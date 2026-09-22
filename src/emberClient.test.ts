import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  EmberAbortError,
  EmberApiError,
  EmberChallengeValidationError,
  EmberConfigurationError,
  EmberEnvironmentMismatchError,
  EmberQuoteVerificationError,
  EmberResponseMismatchError,
  EmberSessionPersistenceError,
  EmberSessionRequiredError,
} from './errors';
import { base58Encode, webCrypto, type EmberCrypto } from './encoding';
import {
  EmberWalletClient,
  P10_WALLET_SCOPES,
  P11_WALLET_SCOPES,
  type SigningReview,
} from './emberClient';
import type { EmberTelemetryEvent } from './transport';
import type {
  AvailableOfferResponse,
  CoverageDecisionResponse,
  CoverageInstanceResponse,
  PaymentResponse,
  SignedQuoteResponse,
  WalletClaimResponse,
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

class FailingSaveSessionStore extends MemorySessionStore {
  clearAttempts = 0;

  override async save(): Promise<void> {
    throw new Error('secure storage unavailable');
  }

  override async clear(): Promise<void> {
    this.clearAttempts += 1;
    this.value = null;
  }
}

class FailingClearSessionStore extends MemorySessionStore {
  override async clear(): Promise<void> {
    throw new Error('secure storage unavailable');
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
    refreshToken: `refresh_session_wallet-sdk.${'A'.repeat(43)}`,
    scopes: [...P10_WALLET_SCOPES],
    sessionId: 'session_wallet-sdk',
    sessionPublicKey: SESSION_PUBLIC_KEY,
    walletAddress: WALLET,
    walletSubjectId: 'wallet_wallet-sdk',
    ...overrides,
  };
}

function nativeChallenge(
  requestedScopes: ReadonlyArray<WalletScope>,
  issuedAt = '2026-07-27T12:05:00.000Z',
) {
  const challengeId = 'challenge_11111111-1111-4111-8111-111111111111';
  const nonce = '111111111111111111111111';
  const expiresAt = new Date(Date.parse(issuedAt) + 5 * 60_000).toISOString();
  const bindingSha256 = createHash('sha256')
    .update(APPLICATION_ID)
    .digest('hex');
  const resources = [
    `urn:ember:integration:${INTEGRATION_ID}:1`,
    'urn:ember:environment:sandbox',
    `urn:ember:session-key:${SESSION_PUBLIC_KEY}`,
    'urn:ember:client-kind:native',
    `urn:ember:client-binding-sha256:${bindingSha256}`,
    ...requestedScopes.map((scope) => `urn:ember:scope:${scope}`),
  ];
  const message = [
    'api.ember.cover wants you to sign in with your Solana account:',
    WALLET,
    '',
    'Prove ownership of this wallet and authorize a short-lived Ember Cover session. This does not submit a transaction or move funds.',
    '',
    'URI: https://api.ember.cover/wallet-session',
    'Version: 1',
    'Chain ID: devnet',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
    `Request ID: ${challengeId}`,
    'Resources:',
    ...resources.map((resource) => `- ${resource}`),
  ].join('\n');
  return { challengeId, expiresAt, issuedAt, message, nonce };
}

function client(input: {
  crypto?: EmberCrypto;
  environment?: 'sandbox' | 'production';
  now?: () => Date;
  sessionSigner?: EmberMessageSigner;
  store?: MemorySessionStore;
  timeoutMs?: number;
  telemetry?: (event: EmberTelemetryEvent) => void;
  usePlatformFetch?: boolean;
}) {
  const store = input.store ?? new MemorySessionStore(session());
  const signer = input.sessionSigner ?? new CapturingSigner(SESSION_PUBLIC_KEY, 7);
  const sdk = new EmberWalletClient({
    baseUrl: API,
    crypto: input.crypto ?? deterministicCrypto(),
    environment: input.environment ?? 'sandbox',
    ...(input.usePlatformFetch ? {} : { fetch }),
    hostBinding: { kind: 'native', applicationId: APPLICATION_ID },
    integrationId: INTEGRATION_ID,
    integrationVersion: 1,
    now: input.now ?? (() => FIXED_NOW),
    retry: { maxBackoffMs: 2, maxRetries: 1, minBackoffMs: 1 },
    sessionSigner: signer,
    sessionStore: store,
    telemetry: input.telemetry,
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
    evaluationCountImpact: 0,
    allowance: { limit: 100, committed: 0, reserved: 1, available: 99 },
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

function coverage(
  overrides: Partial<CoverageInstanceResponse> = {},
): CoverageInstanceResponse {
  return {
    activatedAt: '2026-07-27T12:05:00.000Z',
    aggregateLimitMicros: '120000000000',
    appealWindowDays: 7,
    benefitPeriodCount: 12,
    benefitPeriodLimitMicros: '10000000000',
    coverageEndsAt: '2027-07-27T12:05:00.000Z',
    coverageInstanceId: 'coverage_wallet-sdk',
    coverageStartsAt: '2026-07-27T12:05:00.000Z',
    coveredTransactionLimit: 100,
    deductibleMicros: '0',
    delegateLossTailDays: 30,
    immediateLossClaimWindowDays: 7,
    offerId: 'offer_core-annual',
    offerVersion: 1,
    paymentId: 'payment_wallet-sdk',
    paymentSignature: '3'.repeat(64),
    perLossLimitMicros: '10000000000',
    policyVersion: 'policy-v0.1',
    protectedWallet: WALLET,
    quoteId: 'quote_wallet-sdk',
    status: 'active',
    termsVersion: 'terms-v0.1',
    waitingPeriodDays: 0,
    walletSubjectId: 'wallet_wallet-sdk',
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentResponse> = {}): PaymentResponse {
  return {
    paymentId: 'payment_wallet-sdk',
    paymentSignature: '3'.repeat(64),
    quoteId: 'quote_wallet-sdk',
    status: 'pending',
    submittedAt: '2026-07-27T12:05:00.000Z',
    updatedAt: '2026-07-27T12:05:00.000Z',
    ...overrides,
  };
}

function claim(
  overrides: Partial<WalletClaimResponse> = {},
): WalletClaimResponse {
  return {
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
      { occurredAt: '2026-07-27T12:05:00.000Z', status: 'submitted' },
    ],
    version: 1,
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
      return HttpResponse.json(nativeChallenge(requestedScopes));
    }),
    http.post(`${API}/v1/wallet-sessions`, async ({ request }) => {
      expect(request.headers.get('authorization')).toBeNull();
      expect(await request.json()).toEqual({
        challengeId: 'challenge_11111111-1111-4111-8111-111111111111',
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
    nativeChallenge(requestedScopes).message,
  );
  expect(opened.sessionPublicKey).toBe(SESSION_PUBLIC_KEY);
  expect(store.value?.refreshToken).toContain('refresh_');
});

test('opens a session when the API clock is at the accepted 60-second boundary', async () => {
  const store = new MemorySessionStore();
  const walletSigner = new CapturingSigner(WALLET, 9);
  const requestedScopes: WalletScope[] = ['offers:read', 'cover:evaluate'];
  server.use(
    http.post(`${API}/v1/wallet-sessions/challenges`, () =>
      HttpResponse.json(
        nativeChallenge(requestedScopes, '2026-07-27T12:06:00.000Z'),
      ),
    ),
    http.post(`${API}/v1/wallet-sessions`, () =>
      HttpResponse.json({
        ...session({ scopes: requestedScopes }),
        sessionPublicKey: undefined,
      }),
    ),
  );

  const { sdk } = client({ store });

  await expect(
    sdk.openSession({ requestedScopes, walletSigner }),
  ).resolves.toMatchObject({ walletAddress: WALLET });
  expect(walletSigner.messages).toHaveLength(1);
  expect(store.value?.walletAddress).toBe(WALLET);
});

test('never signs a challenge beyond the accepted clock-skew boundary', async () => {
  const store = new MemorySessionStore();
  const walletSigner = new CapturingSigner(WALLET, 9);
  const requestedScopes: WalletScope[] = ['offers:read', 'cover:evaluate'];
  let createAttempts = 0;
  server.use(
    http.post(`${API}/v1/wallet-sessions/challenges`, () =>
      HttpResponse.json(
        nativeChallenge(requestedScopes, '2026-07-27T12:06:00.001Z'),
      ),
    ),
    http.post(`${API}/v1/wallet-sessions`, () => {
      createAttempts += 1;
      return HttpResponse.json(session());
    }),
  );

  const { sdk } = client({ store });

  await expect(
    sdk.openSession({ requestedScopes, walletSigner }),
  ).rejects.toMatchObject({ reason: 'not_yet_valid' });
  expect(walletSigner.messages).toHaveLength(0);
  expect(createAttempts).toBe(0);
  expect(store.value).toBeNull();
});

test('never calls the protected-wallet signer for a tampered challenge', async () => {
  const store = new MemorySessionStore();
  const walletSigner = new CapturingSigner(WALLET, 9);
  const requestedScopes: WalletScope[] = ['offers:read', 'cover:evaluate'];
  let createAttempts = 0;
  server.use(
    http.post(`${API}/v1/wallet-sessions/challenges`, () => {
      const challenge = nativeChallenge(requestedScopes);
      return HttpResponse.json({
        ...challenge,
        message: challenge.message.replace(
          'urn:ember:environment:sandbox',
          'urn:ember:environment:production',
        ),
      });
    }),
    http.post(`${API}/v1/wallet-sessions`, () => {
      createAttempts += 1;
      return HttpResponse.json(session());
    }),
  );

  const { sdk } = client({ store });
  await expect(
    sdk.openSession({ requestedScopes, walletSigner }),
  ).rejects.toBeInstanceOf(EmberChallengeValidationError);
  expect(walletSigner.messages).toHaveLength(0);
  expect(createAttempts).toBe(0);
  expect(store.value).toBeNull();
});

test('clears a possibly partial credential write when session persistence fails', async () => {
  const store = new FailingSaveSessionStore();
  const requestedScopes: WalletScope[] = ['offers:read', 'cover:evaluate'];
  server.use(
    http.post(`${API}/v1/wallet-sessions/challenges`, () =>
      HttpResponse.json(nativeChallenge(requestedScopes)),
    ),
    http.post(`${API}/v1/wallet-sessions`, () =>
      HttpResponse.json({
        ...session({ scopes: requestedScopes }),
        sessionPublicKey: undefined,
      }),
    ),
  );
  const { sdk } = client({ store });

  await expect(
    sdk.openSession({
      requestedScopes,
      walletSigner: new CapturingSigner(WALLET, 9),
    }),
  ).rejects.toMatchObject({
    name: EmberSessionPersistenceError.name,
    operation: 'save',
  });
  expect(store.clearAttempts).toBe(1);
  expect(store.value).toBeNull();
});

test('ignores another client authority without deleting its valid session', async () => {
  const store = new MemorySessionStore(
    session({ integrationVersion: 2 }),
  );
  const { sdk } = client({ store });

  await expect(sdk.currentSession()).resolves.toBeNull();
  expect(store.value).toEqual(session({ integrationVersion: 2 }));
});

test('blocks rotation after refresh expiry without calling the session signer', async () => {
  const signer = new CapturingSigner(SESSION_PUBLIC_KEY, 7);
  const store = new MemorySessionStore(
    session({
      expiresAt: '2026-07-27T12:10:00.000Z',
      refreshExpiresAt: '2026-07-27T12:05:00.000Z',
    }),
  );
  const { sdk } = client({ sessionSigner: signer, store });

  await expect(
    sdk.rotateSession(
      new CapturingSigner('SysvarC1ock11111111111111111111111111111111', 8),
    ),
  ).rejects.toBeInstanceOf(EmberSessionRequiredError);
  expect(signer.messages).toHaveLength(0);
});

test('rotates only into the same session family authority', async () => {
  const nextSigner = new CapturingSigner(
    'SysvarC1ock11111111111111111111111111111111',
    8,
  );
  const store = new MemorySessionStore(
    session({
      expiresAt: '2026-07-27T12:15:00.000Z',
      refreshExpiresAt: '2026-07-28T12:00:00.000Z',
    }),
  );
  server.use(
    http.post(`${API}/v1/wallet-sessions/rotate`, async ({ request }) => {
      expect(await request.json()).toEqual({
        refreshToken: `refresh_session_wallet-sdk.${'A'.repeat(43)}`,
        sessionPublicKey: nextSigner.publicKey,
      });
      return HttpResponse.json(
        session({
          expiresAt: '2026-07-27T12:20:00.000Z',
          refreshExpiresAt: '2026-07-28T12:00:00.000Z',
          refreshToken: `refresh_session_rotated.${'Q'.repeat(42)}g`,
          sessionId: 'session_rotated',
          sessionPublicKey: undefined,
        }),
      );
    }),
  );

  const { sdk } = client({ store });
  await expect(sdk.rotateSession(nextSigner)).resolves.toMatchObject({
    sessionId: 'session_rotated',
    sessionPublicKey: nextSigner.publicKey,
  });
  expect(store.value).toMatchObject({ sessionId: 'session_rotated' });
});

test('rejects a cross-subject rotation response before persistence', async () => {
  const current = session({
    expiresAt: '2026-07-27T12:15:00.000Z',
    refreshExpiresAt: '2026-07-28T12:00:00.000Z',
  });
  const store = new MemorySessionStore(current);
  const nextSigner = new CapturingSigner(
    'SysvarC1ock11111111111111111111111111111111',
    8,
  );
  server.use(
    http.post(`${API}/v1/wallet-sessions/rotate`, () =>
      HttpResponse.json(
        session({
          expiresAt: '2026-07-27T12:20:00.000Z',
          refreshExpiresAt: current.refreshExpiresAt,
          refreshToken: `refresh_session_rotated.${'Q'.repeat(42)}g`,
          sessionId: 'session_rotated',
          sessionPublicKey: undefined,
          walletSubjectId: 'wallet_attacker',
        }),
      ),
    ),
  );

  const { sdk } = client({ store });
  await expect(sdk.rotateSession(nextSigner)).rejects.toBeInstanceOf(
    EmberSessionRequiredError,
  );
  expect(store.value).toEqual(current);
});

test('clears local authority after successful session revocation', async () => {
  const store = new MemorySessionStore(session());
  server.use(
    http.post(`${API}/v1/wallet-sessions/revoke`, () =>
      HttpResponse.json({ revokedSessions: 1 }),
    ),
  );
  const { sdk } = client({ store });

  await expect(sdk.revokeSession()).resolves.toEqual({ revokedSessions: 1 });
  expect(store.value).toBeNull();
});

test('reports local-clear failure after the server revokes the session', async () => {
  const store = new FailingClearSessionStore(session());
  server.use(
    http.post(`${API}/v1/wallet-sessions/revoke`, () =>
      HttpResponse.json({ revokedSessions: 1 }),
    ),
  );
  const { sdk } = client({ store });

  await expect(sdk.revokeSession()).rejects.toMatchObject({
    name: EmberSessionPersistenceError.name,
    operation: 'clear',
  });
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

test('rejects a valid offer response correlated to another resource', async () => {
  server.use(
    http.get(`${API}/v1/wallet/offers/offer_requested`, () =>
      HttpResponse.json(offer({ offerId: 'offer_other' })),
    ),
  );
  const { sdk } = client({});
  const error = await sdk.getOffer('offer_requested').catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    name: 'EmberResponseMismatchError',
    operation: 'offers.get',
    field: 'offerId',
    reason: 'resource_mismatch',
  });
  expect((error as Error).message).not.toContain('offer_requested');
  expect((error as Error).message).not.toContain('offer_other');
});

test('telemetry receives a static route template without the requested identifier', async () => {
  const events: EmberTelemetryEvent[] = [];
  server.use(
    http.get(`${API}/v1/wallet/offers/offer_customer-linked`, () =>
      HttpResponse.json(offer({ offerId: 'offer_customer-linked' })),
    ),
  );
  const { sdk } = client({ telemetry: (event) => events.push(event) });
  await sdk.getOffer('offer_customer-linked');
  expect(events).toEqual([
    expect.objectContaining({
      operation: 'offers.get',
      pathTemplate: '/v1/wallet/offers/{offerId}',
      outcome: 'success',
    }),
  ]);
  expect(JSON.stringify(events)).not.toContain('offer_customer-linked');
  expect(events[0]).not.toHaveProperty('path');
});

test('rejects a terms receipt for another wallet subject', async () => {
  server.use(
    http.post(`${API}/v1/wallet/terms-acceptances`, () =>
      HttpResponse.json({
        acceptanceId: 'acceptance_wallet-sdk',
        acceptedAt: '2026-07-27T12:05:00.000Z',
        documentSha256: 'a'.repeat(64),
        offerId: 'offer_core-annual',
        offerVersion: 1,
        termsVersion: 'terms-v0.1',
        walletSubjectId: 'wallet_other',
      }),
    ),
  );
  const { sdk } = client({});
  await expect(
    sdk.acceptTerms({
      documentSha256: 'a'.repeat(64),
      offerId: 'offer_core-annual',
      offerVersion: 1,
      termsVersion: 'terms-v0.1',
    }),
  ).rejects.toMatchObject({
    name: 'EmberResponseMismatchError',
    field: 'walletSubjectId',
    reason: 'authority_mismatch',
  });
});

test('rejects payment creation correlated to another signature', async () => {
  server.use(
    http.post(`${API}/v1/payments`, () =>
      HttpResponse.json({
        paymentId: 'payment_wallet-sdk',
        paymentSignature: '4'.repeat(64),
        quoteId: 'quote_wallet-sdk',
        status: 'pending',
        submittedAt: '2026-07-27T12:05:00.000Z',
        updatedAt: '2026-07-27T12:05:00.000Z',
      }),
    ),
  );
  const { sdk } = client({});
  await expect(
    sdk.createPayment({
      paymentSignature: '5'.repeat(64),
      quoteId: 'quote_wallet-sdk',
    }),
  ).rejects.toBeInstanceOf(EmberResponseMismatchError);
});

test('rejects coverage belonging to another active wallet subject', async () => {
  server.use(
    http.get(`${API}/v1/coverage-instances/coverage_wallet-sdk`, () =>
      HttpResponse.json(coverage({ walletSubjectId: 'wallet_other' })),
    ),
  );
  const { sdk } = client({});
  await expect(sdk.getCoverageInstance('coverage_wallet-sdk')).rejects.toMatchObject({
    name: 'EmberResponseMismatchError',
    field: 'walletSubjectId',
    reason: 'authority_mismatch',
  });
});

test('reviewForSigning fails open on a semantically mismatched decision', async () => {
  server.use(
    http.post(`${API}/v1/decisions`, () =>
      HttpResponse.json(decision({ coverageInstanceId: 'coverage_other' })),
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
    status: 'unavailable',
    coverStatus: 'unavailable',
    reason: 'response_mismatch',
  });
});

test('rejects a claim read that returns another claim or wallet', async () => {
  server.use(
    http.get(`${API}/v1/wallet/claims/claim_requested`, () =>
      HttpResponse.json(claim({ claimId: 'claim_other', protectedWallet: '2'.repeat(32) })),
    ),
  );
  const { sdk } = client({});
  await expect(sdk.getClaim('claim_requested')).rejects.toMatchObject({
    name: 'EmberResponseMismatchError',
    field: 'claimId',
    reason: 'resource_mismatch',
  });
});

test('returns only a correlated and validated evidence upload grant', async () => {
  server.use(
    http.post(`${API}/v1/wallet/claims/claim_wallet-sdk/evidence-uploads`, () =>
      HttpResponse.json({
        claimId: 'claim_wallet-sdk',
        evidenceCode: 'loss-proof',
        evidenceId: 'evidence_wallet-sdk',
        requestId: 'request_wallet-sdk',
        retentionUntil: '2027-07-27T12:05:00.000Z',
        status: 'pending_upload',
        upload: {
          expiresAt: '2026-07-27T12:15:00.000Z',
          headers: { 'content-type': 'application/pdf' },
          method: 'PUT',
          url: 'https://evidence.example/upload?signature=opaque',
        },
      }),
    ),
  );
  const { sdk } = client({});
  await expect(
    sdk.beginClaimEvidenceUpload('claim_wallet-sdk', {
      contentLength: '1024',
      contentType: 'application/pdf',
      evidenceCode: 'loss-proof',
      requestId: 'request_wallet-sdk',
      sha256: 'a'.repeat(64),
    }),
  ).resolves.toMatchObject({ evidenceId: 'evidence_wallet-sdk' });
});

test('rejects an evidence grant in an unexpected lifecycle state', async () => {
  server.use(
    http.post(`${API}/v1/wallet/claims/claim_wallet-sdk/evidence-uploads`, () =>
      HttpResponse.json({
        claimId: 'claim_wallet-sdk',
        evidenceCode: 'loss-proof',
        evidenceId: 'evidence_wallet-sdk',
        requestId: 'request_wallet-sdk',
        retentionUntil: '2027-07-27T12:05:00.000Z',
        status: 'uploaded',
        upload: {
          expiresAt: '2026-07-27T12:15:00.000Z',
          headers: {},
          method: 'PUT',
          url: 'https://evidence.example/upload',
        },
      }),
    ),
  );
  const { sdk } = client({});
  await expect(
    sdk.beginClaimEvidenceUpload('claim_wallet-sdk', {
      contentLength: '1024',
      contentType: 'application/pdf',
      evidenceCode: 'loss-proof',
      requestId: 'request_wallet-sdk',
      sha256: 'a'.repeat(64),
    }),
  ).rejects.toMatchObject({
    name: 'EmberResponseMismatchError',
    field: 'status',
    reason: 'unexpected_state',
  });
});

test('correlates evidence completion with both path identifiers', async () => {
  server.use(
    http.post(
      `${API}/v1/wallet/claims/claim_wallet-sdk/evidence-uploads/evidence_requested/complete`,
      () =>
        HttpResponse.json({
          claimId: 'claim_wallet-sdk',
          evidenceCode: 'loss-proof',
          evidenceId: 'evidence_other',
          requestId: 'request_wallet-sdk',
          retentionUntil: '2027-07-27T12:05:00.000Z',
          status: 'uploaded',
        }),
    ),
  );
  const { sdk } = client({});
  await expect(
    sdk.completeClaimEvidenceUpload('claim_wallet-sdk', 'evidence_requested'),
  ).rejects.toMatchObject({
    name: 'EmberResponseMismatchError',
    field: 'evidenceId',
    reason: 'resource_mismatch',
  });
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

test('retries payment creation with exact input and a fresh proof JTI', async () => {
  const bodies: string[] = [];
  const jtis = new Set<string>();
  let attempts = 0;
  const paymentSignature = '3'.repeat(64);
  server.use(
    http.post(`${API}/v1/payments`, async ({ request }) => {
      attempts += 1;
      bodies.push(await request.text());
      jtis.add(request.headers.get('x-ember-wallet-jti') ?? '');
      if (attempts === 1) {
        return HttpResponse.json(
          {
            details: [],
            error: 'service_unavailable',
            message: 'Try again.',
            requestId: 'req_payment_retry',
          },
          { status: 503 },
        );
      }
      return HttpResponse.json(payment({ paymentSignature }));
    }),
  );
  const { sdk } = client({});
  await expect(
    sdk.createPayment({ paymentSignature, quoteId: 'quote_wallet-sdk' }),
  ).resolves.toMatchObject({ paymentId: 'payment_wallet-sdk' });
  expect(attempts).toBe(2);
  expect(new Set(bodies).size).toBe(1);
  expect(jtis.size).toBe(2);
});

test('retries claim creation with one idempotency key and a fresh proof JTI', async () => {
  const keys = new Set<string>();
  const bodies: string[] = [];
  const jtis = new Set<string>();
  let attempts = 0;
  server.use(
    http.post(`${API}/v1/wallet/claims`, async ({ request }) => {
      attempts += 1;
      keys.add(request.headers.get('idempotency-key') ?? '');
      jtis.add(request.headers.get('x-ember-wallet-jti') ?? '');
      bodies.push(await request.text());
      if (attempts === 1) {
        return HttpResponse.json(
          {
            details: [],
            error: 'service_unavailable',
            message: 'Try again.',
            requestId: 'req_claim_retry',
          },
          { status: 503 },
        );
      }
      return HttpResponse.json(claim(), { status: 201 });
    }),
  );
  const store = new MemorySessionStore(
    session({ scopes: [...P11_WALLET_SCOPES] }),
  );
  const { sdk } = client({ store });
  await sdk.createClaim(
    {
      claimedAmountMicros: '1000000',
      decisionId: 'decision_wallet-sdk',
      lossEvent: 'direct_malicious_signing_loss',
      statement: 'Synthetic loss.',
    },
    { idempotencyKey: 'claim-retry-00000001' },
  );
  expect(attempts).toBe(2);
  expect(keys).toEqual(new Set(['claim-retry-00000001']));
  expect(new Set(bodies).size).toBe(1);
  expect(jtis.size).toBe(2);
});

test('caller cancellation stops read and replay-safe mutation requests', async () => {
  let requests = 0;
  server.use(
    http.get(`${API}/v1/wallet/offers`, () => {
      requests += 1;
      return HttpResponse.json({ offers: [offer()] });
    }),
    http.post(`${API}/v1/payments`, () => {
      requests += 1;
      return HttpResponse.json(payment());
    }),
  );
  const controller = new AbortController();
  controller.abort();
  const { sdk } = client({});

  await expect(
    sdk.listOffers({ signal: controller.signal }),
  ).rejects.toBeInstanceOf(EmberAbortError);
  await expect(
    sdk.createPayment(
      { paymentSignature: '3'.repeat(64), quoteId: 'quote_wallet-sdk' },
      { signal: controller.signal },
    ),
  ).rejects.toBeInstanceOf(EmberAbortError);
  expect(requests).toBe(0);
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

test('accepts correlated terms and completes payment create/read behavior', async () => {
  const paymentSignature = '3'.repeat(64);
  server.use(
    http.post(`${API}/v1/wallet/terms-acceptances`, async ({ request }) => {
      expect(await request.json()).toEqual({
        documentSha256: 'a'.repeat(64),
        offerId: 'offer_core-annual',
        offerVersion: 1,
        termsVersion: 'terms-v0.1',
      });
      return HttpResponse.json({
        acceptanceId: 'acceptance_wallet-sdk',
        acceptedAt: '2026-07-27T12:05:00.000Z',
        documentSha256: 'a'.repeat(64),
        offerId: 'offer_core-annual',
        offerVersion: 1,
        termsVersion: 'terms-v0.1',
        walletSubjectId: 'wallet_wallet-sdk',
      });
    }),
    http.post(`${API}/v1/payments`, async ({ request }) => {
      expect(await request.json()).toEqual({
        paymentSignature,
        quoteId: 'quote_wallet-sdk',
      });
      return HttpResponse.json(payment({ paymentSignature }));
    }),
    http.get(`${API}/v1/payments/payment_wallet-sdk`, () =>
      HttpResponse.json(
        payment({ coverageInstanceId: 'coverage_wallet-sdk', status: 'activated' }),
      ),
    ),
  );
  const { sdk } = client({});

  await expect(
    sdk.acceptTerms({
      documentSha256: 'a'.repeat(64),
      offerId: 'offer_core-annual',
      offerVersion: 1,
      termsVersion: 'terms-v0.1',
    }),
  ).resolves.toMatchObject({ acceptanceId: 'acceptance_wallet-sdk' });
  await expect(
    sdk.createPayment({ paymentSignature, quoteId: 'quote_wallet-sdk' }),
  ).resolves.toMatchObject({ paymentId: 'payment_wallet-sdk', status: 'pending' });
  await expect(sdk.getPayment('payment_wallet-sdk')).resolves.toMatchObject({
    coverageInstanceId: 'coverage_wallet-sdk',
    status: 'activated',
  });
});

test('completes coverage, decision, lineage, evidence, and eligibility reads', async () => {
  server.use(
    http.get(`${API}/v1/coverage-instances/coverage_wallet-sdk`, () =>
      HttpResponse.json(coverage()),
    ),
    http.get(`${API}/v1/decisions/decision_wallet-sdk`, () =>
      HttpResponse.json(decision()),
    ),
    http.get(`${API}/v1/decisions/decision_wallet-sdk/lineage`, () =>
      HttpResponse.json({
        coverageInstanceId: 'coverage_wallet-sdk',
        decisionId: 'decision_wallet-sdk',
        evidenceState: 'post_sign',
        lifecycle: [
          { occurredAt: '2026-07-27T12:05:00.000Z', status: 'reviewed' },
        ],
        paymentId: 'payment_wallet-sdk',
        quoteId: 'quote_wallet-sdk',
      }),
    ),
    http.post(
      `${API}/v1/decisions/decision_wallet-sdk/post-sign`,
      async ({ request }) => {
        expect(await request.json()).toEqual({
          kind: 'transaction',
          signedBytes: 'AAAA',
        });
        return HttpResponse.json({
          accepted: true,
          decisionId: 'decision_wallet-sdk',
          evidenceState: 'confirmation',
          transactionSignature: '4'.repeat(64),
        });
      },
    ),
    http.get(
      `${API}/v1/wallet/decisions/decision_wallet-sdk/claim-eligibility`,
      () =>
        HttpResponse.json({
          decisionId: 'decision_wallet-sdk',
          eligible: true,
        }),
    ),
  );
  const { sdk } = client({});

  await expect(sdk.getCoverageInstance('coverage_wallet-sdk')).resolves.toMatchObject({
    coverageInstanceId: 'coverage_wallet-sdk',
  });
  await expect(sdk.getDecision('decision_wallet-sdk')).resolves.toMatchObject({
    decisionId: 'decision_wallet-sdk',
  });
  await expect(sdk.getDecisionLineage('decision_wallet-sdk')).resolves.toMatchObject({
    evidenceState: 'post_sign',
  });
  await expect(
    sdk.submitDecisionEvidence('decision_wallet-sdk', {
      kind: 'transaction',
      signedBytes: 'AAAA',
    }),
  ).resolves.toMatchObject({ accepted: true, evidenceState: 'confirmation' });
  await expect(sdk.claimEligibility('decision_wallet-sdk')).resolves.toEqual({
    decisionId: 'decision_wallet-sdk',
    eligible: true,
  });
});

test('completes claim list, read, appeal, and evidence completion behavior', async () => {
  server.use(
    http.get(`${API}/v1/wallet/claims`, () =>
      HttpResponse.json({ claims: [claim()] }),
    ),
    http.get(`${API}/v1/wallet/claims/claim_wallet-sdk`, () =>
      HttpResponse.json(claim()),
    ),
    http.post(
      `${API}/v1/wallet/claims/claim_wallet-sdk/appeals`,
      async ({ request }) => {
        expect(await request.json()).toEqual({ reason: 'Independent review requested.' });
        return HttpResponse.json(claim({ state: 'appealed' }));
      },
    ),
    http.post(
      `${API}/v1/wallet/claims/claim_wallet-sdk/evidence-uploads/evidence_wallet-sdk/complete`,
      () =>
        HttpResponse.json({
          claimId: 'claim_wallet-sdk',
          evidenceCode: 'loss-proof',
          evidenceId: 'evidence_wallet-sdk',
          requestId: 'request_wallet-sdk',
          retentionUntil: '2027-07-27T12:05:00.000Z',
          status: 'uploaded',
        }),
    ),
  );
  const store = new MemorySessionStore(
    session({ scopes: [...P11_WALLET_SCOPES] }),
  );
  const { sdk } = client({ store });

  await expect(sdk.listClaims()).resolves.toMatchObject({
    claims: [{ claimId: 'claim_wallet-sdk' }],
  });
  await expect(sdk.getClaim('claim_wallet-sdk')).resolves.toMatchObject({
    state: 'submitted',
  });
  await expect(
    sdk.appealClaim('claim_wallet-sdk', {
      reason: 'Independent review requested.',
    }),
  ).resolves.toMatchObject({ state: 'appealed' });
  await expect(
    sdk.completeClaimEvidenceUpload('claim_wallet-sdk', 'evidence_wallet-sdk'),
  ).resolves.toMatchObject({ status: 'uploaded' });
});

test('revoke-all and explicit local clearing remove persisted authority', async () => {
  server.use(
    http.post(`${API}/v1/wallet-sessions/revoke-all`, () =>
      HttpResponse.json({ revokedSessions: 3 }),
    ),
  );
  const firstStore = new MemorySessionStore(session());
  const { sdk: revokeAllClient } = client({ store: firstStore });
  await expect(revokeAllClient.revokeAllSessions()).resolves.toEqual({
    revokedSessions: 3,
  });
  expect(firstStore.value).toBeNull();

  const secondStore = new MemorySessionStore(session());
  const { sdk: localClient } = client({ store: secondStore });
  await localClient.clearLocalSession();
  expect(secondStore.value).toBeNull();
  await expect(localClient.currentSession()).resolves.toBeNull();
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

test('non-idempotent terms, appeal, and upload-begin mutations never retry', async () => {
  const attempts = { appeal: 0, begin: 0, terms: 0 };
  const unavailable = () =>
    HttpResponse.json(
      {
        details: [],
        error: 'service_unavailable',
        message: 'Try again.',
        requestId: 'req_non_idempotent',
      },
      { status: 503 },
    );
  server.use(
    http.post(`${API}/v1/wallet/terms-acceptances`, () => {
      attempts.terms += 1;
      return unavailable();
    }),
    http.post(`${API}/v1/wallet/claims/claim_wallet-sdk/appeals`, () => {
      attempts.appeal += 1;
      return unavailable();
    }),
    http.post(
      `${API}/v1/wallet/claims/claim_wallet-sdk/evidence-uploads`,
      () => {
        attempts.begin += 1;
        return unavailable();
      },
    ),
  );
  const store = new MemorySessionStore(
    session({ scopes: [...P11_WALLET_SCOPES] }),
  );
  const { sdk } = client({ store });

  await expect(
    sdk.acceptTerms({
      documentSha256: 'a'.repeat(64),
      offerId: 'offer_core-annual',
      offerVersion: 1,
      termsVersion: 'terms-v0.1',
    }),
  ).rejects.toBeInstanceOf(EmberApiError);
  await expect(
    sdk.appealClaim('claim_wallet-sdk', { reason: 'Independent review.' }),
  ).rejects.toBeInstanceOf(EmberApiError);
  await expect(
    sdk.beginClaimEvidenceUpload('claim_wallet-sdk', {
      contentLength: '1024',
      contentType: 'application/pdf',
      evidenceCode: 'loss-proof',
      requestId: 'request_wallet-sdk',
      sha256: 'a'.repeat(64),
    }),
  ).rejects.toBeInstanceOf(EmberApiError);
  expect(attempts).toEqual({ appeal: 1, begin: 1, terms: 1 });
});

test('creates and verifies a correlated signed quote before returning it', async () => {
  const vector = JSON.parse(
    await readFile(
      new URL('../fixtures/signed-quote-vector-v1.json', import.meta.url),
      'utf8',
    ),
  ) as SignedQuoteResponse;
  server.use(
    http.post('https://api.ember.test/v1/quotes', async ({ request }) => {
      expect(await request.json()).toEqual({ offerId: vector.payload.offer.offerId });
      return HttpResponse.json(vector);
    }),
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
  const sdk = new EmberWalletClient({
    baseUrl: 'https://api.ember.test',
    crypto: webCrypto(),
    environment: 'production',
    fetch,
    hostBinding: { kind: 'native', applicationId: APPLICATION_ID },
    integrationId: 'integration_vector',
    integrationVersion: 1,
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

  await expect(
    sdk.createQuote({ offerId: vector.payload.offer.offerId }),
  ).resolves.toMatchObject({
    payload: vector.payload,
    payloadSha256: vector.payloadSha256,
    signature: vector.signature,
    signingPublicKey: vector.signingPublicKey,
  });
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
    crypto: webCrypto(),
    environment: 'production',
    fetch,
    hostBinding: { kind: 'native', applicationId: APPLICATION_ID },
    integrationId: 'integration_vector',
    integrationVersion: 1,
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

test('allows bounded quote issuer clock skew while keeping expiry strict', async () => {
  const vector = JSON.parse(
    await readFile(
      new URL('../fixtures/signed-quote-vector-v1.json', import.meta.url),
      'utf8',
    ),
  ) as SignedQuoteResponse;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signingPublicKey = base58Encode(
    publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  );
  const domain = Buffer.from(
    '656d6265722d7369676e65642d71756f74652d763100',
    'hex',
  );
  const signedQuote = (issuedAt: string, expiresAt: string): SignedQuoteResponse => {
    const payload = structuredClone(vector.payload);
    payload.validity = { issuedAt, expiresAt };
    const canonical = new TextEncoder().encode(JSON.stringify(payload));
    return {
      payload,
      payloadSha256: createHash('sha256').update(canonical).digest('hex'),
      signature: base58Encode(
        signBytes(null, Buffer.concat([domain, canonical]), privateKey),
      ),
      signingPublicKey,
    };
  };
  server.use(
    http.get('https://api.ember.test/v1/quote-signing-keys', () =>
      HttpResponse.json({
        keys: [
          {
            algorithm: 'ed25519',
            createdAt: '2026-07-27T11:00:00Z',
            keyId: vector.payload.signingKeyId,
            mode: vector.payload.mode,
            publicKey: signingPublicKey,
            state: 'active',
            updatedAt: '2026-07-27T11:00:00Z',
          },
        ],
      }),
    ),
  );
  const sdk = new EmberWalletClient({
    baseUrl: 'https://api.ember.test',
    crypto: webCrypto(),
    environment: 'production',
    fetch,
    hostBinding: { kind: 'native', applicationId: APPLICATION_ID },
    integrationId: 'integration_vector',
    integrationVersion: 1,
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

  await expect(
    sdk.verifyQuote(
      signedQuote('2026-07-27T12:06:00.000Z', '2026-07-27T12:21:00.000Z'),
    ),
  ).resolves.toBeUndefined();
  await expect(
    sdk.verifyQuote(
      signedQuote('2026-07-27T12:06:00.001Z', '2026-07-27T12:21:00.001Z'),
    ),
  ).rejects.toMatchObject({
    name: EmberQuoteVerificationError.name,
    reason: 'not_yet_valid',
  });
  await expect(
    sdk.verifyQuote(
      signedQuote('2026-07-27T11:50:00.000Z', '2026-07-27T12:05:00.000Z'),
    ),
  ).rejects.toMatchObject({
    name: EmberQuoteVerificationError.name,
    reason: 'expired',
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
    crypto: webCrypto(),
    environment: 'production',
    fetch,
    hostBinding: { kind: 'native', applicationId: APPLICATION_ID },
    integrationId: 'integration_vector',
    integrationVersion: 1,
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
    crypto: webCrypto(),
    environment: 'sandbox',
    fetch,
    hostBinding: { kind: 'native', applicationId: APPLICATION_ID },
    integrationId: 'integration_vector',
    integrationVersion: 1,
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


test('discovers current coverage in one read and validates the wallet authority', async () => {
  let reads = 0;
  server.use(http.get(`${API}/v1/coverage-instances/current`, () => {
    reads += 1;
    return HttpResponse.json({ status: 'active', coverage: coverage(), allowance: { limit: 100, committed: 2, reserved: 1, available: 97 } });
  }));
  const { sdk } = client({});
  await expect(sdk.getCurrentCoverage()).resolves.toMatchObject({ status: 'active', allowance: { available: 97 } });
  expect(reads).toBe(1);
  server.use(http.get(`${API}/v1/coverage-instances/current`, () => HttpResponse.json({ status: 'none' })));
  await expect(sdk.getCurrentCoverage()).resolves.toEqual({ status: 'none' });
  server.use(http.get(`${API}/v1/coverage-instances/current`, () => HttpResponse.json({
    status: 'active', coverage: coverage({ walletSubjectId: 'wallet_other' }),
    allowance: { limit: 100, committed: 0, reserved: 0, available: 100 },
  })));
  await expect(sdk.getCurrentCoverage()).rejects.toMatchObject({ reason: 'authority_mismatch' });
});

test('returns cancellation outcomes without claiming a refund when evidence won', async () => {
  const { sdk } = client({});
  for (const cancelled of [true, false]) {
    server.use(http.post(`${API}/v1/decisions/decision_wallet-sdk/cancel`, () => HttpResponse.json({
      decisionId: 'decision_wallet-sdk', cancelled, evidenceState: cancelled ? 'dropped' : 'post_sign',
    })));
    await expect(sdk.cancelDecision('decision_wallet-sdk')).resolves.toMatchObject({ cancelled });
  }
  server.use(http.post(`${API}/v1/decisions/decision_wallet-sdk/cancel`, () => HttpResponse.json({
    decisionId: 'decision_wrong', cancelled: true, evidenceState: 'dropped',
  })));
  await expect(sdk.cancelDecision('decision_wallet-sdk')).rejects.toMatchObject({ reason: 'resource_mismatch' });
});

test.each(['dropped', 'post_sign', 'confirmation', 'sealed', 'conflict'] as const)(
  'does not present a %s decision as fresh covered signing authority', async (evidenceState) => {
    server.use(http.post(`${API}/v1/decisions`, () => HttpResponse.json(decision({ evidenceState }))));
    const { sdk } = client({});
    await expect(sdk.reviewForSigning({ coverageInstanceId: 'coverage_wallet-sdk', kind: 'transaction', transactionBytes: 'AAAA' }))
      .resolves.toMatchObject({ status: 'unavailable', reason: 'response_mismatch' });
  },
);
