import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  EmberApiError,
  EmberConfigurationError,
  EmberEnvironmentMismatchError,
  EmberQuoteVerificationError,
} from './errors';
import { base58Encode, webCrypto, type EmberCrypto } from './encoding';
import {
  EmberWalletClient,
  P10_WALLET_SCOPES,
  P11_WALLET_SCOPES,
  type SigningReview,
} from './emberClient';
import type {
  AvailableOfferResponse,
  CoverageDecisionResponse,
  SignedQuoteResponse,
  WalletScope,
} from './generated/types.gen';
import type {
  EmberMessageSigner,
  PersistedWalletSession,
  WalletSessionStore,
} from './session';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});
afterAll(() => server.close());

const API = 'http://localhost:4310';
const INTEGRATION_ID = 'integration_wallet-sdk';
const APPLICATION_ID = 'cover.ember.reference';
const WALLET = '11111111111111111111111111111111';
const SESSION_PUBLIC_KEY = 'SysvarRent111111111111111111111111111111111';
const FIXED_NOW = new Date('2026-07-27T12:05:00.000Z');

class MemorySessionStore implements WalletSessionStore {
  constructor(public value: PersistedWalletSession | null = null) {}

  async load(): Promise<PersistedWalletSession | null> {
    return this.value;
  }

  async save(session: PersistedWalletSession): Promise<void> {
    this.value = session;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

class CapturingSigner implements EmberMessageSigner {
  readonly messages: Uint8Array[] = [];

  constructor(
    readonly publicKey: string,
    private readonly fill: number,
  ) {}

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    this.messages.push(message);
    return new Uint8Array(64).fill(this.fill);
  }
}

function deterministicCrypto(): EmberCrypto {
  let sequence = 0;
  return {
    randomUuid() {
      sequence += 1;
      return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
    },
    async sha256(bytes) {
      return new Uint8Array(createHash('sha256').update(bytes).digest());
    },
    async verifyEd25519() {
      return true;
    },
  };
}

function session(
  overrides: Partial<PersistedWalletSession> = {},
): PersistedWalletSession {
  return {
    environment: 'sandbox',
    expiresAt: '2099-01-01T00:00:00Z',
    integrationId: INTEGRATION_ID,
    integrationVersion: 1,
    partnerId: 'partner_wallet-sdk',
    refreshExpiresAt: '2099-01-02T00:00:00Z',
    refreshToken: 'refresh_session_test.redacted-test-value',
    scopes: [...P10_WALLET_SCOPES],
    sessionId: 'session_wallet-sdk',
    sessionPublicKey: SESSION_PUBLIC_KEY,
    walletAddress: WALLET,
    walletSubjectId: 'wallet_wallet-sdk',
    ...overrides,
  };
}

function client(input: {
  crypto?: EmberCrypto;
  environment?: 'sandbox' | 'production';
  now?: () => Date;
  sessionSigner?: EmberMessageSigner;
  store?: MemorySessionStore;
  timeoutMs?: number;
  usePlatformFetch?: boolean;
}) {
  const store = input.store ?? new MemorySessionStore(session());
  const signer = input.sessionSigner ?? new CapturingSigner(SESSION_PUBLIC_KEY, 7);
  const sdk = new EmberWalletClient({
    baseUrl: API,
    client: { kind: 'native', applicationId: APPLICATION_ID },
    crypto: input.crypto ?? deterministicCrypto(),
    environment: input.environment ?? 'sandbox',
    ...(input.usePlatformFetch ? {} : { fetch }),
    integrationId: INTEGRATION_ID,
    now: input.now ?? (() => FIXED_NOW),
    retry: { maxBackoffMs: 2, maxRetries: 1, minBackoffMs: 1 },
    sessionSigner: signer,
    sessionStore: store,
    timeouts: {
      bootstrapMs: input.timeoutMs ?? 500,
      decisionMs: input.timeoutMs ?? 500,
      mutationMs: input.timeoutMs ?? 500,
      readMs: input.timeoutMs ?? 500,
    },
  });
  return { sdk, signer, store };
}

test('binds the platform fetch receiver in browser and extension runtimes', async () => {
  const platformFetch = globalThis.fetch;
  const receiverCheckingFetch = vi.fn(function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch': Illegal invocation");
    }
    return platformFetch.call(globalThis, input, init);
  }) as typeof fetch;
  vi.stubGlobal('fetch', receiverCheckingFetch);
  server.use(
    http.get(`${API}/v1/wallet/offers`, () =>
      HttpResponse.json({ offers: [offer()] }),
    ),
  );

