# Ember Wallet SDK

**Bring transaction review and eligible cover into your Solana wallet.**

Ember is building insurance infrastructure for onchain transactions. It connects
an assessment of what a user is about to sign with cover for defined, eligible
losses—and the evidence needed to support a claim if something goes wrong.
The aim is to make protection part of the wallet experience, from the approval
screen through to transaction history and claims.

`@embercover/wallet-sdk` is the TypeScript client for that integration. It lets
your wallet establish an authenticated session, activate coverage, request a
review of exact transaction bytes, submit signing evidence, and manage claims.
Your wallet keeps control of its interface, keys, approvals, and Solana execution.

Coverage depends on the offer, terms, limits, transaction decision, and verified
evidence. An active coverage instance does not mean every transaction is covered,
and a risk assessment is not a guarantee that a transaction is safe.

## What you can build

- **Coverage onboarding:** discover offers, present terms, obtain a verified
  payment quote, and track activation.
- **Transaction approval:** display risk, signing disposition, coverage status,
  and available simulation effects before the user signs.
- **Coverage recovery:** restore current coverage and allowance after a restart.
- **Transaction history:** follow signed evidence through verification and read
  the decision lineage.
- **Claims:** check eligibility, submit a claim, respond to evidence requests,
  and request an appeal.

## Start here

This README targets the **1.3.2-beta.5 source implementation** in this checkout.
It is a prerelease integration contract; examples must be used with a matching
artifact. The checkout version alone does not establish npm availability or
production readiness. Pin the exact package approved for your integration.

To try this implementation locally, use Node.js 20 or newer:

```bash
npm ci
npm run build
npm pack
```

Then install the resulting package in your wallet project:

```bash
npm install --save-exact /absolute/path/to/embercover-wallet-sdk-1.3.2-beta.5.tgz
```

The package exports ESM, CommonJS, and TypeScript declarations. It targets ES2022
and uses standard `fetch`, `AbortController`, `TextEncoder`, `URL`, timers, and
Web Crypto. Native hosts can inject fetch and crypto adapters.

Before connecting, obtain these public integration values from Ember:

- API base URL and environment;
- `integrationId` and registered `integrationVersion`;
- registration of your exact HTTPS origin, Chrome extension origin, or native
  application identifier.

There is no Ember API key to embed in a wallet. Your host supplies a wallet
message signer, a separate ephemeral Ed25519 session signer, and secure session
storage. Sandbox binds to `devnet`; production binds to `mainnet-beta` and
requires HTTPS. Production configuration is not a release approval.

### Platform qualification

| Host | Binding | Status |
| --- | --- | --- |
| HTTPS web wallet / PWA | Exact browser-provided HTTPS origin | Release qualification required |
| Chrome Manifest V3 extension | Exact registered extension origin | Release qualification required |
| Android / React Native | Exact registered application ID | Device and release qualification required |
| iOS | Exact registered bundle ID | Unsupported pending equivalent evidence |
| Other runtimes and host types | Separate binding and conformance work | Not currently supported |

See [Supported hosts](./SUPPORT.md) for the evidence required for each platform
and [Compatibility](./COMPATIBILITY.md) before choosing or upgrading a package.

## 1. Connect the wallet

The following snippets describe a sandbox web-wallet flow. `declare` values
represent adapters or configuration supplied by your application.

```ts
import {
  EmberWalletClient,
  P11_WALLET_SCOPES,
  type EmberMessageSigner,
  type WalletSessionStore,
} from '@embercover/wallet-sdk';

declare const sandboxApiUrl: string;
declare const integrationId: string;
declare const integrationVersion: number;
declare const walletSigner: EmberMessageSigner;
declare const sessionSigner: EmberMessageSigner;
declare const secureSessionStore: WalletSessionStore;

const ember = new EmberWalletClient({
  baseUrl: sandboxApiUrl,
  environment: 'sandbox',
  integrationId,
  integrationVersion,
  hostBinding: { kind: 'web', origin: window.location.origin },
  sessionSigner,
  sessionStore: secureSessionStore,
});

await ember.openSession({
  walletSigner,
  requestedScopes: P11_WALLET_SCOPES,
});
```

`EmberMessageSigner` exposes a base58 Ed25519 `publicKey` and
`signMessage(message: Uint8Array): Promise<Uint8Array>`. Sign the supplied bytes
exactly, without a prefix or encoding transform. The SDK validates the complete
challenge and its authority bindings before requesting the wallet signature.
Subsequent authenticated requests use the separate session signer.

`WalletSessionStore` implements `load`, `save`, and `clear`. Treat the refresh
credential and its matching session signer as one authority in your platform's
secure storage. Never pass a wallet private key or seed phrase to the SDK.

