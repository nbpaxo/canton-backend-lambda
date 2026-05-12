/**
 * Canton Withdraw Operation
 *
 * Replaces the EVM withdrawal flow entirely.
 *
 * EVM flow (old):
 *   1. User calls approve-withdraw API → exchange validates balance, locks funds, creates signature
 *   2. Frontend submits blockchain tx with signature → smart contract releases funds
 *   3. Withdraw event emitted → machine-to-machine API debits exchange balance
 *   (3 steps, 2 API calls, 1 blockchain tx)
 *
 * Canton flow (new):
 *   1. User calls withdraw API (auth-protected)
 *   2. This SDK handles the Canton interaction:
 *      a. Operator's token → ExecuteWithdrawal (atomic: consume receipt + transfer to user)
 *      b. User's token → TI_Accept (user receives the Holding)
 *   3. Exchange debits balance in its DB (same as before)
 *   (1 API call, SDK handles everything)
 *
 * Key simplification: No approve step, no frontend blockchain call, no M2M callback.
 * The operator has CanActAs(vaultpool) so it can initiate the transfer from pool to user
 * directly via the VaultAccount contract.
 */

import type { CantonSdkConfig } from './config.js';
import { getTemplateIds } from './config.js';
import { getOperatorToken } from './tokens.js';
import {
  getActiveContracts,
  submitCommand,
} from './ledger.js';
import { requireActiveVault } from './vault.js';
import { resolveOperatorCantonId } from './operator.js';

export interface WithdrawParams {
  /** User's Keycloak access token */
  userToken: string;
  /** User's Canton user ID (Keycloak sub/UUID) */
  userCantonId: string;
  /** User's Canton party ID */
  userParty: string;
  /** Amount to withdraw */
  amount: number;
}

export interface WithdrawResult {
  ok: boolean;
  /** Amount withdrawn from deposit receipts */
  withdrawnFromDeposits: number;
  /** Amount paid from treasury (profit) */
  paidFromTreasury: number;
}

/**
 * Execute a withdrawal on Canton.
 *
 * This is the single function exchange developers call.
 * Handles receipt selection, operator withdrawal, and user auto-accept.
 *
 * @example
 * ```typescript
 * import { withdraw } from 'canton-sdk';
 *
 * // In your withdraw API handler (after auth + balance check):
 * const result = await withdraw(cantonConfig, {
 *   userToken: user.keycloakAccessToken,
 *   userCantonId: user.cantonUserId,
 *   userParty: user.party,
 *   amount: req.body.amount,
 * });
 *
 * // Then do your usual balance debit:
 * await db.users.debitBalance(userId, amount);
 * ```
 */
