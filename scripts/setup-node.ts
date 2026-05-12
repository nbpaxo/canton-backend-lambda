/**
 * Bootstrap a fresh Canton node so our backend can talk to it.
 *
 * Idempotent — safe to re-run. For each role (operator, circle), this script:
 *   1. Verifies the Canton party exists.
 *   2. Looks up the existing Canton user that owns that primaryParty (if any).
 *   3. Creates the Keycloak user (idempotent — skips if it already exists).
 *      Tries to use the existing Canton user id as the KC UUID so the JWT
 *      `sub` matches Canton's userId enforcement.
 *   4. If KC's actual UUID differs from the Canton user id, deletes the old
 *      Canton user and recreates it with the new KC UUID.
 *   5. Re-grants CanActAs + CanReadAs.
 *   6. For operator: also grants CanActAs/CanReadAs on vaultPool + treasury.
 *
 * After this script, getOperatorToken() / getCircleToken() / submitCommand
 * will all succeed — signup and faucet will work.
 *
 * Usage:
 *   npx tsx scripts/setup-node.ts
 */

import 'dotenv/config';
import {
  CANTON_LEDGER_API,
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET,
  PARTIES,
  CIRCLE_KC_USERNAME,
  CIRCLE_KC_PASSWORD,
  OPERATOR_KC_USERNAME,
  OPERATOR_KC_PASSWORD,
} from '../src/config.js';

const KC_ADMIN_USERNAME = process.env.KC_ADMIN_USERNAME || 'admin';
const KC_ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD || 'admin';

// ─── Token helpers ──────────────────────────────────────────────────────────

async function getCantonAdminToken(): Promise<string> {
  const res = await fetch(`${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: KEYCLOAK_CLIENT_ID,
      client_secret: KEYCLOAK_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Canton admin token failed: ${await res.text()}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function getKcAdminToken(): Promise<string> {
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
  if (!res.ok) throw new Error(`KC admin token failed: ${await res.text()}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// ─── Canton helpers ─────────────────────────────────────────────────────────

async function findCantonUserByPrimaryParty(adminToken: string, party: string) {
  // Paginate through all users
  let pageToken: string | undefined;
  let safety = 50;
  do {
    const url = new URL(`${CANTON_LEDGER_API}/v2/users`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } });
    if (!res.ok) throw new Error(`List Canton users failed: ${await res.text()}`);
    const data = await res.json() as { users?: any[]; nextPageToken?: string };
    const match = (data.users ?? []).find(u => u.primaryParty === party);
    if (match) return match;
    pageToken = data.nextPageToken || undefined;
    if (!pageToken) break;
  } while (--safety > 0);
  return null;
}

async function createCantonUser(adminToken: string, id: string, primaryParty: string) {
  const res = await fetch(`${CANTON_LEDGER_API}/v2/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: {
        id,
        primaryParty,
        isDeactivated: false,
        metadata: { resourceVersion: '', annotations: {} },
        identityProviderId: '',
      },
    }),
  });
  if (!res.ok) throw new Error(`Create Canton user failed: ${await res.text()}`);
}

async function deleteCantonUser(adminToken: string, id: string) {
  const res = await fetch(`${CANTON_LEDGER_API}/v2/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete Canton user failed: ${await res.text()}`);
  }
}

async function grantRight(
  adminToken: string,
  userId: string,
  kind: 'CanActAs' | 'CanReadAs',
  party: string,
) {
  const res = await fetch(`${CANTON_LEDGER_API}/v2/users/${userId}/rights`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      rights: [{ kind: { [kind]: { value: { party } } } }],
      identityProviderId: '',
    }),
  });
  const text = await res.text();
  if (!res.ok && !/already|duplicate|EXIST|RIGHTS/i.test(text)) {
    throw new Error(`Grant ${kind}(${party.split('::')[0]}) failed: ${text}`);
  }
}

// ─── Keycloak helpers ───────────────────────────────────────────────────────

async function findKcUser(kcAdminToken: string, username: string) {
  const res = await fetch(
    `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
    { headers: { Authorization: `Bearer ${kcAdminToken}` } },
  );
  if (!res.ok) throw new Error(`Find KC user failed: ${await res.text()}`);
  const data = await res.json() as any[];
  return data?.[0] ?? null;
}

