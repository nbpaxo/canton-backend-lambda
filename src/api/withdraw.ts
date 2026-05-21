/**
 * POST /withdraw — burn DepositRecord(s) + pay user via operator transfer.
 *
 * Auth: Keycloak JWT (Authorization: Bearer …) OR Loop signature (in body).
 *       Open-auth is NOT honored here — see withdrawAuth.ts.
 *
 * Flow:
 *   1. Verify caller identity (Loop sig or KC JWT) — returns party id.
 *   2. Reserve the approval id in `withdrawals` table (replay guard).
 *   3. Look up the approval at exchange-backend (STUBBED; trusts client
 *      hints for now). Compare authenticated party to approval party.
 *   4. POST /v1/withdraw/defi (exchange-backend finalize). If this fails,
 *      DO NOT touch the chain — abort with 502. If it succeeds, balance
 *      has already been debited at exchange-backend.
 *   5. On chain: pick DepositRecord(s), split last if overshoots, consume,
 *      operator transfer vaultPool → user. (See implementation note.)
 *
 * Failure modes:
 *   - 401 — auth missing/invalid
 *   - 403 — authenticated party doesn't match approval party
 *   - 409 — approval id already used (replay)
 *   - 410 — approval expired / already finalized
 *   - 502 — exchange-backend finalize rejected
 *   - 500 — exchange finalized but on-chain failed (row stuck in
 *           'finalized' state; retry pass should reconcile — TODO)
 */
import { Router, Request, Response } from 'express';
import { json } from 'express';
import type { Pool } from 'pg';
import { getPool } from '../db/pool.js';
import { authenticateWithdraw } from '../withdrawAuth.js';
import { normalizePartyId } from '../auth.js';
import { lookupWithdrawApproval } from '../services/withdrawApproval.js';
import {
  CANTON_LEDGER_API,
  EXCHANGE_WITHDRAW_URL,
  INSTRUMENT_ADMIN_PARTY_ID,
  INSTRUMENT_ID,
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  KEYCLOAK_TOKEN_URL,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET,
  OPERATOR_KC_USERNAME,
  OPERATOR_KC_PASSWORD,
  PACKAGE_ID,
  PARTIES,
} from '../config.js';
import type { CantonSdkConfig } from '../canton-sdk/config.js';
import { TPL_DEPOSIT_RECORD } from '../canton-sdk/config.js';
import { submitCommand } from '../canton-sdk/ledger.js';
import { getOperatorToken } from '../canton-sdk/tokens.js';
import { resolveOperatorCantonId } from '../canton-sdk/operator.js';
import { sendAmulet } from '../canton-sdk/operatorTransfer.js';
import { getUserDepositRecords } from '../canton-sdk/depositRecords.js';

const sdkConfig: CantonSdkConfig = {
  cantonLedgerApi: CANTON_LEDGER_API,
  keycloakBase: KEYCLOAK_BASE,
  keycloakRealm: KEYCLOAK_REALM,
  keycloakTokenUrl: KEYCLOAK_TOKEN_URL,
  keycloakClientId: KEYCLOAK_CLIENT_ID,
  keycloakClientSecret: KEYCLOAK_CLIENT_SECRET,
  operatorUsername: OPERATOR_KC_USERNAME,
  operatorPassword: OPERATOR_KC_PASSWORD,
  packageId: PACKAGE_ID,
  parties: PARTIES,
};

const router = Router();

interface WithdrawBody {
  approvalId: string;
  partyId: string;
  amount: string;
  nonce: string;
  expiry: number;
  // Loop only — Keycloak path uses the Authorization header instead.
  loopAuth?: { message: string; signature: string; publicKey: string };
}

