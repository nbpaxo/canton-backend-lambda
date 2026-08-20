/**
 * User-facing transfer / preapproval / bridge endpoints.
 *
 * Ported (trimmed) from exchange-v2/backend/src/api/routes/userTransfers.ts.
 * The exchange-v2 version is a Fastify plugin behind a cookie session; we
 * mirror the auth surface as Express middleware that requires:
 *
 *   x-party-id     — the caller's canonical Canton party id (open-mode shim)
 *   Authorization  — Bearer <user's Canton JWT> minted via the frontend's
 *                    /v1/oauth/canton/refresh-keycloak-token proxy. The JWT
 *                    is what Canton uses to authorize submit/ACS reads;
 *                    x-party-id is just metadata.
 *
 * Endpoints
 *   GET  /user/onboarding-status        — preapproval + BUA snapshot
 *   POST /user/transfer-preapproval/create
 *                                        — Internal users only. body { instrument: 'USDCx' | 'CC' }
 *                                          (CC currently returns 501 with a redirect hint.)
 *   GET  /user/bua/status                — BridgeUserAgreement check + hints
 *   POST /user/transfers/send            — USDCx peer-to-peer via TransferFactory
 *
 * See memory/exchange_v2_usdcx_testnet_working.md for the URL/template
 * discovery story.
 */

import { Router, Request, Response, json } from 'express';
import { normalizePartyId, getAdminToken } from '../auth.js';
import { sdkConfig } from '../sdk.js';
import {
  getActiveContracts,
  submitCommand,
} from '../canton-sdk/ledger.js';
import {
  IFACE_TRANSFER_FACTORY,
  IFACE_TRANSFER_INSTRUCTION,
  CHOICE_TRANSFER_FACTORY_TRANSFER,
} from '../canton-sdk/config.js';
import { getTransferFactory, SCAN_TRANSFER_FACTORY_URL } from '../canton-sdk/scanApi.js';
import {
  CANTON_LEDGER_API,
  INSTRUMENT_ADMIN_PARTY_ID,
  INSTRUMENT_ID,
  UTILITY_BACKEND_URL,
  WALLET_API_URL,
  BRIDGE_OPERATOR_PARTY_ID,
  UTILITY_OPERATOR_PARTY_ID,
  PARTICIPANT_SUFFIX,
  formatInstrumentAmount,
} from '../config.js';

const router = Router();

// ─── Template + party constants (testnet-stable) ─────────────────────────
// Pin to package-id (not `#package-name`) because Canton 3.4's
// templateFilters with name-style ids over-match in our testing.

const PKG_UTILITY_REGISTRY_APP = '7a75ef6e69f69395a4e60919e228528bb8f3881150ccfde3f31bcc73864b18ab';
const PKG_UTILITY_BRIDGE       = '9cb076659b354fdaecb69107017fd163998c025c6b52f567508c1e060de6eda8';

const TPL_TRANSFER_PREAPPROVAL =
  `${PKG_UTILITY_REGISTRY_APP}:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval`;
const TPL_BRIDGE_USER_AGREEMENT =
  `${PKG_UTILITY_BRIDGE}:Utility.Bridge.V0.Agreement.User:BridgeUserAgreement`;
const TPL_HOLDER_SERVICE =
  `${PKG_UTILITY_REGISTRY_APP}:Utility.Registry.App.V0.Service.Holder:HolderService`;
// 2-step USDCx peer-to-peer offer (DA utility-registry app). Created when
// the sender's TransferFactory_Transfer falls back from preapproval (e.g.
// the receiver hasn't enabled auto-accept). Surfaced as pending/outgoing.
const TPL_TRANSFER_OFFER =
  `${PKG_UTILITY_REGISTRY_APP}:Utility.Registry.App.V0.Model.Transfer:TransferOffer`;
// Sepolia → Canton bridge attestation. Circle's attester creates this
// with `recipient = userPartyId` after a USDC deposit; the user mints
// USDCx by exercising BridgeUserAgreement_Mint to consume it.
const TPL_DEPOSIT_ATTESTATION =
  `${PKG_UTILITY_BRIDGE}:Utility.Bridge.V0.Attestation.Deposit:DepositAttestation`;
// Request contract a user creates to enrol in the USDCx bridge. The bridge
// operator's automation accepts it, producing a BridgeUserAgreement (which
// then carries the Mint/Burn choices). Same package as the agreement.
const TPL_BRIDGE_USER_AGREEMENT_REQUEST =
  `${PKG_UTILITY_BRIDGE}:Utility.Bridge.V0.Agreement.User:BridgeUserAgreementRequest`;

// BridgeUserAgreement mint choice — consumes a DepositAttestation, produces USDCx.
const CHOICE_BUA_MINT = 'BridgeUserAgreement_Mint';
const CHOICE_BUA_BURN = 'BridgeUserAgreement_Burn';
// Ethereum domain id for the bridge-out (burn). Currently the only supported
// destination. Canton JSON API encodes Daml Int as a string.
const ETHEREUM_DOMAIN_ID = '0';
// USDCx on-chain precision (scale for exact change arithmetic on burn).
const USDCX_SCALE = 10;

// BurnMint `contextContractIds` record keys (per DA utility-bridge docs:
// "Extracting Contract IDs and Disclosed Contracts"). The record always has
// these three fields; appReward/featured are Optional and may be absent from
// the factory response (testnet USDCx returns only instrument-configuration),
// in which case we pass null (Daml None). The response's `issuer-credentials`
// entry is NOT part of contextContractIds and is ignored.
const CTX_KEY_INSTRUMENT_CONFIG = 'utility.digitalasset.com/instrument-configuration';
const CTX_KEY_APP_REWARD_CONFIG = 'utility.digitalasset.com/app-reward-configuration';
const CTX_KEY_FEATURED_APP_RIGHT = 'utility.digitalasset.com/featured-app-right';

// Splice's native Amulet preapproval. Matches by template-name suffix
// (the Amulet/Splice package id rolls forward each release; pinning would
// break on every version bump). The contract template is published as part
// of `splice-amulet` and is signed by `{provider=validator, receiver=user}`.
const TPL_SPLICE_AMULET_TRANSFER_PREAPPROVAL_SUFFIX =
  ':Splice.AmuletRules:TransferPreapproval';

