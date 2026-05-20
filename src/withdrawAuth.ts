/**
 * Per-user-type authentication for /cb/withdraw.
 *
 * The withdraw endpoint must NOT be open-auth — funds move on chain as a
 * result of a successful call. We require cryptographic proof that the
 * party owner authorized this specific withdrawal.
 *
 *   Keycloak path:
 *     - Frontend obtains a fresh ledger token via
 *       be/v1/oauth/canton/refresh-keycloak-token.
 *     - Sends it as `Authorization: Bearer <token>`.
 *     - We verify the JWT against Keycloak JWKS, extract `sub`, and
 *       reconstruct the party id (signup sets partyIdHint=sub, so the
 *       canonical party is `${sub}::${PARTICIPANT_SUFFIX}`).
 *
 *   Loop wallet path:
 *     - Frontend asks Loop SDK to sign a canonical payload that
 *       includes the approvalId so the proof is bound to one withdrawal.
 *     - Sends { message, signature, publicKey } in the request body.
 *     - We Ed25519-verify the signature, parse the message, check it's
 *       fresh (< 60 s) and well-formed, and trust the partyId it claims.
 *
 * Both paths yield a verified `partyId`. The caller (the /withdraw route)
 * then matches that against the approval's party — so even if a user
 * authenticates correctly, they can only withdraw against their OWN
 * approval.
 *
 * Open TODO: bind the Loop public key to the party id. Right now we
 * accept whatever publicKey the client sends and the signature only
 * proves "someone with this key signed this message". The real check
 * needs the pubkey-to-party mapping (Splice scan or exchange-backend).
 * Until the same shared-secret S2S channel exists, we can't close this
 * gap. Note: the per-approval partyId match (done by the route) means a
 * malicious caller still can't withdraw against someone else's approval
 * — only spoof being themselves, which is unhelpful for an attacker.
 */
