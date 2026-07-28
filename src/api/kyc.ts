/**
 * KYC endpoints — provider-agnostic (Persona / Sumsub / Hypersign, selected by
 * KYC_PROVIDER).
 *
 *   POST /kyc/start
 *     Uses the ACTIVE provider. If the caller's latest record is resumable
 *     (created | pending | completed | needs_review | expired | failed) the
 *     provider re-issues a session for the same record; if approved → 409;
 *     otherwise a fresh verification is created. Returns a hosted/SDK URL.
 *
 *   POST /kyc/webhook/persona   — Persona event sink (HMAC over raw body)
 *   POST /kyc/webhook/sumsub    — Sumsub event sink (x-payload-digest)
 *   POST /kyc/webhook/hypersign — Hypersign event sink ({ idToken, sessionId })
 *   POST /kyc/webhook           — back-compat alias → persona
 *     Each verifies its own signature, normalizes the event, and upserts
 *     kyc_inquiries (tagged with `provider`). The /me endpoint reads the
 *     normalized status/decision and never branches on provider.
 *
 *     Some providers (Hypersign) omit our reference id from the webhook body —
 *     the handler resolves the party from the stored inquiry/session id.
 */
import { Router, Request, Response, raw, json } from 'express';
import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getPool } from '../db/pool.js';
import {
  KYC_RESUMABLE_STATUSES,
  KYC_TERMINAL_STATUSES,
  type KycProvider,
} from '../kyc/types.js';
import { getActiveProvider, getProvider } from '../kyc/index.js';
import { personaProvider } from '../kyc/persona.js';
import { sumsubProvider } from '../kyc/sumsub.js';
import { hypersignProvider } from '../kyc/hypersign.js';
import {
  PARTICIPANT_SUFFIX,
  EMAIL_OTP_TTL_SECS,
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_RESEND_COOLDOWN_SECS,
} from '../config.js';
import { getKcUserEmailBySub } from '../keycloak.js';
import { sendOtpEmail } from '../email/resend.js';

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

    // Email handling (provider-dependent):
    //   • Providers that require an email up front (provider.requiresEmail —
    //     Hypersign's client_auth needs it as a DID-JWT claim and can't collect
    //     it in-flow): the email MUST already be on file for EVERY user type.
    //     If absent we return `email_missing` and do NOT start KYC.
    //     (Phase 1: emails are seeded manually. Phase 2 will add in-app email
    //     collection + uniqueness + OTP verification before this point.)
    //   • Other providers (Persona/Sumsub): pre-fill + lock the email for
    //     internal (validator) users only; Loop users omit it and the provider
    //     collects + OTP-verifies a fresh one, captured back via the webhook.
    const needsEmail = provider.requiresEmail === true;

    // Stored email (if any). Internal parties encode a Keycloak sub, so backfill
    // from Keycloak when our DB has none — regardless of provider.
    let storedEmail = (
      await pool.query<{ email: string | null }>(
        `SELECT email FROM users WHERE party_id = $1`,
        [party],
      )
    ).rows[0]?.email?.trim();
    if (!storedEmail && isInternalParty(party)) {
      const kcEmail = await getKcUserEmailBySub(kcSubFromParty(party)).catch((err) => {
        console.warn('[kyc/start] Keycloak email lookup failed:', err);
        return null;
      });
      if (kcEmail) {
        try {
          await pool.query(
            `UPDATE users SET email = $2 WHERE party_id = $1 AND email IS NULL`,
            [party, kcEmail],
          );
          storedEmail = kcEmail;
        } catch (e) {
          // Another party already uses this email — don't backfill (leave null).
          if ((e as { code?: string }).code === '23505') {
            console.warn('[kyc/start] Keycloak email already in use by another party; not backfilling');
          } else {
            throw e;
          }
        }
      }
    }

    let prefillEmail: string | undefined;
    if (needsEmail) {
      // Required for ALL user types — block (and do nothing) when absent.
      if (!storedEmail) {
        return res.status(400).json({
          error: 'email_missing',
          message: 'No email is on file for your account. An email is required to start KYC.',
        });
      }
      prefillEmail = storedEmail;
    } else if (isInternalParty(party)) {
      // Persona/Sumsub: only internal users are pre-filled + must have an email.
      if (!storedEmail) {
        return res.status(400).json({
          error: 'email_missing',
          message:
            'No verified email is on file for your account. Please contact support to complete KYC.',
        });
      }
      prefillEmail = storedEmail;
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

    // One active record per user. Persona/Sumsub reuse the same record id on
    // resume, so they naturally keep one row — but Hypersign mints a fresh
    // sessionId every start, which would accrue a new row per click. When a
    // brand-new record is created, drop the user's other non-approved
    // inquiries (any provider) so exactly one active KYC record remains.
    if (start.isNew) {
      await pool.query(
        `DELETE FROM kyc_inquiries
           WHERE user_party_id = $1 AND inquiry_id <> $2
             AND (decision IS NULL OR decision <> 'approved')`,
        [party, start.inquiryId],
      );
    }

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

// ─── Email OTP collection ────────────────────────────────────────────────
// For users we have no email for (Loop wallet users) before a provider that
// requires one up front (Hypersign client_auth). Two steps: request a code,
// then verify it — on success the address is persisted to users.email and the
// /kyc/start email gate passes. The KYC router is mounted before the global
// JSON parser (webhooks need the raw body), so parse JSON locally here.
const jsonParser = json();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// OTP hashing: scrypt (memory-hard KDF, argon2id-equivalent) with a per-code
// random salt. The 6-digit space is only 1M values, so a fast hash (sha256)
// would be trivially brute-forced offline if the DB leaked; scrypt makes each
// guess expensive and the salt defeats precomputation. Built into node:crypto —
// no native dependency (Lambda-safe). Stored as `scrypt$<saltHex>$<hashHex>`.
const SCRYPT_KEYLEN = 32;
// N=16384 → ~16MB working memory per hash; well within Lambda limits.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Manual promise wrapper — promisify() resolves to scrypt's no-options overload,
// so we can't pass SCRYPT_PARAMS through it.
function deriveScrypt(code: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(code, salt, keylen, SCRYPT_PARAMS, (err, dk) => {
      if (err) reject(err);
      else resolve(dk as Buffer);
    });
  });
}

