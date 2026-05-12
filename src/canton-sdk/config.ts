/**
 * Canton SDK config + template identifiers (devnet branch).
 *
 * Our DApp templates live in package `exchange-v2-core` (1.0.0). Canton
 * resolves `#exchange-v2-core:Module:Template` against the most recent
 * vetted version, so we don't track hex package IDs in code. CIP-56
 * interfaces come from Splice's published packages.
 *
 * See exchange-v2/backend/src/ledger/templates.ts — this file mirrors that
 * surface, trimmed to what the lambda needs.
 */

export interface CantonSdkConfig {
  cantonLedgerApi: string;
  keycloakBase: string;
  keycloakRealm: string;
  keycloakTokenUrl: string;
  keycloakClientId: string;
  keycloakClientSecret: string;
  operatorUsername: string;
  operatorPassword: string;
  /** Stable package reference (e.g. "#exchange-v2-core"). Reserved — most
   *  callers use the constants below directly. */
  packageId: string;
  parties: {
    operator: string;
    vaultPool: string;
    treasury: string;
    tokenIssuer: string;
  };
}

// ─── Our contracts (exchange-v2-core) ────────────────────────────────────
export const TPL_DEPOSIT_RECORD    = '#exchange-v2-core:Vault:DepositRecord';
export const TPL_SETTLEMENT_RECORD = '#exchange-v2-core:Vault:SettlementRecord';

// ─── CIP-56 interfaces (Splice-built, vetted on every Splice validator) ─
export const IFACE_HOLDING =
  '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';
export const IFACE_TRANSFER_FACTORY =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory';
export const IFACE_TRANSFER_INSTRUCTION =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction';

// ─── Choice names ───────────────────────────────────────────────────────
export const CHOICE_TRANSFER_FACTORY_TRANSFER     = 'TransferFactory_Transfer';
export const CHOICE_DEPOSIT_CONSUME_FOR_WITHDRAWAL = 'ConsumeForWithdrawal';
export const CHOICE_DEPOSIT_SPLIT_FOR_WITHDRAWAL   = 'SplitForWithdrawal';

// ─── Keycloak URL builders (used by auth-code flow if/when re-enabled) ──
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

export function getKeycloakLogoutUrl(config: CantonSdkConfig, postLogoutRedirectUri: string): string {
  const base = `${config.keycloakBase}/realms/${config.keycloakRealm}/protocol/openid-connect/logout`;
  const params = new URLSearchParams({
    client_id: config.keycloakClientId,
    post_logout_redirect_uri: postLogoutRedirectUri,
  });
  return `${base}?${params.toString()}`;
}
