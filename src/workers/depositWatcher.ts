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
} from '../config.js';
import type { CantonSdkConfig } from '../canton-sdk/config.js';
import {
  IFACE_HOLDING,
  TPL_DEPOSIT_RECORD,
} from '../canton-sdk/config.js';
import {
  collectExerciseEvents,
  getActiveContracts,
  getEventsByContractId,
  getTransactionTreeByOffset,
  submitCommand,
  extractCreatedContractId,
} from '../canton-sdk/ledger.js';
import { getOperatorToken } from '../canton-sdk/tokens.js';
import { resolveOperatorCantonId } from '../canton-sdk/operator.js';

const INTERVAL_MS = Number(process.env.WATCHER_INTERVAL_MS ?? 5_000);

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

async function main(): Promise<void> {
  const pool = getPool();
  await sanityCheckDb(pool);

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
    await sleep(INTERVAL_MS, stopSignal);
  }

  log('stopping');
  await closePool();
}

async function sanityCheckDb(pool: Pool): Promise<void> {
  const r = await pool.query<{ last_offset: string }>(
    `SELECT last_offset FROM watcher_checkpoint WHERE id = 1`,
  );
  const off = r.rows[0]?.last_offset ?? '';
  log(`db checkpoint: "${off || '(none)'}"`);
}

/**
 * One polling iteration.
 *  1. List CIP-56 Holdings owned by vaultPool.
 *  2. Filter to Amulet/CC + unlocked + not-yet-seen.
 *  3. For each, resolve the originating transfer's update_id + sender
 *     party from the on-chain tx tree.
 *  4. Branch on KYC status; create DepositRecord or write to held_deposits.
 */
async function tick(pool: Pool): Promise<void> {
  const opToken = await getOperatorToken(sdkConfig);
  const opUserId = await resolveOperatorCantonId(sdkConfig);

  const contracts = await getActiveContracts(
    sdkConfig,
    opToken,
    PARTIES.vaultPool,
    { interfaceId: IFACE_HOLDING },
  );

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

    // Dedup: skip if we've already processed this Holding's source transfer.
    const alreadyRecorded = await pool.query<{ id: number }>(
      `SELECT id FROM deposits WHERE transfer_update_id = $1
       UNION ALL
       SELECT id FROM held_deposits WHERE transfer_update_id = $1`,
      [c.contractId], // tentative key; replaced with real update_id below if lookup succeeds
    );
    if (alreadyRecorded.rowCount && alreadyRecorded.rowCount > 0) {
      seenHoldingCids.add(c.contractId);
      continue;
    }

    // Resolve sender + transfer update_id from chain.
    let sender: string | null = null;
    let transferUpdateId: string | null = null;
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
      // also try to grab updateId from tree if not on the create event
      transferUpdateId ??= (tree as { updateId?: string }).updateId
        ?? ((tree.transactionTree as { updateId?: string } | undefined)?.updateId ?? null);

      for (const ex of collectExerciseEvents(tree)) {
        // CIP-56 TransferFactory_Transfer carries the sender at choiceArgument.transfer.sender.
        const ca = ex.choiceArgument as { transfer?: { sender?: string } } | undefined;
        if (ca?.transfer?.sender) { sender = ca.transfer.sender; break; }
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

    if (!sender) {
      await pool.query(
        `INSERT INTO held_deposits (user_party_id, amount, transfer_update_id, reason)
           VALUES (NULL, $1, $2, 'unknown_sender')
         ON CONFLICT (transfer_update_id) DO NOTHING`,
        [amount, dedupKey],
      );
      if (!unmatchedLogged.has(c.contractId)) {
        log(`held: unknown sender for ${c.contractId.slice(0, 14)}… (${amount} ${INSTRUMENT_ID})`);
        unmatchedLogged.add(c.contractId);
      }
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
        `INSERT INTO held_deposits (user_party_id, amount, transfer_update_id, reason, raw_meta)
           VALUES (NULL, $1, $2, 'unknown_user', $3::jsonb)
         ON CONFLICT (transfer_update_id) DO NOTHING`,
        [amount, dedupKey, JSON.stringify({ sender, holdingCid: c.contractId })],
      );
      log(`held: unknown user ${sender.split('::')[0]}… for ${amount} ${INSTRUMENT_ID}`);
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
        `INSERT INTO held_deposits (user_party_id, amount, transfer_update_id, reason, raw_meta)
           VALUES ($1, $2, $3, 'kyc_not_done', $4::jsonb)
         ON CONFLICT (transfer_update_id) DO NOTHING`,
        [sender, amount, dedupKey, JSON.stringify({ kycDecision: kycRow?.decision ?? 'not_started', holdingCid: c.contractId })],
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

      await pool.query(
        `INSERT INTO deposits (user_party_id, amount, transfer_update_id, deposit_receipt_cid)
           VALUES ($1, $2, $3, $4)
         ON CONFLICT (transfer_update_id) DO NOTHING`,
        [sender, amount, dedupKey, depositRecordCid],
      );
      await pool.query(
        `INSERT INTO audit_log (user_party_id, action, details)
           VALUES ($1, 'deposit.credited', $2::jsonb)`,
        [sender, JSON.stringify({ amount, transferUpdateId: dedupKey, depositRecordCid, holdingCid: c.contractId })],
      );
      log(`✓ deposited ${amount} ${INSTRUMENT_ID} for ${sender.split('::')[0]}… (cid ${depositRecordCid?.slice(0, 14)}…)`);
    } catch (err) {
      log(`DepositRecord create failed for ${sender.split('::')[0]}…: ${(err as Error).message}`);
      // don't mark seen — retry on next tick.
      continue;
    }

    seenHoldingCids.add(c.contractId);
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
