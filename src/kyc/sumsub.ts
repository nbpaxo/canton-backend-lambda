/**
 * Sumsub KYC client + webhook verification, implementing the generic
 * `KycProvider` interface.
 *
 * Auth: every API call is signed — header set:
 *   X-App-Token        = SUMSUB_APP_TOKEN
 *   X-App-Access-Ts    = unix seconds
 *   X-App-Access-Sig   = hex HMAC-SHA256(SUMSUB_SECRET_KEY, ts + METHOD + path + body)
 * (path includes the query string; body is "" for GET.)
 *   docs: https://docs.sumsub.com/reference/authentication
 *
 * Flow (analogue of Persona's hosted inquiry):
 *   1. Generate a WebSDK external link for (levelName, externalUserId=partyId).
 *      Sumsub creates/reuses the applicant for that externalUserId and returns
 *      a one-time URL the user opens.  → our `sessionUrl`
 *   2. Look up the applicant id by externalUserId.  → our `inquiry_id`
 *
 * Webhooks: Sumsub signs the raw body and sends the digest in `x-payload-digest`
 * with the algorithm in `x-payload-digest-alg` (e.g. HMAC_SHA256_HEX), keyed
 * by SUMSUB_WEBHOOK_SECRET.  docs: https://docs.sumsub.com/docs/webhooks
 *
 * NOTE: endpoint paths + payload shapes follow Sumsub's current docs; verify
 * against your account (level name, webhook secret) before going live.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  SUMSUB_API_BASE,
  SUMSUB_APP_TOKEN,
  SUMSUB_SECRET_KEY,
  SUMSUB_WEBHOOK_SECRET,
  SUMSUB_LEVEL_NAME,
  SUMSUB_LINK_TTL_SECS,
  SUMSUB_REDIRECT_URI,
  SUMSUB_REDIRECT_SIGN_KEY,
} from '../config.js';
import type {
  KycProvider,
  KycStartResult,
  NormalizedKycEvent,
  WebhookHeaders,
} from './types.js';

/** Sign + send a Sumsub API request. `path` MUST include any query string. */
async function sumsubFetch(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body = '',
): Promise<Response> {
  if (!SUMSUB_APP_TOKEN || !SUMSUB_SECRET_KEY) {
    throw new Error('SUMSUB_APP_TOKEN / SUMSUB_SECRET_KEY not set');
  }
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', SUMSUB_SECRET_KEY)
    .update(ts + method + path + body)
    .digest('hex');
  return fetch(`${SUMSUB_API_BASE}${path}`, {
    method,
    headers: {
      'X-App-Token': SUMSUB_APP_TOKEN,
      'X-App-Access-Ts': ts,
      'X-App-Access-Sig': sig,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body } : {}),
  });
}

/** Resolve the applicant (id + email on file) for our party (externalUserId).
 *  Sumsub uses the matrix-param form: /resources/applicants/-;externalUserId={ext}/one
 *  (docs: Get applicant data via externalUserId). */
