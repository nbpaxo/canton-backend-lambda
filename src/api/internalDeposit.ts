/**
 * POST /internal-deposit
 *
 * Server-side proxy for the Keycloak / validator-signup deposit path. The
 * browser sends the user's Canton JWT in the Authorization header; we use
 * that token to submit a CIP-56 `TransferFactory_Transfer` with
 *   actAs            = [sender]                            (the user)
 *   inputHoldingCids = <sender's CC holdings>              (user-owned)
 *   receiver         = PARTIES.vaultPool                   (fixed)
 *   instrumentId     = (INSTRUMENT_ADMIN_PARTY_ID, INSTRUMENT_ID)
 *
 * Why this exists: Canton's JSON ledger API at v2/state/* / v2/commands/*
 * doesn't ship with CORS headers, so direct browser calls to it fail. This
 * endpoint moves the entire flow server-side. The trust model is unchanged
 * — the JWT belongs to the user, `actAs` is the user, and Splice fees
 * still come out of the user's own holdings. Our operator/vaultPool/
 * treasury are not involved as fee payers.
 *
 * The body's `sender` is taken at face value: Canton enforces actAs
 * against the JWT, so a user trying to deposit FROM someone else's party
 * fails at the ledger boundary.
 */
import { Router, Request, Response } from 'express';
import { json } from 'express';
import {
  CANTON_LEDGER_API,
  INSTRUMENT_ADMIN_PARTY_ID,
  INSTRUMENT_ID,
  KEYCLOAK_BASE,
  KEYCLOAK_REALM,
  KEYCLOAK_TOKEN_URL,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET,
  OPERATOR_KC_USERNAME,
  OPERATOR_KC_PASSWORD,
  PACKAGE_ID,
  PARTIES,
} from '../config.js';
import { normalizePartyId } from '../auth.js';
import type { CantonSdkConfig } from '../canton-sdk/config.js';
import {
  CHOICE_TRANSFER_FACTORY_TRANSFER,
  IFACE_HOLDING,
  IFACE_TRANSFER_FACTORY,
} from '../canton-sdk/config.js';
import { getActiveContracts, submitCommand } from '../canton-sdk/ledger.js';
import { getTransferFactory } from '../canton-sdk/scanApi.js';

const sdkConfig: CantonSdkConfig = {
  cantonLedgerApi: CANTON_LEDGER_API,
  keycloakBase: KEYCLOAK_BASE,
  keycloakRealm: KEYCLOAK_REALM,
  keycloakTokenUrl: KEYCLOAK_TOKEN_URL,
  keycloakClientId: KEYCLOAK_CLIENT_ID,
  keycloakClientSecret: KEYCLOAK_CLIENT_SECRET,
  operatorUsername: OPERATOR_KC_USERNAME,
  operatorPassword: OPERATOR_KC_PASSWORD,
  packageId: PACKAGE_ID,
  parties: PARTIES,
};

const TRANSFER_EXECUTE_TTL_MS = 60 * 60 * 1000; // 1 h — matches operator path
const SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

// NOTE: this devnet's AmuletConfig publishes zero Splice transfer fees, so
// the picker covers exactly `amount`. If we ever target a fee-bearing
// chain, re-introduce a target = need + fee buffer (or fetch AmuletConfig
// from scan and pad by the computed fee) so picked inputs cover both
// `amount` and the protocol fee. Without the buffer on a fee-bearing
// chain, a user holding exactly `amount` would see the choice fail at
// execution time.

const router = Router();

interface InternalDepositBody {
  /** User's party id (sender of the transfer). Canton enforces actAs
   *  against the JWT, so the user can only act as their own party. */
  sender: string;
  /** Decimal string in instrument units (e.g. "1.25"). */
  amount: string;
  /** Optional metadata; defaults to `{ depositFor: <sender> }` for the
   *  watcher's audit trail. */
  memo?: Record<string, string>;
}

