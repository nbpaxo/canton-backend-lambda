/**
 * Loop wallet credential verification.
 *
 * A Loop user proves who they are with three things (per Loop SDK issue #44,
 * confirmed by the Loop maintainers):
 *
 *   • public_key — the wallet's Ed25519 key, reported by the SDK provider
 *   • message    — a challenge string the user signed
 *   • signature  — Ed25519 signature over `message`
 *
 * Verifying the signature alone only proves "someone holding this key signed
 * this". The binding to a Canton party comes from the party id itself:
 *
 *   partyId     = <identifier>::1220<fingerprint>
 *   fingerprint = SHA256( 0x0000000C || publicKeyBytes )
 *
 * `1220` is the multihash prefix (0x12 = SHA-256, 0x20 = 32 bytes) and
 * 0x0000000C is Canton's HashPurpose.PublicKeyFingerprint (12), encoded as
 * 4 bytes big-endian. Recomputing that hash and matching it against the
 * namespace proves the signer controls the party's namespace key — no
 * external lookup, no trust-on-first-use, no exchange round-trip.
 *
 * Together: signature valid + fingerprint matches ⇒ the caller IS that party.
 */
import { verify as edVerify, createPublicKey, createHash } from 'node:crypto';

/** Canton HashPurpose.PublicKeyFingerprint, 4 bytes big-endian. */
const HASH_PURPOSE_PUBLIC_KEY_FINGERPRINT = Buffer.from([0x00, 0x00, 0x00, 0x0c]);

/** Multihash prefix for SHA-256 / 32 bytes. */
const MULTIHASH_SHA256_32 = '1220';

export interface LoopCredential {
  /** The exact string that was signed. */
  message: string;
  /** Ed25519 signature over `message`, hex or base64. */
  signature: string;
  /** Wallet Ed25519 public key, hex or base64 (32 raw bytes). */
  publicKey: string;
  /** Party the caller claims to be. Must match the derived fingerprint. */
  partyId: string;
}

/** Accept hex or base64/base64url without the caller having to say which. */
export function fromHexOrBase64(s: string): Buffer {
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return Buffer.from(s, 'hex');
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Wrap a raw 32-byte Ed25519 key in SPKI DER so node's crypto accepts it. */
function buildEd25519PublicKey(rawPub: Buffer): ReturnType<typeof createPublicKey> {
  if (rawPub.length !== 32) {
    throw new Error(`expected 32-byte Ed25519 public key, got ${rawPub.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPub]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Canton fingerprint of an Ed25519 public key — the `1220…` namespace that
 * appears after `::` in a party id.
 */
export function fingerprintForPublicKey(rawPub: Buffer): string {
  const digest = createHash('sha256')
    .update(Buffer.concat([HASH_PURPOSE_PUBLIC_KEY_FINGERPRINT, rawPub]))
    .digest('hex');
  return `${MULTIHASH_SHA256_32}${digest}`;
}

/** Split `identifier::namespace`. Throws if the shape is wrong. */
export function splitPartyId(partyId: string): { identifier: string; namespace: string } {
  const parts = partyId.split('::');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`malformed party id: expected identifier::namespace, got "${partyId}"`);
  }
  return { identifier: parts[0], namespace: parts[1] };
}

/**
 * Does `publicKey` control `partyId`'s namespace?
 *
 * Returns the computed vs expected pair as well so callers can log the
 * comparison in warn mode without enforcing it.
 */
export function checkPartyBinding(
  partyId: string,
  rawPub: Buffer,
): { ok: boolean; expected: string; computed: string } {
  const { namespace } = splitPartyId(partyId);
  const computed = fingerprintForPublicKey(rawPub);
  return { ok: computed === namespace, expected: namespace, computed };
}

export interface LoopVerifyResult {
  partyId: string;
  /** Fingerprint comparison — inspect in warn mode, enforce in strict. */
  binding: { ok: boolean; expected: string; computed: string };
  /** Age of the credential in ms, or null when the message carries no timestamp. */
  ageMs: number | null;
}

/**
 * Extract the issue time from a Loop/exchange challenge.
 *
 * The exchange nonce endpoint returns `"Login at <iso>. Nonce: <nonce>"`, so
 * the credential carries its own age. Anything else (a JSON envelope with
 * `issuedAt`) is supported too. Returns null when no timestamp is present —
 * the caller decides whether that is acceptable.
 */
export function messageIssuedAt(message: string): number | null {
  const iso = message.match(/Login at\s+(\S+?)\.?\s+Nonce:/i)?.[1];
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  try {
    const parsed = JSON.parse(message) as { issuedAt?: number };
    if (typeof parsed.issuedAt === 'number') return parsed.issuedAt;
  } catch {
    /* not JSON — fall through */
  }
  return null;
}

/**
 * Verify a Loop credential. Throws on any cryptographic failure.
 *
 * `maxAgeMs` bounds how long one signature stays usable. Reads run with a
 * long window (a signature per app load); /withdraw demands a fresh one.
 * Binding failure is reported rather than thrown so warn mode can log it.
 */
export function verifyLoopCredential(
  cred: LoopCredential,
  opts: { maxAgeMs: number; requireTimestamp?: boolean },
): LoopVerifyResult {
  const rawPub = fromHexOrBase64(cred.publicKey);
  if (rawPub.length !== 32) {
    throw new Error(`publicKey: expected 32 bytes, got ${rawPub.length}`);
  }
  const sig = fromHexOrBase64(cred.signature);
  if (sig.length !== 64) {
    throw new Error(`signature: expected 64 bytes, got ${sig.length}`);
  }

  const ok = edVerify(
    null,
    Buffer.from(cred.message, 'utf8'),
    buildEd25519PublicKey(rawPub),
    sig,
  );
  if (!ok) throw new Error('Ed25519 signature verification failed');

  const issuedAt = messageIssuedAt(cred.message);
  if (issuedAt === null) {
    if (opts.requireTimestamp) {
      throw new Error('credential carries no timestamp and a fresh one is required');
    }
  } else {
    const age = Date.now() - issuedAt;
    // Small negative ages are just clock skew between us and the issuer.
    if (age > opts.maxAgeMs) {
      throw new Error(`credential expired (age ${Math.round(age / 1000)}s > ${Math.round(opts.maxAgeMs / 1000)}s)`);
    }
  }

  return {
    partyId: cred.partyId,
    binding: checkPartyBinding(cred.partyId, rawPub),
    ageMs: issuedAt === null ? null : Date.now() - issuedAt,
  };
}
