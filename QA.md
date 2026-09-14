# Wallet integration QA

Run un this checkpoint against the exact prerelease tarball before anyone approves
an npm release. Record the SDK version, tarball SHA-256, API environment, wallet
build identifiers, tester, date, and pass/fail evidence.

## Package boundary

- Extract the tarball and confirm it contains only `dist`, `README.md`,
  `LICENSE`, `contract/README.md`, `contract/provenance.json`, and package
  metadata.
- Confirm the published provenance digest matches the reviewed
  `contract/wallet-v1.json` and its recorded upstream revision.
- Install the tarball into clean React Native and browser-extension test
  projects. Both projects must build without Node-only runtime polyfills.
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

## Quote and coverage journeys

- Exercise eligible, not-eligible, unsupported, temporarily unavailable, and
  coverage-limit results. Each UI state must be distinct and understandable.
- Verify a signed quote and confirm the wallet displays the signed public facts,
  not data inferred locally.
- Attempt verification on the wrong cluster and with one altered signed fact.
  Both attempts must fail closed before a transaction is submitted.
- Confirm coverage activation and status refresh survive an app or extension
  restart.

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

## Release decision

The prerelease passes only when every row has evidence from both the React
Native wallet and the browser extension, the package and repository boundary
checks pass, and no unresolved severity-one or severity-two defect remains.