async function hashOtp(code: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await deriveScrypt(code, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

async function verifyOtp(code: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const dk = await deriveScrypt(code, salt, expected.length);
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

// POST /kyc/email/request-otp { email } — send a fresh 6-digit code.
router.post('/kyc/email/request-otp', jsonParser, requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const email = String((req.body?.email ?? '')).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email', message: 'Enter a valid email address.' });
  }
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO users (party_id, is_external) VALUES ($1, true)
       ON CONFLICT (party_id) DO NOTHING`,
      [party],
    );

    // Uniqueness: reject if another party already uses this address.
    const taken = (
      await pool.query(
        `SELECT 1 FROM users WHERE LOWER(email) = $1 AND party_id <> $2 LIMIT 1`,
        [email, party],
      )
    ).rows[0];
    if (taken) {
      return res.status(409).json({ error: 'email_in_use', message: 'This email is already in use.' });
    }

    // Anti-spam cooldown between successive sends.
    const existing = (
      await pool.query<{ last_sent_at: Date }>(
        `SELECT last_sent_at FROM email_otps WHERE party_id = $1`,
        [party],
      )
    ).rows[0];
    if (existing) {
      const sinceSecs = (Date.now() - existing.last_sent_at.getTime()) / 1000;
      if (sinceSecs < EMAIL_OTP_RESEND_COOLDOWN_SECS) {
        const retryAfter = Math.ceil(EMAIL_OTP_RESEND_COOLDOWN_SECS - sinceSecs);
        return res.status(429).json({
          error: 'otp_cooldown',
          message: `Please wait ${retryAfter}s before requesting another code.`,
          retryAfterSecs: retryAfter,
        });
      }
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = await hashOtp(code);
    await pool.query(
      `INSERT INTO email_otps (party_id, email, code_hash, expires_at, attempts, last_sent_at)
         VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::interval, 0, NOW())
       ON CONFLICT (party_id) DO UPDATE
         SET email = EXCLUDED.email,
             code_hash = EXCLUDED.code_hash,
             expires_at = EXCLUDED.expires_at,
             attempts = 0,
             last_sent_at = NOW()`,
      [party, email, codeHash, String(EMAIL_OTP_TTL_SECS)],
    );

    await sendOtpEmail(email, code, Math.round(EMAIL_OTP_TTL_SECS / 60));

    return res.json({ ok: true, email, expiresInSecs: EMAIL_OTP_TTL_SECS });
  } catch (err) {
    console.error('[kyc/email/request-otp] error:', err);
    return res.status(502).json({
      error: 'otp_send_failed',
      message: 'Could not send the verification code. Please try again.',
    });
  }
});

// POST /kyc/email/verify-otp { email, code } — verify + persist on success.
router.post('/kyc/email/verify-otp', jsonParser, requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const email = String((req.body?.email ?? '')).trim().toLowerCase();
  const code = String((req.body?.code ?? '')).trim();
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({
      error: 'invalid_input',
      message: 'Enter the 6-digit code sent to your email.',
    });
  }
  const pool = getPool();
  try {
    const row = (
      await pool.query<{ email: string; code_hash: string; attempts: number; expires_at: Date }>(
        `SELECT email, code_hash, attempts, expires_at FROM email_otps WHERE party_id = $1`,
        [party],
      )
    ).rows[0];
    if (!row) {
      return res.status(400).json({ error: 'no_otp', message: 'Request a verification code first.' });
    }
    if (row.expires_at.getTime() < Date.now()) {
      return res.status(400).json({ error: 'otp_expired', message: 'Code expired. Request a new one.' });
    }
    if (row.attempts >= EMAIL_OTP_MAX_ATTEMPTS) {
      return res.status(429).json({
        error: 'too_many_attempts',
        message: 'Too many incorrect attempts. Request a new code.',
      });
    }
    // The submitted email must match the address the code was sent to.
    if (row.email.toLowerCase() !== email) {
      return res.status(400).json({
        error: 'email_mismatch',
        message: 'This code was sent to a different email. Request a new code.',
      });
    }
    if (!(await verifyOtp(code, row.code_hash))) {
      await pool.query(`UPDATE email_otps SET attempts = attempts + 1 WHERE party_id = $1`, [party]);
      return res.status(400).json({ error: 'otp_invalid', message: 'Incorrect code.' });
    }

    // Re-check uniqueness at commit time (guards a race between request + verify).
    const taken = (
      await pool.query(
        `SELECT 1 FROM users WHERE LOWER(email) = $1 AND party_id <> $2 LIMIT 1`,
        [email, party],
      )
    ).rows[0];
    if (taken) {
      return res.status(409).json({ error: 'email_in_use', message: 'This email is already in use.' });
    }

    try {
      await pool.query(`UPDATE users SET email = $2 WHERE party_id = $1`, [party, email]);
    } catch (e) {
      // Unique-index backstop (23505) in case another party claimed it between
      // the pre-check above and here.
      if ((e as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'email_in_use', message: 'This email is already in use.' });
      }
      throw e;
    }
    await pool.query(`DELETE FROM email_otps WHERE party_id = $1`, [party]);
    await pool.query(
      `INSERT INTO audit_log (user_party_id, action, details)
         VALUES ($1, 'email.verified', $2::jsonb)`,
      [party, JSON.stringify({ email })],
    );

    return res.json({ ok: true, email });
  } catch (err) {
    console.error('[kyc/email/verify-otp] error:', err);
    return res.status(502).json({ error: 'otp_verify_failed', message: 'Could not verify the code. Please try again.' });
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
    console.warn(`[kyc/webhook/${provider.name}] ignored: unparseable or missing ids`);
    return res.status(202).json({ ok: true, ignored: 'unparseable or missing ids' });
  }

  const pool = getPool();

  // Some providers (Hypersign) don't echo our reference id in the webhook body.
  // Resolve the party from the stored inquiry/session id we recorded at
  // /kyc/start. If it maps to no known verification, ignore the event (this is
  // also the authenticity guard for unsigned webhooks).
  if (!evt.referenceId) {
    const row = (
      await pool.query<{ reference_id: string | null }>(
        `SELECT reference_id FROM kyc_inquiries WHERE inquiry_id = $1`,
        [evt.inquiryId],
      )
    ).rows[0];
    const resolved = row?.reference_id?.trim();
    if (!resolved) {
      console.warn(
        `[kyc/webhook/${provider.name}] ignored: no verification found for inquiry/session id ${evt.inquiryId}`,
      );
      return res.status(202).json({ ok: true, ignored: 'unknown session id' });
    }
    evt.referenceId = resolved;
  }

  await applyKycEvent(provider, evt, rawBody);
  return res.json({ ok: true });
}

/**
 * Persist a normalized KYC event to the DB (idempotent upsert + audit + best-
 * effort email capture). Shared by the webhook handler and the /kyc/sync
 * fallback so both apply outcomes identically.
 *   `rawEvent` is stored in raw_last_event for forensics (the raw webhook body,
 *   or a small marker for a sync-sourced event).
 */
async function applyKycEvent(
  provider: KycProvider,
  evt: NonNullable<ReturnType<KycProvider['parseWebhookEvent']>>,
  rawEvent: string,
): Promise<void> {
  const pool = getPool();

  // Events can arrive before /me ever ran — ensure the users row exists.
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
      rawEvent,
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
  // validator user may legitimately share an address. Best-effort.
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
      console.warn(`[kyc/${provider.name}] email capture failed:`, err);
    }
  }
}

// ─── POST /kyc/sync — webhook fallback via provider status poll ───────────
// If a webhook was missed, reconcile the caller's latest non-terminal record by
// polling the provider (Hypersign consent API). Called by the KYC Refresh
// button. No-op for providers without a checkStatus poll, or when already done.
router.post('/kyc/sync', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();
  try {
    const row = (
      await pool.query<{ inquiry_id: string; provider: string; status: string; decision: string | null }>(
        `SELECT inquiry_id, provider, status, decision FROM kyc_inquiries
          WHERE user_party_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [party],
      )
    ).rows[0];
    if (!row) return res.json({ synced: false, reason: 'no_inquiry' });
    if (KYC_TERMINAL_STATUSES.has(row.status) || row.decision === 'approved') {
      return res.json({ synced: false, reason: 'already_terminal' });
    }
    const provider = getProvider(row.provider);
    if (!provider?.getConsentStatus) return res.json({ synced: false, reason: 'unsupported' });

    const st = await provider.getConsentStatus(row.inquiry_id, party);
    if (!st) return res.json({ synced: false, reason: 'unavailable' });
    if (!st.done || !st.event) return res.json({ synced: false, reason: 'in_progress' });

    await applyKycEvent(
      provider,
      st.event,
      JSON.stringify({ source: 'consent-sync', eventName: st.event.eventName }),
    );
    return res.json({ synced: true, status: st.event.status, decision: st.event.decision });
  } catch (err) {
    console.error('[kyc/sync] error:', err);
    return res.status(502).json({ synced: false, error: 'sync_failed', details: String(err) });
  }
});

