/**
 * GET /deposits — caller's deposit history.
 *
 * Returns two arrays:
 *   • deposits[]      — credited (on-chain DepositRecord created)
 *   • heldDeposits[]  — transfers that landed at vaultPool but weren't
 *                       credited (KYC not done, unknown user, pre-existing
 *                       cutoff, etc.). Useful for end-user troubleshooting.
 *
 * Open-auth (AUTH_MODE=open) like /me — caller-supplied x-party-id is the
 * filter; we only return rows for that party.
 *
 * Each deposit carries its reconciliation state with the exchange backend
 * (credited / pending / failed) so the UI can show a clear progress chip
 * per row.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../auth.js';
import { getPool } from '../db/pool.js';
import {
  CANTON_LEDGER_API,
  INSTRUMENT_ADMIN_PARTY_ID,
  INSTRUMENT_ID,
  INSTRUMENT_SYMBOL,
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
import type { CantonSdkConfig } from '../canton-sdk/config.js';
import { getOperatorToken } from '../canton-sdk/tokens.js';
import { getUserDepositRecords } from '../canton-sdk/depositRecords.js';

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

const router = Router();

interface DepositRow {
  id: string;
  amount: string;
  transfer_update_id: string;
  source_holding_cid: string | null;
  deposit_receipt_cid: string | null;
  exchange_credited_at: Date | null;
  exchange_attempts: number;
  exchange_last_error: string | null;
  exchange_last_attempt_at: Date | null;
  consumed_at: Date | null;
  consumed_by_withdrawal: string | null;
  created_at: Date;
}

interface HeldDepositRow {
  id: string;
  amount: string;
  transfer_update_id: string;
  source_holding_cid: string | null;
  reason: string;
  raw_meta: Record<string, unknown> | null;
  observed_at: Date;
  resolved_at: Date | null;
  resolution_note: string | null;
}

router.get('/deposits', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  const pool = getPool();

  const limit = Math.min(Number(req.query.limit ?? 100), 500);

  // Holdings come from the LEDGER (source of truth). Deposits + held tabs
  // come from DB (audit log — necessary to show history including consumed
  // ones, since archived DepositRecords are gone from the ACS).
  const opToken = await getOperatorToken(sdkConfig);
  const [deposits, held, onChainRecords] = await Promise.all([
    pool.query<DepositRow>(
      `SELECT id, amount::text AS amount, transfer_update_id, source_holding_cid,
              deposit_receipt_cid, exchange_credited_at, exchange_attempts,
              exchange_last_error, exchange_last_attempt_at,
              consumed_at, consumed_by_withdrawal, created_at
         FROM deposits
        WHERE user_party_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [party, limit],
    ),
    pool.query<HeldDepositRow>(
      `SELECT id, amount::text AS amount, transfer_update_id, source_holding_cid,
              reason, raw_meta, observed_at, resolved_at, resolution_note
         FROM held_deposits
        WHERE user_party_id = $1
        ORDER BY observed_at DESC
        LIMIT $2`,
      [party, limit],
    ),
    getUserDepositRecords(sdkConfig, opToken, party, {
      instrumentAdmin: INSTRUMENT_ADMIN_PARTY_ID,
      instrumentId: INSTRUMENT_ID,
    }),
  ]);

  // Sum on-chain DepositRecord amounts (fixed-point sum to avoid float
  // drift on long decimals).
  let totalScaled = 0n;
  for (const r of onChainRecords) totalScaled += toScaled(r.amount);
  const unconsumedTotal = fromScaled(totalScaled);

  // User-visible deposits = full history (credited + consumed), MINUS the
  // split-change rows. Those `split-*` transfer_update_ids are internal
  // bookkeeping created when a withdrawal partially consumes a deposit;
  // the user already sees that event in their withdraw history, so
  // showing it again here as a "deposit" would be confusing.
  const visibleDeposits = deposits.rows.filter(
    (d) => !d.transfer_update_id.startsWith('split-'),
  );

  res.json({
    instrumentSymbol: INSTRUMENT_SYMBOL,
    // SOURCE: Canton ledger ACS query, not Postgres. This is what the user
    // can actually withdraw right now.
    holdings: {
      unconsumedTotal,
      unconsumedCount: onChainRecords.length,
      records: onChainRecords.map((r) => ({
        contractId: r.cid,
        amount: r.amount,
        depositedAt: r.depositedAt,
        sourceTransferId: r.sourceTransferId,
      })),
    },
    deposits: visibleDeposits.map((d) => ({
      id: String(d.id),
      amount: d.amount,
      transferUpdateId: d.transfer_update_id,
      sourceHoldingCid: d.source_holding_cid,
      depositReceiptCid: d.deposit_receipt_cid,
      exchangeCreditedAt: d.exchange_credited_at?.toISOString() ?? null,
      exchangeAttempts: d.exchange_attempts,
      exchangeLastError: d.exchange_last_error,
      exchangeLastAttemptAt: d.exchange_last_attempt_at?.toISOString() ?? null,
      consumedAt: d.consumed_at?.toISOString() ?? null,
      consumedByWithdrawal: d.consumed_by_withdrawal,
      createdAt: d.created_at.toISOString(),
      // Derived state for the UI: credited > pending > failed.
      status: deriveStatus(d),
    })),
    heldDeposits: held.rows.map((h) => ({
      id: String(h.id),
      amount: h.amount,
      transferUpdateId: h.transfer_update_id,
      sourceHoldingCid: h.source_holding_cid,
      reason: h.reason,
      observedAt: h.observed_at.toISOString(),
      resolvedAt: h.resolved_at?.toISOString() ?? null,
      resolutionNote: h.resolution_note,
    })),
  });
});

function deriveStatus(
  d: DepositRow,
): 'credited' | 'pending_exchange' | 'failed_exchange' {
  if (d.exchange_credited_at) return 'credited';
  if (d.exchange_last_error) return 'failed_exchange';
  return 'pending_exchange';
}

// ─── Fixed-point sum helpers ──────────────────────────────────────────────
// 18-decimal scaled BigInt arithmetic — matches the convention used by
// the watcher / withdraw / amuletTransfer paths.

const SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

function toScaled(decimal: string): bigint {
  const [intPart, fracPart = ''] = decimal.split('.');
  const fracPadded = (fracPart + '0'.repeat(SCALE)).slice(0, SCALE);
  return BigInt(intPart || '0') * SCALE_FACTOR + BigInt(fracPadded || '0');
}

function fromScaled(scaled: bigint): string {
  const intPart = scaled / SCALE_FACTOR;
  const fracPart = (scaled % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : `${intPart}`;
}

export default router;
