/**
 * Hypersign ID/KYC client + webhook handling, implementing the generic
 * `KycProvider` interface.
 *
 * Flow (analogue of Persona's hosted inquiry / Sumsub's WebSDK link):
 *   1. Mint a short-lived KYC access token by exchanging the app's API secret
 *      key at the OAuth endpoint, selecting the service via grant_type:
 *        POST {AUTH_API_BASE}/api/v1/app/oauth?grant_type=access_service_kyc
 *        header: X-Api-Secret-Key: <secret>   → { access_token, expiresIn }
 *      A matching ssiAccessToken (grant_type=access_service_ssi) is minted
 *      best-effort with the same secret; the widget works without it.
 *   2. Create a verification session at the KYC tenant URL:
 *        POST {KYC_TENANT_URL}/api/v2/session
 *        header: x-kyc-access-token: <kycAccessToken>
 *        → { data: { sessionId } }              → our `inquiry_id`
 *   2b. (client_auth) When in-widget user login is DISABLED, also mint a
 *       per-session kycUserAccessToken so the backend establishes the user
 *       session. 3 steps (all with the SSI admin token):
 *         a. POST {SSI_BASE_URL}/api/v1/did/create            → userDid
 *         b. POST {SSI_BASE_URL}/api/v1/did/auth/issue-jwt     → DID-signed JWT
 *            (issuer = our app DID; audience = KYC tenant; claims = {did,email})
 *         c. POST {KYC_TENANT_URL}/api/v2/auth/exchange        → user token
 *            (provider="client_auth", sessionId) → data.kycServiceUserAccessToken
 *       Enabled only when ISSUER_DID + ISSUER_VERIFICATION_METHOD_ID are set.
 *   3. The frontend opens the hosted widget:
 *        {WIDGET_URL}?kycAccessToken=…&ssiAccessToken=…&sessionId=…[&kycUserAccessToken=…]
 *        → sessionUrl
 *      The widget posts `{ status: 'success'|'fail', message }` back to the
 *      opener, but the WEBHOOK is the source of truth for the decision.
 *
 * Webhook: on completion Hypersign POSTs `{ idToken, sessionId }` to the URL
 * configured in the KYC dashboard. `idToken` is a signed JWT credential
 * describing the verification result. Unlike Persona/Sumsub the body carries
 * NO reference/externalUserId, so the generic handler resolves our party id
 * from the stored `sessionId` (see api/kyc.ts). docs: hypersign-kyc
 *
 * NOTE: Hypersign's public docs don't pin down the idToken claim names or a
 * webhook-signature header. The webhook extraction below is defensive and every
 * assumption is flagged — verify against your account (idToken claim shapes,
 * webhook secret) before going live.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  HYPERSIGN_AUTH_API_BASE,
  HYPERSIGN_API_SECRET_KEY,
  HYPERSIGN_SSI_API_SECRET_KEY,
  HYPERSIGN_KYC_TENANT_URL,
  HYPERSIGN_WIDGET_URL,
  HYPERSIGN_SSI_BASE_URL,
  HYPERSIGN_ISSUER_DID,
  HYPERSIGN_ISSUER_VERIFICATION_METHOD_ID,
  HYPERSIGN_WEBHOOK_API_TOKEN,
  HYPERSIGN_WEBHOOK_SECRET,
} from '../config.js';
import type {
  KycProvider,
  KycConsentStatus,
  KycStartResult,
  NormalizedKycEvent,
  WebhookHeaders,
} from './types.js';

/**
 * Exchange the app API secret key for a short-lived access token for one
 * service (KYC or SSI), selected by grant_type.
 *   POST {AUTH_API_BASE}/api/v1/app/oauth?grant_type=<grant>
 *   header: X-Api-Secret-Key: <secret>   → { access_token, expiresIn }
 */
