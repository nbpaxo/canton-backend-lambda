/**
 * Telegram delivery for ops alerts. Formats a single alert as an HTML message
 * (severity emoji + title + body + context) and sends it to the alerts group.
 * Pure I/O — no DB, no dedup; the caller (processor) owns retry + status.
 */
import { TELEGRAM_ALERTS_BOT_TOKEN, TELEGRAM_ALERTS_CHAT_ID } from '../config.js';
import { sendTelegramMessage, escapeHtml } from '../support/telegram.js';
import type { AlertSeverity } from './types.js';

const SEVERITY_META: Record<AlertSeverity, { emoji: string; label: string }> = {
  critical: { emoji: '🔴', label: 'CRITICAL' },
  warning: { emoji: '🟡', label: 'WARNING' },
  info: { emoji: '✅', label: 'INFO' },
};

export interface AlertTelegramPayload {
  severity: AlertSeverity;
  alertType: string;
  title: string;
  body: string;
  context?: Record<string, unknown> | null;
  createdAt?: Date;
}

/**
 * Send one alert to the Telegram alerts group. Returns ok=false with a message
 * on any error — never throws, so the processor's status bookkeeping is always
 * reached.
 */
export async function sendAlertToTelegram(
  payload: AlertTelegramPayload,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const meta = SEVERITY_META[payload.severity];

  const ctx = Object.entries(payload.context ?? {})
    .slice(0, 12)
    .map(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `• <b>${escapeHtml(String(k))}:</b> <code>${escapeHtml(val).slice(0, 300)}</code>`;
    })
    .join('\n');

  const text =
    `${meta.emoji} <b>${escapeHtml(payload.title)}</b>  [${meta.label}]\n` +
    `<i>${escapeHtml(payload.alertType)}</i>\n\n` +
    `${escapeHtml(payload.body).slice(0, 3500)}` +
    (ctx ? `\n\n${ctx}` : '');

  const r = await sendTelegramMessage(text, TELEGRAM_ALERTS_BOT_TOKEN, TELEGRAM_ALERTS_CHAT_ID);
  return { ok: r.ok, status: r.ok ? 200 : 0, error: r.error };
}
