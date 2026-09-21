/**
 * Referral endpoints.
 *
 *   GET  /points/me          — the caller's MPoints (own + from referrals)
 *   GET  /points/config      — the competition rules, active and past
 *   GET  /referral/me        — the caller's code, link, summary, and inviter
 *   GET  /referral/validate  — is this code usable? (open: the signup form
 *                              needs it before the user exists)
 *   POST /referral/bind      — Loop wallet users attach a code post-connect
 *   GET  /referral/friends   — paginated list of who the caller referred
 *
 * This ships the referral GRAPH. Volume and points fields come back as null
 * until the points service exists and the exchange backend can report
 * per-user trading volume; the UI renders them as placeholders. The shapes
 * are final, so filling them in needs no client change — see
 * referral/points.ts.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getPool } from '../db/pool.js';
import { getOrCreateCode } from '../referral/codes.js';
import { getPointsSummary, getCompetitionConfigs } from '../referral/points.js';
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
};

/** 400 for user error, 409 for "the state already moved on". */
const BIND_FAILURE_STATUS: Record<BindFailure, number> = {
  invalid_code: 400,
  self_referral: 400,
  already_bound: 409,
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

  const [state, summary, inviter, points] = await Promise.all([
    getReferralState(pool, party),
    getSummary(pool, party),
    getInviter(pool, party),
    // Included here rather than left to a second call: the referral screen
    // shows the caller's own trading points beside their referral points, and
    // a separate request would make the two halves of one figure arrive
    // independently and visibly disagree for a moment.
    getPointsSummary(pool, party),
  ]);

  res.json({
    code,
    link: referralLink(code),
    summary,
    points,
    inviter,
    bound: state.bound,
    referredByCode: state.referredByCode,
    canBind: state.canBind,
    showPrompt: state.showPrompt,
  });
});

// ─── GET /points/me ──────────────────────────────────────────────────────

/**
 * MPoints for the caller. Serves the Points screen, which needs the total
 * without any of the referral-graph payload that /referral/me carries.
 */
router.get('/points/me', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  res.json(await getPointsSummary(getPool(), party));
});

// ─── GET /points/config ──────────────────────────────────────────────────

/**
 * The rules behind the numbers: which competition is running, since when
 * trading counts, and at what rates — plus previous rounds, so a user can see
 * that an older balance was earned under different terms rather than assuming
 * today's rate always applied.
 *
 * Not user-specific, but kept behind auth so the programme's commercial terms
 * aren't a public endpoint.
 */
router.get('/points/config', requireAuth, async (_req: Request, res: Response) => {
  res.json(await getCompetitionConfigs(getPool()));
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
 * Self-service bind — either user type, at any time.
 *
 * mperps users who skipped the field on the signup form use this too; there
 * is no deadline. The one-referrer-ever rule is enforced by the primary key
 * on `referrals`, not by anything time-based.
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
    source: 'self_service',
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
