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
// Splice scan API — used for Splice/Amulet (CC) flows only. The CIP-56
// transfer-factory endpoint here returns the DSO/Amulet factory, which is
// the WRONG factory for any non-Amulet instrument (USDCx etc.).
export const SCAN_API_URL = process.env.SCAN_API_URL || 'https://scan.56.69.6.174.nip.io';

// DA Utility Backend — hosts the per-instrument-admin Token Standard
// registry that publishes the correct TransferFactory + choice contexts
// for non-Amulet instruments (notably USDCx).
//
// Pattern (no auth):
//   ${UTILITY_BACKEND_URL}/api/token-standard/v0/registrars/<admin-party-id>/...
//
//   devnet:  https://api.utilities.digitalasset-dev.com
//   testnet: https://api.utilities.digitalasset-staging.com
//   mainnet: https://api.utilities.digitalasset.com
//
// See exchange-v2/docs/usdcx-registry-url.md for the full URL pattern +
// memory/exchange_v2_usdcx_testnet_working.md for the discovery story.
export const UTILITY_BACKEND_URL = process.env.UTILITY_BACKEND_URL
  || 'https://api.utilities.digitalasset-staging.com';

// Keycloak (for JWKS verification + operator token)
export const KEYCLOAK_BASE = process.env.KEYCLOAK_BASE || 'https://keycloak.56.69.6.174.nip.io';
export const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'AppProvider';
export const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || 'app-provider-validator';
export const KEYCLOAK_CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET || 'AL8648b9SfdTFImq7FV56Vd0KHifHBuC';
export const KEYCLOAK_TOKEN_URL = `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;

// Operator Keycloak credentials
export const OPERATOR_KC_USERNAME = process.env.OPERATOR_KC_USERNAME || 'mperpoperator';
export const OPERATOR_KC_PASSWORD = process.env.OPERATOR_KC_PASSWORD || 'mperpoperator';

// Splice validator WALLET API base URL. Hosts the self-service wallet
// endpoints under /api/validator/v0/wallet/* — notably
// POST /api/validator/v0/wallet/transfer-preapproval (createTransferPreapproval),
// which makes the authenticated wallet user (JWT subject) the receiver of a
// Splice TransferPreapproval (CC auto-accept). Unlike the admin API (port
// 5003), this is publicly reachable behind the wallet UI host. Auth is the
// user's own Canton/Keycloak bearer token.
export const WALLET_API_URL = process.env.WALLET_API_URL
  || 'https://testnet-wallet.43.217.203.156.nip.io';

// Bridge operator party id (DA's xreserve bridge automation). Co-signs the
// BridgeUserAgreementRequest. Testnet value observed on chain; differs on
// mainnet — re-derive from an existing BridgeUserAgreement contract.
export const BRIDGE_OPERATOR_PARTY_ID = process.env.BRIDGE_OPERATOR_PARTY_ID
  || 'Bridge-Operator::12209d011ce250de439fefc35d16d1ab9d56fb99ccb24c18d798efb22352d533bcdb';

// DA utility-operator party id. Co-signs utility-registry + bridge
// contracts. Testnet value observed on chain; differs on mainnet.
export const UTILITY_OPERATOR_PARTY_ID = process.env.UTILITY_OPERATOR_PARTY_ID
  || 'DigitalAsset-UtilityOperator::12202679f2bbe57d8cba9ef3cee847ac8239df0877105ab1f01a77d47477fdce1204';

// Keycloak master-realm admin credentials. Used by the signup flow to
// create new users in the configured realm via the admin-cli client.
// Defaults to admin/admin (devnet-friendly); override per environment.
export const KC_ADMIN_USERNAME = process.env.KC_ADMIN_USERNAME || 'admin';
export const KC_ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD || 'admin';

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

/**
 * Format an on-chain amount (which carries full ledger precision, e.g. 10
 * fractional digits for USDCx) to the instrument's display decimals. Use
 * this for any human-facing amount string the backend emits so it matches
 * what the UI shows. `decimals` defaults to INSTRUMENT_DECIMALS; pass an
 * override for a different instrument (e.g. 10 for Amulet/CC).
 */
export function formatInstrumentAmount(
  amount: string | number,
  decimals: number = INSTRUMENT_DECIMALS,
): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals, useGrouping: false });
}
export const INSTRUMENT_ADMIN_PARTY_ID = process.env.INSTRUMENT_ADMIN_PARTY_ID
  || 'DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a';

// CORS allowed origins
export const CORS_ORIGINS = (process.env.CORS_ORIGINS
  || 'http://localhost:3000,http://localhost:5173,https://testnet.mperps.xyz').split(',');

// ─── KYC provider selector ──────────────────────────────────────────────
// Which KYC integration is active. Exactly ONE runs at a time. The DB schema
// and /kyc routes are provider-agnostic; only this switch + the provider's
// own credentials change. Webhooks have per-provider endpoints
// (/kyc/webhook/persona, /kyc/webhook/sumsub) so both can stay configured.
export const KYC_PROVIDER = (process.env.KYC_PROVIDER || 'persona').toLowerCase();

// ─── Persona Sandbox (KYC) ──────────────────────────────────────────────
export const PERSONA_API_KEY = process.env.PERSONA_API_KEY || '';
export const PERSONA_WEBHOOK_SECRET = process.env.PERSONA_WEBHOOK_SECRET || '';
export const PERSONA_TEMPLATE_ID = process.env.PERSONA_TEMPLATE_ID || '';
export const PERSONA_ENVIRONMENT_ID = process.env.PERSONA_ENVIRONMENT_ID || '';
export const PERSONA_API_BASE = process.env.PERSONA_API_BASE || 'https://withpersona.com/api/v1';
// Where Persona's hosted flow redirects the browser when the user finishes
// (or backs out of) an inquiry. Frontend reads the `?kyc=1` query param on
// the root page and auto-opens the KYC status modal (waiting for login if
// the session has dropped during the Persona round-trip).
//
// Env-driven so it can vary by deployment (testnet vs prod), but if the
// env var is missing or stale we still want the testnet value rather
// than an empty string, so we fall back to the canonical URL. Each
// deploy should set PERSONA_REDIRECT_URI explicitly to match the
// frontend domain that AppLayout's `?kyc=1` handler is watching.
export const PERSONA_REDIRECT_URI =
  process.env.PERSONA_REDIRECT_URI || 'https://testnet.mperps.xyz?kyc=1';

// ─── Sumsub (KYC) ───────────────────────────────────────────────────────
// API requests are signed with HMAC-SHA256 over (ts + method + path + body)
// using SUMSUB_SECRET_KEY, sent with X-App-Token / X-App-Access-Sig /
// X-App-Access-Ts. Webhooks are verified with SUMSUB_WEBHOOK_SECRET against
// the `x-payload-digest` header. SUMSUB_LEVEL_NAME is the verification level
// (Sumsub's analogue of a Persona template).
export const SUMSUB_APP_TOKEN = process.env.SUMSUB_APP_TOKEN || '';
export const SUMSUB_SECRET_KEY = process.env.SUMSUB_SECRET_KEY || '';
export const SUMSUB_WEBHOOK_SECRET = process.env.SUMSUB_WEBHOOK_SECRET || '';
export const SUMSUB_LEVEL_NAME = process.env.SUMSUB_LEVEL_NAME || 'basic-kyc-level';
export const SUMSUB_API_BASE = process.env.SUMSUB_API_BASE || 'https://api.sumsub.com';
// TTL (seconds) for the generated WebSDK external link the user opens.
export const SUMSUB_LINK_TTL_SECS = Number(process.env.SUMSUB_LINK_TTL_SECS || '1800');
// Where Sumsub's hosted WebSDK flow redirects the browser when the user taps
// Finish (its analogue of Persona's redirect-uri). Reuses the SAME redirect
// target as Persona by default — the frontend's AppLayout watches `?kyc=1` and
// re-opens the KYC modal regardless of provider. Override independently if the
// Sumsub flow ever needs a different landing page.
export const SUMSUB_REDIRECT_URI = process.env.SUMSUB_REDIRECT_URI || PERSONA_REDIRECT_URI;
// Optional: when set, Sumsub appends a signed JWT (HS256 over this key) to the
// redirect URL so the landing page can verify the outcome. We don't rely on it
// for the decision (the webhook is the source of truth), so it's off unless set.
export const SUMSUB_REDIRECT_SIGN_KEY = process.env.SUMSUB_REDIRECT_SIGN_KEY || '';

// Postgres (devnet branch — replaces DynamoDB for invite codes / users / KYC).
// Defaults match the docker-compose service.
export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://canton_backend:canton_backend@localhost:5436/canton_backend';

// Admin API key (for admin endpoints like invite code management)
export const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'canton-admin-secret';

// Server port (for local dev; Lambda ignores this)
export const PORT = Number(process.env.PORT) || 3003;