// Broad ACS query — returns EVERY active contract visible to `partyId`,
// regardless of template. Use when filtering by template-name suffix
// (not supported by Canton 3.4's templateFilters). Mirrors the
// exchange-v2/backend `acsByTemplate` helper, sans the template filter.
async function queryAcsUnfiltered(
  bearerToken: string,
  partyId: string,
): Promise<Array<{ templateId: string; contractId: string; payload: Record<string, unknown> }>> {
  // ledger-end → offset (POST body needs an activeAtOffset).
  const endRes = await fetch(`${CANTON_LEDGER_API}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  if (!endRes.ok) {
    throw new Error(`ledger-end query: ${endRes.status} ${await endRes.text()}`);
  }
  const offset = ((await endRes.json()) as { offset?: number }).offset ?? 0;

  const res = await fetch(`${CANTON_LEDGER_API}/v2/state/active-contracts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { filtersByParty: { [partyId]: {} } },
      verbose: false,
      activeAtOffset: offset,
    }),
  });
  if (!res.ok) {
    throw new Error(`active-contracts query: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as unknown;
  const entries: unknown[] = Array.isArray(data)
    ? (data as unknown[])
    : (data as { entries?: unknown[]; activeContracts?: unknown[] }).entries
      ?? (data as { entries?: unknown[]; activeContracts?: unknown[] }).activeContracts
      ?? [];

  return entries
    .map((e) => {
      const anyE = e as Record<string, any>;
      const ce  = anyE.contractEntry ?? anyE;
      const ac  = ce.JsActiveContract ?? ce;
      const evt = ac.createdEvent ?? ac;
      if (!evt?.contractId) return null;
      return {
        contractId: evt.contractId as string,
        templateId: (evt.templateId as string) ?? '',
        payload: (evt.createArguments ?? evt.createArgument ?? evt.payload ?? {}) as Record<string, unknown>,
      };
    })
    .filter((c): c is { templateId: string; contractId: string; payload: Record<string, unknown> } => c !== null);
}

// DA utility-operator party (env-configurable; testnet default in config).
const UTILITY_OPERATOR = UTILITY_OPERATOR_PARTY_ID;

interface BurnMintContext {
  factoryId: string;
  /** `contextContractIds` record for the Mint/Burn choice (field-name → cid). */
  contextContractIds: Record<string, unknown>;
  disclosedContracts: Array<Record<string, unknown>>;
}

/**
 * Fetch the burn-mint-factory choice context from the DA utility backend and
 * shape it into the `contextContractIds` record the BurnMint choice expects.
 * Field names are derived from the returned context keys (see contextKeyToField)
 * so we adapt to whatever the registry currently returns.
 */
async function fetchBurnMintContext(
  inputHoldingCids: string[],
  outputs: Array<{ owner: string; amount: string }>,
): Promise<BurnMintContext> {
  const url = `${UTILITY_BACKEND_URL}/api/utilities/v0/registry/burn-mint-instruction/v0/burn-mint-factory`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instrumentId: { admin: INSTRUMENT_ADMIN_PARTY_ID, id: INSTRUMENT_ID },
      inputHoldingCids,
      outputs,
    }),
  });
  if (!res.ok) {
    throw new Error(`burn-mint-factory ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const j = (await res.json()) as {
    factoryId?: string;
    choiceContext?: {
      choiceContextData?: { values?: Record<string, { tag?: string; value: unknown }> };
      disclosedContracts?: Array<Record<string, unknown>>;
    };
  };
  if (!j.factoryId) {
    throw new Error('burn-mint-factory response missing factoryId');
  }
  const values = (j.choiceContext?.choiceContextData?.values ?? {}) as Record<string, { value?: unknown }>;
  const cid = (key: string): unknown => values[key]?.value ?? null;
  const instrumentConfigurationCid = cid(CTX_KEY_INSTRUMENT_CONFIG);
  if (instrumentConfigurationCid == null) {
    throw new Error(
      `burn-mint-factory response missing instrument-configuration (have keys: ${Object.keys(values).join(', ')})`,
    );
  }
  const contextContractIds: Record<string, unknown> = {
    instrumentConfigurationCid,
    appRewardConfigurationCid: cid(CTX_KEY_APP_REWARD_CONFIG),
    featuredAppRightCid: cid(CTX_KEY_FEATURED_APP_RIGHT),
  };
  // Normalize each disclosed contract to the core disclosure fields and DROP
  // null/undefined values — Canton's submit decoder rejects
  // `synchronizerId: null` ("Got value 'null' with wrong type, expecting
  // string at 'synchronizerId'"). It must be a string or absent. Then dedupe
  // by contractId (Canton 3.4 rejects duplicate cids in a submit).
  const seen = new Set<string>();
  const disclosedContracts = (j.choiceContext?.disclosedContracts ?? [])
    .map((d) => {
      const src = d as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of [
        'templateId', 'template_id',
        'contractId', 'contract_id',
        'createdEventBlob', 'created_event_blob',
        'synchronizerId', 'synchronizer_id',
      ]) {
        if (src[k] != null) out[k] = src[k];
      }
      return out;
    })
    .filter((d) => {
      const c = (d.contractId ?? d.contract_id) as string | undefined;
      if (!c) return true;
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });
  return { factoryId: j.factoryId, contextContractIds, disclosedContracts };
}

// ─── User-auth middleware ────────────────────────────────────────────────

interface UserAuthRequest extends Request {
  userParty: string;
  userToken: string;
  userId: string;
}

/**
 * Require x-party-id + Bearer Canton JWT. We do NOT verify the JWT
 * signature here — Canton verifies it on submit. We only read `sub` for
 * the userId field in submit-and-wait calls.
 */
function requireUserAuth(req: Request, res: Response, next: () => void): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Missing Bearer token (expected user Canton JWT from /v1/oauth/canton/refresh-keycloak-token)',
    });
    return;
  }
  const userToken = authHeader.slice(7);

  // Header only. `?partyId=` used to be accepted too, but query strings are
  // copied into access logs, proxy logs and browser history.
  const rawParty = req.headers['x-party-id'] as string | undefined;
  if (!rawParty) {
    res.status(401).json({ error: 'Missing x-party-id header' });
    return;
  }
  const userParty = normalizePartyId(rawParty);

  const userId = extractJwtSub(userToken);
  if (!userId) {
    res.status(401).json({ error: 'Could not extract sub claim from Bearer token' });
    return;
  }

  // Tie the claimed party to the token. Signup allocates the party with
  // partyIdHint = sub, so the canonical party for a Keycloak caller is
  // `sub::PARTICIPANT_SUFFIX`. Without this the header alone decided who the
  // caller was, and it is attacker-controlled. Note the token's signature is
  // verified by Canton on submit, not here — so this check is what stops a
  // caller acting as a party that is not theirs.
  const expectedParty = `${userId}::${PARTICIPANT_SUFFIX}`;
  if (userParty !== expectedParty) {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({
      level: 'warn',
      type: 'party_mismatch',
      path: req.path,
      tokenParty: expectedParty,
      claimedParty: userParty,
    }));
    res.status(403).json({
      error: 'party_mismatch',
      message: 'x-party-id does not match the party for this token',
    });
    return;
  }

  (req as UserAuthRequest).userParty = userParty;
  (req as UserAuthRequest).userToken = userToken;
  (req as UserAuthRequest).userId    = userId;
  next();
}

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

