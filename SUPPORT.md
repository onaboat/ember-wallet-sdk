# Supported hosts

Support is a product claim, not merely a successful JavaScript import. A host
is declared supported only when the exact package version has passed its
automated gate and every listed release-evidence checkpoint.

## Host matrix

| Host | Binding | Automated package evidence | Release evidence still required | Current declaration |
| --- | --- | --- | --- | --- |
| HTTPS web wallet or PWA | Exact browser-provided HTTPS `Origin` | Packed SDK executes in a real HTTPS Window with default and injected Web Crypto; reload, two-tab ownership and origin rejection pass | Registered-origin CORS and full Devnet/manual product journey | Qualification required |
| Chrome Manifest V3 extension | Exact `chrome-extension://<extension-id>` origin | Packed SDK executes in an MV3 service worker; worker restart and origin rejection pass | Registered-extension CORS and full Devnet/manual product journey | Qualification required |
| Android native wallet | Exact Ember-registered application ID | Packed SDK bundles with React Native 0.86/Metro and compiles with Hermes `250829098.0.14`; request proof and serialized session restoration pass | Emulator boot, representative Solana-phone run, platform secure storage and full Devnet/manual product journey | Qualification required; Android first |
| iOS native wallet | Exact Ember-registered bundle ID | None | Equivalent iOS runtime, storage, lifecycle and product evidence | Unsupported |
| Other extension schemes, embedded frames, Electron/desktop and server-side wallets | Undefined | None | Separate binding threat model and conformance fixture | Unsupported unless added by a later release |

The authoritative machine-readable declaration is
`release/policy.json`. `npm run release:policy` prevents documentation tooling
from assigning prerelease versions to the stable channel and validates the
closed host set used by release evidence.

The `beta` channel is an integration channel, not a supported-host declaration.
Its narrower API, Chrome-origin and manual Chrome evidence permits consumers to
test an exact package before HTTPS and native qualification. The
`release-candidate` and stable channels still require evidence for every host
listed as qualification required above.

## Host-owned boundaries

The SDK owns Ember challenge validation, session/request proofs, response
validation and domain results. Each wallet host owns UI, account selection,
protected signing, non-exportable ephemeral signing, secure persistence,
Mobile Wallet Adapter or Seed Vault integration, Solana RPC, transaction
simulation, approval and broadcast.

No wallet private key, seed phrase, partner credential or administrative
credential belongs in the SDK. Runtime adapters must preserve the exact bytes
given to message signers and must store the refresh credential with the
matching session signer as one authority.

## Compatibility versus support

The package publishes neutral ES2022 ESM and CommonJS artifacts. A successful
bundle in another runtime is useful compatibility evidence, but it does not add
that runtime to the supported-host matrix. See `COMPATIBILITY.md` for version
and upgrade rules and `QA.md` for the observable release checkpoints.
