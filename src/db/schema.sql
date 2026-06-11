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
-- See src/kyc/types.ts for the generic column mapping (Persona / Sumsub).
CREATE TABLE IF NOT EXISTS kyc_inquiries (
  inquiry_id      TEXT PRIMARY KEY,        -- provider primary id: Persona inquiry (inq_…) / Sumsub applicantId
  user_party_id   TEXT NOT NULL REFERENCES users(party_id),
  provider        TEXT NOT NULL DEFAULT 'persona', -- 'persona' | 'sumsub'
  template_id     TEXT,                    -- verification template/level: Persona template (itmpl_…) / Sumsub levelName
  reference_id    TEXT,                    -- our party id echoed back (Persona reference-id / Sumsub externalUserId)
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