// ─── GET /user/onboarding-status ─────────────────────────────────────────
// Reports whether the caller has, for each instrument:
//   - a TransferPreapproval contract receivable as them
//   - (USDCx only) a BridgeUserAgreement
// Frontend uses this to decide what to nudge in the auto-accept modal +
// dropdown checkmarks.
router.get('/user/onboarding-status', requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken } = req as UserAuthRequest;

  try {
    // USDCx preapproval — utility-registry template, instrumentAdmin =
    // INSTRUMENT_ADMIN_PARTY_ID (USDCx admin on testnet).
    const utilityPreapprovals = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_TRANSFER_PREAPPROVAL },
    );
    const usdcxPreapproval = utilityPreapprovals.some((c) => {
      const p = c.payload as Record<string, unknown>;
      if (p.receiver !== userParty) return false;
      if (p.instrumentAdmin && p.instrumentAdmin !== INSTRUMENT_ADMIN_PARTY_ID) return false;
      return true;
    });

    // CC (Amulet) preapproval — Splice-native template, matched by
    // template-name suffix because the Amulet package id rolls forward
    // each release; pinning would break on every version bump. The user
    // is a stakeholder on their own TransferPreapproval (the contract is
    // signed by {provider=validator, receiver=user}), so a broad ACS read
    // as the user catches it.
    let ccPreapproval = false;
    try {
      const all = await queryAcsUnfiltered(userToken, userParty);
      ccPreapproval = all.some((c) => {
        if (!c.templateId.endsWith(TPL_SPLICE_AMULET_TRANSFER_PREAPPROVAL_SUFFIX)) {
          return false;
        }
        const receiver = (c.payload as Record<string, unknown>).receiver;
        return receiver === userParty;
      });
    } catch (e) {
      // Don't fail the whole snapshot just because the broad query died —
      // log and report ccPreapproval=false. The other readings are still useful.
      console.warn(
        '[onboarding-status] CC preapproval scan failed:',
        (e as Error).message,
      );
    }

    // BridgeUserAgreement (USDCx bridge). Required for internal users to
    // mint USDCx after a Sepolia deposit. Loop users don't need it (Loop
    // handles the agreement themselves).
    const buaContracts = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_BRIDGE_USER_AGREEMENT },
    );
    const hasBua = buaContracts.some((c) => (c.payload as Record<string, unknown>).user === userParty);

    // Holder service (Circle's out-of-band onboarding). Reported but not
    // used by the FE auto-accept flow.
    const holderServices = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_HOLDER_SERVICE },
    );

    res.json({
      partyId: userParty,
      preapproval: {
        usdcx: usdcxPreapproval,
        cc: ccPreapproval,
      },
      bridgeUserAgreement: hasBua,
      holderService: holderServices.length > 0,
      // Convenience: a single boolean per token for "ready to receive".
      canReceive: {
        usdcx: usdcxPreapproval || holderServices.length > 0,
        cc: ccPreapproval, // Splice validators usually auto-credit CC anyway.
      },
    });
  } catch (err) {
    res.status(502).json({
      error: 'ledger_query_failed',
      detail: (err as Error).message,
    });
  }
});

// ─── POST /user/transfer-preapproval/create ──────────────────────────────
// body: { instrument: 'USDCx' | 'CC' }
//
// Internal users only (Bearer token from /v1/oauth/.../refresh-keycloak-token).
// USDCx → CreateCommand on Utility.Registry.App TransferPreapproval.
// CC    → returns 501 with a redirect URL; we expect the FE to send
//         users to the validator wallet for the Splice preapproval until
//         we wire up the Splice wallet API.
router.post('/user/transfer-preapproval/create', json(), requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken, userId } = req as UserAuthRequest;
  const body = (req.body ?? {}) as { instrument?: string };
  const instrument = (body.instrument ?? 'USDCx').toUpperCase();

  if (instrument === 'CC' || instrument === 'AMULET') {
    await enableCcPreapproval(userParty, userToken, userId, res);
    return;
  }
  if (instrument !== 'USDCX') {
    res.status(400).json({ error: 'unknown_instrument', detail: `instrument must be USDCx or CC` });
    return;
  }

  try {
    const result = await submitCommand(
      sdkConfig,
      userToken,
      userId,
      [userParty],
      [
        {
          CreateCommand: {
            templateId: TPL_TRANSFER_PREAPPROVAL,
            createArguments: {
              operator: UTILITY_OPERATOR,
              receiver: userParty,
              instrumentAdmin: INSTRUMENT_ADMIN_PARTY_ID,
              // Empty list = all instruments admin'd by INSTRUMENT_ADMIN_PARTY_ID;
              // restrict to USDCx to be conservative.
              instrumentAllowances: [{ id: INSTRUMENT_ID }],
            },
          },
        },
      ],
      { commandId: `tp-create-${Date.now()}` },
    );
    res.json({
      ok: true,
      instrument: 'USDCx',
      message: 'Auto-accept enabled — incoming USDCx will land directly without an Accept step.',
      transactionTree: result,
    });
  } catch (err) {
    res.status(502).json({
      error: 'create_failed',
      detail: (err as Error).message,
    });
  }
});

/**
 * Enable the Splice-native (CC / Amulet) TransferPreapproval for a user via
 * the validator's self-service WALLET API:
 *
 *   POST {WALLET_API_URL}/api/validator/v0/wallet/transfer-preapproval
 *   (operationId createTransferPreapproval)
 *
 * The authenticated wallet user (the bearer token's subject) becomes the
 * receiver who auto-accepts incoming CC. We forward the user's own bearer
 * token.
 *
 * Our signup users get a Canton party via the JSON Ledger API but no Splice
 * *wallet* install, so the wallet API first answers 404 "No wallet found".
 * In that case we onboard the user to their EXISTING party via the validator
 * admin API (`onboardUser`, operator m2m token — `party_id` set +
 * createPartyIfMissing=false ⇒ assigns the existing party, never reallocates)
 * and retry once.
 *
 * Idempotent: a pre-check short-circuits if a preapproval already exists, and
 * a 409 from the wallet API is treated as "already enabled".
 */
async function enableCcPreapproval(
  userParty: string,
  userToken: string,
  userId: string,
  res: Response,
): Promise<void> {
  const createPreapproval = () =>
    fetch(`${WALLET_API_URL}/api/validator/v0/wallet/transfer-preapproval`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

  try {
    // Short-circuit if a Splice TransferPreapproval already exists for the
    // user (matched by template-name suffix — the Amulet pkg id rolls fwd).
    try {
      const all = await queryAcsUnfiltered(userToken, userParty);
      const alreadyEnabled = all.some(
        (c) =>
          c.templateId.endsWith(TPL_SPLICE_AMULET_TRANSFER_PREAPPROVAL_SUFFIX) &&
          (c.payload as Record<string, unknown>).receiver === userParty,
      );
      if (alreadyEnabled) {
        res.json({
          ok: true,
          instrument: 'CC',
          message: 'CC auto-accept is already enabled.',
          alreadyEnabled: true,
        });
        return;
      }
    } catch (e) {
      // Non-fatal — fall through to the wallet API, which is itself idempotent.
      console.warn('[cc-preapproval] pre-check ACS read failed:', (e as Error).message);
    }

    let walletRes = await createPreapproval();

    // No Splice wallet for this user yet → onboard them to their existing
    // party (admin/m2m), then retry the preapproval once.
    if (walletRes.status === 404) {
      const adminToken = await getAdminToken();
      const onboardRes = await fetch(`${WALLET_API_URL}/api/validator/v0/admin/users`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: userId, party_id: userParty, createPartyIfMissing: false }),
      });
      if (!onboardRes.ok && onboardRes.status !== 409) {
        const otext = await onboardRes.text();
        res.status(502).json({
          error: 'wallet_onboard_failed',
          detail: `validator onboardUser → ${onboardRes.status}: ${otext.slice(0, 400)}`,
        });
        return;
      }
      walletRes = await createPreapproval();
    }

    if (walletRes.status === 409) {
      res.json({
        ok: true,
        instrument: 'CC',
        message: 'CC auto-accept is already enabled.',
        alreadyEnabled: true,
      });
      return;
    }
    if (!walletRes.ok) {
      const text = await walletRes.text();
      res.status(walletRes.status === 401 || walletRes.status === 403 ? walletRes.status : 502).json({
        error: 'cc_preapproval_failed',
        detail: `wallet transfer-preapproval → ${walletRes.status}: ${text.slice(0, 400)}`,
      });
      return;
    }

    const body = (await walletRes.json().catch(() => ({}))) as {
      transfer_preapproval_contract_id?: string;
    };
    res.json({
      ok: true,
      instrument: 'CC',
      message: 'CC auto-accept enabled — incoming CC will land directly without an Accept step.',
      contractId: body.transfer_preapproval_contract_id ?? null,
    });
  } catch (err) {
    res.status(502).json({
      error: 'cc_preapproval_failed',
      detail: (err as Error).message,
    });
  }
}

