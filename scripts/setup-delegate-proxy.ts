/**
 * Step 3b: get the DelegateProxy in place on the validator.
 *
 * Three phases, each independently gated. Default is a DRY RUN — nothing
 * mutates without `--yes`.
 *
 *   --upload   POST dars/splice-util-featured-app-proxies-1.2.4.dar to
 *              /v2/packages. Additive and idempotent: re-uploading an
 *              already-vetted package is a no-op. The package is Splice-
 *              published and already ships in your node's bundle; it just
 *              isn't vetted by default.
 *
 *   --create   Create ONE `DelegateProxy { provider, delegate }`:
 *                provider = PARTIES.nodeOperator  (the featured party)
 *                delegate = PARTIES.operator      (this backend)
 *              The template's signatory is `provider`, so this single create
 *              needs `CanActAs(provider)`. Grant it with
 *              `grant-node-operator-rights.ts --act --yes`, run this, then
 *              REVOKE CanActAs. Steady state needs only CanReadAs, because
 *              every DelegateProxy choice is controlled by the delegate.
 *
 *   (no flag)  Report current state only.
 *
 * Idempotent: an existing proxy for the same (provider, delegate) pair is
 * detected and the create is skipped. Creating a second one is harmless but
 * pointless.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/setup-delegate-proxy.ts
 *   npx tsx --env-file=.env scripts/setup-delegate-proxy.ts --upload --yes
 *   npx tsx --env-file=.env scripts/setup-delegate-proxy.ts --create --yes
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANTON_LEDGER_API, KEYCLOAK_BASE, KEYCLOAK_REALM, KEYCLOAK_TOKEN_URL,
  KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, OPERATOR_KC_USERNAME,
  OPERATOR_KC_PASSWORD, PACKAGE_ID, PARTIES,
} from '../src/config.js';
import type { CantonSdkConfig } from '../src/canton-sdk/config.js';
import { PKG_FEATURED_APP_PROXIES, TPL_DELEGATE_PROXY } from '../src/canton-sdk/config.js';
import { getActiveContracts, listUserRights, submitCommand } from '../src/canton-sdk/ledger.js';
import { getAdminToken, getOperatorToken } from '../src/canton-sdk/tokens.js';
import { resolveOperatorCantonId } from '../src/canton-sdk/operator.js';

const DAR_RELATIVE = '../dars/splice-util-featured-app-proxies-1.2.4.dar';

const config: CantonSdkConfig = {
  cantonLedgerApi: CANTON_LEDGER_API, keycloakBase: KEYCLOAK_BASE,
  keycloakRealm: KEYCLOAK_REALM, keycloakTokenUrl: KEYCLOAK_TOKEN_URL,
  keycloakClientId: KEYCLOAK_CLIENT_ID, keycloakClientSecret: KEYCLOAK_CLIENT_SECRET,
  operatorUsername: OPERATOR_KC_USERNAME, operatorPassword: OPERATOR_KC_PASSWORD,
  packageId: PACKAGE_ID, parties: PARTIES,
};

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const no = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const hm = (m: string) => console.log(`  \x1b[33m•\x1b[0m ${m}`);

async function isVetted(opToken: string): Promise<boolean> {
  const res = await fetch(`${CANTON_LEDGER_API}/v2/packages`, {
    headers: { Authorization: `Bearer ${opToken}` },
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json() as { packageIds?: string[] } | string[];
  const ids = Array.isArray(body) ? body : (body.packageIds ?? []);
  return ids.includes(PKG_FEATURED_APP_PROXIES);
}

async function findProxy(
  opToken: string, provider: string, delegate: string,
): Promise<string | null> {
  // `delegate` is an observer on DelegateProxy, so the operator party sees it.
  const contracts = await getActiveContracts(
    config, opToken, delegate, { templateId: TPL_DELEGATE_PROXY },
  );
  const match = contracts.find((c) => {
    const p = c.payload as { provider?: string; delegate?: string };
    return p.provider === provider && p.delegate === delegate;
  });
  return match?.contractId ?? null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--yes');
  const doUpload = process.argv.includes('--upload');
  const doCreate = process.argv.includes('--create');

  const provider = PARTIES.nodeOperator;
  const delegate = PARTIES.operator;
  if (!provider) throw new Error('NODE_OPERATOR_PARTY_ID is unset');

  const opToken = await getOperatorToken(config);
  const opUserId = await resolveOperatorCantonId(config);

  console.log(`\nledger  : ${CANTON_LEDGER_API}`);
  console.log(`provider: ${provider}`);
  console.log(`delegate: ${delegate}\n`);

  // ── package ────────────────────────────────────────────────────────
  console.log('package splice-util-featured-app-proxies (1.2.4)');
  let vetted = await isVetted(opToken);
  vetted ? ok(`vetted (${PKG_FEATURED_APP_PROXIES.slice(0, 16)}…)`) : no('NOT vetted');

  if (doUpload && !vetted) {
    if (!apply) {
      hm('DRY RUN — would upload. Re-run with --yes.');
    } else {
      const here = dirname(fileURLToPath(import.meta.url));
      const bytes = await readFile(resolve(here, DAR_RELATIVE));
      const res = await fetch(`${CANTON_LEDGER_API}/v2/packages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await getAdminToken(config)}`,
          'Content-Type': 'application/octet-stream',
        },
        body: new Uint8Array(bytes),
      });
      if (!res.ok) throw new Error(`upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      ok(`uploaded ${bytes.length} bytes`);
      vetted = await isVetted(opToken);
      vetted ? ok('vetted ✓') : no('still not listed — check participant logs');
    }
  } else if (doUpload) {
    hm('already vetted — nothing to upload');
  }

  // ── proxy contract ─────────────────────────────────────────────────
  console.log('\nDelegateProxy contract');
  if (!vetted) {
    hm('skipped — package must be vetted first (--upload --yes)');
  } else {
    const existing = await findProxy(opToken, provider, delegate);
    if (existing) {
      ok(`exists: ${existing}`);
      hm('nothing to do — this cid is resolved dynamically at submit time');
    } else {
      no('none for this (provider, delegate) pair');
      if (doCreate) {
        const rights = await listUserRights(config, opToken, opUserId);
        if (!rights.actAs.includes(provider)) {
          no('CanActAs(provider) missing — the create is signed by the provider');
          hm('run: grant-node-operator-rights.ts --act --yes   (then revoke after)');
        } else if (!apply) {
          hm('DRY RUN — would create. Re-run with --yes.');
        } else {
          const result = await submitCommand(
            config, opToken, opUserId,
            [provider], // signatory only; delegate is a mere observer
            [{ CreateCommand: { templateId: TPL_DELEGATE_PROXY, createArguments: { provider, delegate } } }],
            { commandId: `delegate-proxy-create-${provider.split('::')[0]}` },
          );
          const cid = await findProxy(opToken, provider, delegate);
          ok(`created: ${cid ?? '(cid not echoed; re-run to confirm)'}`);
          void result;
          hm('now REVOKE CanActAs(provider) — steady state needs only CanReadAs');
        }
      }
    }
  }

  console.log('');
}

main().catch((e) => { console.error(`\nfailed: ${(e as Error).message}\n`); process.exit(1); });