  const { sdk } = client({ usePlatformFetch: true });

  await expect(sdk.listOffers()).resolves.toMatchObject({
    offers: [{ offerId: 'offer_core-annual' }],
  });
  expect(receiverCheckingFetch).toHaveBeenCalledOnce();
});

function offer(
  overrides: Partial<AvailableOfferResponse> = {},
): AvailableOfferResponse {
  return {
    aggregateLimitMicros: '10000000000',
    appealWindowDays: 7,
    availabilityMode: 'test',
    benefitPeriodCount: 12,
    benefitPeriodLimitMicros: '10000000000',
    cancellationRuleCode: 'no_post_activation_cancellation',
    catalogueSha256: 'd'.repeat(64),
    cluster: 'devnet',
    coverageDurationDays: 365,
    coverageDurationMonths: 12,
    coveredTransactionLimit: 100,
    deductibleMicros: '0',
    delegateLossTailDays: 30,
    displayName: 'Core Annual',
    environment: 'sandbox',
    immediateLossClaimWindowDays: 7,
    lifecycle: 'testing',
    offerId: 'offer_core-annual',
    offerVersion: 1,
    payerMustEqualProtectedWallet: true,
    paymentAsset: 'USDC',
    paymentAssetDecimals: 6,
    paymentMint: WALLET,
    paymentTokenProgram: WALLET,
    perLossLimitMicros: '10000000000',
    policySha256: 'c'.repeat(64),
    policyVersion: 'policy-v0.1',
    priceBaseUnits: '249990000',
    productCode: 'core',
    protectedWalletCount: 1,
    refundRuleCode: 'operational_or_mandatory_law_only',
    snapshotSha256: 'a'.repeat(64),
    termsSha256: 'b'.repeat(64),
    termsVersion: 'terms-v0.1',
    waitingPeriodDays: 0,
    ...overrides,
  };
}

function decision(
  overrides: Partial<CoverageDecisionResponse> = {},
): CoverageDecisionResponse {
  return {
    coverStatus: 'covered',
    coverageInstanceId: 'coverage_wallet-sdk',
    decisionExpiresAt: '2099-01-01T00:00:00Z',
    decisionId: 'decision_wallet-sdk',
    decisionReason: 'eligible',
    evaluationCountImpact: 1,
    evidenceState: 'pre_sign',
    kind: 'transaction',
    maximumPayoutMicros: '10000000000',
    offerId: 'offer_core-annual',
    offerVersion: 1,
    policyVersion: 'policy-v0.1',
    protectedWallet: WALLET,
    quoteId: 'quote_wallet-sdk',
    remainingAggregateLimitMicros: '10000000000',
    remainingUnderwritingEvaluations: 99,
    riskBand: 'low',
    termsVersion: 'terms-v0.1',
    ...overrides,
  };
}

test('opens a secretless session without an API key or authorization header', async () => {
  const store = new MemorySessionStore();
  const sessionSigner = new CapturingSigner(SESSION_PUBLIC_KEY, 7);
  const walletSigner = new CapturingSigner(WALLET, 9);
  const requestedScopes: WalletScope[] = ['offers:read', 'cover:evaluate'];
  let challengeBody: unknown;

  server.use(
    http.post(`${API}/v1/wallet-sessions/challenges`, async ({ request }) => {
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('x-ember-application-id')).toBe(APPLICATION_ID);
      challengeBody = await request.json();
      return HttpResponse.json({
        challengeId: 'challenge_wallet-sdk',
        expiresAt: '2026-07-27T12:10:00Z',
        issuedAt: '2026-07-27T12:05:00Z',
        message: 'exact SIWS challenge bytes',
        nonce: 'nonce_wallet-sdk',
      });
    }),
    http.post(`${API}/v1/wallet-sessions`, async ({ request }) => {
      expect(request.headers.get('authorization')).toBeNull();
      expect(await request.json()).toEqual({
        challengeId: 'challenge_wallet-sdk',
        signature: expect.any(String),
      });
      return HttpResponse.json({
        ...session({ scopes: requestedScopes }),
        sessionPublicKey: undefined,
      });
    }),
  );

  const { sdk } = client({ sessionSigner, store });
  const opened = await sdk.openSession({ requestedScopes, walletSigner });

  expect(challengeBody).toEqual({
    client: { kind: 'native', applicationId: APPLICATION_ID },
    integrationId: INTEGRATION_ID,
    requestedScopes,
    sessionPublicKey: SESSION_PUBLIC_KEY,
    walletAddress: WALLET,
  });
  expect(new TextDecoder().decode(walletSigner.messages[0])).toBe(
    'exact SIWS challenge bytes',
  );
  expect(opened.sessionPublicKey).toBe(SESSION_PUBLIC_KEY);
  expect(store.value?.refreshToken).toContain('refresh_');
});