async function mintAccessToken(
  secretKey: string,
  grantType: 'access_service_kyc' | 'access_service_ssi',
  label: string,
): Promise<string> {
  if (!secretKey) throw new Error(`Hypersign ${label} secret key not set`);
  const url = `${HYPERSIGN_AUTH_API_BASE}/api/v1/app/oauth?grant_type=${grantType}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Api-Secret-Key': secretKey,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Hypersign ${label} oauth failed (${res.status}): ${await res.text()}`);
  }
  const j = (await res.json()) as {
    access_token?: string;
    accessToken?: string;
    data?: { access_token?: string; accessToken?: string };
  };
  const token =
    j.access_token ?? j.accessToken ?? j.data?.access_token ?? j.data?.accessToken ?? '';
  if (!token) throw new Error(`Hypersign ${label} oauth response missing access_token`);
  return token;
}

/**
 * Create a KYC verification session and return its id.
 *   POST {KYC_TENANT_URL}/api/v2/session
 *   header: x-kyc-access-token: <kycAccessToken>   → { data: { sessionId } }
 * Read the id defensively (a few key shapes across tenant versions).
 */
async function createSession(kycAccessToken: string): Promise<string> {
  if (!HYPERSIGN_KYC_TENANT_URL) throw new Error('HYPERSIGN_KYC_TENANT_URL not set');
  const res = await fetch(`${HYPERSIGN_KYC_TENANT_URL}/api/v2/session`, {
    method: 'POST',
    headers: {
      'x-kyc-access-token': kycAccessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`Hypersign createSession failed (${res.status}): ${await res.text()}`);
  }
  const j = (await res.json()) as {
    sessionId?: string;
    id?: string;
    data?: { sessionId?: string; id?: string };
  };
  const sessionId = j.data?.sessionId ?? j.sessionId ?? j.data?.id ?? j.id ?? '';
  if (!sessionId) throw new Error('Hypersign createSession response missing sessionId');
  return sessionId;
}

/** Build the hosted-widget URL the frontend opens (tokens + session in the query).
 *  ssiAccessToken / userAccessToken are optional — omitted when not minted. */
function buildWidgetUrl(
  kycAccessToken: string,
  ssiAccessToken: string,
  sessionId: string,
  userAccessToken = '',
): string {
  const params = new URLSearchParams({ kycAccessToken, sessionId });
  if (ssiAccessToken) params.set('ssiAccessToken', ssiAccessToken);
  if (userAccessToken) params.set('kycUserAccessToken', userAccessToken);
  return `${HYPERSIGN_WIDGET_URL}?${params.toString()}`;
}

// ─── client_auth user-token flow (used when in-widget login is disabled) ────

/** True when the issuer identity needed for the client_auth flow is configured. */
function userTokenFlowEnabled(): boolean {
  return !!(HYPERSIGN_ISSUER_DID && HYPERSIGN_ISSUER_VERIFICATION_METHOD_ID);
}

/** Step a: register a fresh user DID (needed as the JWT subject).
 *  POST {SSI_BASE_URL}/api/v1/did/create  → { did, metaData: { didDocument } } */
async function createUserDid(ssiAdminToken: string): Promise<string> {
  const res = await fetch(`${HYPERSIGN_SSI_BASE_URL}/api/v1/did/create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ssiAdminToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ namespace: '' }),
  });
  if (!res.ok) {
    throw new Error(`Hypersign did/create failed (${res.status}): ${await res.text()}`);
  }
  const j = (await res.json()) as {
    did?: string;
    metaData?: { didDocument?: { id?: string } };
  };
  const did = j.did ?? j.metaData?.didDocument?.id ?? '';
  if (!did) throw new Error('Hypersign did/create response missing did');
  return did;
}

/** Step b: issue the DID-signed JWT for (userDid, email).
 *  POST {SSI_BASE_URL}/api/v1/did/auth/issue-jwt  → { accessToken } */
async function issueDidJwt(
  ssiAdminToken: string,
  userDid: string,
  email: string,
): Promise<string> {
  const res = await fetch(`${HYPERSIGN_SSI_BASE_URL}/api/v1/did/auth/issue-jwt`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ssiAdminToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      issuer: {
        verificationMethodId: HYPERSIGN_ISSUER_VERIFICATION_METHOD_ID,
        did: HYPERSIGN_ISSUER_DID,
      },
      audience: HYPERSIGN_KYC_TENANT_URL,
      claims: { did: userDid, email },
      ttlSeconds: 3600,
    }),
  });
  if (!res.ok) {
    throw new Error(`Hypersign issue-jwt failed (${res.status}): ${await res.text()}`);
  }
  const j = (await res.json()) as { accessToken?: string; data?: { accessToken?: string } };
  const jwt = j.accessToken ?? j.data?.accessToken ?? '';
  if (!jwt) throw new Error('Hypersign issue-jwt response missing accessToken');
  return jwt;
}

/** Step c: exchange the DID JWT for the per-session kycUserAccessToken.
 *  POST {KYC_TENANT_URL}/api/v2/auth/exchange → { data: { kycServiceUserAccessToken } } */
async function exchangeForUserToken(
  ssiAdminToken: string,
  kycAdminToken: string,
  didJwt: string,
  sessionId: string,
): Promise<string> {
  const res = await fetch(`${HYPERSIGN_KYC_TENANT_URL}/api/v2/auth/exchange`, {
    method: 'POST',
    headers: {
      'x-ssi-access-token': ssiAdminToken,
      'x-kyc-access-token': kycAdminToken,
      Authorization: `Bearer ${didJwt}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ provider: 'client_auth', sessionId }),
  });
  if (!res.ok) {
    throw new Error(`Hypersign auth/exchange failed (${res.status}): ${await res.text()}`);
  }
  const j = (await res.json()) as {
    data?: { kycServiceUserAccessToken?: string };
    kycServiceUserAccessToken?: string;
  };
  const token = j.data?.kycServiceUserAccessToken ?? j.kycServiceUserAccessToken ?? '';
  if (!token) throw new Error('Hypersign auth/exchange response missing kycServiceUserAccessToken');
  return token;
}