// ─── GET /user/bua/status ────────────────────────────────────────────────
// Returns the BridgeUserAgreement state for the caller. If absent, the
// FE prompts the user to log into the xreserve portal to create one.
router.get('/user/bua/status', requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken } = req as UserAuthRequest;

  try {
    const contracts = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_BRIDGE_USER_AGREEMENT },
    );
    const mine = contracts.filter(
      (c) => (c.payload as Record<string, unknown>).user === userParty,
    );

    res.json({
      partyId: userParty,
      hasAgreement: mine.length > 0,
      agreements: mine.map((c) => ({
        contractId: c.contractId,
        preApproval: (c.payload as Record<string, unknown>).preApproval ?? null,
      })),
      // Hints for the FE.
      xreservePortalUrl: 'https://testnet-usdcxreserve.43.217.203.156.nip.io',
      bridgeUiUrl: 'https://digital-asset.github.io/xreserve-deposits/',
    });
  } catch (err) {
    res.status(502).json({
      error: 'ledger_query_failed',
      detail: (err as Error).message,
    });
  }
});

// CIP-56 Holding interface — all token balances (USDCx + Amulet/CC) expose it.
const IFACE_HOLDING = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';

interface ResolvedInstrument {
  /** Issuer/admin party. For CC this is the DSO, derived from holdings. */
  admin: string;
  /** Daml instrument id: 'USDCx' or 'Amulet'. */
  id: string;
  /** Caller's owned, matching Holdings (interface views). */
  holdings: Array<{ contractId: string; interfaceView?: Record<string, unknown> }>;
  /** Transfer-factory registry URL. undefined → USDCx per-admin default. */
  registryUrl?: string;
  symbol: 'USDCx' | 'CC';
}

/**
 * Resolve the on-chain instrument context for a peer-to-peer transfer.
 *   • USDCx → configured admin/id; factory via DA per-admin registry (default).
 *   • CC    → Amulet; DSO admin derived from the caller's Amulet holdings;
 *             factory via the Splice scan (Amulet's registrar).
 */
async function resolveInstrumentForSend(
  instrument: string,
  userToken: string,
  userParty: string,
): Promise<ResolvedInstrument> {
  const holdings = await getActiveContracts(sdkConfig, userToken, userParty, { interfaceId: IFACE_HOLDING });
  const owned = (match: (iid: { admin?: string; id?: string }) => boolean) =>
    holdings.filter((h) => {
      const v = h.interfaceView as Record<string, any> | undefined;
      if (!v || v.owner !== userParty) return false;
      return match((v.instrumentId ?? {}) as { admin?: string; id?: string });
    });

  if (instrument === 'CC' || instrument === 'AMULET') {
    const cc = owned((iid) => iid.id === 'Amulet');
    const admin = (cc[0]?.interfaceView as Record<string, any> | undefined)?.instrumentId?.admin as string | undefined;
    return { admin: admin ?? '', id: 'Amulet', holdings: cc, registryUrl: SCAN_TRANSFER_FACTORY_URL, symbol: 'CC' };
  }
  const usdcx = owned((iid) => iid.admin === INSTRUMENT_ADMIN_PARTY_ID && iid.id === INSTRUMENT_ID);
  return { admin: INSTRUMENT_ADMIN_PARTY_ID, id: INSTRUMENT_ID, holdings: usdcx, symbol: 'USDCx' };
}

// ─── POST /user/transfers/send ───────────────────────────────────────────
// Peer-to-peer send of USDCx or CC. body: { receiver, amount, instrument?, memo? }
//
// 1. Pull the sender's USDCx holdings (ACS, interface filter).
// 2. Pick smallest-first to cover `amount` (delegated to the picker logic
//    in services/amuletTransfer.ts? We don't have one in lambda — exchange-v2
//    keeps it in services/. For an MVP we hand the registry the full list
//    and let it pick — registry's TransferFactory_Transfer choice context
//    handles input selection on the registrar side for USDCx).
// 3. Get factory enrichment from DA registry (per-admin URL — see scanApi).
// 4. Submit TransferFactory_Transfer.
router.post('/user/transfers/send', json(), requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken, userId } = req as UserAuthRequest;
  const body = (req.body ?? {}) as { receiver?: string; amount?: string; instrument?: string; memo?: Record<string, string> };
  if (!body.receiver || !body.amount) {
    res.status(400).json({ error: 'required fields: receiver, amount' });
    return;
  }
  const receiver = normalizePartyId(body.receiver);
  const amount = body.amount;
  const instrument = (body.instrument ?? 'USDCx').toUpperCase();

  try {
    const inst = await resolveInstrumentForSend(instrument, userToken, userParty);

    if (inst.symbol === 'CC' && !inst.admin) {
      res.status(400).json({ error: 'no_cc_holdings', detail: 'You have no CC (Canton Coin) holdings on your party.' });
      return;
    }
    if (inst.holdings.length === 0) {
      res.status(400).json({
        error: `no_${inst.symbol.toLowerCase()}_holdings`,
        detail: `You have no ${inst.symbol} holdings on your party.`,
      });
      return;
    }

    const now = new Date();
    // 30-day TTL on the on-chain transfer. Matters mainly for the 2-step
    // fallback (receiver has no preapproval) — the resulting
    // TransferInstruction is valid for accept until `executeBefore`. After
    // expiry the receiver gets a 410 from /accept and the sender has to
    // resend. 30 days matches Loop wallet's default and gives the
    // receiver enough time even if they're slow to log in.
    const INSTRUCTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const transferArgs = {
      expectedAdmin: inst.admin,
      transfer: {
        sender: userParty,
        receiver,
        amount,
        instrumentId: { admin: inst.admin, id: inst.id },
        requestedAt: now.toISOString(),
        executeBefore: new Date(now.getTime() + INSTRUCTION_TTL_MS).toISOString(),
        inputHoldingCids: inst.holdings.map((h) => h.contractId),
        meta: { values: { ...(body.memo ?? {}) } },
      },
      extraArgs: {
        context: { values: {} as Record<string, unknown> },
        meta: { values: {} },
      },
    };

    const enriched = await getTransferFactory(transferArgs, inst.registryUrl);
    transferArgs.extraArgs.context = enriched.choiceContext;

    // DA's per-admin registry returns ONE of two factory cids based on the
    // receiver's state:
    //   • TransferPreapproval cid → TransferFactory_Transfer auto-completes
    //     into a Holding owned by the receiver. No accept step.
    //   • AllocationFactory cid    → TransferFactory_Transfer creates a
    //     2-step TransferInstruction; the receiver must POST /accept.
    // Detect which path the registry chose by looking at disclosedContracts.
    // USDCx preapproval = UtilityRegistry template; CC = Splice Amulet template.
    const autoCompleted = enriched.disclosedContracts.some((d) => {
      const tplId = (d.templateId ?? (d as Record<string, unknown>).template_id) as string | undefined;
      return !!tplId && (
        tplId.endsWith(':Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval') ||
        tplId.endsWith(':Splice.AmuletRules:TransferPreapproval')
      );
    });

    const result = await submitCommand(
      sdkConfig,
      userToken,
      userId,
      [userParty],
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

    res.json({
      ok: true,
      sender: userParty,
      receiver,
      amount,
      instrument: inst.symbol,
      /** `completed` = auto-credited via preapproval, `pending_acceptance` =
       *  2-step TransferInstruction awaiting receiver accept. */
      status: autoCompleted ? 'completed' : 'pending_acceptance',
      autoCompleted,
      transactionTree: result,
    });
  } catch (err) {
    res.status(502).json({
      error: 'send_failed',
      detail: (err as Error).message,
    });
  }
});

