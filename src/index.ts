/**
 * AWS Lambda handler — direct API Gateway routing, no Express overhead.
 *
 * API Gateway routes ALL requests via {proxy+} to this handler.
 * This file parses the event, authenticates if needed, and calls
 * the appropriate handler function.
 *
 * Local dev still uses server.ts (Express) — this file is Lambda-only.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult, APIGatewayProxyEventV2 } from 'aws-lambda';
import { canton, sdkConfig } from './sdk.js';
import { getAdminToken } from './auth.js';
import { getInviteCode, redeemInviteCode, listInviteCodes, type RedeemedByInfo } from './db.js';
import {
  CANTON_LEDGER_API,
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET,
  EXCHANGE_DEPOSIT_URL,
  EXCHANGE_WITHDRAW_URL,
  CIRCLE_KC_USERNAME,
  CIRCLE_KC_PASSWORD,
  PACKAGE_ID,
  ADMIN_API_KEY,
  CORS_ORIGINS,
  PARTIES,
} from './config.js';
import { getTemplateIds } from './canton-sdk/config.js';
import { getOperatorToken } from './canton-sdk/tokens.js';
import { getActiveContracts, submitCommand, extractCreatedContractId } from './canton-sdk/ledger.js';
import { resolveOperatorCantonId } from './canton-sdk/operator.js';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';

// ─── Types ──────────────────────────────────────────────────────────────────

interface UserInfo {
  sub: string;
  party: string;
  keycloakToken: string;
}

type RouteHandler = (body: any, user: UserInfo | null, event: APIGatewayProxyEvent) => Promise<{ status: number; body: any }>;

// ─── CORS ───────────────────────────────────────────────────────────────────

function corsHeaders(event: APIGatewayProxyEvent) {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowed = CORS_ORIGINS.includes(origin) ? origin : CORS_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
  };
}

// ─── Auth ───────────────────────────────────────────────────────────────────

const jwksClient = jwksRsa({
  jwksUri: `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600_000,
});

const partyCache = new Map<string, { party: string; ts: number }>();
const PARTY_CACHE_TTL = 5 * 60_000;

async function resolveParty(adminToken: string, sub: string): Promise<string> {
  const cached = partyCache.get(sub);
  if (cached && Date.now() - cached.ts < PARTY_CACHE_TTL) return cached.party;

  const res = await fetch(`${CANTON_LEDGER_API}/v2/users/${sub}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) throw new Error(`Canton user lookup failed (${res.status})`);
  const data = await res.json() as { user?: { primaryParty?: string } };
  const party = data.user?.primaryParty;
  if (!party) throw new Error(`No primaryParty for canton user ${sub}`);

  partyCache.set(sub, { party, ts: Date.now() });
  return party;
}

function verifyJwt(token: string): Promise<jwt.JwtPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      (header, cb) => {
        jwksClient.getSigningKey(header.kid, (err, key) => {
          if (err) return cb(err);
          cb(null, key?.getPublicKey());
        });
      },
      { algorithms: ['RS256'], issuer: `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}` },
      (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded as jwt.JwtPayload);
      },
    );
  });
}

async function authenticate(event: APIGatewayProxyEvent): Promise<UserInfo> {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing Authorization header');

  const token = authHeader.slice(7);
  const payload = await verifyJwt(token);
  const sub = payload.sub as string;

  const adminToken = await getAdminToken();
  const party = await resolveParty(adminToken, sub);

  return { sub, party, keycloakToken: token };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function txRef(): string {
  return `canton-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ok(data: any) { return { status: 200, body: data }; }
function bad(msg: string, extra?: any) { return { status: 400, body: { error: msg, ...extra } }; }
function fail(msg: string) { return { status: 500, body: { error: msg } }; }

// ─── Signup helpers ─────────────────────────────────────────────────────────

const USERNAME_RE = /^[a-z][a-z0-9_-]{2,29}$/;

let kcAdminTokenCache: { token: string; expiry: number } | null = null;

async function getKcAdminToken(): Promise<string> {
  if (kcAdminTokenCache && Date.now() < kcAdminTokenCache.expiry - 30_000) {
    return kcAdminTokenCache.token;
  }
  const res = await fetch(`${KEYCLOAK_BASE}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'admin-cli', username: 'admin', password: 'admin', grant_type: 'password',
    }),
  });
  if (!res.ok) throw new Error(`KC admin token failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  kcAdminTokenCache = { token: data.access_token, expiry: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function grantRight(adminToken: string, userId: string, kind: 'CanActAs' | 'CanReadAs', party: string) {
  const res = await fetch(`${CANTON_LEDGER_API}/v2/users/${userId}/rights`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, rights: [{ kind: { [kind]: { value: { party } } } }], identityProviderId: '' }),
  });
  const text = await res.text();
  if (!res.ok && !/already|duplicate|EXIST|RIGHTS/i.test(text)) {
    console.warn(`Grant ${kind} warning: ${text}`);
  }
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

const handleHealth: RouteHandler = async () => {
  return ok({ status: 'ok', timestamp: new Date().toISOString() });
};

const handleVaultStatus: RouteHandler = async (_body, user) => {
  try {
    const status = await canton.getVaultAccountStatus(user!.party);
    return ok(status);
  } catch (err) {
    console.error('Vault status error:', err);
    return fail('Failed to check vault status');
  }
};

const handleVaultAcceptProposal: RouteHandler = async (_body, user) => {
  try {
    const status = await canton.getVaultAccountStatus(user!.party);

    if (status.status === 'ACTIVE') return ok({ ok: true, message: 'Vault account is already active.' });
    if (status.status === 'NOT_CREATED' || !status.proposalContractId) return bad('No pending vault proposal found.');

    const result = await canton.acceptVaultProposal(user!.keycloakToken, user!.sub, user!.party, status.proposalContractId);
    return ok(result);
  } catch (err) {
    console.error('Accept proposal error:', err);
    return fail('Failed to accept vault proposal');
  }
};

const handleHoldings: RouteHandler = async (_body, user) => {
  try {
    const holdings = await canton.getUserHoldings(user!.keycloakToken, user!.party);
    const totalBalance = holdings.reduce((sum, h) => sum + h.amount, 0);
    return ok({
      holdings: holdings.map(h => ({ contractId: h.contractId, amount: h.amount, owner: h.owner, issuer: h.issuer })),
      totalBalance,
    });
  } catch (err) {
    console.error('Holdings query error:', err);
    return fail('Failed to fetch holdings');
  }
};

const handleDepositReceipts: RouteHandler = async (_body, user) => {
  try {
    const receipts = await canton.getUserVaultHoldings(user!.party);
    const totalDeposited = receipts.reduce((sum, r) => sum + r.amount, 0);
    return ok({
      receipts: receipts.map(r => ({
        contractId: r.contractId, amount: r.amount,
        txnHash: r.depositRef || r.contractId, depositRef: r.depositRef, user: r.user,
      })),
      totalDeposited,
    });
  } catch (err) {
    console.error('Deposit receipts query error:', err);
    return fail('Failed to fetch deposit receipts');
  }
};

const handleFaucet: RouteHandler = async (body, user) => {
  try {
    const { amount } = body as { amount?: number };
    if (!amount || amount <= 0 || amount > 10000) return bad('Amount must be between 0 and 10,000 USDC');

    const templates = getTemplateIds(PACKAGE_ID);
    const circleToken = await canton.getCircleToken(CIRCLE_KC_USERNAME, CIRCLE_KC_PASSWORD);
    const circleCantonId = await canton.resolveCircleCantonId();

    const result = await submitCommand(sdkConfig, circleToken, circleCantonId, [sdkConfig.parties.tokenIssuer], [
      { CreateCommand: { templateId: templates.MintProposal, createArguments: { issuer: sdkConfig.parties.tokenIssuer, owner: user!.party, amount: amount.toString() } } },
    ]);

    const proposalCid = extractCreatedContractId(result, templates.MintProposal);
    console.log(`[faucet] MintProposal created for ${user!.party.split('::')[0]}: ${amount} USDC (cid: ${proposalCid})`);
    return ok({ ok: true, proposalContractId: proposalCid, amount, message: `Mint proposal for ${amount} USDC created. Accept it to receive tokens.` });
  } catch (err) {
    console.error('Faucet error:', err);
    return fail('Failed to create mint proposal');
  }
};

const handleMintProposals: RouteHandler = async (_body, user) => {
  try {
    const templates = getTemplateIds(PACKAGE_ID);
    const contracts = await getActiveContracts(sdkConfig, user!.keycloakToken, user!.party, templates.MintProposal);
    const proposals = contracts
      .map(c => {
        const p = c.payload as Record<string, unknown>;
        return { contractId: c.contractId, issuer: String(p.issuer ?? ''), owner: String(p.owner ?? ''), amount: parseFloat(String(p.amount ?? '0')) };
      })
      .filter(p => p.owner === user!.party && p.amount > 0);
    return ok({ proposals });
  } catch (err) {
    console.error('Mint proposals query error:', err);
    return fail('Failed to fetch mint proposals');
  }
};

const handleAcceptMint: RouteHandler = async (body, user) => {
  try {
    const { contractId } = body as { contractId?: string };
    if (!contractId) return bad('contractId is required');

    const templates = getTemplateIds(PACKAGE_ID);
    const result = await submitCommand(sdkConfig, user!.keycloakToken, user!.sub, [user!.party], [
      { ExerciseCommand: { templateId: templates.MintProposal, contractId, choice: 'AcceptMint', choiceArgument: {} } },
    ]);
    const holdingCid = extractCreatedContractId(result, templates.Holding);
    console.log(`[mint] User ${user!.party.split('::')[0]} accepted MintProposal → Holding: ${holdingCid}`);
    return ok({ ok: true, holdingContractId: holdingCid, message: 'Mint accepted. USDC has been added to your holdings.' });
  } catch (err) {
    console.error('Accept mint error:', err);
    return fail('Failed to accept mint proposal');
  }
};

const handleDeposit: RouteHandler = async (body, user) => {
  try {
    const { amount, coin = 'USDT' } = body as { amount?: number; coin?: string };
    if (!amount || amount <= 0) return bad('Invalid amount');

    const holdings = await canton.getUserHoldings(user!.keycloakToken, user!.party);
    if (!holdings || holdings.length === 0) return bad('No token holdings found. Mint tokens first.');

    // Smart holding selection: exact match first, then smallest sufficient
    const sortedByAmount = [...holdings].sort((a, b) => a.amount - b.amount);
    const holding = sortedByAmount.find(h => h.amount === amount)
      ?? sortedByAmount.find(h => h.amount >= amount);

    if (!holding) {
      const totalBalance = holdings.reduce((sum, h) => sum + h.amount, 0);
      if (totalBalance < amount) {
        return bad(`Insufficient USDC balance. You have ${totalBalance} USDC but tried to deposit ${amount} USDC.`);
      }
      return bad(
        `No single holding has ${amount} USDC. Your holdings are split across ${holdings.length} contracts. Please deposit in smaller amounts.`,
        { holdings: holdings.map(h => ({ contractId: h.contractId, amount: h.amount })) },
      );
    }

    console.log(`[deposit] Selected holding ${holding.contractId.slice(0, 10)}… (${holding.amount} USDC) for ${amount} USDC deposit`);

    let cantonResult;
    try {
      cantonResult = await canton.deposit({ userToken: user!.keycloakToken, userCantonId: user!.sub, userParty: user!.party, holdingCid: holding.contractId, amount });
    } catch (cantonErr) {
      console.error('Canton deposit failed:', cantonErr);
      return fail('Deposit failed on Canton ledger. Please try again.');
    }

    const ref = txRef();
    const exchangeRes = await fetch(EXCHANGE_DEPOSIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: user!.party.split('::')[0], coin, amount, txnHash: ref, network: '0' }),
    });
    const exchangeData = await exchangeRes.json() as Record<string, unknown>;

    if (!exchangeRes.ok) {
      console.error('Exchange deposit API failed:', exchangeData);
      return { status: 207, body: { success: true, cantonSuccess: true, exchangeSuccess: false, txRef: ref, cantonResult, exchangeError: exchangeData } };
    }

    return ok({ success: true, txRef: ref, cantonResult, exchangeResult: exchangeData });
  } catch (err) {
    console.error('Deposit error:', err);
    return fail('Deposit failed. Please try again.');
  }
};

const handleWithdraw: RouteHandler = async (body, user) => {
  try {
    const { amount, coin = 'USDT', nonce, approvalId } = body as { amount?: number; coin?: string; nonce?: string; approvalId?: number };
    if (!amount || amount <= 0) return bad('Invalid amount');
    if (!nonce || approvalId === undefined) return bad('Missing nonce or approvalId from approval step');

    let cantonResult;
    try {
      cantonResult = await canton.withdraw({ userToken: user!.keycloakToken, userCantonId: user!.sub, userParty: user!.party, amount });
    } catch (cantonErr) {
      console.error('Canton withdraw failed:', cantonErr);
      return fail('Withdrawal failed on Canton ledger. Please try again.');
    }

    const ref = txRef();
    const exchangeRes = await fetch(EXCHANGE_WITHDRAW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: user!.party.split('::')[0], coin, amount, txnHash: ref, nonce, approvalId }),
    });
    const exchangeData = await exchangeRes.json() as Record<string, unknown>;

    if (!exchangeRes.ok) {
      console.error('Exchange withdraw API failed:', exchangeData);
      return { status: 207, body: { success: true, cantonSuccess: true, exchangeSuccess: false, txRef: ref, cantonResult, exchangeError: exchangeData } };
    }

    return ok({ success: true, txRef: ref, cantonResult, exchangeResult: exchangeData });
  } catch (err) {
    console.error('Withdraw error:', err);
    return fail('Withdrawal failed. Please try again.');
  }
};

const handleValidateInvite: RouteHandler = async (body) => {
  try {
    const { inviteCode } = body as { inviteCode?: string };
    if (!inviteCode?.trim()) return bad('Invite code is required');

    const code = inviteCode.trim().toUpperCase();
    const invite = await getInviteCode(code);

    if (!invite) return { status: 404, body: { valid: false, error: 'Invalid invite code' } };
    if (invite.redeemed) return { status: 409, body: { valid: false, error: 'This invite code has already been used' } };

    return ok({ valid: true, message: 'Invite code is valid' });
  } catch (err) {
    console.error('[validate-invite] Error:', err);
    return fail('Failed to validate invite code');
  }
};

const handleSignup: RouteHandler = async (body) => {
  try {
    const { inviteCode: rawCode, username: rawUser, password } = body as { inviteCode?: string; username?: string; password?: string };

    if (!rawCode?.trim()) return bad('Invite code is required');
    if (!rawUser?.trim()) return bad('Username is required');
    if (!USERNAME_RE.test(rawUser.toLowerCase())) return bad('Username must be 3-30 chars, start with a letter, and contain only lowercase letters, numbers, hyphens, or underscores');
    if (!password || password.length < 8) return bad('Password must be at least 8 characters');

    const username = rawUser.toLowerCase().trim();
    const inviteCode = rawCode.trim().toUpperCase();

    // 1. Validate invite code
    const invite = await getInviteCode(inviteCode);
    if (!invite) return bad('Invalid invite code');
    if (invite.redeemed) return bad('Invite code has already been used');

    // 2. Check if username exists in Keycloak
    const kcAdminToken = await getKcAdminToken();
    const existingUserRes = await fetch(
      `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
      { headers: { Authorization: `Bearer ${kcAdminToken}` } },
    );
    const existingUsers = (await existingUserRes.json()) as any[];
    if (existingUsers && existingUsers.length > 0) {
      return { status: 409, body: { error: 'Username is already taken. Please choose a different username.' } };
    }

    // 3. Create Canton party
    const cantonAdminToken = await getAdminToken();
    const partyRes = await fetch(`${CANTON_LEDGER_API}/v2/parties`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cantonAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ partyIdHint: username, identityProviderId: '' }),
    });
    const partyData = await partyRes.json() as any;
    const partyId = partyData.partyDetails?.party;
    if (!partyId) return bad('Failed to create Canton party');
    console.log(`[signup] Canton party created: ${partyId}`);

    // 4. Create Keycloak user
    const kcCreateRes = await fetch(`${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kcAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, enabled: true, credentials: [{ type: 'password', value: password, temporary: false }] }),
    });
    if (!kcCreateRes.ok) {
      const errText = await kcCreateRes.text();
      return bad('Failed to create user account');
    }

    // 5. Get Keycloak user UUID
    const kcUserRes = await fetch(
      `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
      { headers: { Authorization: `Bearer ${kcAdminToken}` } },
    );
    const kcUsers = (await kcUserRes.json()) as any[];
    const kcUuid = kcUsers?.[0]?.id;
    if (!kcUuid) return fail('Failed to resolve user account');
    console.log(`[signup] Keycloak user created: ${kcUuid}`);

    // 6. Create Canton user (link KC UUID → party)
    await fetch(`${CANTON_LEDGER_API}/v2/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cantonAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { id: kcUuid, primaryParty: partyId, isDeactivated: false, metadata: { resourceVersion: '', annotations: {} }, identityProviderId: '' } }),
    });

    // 7. Grant rights
    await grantRight(cantonAdminToken, kcUuid, 'CanActAs', partyId);
    await grantRight(cantonAdminToken, kcUuid, 'CanReadAs', partyId);
    console.log(`[signup] Rights granted for ${username}`);

    // 8. Create VaultAccountProposal
    try {
      const templates = getTemplateIds(PACKAGE_ID);
      const opToken = await getOperatorToken(sdkConfig);
      const opCantonId = await resolveOperatorCantonId(sdkConfig);
      await submitCommand(sdkConfig, opToken, opCantonId, [PARTIES.operator, PARTIES.vaultPool], [
        { CreateCommand: { templateId: templates.VaultAccountProposal, createArguments: { operator: PARTIES.operator, user: partyId, issuer: PARTIES.tokenIssuer, vaultPool: PARTIES.vaultPool } } },
      ]);
      console.log(`[signup] VaultAccountProposal created for ${username}`);
    } catch (vaultErr) {
      console.error(`[signup] VaultAccountProposal failed (non-fatal):`, vaultErr);
    }

    // 9. Redeem invite code
    try {
      await redeemInviteCode(inviteCode, { username } as RedeemedByInfo);
    } catch (redeemErr) {
      console.error(`[signup] Failed to mark invite code as redeemed:`, redeemErr);
    }

    console.log(`[signup] Complete: ${username} → ${partyId}`);
    return ok({ success: true, username, partyId, message: 'Account created. Please login to continue.' });
  } catch (err) {
    console.error('[signup] Error:', err);
    return fail('Signup failed');
  }
};

const handleAdminInviteCodes: RouteHandler = async (_body, _user, event) => {
  const key = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];
  if (key !== ADMIN_API_KEY) return { status: 401, body: { error: 'Invalid API key' } };
  try {
    const codes = await listInviteCodes();
    return ok({ codes });
  } catch (err) {
    return fail('Failed to list invite codes');
  }
};

// ─── Route Table ────────────────────────────────────────────────────────────

interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
  auth: boolean;
}

const routes: Route[] = [
  { method: 'GET',  path: '/health',                handler: handleHealth,             auth: false },
  { method: 'GET',  path: '/vault/status',           handler: handleVaultStatus,        auth: true },
  { method: 'POST', path: '/vault/accept-proposal',  handler: handleVaultAcceptProposal, auth: true },
  { method: 'GET',  path: '/holdings',               handler: handleHoldings,           auth: true },
  { method: 'GET',  path: '/deposit-receipts',       handler: handleDepositReceipts,    auth: true },
  { method: 'POST', path: '/faucet',                 handler: handleFaucet,             auth: true },
  { method: 'GET',  path: '/mint-proposals',         handler: handleMintProposals,      auth: true },
  { method: 'POST', path: '/mint-proposals/accept',  handler: handleAcceptMint,         auth: true },
  { method: 'POST', path: '/deposit',                handler: handleDeposit,            auth: true },
  { method: 'POST', path: '/withdraw',               handler: handleWithdraw,           auth: true },
  { method: 'POST', path: '/validate-invite',        handler: handleValidateInvite,     auth: false },
  { method: 'POST', path: '/signup',                 handler: handleSignup,             auth: false },
  { method: 'GET',  path: '/admin/invite-codes',     handler: handleAdminInviteCodes,   auth: false },
];

// ─── Lambda Handler ─────────────────────────────────────────────────────────

/**
 * Supports both API Gateway v1 (REST API) and v2 (HTTP API) event formats.
 */
