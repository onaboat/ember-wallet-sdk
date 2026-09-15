# Wallet integration QA

Run this checkpoint against the exact prerelease tarball before anyone approves
an npm release. Record the SDK version, tarball SHA-256, API environment, wallet
build identifiers, tester, date, and pass/fail evidence.

## Package boundary

- Extract the tarball and confirm it contains only `dist`, `README.md`,
  `SUPPORT.md`, `COMPATIBILITY.md`, `LICENSE`, `contract/README.md`,
  `contract/provenance.json`, and package metadata.
- Confirm the published provenance digest matches the reviewed
  `contract/wallet-v1.json` and its recorded upstream revision.
- Install the tarball into clean React Native and browser-extension test
  projects, and execute it in the SDK-owned HTTPS web and Manifest V3 fixtures.
  All targets must build without Node-only runtime polyfills.
- Import the package through both ESM and CommonJS entry points and confirm the
  expected exports load.
- Confirm logs, thrown errors, and network responses expose only documented
  wallet-facing fields and safe public error codes.

## Session and binding

- Confirm the client is configured with its exact registered integration
  version and a `web`, `chrome_extension`, or `native` host binding.
- Create a fresh session using the exact challenge bytes returned by the API.
- Alter each challenge authority field and confirm the protected-wallet signer
  and session-creation request are never invoked.
- Restart each wallet and confirm its session can be restored from secure local
  storage.
- Reuse a browser-extension session from a different origin. The API must reject
  it without revealing operational details.
- Reuse a mobile session with a different application binding. The API must
  reject it without revealing operational details.
- Corrupt, expire, and revoke a session independently. Each case must fail
  closed and prompt a clean session renewal.
- Force secure-storage save and clear failures and confirm they surface as
  `EmberSessionPersistenceError` without silently switching session signers.

## HTTPS web and Chrome extension hosts

- Run `npm run conformance:origins`. Confirm the installed tarball executes in
  a real HTTPS Window and Manifest V3 service worker with default and injected
  Web Crypto.
- Confirm HTTPS reload and extension-worker restart restore the same
  partitioned authority without opening another session.
- Open two web-wallet tabs concurrently. Confirm Web Locks permit only one
  session-opening transition and the second tab re-reads the stored authority.
- Use a different wallet partition. Confirm it cannot load or clear the first
  wallet's session.
- Configure the deployed Devnet API values from
  `conformance/origin-host/env.example`, run `npm run conformance:cors`, and
  retain the result with the release evidence.
- Confirm approved HTTPS and Chrome origins receive exact CORS reflection for
  challenge and signed headers; an unapproved origin must not receive access.
- Inspect the host CSP and dependency graph. No unreviewed third-party script
  may share access to refresh credentials or session signing capability.

## Native Android and Solana-phone hosts

- Run `npm run conformance:native`. Confirm a clean consumer installs the
  current tarball, Metro builds its Android target, the React Native-matched
  Hermes compiler accepts both bundles, and no Node-only runtime import enters
  either bundle.
- Confirm the deterministic adapter result matches the shared request-proof
  vector and restores the serialized session in a second process without
  opening another wallet challenge.
- Install the same tarball in a supported Android emulator and a representative
  Solana phone. Confirm the application actually starts under Hermes; compiler
  acceptance alone is not device-runtime evidence.
- Using the final Ember-registered Android application ID, open, restore,
  rotate and revoke against Devnet QA with the wallet's production-equivalent
  fetch, crypto, non-exportable signer and secure-storage adapters.
- Kill the process after persistence and confirm the refresh credential and
  matching ephemeral signer restore as one authority without another protected
  wallet signature.
- Background beyond the access window and exercise biometric/PIN approval near
  the decision-expiry boundary. Record expected reauthentication and freshness
  behavior. Do not advertise iOS support without an equivalent gate.

## Quote and coverage journeys

- Exercise eligible, not-eligible, unsupported, temporarily unavailable, and
  coverage-limit results. Each UI state must be distinct and understandable.
- Verify a signed quote and confirm the wallet displays the signed public facts,
  not data inferred locally.
- Attempt verification on the wrong cluster and with one altered signed fact.
  Both attempts must fail closed before a transaction is submitted.
- Confirm coverage activation and status refresh survive an app or extension
  restart.
- Exercise `decisionFreshness` immediately before protected signing and after
  the signer returns. Confirm exact-boundary, near-expiry, expired, and invalid
  timestamps never appear as fresh.

## Failure, retry, and cancellation

- Force a transient failure on a read, payment, decision, evidence submission,
  claim creation, and evidence completion. Confirm the business body and
  idempotency key stay exact while each proof JTI and signature changes.
- Force the same failure on session bootstrap/rotation, terms acceptance,
  quote creation, revocation, claim appeal, and evidence-upload begin. Confirm
  none of these non-idempotent operations retries automatically.
- Abort a read and mutation before dispatch and while in flight. Confirm caller
  cancellation is distinguishable from timeout and no later retry is sent.
- Return a validly shaped response for the wrong resource and wallet. Confirm
  the SDK rejects it locally without copying either identifier into the error.

## Evidence and claims

- Queue evidence, close the wallet before upload completes, reopen it, and
  confirm retry is idempotent.
- Simulate offline, timeout, rate-limit, and unavailable responses. No retry may
  duplicate evidence or lose the local queue.
- Submit a claim and confirm the wallet can render its amount, deadlines,
  evidence requests, decision, and normalized timeline without private
  operational data.
- Confirm all displayed amounts use integer-safe handling and never pass through
  floating-point conversion.

## Real API conformance

- Configure the designated sandbox authority and an operator-owned wallet
  fixture as documented in [`CONFORMANCE.md`](./CONFORMANCE.md).
- Review the payment recipient, amount, mint, cluster, fee payer and controlled
  test transaction; confirm both simulations pass before setting the explicit
  Devnet transaction approval for the run.
- Run `npm run conformance:api` and retain the JSON evidence report.
- Confirm the report identifies the packed SDK version and tarball SHA-256,
  contract version/digest/upstream revision, public lifecycle identifiers and
  every required step through appeal and revocation.
- Confirm the report contains no credentials, signed bytes, evidence contents,
  request bodies, private keys or upload URLs.

## Release decision

The prerelease passes only when every row has evidence from the HTTPS web
fixture, browser extension, and declared native-mobile wallet; the package and
repository boundary checks pass; and no unresolved severity-one or
severity-two defect remains.

Hash the reviewed API, CORS, Android emulator, representative Solana-phone and
manual product QA records into `release/evidence/v<package-version>.json` using
the exact release tarball SHA-256. `npm run release:check` must reject a missing,
failed, malformed or cross-version gate before the artifact can be staged.
