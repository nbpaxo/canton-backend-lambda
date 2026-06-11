/**
 * KYC endpoints — provider-agnostic (Persona / Sumsub, selected by KYC_PROVIDER).
 *
 *   POST /kyc/start
 *     Uses the ACTIVE provider. If the caller's latest record is resumable
 *     (created | pending | completed | needs_review | expired | failed) the
 *     provider re-issues a session for the same record; if approved → 409;
 *     otherwise a fresh verification is created. Returns a hosted/SDK URL.
 *
 *   POST /kyc/webhook/persona   — Persona event sink (HMAC over raw body)
 *   POST /kyc/webhook/sumsub    — Sumsub event sink (x-payload-digest)
 *   POST /kyc/webhook           — back-compat alias → persona
 *     Each verifies its own signature, normalizes the event, and upserts
 *     kyc_inquiries (tagged with `provider`). The /me endpoint reads the
 *     normalized status/decision and never branches on provider.
 */
import { Router, Request, Response, raw } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getPool } from '../db/pool.js';
import {
  KYC_RESUMABLE_STATUSES,
  KYC_TERMINAL_STATUSES,
  type KycProvider,
} from '../kyc/types.js';
import { getActiveProvider } from '../kyc/index.js';
import { personaProvider } from '../kyc/persona.js';
import { sumsubProvider } from '../kyc/sumsub.js';
import { PARTICIPANT_SUFFIX } from '../config.js';
import { getKcUserEmailBySub } from '../keycloak.js';

const router = Router();

interface KycInquiryRow {
  inquiry_id: string;
  status: string;
  decision: string | null;
}

/**
 * Internal (validator/mperps) users live on OUR participant — their party id
 * ends in our fingerprint. Loop wallet users live on a different participant.
 * Mirrors the frontend `isInternalUser`. We pre-fill + lock the email only for
 * internal users (their address is already known + verified in our DB); Loop
 * users enter + OTP-verify a fresh one inside the provider flow.
 */
function isInternalParty(party: string): boolean {
  if (!PARTICIPANT_SUFFIX) return false;
  const colon = party.indexOf('::');
  const suffix = colon >= 0 ? party.slice(colon + 2) : party.slice(party.lastIndexOf('.') + 1);
  return suffix === PARTICIPANT_SUFFIX;
}

/**
 * The validator party id's local-part (before `::`, or the legacy `.`
 * separator) IS the user's Keycloak `sub` — that's how the party was hinted at
 * allocation. Lets us recover the email from Keycloak for users onboarded
 * outside our /signup flow.
 */
function kcSubFromParty(party: string): string {
  const colon = party.indexOf('::');
  if (colon >= 0) return party.slice(0, colon);
  const dot = party.indexOf('.');
  return dot >= 0 ? party.slice(0, dot) : party;
}