// ─── GET /user/transfers/preapproval-check ───────────────────────────────
// Pre-flight check used by the Transfer USDCx modal so we can warn the
// sender BEFORE they sign that the transfer will land as a pending
// instruction (vs. auto-completing into a Holding).
//
// Implementation: ask DA's per-admin registry's transfer-factory for a
// 1-unit probe transfer to the receiver, using ONE of the sender's actual
// USDCx Holding cids (registry rejects `inputHoldingCids:[]` with "No
// holdings provided"). The probe is never submitted to the ledger — only
// the registry response's disclosedContracts is inspected. Receiver has
// preapproval iff the response discloses their
// `Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval`.
//
// Edge case: sender has zero USDCx Holdings. We can't probe the registry,
// so return `hasPreapproval: null` and let the FE render an "Unknown"
// state rather than blocking the user.
router.get('/user/transfers/preapproval-check', requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken } = req as UserAuthRequest;
  const q = (req.query ?? {}) as { receiver?: string; instrument?: string };
  const receiver = q.receiver?.trim();
  const instrument = (q.instrument ?? 'USDCx').toUpperCase();
  if (!receiver || !receiver.includes('::')) {
    res.status(400).json({
      error: 'receiver must be a full party id (prefix::namespace)',
    });
    return;
  }

  try {
    // Find ONE holding of the instrument the sender owns — the registry needs
    // at least one cid in inputHoldingCids or it 400s. Also yields the admin
    // (DSO for CC).
    const inst = await resolveInstrumentForSend(instrument, userToken, userParty);
    const probeCid = inst.holdings[0]?.contractId;

    if (!probeCid || (inst.symbol === 'CC' && !inst.admin)) {
      res.json({
        receiver,
        instrumentAdmin: inst.admin || null,
        instrumentId: inst.id,
        hasPreapproval: null,
        reason: `sender_has_no_${inst.symbol.toLowerCase()}_holdings`,
      });
      return;
    }

    // Probe the registry with one real holding cid. Never submitted.
    const now = new Date();
    const probeArgs = {
      expectedAdmin: inst.admin,
      transfer: {
        sender: userParty,
        receiver,
        amount: '1',
        instrumentId: { admin: inst.admin, id: inst.id },
        requestedAt: now.toISOString(),
        executeBefore: new Date(now.getTime() + 60_000).toISOString(),
        inputHoldingCids: [probeCid],
        meta: { values: {} },
      },
      extraArgs: { context: { values: {} }, meta: { values: {} } },
    };
    const enriched = await getTransferFactory(probeArgs, inst.registryUrl);
    const hasPreapproval = enriched.disclosedContracts.some((d) => {
      const tplId = (d.templateId ?? (d as Record<string, unknown>).template_id) as string | undefined;
      return !!tplId && (
        tplId.endsWith(':Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval') ||
        tplId.endsWith(':Splice.AmuletRules:TransferPreapproval')
      );
    });
    res.json({
      receiver,
      instrumentAdmin: inst.admin,
      instrumentId: inst.id,
      hasPreapproval,
    });
  } catch (err) {
    res.status(502).json({
      error: 'preapproval_check_failed',
      detail: (err as Error).message,
    });
  }
});

// ─── GET /user/transfers/pending ─────────────────────────────────────────
// Lists INCOMING USDCx TransferOffer contracts where the caller is the
// receiver. These arise when a sender's TransferFactory_Transfer falls back
// to a 2-step flow (e.g. the receiver hasn't enabled auto-accept). The
// caller accepts via POST /user/transfers/:cid/accept (CIP-56 choice on
// the TransferInstruction interface).
router.get('/user/transfers/pending', requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken } = req as UserAuthRequest;

  try {
    const contracts = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_TRANSFER_OFFER },
    );
    const now = Date.now();
    const pending = contracts
      .filter((c) => {
        const t = ((c.payload as Record<string, unknown>).transfer ?? {}) as { receiver?: string };
        return t.receiver === userParty;
      })
      .map((c) => {
        // On-chain shape: payload.transfer.instrumentId.{admin,id}
        // (the Holding template uses {instrument, source, id} — different).
        const t = ((c.payload as Record<string, unknown>).transfer ?? {}) as {
          sender?: string;
          amount?: string;
          instrumentId?: { admin?: string; id?: string };
          requestedAt?: string;
          executeBefore?: string;
        };
        const inst = t.instrumentId ?? {};
        const executeBefore = t.executeBefore ?? null;
        const expiresAtMs = executeBefore ? Date.parse(executeBefore) : NaN;
        const expired = isFinite(expiresAtMs) ? expiresAtMs <= now : false;
        return {
          contractId: c.contractId,
          sender: t.sender ?? null,
          amount: t.amount ?? null,
          instrument: { admin: inst.admin ?? null, id: inst.id ?? null },
          requestedAt: t.requestedAt ?? null,
          executeBefore,
          expired,
        };
      });
    res.json({ partyId: userParty, pending });
  } catch (err) {
    res.status(502).json({
      error: 'ledger_query_failed',
      detail: (err as Error).message,
    });
  }
});

