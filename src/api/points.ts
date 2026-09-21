/**
 * mPoints endpoints — the read surface for the trading-volume competition UI.
 *
 *   GET /points/me              the caller's totals for the active competition,
 *                               grand total + per-source breakdown
 *   GET /points/me/daily        the caller's per-day personal/referral points
 *                               (chart), with a provisional flag per day
 *   GET /points/leaderboard     top N parties by total points + the caller's
 *                               own rank / movement / gap to the next rank
 *   GET /points/me/referrals    the caller's referral code + link, friends
 *                               joined/traded, and what each friend earned them
 *
 * All routes read the mp_* tables written by the standalone mpoints-service in
 * the shared Postgres; this router never writes. Every response carries
 * `dataStatus` ('complete' | 'provisional') so the client knows whether the
 * numbers are settled or the service is still catching up.
 *
 * Identity is always `req.user.party` from requireAuth — the client never
 * supplies a party id. Other parties on the leaderboard are MASKED (see
 * maskParty) so the board never leaks full Canton party ids.
 */

import { Router, Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getPool } from '../db/pool.js';
import { getOrCreateCode } from '../referral/codes.js';
import { referralLink } from '../referral/service.js';
import { displayConfig, type DisplayConfig } from '../db/mpointsConfig.js';

const router = Router();

// ─── Shared helpers ───────────────────────────────────────────────────────

type DataStatus = 'complete' | 'provisional';

const round2 = (x: number) => Math.round(x * 100) / 100;

// `active` in every response = the shown competition is RUNNING now. Between
// seasons the last ended one is still shown (active: false, phase: 'ended').
const activeConfig = displayConfig;
const competitionJson = (c: DisplayConfig) => ({
  id: c.id, name: c.name, startAt: c.startAt.toISOString(), endAt: c.endAt.toISOString(), phase: c.phase, settled: c.settled,
});

/** 'provisional' while the trade sync has never caught up or work is still queued. */
async function dataStatus(pool: Pool): Promise<DataStatus> {
  const h = (
    await pool.query<{ caught_up_at: Date | null; dirty: string; pending: string }>(
      `SELECT (SELECT caught_up_at FROM mp_sync_state WHERE sync_key = 'trade') AS caught_up_at,
              (SELECT COUNT(*)::text FROM mp_dirty_days) AS dirty,
              (SELECT COUNT(*)::text FROM mp_trades WHERE aggregated_at IS NULL AND skip_reason IS NULL) AS pending`,
    )
  ).rows[0];
  const backlog = Number(h?.dirty ?? 0) + Number(h?.pending ?? 0);
  return !h?.caught_up_at || backlog > 0 ? 'provisional' : 'complete';
}

/**
 * Mask a Canton party id for display next to other users: keep the human hint
 * and the first/last 4 chars of the fingerprint. `alice::1220abcd…ef01`.
 * Never applied to the caller's own row.
 */
function maskParty(party: string): string {
  const i = party.indexOf('::');
  if (i < 0) return party.length > 12 ? `${party.slice(0, 6)}…${party.slice(-4)}` : party;
  const hint = party.slice(0, i);
  const fp = party.slice(i + 2);
  return fp.length > 12 ? `${hint}::${fp.slice(0, 4)}…${fp.slice(-4)}` : party;
}

/** mp_* tables absent = the points service hasn't been provisioned on this DB yet → 503, not 500. */
function pointsErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const msg = (err as Error)?.message ?? '';
  if (/relation "mp_/.test(msg)) {
    res.status(503).json({ error: 'points_unavailable', message: 'Points service is not initialised.' });
    return;
  }
  next(err);
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// ─── GET /points/me ───────────────────────────────────────────────────────

router.get('/points/me', requireAuth, wrap(async (req, res) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();
  const cfg = await activeConfig(pool);
  if (!cfg) {
    return res.json({
      active: false, competition: null,
      totalPoints: 0, personalPoints: 0, referralPoints: 0, bySource: {},
      dataStatus: 'no_active_competition', asOf: null,
    });
  }

  const totals = await pool.query<{ source: string; total_volume: string; total_points: string; updated_at: Date }>(
    `SELECT source, total_volume::text, total_points::text, updated_at
       FROM mp_points_total WHERE party_id = $1 AND config_id = $2`,
    [party, cfg.id],
  );
  const bySource: Record<string, { volume: number; points: number }> = {};
  let totalPoints = 0;
  let asOf: Date | null = null;
  for (const r of totals.rows) {
    const points = Number(r.total_points);
    bySource[r.source] = { volume: Number(r.total_volume), points };
    totalPoints += points;
    if (!asOf || r.updated_at > asOf) asOf = r.updated_at;
  }

  res.json({
    active: cfg.phase === 'running',
    competition: competitionJson(cfg),
    totalPoints: round2(totalPoints),
    personalPoints: round2(bySource.trade_personal?.points ?? 0),
    referralPoints: round2(bySource.trade_referral?.points ?? 0),
    bySource,
    dataStatus: await dataStatus(pool),
    asOf: asOf ? asOf.toISOString() : null,
  });
}));

