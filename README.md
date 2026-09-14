# `@embercover/wallet-sdk`

Secretless Ember Cover integration for browser-extension and React Native
wallets.

The package never accepts a partner API key. A wallet proves ownership with a
one-use Solana off-chain challenge, then uses a host-custodied ephemeral
Ed25519 session key for short-lived proof-of-possession requests.

## Security boundary

- Wallet private keys and seed phrases never enter the SDK.
- The host supplies the wallet signer and an independent ephemeral session
  signer.
- The host stores the session refresh credential and session signer in its
  approved secure storage.
- Browser sessions are bound to the browser-provided `Origin`.
- Native sessions are bound to an exact registered application identifier.
- Production configuration requires HTTPS.
- The configured environment must match every returned session, offer, and
  quote. Production maps only to `mainnet-beta`; sandbox maps only to `devnet`.
- Successful API responses are runtime-validated before becoming trusted
  SDK values.
- Quotes are hash-checked and Ed25519-verified against Ember's active or
  retired public verification keys. Live schema-v3 quotes must carry the
  twelve-period benefit schedule and exact $10,000/$120,000 limits.

This repository contains only the wallet integration contract and client.
Underwriting implementation, operational controls, provider configuration,
partner APIs, and administrative APIs are intentionally not part of the
package or its source history.

## Contract authority and provenance

This repository is the sole source of behavior for the published
`@embercover/wallet-sdk`. The checked-in wallet OpenAPI document is an imported
release artifact, not a second implementation of the API.

[`contract/provenance.json`](./contract/provenance.json) records the exact
upstream contract revision, artifact path, contract version, and SHA-256. It is
validated before generated-code currency and is included in the npm tarball so
an installed SDK can be traced to its wire contract. See
[`contract/README.md`](./contract/README.md) for the contract-change sequence.

External SDK copies and wallet applications are consumers or temporary
compatibility mirrors. They do not define this package's behavior.

## Install

```bash
npm install @embercover/wallet-sdk@beta
```

The `beta` tag is the prerelease channel for integration testing. Pin an exact
version before a production wallet release.

The package publishes ESM, CommonJS, and TypeScript declarations. It relies on
standard `fetch`, `AbortController`, `TextEncoder`, and Web Crypto by default;
React Native hosts can inject equivalent adapters.

## Sandbox/devnet quick start

### What you need from Ember

Before writing code, ask Ember for:

- the sandbox API base URL;
- your public `integrationId`;
- the exact registered `integrationVersion`;
- registration of each browser-extension origin; and
- registration of the iOS bundle ID and Android package ID used by the native
  wallet.

These are public binding values, not credentials. There is no Ember API key in
a wallet integration.

The test wallet also needs:

- enough devnet SOL to pay transaction fees;
- at least 1 devnet USDC for the current QA offer;
- its existing message-signing and transaction-signing adapters; and
- a separate ephemeral Ed25519 signer stored with the session in the
  platform's secure storage.

Circle's official Solana devnet USDC mint is
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. It uses the classic SPL Token
Program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` and six decimals.
Obtain test USDC from the
[Circle Faucet](https://faucet.circle.com/) and devnet SOL from a public
[Solana faucet](https://faucet.solana.com/).

The SDK checks those devnet facts when it verifies the signed quote. The quote
is still authoritative: never hardcode its amount, destination token account,
treasury owner, payment reference, or expiry.

### 1. Create a client

```ts
import {
  EmberWalletClient,
  P11_WALLET_SCOPES,
  type EmberCrypto,
  type EmberFetch,
  type EmberMessageSigner,
  type WalletSessionStore,
} from '@embercover/wallet-sdk';

declare const sessionSigner: EmberMessageSigner; // ephemeral, not the wallet key
declare const secureSessionStore: WalletSessionStore;
declare const EMBER_SANDBOX_API_URL: string; // supplied by Ember
declare const EMBER_INTEGRATION_ID: string; // supplied by Ember
declare const EMBER_INTEGRATION_VERSION: number; // supplied by Ember
declare const EXTENSION_ORIGIN: string; // exact chrome-extension:// origin

const ember = new EmberWalletClient({
  baseUrl: EMBER_SANDBOX_API_URL,
  environment: 'sandbox',
  hostBinding: { kind: 'chrome_extension', origin: EXTENSION_ORIGIN },
  integrationId: EMBER_INTEGRATION_ID,
  integrationVersion: EMBER_INTEGRATION_VERSION,
  sessionSigner,
  sessionStore: secureSessionStore,
});
```

Use `hostBinding: { kind: 'chrome_extension', origin }` in an extension and
`hostBinding: { kind: 'web', origin }` in an HTTPS web wallet or PWA. The SDK
checks that the challenge binds the exact expected origin before asking the
protected wallet to sign. The runtime still supplies the request `Origin`; do
not synthesize or override that header.

React Native clients use the exact Ember-registered bundle/package identifier
and inject platform-compatible `fetch` and crypto adapters when required:

```ts
declare const reactNativeFetch: EmberFetch;
declare const reactNativeCrypto: EmberCrypto;

