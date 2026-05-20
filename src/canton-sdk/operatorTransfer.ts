/**
 * Operator-driven CIP-56 transfer.
 *
 * Ported from exchange-v2/backend/src/services/amuletTransfer.ts. The
 * operator has CanActAs(vaultPool) + CanActAs(treasury) on our validator,
 * so it can submit `TransferFactory_Transfer` choices with sender = those
 * parties. The flow:
 *
 *   1. ACS query: list `sender`'s active CIP-56 Holdings for the
 *      configured instrument.
 *   2. Greedy-pick smallest-first holdings until they cover `amount`.
 *      The picked holdings' cids become `inputHoldingCids` in the
 *      choice argument.
 *   3. Ask Splice scan for the enriched choice (factoryCid +
 *      choiceContext + disclosedContracts).
 *   4. submitAndWait the exercise — operator + sender in `actAs`,
 *      `disclosedContracts` passed through.
 */
import type { CantonSdkConfig } from './config.js';
import {
  CHOICE_TRANSFER_FACTORY_TRANSFER,
  IFACE_HOLDING,
  IFACE_TRANSFER_FACTORY,
} from './config.js';
import { getActiveContracts, submitCommand } from './ledger.js';
import { getTransferFactory } from './scanApi.js';

const TRANSFER_EXECUTE_TTL_MS = 60 * 60 * 1000; // 1 h

export interface SendAmuletArgs {
  config: CantonSdkConfig;
  opToken: string;
  opUserId: string;
  sender: string;
  receiver: string;
  amount: string;
  instrumentAdmin: string;
  instrumentId: string;
  /** Extra parties (beyond operator) needed in actAs. Typically `[sender]`. */
  extraActAs?: string[];
  /** memo `values` written into the transfer; useful for audit / forensics. */
  memo?: Record<string, string>;
  /** Pin commandId for idempotency on retry. */
  commandId?: string;
}

export interface SendAmuletResult {
  transferUpdateId: string | null;
  /** Holding cids consumed from `sender`'s side. */
  inputHoldingCids: string[];
}

export async function sendAmulet(args: SendAmuletArgs): Promise<SendAmuletResult> {
  const {
    config,
    opToken,
    opUserId,
    sender,
    receiver,
    amount,
    instrumentAdmin,
    instrumentId,
    extraActAs = [],
    memo = {},
    commandId,
  } = args;

  // 1. Holdings owned by sender, filtered to the right instrument.
  const holdings = await getActiveContracts(
    config,
    opToken,
    sender,
    { interfaceId: IFACE_HOLDING },
  );
  const inputs = pickHoldingsForAmount(holdings, amount, {
    sender,
    instrumentAdmin,
    instrumentId,
  });
  if (!inputs) {
    throw new Error(
      `${sender} has insufficient ${instrumentId} balance to send ${amount}`,
    );
  }

  // 2. Build the choice argument.
  const startedAt = new Date();
  const transferArgs = {
    expectedAdmin: instrumentAdmin,
    transfer: {
      sender,
      receiver,
      amount,
      instrumentId: { admin: instrumentAdmin, id: instrumentId },
      requestedAt: startedAt.toISOString(),
      executeBefore: new Date(startedAt.getTime() + TRANSFER_EXECUTE_TTL_MS).toISOString(),
      inputHoldingCids: inputs,
      meta: { values: { ...memo } },
    },
    extraArgs: {
      context: { values: {} as Record<string, unknown> },
      meta: { values: {} },
    },
  };

  // 3. Enrich via scan (factoryCid + choiceContext + disclosed contracts).
  const enriched = await getTransferFactory(transferArgs);
  transferArgs.extraArgs.context = enriched.choiceContext;

  // 4. Submit. operator + sender in actAs so the choice's authorization
  //    chain is satisfied (sender's Holdings are spent).
  const actAs = Array.from(new Set([config.parties.operator, sender, ...extraActAs]));
  const result = await submitCommand(
    config,
    opToken,
    opUserId,
    actAs,
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
    { disclosedContracts: enriched.disclosedContracts, commandId },
  );

  const transferUpdateId =
    (result as { transactionTree?: { updateId?: string } }).transactionTree?.updateId ?? null;
  return { transferUpdateId, inputHoldingCids: inputs };
}

interface HoldingView {
  owner?: string;
  amount?: string;
  instrumentId?: { admin?: string; id?: string };
  lock?: unknown;
}

/**
 * Smallest-first greedy fit. Returns the chosen holding cids, or null if
 * even consuming everything doesn't cover the requested amount. Mirrors
 * the algorithm in exchange-v2/backend/src/services/amuletTransfer.ts.
 */
function pickHoldingsForAmount(
  holdings: Array<{ contractId: string; payload: Record<string, unknown>; interfaceView?: Record<string, unknown> }>,
  amount: string,
  ctx: { sender: string; instrumentAdmin: string; instrumentId: string },
): string[] | null {
  const need = toScaled(amount);
  const candidates = holdings
    .map((h) => ({ cid: h.contractId, view: (h.interfaceView ?? h.payload) as HoldingView }))
    .filter((h) => {
      if (h.view.owner !== undefined && h.view.owner !== ctx.sender) return false;
      const iid = h.view.instrumentId ?? {};
      if (iid.admin !== ctx.instrumentAdmin || iid.id !== ctx.instrumentId) return false;
      return !h.view.lock;
    })
    .map((h) => ({ cid: h.cid, amount: toScaled(String(h.view.amount ?? '0')) }))
    .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));

  let remaining = need;
  const picked: string[] = [];
  for (const h of candidates) {
    if (remaining <= 0n) break;
    picked.push(h.cid);
    remaining -= h.amount;
  }
  return remaining > 0n ? null : picked;
}

const SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

function toScaled(decimal: string): bigint {
  const [intPart, fracPart = ''] = decimal.split('.');
  const fracPadded = (fracPart + '0'.repeat(SCALE)).slice(0, SCALE);
  return BigInt(intPart || '0') * SCALE_FACTOR + BigInt(fracPadded || '0');
}
