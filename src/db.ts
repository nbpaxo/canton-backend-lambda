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
