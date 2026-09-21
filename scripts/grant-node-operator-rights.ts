/**
 * Grant the operator's Canton user a right on the node-operator (validator) party.
 *
 * WHY ONLY CanReadAs IS NORMALLY NEEDED
 * -------------------------------------
 * With the `DelegateProxy` design, the backend exercises
 * `DelegateProxy_TransferFactory_Transfer`, whose controller is the DELEGATE
 * (our operator party). The provider's authority is supplied by the proxy
 * contract's signatory, not by `actAs`. So the backend never needs to act as
 * the validator party — which holds the node's CC and its ValidatorRight
 * contracts, and is not something a public-facing Lambda should be able to
 * spend from.
 *
 * It does still need to SEE the provider's `FeaturedAppRight` in order to pass
 * its cid into the proxy choice, and the ACS is read per-party. Hence
 * CanReadAs: visibility, no spend authority.
 *
 * CanActAs is needed exactly once, to CREATE the DelegateProxy (signatory =
 * provider). Grant it, create the proxy, then revoke it and keep only the read
 * right.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/grant-node-operator-rights.ts            # dry run
 *   npx tsx --env-file=.env scripts/grant-node-operator-rights.ts --yes
 *   npx tsx --env-file=.env scripts/grant-node-operator-rights.ts --act --yes  # one-time, for proxy creation
 *   npx tsx --env-file=.env scripts/grant-node-operator-rights.ts --revoke-act --yes  # drop back to read-only
 */
import {
  CANTON_LEDGER_API, KEYCLOAK_BASE, KEYCLOAK_REALM, KEYCLOAK_TOKEN_URL,
  KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, OPERATOR_KC_USERNAME,
  OPERATOR_KC_PASSWORD, PACKAGE_ID, PARTIES,
} from '../src/config.js';
import type { CantonSdkConfig } from '../src/canton-sdk/config.js';
import { grantRight, listUserRights, revokeRight } from '../src/canton-sdk/ledger.js';
import { getAdminToken, getOperatorToken } from '../src/canton-sdk/tokens.js';
import { resolveOperatorCantonId } from '../src/canton-sdk/operator.js';

const config: CantonSdkConfig = {
  cantonLedgerApi: CANTON_LEDGER_API, keycloakBase: KEYCLOAK_BASE,
  keycloakRealm: KEYCLOAK_REALM, keycloakTokenUrl: KEYCLOAK_TOKEN_URL,
  keycloakClientId: KEYCLOAK_CLIENT_ID, keycloakClientSecret: KEYCLOAK_CLIENT_SECRET,
  operatorUsername: OPERATOR_KC_USERNAME, operatorPassword: OPERATOR_KC_PASSWORD,
  packageId: PACKAGE_ID, parties: PARTIES,
};

async function main(): Promise<void> {
  const apply = process.argv.includes('--yes');
  const wantAct = process.argv.includes('--act');
  const revokeAct = process.argv.includes('--revoke-act');
  const party = PARTIES.nodeOperator;
  if (!party) throw new Error('NODE_OPERATOR_PARTY_ID is unset');

  const opToken = await getOperatorToken(config);
  const userId = await resolveOperatorCantonId(config);

  const before = await listUserRights(config, opToken, userId);
  console.log(`\nuser  : ${userId}`);
  console.log(`party : ${party}`);
  console.log(`before: CanActAs=${before.actAs.includes(party)} CanReadAs=${before.readAs.includes(party)}`);

  // Revoke path: drop CanActAs, keep CanReadAs. This is the steady state —
  // every DelegateProxy choice is controlled by the delegate, so the backend
  // only ever needs to SEE the provider's contracts, never act as it.
  if (revokeAct) {
    if (!before.actAs.includes(party)) {
      console.log('\nCanActAs is already absent — nothing to revoke.\n');
      return;
    }
    if (!apply) {
      console.log('\nDRY RUN — would revoke CanActAs (keeping CanReadAs). Re-run with --yes.\n');
      return;
    }
    await revokeRight(config, await getAdminToken(config), userId, 'CanActAs', party);
    const after = await listUserRights(config, opToken, userId);
    console.log(`after : CanActAs=${after.actAs.includes(party)} CanReadAs=${after.readAs.includes(party)}`);
    if (after.actAs.includes(party)) {
      console.error('\n⚠  CanActAs STILL PRESENT — revoke did not take effect. Investigate.\n');
      process.exit(1);
    }
    console.log('\n✓ back to read-only on the provider party.\n');
    return;
  }

  const kinds: Array<'CanActAs' | 'CanReadAs'> = wantAct ? ['CanActAs', 'CanReadAs'] : ['CanReadAs'];
  if (!apply) {
    console.log(`\nDRY RUN — would grant ${kinds.join(' + ')}. Re-run with --yes to apply.\n`);
    return;
  }

  const adminToken = await getAdminToken(config);
  for (const kind of kinds) {
    await grantRight(config, adminToken, userId, kind, party);
    console.log(`granted ${kind}`);
  }

  const after = await listUserRights(config, opToken, userId);
  console.log(`after : CanActAs=${after.actAs.includes(party)} CanReadAs=${after.readAs.includes(party)}`);
  if (wantAct) {
    console.log('\n⚠  CanActAs is granted. Revoke it once the DelegateProxy exists:');
    console.log('   npx tsx --env-file=.env scripts/grant-node-operator-rights.ts --revoke-act --yes\n');
  } else {
    console.log('');
  }
}

main().catch((e) => { console.error(`\nfailed: ${(e as Error).message}\n`); process.exit(1); });
