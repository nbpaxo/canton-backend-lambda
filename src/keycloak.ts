/**
 * Keycloak admin helpers shared across routes (signup, KYC, …).
 *
 * `getKcAdminToken` mints (and caches) a `master`-realm admin-cli token used
 * for the Keycloak Admin REST API. `getKcUserEmailBySub` resolves a user's
 * email from their `sub` (UUID) — the validator party id's local-part IS the
 * Keycloak sub, so this lets us recover the email for users who were onboarded
 * outside our `/signup` flow (and therefore have no email persisted in our DB).
 */
import {
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  KC_ADMIN_USERNAME,
  KC_ADMIN_PASSWORD,
} from './config.js';

let kcAdminTokenCache: { token: string; expiry: number } | null = null;

export async function getKcAdminToken(): Promise<string> {
  if (kcAdminTokenCache && Date.now() < kcAdminTokenCache.expiry - 30_000) {
    return kcAdminTokenCache.token;
  }

  const res = await fetch(`${KEYCLOAK_BASE}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'admin-cli',
      username: KC_ADMIN_USERNAME,
      password: KC_ADMIN_PASSWORD,
      grant_type: 'password',
    }),
  });

  if (!res.ok) throw new Error(`KC admin token failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  kcAdminTokenCache = { token: data.access_token, expiry: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

/**
 * Look up a Keycloak user's email by their `sub` (UUID). Returns the lowercased
 * email, or null if the user is unknown / has no email on file.
 */
export async function getKcUserEmailBySub(sub: string): Promise<string | null> {
  const token = await getKcAdminToken();
  const res = await fetch(
    `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users/${encodeURIComponent(sub)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const u = (await res.json()) as { email?: string };
  return u.email?.trim().toLowerCase() || null;
}