`P11_WALLET_SCOPES` includes claim creation. `P10_WALLET_SCOPES` is available
for integrations that do not request that authority.

For Chrome extensions, use
`hostBinding: { kind: 'chrome_extension', origin: registeredExtensionOrigin }`.
The browser supplies the HTTP `Origin`; do not synthesize that header.
For native wallets, use
`hostBinding: { kind: 'native', applicationId: registeredApplicationId }`
and supply `fetch` and `crypto` adapters when the runtime requires them.
An application ID is a public binding value, not a credential.

Working host adapters are in [the extension example](./examples/browser-extension/index.ts)
and [the React Native example](./examples/react-native/index.ts).

## 2. Activate coverage

Coverage activation follows a clear sequence: select an offer, obtain user
agreement to its terms, verify a quote, pay it through the wallet, and wait for
Ember to confirm activation.

```ts
import type { AvailableOfferResponse } from '@embercover/wallet-sdk';

declare const confirmTerms: (offer: AvailableOfferResponse) => Promise<void>;

const { offers } = await ember.listOffers();
const offer = offers.find((candidate) =>
  candidate.environment === 'sandbox' &&
  candidate.cluster === 'devnet' &&
  candidate.availabilityMode === 'live' &&
  candidate.lifecycle === 'active'
);
if (!offer) throw new Error('No active devnet offer is available.');

// Present the exact terms identified by the offer. Resolve only on consent.
await confirmTerms(offer);
await ember.acceptTerms({
  offerId: offer.offerId,
  offerVersion: offer.offerVersion,
  termsVersion: offer.termsVersion,
  documentSha256: offer.termsSha256,
});

const quote = await ember.createQuote({ offerId: offer.offerId });
if (
  !quote.payload.paymentAllowed ||
  !quote.payload.createsCoverage ||
  quote.payload.offer.cluster !== 'devnet'
) {
  throw new Error('The quote cannot activate coverage on devnet.');
}
```

`createQuote` verifies the payload hash, Ed25519 signature, trusted signing key,
validity window, wallet and integration authority, environment, cluster, and
supported quote/payment constraints before returning. Use the verified quote
for displayed amounts and payment construction; do not hardcode commercial terms.

### Pay the verified quote

Your wallet builds, simulates, presents, signs, and broadcasts the payment.
The SDK does not construct Solana transactions or choose an RPC endpoint.

Pass `quote.payload.payment`, `payerWallet`, `offer.cluster`, `quoteId`, and
`validity.expiresAt` to your payment adapter. It must:

1. Check the quote expiry and the wallet's active cluster.
2. Select the payer's source token account for the quoted mint.
3. Build `TransferChecked` with the exact quoted `mint`, `tokenProgram`,
   `treasuryTokenAccount`, `amount`, and `decimals`. Parse the integer amount
   with `BigInt`, not floating-point arithmetic.
4. Include `payment.reference` as an additional read-only, non-signer account
   on the transfer instruction.
5. Simulate the complete transaction, show the payment details, obtain approval,
   and sign and broadcast through the wallet's normal transaction path.

Sandbox testing needs devnet SOL for fees and the devnet USDC specified by the
quote. Do not substitute the treasury, reference, token, or payment amount.

After broadcast, register the transaction signature:

```ts
declare const paymentSignature: string; // base58, returned by your wallet

const payment = await ember.createPayment({
  quoteId: quote.payload.quoteId,
  paymentSignature,
});

// Persist paymentId and repeat this read through a background-safe scheduler.
const paymentState = await ember.getPayment(payment.paymentId);
if (paymentState.status === 'activated' && paymentState.coverageInstanceId) {
  const coverage = await ember.getCoverageInstance(paymentState.coverageInstanceId);
  // Display the activated coverage record.
} else if (paymentState.status === 'rejected') {
  // Show the rejection and a recovery path.
} else {
  // Keep the payment pending and schedule another read.
}
```

Payment registration is idempotent for the same quote and signature. Broadcast
success is not coverage activation: wait for Ember's settlement verification.
See [the activation example](./examples/readme-quickstart.ts) for the typed
orchestration and payment-adapter contract.

## 3. Recover coverage and allowance

Use the server's current state after session restoration or a lifecycle change:

```ts
const current = await ember.getCurrentCoverage();
if (current.status === 'active') {
  const { coverage, allowance } = current;
  // coverage.coverageInstanceId identifies the coverage for a signing review.
  // allowance contains available, reserved, committed, and limit.
} else {
  // No current coverage. Present activation or the wallet's uncovered flow.
}
```

This avoids relying on a locally remembered payment ID. Treat allowance as a
server snapshot; local approval counts cannot establish whether a reservation
has been released or committed.

