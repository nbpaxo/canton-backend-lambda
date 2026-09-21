# Vendored DARs

## splice-util-featured-app-proxies-1.2.4.dar

Splice utility package for featured-app activity markers. **Not uploaded to
validators by default** — it ships in the Splice release bundle but has to be
explicitly vetted on the participant.

- **Provenance:** extracted from the official `0.6.11_splice-node.tar.gz`
  release bundle (`digital-asset/decentralized-canton-sync`, tag `v0.6.11`),
  path `splice-node/dars/`. This matches the `IMAGE_TAG=0.6.11` the MainNet
  validator actually runs — the on-disk bundles at `~/.canton/0.6.2` and
  `~/.canton/0.6.7` only carry up to 1.2.3.
- **Package id:** `88bcea6e9990bb2edb5301c042caa25c0594742665866f049f7bd67342d0865d`
- **Why ≥ 1.2.1:** Splice 0.5.3 fixed a `WalletUserProxy_TransferInstruction_Withdraw`
  controller bug (required `receiver` instead of `sender`).
- **Verified:** `Splice/Util/FeaturedApp/DelegateProxy.daml` is byte-identical
  across package versions 1.2.0 → 1.2.4, so this is the same code as the 1.2.3
  sitting on the validator host. `WalletUserProxy.daml` is identical 1.2.1 → 1.2.4.

Upload with `scripts/setup-delegate-proxy.ts --upload --yes`.
