/**
 * KYC endpoints.
 *
 *   POST /kyc/start
 *     If the caller has no inquiry, or their latest inquiry is in a
 *     resumable state (created | pending | completed | needs_review |
 *     expired) → returns a one-time hosted-flow URL the user opens to
 *     finish or restart their inquiry.
 *
 *     If the latest inquiry is `approved` → 409 (already done; nothing
 *     to start).
 *
 *     If the latest inquiry is `declined` → creates a fresh inquiry
 *     (retry allowed) and returns a one-time URL.
 *
 *   POST /kyc/webhook
 *     Persona event sink. Verifies the HMAC signature on the raw body,
 *     reads `reference-id` (which we set to the caller's party_id) and
 *     upserts kyc_inquiries with the new status/decision. `inquiry.expired`
 *     bumps status='expired' so the next /kyc/start hits the resume path.
 */
import { Router, Request, Response, raw } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getPool } from '../db/pool.js';
import {
  KYC_RESUMABLE_STATUSES,
  KYC_TERMINAL_STATUSES,
  buildInquiryUrl,
  createInquiry,
  createInquirySession,
  normalizeEventStatus,
  verifyWebhookSignature,
} from '../kyc/persona.js';

const router = Router();

interface KycInquiryRow {
  inquiry_id: string;
  status: string;
  decision: string | null;
}

// ─── POST /kyc/start ─────────────────────────────────────────────────────
router.post('/kyc/start', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();

  try {
    // Make sure the users row exists (matches /me's auto-create policy).
    await pool.query(
      `INSERT INTO users (party_id, is_external) VALUES ($1, true)
       ON CONFLICT (party_id) DO NOTHING`,
      [party],
    );

    const latest = (
      await pool.query<KycInquiryRow>(
        `SELECT inquiry_id, status, decision FROM kyc_inquiries
          WHERE user_party_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [party],
      )
    ).rows[0];

    // Already approved — nothing to do.
    if (latest && (KYC_TERMINAL_STATUSES.has(latest.status) || latest.decision === 'approved')) {
      return res.status(409).json({
        error: 'already_approved',
        inquiryId: latest.inquiry_id,
        status: latest.status,
        decision: latest.decision,
      });
    }

    // Resume the existing inquiry if it's in a resumable state — fresh
    // session token, same inquiry id. Persona keeps the user's progress.
    let inquiryId: string;
    let isNew = false;
    if (latest && KYC_RESUMABLE_STATUSES.has(latest.status)) {
      inquiryId = latest.inquiry_id;
    } else {
      // No inquiry, or last one declined — create a new one. reference-id
      // is the user's party id (Persona echoes it back on every webhook
      // event so we route on inquiry_id + reference_id).
      const inquiry = await createInquiry({ referenceId: party });
      inquiryId = inquiry.id;
      isNew = true;

      await pool.query(
        `INSERT INTO kyc_inquiries (inquiry_id, user_party_id, reference_id, status)
           VALUES ($1, $2, $3, 'created')
         ON CONFLICT (inquiry_id) DO NOTHING`,
        [inquiryId, party, party],
      );
    }

    // Mint a one-time session URL for the chosen inquiry.
    const { sessionToken } = await createInquirySession(inquiryId);
    const sessionUrl = buildInquiryUrl(inquiryId, sessionToken);

    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'kyc.session', $2::jsonb)`,
      [party, JSON.stringify({ inquiryId, isNew })],
    );

    return res.json({
      inquiryId,
      sessionUrl,
      status: isNew ? 'created' : latest?.status ?? 'created',
      resumed: !isNew,
    });
  } catch (err) {
    console.error('[kyc/start] error:', err);
    return res.status(502).json({ error: 'Failed to start KYC', details: String(err) });
  }
});

// ─── POST /kyc/webhook ───────────────────────────────────────────────────
// Reads the raw body so HMAC is computed over the exact bytes Persona sent.
router.post(
  '/kyc/webhook',
  raw({ type: '*/*' }),
  async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;
    const bodyText = rawBody.toString('utf8');
    const sigHeader = req.headers['persona-signature'] as string | undefined;

    if (!verifyWebhookSignature(bodyText, sigHeader)) {
      console.warn('[kyc/webhook] signature verification failed');
      return res.status(401).json({ error: 'invalid signature' });
    }

    let evt: {
      data?: {
        attributes?: {
          name?: string;
          payload?: {
            data?: {
              id?: string;
              attributes?: {
                'reference-id'?: string;
                status?: string;
                'completed-at'?: string | null;
              };
            };
          };
        };
      };
    };
    try {
      evt = JSON.parse(bodyText);
    } catch {
      return res.status(400).json({ error: 'invalid json' });
    }

    const eventName = evt.data?.attributes?.name ?? '';
    const inq = evt.data?.attributes?.payload?.data;
    const inquiryId = inq?.id;
    const referenceId = inq?.attributes?.['reference-id'];
    const completedAt = inq?.attributes?.['completed-at'] ?? null;

    if (!inquiryId || !referenceId) {
      console.warn('[kyc/webhook] missing inquiry id or reference id', evt);
      return res.status(202).json({ ok: true, ignored: 'missing inquiry id/ref' });
    }

    // reference-id IS the user's party id (set by us at /kyc/start).
    const userPartyId = referenceId;
    const { status, decision } = normalizeEventStatus(eventName);

    const pool = getPool();
    // Make sure the users row exists — webhooks can arrive before /me has
    // ever been called (e.g. user started KYC, switched device, then we
    // get the completion event).
    await pool.query(
      `INSERT INTO users (party_id, is_external) VALUES ($1, true)
       ON CONFLICT (party_id) DO NOTHING`,
      [userPartyId],
    );

    await pool.query(
      `INSERT INTO kyc_inquiries
         (inquiry_id, user_party_id, reference_id, status, decision,
          completed_at, raw_last_event, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
       ON CONFLICT (inquiry_id) DO UPDATE
         SET status         = EXCLUDED.status,
             decision       = COALESCE(EXCLUDED.decision, kyc_inquiries.decision),
             completed_at   = COALESCE(EXCLUDED.completed_at, kyc_inquiries.completed_at),
             raw_last_event = EXCLUDED.raw_last_event,
             updated_at     = NOW()`,
      [inquiryId, userPartyId, referenceId, status, decision, completedAt, bodyText],
    );

    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'kyc.event', $2::jsonb)`,
      [userPartyId, JSON.stringify({ inquiryId, eventName, status, decision })],
    );

    return res.json({ ok: true });
  },
);

export default router;
