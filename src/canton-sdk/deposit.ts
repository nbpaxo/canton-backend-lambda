/**
 * Canton Deposit Operation
 *
 * Replaces the EVM deposit flow entirely.
 *
 * EVM flow (old):
 *   1. User deposits to smart contract on-chain
 *   2. Smart contract emits Deposit event
 *   3. Machine-to-machine API call credits exchange balance
 *
 * Canton flow (new):
 *   1. User calls exchange deposit API (auth-protected)
 *   2. This SDK handles the two-step Canton interaction:
 *      a. User's token → Transfer_Initiate (user sends tokens to vault pool)
 *      b. Operator's token → ExecuteDeposit (atomic: accept transfer + create receipt)
 *   3. Exchange credits balance in its DB (same as before)
 *
 * Why two tokens?
 *   - Only the token OWNER can initiate a transfer (CIP-56 standard)
 *   - Only the OPERATOR can execute vault operations
 *   - This separation ensures no single party controls the full flow
 */

import crypto from 'node:crypto';
import type { CantonSdkConfig } from './config.js';
import { getTemplateIds } from './config.js';
import { getAdminToken, getOperatorToken } from './tokens.js';
import {
  getActiveContracts,
  submitCommand,
  extractCreatedContractId,
} from './ledger.js';
import { requireActiveVault } from './vault.js';
import { resolveOperatorCantonId } from './operator.js';

export interface DepositParams {
  /** User's Keycloak access token (for Canton commands as the user) */
  userToken: string;
  /** User's Canton user ID (Keycloak sub/UUID) */
  userCantonId: string;
  /** User's Canton party ID (e.g., "neeraj::12205f55d1bb...") */
  userParty: string;
  /** Contract ID of the Holding to deposit */
  holdingCid: string;
  /** Amount to deposit */
  amount: number;
}

export interface DepositResult {
  ok: boolean;
  /** The TransferInstruction contract ID created in step 1 */
  transferInstructionCid: string;
  /** The DepositReceipt contract ID created in step 2 */
  depositReceiptCid: string | null;
}

/**
 * Execute a deposit on Canton.
 *
 * This is the single function exchange developers call.
 * It handles the full two-step Canton flow internally.
 *
 * @example
 * ```typescript
 * import { deposit } from 'canton-sdk';
 *
 * // In your deposit API handler (after auth):
 * const result = await deposit(cantonConfig, {
 *   userToken: user.keycloakAccessToken,
 *   userCantonId: user.cantonUserId,
 *   userParty: user.party,
 *   holdingCid: req.body.holdingCid,
 *   amount: req.body.amount,
 * });
 *
 * // Then do your usual balance update:
 * await db.users.updateBalance(userId, amount);
 * ```
 */
export async function deposit(
  config: CantonSdkConfig,
  params: DepositParams,
): Promise<DepositResult> {
  const templates = getTemplateIds(config.packageId);

  // ── Guard: User must have an active vault account ──
  await requireActiveVault(config, params.userParty);

  // ── Step 1: User initiates transfer to vault pool ──
  // Uses the USER's token because only the Holding owner can exercise Transfer_Initiate
  const initiateResult = await submitCommand(
    config,
    params.userToken,
    params.userCantonId,
    [params.userParty],
    [
      {
        ExerciseCommand: {
          templateId: templates.Holding,
          contractId: params.holdingCid,
          choice: 'Transfer_Initiate',
          choiceArgument: {
            receiver: config.parties.vaultPool,
            transferAmount: params.amount.toString(),
          },
        },
      },
    ],
  );

  const tiCid = extractCreatedContractId(initiateResult, templates.TransferInstruction);
  if (!tiCid) {
    throw new Error('Transfer_Initiate did not produce a TransferInstruction');
  }

  // ── Step 2: Operator executes deposit (ATOMIC) ──
  // Uses the OPERATOR's token because ExecuteDeposit controller is operator.
  // Inside Daml, this atomically: TI_Accept + create DepositReceipt.
  const opToken = await getOperatorToken(config);

  // Find user's VaultAccount
  const vaultAccounts = await getActiveContracts(
    config, opToken, config.parties.operator, templates.VaultAccount,
  );
  const userVA = vaultAccounts.find(
    (c) => (c.payload as Record<string, unknown>).user === params.userParty,
  );
  if (!userVA) {
    throw new Error('No VaultAccount found for this user. User must complete onboarding first.');
  }

  const depositRef = `dep-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  const depositResult = await submitCommand(
    config,
    opToken,
    // Operator's Canton user ID is resolved internally
    await resolveOperatorCantonId(config),
    [config.parties.operator, config.parties.vaultPool],
    [
      {
        ExerciseCommand: {
          templateId: templates.VaultAccount,
          contractId: userVA.contractId,
          choice: 'ExecuteDeposit',
          choiceArgument: {
            tiCid,
            depositAmount: params.amount.toString(),
            depositRef,
          },
        },
      },
    ],
  );

  const receiptCid = extractCreatedContractId(depositResult, templates.DepositReceipt);

  return {
    ok: true,
    transferInstructionCid: tiCid,
    depositReceiptCid: receiptCid,
  };
}

