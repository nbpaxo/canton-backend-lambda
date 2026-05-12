/**
 * Persona Sandbox API client + webhook signature verification.
 *
 * Persona webhooks include an HMAC-SHA256 signature in the
 * `Persona-Signature` header, computed over the raw request body using the
 * webhook secret. See: https://docs.withpersona.com/docs/webhooks-signing
 *
 * Inquiry creation: https://docs.withpersona.com/reference/create-an-inquiry
 *   POST /api/v1/inquiries
 *   Authorization: Bearer <PERSONA_API_KEY>
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PERSONA_API_BASE,
  PERSONA_API_KEY,
  PERSONA_TEMPLATE_ID,
  PERSONA_WEBHOOK_SECRET,
} from '../config.js';

export interface CreateInquiryArgs {
  /** Our reference id — Persona echoes this back in webhook events. */
  referenceId: string;
  /** Optional pre-fill fields (Persona expects snake_case nested under attributes.fields). */
  fields?: Record<string, unknown>;
}

export interface PersonaInquiry {
  id: string;                              // inq_xxxxxxxxxxxx
  attributes: {
    status: string;
    'reference-id'?: string;
    'created-at': string;
  };
}

/**
 * Create a new Persona inquiry. Returns the inquiry id + status; the
 * frontend then opens the Persona embedded flow with that inquiry id.
 */
export async function createInquiry(args: CreateInquiryArgs): Promise<PersonaInquiry> {
  if (!PERSONA_API_KEY) throw new Error('PERSONA_API_KEY not set');
  if (!PERSONA_TEMPLATE_ID) throw new Error('PERSONA_TEMPLATE_ID not set');

  const res = await fetch(`${PERSONA_API_BASE}/inquiries`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PERSONA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      data: {
        attributes: {
          'inquiry-template-id': PERSONA_TEMPLATE_ID,
          'reference-id': args.referenceId,
          ...(args.fields ? { fields: args.fields } : {}),
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Persona createInquiry failed (${res.status}): ${await res.text()}`);
  }

  const body = (await res.json()) as { data: PersonaInquiry };
  return body.data;
}

/**
 * Verify a Persona webhook signature.
 *
 * Persona sends `Persona-Signature: t=<unix>,v1=<hex>` where v1 is
 * `HMAC-SHA256(secret, "<t>.<rawBody>")`. We re-compute and compare with
 * a timing-safe equality check.
 *
 * Returns true if signature is valid, false otherwise (header missing,
 * malformed, wrong secret, body tampered).
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!PERSONA_WEBHOOK_SECRET) {
    console.warn('[persona] PERSONA_WEBHOOK_SECRET not set — rejecting webhook');
    return false;
  }
  if (!signatureHeader) return false;

  // Parse header: comma-separated key=value pairs.
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((s) => {
      const [k, v] = s.split('=');
      return [k?.trim() ?? '', v?.trim() ?? ''];
    }),
  ) as Record<string, string>;
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  const expected = createHmac('sha256', PERSONA_WEBHOOK_SECRET)
    .update(`${t}.${rawBody}`)
    .digest('hex');

  if (expected.length !== v1.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Normalize Persona's lifecycle event name → our `kyc_inquiries.status`
 * column. Persona ships many event names; we coalesce to a short list.
 *
 * Event names: https://docs.withpersona.com/reference/event-types
 */
export function normalizeEventStatus(eventName: string): {
  status: string;
  decision: string | null;
} {
  switch (eventName) {
    case 'inquiry.created':            return { status: 'created',      decision: null };
    case 'inquiry.started':            return { status: 'pending',      decision: null };
    case 'inquiry.completed':          return { status: 'completed',    decision: null };
    case 'inquiry.approved':           return { status: 'approved',     decision: 'approved' };
    case 'inquiry.declined':           return { status: 'declined',     decision: 'declined' };
    case 'inquiry.marked-for-review':
    case 'inquiry.needs-review':       return { status: 'needs_review', decision: 'needs_review' };
    case 'inquiry.expired':            return { status: 'expired',      decision: null };
    case 'inquiry.transitioned':       return { status: 'pending',      decision: null };
    default:                           return { status: eventName.replace(/^inquiry\./, ''), decision: null };
  }
}