test('signs each authenticated request over the exact method, path, JTI, and body hash', async () => {
  const signer = new CapturingSigner(SESSION_PUBLIC_KEY, 4);
  let requestJti = '';
  server.use(
    http.get(`${API}/v1/wallet/offers`, ({ request }) => {
      expect(request.headers.get('authorization')).toBeNull();
      requestJti = request.headers.get('x-ember-wallet-jti') ?? '';
      expect(request.headers.get('x-ember-wallet-session')).toBe('session_wallet-sdk');
      expect(request.headers.get('x-ember-wallet-signature')).toMatch(
        /^[A-Za-z0-9+/]{86}==$/,
      );
      expect(request.headers.get('x-ember-wallet-timestamp')).toBe(
        '2026-07-27T12:05:00.000Z',
      );
      return HttpResponse.json({ offers: [offer()] });
    }),
  );

  const { sdk } = client({ sessionSigner: signer });
  const result = await sdk.listOffers();
  expect(result.offers[0]?.offerId).toBe('offer_core-annual');

  const payload = new TextDecoder().decode(signer.messages[0]);
  expect(payload).toBe(
    [
      'ember-wallet-request-v1',
      'session_wallet-sdk',
      'GET',
      '/v1/wallet/offers',
      '2026-07-27T12:05:00.000Z',
      requestJti,
      createHash('sha256').update('').digest('hex'),
    ].join('\n'),
  );
});

test('rejects an offer whose environment or cluster disagrees with the client', async () => {
  server.use(
    http.get(`${API}/v1/wallet/offers`, () =>
      HttpResponse.json({
        offers: [offer({ cluster: 'mainnet-beta', environment: 'production' })],
      }),
    ),
  );
  const { sdk } = client({});
  await expect(sdk.listOffers()).rejects.toBeInstanceOf(
    EmberEnvironmentMismatchError,
  );
});

test('retries an exact decision with a fresh proof JTI', async () => {
  const jtis = new Set<string>();
  let attempts = 0;
  server.use(
    http.post(`${API}/v1/decisions`, ({ request }) => {
      attempts += 1;
      jtis.add(request.headers.get('x-ember-wallet-jti') ?? '');
      if (attempts === 1) {
        return HttpResponse.json(
          {
            details: [],
            error: 'rpc_unavailable',
            message: 'Try again.',
            requestId: 'req_retry',
          },
          { status: 503 },
        );
      }
      return HttpResponse.json(decision());
    }),
  );
  const { sdk } = client({});
  await expect(
    sdk.createDecision({
      coverageInstanceId: 'coverage_wallet-sdk',
      kind: 'transaction',
      transactionBytes: 'AAAA',
    }),
  ).resolves.toMatchObject({ decisionId: 'decision_wallet-sdk' });
  expect(attempts).toBe(2);
  expect(jtis.size).toBe(2);
});

test('does not retry a typed client error', async () => {
  let attempts = 0;
  server.use(
    http.get(`${API}/v1/wallet/offers`, () => {
      attempts += 1;
      return HttpResponse.json(
        {
          details: [],
          error: 'permission_denied',
          message: 'Scope is missing.',
          requestId: 'req_scope',
        },
        { status: 403 },
      );
    }),
  );
  const { sdk } = client({});
  const error = await sdk.listOffers().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(EmberApiError);
  expect((error as EmberApiError).code).toBe('permission_denied');
  expect(attempts).toBe(1);
});