async function getApplicant(
  externalUserId: string,
): Promise<{ id: string; email: string | null } | null> {
  const path = `/resources/applicants/-;externalUserId=${encodeURIComponent(externalUserId)}/one`;
  const res = await sumsubFetch('GET', path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sumsub getApplicant failed (${res.status}): ${await res.text()}`);
  const j = (await res.json()) as { id?: string; email?: string };
  if (!j.id) return null;
  return { id: j.id, email: j.email ?? null };
}

/** Create the applicant for our party; on 409 (already exists) fetch it.
 *  `email`, when given, is pre-set so the email-verification step is pre-filled. */
async function createApplicant(
  externalUserId: string,
  email?: string,
): Promise<string> {
  const path = `/resources/applicants?levelName=${encodeURIComponent(SUMSUB_LEVEL_NAME)}`;
  const body: Record<string, string> = { externalUserId };
  if (email) body.email = email;
  const res = await sumsubFetch('POST', path, JSON.stringify(body));
  if (res.status === 409) {
    const existing = await getApplicant(externalUserId);
    if (existing) return existing.id;
    throw new Error('Sumsub applicant already exists (409) but lookup failed');
  }
  if (!res.ok) throw new Error(`Sumsub createApplicant failed (${res.status}): ${await res.text()}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('Sumsub createApplicant response missing id');
  return j.id;
}

/** Set/replace an existing applicant's email (PATCH only changes given fields).
 *  docs: Change profile data (PATCH /resources/applicants). */
async function setApplicantEmail(applicantId: string, email: string): Promise<void> {
  const res = await sumsubFetch(
    'PATCH',
    '/resources/applicants',
    JSON.stringify({ id: applicantId, email }),
  );
  if (!res.ok) {
    throw new Error(`Sumsub setApplicantEmail failed (${res.status}): ${await res.text()}`);
  }
}

/** Generate a one-time WebSDK external link (the applicant must already exist). */
async function generateWebSdkLink(externalUserId: string): Promise<string> {
  const qs = new URLSearchParams({
    externalUserId,
    ttlInSecs: String(SUMSUB_LINK_TTL_SECS),
    lang: 'en',
  });
  const path = `/resources/sdkIntegrations/levels/${encodeURIComponent(SUMSUB_LEVEL_NAME)}/websdkLink?${qs.toString()}`;
  // Post-verification redirect — Sumsub's analogue of Persona's redirect-uri.
  // After the user taps Finish, Sumsub sends the browser to successUrl /
  // rejectUrl; we reuse the same `?kyc=1` target so the frontend re-opens the
  // KYC modal. The `redirect` block goes in the JSON body (which is part of the
  // signed payload). The webhook stays the source of truth for the decision.
  const body = SUMSUB_REDIRECT_URI
    ? JSON.stringify({
        redirect: {
          successUrl: SUMSUB_REDIRECT_URI,
          rejectUrl: SUMSUB_REDIRECT_URI,
          ...(SUMSUB_REDIRECT_SIGN_KEY ? { signKey: SUMSUB_REDIRECT_SIGN_KEY } : {}),
        },
      })
    : '';
  const res = await sumsubFetch('POST', path, body);
  if (!res.ok) throw new Error(`Sumsub websdkLink failed (${res.status}): ${await res.text()}`);
  const j = (await res.json()) as { url?: string };
  if (!j.url) throw new Error('Sumsub websdkLink response missing url');
  return j.url;
}

/**
 * Map a Sumsub webhook `type` (+ reviewResult) -> normalized status/decision,
 * or `null` for events that are NOT KYC-lifecycle transitions (those must not
 * overwrite the stored status).
 *
 * IMPORTANT: `reviewResult.reviewAnswer` ("GREEN"/"RED") rides on MANY
 * non-decision events too (applicantOnHold, applicantAwaitingUser,
 * applicantReset, applicantActionReviewed, applicantTagsChanged, ...), so the
 * verdict is read ONLY on the real review/workflow-completion events.
 * The applicantAction* events are a separate "applicant action" flow (not the
 * main KYC review) and are ignored.
 */
function normalizeSumsubEvent(
  type: string,
  reviewAnswer?: string,
  reviewRejectType?: string,
): { status: string; decision: NormalizedKycEvent['decision']; resubmitAllowed?: boolean } | null {
  switch (type) {
    case 'applicantCreated':
      return { status: 'created', decision: null };
    case 'applicantPending':
    case 'applicantAwaitingUser':
    case 'applicantAwaitingService':
    case 'applicantReset':
    case 'applicantStepsReset':
      return { status: 'pending', decision: null };
    case 'applicantOnHold':
    case 'applicantActionOnHold':
    case 'applicantActionPending':
      // Pending manual review (the team approves/rejects out-of-band).
      return { status: 'needs_review', decision: 'needs_review' };
    // Terminal KYC verdict. Classic level flows emit `applicantReviewed`;
    // workflow-based levels emit `applicantWorkflowCompleted` (and
    // `applicantWorkflowFailed` on a workflow failure). All carry the verdict
    // in reviewResult.
    case 'applicantReviewed':
    case 'applicantActionReviewed':
    case 'applicantWorkflowCompleted':
    case 'applicantWorkflowFailed':
      if (reviewAnswer === 'GREEN') return { status: 'approved', decision: 'approved' };
      if (reviewAnswer === 'RED') {
        // Review is DONE and rejected. RETRY = applicant may resubmit; FINAL =
        // permanent. Both are a decline (NOT "needs review").
        return {
          status: 'declined',
          decision: 'declined',
          resubmitAllowed: reviewRejectType === 'RETRY',
        };
      }
      // No verdict present (e.g. a genuine workflow execution failure) -> retryable.
      return { status: type === 'applicantWorkflowFailed' ? 'failed' : 'completed', decision: null };
    case 'applicantDeleted':
    case 'applicantPersonalDataDeleted':
      return { status: 'redacted', decision: null };
    // Everything else is NOT a KYC lifecycle transition and must not change the
    // stored status: personal-info / tags changes, activate/deactivate, level
    // changes (incl. applicantActionLevelChanged), verification-link-opened,
    // prechecked, share-token events, etc.
    default:
      return null;
  }
}

export const sumsubProvider: KycProvider = {
  name: 'sumsub',

  async startVerification({ userParty, email }): Promise<KycStartResult> {
    // Sumsub keys everything off externalUserId (our party id). Link generation
    // does NOT auto-create the applicant, so ensure it exists first (create, or
    // reuse on 409), THEN mint a fresh WebSDK link for the user to open.
    const existing = await getApplicant(userParty);
    const existedBefore = existing != null;
    let applicantId: string;
    if (!existing) {
      // New applicant — pre-set the email (if known) so it's pre-filled.
      applicantId = await createApplicant(userParty, email);
    } else {
      applicantId = existing.id;
      // Applicant already exists: make sure the pre-set email is in place
      // (e.g. a validator resuming an inquiry created before we pre-filled).
      if (email && existing.email !== email) {
        await setApplicantEmail(applicantId, email);
      }
    }
    const sessionUrl = await generateWebSdkLink(userParty);
    return {
      inquiryId: applicantId,
      sessionUrl,
      templateRef: SUMSUB_LEVEL_NAME || undefined,
      isNew: !existedBefore,
    };
  },

  /** Return the applicant's email on file (the OTP-verified address for Loop
   *  users who entered it inside the Sumsub flow), or null. */
  async fetchContactEmail(inquiryId: string): Promise<string | null> {
    const path = `/resources/applicants/${encodeURIComponent(inquiryId)}/one`;
    const res = await sumsubFetch('GET', path);
    if (!res.ok) return null;
    const j = (await res.json()) as { email?: string };
    return j.email?.trim() || null;
  },

  verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean {
    if (!SUMSUB_WEBHOOK_SECRET) {
      console.warn('[sumsub] SUMSUB_WEBHOOK_SECRET not set — rejecting webhook');
      return false;
    }
    const h = (k: string): string | undefined => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const digest = h('x-payload-digest');
    if (!digest) return false;
    const alg = (h('x-payload-digest-alg') || 'HMAC_SHA256_HEX').toUpperCase();
    const algo = alg.includes('SHA512') ? 'sha512' : alg.includes('SHA1') ? 'sha1' : 'sha256';
    const expected = createHmac(algo, SUMSUB_WEBHOOK_SECRET).update(rawBody).digest('hex');
    if (expected.length !== digest.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(digest, 'hex'));
    } catch {
      return false;
    }
  },

  parseWebhookEvent(rawBody: string): NormalizedKycEvent | null {
    let evt: {
      applicantId?: string;
      externalUserId?: string;
      levelName?: string;
      type?: string;
      reviewResult?: {
        reviewAnswer?: string;
        reviewRejectType?: string;
        moderationComment?: string;
        clientComment?: string;
        rejectLabels?: string[];
      };
      // Both are STRINGS (not unix-ms numbers). `createdAt` (with a TZ offset,
      // e.g. "2023-03-14 12:50:27+0000") rides on some events; `createdAtMs`
      // ("yyyy-MM-dd HH:mm:ss.fff", UTC, no TZ) is always present.
      createdAt?: string;
      createdAtMs?: string;
    };
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const inquiryId = evt.applicantId;
    const referenceId = evt.externalUserId;
    const type = evt.type ?? '';
    if (!inquiryId || !referenceId) return null;
    const norm = normalizeSumsubEvent(
      type,
      evt.reviewResult?.reviewAnswer,
      evt.reviewResult?.reviewRejectType,
    );
    if (!norm) return null; // event we intentionally ignore (no status change)
    const { status, decision, resubmitAllowed } = norm;
    // Stamp completed_at when the verdict lands.
    const terminal = status === 'approved' || status === 'declined';
    const completedAt = terminal
      ? evt.createdAt ?? (evt.createdAtMs ? `${evt.createdAtMs.replace(' ', 'T')}Z` : null)
      : null;
    // Surface the rejection reason for the UI (prefer the applicant-facing
    // moderationComment, then clientComment, then the reject labels).
    const rr = evt.reviewResult;
    const rejectReason =
      status === 'declined'
        ? rr?.moderationComment ?? rr?.clientComment ?? rr?.rejectLabels?.join(', ') ?? null
        : null;
    return {
      inquiryId,
      referenceId,
      templateRef: evt.levelName,
      status,
      decision,
      completedAt,
      rejectReason,
      resubmitAllowed,
      eventName: type,
    };
  },
};
