/**
 * Canton Query Functions
 *
 * High-level query functions for exchange developers.
 * These wrap the low-level ACS queries with parsed, typed results.
 */

import type { CantonSdkConfig } from './config.js';
import { getTemplateIds } from './config.js';
import { getOperatorToken } from './tokens.js';
import { getActiveContracts } from './ledger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HoldingInfo {
  /** Contract ID (needed for deposit) */
  contractId: string;
  /** Owner party ID */
  owner: string;
  /** Token issuer party ID */
  issuer: string;
  /** Token amount */
  amount: number;
}

export interface DepositReceiptInfo {
  /** Contract ID */
  contractId: string;
  /** User party ID */
  user: string;
  /** Deposited amount */
  amount: number;
  /** Deposit reference */
  depositRef: string;
}

// ─── User Holdings (USDC on-chain balance) ───────────────────────────────────

/**
 * Get all USDC Holdings owned by a user on Canton.
 *
 * These are the user's on-chain token balances — what they can deposit
 * into the exchange. Each holding is a separate UTXO contract.
 *
 * @param userToken - User's Keycloak access token
 * @param userParty - User's Canton party ID
 * @returns Array of holdings with contract IDs and amounts
 *
 * @example
 * ```typescript
 * const holdings = await canton.getUserHoldings(userToken, userParty);
 * // [
 * //   { contractId: "00abc...", owner: "neeraj::122...", issuer: "circle::122...", amount: 100 },
 * //   { contractId: "00def...", owner: "neeraj::122...", issuer: "circle::122...", amount: 50 },
 * // ]
 * // Total on-chain: 150 USDC
 * ```
 */
export async function getUserHoldings(
  config: CantonSdkConfig,
  userToken: string,
  userParty: string,
): Promise<HoldingInfo[]> {
  const templates = getTemplateIds(config.packageId);

  const contracts = await getActiveContracts(
    config, userToken, userParty, templates.Holding,
  );

  return contracts
    .map((c) => {
      const p = c.payload as Record<string, unknown>;
      return {
        contractId: c.contractId,
        owner: String(p.owner ?? ''),
        issuer: String(p.issuer ?? ''),
        amount: parseFloat(String(p.amount ?? '0')),
      };
    })
    .filter((h) => h.owner === userParty && h.amount > 0);
}

// ─── Vault Deposit Receipts (on-chain deposit proof) ─────────────────────────

/**
 * Get all deposit receipts for a user in the vault.
 *
 * These represent the user's deposited tokens held by the vault pool.
 * Sum of receipt amounts = total deposited on-chain.
 * This is different from the exchange off-chain balance (which includes PnL).
 *
 * @param userParty - User's Canton party ID
 * @returns Array of deposit receipts with amounts
 *
 * @example
 * ```typescript
 * const receipts = await canton.getUserVaultHoldings(userParty);
 * // [
 * //   { contractId: "00abc...", user: "neeraj::122...", amount: 100, depositRef: "dep-..." },
 * //   { contractId: "00def...", user: "neeraj::122...", amount: 50, depositRef: "dep-..." },
 * // ]
 * // Total in vault: 150 USDC deposited
 * ```
 */
export async function getUserVaultHoldings(
  config: CantonSdkConfig,
  userParty: string,
): Promise<DepositReceiptInfo[]> {
  const templates = getTemplateIds(config.packageId);
  const opToken = await getOperatorToken(config);

  const contracts = await getActiveContracts(
    config, opToken, config.parties.operator, templates.DepositReceipt,
  );

  return contracts
    .filter((c) => (c.payload as Record<string, unknown>).user === userParty)
    .map((c) => {
      const p = c.payload as Record<string, unknown>;
      return {
        contractId: c.contractId,
        user: String(p.user ?? ''),
        amount: parseFloat(String(p.amount ?? '0')),
        depositRef: String(p.depositRef ?? ''),
      };
    })
    .filter((r) => r.amount > 0);
}
