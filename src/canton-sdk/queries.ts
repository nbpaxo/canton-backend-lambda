/**
 * High-level query helpers for the lambda's user-facing routes.
 *
 * Holdings: read CIP-56 `Holding` interface as the operator (operator can
 * see vaultPool's holdings; for user holdings we'd want their JWT, but
 * with the open-auth shim we don't have one — so the operator queries on
 * the user's behalf and we filter by owner client-side. Replace with the
 * user's JWT once a proper auth path lands).
 *
 * DepositRecords: read our `#exchange-v2-core:Vault:DepositRecord`
 * template as the operator and filter by the `user` data field.
 */

import type { CantonSdkConfig } from './config.js';
import { IFACE_HOLDING, TPL_DEPOSIT_RECORD } from './config.js';
import { getActiveContracts } from './ledger.js';
import { getOperatorToken } from './tokens.js';

export interface HoldingInfo {
  contractId: string;
  owner: string;
  amount: number;
  instrumentAdmin: string;
  instrumentId: string;
  locked: boolean;
}

export interface DepositRecordInfo {
  contractId: string;
  user: string;
  amount: number;
  sourceTransferId: string;
  depositedAt: string;
}

/**
 * Read all CIP-56 Holdings owned by `userParty`. Optionally filter by
 * instrument (we default to whatever's in env via the caller).
 *
 * Note: queries as the user's party. Loop callers authenticate with a wallet
 * signature rather than a ledger JWT, so there is no user token to submit
 * with — we fall back to an operator-scoped query and filter client-side by
 * owner. Fine for reads; doesn't generalize to mutations.
 */
export async function getUserHoldings(
  config: CantonSdkConfig,
  userParty: string,
  opts: { instrumentAdmin?: string; instrumentId?: string } = {},
): Promise<HoldingInfo[]> {
  const opToken = await getOperatorToken(config);

  // Try as the user first (when they have rights granted) — falls back to
  // operator if the user has no rights on this participant.
  let contracts;
  try {
    contracts = await getActiveContracts(config, opToken, userParty, { interfaceId: IFACE_HOLDING });
  } catch {
    contracts = await getActiveContracts(config, opToken, config.parties.operator, { interfaceId: IFACE_HOLDING });
  }

  return contracts
    .map((c) => {
      const v = (c.interfaceView ?? c.payload) as Record<string, unknown>;
      const iid = (v.instrumentId ?? {}) as { admin?: string; id?: string };
      return {
        contractId: c.contractId,
        owner: String(v.owner ?? ''),
        amount: parseFloat(String(v.amount ?? '0')),
        instrumentAdmin: iid.admin ?? '',
        instrumentId: iid.id ?? '',
        locked: Boolean(v.lock),
      };
    })
    .filter((h) => {
      if (h.owner !== userParty) return false;
      if (h.amount <= 0) return false;
      if (opts.instrumentAdmin && h.instrumentAdmin !== opts.instrumentAdmin) return false;
      if (opts.instrumentId && h.instrumentId !== opts.instrumentId) return false;
      return true;
    });
}

/**
 * Read DepositRecord contracts for a user. Queried as the operator since
 * DepositRecord is operator-only signed (user is a data field, not a
 * stakeholder).
 */
export async function getUserDepositRecords(
  config: CantonSdkConfig,
  userParty: string,
): Promise<DepositRecordInfo[]> {
  const opToken = await getOperatorToken(config);
  const contracts = await getActiveContracts(
    config, opToken, config.parties.operator, { templateId: TPL_DEPOSIT_RECORD },
  );

  return contracts
    .map((c) => {
      const p = c.payload;
      return {
        contractId: c.contractId,
        user: String(p.user ?? ''),
        amount: parseFloat(String(p.amount ?? '0')),
        sourceTransferId: String(p.sourceTransferId ?? ''),
        depositedAt: String(p.depositedAt ?? ''),
      };
    })
    .filter((r) => r.user === userParty && r.amount > 0);
}
