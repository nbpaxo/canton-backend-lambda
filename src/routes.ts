/**
 * User-facing canton backend routes (devnet branch).
 *
 *   GET  /health
 *   GET  /holdings           — caller's on-chain Amulet/CC holdings
 *   GET  /deposit-receipts   — caller's DepositRecord contracts (sum = vault balance)
 *
 * No /vault/* — the new contract has no VaultAccount/VaultAccountProposal.
 * No /faucet, /mint-proposals/*, /deposit, /withdraw — operator-only or
 * obsolete with the watcher-driven deposit flow.
 *
 * All endpoints go through `requireAuth`. In open auth mode (DEV) the
 * caller supplies `x-party-id` with no cryptographic verification.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from './auth.js';
import { canton } from './sdk.js';
import { INSTRUMENT_ADMIN_PARTY_ID, INSTRUMENT_ID } from './config.js';

const router = Router();

// ─── Health ──────────────────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Holdings (on-chain Amulet/CC balance) ──────────────────────────────────
router.get('/holdings', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  try {
    const holdings = await canton.getUserHoldings(party, {
      instrumentAdmin: INSTRUMENT_ADMIN_PARTY_ID,
      instrumentId: INSTRUMENT_ID,
    });
    const totalBalance = holdings.reduce((s, h) => s + h.amount, 0);
    res.json({
      holdings: holdings.map(h => ({
        contractId: h.contractId,
        amount: h.amount,
        owner: h.owner,
        instrumentAdmin: h.instrumentAdmin,
        instrumentId: h.instrumentId,
        locked: h.locked,
      })),
      totalBalance,
    });
  } catch (err) {
    console.error('Holdings query error:', err);
    res.status(500).json({ error: 'Failed to fetch holdings', details: String(err) });
  }
});

// ─── DepositRecords ─────────────────────────────────────────────────────────
// On-chain proof of deposits credited by the watcher. Sum = user's vault
// balance. (The frontend may want to show CC as USDC — that's a display
// concern; this endpoint returns raw amounts in the instrument's units.)
router.get('/deposit-receipts', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  try {
    const records = await canton.getUserDepositRecords(party);
    const totalDeposited = records.reduce((s, r) => s + r.amount, 0);
    res.json({
      receipts: records.map(r => ({
        contractId: r.contractId,
        amount: r.amount,
        user: r.user,
        sourceTransferId: r.sourceTransferId,
        depositedAt: r.depositedAt,
      })),
      totalDeposited,
    });
  } catch (err) {
    console.error('DepositRecords query error:', err);
    res.status(500).json({ error: 'Failed to fetch deposit records', details: String(err) });
  }
});

export default router;