test('reviewForSigning fails open on timeout without claiming cover', async () => {
  server.use(
    http.post(`${API}/v1/decisions`, async () => {
      await delay(100);
      return HttpResponse.json(decision());
    }),
  );
  const { sdk } = client({ timeoutMs: 10 });
  const result = await sdk.reviewForSigning({
    coverageInstanceId: 'coverage_wallet-sdk',
    kind: 'transaction',
    transactionBytes: 'AAAA',
  });
  expect(result).toEqual({
    status: 'unavailable',
    coverStatus: 'unavailable',
    reason: 'timeout',
  } satisfies SigningReview);
});

test('reviewForSigning maps allowance exhaustion to not covered', async () => {
  server.use(
    http.post(`${API}/v1/decisions`, () =>
      HttpResponse.json(
        {
          details: [],
          error: 'coverage_limit_reached',
          message: 'Allowance exhausted.',
          requestId: 'req_exhausted',
        },
        { status: 403 },
      ),
    ),
  );
  const { sdk } = client({});
  await expect(
    sdk.reviewForSigning({
      coverageInstanceId: 'coverage_wallet-sdk',
      kind: 'transaction',
      transactionBytes: 'AAAA',
    }),
  ).resolves.toEqual({
    status: 'not_covered',
    coverStatus: 'not_covered',
    reason: 'coverage_limit_reached',
    requestId: 'req_exhausted',
  });
});

test('reviewForSigning fails open on a malformed successful response', async () => {
  let attempts = 0;
  server.use(
    http.post(`${API}/v1/decisions`, () => {
      attempts += 1;
      return HttpResponse.json({ decisionId: 'decision_incomplete' });
    }),
  );
  const { sdk } = client({});
  await expect(
    sdk.reviewForSigning({
      coverageInstanceId: 'coverage_wallet-sdk',
      kind: 'transaction',
      transactionBytes: 'AAAA',
    }),
  ).resolves.toEqual({
    status: 'unavailable',
    coverStatus: 'unavailable',
    reason: 'invalid_response',
  });
  expect(attempts).toBe(1);
});

test('reviewForSigning fails open after bounded network retries', async () => {
  let attempts = 0;
  server.use(
    http.post(`${API}/v1/decisions`, () => {
      attempts += 1;
      return HttpResponse.error();
    }),
  );
  const { sdk } = client({});
  await expect(
    sdk.reviewForSigning({
      coverageInstanceId: 'coverage_wallet-sdk',
      kind: 'transaction',
      transactionBytes: 'AAAA',
    }),
  ).resolves.toEqual({
    status: 'unavailable',
    coverStatus: 'unavailable',
    reason: 'network',
  });
  expect(attempts).toBe(2);
});

test('reviewForSigning converts caller aborts into an unavailable result', async () => {
  const controller = new AbortController();
  controller.abort();
  const { sdk } = client({});
  await expect(
    sdk.reviewForSigning(
      {
        coverageInstanceId: 'coverage_wallet-sdk',
        kind: 'transaction',
        transactionBytes: 'AAAA',
      },
      { signal: controller.signal },
    ),
  ).resolves.toEqual({
    status: 'unavailable',
    coverStatus: 'unavailable',
    reason: 'aborted',
  });
});

test('reviewForSigning fails open without a request when session signing fails', async () => {
  const failingSigner: EmberMessageSigner = {
    publicKey: SESSION_PUBLIC_KEY,
    async signMessage() {
      throw new Error('secure signer unavailable');
    },
  };
  const { sdk } = client({ sessionSigner: failingSigner });
  await expect(
    sdk.reviewForSigning({
      coverageInstanceId: 'coverage_wallet-sdk',
      kind: 'transaction',
      transactionBytes: 'AAAA',
    }),
  ).resolves.toEqual({
    status: 'unavailable',
    coverStatus: 'unavailable',
    reason: 'signing',
  });
});

test('reviewForSigning reports a missing wallet session without making a request', async () => {
  const { sdk } = client({ store: new MemorySessionStore() });
  await expect(
    sdk.reviewForSigning({
      coverageInstanceId: 'coverage_wallet-sdk',
      kind: 'transaction',
      transactionBytes: 'AAAA',
    }),
  ).resolves.toEqual({
    status: 'unavailable',
    coverStatus: 'unavailable',
    reason: 'session',
  });
});

