/**
 * Deposit watcher.
 *
 * Polls vaultPool's CIP-56 Holdings every N seconds. For each new Holding
 * (one we haven't already recorded), walks back to the originating
 * `TransferFactory_Transfer` exercise to find the depositing party. Then:
 *
 *   • If we don't know the depositor → row in held_deposits (unknown_user).
 *   • If the depositor exists but KYC is not approved → held_deposits
 *     (reason='kyc_not_done').
 *   • If KYC approved → create #exchange-v2-core:Vault:DepositRecord
 *     on chain (operator-signed), record the receipt cid + transfer
 *     update_id in `deposits`.
 *
 * Dedup: we use the transfer's `update_id` as the unique key (one transfer
 * → one Holding → one DepositRecord). Stored in deposits.transfer_update_id
 * (UNIQUE) and held_deposits.transfer_update_id (UNIQUE).
 */
import type { Pool } from 'pg';
import { closePool, getPool } from '../db/pool.js';
import {
  CANTON_LEDGER_API,
  EXCHANGE_DEPOSIT_URL,
  INSTRUMENT_ADMIN_PARTY_ID,
  INSTRUMENT_ID,
  INSTRUMENT_SYMBOL,
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  KEYCLOAK_TOKEN_URL,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET,
  OPERATOR_KC_USERNAME,
  OPERATOR_KC_PASSWORD,
  PACKAGE_ID,
  PARTIES,
  EXCHANGE_API_HEADER,
  BRIDGE_OPERATOR_PARTY_ID,
  UTILITY_OPERATOR_PARTY_ID,
} from '../config.js';
import { registerAlert, runAlertProcessor } from '../alerts/index.js';
import { writeHeartbeat } from './heartbeat.js';
import type { CantonSdkConfig } from '../canton-sdk/config.js';
import {
  IFACE_HOLDING,
  TPL_DEPOSIT_RECORD,
} from '../canton-sdk/config.js';
import {
  collectExerciseEvents,
  getActiveContracts,
  getCreatedEventsByOffsetRange,
  getEventsByContractId,
  getLedgerEnd,
  getTransactionTreeByOffset,
  submitCommand,
  extractCreatedContractId,
} from '../canton-sdk/ledger.js';
import { getOperatorToken } from '../canton-sdk/tokens.js';
import { resolveOperatorCantonId } from '../canton-sdk/operator.js';
import { signPayload } from '../exchangeAuth.js';

const INTERVAL_MS = Number(process.env.WATCHER_INTERVAL_MS ?? 5_000);
// Stop hammering the exchange API after this many failed attempts per deposit.
// Default kept low so persistent failures surface fast in the ops queue
// instead of churning in the retry loop. Operator can reset by zeroing
// exchange_attempts manually in SQL once the underlying blocker is fixed
// (typical case: user account not yet linked at the exchange side).
const MAX_EXCHANGE_ATTEMPTS = Number(process.env.EXCHANGE_MAX_ATTEMPTS ?? 2);
// Don't retry more often than this — at 5s interval we'd otherwise hit
// every tick; for transient errors it's fine, but for a 4xx we want a back-off.
const RETRY_BACKOFF_MS = Number(process.env.EXCHANGE_RETRY_BACKOFF_MS ?? 30_000);
const RETRY_BATCH_LIMIT = 25;

// Cutoff for which on-chain transfers the watcher will credit. Any transfer
// whose `requestedAt` is before this is skipped (logged once + dropped).
// Use this to ignore vaultPool holdings that existed before the deposit
// functionality went live, so they don't accidentally get re-credited.
//   format: ISO-8601 timestamp, e.g. '2026-05-13T00:00:00Z'
// Unset = process everything (legacy behaviour).
const PROCESS_FROM_DATE = process.env.WATCHER_PROCESS_FROM_DATE
  ? new Date(process.env.WATCHER_PROCESS_FROM_DATE)
  : null;
if (PROCESS_FROM_DATE && Number.isNaN(PROCESS_FROM_DATE.getTime())) {
  throw new Error(`WATCHER_PROCESS_FROM_DATE is not a valid ISO date: ${process.env.WATCHER_PROCESS_FROM_DATE}`);
}

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

function log(msg: string, ...rest: unknown[]): void {
  console.log(`[watcher] ${new Date().toISOString()} ${msg}`, ...rest);
}

