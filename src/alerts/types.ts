/**
 * Alert taxonomy shared by every source + the processor.
 *
 * Condition alerts describe a sustained state (fire once, remind after the
 * cooldown, recover when cleared) and use a STABLE dedup key. Event alerts
 * describe a discrete occurrence (fire exactly once) and use a UNIQUE key.
 */
export type AlertSeverity = 'critical' | 'warning' | 'info';

export type AlertType =
  // ── condition alerts (health monitor; stable dedup key) ──
  | 'reserve_shortfall'   // A: vault+treasury < Aster account value × ratio
  | 'aster_underfunded'   // B: Aster wallet balance < vault × ratio
  | 'validator_stalled'   // C: ledger offset not advancing / API unreachable
  | 'low_traffic_credit'  // D: synchronizer traffic below floor
  | 'watcher_stale'       // E: deposit-watcher heartbeat gone stale
  // ── event alerts (unique dedup key) ──
  | 'withdraw_failed'     // F: a failed_withdraw_attempts row was written
  | 'deposit_stuck';      // G: held deposit / exchange notify exhausted

export interface RegisterAlertInput {
  type: AlertType;
  severity: AlertSeverity;
  /**
   * Identifies the logical condition/event. Stable for sustained conditions
   * (fire-once + reminder); unique-per-event for discrete events.
   */
  dedupKey: string;
  title: string;
  body: string;
  context?: Record<string, unknown>;
  /** Override the default cooldown (minutes) for this alert's key. */
  cooldownMinutes?: number;
}

export type RegisterResult = 'queued' | 'suppressed';

export interface ResolveAlertInput {
  type: AlertType;
  /** The stable dedup key of the condition being resolved. */
  dedupKey: string;
  title?: string;
  body?: string;
  context?: Record<string, unknown>;
}
