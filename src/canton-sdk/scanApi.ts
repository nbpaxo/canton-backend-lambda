/**
 * CIP-56 transfer-factory client — public, unauthenticated.
 *
 * For Amulet/CC (instrument admin = DSO) the factory lives on the Splice
 * scan; for every other instrument (USDCx etc.) it lives on DA's per-admin
 * Token Standard registry under the Utility Backend. We always hit the
 * per-admin registry — its URL embeds the admin party id, so it works for
 * any instrument including Amulet (DSO is just another admin).
 *
 * The exchange-v2 memory handoff
 * (memory/exchange_v2_usdcx_testnet_working.md) traces why the Splice
 * scan path always returned the DSO/Amulet factory — that's what caused
 * `DAML_FAILURE: Expected admin '<USDCx-admin>' matches actual admin
 * 'DSO::...'` when we submitted a USDCx TransferFactory_Transfer.
 */
import { UTILITY_BACKEND_URL, INSTRUMENT_ADMIN_PARTY_ID, SCAN_API_URL } from '../config.js';

/**
 * CIP-56 transfer-factory URL for Amulet/CC — served by the Splice scan
 * (NOT DA's per-admin utility registry, which only knows USDCx-like
 * instruments). Path is `/registry/...`, per the exchange-v2 handoff.
 */
export const SCAN_TRANSFER_FACTORY_URL =
  `${SCAN_API_URL}/registry/transfer-instruction/v1/transfer-factory`;

/**
 * Per-instrument-admin CIP-56 registry base URL.
 *
 *   ${UTILITY_BACKEND_URL}/api/token-standard/v0/registrars/<admin-party-id>
 *
 * The transfer-factory + accept/reject/withdraw choice-context endpoints
 * all hang under this base. NOT under the Splice scan, which only knows
 * Amulet/CC.
 */
function instrumentRegistryUrl(path: string): string {
  return `${UTILITY_BACKEND_URL}/api/token-standard/v0/registrars/${INSTRUMENT_ADMIN_PARTY_ID}${path}`;
}

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
 * POST {registry}/registry/transfer-instruction/v1/transfer-factory
 * Body: { choiceArguments, excludeDebugFields: true }
 *
 * Returns enrichment for invoking TransferFactory_Transfer. Registry
 * already discloses the receiver's TransferPreapproval (when present) in
 * `choiceContext.disclosedContracts` for auto-complete; callers should
 * dedupe disclosures by contractId before submit (Canton 3.4 rejects
 * duplicates).
 */
export async function getTransferFactory(
  choiceArguments: unknown,
  registryUrl?: string,
): Promise<EnrichedChoice> {
  const url = registryUrl ?? instrumentRegistryUrl('/registry/transfer-instruction/v1/transfer-factory');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ choiceArguments, excludeDebugFields: true }),
  });
  if (!res.ok) {
    throw new Error(`registry transfer-factory → ${res.status}: ${(await res.text()).slice(0, 500)}`);
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
  const stripped = disclosedRaw.map((d) => {
    const out: Record<string, unknown> = {};
    for (const k of [
      'templateId', 'template_id',
      'contractId', 'contract_id',
      'createdEventBlob', 'created_event_blob',
      'synchronizerId', 'synchronizer_id',
    ]) {
      // `!= null` drops BOTH null and undefined — Canton's submit decoder
      // rejects `synchronizerId: null` (it must be a string or absent).
      if (d[k] != null) out[k] = d[k];
    }
    return out;
  });

  // Dedupe by contract id. Canton 3.4 rejects submissions with duplicate
  // cids in disclosedContracts (registry response + any caller-injected
  // preapproval can produce the same cid twice).
  const seen = new Set<string>();
  const disclosedContracts: Array<Record<string, unknown>> = [];
  for (const d of stripped) {
    const cid = (d.contractId ?? d.contract_id) as string | undefined;
    if (!cid) { disclosedContracts.push(d); continue; }
    if (seen.has(cid)) continue;
    seen.add(cid);
    disclosedContracts.push(d);
  }

  return { factoryCid, choiceContext, disclosedContracts };
}
