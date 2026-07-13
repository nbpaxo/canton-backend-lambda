/**
 * Worker liveness heartbeats. Each long-running worker calls writeHeartbeat()
 * every tick; the health monitor reads them and alerts when one goes stale.
 * Generic (keyed by worker name) so any worker can participate.
 */
import type { Pool } from 'pg';

/** Upsert this worker's heartbeat. Best-effort — never breaks the tick. */
export async function writeHeartbeat(
  pool: Pool,
  worker: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO worker_heartbeats (worker, beat_at, meta)
         VALUES ($1, NOW(), $2::jsonb)
       ON CONFLICT (worker) DO UPDATE
         SET beat_at = EXCLUDED.beat_at, meta = EXCLUDED.meta`,
      [worker, JSON.stringify(meta ?? {})],
    );
  } catch {
    // Heartbeat is advisory; a write failure must not disrupt the worker.
  }
}

export interface Heartbeat {
  worker: string;
  beat_at: Date;
  meta: Record<string, unknown> | null;
}

/** Read a worker's last heartbeat, or null if it has never beaten. */
export async function readHeartbeat(pool: Pool, worker: string): Promise<Heartbeat | null> {
  const r = await pool.query<Heartbeat>(
    `SELECT worker, beat_at, meta FROM worker_heartbeats WHERE worker = $1`,
    [worker],
  );
  return r.rows[0] ?? null;
}
