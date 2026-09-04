/**
 * Signup route — invite code based onboarding on our validator (devnet branch).
 *
 * Flow (reordered from master so the Keycloak UUID is the party hint, per
 * "user id in keycloak should be party id for user not name"):
 *   1. Validate invite code (Postgres)
 *   2. Check username not taken in Keycloak
 *   3. Create Keycloak user → get UUID (this is the Canton `sub`)
 *   4. Create Canton party with partyIdHint = UUID
 *      → party_id is `<uuid>::<fingerprint>`
 *      → user logs in with username/password, but their canonical identifier
 *        on the ledger is the UUID-derived party id
 *   5. Create Canton user (link UUID → party id)
 *   6. Grant CanActAs + CanReadAs on the party
 *   7. Upsert into our local `users` table (so /me + the watcher find them)
 *   8. (deferred) VaultAccountProposal — new contract may not need this.
 *      Kept as a no-op TODO until the new contract is confirmed.
 *   9. Mark invite code as redeemed
 */

import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getAdminToken } from './auth.js';
import {
  getInviteCode,
  claimInviteCode,
  releaseInviteCode,
  finalizeInviteClaim,
  listInviteCodes,
  type RedeemedByInfo,
} from './db.js';
import { registerAlert } from './alerts/register.js';
import { getPool } from './db/pool.js';
import {
  CANTON_LEDGER_API,
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET,
  ADMIN_API_KEY,
} from './config.js';
import { getKcAdminToken } from './keycloak.js';
import {
  verifyTurnstile,
  TURNSTILE_ACTION_VALIDATE_INVITE,
  TURNSTILE_ACTION_SIGNUP,
} from './middleware/turnstile.js';
import { isWellFormedCode, normalizeCode } from './referral/codes.js';
import { bindReferral, lookupActiveCode } from './referral/service.js';

const router = Router();

// ─── Validation helpers ─────────────────────────────────────────────────────

const USERNAME_RE = /^[a-z][a-z0-9_-]{2,29}$/;
// Cheap-but-good-enough email check; the real proof is the activation email
// (which we don't send yet — devnet).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SignupBody {
  inviteCode: string;
  username: string;
  email: string;
  password: string;
  /** Optional. Empty is fine; present-but-invalid blocks the signup. */
  referralCode?: string;
}

function validateSignup(body: SignupBody): string | null {
  if (!body.inviteCode?.trim()) return 'Invite code is required';
  if (!body.username?.trim()) return 'Username is required';
  if (!USERNAME_RE.test(body.username.toLowerCase()))
    return 'Username must be 3-30 chars, start with a letter, and contain only lowercase letters, numbers, hyphens, or underscores';
  if (!body.email?.trim()) return 'Email is required';
  if (!EMAIL_RE.test(body.email.toLowerCase()))
    return 'Email must be a valid address';
  if (!body.password || body.password.length < 8) return 'Password must be at least 8 characters';
  // Referrals are optional. A blank field just means no referrer; a filled-in
  // field that is malformed is a typo we refuse rather than silently drop,
  // because dropping it quietly loses someone their attribution.
  if (body.referralCode?.trim() && !isWellFormedCode(normalizeCode(body.referralCode)))
    return 'Referral code is not valid';
  return null;
}

// KC admin token + user lookups live in ./keycloak.js (getKcAdminToken).

// ─── Validate Invite Code ──────────────────────────────────────────────────

router.post(
  '/validate-invite',
  verifyTurnstile(TURNSTILE_ACTION_VALIDATE_INVITE),
  async (req: Request, res: Response) => {
  try {
    const { inviteCode } = req.body as { inviteCode?: string };
    if (!inviteCode?.trim()) {
      res.status(400).json({ valid: false, error: 'Invite code is required' });
      return;
    }

    const code = inviteCode.trim().toUpperCase();
    const invite = await getInviteCode(code);

    if (!invite) {
      res.status(404).json({ valid: false, error: 'Invalid invite code' });
      return;
    }
    if (invite.redeemed) {
      res.status(409).json({ valid: false, error: 'This invite code has already been used' });
      return;
    }

    res.json({ valid: true, message: 'Invite code is valid' });
  } catch (err) {
    console.error('[validate-invite] Error:', err);
    res.status(500).json({ valid: false, error: 'Failed to validate invite code' });
  }
});

// ─── Signup ─────────────────────────────────────────────────────────────────

