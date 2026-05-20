/**
 * Retry the on-chain side of a stuck withdrawal.
 *
 * Use when /cb/withdraw's exchange-finalize succeeded but the on-chain
 * step failed — the user has been debited at exchange-backend, the
 * `withdrawals` row sits in state='finalized' (or 'failed' with the
 * exchange portion still complete), and the chain didn't move (or moved
 * partially).
 *
 * What it does:
 *   1. Reads the `withdrawals` row by approval_id; prints current state.
 *   2. Runs `runOnChainWithdraw` again — same code path as the live route,
 *      using the same commandIds:
 *        - sendAmulet(vaultPool → user, principal)  commandId=`withdraw-<id>`
 *        - sendAmulet(treasury → user, profit)      commandId=`withdraw-<id>-profit`
 *        - SplitForWithdrawal                       commandId=`withdraw-<id>-split`
 *        - ConsumeForWithdrawal                     commandId=`withdraw-<id>-consume`
 *      Canton dedups by commandId within ~24h, so a retry shortly after
 *      the original failure is safe (either no-op if the chain already
 *      committed, or fresh submit if it didn't).
 *   3. Updates the `withdrawals` row + syncs the `deposits` table.
 *   4. Resolves any open `failed_withdraw_attempts` rows for this approval.
 *
 * DOES NOT re-call exchange-backend's /v1/withdraw/defi — that part is
 * presumed already done (exchange already debited). If that's not your
 * scenario, this script is the wrong tool; the live route handles the
 * full flow.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/retry-withdraw-onchain.ts <approvalId>
 */

import { closePool, getPool } from '../src/db/pool.js';
import { runOnChainWithdraw } from '../src/api/withdraw.js';

interface WithdrawalRow {
  approval_id: string;
  user_party_id: string;
  amount: string;
  state: 'pending' | 'finalized' | 'on_chain' | 'failed';
  on_chain_update_id: string | null;
  failure_reason: string | null;
}

async function main(): Promise<void> {
  const approvalId = process.argv[2];
  if (!approvalId) {
    console.error('usage: retry-withdraw-onchain.ts <approvalId>');
    process.exit(1);
  }

  const pool = getPool();

  const r = await pool.query<WithdrawalRow>(
    `SELECT approval_id, user_party_id, amount::text AS amount, state,
            on_chain_update_id, failure_reason
       FROM withdrawals
      WHERE approval_id = $1`,
    [approvalId],
  );
  const row = r.rows[0];
  if (!row) {
    console.error(`no withdrawals row for approval_id=${approvalId}`);
    process.exit(2);
  }

  console.log('current state:');
  console.log(`  approval_id : ${row.approval_id}`);
  console.log(`  user        : ${row.user_party_id}`);
  console.log(`  amount      : ${row.amount}`);
  console.log(`  state       : ${row.state}`);
  console.log(`  on-chain id : ${row.on_chain_update_id ?? '(not on chain)'}`);
  console.log(`  reason      : ${row.failure_reason ?? '(none)'}`);

  if (row.state === 'on_chain') {
    console.log('\n✓ already on chain — nothing to do');
    await closePool();
    return;
  }
  if (row.state === 'pending') {
    console.warn(
      "\nstate='pending' means the exchange-finalize step never completed. " +
        'This script only re-runs the on-chain side. ' +
        'If you want to skip the exchange call entirely, that needs the live route.',
    );
  }

  console.log('\nretrying on-chain transfer + DepositRecord archive…');

  try {
    const result = await runOnChainWithdraw({
      pool,
      approvalId: row.approval_id,
      userParty: row.user_party_id,
      amount: row.amount,
    });

    await pool.query(
      `UPDATE withdrawals
          SET state='on_chain',
              on_chain_at=NOW(),
              on_chain_update_id=$1,
              consumed_record_cids=$2,
              principal_amount=$3,
              profit_amount=$4,
              treasury_transfer_update_id=$5,
              failure_reason=NULL,
              updated_at=NOW()
        WHERE approval_id=$6`,
      [
        result.transferUpdateId,
        result.consumedCids,
        result.principalAmount,
        result.profitAmount,
        result.treasuryTransferUpdateId,
        approvalId,
      ],
    );

    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'withdraw.on_chain.retried', $2::jsonb)`,
      [
        row.user_party_id,
        JSON.stringify({
          approvalId,
          principalAmount: result.principalAmount,
          profitAmount: result.profitAmount,
          transferUpdateId: result.transferUpdateId,
          treasuryTransferUpdateId: result.treasuryTransferUpdateId,
          consumedRecordCids: result.consumedCids,
        }),
      ],
    );

    // Close out any open failed-attempt rows for this approval. The
    // resolution_note is grep-able later — `script:retry-withdraw-onchain`.
    const cleared = await pool.query<{ id: string }>(
      `UPDATE failed_withdraw_attempts
          SET resolved_at = NOW(),
              resolution_note = $1
        WHERE approval_id = $2
          AND resolved_at IS NULL
        RETURNING id`,
      [
        `script:retry-withdraw-onchain at ${new Date().toISOString()}`,
        approvalId,
      ],
    );

    console.log('\n✓ retry succeeded');
    console.log(`  principal       : ${result.principalAmount}`);
    console.log(`  profit          : ${result.profitAmount}`);
    console.log(`  transferUpdateId: ${result.transferUpdateId ?? '(none)'}`);
    console.log(
      `  treasuryUpdateId: ${result.treasuryTransferUpdateId ?? '(none)'}`,
    );
    console.log(`  consumed cids   : ${result.consumedCids.length}`);
    console.log(`  failed_withdraw_attempts resolved: ${cleared.rowCount ?? 0}`);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`\n✗ retry failed: ${msg}`);
    console.error((err as Error).stack);

    await pool.query(
      `UPDATE withdrawals
          SET failure_reason = $1, updated_at = NOW()
        WHERE approval_id = $2`,
      [`script-retry: ${msg}`, approvalId],
    );
    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'withdraw.on_chain.retry_failed', $2::jsonb)`,
      [row.user_party_id, JSON.stringify({ approvalId, reason: msg })],
    );
    process.exit(3);
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
