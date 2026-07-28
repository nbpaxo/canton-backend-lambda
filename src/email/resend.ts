/**
 * Resend transactional email client (KYC email OTP).
 *
 * Thin fetch wrapper over the Resend REST API — no SDK dependency.
 *   POST {RESEND_API_BASE}/emails
 *   Authorization: Bearer {RESEND_API_KEY}
 *   body: { from, to, subject, html, text }
 * docs: https://resend.com/docs/api-reference/emails/send-email
 */
import { RESEND_API_BASE, RESEND_API_KEY, RESEND_FROM } from '../config.js';

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/** Send one email via Resend. Throws on non-2xx. */
export async function sendEmail(args: SendEmailArgs): Promise<void> {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const res = await fetch(`${RESEND_API_BASE}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      ...(args.text ? { text: args.text } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed (${res.status}): ${await res.text()}`);
  }
}

/** Send the 6-digit KYC verification code. */
export async function sendOtpEmail(to: string, code: string, ttlMinutes: number): Promise<void> {
  const subject = `${code} is your Mperps verification code`;
  const text =
    `Your Mperps verification code is ${code}.\n` +
    `It expires in ${ttlMinutes} minutes.\n\n` +
    `If you didn't request this, you can safely ignore this email.`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
      <h2 style="margin:0 0 8px;font-size:18px">Verify your email</h2>
      <p style="margin:0 0 20px;color:#555;font-size:14px">
        Use this code to verify your email for Mperps KYC.
      </p>
      <div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f4f5f7;border-radius:8px;padding:16px;text-align:center">
        ${code}
      </div>
      <p style="margin:20px 0 0;color:#888;font-size:12px">
        This code expires in ${ttlMinutes} minutes. If you didn't request it, ignore this email.
      </p>
    </div>`;
  await sendEmail({ to, subject, html, text });
}
