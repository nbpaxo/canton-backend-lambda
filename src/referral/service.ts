/**
 * Referral graph: lookups, bind rules, and the reads the referral page needs.
 *
 * Everything is keyed on `party_id`, which is the identifier both user types
 * share (mperps users get one at signup, Loop users bring their own) and the
 * same key the exchange backend accounts by — so referral volume can be joined
 * later without an identity-mapping layer.
 */

import type { Pool, PoolClient } from 'pg';
import { REFERRAL_BIND_WINDOW_HOURS, REFERRAL_LINK_BASE } from '../config.js';
import { isWellFormedCode, normalizeCode } from './codes.js';

type Db = Pool | PoolClient;

/** Why a bind was refused. Surfaced to the client as `error`. */
export type BindFailure =
  | 'invalid_code'      // malformed, unknown, or disabled
  | 'self_referral'     // the code belongs to the caller
  | 'already_bound'     // this user already has a referrer (immutable)
  | 'window_closed'     // past the post-connect window
  | 'not_eligible';     // wrong user type for this bind path

export type BindResult =
  | { ok: true; code: string; referrerPartyId: string }
  | { ok: false; reason: BindFailure };

export interface ReferralState {
  /** Code the caller shares. Null until they've visited the referral page. */
  myCode: string | null;
  /** Code the caller was referred BY, if any. */
  referredByCode: string | null;
  /** True once a referrer is attached — permanent. */
  bound: boolean;
  /** Whether the caller may still attach a code right now. */
  canBind: boolean;
  /** When the bind window shuts. Null for users with no window concept. */
  windowExpiresAt: string | null;
}

/** Resolve a raw user-supplied code to its owner. Null when unusable. */
export async function lookupActiveCode(
  db: Db,
  rawCode: string,
): Promise<{ code: string; ownerPartyId: string } | null> {
  const code = normalizeCode(rawCode);
  if (!isWellFormedCode(code)) return null;

  const res = await db.query<{ code: string; owner_party_id: string }>(
    `SELECT code, owner_party_id FROM referral_codes
      WHERE code = $1 AND status = 'active'
      LIMIT 1`,
    [code],
  );
  const row = res.rows[0];
  return row ? { code: row.code, ownerPartyId: row.owner_party_id } : null;
}

/** The shareable link for a code. */
export function referralLink(code: string): string {
  return `${REFERRAL_LINK_BASE}/?ref=${encodeURIComponent(code)}`;
}

/**
 * Current referral state for one user.
 *
 * The window is measured from `users.created_at`. For Loop users that is the
 * moment they first reached an authenticated endpoint after connecting — the
 * closest thing we have to "first wallet connect", and the anchor the product
 * rule is defined against. mperps users bind during signup instead, so they
 * get `canBind: false` and a null window: there is no post-hoc path for them.
 */
export async function getReferralState(
  db: Db,
  partyId: string,
): Promise<ReferralState> {
  const res = await db.query<{
    is_external: boolean;
    created_at: Date;
    my_code: string | null;
    referred_by_code: string | null;
  }>(
    `SELECT u.is_external,
            u.created_at,
            (SELECT rc.code FROM referral_codes rc
              WHERE rc.owner_party_id = u.party_id
                AND rc.status = 'active'
              LIMIT 1)                                    AS my_code,
            (SELECT r.code FROM referrals r
              WHERE r.referee_party_id = u.party_id
                AND r.status = 'active'
              LIMIT 1)                                    AS referred_by_code
       FROM users u
      WHERE u.party_id = $1`,
    [partyId],
  );

  const row = res.rows[0];
  if (!row) {
    return {
      myCode: null,
      referredByCode: null,
      bound: false,
      canBind: false,
      windowExpiresAt: null,
    };
  }

  const bound = row.referred_by_code !== null;

  // Only Loop users have a window; mperps users bind at signup.
  if (!row.is_external) {
    return {
      myCode: row.my_code,
      referredByCode: row.referred_by_code,
      bound,
      canBind: false,
      windowExpiresAt: null,
    };
  }

  const expiresAt = new Date(
    row.created_at.getTime() + REFERRAL_BIND_WINDOW_HOURS * 3_600_000,
  );

  return {
    myCode: row.my_code,
    referredByCode: row.referred_by_code,
    bound,
    canBind: !bound && expiresAt.getTime() > Date.now(),
    windowExpiresAt: expiresAt.toISOString(),
  };
}

/**
 * Attach a referrer to a user.
 *
 * Every rule is re-checked here even though the UI checks them too — the UI's
 * copy is a convenience and this is the control. The DB backs the two that
 * matter most regardless of what this function does: `referrals`' primary key
 * makes a second bind impossible, and the CHECK constraint blocks a self-
 * referral, so a race between two concurrent binds ends in a conflict rather
 * than a duplicate row.
 *
 * `source` distinguishes the three call sites: signup (mperps, inside the
 * signup transaction), loop_window (Loop users, window-gated), and admin
 * (the backfill script, which bypasses the window but nothing else).
 */
