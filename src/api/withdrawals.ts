/**
 * GET /withdrawals — caller's withdrawal history.
 *
 * Returns rows from the `withdrawals` table (successful + in-progress)
 * plus any rows from `failed_withdraw_attempts` (unresolved failures the
 * operator queue cares about, surfaced to the user so they know their
 * approval didn't go through).
 *
 * Open-auth like /me / /deposits — filtered by `x-party-id` header.
 *
 * NOTE: this endpoint is RESTful (GET, idempotent, read-only). The
 * authenticated `/withdraw` endpoint is the action one; this one is the
 * audit/history view.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getPool } from '../db/pool.js';

const router = Router();

interface WithdrawalRow {
  approval_id: string;
  amount: string;
  nonce: string;
  state: 'pending' | 'finalized' | 'on_chain' | 'failed';
  on_chain_update_id: string | null;
  consumed_record_cids: string[] | null;
  exchange_finalized_at: Date | null;
  on_chain_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
}

interface FailedRow {
  id: string;
  approval_id: string | null;
  amount: string | null;
  nonce: string | null;
  failure_step: string;
  failure_reason: string;
  resolved_at: Date | null;
  resolution_note: string | null;
  created_at: Date;
}

router.get('/withdrawals', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();
  const limit = Math.min(Number(req.query.limit ?? 100), 500);

  const [withdrawals, failed] = await Promise.all([
    pool.query<WithdrawalRow>(
      `SELECT approval_id, amount::text AS amount, nonce, state,
              on_chain_update_id, consumed_record_cids,
              exchange_finalized_at, on_chain_at, failure_reason, created_at
         FROM withdrawals
        WHERE user_party_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [party, limit],
    ),
    pool.query<FailedRow>(
      `SELECT id, approval_id, amount::text AS amount, nonce,
              failure_step, failure_reason, resolved_at, resolution_note, created_at
         FROM failed_withdraw_attempts
        WHERE user_party_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [party, limit],
    ),
  ]);

  res.json({
    withdrawals: withdrawals.rows.map((w) => ({
      approvalId: w.approval_id,
      amount: w.amount,
      nonce: w.nonce,
      state: w.state,
      onChainUpdateId: w.on_chain_update_id,
      consumedRecordCids: w.consumed_record_cids,
      exchangeFinalizedAt: w.exchange_finalized_at?.toISOString() ?? null,
      onChainAt: w.on_chain_at?.toISOString() ?? null,
      failureReason: w.failure_reason,
      createdAt: w.created_at.toISOString(),
    })),
    failedAttempts: failed.rows.map((f) => ({
      id: String(f.id),
      approvalId: f.approval_id,
      amount: f.amount,
      nonce: f.nonce,
      failureStep: f.failure_step,
      failureReason: f.failure_reason,
      resolvedAt: f.resolved_at?.toISOString() ?? null,
      resolutionNote: f.resolution_note,
      createdAt: f.created_at.toISOString(),
    })),
  });
});

export default router;