// ─── GET /points/me/daily ─────────────────────────────────────────────────
//
// One row per day the caller earned anything, ascending. A day is `finalized`
// once the service has stamped it (FINALIZE_AFTER_HOURS after it closed);
// until then the UI should render it as provisional — it may still move.

router.get('/points/me/daily', requireAuth, wrap(async (req, res) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();
  const cfg = await activeConfig(pool);
  if (!cfg) return res.json({ active: false, competition: null, days: [], dataStatus: 'no_active_competition' });

  // `finalized` is per competition: the points rows themselves carry the stamp.
  const rows = await pool.query<{ day: string; personal: string; referral: string; finalized: boolean }>(
    `SELECT d.day::text AS day,
            COALESCE(SUM(d.points) FILTER (WHERE d.source = 'trade_personal'), 0)::text AS personal,
            COALESCE(SUM(d.points) FILTER (WHERE d.source = 'trade_referral'), 0)::text AS referral,
            COALESCE(BOOL_AND(d.finalized_at IS NOT NULL), FALSE) AS finalized
       FROM mp_points_daily d
      WHERE d.party_id = $1 AND d.config_id = $2
      GROUP BY d.day
      ORDER BY d.day`,
    [party, cfg.id],
  );

  res.json({
    active: cfg.phase === 'running',
    competition: competitionJson(cfg),
    days: rows.rows.map((r) => ({
      day: r.day, personal: round2(Number(r.personal)), referral: round2(Number(r.referral)), finalized: r.finalized,
    })),
    dataStatus: await dataStatus(pool),
  });
}));

// ─── GET /points/leaderboard?limit=10 ─────────────────────────────────────
//
// Ranked by total points across all sources (dense rank: ties share a rank).
// The caller's row is included in `rows` if it is inside the top N; `me`
// always carries the caller's own rank so the UI can show "#12 of 1,437" even
// when they are outside the list. `rankDelta` is movement since the previous
// UTC day's snapshot of totals — 0 when there is no snapshot to compare yet.

router.get('/points/leaderboard', requireAuth, wrap(async (req, res) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();
  const cfg = await activeConfig(pool);
  if (!cfg) return res.json({ active: false, competition: null, rows: [], me: null, dataStatus: 'no_active_competition' });

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 10;

  const ranked = await pool.query<{
    rank: string; party_id: string; volume: string; personal: string; referral: string; total: string; n: string;
  }>(
    `WITH per_party AS (
       SELECT party_id,
              SUM(total_volume) FILTER (WHERE source = 'trade_personal') AS volume,
              COALESCE(SUM(total_points) FILTER (WHERE source = 'trade_personal'), 0) AS personal,
              COALESCE(SUM(total_points) FILTER (WHERE source = 'trade_referral'), 0) AS referral,
              SUM(total_points) AS total
         FROM mp_points_total
        WHERE config_id = $1
        GROUP BY party_id
       HAVING SUM(total_points) > 0
     ), ranked AS (
       SELECT *, DENSE_RANK() OVER (ORDER BY total DESC, party_id) AS rank, COUNT(*) OVER () AS n FROM per_party
     )
     SELECT rank::text, party_id, COALESCE(volume, 0)::text AS volume, personal::text, referral::text, total::text, n::text
       FROM ranked
      WHERE rank <= $2 OR party_id = $3
      ORDER BY rank::int`,
    [cfg.id, limit, party],
  );

  const toRow = (r: typeof ranked.rows[number]) => ({
    rank: Number(r.rank),
    party: r.party_id === party ? r.party_id : maskParty(r.party_id),
    volume: round2(Number(r.volume)),
    personal: round2(Number(r.personal)),
    referral: round2(Number(r.referral)),
    total: round2(Number(r.total)),
    me: r.party_id === party,
  });
  // `rows` is strictly the top N. The caller's own row rides in `me.row` so a
  // caller outside the top N is never spliced into the middle of the list.
  const rows = ranked.rows.filter((r) => Number(r.rank) <= limit).map(toRow);
  const mine = ranked.rows.find((r) => r.party_id === party) ?? null;
  const totalParticipants = Number(ranked.rows[0]?.n ?? 0);

  let me: { rank: number; totalParticipants: number; rankDelta: number; behindNext: number; row: ReturnType<typeof toRow> } | null = null;
  if (mine) {
    const myRank = Number(mine.rank);
    // Points needed to reach the next rank up.
    const next = await pool.query<{ total: string }>(
      `SELECT SUM(total_points)::text AS total FROM mp_points_total WHERE config_id = $1
        GROUP BY party_id HAVING SUM(total_points) > $2 ORDER BY SUM(total_points) ASC LIMIT 1`,
      [cfg.id, mine.total],
    );
    const behindNext = next.rows[0] ? round2(Number(next.rows[0].total) - Number(mine.total)) : 0;
    // Movement vs yesterday: rank the totals as they stood at the end of the previous UTC day.
    const prev = await pool.query<{ rank: string }>(
      `WITH prior AS (
         SELECT party_id, SUM(points) AS total FROM mp_points_daily
          WHERE config_id = $1 AND day < (NOW() AT TIME ZONE 'UTC')::date
          GROUP BY party_id HAVING SUM(points) > 0
       ) SELECT DENSE_RANK() OVER (ORDER BY total DESC, party_id)::text AS rank, party_id FROM prior`,
      [cfg.id],
    );
    const prevMine = prev.rows.find((r) => (r as unknown as { party_id: string }).party_id === party);
    const rankDelta = prevMine ? Number(prevMine.rank) - myRank : 0; // positive = moved up
    me = { rank: myRank, totalParticipants, rankDelta, behindNext, row: toRow(mine) };
  }

  res.json({
    active: cfg.phase === 'running',
    competition: competitionJson(cfg),
    rows,
    me,
    totalParticipants,
    dataStatus: await dataStatus(pool),
  });
}));

