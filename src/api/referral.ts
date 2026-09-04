/**
 * Referral endpoints.
 *
 *   GET  /referral/me        — the caller's code, link, summary, and inviter
 *   GET  /referral/validate  — is this code usable? (open: the signup form
 *                              needs it before the user exists)
 *   POST /referral/bind      — Loop wallet users attach a code post-connect
 *   GET  /referral/friends   — paginated list of who the caller referred
 *
 * Points are deliberately absent. This ships the referral GRAPH; the volume
 * and points fields come back as null until the exchange backend can report
 * per-user trading volume, and the UI renders them as placeholders.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getPool } from '../db/pool.js';
import { getOrCreateCode } from '../referral/codes.js';
import {
  bindReferral,
  getInviter,
  getReferralState,
  getSummary,
  listReferredFriends,
  lookupActiveCode,
  referralLink,
  type BindFailure,
} from '../referral/service.js';

const router = Router();

/** Human text for each refusal. Keys double as the machine `error` code. */
const BIND_FAILURE_MESSAGE: Record<BindFailure, string> = {
  invalid_code: 'That referral code is not valid.',
  self_referral: 'You cannot use your own referral code.',
  already_bound: 'A referral code is already attached to your account.',
  window_closed:
    'The window to add a referral code has closed for your account.',
  not_eligible: 'Your account type cannot add a referral code here.',
};

/** 400 for user error, 409 for "the state already moved on". */
const BIND_FAILURE_STATUS: Record<BindFailure, number> = {
  invalid_code: 400,
  self_referral: 400,
  already_bound: 409,
  window_closed: 409,
  not_eligible: 403,
};

// ─── GET /referral/me ────────────────────────────────────────────────────

router.get('/referral/me', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();

  // Codes are minted on first view rather than at signup, so accounts that
  // never open this page never get one — and Loop users, who have no signup
  // step at all, come through the same path.
  const client = await pool.connect();
  let code: string;
  try {
    code = await getOrCreateCode(client, party);
  } finally {
    client.release();
  }

  const [state, summary, inviter] = await Promise.all([
    getReferralState(pool, party),
    getSummary(pool, party),
    getInviter(pool, party),
  ]);

  res.json({
    code,
    link: referralLink(code),
    summary,
    inviter,
    bound: state.bound,
    referredByCode: state.referredByCode,
    canBind: state.canBind,
    windowExpiresAt: state.windowExpiresAt,
  });
});

// ─── GET /referral/validate?code=XXX ─────────────────────────────────────

/**
 * Open (no auth) because the mperps signup form validates a code before the
 * account exists, so there is no caller to authenticate yet.
 *
 * This does leak "is this code real?", but a code is ~33 bits of entropy and
 * knowing one buys nothing beyond the ability to credit that person with your
 * own signup — which is what a referral link does in public anyway. Rate
 * limited in server.ts so it can't be enumerated in bulk.
 */
router.get('/referral/validate', async (req: Request, res: Response) => {
  const raw = req.query.code;
  const code = typeof raw === 'string' ? raw : '';
  if (!code.trim()) {
    res.status(400).json({ valid: false, error: 'code_required' });
    return;
  }

  const found = await lookupActiveCode(getPool(), code);
  if (!found) {
    res.status(404).json({
      valid: false,
      error: 'invalid_code',
      message: 'That referral code is not valid.',
    });
    return;
  }

  // Only the normalised code goes back — never the owner's party id, which
  // would turn this into a public lookup from code to account.
  res.json({ valid: true, code: found.code });
});

// ─── POST /referral/bind ─────────────────────────────────────────────────

/**
 * The Loop wallet path: these users never see a signup form, so they attach a
 * code from the in-app prompt instead. Window-gated server-side.
 */
router.post('/referral/bind', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const { code } = (req.body ?? {}) as { code?: unknown };

  if (typeof code !== 'string' || !code.trim()) {
    res.status(400).json({ error: 'code_required', message: 'A referral code is required.' });
    return;
  }

  const result = await bindReferral(getPool(), {
    refereePartyId: party,
    rawCode: code,
    source: 'loop_window',
  });

  if (!result.ok) {
    res.status(BIND_FAILURE_STATUS[result.reason]).json({
      error: result.reason,
      message: BIND_FAILURE_MESSAGE[result.reason],
    });
    return;
  }

  res.json({ ok: true, code: result.code });
});

// ─── GET /referral/friends ───────────────────────────────────────────────

router.get('/referral/friends', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const limit = Number(req.query.limit ?? '20');
  const before = typeof req.query.before === 'string' ? req.query.before : undefined;

  const page = await listReferredFriends(getPool(), party, {
    limit: Number.isFinite(limit) ? limit : 20,
    before,
  });

  res.json(page);
});

export default router;