test('createClaim sends one stable idempotency key and validates claim data', async () => {
  let observedKey: string | null = null;
  server.use(
    http.post(`${API}/v1/wallet/claims`, ({ request }) => {
      observedKey = request.headers.get('idempotency-key');
      return HttpResponse.json(
        {
          claimId: 'claim_wallet-sdk',
          claimedAmountMicros: '1000000',
          coverageInstanceId: 'coverage_wallet-sdk',
          decisionId: 'decision_wallet-sdk',
          evidenceRequests: [],
          lossEvent: 'direct_malicious_signing_loss',
          protectedWallet: WALLET,
          reviewDueAt: '2026-07-28T12:05:00.000Z',
          state: 'submitted',
          submittedAt: '2026-07-27T12:05:00.000Z',
          timeline: [
            {
              occurredAt: '2026-07-27T12:05:00.000Z',
              status: 'submitted',
            },
          ],
          version: 1,
        },
        { status: 201 },
      );
    }),
  );
  const store = new MemorySessionStore(
    session({ scopes: [...P11_WALLET_SCOPES] }),
  );
  const { sdk } = client({ store });
  await expect(
    sdk.createClaim(
      {
        claimedAmountMicros: '1000000',
        decisionId: 'decision_wallet-sdk',
        lossEvent: 'direct_malicious_signing_loss',
        statement: 'Synthetic loss.',
      },
      { idempotencyKey: 'claim-test-00000001' },
    ),
  ).resolves.toMatchObject({
    claimId: 'claim_wallet-sdk',
    state: 'submitted',
  });
  expect(observedKey).toBe('claim-test-00000001');
});

test('production clients reject plaintext HTTP during construction', () => {
  expect(() => client({ environment: 'production' })).toThrow(
    EmberConfigurationError,
  );
});

test('non-idempotent quote creation is never retried', async () => {
  let attempts = 0;
  server.use(
    http.post(`${API}/v1/quotes`, () => {
      attempts += 1;
      return HttpResponse.json(
        {
          details: [],
          error: 'rpc_unavailable',
          message: 'Try again.',
          requestId: 'req_quote',
        },
        { status: 503 },
      );
    }),
  );
  const { sdk } = client({});
  await expect(
    sdk.createQuote({ offerId: 'offer_core-annual' }),
  ).rejects.toBeInstanceOf(EmberApiError);
  expect(attempts).toBe(1);
});

test('public signing-key discovery sends no credentials or content type', async () => {
  server.use(
    http.get(`${API}/v1/quote-signing-keys`, ({ request }) => {
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('content-type')).toBeNull();
      expect(request.headers.get('x-ember-wallet-session')).toBeNull();
      expect(request.headers.get('x-ember-wallet-signature')).toBeNull();
      return HttpResponse.json({ keys: [] });
    }),
  );
  const { sdk } = client({});
  await expect(sdk.quoteSigningKeys()).resolves.toEqual({ keys: [] });
});

test('verifies the canonical non-payable quote vector and rejects payload tampering', async () => {
  const vector = JSON.parse(
    await readFile(
      new URL('../fixtures/signed-quote-vector-v1.json', import.meta.url),
      'utf8',
    ),
  ) as SignedQuoteResponse;
  server.use(
    http.get('https://api.ember.test/v1/quote-signing-keys', () =>
      HttpResponse.json({
        keys: [
          {
            algorithm: 'ed25519',
            createdAt: '2026-07-27T11:00:00Z',
            keyId: vector.payload.signingKeyId,
            mode: vector.payload.mode,
            publicKey: vector.signingPublicKey,
            state: 'active',
            updatedAt: '2026-07-27T11:00:00Z',
          },
        ],
      }),
    ),
  );
  const store = new MemorySessionStore(
    session({
      environment: 'production',
      expiresAt: '2026-07-27T12:30:00Z',
      integrationId: 'integration_vector',
      integrationVersion: 1,
      partnerId: 'partner_vector',
      sessionPublicKey: SESSION_PUBLIC_KEY,
      walletAddress: WALLET,
      walletSubjectId: 'wallet_vector',
    }),
  );
  const sdk = new EmberWalletClient({
    baseUrl: 'https://api.ember.test',
    client: { kind: 'native', applicationId: APPLICATION_ID },
    crypto: webCrypto(),
    environment: 'production',
    fetch,
    integrationId: 'integration_vector',
    now: () => FIXED_NOW,
    retry: { maxRetries: 0 },
    sessionSigner: new CapturingSigner(SESSION_PUBLIC_KEY, 7),
    sessionStore: store,
  });

  await expect(sdk.verifyQuote(vector)).resolves.toBeUndefined();
  const tampered = structuredClone(vector);
  tampered.payload.nonce = `${tampered.payload.nonce}-tampered`;
  await expect(sdk.verifyQuote(tampered)).rejects.toMatchObject({
    name: EmberQuoteVerificationError.name,
    reason: 'hash_mismatch',
  });

  const obsoleteLive = structuredClone(vector);
  obsoleteLive.payload.schemaVersion = 2;
  obsoleteLive.payload.mode = 'live';
  obsoleteLive.payload.paymentAllowed = true;
  obsoleteLive.payload.createsCoverage = true;
  obsoleteLive.payload.payment.treasuryOwner = WALLET;
  await expect(sdk.verifyQuote(obsoleteLive)).rejects.toMatchObject({
    name: EmberQuoteVerificationError.name,
    reason: 'unsupported_schema',
  });

  const missingBenefitSchedule = structuredClone(obsoleteLive);
  missingBenefitSchedule.payload.schemaVersion = 3;
  await expect(sdk.verifyQuote(missingBenefitSchedule)).rejects.toMatchObject({
    name: EmberQuoteVerificationError.name,
    reason: 'unsupported_schema',
  });
});