// In-process caches to keep the log volume down on repeat polls.
const seenHoldingCids = new Set<string>();
const unmatchedLogged = new Set<string>();
const lookupFailures = new Map<string, number>();
const MAX_LOOKUP_FAILURES = 3;

// Parties that are ours/internal — a transfer to the vault from one of these
// is internal movement (change from a withdrawal, treasury top-up, bridge),
// NOT an unattributed user deposit. It's still recorded in held_deposits for
// the trail, but it never raises an "unknown user" alert.
const INTERNAL_PARTIES = new Set<string>(
  [
    PARTIES.operator,
    PARTIES.vaultPool,
    PARTIES.treasury,
    PARTIES.tokenIssuer,
    INSTRUMENT_ADMIN_PARTY_ID,
    BRIDGE_OPERATOR_PARTY_ID,
    UTILITY_OPERATOR_PARTY_ID,
  ].filter(Boolean),
);

async function main(): Promise<void> {
  const pool = getPool();
  await sanityCheckDb(pool);
  await backfillSourceHoldingCids(pool);

  log(`starting; polling every ${INTERVAL_MS}ms`);
  log(`  vaultPool : ${PARTIES.vaultPool}`);
  log(`  operator  : ${PARTIES.operator}`);
  log(`  instrument: ${INSTRUMENT_SYMBOL} (id=${INSTRUMENT_ID}, admin ${INSTRUMENT_ADMIN_PARTY_ID.split('::')[0]}...)`);

  const stopSignal = installStopSignal();
  while (!stopSignal.aborted) {
    try {
      await tick(pool);
    } catch (err) {
      log(`tick error (continuing): ${(err as Error).message}`);
    }
    // Drain the ops-alert queue to Telegram. This is the single delivery
    // point — alerts registered here AND by the Lambda (same RDS) go out
    // from this process. Isolated so a delivery hiccup can't stall the watcher.
    try {
      const r = await runAlertProcessor(pool);
      if (r.sent || r.failed) log(`alerts: sent ${r.sent}, failed ${r.failed}`);
    } catch (err) {
      log(`alert processor error (continuing): ${(err as Error).message}`);
    }
    await sleep(INTERVAL_MS, stopSignal);
  }

  log('stopping');
  await closePool();
}

async function sanityCheckDb(pool: Pool): Promise<void> {
  const off = await readCheckpoint(pool);
  log(`db checkpoint: ${off ?? '(none — will bootstrap via ACS query on first tick)'}`);
}

/**
 * Read the persisted Canton ledger offset. Returns null when the row is
 * empty/absent — caller treats that as "bootstrap needed" and seeds the
 * checkpoint with the current ledger end after a one-time ACS query.
 *
 * Ledger offsets in Canton 3 are monotonic integers; we store them as
 * TEXT to stay compatible with the existing schema (which was created
 * before we committed to the offset type) and parse to Number here.
 */
