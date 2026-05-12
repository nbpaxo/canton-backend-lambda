/**
 * User-facing canton backend routes (devnet branch).
 *
 *   GET  /health
 *   GET  /vault/status              — user's vault account state
 *   POST /vault/accept-proposal     — accept a VaultAccountProposal
 *   GET  /holdings                  — user's on-chain token balance
 *   GET  /deposit-receipts          — on-chain proof of deposits (mirrors DB)
 *
 * Operator-only endpoints (/faucet, /mint-proposals/*, /withdraw,
 * /admin/invite-codes) lived here on the master branch — they are gone now.
 * The new contract is operator-only-signed, the watcher creates deposit
 * receipts after users transfer to the vault directly. Withdraw is deferred
 * to a later phase.
 *
 * All endpoints go through `requireAuth`. In open auth mode the caller
 * supplies `x-party-id` (DEV ONLY, no cryptographic verification).
 */

import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from './auth.js';
import { canton } from './sdk.js';

const router = Router();

// ─── Health ──────────────────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Vault Status & Accept Proposal ─────────────────────────────────────────
router.get('/vault/status', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;
  try {
    const status = await canton.getVaultAccountStatus(party);
    res.json(status);
  } catch (err) {
    console.error('Vault status error:', err);
    res.status(500).json({ error: 'Failed to check vault status' });
  }
});

router.post('/vault/accept-proposal', requireAuth, async (req: Request, res: Response) => {
  const { sub, party, keycloakToken } = (req as AuthenticatedRequest).user;
  try {
    const status = await canton.getVaultAccountStatus(party);

    if (status.status === 'ACTIVE') {
      res.json({ ok: true, message: 'Vault account is already active.' });
      return;
    }

    if (status.status === 'NOT_CREATED' || !status.proposalContractId) {
      res.status(400).json({ error: 'No pending vault proposal found.' });
      return;
    }

    const result = await canton.acceptVaultProposal(
      keycloakToken, sub, party, status.proposalContractId,
    );

    res.json(result);
  } catch (err) {
    console.error('Accept proposal error:', err);
    res.status(500).json({ error: 'Failed to accept vault proposal' });
  }
});

// ─── Holdings (on-chain token balance) ──────────────────────────────────────
router.get('/holdings', requireAuth, async (req: Request, res: Response) => {
  const { party, keycloakToken } = (req as AuthenticatedRequest).user;

  try {
    const holdings = await canton.getUserHoldings(keycloakToken, party);
    const totalBalance = holdings.reduce((sum, h) => sum + h.amount, 0);

    res.json({
      holdings: holdings.map(h => ({
        contractId: h.contractId,
        amount: h.amount,
        owner: h.owner,
        issuer: h.issuer,
      })),
      totalBalance,
    });
  } catch (err) {
    console.error('Holdings query error:', err);
    res.status(500).json({ error: 'Failed to fetch holdings', details: String(err) });
  }
});

// ─── Deposit Receipts ───────────────────────────────────────────────────────
router.get('/deposit-receipts', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;

  try {
    const receipts = await canton.getUserVaultHoldings(party);
    const totalDeposited = receipts.reduce((sum, r) => sum + r.amount, 0);

    res.json({
      receipts: receipts.map(r => ({
        contractId: r.contractId,
        amount: r.amount,
        txnHash: r.depositRef || r.contractId,
        depositRef: r.depositRef,
        user: r.user,
      })),
      totalDeposited,
    });
  } catch (err) {
    console.error('Deposit receipts query error:', err);
    res.status(500).json({ error: 'Failed to fetch deposit receipts', details: String(err) });
  }
});

export default router;
