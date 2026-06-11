/**
 * Provider-agnostic KYC abstraction.
 *
 * The app integrates with ONE KYC provider at a time (chosen by the
 * `KYC_PROVIDER` env var), but the DB schema and the /kyc routes are generic.
 * Each concrete provider (Persona, Sumsub, …) implements `KycProvider` and
 * normalizes its own lifecycle into the shared status/decision vocabulary
 * below, so the routes + `kyc_inquiries` table never need provider-specific
 * branching.
 *
 * Column mapping in `kyc_inquiries` (generic):
 *   provider      → 'persona' | 'sumsub'
 *   inquiry_id    → the provider's primary record id
 *                   (Persona inquiry id `inq_…` / Sumsub applicantId)
 *   reference_id  → our Canton party id
 *                   (Persona `reference-id` / Sumsub `externalUserId`)
 *   template_id   → the verification template/level
 *                   (Persona inquiry-template / Sumsub levelName)
 *   status        → normalized KycStatus
 *   decision      → normalized KycDecision
 */

export type KycProviderName = 'persona' | 'sumsub';

/** Normalized lifecycle status (what `kyc_inquiries.status` holds). */
export type KycStatus =
  | 'created'
  | 'pending'
  | 'completed'
  | 'approved'
  | 'declined'
  | 'needs_review'
  | 'expired'
  | 'failed'
  | 'redacted';

/** Normalized decision (what `kyc_inquiries.decision` holds). */
export type KycDecision = 'approved' | 'declined' | 'needs_review' | null;

/** Terminal statuses — the user is done; /kyc/start returns 409. */
export const KYC_TERMINAL_STATUSES = new Set<string>(['approved']);

/**
 * Resumable statuses — /kyc/start resumes the SAME inquiry (provider mints a
 * fresh session URL) rather than creating a new one. `declined` is NOT here:
 * a retry creates a fresh attempt. `redacted` is NOT here: the record is gone.
 */
export const KYC_RESUMABLE_STATUSES = new Set<string>([
  'created',
  'pending',
  'completed',
  'needs_review',
  'expired',
  'failed',
]);

/** Result of starting/resuming a verification. */
export interface KycStartResult {
  /** Provider's primary record id (stored as `inquiry_id`). */
  inquiryId: string;
  /** URL the frontend opens to run the hosted/SDK verification flow. */
  sessionUrl: string;
  /** Template/level used (stored as `template_id`), if known. */
  templateRef?: string;
  /** True if a brand-new record was created (vs resumed). */
  isNew: boolean;
}

/** A webhook event normalized into the shared vocabulary. */
export interface NormalizedKycEvent {
  /** Provider's primary record id. */
  inquiryId: string;
  /** Our Canton party id (provider echoes this back). */
  referenceId: string;
  /** Provider's template/level, if present on the event. */
  templateRef?: string;
  status: KycStatus | string;
  decision: KycDecision;
  completedAt: string | null;
  /** Human-readable rejection reason (provider moderation/client comment). */
  rejectReason?: string | null;
  /** True when a declined verification may be resubmitted (provider RETRY). */
  resubmitAllowed?: boolean;
  /** Raw provider event name, for the audit log. */
  eventName: string;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

/**
 * One KYC provider integration. Implementations live in `persona.ts`,
 * `sumsub.ts`, … and are selected by `getActiveProvider()` (kyc/index.ts).
 */
export interface KycProvider {
  readonly name: KycProviderName;

  /**
   * Start or resume verification for `userParty`.
   *   - `existingInquiryId` is passed when the user's latest record is in a
   *     resumable state; providers that support resume reuse it, others
   *     ignore it and (re)issue a fresh session for the same subject.
   *   - `email`, when supplied, is pre-set on the provider's record so the
   *     hosted/SDK flow shows it pre-filled and non-editable (the user only
   *     completes the OTP step). We pass it for validator users (their email
   *     is already known + verified in our DB); Loop users have no stored
   *     email, so we omit it and let the provider collect + verify a fresh one.
   * Returns the record id + a URL the frontend opens.
   */
  startVerification(args: {
    userParty: string;
    existingInquiryId?: string;
    email?: string;
  }): Promise<KycStartResult>;

  /** Verify a webhook's signature over the EXACT raw bytes received. */
  verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean;

  /** Parse a webhook body into a normalized event, or null to ignore it. */
  parseWebhookEvent(rawBody: string): NormalizedKycEvent | null;

  /**
   * Fetch the contact email the provider has on file for a record, if any.
   * Used to capture a Loop user's provider-collected + OTP-verified email
   * back into our DB. Optional — providers that don't expose it omit it.
   */
  fetchContactEmail?(inquiryId: string): Promise<string | null>;
}
