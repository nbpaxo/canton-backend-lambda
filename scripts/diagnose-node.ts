/**
 * Diagnose the Canton node + Keycloak setup on a fresh devnet.
 *
 * For operator + circle (and any extra parties you pass), this script checks:
 *   1. Canton party exists (POST /v2/parties listing)
 *   2. Keycloak user exists with the expected username
 *   3. Keycloak user can authenticate with the expected password (password grant)
 *   4. Canton user exists whose primaryParty matches the canton party
 *   5. That Canton user has CanActAs + CanReadAs rights on the party
 *
 * It prints a checklist so you can see exactly which step is missing —
 * useful when a dev created Canton parties manually without going through
 * Keycloak.
 *
 * Usage:
 *   npx tsx scripts/diagnose-node.ts
 *
 * Reads from canton-backend-lambda's .env (loaded by config.ts).
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

type Check = { label: string; ok: boolean; detail?: string };

function ok(label: string, detail?: string): Check { return { label, ok: true, detail }; }
function fail(label: string, detail?: string): Check { return { label, ok: false, detail }; }

function printChecks(title: string, checks: Check[]) {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
  for (const c of checks) {
    const icon = c.ok ? '✓' : '✗';
    console.log(`  ${icon} ${c.label}${c.detail ? `  — ${c.detail}` : ''}`);
  }
}

// ─── Canton admin token (via Keycloak app-provider-validator client_credentials)
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
  if (!res.ok) throw new Error(`Canton admin token failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// ─── Keycloak master-realm admin token
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
  if (!res.ok) throw new Error(`KC admin token failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function partyExists(adminToken: string, party: string): Promise<boolean> {
  // Direct lookup by party id — avoids paginating 10k+ parties
  const res = await fetch(`${CANTON_LEDGER_API}/v2/parties/${encodeURIComponent(party)}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) return false;
  const data = await res.json() as { partyDetails?: any[] };
  return Array.isArray(data.partyDetails) && data.partyDetails.length > 0;
}

async function listCantonUsers(adminToken: string) {
  // /v2/users supports pagination via pageToken
  const all: { id: string; primaryParty?: string }[] = [];
  let pageToken: string | undefined;
  let safety = 50;
  do {
    const url = new URL(`${CANTON_LEDGER_API}/v2/users`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!res.ok) throw new Error(`List users failed (${res.status}): ${await res.text()}`);
    const data = await res.json() as { users?: any[]; nextPageToken?: string };
    for (const u of data.users ?? []) all.push({ id: u.id, primaryParty: u.primaryParty });
    pageToken = data.nextPageToken || undefined;
    if (!pageToken) break;
  } while (--safety > 0);
  return all;
}

async function getUserRights(adminToken: string, userId: string) {
  const res = await fetch(`${CANTON_LEDGER_API}/v2/users/${userId}/rights`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) return [];
  const data = await res.json() as { rights?: any[] };
  return data.rights ?? [];
}

async function findKcUser(kcAdminToken: string, username: string) {
  const res = await fetch(
    `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
    { headers: { Authorization: `Bearer ${kcAdminToken}` } },
  );
  if (!res.ok) return null;
  const data = await res.json() as any[];
  return data?.[0] ?? null;
}

async function tryPasswordGrant(username: string, password: string): Promise<{ ok: boolean; detail?: string }> {
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
  if (res.ok) return { ok: true };
  const text = await res.text();
  return { ok: false, detail: `${res.status}: ${text.slice(0, 120)}` };
}

async function diagnoseRole(
  role: 'operator' | 'circle',
  expectedParty: string,
  expectedKcUsername: string,
  expectedKcPassword: string,
  cantonAdminToken: string,
  kcAdminToken: string,
  cantonUsers: { id: string; primaryParty?: string }[],
) {
  const checks: Check[] = [];

  // 1. Canton party exists
  const cantonPartyExists = await partyExists(cantonAdminToken, expectedParty);
  checks.push(
    cantonPartyExists
      ? ok(`Canton party exists: ${expectedParty.split('::')[0]}`)
      : fail(`Canton party MISSING: ${expectedParty}`),
  );

  // 2. Keycloak user exists
  const kcUser = await findKcUser(kcAdminToken, expectedKcUsername);
  checks.push(
    kcUser
      ? ok(`Keycloak user '${expectedKcUsername}' exists`, `id=${kcUser.id}`)
      : fail(`Keycloak user '${expectedKcUsername}' MISSING`),
  );

  // 3. Keycloak password works
  if (kcUser) {
    const grant = await tryPasswordGrant(expectedKcUsername, expectedKcPassword);
    checks.push(
      grant.ok
        ? ok(`Password grant works for '${expectedKcUsername}'`)
        : fail(`Password grant FAILED for '${expectedKcUsername}'`, grant.detail),
    );
  } else {
    checks.push(fail(`Password grant skipped — no KC user`));
  }

  // 4. Canton user exists with matching primaryParty
  const matchingCantonUsers = cantonUsers.filter(u => u.primaryParty === expectedParty);
  let cantonUserId: string | null = null;
  if (matchingCantonUsers.length === 0) {
    checks.push(fail(`Canton user with primaryParty=${role} MISSING`,
      `(no /v2/users entry maps to this party — getOperatorToken/resolveOperatorCantonId will fail)`));
  } else {
    cantonUserId = matchingCantonUsers[0]!.id;
    checks.push(ok(`Canton user with primaryParty=${role} exists`, `id=${cantonUserId}`));

    // 4b. Verify Canton user id matches Keycloak user UUID (so JWT 'sub' lines up)
    if (kcUser && kcUser.id !== cantonUserId) {
      checks.push(fail(
        `Canton user id ≠ Keycloak UUID`,
        `KC=${kcUser.id} Canton=${cantonUserId} — JWT 'sub' won't match!`,
      ));
    } else if (kcUser) {
      checks.push(ok(`Canton user id == Keycloak UUID`));
    }
  }

  // 5. Rights granted
  if (cantonUserId) {
    const rights = await getUserRights(cantonAdminToken, cantonUserId);
    const canActAs = rights.some(r =>
      r.kind?.CanActAs?.value?.party === expectedParty,
    );
    const canReadAs = rights.some(r =>
      r.kind?.CanReadAs?.value?.party === expectedParty,
    );
    checks.push(canActAs ? ok(`CanActAs(${role}) granted`) : fail(`CanActAs(${role}) MISSING`));
    checks.push(canReadAs ? ok(`CanReadAs(${role}) granted`) : fail(`CanReadAs(${role}) MISSING`));
  }

  printChecks(`[${role.toUpperCase()}] expected party = ${expectedParty.split('::')[0]}`, checks);
  return checks;
}

async function main() {
  console.log(`\nDiagnosing node:`);
  console.log(`  CANTON_LEDGER_API = ${CANTON_LEDGER_API}`);
  console.log(`  KEYCLOAK_BASE     = ${KEYCLOAK_BASE}`);
  console.log(`  KEYCLOAK_REALM    = ${KEYCLOAK_REALM}`);
  console.log(`  expected operator = ${PARTIES.operator}`);
  console.log(`  expected circle   = ${PARTIES.tokenIssuer}`);
  console.log(`  expected vaultPool= ${PARTIES.vaultPool}`);

  const cantonAdminToken = await getCantonAdminToken().catch(e => {
    console.error(`\n✗ Could not get Canton admin token: ${e.message}`);
    console.error(`  Check KEYCLOAK_CLIENT_ID/SECRET in .env are valid for this node.`);
    process.exit(1);
  });

  const kcAdminToken = await getKcAdminToken().catch(e => {
    console.error(`\n✗ Could not get Keycloak master-realm admin token: ${e.message}`);
    console.error(`  Set KC_ADMIN_USERNAME/PASSWORD env vars if 'admin/admin' isn't right.`);
    process.exit(1);
  });

  console.log(`\n✓ Got admin tokens (Canton + Keycloak master)`);

  const cantonUsers = await listCantonUsers(cantonAdminToken);

  console.log(`✓ Canton has ${cantonUsers.length} users (parties looked up directly)`);

  await diagnoseRole(
    'operator',
    PARTIES.operator,
    OPERATOR_KC_USERNAME,
    OPERATOR_KC_PASSWORD,
    cantonAdminToken,
    kcAdminToken,
    cantonUsers,
  );

  await diagnoseRole(
    'circle',
    PARTIES.tokenIssuer,
    CIRCLE_KC_USERNAME,
    CIRCLE_KC_PASSWORD,
    cantonAdminToken,
    kcAdminToken,
    cantonUsers,
  );

  // Bonus: list pool parties (vaultPool, treasury) — these don't need KC users,
  // but operator must have CanActAs/CanReadAs on them.
  console.log(`\n[POOLS] (operator must have rights on these)`);
  console.log(`────────`);
  const poolParties: Array<{ name: string; party: string }> = [
    { name: 'vaultPool', party: PARTIES.vaultPool },
    { name: 'treasury', party: PARTIES.treasury },
  ];

  const opCantonUser = cantonUsers.find(u => u.primaryParty === PARTIES.operator);
  for (const pp of poolParties) {
    const exists = await partyExists(cantonAdminToken, pp.party);
    console.log(`  ${exists ? '✓' : '✗'} ${pp.name} party ${exists ? 'exists' : 'MISSING'}: ${pp.party.split('::')[0]}`);
    if (opCantonUser && exists) {
      const rights = await getUserRights(cantonAdminToken, opCantonUser.id);
      const canActAs = rights.some(r => r.kind?.CanActAs?.value?.party === pp.party);
      const canReadAs = rights.some(r => r.kind?.CanReadAs?.value?.party === pp.party);
      console.log(`     ${canActAs ? '✓' : '✗'} operator CanActAs(${pp.name})  ${canActAs ? '' : '— MISSING'}`);
      console.log(`     ${canReadAs ? '✓' : '✗'} operator CanReadAs(${pp.name}) ${canReadAs ? '' : '— MISSING'}`);
    }
  }

  console.log(`\nDone.\n`);
}

main().catch(e => {
  console.error(`\nFatal:`, e);
  process.exit(1);
});
