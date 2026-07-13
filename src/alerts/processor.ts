/**
 * runAlertProcessor — drains pending alerts to Telegram. Runs inside the
 * always-on health monitor loop (the Lambda never calls this). One pass:
 *   • select up to BATCH pending rows whose send-backoff has elapsed
 *   • post each to Telegram
 *   • mark 'sent' on success; bump attempts + 'failed' once attempts exhaust
 *
 * Ordering is oldest-first so a backlog drains in the order problems arose.
 * The function itself never throws for a per-row failure — a bad row is
 * recorded and the pass continues.
 */
import type { Pool } from 'pg';
import {
  ALERT_MAX_SEND_ATTEMPTS,
  ALERT_SEND_BACKOFF_MS,
  ALERT_SEND_BATCH_LIMIT,
} from '../config.js';
import { sendAlertToTelegram } from './telegram.js';
import type { AlertSeverity } from './types.js';

interface PendingRow {
  id: string;
  alert_type: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  context: Record<string, unknown> | null;
  created_at: Date;
  attempts: number;
}

export async function runAlertProcessor(
  pool: Pool,
): Promise<{ sent: number; failed: number }> {
  const pending = await pool.query<PendingRow>(
    `SELECT id, alert_type, severity, title, body, context, created_at, attempts
       FROM alerts
      WHERE status = 'pending'
        AND attempts < $1
        AND (last_attempt_at IS NULL
             OR last_attempt_at < NOW() - ($2::text || ' milliseconds')::interval)
      ORDER BY created_at ASC
      LIMIT $3`,
    [ALERT_MAX_SEND_ATTEMPTS, String(ALERT_SEND_BACKOFF_MS), ALERT_SEND_BATCH_LIMIT],
  );

  let sent = 0;
  let failed = 0;

  for (const row of pending.rows) {
    const result = await sendAlertToTelegram({
      severity: row.severity,
      alertType: row.alert_type,
      title: row.title,
      body: row.body,
      context: row.context,
      createdAt: row.created_at,
    });

    if (result.ok) {
      await pool.query(
        `UPDATE alerts
            SET status = 'sent', sent_at = NOW(),
                attempts = attempts + 1, last_attempt_at = NOW(), last_error = NULL
          WHERE id = $1`,
        [row.id],
      );
      sent += 1;
    } else {
      const willExhaust = row.attempts + 1 >= ALERT_MAX_SEND_ATTEMPTS;
      await pool.query(
        `UPDATE alerts
            SET status = $2,
                attempts = attempts + 1, last_attempt_at = NOW(), last_error = $3
          WHERE id = $1`,
        [
          row.id,
          willExhaust ? 'failed' : 'pending',
          `${result.status}: ${result.error ?? ''}`.slice(0, 2000),
        ],
      );
      failed += 1;
    }
  }

  return { sent, failed };
}
