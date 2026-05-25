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
import { getAdminToken } from './auth.js';
import { getInviteCode, redeemInviteCode, listInviteCodes, type RedeemedByInfo } from './db.js';
import { getPool } from './db/pool.js';
import {
  CANTON_LEDGER_API,
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET,
  KC_ADMIN_USERNAME,
  KC_ADMIN_PASSWORD,
  ADMIN_API_KEY,
} from './config.js';

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
  return null;
}

// ─── KC Admin helpers ───────────────────────────────────────────────────────

let kcAdminTokenCache: { token: string; expiry: number } | null = null;

async function getKcAdminToken(): Promise<string> {
  if (kcAdminTokenCache && Date.now() < kcAdminTokenCache.expiry - 30_000) {
    return kcAdminTokenCache.token;
  }

  const res = await fetch(`${KEYCLOAK_BASE}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'admin-cli',
      username: KC_ADMIN_USERNAME,
      password: KC_ADMIN_PASSWORD,
      grant_type: 'password',
    }),
  });

  if (!res.ok) throw new Error(`KC admin token failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  kcAdminTokenCache = { token: data.access_token, expiry: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

// ─── Validate Invite Code ──────────────────────────────────────────────────

router.post('/validate-invite', async (req: Request, res: Response) => {
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

router.post('/signup', async (req: Request, res: Response) => {
  try {
    const body = req.body as SignupBody;
    const validationError = validateSignup(body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const username = body.username.toLowerCase().trim();
    const email = body.email.toLowerCase().trim();
    const inviteCode = body.inviteCode.trim().toUpperCase();

    // 1. Validate invite code
    const invite = await getInviteCode(inviteCode);
    if (!invite) {
      res.status(400).json({ error: 'Invalid invite code' });
      return;
    }
    if (invite.redeemed) {
      res.status(400).json({ error: 'Invite code has already been used' });
      return;
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
    await getPool().query(
      `INSERT INTO users (party_id, is_external, keycloak_sub, username, email)
         VALUES ($1, false, $2, $3, $4)
       ON CONFLICT (party_id) DO UPDATE
         SET keycloak_sub = EXCLUDED.keycloak_sub,
             username     = EXCLUDED.username,
             email        = EXCLUDED.email`,
      [partyId, kcUuid, username, email],
    );

    // 9. (deferred) VaultAccountProposal — the new operator-only-signed
    //    contract may not need it. Re-enable here once the new Daml package
    //    + template IDs are confirmed (see canton-sdk/config.ts).

    // 10. Redeem invite code.
    const userInfo: RedeemedByInfo = { username, email, partyId };
    try {
      await redeemInviteCode(inviteCode, userInfo);
    } catch (redeemErr) {
      // Race condition: someone else redeemed between check and here.
      // User is already created; just log.
      console.error(`[signup] Failed to mark invite code as redeemed:`, redeemErr);
    }

    console.log(`[signup] Complete: ${username} → ${partyId}`);

    res.json({
      success: true,
      username,
      email,
      partyId,
      kcUuid,
      message: 'Account created. Please login to continue.',
    });
  } catch (err) {
    console.error('[signup] Error:', err);
    res.status(500).json({
      error: 'Signup failed',
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

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

// ─── Admin: List invite codes ───────────────────────────────────────────────

router.get('/admin/invite-codes', (req: Request, res: Response, next) => {
  const key = req.headers['x-api-key'];
  if (key !== ADMIN_API_KEY) {
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
