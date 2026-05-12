/**
 * Canton Ledger API Client
 *
 * Low-level functions for interacting with the Canton participant node.
 * - Query active contracts (ACS)
 * - Submit commands (exercise choices, create contracts)
 * - User management (resolve user, grant rights)
 */

import crypto from 'node:crypto';
import type { CantonSdkConfig } from './config.js';

// ─── Active Contract Set (ACS) Queries ───────────────────────────────────────

/**
 * Get the current ledger end offset.
 */
async function getLedgerEndOffset(config: CantonSdkConfig, token: string): Promise<number> {
  const res = await fetch(`${config.cantonLedgerApi}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Ledger end offset failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { offset?: number };
  return data.offset ?? 0;
}

/**
 * Query active contracts for a given party and template.
 */
export async function getActiveContracts(
  config: CantonSdkConfig,
  token: string,
  partyId: string,
  templateId: string,
): Promise<Array<{ contractId: string; payload: Record<string, unknown> }>> {
  const activeAtOffset = await getLedgerEndOffset(config, token);

  const res = await fetch(`${config.cantonLedgerApi}/v2/state/active-contracts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [partyId]: {
            inclusive: { templateFilters: [{ templateId }] },
          },
        },
      },
      verbose: true,
      activeAtOffset,
    }),
  });

  if (!res.ok) throw new Error(`ACS query failed (${res.status}): ${await res.text()}`);

  const data = await res.json() as any;
  const entries: any[] = Array.isArray(data) ? data : (data.entries || []);

  return entries
    .filter((e: any) => {
      const ce = e.contractEntry || e;
      const ac = ce.JsActiveContract || ce;
      const evt = ac.createdEvent || ac;
      return evt.templateId === templateId;
    })
    .map((e: any) => {
      const ce = e.contractEntry || e;
      const ac = ce.JsActiveContract || ce;
      const evt = ac.createdEvent || ac;
      return {
        contractId: evt.contractId,
        payload: evt.createArguments || evt.createArgument || evt.payload || {},
      };
    });
}

// ─── Command Submission ──────────────────────────────────────────────────────

export interface ExerciseCommand {
  ExerciseCommand: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: Record<string, unknown>;
  };
}

export interface CreateCommand {
  CreateCommand: {
    templateId: string;
    createArguments: Record<string, unknown>;
  };
}

export type LedgerCommand = ExerciseCommand | CreateCommand;

/**
 * Submit a command to Canton and wait for the transaction result.
 */
export async function submitCommand(
  config: CantonSdkConfig,
  bearerToken: string,
  userId: string,
  actAs: string[],
  commands: LedgerCommand[],
): Promise<Record<string, unknown>> {
  const commandId = `canton-sdk-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  const res = await fetch(`${config.cantonLedgerApi}/v2/commands/submit-and-wait-for-transaction-tree`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      userId,
      commands,
      actAs,
      readAs: [],
      commandId,
    }),
  });

  if (!res.ok) throw new Error(`Canton command failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

/**
 * Extract a created contract ID from a submit-and-wait result.
 */
export function extractCreatedContractId(
  result: Record<string, unknown>,
  templateId: string,
): string | null {
  try {
    const tree = (result.transactionTree || result) as Record<string, unknown>;
    const eventsById = tree.eventsById as Record<string, Record<string, unknown>> | undefined;
    if (!eventsById) return null;

    for (const event of Object.values(eventsById)) {
      const created = event.CreatedTreeEvent as Record<string, unknown> | undefined;
      if (!created) continue;
      const val = (created.value || created) as Record<string, unknown>;
      if (val.templateId === templateId) {
        return val.contractId as string;
      }
    }
  } catch {
    // Parsing failed
  }
  return null;
}

// ─── User Management ─────────────────────────────────────────────────────────

/**
 * Resolve a Canton user by Keycloak sub (UUID).
 * Returns the Canton user ID and primary party.
 */
export async function getCantonUser(
  config: CantonSdkConfig,
  token: string,
  keycloakUserId: string,
): Promise<{ id: string; primaryParty: string }> {
  const res = await fetch(`${config.cantonLedgerApi}/v2/users/${keycloakUserId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Canton user lookup failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { user: { id: string; primaryParty: string } };
  return data.user;
}

/**
 * Grant a Canton right (CanActAs/CanReadAs) to a user.
 */
export async function grantRight(
  config: CantonSdkConfig,
  adminToken: string,
  userId: string,
  kind: 'CanActAs' | 'CanReadAs',
  party: string,
): Promise<void> {
  const res = await fetch(`${config.cantonLedgerApi}/v2/users/${userId}/rights`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ userId, identityProviderId: '', rights: [{ kind: { [kind]: { value: { party } } } }] }),
  });
  if (!res.ok) {
    const text = await res.text();
    // Non-fatal — right may already be granted
    console.warn(`Grant ${kind}(${party.split('::')[0]}) warning: ${text}`);
  }
}