router.post('/withdraw', json(), async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as WithdrawBody;
  if (!body.approvalId || !body.partyId || !body.amount || !body.nonce || !body.expiry) {
    return res.status(400).json({
      error: 'required fields: approvalId, partyId, amount, nonce, expiry',
    });
  }
  // Legacy clients send the party id with `.` instead of `::` — normalize
  // so downstream comparisons (auth.partyId vs approval.partyId) work for
  // both. See normalizePartyId() in auth.ts.
  body.partyId = normalizePartyId(body.partyId);

  // Step-by-step logger scoped to this request. Lets us correlate where
  // a withdraw died even when the DB pool is unhealthy and recordFailed-
  // Attempt itself can't write. The string `[withdraw]` is grep-friendly.
  const wlog = (stage: string, extra: Record<string, unknown> = {}): void => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      level: 'info',
      type: 'withdraw_step',
      stage,
      approvalId: body.approvalId,
      partyId: body.partyId,
      amount: body.amount,
      ...extra,
    }));
  };
  wlog('start');

  const pool = getPool();
  // Strip the loopAuth field — signatures + pubkeys shouldn't end up in
  // the audit/failure tables.
  const safePayload = (() => {
    const { loopAuth: _omit, ...rest } = body;
    void _omit;
    return rest as Record<string, unknown>;
  })();

  // 1. Authenticate. authenticateWithdraw binds the Loop signature to
  //    `approvalId`, so a captured sig can't be replayed against a
  //    different approval.
  let auth;
  try {
    auth = await authenticateWithdraw(req, { approvalId: body.approvalId });
    wlog('auth_ok', { authMethod: auth.authMethod });
  } catch (err) {
    wlog('auth_failed', { error: (err as Error).message });
    await recordFailedAttempt(pool, {
      approvalId: body.approvalId,
      userPartyId: body.partyId,
      amount: typeof body.amount === 'string' ? body.amount : String(body.amount),
      nonce: body.nonce,
      failureStep: 'auth',
      failureReason: (err as Error).message,
      requestPayload: safePayload,
    });
    return res.status(401).json({ error: `unauthorized: ${(err as Error).message}` });
  }

  // 2. Look up the approval. STUB — trusts the body until exchange-backend
  //    exposes /internal/withdraw/approvals/:id. The body-supplied values
  //    are still cross-checked against the authenticated identity below,
  //    so a malicious caller can't withdraw against someone else's funds.
  //
  // Body amount may arrive as a JS number (frontend forwards
  // approval.amount as-is, which is what the JSON parser produced). Coerce
  // to string here so the downstream type contract (`amount: string`) is
  // honored — fixed-point arithmetic needs a string source.
  const amountStr = typeof body.amount === 'string' ? body.amount : String(body.amount);
  const approval = await lookupWithdrawApproval(body.approvalId, {
    partyId: body.partyId,
    amount: amountStr,
    nonce: body.nonce,
    expiry: body.expiry,
  });
  const lookupFail = async (reason: string, status: number): Promise<void> => {
    await recordFailedAttempt(pool, {
      approvalId: body.approvalId,
      userPartyId: body.partyId,
      amount: amountStr,
      nonce: body.nonce,
      failureStep: 'lookup',
      failureReason: reason,
      requestPayload: safePayload,
    });
    res.status(status).json({ error: reason });
  };
  if (approval.status === 'not_found') { await lookupFail('approval not found', 404); return; }
  if (approval.status === 'expired')   { await lookupFail('approval expired', 410); return; }
  if (approval.status === 'finalized') { await lookupFail('approval already finalized', 410); return; }
  if (approval.expiry && approval.expiry < Date.now()) {
    await lookupFail('approval expired (local clock)', 410);
    return;
  }

  // 3. The authenticated user must own this approval.
  if (auth.partyId !== approval.partyId) {
    await recordFailedAttempt(pool, {
      approvalId: body.approvalId,
      userPartyId: body.partyId,
      amount: amountStr,
      nonce: body.nonce,
      failureStep: 'lookup',
      failureReason: `auth party ${auth.partyId} != approval party ${approval.partyId}`,
      requestPayload: safePayload,
    });
    return res.status(403).json({
      error: 'authenticated party does not match approval',
      details: { authParty: auth.partyId, approvalParty: approval.partyId },
    });
  }

  // 4. Reserve the approval id. UNIQUE PK on approval_id catches replay.
  try {
    await pool.query(
      `INSERT INTO withdrawals (approval_id, user_party_id, amount, nonce, state)
         VALUES ($1, $2, $3, $4, 'pending')`,
      [body.approvalId, approval.partyId, approval.amount, approval.nonce],
    );
    wlog('reserved');
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      wlog('replay');
      await recordFailedAttempt(pool, {
        approvalId: body.approvalId,
        userPartyId: approval.partyId,
        amount: approval.amount,
        nonce: approval.nonce,
        failureStep: 'replay',
        failureReason: 'approval already processed',
        requestPayload: safePayload,
      });
      return res.status(409).json({ error: 'approval already processed' });
    }
    wlog('reserve_failed', { error: (err as Error).message });
    throw err;
  }

  // ── STEP A: Exchange-backend finalize FIRST. ─────────────────────────
  // Strict order: NOTHING on-chain happens until exchange has confirmed
  // it has debited the user's trading wallet. If this errors, the
  // approval row stays in 'failed' state, a row is recorded in
  // failed_withdraw_attempts (failure_step='exchange-api-fail') with the
  // full request payload, and the UI gets a "cannot withdraw" response.
  wlog('exchange_call_start', { url: EXCHANGE_WITHDRAW_URL });
  const finalize = await postExchangeWithdrawFinalize({
    partyId: approval.partyId,
    amount: approval.amount,
    nonce: approval.nonce,
    approvalId: body.approvalId,
  });
  wlog('exchange_call_done', { ok: finalize.ok, status: finalize.status });
  if (!finalize.ok) {
    const reason = `exchange finalize ${finalize.status}: ${JSON.stringify(finalize.body).slice(0, 400)}`;
    await pool.query(
      `UPDATE withdrawals
          SET state='failed',
              failure_reason=$1,
              updated_at=NOW()
        WHERE approval_id=$2`,
      [reason, body.approvalId],
    );
    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'withdraw.exchange.failed', $2::jsonb)`,
      [approval.partyId, JSON.stringify({ approvalId: body.approvalId, status: finalize.status, body: finalize.body })],
    );
    await recordFailedAttempt(pool, {
      approvalId: body.approvalId,
      userPartyId: approval.partyId,
      amount: approval.amount,
      nonce: approval.nonce,
      failureStep: 'exchange-api-fail',
      failureReason: reason,
      // Capture the FULL diagnostic envelope so ops can reconstruct what
      // we attempted: the incoming user request, the exact JSON we posted
      // to exchange-backend (txnHash, walletAddress, coin, amount, nonce,
      // approvalId), and exchange-backend's response.
      requestPayload: {
        incoming: safePayload,
        exchangeRequest: {
          url: finalize.url,
          method: 'POST',
          body: finalize.requestPayload,
        },
        exchangeResponse: {
          status: finalize.status,
          body: finalize.body,
        },
      },
    });
    return res.status(502).json({
      error: 'cannot_withdraw',
      message: 'Cannot withdraw at this time. Your funds have not been moved. Please try again later.',
      stage: 'exchange-api-fail',
      details: finalize.body,
    });
  }

  await pool.query(
    `UPDATE withdrawals
        SET state='finalized', exchange_finalized_at=NOW(), updated_at=NOW()
      WHERE approval_id=$1`,
    [body.approvalId],
  );
  await pool.query(
    `INSERT INTO audit_log (user_party_id, action, details)
       VALUES ($1, 'withdraw.exchange.finalized', $2::jsonb)`,
    [approval.partyId, JSON.stringify({ approvalId: body.approvalId, amount: approval.amount })],
  );

  // ── STEP B: On chain. ────────────────────────────────────────────────
  // Exchange has now debited the user's trading wallet; we owe them the
  // CC on chain. Mirrors exchange-v2/backend/src/services/withdraw.ts:
  // transfer FIRST (so user sees money), then DB-mark consumed (atomic),
  // then best-effort DepositRecord archive on chain.
  //
  // If this errors, exchange has ALREADY debited — the withdrawals row
  // sits in 'finalized' with failure_reason, a row is added to
  // failed_withdraw_attempts (failure_step='on-chain-failed') with the
  // full payload + error, and the UI gets the "contact support" message
  // so the user knows their balance moved but settlement didn't. A retry
  // pass (TODO) can drive 'finalized' rows to completion.
  wlog('on_chain_start');
  try {
    const onChain = await runOnChainWithdraw({
      pool,
      approvalId: body.approvalId,
      userParty: approval.partyId,
      amount: approval.amount,
    });
    wlog('on_chain_done', { transferUpdateId: onChain.transferUpdateId });

    await pool.query(
      `UPDATE withdrawals
          SET state='on_chain',
              on_chain_at=NOW(),
              on_chain_update_id=$1,
              consumed_record_cids=$2,
              failure_reason=NULL,
              updated_at=NOW()
        WHERE approval_id=$3`,
      [onChain.transferUpdateId, onChain.consumedCids, body.approvalId],
    );
    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'withdraw.on_chain', $2::jsonb)`,
      [
        approval.partyId,
        JSON.stringify({
          approvalId: body.approvalId,
          amount: approval.amount,
          principalAmount: onChain.principalAmount,
          profitAmount: onChain.profitAmount,
          transferUpdateId: onChain.transferUpdateId,
          treasuryTransferUpdateId: onChain.treasuryTransferUpdateId,
          consumedRecordCids: onChain.consumedCids,
        }),
      ],
    );

    wlog('success');
    return res.json({
      success: true,
      approvalId: body.approvalId,
      state: 'on_chain',
      transferUpdateId: onChain.transferUpdateId,
      treasuryTransferUpdateId: onChain.treasuryTransferUpdateId,
      principalAmount: onChain.principalAmount,
      profitAmount: onChain.profitAmount,
    });
  } catch (err) {
    wlog('on_chain_failed', { error: (err as Error).message });
    // Exchange has already debited; row stays in 'finalized' with a
    // failure_reason. TODO: retry pass that picks up `finalized` rows
    // older than N seconds and re-runs runOnChainWithdraw — same pattern
    // as the deposit-exchange retry in depositWatcher.
    const reason = (err as Error).message;
    // eslint-disable-next-line no-console
    console.warn('[withdraw] on-chain failed (exchange already debited)', {
      approvalId: body.approvalId,
      partyId: approval.partyId,
      amount: approval.amount,
      reason,
      stack: (err as Error).stack,
    });
    await pool.query(
      `UPDATE withdrawals
          SET failure_reason=$1, updated_at=NOW()
        WHERE approval_id=$2`,
      [`on-chain: ${reason}`, body.approvalId],
    );
    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'withdraw.on_chain.failed', $2::jsonb)`,
      [approval.partyId, JSON.stringify({ approvalId: body.approvalId, reason })],
    );
    await recordFailedAttempt(pool, {
      approvalId: body.approvalId,
      userPartyId: approval.partyId,
      amount: approval.amount,
      nonce: approval.nonce,
      failureStep: 'on-chain-failed',
      failureReason: reason,
      // Diagnostic envelope: the incoming user request, the (successful)
      // exchange-backend call we made before attempting on-chain, and the
      // on-chain error itself. Exchange has already debited at this point
      // — including the exchange request/response is critical context for
      // manual reconciliation (it shows exactly what was debited).
      requestPayload: {
        incoming: safePayload,
        exchangeRequest: {
          url: finalize.url,
          method: 'POST',
          body: finalize.requestPayload,
        },
        exchangeResponse: {
          status: finalize.status,
          body: finalize.body,
        },
        onChainError: {
          message: reason,
          stack: (err as Error).stack,
        },
      },
    });
    return res.status(500).json({
      error: 'on_chain_failed',
      message: 'Issue in transferring on chain. Please contact support — help@mperps.xyz',
      stage: 'on-chain-failed',
      details: reason,
      state: 'finalized',
    });
  }
});

/**
 * Append a row to `failed_withdraw_attempts`. Records every recoverable
 * failure inside POST /cb/withdraw with enough metadata for ops to:
 *   - locate the user's locked / debited balance at exchange-backend
 *   - decide between unlock vs manual on-chain settlement
 *   - replay the request if the cause is now fixed
 *
 * Strict-recording contract:
 *   - Caller's 4xx/5xx response to the user is NEVER blocked by a
 *     recording failure — we don't re-throw, so the user always gets
 *     their HTTP response.
 *   - If the primary INSERT fails (e.g. CHECK violation, pool
 *     exhausted), we log LOUDLY (console.error) AND attempt a
 *     last-ditch audit_log INSERT so the failure is at least visible
 *     in `audit_log`. The previous version silently swallowed errors
 *     with console.warn — the symptom in prod was "exchange call
 *     failed but failed_withdraw_attempts has no row", which is the
 *     exact mode this now defends against.
 */
type WithdrawFailureStep =
  | 'auth'
  | 'lookup'
  | 'replay'
  // 2026-05-20 refactor — canonical values for new failures. Legacy
  // 'exchange'/'on_chain' stay in the CHECK constraint for back-compat
  // but are no longer written by new code.
  | 'exchange-api-fail'
  | 'on-chain-failed';

async function recordFailedAttempt(
  pool: Pool,
  args: {
    approvalId?: string;
    userPartyId?: string;
    amount?: string;
    nonce?: string;
    failureStep: WithdrawFailureStep;
    failureReason: string;
    requestPayload: unknown;
  },
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO failed_withdraw_attempts
         (approval_id, user_party_id, amount, nonce, failure_step, failure_reason, request_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        args.approvalId ?? null,
        args.userPartyId ?? null,
        args.amount ?? null,
        args.nonce ?? null,
        args.failureStep,
        args.failureReason.slice(0, 2000),
        JSON.stringify(args.requestPayload),
      ],
    );
    // eslint-disable-next-line no-console
    console.log(
      `[withdraw] recorded failed_withdraw_attempt step=${args.failureStep} approval=${args.approvalId ?? '<none>'}`,
    );
    return;
  } catch (primaryErr) {
    // eslint-disable-next-line no-console
    console.error(
      `[withdraw] CRITICAL: failed to INSERT failed_withdraw_attempts row ` +
        `(step=${args.failureStep} approval=${args.approvalId ?? '<none>'}) — ` +
        `falling back to audit_log:`,
      {
        message: (primaryErr as Error).message,
        stack: (primaryErr as Error).stack,
      },
    );
  }

  // Last-ditch: at least leave a trail in audit_log so ops can find it.
  try {
    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'withdraw.failure.record_missed', $2::jsonb)`,
      [
        args.userPartyId ?? null,
        JSON.stringify({
          approvalId: args.approvalId,
          amount: args.amount,
          nonce: args.nonce,
          failureStep: args.failureStep,
          failureReason: args.failureReason.slice(0, 2000),
          requestPayload: args.requestPayload,
          note: 'INSERT into failed_withdraw_attempts threw; this audit_log row is the fallback record',
        }),
      ],
    );
  } catch (auditErr) {
    // eslint-disable-next-line no-console
    console.error(
      `[withdraw] DOUBLE-CRITICAL: audit_log fallback also failed — manual reconciliation needed`,
      {
        message: (auditErr as Error).message,
        approval: args.approvalId,
        step: args.failureStep,
        original_failure_reason: args.failureReason,
        request_payload: args.requestPayload,
      },
    );
  }
}

