/**
 * Which mPoints competition to show. Several configs may be ENABLED at once
 * (seasons scheduled ahead, an ended season still settling); the API shows the
 * one RUNNING now, else the most recently ENDED (the leaderboard stays visible
 * between seasons), else the NEXT scheduled one.
 */
import type { Pool } from 'pg';

export type CompetitionPhase = 'scheduled' | 'running' | 'ended';
export interface DisplayConfig { id: number; name: string | null; startAt: Date; endAt: Date; phase: CompetitionPhase; settled: boolean }

export const DISPLAY_CONFIG_SQL = `
  SELECT id, name, start_at, end_at, settled_at,
         CASE WHEN NOW() < start_at THEN 'scheduled' WHEN NOW() >= end_at THEN 'ended' ELSE 'running' END AS phase
    FROM mp_competition_config
   WHERE status = 'active'
   ORDER BY CASE WHEN start_at <= NOW() AND end_at > NOW() THEN 0 WHEN end_at <= NOW() THEN 1 ELSE 2 END,
            CASE WHEN end_at <= NOW() THEN end_at END DESC NULLS LAST,
            start_at ASC
   LIMIT 1`;

export async function displayConfig(pool: Pool): Promise<DisplayConfig | null> {
  const r = await pool.query<{ id: string; name: string | null; start_at: Date; end_at: Date; settled_at: Date | null; phase: CompetitionPhase }>(DISPLAY_CONFIG_SQL);
  const row = r.rows[0];
  return row ? { id: Number(row.id), name: row.name, startAt: row.start_at, endAt: row.end_at, phase: row.phase, settled: row.settled_at !== null } : null;
}
