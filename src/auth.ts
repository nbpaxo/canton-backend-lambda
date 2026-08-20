/**
 * Caller identification for canton-backend-lambda.
 *
 * Two kinds of user reach this service, each with its own credential:
 *
 *   mperps (Keycloak) — the exchange holds the session. The frontend trades
 *     it for a Canton ledger token via
 *     `be/v1/oauth/canton/refresh-keycloak-token`. We verify that JWT against
 *     Keycloak JWKS and resolve the party through /v2/users/{sub}. The token
 *     is minted *by* the exchange for the logged-in user, so token-party and
 *     session-party are bound by construction.
 *
 *   Loop wallet — the wallet signs a challenge. We verify the Ed25519
 *     signature and then check that the public key hashes to the claimed
 *     party's namespace (see loopVerify.ts). That proves control of the
 *     party's namespace key, which is strictly stronger evidence than
 *     holding a session cookie. Sent as an `x-loop-auth` header so the same
 *     credential works on every call — one signature per app load, no second
 *     session to manage.
 *
 * The party we derive is AUTHORITATIVE. Endpoints that also receive a party
 * id in their payload must run it through `assertPartyMatches()`; a mismatch
 * is a 403, never a silent preference for one value over the other.
 *
 * There is no unauthenticated path. A request without a credential we can
 * verify gets a 401 — there is no x-party-id fallback, because a caller-
 * supplied party id is a claim, not evidence, and treating it as identity is
 * what left every endpoint open.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import {
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  CANTON_LEDGER_API,
  LOOP_CRED_TTL_MS,
} from './config.js';
import { verifyLoopCredential, type LoopCredential } from './loopVerify.js';

export type AuthMethod = 'keycloak' | 'loop';

export interface AuthenticatedRequest extends Request {
  user: {
    sub: string;          // Keycloak UUID ('' for Loop callers)
    party: string;        // Canton party ID — authoritative
    keycloakToken: string;
    authMethod: AuthMethod;
  };
}

// ─── Keycloak plumbing ───────────────────────────────────────────────────

const jwksClient = jwksRsa({
  jwksUri: `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600_000, // 10 min
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key?.getPublicKey());
  });
}

// Cache: Keycloak sub → Canton party
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

let adminTokenCache: { token: string; expiry: number } | null = null;

async function getAdminToken(): Promise<string> {
  if (adminTokenCache && Date.now() < adminTokenCache.expiry - 30_000) {
    return adminTokenCache.token;
  }

  const { KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, KEYCLOAK_TOKEN_URL } = await import('./config.js');
  const res = await fetch(KEYCLOAK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: KEYCLOAK_CLIENT_ID,
      client_secret: KEYCLOAK_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) throw new Error(`Admin token fetch failed (${res.status})`);
  const data = await res.json() as { access_token: string; expires_in: number };
  adminTokenCache = { token: data.access_token, expiry: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

/**
 * Normalize an incoming party id to canonical `hint::fingerprint` form.
 *
 * Legacy users (whose ids were minted with `.` as the separator, because the
 * source field was an email local-part where `:` is illegal) still send
 * `.`-form. New users send `::`-form. Swap `.` → `::` only when no `::` is
 * already present so we don't double-rewrite anything.
 */
export function normalizePartyId(raw: string): string {
  if (raw.includes('::')) return raw;
  if (raw.includes('.')) return raw.replaceAll('.', '::');
  return raw;
}

function authLog(type: string, req: Request, extra: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({
    level: 'warn', type, path: req.path, method: req.method, ...extra,
  }));
}

// ─── Credential readers ──────────────────────────────────────────────────

/**
 * Parse the `x-loop-auth` header: base64url of
 * `{ message, signature, publicKey, partyId }`.
 */
export function readLoopCredential(req: Request): LoopCredential | null {
  const raw = req.headers['x-loop-auth'];
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const json = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const c = JSON.parse(json) as Partial<LoopCredential>;
    if (!c.message || !c.signature || !c.publicKey || !c.partyId) return null;
    return { ...c, partyId: normalizePartyId(c.partyId) } as LoopCredential;
  } catch {
    return null;
  }
}

