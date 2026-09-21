/**
 * Referral graph: lookups, bind rules, and the reads the referral page needs.
 *
 * Everything is keyed on `party_id`, which is the identifier both user types
 * share (mperps users get one at signup, Loop users bring their own) and the
 * same key the exchange backend accounts by — so referral volume can be joined
 * later without an identity-mapping layer.
 */

import type { Pool, PoolClient } from 'pg';
import { DISPLAY_CONFIG_SQL } from '../db/mpointsConfig.js';
import { REFERRAL_LINK_BASE } from '../config.js';
import { isWellFormedCode, normalizeCode } from './codes.js';

type Db = Pool | PoolClient;

/** Why a bind was refused. Surfaced to the client as `error`. */
export type BindFailure =
  | 'invalid_code'      // malformed, unknown, or disabled
  | 'self_referral'     // the code belongs to the caller
  | 'already_bound';    // this user already has a referrer (immutable)

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
  /**
   * Whether the caller may attach a code. This is simply "not already bound":
   * there is NO deadline. Both user types can attach a referral code at any
   * point in their life, exactly once.
   */
  canBind: boolean;
  /**
   * Whether the app should actively PROMPT for a code (the first-connect
   * modal), as opposed to merely allowing one. True only for a still-new,
   * unbound account — see REFERRAL_PROMPT_HOURS. Purely a nagging control;
   * POST /referral/bind does not consult it.
   */
  showPrompt: boolean;
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
      showPrompt: false,
    };
  }

  const bound = row.referred_by_code !== null;

  // Binding is open to everyone, forever, until they use their one chance.
  // The only thing measured against account age is whether we volunteer the
  // modal — see showPrompt.
  // const promptUntil =
  //   row.created_at.getTime() + REFERRAL_PROMPT_HOURS * 3_600_000;

  return {
    myCode: row.my_code,
    referredByCode: row.referred_by_code,
    bound,
    canBind: !bound,
    showPrompt: false,
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
 * `source` records how the bind happened: signup (entered on the mperps
 * signup form, bound inside that transaction), self_service (entered later by
 * the user themselves, from the referral page or the first-connect modal —
 * either user type), or admin (the operator script).
 *
 * There is no time limit on any of these. The only rules are: the code must
 * resolve, it must not be the caller's own, and the caller must not already
 * have a referrer. The primary key on referrals enforces that last one even
 * if this function is bypassed.
 */
export async function bindReferral(
  db: Db,
  args: {
    refereePartyId: string;
    rawCode: string;
    source: 'signup' | 'self_service' | 'admin';
  },
): Promise<BindResult> {
  const { refereePartyId, rawCode, source } = args;

  const target = await lookupActiveCode(db, rawCode);
  if (!target) return { ok: false, reason: 'invalid_code' };
  if (target.ownerPartyId === refereePartyId) {
    return { ok: false, reason: 'self_referral' };
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
  const summary: ReferralSummary = {
    referredFriends: Number(res.rows[0]?.referred_friends ?? '0'),
    totalVolume: null,
    totalRewards: null,
    friendsWhoTraded: null,
  };

  // Volume / rewards come from the mpoints-service tables (shared Postgres).
  // Stay null — never 0 — when the service isn't provisioned on this DB or no
  // competition is active, so the UI keeps rendering "—" rather than "0".
  try {
    const mp = await db.query<{ volume: string; points: string; traded: string }>(
      `WITH cfg AS (${DISPLAY_CONFIG_SQL})
       SELECT COALESCE(t.total_volume, 0)::text AS volume,
              COALESCE(t.total_points, 0)::text AS points,
              (SELECT COUNT(DISTINCT a.referee_party_id)
                 FROM mp_referral_attribution a
                WHERE a.referrer_party_id = $1 AND a.volume > 0
                  AND a.day >= (cfg.start_at AT TIME ZONE 'UTC')::date
                  AND a.day <  (cfg.end_at   AT TIME ZONE 'UTC')::date)::text AS traded
         FROM cfg
         LEFT JOIN mp_points_total t ON t.party_id = $1 AND t.config_id = cfg.id AND t.source = 'trade_referral'`,
      [partyId],
    );
    const row = mp.rows[0];
    if (row) {
      summary.totalVolume = Math.round(Number(row.volume) * 100) / 100;
      summary.totalRewards = Math.round(Number(row.points) * 100) / 100;
      summary.friendsWhoTraded = Number(row.traded);
    }
  } catch (err) {
    if (!/relation "mp_/.test((err as Error).message ?? '')) throw err;
  }
  return summary;
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

  // Per-friend volume + the points that friend earned this referrer.
  //
  // mp_referral_attribution holds the referee's volume per day; summed over
  // the active competition window it is exactly what that one friend
  // contributed. Points are then derived with the SAME formula the points
  // service uses — volume / referral_volume_unit * referral_points_per_unit —
  // so the per-friend column adds up to the aggregate shown above it rather
  // than being computed a second, subtly different way.
  //
  // Left null (not 0) when the points service isn't provisioned here or no
  // competition is active, matching getPointsSummary.
  const contributions = new Map<string, { volume: number; points: number }>();
  if (page.length > 0) {
    try {
      const mp = await db.query<{
        referee_party_id: string;
        volume: string;
        points: string;
      }>(
        `WITH cfg AS (
           SELECT id, start_at, end_at, referral_volume_unit, referral_points_per_unit
             FROM mp_competition_config
            WHERE status = 'active'
            ORDER BY id DESC
            LIMIT 1
         )
         SELECT a.referee_party_id,
                SUM(a.volume)::text AS volume,
                (SUM(a.volume) / cfg.referral_volume_unit
                   * cfg.referral_points_per_unit)::text AS points
           FROM mp_referral_attribution a
           CROSS JOIN cfg
          WHERE a.referrer_party_id = $1
            AND a.referee_party_id = ANY($2::text[])
            AND a.day >= (cfg.start_at AT TIME ZONE 'UTC')::date
            AND a.day <  (cfg.end_at   AT TIME ZONE 'UTC')::date
          GROUP BY a.referee_party_id, cfg.referral_volume_unit, cfg.referral_points_per_unit`,
        [partyId, page.map((r) => r.referee_party_id)],
      );
      for (const row of mp.rows) {
        contributions.set(row.referee_party_id, {
          volume: Math.round(Number(row.volume) * 100) / 100,
          points: Math.round(Number(row.points) * 100) / 100,
        });
      }
    } catch (err) {
      if (!/relation "mp_/.test((err as Error).message ?? '')) throw err;
    }
  }

  // A friend with an attribution row but no trades shows 0, which is true.
  // A friend with no row at all under an active competition has contributed
  // nothing yet — also 0. Only an absent points service yields null.
  const serviceLive = contributions.size > 0;

  return {
    friends: page.map((r) => {
      const c = contributions.get(r.referee_party_id);
      return {
        partyId: r.referee_party_id,
        joinedAt: r.bound_at.toISOString(),
        volume: c ? c.volume : serviceLive ? 0 : null,
        points: c ? c.points : serviceLive ? 0 : null,
      };
    }),
    nextCursor: hasMore ? page[page.length - 1].bound_at.toISOString() : null,
  };
}