// ─── GET /user/transfers/outgoing ────────────────────────────────────────
// Lists OUTGOING TransferOffer contracts where the caller is the sender —
// i.e. p2p transfers we initiated that haven't been accepted yet. Surfaced
// so the user can cancel them via POST /user/transfers/:cid/cancel
// (sender-side TransferInstruction_Withdraw).
router.get('/user/transfers/outgoing', requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken } = req as UserAuthRequest;

  try {
    const contracts = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_TRANSFER_OFFER },
    );
    const now = Date.now();
    const outgoing = contracts
      .filter((c) => {
        const t = ((c.payload as Record<string, unknown>).transfer ?? {}) as { sender?: string };
        return t.sender === userParty;
      })
      .map((c) => {
        const t = ((c.payload as Record<string, unknown>).transfer ?? {}) as {
          receiver?: string;
          amount?: string;
          instrumentId?: { admin?: string; id?: string };
          requestedAt?: string;
          executeBefore?: string;
        };
        const inst = t.instrumentId ?? {};
        const executeBefore = t.executeBefore ?? null;
        const expiresAtMs = executeBefore ? Date.parse(executeBefore) : NaN;
        const expired = isFinite(expiresAtMs) ? expiresAtMs <= now : false;
        return {
          contractId: c.contractId,
          receiver: t.receiver ?? null,
          amount: t.amount ?? null,
          instrument: { admin: inst.admin ?? null, id: inst.id ?? null },
          requestedAt: t.requestedAt ?? null,
          executeBefore,
          expired,
        };
      });
    res.json({ partyId: userParty, outgoing });
  } catch (err) {
    res.status(502).json({
      error: 'ledger_query_failed',
      detail: (err as Error).message,
    });
  }
});

// ─── POST /user/transfers/:cid/accept ────────────────────────────────────
// Accept an incoming USDCx TransferOffer by exercising the CIP-56
// `TransferInstruction_Accept` choice. The DA per-admin USDCx registry
// returns the accept choice-context (including the TransferRule blob our
// managed parties can't see on chain) + the disclosed contracts we need to
// disclose alongside the submit.
router.post('/user/transfers/:cid/accept', requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken, userId } = req as UserAuthRequest;
  const { cid } = req.params;
  if (!cid || !/^[0-9a-f]+$/i.test(cid)) {
    res.status(400).json({ error: 'invalid_cid', detail: 'invalid contract id' });
    return;
  }

  try {
    // Pre-flight: confirm visible + receiver matches + not expired.
    const offers = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_TRANSFER_OFFER },
    );
    const offer = offers.find((c) => c.contractId === cid);
    if (!offer) {
      res.status(404).json({ error: 'not_found', detail: 'No active TransferOffer with that cid visible to your party.' });
      return;
    }
    const t = ((offer.payload as Record<string, unknown>).transfer ?? {}) as { receiver?: string; executeBefore?: string };
    if (t.receiver !== userParty) {
      res.status(403).json({ error: 'not_receiver', detail: 'You are not the receiver on this TransferOffer.' });
      return;
    }
    const executeBefore = t.executeBefore ? Date.parse(t.executeBefore) : NaN;
    if (isFinite(executeBefore) && executeBefore <= Date.now()) {
      res.status(410).json({
        error: 'expired',
        detail: `TransferOffer expired at ${t.executeBefore}. Ask sender to cancel + resend, or enable USDCx auto-receive so the resend auto-completes.`,
        executeBefore: t.executeBefore,
      });
      return;
    }

    // Fetch the accept choice context from DA's per-admin USDCx registry.
    // Returns { choiceContextData: {values:...}, disclosedContracts:[...] }
    // — the TransferRule disclosure is the part we can't construct locally.
    const ctxUrl = `${UTILITY_BACKEND_URL}/api/token-standard/v0/registrars/${INSTRUMENT_ADMIN_PARTY_ID}/registry/transfer-instruction/v1/${cid}/choice-contexts/accept`;
    const ctxRes = await fetch(ctxUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: {}, excludeDebugFields: true }),
    });
    if (!ctxRes.ok) {
      const text = await ctxRes.text();
      console.error('[accept] choice-context fetch failed', { status: ctxRes.status, text, ctxUrl });
      res.status(502).json({
        error: 'accept_context_failed',
        detail: text.slice(0, 800),
      });
      return;
    }
    const ctx = (await ctxRes.json()) as {
      choiceContextData?: { values?: Record<string, { tag?: string; value: unknown }> };
      disclosedContracts?: Array<Record<string, unknown>>;
    };
    const contextValues: Record<string, { tag?: string; value: unknown }> = {
      ...(ctx.choiceContextData?.values ?? {}),
    };
    // Dedupe disclosed contracts by contract id (defense-in-depth — Canton
    // rejects duplicates).
    const seen = new Set<string>();
    const disclosedContracts = (ctx.disclosedContracts ?? []).filter((d) => {
      const c = (d as { contractId?: string }).contractId;
      if (!c) return true;
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });

    try {
      await submitCommand(
        sdkConfig,
        userToken,
        userId,
        [userParty],
        [
          {
            ExerciseCommand: {
              templateId: IFACE_TRANSFER_INSTRUCTION,
              contractId: cid,
              choice: 'TransferInstruction_Accept',
              choiceArgument: {
                extraArgs: {
                  context: { values: contextValues },
                  meta: { values: {} },
                },
              },
            },
          },
        ],
        { commandId: `accept-${Date.now()}`, disclosedContracts },
      );
    } catch (submitErr) {
      res.status(502).json({
        error: 'accept_failed',
        detail: (submitErr as Error).message.slice(0, 1200),
        attempted: {
          contextKeys: Object.keys(contextValues),
          disclosedCount: disclosedContracts.length,
        },
      });
      return;
    }

    res.json({ ok: true, message: 'Transfer accepted.' });
  } catch (err) {
    res.status(502).json({
      error: 'accept_failed',
      detail: (err as Error).message,
    });
  }
});

