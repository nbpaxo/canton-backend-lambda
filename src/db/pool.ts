/**
 * Singleton Postgres pool. Imported anywhere a request handler / worker
 * needs to read or write. Connections are pooled — never construct ad-hoc
 * Client instances.
 *
 * DATABASE_URL is required at runtime; defaults to the docker-compose
 * service if unset (port 5436, user/pw/db = canton_backend).
 */
import pg from 'pg';

const DEFAULT_URL = 'postgres://canton_backend:canton_backend@localhost:5436/canton_backend';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || DEFAULT_URL,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => {
    console.error('[pg] unexpected pool error:', err);
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
