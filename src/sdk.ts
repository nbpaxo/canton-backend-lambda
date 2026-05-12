/**
 * Canton SDK instance.
 */

import { createCantonSdk, type CantonSdkConfig } from './canton-sdk/index.js';
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
} from './config.js';

const sdkConfig: CantonSdkConfig = {
  cantonLedgerApi: CANTON_LEDGER_API,
  keycloakBase: KEYCLOAK_BASE,
  keycloakRealm: KEYCLOAK_REALM,
  keycloakTokenUrl: KEYCLOAK_TOKEN_URL,
  keycloakClientId: KEYCLOAK_CLIENT_ID,
  keycloakClientSecret: KEYCLOAK_CLIENT_SECRET,
  operatorUsername: OPERATOR_KC_USERNAME,
  operatorPassword: OPERATOR_KC_PASSWORD,
  packageId: PACKAGE_ID,
  parties: {
    operator: PARTIES.operator,
    vaultPool: PARTIES.vaultPool,
    treasury: PARTIES.treasury,
    tokenIssuer: PARTIES.tokenIssuer,
  },
};

export const canton = createCantonSdk(sdkConfig);
export { sdkConfig };