// ─── POST /kyc/start ─────────────────────────────────────────────────────
router.post('/kyc/start', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();
  const provider = getActiveProvider();

  try {
    // Make sure the users row exists (matches /me's auto-create policy).
    await pool.query(
      `INSERT INTO users (party_id, is_external) VALUES ($1, true)
       ON CONFLICT (party_id) DO NOTHING`,
      [party],
    );

    // Email handling:
    //   • internal (validator) users → pre-fill + lock the email we already
    //     have on file. Block if it's somehow missing (we never let a
    //     validator type a fresh address).
    //   • Loop users → omit; the provider collects + OTP-verifies a fresh one,
    //     which we later capture back via the webhook.
    let prefillEmail: string | undefined;
    if (isInternalParty(party)) {
      let stored = (
        await pool.query<{ email: string | null }>(
          `SELECT email FROM users WHERE party_id = $1`,
          [party],
        )
      ).rows[0]?.email?.trim();
      // Users onboarded outside /signup have no email persisted, but the
      // validator party encodes their Keycloak sub — recover it from Keycloak,
      // backfill our DB, and proceed. Only block if Keycloak has none either.
      if (!stored) {
        const kcEmail = await getKcUserEmailBySub(kcSubFromParty(party)).catch((err) => {
          console.warn('[kyc/start] Keycloak email lookup failed:', err);
          return null;
        });
        if (kcEmail) {
          await pool.query(
            `UPDATE users SET email = $2 WHERE party_id = $1 AND email IS NULL`,
            [party, kcEmail],
          );
          stored = kcEmail;
        }
      }
      if (!stored) {
        return res.status(400).json({
          error: 'email_missing',
          message:
            'No verified email is on file for your account. Please contact support to complete KYC.',
        });
      }
      prefillEmail = stored;
    }

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

    const resumable = !!latest && KYC_RESUMABLE_STATUSES.has(latest.status);
    const start = await provider.startVerification({
      userParty: party,
      existingInquiryId: resumable ? latest!.inquiry_id : undefined,
      email: prefillEmail,
    });

    // Record the (possibly new) verification. ON CONFLICT keeps the existing
    // row when the provider resumed / reused the same record id.
    await pool.query(
      `INSERT INTO kyc_inquiries (inquiry_id, user_party_id, provider, template_id, reference_id, status)
         VALUES ($1, $2, $3, $4, $5, 'created')
       ON CONFLICT (inquiry_id) DO NOTHING`,
      [start.inquiryId, party, provider.name, start.templateRef ?? null, party],
    );

    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'kyc.session', $2::jsonb)`,
      [party, JSON.stringify({ provider: provider.name, inquiryId: start.inquiryId, isNew: start.isNew })],
    );

    return res.json({
      inquiryId: start.inquiryId,
      sessionUrl: start.sessionUrl,
      status: start.isNew ? 'created' : latest?.status ?? 'created',
      resumed: !start.isNew,
      provider: provider.name,
    });
  } catch (err) {
    console.error('[kyc/start] error:', err);
    return res.status(502).json({ error: 'Failed to start KYC', details: String(err) });
  }
});

// ─── Generic webhook handler ─────────────────────────────────────────────
// Verifies the provider's signature over the EXACT raw bytes, normalizes the
// event, and upserts kyc_inquiries (tagged with the provider).
async function handleWebhook(
  provider: KycProvider,
  req: Request,
  res: Response,
): Promise<Response> {
  const rawBody = (req.body as Buffer).toString('utf8');

  if (!provider.verifyWebhook(rawBody, req.headers)) {
    console.warn(`[kyc/webhook/${provider.name}] signature verification failed`);
    return res.status(401).json({ error: 'invalid signature' });
  }

  const evt = provider.parseWebhookEvent(rawBody);
  if (!evt) {
    return res.status(202).json({ ok: true, ignored: 'unparseable or missing ids' });
  }

  const pool = getPool();
  // Webhooks can arrive before /me ever ran — ensure the users row exists.
  await pool.query(
    `INSERT INTO users (party_id, is_external) VALUES ($1, true)
     ON CONFLICT (party_id) DO NOTHING`,
    [evt.referenceId],
  );

  await pool.query(
    `INSERT INTO kyc_inquiries
       (inquiry_id, user_party_id, provider, template_id, reference_id,
        status, decision, completed_at, reject_reason, resubmit_allowed,
        raw_last_event, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
     ON CONFLICT (inquiry_id) DO UPDATE
       SET status           = EXCLUDED.status,
           decision         = COALESCE(EXCLUDED.decision, kyc_inquiries.decision),
           completed_at     = COALESCE(EXCLUDED.completed_at, kyc_inquiries.completed_at),
           template_id      = COALESCE(EXCLUDED.template_id, kyc_inquiries.template_id),
           reject_reason    = EXCLUDED.reject_reason,
           resubmit_allowed = EXCLUDED.resubmit_allowed,
           raw_last_event   = EXCLUDED.raw_last_event,
           updated_at       = NOW()`,
    [
      evt.inquiryId,
      evt.referenceId,
      provider.name,
      evt.templateRef ?? null,
      evt.referenceId,
      evt.status,
      evt.decision,
      evt.completedAt,
      evt.rejectReason ?? null,
      evt.resubmitAllowed ?? null,
      rawBody,
    ],
  );

  await pool.query(
    `INSERT INTO audit_log (user_party_id, action, details)
       VALUES ($1, 'kyc.event', $2::jsonb)`,
    [
      evt.referenceId,
      JSON.stringify({
        provider: provider.name,
        inquiryId: evt.inquiryId,
        eventName: evt.eventName,
        status: evt.status,
        decision: evt.decision,
      }),
    ],
  );

  // Capture the provider-collected + OTP-verified email back into our DB for
  // Loop users (who entered it inside the provider flow rather than us). Only
  // when we don't already have one, the applicant has progressed past creation,
  // and the provider exposes it. email is NOT unique — a Loop user and a
  // validator user may legitimately share an address. Best-effort: never let
  // this fail the webhook ack.
  if (provider.fetchContactEmail && evt.status !== 'created') {
    try {
      const hasEmail = (
        await pool.query<{ email: string | null }>(
          `SELECT email FROM users WHERE party_id = $1`,
          [evt.referenceId],
        )
      ).rows[0]?.email?.trim();
      if (!hasEmail) {
        const verified = await provider.fetchContactEmail(evt.inquiryId);
        if (verified) {
          await pool.query(
            `UPDATE users SET email = $2 WHERE party_id = $1 AND email IS NULL`,
            [evt.referenceId, verified],
          );
        }
      }
    } catch (err) {
      console.warn(`[kyc/webhook/${provider.name}] email capture failed:`, err);
    }
  }

  return res.json({ ok: true });
}

// Raw-body parser — HMAC/digest must be computed over the exact bytes sent.
const rawAny = raw({ type: '*/*' });

// Independent webhook URL per integration.
router.post('/kyc/webhook/persona', rawAny, (req, res) => handleWebhook(personaProvider, req, res));
router.post('/kyc/webhook/sumsub', rawAny, (req, res) => handleWebhook(sumsubProvider, req, res));
// Back-compat: original Persona webhook URL.
router.post('/kyc/webhook', rawAny, (req, res) => handleWebhook(personaProvider, req, res));

export default router;
