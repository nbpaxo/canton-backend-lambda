/**
 * Configuration — all values come from environment variables.
 * Lambda-friendly: no hardcoded URLs.
 */
// Load .env file for local dev — on Lambda, env vars are set natively
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  await import('dotenv/config');
}

// Canton Ledger
export const CANTON_LEDGER_API = process.env.CANTON_LEDGER_API || 'http://localhost:3975';

// Keycloak (for JWKS verification + operator token)
export const KEYCLOAK_BASE = process.env.KEYCLOAK_BASE || 'http://keycloak.localhost:8082';
export const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'AppProvider';
export const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || 'app-provider-validator';
export const KEYCLOAK_CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET || 'AL8648b9SfdTFImq7FV56Vd0KHifHBuC';
export const KEYCLOAK_TOKEN_URL = `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;

// Operator Keycloak credentials
export const OPERATOR_KC_USERNAME = process.env.OPERATOR_KC_USERNAME || 'operator';
export const OPERATOR_KC_PASSWORD = process.env.OPERATOR_KC_PASSWORD || 'operator';

// Circle (token issuer) Keycloak credentials — for minting USDC
export const CIRCLE_KC_USERNAME = process.env.CIRCLE_KC_USERNAME || 'circle';
export const CIRCLE_KC_PASSWORD = process.env.CIRCLE_KC_PASSWORD || 'circle';

// Daml package ID
export const PACKAGE_ID = process.env.PACKAGE_ID || '20dda9c77959da83a4cdcf8ad07dc95afcf335ec27a421e530268c8de775481f';

// Participant suffix (fingerprint)
export const PARTICIPANT_SUFFIX = process.env.PARTICIPANT_SUFFIX || '1220327e3eff51506a46b72ae1ec0c05471754a2fadbc1440b22991dd125778b6d26';

// Party IDs
export const PARTIES = {
  operator: `operator::${PARTICIPANT_SUFFIX}`,
  vaultPool: `vaultpool::${PARTICIPANT_SUFFIX}`,
  treasury: `treasury::${PARTICIPANT_SUFFIX}`,
  tokenIssuer: `circle::${PARTICIPANT_SUFFIX}`,
} as const;

// Exchange API (the real deployed exchange backend)
export const EXCHANGE_DEPOSIT_URL = process.env.EXCHANGE_DEPOSIT_URL || 'https://be.zeromile.xyz/v1/deposit/defi';
export const EXCHANGE_WITHDRAW_URL = process.env.EXCHANGE_WITHDRAW_URL || 'https://be.mperps.xyz/v1/withdraw/defi';

// CORS allowed origins
export const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000,https://testnet.mperps.xyz').split(',');

// Postgres (devnet branch — replaces DynamoDB for invite codes / users / KYC).
// Defaults match the docker-compose service.
export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://canton_backend:canton_backend@localhost:5436/canton_backend';

// Admin API key (for admin endpoints like invite code management)
export const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'canton-admin-secret';

// Server port (for local dev; Lambda ignores this)
export const PORT = Number(process.env.PORT) || 3003;
