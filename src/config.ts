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

// ─── Hypersign (KYC — "Cavach") ─────────────────────────────────────────
// Flow (see src/kyc/hypersign.ts):
//   1. Mint a short-lived KYC access token by exchanging the app's API secret
//      key at the OAuth endpoint, selecting the service via grant_type:
//        POST {AUTH_API_BASE}/api/v1/app/oauth?grant_type=access_service_kyc
//        header: X-Api-Secret-Key: <secret>   → { access_token, expiresIn }
//      A matching ssiAccessToken (grant_type=access_service_ssi) is minted
//      best-effort with the same secret; the widget works without it.
//   2. Create a verification session at the KYC tenant URL:
//        POST {KYC_TENANT_URL}/api/v2/session
//        header: x-kyc-access-token: <kycAccessToken>   → { data: { sessionId } }
//   3. The user opens the hosted widget:
//        {WIDGET_URL}?kycAccessToken=…&ssiAccessToken=…&sessionId=…
// On completion Hypersign POSTs a webhook `{ idToken, sessionId }` (the idToken
// is a signed JWT; the body has NO reference/externalUserId, so we route the
// event to a party via the sessionId we stored at /kyc/start).
// docs: https://docs.hypersign.id/hypersign-kyc
//
// A single app "API secret key" (from the Cavach/Entity dashboard) is all you
// need; the dashboard "application id" is NOT used by any API call here.
export const HYPERSIGN_API_SECRET_KEY = process.env.HYPERSIGN_API_SECRET_KEY || '';
// Secret used for the SSI grant. Most Cavach setups reuse the same app secret,
// so default to it; override only if your account has a distinct SSI secret.
export const HYPERSIGN_SSI_API_SECRET_KEY =
  process.env.HYPERSIGN_SSI_API_SECRET_KEY || '';
// OAuth endpoint base that exchanges a secret key for an access token.
export const HYPERSIGN_AUTH_API_BASE =
  process.env.HYPERSIGN_AUTH_API_BASE || 'https://api.entity.dashboard.hypersign.id';
// The KYC "tenant URL" from your Cavach dashboard, where sessions are created.
// No trailing slash. (Yours: https://api.cavach.hypersign.id)
export const HYPERSIGN_KYC_TENANT_URL = (
  process.env.HYPERSIGN_KYC_TENANT_URL || 'https://api.cavach.hypersign.id'
).replace(/\/$/, '');
// Hosted verification widget origin the frontend opens (with the token + sessionId).
export const HYPERSIGN_WIDGET_URL = process.env.HYPERSIGN_WIDGET_URL || 'https://verify.hypersign.id';
// Client-auth user token (kycUserAccessToken). REQUIRED once in-widget user
// login (e.g. Google) is DISABLED: with no in-widget login the backend must
// establish the user session itself, so /kyc/start mints a per-session
// kycUserAccessToken via a 3-step flow (create user DID → issue DID-signed JWT
// → exchange) and appends it to the widget URL. See src/kyc/hypersign.ts.
//   • SSI_BASE_URL is the SSI *entity* service (NOT the dashboard oauth host and
//     NOT the cavach KYC tenant); it serves /api/v1/did/*.
//   • ISSUER_DID + ISSUER_VERIFICATION_METHOD_ID are your app's issuer identity
//     from the SSI sub-portal (key type Ed25519VerificationKey2020).
// The flow activates only when ISSUER_DID + ISSUER_VERIFICATION_METHOD_ID are
// both set; otherwise /kyc/start falls back to the admin-token-only widget URL
// (which is valid only while in-widget login is still enabled).
export const HYPERSIGN_SSI_BASE_URL = (
  process.env.HYPERSIGN_SSI_BASE_URL || 'https://api.entity.hypersign.id'
).replace(/\/$/, '');
export const HYPERSIGN_ISSUER_DID = process.env.HYPERSIGN_ISSUER_DID || '';
export const HYPERSIGN_ISSUER_VERIFICATION_METHOD_ID =
  process.env.HYPERSIGN_ISSUER_VERIFICATION_METHOD_ID || '';