## 4. Review before signing

Submit the final unsigned transaction bytes before opening the covered approval
flow. This snippet requests an assessment; the host implements the approval
and signing policy described below.

```ts
import { decisionFreshness } from '@embercover/wallet-sdk';

declare const coverageInstanceId: string;
declare const unsignedTransactionBase64: string;
declare const dappUrl: string;
declare const approvalSafetyMs: number; // measured for your host's approval flow

const review = await ember.reviewForSigning({
  kind: 'transaction',
  coverageInstanceId,
  transactionBytes: unsignedTransactionBase64,
  dappUrl,
});

if (review.status === 'reviewed') {
  const decision = review.decision;
  const freshness = decisionFreshness(decision, new Date(), approvalSafetyMs);
  // Render the decision and apply signing policy before invoking your signer.
} else if (review.status === 'not_covered') {
  // Allowance is exhausted. Show that this request is not covered.
} else {
  // Review is unavailable. Never display a coverage promise.
}
```

Three distinct results matter to the approval UI:

| Result | Meaning |
| --- | --- |
| `review.status` | Whether a review was obtained: `reviewed`, `not_covered`, or `unavailable` |
| `decision.coverStatus` | Coverage assessment: `covered`, `not_covered`, `unsupported`, or `unavailable` |
| `decision.signingDisposition` | Signing policy: `allow`, `acknowledge`, or `block`; may be absent or null |

A reviewed response is not automatically covered. Enforce `block` at the
wallet's signing boundary and require explicit consent for `acknowledge`.
Missing or null disposition means the safety assessment is unavailable; do not
interpret it as `allow`. An Ember outage should be visible as unavailable and
must not, by itself, disable the wallet's ordinary signing path.

Optional simulation balances are observations, not spending intent or a
promise of execution. SOL changes can include fees and account funding; token
amounts are raw units. Preserve warnings about incomplete effects.

### Approval and evidence ordering

1. Review the final unsigned bytes and present the assessment.
2. Check freshness immediately before signing. `near_expiry`, `expired`, and
   `invalid` must not be shown as fresh cover. Review again if the bytes change.
3. Apply the wallet's approval policy and sign exactly the reviewed transaction.
4. Check freshness again after signing. If it finished too late, preserve the
   signed evidence and show the actual state without promising fresh cover.
5. Durably queue the decision ID and exact signed bytes **before** returning a
   `signTransaction` result or broadcasting a `signAndSendTransaction` result.
6. Submit the queued evidence and retry it unchanged after failures or restart.

```ts
declare const decisionId: string;
declare const signedTransactionBase64: string;

await ember.submitDecisionEvidence(decisionId, {
  kind: 'transaction',
  signedBytes: signedTransactionBase64,
});
```

Use `getDecision` and `getDecisionLineage` to follow verification and finalized
chain evidence. Successful submission alone does not establish a sealed covered
outcome. For `signAndSendTransaction`, the host also broadcasts through its own
RPC path and records the transaction signature in wallet activity.

If the user rejects an approval **before signing begins**, call
`cancelDecision(decisionId)`. Inspect `cancelled` and `evidenceState`, then
refresh allowance. Accepted evidence wins over later cancellation; cancellation
is not a post-sign refund mechanism.

### Message requests

The review request also accepts `kind: 'message'`, `coverageInstanceId`, base64
`messageBytes`, and `walletMethod: 'signMessage' | 'signIn'`. Message evidence
uses `kind: 'message'`, base64 `signedMessage`, and a base58 `signature`.
Support for requesting a review does not imply message coverage; apply the
returned coverage assessment and signing disposition.

## 5. Manage claims

Check eligibility for the specific decision. Claims require a covered
transaction decision sealed against finalized chain evidence.

```ts
declare const claimedAmountMicros: string; // integer micro-units
declare const statement: string;
declare const claimIdempotencyKey: string; // persist with this exact request

const eligibility = await ember.claimEligibility(decisionId);
if (eligibility.eligible) {
  const claim = await ember.createClaim(
    {
      lossEvent: 'direct_malicious_signing_loss',
      decisionId,
      claimedAmountMicros,
      statement,
    },
    { idempotencyKey: claimIdempotencyKey },
  );
  const claimState = await ember.getClaim(claim.claimId);
  // Display the returned claim state; submission does not mean approval.
}
```

Persist and reuse the idempotency key with the exact same request across
retries and restarts. `listClaims` retrieves the wallet's claims. For delegate
drains, include the independently finalized loss transaction signature in
`lossTransactionSignature`; caller-provided amounts and timing are not
settlement authority.

When a claim has an open evidence request:

