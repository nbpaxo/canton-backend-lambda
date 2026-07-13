/**
 * Drain pending alerts to Telegram once. Useful for testing alert sources
 * (e.g. a withdraw failure that queued an alert) before the health monitor
 * exists, and as an ops tool to flush the queue on demand.
 *
 *   npx tsx --env-file=.env scripts/alert-drain.ts
 */
import { closePool, getPool } from '../src/db/pool.js';
import { runAlertProcessor } from '../src/alerts/index.js';

async function main(): Promise<void> {
  const pool = getPool();
  const res = await runAlertProcessor(pool);
  console.log('processor result:', res);
  await closePool();
}

main().catch((err) => {
  console.error('drain failed:', err);
  process.exit(1);
});
