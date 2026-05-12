/**
 * Configuration — all values come from environment variables.
 * Lambda-friendly: no hardcoded URLs.
 */
// Load .env file for local dev — on Lambda, env vars are set natively
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  await import('dotenv/config');
}

// Canton Ledger
export const CANTON_LEDGER_API = process.env.CANTON_LEDGER_API || 'https://canton.56.69.6.174.nip.io';

// Keycloak (for JWKS verification + operator token)
export const KEYCLOAK_BASE = process.env.KEYCLOAK_BASE || 'https://keycloak.56.69.6.174.nip.io';
export const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'AppProvider';
export const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || 'app-provider-validator';
export const KEYCLOAK_CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET || 'AL8648b9SfdTFImq7FV56Vd0KHifHBuC';
export const KEYCLOAK_TOKEN_URL = `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;

// Operator Keycloak credentials
export const OPERATOR_KC_USERNAME = process.env.OPERATOR_KC_USERNAME || 'mperpoperator';
export const OPERATOR_KC_PASSWORD = process.env.OPERATOR_KC_PASSWORD || 'mperpoperator';

// Token-issuer Keycloak credentials. On devnet (Amulet/CC) the issuer is
// the DSO and we don't mint; keep these for the custom-USDC variant if/when
// it returns.
export const CIRCLE_KC_USERNAME = process.env.CIRCLE_KC_USERNAME || 'mperpoperator';
export const CIRCLE_KC_PASSWORD = process.env.CIRCLE_KC_PASSWORD || 'mperpoperator';

// Daml package ID — set after new DAR is deployed; will be empty until then.
export const PACKAGE_ID = process.env.PACKAGE_ID || '';

// Participant suffix (devnet validator fingerprint)
export const PARTICIPANT_SUFFIX = process.env.PARTICIPANT_SUFFIX
  || '12203171abe141f5537ded76661f4ff75b4fde178e950fca4193e2bb268e8238cfb2';

// Exchange API — legacy /deposit and /withdraw Lambda paths in src/index.ts
// still reference these. The express server (server.ts) no longer uses them.
// Drop entirely when index.ts is cleaned up for the post-watcher world.
export const EXCHANGE_DEPOSIT_URL = process.env.EXCHANGE_DEPOSIT_URL || '';
export const EXCHANGE_WITHDRAW_URL = process.env.EXCHANGE_WITHDRAW_URL || '';

// Managed party ids (mirrors exchange-v2 devnet allocation)
export const PARTIES = {
  operator:  process.env.OPERATOR_PARTY_ID   || `mperpoperator::${PARTICIPANT_SUFFIX}`,
  vaultPool: process.env.VAULT_POOL_PARTY_ID || `mperpvaultpool::${PARTICIPANT_SUFFIX}`,
  treasury:  process.env.TREASURY_PARTY_ID   || `mperptreasury::${PARTICIPANT_SUFFIX}`,
  // Token issuer = DSO when INSTRUMENT_VARIANT=amulet (devnet default).
  tokenIssuer: process.env.INSTRUMENT_ADMIN_PARTY_ID
    || `DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a`,
} as const;

// ─── Instrument config (devnet=Amulet/CC; testnet swaps to USDCx) ───────
// The Daml-side instrument id + admin party govern which on-chain
// Holdings/Transfers we recognize. The symbol + decimals are purely
// display — surfaced via /me so the frontend doesn't carry its own env.
export const INSTRUMENT_ID = process.env.INSTRUMENT_ID || 'Amulet';
export const INSTRUMENT_SYMBOL = process.env.INSTRUMENT_SYMBOL || 'CC';
export const INSTRUMENT_DECIMALS = Number(process.env.INSTRUMENT_DECIMALS || 10);
export const INSTRUMENT_ADMIN_PARTY_ID = process.env.INSTRUMENT_ADMIN_PARTY_ID
  || 'DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a';

// CORS allowed origins
export const CORS_ORIGINS = (process.env.CORS_ORIGINS
  || 'http://localhost:3000,http://localhost:5173,https://testnet.mperps.xyz').split(',');

// ─── Persona Sandbox (KYC) ──────────────────────────────────────────────
export const PERSONA_API_KEY = process.env.PERSONA_API_KEY || '';
export const PERSONA_WEBHOOK_SECRET = process.env.PERSONA_WEBHOOK_SECRET || '';
export const PERSONA_TEMPLATE_ID = process.env.PERSONA_TEMPLATE_ID || '';
export const PERSONA_ENVIRONMENT_ID = process.env.PERSONA_ENVIRONMENT_ID || '';
export const PERSONA_API_BASE = process.env.PERSONA_API_BASE || 'https://withpersona.com/api/v1';

// Postgres (devnet branch — replaces DynamoDB for invite codes / users / KYC).
// Defaults match the docker-compose service.
export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://canton_backend:canton_backend@localhost:5436/canton_backend';

// Admin API key (for admin endpoints like invite code management)
export const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'canton-admin-secret';

// Server port (for local dev; Lambda ignores this)
export const PORT = Number(process.env.PORT) || 3003;
