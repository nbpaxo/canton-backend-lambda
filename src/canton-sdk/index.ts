/**
 * Canton SDK — devnet branch.
 *
 * Trimmed down for the operator-only-signed exchange-v2-core contracts.
 * No more VaultAccount / VaultAccountProposal / MintProposal / TI-based
 * deposit flow. Users transfer Amulet (CC) directly to vaultPool; the
 * watcher creates DepositRecords on chain.
 */

export type { CantonSdkConfig } from './config.js';
export {
  TPL_DEPOSIT_RECORD,
  TPL_SETTLEMENT_RECORD,
  IFACE_HOLDING,
  IFACE_TRANSFER_FACTORY,
  IFACE_TRANSFER_INSTRUCTION,
  CHOICE_TRANSFER_FACTORY_TRANSFER,
  CHOICE_DEPOSIT_CONSUME_FOR_WITHDRAWAL,
  CHOICE_DEPOSIT_SPLIT_FOR_WITHDRAWAL,
  getKeycloakAuthUrl,
  getKeycloakLogoutUrl,
} from './config.js';

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
  type ActiveContract,
} from './ledger.js';

export {
  resolveOperatorCantonId,
  resolveCircleCantonId,
} from './operator.js';

export {
  getUserHoldings,
  getUserDepositRecords,
  type HoldingInfo,
  type DepositRecordInfo,
} from './queries.js';

import type { CantonSdkConfig } from './config.js';
import { getAdminToken, getOperatorToken, getCircleToken } from './tokens.js';
import { getCantonUser, grantRight } from './ledger.js';
import { resolveOperatorCantonId, resolveCircleCantonId } from './operator.js';
import { getUserHoldings, getUserDepositRecords } from './queries.js';

/**
 * Bound-config SDK facade. The lambda's routes / signup / watcher all go
 * through this object so config is set once in src/sdk.ts.
 */
export function createCantonSdk(config: CantonSdkConfig) {
  return {
    // Tokens
    getAdminToken:    () => getAdminToken(config),
    getOperatorToken: () => getOperatorToken(config),
    getCircleToken:   (u: string, p: string) => getCircleToken(config, u, p),

    // User mgmt
    getCantonUser: (token: string, kcUserId: string) => getCantonUser(config, token, kcUserId),
    grantRight: (adminToken: string, userId: string, kind: 'CanActAs' | 'CanReadAs', party: string) =>
      grantRight(config, adminToken, userId, kind, party),

    // Resolution
    resolveOperatorCantonId: () => resolveOperatorCantonId(config),
    resolveCircleCantonId:   () => resolveCircleCantonId(config),

    // Queries
    getUserHoldings: (userParty: string, opts?: { instrumentAdmin?: string; instrumentId?: string }) =>
      getUserHoldings(config, userParty, opts),
    getUserDepositRecords: (userParty: string) =>
      getUserDepositRecords(config, userParty),
  };
}
