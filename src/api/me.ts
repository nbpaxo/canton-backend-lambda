/**
 * GET /me — caller profile (minimal, since the endpoint is open-auth).
 *
 * Returns ONLY the data needed for the UI to render — no PII fields. Anyone
 * can hit this with any x-party-id while AUTH_MODE=open is in effect, so
 * we deliberately omit email / username / displayName / keycloak_sub.
 * Auto-creates a users row on first call so the watcher + KYC service
 * have a place to attach state.
 *
 * Shape:
 *   {
 *     partyId, kyc: { inquiryId, status, decision, updatedAt, completedAt },
 *     instrument: { id, symbol, decimals, admin },
 *     vaultPool: <party-id>
 *   }
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
import { getActiveProvider } from '../kyc/index.js';

const router = Router();

interface KycRow {
  inquiry_id: string;
  provider: string;
  status: string;
  decision: string | null;
  reject_reason: string | null;
  resubmit_allowed: boolean | null;
  updated_at: Date;
  completed_at: Date | null;
}

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const { party, sub } = (req as AuthenticatedRequest).user;
  const pool = getPool();

  // Auto-create on first call. Default is_external based on auth source:
  // a Keycloak sub present → validator user (is_external=false); absent →
  // Loop / external. We DON'T return is_external to the caller (it's a
  // private flag).
  await pool.query(
    `INSERT INTO users (party_id, is_external, keycloak_sub)
       VALUES ($1, $2, $3)
     ON CONFLICT (party_id) DO NOTHING`,
    [party, !sub, sub || null],
  );

  // Whether an email is on file (boolean only — the address itself is PII and
  // stays omitted). Lets the UI show the email-collection step before KYC for
  // providers that require an email up front (Hypersign).
  const hasEmail = (
    await pool.query<{ has_email: boolean }>(
      `SELECT (email IS NOT NULL AND email <> '') AS has_email FROM users WHERE party_id = $1`,
      [party],
    )
  ).rows[0]?.has_email ?? false;

  // Latest KYC inquiry, if any.
  const kycRow = (
    await pool.query<KycRow>(
      `SELECT inquiry_id, provider, status, decision, reject_reason, resubmit_allowed, updated_at, completed_at
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
        provider: kycRow.provider,
        status: kycRow.status,
        decision: kycRow.decision,
        rejectReason: kycRow.reject_reason,
        resubmitAllowed: kycRow.resubmit_allowed ?? false,
        updatedAt: kycRow.updated_at.toISOString(),
        completedAt: kycRow.completed_at?.toISOString() ?? null,
      }
    : {
        inquiryId: null,
        provider: null,
        status: 'not_started',
        decision: null,
        rejectReason: null,
        resubmitAllowed: false,
        updatedAt: null,
        completedAt: null,
      };

  // Whether the ACTIVE KYC provider needs an email up front (Hypersign). The
  // UI shows the email-collection step only when emailRequired && !hasEmail.
  let emailRequired = false;
  try {
    emailRequired = getActiveProvider().requiresEmail === true;
  } catch {
    emailRequired = false;
  }

  res.json({
    partyId: party,
    hasEmail,
    emailRequired,
    kyc,
    instrument: {
      id: INSTRUMENT_ID,
      symbol: INSTRUMENT_SYMBOL,
      decimals: INSTRUMENT_DECIMALS,
      admin: INSTRUMENT_ADMIN_PARTY_ID,
    },
    vaultPool: PARTIES.vaultPool,
  });
});

export default router;