const ember = new EmberWalletClient({
  baseUrl: EMBER_SANDBOX_API_URL,
  environment: 'sandbox',
  integrationId: EMBER_INTEGRATION_ID,
  integrationVersion: EMBER_INTEGRATION_VERSION,
  hostBinding: {
    kind: 'native',
    applicationId: 'com.partner.wallet',
  },
  fetch: reactNativeFetch,
  crypto: reactNativeCrypto,
  sessionSigner,
  sessionStore: secureSessionStore,
});
```

An application identifier is attribution and request binding, not a secret.
See the complete storage adapters in
[`examples/browser-extension`](https://github.com/onaboat/ember-wallet-sdk/tree/v1.3.2-beta.1/examples/browser-extension)
and
[`examples/react-native`](https://github.com/onaboat/ember-wallet-sdk/tree/v1.3.2-beta.1/examples/react-native).

### 2. Open a wallet session

```ts
declare const walletSigner: EmberMessageSigner;

await ember.openSession({
  walletSigner,
  requestedScopes: P11_WALLET_SCOPES,
});
```

The SDK validates every authority field and the complete canonical SIWS-style
message before it calls the protected-wallet signer. The signer's
`signMessage` implementation must sign those exact bytes without adding another
prefix or encoding transform.

`P11_WALLET_SCOPES` adds `claims:create` to the core wallet lifecycle scopes.
`P10_WALLET_SCOPES` remains available for hosts that intentionally do not
request claim authority. The SDK exposes only coverage-instance claims, never
the legacy subscription claim API.

### 3. Request and verify a quote

```ts
const { offers } = await ember.listOffers();
const offer = offers.find(
  (candidate) =>
    candidate.environment === 'sandbox' &&
    candidate.cluster === 'devnet' &&
    candidate.availabilityMode === 'live' &&
    candidate.lifecycle === 'active',
);
if (!offer) throw new Error('No devnet Ember offer is currently available.');

// Render the terms identified by these exact versions and hashes. Call this
// only after the user approves those terms.
await ember.acceptTerms({
  offerId: offer.offerId,
  offerVersion: offer.offerVersion,
  termsVersion: offer.termsVersion,
  documentSha256: offer.termsSha256,
});

// createQuote verifies the returned quote before resolving.
const quote = await ember.createQuote({ offerId: offer.offerId });

if (
  !quote.payload.paymentAllowed ||
  !quote.payload.createsCoverage ||
  quote.payload.offer.cluster !== 'devnet'
) {
  throw new Error('The returned quote is not a payable devnet quote.');
}
```

`createQuote` resolves only after checking the response schema, payload hash,
Ed25519 signature, signing-key registry, expiry, environment, integration,
wallet authority, cluster, and supported quote schema.

### 4. Build and send the quoted USDC payment

Keep Solana construction inside the wallet's existing transaction layer. The
small adapter below is the only bridge the Ember flow needs:

```ts
import type {
  OfferCluster,
  QuotePaymentFactsResponse,
} from '@embercover/wallet-sdk';

interface QuotedUsdcPayment {
  cluster: OfferCluster;
  expiresAt: string;
  payerWallet: string;
  payment: QuotePaymentFactsResponse;
  quoteId: string;
}

interface WalletPaymentAdapter {
  simulateReviewSignAndSend(
    input: QuotedUsdcPayment,
  ): Promise<string>; // base58 transaction signature
}

declare const walletPayments: WalletPaymentAdapter;

const paymentSignature = await walletPayments.simulateReviewSignAndSend({
  cluster: quote.payload.offer.cluster,
  expiresAt: quote.payload.validity.expiresAt,
  payerWallet: quote.payload.payerWallet,
  payment: quote.payload.payment,
  quoteId: quote.payload.quoteId,
});

const payment = await ember.createPayment({
  quoteId: quote.payload.quoteId,
  paymentSignature,
});
```

The adapter must:

1. reject an expired quote or a cluster other than the wallet's active
   `devnet` cluster;
2. derive the protected wallet's source token account for `payment.mint`;
3. build an SPL Token `TransferChecked` using the exact `mint`,
   `tokenProgram`, `treasuryTokenAccount`, `amount`, and `decimals` from the
   verified quote, parsing `amount` as `BigInt` rather than a JavaScript
   floating-point number;
4. include `payment.reference` as an additional read-only, non-signer account
   on that transfer instruction, following the Solana Pay reference convention;
5. simulate the complete transaction;
6. show the user the devnet cluster, payer, recipient, token, and amount before
   requesting approval; and
7. sign and broadcast through the wallet's normal Solana path.

The SDK never receives a wallet private key, builds a transaction, chooses an
RPC endpoint, or broadcasts.

A complete typechecked version of this orchestration is available in
[`examples/readme-quickstart.ts`](https://github.com/onaboat/ember-wallet-sdk/blob/v1.3.2-beta.1/examples/readme-quickstart.ts).

### 5. Wait for activation

`createPayment` is idempotent for the same quote and signature. Persist its
`paymentId`, then refresh it from a background-safe scheduler:

```ts
const paymentState = await ember.getPayment(payment.paymentId);

