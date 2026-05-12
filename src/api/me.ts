/**
 * GET /me — caller's profile + latest KYC status.
 *
 * Auto-creates a row in `users` on first call so the rest of the system
 * (watcher, KYC service) has somewhere to attach state. Defaults assume the
 * caller is a Loop user (is_external=true); validator-signup users already
 * have a row inserted by /signup with is_external=false.
 *
 * In open auth mode the caller identifies themselves via `x-party-id`;
 * in keycloak mode the party comes from the JWT subject lookup. Either
 * way it's `req.user.party` by the time we get here.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getPool } from '../db/pool.js';
import {
  INSTRUMENT_ADMIN_PARTY_ID,
  INSTRUMENT_DECIMALS,
  INSTRUMENT_ID,
  INSTRUMENT_SYMBOL,
  PARTIES,
} from '../config.js';

const router = Router();

interface UserRow {
  party_id: string;
  is_external: boolean;
  keycloak_sub: string | null;
  username: string | null;
  display_name: string | null;
  email: string | null;
  status: string;
  created_at: Date;
}

interface KycRow {
  inquiry_id: string;
  status: string;
  decision: string | null;
  updated_at: Date;
  completed_at: Date | null;
}

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const { party, sub } = (req as AuthenticatedRequest).user;
  const pool = getPool();

  // Try fetch first; if missing, upsert with defaults appropriate for the
  // auth source we got the request from.
  let userRow = (
    await pool.query<UserRow>(
      `SELECT party_id, is_external, keycloak_sub, username, display_name, email, status, created_at
         FROM users WHERE party_id = $1`,
      [party],
    )
  ).rows[0];

  if (!userRow) {
    // Auto-create. If we have a Keycloak sub from the JWT, assume validator
    // user (is_external=false). Otherwise assume Loop / external.
    const isExternal = !sub;
    userRow = (
      await pool.query<UserRow>(
        `INSERT INTO users (party_id, is_external, keycloak_sub)
           VALUES ($1, $2, $3)
         RETURNING party_id, is_external, keycloak_sub, username, display_name, email, status, created_at`,
        [party, isExternal, sub || null],
      )
    ).rows[0]!;
  }

  // Latest KYC inquiry, if any.
  const kycRow = (
    await pool.query<KycRow>(
      `SELECT inquiry_id, status, decision, updated_at, completed_at
         FROM kyc_inquiries
        WHERE user_party_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [party],
    )
  ).rows[0];

  const kyc = kycRow
    ? {
        inquiryId: kycRow.inquiry_id,
        status: kycRow.status,
        decision: kycRow.decision,
        updatedAt: kycRow.updated_at.toISOString(),
        completedAt: kycRow.completed_at?.toISOString() ?? null,
      }
    : {
        inquiryId: null,
        status: 'not_started',
        decision: null,
        updatedAt: null,
        completedAt: null,
      };

  res.json({
    partyId: userRow.party_id,
    isExternal: userRow.is_external,
    keycloakSub: userRow.keycloak_sub,
    username: userRow.username,
    displayName: userRow.display_name,
    email: userRow.email,
    status: userRow.status,
    createdAt: userRow.created_at.toISOString(),
    kyc,
    // Instrument config — frontend reads these and renders accordingly. On
    // testnet we'll swap to {id: 'USDCx', symbol: 'USDCx', decimals: 6,
    // admin: <Circle's party>} via env; no frontend code changes needed.
    instrument: {
      id: INSTRUMENT_ID,
      symbol: INSTRUMENT_SYMBOL,
      decimals: INSTRUMENT_DECIMALS,
      admin: INSTRUMENT_ADMIN_PARTY_ID,
    },
    // Deposit destination — users send to this party; the watcher detects
    // and credits the deposit on chain.
    vaultPool: PARTIES.vaultPool,
  });
});

export default router;
