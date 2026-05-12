/**
 * Deposit watcher (stub — real logic lands once the new Daml contract and
 * its template IDs are confirmed).
 *
 *   npm run start:watcher
 *
 * Intended behavior (see TODO):
 *   1. Read last_offset from watcher_checkpoint.
 *   2. Subscribe to Canton's update stream (JSON Ledger API) for transfers
 *      with the vault pool as receiver.
 *   3. For each new incoming transfer:
 *        a. Resolve sender's partyId → users.party_id.
 *        b. Check KYC status. If approved:
 *             - Submit on-chain CreateDepositReceipt as operator
 *             - Insert into `deposits` table with the receipt's contract id
 *           Else:
 *             - Insert into `held_deposits` with reason='kyc_not_done'
 *             - Log a flag for the ops dashboard to review
 *   4. Persist the offset to watcher_checkpoint.
 *
 * The watcher is a long-running process, sibling to the API server. Both
 * share the same Postgres pool and configuration.
 */
import { getPool, closePool } from '../db/pool.js';

async function main(): Promise<void> {
  const pool = getPool();
  console.log('[watcher] starting deposit watcher (stub mode)');

  // Sanity check DB connectivity.
  const r = await pool.query<{ last_offset: string }>(
    `SELECT last_offset FROM watcher_checkpoint WHERE id = 1`,
  );
  const offset = r.rows[0]?.last_offset ?? '';
  console.log(`[watcher] resuming from offset: "${offset || '(none)'}"`);

  // TODO: subscribe to Canton update stream, gate on KYC, insert deposits.
  console.log('[watcher] stub: nothing to do yet. Implementation pending Daml contract details.');

  // Idle loop so the process stays up (helps catch wiring issues during dev).
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });

  await closePool();
}

main().catch((err) => {
  console.error('[watcher] fatal:', err);
  process.exit(1);
});
