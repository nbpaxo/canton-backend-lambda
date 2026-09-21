/**
 * Read-only pre-flight for featured-app activity markers.
 *
 * Answers, against the LIVE ledger, the four questions that gate every
 * downstream step. Touches nothing — no submits, no DB writes.
 *
 *   1. Is NODE_OPERATOR_PARTY_ID configured, and does the party resolve?
 *   2. Does the operator's Canton user hold CanActAs / CanReadAs on it?
 *      (CanActAs is what the sibling-command marker in operatorTransfer.ts
 *       needs; a DelegateProxy would remove that requirement.)
 *   3. Do we already hold a `FeaturedAppRight`? This is the question the
 *      docs answer inconsistently — they claim both that unfeatured apps
 *      can create markers and that a non-featured app cannot accrue one.
 *      The ACS is the only authority that matters.
 *   4. Is `splice-util-featured-app-proxies` vetted on this participant?
 *      Needed before DelegateProxy / WalletUserProxy can be used. It is
 *      NOT uploaded to validators by default; it ships in the Splice
 *      release bundle under ~/.canton/<version>/splice-node/.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/check-featured-app.ts
 */
import {
  CANTON_LEDGER_API,
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  KEYCLOAK_TOKEN_URL,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET,
  OPERATOR_KC_USERNAME,
  OPERATOR_KC_PASSWORD,
  PACKAGE_ID,
  PARTIES,
} from '../src/config.js';
import type { CantonSdkConfig } from '../src/canton-sdk/config.js';
import { IFACE_FEATURED_APP_RIGHT, PKG_FEATURED_APP_PROXIES } from '../src/canton-sdk/config.js';
import { getActiveContracts, listUserRights } from '../src/canton-sdk/ledger.js';
import { getOperatorToken } from '../src/canton-sdk/tokens.js';
import { resolveOperatorCantonId } from '../src/canton-sdk/operator.js';

const config: CantonSdkConfig = {
  cantonLedgerApi: CANTON_LEDGER_API,
  keycloakBase: KEYCLOAK_BASE,
  keycloakRealm: KEYCLOAK_REALM,
  keycloakTokenUrl: KEYCLOAK_TOKEN_URL,
  keycloakClientId: KEYCLOAK_CLIENT_ID,
  keycloakClientSecret: KEYCLOAK_CLIENT_SECRET,
  operatorUsername: OPERATOR_KC_USERNAME,
  operatorPassword: OPERATOR_KC_PASSWORD,
  packageId: PACKAGE_ID,
  parties: PARTIES,
};

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const no = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const hm = (m: string) => console.log(`  \x1b[33m•\x1b[0m ${m}`);

async function main(): Promise<void> {
  console.log(`\nledger: ${CANTON_LEDGER_API}\n`);

  const opToken = await getOperatorToken(config);
  const opUserId = await resolveOperatorCantonId(config);
  console.log(`operator canton user: ${opUserId}`);

  // ── 1. provider party ──────────────────────────────────────────────
  console.log('\n1. provider party (NODE_OPERATOR_PARTY_ID)');
  const provider = PARTIES.nodeOperator;
  if (!provider) {
    no('unset — markers are disabled; nothing else here can pass');
  } else {
    ok(provider);
  }

  // ── 2. rights ──────────────────────────────────────────────────────
  console.log('\n2. operator user rights on the provider party (want: read-only)');
  let canAct = false;
  try {
    const rights = await listUserRights(config, opToken, opUserId);
    canAct = !!provider && rights.actAs.includes(provider);
    const canRead = !!provider && (rights.readAs.includes(provider) || canAct);
    // With DelegateProxy, ABSENT CanActAs is the desired steady state: every
    // proxy choice is controlled by the delegate, and the provider's authority
    // comes from the contract's signatory. A lingering CanActAs means the
    // one-time proxy-creation grant was never revoked.
    canAct
      ? hm('CanActAs  present — expected only during proxy creation; revoke it')
      : ok('CanActAs  absent (correct — DelegateProxy does not need it)');
    canRead ? ok('CanReadAs ✓') : no('CanReadAs — required to see the FeaturedAppRight');
    console.log('     actAs:');
    for (const p of rights.actAs) console.log(`       ${p}`);
    if (rights.actAs.length === 0) console.log('       (none)');
  } catch (e) {
    no(`rights lookup failed: ${(e as Error).message}`);
  }

  // ── 3. FeaturedAppRight ────────────────────────────────────────────
  console.log('\n3. FeaturedAppRight in the ACS');
  if (!provider) {
    hm('skipped — no provider party');
  } else {
    try {
      const contracts = await getActiveContracts(
        config, opToken, provider, { interfaceId: IFACE_FEATURED_APP_RIGHT },
      );
      const mine = contracts.filter((c) => {
        const v = (c.interfaceView ?? c.payload) as { provider?: string };
        return v.provider === provider;
      });
      if (mine.length > 0) {
        ok(`FEATURED — ${mine.length} right(s); cid ${mine[0].contractId.slice(0, 24)}…`);
        hm('markers will be emitted on the next withdrawal');
      } else {
        no('none — not featured yet, so no marker can be created');
        hm('this settles the doc contradiction: no right ⇒ no marker');
      }
    } catch (e) {
      no(`ACS query failed: ${(e as Error).message}`);
      hm('if this is an auth error, it is the CanReadAs gap from step 2');
    }
  }

  // ── 4. proxies package vetted? ─────────────────────────────────────
  console.log('\n4. splice-util-featured-app-proxies vetted on this participant');
  try {
    const res = await fetch(`${CANTON_LEDGER_API}/v2/packages`, {
      headers: { Authorization: `Bearer ${opToken}` },
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json() as { packageIds?: string[] } | string[];
    const ids = Array.isArray(body) ? body : (body.packageIds ?? []);
    if (ids.includes(PKG_FEATURED_APP_PROXIES)) {
      ok(`vetted (${ids.length} packages total)`);
    } else {
      no(`NOT vetted — ${PKG_FEATURED_APP_PROXIES.slice(0, 16)}… absent of ${ids.length} packages`);
      hm('upload with: scripts/setup-delegate-proxy.ts --upload --yes');
    }
  } catch (e) {
    no(`package list failed: ${(e as Error).message}`);
  }

  console.log('');
}

main().catch((e) => {
  console.error(`\nfailed: ${(e as Error).message}\n`);
  process.exit(1);
});