/** Verify a Loop credential and return the proven party, or throw. */
export function partyFromLoopCredential(
  cred: LoopCredential,
  maxAgeMs: number,
  opts: { requireTimestamp?: boolean } = {},
): string {
  const result = verifyLoopCredential(cred, { maxAgeMs, requireTimestamp: opts.requireTimestamp });

  if (!result.binding.ok) {
    throw new Error(
      `public key does not control party ${cred.partyId} ` +
      `(namespace ${result.binding.expected}, derived ${result.binding.computed})`,
    );
  }
  return result.partyId;
}

function verifyKeycloakToken(token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      { algorithms: ['RS256'], issuer: `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}` },
      (err, decoded) => {
        if (err) return reject(err);
        const sub = (decoded as jwt.JwtPayload)?.sub;
        if (!sub) return reject(new Error('JWT missing sub'));
        resolve(sub as string);
      },
    );
  });
}

// ─── Middleware ──────────────────────────────────────────────────────────

/**
 * Attach the proven identity, then make sure any party id the client also
 * volunteered agrees with it.
 *
 * `x-party-id` is no longer how we identify anyone, so a stale or wrong value
 * is harmless — it is simply ignored. We still reject the request rather than
 * ignore it quietly: a client sending a party id that is not its own is
 * either buggy or probing, and both are worth surfacing instead of returning
 * a 200 for a different party than the caller asked about.
 */
function grant(
  req: Request,
  res: Response,
  next: NextFunction,
  user: AuthenticatedRequest['user'],
): void {
  (req as AuthenticatedRequest).user = user;

  const claimed = req.headers['x-party-id'];
  if (typeof claimed === 'string' && claimed) {
    if (!assertPartyMatches(req, res, claimed)) return;
  }
  next();
}

/**
 * Identify the caller from the credential the request carries.
 *
 * Order matters only for cost: the Loop check is local crypto, the Keycloak
 * check makes network calls, so we try the cheap one first.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    // 1. Loop wallet credential — Ed25519 signature plus the public key that
    //    hashes to the party's namespace.
    const cred = readLoopCredential(req);
    if (cred) {
      try {
        const party = partyFromLoopCredential(cred, LOOP_CRED_TTL_MS);
        return grant(req, res, next, {
          sub: '', party, keycloakToken: '', authMethod: 'loop',
        });
      } catch (err) {
        authLog('loop_auth_failed', req, { error: (err as Error).message });
        res.status(401).json({
          error: 'invalid_loop_credential',
          message: (err as Error).message,
        });
        return;
      }
    }

    // 2. Keycloak bearer token — the Canton ledger token the exchange mints
    //    for an mperps user from their session.
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        const sub = await verifyKeycloakToken(token);
        const party = await resolveParty(await getAdminToken(), sub);
        return grant(req, res, next, {
          sub, party, keycloakToken: token, authMethod: 'keycloak',
        });
      } catch (err) {
        authLog('keycloak_auth_failed', req, { error: (err as Error).message });
        res.status(401).json({ error: 'invalid_token', message: (err as Error).message });
        return;
      }
    }

    // 3. Nothing to verify. `x-party-id` used to be accepted here; it is a
    //    claim the caller makes about themselves, so it proves nothing.
    authLog('no_credential', req);
    res.status(401).json({
      error: 'unauthorized',
      message: 'send a Keycloak bearer token or an x-loop-auth credential',
    });
  })().catch(next);
}

/**
 * Guard for endpoints that ALSO take a party id in their payload.
 *
 * The authenticated party is the only identity we trust; a payload value may
 * disagree with it only because the caller is confused or hostile. Either way
 * the request stops here rather than picking a winner.
 *
 * Returns true when the request may proceed; sends a 403 and returns false
 * otherwise.
 */
export function assertPartyMatches(
  req: Request,
  res: Response,
  claimed: string | undefined | null,
): boolean {
  if (!claimed) return true;
  const auth = (req as AuthenticatedRequest).user;
  const normalized = normalizePartyId(claimed);
  if (normalized === auth.party) return true;

  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({
    level: 'warn',
    type: 'party_mismatch',
    path: req.path,
    authParty: auth.party,
    claimedParty: normalized,
    authMethod: auth.authMethod,
  }));
  res.status(403).json({
    error: 'party_mismatch',
    message: 'authenticated party does not match the party id in the request',
  });
  return false;
}

export { getAdminToken };
