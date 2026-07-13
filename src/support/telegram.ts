/**
 * Minimal Telegram Bot API client. Sends a message with a caller-supplied bot
 * token + chat id, so the support and alerts channels can each use their own
 * bot and group.
 *
 * Best-effort: returns ok=false with a message on any error and never throws,
 * so a Telegram hiccup can't break the caller that triggered it. The chat id
 * is the numeric group id (negative for groups/supergroups).
 */

/** Escape the small set of characters Telegram's HTML parse mode cares about. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendTelegramMessage(
  text: string,
  botToken: string,
  chatId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!botToken || !chatId) {
    return { ok: false, error: 'Telegram bot token / chat id not set' };
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `${res.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
