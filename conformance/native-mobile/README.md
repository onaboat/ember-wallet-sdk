# Native qualification is deferred

Android and iOS are not current release targets. The React Native/Metro/Hermes
dependencies, Android fixtures and native conformance runner were removed when
Android work was deferred. They are recoverable from Git history; the original
tooling was introduced in commit `4d20c7e`.

The SDK still exposes native application binding, injected fetch/crypto,
message signer and session-store contracts. The framework-independent
[adapter example](../../examples/react-native/index.ts) remains typechecked.
These interfaces do not establish compatibility with a mobile runtime.

Before reintroducing Android:

1. Select a maintained React Native/Metro/Hermes toolchain whose complete
   dependency audit passes. Do not restore old dependency pins blindly.
2. Restore packed-package Android bundle, Hermes compilation, request-proof
   and process-restoration conformance checks.
3. Run the exact tarball in an Android emulator and a representative Solana
   phone using the wallet's fetch, crypto and secure-storage implementations.
4. Verify application binding, session opening/rotation/revocation, background
   expiry, process death, evidence recovery and approval timing against Devnet.
5. Add the automated gate and device evidence back to the release policy,
   validator, evidence template, tests and support documentation together.

The host must custody the ephemeral signer and refresh credential together,
use its registered application ID, and preserve the exact bytes supplied to
signers. Mobile Wallet Adapter and Seed Vault integrations belong in the wallet
application. iOS needs equivalent independent qualification.
