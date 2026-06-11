/**
 * KYC provider registry + active-provider selector.
 *
 * Exactly one provider is "active" (the `KYC_PROVIDER` env var) and is used by
 * POST /kyc/start. Both providers stay registered so their per-provider webhook
 * endpoints can remain configured at once.
 */
import { KYC_PROVIDER } from '../config.js';
import { personaProvider } from './persona.js';
import { sumsubProvider } from './sumsub.js';
import type { KycProvider } from './types.js';

const PROVIDERS: Record<string, KycProvider> = {
  persona: personaProvider,
  sumsub: sumsubProvider,
};

/** Look up a provider by name (for the per-provider webhook routes). */
export function getProvider(name: string): KycProvider | undefined {
  return PROVIDERS[name];
}

/** The provider selected by KYC_PROVIDER — used by /kyc/start. */
export function getActiveProvider(): KycProvider {
  const p = PROVIDERS[KYC_PROVIDER];
  if (!p) {
    throw new Error(
      `Unknown KYC_PROVIDER='${KYC_PROVIDER}'. Expected one of: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return p;
}

export { personaProvider, sumsubProvider };
export * from './types.js';