test('verifies a canonical live quote with its benefit schedule', async () => {
  const vector = JSON.parse(
    await readFile(
      new URL('../fixtures/signed-quote-vector-v1.json', import.meta.url),
      'utf8',
    ),
  ) as SignedQuoteResponse;
  const original = vector.payload;
  const payload = {
    schemaVersion: 3,
    quoteId: original.quoteId,
    signingKeyId: original.signingKeyId,
    mode: 'live',
    partnerId: original.partnerId,
    integrationId: original.integrationId,
    integrationVersion: original.integrationVersion,
    walletSubjectId: original.walletSubjectId,
    termsAcceptanceId: original.termsAcceptanceId,
    protectedWallet: original.protectedWallet,
    payerWallet: original.payerWallet,
    offer: {
      ...original.offer,
      aggregateLimit: '120000000000',
    },
    benefitSchedule: {
      coverageDurationMonths: 12,
      benefitPeriodCount: 12,
      benefitPeriodLimit: '10000000000',
    },
    payment: {
      genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      mint: original.payment.mint,
      tokenProgram: original.payment.tokenProgram,
      treasuryTokenAccount: original.payment.treasuryTokenAccount,
      treasuryOwner: WALLET,
      amount: original.payment.amount,
      decimals: original.payment.decimals,
      reference: original.payment.reference,
    },
    validity: original.validity,
    nonce: original.nonce,
    paymentAllowed: true,
    createsCoverage: true,
  } as SignedQuoteResponse['payload'];
  const canonical = new TextEncoder().encode(JSON.stringify(payload));
  const payloadSha256 = createHash('sha256').update(canonical).digest('hex');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const domain = Buffer.from(
    '656d6265722d7369676e65642d71756f74652d763100',
    'hex',
  );
  const quote = {
    payload,
    payloadSha256,
    signingPublicKey: base58Encode(publicKeyBytes),
    signature: base58Encode(signBytes(null, Buffer.concat([domain, canonical]), privateKey)),
  } satisfies SignedQuoteResponse;
  server.use(
    http.get('https://api.ember.test/v1/quote-signing-keys', () =>
      HttpResponse.json({
        keys: [
          {
            algorithm: 'ed25519',
            createdAt: '2026-07-27T11:00:00Z',
            keyId: payload.signingKeyId,
            mode: 'live',
            publicKey: quote.signingPublicKey,
            state: 'active',
            updatedAt: '2026-07-27T11:00:00Z',
          },
        ],
      }),
    ),
  );
  const sdk = new EmberWalletClient({
    baseUrl: 'https://api.ember.test',
    client: { kind: 'native', applicationId: APPLICATION_ID },
    crypto: webCrypto(),
    environment: 'production',
    fetch,
    integrationId: 'integration_vector',
    now: () => FIXED_NOW,
    retry: { maxRetries: 0 },
    sessionSigner: new CapturingSigner(SESSION_PUBLIC_KEY, 7),
    sessionStore: new MemorySessionStore(
      session({
        environment: 'production',
        expiresAt: '2026-07-27T12:30:00Z',
        integrationId: 'integration_vector',
        integrationVersion: 1,
        partnerId: 'partner_vector',
        sessionPublicKey: SESSION_PUBLIC_KEY,
        walletAddress: WALLET,
        walletSubjectId: 'wallet_vector',
      }),
    ),
  });

  await expect(sdk.verifyQuote(quote)).resolves.toBeUndefined();
});

