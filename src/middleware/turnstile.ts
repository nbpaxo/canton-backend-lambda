/**
 * Cloudflare Turnstile verification middleware.
 *
 * Mounted on the two unauthenticated endpoints in the signup funnel:
 *   • /validate-invite — an invite-code oracle; without this a script can
 *     enumerate valid codes for free (the route is deliberately not rate
 *     limited, see the comment in server.ts).
 *   • /signup          — the expensive one: it writes to Keycloak and Canton.
 *
 * The browser widget mints a token. We redeem it here against Cloudflare's
 * siteverify API — never from the browser, which would leak the secret and
 * prove nothing.
 *
 * DO NOT treat this as an idempotency guard. Cloudflare documents tokens as
 * single-use, but its duplicate detection is eventually consistent: measured
 * against the live API, the same token verified `success: true` TWICE before
 * the third call returned `timeout-or-duplicate`. Two rapid double-click
 * submits can therefore both clear the captcha. Request de-duplication has to
 * come from something atomic on our side (the invite-code claim), not here.
 *
 * Three things are checked, not one:
 *   success   — the challenge was actually solved
 *   action    — the token came from the form we think it did, so a token
 *               minted on /validate-invite can't be spent on /signup
 *   hostname  — the token was solved on OUR frontend. Without this, anyone
 *               can embed our (public) sitekey on their own page, farm real
 *               tokens there, and replay them at our API.
 *
 * Error responses follow this service's convention: `error` carries the
 * machine-readable code (the frontend maps it to err.code) and `message`
 * carries the human text. Codes: captcha_missing | captcha_expired |
 * captcha_unavailable | captcha_failed.
 *
 * Fails CLOSED: any error — network, timeout, malformed response — is a 403.
 * The one exception is TURNSTILE_ENABLED=false (secret or hostname list
 * unset), which skips the check entirely so local dev works without keys.
 */

import { Request, Response, NextFunction } from 'express';
import {
  TURNSTILE_ENABLED,
  TURNSTILE_HOSTNAMES,
  TURNSTILE_SECRET_KEY,
  TURNSTILE_VERIFY_URL,
} from '../config.js';

/** Cloudflare's siteverify response. `error-codes` is always present. */
interface SiteVerifyResponse {
  success: boolean;
  action?: string;
  hostname?: string;
  challenge_ts?: string;
  'error-codes'?: string[];
}

/** Cloudflare caps tokens at 2048 chars; anything longer is not ours. */
const MAX_TOKEN_LENGTH = 2048;
const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Client IP for the optional `remoteip` parameter.
 *
 * Behind API Gateway `req.ip` is the gateway's own address, which tells
 * Cloudflare nothing. The real client is the FIRST entry in X-Forwarded-For
 * (later entries are the proxies it traversed). Returns undefined rather than
 * a wrong value when there's no header — remoteip is optional, and sending a
 * proxy IP is worse than sending none.
 */
function clientIp(req: Request): string | undefined {
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const first = header?.split(',')[0]?.trim();
  return first || undefined;
}

/**
 * Build the middleware for one form. `action` must match the `data-action`
 * the widget was rendered with on the frontend.
 */
export function verifyTurnstile(action: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!TURNSTILE_ENABLED) {
      console.warn(
        `[turnstile] DISABLED (TURNSTILE_SECRET_KEY / TURNSTILE_HOSTNAMES unset) — `
        + `skipping check for action=${action}. Do not run production like this.`,
      );
      return next();
    }

    const token = (req.body as { turnstileToken?: unknown } | undefined)?.turnstileToken;

    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      res.status(403).json({
        error: 'captcha_missing',
        message: 'Captcha verification required.',
      });
      return;
    }

    let result: SiteVerifyResponse;
    try {
      const body = new URLSearchParams({
        secret: TURNSTILE_SECRET_KEY,
        response: token,
      });
      const ip = clientIp(req);
      if (ip) body.set('remoteip', ip);

      const verifyRes = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        body,
      });
      if (!verifyRes.ok) throw new Error(`siteverify HTTP ${verifyRes.status}`);
      result = (await verifyRes.json()) as SiteVerifyResponse;
    } catch (err) {
      // Network / timeout / malformed JSON. Fail closed.
      console.error(
        `[turnstile] siteverify call failed (action=${action}):`,
        err instanceof Error ? err.message : String(err),
      );
      res.status(403).json({
        error: 'captcha_unavailable',
        message: 'Captcha verification unavailable. Please try again.',
      });
      return;
    }

    const codes = result['error-codes'] ?? [];

    // A used or expired token is the ONE failure the user can fix themselves
    // (Turnstile tokens expire after ~5 minutes, and a retry of a failed
    // submit reuses the same one). Give it a distinct code so the frontend
    // resets the widget and says something useful instead of "access denied".
    if (!result.success && codes.includes('timeout-or-duplicate')) {
      res.status(403).json({
        error: 'captcha_expired',
        message: 'Captcha expired. Please try again.',
      });
      return;
    }

    if (!result.success) {
      console.warn(`[turnstile] rejected (action=${action}): ${codes.join(',') || 'no error codes'}`);
      res.status(403).json({
        error: 'captcha_failed',
        message: 'Captcha verification failed. Please try again.',
      });
      return;
    }

    // Solved — but was it solved on our form, on our site?
    if (result.action !== action) {
      console.warn(`[turnstile] action mismatch: expected=${action} got=${result.action}`);
      res.status(403).json({
        error: 'captcha_failed',
        message: 'Captcha verification failed. Please try again.',
      });
      return;
    }

    if (!result.hostname || !TURNSTILE_HOSTNAMES.includes(result.hostname)) {
      console.warn(
        `[turnstile] hostname not allowed: got=${result.hostname} `
        + `allowed=${TURNSTILE_HOSTNAMES.join(',')}`,
      );
      res.status(403).json({
        error: 'captcha_failed',
        message: 'Captcha verification failed. Please try again.',
      });
      return;
    }

    next();
  };
}

/** Action names — shared with the frontend widget's `data-action`. */
export const TURNSTILE_ACTION_VALIDATE_INVITE = 'validate_invite';
export const TURNSTILE_ACTION_SIGNUP = 'signup';
