/**
 * Beta-tester KYC bypass.
 *
 * Inserts an `approved` row into kyc_inquiries for each party id in a CSV so
 * those users skip KYC (the /me + /kyc/start endpoints read the latest row and
 * treat decision='approved' as cleared). Every row is tagged so the whole batch
 * can be removed later — at which point those users fall back to "KYC required"
 * and can verify for real.
 *
 * Tagging:
 *   - inquiry_id = `BETA_USERS:<partyId>`  (inquiry_id is the PK, so it can't be
 *     literally identical across rows — the `BETA_USERS:` prefix is the group
 *     marker). Delete with: inquiry_id LIKE 'BETA_USERS:%'.
 *   - provider   = 'beta'  (second marker, in case you query by provider).
 *
 * CSV format: first column is the party id (header row is skipped). The
 * provided "beta testers" sheet has columns `recipient party id,amount` — only
 * the party id is used.
 *
 * Usage:
 *   # apply the bypass (default CSV: scripts/beta-testers.csv)
 *   npx tsx --env-file=.env scripts/beta-bypass-kyc.ts
 *   npx tsx --env-file=.env scripts/beta-bypass-kyc.ts path/to/list.csv
 *
 *   # remove the bypass for the WHOLE batch (re-enable KYC for everyone tagged)
 *   npx tsx --env-file=.env scripts/beta-bypass-kyc.ts --delete
 *
 *   # dry run — show what would change, write nothing
 *   npx tsx --env-file=.env scripts/beta-bypass-kyc.ts --dry-run
 *
 * Run against prod via the SSM tunnel (DATABASE_URL → localhost:15432) or on
 * the EC2 box. Idempotent: re-applying upserts; deleting is by the prefix.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getPool, closePool } from '../src/db/pool.js';

/** Group marker — both the inquiry_id prefix and the deletion key. */
const BETA_MARKER = 'BETA_USERS';
const DEFAULT_CSV = path.join(import.meta.dirname, 'beta-testers.csv');

const args = process.argv.slice(2);
const doDelete = args.includes('--delete');
const dryRun = args.includes('--dry-run');
const csvPath = args.find((a) => !a.startsWith('--')) || DEFAULT_CSV;

/** Parse the party ids out of the CSV (first column, header skipped). */
function readPartyIds(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  // Drop the header row if the first cell isn't a party id (no `::`).
  const start = lines[0].split(',')[0].includes('::') ? 0 : 1;
  const ids = lines
    .slice(start)
    .map((l) => l.split(',')[0].trim())
    .filter((id) => id.includes('::'));
  // De-dup while preserving order.
  return [...new Set(ids)];
}

async function applyBypass(): Promise<void> {
  const partyIds = readPartyIds(csvPath);
  if (partyIds.length === 0) {
    console.error(`No party ids found in ${csvPath}`);
    process.exit(1);
  }
  console.log(
    `${dryRun ? '[dry-run] ' : ''}Bypassing KYC (status=approved) for ${partyIds.length} party id(s) from ${csvPath}\n`,
  );
  if (dryRun) {
    partyIds.forEach((p, i) => console.log(`  ${i + 1}. ${p}  ->  ${BETA_MARKER}:${p}`));
    return;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const party of partyIds) {
      const inquiryId = `${BETA_MARKER}:${party}`;
      // FK: kyc_inquiries.user_party_id -> users.party_id. Ensure the row exists
      // (matches /me + /kyc/start auto-create: is_external=true, kept on conflict).
      await client.query(
        `INSERT INTO users (party_id, is_external) VALUES ($1, true)
         ON CONFLICT (party_id) DO NOTHING`,
        [party],
      );
      await client.query(
        `INSERT INTO kyc_inquiries
           (inquiry_id, user_party_id, provider, template_id, reference_id,
            status, decision, completed_at, updated_at)
         VALUES ($1, $2, 'beta', $3, $2, 'approved', 'approved', NOW(), NOW())
         ON CONFLICT (inquiry_id) DO UPDATE
           SET status       = 'approved',
               decision     = 'approved',
               completed_at = COALESCE(kyc_inquiries.completed_at, NOW()),
               updated_at   = NOW()`,
        [inquiryId, party, BETA_MARKER],
      );
      await client.query(
        `INSERT INTO audit_log (user_party_id, action, details)
           VALUES ($1, 'kyc.event', $2::jsonb)`,
        [
          party,
          JSON.stringify({
            inquiryId,
            eventName: 'beta.bypass',
            status: 'approved',
            decision: 'approved',
            beta: true,
          }),
        ],
      );
      console.log(`  ✓ ${party}`);
    }
    await client.query('COMMIT');
    console.log(`\nDone. ${partyIds.length} beta tester(s) marked KYC-approved.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteBypass(): Promise<void> {
  const pool = getPool();
  if (dryRun) {
    const { rows } = await pool.query<{ user_party_id: string; inquiry_id: string }>(
      `SELECT user_party_id, inquiry_id FROM kyc_inquiries
        WHERE inquiry_id LIKE $1 ORDER BY user_party_id`,
      [`${BETA_MARKER}:%`],
    );
    console.log(`[dry-run] Would delete ${rows.length} beta bypass row(s):`);
    rows.forEach((r) => console.log(`  - ${r.user_party_id}`));
    return;
  }
  const res = await pool.query(
    `DELETE FROM kyc_inquiries WHERE inquiry_id LIKE $1`,
    [`${BETA_MARKER}:%`],
  );
  console.log(
    `Removed ${res.rowCount} beta bypass row(s). Those users now require KYC again.\n` +
      `(audit_log history is left intact.)`,
  );
}

async function main(): Promise<void> {
  if (doDelete) {
    await deleteBypass();
  } else {
    await applyBypass();
  }
  await closePool();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
