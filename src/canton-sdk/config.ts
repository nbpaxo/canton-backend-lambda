/**
 * Canton SDK Configuration
 *
 * All Canton-specific configuration lives here.
 * Exchange developers only need to set these values once.
 */

export interface CantonSdkConfig {
  /** Canton Ledger API base URL (e.g., http://localhost:3975) */
  cantonLedgerApi: string;

  /** Keycloak base URL (e.g., http://localhost:8082) */
  keycloakBase: string;

  /** Keycloak realm name */
  keycloakRealm: string;

  /** Keycloak token endpoint URL (derived from base + realm if not set) */
  keycloakTokenUrl: string;

  /** Keycloak client ID (the client Canton trusts) */
  keycloakClientId: string;

  /** Keycloak client secret */
  keycloakClientSecret: string;

  /** Operator Keycloak username (password grant) */
  operatorUsername: string;

  /** Operator Keycloak password */
  operatorPassword: string;

  /** Daml package ID (changes per deployment) */
  packageId: string;

  /** Canton party IDs */
  parties: {
    operator: string;
    vaultPool: string;
    treasury: string;
    tokenIssuer: string;
  };
}

/**
 * Build the Keycloak authorization URL for user login.
 * Frontend redirects to this URL → Keycloak login page → redirects back with ?code=
 */
export function getKeycloakAuthUrl(config: CantonSdkConfig, redirectUri: string): string {
  const base = `${config.keycloakBase}/realms/${config.keycloakRealm}/protocol/openid-connect/auth`;
  const params = new URLSearchParams({
    client_id: config.keycloakClientId,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri,
  });
  return `${base}?${params.toString()}`;
}

/**
 * Build the Keycloak logout URL.
 * Redirects user to Keycloak to end their SSO session, then back to the app.
 */
export function getKeycloakLogoutUrl(config: CantonSdkConfig, postLogoutRedirectUri: string): string {
  const base = `${config.keycloakBase}/realms/${config.keycloakRealm}/protocol/openid-connect/logout`;
  const params = new URLSearchParams({
    client_id: config.keycloakClientId,
    post_logout_redirect_uri: postLogoutRedirectUri,
  });
  return `${base}?${params.toString()}`;
}

/** Derive Daml template IDs from package ID */
export function getTemplateIds(packageId: string) {
  return {
    Holding: `${packageId}:Token:Holding`,
    TransferInstruction: `${packageId}:Token:TransferInstruction`,
    VaultAccount: `${packageId}:Vault:VaultAccount`,
    DepositReceipt: `${packageId}:Vault:DepositReceipt`,
    VaultAccountProposal: `${packageId}:Vault:VaultAccountProposal`,
    MintProposal: `${packageId}:Token:MintProposal`,
  } as const;
}
