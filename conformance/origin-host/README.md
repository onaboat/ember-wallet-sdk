# Origin-host conformance

This fixture installs the current npm tarball into a clean consumer and bundles
that installed package for two real browser runtimes:

- an HTTPS page/window representing a web wallet or PWA; and
- a Chrome Manifest V3 extension service worker.

It opens or restores a secretless session and performs a signed offer request
in each runtime. The local HTTPS API fixture enforces exact-origin CORS so the
test observes both challenge and signed-header preflights. It also proves
reload, multi-tab serialization, service-worker restart, unapproved-origin and
challenge-binding mismatch behavior.

The deterministic test signers contain no key material and cannot sign or send
a Solana transaction. Full Devnet lifecycle conformance remains the separate
`npm run conformance:api` gate.

## Runtime contract

The SDK distribution targets ES2022 and has no Node-only runtime dependency.
It supports standards-based Window and worker runtimes with `fetch`,
`AbortController`, `TextEncoder`, `URL`, timers and Web Crypto. A host without
those APIs must provide the documented fetch and crypto adapters.

`engines.node` describes installation, package verification and CommonJS
support; it does not make Node a browser runtime dependency.

## CORS contract owned by the API

For each registered HTTPS or `chrome-extension://` origin, preflight responses
must:

- return a successful status;
- echo the exact origin in `Access-Control-Allow-Origin` (never `*`);
- include `Vary: Origin`;
- allow `POST` plus `content-type` for session challenge and creation; and
- allow `GET`/`POST` plus `content-type`, `idempotency-key`,
  `x-ember-wallet-jti`, `x-ember-wallet-session`,
  `x-ember-wallet-signature`, and `x-ember-wallet-timestamp` for signed calls.

Unregistered and mismatched origins must fail closed. The backend's narrowly
defined missing-Origin behavior for signed Chrome GET requests does not apply
to ordinary HTTPS web wallets or session-opening mutations.

Copy `env.example` into a secure operator environment and run
`npm run conformance:cors` to check the deployed API. These binding values are
public identifiers, but they remain deployment configuration rather than SDK
defaults.

## Host-owned session storage and concurrency

Partition browser sessions by environment, integration ID, integration
version and protected wallet address. Store the refresh credential together
with the matching non-extractable session signer; never persist a wallet
private key or seed phrase.

Every open, rotate, reauthentication and revocation transition must execute
under one Web Lock using that same partition key. Re-read storage after taking
the lock before deciding whether to mutate. `BroadcastChannel` may notify other
tabs, but notifications are not ownership and cannot replace the lock.

An HTTPS wallet must assume any same-origin script can access its session.
Use a restrictive CSP, no unreviewed third-party scripts, no session values in
URLs or telemetry, and clear the complete partition on parser or persistence
failure. The conformance fixture uses `localStorage` only to make reload and
multi-tab behavior observable; it is not a production secure-storage
recommendation.

An MV3 extension should keep the same partition in `chrome.storage.local` and
persist the non-extractable signer in an extension-owned store. Reconstruct the
client after worker restart and verify the stored public key before reuse.
Pin the manifest public key so the registered extension origin stays stable.
