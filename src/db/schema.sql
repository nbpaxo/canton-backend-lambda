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
CREATE TABLE IF NOT EXISTS kyc_inquiries (
  inquiry_id      TEXT PRIMARY KEY,        -- Persona inquiry_id (inq_xxxx)
  user_party_id   TEXT NOT NULL REFERENCES users(party_id),
  template_id     TEXT,                    -- Persona template (itmpl_xxxx)
  reference_id    TEXT,                    -- our internal ref echoed back by Persona
  status          TEXT NOT NULL,           -- created | pending | completed | approved | declined | needs_review | expired
  decision        TEXT,                    -- approved | declined | needs_review | null
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  raw_last_event  JSONB                    -- most recent webhook body for forensics
);
CREATE INDEX IF NOT EXISTS kyc_inquiries_user_idx
  ON kyc_inquiries (user_party_id, created_at DESC);


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
CREATE TABLE IF NOT EXISTS deposits (
  id                  BIGSERIAL PRIMARY KEY,
  user_party_id       TEXT NOT NULL REFERENCES users(party_id),
  amount              NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
  transfer_update_id  TEXT NOT NULL UNIQUE,
  deposit_receipt_cid TEXT,                  -- null until on-chain receipt created
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS deposits_user_idx
  ON deposits (user_party_id, created_at DESC);


-- ─── Held deposits (KYC not done when transfer landed) ───────────────────
CREATE TABLE IF NOT EXISTS held_deposits (
  id                  BIGSERIAL PRIMARY KEY,
  user_party_id       TEXT,                  -- nullable: party may be unknown
  amount              NUMERIC(38, 18) NOT NULL,
  transfer_update_id  TEXT NOT NULL UNIQUE,
  reason              TEXT NOT NULL,         -- 'kyc_not_done' | 'unknown_user' | ...
  raw_meta            JSONB,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT
);


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