async function createKcUser(
  kcAdminToken: string,
  username: string,
  password: string,
  preferredId?: string,
) {
  const body: any = {
    username,
    enabled: true,
    emailVerified: true,
    requiredActions: [],
    credentials: [{ type: 'password', value: password, temporary: false }],
  };
  if (preferredId) body.id = preferredId;

  const res = await fetch(
    `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${kcAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok && res.status !== 409) {
    throw new Error(`Create KC user '${username}' failed (${res.status}): ${await res.text()}`);
  }
}

/** Ensure a KC user has no pending required actions (e.g. on a re-run where
 *  the user was created without our flags). */
async function clearKcRequiredActions(
  kcAdminToken: string,
  userId: string,
  username: string,
  password: string,
) {
  const res = await fetch(
    `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users/${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${kcAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        enabled: true,
        emailVerified: true,
        requiredActions: [],
        credentials: [{ type: 'password', value: password, temporary: false }],
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Clear required actions for '${username}' failed: ${await res.text()}`);
  }
}

async function verifyPasswordGrant(username: string, password: string) {
  const res = await fetch(`${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: KEYCLOAK_CLIENT_ID,
      client_secret: KEYCLOAK_CLIENT_SECRET,
      grant_type: 'password',
      username,
      password,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Password grant for '${username}' failed: ${res.status} ${text.slice(0, 150)}`);
  }
}

// ─── Setup a single role ────────────────────────────────────────────────────

async function setupRole(
  role: 'operator' | 'circle',
  party: string,
  kcUsername: string,
  kcPassword: string,
  cantonAdminToken: string,
  kcAdminToken: string,
  extraPartiesForActAs: string[] = [],
) {
  console.log(`\n[${role.toUpperCase()}] setup`);
  console.log('─'.repeat(role.length + 8));

  // 1. Look up existing Canton user (created manually by dev)
  const existingCantonUser = await findCantonUserByPrimaryParty(cantonAdminToken, party);
  console.log(`  • existing Canton user: ${existingCantonUser ? existingCantonUser.id : '(none)'}`);

  // 2. Look up existing Keycloak user
  let kcUser = await findKcUser(kcAdminToken, kcUsername);
  console.log(`  • existing KC user:     ${kcUser ? kcUser.id : '(none)'}`);

  // 3. Create KC user if missing — try to align id with Canton user id
  if (!kcUser) {
    const preferredId = existingCantonUser?.id;
    console.log(`  ▸ creating KC user '${kcUsername}'${preferredId ? ` (preferred id=${preferredId})` : ''}`);
    await createKcUser(kcAdminToken, kcUsername, kcPassword, preferredId);
    kcUser = await findKcUser(kcAdminToken, kcUsername);
    if (!kcUser) throw new Error(`KC user '${kcUsername}' was not found after creation`);
    console.log(`  ✓ KC user created with id=${kcUser.id}`);
  } else {
    // Already exists — clear any required actions and reset password to known value
    console.log(`  ▸ updating KC user (clear required actions, reset password)`);
    await clearKcRequiredActions(kcAdminToken, kcUser.id, kcUsername, kcPassword);
  }

  // 4. Verify password grant works (signup will use this!)
  await verifyPasswordGrant(kcUsername, kcPassword);
  console.log(`  ✓ password grant works`);

  // 5. Reconcile: KC UUID must == Canton user id (otherwise JWT.sub != userId)
  let cantonUserId = existingCantonUser?.id;
  if (existingCantonUser && existingCantonUser.id !== kcUser.id) {
    console.log(`  ⚠ KC UUID (${kcUser.id}) differs from Canton user id (${existingCantonUser.id})`);
    console.log(`  ▸ deleting old Canton user and recreating with KC UUID`);
    await deleteCantonUser(cantonAdminToken, existingCantonUser.id);
    await createCantonUser(cantonAdminToken, kcUser.id, party);
    cantonUserId = kcUser.id;
    console.log(`  ✓ Canton user recreated as ${cantonUserId}`);
  } else if (!existingCantonUser) {
    console.log(`  ▸ creating Canton user id=${kcUser.id} primaryParty=${role}`);
    await createCantonUser(cantonAdminToken, kcUser.id, party);
    cantonUserId = kcUser.id;
  } else {
    console.log(`  ✓ Canton user id matches KC UUID`);
  }

  // 6. Grant rights (idempotent)
  await grantRight(cantonAdminToken, cantonUserId!, 'CanActAs', party);
  await grantRight(cantonAdminToken, cantonUserId!, 'CanReadAs', party);
  console.log(`  ✓ CanActAs + CanReadAs granted on ${role}`);

  // 7. Extra parties (operator needs vaultPool + treasury)
  for (const p of extraPartiesForActAs) {
    await grantRight(cantonAdminToken, cantonUserId!, 'CanActAs', p);
    await grantRight(cantonAdminToken, cantonUserId!, 'CanReadAs', p);
    console.log(`  ✓ CanActAs + CanReadAs granted on ${p.split('::')[0]}`);
  }
}

async function main() {
  console.log(`\nSetting up node:`);
  console.log(`  CANTON_LEDGER_API = ${CANTON_LEDGER_API}`);
  console.log(`  KEYCLOAK_BASE     = ${KEYCLOAK_BASE}`);

  const cantonAdminToken = await getCantonAdminToken();
  const kcAdminToken = await getKcAdminToken();

  await setupRole(
    'operator',
    PARTIES.operator,
    OPERATOR_KC_USERNAME,
    OPERATOR_KC_PASSWORD,
    cantonAdminToken,
    kcAdminToken,
    [PARTIES.vaultPool, PARTIES.treasury],
  );

  await setupRole(
    'circle',
    PARTIES.tokenIssuer,
    CIRCLE_KC_USERNAME,
    CIRCLE_KC_PASSWORD,
    cantonAdminToken,
    kcAdminToken,
  );

  console.log(`\nSetup complete. Now run:`);
  console.log(`  npx tsx scripts/diagnose-node.ts`);
  console.log(`to verify all checks pass.\n`);
}

main().catch(e => {
  console.error(`\nFatal:`, e.message);
  process.exit(1);
});
