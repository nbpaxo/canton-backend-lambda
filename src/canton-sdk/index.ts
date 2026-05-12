/**
 * Canton SDK
 *
 * Drop-in library for off-chain exchanges migrating from EVM to Canton Network.
 *
 * Usage:
 *   import { createCantonSdk } from 'canton-sdk';
 *
 *   const canton = createCantonSdk({ ...config });
 *
 *   // Auth: replace MetaMask sign-in
 *   const tokens = await canton.exchangeAuthCode(code, redirectUri);
 *
 *   // Deposit: replace EVM event → M2M API
 *   const result = await canton.deposit({ userToken, userCantonId, userParty, holdingCid, amount });
 *
 *   // Withdraw: replace approve → sign → blockchain → M2M
 *   const result = await canton.withdraw({ userToken, userCantonId, userParty, amount });
 */

export type { CantonSdkConfig } from './config.js';
export { getTemplateIds, getKeycloakAuthUrl, getKeycloakLogoutUrl } from './config.js';

export {
  getAdminToken,
  getOperatorToken,
  getCircleToken,
  exchangeAuthCode,
  refreshUserToken,
} from './tokens.js';

export {
  getActiveContracts,
  submitCommand,
  extractCreatedContractId,
  getCantonUser,
  grantRight,
  type LedgerCommand,
  type ExerciseCommand,
  type CreateCommand,
} from './ledger.js';

export { resolveOperatorCantonId, resolveCircleCantonId } from './operator.js';
export { deposit, type DepositParams, type DepositResult } from './deposit.js';
export { withdraw, type WithdrawParams, type WithdrawResult } from './withdraw.js';
export {
  getVaultAccountStatus,
  acceptVaultProposal,
  requireActiveVault,
  type VaultAccountStatus,
  type VaultStatusResult,
} from './vault.js';
export {
  getUserHoldings,
  getUserVaultHoldings,
  type HoldingInfo,
  type DepositReceiptInfo,
} from './queries.js';

import type { CantonSdkConfig } from './config.js';
import { getKeycloakAuthUrl, getKeycloakLogoutUrl } from './config.js';
import { getAdminToken, getOperatorToken, getCircleToken, exchangeAuthCode, refreshUserToken } from './tokens.js';
import { getActiveContracts, getCantonUser, grantRight } from './ledger.js';
import { deposit, type DepositParams } from './deposit.js';
import { withdraw, type WithdrawParams } from './withdraw.js';
import { getVaultAccountStatus, acceptVaultProposal, requireActiveVault } from './vault.js';
import { getUserHoldings, getUserVaultHoldings } from './queries.js';
import { resolveOperatorCantonId, resolveCircleCantonId } from './operator.js';

/**
 * Create a Canton SDK instance with bound config.
 * This is the recommended way to use the SDK — no need to pass config to every call.
 */
export function createCantonSdk(config: CantonSdkConfig) {
  return {
    // ── Auth URLs ──
    /** Get the Keycloak login URL to redirect users to. Backend uses this for GET /api/auth/login */
    getLoginUrl: (redirectUri: string) => getKeycloakAuthUrl(config, redirectUri),
    /** Get the Keycloak logout URL. Ends user's SSO session. */
    getLogoutUrl: (postLogoutRedirectUri: string) => getKeycloakLogoutUrl(config, postLogoutRedirectUri),

    // ── Auth Tokens ──
    /** Get admin token (client_credentials) for Canton admin APIs */
    getAdminToken: () => getAdminToken(config),
    /** Get operator token (password grant) for operator-side commands */
    getOperatorToken: () => getOperatorToken(config),
    /** Get circle token (password grant) for issuer-side commands (minting) */
    getCircleToken: (circleUsername: string, circlePassword: string) =>
      getCircleToken(config, circleUsername, circlePassword),
    /** Exchange OAuth2 auth code for user tokens (replaces MetaMask sign-in) */
    exchangeAuthCode: (code: string, redirectUri: string) => exchangeAuthCode(config, code, redirectUri),
    /** Refresh a user's Keycloak token */
    refreshUserToken: (refreshToken: string) => refreshUserToken(config, refreshToken),

    // ── User Management ──
    /** Resolve a Canton user by Keycloak sub */
    getCantonUser: (token: string, keycloakUserId: string) => getCantonUser(config, token, keycloakUserId),
    /** Grant CanActAs/CanReadAs right */
    grantRight: (adminToken: string, userId: string, kind: 'CanActAs' | 'CanReadAs', party: string) =>
      grantRight(config, adminToken, userId, kind, party),

    // ── Ledger Queries ──
    /** Query active contracts */
    getActiveContracts: (token: string, partyId: string, templateId: string) =>
      getActiveContracts(config, token, partyId, templateId),

    // ── Vault Account (Onboarding) ──
    /** Check user's vault account status: NOT_CREATED | PROPOSAL_PENDING | ACTIVE */
    getVaultAccountStatus: (userParty: string) => getVaultAccountStatus(config, userParty),
    /** Accept a pending vault account proposal on-chain */
    acceptVaultProposal: (userToken: string, userCantonId: string, userParty: string, proposalCid: string) =>
      acceptVaultProposal(config, userToken, userCantonId, userParty, proposalCid),
    /** Throws if user doesn't have an active vault account */
    requireActiveVault: (userParty: string) => requireActiveVault(config, userParty),

    // ── Queries ──
    /** Get user's on-chain USDC holdings (what they can deposit) */
    getUserHoldings: (userToken: string, userParty: string) => getUserHoldings(config, userToken, userParty),
    /** Get user's vault deposit receipts (what's deposited on-chain) */
    getUserVaultHoldings: (userParty: string) => getUserVaultHoldings(config, userParty),
    /** Resolve circle (token issuer) Canton user ID */
    resolveCircleCantonId: () => resolveCircleCantonId(config),

    // ── Exchange Operations ──
    /** Execute deposit (replaces EVM event → M2M API). Requires active vault account. */
    deposit: (params: DepositParams) => deposit(config, params),
    /** Execute withdrawal (replaces approve → sign → blockchain → M2M). Requires active vault account. */
    withdraw: (params: WithdrawParams) => withdraw(config, params),
  };
}