router.post('/internal-deposit', json(), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing Bearer token (expected user Canton JWT from /v1/oauth/canton/refresh-keycloak-token)',
    });
  }
  const userToken = authHeader.slice(7);

  const body = (req.body ?? {}) as InternalDepositBody;
  if (!body.sender || !body.amount) {
    return res.status(400).json({ error: 'required fields: sender, amount' });
  }
  const sender = normalizePartyId(body.sender);

  const userId = extractJwtSub(userToken);
  if (!userId) {
    return res.status(401).json({ error: 'Could not extract sub claim from Bearer token' });
  }

  // 1. User's CIP-56 Holdings on our validator.
  let holdings;
  try {
    holdings = await getActiveContracts(sdkConfig, userToken, sender, {
      interfaceId: IFACE_HOLDING,
    });
  } catch (err) {
    return res.status(502).json({
      error: `ledger ACS query failed: ${(err as Error).message}`,
    });
  }

  // 2. Smallest-first pick with fee buffer.
  const inputs = pickHoldingsForAmount(holdings, body.amount, {
    sender,
    instrumentAdmin: INSTRUMENT_ADMIN_PARTY_ID,
    instrumentId: INSTRUMENT_ID,
  });
  if (!inputs) {
    return res.status(400).json({
      error: `Insufficient ${INSTRUMENT_ID} balance — couldn't cover ${body.amount}.`,
    });
  }

  // 3. Build the choice argument shell.
  const now = new Date();
  const transferArgs = {
    expectedAdmin: INSTRUMENT_ADMIN_PARTY_ID,
    transfer: {
      sender,
      receiver: PARTIES.vaultPool,
      amount: body.amount,
      instrumentId: { admin: INSTRUMENT_ADMIN_PARTY_ID, id: INSTRUMENT_ID },
      requestedAt: now.toISOString(),
      executeBefore: new Date(now.getTime() + TRANSFER_EXECUTE_TTL_MS).toISOString(),
      inputHoldingCids: inputs,
      meta: { values: { ...(body.memo ?? { depositFor: sender }) } },
    },
    extraArgs: {
      context: { values: {} as Record<string, unknown> },
      meta: { values: {} },
    },
  };

  // 4. Splice scan → factoryCid + choiceContext + disclosed contracts.
  let enriched;
  try {
    enriched = await getTransferFactory(transferArgs);
  } catch (err) {
    return res.status(502).json({
      error: `scan transfer-factory enrichment failed: ${(err as Error).message}`,
    });
  }
  transferArgs.extraArgs.context = enriched.choiceContext;

  // 5. Submit. actAs=[sender] + user's JWT — Canton authorizes via the
  //    JWT, fees + transfer come out of the inputs (all user-owned).
  let result: Record<string, unknown>;
  try {
    result = await submitCommand(
      sdkConfig,
      userToken,
      userId,
      [sender],
      [
        {
          ExerciseCommand: {
            templateId: IFACE_TRANSFER_FACTORY,
            contractId: enriched.factoryCid,
            choice: CHOICE_TRANSFER_FACTORY_TRANSFER,
            choiceArgument: transferArgs as unknown as Record<string, unknown>,
          },
        },
      ],
      { disclosedContracts: enriched.disclosedContracts },
    );
  } catch (err) {
    return res.status(502).json({
      error: `ledger command submission failed: ${(err as Error).message}`,
    });
  }

  const transferUpdateId =
    (result as { transactionTree?: { updateId?: string } }).transactionTree?.updateId ?? null;
  return res.json({ transferUpdateId });
});

/**
 * GET /internal-balance?sender=<partyId>
 *
 * Returns the caller's CC balance, queried with their own Canton JWT so
 * the participant actually returns their holdings. The generic /holdings
 * endpoint runs as the operator, which fails ACS reads of user-owned
 * holdings (operator doesn't have CanReadAs(user) — signup only grants
 * the user themselves those rights), then quietly returns 0.
 *
 * Filters to the configured instrument + drops locked holdings, mirroring
 * what `pickHoldingsForAmount` sees on the deposit path so the displayed
 * "Available" matches what's actually depositable.
 */
