/**
 * Featured App Activity Markers (CIP-0047 / CIP-0078).
 *
 * A `FeaturedAppActivityMarker` is how a featured app claims credit for an
 * economically meaningful on-chain action. SV automation converts markers
 * into `AppRewardCoupon`s, which mint Canton Coin for the named beneficiaries.
 *
 * Two facts drive the entire design of this module:
 *
 *  1. **`FeaturedAppRight` IS the featuring.** The DSO creates that contract
 *     for our provider party when the Canton Foundation approves the
 *     featured-app application. Before approval the contract does not exist,
 *     so there is nothing to exercise — you cannot "emit markers now and
 *     collect the rewards later". This module therefore resolves the right at
 *     submit time and simply does nothing until it shows up.
 *
 *  2. **The marker must be in the SAME transaction as the action it marks.**
 *     A follow-up transaction is explicitly not allowed (nor is marking an
 *     intermediate/propose step, nor internal bookkeeping). Canton executes
 *     every command in one `submitCommand` call as a single atomic
 *     transaction, so the marker rides as a second root command alongside the
 *     transfer. The choice's controller is `provider`, which is why that party
 *     must be added to `actAs`.
 *
 * The consequence of (1) + (2) is the safety rule for this file: a marker
 * command referencing a contract that does not exist would fail the whole
 * transaction and take the user's withdrawal down with it. So **every path
 * here fails open** — any problem resolving the right means "no marker", never
 * "no transfer". A missed reward is worth immeasurably less than a stuck
 * withdrawal.
 *
 * Ops prerequisite: the operator's Canton user needs `CanActAs` on
 * `parties.nodeOperator`, otherwise the enriched submission is rejected. That
 * is the one misconfiguration that could break a withdrawal, so we verify the
 * right explicitly before ever adding the party to `actAs` — a missing grant
 * yields no marker instead of a failed payout. Until that grant exists (and
 * until CF approves), this module stays dormant and withdrawals submit exactly
 * as they do today.
 */
import type { CantonSdkConfig } from './config.js';
import {
  CHOICE_CREATE_ACTIVITY_MARKER,
  IFACE_FEATURED_APP_RIGHT,
} from './config.js';
import { getActiveContracts, listUserRights, type LedgerCommand } from './ledger.js';

/**
 * Party that should receive the minted rewards. Defaults to the provider
 * itself, which is the sane choice: the node operator party is a Splice
 * wallet user, so its validator automation collects `AppRewardCoupon`s
 * without any extra onboarding. Override only if rewards should land
 * elsewhere — and only on a party that has a wallet, or the coupons expire
 * uncollected.
 */
const BENEFICIARY_OVERRIDE = process.env.ACTIVITY_MARKER_BENEFICIARY_PARTY_ID || '';

/** Re-check for the right this often once we've found it. */
const HIT_TTL_MS = 15 * 60_000;
/** Re-check this often while it's still absent (i.e. pre-approval). Short
 *  enough that the day CF grants the right we start marking on our own. */
const MISS_TTL_MS = 5 * 60_000;

interface Resolved {
  cid: string;
  provider: string;
}

let cached: Resolved | null = null;
let cachedAt = 0;
let cachedMiss = false;

/** Drop the memoised lookup — used by tests and after a known revocation. */
export function resetFeaturedAppRightCache(): void {
  cached = null;
  cachedAt = 0;
  cachedMiss = false;
}

/**
 * Find our `FeaturedAppRight` in the ACS, or null.
 *
 * Null is the normal, expected answer until the Canton Foundation approves
 * the application — it is not an error and must never be logged as one.
 * The contract is DSO-signed with `provider` as an observer, so it lands in
 * our own participant's ACS; no disclosed contracts are involved.
 */
export async function resolveFeaturedAppRight(
  config: CantonSdkConfig,
  opToken: string,
  opUserId: string,
): Promise<Resolved | null> {
  const provider = config.parties.nodeOperator;
  if (!provider) return null; // markers disabled — NODE_OPERATOR_PARTY_ID unset

  const ttl = cachedMiss ? MISS_TTL_MS : HIT_TTL_MS;
  if (Date.now() - cachedAt < ttl) return cached;

  try {
    // Pre-flight the authorization BEFORE we go looking for the contract.
    // Without CanActAs(provider) the enriched submission is rejected outright,
    // which would fail the transfer this marker is meant to decorate.
    const rights = await listUserRights(config, opToken, opUserId);
    if (!rights.actAs.includes(provider)) {
      console.warn(
        `[featuredApp] no CanActAs(${provider.split('::')[0]}) for the operator user — marker disabled`,
      );
      cached = null;
      cachedAt = Date.now();
      cachedMiss = true;
      return null;
    }

    const contracts = await getActiveContracts(
      config,
      opToken,
      provider,
      { interfaceId: IFACE_FEATURED_APP_RIGHT },
    );
    const match = contracts.find((c) => {
      const view = (c.interfaceView ?? c.payload) as { provider?: string };
      return view.provider === provider;
    });
    cached = match ? { cid: match.contractId, provider } : null;
  } catch (e) {
    // Reading the ACS as `provider` fails until CanActAs/CanReadAs is granted.
    // That's an ops gap, not a withdrawal problem — degrade silently.
    console.warn(`[featuredApp] right lookup failed (no marker): ${(e as Error).message}`);
    cached = null;
  }

  cachedAt = Date.now();
  cachedMiss = cached === null;
  return cached;
}

/**
 * Build the marker command to append to a value-moving submission, or null
 * when we aren't featured (yet).
 *
 * Caller contract: if this returns non-null, push `command` onto the same
 * `commands` array as the transfer AND add `provider` to `actAs`. Doing one
 * without the other produces a rejected submission.
 *
 * v1 of the API has no per-marker `weight`, so one call = one unit of
 * activity regardless of notional. Emit exactly one marker per user-facing
 * economic event — never one per leg of a multi-leg payout.
 */
export async function buildActivityMarkerCommand(
  config: CantonSdkConfig,
  opToken: string,
  opUserId: string,
): Promise<{ command: LedgerCommand; provider: string } | null> {
  const right = await resolveFeaturedAppRight(config, opToken, opUserId);
  if (!right) return null;

  const beneficiary = BENEFICIARY_OVERRIDE || right.provider;

  return {
    provider: right.provider,
    command: {
      ExerciseCommand: {
        templateId: IFACE_FEATURED_APP_RIGHT,
        contractId: right.cid,
        choice: CHOICE_CREATE_ACTIVITY_MARKER,
        // Weights must be > 0 and sum to 1.0. A single beneficiary at 1.0 is
        // unambiguous; an empty list would sum to 0 and be rejected.
        choiceArgument: { beneficiaries: [{ beneficiary, weight: '1.0' }] },
      },
    },
  };
}
