/**
 * Invite-code helpers — Postgres backed (was DynamoDB on master).
 *
 * Schema: see src/db/schema.sql (table `invite_codes`).
 *   code         text primary key
 *   created_at   timestamptz
 *   redeemed_at  timestamptz   — null until redeemed
 *   redeemed_by  jsonb         — { username, partyId, email, ... }
 *
 * Atomicity for redeem: a single UPDATE with WHERE redeemed_at IS NULL.
 * Returns rowCount=1 on success, 0 if already redeemed or non-existent.
 */

import { getPool } from './db/pool.js';

export interface RedeemedByInfo {
  username: string;
  partyId?: string;
  email?: string;
  fullName?: string;
  phone?: string;
  countryCode?: string;
}

export interface InviteCode {
  code: string;
  redeemed: boolean;
  redeemedAt?: string;
  redeemedBy?: RedeemedByInfo;
  createdAt: string;
}

function rowToInvite(row: {
  code: string;
  created_at: Date;
  redeemed_at: Date | null;
  redeemed_by: RedeemedByInfo | null;
}): InviteCode {
  return {
    code: row.code,
    redeemed: row.redeemed_at !== null,
    redeemedAt: row.redeemed_at ? row.redeemed_at.toISOString() : undefined,
    redeemedBy: row.redeemed_by ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getInviteCode(code: string): Promise<InviteCode | null> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT code, created_at, redeemed_at, redeemed_by FROM invite_codes WHERE code = $1`,
    [code],
  );
  return r.rows[0] ? rowToInvite(r.rows[0]) : null;
}

export async function createInviteCode(code: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO invite_codes (code) VALUES ($1)
       ON CONFLICT (code) DO NOTHING`,
    [code],
  );
}

/**
 * Atomic redeem. Throws if the code doesn't exist or is already redeemed.
 */
export async function redeemInviteCode(
  code: string,
  userInfo: RedeemedByInfo,
): Promise<void> {
  const pool = getPool();
  const r = await pool.query(
    `UPDATE invite_codes
        SET redeemed_at = NOW(), redeemed_by = $2::jsonb
      WHERE code = $1 AND redeemed_at IS NULL`,
    [code, JSON.stringify(userInfo)],
  );
  if (r.rowCount === 0) {
    throw new Error('invite code not found or already redeemed');
  }
}

export async function listInviteCodes(): Promise<InviteCode[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT code, created_at, redeemed_at, redeemed_by
       FROM invite_codes
       ORDER BY created_at DESC`,
  );
  return r.rows.map(rowToInvite);
}

/**
 * Atomically CLAIM an invite code for an in-flight signup.
 *
 * This is the serialisation point for the whole signup saga. Previously the
 * route checked the code at the top and redeemed it at the very end, leaving a
 * multi-second window in which a second request — a double-clicked button, a
 * retried fetch — passed the same check and ran the same external writes. The
 * second one then collided inside Keycloak and returned a failure to a user
 * whose account had, in fact, just been created.
 *
 * Claiming up front collapses that window to a single atomic UPDATE: exactly
 * one caller can transition the row from unredeemed to redeemed, and everyone
 * else is told who won. The claim is released again (see releaseInviteCode) if
 * the signup later fails, so a genuine retry isn't locked out.
 *
 * Note this cannot be replaced by Turnstile's single-use tokens: measured
 * against the live API, Cloudflare's duplicate detection is eventually
 * consistent and accepts the same token more than once in a short window.
 */
export async function claimInviteCode(
  code: string,
  userInfo: RedeemedByInfo,
): Promise<
  | { status: 'claimed' }
  | { status: 'not_found' }
  | { status: 'already_redeemed'; redeemedBy?: RedeemedByInfo }
> {
  const pool = getPool();
  const claimed = await pool.query(
    `UPDATE invite_codes
        SET redeemed_at = NOW(), redeemed_by = $2::jsonb
      WHERE code = $1 AND redeemed_at IS NULL
      RETURNING code`,
    [code, JSON.stringify(userInfo)],
  );
  if ((claimed.rowCount ?? 0) > 0) return { status: 'claimed' };

  const existing = await pool.query<{ redeemed_by: RedeemedByInfo | null }>(
    `SELECT redeemed_by FROM invite_codes WHERE code = $1`,
    [code],
  );
  if (!existing.rows[0]) return { status: 'not_found' };
  return {
    status: 'already_redeemed',
    redeemedBy: existing.rows[0].redeemed_by ?? undefined,
  };
}

/**
 * Hand a claimed invite code back, so the user can retry.
 *
 * Called only on the compensation path: the signup failed after the claim, so
 * the code was never actually spent. Without this a transient Canton error
 * would burn the user's invite permanently.
 */
export async function releaseInviteCode(code: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE invite_codes SET redeemed_at = NULL, redeemed_by = NULL WHERE code = $1`,
    [code],
  );
}

/** Attach the resolved party id to an already-claimed invite. */
export async function finalizeInviteClaim(
  code: string,
  userInfo: RedeemedByInfo,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE invite_codes SET redeemed_by = $2::jsonb WHERE code = $1`,
    [code, JSON.stringify(userInfo)],
  );
}
