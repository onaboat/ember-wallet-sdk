# Changelog

## Unreleased

- Makes release evidence channel-specific: beta integration releases require
  retained real-API and Chrome wallet records, while release-candidate and stable
  releases remain gated by the complete HTTPS and Android/Solana-phone matrix.
- Aligns fresh challenge validation with the API's bounded 60-second wallet
  clock-skew policy while continuing to reject larger future timestamps before
  invoking the protected-wallet signer.
- Keeps runtime exports aligned with the public declarations for persisted
  session parsing, session-state evaluation, and request-proof construction.
- Declares this repository as the sole authority for the published SDK.
- Adds a published contract-provenance manifest with strict revision, path,
  version, and SHA-256 verification.
- Includes the retained product plan in public-boundary scanning.
- Validates the complete wallet challenge and expected host authority before
  invoking a protected-wallet signer.
- Adds strict persisted-session parsing, lifecycle states, rotation response
  correlation, and typed persistence failures.
- Replaces the ambiguous generated `client` configuration with an explicit
  `hostBinding` and requires the trusted `integrationVersion`.
- Rejects successful responses that do not match the originating request or
  active wallet authority with a typed `EmberResponseMismatchError`.
- Emits only static route templates to telemetry and validates HTTPS `PUT`
  evidence-upload grants, expiry, lifecycle state, and safe headers.
- Adds a host-neutral `decisionFreshness` policy with explicit fresh,
  near-expiry, expired, and invalid states.
- Exercises every public client method and verifies retry, idempotency,
  cancellation, malformed-response, and fail-open signing behavior.
- Adds an SDK-owned packed-package conformance runner for the complete
  secretless lifecycle against a configured sandbox API, with explicit Devnet
  transaction approval and provenance-bearing evidence reports.
- Adds packed-package execution in a real HTTPS Window and Chrome Manifest V3
  worker, exact-origin CORS conformance, and host-owned browser session
  partitioning and concurrency guidance.
- Adds packed-package React Native Android conformance through Metro and the
  React Native-matched Hermes compiler, plus deterministic request-proof and
  two-process session-restoration checks; physical Android/Solana-phone runtime
  approval remains an explicit Manual QA gate.
- Bundles the runtime validator into the neutral SDK artifacts so React Native
  consumers do not require a package-specific Babel transform.
- Adds closed beta, release-candidate and stable channel rules, exact-tarball
  staged publishing, signed-tag checks and fail-closed release-evidence
  manifests appropriate to each channel.
- Publishes the supported-host matrix plus semantic compatibility, upgrade and
  rollback rules with the package.

## 1.3.2-beta.1

- Adds a copyable sandbox/devnet wallet-integration path to the README.
- Documents the verified Solana devnet USDC facts and the wallet-owned quoted
  payment adapter contract.
- Adds platform-specific browser-extension and React Native configuration,
  transaction-review requirements, and activation polling guidance.
- Contains no runtime SDK or public API changes.

## 1.3.2-beta.0

- First standalone public prerelease for browser-extension and React Native
  wallet integration testing.
- Adds secretless wallet sessions with browser-origin or native-application
  binding.
- Adds runtime-validated offer, quote, payment, coverage, decision, evidence,
  and claim clients.
- Adds offline signed-quote verification and fail-open signing review.
- Publishes only the curated wallet contract and coarse wallet-facing errors,
  decision reasons, payment status, and claim lifecycle.
