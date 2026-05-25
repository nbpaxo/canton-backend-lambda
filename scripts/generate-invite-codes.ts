/**
 * Generate single-use invite codes and store them in Postgres.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/generate-invite-codes.ts          # 50 codes
 *   npx tsx --env-file=.env scripts/generate-invite-codes.ts 100      # custom count
 */

import crypto from 'node:crypto';
import { createInviteCode } from '../src/db.js';
import { closePool } from '../src/db/pool.js';

const COUNT = parseInt(process.argv[2] || '50', 10);

/** Readable invite code: MPERP-XXXXX-XXXXX (no 0/O/1/I to avoid confusion) */
function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () =>
    Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `MPERPS-${part()}-${part()}`;
}

async function main(): Promise<void> {
  console.log(`Generating ${COUNT} invite codes...\n`);

  const codes: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    const code = generateCode();
    try {
      await createInviteCode(code);
      codes.push(code);
      process.stdout.write(`  ${i + 1}. ${code}\n`);
    } catch (err) {
      // Collision (vanishingly unlikely) — retry.
      i--;
    }
  }

  console.log(`\nDone. ${codes.length} invite codes created.\n`);
  console.log('--- CSV ---');
  console.log('code');
  codes.forEach((c) => console.log(c));

  await closePool();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
