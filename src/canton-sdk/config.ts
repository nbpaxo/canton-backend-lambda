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
    /** Featured-app provider party (the validator/node operator). Optional:
     *  when absent or empty, activity-marker emission is disabled. */
    nodeOperator?: string;
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

// ─── Featured app rewards (CIP-0047 / CIP-0078) ─────────────────────────
// `splice-api-featured-app-v1` is vetted on every Splice validator — it
// ships inside the utility-registry DARs we already depend on, so there is
// nothing to upload and nothing to add to daml.yaml. We never reference it
// from Daml; we only exercise the interface choice over the JSON API.
export const IFACE_FEATURED_APP_RIGHT =
  '#splice-api-featured-app-v1:Splice.Api.FeaturedAppRightV1:FeaturedAppRight';

// ─── splice-util-featured-app-proxies ───────────────────────────────────
// Vendored at dars/splice-util-featured-app-proxies-1.2.4.dar. NOT uploaded
// to validators by default — see dars/README.md for provenance.
//
// `DelegateProxy { provider, delegate }` — signatory `provider`, observer
// `delegate`, every choice controlled by `delegate`. Its body fetches the
// provider's FeaturedAppRight, creates the activity marker, then exercises the
// proxied token-standard choice — all in one transaction. Because the
// provider's authority comes from the SIGNATORY rather than `actAs`, the
// submitter needs no `CanActAs` on the provider party; `CanReadAs` is enough
// (to resolve the right's contract id from the ACS).
export const PKG_FEATURED_APP_PROXIES =
  '88bcea6e9990bb2edb5301c042caa25c0594742665866f049f7bd67342d0865d';
export const TPL_DELEGATE_PROXY =
  '#splice-util-featured-app-proxies:Splice.Util.FeaturedApp.DelegateProxy:DelegateProxy';
export const TPL_WALLET_USER_PROXY =
  '#splice-util-featured-app-proxies:Splice.Util.FeaturedApp.WalletUserProxy:WalletUserProxy';

// ─── Choice names ───────────────────────────────────────────────────────
export const CHOICE_TRANSFER_FACTORY_TRANSFER     = 'TransferFactory_Transfer';
export const CHOICE_CREATE_ACTIVITY_MARKER         = 'FeaturedAppRight_CreateActivityMarker';
export const CHOICE_DELEGATE_PROXY_TRANSFER        = 'DelegateProxy_TransferFactory_Transfer';
// Takes `optFeaturedAppRightCid : Optional` — with None it runs the transfers
// and creates NO marker. That is the only proxy path exercisable while
// unfeatured, so it is what a pre-approval smoke test would use.
export const CHOICE_WALLET_USER_PROXY_BATCH        = 'WalletUserProxy_BatchTransfer';
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
