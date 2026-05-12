/**
 * Vault Account Status & Onboarding
 *
 * Before a user can deposit or withdraw, they need a VaultAccount on Canton.
 * This module provides functions to check status and accept proposals.
 *
 * Vault Account Lifecycle:
 *   1. NOT_CREATED    — User has no account, no proposal exists
 *   2. PROPOSAL_PENDING — Operator created a VaultAccountProposal, waiting for user to accept
 *   3. ACTIVE         — User accepted, VaultAccount exists on-chain → deposit/withdraw enabled
 */

import type { CantonSdkConfig } from './config.js';
import { getTemplateIds } from './config.js';
import { getOperatorToken } from './tokens.js';
import { getActiveContracts, submitCommand } from './ledger.js';

export type VaultAccountStatus = 'NOT_CREATED' | 'PROPOSAL_PENDING' | 'ACTIVE';

export interface VaultStatusResult {
  /** Current status of the user's vault account */
  status: VaultAccountStatus;
  /** Whether the user can deposit/withdraw (only true when ACTIVE) */
  canTransact: boolean;
  /** If status is PROPOSAL_PENDING, the proposal contract ID to accept */
  proposalContractId: string | null;
  /** If status is ACTIVE, the VaultAccount contract ID */
  vaultAccountContractId: string | null;
  /** Human-readable message */
  message: string;
}

/**
 * Check the user's vault account status on Canton.
 *
 * This is the first thing to call after login. If status is not ACTIVE,
 * the user cannot deposit or withdraw.
 *
 * @example
 * ```typescript
 * const status = await canton.getVaultAccountStatus(userParty);
 *
 * if (status.status === 'NOT_CREATED') {
 *   // Show "Request Account" button in UI
 *   // Exchange backend tracks request in its DB, operator creates proposal
 * }
 *
 * if (status.status === 'PROPOSAL_PENDING') {
 *   // Show "Accept Proposal" button
 *   await canton.acceptVaultProposal(userToken, userCantonId, userParty, status.proposalContractId!);
 * }
 *
 * if (status.canTransact) {
 *   // User is onboarded — enable deposit/withdraw
 * }
 * ```
 */
export async function getVaultAccountStatus(
  config: CantonSdkConfig,
  userParty: string,
): Promise<VaultStatusResult> {
  const templates = getTemplateIds(config.packageId);
  const opToken = await getOperatorToken(config);

  // Check for active VaultAccount
  const vaultAccounts = await getActiveContracts(
    config, opToken, config.parties.operator, templates.VaultAccount,
  );
  const userVA = vaultAccounts.find(
    (c) => (c.payload as Record<string, unknown>).user === userParty,
  );

  if (userVA) {
    return {
      status: 'ACTIVE',
      canTransact: true,
      proposalContractId: null,
      vaultAccountContractId: userVA.contractId,
      message: 'Vault account is active. You can deposit and withdraw.',
    };
  }

  // Check for pending proposal
  const proposals = await getActiveContracts(
    config, opToken, config.parties.operator, templates.VaultAccountProposal,
  );
  const userProposal = proposals.find(
    (c) => (c.payload as Record<string, unknown>).user === userParty,
  );

  if (userProposal) {
    return {
      status: 'PROPOSAL_PENDING',
      canTransact: false,
      proposalContractId: userProposal.contractId,
      vaultAccountContractId: null,
      message: 'Operator has created a vault account proposal. Please accept to activate your account.',
    };
  }

  // No account, no proposal
  return {
    status: 'NOT_CREATED',
    canTransact: false,
    proposalContractId: null,
    vaultAccountContractId: null,
    message: 'No vault account found. Please request one from the operator.',
  };
}

/**
 * Accept a VaultAccountProposal on Canton.
 *
 * Call this when status is PROPOSAL_PENDING.
 * After acceptance, the VaultAccount is created and the user can deposit/withdraw.
 */
export async function acceptVaultProposal(
  config: CantonSdkConfig,
  userToken: string,
  userCantonId: string,
  userParty: string,
  proposalContractId: string,
): Promise<{ ok: boolean; message: string }> {
  const templates = getTemplateIds(config.packageId);

  await submitCommand(
    config,
    userToken,
    userCantonId,
    [userParty],
    [{
      ExerciseCommand: {
        templateId: templates.VaultAccountProposal,
        contractId: proposalContractId,
        choice: 'AcceptProposal',
        choiceArgument: {},
      },
    }],
  );

  return {
    ok: true,
    message: 'Vault account proposal accepted. Your account is now active.',
  };
}

/**
 * Guard function — throws if user does not have an active vault account.
 * Call this before deposit/withdraw to give a clear error.
 */
export async function requireActiveVault(
  config: CantonSdkConfig,
  userParty: string,
): Promise<string> {
  const status = await getVaultAccountStatus(config, userParty);

  if (status.status === 'NOT_CREATED') {
    throw new Error(
      'VAULT_NOT_CREATED: No vault account exists for this user. ' +
      'Request one from the operator before attempting to deposit or withdraw.',
    );
  }

  if (status.status === 'PROPOSAL_PENDING') {
    throw new Error(
      `VAULT_PROPOSAL_PENDING: A vault account proposal is waiting for acceptance. ` +
      `Accept proposal ${status.proposalContractId} before attempting to deposit or withdraw.`,
    );
  }

  return status.vaultAccountContractId!;
}
