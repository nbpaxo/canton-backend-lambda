/**
 * Signup route — invite code based onboarding.
 *
 * Flow:
 *   1. Validate invite code (DynamoDB)
 *   2. Check username not taken (Keycloak)
 *   3. Create Canton party (POST /v2/parties)
 *   4. Create Keycloak user (admin API)
 *   5. Get Keycloak user UUID
 *   6. Create Canton user (link KC UUID → party)
 *   7. Grant CanActAs + CanReadAs
 *   8. Create VaultAccountProposal on Canton
 *   9. Mark invite code as redeemed
 */

import { Router, Request, Response } from 'express';
import { canton } from './sdk.js';
import { getAdminToken } from './auth.js';
import { getInviteCode, redeemInviteCode, listInviteCodes, type RedeemedByInfo } from './db.js';
import {
  CANTON_LEDGER_API,
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET,
  PACKAGE_ID,
  PARTIES,
  ADMIN_API_KEY,
} from './config.js';
import { getTemplateIds } from './canton-sdk/config.js';
import { getOperatorToken } from './canton-sdk/tokens.js';
import { submitCommand } from './canton-sdk/ledger.js';
import { resolveOperatorCantonId } from './canton-sdk/operator.js';
import { sdkConfig } from './sdk.js';

const router = Router();

// ─── Validation helpers ─────────────────────────────────────────────────────

const USERNAME_RE = /^[a-z][a-z0-9_-]{2,29}$/;

interface SignupBody {
  inviteCode: string;
  username: string;
  password: string;
}

function validateSignup(body: SignupBody): string | null {
  if (!body.inviteCode?.trim()) return 'Invite code is required';
  if (!body.username?.trim()) return 'Username is required';
  if (!USERNAME_RE.test(body.username.toLowerCase()))
    return 'Username must be 3-30 chars, start with a letter, and contain only lowercase letters, numbers, hyphens, or underscores';
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
      username: 'admin',
      password: 'admin',
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

    // 2. Check if username already exists in Keycloak
    const kcAdminToken = await getKcAdminToken();
    const existingUserRes = await fetch(
      `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
      { headers: { Authorization: `Bearer ${kcAdminToken}` } },
    );
    const existingUsers = (await existingUserRes.json()) as any[];
    if (existingUsers && existingUsers.length > 0) {
      res.status(409).json({ error: 'Username is already taken. Please choose a different username.' });
      return;
    }

    // 3. Create Canton party
    const cantonAdminToken = await getAdminToken();
    const partyRes = await fetch(`${CANTON_LEDGER_API}/v2/parties`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cantonAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ partyIdHint: username, identityProviderId: '' }),
    });

    const partyData = await partyRes.json() as any;
    const partyId = partyData.partyDetails?.party;

    if (!partyId) {
      res.status(400).json({ error: 'Failed to create Canton party', details: partyData });
      return;
    }

    console.log(`[signup] Canton party created: ${partyId}`);

    // 4. Create Keycloak user
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

    // 5. Get Keycloak user UUID
    const kcUserRes = await fetch(
      `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
      { headers: { Authorization: `Bearer ${kcAdminToken}` } },
    );
    const kcUsers = (await kcUserRes.json()) as any[];
    const kcUuid = kcUsers?.[0]?.id;
    if (!kcUuid) {
      res.status(500).json({ error: 'Failed to resolve user account' });
      return;
    }

    console.log(`[signup] Keycloak user created: ${kcUuid}`);

    // 6. Create Canton user (link KC UUID → party)
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

    // 7. Grant CanActAs + CanReadAs
    await grantRight(cantonAdminToken, kcUuid, 'CanActAs', partyId);
    await grantRight(cantonAdminToken, kcUuid, 'CanReadAs', partyId);

    console.log(`[signup] Rights granted for ${username}`);

    // 8. Create VaultAccountProposal
    try {
      const templates = getTemplateIds(PACKAGE_ID);
      const opToken = await getOperatorToken(sdkConfig);
      const opCantonId = await resolveOperatorCantonId(sdkConfig);

      await submitCommand(
        sdkConfig,
        opToken,
        opCantonId,
        [PARTIES.operator, PARTIES.vaultPool],
        [
          {
            CreateCommand: {
              templateId: templates.VaultAccountProposal,
              createArguments: {
                operator: PARTIES.operator,
                user: partyId,
                issuer: PARTIES.tokenIssuer,
                vaultPool: PARTIES.vaultPool,
              },
            },
          },
        ],
      );

      console.log(`[signup] VaultAccountProposal created for ${username}`);
    } catch (vaultErr) {
      console.error(`[signup] VaultAccountProposal failed (non-fatal):`, vaultErr);
      // Non-fatal — user can still login, operator can create proposal later
    }

    // 9. Redeem invite code with username
    const userInfo: RedeemedByInfo = {
      username,
    };

    try {
      await redeemInviteCode(inviteCode, userInfo);
    } catch (redeemErr) {
      // Race condition: someone else redeemed between check and here
      // User is already created, so just log the warning
      console.error(`[signup] Failed to mark invite code as redeemed:`, redeemErr);
    }

    console.log(`[signup] Complete: ${username} → ${partyId}`);

    res.json({
      success: true,
      username,
      partyId,
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