async function readCheckpoint(pool: Pool): Promise<number | null> {
  const r = await pool.query<{ last_offset: string }>(
    `SELECT last_offset FROM watcher_checkpoint WHERE id = 1`,
  );
  const raw = (r.rows[0]?.last_offset ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Persist the latest known ledger end as the next beginExclusive. */
async function writeCheckpoint(pool: Pool, offset: number): Promise<void> {
  await pool.query(
    `INSERT INTO watcher_checkpoint (id, last_offset, updated_at)
       VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE
       SET last_offset = EXCLUDED.last_offset,
           updated_at  = EXCLUDED.updated_at`,
    [String(offset)],
  );
}

/**
 * One-time per startup: populate `source_holding_cid` for any pre-existing
 * `deposits` / `held_deposits` rows that don't have it set yet. We added
 * the column later, so old rows are NULL; the dedup query in `tick()`
 * keys on `source_holding_cid` and would otherwise miss them, causing the
 * watcher to "re-process" Holdings it already credited (the `transfer_update_id`
 * UNIQUE constraint stops the duplicate row, but the chain submit + exchange
 * notify already happened by that point).
 *
 * The cid we need lives in audit_log: `deposit.credited` rows carry
 * `details.holdingCid`, and `held_deposits.raw_meta.holdingCid` was set on
 * insert. Both backfills are idempotent — they only touch rows where
 * source_holding_cid IS NULL.
 */
async function backfillSourceHoldingCids(pool: Pool): Promise<void> {
  const d = await pool.query(
    `UPDATE deposits d
        SET source_holding_cid = a.details->>'holdingCid'
       FROM audit_log a
      WHERE d.source_holding_cid IS NULL
        AND a.action = 'deposit.credited'
        AND a.details->>'transferUpdateId' = d.transfer_update_id
        AND a.details->>'holdingCid' IS NOT NULL`,
  );
  const h = await pool.query(
    `UPDATE held_deposits
        SET source_holding_cid = raw_meta->>'holdingCid'
      WHERE source_holding_cid IS NULL
        AND raw_meta ? 'holdingCid'`,
  );
  if ((d.rowCount ?? 0) > 0 || (h.rowCount ?? 0) > 0) {
    log(`backfilled source_holding_cid: ${d.rowCount ?? 0} deposits, ${h.rowCount ?? 0} held`);
  }
}

/**
 * One polling iteration.
 *  0. Retry any deposits whose on-chain credit succeeded but whose
 *     exchange-backend notify failed last time (transient 5xx, network,
 *     or recoverable 4xx where the operator has since fixed the link).
 *  1. Fetch new Holdings since the last persisted checkpoint:
 *       - bootstrap path (checkpoint empty): ACS query of all active
 *         vaultPool Holdings, then write current ledger end as checkpoint
 *       - incremental path: stream creates in (lastOffset, ledgerEnd]
 *         via /v2/updates/flats
 *  2. Filter to Amulet/CC + unlocked + not-yet-seen.
 *  3. For each, resolve the originating transfer's update_id + sender
 *     party from the on-chain tx tree.
 *  4. Branch on KYC status; create DepositRecord or write to held_deposits.
 *  5. Persist the new ledger end so the next tick only sees deltas.
 */
async function tick(pool: Pool): Promise<void> {
  // Liveness first, before any early return — so the heartbeat advances every
  // tick even on idle ticks (writeCheckpoint doesn't run when nothing is new).
  await writeHeartbeat(pool, 'deposit-watcher', { intervalMs: INTERVAL_MS });

  await retryFailedExchangeNotifies(pool);

  const opToken = await getOperatorToken(sdkConfig);
  const opUserId = await resolveOperatorCantonId(sdkConfig);

  const ledgerEnd = await getLedgerEnd(sdkConfig, opToken);
  const lastOffset = await readCheckpoint(pool);

  let contracts;
  if (lastOffset == null) {
    // Bootstrap on first run — one-time full ACS scan so any pre-existing
    // unprocessed Holdings get picked up. Dedup via source_holding_cid
    // keeps it safe if the watcher restarts mid-bootstrap.
    log(`bootstrap: full ACS scan at offset ${ledgerEnd}`);
    contracts = await getActiveContracts(
      sdkConfig, opToken, PARTIES.vaultPool, { interfaceId: IFACE_HOLDING },
    );
  } else if (lastOffset >= ledgerEnd) {
    // Nothing new since last tick. Skip the network roundtrip + DB writes.
    return;
  } else {
    // Incremental: only the creates that happened in this offset window.
    // Skips the full ACS scan, which is what makes growth O(deltas) instead
    // of O(active Holdings).
    contracts = await getCreatedEventsByOffsetRange(sdkConfig, opToken, {
      party: PARTIES.vaultPool,
      interfaceId: IFACE_HOLDING,
      beginExclusive: lastOffset,
      endInclusive: ledgerEnd,
    });
    if (contracts.length > 0) {
      log(`incremental: ${contracts.length} creates in (${lastOffset}, ${ledgerEnd}]`);
    }
  }

  for (const c of contracts) {
    if (seenHoldingCids.has(c.contractId)) continue;

    const view = (c.interfaceView ?? c.payload) as Record<string, unknown>;
    const owner = String(view.owner ?? '');
    const iid = (view.instrumentId ?? {}) as { admin?: string; id?: string };
    const amount = String(view.amount ?? '0');

    if (owner !== PARTIES.vaultPool) { seenHoldingCids.add(c.contractId); continue; }
    if (iid.admin !== INSTRUMENT_ADMIN_PARTY_ID || iid.id !== INSTRUMENT_ID) { seenHoldingCids.add(c.contractId); continue; }
    if (view.lock) { seenHoldingCids.add(c.contractId); continue; } // locked holding (e.g. fee reserve) — skip
    if (Number(amount) <= 0) { seenHoldingCids.add(c.contractId); continue; }

    // Cross-restart dedup, pass 1: by source_holding_cid (set on all new
    // rows). The backfill at startup populates this on old rows too, so
    // this is the fast path. Catches > 99% of duplicates without needing
    // the on-chain lookup below.
    const alreadyRecorded = await pool.query<{ id: number }>(
      `SELECT id FROM deposits WHERE source_holding_cid = $1
       UNION ALL
       SELECT id FROM held_deposits WHERE source_holding_cid = $1`,
      [c.contractId],
    );
    if (alreadyRecorded.rowCount && alreadyRecorded.rowCount > 0) {
      seenHoldingCids.add(c.contractId);
      continue;
    }

    // Resolve sender + transfer update_id + requestedAt from chain.
    let sender: string | null = null;
    let transferUpdateId: string | null = null;
    let requestedAt: string | null = null;
    try {
      const ev = await getEventsByContractId(sdkConfig, opToken, {
        contractId: c.contractId,
        requestingParties: [PARTIES.vaultPool, PARTIES.operator],
      });
      const inner = (ev.created?.createdEvent ?? ev.created ?? {}) as { offset?: number; updateId?: string };
      const offset = inner.offset ?? ev.created?.offset;
      transferUpdateId = inner.updateId ?? null;
      if (typeof offset !== 'number') throw new Error('no offset on create event');

      const tree = await getTransactionTreeByOffset(sdkConfig, opToken, {
        offset,
        requestingParties: [PARTIES.vaultPool, PARTIES.operator],
      });
      // Canton 3 wraps the update id behind a oneof variant in /v2/updates/
      // update-by-offset. Try every shape we've seen: submit-and-wait-style
      // `transactionTree.updateId`, top-level `updateId`, and the canonical
      // update-by-offset path `update.Transaction.value.updateId`. The last
      // one is what was missing — without it the watcher fell back to
      // `c.contractId` and DB rows got contract ids in transfer_update_id.
      transferUpdateId ??=
        (tree as { updateId?: string }).updateId
        ?? (tree.transactionTree as { updateId?: string } | undefined)?.updateId
        ?? (tree as { update?: { Transaction?: { value?: { updateId?: string } } } }).update
             ?.Transaction?.value?.updateId
        ?? (tree as { Transaction?: { value?: { updateId?: string } } }).Transaction
             ?.value?.updateId
        ?? null;

      for (const ex of collectExerciseEvents(tree)) {
        // CIP-56 TransferFactory_Transfer:
        //   choiceArgument.transfer.{sender, requestedAt}
        const ca = ex.choiceArgument as
          | { transfer?: { sender?: string; requestedAt?: string } }
          | undefined;
        if (ca?.transfer?.sender) {
          sender = ca.transfer.sender;
          requestedAt = ca.transfer.requestedAt ?? null;
          break;
        }
        // Fallback: any controlled exercise's actingParties[0].
        if (!sender && ex.actingParties?.[0]) sender = ex.actingParties[0];
      }
    } catch (err) {
      const n = (lookupFailures.get(c.contractId) ?? 0) + 1;
      lookupFailures.set(c.contractId, n);
      if (n <= MAX_LOOKUP_FAILURES) {
        log(`sender lookup failed for ${c.contractId.slice(0, 14)}…: ${(err as Error).message}`);
      }
      if (n >= MAX_LOOKUP_FAILURES) seenHoldingCids.add(c.contractId);
      continue;
    }

    const dedupKey = transferUpdateId ?? c.contractId;

    // Cross-restart dedup, pass 2: by transfer_update_id. Belt-and-suspenders
    // for the case where source_holding_cid is NULL on an existing row
    // (backfill couldn't find the holdingCid in audit_log / raw_meta) but
    // transfer_update_id is correctly set. We do this BEFORE submitCommand
    // so we never create a duplicate DepositRecord on chain.
    if (transferUpdateId) {
      const byTxId = await pool.query<{ id: number }>(
        `SELECT id FROM deposits WHERE transfer_update_id = $1
         UNION ALL
         SELECT id FROM held_deposits WHERE transfer_update_id = $1`,
        [transferUpdateId],
      );
      if (byTxId.rowCount && byTxId.rowCount > 0) {
        // Heal the missing source_holding_cid so pass-1 catches it next time.
        await pool.query(
          `UPDATE deposits SET source_holding_cid = $1
            WHERE transfer_update_id = $2 AND source_holding_cid IS NULL`,
          [c.contractId, transferUpdateId],
        );
        await pool.query(
          `UPDATE held_deposits SET source_holding_cid = $1
            WHERE transfer_update_id = $2 AND source_holding_cid IS NULL`,
          [c.contractId, transferUpdateId],
        );
        log(`dedup hit (tx-id pass) for holding ${c.contractId.slice(0, 14)}… → backfilled source_holding_cid`);
        seenHoldingCids.add(c.contractId);
        continue;
      }
    }

    // Cutoff: skip transfers older than WATCHER_PROCESS_FROM_DATE. We mark
    // them as held_deposits with reason='pre_existing' so they're recorded
    // (operator-visible) but never credited.
    if (PROCESS_FROM_DATE && requestedAt) {
      const reqDate = new Date(requestedAt);
      if (!Number.isNaN(reqDate.getTime()) && reqDate < PROCESS_FROM_DATE) {
        await pool.query(
          `INSERT INTO held_deposits (user_party_id, amount, transfer_update_id, source_holding_cid, reason, raw_meta)
             VALUES ($1, $2, $3, $4, 'pre_existing', $5::jsonb)
           ON CONFLICT (transfer_update_id) DO NOTHING`,
          [
            sender,
            amount,
            dedupKey,
            c.contractId,
            JSON.stringify({ requestedAt, cutoff: PROCESS_FROM_DATE.toISOString(), holdingCid: c.contractId }),
          ],
        );
        log(`held: pre-existing transfer skipped (requestedAt=${requestedAt}, ${amount} ${INSTRUMENT_ID})`);
        seenHoldingCids.add(c.contractId);
        continue;
      }
    }

    if (!sender) {
      await pool.query(
        `INSERT INTO held_deposits (user_party_id, amount, transfer_update_id, source_holding_cid, reason)
           VALUES (NULL, $1, $2, $3, 'unknown_sender')
         ON CONFLICT (transfer_update_id) DO NOTHING`,
        [amount, dedupKey, c.contractId],
      );
      if (!unmatchedLogged.has(c.contractId)) {
        log(`held: unknown sender for ${c.contractId.slice(0, 14)}… (${amount} ${INSTRUMENT_ID})`);
        unmatchedLogged.add(c.contractId);
      }
      // Unattributable USDCx sitting in the vault — needs a human to trace.
      await registerAlert(pool, {
        type: 'deposit_stuck',
        severity: 'warning',
        dedupKey: `deposit_stuck:unknown_sender:${c.contractId}`,
        title: 'Held deposit — unknown sender',
        body: `${amount} ${INSTRUMENT_ID} landed in the vault but the sending party could not be resolved. Recorded in held_deposits; needs manual attribution.`,
        context: { amount, instrument: INSTRUMENT_ID, holdingCid: c.contractId, transferUpdateId: dedupKey },
      });
      seenHoldingCids.add(c.contractId);
      continue;
    }

    // Look up user + KYC status.
    const userRow = (
      await pool.query<{ party_id: string }>(
        `SELECT party_id FROM users WHERE party_id = $1`,
        [sender],
      )
    ).rows[0];

    if (!userRow) {
      await pool.query(
        `INSERT INTO held_deposits (user_party_id, amount, transfer_update_id, source_holding_cid, reason, raw_meta)
           VALUES (NULL, $1, $2, $3, 'unknown_user', $4::jsonb)
         ON CONFLICT (transfer_update_id) DO NOTHING`,
        [amount, dedupKey, c.contractId, JSON.stringify({ sender, holdingCid: c.contractId })],
      );
      log(`held: unknown user ${sender.split('::')[0]}… for ${amount} ${INSTRUMENT_ID}`);
      // Internal transfers (withdrawal change, treasury/bridge moves) land here
      // too — the vault/operator/treasury aren't users. Only alert when the
      // sender is a genuinely unrecognized external party.
      if (!INTERNAL_PARTIES.has(sender)) {
        await registerAlert(pool, {
          type: 'deposit_stuck',
          severity: 'warning',
          dedupKey: `deposit_stuck:unknown_user:${c.contractId}`,
          title: 'Held deposit — unknown user',
          body: `${amount} ${INSTRUMENT_ID} sent to the vault by a party with no user record (${sender.split('::')[0]}…). Recorded in held_deposits; needs manual attribution or onboarding.`,
          context: { amount, instrument: INSTRUMENT_ID, sender, holdingCid: c.contractId, transferUpdateId: dedupKey },
        });
      }
      seenHoldingCids.add(c.contractId);
      continue;
    }

    const kycRow = (
      await pool.query<{ decision: string | null }>(
        `SELECT decision FROM kyc_inquiries
          WHERE user_party_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [sender],
      )
    ).rows[0];

    if (kycRow?.decision !== 'approved') {
      await pool.query(
        `INSERT INTO held_deposits (user_party_id, amount, transfer_update_id, source_holding_cid, reason, raw_meta)
           VALUES ($1, $2, $3, $4, 'kyc_not_done', $5::jsonb)
         ON CONFLICT (transfer_update_id) DO NOTHING`,
        [sender, amount, dedupKey, c.contractId, JSON.stringify({ kycDecision: kycRow?.decision ?? 'not_started', holdingCid: c.contractId })],
      );
      log(`held: kyc not approved for ${sender.split('::')[0]}… (${amount} ${INSTRUMENT_ID}, decision=${kycRow?.decision ?? 'not_started'})`);
      seenHoldingCids.add(c.contractId);
      continue;
    }

    // KYC approved — create DepositRecord on chain + insert deposits row.
    try {
      const result = await submitCommand(sdkConfig, opToken, opUserId, [PARTIES.operator], [
        {
          CreateCommand: {
            templateId: TPL_DEPOSIT_RECORD,
            createArguments: {
              operator: PARTIES.operator,
              user: sender,
              amount,
              instrumentAdmin: INSTRUMENT_ADMIN_PARTY_ID,
              instrumentId: INSTRUMENT_ID,
              sourceTransferId: dedupKey,
              depositedAt: new Date().toISOString(),
            },
          },
        },
      ]);
      const depositRecordCid = extractCreatedContractId(result, TPL_DEPOSIT_RECORD);

      const insertRes = await pool.query<{ id: string }>(
        `INSERT INTO deposits (user_party_id, amount, transfer_update_id, source_holding_cid, deposit_receipt_cid)
           VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (transfer_update_id) DO NOTHING
         RETURNING id`,
        [sender, amount, dedupKey, c.contractId, depositRecordCid],
      );

      // RETURNING + rowCount=0 means the ON CONFLICT branch fired — someone
      // already inserted this transfer (most likely the watcher itself on a
      // prior run, with source_holding_cid NULL before backfill). The chain
      // submit above DID create a duplicate DepositRecord (submitCommand is
      // non-idempotent), but the exchange-credit side effect is what we
      // care about most — DO NOT call it again.
      const isFreshDeposit = (insertRes.rowCount ?? 0) > 0;

      if (!isFreshDeposit) {
        // Heal the missing source_holding_cid so future ticks dedup early.
        await pool.query(
          `UPDATE deposits SET source_holding_cid = $1
            WHERE transfer_update_id = $2 AND source_holding_cid IS NULL`,
          [c.contractId, dedupKey],
        );
        log(`⚠ duplicate deposit detected for tx ${dedupKey.slice(0, 14)}… (already credited; skipping exchange notify)`);
        await pool.query(
          `INSERT INTO audit_log (user_party_id, action, details)
             VALUES ($1, 'deposit.duplicate_detected', $2::jsonb)`,
          [sender, JSON.stringify({ amount, transferUpdateId: dedupKey, depositRecordCid, holdingCid: c.contractId, requestedAt })],
        );
        seenHoldingCids.add(c.contractId);
        continue;
      }

      await pool.query(
        `INSERT INTO audit_log (user_party_id, action, details)
           VALUES ($1, 'deposit.credited', $2::jsonb)`,
        [sender, JSON.stringify({ amount, transferUpdateId: dedupKey, depositRecordCid, holdingCid: c.contractId, requestedAt })],
      );
      log(`✓ deposited ${amount} ${INSTRUMENT_ID} for ${sender.split('::')[0]}… (cid ${depositRecordCid?.slice(0, 14)}…)`);
    } catch (err) {
      log(`DepositRecord create failed for ${sender.split('::')[0]}…: ${(err as Error).message}`);
      // don't mark seen — retry on next tick.
      continue;
    }

    // Notify the exchange backend so the user's tradeable balance reflects
    // the on-chain deposit. Only reached when the deposits row is FRESH
    // (the duplicate branch above does `continue` before getting here).
    // Coin is hard-coded to 'USDT' regardless of the on-chain instrument
    // symbol — the exchange backend's deposit/defi endpoint only knows the
    // legacy EVM coin names, and rejects anything else (incl. our devnet 'CC').
    await tryNotifyAndRecord(pool, {
      partyId: sender,
      amount,
      coin: 'USDT',
      txRef: dedupKey,
    });

    seenHoldingCids.add(c.contractId);
  }

  // Persist the ledger end we processed. Next tick uses this as
  // beginExclusive — anything that lands after this offset is what we'll
  // see. Done at the end so a mid-tick crash doesn't advance the cursor
  // past Holdings we haven't credited yet; on restart we redo the same
  // window and the source_holding_cid dedup makes re-processing safe.
  await writeCheckpoint(pool, ledgerEnd);
}

/**
 * Notify the exchange backend and write the outcome to the deposits row
 * (exchange_credited_at on success, attempt counters + last error on
 * failure). Also writes a one-line audit_log entry so the lifecycle is
 * still grep-able from there.
 */
async function tryNotifyAndRecord(
  pool: Pool,
  args: { partyId: string; amount: string; coin: string; txRef: string },
): Promise<void> {
  const result = await notifyExchangeDeposit(args);
  if (result.ok) {
    await pool.query(
      `UPDATE deposits
          SET exchange_credited_at     = NOW(),
              exchange_attempts        = exchange_attempts + 1,
              exchange_last_attempt_at = NOW(),
              exchange_last_error      = NULL
        WHERE transfer_update_id = $1`,
      [args.txRef],
    );
    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'deposit.exchange.credited', $2::jsonb)`,
      [args.partyId, JSON.stringify({ ...args, onChainSymbol: INSTRUMENT_SYMBOL, status: result.status, body: result.body })],
    );
    log(`✓ exchange credited ${args.amount} ${args.coin} for ${args.partyId.split('::')[0]}…`);
  } else {
    const errSummary = JSON.stringify(result.body).slice(0, 500);
    const upd = await pool.query<{ exchange_attempts: number }>(
      `UPDATE deposits
          SET exchange_attempts        = exchange_attempts + 1,
              exchange_last_attempt_at = NOW(),
              exchange_last_error      = $2
        WHERE transfer_update_id = $1
        RETURNING exchange_attempts`,
      [args.txRef, `${result.status}: ${errSummary}`],
    );
    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'deposit.exchange.failed', $2::jsonb)`,
      [args.partyId, JSON.stringify({ ...args, onChainSymbol: INSTRUMENT_SYMBOL, status: result.status, body: result.body })],
    );
    log(`⚠ exchange notify failed (${result.status}) for ${args.partyId.split('::')[0]}…: ${errSummary.slice(0, 200)}`);

    // Once retries are exhausted the retry pass stops touching this row
    // (it filters exchange_attempts < MAX) — so the deposit is credited
    // on-chain but the user's tradeable balance will never update without
    // intervention. Fire once at the exhaustion boundary.
    const attempts = upd.rows[0]?.exchange_attempts ?? 0;
    if (attempts >= MAX_EXCHANGE_ATTEMPTS) {
      await registerAlert(pool, {
        type: 'deposit_stuck',
        severity: 'warning',
        dedupKey: `deposit_stuck:exchange:${args.txRef}`,
        title: 'Deposit stuck — exchange credit failed',
        body: `On-chain deposit is credited but the exchange-backend notify failed ${attempts}× (max ${MAX_EXCHANGE_ATTEMPTS}). The user's tradeable balance is NOT updated. Last error: ${errSummary.slice(0, 300)}`,
        context: { user: args.partyId, amount: args.amount, coin: args.coin, txRef: args.txRef, attempts, lastStatus: result.status },
      });
    }
  }
}

