# Real API conformance

This SDK-owned runner installs the current package tarball into a clean
temporary consumer and drives the public client against a configured Ember
sandbox API. It never imports SDK source or backend implementation.

The run is intentionally separate from `npm run verify`: it requires a live
API, a registered integration, funded Devnet accounts, object storage, chain
confirmation workers, and a human-approved wallet fixture.

HTTPS web-wallet and Chrome-extension runtime/CORS conformance is documented
separately in [`conformance/origin-host/README.md`](./conformance/origin-host/README.md).

## Safety boundary

- The runner refuses every environment except `sandbox`.
- Transactions are disabled unless
  `EMBER_CONFORMANCE_TRANSACTION_APPROVAL=I_APPROVE_DEVNET_TRANSACTIONS` is
  supplied for that run.
- Never put a private key, seed phrase, session file, or funded-wallet fixture
  in this repository.
- The wallet fixture must display the quoted payment and controlled test
  transaction, simulate each transaction, obtain human approval, then sign and
  broadcast through its own wallet boundary.
- Use only the designated low-value Devnet QA wallet and controlled recipient.
  Do not use a production wallet or mainnet RPC.

## Required configuration

Copy `conformance/env.example` into your shell configuration or secure CI
environment and replace every placeholder. `EMBER_CONFORMANCE_FIXTURE_MODULE`
must be an absolute path to an operator-owned module outside this repository.

The base URL must be HTTPS, except for an exact localhost sandbox. Branch 04
can exercise native, HTTPS-origin, or Chrome-extension protocol binding from
Node. That does not certify browser CORS or a mobile runtime; those are the
separate Branch 05 and Branch 06 gates.

## Wallet fixture contract

The external module must export:

```js
export async function createConformanceWalletFixture({ baseUrl, environment }) {
  return {
    walletSigner: {
      publicKey: 'canonical base58 Solana address',
      async signMessage(exactBytes) {
        // Return one real 64-byte Ed25519 signature from the protected wallet.
      },
    },

    async submitQuotedPayment({ quote }) {
      // Review and simulate the exact quote, obtain human approval, then send.
      return { simulationPassed: true, paymentSignature: 'base58 signature' };
    },

    async prepareCoveredTransaction({ coverage, quote }) {
      // Build and simulate one controlled low-value Devnet transaction.
      return {
        simulationPassed: true,
        request: {
          kind: 'transaction',
          coverageInstanceId: coverage.coverageInstanceId,
          transactionBytes: 'base64 unsigned transaction',
        },
        // Keep any host-owned signing state here; the SDK never reads keys.
      };
    },

    async signAndBroadcast({ decision, prepared }) {
      // Reconfirm freshness, obtain approval, sign exact reviewed bytes, send.
      return {
        simulationPassed: true,
        broadcastSignature: 'base58 signature',
        evidence: {
          kind: 'transaction',
          signedBytes: 'base64 signed transaction',
        },
      };
    },

    async evidenceForRequest({ claim, evidenceRequest }) {
      // Return synthetic, non-customer evidence allowed by the QA policy.
      return {
        bytes: new TextEncoder().encode('synthetic conformance evidence'),
        contentType: 'text/plain',
      };
    },
  };
}
```

The fixture is an adapter at the wallet/Solana edge. It must not be copied into
the SDK package and must not expose private key material to `EmberWalletClient`.

## Run and evidence

```sh
npm run conformance:api
```

The runner packs and installs the SDK, creates real Ed25519 session signers,
opens/rotates/restores a wallet session, and exercises offers, terms, quote,
payment activation, coverage, decision, post-sign evidence, lineage, claim,
evidence upload, appeal, and revocation. It reconstructs the client after every
durable transition so retries cannot silently depend on in-memory state.

A JSON report is written under `artifacts/api-conformance/`. It records the
package version and tarball digest, contract version/digest/upstream revision,
public API authority, public lifecycle identifiers, state transitions, and
pass/fail outcome. It never records session credentials, signed bytes,
transaction bodies, evidence contents, or private keys.

Branch 04 is complete only after a passing report from the designated API has
been reviewed and attached to Manual QA evidence. A locally green unit suite
proves the harness, not real API compatibility.