export async function bindReferral(
  db: Db,
  args: {
    refereePartyId: string;
    rawCode: string;
    source: 'signup' | 'loop_window' | 'admin';
  },
): Promise<BindResult> {
  const { refereePartyId, rawCode, source } = args;

  const target = await lookupActiveCode(db, rawCode);
  if (!target) return { ok: false, reason: 'invalid_code' };
  if (target.ownerPartyId === refereePartyId) {
    return { ok: false, reason: 'self_referral' };
  }

  // Window + eligibility apply only to the self-service Loop path. `signup`
  // binds inside a transaction that is creating the user right now, and
  // `admin` is a deliberate operator override.
  if (source === 'loop_window') {
    const state = await getReferralState(db, refereePartyId);
    if (state.bound) return { ok: false, reason: 'already_bound' };
    if (state.windowExpiresAt === null) return { ok: false, reason: 'not_eligible' };
    if (!state.canBind) return { ok: false, reason: 'window_closed' };
  }

  // The conflict target is the primary key, so this is the point where
  // "one referrer per user, ever" is actually enforced.
  //
  // The DO UPDATE ... WHERE status = 'revoked' clause is load-bearing: an
  // operator who unbinds a user leaves a revoked row behind, and that row
  // still occupies the primary key. Without this, `unbind` would be a one-way
  // door — the user could never be re-bound, and getReferralState would report
  // `bound: false` while every bind attempt failed with already_bound.
  //
  // An ACTIVE row still matches no WHERE and returns nothing, so a live
  // referral remains immutable and a race between two binds still ends with
  // exactly one winner.
  const inserted = await db.query<{ referee_party_id: string }>(
    `INSERT INTO referrals
        (referee_party_id, referrer_party_id, code, bind_source)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (referee_party_id) DO UPDATE
         SET referrer_party_id = EXCLUDED.referrer_party_id,
             code              = EXCLUDED.code,
             bind_source       = EXCLUDED.bind_source,
             bound_at          = NOW(),
             status            = 'active',
             revoked_at        = NULL,
             revoked_reason    = NULL
       WHERE referrals.status = 'revoked'
      RETURNING referee_party_id`,
    [refereePartyId, target.ownerPartyId, target.code, source],
  );

  // No row means an ACTIVE referral already existed — either a genuine second
  // attempt or the loser of a race. Both are `already_bound`.
  if (!inserted.rows[0]) return { ok: false, reason: 'already_bound' };

  return { ok: true, code: target.code, referrerPartyId: target.ownerPartyId };
}

// ─── Reads for the referral page ─────────────────────────────────────────

export interface ReferralSummary {
  referredFriends: number;
  /**
   * Populated once per-user trading volume is available from the exchange
   * backend. Null (not 0) so the UI can render "—" rather than assert that a
   * referrer has earned nothing.
   */
  totalVolume: number | null;
  totalRewards: number | null;
  friendsWhoTraded: number | null;
}

export async function getSummary(db: Db, partyId: string): Promise<ReferralSummary> {
  const res = await db.query<{ referred_friends: string }>(
    `SELECT COUNT(*)::text AS referred_friends
       FROM referrals
      WHERE referrer_party_id = $1 AND status = 'active'`,
    [partyId],
  );
  return {
    referredFriends: Number(res.rows[0]?.referred_friends ?? '0'),
    totalVolume: null,
    totalRewards: null,
    friendsWhoTraded: null,
  };
}

export interface InviterInfo {
  partyId: string;
  code: string;
  boundAt: string;
}

/** Who referred the caller — the "Inviter" block on the referral page. */
export async function getInviter(
  db: Db,
  partyId: string,
): Promise<InviterInfo | null> {
  const res = await db.query<{
    referrer_party_id: string;
    code: string;
    bound_at: Date;
  }>(
    `SELECT referrer_party_id, code, bound_at
       FROM referrals
      WHERE referee_party_id = $1 AND status = 'active'
      LIMIT 1`,
    [partyId],
  );
  const row = res.rows[0];
  return row
    ? {
        partyId: row.referrer_party_id,
        code: row.code,
        boundAt: row.bound_at.toISOString(),
      }
    : null;
}

export interface ReferredFriend {
  partyId: string;
  joinedAt: string;
  volume: number | null;
  points: number | null;
}

/**
 * The caller's referred friends, newest first.
 *
 * Keyset pagination on `bound_at` rather than OFFSET: a referrer who is
 * actively gaining referrals would see rows shift between pages under OFFSET,
 * and the (referrer_party_id, bound_at DESC) index serves this directly.
 *
 * `joinedAt` is `bound_at` — when they joined VIA this referrer — not the
 * referee's own account creation date.
 */
export async function listReferredFriends(
  db: Db,
  partyId: string,
  opts: { limit: number; before?: string },
): Promise<{ friends: ReferredFriend[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);

  const res = await db.query<{ referee_party_id: string; bound_at: Date }>(
    `SELECT referee_party_id, bound_at
       FROM referrals
      WHERE referrer_party_id = $1
        AND status = 'active'
        AND ($2::timestamptz IS NULL OR bound_at < $2)
      ORDER BY bound_at DESC
      LIMIT $3`,
    [partyId, opts.before ?? null, limit + 1],
  );

  const hasMore = res.rows.length > limit;
  const page = hasMore ? res.rows.slice(0, limit) : res.rows;

  return {
    friends: page.map((r) => ({
      partyId: r.referee_party_id,
      joinedAt: r.bound_at.toISOString(),
      volume: null,
      points: null,
    })),
    nextCursor: hasMore ? page[page.length - 1].bound_at.toISOString() : null,
  };
}
