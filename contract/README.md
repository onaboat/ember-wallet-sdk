# Wallet API contract authority

This repository is the only authority for the published
`@embercover/wallet-sdk` implementation. `wallet-v1.json` is an imported release
artifact whose wire behavior is owned by the Ember wallet API OpenAPI contract.

`provenance.json` records the exact upstream revision, artifact path, contract
version, and SHA-256 used by this SDK source state. The npm package includes the
provenance manifest, but it does not include backend source or private API
contracts.

## Updating the contract

1. Obtain the reviewed `wallet-v1.json` artifact and its authoritative upstream
   revision.
2. Replace `contract/wallet-v1.json`.
3. Update every field in `contract/provenance.json` from that same reviewed
   artifact. Do not update the digest merely to silence a failed check.
4. Run `npm run generate` and review the generated type and schema changes.
5. Run `npm run contract:check` and `npm run verify`.
6. Record the compatibility impact in `CHANGELOG.md` before publishing.

Generated files under `src/generated/` are never edited by hand. External SDK
copies and wallet applications are consumers or temporary compatibility mirrors;
they do not define package behavior and must not be used as a source for changes
to this repository.