// Webhook auth: the Cavach webhook config lets you set a custom header that
// Hypersign sends on every webhook POST. Put a strong random value in the
// dashboard's `x-api-token` field and the SAME value here — incoming webhooks
// whose `x-api-token` header doesn't match are rejected. This is the primary
// authenticity guard (Hypersign's webhook body has no documented signature).
export const HYPERSIGN_WEBHOOK_API_TOKEN = process.env.HYPERSIGN_WEBHOOK_API_TOKEN || '';
// Optional additional guard: when set, we also verify the webhook idToken's
// HS256 signature against it. If neither this nor HYPERSIGN_WEBHOOK_API_TOKEN
// is set, we fall back to accepting a structurally-valid idToken whose
// sessionId maps to a verification we created (the sessionId→party mapping is
// then the only guard).
export const HYPERSIGN_WEBHOOK_SECRET = process.env.HYPERSIGN_WEBHOOK_SECRET || '';

// Postgres (devnet branch — replaces DynamoDB for invite codes / users / KYC).
// Defaults match the docker-compose service.
export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://canton_backend:canton_backend@localhost:5436/canton_backend';

// Admin API key (for admin endpoints like invite code management)
// No default. The previous fallback ('canton-admin-secret') is committed to
// this repo, so any deploy that forgot the env var was protected by a value
// anyone with read access already knows. Empty means the admin routes reject
// every request — see the guard in signup.ts.
export const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

// Server port (for local dev; Lambda ignores this)
export const PORT = Number(process.env.PORT) || 3003;

export const EXCHANGE_API_HEADER = process.env.EXCHANGE_API_HEADER || 'x-liminal-signature';
export const EXCHANGE_API_SECRET = process.env.EXCHANGE_API_SECRET || '';

// ─── Alerts / ops notifications ──────────────────────────────────────────
// Operational alerts are delivered to a Telegram group (TELEGRAM_ALERTS_CHAT_ID
// below). Alerts are decoupled: sources call registerAlert() (a cheap INSERT
// into the `alerts` table); an always-on process (the deposit watcher, or a
// dedicated monitor) drains pending rows to Telegram via runAlertProcessor().
// The Lambda API only ever REGISTERS (it's short-lived); it never sends.
// See src/alerts/*.
// A sustained condition (e.g. reserve shortfall) alerts once, then stays
// quiet until it resolves — but re-fires as a reminder after this cooldown
// so an unresolved problem doesn't drop off the radar.
export const ALERT_COOLDOWN_MINUTES = Number(process.env.ALERT_COOLDOWN_MINUTES ?? 30);
// Delivery retry policy for the processor: how many times to attempt posting
// a single alert to Telegram before marking it 'failed', and the minimum gap
// between attempts on a given row.
export const ALERT_MAX_SEND_ATTEMPTS = Number(process.env.ALERT_MAX_SEND_ATTEMPTS ?? 6);
export const ALERT_SEND_BACKOFF_MS = Number(process.env.ALERT_SEND_BACKOFF_MS ?? 30_000);
// Safety valve: never send more than this many alerts per processor pass, so
// a burst (or a bug) can't rate-limit us out of the webhook.
export const ALERT_SEND_BATCH_LIMIT = Number(process.env.ALERT_SEND_BATCH_LIMIT ?? 10);

// ─── Telegram notifications ──────────────────────────────────────────────
// Two INDEPENDENT bots + groups:
//   • SUPPORT — user "Report an issue" submissions (src/api/support.ts)
//   • ALERTS  — automated ops alerts (src/alerts/*)
// Create each bot via @BotFather, add it to its group, and set the numeric
// group chat id (negative for groups/supergroups — e.g. -1001234567890).
export const TELEGRAM_SUPPORT_BOT_TOKEN = process.env.TELEGRAM_SUPPORT_BOT_TOKEN || '';
export const TELEGRAM_SUPPORT_CHAT_ID = process.env.TELEGRAM_SUPPORT_CHAT_ID || '';
export const TELEGRAM_ALERTS_BOT_TOKEN = process.env.TELEGRAM_ALERTS_BOT_TOKEN || '';
export const TELEGRAM_ALERTS_CHAT_ID = process.env.TELEGRAM_ALERTS_CHAT_ID || '';

// ─── Resend (transactional email — KYC email OTP) ───────────────────────
// Used to send the 6-digit email-verification code for users whose email we
// don't already have (Loop wallet users) before the Hypersign client_auth
// flow, which needs a verified email up front. Create an API key at
// resend.com, verify the sending domain (DNS), and set RESEND_FROM to a
// verified sender on it.
export const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
export const RESEND_API_BASE = process.env.RESEND_API_BASE || 'https://api.resend.com';
export const RESEND_FROM = process.env.RESEND_FROM || 'Mperps <no-reply@mperps.xyz>';

