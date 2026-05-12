/**
 * Canton backend routes — lambda-friendly.
 *
 * POST /deposit  — Canton deposit + call exchange /v1/deposit/defi
 * POST /withdraw — Canton withdraw + call exchange /v1/withdraw/defi
 *
 * All endpoints require Keycloak Bearer token.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from './auth.js';
import { canton, sdkConfig } from './sdk.js';
import { EXCHANGE_DEPOSIT_URL, EXCHANGE_WITHDRAW_URL, CIRCLE_KC_USERNAME, CIRCLE_KC_PASSWORD, PACKAGE_ID } from './config.js';
import { getTemplateIds } from './canton-sdk/config.js';
import { getActiveContracts, submitCommand, extractCreatedContractId } from './canton-sdk/ledger.js';

const router = Router();

/** Generate a unique tx reference */
function txRef(): string {
  return `canton-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Health ──────────────────────────────────────────────────────────────────

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Vault Status & Accept Proposal ─────────────────────────────────────────

/**
 * GET /vault/status
 * Returns vault account status: NOT_CREATED | PROPOSAL_PENDING | ACTIVE
 */
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

/**
 * POST /vault/accept-proposal
 * Accepts a pending VaultAccountProposal on Canton.
 */
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

// ─── Holdings (USDC balance on Canton) ──────────────────────────────────────

/**
 * GET /holdings
 *
 * Returns the user's USDC token holdings on Canton ledger.
 * Each holding is a separate UTXO contract. Frontend sums amounts
 * to display available USDC balance.
 */
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

// ─── Deposit Receipts (on-chain proof of deposits) ──────────────────────────

/**
 * GET /deposit-receipts
 *
 * Returns the user's vault deposit receipts — on-chain proof that tokens
 * were deposited into the exchange vault.
 */
router.get('/deposit-receipts', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;

  try {
    const receipts = await canton.getUserVaultHoldings(party);

    const totalDeposited = receipts.reduce((sum, r) => sum + r.amount, 0);

    res.json({
      receipts: receipts.map(r => ({
        contractId: r.contractId,
        amount: r.amount,
        // Use depositRef if available, fall back to contractId as unique txn identifier
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

// ─── Faucet: Request USDC Mint ──────────────────────────────────────────────

/**
 * POST /faucet
 * Body: { amount: number }
 *
 * Circle (token issuer) creates a MintProposal for the user.
 * User must then accept the proposal to receive USDC.
 */
router.post('/faucet', requireAuth, async (req: Request, res: Response) => {
  const { party } = (req as AuthenticatedRequest).user;

  try {
    const { amount } = req.body as { amount?: number };

    if (!amount || amount <= 0 || amount > 10000) {
      res.status(400).json({ error: 'Amount must be between 0 and 10,000 USDC' });
      return;
    }

    const templates = getTemplateIds(PACKAGE_ID);
    const circleToken = await canton.getCircleToken(CIRCLE_KC_USERNAME, CIRCLE_KC_PASSWORD);
    const circleCantonId = await canton.resolveCircleCantonId();

    const result = await submitCommand(
      sdkConfig,
      circleToken,
      circleCantonId,
      [sdkConfig.parties.tokenIssuer],
      [
        {
          CreateCommand: {
            templateId: templates.MintProposal,
            createArguments: {
              issuer: sdkConfig.parties.tokenIssuer,
              owner: party,
              amount: amount.toString(),
            },
          },
        },
      ],
    );

    const proposalCid = extractCreatedContractId(result, templates.MintProposal);

    console.log(`[faucet] MintProposal created for ${party.split('::')[0]}: ${amount} USDC (cid: ${proposalCid})`);

    res.json({
      ok: true,
      proposalContractId: proposalCid,
      amount,
      message: `Mint proposal for ${amount} USDC created. Accept it to receive tokens.`,
    });
  } catch (err) {
    console.error('Faucet error:', err);
    res.status(500).json({ error: 'Failed to create mint proposal', details: String(err) });
  }
});

// ─── Mint Proposals: List pending ──────────────────────────────────────────

/**
 * GET /mint-proposals
 *
 * Returns pending MintProposal contracts where the user is the owner.
 */
router.get('/mint-proposals', requireAuth, async (req: Request, res: Response) => {
  const { party, keycloakToken } = (req as AuthenticatedRequest).user;

  try {
    const templates = getTemplateIds(PACKAGE_ID);
    const contracts = await getActiveContracts(
      sdkConfig, keycloakToken, party, templates.MintProposal,
    );

    const proposals = contracts
      .map((c) => {
        const p = c.payload as Record<string, unknown>;
        return {
          contractId: c.contractId,
          issuer: String(p.issuer ?? ''),
          owner: String(p.owner ?? ''),
          amount: parseFloat(String(p.amount ?? '0')),
        };
      })
      .filter((p) => p.owner === party && p.amount > 0);

    res.json({ proposals });
  } catch (err) {
    console.error('Mint proposals query error:', err);
    res.status(500).json({ error: 'Failed to fetch mint proposals', details: String(err) });
  }
});

// ─── Accept Mint Proposal ──────────────────────────────────────────────────

/**
 * POST /mint-proposals/accept
 * Body: { contractId: string }
 *
 * User accepts a pending MintProposal → creates a Holding.
 */
router.post('/mint-proposals/accept', requireAuth, async (req: Request, res: Response) => {
  const { sub, party, keycloakToken } = (req as AuthenticatedRequest).user;

  try {
    const { contractId } = req.body as { contractId?: string };
    if (!contractId) {
      res.status(400).json({ error: 'contractId is required' });
      return;
    }

    const templates = getTemplateIds(PACKAGE_ID);

    const result = await submitCommand(
      sdkConfig,
      keycloakToken,
      sub,
      [party],
      [
        {
          ExerciseCommand: {
            templateId: templates.MintProposal,
            contractId,
            choice: 'AcceptMint',
            choiceArgument: {},
          },
        },
      ],
    );

    const holdingCid = extractCreatedContractId(result, templates.Holding);

    console.log(`[mint] User ${party.split('::')[0]} accepted MintProposal → Holding: ${holdingCid}`);

    res.json({
      ok: true,
      holdingContractId: holdingCid,
      message: 'Mint accepted. USDC has been added to your holdings.',
    });
  } catch (err) {
    console.error('Accept mint error:', err);
    res.status(500).json({ error: 'Failed to accept mint proposal', details: String(err) });
  }
});

// ─── Deposit ─────────────────────────────────────────────────────────────────

/**
 * POST /deposit
 * Body: { amount: number, coin?: string }
 *
 * Flow:
 * 1. Canton SDK deposit (Transfer_Initiate → ExecuteDeposit)
 * 2. Call exchange POST /v1/deposit/defi to credit balance
 */
router.post('/deposit', requireAuth, async (req: Request, res: Response) => {
  const { party, sub, keycloakToken } = (req as AuthenticatedRequest).user;

  try {
    const { amount, coin = 'USDT' } = req.body as { amount?: number; coin?: string };

    if (!amount || amount <= 0) {
      res.status(400).json({ error: 'Invalid amount' });
      return;
    }

    // Step 1: find a holding contract with enough balance to deposit from
    const holdings = await canton.getUserHoldings(keycloakToken, party);
    if (!holdings || holdings.length === 0) {
      res.status(400).json({ error: 'No token holdings found. Mint tokens first.' });
      return;
    }

    // Smart holding selection:
    //   1. Exact match — no splitting needed
    //   2. Smallest holding that covers the amount — least waste when splitting
    const sortedByAmount = [...holdings].sort((a, b) => a.amount - b.amount);
    const exactMatch = sortedByAmount.find(h => h.amount === amount);
    const holding = exactMatch
      ?? sortedByAmount.find(h => h.amount >= amount);  // smallest sufficient

    if (!holding) {
      const totalBalance = holdings.reduce((sum, h) => sum + h.amount, 0);
      if (totalBalance < amount) {
        res.status(400).json({
          error: `Insufficient USDC balance. You have ${totalBalance} USDC but tried to deposit ${amount} USDC.`,
        });
      } else {
        res.status(400).json({
          error: `No single holding has ${amount} USDC. Your holdings are split across ${holdings.length} contracts. Please deposit in smaller amounts matching your individual holdings.`,
          holdings: holdings.map(h => ({ contractId: h.contractId, amount: h.amount })),
        });
      }
      return;
    }

    console.log(`[deposit] Selected holding ${holding.contractId.slice(0, 10)}… (${holding.amount} USDC) for ${amount} USDC deposit`);
    const holdingCid = holding.contractId;

    // Step 2: Canton deposit
    let cantonResult;
    try {
      cantonResult = await canton.deposit({
        userToken: keycloakToken,
        userCantonId: sub,
        userParty: party,
        holdingCid,
        amount,
      });
    } catch (cantonErr) {
      console.error('Canton deposit failed:', cantonErr);
      res.status(500).json({ error: 'Deposit failed on Canton ledger. Please try again.' });
      return;
    }

    // Step 3: Call real exchange deposit API
    const ref = txRef();
    const exchangeRes = await fetch(EXCHANGE_DEPOSIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: party.split('::')[0],
        coin,
        amount,
        txnHash: ref,
        network: '0',
      }),
    });

    const exchangeData = await exchangeRes.json() as Record<string, unknown>;

    if (!exchangeRes.ok) {
      console.error('Exchange deposit API failed:', exchangeData);
      // Canton succeeded but exchange failed — log and return partial success
      res.status(207).json({
        success: true,
        cantonSuccess: true,
        exchangeSuccess: false,
        txRef: ref,
        cantonResult,
        exchangeError: exchangeData,
      });
      return;
    }

    res.json({
      success: true,
      txRef: ref,
      cantonResult,
      exchangeResult: exchangeData,
    });
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Deposit failed. Please try again.' });
  }
});

// ─── Withdraw ────────────────────────────────────────────────────────────────

/**
 * POST /withdraw
 * Body: { amount: number, coin?: string, nonce: string, approvalId: number }
 *
 * Flow:
 * 1. Canton SDK withdraw (ExecuteWithdrawal → user accepts TIs)
 * 2. Call exchange POST /v1/withdraw/defi with nonce + approvalId from frontend
 */
router.post('/withdraw', requireAuth, async (req: Request, res: Response) => {
  const { party, sub, keycloakToken } = (req as AuthenticatedRequest).user;

  try {
    const { amount, coin = 'USDT', nonce, approvalId } = req.body as {
      amount?: number;
      coin?: string;
      nonce?: string;
      approvalId?: number;
    };

    if (!amount || amount <= 0) {
      res.status(400).json({ error: 'Invalid amount' });
      return;
    }
    if (!nonce || approvalId === undefined) {
      res.status(400).json({ error: 'Missing nonce or approvalId from approval step' });
      return;
    }

    // Step 1: Canton withdraw
    let cantonResult;
    try {
      cantonResult = await canton.withdraw({
        userToken: keycloakToken,
        userCantonId: sub,
        userParty: party,
        amount,
      });
    } catch (cantonErr) {
      console.error('Canton withdraw failed:', cantonErr);
      res.status(500).json({ error: 'Withdrawal failed on Canton ledger. Please try again.' });
      return;
    }

    // Step 2: Call real exchange withdraw API
    const ref = txRef();
    const exchangeRes = await fetch(EXCHANGE_WITHDRAW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: party.split('::')[0],
        coin,
        amount,
        txnHash: ref,
        nonce,
        approvalId,
      }),
    });

    const exchangeData = await exchangeRes.json() as Record<string, unknown>;

    if (!exchangeRes.ok) {
      console.error('Exchange withdraw API failed:', exchangeData);
      res.status(207).json({
        success: true,
        cantonSuccess: true,
        exchangeSuccess: false,
        txRef: ref,
        cantonResult,
        exchangeError: exchangeData,
      });
      return;
    }

    res.json({
      success: true,
      txRef: ref,
      cantonResult,
      exchangeResult: exchangeData,
    });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ error: 'Withdrawal failed. Please try again.' });
  }
});

export default router;