/**
 * Pre-pass that finds deposits whose on-chain credit landed but whose
 * exchange-API notify hasn't succeeded yet, and retries them.
 *
 * Skip rules:
 *   • exchange_attempts >= MAX_EXCHANGE_ATTEMPTS  — operator intervention only
 *   • exchange_last_attempt_at < RETRY_BACKOFF_MS ago — give it room to breathe
 *
 * Batched (LIMIT) so a backlog doesn't stall the new-holding scan.
 */
async function retryFailedExchangeNotifies(pool: Pool): Promise<void> {
  const pending = await pool.query<{
    user_party_id: string;
    amount: string;
    transfer_update_id: string;
    exchange_attempts: number;
  }>(
    `SELECT user_party_id, amount::text AS amount, transfer_update_id, exchange_attempts
       FROM deposits
      WHERE exchange_credited_at IS NULL
        AND exchange_attempts < $1
        AND (exchange_last_attempt_at IS NULL
             OR exchange_last_attempt_at < NOW() - ($2::text || ' milliseconds')::interval)
        -- Don't credit split-change rows: those are internal bookkeeping
        --   for partial withdrawals, not real user deposits. Exchange-backend
        --   already saw the original deposit; sending /v1/deposit/defi for
        --   the leftover would over-credit the user.
        AND transfer_update_id NOT LIKE 'split-%'
        -- Don't credit rows that have already been consumed by a later
        --   withdrawal. (Belt-and-suspenders; this should never happen in
        --   normal flow because credit precedes any withdraw.)
        AND consumed_at IS NULL
      ORDER BY exchange_attempts ASC, created_at ASC
      LIMIT $3`,
    [MAX_EXCHANGE_ATTEMPTS, String(RETRY_BACKOFF_MS), RETRY_BATCH_LIMIT],
  );

  if (pending.rowCount === 0) return;
  log(`retry: ${pending.rowCount} pending exchange notif${pending.rowCount === 1 ? 'y' : 'ies'}`);

  for (const row of pending.rows) {
    await tryNotifyAndRecord(pool, {
      partyId: row.user_party_id,
      amount: row.amount,
      coin: 'USDT',
      txRef: row.transfer_update_id,
    });
  }
}