router.get('/internal-balance', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing Bearer token (expected user Canton JWT)',
    });
  }
  const userToken = authHeader.slice(7);

  const senderRaw = typeof req.query.sender === 'string' ? req.query.sender : '';
  if (!senderRaw) {
    return res.status(400).json({ error: 'required query param: sender' });
  }
  const sender = normalizePartyId(senderRaw);

  // Optional instrument selector. Default = configured instrument (USDCx on
  // testnet). `CC` (a.k.a. Amulet) reads the user's Canton Coin holdings —
  // matched by instrument id only ('Amulet' has a single DSO issuer), so we
  // don't need to carry the DSO party id here.
  const instrumentQ = (typeof req.query.instrument === 'string' ? req.query.instrument : '').toUpperCase();
  const wantCc = instrumentQ === 'CC' || instrumentQ === 'AMULET';

  let holdings;
  try {
    holdings = await getActiveContracts(sdkConfig, userToken, sender, {
      interfaceId: IFACE_HOLDING,
    });
  } catch (err) {
    return res.status(502).json({
      error: `ledger ACS query failed: ${(err as Error).message}`,
    });
  }

  let balance = 0;
  let count = 0;
  for (const h of holdings) {
    const view = getHoldingInterfaceView(h.payload, h.interfaceView);
    if (view.owner !== undefined && view.owner !== sender) continue;
    const iid = view.instrumentId ?? {};
    if (wantCc) {
      if (iid.id !== 'Amulet') continue;
    } else {
      if (iid.admin !== INSTRUMENT_ADMIN_PARTY_ID) continue;
      if (iid.id !== INSTRUMENT_ID) continue;
    }
    if (view.lock) continue;
    const amt = Number(view.amount ?? 0);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    balance += amt;
    count += 1;
  }

  return res.json({
    balance,
    holdingCount: count,
    instrumentId: wantCc ? 'Amulet' : INSTRUMENT_ID,
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

interface HoldingView {
  owner?: string;
  amount?: string;
  instrumentId?: { admin?: string; id?: string };
  lock?: unknown;
}

/**
 * Smallest-first greedy fit covering exactly `amount`. Returns the picked
 * Holding cids, or null if available holdings don't cover the request.
 */
function pickHoldingsForAmount(
  holdings: Array<{ contractId: string; payload: Record<string, unknown>; interfaceView?: Record<string, unknown> }>,
  amount: string,
  ctx: { sender: string; instrumentAdmin: string; instrumentId: string },
): string[] | null {
  const need = toScaled(amount);

  const matching = holdings
    .map((h) => ({
      cid: h.contractId,
      view: getHoldingInterfaceView(h.payload, h.interfaceView),
    }))
    .filter((h) => {
      const v = h.view;
      if (v.owner !== undefined && v.owner !== ctx.sender) return false;
      const iid = v.instrumentId ?? {};
      if (iid.admin !== ctx.instrumentAdmin || iid.id !== ctx.instrumentId) return false;
      return !v.lock;
    })
    .map((h) => ({ cid: h.cid, amount: toScaled(String(h.view.amount ?? '0')) }))
    .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));

  let remaining = need;
  const picked: string[] = [];
  for (const h of matching) {
    if (remaining <= 0n) break;
    picked.push(h.cid);
    remaining -= h.amount;
  }
  return remaining > 0n ? null : picked;
}

/**
 * Surface the interface view if Canton attached one (CIP-56
 * includeInterfaceView), else synthesize from Splice's native Amulet
 * payload shape so callers always see `{ owner, amount, instrumentId }`.
 */
function getHoldingInterfaceView(
  payload: Record<string, unknown>,
  interfaceView?: Record<string, unknown>,
): HoldingView {
  if (interfaceView && typeof interfaceView === 'object') return interfaceView as HoldingView;

  const owner = payload.owner;
  const dso = payload.dso;
  const amountObj = payload.amount as { initialAmount?: string } | string | undefined;
  if (typeof owner === 'string' && typeof dso === 'string') {
    const amount =
      typeof amountObj === 'string'
        ? amountObj
        : typeof amountObj === 'object' && amountObj !== null && typeof amountObj.initialAmount === 'string'
        ? amountObj.initialAmount
        : '0';
    return {
      owner,
      instrumentId: { admin: dso, id: 'Amulet' },
      amount,
      lock: null,
    };
  }
  return payload as HoldingView;
}

function toScaled(decimal: string): bigint {
  const [intPart, fracPart = ''] = decimal.split('.');
  const fracPadded = (fracPart + '0'.repeat(SCALE)).slice(0, SCALE);
  return BigInt(intPart || '0') * SCALE_FACTOR + BigInt(fracPadded || '0');
}

/** Decode a JWT payload (no signature verification) and return `sub`. */
function extractJwtSub(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString('utf-8');
    const decoded = JSON.parse(json) as { sub?: string };
    return decoded.sub ?? null;
  } catch {
    return null;
  }
}

export default router;