// Email OTP tuning.
export const EMAIL_OTP_TTL_SECS = Number(process.env.EMAIL_OTP_TTL_SECS || '600'); // 10 min
export const EMAIL_OTP_MAX_ATTEMPTS = Number(process.env.EMAIL_OTP_MAX_ATTEMPTS || '5');
// Minimum gap between successive code requests for one user (anti-spam).
export const EMAIL_OTP_RESEND_COOLDOWN_SECS = Number(
  process.env.EMAIL_OTP_RESEND_COOLDOWN_SECS || '30',
);


// ─── Session auth ────────────────────────────────────────────────────────
/**
 * Age limit for a Loop signature on ordinary reads. Unbounded by default.
 *
 * The credential is the exchange login signature, which covers only the bare
 * nonce and so carries no timestamp to measure age against. Rather than
 * pretend to enforce a window we cannot verify, reads accept the credential
 * for as long as the client holds it, and money-moving calls demand their own
 * fresh signature instead (LOOP_WITHDRAW_TTL_MS, and the `mperp-withdraw-v1`
 * envelope in withdrawAuth.ts, which does carry issuedAt).
 *
 * Set LOOP_CRED_TTL_SEC to impose a window — only meaningful once the signed
 * payload carries an issuedAt.
 */
export const LOOP_CRED_TTL_MS = process.env.LOOP_CRED_TTL_SEC
  ? Number(process.env.LOOP_CRED_TTL_SEC) * 1000
  : Number.POSITIVE_INFINITY;

/** Freshness demanded for money-moving calls — /withdraw re-signs every time. */
export const LOOP_WITHDRAW_TTL_MS = Number(process.env.LOOP_WITHDRAW_TTL_SEC ?? 300) * 1000;


// ─── Cloudflare Turnstile (signup bot protection) ────────────────────────
// Guards the two unauthenticated write/oracle endpoints: /validate-invite
// (which otherwise lets a script enumerate valid invite codes for free) and
// /signup. The widget mints a single-use token in the browser; we redeem it
// here against Cloudflare's siteverify API. NEVER verify from the browser.
//
// Set TURNSTILE_SECRET_KEY in .env / .env.lambda (both are gitignored — the
// secret must never be committed). Leaving it unset disables the check, which
// is what local dev wants; production sets it and the middleware fails closed.
export const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
export const TURNSTILE_VERIFY_URL =
  process.env.TURNSTILE_VERIFY_URL
  || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Hostnames the widget is allowed to have been solved on, comma-separated.
 *
 * Cloudflare echoes the solving page's hostname back in the siteverify
 * response. Checking it is what stops someone embedding our sitekey on their
 * own page, farming tokens there, and replaying them at our API — `success:
 * true` alone does not prove the token came from our frontend.
 *
 * Deliberately excludes localhost: dev runs with TURNSTILE_SECRET_KEY unset
 * (check disabled) rather than by widening the production allowlist.
 */
export const TURNSTILE_HOSTNAMES = (process.env.TURNSTILE_HOSTNAMES || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

/** Whether the Turnstile check is active. Both halves are required. */
export const TURNSTILE_ENABLED =
  TURNSTILE_SECRET_KEY !== '' && TURNSTILE_HOSTNAMES.length > 0;


// ─── Referrals ───────────────────────────────────────────────────────────
/**
 * Generated referral-code length. 7 chars over a 27-symbol alphabet is ~33
 * bits — far too large to enumerate, and short enough to read out loud.
 */
export const REFERRAL_CODE_LENGTH = Number(process.env.REFERRAL_CODE_LENGTH || '7');

/**
 * How long a Loop wallet user has to attach a referral code, measured from
 * `users.created_at` — which for Loop users is set the first time they hit an
 * authenticated endpoint after connecting their wallet (see api/me.ts). They
 * never sign up, so there is no form to put the field on; the app prompts
 * them on first connect and the window is the outer bound.
 *
 * Enforced SERVER-SIDE in POST /referral/bind. The UI also hides the field
 * once the window closes, but that is a convenience, not the control.
 *
 * mperps users are unaffected: they bind during signup, atomically.
 */
export const REFERRAL_BIND_WINDOW_HOURS = Number(
  process.env.REFERRAL_BIND_WINDOW_HOURS || '24',
);

/** Base URL used to build the shareable referral link (`<base>/?ref=CODE`). */
export const REFERRAL_LINK_BASE = (
  process.env.REFERRAL_LINK_BASE || 'https://app.mperps.xyz'
).replace(/\/+$/, '');