/**
 * POST to the exchange-backend's deposit/defi endpoint to credit the user's
 * tradeable balance after an on-chain DepositRecord has been created.
 *
 * Body shape matches the pre-refactor handleDeposit in src/index.ts:
 *   { walletAddress, coin, amount, txnHash, network }
 *
 * `walletAddress` is the user's full Canton party id with `::` replaced by
 * `.` — exchange-backend stores the party id in the user's email field with
 * that same substitution (since `:` is illegal in an email local-part), and
 * looks up the user by that string. Sending just the hint (`split('::')[0]`)
 * gets a 400 "wallet address not linked to any Pi42 account".
 *
 * `txnHash` is the Canton transfer update id so retries are idempotent
 * against the same deposit.
 */
async function notifyExchangeDeposit(args: {
  partyId: string;
  amount: string;
  coin: string;
  txRef: string;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!EXCHANGE_DEPOSIT_URL) {
    return { ok: false, status: 0, body: { error: 'EXCHANGE_DEPOSIT_URL not set' } };
  }
  try {
    const payload =  JSON.stringify({
        walletAddress: args.partyId,
        coin: args.coin,
        amount: Number(args.amount),
        txnHash: args.txRef,
        network: '0',
      });
    const headers: any = { 'Content-Type': 'application/json' }
    headers[EXCHANGE_API_HEADER] = signPayload(payload);

    const res = await fetch(EXCHANGE_DEPOSIT_URL, {
      method: 'POST',
      headers,
      body: payload
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: (err as Error).message } };
  }
}

function installStopSignal(): AbortSignal {
  const ctl = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (!ctl.signal.aborted) ctl.abort();
    });
  }
  return ctl.signal;
}

function sleep(ms: number, abort: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (abort.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    abort.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

main().catch((err) => {
  console.error('[watcher] fatal:', err);
  process.exit(1);
});
