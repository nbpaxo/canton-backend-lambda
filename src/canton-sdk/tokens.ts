/**
 * Keycloak Token Management
 *
 * Handles all three token types used with Canton:
 * - Admin token (client_credentials) — for user management APIs
 * - Operator token (password grant) — for operator-side ledger commands
 * - User token (auth code exchange + refresh) — for user-side ledger commands
 */

import type { CantonSdkConfig } from './config.js';

// ─── Cached Tokens ───────────────────────────────────────────────────────────

let adminToken: string | null = null;
let adminTokenExpiry = 0;

let operatorToken: string | null = null;
let operatorRefreshToken: string | null = null;
let operatorTokenExpiry = 0;

/**
 * Get an admin/service-account token (client_credentials grant).
 * Used for Canton admin APIs: list users, grant rights, look up user by sub.
 * NOT used for ledger commands.
 */
export async function getAdminToken(config: CantonSdkConfig): Promise<string> {
  if (adminToken && Date.now() < adminTokenExpiry - 30_000) {
    return adminToken;
  }

  const res = await fetch(config.keycloakTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.keycloakClientId,
      client_secret: config.keycloakClientSecret,
      grant_type: 'client_credentials',
      scope: 'openid',
    }),
  });

  if (!res.ok) {
    throw new Error(`Admin token request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  adminToken = data.access_token;
  adminTokenExpiry = Date.now() + data.expires_in * 1000;
  return adminToken;
}

/**
 * Get operator token (password grant with auto-refresh).
 * This token carries CanActAs(operator, vaultpool, treasury).
 * Used for all operator-side Canton commands (deposits, withdrawals, settlements).
 */
export async function getOperatorToken(config: CantonSdkConfig): Promise<string> {
  if (operatorToken && Date.now() < operatorTokenExpiry - 30_000) {
    return operatorToken;
  }

  // Try refresh first
  if (operatorRefreshToken) {
    try {
      const res = await fetch(config.keycloakTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.keycloakClientId,
          client_secret: config.keycloakClientSecret,
          grant_type: 'refresh_token',
          refresh_token: operatorRefreshToken,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
        operatorToken = data.access_token;
        operatorRefreshToken = data.refresh_token;
        operatorTokenExpiry = Date.now() + data.expires_in * 1000;
        return operatorToken;
      }
    } catch {
      // Fall through to password grant
    }
  }

  // Password grant
  const res = await fetch(config.keycloakTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.keycloakClientId,
      client_secret: config.keycloakClientSecret,
      grant_type: 'password',
      username: config.operatorUsername,
      password: config.operatorPassword,
      scope: 'openid',
    }),
  });

  if (!res.ok) {
    throw new Error(`Operator token request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  operatorToken = data.access_token;
  operatorRefreshToken = data.refresh_token;
  operatorTokenExpiry = Date.now() + data.expires_in * 1000;
  return operatorToken;
}

// ─── Circle Token (token issuer — password grant) ───────────────────────────

let circleToken: string | null = null;
let circleRefreshToken: string | null = null;
let circleTokenExpiry = 0;

/**
 * Get circle (token issuer) token via password grant.
 * This token carries CanActAs(circle/tokenIssuer).
 * Used for minting USDC (creating MintProposals).
 */
export async function getCircleToken(
  config: CantonSdkConfig,
  circleUsername: string,
  circlePassword: string,
): Promise<string> {
  if (circleToken && Date.now() < circleTokenExpiry - 30_000) {
    return circleToken;
  }

  // Try refresh first
  if (circleRefreshToken) {
    try {
      const res = await fetch(config.keycloakTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.keycloakClientId,
          client_secret: config.keycloakClientSecret,
          grant_type: 'refresh_token',
          refresh_token: circleRefreshToken,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
        circleToken = data.access_token;
        circleRefreshToken = data.refresh_token;
        circleTokenExpiry = Date.now() + data.expires_in * 1000;
        return circleToken;
      }
    } catch {
      // Fall through to password grant
    }
  }

  // Password grant
  const res = await fetch(config.keycloakTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.keycloakClientId,
      client_secret: config.keycloakClientSecret,
      grant_type: 'password',
      username: circleUsername,
      password: circlePassword,
      scope: 'openid',
    }),
  });

  if (!res.ok) {
    throw new Error(`Circle token request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  circleToken = data.access_token;
  circleRefreshToken = data.refresh_token;
  circleTokenExpiry = Date.now() + data.expires_in * 1000;
  return circleToken;
}

/**
 * Exchange an OAuth2 authorization code for Keycloak tokens.
 * Called during user login — replaces MetaMask nonce/signature flow.
 */
export async function exchangeAuthCode(
  config: CantonSdkConfig,
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number; id_token: string }> {
  const res = await fetch(config.keycloakTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.keycloakClientId,
      client_secret: config.keycloakClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    throw new Error(`Auth code exchange failed (${res.status}): ${await res.text()}`);
  }

  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number; id_token: string }>;
}

/**
 * Refresh a user's Keycloak access token.
 * Call this before Canton commands if the user's token may be expired.
 */
export async function refreshUserToken(
  config: CantonSdkConfig,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(config.keycloakTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.keycloakClientId,
      client_secret: config.keycloakClientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }

  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}