if (paymentState.status === 'rejected') {
  showPaymentRejected();
} else if (
  paymentState.status === 'activated' &&
  paymentState.coverageInstanceId
) {
  const coverage = await ember.getCoverageInstance(
    paymentState.coverageInstanceId,
  );
  showActiveCoverage(coverage);
} else {
  schedulePaymentRefresh(payment.paymentId);
}
```

Do not treat a wallet broadcast callback as activation. Ember independently
checks finalized settlement before returning a coverage instance.

## `signTransaction`

```ts
const review = await ember.reviewForSigning({
  kind: 'transaction',
  coverageInstanceId,
  transactionBytes: unsignedTransactionBase64,
  dappUrl,
});

// Render review before approval. `unavailable` never claims coverage and must
// not prevent ordinary wallet signing.
renderEmberReview(review);

const signedBytes = await walletSignExactReviewedTransaction();

if (review.status === 'reviewed') {
  // Persist before returning the signed transaction to the dapp.
  await durableEvidenceQueue.put({
    decisionId: review.decision.decisionId,
    request: { kind: 'transaction', signedBytes },
  });
  void drainEvidenceQueue();
}

return signedBytes;
```

The evidence queue retries the exact same decision evidence. Ember verifies
every required transaction signature and the reviewed message hash before
accepting it.

## Claims

Claims are available only for covered transaction decisions that Ember has
sealed against finalized chain evidence.

```ts
const eligibility = await ember.claimEligibility(decisionId);
if (eligibility.eligible) {
  const claim = await ember.createClaim(
    {
      lossEvent: 'direct_malicious_signing_loss',
      decisionId,
      claimedAmountMicros: '1000000',
      statement: 'Describe the covered loss.',
    },
    // Persist and reuse this key with the exact same request after a restart.
    { idempotencyKey: 'claim-wallet-record-000001' },
  );

  const current = await ember.getClaim(claim.claimId);
  const allClaims = await ember.listClaims();
}
```

For a delegate drain, supply the independently finalized loss transaction
signature in `lossTransactionSignature`. Ember derives the loss time, amount,
and approval-to-transfer causality; caller values are never authoritative.

When `evidenceRequests` contains an open request:

1. call `beginClaimEvidenceUpload`;
2. upload exact bytes to the returned short-lived `PUT` grant using its
   headers;
3. call `completeClaimEvidenceUpload`; and
4. poll `getClaim` while Ember verifies stored metadata and scans the object.

Only clean evidence satisfies a request. Rejections remain immutable, and
`appealClaim` opens a separate appeal review without rewriting the original
decision.

## `signAndSendTransaction`

Use the same review sequence. After approval:

1. sign and broadcast using the wallet's normal Solana path;
2. durably record the exact signed bytes and decision identifier;
3. submit them with `submitDecisionEvidence`;
4. expose the transaction signature and decision evidence state in wallet
   activity; and
5. poll `getDecision` or read `getDecisionLineage` while Ember independently
   confirms and seals the landed transaction.

The SDK does not choose an RPC endpoint, fee payer, recent blockhash, compute
budget, prioritization fee, signer set, or broadcast policy.

## Failure and retry behavior

- `reviewForSigning` never throws. Timeout, network, validation, and API
  failures become an explicit `unavailable` result so signing can continue
  without a false coverage promise.
- Allowance exhaustion becomes `not_covered`.
- Reads retry transient network, `408`, `425`, `429`, and `5xx` responses.
- Payment submission, decision creation, exact evidence submission, claim
  creation, and evidence completion retry because the server provides
  operation-specific idempotency.
- Challenge creation, session creation/rotation, terms acceptance, quote
  creation, and revocation do not retry automatically.
- Every retry uses a fresh proof-of-possession JTI and signature while
  preserving the exact business request.
- Every method accepts `{ signal }`; claim creation additionally accepts a
  stable `{ idempotencyKey }`. Caller cancellation is distinct from a timeout.

## Session rotation

Create and securely persist a new ephemeral signer before calling:

```ts
await ember.rotateSession(nextSessionSigner);
```

Rotation consumes the old refresh credential and revokes the old session
atomically on the server. A wallet should prompt for fresh ownership proof when
rotation cannot be recovered safely.

Use `sessionState(session, now, rotateBeforeMs)` with a host-chosen rotation
window. It distinguishes `active`, `rotate_soon`, `refresh_window_expired`, and
`reauthentication_required`. A late-rotated access session may remain active
after its fixed refresh window closes; it can continue making signed requests
but cannot rotate again.

## Telemetry

The optional telemetry hook receives only operation name, path template,
attempt, duration, status, and outcome. It never receives request bodies,
wallet addresses, signed bytes, signatures, session identifiers, refresh
credentials, or API responses.

## Platform examples

- `examples/browser-extension` demonstrates a Manifest V3 signing boundary and
  durable post-sign queue ordering.
- `examples/react-native` demonstrates injected crypto, fetch, and secure
  session persistence.

Both examples are typechecked in CI.

Before approving a prerelease, run the complete React Native and browser
extension checkpoint in [`QA.md`](./QA.md) against the exact release tarball.
