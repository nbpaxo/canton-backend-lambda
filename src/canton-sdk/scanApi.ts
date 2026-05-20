/**
 * Splice Scan client — public, unauthenticated.
 *
 * Ported (trimmed) from exchange-v2/backend/src/ledger/scanApi.ts. We only
 * need `getTransferFactory` for the withdraw flow; if other choice contexts
 * are ever needed they go here.
 *
 * The scan service is run by Super Validators and exposes the network's
 * shared state — DSO party id, AmuletRules, transfer factory choice
 * contexts and disclosures. Returning a `factoryCid`, a `choiceContext`,
 * and a list of `disclosedContracts` is the recipe for invoking a CIP-56
 * factory on our participant (which doesn't natively see the factory).
 */
import { SCAN_API_URL } from '../config.js';

export interface EnrichedChoice {
  /** Contract id of the factory (or instruction) to exercise on. */
  factoryCid: string;
  /** Pass through verbatim into the choice argument as `extraArgs.context`. */
  choiceContext: { values: Record<string, unknown> };
  /**
   * Attach to `submit-and-wait`'s `disclosedContracts` field. Each entry
   * carries `{ templateId, contractId, createdEventBlob, synchronizerId }`
   * — the minimum Canton needs to grant a one-off read for this choice.
   */
  disclosedContracts: Array<Record<string, unknown>>;
}

/**
 * POST /registry/transfer-instruction/v1/transfer-factory
 * Body: { choiceArguments: <your transfer args> }
 * Returns enrichment for invoking TransferFactory_Transfer.
 */
export async function getTransferFactory(
  choiceArguments: unknown,
): Promise<EnrichedChoice> {
  const url = `${SCAN_API_URL}/registry/transfer-instruction/v1/transfer-factory`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ choiceArguments }),
  });
  if (!res.ok) {
    throw new Error(`scan transfer-factory: ${res.status} ${await res.text()}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  return parseEnrichedChoice(raw, 'transfer-factory');
}

function parseEnrichedChoice(raw: unknown, label: string): EnrichedChoice {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`scan ${label}: response is not an object`);
  }
  const r = raw as Record<string, unknown>;

  const factoryCid =
    (r.factory_id as string | undefined)
    ?? (r.factoryId as string | undefined)
    ?? (r.factory as string | undefined);
  if (!factoryCid) {
    throw new Error(
      `scan ${label}: response missing factory contract id (keys: ${Object.keys(raw).join(',')})`,
    );
  }

  // Splice may nest under `choiceContext` or put fields at root — handle both.
  const ctxRoot = (r.choiceContext as Record<string, unknown> | undefined)
    ?? (r.choice_context as Record<string, unknown> | undefined)
    ?? r;
  const ctxData =
    (ctxRoot.choice_context_data as Record<string, unknown> | undefined)
    ?? (ctxRoot.choiceContextData as Record<string, unknown> | undefined)
    ?? {};
  const choiceContext = {
    values: (ctxData.values as Record<string, unknown> | undefined)
      ?? (ctxData as Record<string, unknown>),
  };
  const disclosedRaw =
    (ctxRoot.disclosed_contracts as Array<Record<string, unknown>> | undefined)
    ?? (ctxRoot.disclosedContracts as Array<Record<string, unknown>> | undefined)
    ?? [];

  // Strip Splice debug fields — Canton tolerates extras in some versions
  // and rejects them in others; safest to send only the core four.
  const disclosedContracts = disclosedRaw.map((d) => {
    const out: Record<string, unknown> = {};
    for (const k of [
      'templateId', 'template_id',
      'contractId', 'contract_id',
      'createdEventBlob', 'created_event_blob',
      'synchronizerId', 'synchronizer_id',
    ]) {
      if (d[k] !== undefined) out[k] = d[k];
    }
    return out;
  });

  return { factoryCid, choiceContext, disclosedContracts };
}