1. Call `beginClaimEvidenceUpload` for that request.
2. Upload the exact file bytes using the returned HTTPS `PUT` URL and headers.
3. Call `completeClaimEvidenceUpload`.
4. Read `getClaim` while metadata verification and scanning complete.

The SDK validates grant expiry, identifiers, upload state, and permitted
headers. Only clean evidence satisfies the request. `appealClaim` starts a
separate review while preserving the original rejection.

## Session lifecycle and resilience

`currentSession()` validates the persisted session. Restore the matching
session signer before using it, and isolate authority when accounts,
environments, or host bindings change. The host owns secure persistence,
concurrent tab/worker coordination, and recovery after process death.

Use `sessionState(session, now, rotateBeforeMs)` to distinguish `active`,
`rotate_soon`, `refresh_window_expired`, and `reauthentication_required`.
Securely persist a new ephemeral signer before `rotateSession(nextSigner)`.
Rotation consumes the old refresh credential and revokes the old session; if
recovery is uncertain, obtain fresh wallet ownership proof. An access session
can remain active after its refresh window closes, but cannot rotate again.

`clearLocalSession()` only clears local storage. Use `revokeSession()` or
`revokeAllSessions()` to revoke server authority.

### Failures and retries

`reviewForSigning` converts failures into explicit review results instead of
throwing. Other methods expose typed errors, including `EmberApiError`,
`EmberTimeoutError`, `EmberAbortError`, `EmberResponseValidationError`, and
`EmberResponseMismatchError`. `EmberApiError` exposes `code`, `status`, and
`requestId` for handling API failures.

The transport retries transient network errors and HTTP `408`, `425`, `429`,
and `5xx` only for operations marked idempotent. These include reads, payment
registration, decision creation/cancellation, exact evidence submission, claim
creation, and evidence completion. It does not automatically retry challenge
or session creation, rotation, terms acceptance, quote creation, or revocation.
Each retry creates a fresh request proof while preserving the business request.

Configure `timeouts` and `retry` on the client. Default timeouts are 15 seconds
for decisions, 5 seconds for reads, and 10 seconds for bootstrap and mutations;
the default retry budget is two retries. Methods accepting `EmberRequestOptions`
support an abort `signal`. Aborting an HTTP request does not cancel a decision
on the server.

The optional `telemetry` hook reports operation, templated path, attempt,
duration, status, and outcome. It receives no bodies, wallet addresses,
credentials, signatures, or concrete resource identifiers.

## Integration boundaries

| SDK owns | Wallet host owns |
| --- | --- |
| Challenge validation and request proofs | Wallet and ephemeral session signers |
| Runtime response and authority validation | Secure storage and account selection |
| Quote hash and signature verification | Terms, payment, approval, and claims UI |
| Typed Ember lifecycle calls | Transaction construction, simulation, and RPC |
| Review results and freshness helpers | Signing policy, durable evidence queue, and broadcast |

This package contains the wallet client and its imported API contract. It does
not include underwriting implementation, administrative APIs, partner secrets,
or custody of wallet keys. The checked-in contract's upstream revision and
SHA-256 are recorded in [contract provenance](./contract/provenance.json).
See [contract maintenance](./contract/README.md) for regeneration rules.

## Examples, verification, and release checks

| Resource | Purpose |
| --- | --- |
| [Activation example](./examples/readme-quickstart.ts) | Typed offer-to-payment orchestration |
| [Browser extension example](./examples/browser-extension/index.ts) | Signing boundary and durable evidence ordering |
| [React Native example](./examples/react-native/index.ts) | Native adapters and secure session persistence |
| [Browser conformance](./conformance/origin-host/README.md) | HTTPS/MV3 origin binding, CORS, restart, and coordination |
| [Native conformance](./conformance/native-mobile/README.md) | Metro/Hermes checks and device QA requirements |
| [API conformance](./CONFORMANCE.md) | Packed SDK journey against an API with an external signer |
| [Manual QA](./QA.md) | Observable integration and release checkpoints |
| [Compatibility](./COMPATIBILITY.md) | Versioning, upgrade, and rollback rules |

For local development:

```bash
npm run typecheck
npm run examples:check
```

`npm run verify` runs the broader automated gates, including contract checks,
tests, consumer builds, platform fixtures, public-boundary checks, and package
checks. It does not replace live API/CORS conformance or device QA.

Before approving a wallet integration, manually exercise activation and payment
recovery, session restoration and rotation, coverage/allowance recovery,
blocked and unavailable approvals, expiry during signing, pre-sign cancellation,
evidence recovery after process death, and claim retries. Use the exact packed
artifact and the platform-specific checkpoints linked above.

## License

[MIT](./LICENSE).
