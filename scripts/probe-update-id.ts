import { CANTON_LEDGER_API, PARTIES, KEYCLOAK_BASE, KEYCLOAK_REALM, KEYCLOAK_TOKEN_URL,
  KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, OPERATOR_KC_USERNAME, OPERATOR_KC_PASSWORD,
  PACKAGE_ID } from '../src/config.js';
import { getOperatorToken } from '../src/canton-sdk/tokens.js';
import { CantonSdkConfig } from '../src/canton-sdk/config.js';

async function main() {
  const cfg: CantonSdkConfig = {
    cantonLedgerApi: CANTON_LEDGER_API, keycloakBase: KEYCLOAK_BASE,
    keycloakRealm: KEYCLOAK_REALM, keycloakTokenUrl: KEYCLOAK_TOKEN_URL,
    keycloakClientId: KEYCLOAK_CLIENT_ID, keycloakClientSecret: KEYCLOAK_CLIENT_SECRET,
    operatorUsername: OPERATOR_KC_USERNAME, operatorPassword: OPERATOR_KC_PASSWORD,
    packageId: PACKAGE_ID, parties: PARTIES,
  };
  const cid = process.argv[2];
  const token = await getOperatorToken(cfg);

  console.log('── events-by-contract-id ──');
  const r1 = await fetch(`${CANTON_LEDGER_API}/v2/events/events-by-contract-id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contractId: cid,
      eventFormat: { filtersByParty: {
        [PARTIES.operator]:  { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] },
        [PARTIES.treasury]:  { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] },
        [PARTIES.vaultPool]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] },
      }, verbose: false },
    }),
  });
  const j1: any = await r1.json();
  console.log(JSON.stringify(j1).slice(0, 1500));

  const offset = j1?.created?.offset ?? j1?.created?.createdEvent?.offset;
  console.log('\noffset:', offset);

  if (offset) {
    console.log('\n── update-by-offset ──');
    const r2 = await fetch(`${CANTON_LEDGER_API}/v2/updates/update-by-offset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset,
        updateFormat: {
          includeTransactions: {
            eventFormat: { filtersByParty: {
        [PARTIES.operator]:  { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] },
        [PARTIES.treasury]:  { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] },
        [PARTIES.vaultPool]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] },
      }, verbose: false },
            transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
          },
        },
      }),
    });
    const j2: any = await r2.json();
    console.log(JSON.stringify(j2).slice(0, 2000));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
