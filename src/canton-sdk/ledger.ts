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
 *
 * Optional `disclosedContracts` are off-ledger contracts (the scan API
 * returns these for CIP-56 factory exercises) that our participant needs
 * to see for this single submission. Each entry is the
 * `{ templateId, contractId, createdEventBlob, synchronizerId }` blob
 * returned by Splice scan.
 *
 * `commandId` pins idempotency to a request key (e.g. an approval id),
 * and `deduplicationDuration` is the window Canton honours that key for.
 * WITHOUT an explicit duration, the participant's default applies (often
 * 0 = no dedup), so a retry of the same commandId can produce a duplicate
 * on-chain effect — exactly how a re-run of the retry-withdraw script
 * could double-spend a withdrawal. Default here is 24 h, which comfortably
 * covers operator retries while staying inside typical participant max.
 */
export async function submitCommand(
  config: CantonSdkConfig,
  bearerToken: string,
  userId: string,
  actAs: string[],
  commands: LedgerCommand[],
  options: {
    disclosedContracts?: Array<Record<string, unknown>>;
    commandId?: string;
    readAs?: string[];
    /** Protobuf Duration string ("60s", "3600s", "86400s"…). */
    deduplicationDuration?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const commandId = options.commandId ?? `canton-sdk-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  const body: Record<string, unknown> = {
    userId,
    commands,
    actAs,
    readAs: options.readAs ?? [],
    commandId,
    // Canton 3.x JSON API wraps oneof variants as
    //   { VariantName: { value: <inner> } }
    // (same convention as the `identifierFilter` we use in ACS queries).
    deduplicationPeriod: {
      DeduplicationDuration: { value: options.deduplicationDuration ?? '86400s' },
    },
  };
  if (options.disclosedContracts && options.disclosedContracts.length > 0) {
    body.disclosedContracts = options.disclosedContracts;
  }

  const res = await fetch(`${config.cantonLedgerApi}/v2/commands/submit-and-wait-for-transaction-tree`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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

/**
 * Stream creates of a given interface (e.g. CIP-56 Holding) for `party`
 * in the offset range `(beginExclusive, endInclusive]`.
 *
 * Canton 3's `/v2/updates/flats` is a streaming/range endpoint — given a
 * bounded interval it returns the transactions that happened in that
 * window, each carrying its events. We pull out the CreatedEvent rows
 * that match the requested party + interface and shape them into the
 * same `ActiveContract` envelope the rest of the SDK already uses, so
 * callers don't have to switch on the source.
 *
 * Response parsing is defensive: the JSON API has been observed to
 * return either a JSON array of update wrappers OR newline-delimited
 * JSON in the wild, depending on the deployment's chunked-transfer
 * settings. Both are handled here.
 *
 * Caller is responsible for persisting `endInclusive` as the next
 * `beginExclusive` after a successful tick — this function is pure read.
 */
export async function getCreatedEventsByOffsetRange(
  config: CantonSdkConfig,
  token: string,
  args: {
    party: string;
    interfaceId: string;
    beginExclusive: number;
    endInclusive: number;
  },
): Promise<ActiveContract[]> {
  const body = {
    beginExclusive: args.beginExclusive,
    endInclusive: args.endInclusive,
    updateFormat: {
      includeTransactions: {
        eventFormat: {
          filtersByParty: {
            [args.party]: {
              cumulative: [
                {
                  identifierFilter: {
                    InterfaceFilter: {
                      value: {
                        interfaceId: args.interfaceId,
                        includeInterfaceView: true,
                        includeCreatedEventBlob: false,
                      },
                    },
                  },
                },
              ],
            },
          },
          verbose: false,
        },
        // Flat-style — we only need the events list, not the full tree.
        transactionShape: 'TRANSACTION_SHAPE_ACS_DELTA',
      },
    },
  };

  const res = await fetch(`${config.cantonLedgerApi}/v2/updates/flats`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`updates/flats failed (${res.status}): ${await res.text()}`);
  }

  const text = await res.text();
  return parseFlatUpdatesResponse(text);
}

/**
 * Parse the response from `/v2/updates/flats` into ActiveContract envelopes.
 *
 * Accepts three observed shapes:
 *   - JSON array:                     `[ { update: { Transaction: { ... } } }, ... ]`
 *   - NDJSON:                         one update wrapper per line
 *   - Single-object stream that ends: `{ ... }` (small ranges, no newline)
 */
function parseFlatUpdatesResponse(text: string): ActiveContract[] {
  if (!text.trim()) return [];

  // Try parsing as a single JSON value first (covers array + single-object cases).
  const wrappers: unknown[] = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) wrappers.push(...parsed);
    else wrappers.push(parsed);
  } catch {
    // Fall back to NDJSON.
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        wrappers.push(JSON.parse(s));
      } catch {
        // skip malformed line
      }
    }
  }

  const out: ActiveContract[] = [];
  for (const w of wrappers) {
    const obj = (w ?? {}) as Record<string, unknown>;
    // Possible shapes:
    //   { update: { Transaction: { value: { events: [...] } } } }
    //   { Transaction: { value: { events: [...] } } }
    //   { transaction: { events: [...] } }
    const tx =
      ((obj.update as { Transaction?: { value?: { events?: unknown[] } } } | undefined)?.Transaction?.value) ??
      ((obj.Transaction as { value?: { events?: unknown[] } } | undefined)?.value) ??
      (obj.transaction as { events?: unknown[] } | undefined);
    if (!tx) continue;

    const events = (tx.events ?? []) as unknown[];
    for (const ev of events) {
      // CreatedEvent envelope:
      //   { CreatedEvent: { value: { contractId, templateId, payload, interfaceViews? } } }
      //   { CreatedEvent: { contractId, templateId, ... } }   (rare flatter form)
      const evObj = (ev ?? {}) as Record<string, unknown>;
      const ce = (evObj.CreatedEvent as { value?: Record<string, unknown> } | Record<string, unknown> | undefined);
      if (!ce) continue;
      const inner = ((ce as { value?: Record<string, unknown> }).value ?? ce) as Record<string, unknown>;
      const contractId = inner.contractId as string | undefined;
      const templateId = inner.templateId as string | undefined;
      if (!contractId || !templateId) continue;
      const interfaceViews = inner.interfaceViews as
        | Array<{ viewValue?: Record<string, unknown> }>
        | undefined;
      const interfaceView = interfaceViews?.[0]?.viewValue;
      out.push({
        contractId,
        templateId,
        payload: (inner.createArguments ?? inner.createArgument ?? inner.payload ?? {}) as Record<
          string,
          unknown
        >,
        interfaceView,
      });
    }
  }
  return out;
}

/** Public for the watcher (it can persist this as the next beginExclusive). */
export async function getLedgerEnd(config: CantonSdkConfig, token: string): Promise<number> {
  return getLedgerEndOffset(config, token);
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
 * Compare two template ids tolerantly. We pass the `#package-name:Module:Template`
 * shorthand to Canton, but responses always carry the fully-resolved
 * `<package-id>:Module:Template` form. Strict `===` between those would
 * always fail; match on the `Module:Template` suffix instead — the part
 * that uniquely identifies the template once both sides have been resolved.
 *
 * Caveat: if two different packages share the same Module:Template name
 * (rare), this becomes permissive. The tradeoff is worth it for our use.
 */
export function templateIdsMatch(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const actualSuffix = actual.split(':').slice(1).join(':');
  const expectedSuffix = expected.split(':').slice(1).join(':');
  return actualSuffix.length > 0 && actualSuffix === expectedSuffix;
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
      const tid = val.templateId as string | undefined;
      if (tid && templateIdsMatch(tid, templateId)) {
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