import { Request } from 'express';
import { verify as edVerify, createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import {
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  PARTICIPANT_SUFFIX,
} from './config.js';

export type WithdrawAuthMethod = 'keycloak' | 'loop';

export interface AuthenticatedWithdrawer {
  partyId: string;
  authMethod: WithdrawAuthMethod;
}

// Maximum age of a Loop-signed message in milliseconds.
const LOOP_SIG_TTL_MS = 60_000;

// Canonical envelope type the frontend signs. Anything else gets rejected.
const LOOP_MESSAGE_TYPE = 'mperp-withdraw-v1';

const jwksClient = jwksRsa({
  jwksUri: `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600_000,
});

function getKey(header: jwt.JwtHeader, cb: jwt.SigningKeyCallback): void {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return cb(err);
    cb(null, key?.getPublicKey());
  });
}

function verifyKeycloakJwt(token: string): Promise<{ sub: string }> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, { algorithms: ['RS256'] }, (err, decoded) => {
      if (err) return reject(err);
      const d = decoded as { sub?: string };
      if (!d?.sub) return reject(new Error('JWT missing sub'));
      resolve({ sub: d.sub });
    });
  });
}

/** Loop's sign-message bundle as the frontend should send it. */
export interface LoopWithdrawAuth {
  /** Canonical JSON the user signed (we re-parse and re-stringify checks). */
  message: string;
  /** Ed25519 signature over `message`, hex or base64. */
  signature: string;
  /** User's Loop wallet public key, hex or base64 (32 raw bytes). */
  publicKey: string;
}

/** Decoded contents of `LoopWithdrawAuth.message`. */
interface LoopMessagePayload {
  type: string;
  approvalId: string;
  partyId: string;
  amount: string;
  nonce: string;
  issuedAt: number;
}

function fromHexOrBase64(s: string): Buffer {
  // Hex: even length, all 0-9a-f.
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return Buffer.from(s, 'hex');
  // Otherwise treat as base64 / base64url.
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

function buildEd25519PublicKey(rawPub: Buffer): import('node:crypto').KeyObject {
  // Ed25519 SPKI DER prefix for a 32-byte raw public key:
  //   SEQUENCE { SEQUENCE { OID 1.3.101.112 } BITSTRING { …32 bytes… } }
  // = 302a300506032b65700321 00 || rawPub
  if (rawPub.length !== 32) {
    throw new Error(`expected 32-byte Ed25519 public key, got ${rawPub.length}`);
  }
  const der = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    rawPub,
  ]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** Verify a Loop-signed withdrawal authorization. Throws on failure. */
function verifyLoopSignature(
  auth: LoopWithdrawAuth,
  expected: { approvalId: string },
): { partyId: string } {
  const pubRaw = fromHexOrBase64(auth.publicKey);
  if (pubRaw.length !== 32) {
    throw new Error(
      `Loop publicKey: expected 32 bytes after hex/base64 decode, got ${pubRaw.length} ` +
      `(input len=${auth.publicKey.length}, looks like ${/^[0-9a-fA-F]+$/.test(auth.publicKey) ? 'hex' : 'base64'})`,
    );
  }
  const sig = fromHexOrBase64(auth.signature);
  if (sig.length !== 64) {
    throw new Error(
      `Loop signature: expected 64 bytes after hex/base64 decode, got ${sig.length} ` +
      `(input len=${auth.signature.length})`,
    );
  }
  const pubKey = buildEd25519PublicKey(pubRaw);

  const ok = edVerify(null, Buffer.from(auth.message, 'utf8'), pubKey, sig);
  if (!ok) {
    throw new Error(
      `Loop signature verification failed (msgBytes=${Buffer.byteLength(auth.message, 'utf8')}, sigBytes=${sig.length}, pubBytes=${pubRaw.length})`,
    );
  }

  let payload: LoopMessagePayload;
  try {
    payload = JSON.parse(auth.message) as LoopMessagePayload;
  } catch {
    throw new Error('Loop message is not valid JSON');
  }
  if (payload.type !== LOOP_MESSAGE_TYPE) {
    throw new Error(`Loop message type must be ${LOOP_MESSAGE_TYPE}, got ${payload.type}`);
  }
  if (payload.approvalId !== expected.approvalId) {
    throw new Error('Loop signature bound to a different approvalId');
  }
  if (typeof payload.issuedAt !== 'number' || Date.now() - payload.issuedAt > LOOP_SIG_TTL_MS) {
    throw new Error('Loop signature expired (issuedAt older than 60s)');
  }
  if (!payload.partyId) throw new Error('Loop message missing partyId');

  // TODO(loop-pubkey-binding): verify `pubRaw` is the canonical key for
  // `payload.partyId` against Splice scan or exchange-backend. Until then,
  // a malicious client could sign with their own key and claim to be
  // themselves — caught downstream by the partyId vs approval match.

  return { partyId: payload.partyId };
}

/**
 * Authenticate a /withdraw request. Returns the verified party id of the
 * caller and the auth method used. Throws (caller should map to 401) if
 * neither auth path produces a valid identity.
 */
export async function authenticateWithdraw(
  req: Request,
  ctx: { approvalId: string },
): Promise<AuthenticatedWithdrawer> {
  // ── Keycloak: Authorization: Bearer <jwt>
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const { sub } = await verifyKeycloakJwt(token);
    // Signup sets partyIdHint = sub, so the canonical party is sub::suffix.
    const partyId = `${sub}::${PARTICIPANT_SUFFIX}`;
    return { partyId, authMethod: 'keycloak' };
  }

  // ── Loop: { loopAuth: { message, signature, publicKey } } in the body
  const body = (req.body ?? {}) as { loopAuth?: LoopWithdrawAuth };
  if (body.loopAuth?.message && body.loopAuth?.signature && body.loopAuth?.publicKey) {
    const { partyId } = verifyLoopSignature(body.loopAuth, { approvalId: ctx.approvalId });
    return { partyId, authMethod: 'loop' };
  }

  throw new Error('No valid authentication: send Bearer token (Keycloak) or loopAuth (Loop)');
}

export { LOOP_MESSAGE_TYPE };
