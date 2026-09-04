-- canton-backend-lambda schema (devnet branch).
-- Apply: npm run db:apply
-- Idempotent — all CREATE statements use IF NOT EXISTS.

-- ─── Users ───────────────────────────────────────────────────────────────
-- One row per end-user, whether they signed up via our validator (Keycloak)
-- or connected via Loop wallet. party_id is the canonical identifier; the
-- "hint" portion (before "::") differs by source:
--   • is_external=false (validator signup): hint = Keycloak user UUID (sub)
--   • is_external=true  (Loop wallet)     : hint = whatever Loop allocated
--
-- keycloak_sub is set for validator users; null for Loop users.
CREATE TABLE IF NOT EXISTS users (
  party_id        TEXT PRIMARY KEY,
  is_external     BOOLEAN NOT NULL,
  keycloak_sub    TEXT UNIQUE,
  username        TEXT,                  -- Keycloak username (validator users)
  display_name    TEXT,
  email           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'suspended', 'closed'))
);
CREATE INDEX IF NOT EXISTS users_keycloak_sub_idx
  ON users (keycloak_sub) WHERE keycloak_sub IS NOT NULL;
-- System-wide, case-insensitive email uniqueness. A partial UNIQUE index (NULLs
-- excluded, so users without an email are unaffected) enforces "one account per
-- email" at the DB level — the backstop behind every write path
-- (signup, KYC email OTP, Keycloak backfill, webhook capture). This index also
-- serves the case-insensitive lookups those paths run.
--
-- Guarded creation: if legacy duplicate emails already exist the unique index
-- can't be built, so we warn instead of failing the whole schema apply. Resolve
-- the duplicates, then re-run db:apply to create it.
DROP INDEX IF EXISTS users_email_lower_idx;  -- superseded by the unique index
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users
     WHERE email IS NOT NULL
     GROUP BY LOWER(email)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING 'users_email_lower_uidx NOT created: duplicate emails exist. Resolve duplicates, then re-run db:apply.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx
      ON users (LOWER(email)) WHERE email IS NOT NULL;
  END IF;
END $$;


