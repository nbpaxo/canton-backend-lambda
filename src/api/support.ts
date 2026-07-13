/**
 * POST /support/report — in-app "Report an issue".
 *
 * Logged-in users only (requireAuth). The caller supplies a description and
 * at least one contact handle (telegram / twitter / email). The party id and
 * user type (validator vs Loop wallet) are derived SERVER-SIDE — never
 * trusted from the client. We store a support_reports row and ping the
 * support Telegram group; Telegram delivery is best-effort (the report is
 * saved regardless).
 */
import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getPool } from '../db/pool.js';
import { sendTelegramMessage, escapeHtml } from '../support/telegram.js';
import { TELEGRAM_SUPPORT_BOT_TOKEN, TELEGRAM_SUPPORT_CHAT_ID } from '../config.js';

const router = Router();

/** Trim + length-cap a string field; return null when empty/absent. */
function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

router.post('/support/report', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();

  const description = clean(req.body?.description, 4000);
  const telegram = clean(req.body?.telegram, 200);
  const twitter = clean(req.body?.twitter, 200);
  const email = clean(req.body?.email, 320);

  if (!description) {
    res.status(400).json({ error: 'A description is required.' });
    return;
  }
  if (!telegram && !twitter && !email) {
    res.status(400).json({
      error: 'Provide at least one contact: Telegram, Twitter, or email.',
    });
    return;
  }

  // Derive user type from the authoritative users row. In open-auth mode the
  // token `sub` is empty for everyone, so we cannot infer type from it —
  // is_external is set correctly at validator signup / for Loop users.
  const uRow = (
    await pool.query<{ is_external: boolean }>(
      `SELECT is_external FROM users WHERE party_id = $1`,
      [party],
    )
  ).rows[0];
  const userType = uRow ? (uRow.is_external ? 'loop' : 'validator') : 'loop';

  const ins = await pool.query<{ id: string }>(
    `INSERT INTO support_reports
       (user_party_id, user_type, description, telegram, twitter, email)
       VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [party, userType, description, telegram, twitter, email],
  );
  const id = ins.rows[0].id;

  // Ping the support Telegram group (best-effort).
  const contacts = [
    telegram ? `• Telegram: ${escapeHtml(telegram)}` : null,
    twitter ? `• Twitter: ${escapeHtml(twitter)}` : null,
    email ? `• Email: ${escapeHtml(email)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const msg =
    `🆘 <b>New support report</b> #${id}\n` +
    `<b>User:</b> ${userType === 'validator' ? 'mperps validator' : 'Loop wallet'}\n` +
    `<b>Party:</b> <code>${escapeHtml(party)}</code>\n` +
    `<b>Contact</b>\n${contacts}\n\n` +
    `<b>Issue</b>\n${escapeHtml(description)}`;

  const tg = await sendTelegramMessage(msg, TELEGRAM_SUPPORT_BOT_TOKEN, TELEGRAM_SUPPORT_CHAT_ID);
  if (tg.ok) {
    await pool.query(
      `UPDATE support_reports SET notified_telegram = true WHERE id = $1`,
      [id],
    );
  } else {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'error',
        type: 'support_telegram_failed',
        id,
        error: tg.error,
      }),
    );
  }

  res.json({ ok: true, id });
});

export default router;
