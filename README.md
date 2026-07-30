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

## Install

```bash
npm install @embercover/wallet-sdk@beta
```

The `beta` tag is the prerelease channel for integration testing. Pin an exact
version before a production wallet release.

The package publishes ESM, CommonJS, and TypeScript declarations. It relies on
standard `fetch`, `AbortController`, `TextEncoder`, and Web Crypto by default;
React Native hosts can inject equivalent adapters.

## Create a client

```ts
import {
  EmberWalletClient,
  P11_WALLET_SCOPES,
  type EmberMessageSigner,
  type WalletSessionStore,
} from '@embercover/wallet-sdk';

declare const sessionSigner: EmberMessageSigner; // ephemeral, not the wallet key
declare const secureSessionStore: WalletSessionStore;

const ember = new EmberWalletClient({
  baseUrl: 'https://sandbox-api.example.ember.cover',
  environment: 'sandbox',
  integrationId: 'integration_partner-wallet',
  client: { kind: 'browser' },
  sessionSigner,
  sessionStore: secureSessionStore,
});
```

Native clients use an Ember-approved public application identifier:

```ts
client: {
  kind: 'native',
  applicationId: 'com.partner.wallet',
}
```

An application identifier is attribution and request binding, not a secret.

## Open a wallet session

```ts
declare const walletSigner: EmberMessageSigner;

await ember.openSession({
  walletSigner,
  requestedScopes: P11_WALLET_SCOPES,
});
```

The wallet signer receives the exact SIWS-style challenge string returned by
Ember. Its `signMessage` implementation must sign those bytes without adding
another prefix or encoding transform.

`P11_WALLET_SCOPES` adds `claims:create` to the core wallet lifecycle scopes.
`P10_WALLET_SCOPES` remains available for hosts that intentionally do not
request claim authority. The SDK exposes only coverage-instance claims, never
the legacy subscription claim API.

## Offer, quote, and payment lifecycle

```ts
const { offers } = await ember.listOffers();
const offer = offers[0];

await ember.acceptTerms({
  offerId: offer.offerId,
  offerVersion: offer.offerVersion,
  termsVersion: offer.termsVersion,
  documentSha256: offer.termsSha256,
});

// createQuote verifies the returned quote before resolving.
const quote = await ember.createQuote({ offerId: offer.offerId });

// A live quote has twelve activation-anchored periods. Each period shares
// $10,000 across its claims; the annual maximum is $120,000.
const schedule = quote.payload.benefitSchedule;

// The protected wallet constructs, reviews, and signs the exact quoted USDC
// payment. The SDK never signs or broadcasts it.
const payment = await ember.createPayment({
  quoteId: quote.payload.quoteId,
  paymentSignature: '<base58 payment transaction signature>',
});

const paymentState = await ember.getPayment(payment.paymentId);
if (paymentState.coverageInstanceId) {
  const coverage = await ember.getCoverageInstance(
    paymentState.coverageInstanceId,
  );
}
```

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