// ─── POST /user/transfers/:cid/cancel ────────────────────────────────────
// Sender-side withdraw of an outstanding TransferOffer. Exercises the
// CIP-56 `TransferInstruction_Withdraw` choice — controlled by the sender,
// so the user's own JWT suffices. Pulls the per-admin USDCx registry's
// withdraw choice-context for any context entries / disclosures the Daml
// impl needs (e.g. instrument config, app-reward-config refs). NOTE: per
// the dalf, only TransferInstruction_Update takes extraActors — Withdraw
// does NOT, hence the choiceArgument carries only extraArgs.
router.post('/user/transfers/:cid/cancel', requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken, userId } = req as UserAuthRequest;
  const { cid } = req.params;
  if (!cid || !/^[0-9a-f]+$/i.test(cid)) {
    res.status(400).json({ error: 'invalid_cid', detail: 'invalid transfer cid' });
    return;
  }

  try {
    // Pre-flight: confirm visible + this user is the sender.
    const all = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_TRANSFER_OFFER },
    );
    const offer = all.find((c) => c.contractId === cid);
    if (!offer) {
      res.status(404).json({ error: 'not_found', detail: 'no TransferOffer with that cid visible to you' });
      return;
    }
    const t = ((offer.payload as Record<string, unknown>).transfer ?? {}) as { sender?: string };
    if (t.sender !== userParty) {
      res.status(403).json({ error: 'not_sender', detail: 'you are not the sender of this transfer' });
      return;
    }

    // Fetch the withdraw choice context from the per-admin USDCx registry.
    const ctxUrl = `${UTILITY_BACKEND_URL}/api/token-standard/v0/registrars/${INSTRUMENT_ADMIN_PARTY_ID}/registry/transfer-instruction/v1/${cid}/choice-contexts/withdraw`;
    const ctxRes = await fetch(ctxUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: {}, excludeDebugFields: true }),
    });
    if (!ctxRes.ok) {
      const text = await ctxRes.text();
      console.error('[cancel] choice-context fetch failed', { status: ctxRes.status, text, ctxUrl });
      res.status(502).json({
        error: 'cancel_context_failed',
        detail: text.slice(0, 800),
      });
      return;
    }
    const ctx = (await ctxRes.json()) as {
      choiceContextData?: { values?: Record<string, { tag?: string; value: unknown }> };
      disclosedContracts?: Array<Record<string, unknown>>;
    };
    const contextValues: Record<string, { tag?: string; value: unknown }> = {
      ...(ctx.choiceContextData?.values ?? {}),
    };
    const seen = new Set<string>();
    const disclosedContracts = (ctx.disclosedContracts ?? []).filter((d) => {
      const c = (d as { contractId?: string }).contractId;
      if (!c) return true;
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });

    try {
      await submitCommand(
        sdkConfig,
        userToken,
        userId,
        [userParty],
        [
          {
            ExerciseCommand: {
              templateId: IFACE_TRANSFER_INSTRUCTION,
              contractId: cid,
              choice: 'TransferInstruction_Withdraw',
              choiceArgument: {
                extraArgs: {
                  context: { values: contextValues },
                  meta: { values: {} },
                },
              },
            },
          },
        ],
        { commandId: `cancel-${Date.now()}`, disclosedContracts },
      );
    } catch (submitErr) {
      res.status(502).json({
        error: 'cancel_failed',
        detail: (submitErr as Error).message.slice(0, 1200),
        attempted: {
          contextKeys: Object.keys(contextValues),
          disclosedCount: disclosedContracts.length,
        },
      });
      return;
    }

    res.json({ ok: true, message: 'Transfer cancelled.' });
  } catch (err) {
    res.status(502).json({
      error: 'cancel_failed',
      detail: (err as Error).message,
    });
  }
});

// ─── GET /user/bridge/deposits ───────────────────────────────────────────
// Lists pending DepositAttestation contracts where the caller is recipient.
// After a user deposits USDC on Sepolia, Circle's attester creates a
// `DepositAttestation` on Canton; the user then mints USDCx by exercising
// `BridgeUserAgreement_Mint` to consume it. We DON'T port the in-app mint
// for v1 — just surface the list + link out to the xreserve-deposits UI.
router.get('/user/bridge/deposits', requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken } = req as UserAuthRequest;

  try {
    const contracts = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_DEPOSIT_ATTESTATION },
    );
    const deposits = contracts
      .filter((c) => (c.payload as Record<string, unknown>).recipient === userParty)
      .map((c) => {
        const p = c.payload as Record<string, unknown>;
        const inst = (p.instrumentId ?? {}) as { admin?: string; id?: string };
        return {
          contractId: c.contractId,
          amount: (p.amount as string | undefined) ?? null,
          recipient: (p.recipient as string | undefined) ?? null,
          sourceDepositor: (p.sourceDepositor as string | undefined) ?? null,
          reference: (p.reference as string | undefined) ?? null,
          instrument: { admin: inst.admin ?? null, id: inst.id ?? null },
        };
      });
    res.json({
      partyId: userParty,
      deposits,
      bridgeUiUrl: 'https://digital-asset.github.io/xreserve-deposits/',
    });
  } catch (err) {
    res.status(502).json({
      error: 'ledger_query_failed',
      detail: (err as Error).message,
    });
  }
});

// ─── POST /user/bridge/agreement/request ─────────────────────────────────
// Create a BridgeUserAgreementRequest for the caller. DA's bridge operator
// automation accepts it out-of-band, producing the BridgeUserAgreement that
// carries the Mint/Burn choices. Idempotent: if the user already has a
// BridgeUserAgreement we short-circuit (nothing to request).
router.post('/user/bridge/agreement/request', json(), requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken, userId } = req as UserAuthRequest;

  try {
    const existing = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_BRIDGE_USER_AGREEMENT },
    );
    if (existing.some((c) => (c.payload as Record<string, unknown>).user === userParty)) {
      res.json({
        ok: true,
        message: 'Bridge agreement already active.',
        alreadyActive: true,
      });
      return;
    }

    const result = await submitCommand(
      sdkConfig,
      userToken,
      userId,
      [userParty],
      [
        {
          CreateCommand: {
            templateId: TPL_BRIDGE_USER_AGREEMENT_REQUEST,
            createArguments: {
              crossChainRepresentative: INSTRUMENT_ADMIN_PARTY_ID,
              operator: UTILITY_OPERATOR,
              bridgeOperator: BRIDGE_OPERATOR_PARTY_ID,
              user: userParty,
              instrumentId: { admin: INSTRUMENT_ADMIN_PARTY_ID, id: INSTRUMENT_ID },
              preApproval: false,
            },
          },
        },
      ],
      { commandId: `bua-request-${Date.now()}` },
    );

    res.json({
      ok: true,
      message:
        'Bridge agreement requested. It becomes active once the bridge operator accepts (usually within a minute).',
      transactionTree: result,
    });
  } catch (err) {
    res.status(502).json({
      error: 'bua_request_failed',
      detail: (err as Error).message,
    });
  }
});

