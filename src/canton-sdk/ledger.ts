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

export interface ActiveContract {
  contractId: string;
  templateId: string;
  payload: Record<string, unknown>;
  /** Interface view payload when queried by interfaceId. */
  interfaceView?: Record<string, unknown>;
}

/**
 * Query active contracts for a party, by template OR by interface (CIP-56).
 *
 * Uses Canton 3.4's `cumulative.identifierFilter` shape. Pass either:
 *   { templateId:  "#exchange-v2-core:Vault:DepositRecord" }
 *   { interfaceId: "#splice-api-token-holding-v1:...HoldingV1:Holding" }
 *
 * For interface queries the response carries `interfaceViews[*].viewValue`
 * — we surface that as `interfaceView` so callers can read e.g.
 * `view.amount`, `view.owner`, `view.instrumentId`.
 */
export async function getActiveContracts(
  config: CantonSdkConfig,
  token: string,
  partyId: string,
  filter: { templateId: string } | { interfaceId: string },
): Promise<ActiveContract[]> {
  const activeAtOffset = await getLedgerEndOffset(config, token);

  const identifierFilter =
    'templateId' in filter
      ? { TemplateFilter: { value: { templateId: filter.templateId, includeCreatedEventBlob: false } } }
      : { InterfaceFilter: { value: { interfaceId: filter.interfaceId, includeInterfaceView: true, includeCreatedEventBlob: false } } };

  const res = await fetch(`${config.cantonLedgerApi}/v2/state/active-contracts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [partyId]: { cumulative: [{ identifierFilter }] },
        },
      },
      verbose: false,
      activeAtOffset,
    }),
  });

  if (!res.ok) throw new Error(`ACS query failed (${res.status}): ${await res.text()}`);

  const data = await res.json() as any;
  const entries: any[] = Array.isArray(data) ? data : (data.entries || data.activeContracts || []);

  return entries
    .map((e: any): ActiveContract | null => {
      const ce = e.contractEntry ?? e;
      const ac = ce.JsActiveContract ?? ce;
      const evt = ac.createdEvent ?? ac;
      const contractId = evt.contractId;
      if (!contractId) return null;
      const interfaceViews = evt.interfaceViews as Array<{ viewValue?: Record<string, unknown> }> | undefined;
      const interfaceView = interfaceViews?.[0]?.viewValue;
      return {
        contractId,
        templateId: evt.templateId ?? '',
        payload: (evt.createArguments ?? evt.createArgument ?? evt.payload ?? {}) as Record<string, unknown>,
        interfaceView,
      };
    })
    .filter((c): c is ActiveContract => c !== null);
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

// ─── Tx-tree lookups (used by the deposit watcher) ───────────────────────

/**
 * Look up the create event of a single contract. Used by the watcher to
 * find the `offset` of the transaction that produced an Amulet Holding,
 * which we then resolve to the originating TransferFactory_Transfer.
 */
export async function getEventsByContractId(
  config: CantonSdkConfig,
  token: string,
  args: { contractId: string; requestingParties: string[] },
): Promise<{ created?: { offset?: number; createdEvent?: { offset?: number; [k: string]: unknown }; [k: string]: unknown } }> {
  const eventFormat = buildWildcardEventFormat(args.requestingParties);
  const res = await fetch(`${config.cantonLedgerApi}/v2/events/events-by-contract-id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contractId: args.contractId, eventFormat }),
  });
  if (!res.ok) throw new Error(`events-by-contract-id failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ created?: { offset?: number; createdEvent?: { offset?: number; [k: string]: unknown }; [k: string]: unknown } }>;
}

/** Fetch the full transaction tree for an offset (LEDGER_EFFECTS shape). */
export async function getTransactionTreeByOffset(
  config: CantonSdkConfig,
  token: string,
  args: { offset: number; requestingParties: string[] },
): Promise<Record<string, unknown>> {
  const eventFormat = buildWildcardEventFormat(args.requestingParties);
  const res = await fetch(`${config.cantonLedgerApi}/v2/updates/update-by-offset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset: args.offset,
      updateFormat: {
        includeTransactions: { eventFormat, transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS' },
      },
    }),
  });
  if (!res.ok) throw new Error(`update-by-offset failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

function buildWildcardEventFormat(parties: string[]): Record<string, unknown> {
  const filtersByParty: Record<string, unknown> = {};
  for (const p of parties) {
    filtersByParty[p] = {
      cumulative: [
        { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
      ],
    };
  }
  return { filtersByParty, verbose: false };
}

/** Walk a tx tree and pull every exercise event's choice argument. */
export interface ExerciseEvent {
  templateId?: string;
  interfaceId?: string;
  contractId?: string;
  choice?: string;
  choiceArgument?: Record<string, unknown>;
  actingParties?: string[];
}
export function collectExerciseEvents(tree: Record<string, unknown>): ExerciseEvent[] {
  const out: ExerciseEvent[] = [];

  // Shape A: { transactionTree: { eventsById: { ... ExercisedTreeEvent } } }
  const eventsById =
    (tree.transactionTree as { eventsById?: Record<string, Record<string, unknown>> } | undefined)?.eventsById;
  if (eventsById) {
    for (const e of Object.values(eventsById)) {
      const ex = (e.ExercisedTreeEvent ?? e.ExercisedEvent) as { value?: ExerciseEvent } | ExerciseEvent | undefined;
      if (!ex) continue;
      out.push(((ex as { value?: ExerciseEvent }).value ?? ex) as ExerciseEvent);
    }
  }

  // Shape B: { update: { Transaction: { value: { events: [{ ExercisedEvent: ... }] } } } }
  const txEvents =
    ((tree.update as { Transaction?: { value?: { events?: unknown[] } } } | undefined)?.Transaction?.value?.events
      ?? (tree.Transaction as { value?: { events?: unknown[] } } | undefined)?.value?.events) as
      | Array<{ ExercisedEvent?: { value?: ExerciseEvent } | ExerciseEvent }>
      | undefined;
  if (Array.isArray(txEvents)) {
    for (const e of txEvents) {
      const ex = e.ExercisedEvent;
      if (!ex) continue;
      out.push(((ex as { value?: ExerciseEvent }).value ?? ex) as ExerciseEvent);
    }
  }
  return out;
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