// ─── GET /points/me/referrals ─────────────────────────────────────────────
//
// Friends = active referral edges where the caller is the referrer. `volume`
// is what each friend traded that COUNTED for the caller (from bound_at, in
// the competition window, per mp_referral_attribution); `toYou` is the points
// that volume produced at the active config's referral rate.

router.get('/points/me/referrals', requireAuth, wrap(async (req, res) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();

  const client = await pool.connect();
  let code: string;
  try { code = await getOrCreateCode(client, party); } finally { client.release(); }

  const cfg = await activeConfig(pool);
  const rate = cfg
    ? (await pool.query<{ rvu: string; rpu: string }>(
        'SELECT referral_volume_unit::text AS rvu, referral_points_per_unit::text AS rpu FROM mp_competition_config WHERE id = $1', [cfg.id],
      )).rows[0]
    : null;
  const ptsFor = (vol: number) => (rate ? round2((vol / Number(rate.rvu)) * Number(rate.rpu)) : 0);

  const friends = await pool.query<{ party_id: string; bound_at: Date; volume: string }>(
    `SELECT r.referee_party_id AS party_id, r.bound_at,
            COALESCE((SELECT SUM(a.volume) FROM mp_referral_attribution a
                       WHERE a.referee_party_id = r.referee_party_id AND a.referrer_party_id = r.referrer_party_id
                         AND ($2::timestamptz IS NULL OR a.day >= ($2::timestamptz AT TIME ZONE 'UTC')::date)
                         AND ($3::timestamptz IS NULL OR a.day <  ($3::timestamptz AT TIME ZONE 'UTC')::date)), 0)::text AS volume
       FROM referrals r
      WHERE r.referrer_party_id = $1 AND r.status = 'active'
      ORDER BY r.bound_at DESC`,
    [party, cfg?.startAt ?? null, cfg?.endAt ?? null],
  );

  const list = friends.rows.map((f) => {
    const volume = Number(f.volume);
    return { party: maskParty(f.party_id), joined: f.bound_at.toISOString(), volume: round2(volume), toYou: ptsFor(volume) };
  });
  const earned = cfg
    ? Number((await pool.query<{ p: string }>(
        `SELECT COALESCE(total_points, 0)::text AS p FROM mp_points_total WHERE party_id = $1 AND config_id = $2 AND source = 'trade_referral'`,
        [party, cfg.id],
      )).rows[0]?.p ?? 0)
    : 0;

  res.json({
    active: !!cfg,
    competition: cfg ? competitionJson(cfg) : null,
    code,
    link: referralLink(code),
    friendsJoined: list.length,
    friendsTraded: list.filter((f) => f.volume > 0).length,
    earned: round2(earned),
    friends: list,
    dataStatus: cfg ? await dataStatus(pool) : 'no_active_competition',
  });
}));

router.use(pointsErrors);

export default router;