// ─── GET /kyc/progress — steps taken so far (for the progress modal) ──────
// Polls the provider consent status for the caller's latest non-terminal record.
// If it has actually completed, reconciles it (marks approved) and reports done;
// otherwise returns the progress steps for display.
router.get('/kyc/progress', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();
  try {
    const row = (
      await pool.query<{ inquiry_id: string; provider: string; status: string; decision: string | null }>(
        `SELECT inquiry_id, provider, status, decision FROM kyc_inquiries
          WHERE user_party_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [party],
      )
    ).rows[0];
    if (!row) return res.json({ available: false, reason: 'no_inquiry', steps: [] });
    if (KYC_TERMINAL_STATUSES.has(row.status) || row.decision === 'approved') {
      return res.json({ available: false, reason: 'already_terminal', steps: [] });
    }
    const provider = getProvider(row.provider);
    if (!provider?.getConsentStatus) {
      return res.json({ available: false, reason: 'unsupported', steps: [] });
    }

    const st = await provider.getConsentStatus(row.inquiry_id, party);
    if (!st) return res.json({ available: false, reason: 'unavailable', steps: [] });

    // Completed since we last saw it — reconcile and report done.
    if (st.done && st.event) {
      await applyKycEvent(
        provider,
        st.event,
        JSON.stringify({ source: 'consent-progress', eventName: st.event.eventName }),
      );
      return res.json({ available: true, done: true, steps: [] });
    }
    return res.json({ available: true, done: false, steps: st.steps });
  } catch (err) {
    console.error('[kyc/progress] error:', err);
    return res.status(502).json({ available: false, error: 'progress_failed', steps: [] });
  }
});

// Raw-body parser — HMAC/digest must be computed over the exact bytes sent.
const rawAny = raw({ type: '*/*' });

// Independent webhook URL per integration.
router.post('/kyc/webhook/persona', rawAny, (req, res) => handleWebhook(personaProvider, req, res));
router.post('/kyc/webhook/sumsub', rawAny, (req, res) => handleWebhook(sumsubProvider, req, res));
router.post('/kyc/webhook/hypersign', rawAny, (req, res) => handleWebhook(hypersignProvider, req, res));
// Back-compat: original Persona webhook URL.
router.post('/kyc/webhook', rawAny, (req, res) => handleWebhook(personaProvider, req, res));

export default router;