router.post(
  '/signup',
  verifyTurnstile(TURNSTILE_ACTION_SIGNUP),
  async (req: Request, res: Response) => {
  // Hoisted so the catch block can undo whatever this request managed to
  // create. Both stay null until the corresponding write actually succeeds,
  // which is what keeps compensation from touching anything we didn't make.
  let createdKcUuid: string | null = null;
  let claimedInviteCode: string | null = null;
  let username = '';
  let email = '';

  try {
    const body = req.body as SignupBody;
    const validationError = validateSignup(body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    username = body.username.toLowerCase().trim();
    email = body.email.toLowerCase().trim();
    const inviteCode = body.inviteCode.trim().toUpperCase();

    // 1. CLAIM the invite code atomically.
    //
    //    This single UPDATE is what makes the route safe against a double
    //    submit. The old code read the invite here and marked it redeemed at
    //    the very end, so two requests could both pass this point and both go
    //    on to create a Keycloak user — the second one failing, and reporting
    //    failure for an account that had just been created successfully.
    const claim = await claimInviteCode(inviteCode, { username, email });

    if (claim.status === 'not_found') {
      res.status(400).json({ error: 'Invalid invite code' });
      return;
    }

    if (claim.status === 'already_redeemed') {
      // If the same person holds the claim, this is their own duplicate
      // request — the first one is either done or still running. Report
      // success rather than an alarming error about their own signup.
      const owner = claim.redeemedBy;
      const sameUser =
        owner?.username === username && owner?.email === email;

      if (sameUser) {
        console.log(`[signup] duplicate submit for ${username} — replaying original outcome`);
        res.json({
          success: true,
          username,
          email,
          partyId: owner?.partyId ?? null,
          kcUuid: null,
          referralCode: null,
          duplicate: true,
          message: 'Account created. Please login to continue.',
        });
        return;
      }

      res.status(400).json({ error: 'Invite code has already been used' });
      return;
    }

    // Claim held. From here on, any failure must hand it back.
    claimedInviteCode = inviteCode;

    // 1b. Resolve the referral code (if any) BEFORE we touch Keycloak or
    //     Canton. Everything from step 3 on is an irreversible external write,
    //     so a bad code must fail here, while failing is still free.
    const rawReferral = body.referralCode?.trim() ?? '';
    let referralCode: string | null = null;
    if (rawReferral) {
      const found = await lookupActiveCode(getPool(), rawReferral);
      if (!found) {
        res.status(400).json({
          error: 'invalid_referral_code',
          message: 'That referral code is not valid.',
        });
        return;
      }
      referralCode = found.code;
    }

    // 2. Check if username or email already exists in Keycloak
    const kcAdminToken = await getKcAdminToken();
    const existingByUsername = (
      await (
        await fetch(
          `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
          { headers: { Authorization: `Bearer ${kcAdminToken}` } },
        )
      ).json()
    ) as any[];
    if (existingByUsername?.length > 0) {
      res.status(409).json({ error: 'Username is already taken.' });
      return;
    }
    const existingByEmail = (
      await (
        await fetch(
          `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users?email=${encodeURIComponent(email)}&exact=true`,
          { headers: { Authorization: `Bearer ${kcAdminToken}` } },
        )
      ).json()
    ) as any[];
    if (existingByEmail?.length > 0) {
      res.status(409).json({ error: 'An account with that email already exists.' });
      return;
    }

    // 3. Create the Keycloak user with username + email.
    const kcCreateRes = await fetch(
      `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kcAdminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username,
          email,
          enabled: true,
          credentials: [{ type: 'password', value: body.password, temporary: false }],
        }),
      },
    );

    if (!kcCreateRes.ok) {
      const errText = await kcCreateRes.text();
      res.status(400).json({ error: 'Failed to create user account', details: errText });
      return;
    }

    // 4. Get the Keycloak UUID (sub) — used as the Canton partyIdHint so
    //    Splice's wallet UI on the validator (which resolves a user's party
    //    by their Keycloak `sub`) can find this party.
    const kcUserRes = await fetch(
      `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
      { headers: { Authorization: `Bearer ${kcAdminToken}` } },
    );
    const kcUsers = (await kcUserRes.json()) as any[];
    const kcUuid: string | undefined = kcUsers?.[0]?.id;
    if (!kcUuid) {
      res.status(500).json({ error: 'Failed to resolve user account' });
      return;
    }

    // From here the Keycloak user exists and is ours to clean up on failure.
    createdKcUuid = kcUuid;

    // partyIdHint allowed chars are [A-Za-z0-9_-]; Keycloak UUIDs (lowercase
    // hex + '-') already satisfy this, so no sanitization needed.
    const partyHint = kcUuid;

    console.log(
      `[signup] Keycloak user created: username=${username} email=${email} sub=${kcUuid} partyHint=${partyHint}`,
    );

    // 5. Allocate Canton party with hint = Keycloak sub.
    const cantonAdminToken = await getAdminToken();
    const partyRes = await fetch(`${CANTON_LEDGER_API}/v2/parties`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cantonAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ partyIdHint: partyHint, identityProviderId: '' }),
    });

    const partyData = await partyRes.json() as any;
    const partyId: string | undefined = partyData.partyDetails?.party;
    if (!partyId) {
      res.status(400).json({ error: 'Failed to create Canton party', details: partyData });
      return;
    }
    console.log(`[signup] Canton party created: ${partyId}`);

    // 6. Create Canton user (link kcUuid → primaryParty=partyId).
    await fetch(`${CANTON_LEDGER_API}/v2/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cantonAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user: {
          id: kcUuid,
          primaryParty: partyId,
          isDeactivated: false,
          metadata: { resourceVersion: '', annotations: {} },
          identityProviderId: '',
        },
      }),
    });

    // 7. Grant CanActAs + CanReadAs.
    await grantRight(cantonAdminToken, kcUuid, 'CanActAs', partyId);
    await grantRight(cantonAdminToken, kcUuid, 'CanReadAs', partyId);
    console.log(`[signup] Rights granted for ${username}`);

    // 8. Upsert into our local users table so /me + the watcher find them.
    //    We store email so future server-side lookups (if we ever add
    //    `x-user-email` resolution) don't need to re-derive the hint.
    //    The referral edge is written in the SAME transaction as the user
    //    row: either both land or neither does, so we can never end up with a
    //    user whose referral silently vanished or a referral pointing at a
    //    party that was never recorded.
    const dbClient = await getPool().connect();
    let referralBound = false;
    try {
      await dbClient.query('BEGIN');
      await dbClient.query(
        `INSERT INTO users (party_id, is_external, keycloak_sub, username, email)
           VALUES ($1, false, $2, $3, $4)
         ON CONFLICT (party_id) DO UPDATE
           SET keycloak_sub = EXCLUDED.keycloak_sub,
               username     = EXCLUDED.username,
               email        = EXCLUDED.email`,
        [partyId, kcUuid, username, email],
      );

      if (referralCode) {
        const bind = await bindReferral(dbClient, {
          refereePartyId: partyId,
          rawCode: referralCode,
          source: 'signup',
        });
        referralBound = bind.ok;
        if (!bind.ok) {
          // The code was verified at step 1b and this party was created
          // seconds ago, so there is no ordinary way to land here. If we
          // somehow do, keep the account: the user has a live Keycloak
          // identity and a Canton party by now, and failing the whole signup
          // over a lost attribution is far worse than losing the attribution.
          console.error(
            `[signup] referral bind failed for ${partyId} `
            + `(code=${referralCode}): ${bind.reason}`,
          );
        }
      }

      await dbClient.query('COMMIT');
    } catch (e) {
      await dbClient.query('ROLLBACK').catch(() => {});
      // System-wide email uniqueness backstop (23505). Keycloak already rejects
      // duplicate emails at step 2, so this is a rare race; surface it cleanly.
      if ((e as { code?: string }).code === '23505') {
        res.status(409).json({ error: 'An account with that email already exists.' });
        return;
      }
      throw e;
    } finally {
      dbClient.release();
    }

    // 9. (deferred) VaultAccountProposal — the new operator-only-signed
    //    contract may not need it. Re-enable here once the new Daml package
    //    + template IDs are confirmed (see canton-sdk/config.ts).

    // 10. Attach the resolved party id to the claim we already took at
    //     step 1. The code is spent either way — this only enriches the
    //     record, so a failure here is not worth failing the signup over.
    const userInfo: RedeemedByInfo = { username, email, partyId };
    try {
      await finalizeInviteClaim(inviteCode, userInfo);
    } catch (finalizeErr) {
      console.error('[signup] Failed to finalize invite claim:', finalizeErr);
    }

    console.log(`[signup] Complete: ${username} → ${partyId}`);

    res.json({
      success: true,
      username,
      email,
      partyId,
      kcUuid,
      referralCode: referralBound ? referralCode : null,
      message: 'Account created. Please login to continue.',
    });
  } catch (err) {
    console.error('[signup] Error:', err);

    // ─── Compensation ─────────────────────────────────────────────────
    // Everything from the Keycloak create onwards is an external write with
    // no transaction around it. Before this existed, a failure at party
    // creation (or any step after) left a Keycloak user behind with no
    // Canton party — and that orphan permanently locked the person out:
    // retrying returned "Username is already taken", and a different
    // username returned "An account with that email already exists".
    //
    // So we undo what we made. Only ever touches the user THIS request
    // created seconds ago (createdKcUuid is set solely on that path), never
    // a pre-existing account.
    await compensateFailedSignup({
      kcUuid: createdKcUuid,
      inviteCode: claimedInviteCode,
      username,
      reason: err instanceof Error ? err.message : String(err),
    });

    res.status(500).json({
      error: 'Signup failed',
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Undo a half-completed signup.
 *
 * Deletes the Keycloak user this request created and hands the invite code
 * back, so the person can simply try again with the same username and email.
 * Without it, any failure after the Keycloak write left an orphaned account
 * that made those details permanently unusable — the user could neither retry
 * nor pick a different username (the email check would still catch them).
 *
 * Best-effort by construction: it must never throw, because it runs inside a
 * catch block that still has to send a response. If the cleanup itself fails
 * the orphan is real and needs a human, so that case raises an ops alert
 * rather than disappearing into the logs.
 */
async function compensateFailedSignup(args: {
  kcUuid: string | null;
  inviteCode: string | null;
  username: string;
  reason: string;
}): Promise<void> {
  const { kcUuid, inviteCode, username, reason } = args;

  // Release the invite first: it's a local UPDATE and by far the more likely
  // of the two to succeed, and a released code is what lets the user retry.
  if (inviteCode) {
    try {
      await releaseInviteCode(inviteCode);
      console.log(`[signup] compensation: released invite ${inviteCode}`);
    } catch (e) {
      console.error('[signup] compensation: FAILED to release invite:', e);
      await registerAlert(getPool(), {
        type: 'signup_compensation_failed',
        severity: 'warning',
        dedupKey: `signup_invite_release:${inviteCode}`,
        title: 'Signup rollback could not release an invite code',
        body:
          `Invite ${inviteCode} is still marked redeemed after a failed signup `
          + `for "${username}". The user cannot retry until it is released.`,
        context: { inviteCode, username, reason },
      }).catch(() => {});
    }
  }

  if (!kcUuid) return;

  try {
    const adminToken = await getKcAdminToken();
    const del = await fetch(
      `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users/${kcUuid}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } },
    );
    // 404 means it's already gone, which is the state we wanted anyway.
    if (!del.ok && del.status !== 404) {
      throw new Error(`Keycloak delete returned ${del.status}: ${await del.text()}`);
    }
    console.log(`[signup] compensation: removed orphaned Keycloak user ${kcUuid}`);
  } catch (e) {
    console.error('[signup] compensation: FAILED to delete Keycloak user:', e);
    await registerAlert(getPool(), {
      type: 'signup_orphan_user',
      severity: 'critical',
      dedupKey: `signup_orphan:${kcUuid}`,
      title: 'Orphaned Keycloak user left by a failed signup',
      body:
        `Signup for "${username}" failed and the rollback could not delete `
        + `Keycloak user ${kcUuid}. That account has no Canton party, and the `
        + `username/email are now unusable until it is removed by hand.`,
      context: {
        kcUuid,
        username,
        signupError: reason,
        cleanupError: e instanceof Error ? e.message : String(e),
      },
    }).catch(() => {});
  }
}

// ─── Helper ─────────────────────────────────────────────────────────────────

async function grantRight(
  adminToken: string,
  userId: string,
  kind: 'CanActAs' | 'CanReadAs',
  party: string,
): Promise<void> {
  const res = await fetch(`${CANTON_LEDGER_API}/v2/users/${userId}/rights`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      userId,
      rights: [{ kind: { [kind]: { value: { party } } } }],
      identityProviderId: '',
    }),
  });
  const text = await res.text();
  if (!res.ok && !/already|duplicate|EXIST|RIGHTS/i.test(text)) {
    console.warn(`Grant ${kind} warning: ${text}`);
  }
}


/** Constant-time string compare — a plain `!==` leaks the key byte by byte. */
function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ─── Admin: List invite codes ───────────────────────────────────────────────

router.get('/admin/invite-codes', (req: Request, res: Response, next) => {
  // Fail closed: an unset ADMIN_API_KEY disables the route rather than
  // matching the empty string a caller could trivially send.
  if (!ADMIN_API_KEY) {
    console.warn('[admin] ADMIN_API_KEY not set — refusing admin request');
    res.status(503).json({ error: 'admin API not configured' });
    return;
  }
  const raw = req.headers['x-api-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || !safeEqualStr(key, ADMIN_API_KEY)) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }
  next();
}, async (_req: Request, res: Response) => {
  try {
    const codes = await listInviteCodes();
    res.json({ codes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list invite codes', details: String(err) });
  }
});

export default router;