interface OnChainResult {
  transferUpdateId: string | null;
  treasuryTransferUpdateId: string | null;
  principalAmount: string;
  profitAmount: string;
  consumedCids: string[];
}

interface OnChainDepositRow {
  cid: string;
  amount: string;
  depositedAt: string;
}

/**
 * Execute the on-chain side of a withdrawal:
 *   1. Pick the user's unconsumed deposits to cover `amount` (small-first).
 *      If the last picked deposit overshoots, mark a split so we can call
 *      SplitForWithdrawal on chain after the transfer succeeds.
 *   2. operator transfer vaultPool → user via CIP-56 TransferFactory_Transfer.
 *      `commandId` is pinned to the approval id so a retry of the same
 *      withdrawal is idempotent at the ledger layer.
 *   3. ATOMIC: mark picked deposits as consumed in DB; if there was a split,
 *      insert a new deposits row carrying the change.
 *   4. Best-effort: archive the DepositRecords on chain (ConsumeForWithdrawal
 *      and/or SplitForWithdrawal). Failure here is logged but not fatal —
 *      the user got their money and the DB is correct.
 */
export async function runOnChainWithdraw(args: {
  pool: Pool;
  approvalId: string;
  userParty: string;
  amount: string;
}): Promise<OnChainResult> {
  const { pool, approvalId, userParty, amount } = args;

  const opToken = await getOperatorToken(sdkConfig);
  const opUserId = await resolveOperatorCantonId(sdkConfig);

  // ── 1. Read the user's on-chain DepositRecords. Total of these is the
  //      "principal-available" — what we can withdraw out of vaultPool
  //      against the user's existing receipts.
  const onChainRecords = await getUserDepositRecords(sdkConfig, opToken, userParty, {
    instrumentAdmin: INSTRUMENT_ADMIN_PARTY_ID,
    instrumentId: INSTRUMENT_ID,
  });
  const requestedScaled = toScaled(amount);
  let principalAvailableScaled = 0n;
  for (const r of onChainRecords) principalAvailableScaled += toScaled(r.amount);

  // Principal/profit split: the user gets `principal` out of vaultPool
  // against their own receipts, and `profit` topped up by the treasury.
  // Either side can be zero (pure-profit withdraw, pure-principal withdraw).
  const principalScaled =
    requestedScaled <= principalAvailableScaled ? requestedScaled : principalAvailableScaled;
  const profitScaled = requestedScaled - principalScaled;
  const principalAmount = fromScaled(principalScaled);
  const profitAmount = fromScaled(profitScaled);

  // Pick deposits only when there's a principal portion to consume.
  let picked: PickResult | null = null;
  if (principalScaled > 0n) {
    picked = pickDeposits(onChainRecords, principalAmount);
    // Should be impossible (principalScaled is capped at the sum), but
    // guard so a bad pickDeposits return doesn't crash downstream.
    if (!picked) {
      throw new Error(`pickDeposits failed for principal ${principalAmount} ${INSTRUMENT_ID}`);
    }
  }

  // ── 2a. Transfer vaultPool → user for `principal` (skip when zero).
  let transferUpdateId: string | null = null;
  if (principalScaled > 0n) {
    const xfer = await sendAmulet({
      config: sdkConfig,
      opToken,
      opUserId,
      sender: PARTIES.vaultPool,
      receiver: userParty,
      amount: principalAmount,
      instrumentAdmin: INSTRUMENT_ADMIN_PARTY_ID,
      instrumentId: INSTRUMENT_ID,
      extraActAs: [PARTIES.vaultPool],
      memo: {
        'mperp.kind': 'withdrawal',
        'mperp.approvalId': approvalId,
        'mperp.principalAmount': principalAmount,
        'mperp.profitAmount': profitAmount,
      },
      commandId: `withdraw-${approvalId}`, // idempotent retry
    });
    transferUpdateId = xfer.transferUpdateId;
  }

  // ── 2b. Transfer treasury → user for `profit` (skip when zero). If the
  //      principal step already moved the partial principal, a failure here
  //      leaves the withdraw partially fulfilled — recorded in audit_log
  //      so ops can finish it manually (rare; treasury should always have
  //      capacity on devnet).
  let treasuryTransferUpdateId: string | null = null;
  if (profitScaled > 0n) {
    try {
      const xfer = await sendAmulet({
        config: sdkConfig,
        opToken,
        opUserId,
        sender: PARTIES.treasury,
        receiver: userParty,
        amount: profitAmount,
        instrumentAdmin: INSTRUMENT_ADMIN_PARTY_ID,
        instrumentId: INSTRUMENT_ID,
        extraActAs: [PARTIES.treasury],
        memo: {
          'mperp.kind': 'withdrawal.profit',
          'mperp.approvalId': approvalId,
          'mperp.principalAmount': principalAmount,
          'mperp.profitAmount': profitAmount,
        },
        commandId: `withdraw-${approvalId}-profit`,
      });
      treasuryTransferUpdateId = xfer.transferUpdateId;
    } catch (e) {
      await pool.query(
        `INSERT INTO audit_log (user_party_id, action, details)
           VALUES ($1, 'withdraw.partial', $2::jsonb)`,
        [
          userParty,
          JSON.stringify({
            approvalId,
            principalAmount,
            profitAmount,
            transferUpdateId,
            error: (e as Error).message,
          }),
        ],
      );
      throw new Error(`treasury→user profit transfer failed: ${(e as Error).message}`);
    }
  }

  // ── 3. Archive the principal-side DepositRecords on chain. Treasury
  //      transfer has no receipts to archive — profit is funded out of
  //      operator-owned treasury holdings, not the user's deposit receipts.
  const consumedCids: string[] = picked?.exact.map((p) => p.cid) ?? [];
  let splitBigCid: string | null = null;
  if (picked) {
    try {
      const archived = await archiveDepositRecords({
        opToken,
        opUserId,
        approvalId,
        transferUpdateId: transferUpdateId ?? '(unknown)',
        pickedExact: picked.exact,
        pickedSplit: picked.split,
      });
      splitBigCid = archived.bigCid;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[withdraw] archive failed (non-fatal): ${(e as Error).message}`);
    }
  }

  // ── 4. Sync the deposits Postgres table best-effort.
  if (picked) {
    await syncConsumedToDb({
      pool,
      approvalId,
      userParty,
      pickedExact: picked.exact,
      pickedSplit: picked.split,
      splitBigCid,
    }).catch((e: Error) => {
      // eslint-disable-next-line no-console
      console.warn(`[withdraw] DB sync failed (non-fatal): ${e.message}`);
    });
  }

  // ── 5. Record the split on the withdrawals row.
  await pool.query(
    `UPDATE withdrawals
        SET principal_amount = $1,
            profit_amount = $2,
            treasury_transfer_update_id = $3,
            updated_at = NOW()
      WHERE approval_id = $4`,
    [principalAmount, profitAmount, treasuryTransferUpdateId, approvalId],
  );

  // The "primary" update id surfaced to the API is the vaultPool transfer
  // when there is one, else the treasury transfer (pure-profit withdraw).
  return {
    transferUpdateId: transferUpdateId ?? treasuryTransferUpdateId,
    treasuryTransferUpdateId,
    principalAmount,
    profitAmount,
    consumedCids,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

interface OnChainDepositRow {
  cid: string;
  amount: string;
  depositedAt: string;
}

interface PickResult {
  exact: OnChainDepositRow[];
  split: { cid: string; needed: string; change: string } | null;
}

/**
 * Pick DepositRecord(s) from the on-chain ACS query that cover `amount`.
 * Three-pass strategy, ordered by cheapness of the resulting on-chain
 * bookkeeping:
 *
 *   1. EXACT SINGLE — a record whose amount equals the requested amount.
 *      Zero splits, one consume. The ideal case.
 *
 *   2. SMALLEST SINGLE-COVER → SPLIT — the smallest record strictly larger
 *      than `amount`. One split (+ one small-child consume). Beats any
 *      combine-multiple strategy because it touches a single record.
 *
 *   3. LARGE-FIRST COMBINE — when no single record covers, combine larger
 *      ones first so we use as few records as possible. The last one
 *      splits if it overshoots.
 *
 * Ties on amount break by `depositedAt ASC` (FIFO — older receipts go
 * first), then by `cid` for determinism.
 *
 * Returns null when even consuming everything doesn't cover `amount`.
 */
function pickDeposits(rows: OnChainDepositRow[], amount: string): PickResult | null {
  const want = toScaled(amount);
  if (want === 0n) return { exact: [], split: null };

  const ascAmt = [...rows].sort((a, b) => {
    const aa = toScaled(a.amount);
    const bb = toScaled(b.amount);
    if (aa !== bb) return aa < bb ? -1 : 1;
    if (a.depositedAt !== b.depositedAt)
      return a.depositedAt < b.depositedAt ? -1 : 1;
    return a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0;
  });

  // 1. EXACT SINGLE.
  for (const row of ascAmt) {
    if (toScaled(row.amount) === want) {
      return { exact: [row], split: null };
    }
  }

  // 2. SMALLEST SINGLE-COVER → SPLIT.
  for (const row of ascAmt) {
    const rowScaled = toScaled(row.amount);
    if (rowScaled > want) {
      return {
        exact: [],
        split: {
          cid: row.cid,
          needed: amount,
          change: fromScaled(rowScaled - want),
        },
      };
    }
  }

  // 3. LARGE-FIRST COMBINE (+ split last if needed).
  const descAmt = [...ascAmt].reverse();
  let remaining = want;
  const exact: OnChainDepositRow[] = [];
  for (const row of descAmt) {
    if (remaining <= 0n) break;
    const rowScaled = toScaled(row.amount);
    if (rowScaled <= remaining) {
      exact.push(row);
      remaining -= rowScaled;
      continue;
    }
    return {
      exact,
      split: {
        cid: row.cid,
        needed: fromScaled(remaining),
        change: fromScaled(rowScaled - remaining),
      },
    };
  }
  if (remaining > 0n) return null;
  return { exact, split: null };
}

async function archiveDepositRecords(args: {
  opToken: string;
  opUserId: string;
  approvalId: string;
  transferUpdateId: string;
  pickedExact: OnChainDepositRow[];
  pickedSplit: { cid: string; needed: string; change: string } | null;
}): Promise<{ bigCid: string | null }> {
  const {
    opToken,
    opUserId,
    approvalId,
    transferUpdateId,
    pickedExact,
    pickedSplit,
  } = args;

  // SplitForWithdrawal first — gives us new cids for {smallCid, bigCid}.
  // smallCid is the part we'll Consume to offset the withdrawal; bigCid is
  // the change DepositRecord that remains spendable. We return bigCid so
  // the caller can mirror it into the DB.
  let splitSmallCid: string | null = null;
  let splitBigCid: string | null = null;
  if (pickedSplit) {
    const splitResult = await submitCommand(
      sdkConfig,
      opToken,
      opUserId,
      [PARTIES.operator],
      [
        {
          ExerciseCommand: {
            templateId: TPL_DEPOSIT_RECORD,
            contractId: pickedSplit.cid,
            choice: 'SplitForWithdrawal',
            choiceArgument: { splitAmount: pickedSplit.needed },
          },
        },
      ],
      { commandId: `withdraw-${approvalId}-split` },
    );
    const { smallCid, bigCid } = parseSplitChildren(splitResult, pickedSplit.needed);
    splitSmallCid = smallCid;
    splitBigCid = bigCid;
  }

  // ConsumeForWithdrawal on every full pick + the small-child of the split.
  const toConsume: string[] = pickedExact.map((p) => p.cid);
  if (splitSmallCid) toConsume.push(splitSmallCid);
  if (toConsume.length === 0) return { bigCid: splitBigCid };

  await submitCommand(
    sdkConfig,
    opToken,
    opUserId,
    [PARTIES.operator],
    toConsume.map((cid) => ({
      ExerciseCommand: {
        templateId: TPL_DEPOSIT_RECORD,
        contractId: cid,
        choice: 'ConsumeForWithdrawal',
        choiceArgument: { transferUpdateId },
      },
    })),
    { commandId: `withdraw-${approvalId}-consume` },
  );
  return { bigCid: splitBigCid };
}

/**
 * Best-effort mirror of the on-chain archive into `deposits`. After the
 * ledger has Consumed (and possibly Split) DepositRecords, drag the
 * Postgres table along:
 *   - mark each picked cid `consumed_at = NOW()`
 *   - if a split happened, insert a row for the big-child (the change),
 *     with its actual on-chain cid
 *
 * Drift is OK during testing: if a picked cid has no DB row (or the row
 * was already consumed), the UPDATE is a no-op. The ledger remains the
 * canonical state; this table is the audit log we cross-check against.
 */
async function syncConsumedToDb(args: {
  pool: Pool;
  approvalId: string;
  userParty: string;
  pickedExact: OnChainDepositRow[];
  pickedSplit: { cid: string; needed: string; change: string } | null;
  splitBigCid: string | null;
}): Promise<void> {
  const { pool, approvalId, userParty, pickedExact, pickedSplit, splitBigCid } = args;

  const consumeCids = pickedExact.map((p) => p.cid);
  if (pickedSplit) consumeCids.push(pickedSplit.cid);
  if (consumeCids.length > 0) {
    await pool.query(
      `UPDATE deposits
          SET consumed_at = NOW(),
              consumed_by_withdrawal = $1
        WHERE deposit_receipt_cid = ANY($2::text[])
          AND consumed_at IS NULL`,
      [approvalId, consumeCids],
    );
  }
  // Insert a row for the change DepositRecord so subsequent /deposits
  // history queries (DB-driven) see it. The Holdings tab already pulls
  // from on-chain so it's accurate independent of this.
  if (pickedSplit && splitBigCid) {
    await pool.query(
      `INSERT INTO deposits
         (user_party_id, amount, transfer_update_id, source_holding_cid, deposit_receipt_cid)
         VALUES ($1, $2, $3, NULL, $4)
         ON CONFLICT (transfer_update_id) DO NOTHING`,
      [
        userParty,
        pickedSplit.change,
        `split-${approvalId}-of-${pickedSplit.cid}`,
        splitBigCid,
      ],
    );
  }
}

function parseSplitChildren(
  result: Record<string, unknown>,
  needed: string,
): { smallCid: string | null; bigCid: string | null } {
  const eventsById =
    ((result as { transactionTree?: { eventsById?: Record<string, unknown> } }).transactionTree
      ?.eventsById) ?? {};
  let smallCid: string | null = null;
  let bigCid: string | null = null;
  for (const e of Object.values(eventsById)) {
    const ce = (e as { CreatedTreeEvent?: { value?: Record<string, unknown> } }).CreatedTreeEvent;
    if (!ce) continue;
    const v = (ce.value ?? ce) as Record<string, unknown>;
    const tid = v.templateId as string | undefined;
    const cid = v.contractId as string | undefined;
    if (!tid || !cid) continue;
    if (tid !== TPL_DEPOSIT_RECORD && !tid.endsWith(':Vault:DepositRecord')) continue;
    const argsRec = (v.createArguments ?? v.createArgument ?? {}) as Record<string, unknown>;
    const amt = String(argsRec.amount ?? '');
    if (decimalsEqual(amt, needed)) smallCid = cid;
    else bigCid = cid;
  }
  return { smallCid, bigCid };
}

function decimalsEqual(a: string, b: string): boolean {
  const norm = (s: string): string => {
    if (!s.includes('.')) return s;
    return s.replace(/0+$/, '').replace(/\.$/, '');
  };
  return norm(a) === norm(b);
}

const SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

function toScaled(decimal: string | number | bigint): bigint {
  // pg returns NUMERIC columns as strings, but request bodies often carry
  // amounts as JS numbers. Normalize before parsing.
  const s = typeof decimal === 'string' ? decimal : String(decimal);
  const [intPart, fracPart = ''] = s.split('.');
  const fracPadded = (fracPart + '0'.repeat(SCALE)).slice(0, SCALE);
  return BigInt(intPart || '0') * SCALE_FACTOR + BigInt(fracPadded || '0');
}

function fromScaled(scaled: bigint): string {
  const intPart = scaled / SCALE_FACTOR;
  const fracPart = (scaled % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : `${intPart}`;
}

interface ExchangeFinalizeResult {
  ok: boolean;
  status: number;
  body: unknown;
  /** The exact JSON we POSTed to exchange-backend's /v1/withdraw/defi.
   *  Always returned (even on error) so failure recording can capture it
   *  in `failed_withdraw_attempts.request_payload`. Includes the txnHash,
   *  walletAddress, coin, amount, nonce, and approvalId fields exactly
   *  as sent on the wire. */
  requestPayload: Record<string, unknown>;
  /** Endpoint URL hit (or null if EXCHANGE_WITHDRAW_URL was unset). */
  url: string | null;
}

async function postExchangeWithdrawFinalize(args: {
  partyId: string;
  amount: string;
  nonce: string;
  approvalId: string;
}): Promise<ExchangeFinalizeResult> {
  // Body shape (current exchange-backend contract):
  //   { txnHash, walletAddress, coin, amount, nonce, approvalId }
  // approvalId MUST be a number (exchange-backend indexes by numeric id;
  // a string-typed value is rejected).
  const txnHash = `cb-w-${args.approvalId}`;
  const approvalIdNum = Number(args.approvalId);

  // Build the payload up-front so we can return it even on early-out
  // branches (no URL configured, non-numeric approval id, network throw).
  const requestPayload: Record<string, unknown> = {
    txnHash,
    walletAddress: args.partyId,
    coin: 'USDT',
    amount: Number(args.amount),
    nonce: args.nonce,
    approvalId: Number.isFinite(approvalIdNum) ? approvalIdNum : args.approvalId,
  };

  if (!EXCHANGE_WITHDRAW_URL) {
    return {
      ok: false,
      status: 0,
      body: { error: 'EXCHANGE_WITHDRAW_URL not set' },
      requestPayload,
      url: null,
    };
  }
  if (!Number.isFinite(approvalIdNum)) {
    return {
      ok: false,
      status: 0,
      body: { error: `non-numeric approvalId: ${args.approvalId}` },
      requestPayload,
      url: EXCHANGE_WITHDRAW_URL,
    };
  }
  try {
    const res = await fetch(EXCHANGE_WITHDRAW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn('[withdraw] exchange finalize rejected', {
        url: EXCHANGE_WITHDRAW_URL,
        status: res.status,
        payload: requestPayload,
        responseBody: body,
      });
    }
    return { ok: res.ok, status: res.status, body, requestPayload, url: EXCHANGE_WITHDRAW_URL };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[withdraw] exchange finalize errored', {
      url: EXCHANGE_WITHDRAW_URL,
      payload: requestPayload,
      error: (err as Error).message,
    });
    return {
      ok: false,
      status: 0,
      body: { error: (err as Error).message },
      requestPayload,
      url: EXCHANGE_WITHDRAW_URL,
    };
  }
}

export default router;
