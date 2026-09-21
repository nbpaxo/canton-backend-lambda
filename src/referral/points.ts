/**
 * MPoints summary — the read the Points and Referral screens share.
 *
 * Reads the mpoints service's tables, which live in the SAME Postgres as the
 * referral graph:
 *   mp_competition_config  — the active competition and its rates
 *   mp_points_total        — per party, per config, per source, the running
 *                            total_volume + total_points
 *
 * `source` splits the two halves we display:
 *   'trade_personal' — points from the user's own trading volume
 *   'trade_referral' — points from the volume of users they referred
 *
 * A party has a row only for sources it has actually earned on, so a user who
 * has never traded themselves has no 'trade_personal' row at all. That is
 * reported as 0 rather than null once a competition is active: the service HAS
 * run and the honest answer is zero, which is different from "not calculated".
 *
 * If the mp_ tables are absent (a database the points service was never
 * provisioned on) or no competition is active, everything stays null and
 * `available` is false, so the UI renders "—" rather than asserting a zero we
 * cannot stand behind.
 */

import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;

export interface PointsSummary {
  /** Earned from the caller's own trading volume. */
  personalPoints: number | null;
  /** Earned from the trading volume of users they referred. */
  referralPoints: number | null;
  /** personalPoints + referralPoints. */
  totalPoints: number | null;

  /**
   * The volumes those points were derived from. Returned alongside the points
   * rather than separately because the screens always show them together —
   * a points figure with no volume behind it gives the user no way to tell
   * whether it looks right.
   */
  personalVolume: number | null;
  referralVolume: number | null;
  totalVolume: number | null;

  /**
   * False when no figures could be produced — the points service isn't
   * provisioned here, or no competition is active. Lets a client distinguish
   * "earned nothing" from "not calculated yet".
   */
  available: boolean;
}

const EMPTY: PointsSummary = {
  personalPoints: null,
  referralPoints: null,
  totalPoints: null,
  personalVolume: null,
  referralVolume: null,
  totalVolume: null,
  available: false,
};

/** Money-ish rounding — the service stores NUMERIC(38,6); we show 2dp. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function getPointsSummary(
  db: Db,
  partyId: string,
): Promise<PointsSummary> {
  try {
    const res = await db.query<{
      source: string;
      total_volume: string;
      total_points: string;
    }>(
      `WITH cfg AS (
         SELECT id FROM mp_competition_config
          WHERE status = 'active'
          ORDER BY id DESC
          LIMIT 1
       )
       SELECT t.source, t.total_volume::text, t.total_points::text
         FROM mp_points_total t
         JOIN cfg ON cfg.id = t.config_id
        WHERE t.party_id = $1
          AND t.source IN ('trade_personal', 'trade_referral')`,
      [partyId],
    );

    // No active competition at all → nothing to report. Distinguished from
    // "active competition, no rows for this party", which is a real zero.
    const cfg = await db.query<{ id: string }>(
      `SELECT id::text FROM mp_competition_config
        WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
    );
    if (!cfg.rows[0]) return EMPTY;

    let personalPoints = 0;
    let personalVolume = 0;
    let referralPoints = 0;
    let referralVolume = 0;

    for (const row of res.rows) {
      if (row.source === 'trade_personal') {
        personalPoints = Number(row.total_points);
        personalVolume = Number(row.total_volume);
      } else {
        referralPoints = Number(row.total_points);
        referralVolume = Number(row.total_volume);
      }
    }

    return {
      personalPoints: round2(personalPoints),
      referralPoints: round2(referralPoints),
      totalPoints: round2(personalPoints + referralPoints),
      personalVolume: round2(personalVolume),
      referralVolume: round2(referralVolume),
      totalVolume: round2(personalVolume + referralVolume),
      available: true,
    };
  } catch (err) {
    // Only swallow "the points service isn't installed here". Anything else is
    // a real fault and must not be disguised as "no points yet".
    if (!/relation "mp_/.test((err as Error).message ?? '')) throw err;
    return EMPTY;
  }
}

// ─── Competition configuration (the rules behind the numbers) ────────────

export interface CompetitionConfig {
  id: number;
  name: string | null;
  /** Trading from this moment counts toward MPoints. */
  startAt: string;
  /** Exclusive — the window is [startAt, endAt). */
  endAt: string;
  personalVolumeUnit: number;
  personalPointsPerUnit: number;
  referralVolumeUnit: number;
  referralPointsPerUnit: number;
  status: 'active' | 'disabled';
}

export interface CompetitionConfigs {
  /**
   * The rules currently earning points. Null when no competition is running,
   * which is also when getPointsSummary reports available: false.
   */
  active: CompetitionConfig | null;
  /**
   * Everything else, newest first — ended or disabled rounds. Kept visible so
   * a user can see why an older balance was earned at a different rate
   * instead of assuming the current rate always applied.
   */
  past: CompetitionConfig[];
}

const EMPTY_CONFIGS: CompetitionConfigs = { active: null, past: [] };

export async function getCompetitionConfigs(
  db: Db,
): Promise<CompetitionConfigs> {
  try {
    const res = await db.query<{
      id: string;
      name: string | null;
      start_at: Date;
      end_at: Date;
      personal_volume_unit: string;
      personal_points_per_unit: string;
      referral_volume_unit: string;
      referral_points_per_unit: string;
      status: string;
    }>(
      `SELECT id::text, name, start_at, end_at,
              personal_volume_unit::text, personal_points_per_unit::text,
              referral_volume_unit::text, referral_points_per_unit::text,
              status
         FROM mp_competition_config
        ORDER BY start_at DESC`,
    );

    const all: CompetitionConfig[] = res.rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      startAt: r.start_at.toISOString(),
      endAt: r.end_at.toISOString(),
      personalVolumeUnit: Number(r.personal_volume_unit),
      personalPointsPerUnit: Number(r.personal_points_per_unit),
      referralVolumeUnit: Number(r.referral_volume_unit),
      referralPointsPerUnit: Number(r.referral_points_per_unit),
      status: r.status === 'active' ? 'active' : 'disabled',
    }));

    return {
      active: all.find((c) => c.status === 'active') ?? null,
      past: all.filter((c) => c.status !== 'active'),
    };
  } catch (err) {
    if (!/relation "mp_/.test((err as Error).message ?? '')) throw err;
    return EMPTY_CONFIGS;
  }
}
