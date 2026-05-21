/**
 * Singleton Postgres pool. Imported anywhere a request handler / worker
 * needs to read or write. Connections are pooled — never construct ad-hoc
 * Client instances.
 *
 * DATABASE_URL is required at runtime; defaults to the docker-compose
 * service if unset (port 5436, user/pw/db = canton_backend).
 *
 * SSL handling:
 *   - Local dev (docker compose) → no SSL.
 *   - RDS / any managed Postgres → SSL required. We pass `ssl:
 *     { rejectUnauthorized: false }` explicitly so connections are
 *     encrypted but we don't have to bundle the Amazon RDS CA chain
 *     into the Lambda zip. The pg-connection-string library otherwise
 *     tries to verify against Node's default trust store, which doesn't
 *     contain the RDS roots — that manifests as silent hangs on
 *     connect.
 */
import pg from 'pg';

const DEFAULT_URL = 'postgres://canton_backend:canton_backend@localhost:5436/canton_backend';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const raw = process.env.DATABASE_URL || DEFAULT_URL;
  const u = new URL(raw);
  // Detect "encrypted required" from the URL. If present, force
  // node-postgres into encrypted-but-no-CA-verification mode, which is
  // the right tradeoff for RDS where the host is inside AWS but the CA
  // bundle isn't available locally.
  //
  // We bypass `connectionString` entirely and pass individual params,
  // because when both `connectionString` (with sslmode=require) and an
  // explicit `ssl:` are set, pg-pool's URL parser wins and our
  // rejectUnauthorized: false is ignored — symptom is
  // SELF_SIGNED_CERT_IN_CHAIN.
  const wantSsl = /sslmode=(require|prefer|verify-ca|verify-full|allow)/i.test(u.search);
  const inLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

  pool = new pg.Pool({
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    ssl: wantSsl ? { rejectUnauthorized: false } : undefined,
    // Tighter in Lambda: each invocation is short-lived and a stuck
    // connection blocks the whole container. Smaller pool, short
    // connect+query+statement timeouts so failures surface fast enough
    // for the catch handlers + recordFailedAttempt to run before Lambda
    // kills the container.
    max: Number(process.env.PG_POOL_MAX ?? (inLambda ? 3 : 10)),
    idleTimeoutMillis: inLambda ? 5_000 : 30_000,
    // Hard caps so a dead/unreachable RDS doesn't silently consume the
    // entire 30s Lambda timeout without ever logging anything:
    connectionTimeoutMillis: inLambda ? 5_000 : 10_000,
    // Cap individual queries — anything beyond this is fatal at the
    // server side, so we get a clean error instead of a hang.
    statement_timeout: inLambda ? 15_000 : 30_000,
    query_timeout: inLambda ? 15_000 : 30_000,
  });

  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      level: 'error',
      type: 'pg_pool_error',
      message: (err as Error).message,
      stack: (err as Error).stack,
    }));
  });
  pool.on('connect', () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      level: 'debug',
      type: 'pg_pool_connect',
      total: pool!.totalCount,
      idle: pool!.idleCount,
      waiting: pool!.waitingCount,
    }));
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