export async function withdraw(
  config: CantonSdkConfig,
  params: WithdrawParams,
): Promise<WithdrawResult> {
  const templates = getTemplateIds(config.packageId);

  // ── Guard: User must have an active vault account ──
  await requireActiveVault(config, params.userParty);

  const opToken = await getOperatorToken(config);

  // Find user's VaultAccount
  const vaultAccounts = await getActiveContracts(
    config, opToken, config.parties.operator, templates.VaultAccount,
  );
  const userVA = vaultAccounts.find(
    (c) => (c.payload as Record<string, unknown>).user === params.userParty,
  );
  if (!userVA) throw new Error('No VaultAccount found for this user');

  // Query deposit receipts
  const receipts = await getActiveContracts(
    config, opToken, config.parties.operator, templates.DepositReceipt,
  );
  const userReceipts = receipts
    .filter((r) => (r.payload as Record<string, unknown>).user === params.userParty)
    .map((r) => ({
      ...r,
      amount: parseFloat(String((r.payload as Record<string, unknown>).amount)),
    }))
    .filter((r) => !isNaN(r.amount) && r.amount > 0);

  const depositTotal = userReceipts.reduce((sum, r) => sum + r.amount, 0);
  const withdrawFromDeposits = Math.min(params.amount, depositTotal);
  const profitAmount = params.amount - withdrawFromDeposits;

  // Resolve operator Canton ID
  const operatorCantonId = await resolveOperatorCantonId(config);

  // ── Withdraw from deposits (receipt by receipt) ──
  // Each ExecuteWithdrawal can only withdraw up to the receipt's amount.
  // If withdrawFromDeposits spans multiple receipts, we iterate.
  if (withdrawFromDeposits > 0) {
    let remaining = withdrawFromDeposits;
    // Sort largest first — fewer iterations
    const sortedReceipts = [...userReceipts].sort((a, b) => b.amount - a.amount);

    for (const receipt of sortedReceipts) {
      if (remaining <= 0) break;

      const withdrawThisRound = Math.min(remaining, receipt.amount);

      // Re-fetch VaultAccount (contract ID changes after each exercise)
      const currentVAs = await getActiveContracts(
        config, opToken, config.parties.operator, templates.VaultAccount,
      );
      const currentVA = currentVAs.find(
        (c) => (c.payload as Record<string, unknown>).user === params.userParty,
      );
      if (!currentVA) throw new Error('VaultAccount not found during multi-receipt withdrawal');

      // Re-fetch pool holding (contract ID changes after splits)
      const poolHoldings = await getActiveContracts(
        config, opToken, config.parties.vaultPool, templates.Holding,
      );
      const poolHolding = poolHoldings.find((h) => {
        const amt = parseFloat(String((h.payload as Record<string, unknown>).amount));
        return amt >= withdrawThisRound;
      });
      if (!poolHolding) throw new Error(`No pool holding large enough for withdrawal of ${withdrawThisRound}`);

      console.log(`  ExecuteWithdrawal: ${withdrawThisRound} from receipt ${receipt.contractId.slice(0, 16)}... (${receipt.amount})`);

      // ATOMIC: ExecuteWithdrawal (consume/split receipt + Transfer_Initiate pool→user)
      await submitCommand(
        config, opToken, operatorCantonId,
        [config.parties.operator, config.parties.vaultPool],
        [{
          ExerciseCommand: {
            templateId: templates.VaultAccount,
            contractId: currentVA.contractId,
            choice: 'ExecuteWithdrawal',
            choiceArgument: {
              receiptCid: receipt.contractId,
              poolHoldingCid: poolHolding.contractId,
              withdrawAmount: withdrawThisRound.toString(),
            },
          },
        }],
      );

      // User auto-accepts the TransferInstruction from this round
      await autoAcceptIncomingTransfer(config, templates, params);

      remaining -= withdrawThisRound;
    }

    if (remaining > 0) {
      throw new Error(`Could not fully withdraw from deposits. ${remaining} remaining with no more receipts.`);
    }
  }

  // ── Profit payout from treasury (if amount > deposits) ──
  // Direct Transfer_Initiate from treasury → user.
  // We don't use ExecuteProfitPayout because after multi-receipt withdrawal rounds,
  // treasury holdings may have been consumed/split (stale contract IDs).
  // The direct approach is simpler and proven working.
  // Operator has CanActAs(treasury) so it can exercise Transfer_Initiate on treasury holdings.
  if (profitAmount > 0) {
    console.log(`  Profit payout: ${profitAmount} from treasury → user`);

    const freshOpToken = await getOperatorToken(config);

    // Fresh treasury holdings query
    const treasuryHoldings = await getActiveContracts(
      config, freshOpToken, config.parties.treasury, templates.Holding,
    );
    const treasuryHolding = treasuryHoldings.find((h) => {
      const amt = parseFloat(String((h.payload as Record<string, unknown>).amount));
      return amt >= profitAmount;
    });
    if (!treasuryHolding) throw new Error(`No treasury holding large enough for profit payout of ${profitAmount}`);

    console.log(`  Treasury Holding CID: ${treasuryHolding.contractId.slice(0, 16)}... (${(treasuryHolding.payload as any).amount})`);

    // Operator (acting as treasury) → Transfer_Initiate on treasury holding → user
    await submitCommand(
      config, freshOpToken, operatorCantonId,
      [config.parties.treasury],
      [{
        ExerciseCommand: {
          templateId: templates.Holding,
          contractId: treasuryHolding.contractId,
          choice: 'Transfer_Initiate',
          choiceArgument: {
            receiver: params.userParty,
            transferAmount: profitAmount.toString(),
          },
        },
      }],
    );

    // User auto-accepts the incoming transfer
    await autoAcceptIncomingTransfer(config, templates, params);
  }

  return {
    ok: true,
    withdrawnFromDeposits: withdrawFromDeposits,
    paidFromTreasury: profitAmount,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function autoAcceptIncomingTransfer(
  config: CantonSdkConfig,
  templates: ReturnType<typeof getTemplateIds>,
  params: WithdrawParams,
): Promise<void> {
  const tiContracts = await getActiveContracts(
    config, params.userToken, params.userParty, templates.TransferInstruction,
  );
  const incomingTi = tiContracts.find(
    (ti) => (ti.payload as Record<string, unknown>).receiver === params.userParty,
  );
  if (incomingTi) {
    await submitCommand(
      config, params.userToken, params.userCantonId,
      [params.userParty],
      [{
        ExerciseCommand: {
          templateId: templates.TransferInstruction,
          contractId: incomingTi.contractId,
          choice: 'TI_Accept',
          choiceArgument: {},
        },
      }],
    );
  }
}

