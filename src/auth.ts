/**
 * Keycloak JWT verification middleware.
 * Verifies Bearer token from frontend against Keycloak JWKS.
 * Extracts party from Canton user lookup.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { KEYCLOAK_BASE, KEYCLOAK_REALM, CANTON_LEDGER_API } from './config.js';

export interface AuthenticatedRequest extends Request {
  user: {
    sub: string;         // Keycloak UUID
    party: string;       // Canton party ID (e.g. "neeraj::1220…")
    keycloakToken: string;
  };
}

// JWKS client for fetching Keycloak signing keys
const jwksClient = jwksRsa({
  jwksUri: `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600_000, // 10 min
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key?.getPublicKey());
  });
}

// Cache: Keycloak sub → Canton party
const partyCache = new Map<string, { party: string; ts: number }>();
const PARTY_CACHE_TTL = 5 * 60_000; // 5 min

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

// Cache admin token
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
  adminTokenCache = {
    token: data.access_token,
    expiry: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

/**
 * Express middleware: identifies the caller.
 *
 * Two modes (set via AUTH_MODE env var):
 *
 *   keycloak  — verify the Bearer JWT against Keycloak JWKS, resolve the
 *               Canton party via /v2/users/{sub}. The full secure path used
 *               for validator-signup users.
 *
 *   open      — DEV ONLY. Accept an `x-party-id` header (or `?partyId=`
 *               query) as the caller's identity, with NO cryptographic
 *               verification. This is the interim shim while the Loop
 *               wallet → exchange-backend → lambda auth handoff is still
 *               being designed (Loop users have a session cookie issued by
 *               the exchange-backend that the lambda can't decode).
 *
 *               Loud warning printed once at boot and on each request.
 *
 * Either mode populates req.user.{sub?, party, keycloakToken?}.
 */

const AUTH_MODE = (process.env.AUTH_MODE ?? 'open').toLowerCase();
let openModeWarned = false;

/**
 * Normalize an incoming party id to canonical `hint::fingerprint` form.
 *
 * The UI no longer rewrites separators. Legacy users (whose ids were minted
 * with `.` as the separator, because the source field was an email
 * local-part where `:` is illegal) still send `.`-form. New users send
 * `::`-form. Swap `.` → `::` only when no `::` is already present so we
 * don't double-rewrite anything.
 */
export function normalizePartyId(raw: string): string {
  if (raw.includes('::')) return raw;
  if (raw.includes('.')) return raw.replaceAll('.', '::');
  return raw;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (AUTH_MODE === 'open') {
    return openModeAuth(req, res, next);
  }
  return keycloakAuth(req, res, next);
}

function openModeAuth(req: Request, res: Response, next: NextFunction): void {
  if (!openModeWarned) {
    console.warn(
      '[auth] AUTH_MODE=open — accepting x-party-id from clients without verification. ' +
        'DEV ONLY. Switch to AUTH_MODE=keycloak (or add Loop JWT verification) before exposing this beyond localhost.',
    );
    openModeWarned = true;
  }

  const rawParty =
    (req.headers['x-party-id'] as string | undefined) ??
    (typeof req.query.partyId === 'string' ? req.query.partyId : undefined);

  const party = rawParty ? normalizePartyId(rawParty) : undefined;

  if (!party || !/^[A-Za-z0-9_\-]+::[A-Za-z0-9]+$/.test(party)) {
    res.status(401).json({
      error: 'Missing or malformed x-party-id (open auth mode expects partyId in header or query)',
    });
    return;
  }

  (req as AuthenticatedRequest).user = {
    sub: '',
    party,
    keycloakToken: '',
  };
  next();
}

function keycloakAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  jwt.verify(
    token,
    getKey,
    {
      algorithms: ['RS256'],
      issuer: `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}`,
    },
    async (err, decoded) => {
      if (err) {
        res.status(401).json({ error: 'Invalid token', details: err.message });
        return;
      }

      try {
        const payload = decoded as jwt.JwtPayload;
        const sub = payload.sub as string;

        const adminToken = await getAdminToken();
        const party = await resolveParty(adminToken, sub);

        (req as AuthenticatedRequest).user = {
          sub,
          party,
          keycloakToken: token,
        };
        next();
      } catch (resolveErr) {
        res.status(500).json({ error: 'Failed to resolve user', details: String(resolveErr) });
      }
    },
  );
}

export { getAdminToken };
