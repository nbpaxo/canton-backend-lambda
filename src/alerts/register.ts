/**
 * registerAlert / resolveAlert — the only functions alert *sources* call.
 *
 * registerAlert() is a cheap INSERT with dedup + cooldown baked in, safe to
 * call from a request handler (Lambda) or a worker. It NEVER sends to Telegram
 * and never throws for an operational reason — raising an alert must never
 * take down the path that raised it.
 *
 * resolveAlert() closes an open condition alert and enqueues a '✅ recovered'
 * info alert, so the channel reflects when a problem clears.
 */
import type { Pool } from 'pg';
import { ALERT_COOLDOWN_MINUTES } from '../config.js';
import type { RegisterAlertInput, RegisterResult, ResolveAlertInput } from './types.js';

/**
 * Queue an alert for delivery. Dedup rules keyed on dedup_key:
 *   • If an OPEN (unresolved) alert with the same key exists and was created
 *     within the cooldown window → suppress (return 'suppressed').
 *   • Otherwise insert a new pending row (fires now; also the reminder path
 *     once the cooldown elapses on a still-open condition).
 * Returns 'suppressed' on any internal error too — registration is
 * best-effort and must not disrupt the caller.
 */
export async function registerAlert(
  pool: Pool,
  input: RegisterAlertInput,
): Promise<RegisterResult> {
  const cooldownMin = input.cooldownMinutes ?? ALERT_COOLDOWN_MINUTES;
  try {
    const recent = await pool.query<{ id: string }>(
      `SELECT id
         FROM alerts
        WHERE dedup_key = $1
          AND resolved_at IS NULL
          AND created_at > NOW() - ($2::text || ' minutes')::interval
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.dedupKey, String(cooldownMin)],
    );
    if ((recent.rowCount ?? 0) > 0) return 'suppressed';

    await pool.query(
      `INSERT INTO alerts (alert_type, severity, dedup_key, title, body, context)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        input.type,
        input.severity,
        input.dedupKey,
        input.title.slice(0, 1000),
        input.body.slice(0, 4000),
        JSON.stringify(input.context ?? {}),
      ],
    );
    return 'queued';
  } catch (err) {
    // Never let alerting break the caller. Log and move on.
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'error',
        type: 'alert_register_failed',
        dedupKey: input.dedupKey,
        message: (err as Error).message,
      }),
    );
    return 'suppressed';
  }
}

/**
 * Close any open alerts for a condition key and enqueue a recovery notice.
 * No-op (returns false) when there was no open alert — so recovery notices
 * only fire for conditions that had actually alerted. The recovery row is
 * inserted directly (resolved_at set) so it delivers once and never re-fires.
 */
export async function resolveAlert(
  pool: Pool,
  input: ResolveAlertInput,
): Promise<boolean> {
  try {
    const open = await pool.query(
      `UPDATE alerts
          SET resolved_at = NOW()
        WHERE dedup_key = $1 AND resolved_at IS NULL`,
      [input.dedupKey],
    );
    if ((open.rowCount ?? 0) === 0) return false;

    await pool.query(
      `INSERT INTO alerts (alert_type, severity, dedup_key, title, body, context, resolved_at)
         VALUES ($1, 'info', $2, $3, $4, $5::jsonb, NOW())`,
      [
        input.type,
        `${input.dedupKey}:recovered`,
        (input.title ?? 'Recovered').slice(0, 1000),
        (input.body ?? `Condition ${input.dedupKey} has recovered.`).slice(0, 4000),
        JSON.stringify(input.context ?? {}),
      ],
    );
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'error',
        type: 'alert_resolve_failed',
        dedupKey: input.dedupKey,
        message: (err as Error).message,
      }),
    );
    return false;
  }
}
