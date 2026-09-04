/**
 * Referral code generation and normalisation.
 *
 * Alphabet is Crockford-flavoured: digits + uppercase letters with 0, O, 1,
 * I and L removed. Those are the pairs people confuse when a code is read
 * aloud, screenshotted, or retyped from a phone — and here a mistyped code
 * doesn't error, it silently credits the WRONG referrer, so ambiguity is a
 * correctness problem rather than a UX one.
 */

import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import { REFERRAL_CODE_LENGTH } from '../config.js';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Normalise user input to the stored form: trimmed, uppercased, and with the
 * separators people habitually add ("ABC-1234", "abc 1234") stripped.
 *
 * Deliberately NOT a validity check — it only reshapes. An unknown code still
 * has to fail the database lookup, which is the single source of truth.
 */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Cheap shape check before we bother the database.
 *
 * Deliberately WIDER than the generation alphabet. `ALPHABET` exists to keep
 * codes we mint unambiguous; it must not constrain what we can look UP, or a
 * vanity code containing I/L/O/0/1 would be insertable (the table's CHECK
 * allows any uppercase string) yet permanently unresolvable — findable in the
 * database but rejected here before the query ever ran.
 *
 * So: strict on generation, lenient on lookup. This only filters out input
 * that could not be any code at all; the database decides what's real.
 */
export function isWellFormedCode(code: string): boolean {
  return /^[A-Z0-9]{4,32}$/.test(code);
}

/**
 * One random code. `randomInt` is the CSPRNG — Math.random() would make codes
 * predictable from one another, which matters because knowing a code is
 * enough to attribute yourself to that referrer.
 */
export function generateCode(length = REFERRAL_CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * The caller's primary code, generating one on first use.
 *
 * Lazy rather than minted at signup so we don't create codes for accounts that
 * never open the referral page, and so Loop users (who have no signup step)
 * are handled by exactly the same path.
 *
 * Concurrency: two parallel calls for the same user race to INSERT. The
 * partial unique index on (owner_party_id) WHERE status = 'active' means one
 * wins and the other's ON CONFLICT DO NOTHING returns no row — we then
 * re-SELECT and return the winner's code. A random-code collision with a
 * DIFFERENT user is handled by the retry loop.
 *
 * Runs on a caller-supplied client so it can join a surrounding transaction
 * (the signup saga does exactly that).
 */
export async function getOrCreateCode(
  client: PoolClient,
  partyId: string,
): Promise<string> {
  const existing = await client.query<{ code: string }>(
    `SELECT code FROM referral_codes
      WHERE owner_party_id = $1 AND status = 'active'
      LIMIT 1`,
    [partyId],
  );
  if (existing.rows[0]) return existing.rows[0].code;

  // 5 attempts is generous: at 7 chars the collision probability is
  // negligible until the table is enormous, and each retry is one INSERT.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCode();
    const inserted = await client.query<{ code: string }>(
      `INSERT INTO referral_codes (code, owner_party_id, kind)
            VALUES ($1, $2, 'auto')
       ON CONFLICT DO NOTHING
         RETURNING code`,
      [candidate, partyId],
    );
    if (inserted.rows[0]) return inserted.rows[0].code;

    // No row: either the code collided with another user's, or a concurrent
    // call for THIS user already created theirs. Check the latter before
    // burning another attempt.
    const raced = await client.query<{ code: string }>(
      `SELECT code FROM referral_codes
        WHERE owner_party_id = $1 AND status = 'active'
        LIMIT 1`,
      [partyId],
    );
    if (raced.rows[0]) return raced.rows[0].code;
  }

  throw new Error(`Could not allocate a referral code for ${partyId}`);
}