// ─── POST /user/bridge/mint/:cid ─────────────────────────────────────────
// Mint USDCx from a pending DepositAttestation (Sepolia → Canton bridge in).
//   1. Resolve the attestation (must be visible + recipient = caller).
//   2. Resolve the caller's BridgeUserAgreement (must exist).
//   3. Fetch burn-mint-factory context for the attestation amount.
//   4. Exercise BridgeUserAgreement_Mint, disclosing the factory contracts.
router.post('/user/bridge/mint/:cid', json(), requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken, userId } = req as UserAuthRequest;
  const { cid } = req.params;
  if (!cid || !/^[0-9a-f]+$/i.test(cid)) {
    res.status(400).json({ error: 'invalid_cid', detail: 'invalid deposit attestation cid' });
    return;
  }

  try {
    const attestations = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_DEPOSIT_ATTESTATION },
    );
    const att = attestations.find((c) => c.contractId === cid);
    if (!att) {
      res.status(404).json({
        error: 'deposit_not_found',
        detail: 'No DepositAttestation with that cid visible to your party.',
      });
      return;
    }
    if ((att.payload as Record<string, unknown>).recipient !== userParty) {
      res.status(403).json({ error: 'not_recipient', detail: 'You are not the recipient of this deposit.' });
      return;
    }
    const amount = String((att.payload as Record<string, unknown>).amount ?? '');
    if (!amount) {
      res.status(409).json({ error: 'attestation_missing_amount', detail: 'Deposit attestation has no amount.' });
      return;
    }

    const buas = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { templateId: TPL_BRIDGE_USER_AGREEMENT },
    );
    const bua = buas.find((c) => (c.payload as Record<string, unknown>).user === userParty);
    if (!bua) {
      res.status(409).json({
        error: 'no_bridge_user_agreement',
        detail: 'Request the bridge agreement first — it must be active before you can mint.',
      });
      return;
    }

    const ctx = await fetchBurnMintContext(
      [],
      [{ owner: INSTRUMENT_ADMIN_PARTY_ID, amount }],
    );

    await submitCommand(
      sdkConfig,
      userToken,
      userId,
      [userParty],
      [
        {
          ExerciseCommand: {
            templateId: TPL_BRIDGE_USER_AGREEMENT,
            contractId: bua.contractId,
            choice: CHOICE_BUA_MINT,
            choiceArgument: {
              depositAttestationCid: cid,
              factoryCid: ctx.factoryId,
              contextContractIds: ctx.contextContractIds,
            },
          },
        },
      ],
      { commandId: `mint-${Date.now()}`, disclosedContracts: ctx.disclosedContracts },
    );

    res.json({
      ok: true,
      amount,
      instrument: INSTRUMENT_ID,
      message: `Minted ${formatInstrumentAmount(amount)} ${INSTRUMENT_ID}.`,
    });
  } catch (err) {
    res.status(502).json({
      error: 'mint_failed',
      detail: (err as Error).message,
    });
  }
});

// ─── POST /user/bridge/withdraw ──────────────────────────────────────────
// Bridge OUT (Canton → Ethereum): burn USDCx via BridgeUserAgreement_Burn.
// body: { amount, destinationRecipient (0x… EVM addr), reference? }
//   1. Resolve the caller's BridgeUserAgreement + USDCx holdings.
//   2. Pick holdings to cover `amount`; compute exact change (fixed-point).
//   3. burn-mint-factory context with outputs=[{owner:ADMIN, amount:change}].
//   4. Exercise BridgeUserAgreement_Burn (destinationDomain=0 = Ethereum).
router.post('/user/bridge/withdraw', json(), requireUserAuth, async (req: Request, res: Response) => {
  const { userParty, userToken, userId } = req as UserAuthRequest;
  const body = (req.body ?? {}) as { amount?: string; destinationRecipient?: string; reference?: string };

  const amount = (body.amount ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    res.status(400).json({ error: 'invalid_amount', detail: 'amount must be a positive decimal' });
    return;
  }
  if ((amount.split('.')[1]?.length ?? 0) > 6) {
    res.status(400).json({ error: 'invalid_amount', detail: 'amount supports at most 6 decimal places' });
    return;
  }
  const destinationRecipient = (body.destinationRecipient ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(destinationRecipient)) {
    res.status(400).json({ error: 'invalid_recipient', detail: 'destinationRecipient must be a 0x… 20-byte Ethereum address' });
    return;
  }
  const reference = body.reference ?? '';

  try {
    const buas = await getActiveContracts(sdkConfig, userToken, userParty, { templateId: TPL_BRIDGE_USER_AGREEMENT });
    const bua = buas.find((c) => (c.payload as Record<string, unknown>).user === userParty);
    if (!bua) {
      res.status(409).json({
        error: 'no_bridge_user_agreement',
        detail: 'Request the bridge agreement first — it must be active before you can withdraw.',
      });
      return;
    }

    // Fixed-point (scale 10) so the change output is exact (float would drift).
    const pow = 10n ** BigInt(USDCX_SCALE);
    const toScaled = (s: string): bigint => {
      const [int, frac = ''] = s.split('.');
      const fracPadded = (frac + '0'.repeat(USDCX_SCALE)).slice(0, USDCX_SCALE);
      return BigInt(int || '0') * pow + BigInt(fracPadded || '0');
    };
    const fromScaled = (n: bigint): string => {
      const intPart = (n / pow).toString();
      const fracPart = (n % pow).toString().padStart(USDCX_SCALE, '0').replace(/0+$/, '');
      return fracPart ? `${intPart}.${fracPart}` : intPart;
    };

    const holdings = await getActiveContracts(sdkConfig, userToken, userParty, { interfaceId: IFACE_HOLDING });
    const usdcx = holdings
      .map((h) => ({ cid: h.contractId, view: h.interfaceView as Record<string, any> | undefined }))
      .filter((h) => {
        const v = h.view;
        if (!v || v.owner !== userParty) return false;
        const iid = (v.instrumentId ?? {}) as { admin?: string; id?: string };
        return iid.admin === INSTRUMENT_ADMIN_PARTY_ID && iid.id === INSTRUMENT_ID;
      })
      .map((h) => ({ cid: h.cid, scaled: toScaled(String(h.view!.amount ?? '0')) }))
      .filter((h) => h.scaled > 0n)
      .sort((a, b) => (b.scaled > a.scaled ? 1 : b.scaled < a.scaled ? -1 : 0));

    const need = toScaled(amount);
    const picked: typeof usdcx = [];
    let acc = 0n;
    for (const h of usdcx) {
      if (acc >= need) break;
      picked.push(h);
      acc += h.scaled;
    }
    if (acc < need) {
      res.status(409).json({
        error: 'insufficient_balance',
        detail: `Need ${amount} ${INSTRUMENT_ID}; available ${fromScaled(usdcx.reduce((s, h) => s + h.scaled, 0n))}.`,
      });
      return;
    }

    const change = acc - need;
    const outputs = change > 0n ? [{ owner: INSTRUMENT_ADMIN_PARTY_ID, amount: fromScaled(change) }] : [];
    const ctx = await fetchBurnMintContext(picked.map((h) => h.cid), outputs);

    const requestId = crypto.randomUUID();
    await submitCommand(
      sdkConfig,
      userToken,
      userId,
      [userParty],
      [
        {
          ExerciseCommand: {
            templateId: TPL_BRIDGE_USER_AGREEMENT,
            contractId: bua.contractId,
            choice: CHOICE_BUA_BURN,
            choiceArgument: {
              amount,
              destinationDomain: ETHEREUM_DOMAIN_ID,
              destinationRecipient,
              holdingCids: picked.map((h) => h.cid),
              requestId,
              reference,
              factoryCid: ctx.factoryId,
              contextContractIds: ctx.contextContractIds,
            },
          },
        },
      ],
      { commandId: `burn-${Date.now()}`, disclosedContracts: ctx.disclosedContracts },
    );

    res.json({
      ok: true,
      amount,
      instrument: INSTRUMENT_ID,
      destinationRecipient,
      requestId,
      message: `Burn submitted: ${formatInstrumentAmount(amount)} ${INSTRUMENT_ID} → ${destinationRecipient}.`,
    });
  } catch (err) {
    res.status(502).json({
      error: 'withdraw_failed',
      detail: (err as Error).message,
    });
  }
});

export default router;
