/**
 * Active DepositRecord query — Canton ledger is the source of truth.
 *
 * The `deposits` Postgres table is a derived audit log; it tracks each
 * DepositRecord we've created and marks it `consumed_at` when a withdrawal
 * consumes it. But the table can drift from on-chain state:
 *   - watcher hiccup misses a DepositRecord create  → DB short, chain ahead
 *   - manual `ConsumeForWithdrawal` outside our route → chain short, DB ahead
 *
 * For anything that decides what's actually spendable (Holdings UI, withdraw
 * deposit-picking, balance reconciliation), we query the ledger directly.
 * The DB is then a side-effect we update best-effort.
 */
import type { CantonSdkConfig } from './config.js';
import { TPL_DEPOSIT_RECORD } from './config.js';
import { getActiveContracts } from './ledger.js';

export interface OnChainDepositRecord {
  /** Contract id — the canonical handle for `ConsumeForWithdrawal` / `SplitForWithdrawal`. */
  cid: string;
  user: string;
  /** Decimal string; pg-compatible NUMERIC formatting. */
  amount: string;
  instrumentAdmin: string;
  instrumentId: string;
  sourceTransferId: string;
  /** ISO timestamp (matches `Time.toIsoString`). Use this for FIFO tie-breaks. */
  depositedAt: string;
}

/**
 * Active DepositRecord contracts on chain for `userPartyId`.
 *
 * DepositRecord is operator-only-signed (user is a data field, not a
 * stakeholder), so we query as operator and filter by `user` client-side.
 *
 * Optionally filter to a specific instrument so withdrawals only pick
 * deposit receipts denominated in the configured token.
 */
export async function getUserDepositRecords(
  config: CantonSdkConfig,
  opToken: string,
  userPartyId: string,
  filter?: { instrumentAdmin?: string; instrumentId?: string },
): Promise<OnChainDepositRecord[]> {
  const contracts = await getActiveContracts(
    config,
    opToken,
    config.parties.operator,
    { templateId: TPL_DEPOSIT_RECORD },
  );

  const out: OnChainDepositRecord[] = [];
  for (const c of contracts) {
    const p = c.payload as Record<string, unknown>;
    if (p.user !== userPartyId) continue;
    if (filter?.instrumentAdmin && p.instrumentAdmin !== filter.instrumentAdmin) continue;
    if (filter?.instrumentId && p.instrumentId !== filter.instrumentId) continue;
    out.push({
      cid: c.contractId,
      user: String(p.user),
      amount: String(p.amount ?? '0'),
      instrumentAdmin: String(p.instrumentAdmin ?? ''),
      instrumentId: String(p.instrumentId ?? ''),
      sourceTransferId: String(p.sourceTransferId ?? ''),
      depositedAt: String(p.depositedAt ?? ''),
    });
  }
  return out;
}
