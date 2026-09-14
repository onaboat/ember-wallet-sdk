# Changelog

## Unreleased

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