test('verifies only the exact payable Devnet QA contract in test mode', async () => {
  const vector = JSON.parse(
    await readFile(
      new URL('../fixtures/signed-quote-vector-v1.json', import.meta.url),
      'utf8',
    ),
  ) as SignedQuoteResponse;
  const original = vector.payload;
  const payload = {
    schemaVersion: 3,
    quoteId: original.quoteId,
    signingKeyId: original.signingKeyId,
    mode: 'test',
    partnerId: original.partnerId,
    integrationId: original.integrationId,
    integrationVersion: original.integrationVersion,
    walletSubjectId: original.walletSubjectId,
    termsAcceptanceId: original.termsAcceptanceId,
    protectedWallet: original.protectedWallet,
    payerWallet: original.payerWallet,
    offer: {
      ...original.offer,
      offerId: 'offer_devnet-qa-core-annual',
      environment: 'sandbox',
      cluster: 'devnet',
      price: '1000000',
      aggregateLimit: '120000000000',
    },
    benefitSchedule: {
      coverageDurationMonths: 12,
      benefitPeriodCount: 12,
      benefitPeriodLimit: '10000000000',
    },
    payment: {
      genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      tokenProgram: original.payment.tokenProgram,
      treasuryTokenAccount: original.payment.treasuryTokenAccount,
      treasuryOwner: WALLET,
      amount: '1000000',
      decimals: original.payment.decimals,
      reference: original.payment.reference,
    },
    validity: original.validity,
    nonce: original.nonce,
    paymentAllowed: true,
    createsCoverage: true,
  } as SignedQuoteResponse['payload'];
  const canonical = new TextEncoder().encode(JSON.stringify(payload));
  const payloadSha256 = createHash('sha256').update(canonical).digest('hex');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const domain = Buffer.from(
    '656d6265722d7369676e65642d71756f74652d763100',
    'hex',
  );
  const quote = {
    payload,
    payloadSha256,
    signingPublicKey: base58Encode(publicKeyBytes),
    signature: base58Encode(signBytes(null, Buffer.concat([domain, canonical]), privateKey)),
  } satisfies SignedQuoteResponse;
  server.use(
    http.get('https://api.ember.test/v1/quote-signing-keys', () =>
      HttpResponse.json({
        keys: [
          {
            algorithm: 'ed25519',
            createdAt: '2026-07-27T11:00:00Z',
            keyId: payload.signingKeyId,
            mode: 'test',
            publicKey: quote.signingPublicKey,
            state: 'active',
            updatedAt: '2026-07-27T11:00:00Z',
          },
        ],
      }),
    ),
  );
  const sdk = new EmberWalletClient({
    baseUrl: 'https://api.ember.test',
    client: { kind: 'native', applicationId: APPLICATION_ID },
    crypto: webCrypto(),
    environment: 'sandbox',
    fetch,
    integrationId: 'integration_vector',
    now: () => FIXED_NOW,
    retry: { maxRetries: 0 },
    sessionSigner: new CapturingSigner(SESSION_PUBLIC_KEY, 7),
    sessionStore: new MemorySessionStore(
      session({
        expiresAt: '2026-07-27T12:30:00Z',
        integrationId: 'integration_vector',
        integrationVersion: 1,
        partnerId: 'partner_vector',
        sessionPublicKey: SESSION_PUBLIC_KEY,
        walletAddress: WALLET,
        walletSubjectId: 'wallet_vector',
      }),
    ),
  });

  await expect(sdk.verifyQuote(quote)).resolves.toBeUndefined();
  const wrongPrice = structuredClone(quote);
  wrongPrice.payload.offer.price = '2000000';
  wrongPrice.payload.payment.amount = '2000000';
  await expect(sdk.verifyQuote(wrongPrice)).rejects.toMatchObject({
    name: EmberQuoteVerificationError.name,
    reason: 'unsupported_schema',
  });
});