export async function handler(event: any): Promise<APIGatewayProxyResult> {
  // v2 (HTTP API): requestContext.http.method / rawPath
  // v1 (REST API): httpMethod / path
  const v2Http = event.requestContext?.http;
  const method = v2Http?.method || event.httpMethod || 'GET';
  const rawPath = (v2Http?.path || event.rawPath || event.path || '/').replace(/\/+$/, '') || '/';

  // Strip API Gateway stage prefix (e.g. "/prod/health" → "/health")
  const stage = event.requestContext?.stage;
  const path = (stage && stage !== '$default' && rawPath.startsWith(`/${stage}`))
    ? rawPath.slice(stage.length + 1) || '/'
    : rawPath;

  const cors = corsHeaders(event);

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  // Match route
  const route = routes.find(r => r.method === method && r.path === path);
  if (!route) {
    console.log(`[router] No match for ${method} ${path} (raw: ${rawPath}, stage: ${stage})`);
    return { statusCode: 404, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Not found' }) };
  }

  // Authenticate if required
  let user: UserInfo | null = null;
  if (route.auth) {
    try {
      user = await authenticate(event);
    } catch (err) {
      return {
        statusCode: 401,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized', details: err instanceof Error ? err.message : String(err) }),
      };
    }
  }

  // Parse body
  let body: any = {};
  if (event.body) {
    try {
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
    } catch {
      body = {};
    }
  }

  // Execute handler
  try {
    const result = await route.handler(body, user, event);
    return {
      statusCode: result.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify(result.body),
    };
  } catch (err) {
    console.error(`[${method} ${path}] Unhandled error:`, err);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