-- ─── Email OTP (KYC email collection) ────────────────────────────────────
-- One in-flight verification code per user. Requesting a new code overwrites
-- the row (ON CONFLICT party_id). The code is stored HASHED (never plaintext).
-- Rows are ephemeral: deleted on successful verify; stale rows are harmless
-- (expires_at gates them). Used by POST /kyc/email/request-otp + verify-otp.
CREATE TABLE IF NOT EXISTS email_otps (
  party_id     TEXT PRIMARY KEY REFERENCES users(party_id),
  email        TEXT NOT NULL,             -- address the code was sent to (lowercased)
  code_hash    TEXT NOT NULL,             -- sha256(code) hex
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,    -- failed verify attempts (capped)
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ─── Invite codes (moved from DynamoDB) ──────────────────────────────────
-- Used by the validator-signup flow to gate onboarding while devnet is
-- closed-beta. Drop or open if invite-less signup is enabled later.
CREATE TABLE IF NOT EXISTS invite_codes (
  code           TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redeemed_at    TIMESTAMPTZ,
  redeemed_by    JSONB,                    -- { username, partyId, email, ... }
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS invite_codes_unredeemed_idx
  ON invite_codes (created_at) WHERE redeemed_at IS NULL;


-- ─── KYC inquiries (Persona Sandbox) ─────────────────────────────────────
-- One row per Persona inquiry. Webhook events upsert by inquiry_id; the
-- current state is `status`. We never delete — full lifecycle audit lives
-- here for compliance.
-- Provider-agnostic KYC records. One row per provider verification record.
-- See src/kyc/types.ts for the generic column mapping (Persona / Sumsub / Hypersign).
CREATE TABLE IF NOT EXISTS kyc_inquiries (
  inquiry_id      TEXT PRIMARY KEY,        -- provider primary id: Persona inquiry (inq_…) / Sumsub applicantId / Hypersign sessionId
  user_party_id   TEXT NOT NULL REFERENCES users(party_id),
  provider        TEXT NOT NULL DEFAULT 'persona', -- 'persona' | 'sumsub' | 'hypersign'
  template_id     TEXT,                    -- verification template/level: Persona template (itmpl_…) / Sumsub levelName
  reference_id    TEXT,                    -- our party id echoed back (Persona reference-id / Sumsub externalUserId; resolved from sessionId for Hypersign)
  status          TEXT NOT NULL,           -- created | pending | completed | approved | declined | needs_review | expired | failed | redacted
  decision        TEXT,                    -- approved | declined | needs_review | null
  reject_reason    TEXT,                   -- human-readable reason on a rejection (Sumsub moderation/client comment)
  resubmit_allowed BOOLEAN,                -- true when a declined verification may be resubmitted (Sumsub RED + RETRY)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  raw_last_event  JSONB                    -- most recent webhook body for forensics
);
CREATE INDEX IF NOT EXISTS kyc_inquiries_user_idx
  ON kyc_inquiries (user_party_id, created_at DESC);
-- Generic provider column for DBs created before the multi-provider refactor.
ALTER TABLE kyc_inquiries
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'persona',
  ADD COLUMN IF NOT EXISTS reject_reason TEXT,
  ADD COLUMN IF NOT EXISTS resubmit_allowed BOOLEAN;


-- ─── Watcher checkpoint (Canton update-stream offset) ────────────────────
-- Singleton row — the deposit watcher writes the last acknowledged offset
-- here so it resumes correctly after restart.
CREATE TABLE IF NOT EXISTS watcher_checkpoint (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_offset TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO watcher_checkpoint (id) VALUES (1) ON CONFLICT DO NOTHING;


-- ─── Worker heartbeats (liveness) ────────────────────────────────────────
-- Each long-running worker (deposit watcher, health monitor, …) upserts its
-- row every tick. The health monitor reads these and alerts when a worker's
-- heartbeat goes stale (see WATCHER_HEARTBEAT_MINUTES). Distinct from
-- watcher_checkpoint, whose updated_at only advances on new ledger activity.
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker   TEXT PRIMARY KEY,
  beat_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta     JSONB
);


-- ─── Deposits ────────────────────────────────────────────────────────────
-- Mirrors on-chain DepositReceipt creation. Watcher inserts after gating
-- on KYC; if the user isn't KYC-approved at the time the transfer lands,
-- the row goes into `held_deposits` instead for manual reconciliation.
--
-- exchange_credited_at: when the exchange-backend /v1/deposit/defi call
-- succeeded. Null until reconciled. The watcher retries failed notifies
-- on each tick (up to exchange_attempts cap) — see retryFailedExchangeNotifies.
CREATE TABLE IF NOT EXISTS deposits (
  id                       BIGSERIAL PRIMARY KEY,
  user_party_id            TEXT NOT NULL REFERENCES users(party_id),
  amount                   NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
  transfer_update_id       TEXT NOT NULL UNIQUE,
  source_holding_cid       TEXT UNIQUE,           -- vaultPool Holding cid; unique catches re-credit across restarts
  deposit_receipt_cid      TEXT,                  -- null until on-chain receipt created
  exchange_credited_at     TIMESTAMPTZ,           -- null until exchange-backend credits
  exchange_attempts        INT NOT NULL DEFAULT 0,
  exchange_last_error      TEXT,                  -- most-recent exchange-API error body
  exchange_last_attempt_at TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS deposits_user_idx
  ON deposits (user_party_id, created_at DESC);
-- Cheap lookup for the retry pass.
CREATE INDEX IF NOT EXISTS deposits_pending_exchange_idx
  ON deposits (exchange_attempts) WHERE exchange_credited_at IS NULL;

-- Idempotent column-adds for existing deployments (the CREATE TABLE above
-- is a no-op once the table already exists).
ALTER TABLE deposits
  ADD COLUMN IF NOT EXISTS exchange_credited_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exchange_attempts        INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exchange_last_error      TEXT,
  ADD COLUMN IF NOT EXISTS exchange_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_holding_cid       TEXT,
  -- Set when a withdrawal claims this deposit. Filtered out of
  -- pickDeposits() so the same DepositRecord can't fund two withdrawals.
  ADD COLUMN IF NOT EXISTS consumed_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consumed_by_withdrawal   TEXT;
CREATE INDEX IF NOT EXISTS deposits_unconsumed_idx
  ON deposits (user_party_id, created_at) WHERE consumed_at IS NULL;

-- Make source_holding_cid UNIQUE if it isn't already (idempotent — the constraint
-- name is fixed so re-runs are no-ops).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deposits_source_holding_cid_key') THEN
    ALTER TABLE deposits ADD CONSTRAINT deposits_source_holding_cid_key UNIQUE (source_holding_cid);
  END IF;
END $$;


-- ─── Held deposits (KYC not done when transfer landed) ───────────────────
CREATE TABLE IF NOT EXISTS held_deposits (
  id                  BIGSERIAL PRIMARY KEY,
  user_party_id       TEXT,                  -- nullable: party may be unknown
  amount              NUMERIC(38, 18) NOT NULL,
  transfer_update_id  TEXT NOT NULL UNIQUE,
  source_holding_cid  TEXT UNIQUE,           -- vaultPool Holding cid; cross-restart dedup
  reason              TEXT NOT NULL,         -- 'kyc_not_done' | 'unknown_user' | 'pre_existing' | ...
  raw_meta            JSONB,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT
);

-- Idempotent column-add + UNIQUE-constraint for existing deployments.
ALTER TABLE held_deposits
  ADD COLUMN IF NOT EXISTS source_holding_cid TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'held_deposits_source_holding_cid_key') THEN
    ALTER TABLE held_deposits ADD CONSTRAINT held_deposits_source_holding_cid_key UNIQUE (source_holding_cid);
  END IF;
END $$;


-- ─── Withdrawals ─────────────────────────────────────────────────────────
-- One row per exchange-backend approval, keyed by approval_id so it's
-- naturally idempotent (a replay of the same approval id 409s).
--
-- State machine:
--   pending     → row inserted, before anything else
--   finalized   → exchange-backend's /v1/withdraw/defi accepted the call
--                 (this MUST come before any on-chain ops — see the route)
--   on_chain    → operator transfer + DepositRecord consumption committed
--   failed      → terminal; failure_reason tells you what blew up where
CREATE TABLE IF NOT EXISTS withdrawals (
  approval_id                    TEXT PRIMARY KEY,
  user_party_id                  TEXT NOT NULL REFERENCES users(party_id),
  amount                         NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
  nonce                          TEXT NOT NULL,
  state                          TEXT NOT NULL DEFAULT 'pending'
                                   CHECK (state IN ('pending','finalized','on_chain','failed')),
  on_chain_update_id             TEXT,
  consumed_record_cids           TEXT[],
  -- Principal/profit split (mirrors exchange-v2's pattern):
  --   principal = portion covered by user's own DepositRecord(s)
  --   profit    = top-up from treasury when requested > principal-available
  principal_amount               NUMERIC(38, 18),
  profit_amount                  NUMERIC(38, 18),
  treasury_transfer_update_id    TEXT,
  exchange_finalized_at          TIMESTAMPTZ,
  on_chain_at                    TIMESTAMPTZ,
  failure_reason                 TEXT,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Idempotent column-adds for existing deployments.
ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS principal_amount            NUMERIC(38, 18),
  ADD COLUMN IF NOT EXISTS profit_amount               NUMERIC(38, 18),
  ADD COLUMN IF NOT EXISTS treasury_transfer_update_id TEXT;
CREATE INDEX IF NOT EXISTS withdrawals_user_idx
  ON withdrawals (user_party_id, created_at DESC);

-- ─── Failed withdraw attempts (operator queue) ──────────────────────────
-- One row per failure inside POST /cb/withdraw. Lets ops trace which
-- approvals left the user's exchange-backend balance in a stuck state:
--
--   failure_step ∈ ('auth','lookup','replay','exchange','on_chain')
--     auth      → caller couldn't be verified; balance is locked (approval
--                 minted), needs /v1/withdraw/defi/unlock at exchange-backend.
--     lookup    → approval lookup rejected (expired / not found / already
--                 finalized at exchange-backend's side); usually no action
--                 needed, but worth recording.
--     replay    → same approval_id submitted twice; balance state should
--                 already match the first attempt's outcome.
--     exchange  → exchange-backend rejected /v1/withdraw/defi; balance is
--                 LOCKED (debit didn't happen) — needs unlock.
--     on_chain  → exchange already debited but ledger move failed; balance
--                 is DEBITED with no on-chain offset — manual settlement
--                 or retry pass needed.
--
-- resolved_at + resolution_note are operator-only; we never set them
-- from the request path.
CREATE TABLE IF NOT EXISTS failed_withdraw_attempts (
  id              BIGSERIAL PRIMARY KEY,
  approval_id     TEXT,
  user_party_id   TEXT,
  amount          NUMERIC(38, 18),
  nonce           TEXT,
  failure_step    TEXT NOT NULL,
  failure_reason  TEXT NOT NULL,
  request_payload JSONB,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS failed_withdraw_attempts_unresolved_idx
  ON failed_withdraw_attempts (created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS failed_withdraw_attempts_user_idx
  ON failed_withdraw_attempts (user_party_id, created_at DESC);

-- Keep the `failure_step` CHECK constraint in sync with the application's
-- current taxonomy. Idempotent: drops any existing version of the
-- constraint (under either historical name) before re-adding.
--
-- Why this matters: if app code INSERTs a `failure_step` value the DB
-- rejects with CHECK_VIOLATION, the row is silently lost — and that's
-- exactly the symptom that surfaced in prod on the first deploy of the
-- 2026-05-20 refactor (new values `exchange-api-fail` / `on-chain-failed`
-- vs old constraint that only allowed `exchange` / `on_chain`).
DO $$
DECLARE
  cname TEXT;
BEGIN
  FOR cname IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'failed_withdraw_attempts'::regclass
      AND conname LIKE 'failed_withdraw_attempts_failure_step_check%'
  LOOP
    EXECUTE 'ALTER TABLE failed_withdraw_attempts DROP CONSTRAINT ' || quote_ident(cname);
  END LOOP;

  ALTER TABLE failed_withdraw_attempts
    ADD CONSTRAINT failed_withdraw_attempts_failure_step_check
    CHECK (failure_step IN (
      -- Legacy values (kept for back-compat with rows written before the
      -- 2026-05-20 refactor — strings unchanged so old data still validates).
      'auth','lookup','replay','exchange','on_chain',
      -- Canonical values written by current code. `exchange-api-fail` =
      -- exchange-backend rejected before any on-chain work happened.
      -- `on-chain-failed` = exchange already debited but the on-chain
      -- transfer / DepositRecord burn errored.
      'exchange-api-fail','on-chain-failed'
    ));
END $$;

-- ─── Alerts (ops notifications → Telegram alerts group) ────────────────────
-- Decoupled alert queue. Detection sites (withdraw path, deposit watcher,
-- health monitor) call registerAlert() → one INSERT here. The always-on
-- health-monitor process drains status='pending' rows to the Telegram group
-- (runAlertProcessor). The Lambda API only ever registers; it never sends
-- (it's short-lived).
--
-- Two orthogonal lifecycles per row:
--   • delivery:  status pending → sent | failed   (did Telegram accept it?)
--   • condition: resolved_at NULL → set           (did the underlying
--                                                   problem clear?)
-- dedup_key identifies a logical condition/event:
--   • condition alerts use a STABLE key (e.g. 'reserve_shortfall') so a
--     sustained breach fires once, then again only after the cooldown.
--   • event alerts use a UNIQUE key (e.g. 'withdraw_failed:<approval>:<step>')
--     so each distinct event fires exactly once.
CREATE TABLE IF NOT EXISTS alerts (
  id              BIGSERIAL PRIMARY KEY,
  alert_type      TEXT NOT NULL,
  severity        TEXT NOT NULL
                    CHECK (severity IN ('critical','warning','info')),
  dedup_key       TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  context         JSONB,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','failed')),
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ
);
-- Fast lookup for the processor's send loop (oldest pending first).
CREATE INDEX IF NOT EXISTS alerts_pending_idx
  ON alerts (created_at) WHERE status = 'pending';
-- Dedup / cooldown / recovery lookups by logical key (most recent first).
CREATE INDEX IF NOT EXISTS alerts_dedup_idx
  ON alerts (dedup_key, created_at DESC);
-- Open (unresolved) condition alerts — used by resolveAlert() + dashboards.
CREATE INDEX IF NOT EXISTS alerts_open_idx
  ON alerts (dedup_key) WHERE resolved_at IS NULL;


-- ─── Support reports (in-app "Report an issue") ──────────────────────────
-- One row per user-submitted issue. Logged-in users only; party_id + user_type
-- are derived server-side (never trusted from the client). The user supplies a
-- description + at least one contact handle (telegram / twitter / email) so the
-- team can reach them. On submit we also ping the support Telegram group
-- (notified_telegram flips true on success).
CREATE TABLE IF NOT EXISTS support_reports (
  id                BIGSERIAL PRIMARY KEY,
  user_party_id     TEXT NOT NULL,
  user_type         TEXT NOT NULL,          -- 'validator' | 'loop'
  description       TEXT NOT NULL,
  telegram          TEXT,
  twitter           TEXT,
  email             TEXT,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','in_progress','resolved','closed')),
  notified_telegram BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  resolution_note   TEXT,
  -- At least one contact must be present.
  CONSTRAINT support_reports_contact_chk
    CHECK (telegram IS NOT NULL OR twitter IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS support_reports_open_idx
  ON support_reports (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS support_reports_user_idx
  ON support_reports (user_party_id, created_at DESC);


-- ─── Audit log ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  user_party_id TEXT,
  action        TEXT NOT NULL,
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_log_user_idx
  ON audit_log (user_party_id, created_at DESC) WHERE user_party_id IS NOT NULL;


-- ─── Referral codes ──────────────────────────────────────────────────────
-- One active shareable code per user. Kept in its own table rather than as a
-- column on `users` so a code can be disabled or rotated without touching the
-- user row, and so `code` gets a primary key of its own for lookups.
--
-- Codes are stored UPPERCASE and matched exactly. Every write path uppercases
-- before it gets here; the CHECK makes that an invariant the DB enforces
-- rather than a convention each call site has to remember.
--
-- Generated from a Crockford-style alphabet with 0/O/1/I/L removed, so a code
-- read aloud or copied off a screenshot can't land on the wrong account.
CREATE TABLE IF NOT EXISTS referral_codes (
  code            TEXT PRIMARY KEY CHECK (code = UPPER(code) AND LENGTH(code) BETWEEN 4 AND 32),
  owner_party_id  TEXT NOT NULL REFERENCES users(party_id),
  kind            TEXT NOT NULL DEFAULT 'auto'
                    CHECK (kind IN ('auto', 'vanity')),
  -- status — moderation lever on a single code.
  --
  -- TODAY: every read filters `status = 'active'` (lookupActiveCode,
  --   getOrCreateCode) and the partial unique index below is scoped to it, so
  --   the column is honoured everywhere. But NOTHING currently writes
  --   'disabled' — there is no endpoint or admin command for it, so in
  --   practice every row is 'active'.
  --
  -- INTENDED USE: retire an abusive or leaked code without destroying
  --   history. Deleting the row is not an option — `referrals.code` has a
  --   foreign key to it, so a code that anyone has already used cannot be
  --   removed. Setting 'disabled' stops the code resolving for NEW binds
  --   while every referral already earned through it stays intact and keeps
  --   counting. Disabling also frees the partial unique index, so the owner
  --   can be issued a replacement code.
  --
  -- To make it real, add a disable/enable command to
  --   scripts/referral-admin.ts; the read paths need no changes.
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Exactly one active code per user — the one /referral/me returns.
CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_owner_active_uidx
  ON referral_codes (owner_party_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS referral_codes_owner_idx
  ON referral_codes (owner_party_id);


-- ─── Referrals (the referrer → referee edge) ─────────────────────────────
-- ONE LEVEL ONLY: a referrer earns from the users they directly referred, and
-- nothing from those users' own referrals. Nothing here walks a tree.
--
-- referee_party_id is the PRIMARY KEY, which is what makes "a user can be
-- referred exactly once, ever" a database guarantee instead of a check every
-- call site has to remember. A second bind attempt fails on conflict — that
-- is the intended behaviour for the signup path, the Loop 24h window, and the
-- admin backfill script alike.
--
-- Binding counts immediately; there is no qualification gate. That is safe
-- because points derive from VOLUME: a farmed wallet that never trades earns
-- its referrer nothing, so trading activity is the implicit filter.
--
-- How mpoints will read this later (no schema change needed):
--   referrer's referral volume for a day
--     = SUM(daily_user_volume.volume)
--       FROM referrals JOIN daily_user_volume ON referee_party_id
--      WHERE referrer_party_id = $1 AND status = 'active'
--   `bound_at` is kept so the "count volume only from the bind date" vs
--   "count the referee's whole history" decision can be made later.
CREATE TABLE IF NOT EXISTS referrals (
  referee_party_id  TEXT PRIMARY KEY REFERENCES users(party_id),
  referrer_party_id TEXT NOT NULL REFERENCES users(party_id),
  code              TEXT NOT NULL REFERENCES referral_codes(code),
  bound_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- signup      → mperps user entered it on the signup form
  -- loop_window → Loop wallet user bound within the post-connect window
  -- admin       → backfilled by scripts/referral-bind.ts
  bind_source       TEXT NOT NULL
                      CHECK (bind_source IN ('signup', 'loop_window', 'admin')),
  -- status — whether this referral edge currently counts.
  --
  -- TODAY: actively used, unlike referral_codes.status.
  --   • WRITTEN by scripts/referral-admin.ts `unbind` and `reassign`, which
  --     set 'revoked' together with revoked_at + revoked_reason.
  --   • READ by every query, all of which filter `status = 'active'`, so a
  --     revoked edge immediately drops out of the referrer's summary count,
  --     their friends list, and getInviter for the referee.
  --   • LOAD-BEARING in bindReferral's upsert, whose
  --     `ON CONFLICT ... DO UPDATE ... WHERE referrals.status = 'revoked'`
  --     lets a revoked row be re-bound while an ACTIVE row stays immutable.
  --     Without that clause an unbind was a one-way door: the revoked row
  --     still held the primary key, so the user could never be re-bound and
  --     getReferralState reported bound=false while every bind attempt
  --     failed with already_bound.
  --
  -- WHY REVOKE RATHER THAN DELETE: referee_party_id is the primary key, so
  --   this row is also the record that the user WAS referred. Revoking keeps
  --   revoked_at/revoked_reason as an audit trail for a fraud reversal or a
  --   support case; deleting would erase that.
  --
  -- FOR THE POINTS SERVICE: treat 'revoked' as "never earned". Referral
  --   volume rollups must filter `status = 'active'` (see the query sketch
  --   above), otherwise a reversed attribution keeps paying out.
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'revoked')),
  revoked_at        TIMESTAMPTZ,
  revoked_reason    TEXT,
  -- Catches the trivial case only. Someone with both an mperps account and a
  -- Loop wallet has two distinct party ids and can still self-refer; that is
  -- accepted, since points require real volume and real volume means real
  -- fees paid to us.
  CONSTRAINT referrals_no_self CHECK (referee_party_id <> referrer_party_id)
);
-- Drives the referral page's friends list (newest first) and the referral
-- volume rollup. Partial on active so revoked edges cost nothing to skip.
CREATE INDEX IF NOT EXISTS referrals_referrer_idx
  ON referrals (referrer_party_id, bound_at DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS referrals_code_idx
  ON referrals (code);