/** Decode a JWT's payload (base64url JSON) without verifying — for claim reads. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Timing-safe constant-comparison of two secret strings. */
function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/** Verify a JWT's HS256 signature against `secret` (timing-safe). */
function verifyJwtHs256(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [header, payload, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

/**
 * Map a Hypersign result string → normalized status/decision.
 * Hypersign issues the idToken credential on successful completion, so a
 * webhook that carries a valid idToken with no explicit failure signal is
 * treated as approved. Explicit failure/pending markers override that.
 */
function normalizeHypersignStatus(
  raw: string | undefined,
): { status: string; decision: NormalizedKycEvent['decision'] } {
  switch ((raw || '').toLowerCase()) {
    case 'success':
    case 'completed':
    case 'complete':
    case 'verified':
    case 'approved':
    case 'done':
      return { status: 'approved', decision: 'approved' };
    case 'fail':
    case 'failed':
    case 'rejected':
    case 'declined':
    case 'error':
      return { status: 'declined', decision: 'declined' };
    case 'pending':
    case 'processing':
    case 'in_progress':
    case 'inprogress':
      return { status: 'pending', decision: null };
    // No explicit status on the event: receiving a Hypersign webhook means the
    // flow reached completion and a credential (idToken) was issued → approved.
    default:
      return { status: 'approved', decision: 'approved' };
  }
}

/** Pull a plausible status string from the webhook body or the idToken claims. */
function extractStatus(
  body: Record<string, unknown>,
  claims: Record<string, unknown> | null,
): string | undefined {
  const pick = (o: Record<string, unknown> | null, keys: string[]): string | undefined => {
    if (!o) return undefined;
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };
  const keys = ['status', 'verificationStatus', 'kycStatus', 'result', 'state'];
  return pick(body, keys) ?? pick(claims, keys);
}

/** Pull a human-readable reject reason from the body / idToken claims, if any. */
function extractRejectReason(
  body: Record<string, unknown>,
  claims: Record<string, unknown> | null,
): string | null {
  const keys = ['reason', 'rejectReason', 'message', 'comment', 'error'];
  for (const src of [body, claims]) {
    if (!src) continue;
    for (const k of keys) {
      const v = src[k];
      if (typeof v === 'string' && v) return v;
    }
  }
  return null;
}

/**
 * Documented consent-step error codes → human-readable messages, keyed by
 * stepName then errorCode. Source: Hypersign Widget Integration Guide (Step 4
 * error tables). We prefer the provider's own `error` string when present and
 * fall back to this table so a bare code always resolves to a message.
 */
const HYPERSIGN_ERROR_MESSAGES: Record<string, Record<number, string>> = {
  liveliness: {
    0: 'Liveness could not be assessed',
    1: 'Possible spoof detected',
    2: 'Unspecified error',
    4: 'Bad image quality',
    5: 'Face too close',
    6: 'Face not found',
    7: 'Face too small',
    8: 'Face angle too steep',
    9: 'Format error',
    10: 'Internal error',
    11: 'Image preprocessing error',
    12: 'Multiple faces detected',
    13: 'Face too close to border',
    14: 'Face cropped',
    15: 'License error',
    16: 'Face obstructed',
    17: 'No liveness detected',
    18: 'Eyes closed',
  },
  ocrIdDoc: {
    0: 'Face check could not be performed',
    1: 'Faces do not match',
    2: 'Face not found',
    4: 'Face pose failed',
    5: 'Facial pattern extraction failed',
    6: 'Document already verified',
  },
  zkProofVerification: {
    4: 'ZK proof verification failed',
    5: 'ZK proof requirement verification failed',
  },
};

/** Resolve a documented error message for (stepName, errorCode), or null. */
function hypersignErrorMessage(stepName: string, code: number | null | undefined): string | null {
  if (code == null) return null;
  return HYPERSIGN_ERROR_MESSAGES[stepName]?.[code] ?? null;
}

export const hypersignProvider: KycProvider = {
  name: 'hypersign',

  // Email is a mandatory DID-JWT claim in the client_auth flow and the widget
  // can't collect it (in-widget login is disabled), so /kyc/start requires an
  // email on file for every user before starting.
  requiresEmail: true,

  /**
   * Hypersign sessions are single-attempt and there is no documented resume
   * endpoint, so we always mint a fresh session (existingInquiryId is ignored).
   * Each /kyc/start therefore creates a new sessionId → a new kyc_inquiries row;
   * the caller's latest row is the one that wins.
   */
  async startVerification({ userParty, email }): Promise<KycStartResult> {
    const withUserToken = userTokenFlowEnabled();
    if (!withUserToken) {
      console.warn(
        '[hypersign] client_auth user-token flow DISABLED — set HYPERSIGN_ISSUER_DID + ' +
          'HYPERSIGN_ISSUER_VERIFICATION_METHOD_ID to include kycUserAccessToken. ' +
          'Falling back to admin-token-only widget URL (only valid while in-widget login is enabled).',
      );
    }

    // KYC admin token is always required.
    const kycAccessToken = await mintAccessToken(
      HYPERSIGN_API_SECRET_KEY,
      'access_service_kyc',
      'KYC',
    );

    // SSI admin token: REQUIRED for the client_auth user-token flow (steps
    // a–c); otherwise best-effort (the admin-token-only widget URL works with
    // just the KYC token + sessionId while in-widget login is enabled).
    let ssiAccessToken: string;
    if (withUserToken) {
      ssiAccessToken = await mintAccessToken(
        HYPERSIGN_SSI_API_SECRET_KEY,
        'access_service_ssi',
        'SSI',
      );
    } else {
      ssiAccessToken = await mintAccessToken(
        HYPERSIGN_SSI_API_SECRET_KEY,
        'access_service_ssi',
        'SSI',
      ).catch((err) => {
        console.warn('[hypersign] SSI token mint failed (continuing without it):', err);
        return '';
      });
    }

    const sessionId = await createSession(kycAccessToken);

    // Mint the per-session user token when in-widget login is disabled.
    let userAccessToken = '';
    if (withUserToken) {
      // client_auth requires an email up front (no in-widget login to collect
      // one). Callers pass it for internal users; Loop users without a stored
      // email can't use this path until an email is captured first.
      if (!email) {
        throw new Error(
          'hypersign_user_email_required: kycUserAccessToken flow needs an email ' +
            '(in-widget login is disabled)',
        );
      }
      const userDid = await createUserDid(ssiAccessToken);
      const didJwt = await issueDidJwt(ssiAccessToken, userDid, email);
      userAccessToken = await exchangeForUserToken(
        ssiAccessToken,
        kycAccessToken,
        didJwt,
        sessionId,
      );
    }

    const sessionUrl = buildWidgetUrl(kycAccessToken, ssiAccessToken, sessionId, userAccessToken);
    // Note: `userParty` is not sent to Hypersign — the webhook body omits any
    // reference, so we route it back purely via the stored sessionId.
    void userParty;
    return { inquiryId: sessionId, sessionUrl, templateRef: undefined, isNew: true };
  },

  verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean {
    // 1. Primary guard — the custom `x-api-token` header set in the Cavach
    //    webhook config. When we've configured its expected value, require a
    //    timing-safe match on every webhook.
    if (HYPERSIGN_WEBHOOK_API_TOKEN) {
      const raw = headers['x-api-token'];
      const got = Array.isArray(raw) ? raw[0] : raw;
      if (!got || !safeEqualStr(got, HYPERSIGN_WEBHOOK_API_TOKEN)) {
        console.warn('[hypersign] webhook x-api-token missing or mismatched');
        return false;
      }
    }

    let body: { idToken?: string };
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.warn('[hypersign] webhook body is not JSON — rejecting');
      return false;
    }
    const idToken = body.idToken;
    // Must at least be a structurally valid JWT credential.
    if (!idToken || idToken.split('.').length !== 3) {
      console.warn('[hypersign] webhook idToken missing or not a 3-part JWT — rejecting');
      return false;
    }

    // 2. Optional additional guard — the idToken's HS256 signature.
    if (HYPERSIGN_WEBHOOK_SECRET) {
      const ok = verifyJwtHs256(idToken, HYPERSIGN_WEBHOOK_SECRET);
      if (!ok) console.warn('[hypersign] webhook idToken HS256 signature mismatch');
      return ok;
    }

    // 3. Neither guard configured — reject. Accepting on idToken shape alone
    //    means anyone who can POST to this URL can approve a KYC for any
    //    session id they can guess, and the shape check ("three dot-separated
    //    parts") is trivially satisfied. Persona and Sumsub already fail
    //    closed on a missing secret; this now matches them.
    if (!HYPERSIGN_WEBHOOK_API_TOKEN) {
      console.warn('[hypersign] no HYPERSIGN_WEBHOOK_API_TOKEN / _SECRET set — rejecting webhook');
      return false;
    }
    return true;
  },

  parseWebhookEvent(rawBody: string): NormalizedKycEvent | null {
    let body: { idToken?: string; sessionId?: string; [k: string]: unknown };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const claims = body.idToken ? decodeJwtPayload(body.idToken) : null;
    // sessionId is our inquiry id; the claim is a fallback if the body omits it.
    const inquiryId =
      body.sessionId ?? (typeof claims?.sessionId === 'string' ? claims.sessionId : undefined);
    if (!inquiryId) return null;

    const statusRaw = extractStatus(body, claims);
    const { status, decision } = normalizeHypersignStatus(statusRaw);
    const terminal = status === 'approved' || status === 'declined';
    // The webhook body has no status field — Hypersign fires it only on
    // successful completion, so with no explicit marker we treat it as approved
    // (see normalizeHypersignStatus). Stamp completed_at from the idToken's
    // `iat` (issued-at, unix seconds) when present, else "now".
    const iat = typeof claims?.iat === 'number' ? claims.iat : null;
    const completedAt = terminal
      ? (iat ? new Date(iat * 1000).toISOString() : new Date().toISOString())
      : null;
    const rejectReason = status === 'declined' ? extractRejectReason(body, claims) : null;

    return {
      inquiryId,
      // Hypersign's body has no reference id; the generic handler resolves our
      // party id from the stored sessionId.
      referenceId: '',
      templateRef: undefined,
      status,
      decision,
      completedAt,
      rejectReason,
      eventName: statusRaw ? `hypersign.${statusRaw}` : 'hypersign.completed',
    };
  },

  /**
   * Webhook fallback (Step 4 of the integration guide): poll the consent status
   * for a session in one call.
   *   GET {KYC_TENANT_URL}/api/v2/consents/{sessionId}  header: x-kyc-access-token
   * Done → { data: { idToken } } (same idToken as the webhook, → approved event).
   * In progress → { data: [ {stepName,status,createdAt} ] } (an array → steps).
   */
  async getConsentStatus(
    inquiryId: string,
    referenceId: string,
  ): Promise<KycConsentStatus | null> {
    const kycAccessToken = await mintAccessToken(
      HYPERSIGN_API_SECRET_KEY,
      'access_service_kyc',
      'KYC',
    );
    const res = await fetch(
      `${HYPERSIGN_KYC_TENANT_URL}/api/v2/consents/${encodeURIComponent(inquiryId)}`,
      { method: 'GET', headers: { 'x-kyc-access-token': kycAccessToken, Accept: 'application/json' } },
    );
    if (!res.ok) return null; // 404 / error → nothing to report

    const j = (await res.json()) as {
      data?: { idToken?: string } | Array<Record<string, unknown>>;
    };
    const data = j?.data;

    // In-progress: `data` is an array of step objects.
    if (Array.isArray(data)) {
      const steps = data.map((s) => {
        const stepName = String(s.stepName ?? '');
        const status = String(s.status ?? '');
        const errorCode = typeof s.errorCode === 'number' ? s.errorCode : null;
        // Resolve the message: provider's own string first, then the documented
        // table by (stepName, errorCode). For a failed step whose code isn't in
        // the table (undocumented / new), fall back to a generic message so the
        // user still sees something meaningful rather than a bare code.
        let error =
          (s.error as string | undefined) || hypersignErrorMessage(stepName, errorCode) || null;
        if (!error && status.toLowerCase() === 'fail') {
          error =
            errorCode != null
              ? `Verification step failed (code ${errorCode})`
              : 'Verification step failed';
        }
        return {
          stepName,
          status,
          errorCode,
          error,
          createdAt: (s.createdAt as string | undefined) ?? null,
        };
      });
      return { done: false, event: null, steps };
    }

    // Done: `data` is an object carrying the idToken (⇒ approved, per webhook rule).
    const idToken = data?.idToken;
    if (!idToken) return { done: false, event: null, steps: [] };
    const claims = decodeJwtPayload(idToken);
    const iat = typeof claims?.iat === 'number' ? claims.iat : null;
    return {
      done: true,
      steps: [],
      event: {
        inquiryId,
        referenceId,
        templateRef: undefined,
        status: 'approved',
        decision: 'approved',
        completedAt: iat ? new Date(iat * 1000).toISOString() : new Date().toISOString(),
        rejectReason: null,
        eventName: 'hypersign.consent-sync',
      },
    };
  },
};
