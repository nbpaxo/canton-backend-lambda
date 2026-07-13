/**
 * Alert core self-test. Registers one alert of each severity, runs the
 * processor once (delivers to TELEGRAM_ALERTS_CHAT_ID), then registers +
 * resolves a condition to exercise the recovery notice.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/alert-selftest.ts
 *
 * Requires: DATABASE_URL (schema applied) and TELEGRAM_ALERTS_CHAT_ID.
 * Uses a per-run suffix on dedup keys so repeat runs aren't suppressed by
 * the cooldown. Writes rows to the `alerts` table on your target DB.
 */
import { closePool, getPool } from '../src/db/pool.js';
import { registerAlert, resolveAlert, runAlertProcessor } from '../src/alerts/index.js';

async function main(): Promise<void> {
  const pool = getPool();
  const run = String(Date.now()).slice(-6); // unique-ish per run

  if (!process.env.TELEGRAM_ALERTS_BOT_TOKEN || !process.env.TELEGRAM_ALERTS_CHAT_ID) {
    console.log('⚠ TELEGRAM_ALERTS_BOT_TOKEN / TELEGRAM_ALERTS_CHAT_ID not set — alerts will queue but delivery will be marked failed.');
    console.log('  Set them in .env to actually post to the Telegram alerts group.\n');
  }

  console.log('1) Registering sample alerts (critical, warning, info)…');
  console.log('  ', await registerAlert(pool, {
    type: 'validator_stalled',
    severity: 'critical',
    dedupKey: `selftest:critical:${run}`,
    title: 'Self-test — CRITICAL',
    body: 'This is a sample critical alert from scripts/alert-selftest.ts.',
    context: { run, example: 'validator offline', offset: 1150442 },
  }));
  console.log('  ', await registerAlert(pool, {
    type: 'low_traffic_credit',
    severity: 'warning',
    dedupKey: `selftest:warning:${run}`,
    title: 'Self-test — WARNING',
    body: 'This is a sample warning alert.',
    context: { run, availableTraffic: 1397, floor: 100000 },
  }));
  console.log('  ', await registerAlert(pool, {
    type: 'deposit_stuck',
    severity: 'info',
    dedupKey: `selftest:info:${run}`,
    title: 'Self-test — INFO',
    body: 'This is a sample info alert.',
    context: { run },
  }));

  console.log('\n2) Registering + resolving a condition (recovery notice)…');
  await registerAlert(pool, {
    type: 'reserve_shortfall',
    severity: 'critical',
    dedupKey: `selftest:condition:${run}`,
    title: 'Self-test — condition OPEN',
    body: 'A sample condition that we will immediately resolve.',
    context: { run },
  });
  const recovered = await resolveAlert(pool, {
    type: 'reserve_shortfall',
    dedupKey: `selftest:condition:${run}`,
    title: 'Self-test — condition RECOVERED',
    body: 'The sample condition has cleared.',
    context: { run },
  });
  console.log('   resolveAlert() enqueued recovery:', recovered);

  console.log('\n3) Running the processor (delivering to webhook)…');
  const result = await runAlertProcessor(pool);
  console.log('   processor result:', result);

  console.log('\n4) Rows written this run:');
  const rows = await pool.query(
    `SELECT id, severity, status, attempts,
            left(coalesce(last_error,''), 80) AS last_error, title
       FROM alerts
      WHERE dedup_key LIKE $1
      ORDER BY id`,
    [`selftest:%${run}`],
  );
  for (const r of rows.rows) {
    console.log(`   #${r.id} [${r.severity}] status=${r.status} attempts=${r.attempts} ${r.last_error ? '· ' + r.last_error : ''} · ${r.title}`);
  }

  await closePool();
  console.log('\nDone. Check the #ops-alerts channel / your webhook endpoint for 5 messages (3 samples + condition open + recovered).');
}

main().catch((err) => {
  console.error('self-test failed:', err);
  process.exit(1);
});
