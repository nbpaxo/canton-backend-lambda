/**
 * KYC endpoints.
 *
 *   POST /kyc/start    — create a new Persona inquiry for the caller and
 *                        return the inquiry id; the frontend opens the
 *                        embedded Persona flow with it.
 *
 *   POST /kyc/webhook  — Persona pushes inquiry lifecycle events here.
 *                        Verifies the HMAC signature, upserts into
 *                        kyc_inquiries with the new status/decision.
 */
import { Router, Request, Response, raw } from 'express';
import crypto from 'node:crypto';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getPool } from '../db/pool.js';
import {
  createInquiry,
  normalizeEventStatus,
  verifyWebhookSignature,
} from '../kyc/persona.js';

const router = Router();

// ─── POST /kyc/start ─────────────────────────────────────────────────────
router.post('/kyc/start', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();

  try {
    // Make sure a users row exists (auto-create same as /me).
    await pool.query(
      `INSERT INTO users (party_id, is_external) VALUES ($1, true)
       ON CONFLICT (party_id) DO NOTHING`,
      [party],
    );

    // Our `referenceId` lets us map the webhook back to this user even if
    // they restart the flow. Random suffix avoids collisions.
    const referenceId = `${party}|${crypto.randomBytes(8).toString('hex')}`;

    const inquiry = await createInquiry({ referenceId });

    await pool.query(
      `INSERT INTO kyc_inquiries (inquiry_id, user_party_id, reference_id, status)
         VALUES ($1, $2, $3, 'created')
       ON CONFLICT (inquiry_id) DO NOTHING`,
      [inquiry.id, party, referenceId],
    );

    res.json({
      inquiryId: inquiry.id,
      referenceId,
      status: inquiry.attributes.status,
    });
  } catch (err) {
    console.error('[kyc/start] error:', err);
    res.status(502).json({ error: 'Failed to start KYC', details: String(err) });
  }
});

// ─── POST /kyc/webhook ───────────────────────────────────────────────────
// IMPORTANT: this route uses `raw` body parsing so the HMAC signature is
// computed over the exact bytes Persona sent. Don't let express.json()
// touch it — it's mounted at the top-level with the raw middleware below.
router.post(
  '/kyc/webhook',
  raw({ type: '*/*' }),
  async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;
    const bodyText = rawBody.toString('utf8');
    const sigHeader = req.headers['persona-signature'] as string | undefined;

    if (!verifyWebhookSignature(bodyText, sigHeader)) {
      console.warn('[kyc/webhook] signature verification failed');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    let evt: {
      data?: {
        attributes?: {
          name?: string;
          payload?: {
            data?: {
              id?: string;
              attributes?: { 'reference-id'?: string; status?: string; 'completed-at'?: string | null };
            };
          };
        };
      };
    };
    try {
      evt = JSON.parse(bodyText);
    } catch {
      res.status(400).json({ error: 'invalid json' });
      return;
    }

    const eventName = evt.data?.attributes?.name ?? '';
    const inq = evt.data?.attributes?.payload?.data;
    const inquiryId = inq?.id;
    const refId = inq?.attributes?.['reference-id'];
    const completedAt = inq?.attributes?.['completed-at'] ?? null;

    if (!inquiryId || !refId) {
      console.warn('[kyc/webhook] missing inquiry id or reference id', evt);
      res.status(202).json({ ok: true, ignored: 'missing inquiry id/ref' });
      return;
    }

    const userPartyId = refId.split('|')[0]; // we encoded `${party}|${nonce}`
    const { status, decision } = normalizeEventStatus(eventName);

    const pool = getPool();
    await pool.query(
      `INSERT INTO kyc_inquiries
         (inquiry_id, user_party_id, reference_id, status, decision,
          completed_at, raw_last_event, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
       ON CONFLICT (inquiry_id) DO UPDATE
         SET status = EXCLUDED.status,
             decision = COALESCE(EXCLUDED.decision, kyc_inquiries.decision),
             completed_at = COALESCE(EXCLUDED.completed_at, kyc_inquiries.completed_at),
             raw_last_event = EXCLUDED.raw_last_event,
             updated_at = NOW()`,
      [
        inquiryId,
        userPartyId,
        refId,
        status,
        decision,
        completedAt,
        bodyText,
      ],
    );

    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'kyc.event', $2::jsonb)`,
      [userPartyId, JSON.stringify({ inquiryId, eventName, status, decision })],
    );

    res.json({ ok: true });
  },
);

export default router;
