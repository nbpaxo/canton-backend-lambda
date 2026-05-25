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
import { normalizePartyId } from '../auth.js';
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
import { getTransferFactory } from '../canton-sdk/scanApi.js';
import { CANTON_LEDGER_API, INSTRUMENT_ADMIN_PARTY_ID, INSTRUMENT_ID, UTILITY_BACKEND_URL } from '../config.js';

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

// Hardcoded testnet utility-operator party (observed on chain). Mainnet
// will differ — re-derive at that point.
const UTILITY_OPERATOR =
  'DigitalAsset-UtilityOperator::12202679f2bbe57d8cba9ef3cee847ac8239df0877105ab1f01a77d47477fdce1204';

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

  const rawParty =
    (req.headers['x-party-id'] as string | undefined) ??
    (typeof req.query.partyId === 'string' ? req.query.partyId : undefined);
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
    res.status(501).json({
      error: 'cc_preapproval_not_supported_inproc',
      detail: 'Create the CC auto-accept on the validator wallet for now.',
      redirectTo: 'https://testnet-wallet.43.217.203.156.nip.io/',
    });
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

// ─── POST /user/transfers/send ───────────────────────────────────────────
// USDCx peer-to-peer send. body: { receiver, amount, memo? }
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
  const body = (req.body ?? {}) as { receiver?: string; amount?: string; memo?: Record<string, string> };
  if (!body.receiver || !body.amount) {
    res.status(400).json({ error: 'required fields: receiver, amount' });
    return;
  }
  const receiver = normalizePartyId(body.receiver);
  const amount = body.amount;

  try {
    // USDCx holdings via the CIP-56 Holding interface.
    const IFACE_HOLDING =
      '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';
    const holdings = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { interfaceId: IFACE_HOLDING },
    );
    const usdcxOwned = holdings.filter((h) => {
      const v = h.interfaceView as Record<string, any> | undefined;
      if (!v) return false;
      if (v.owner !== userParty) return false;
      const iid = v.instrumentId as { admin?: string; id?: string } | undefined;
      return iid?.admin === INSTRUMENT_ADMIN_PARTY_ID && iid?.id === INSTRUMENT_ID;
    });

    if (usdcxOwned.length === 0) {
      res.status(400).json({ error: 'no_usdcx_holdings', detail: 'You have no USDCx holdings on your party.' });
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
      expectedAdmin: INSTRUMENT_ADMIN_PARTY_ID,
      transfer: {
        sender: userParty,
        receiver,
        amount,
        instrumentId: { admin: INSTRUMENT_ADMIN_PARTY_ID, id: INSTRUMENT_ID },
        requestedAt: now.toISOString(),
        executeBefore: new Date(now.getTime() + INSTRUCTION_TTL_MS).toISOString(),
        inputHoldingCids: usdcxOwned.map((h) => h.contractId),
        meta: { values: { ...(body.memo ?? {}) } },
      },
      extraArgs: {
        context: { values: {} as Record<string, unknown> },
        meta: { values: {} },
      },
    };

    const enriched = await getTransferFactory(transferArgs);
    transferArgs.extraArgs.context = enriched.choiceContext;

    // DA's per-admin registry returns ONE of two factory cids based on the
    // receiver's state:
    //   • TransferPreapproval cid → TransferFactory_Transfer auto-completes
    //     into a Holding owned by the receiver. No accept step.
    //   • AllocationFactory cid    → TransferFactory_Transfer creates a
    //     2-step TransferInstruction; the receiver must POST /accept.
    // Detect which path the registry chose by looking at disclosedContracts.
    const autoCompleted = enriched.disclosedContracts.some((d) => {
      const tplId = (d.templateId ?? (d as Record<string, unknown>).template_id) as string | undefined;
      return tplId?.endsWith(
        ':Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval',
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
      instrument: INSTRUMENT_ID,
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
  const q = (req.query ?? {}) as { receiver?: string };
  const receiver = q.receiver?.trim();
  if (!receiver || !receiver.includes('::')) {
    res.status(400).json({
      error: 'receiver must be a full party id (prefix::namespace)',
    });
    return;
  }

  try {
    // 1. Find ONE USDCx holding the sender owns — the registry needs at
    //    least one cid in inputHoldingCids or it 400s.
    const IFACE_HOLDING =
      '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';
    const holdings = await getActiveContracts(
      sdkConfig,
      userToken,
      userParty,
      { interfaceId: IFACE_HOLDING },
    );
    const probeCid = holdings.find((h) => {
      const v = h.interfaceView as Record<string, any> | undefined;
      if (!v || v.owner !== userParty) return false;
      const iid = v.instrumentId as { admin?: string; id?: string } | undefined;
      return iid?.admin === INSTRUMENT_ADMIN_PARTY_ID && iid?.id === INSTRUMENT_ID;
    })?.contractId;

    if (!probeCid) {
      res.json({
        receiver,
        instrumentAdmin: INSTRUMENT_ADMIN_PARTY_ID,
        instrumentId: INSTRUMENT_ID,
        hasPreapproval: null,
        reason: 'sender_has_no_usdcx_holdings',
      });
      return;
    }

    // 2. Probe the registry with one real holding cid. Never submitted.
    const now = new Date();
    const probeArgs = {
      expectedAdmin: INSTRUMENT_ADMIN_PARTY_ID,
      transfer: {
        sender: userParty,
        receiver,
        amount: '1',
        instrumentId: { admin: INSTRUMENT_ADMIN_PARTY_ID, id: INSTRUMENT_ID },
        requestedAt: now.toISOString(),
        executeBefore: new Date(now.getTime() + 60_000).toISOString(),
        inputHoldingCids: [probeCid],
        meta: { values: {} },
      },
      extraArgs: { context: { values: {} }, meta: { values: {} } },
    };
    const enriched = await getTransferFactory(probeArgs);
    const hasPreapproval = enriched.disclosedContracts.some((d) => {
      const tplId = (d.templateId ?? (d as Record<string, unknown>).template_id) as string | undefined;
      return tplId?.endsWith(
        ':Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval',
      );
    });
    res.json({
      receiver,
      instrumentAdmin: INSTRUMENT_ADMIN_PARTY_ID,
      instrumentId: INSTRUMENT_ID,
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

export default router;
