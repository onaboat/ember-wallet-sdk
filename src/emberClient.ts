import type { ZodType } from 'zod';
import { base58Decode, base58Encode, sha256Hex, utf8 } from './encoding';
import { validateWalletChallenge } from './challenge';
import {
  EmberAbortError,
  EmberApiError,
  EmberConfigurationError,
  EmberEnvironmentMismatchError,
  EmberNetworkError,
  EmberQuoteVerificationError,
  EmberResponseMismatchError,
  type EmberResponseMismatchReason,
  EmberResponseValidationError,
  EmberSessionPersistenceError,
  EmberSessionRequiredError,
  EmberSigningError,
  EmberTimeoutError,
} from './errors';
import { assertEvidenceUploadGrant } from './responseIntegrity';
import type {
  AcceptTermsRequest,
  AppealClaimRequest,
  AvailableOfferListResponse,
  AvailableOfferResponse,
  BeginEvidenceUploadRequest,
  ClaimEligibilityResponse,
  CoverageDecisionResponse,
  CoverageInstanceResponse,
  CreateClaimRequest,
  CreateCoverageDecisionRequest,
  CreatePaymentRequest,
  CreateQuoteRequest,
  DecisionLineageResponse,
  EvidenceUploadResponse,
  IntegrationEnvironment,
  PaymentResponse,
  QuotePayloadResponse,
  QuoteSigningKeysResponse,
  RevocationResponse,
  RevokeSessionRequest,
  SignedQuoteResponse,
  SubmitDecisionEvidenceRequest,
  SubmitDecisionEvidenceResponse,
  TermsAcceptanceResponse,
  WalletChallengeResponse,
  WalletClaimListResponse,
  WalletClaimResponse,
  WalletScope,
  WalletSessionResponse,
} from './generated/types.gen';
import {
  zAvailableOfferListResponse,
  zAvailableOfferResponse,
  zClaimEligibilityResponse,
  zCoverageDecisionResponse,
  zCoverageInstanceResponse,
  zDecisionLineageResponse,
  zEvidenceUploadResponse,
  zPaymentResponse,
  zQuoteSigningKeysResponse,
  zRevocationResponse,
  zSignedQuoteResponse,
  zSubmitDecisionEvidenceResponse,
  zTermsAcceptanceResponse,
  zWalletClaimListResponse,
  zWalletClaimResponse,
  zWalletChallengeResponse,
  zWalletSessionResponse,
} from './generated/zod.gen';
import {
  type EmberMessageSigner,
  type OpenWalletSessionInput,
  parsePersistedWalletSession,
  type PersistedWalletSession,
  sessionState,
  type WalletSessionStore,
} from './session';
import {
  EmberTransport,
  type EmberRequestOptions,
  type EmberTransportConfig,
} from './transport';

const QUOTE_DOMAIN = utf8('ember-signed-quote-v1\u0000');
const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const CLASSIC_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const DEVNET_QA_OFFER_ID = 'offer_devnet-qa-core-annual';
const DEVNET_QA_PRICE_BASE_UNITS = '1000000';

export const P10_WALLET_SCOPES = [
  'offers:read',
  'terms:accept',
  'quotes:create',
  'payments:create',
  'cover:evaluate',
  'evidence:write',
  'records:read',
] as const satisfies ReadonlyArray<WalletScope>;

/** Complete wallet authority through the P11 claims lifecycle. */
export const P11_WALLET_SCOPES = [
  ...P10_WALLET_SCOPES,
  'claims:create',
] as const satisfies ReadonlyArray<WalletScope>;

export interface EmberWalletClientConfig extends EmberTransportConfig {
  integrationId: string;
  integrationVersion: number;
  sessionSigner: EmberMessageSigner;
  sessionStore: WalletSessionStore;
}

export type SigningReview =
  | {
      status: 'reviewed';
      decision: CoverageDecisionResponse;
    }
  | {
      status: 'not_covered';
      coverStatus: 'not_covered';
      reason: 'coverage_limit_reached';
      requestId?: string;
    }
  | {
      status: 'unavailable';
      coverStatus: 'unavailable';
      reason:
        | 'aborted'
        | 'api_error'
        | 'configuration'
        | 'environment'
        | 'invalid_response'
        | 'network'
        | 'response_mismatch'
        | 'session'
        | 'signing'
        | 'timeout'
        | 'unknown';
      requestId?: string;
    };

function expectedCluster(environment: IntegrationEnvironment): 'devnet' | 'mainnet-beta' {
  return environment === 'production' ? 'mainnet-beta' : 'devnet';
}

function hasCoreAnnualBenefitSchedule(payload: QuotePayloadResponse): boolean {
  return Boolean(
    payload.benefitSchedule &&
      payload.benefitSchedule.coverageDurationMonths === 12 &&
      payload.benefitSchedule.benefitPeriodCount === 12 &&
      payload.benefitSchedule.benefitPeriodLimit === '10000000000' &&
      payload.offer.coverageDurationDays === 365 &&
      payload.offer.perLossLimit === '10000000000' &&
      payload.offer.aggregateLimit === '120000000000',
  );
}

function isDevnetQaQuote(payload: QuotePayloadResponse): boolean {
  return (
    payload.mode === 'test' &&
    payload.schemaVersion === 3 &&
    payload.paymentAllowed &&
    payload.createsCoverage &&
    hasCoreAnnualBenefitSchedule(payload) &&
    payload.offer.environment === 'sandbox' &&
    payload.offer.cluster === 'devnet' &&
    payload.offer.offerId === DEVNET_QA_OFFER_ID &&
    payload.offer.productCode === 'core' &&
    payload.offer.paymentAsset === 'USDC' &&
    payload.offer.price === DEVNET_QA_PRICE_BASE_UNITS &&
    payload.payment.amount === DEVNET_QA_PRICE_BASE_UNITS &&
    payload.payment.decimals === 6 &&
    payload.payment.genesisHash === DEVNET_GENESIS_HASH &&
    payload.payment.mint === DEVNET_USDC_MINT &&
    payload.payment.tokenProgram === CLASSIC_TOKEN_PROGRAM &&
    Boolean(payload.payment.treasuryOwner)
  );
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function assertCanonicalSignerKey(signer: EmberMessageSigner, label: string): void {
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(signer.publicKey);
  } catch {
    throw new EmberConfigurationError(
      `${label} must expose a canonical base58 Solana Ed25519 public key.`,
    );
  }
  if (bytes.length !== 32) {
    throw new EmberConfigurationError(
      `${label} must expose an exact 32-byte Solana Ed25519 public key.`,
    );
  }
}

function canonicalQuotePayload(payload: QuotePayloadResponse): Uint8Array {
  const commission =
    payload.offer.commission.reference === undefined
      ? { kind: payload.offer.commission.kind }
      : {
          kind: payload.offer.commission.kind,
          reference: payload.offer.commission.reference,
        };
  const payment =
    payload.payment.treasuryOwner === undefined
      ? {
          genesisHash: payload.payment.genesisHash,
          mint: payload.payment.mint,
          tokenProgram: payload.payment.tokenProgram,
          treasuryTokenAccount: payload.payment.treasuryTokenAccount,
          amount: payload.payment.amount,
          decimals: payload.payment.decimals,
          reference: payload.payment.reference,
        }
      : {
          genesisHash: payload.payment.genesisHash,
          mint: payload.payment.mint,
          tokenProgram: payload.payment.tokenProgram,
          treasuryTokenAccount: payload.payment.treasuryTokenAccount,
          treasuryOwner: payload.payment.treasuryOwner,
          amount: payload.payment.amount,
          decimals: payload.payment.decimals,
          reference: payload.payment.reference,
        };
  const canonical = {
    schemaVersion: payload.schemaVersion,
    quoteId: payload.quoteId,
    signingKeyId: payload.signingKeyId,
    mode: payload.mode,
    partnerId: payload.partnerId,
    integrationId: payload.integrationId,
    integrationVersion: payload.integrationVersion,
    walletSubjectId: payload.walletSubjectId,
    termsAcceptanceId: payload.termsAcceptanceId,
    protectedWallet: payload.protectedWallet,
    payerWallet: payload.payerWallet,
    offer: {
      snapshotSchemaVersion: payload.offer.snapshotSchemaVersion,
      snapshotSha256: payload.offer.snapshotSha256,
      offerId: payload.offer.offerId,
      offerVersion: payload.offer.offerVersion,
      availabilityId: payload.offer.availabilityId,
      productCode: payload.offer.productCode,
      environment: payload.offer.environment,
      cluster: payload.offer.cluster,
      paymentAsset: payload.offer.paymentAsset,
      price: payload.offer.price,
      paymentAssetDecimals: payload.offer.paymentAssetDecimals,
      coverageDurationDays: payload.offer.coverageDurationDays,
      protectedWalletCount: payload.offer.protectedWalletCount,
      payerMustEqualProtectedWallet: payload.offer.payerMustEqualProtectedWallet,
      perLossLimit: payload.offer.perLossLimit,
      aggregateLimit: payload.offer.aggregateLimit,
      coveredTransactionLimit: payload.offer.coveredTransactionLimit,
      deductible: payload.offer.deductible,
      waitingPeriodDays: payload.offer.waitingPeriodDays,
      immediateLossClaimWindowDays:
        payload.offer.immediateLossClaimWindowDays,
      delegateLossTailDays: payload.offer.delegateLossTailDays,
      appealWindowDays: payload.offer.appealWindowDays,
      cancellationRuleCode: payload.offer.cancellationRuleCode,
      refundRuleCode: payload.offer.refundRuleCode,
      termsVersion: payload.offer.termsVersion,
      termsHash: payload.offer.termsHash,
      policyVersion: payload.offer.policyVersion,
      policyHash: payload.offer.policyHash,
      catalogueHash: payload.offer.catalogueHash,
      commission,
      resolvedAt: payload.offer.resolvedAt,
    },
    ...(payload.benefitSchedule === undefined ||
    payload.benefitSchedule === null
      ? {}
      : {
          benefitSchedule: {
            coverageDurationMonths:
              payload.benefitSchedule.coverageDurationMonths,
            benefitPeriodCount: payload.benefitSchedule.benefitPeriodCount,
            benefitPeriodLimit: payload.benefitSchedule.benefitPeriodLimit,
          },
        }),
    payment,
    validity: {
      issuedAt: payload.validity.issuedAt,
      expiresAt: payload.validity.expiresAt,
    },
    nonce: payload.nonce,
    paymentAllowed: payload.paymentAllowed,
    createsCoverage: payload.createsCoverage,
  };
  return utf8(JSON.stringify(canonical));
}

function sameScopes(
  requested: ReadonlyArray<WalletScope>,
  returned: ReadonlyArray<WalletScope>,
): boolean {
  return (
    requested.length === returned.length &&
    requested.every((scope) => returned.includes(scope))
  );
}

function unavailableReview(error: unknown): SigningReview {
  if (
    error instanceof EmberApiError &&
    error.code === 'coverage_limit_reached'
  ) {
    return {
      status: 'not_covered',
      coverStatus: 'not_covered',
      reason: 'coverage_limit_reached',
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
  }
  const requestId = error instanceof EmberApiError ? error.requestId : undefined;
  const reason =
    error instanceof EmberTimeoutError
      ? 'timeout'
      : error instanceof EmberAbortError
        ? 'aborted'
        : error instanceof EmberNetworkError
          ? 'network'
          : error instanceof EmberResponseMismatchError
            ? 'response_mismatch'
          : error instanceof EmberResponseValidationError
            ? 'invalid_response'
            : error instanceof EmberSigningError
              ? 'signing'
              : error instanceof EmberEnvironmentMismatchError
                ? 'environment'
                : error instanceof EmberSessionRequiredError
                  ? 'session'
                  : error instanceof EmberConfigurationError
                    ? 'configuration'
                    : error instanceof EmberApiError
                      ? 'api_error'
                      : 'unknown';
  return {
    status: 'unavailable',
    coverStatus: 'unavailable',
    reason,
    ...(requestId ? { requestId } : {}),
  };
}

export class EmberWalletClient {
  private readonly transport: EmberTransport;
  private sessionSigner: EmberMessageSigner;

  constructor(private readonly config: EmberWalletClientConfig) {
    if (
      config.integrationId.length > 96 ||
      !/^integration_[a-z0-9-]+$/.test(config.integrationId)
    ) {
      throw new EmberConfigurationError(
        'integrationId must be a canonical Ember integration identifier.',
      );
    }
    if (
      !Number.isSafeInteger(config.integrationVersion) ||
      config.integrationVersion < 0 ||
      config.integrationVersion > 2_147_483_647
    ) {
      throw new EmberConfigurationError(
        'integrationVersion must be a nonnegative signed 32-bit integer.',
      );
    }
    assertCanonicalSignerKey(config.sessionSigner, 'sessionSigner');
    this.transport = new EmberTransport(config);
    this.sessionSigner = config.sessionSigner;
  }

  async openSession(input: OpenWalletSessionInput): Promise<PersistedWalletSession> {
    this.assertScopes(input.requestedScopes);
    assertCanonicalSignerKey(input.walletSigner, 'walletSigner');
    if (input.walletSigner.publicKey === this.sessionSigner.publicKey) {
      throw new EmberConfigurationError(
        'The wallet signer and ephemeral session signer must use different keys.',
      );
    }
    const challenge = await this.transport.publicRequest({
      body: {
        client: this.transport.walletClientBindingRequest(),
        integrationId: this.config.integrationId,
        requestedScopes: [...input.requestedScopes],
        sessionPublicKey: this.sessionSigner.publicKey,
        walletAddress: input.walletSigner.publicKey,
      },
      method: 'POST',
      operation: 'wallet_session.challenge',
      path: '/v1/wallet-sessions/challenges',
      pathTemplate: '/v1/wallet-sessions/challenges',
      schema: zWalletChallengeResponse,
      timeoutMs: this.transport.timeouts.bootstrapMs,
    });
    await validateWalletChallenge(
      challenge,
      {
        environment: this.config.environment,
        hostBinding: this.config.hostBinding,
        integrationId: this.config.integrationId,
        integrationVersion: this.config.integrationVersion,
        requestedScopes: input.requestedScopes,
        sessionPublicKey: this.sessionSigner.publicKey,
        walletAddress: input.walletSigner.publicKey,
      },
      this.transport.currentDate(),
      this.transport.crypto,
    );
    let signature: Uint8Array;
    try {
      signature = await input.walletSigner.signMessage(utf8(challenge.message));
    } catch (cause) {
      throw new EmberSigningError('The protected-wallet challenge signer failed.', {
        cause,
      });
    }
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new EmberConfigurationError(
        'Wallet signer must return an exact 64-byte Ed25519 signature.',
      );
    }
    const response = await this.transport.publicRequest({
      body: {
        challengeId: challenge.challengeId,
        signature: base58Encode(signature),
      },
      method: 'POST',
      operation: 'wallet_session.create',
      path: '/v1/wallet-sessions',
      pathTemplate: '/v1/wallet-sessions',
      schema: zWalletSessionResponse,
      timeoutMs: this.transport.timeouts.bootstrapMs,
    });
    this.assertNewSession(
      response,
      input.walletSigner.publicKey,
      input.requestedScopes,
    );
    const persisted = this.validatedPersistedSession(
      response,
      this.sessionSigner.publicKey,
    );
    await this.persistSession(persisted);
    return persisted;
  }

  async rotateSession(
    nextSigner: EmberMessageSigner,
    options?: EmberRequestOptions,
  ): Promise<PersistedWalletSession> {
    assertCanonicalSignerKey(nextSigner, 'nextSigner');
    if (nextSigner.publicKey === this.sessionSigner.publicKey) {
      throw new EmberConfigurationError('Session rotation requires a new key.');
    }
    const current = await this.requireSession();
    if (
      sessionState(current, this.transport.currentDate(), 0).status ===
      'refresh_window_expired'
    ) {
      throw new EmberSessionRequiredError(
        'The Ember wallet session refresh window has expired.',
      );
    }
    const response = await this.transport.signedRequest(
      {
        body: {
          refreshToken: current.refreshToken,
          sessionPublicKey: nextSigner.publicKey,
        },
        idempotent: false,
        method: 'POST',
        operation: 'wallet_session.rotate',
        options,
        path: '/v1/wallet-sessions/rotate',
        pathTemplate: '/v1/wallet-sessions/rotate',
        schema: zWalletSessionResponse,
        timeoutMs: this.transport.timeouts.mutationMs,
      },
      current,
      this.sessionSigner,
    );
    this.assertNewSession(response, current.walletAddress, current.scopes);
    if (
      response.partnerId !== current.partnerId ||
      response.walletSubjectId !== current.walletSubjectId ||
      Date.parse(response.refreshExpiresAt) !==
        Date.parse(current.refreshExpiresAt) ||
      response.sessionId === current.sessionId ||
      response.refreshToken === current.refreshToken
    ) {
      throw new EmberSessionRequiredError(
        'The rotated Ember session does not preserve the current session family authority.',
      );
    }
    const persisted = this.validatedPersistedSession(
      response,
      nextSigner.publicKey,
    );
    await this.persistSession(persisted);
    this.sessionSigner = nextSigner;
    return persisted;
  }

  async revokeSession(
    request: RevokeSessionRequest = {},
    options?: EmberRequestOptions,
  ): Promise<RevocationResponse> {
    return this.revoke('/v1/wallet-sessions/revoke', request, options);
  }

  async revokeAllSessions(
    request: RevokeSessionRequest = {},
    options?: EmberRequestOptions,
  ): Promise<RevocationResponse> {
    return this.revoke('/v1/wallet-sessions/revoke-all', request, options);
  }

  async currentSession(): Promise<PersistedWalletSession | null> {
    const stored = await this.config.sessionStore.load();
    const session = parsePersistedWalletSession(stored);
    const matchesClient =
      session !== null &&
      session.sessionPublicKey === this.sessionSigner.publicKey &&
      session.integrationId === this.config.integrationId &&
      session.integrationVersion === this.config.integrationVersion &&
      session.environment === this.config.environment;
    if (stored !== null && !session) {
      await this.clearPersistedSession();
    }
    return matchesClient ? session : null;
  }

  async clearLocalSession(): Promise<void> {
    await this.clearPersistedSession();
  }

  async listOffers(options?: EmberRequestOptions): Promise<AvailableOfferListResponse> {
    const response = await this.authenticated(
      {
        idempotent: true,
        method: 'GET',
        operation: 'offers.list',
        options,
        path: '/v1/wallet/offers',
        pathTemplate: '/v1/wallet/offers',
        schema: zAvailableOfferListResponse,
        timeoutMs: this.transport.timeouts.readMs,
      },
    );
    for (const offer of response.offers) this.assertOfferEnvironment(offer);
    return response;
  }

  async getOffer(
    offerId: string,
    options?: EmberRequestOptions,
  ): Promise<AvailableOfferResponse> {
    const response = await this.authenticated({
      idempotent: true,
      method: 'GET',
      operation: 'offers.get',
      options,
      path: `/v1/wallet/offers/${encodeURIComponent(offerId)}`,
      pathTemplate: '/v1/wallet/offers/{offerId}',
      schema: zAvailableOfferResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
    this.assertMatch(
      'offers.get',
      'offerId',
      response.offerId,
      offerId,
      'resource_mismatch',
    );
    this.assertOfferEnvironment(response);
    return response;
  }

  async acceptTerms(
    request: AcceptTermsRequest,
    options?: EmberRequestOptions,
  ): Promise<TermsAcceptanceResponse> {
    const { response, session } = await this.authenticatedWithSession({
      body: request,
      idempotent: false,
      method: 'POST',
      operation: 'terms.accept',
      options,
      path: '/v1/wallet/terms-acceptances',
      pathTemplate: '/v1/wallet/terms-acceptances',
      schema: zTermsAcceptanceResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
    this.assertMatch(
      'terms.accept',
      'offerId',
      response.offerId,
      request.offerId,
    );
    this.assertMatch(
      'terms.accept',
      'offerVersion',
      response.offerVersion,
      request.offerVersion,
    );
    this.assertMatch(
      'terms.accept',
      'termsVersion',
      response.termsVersion,
      request.termsVersion,
    );
    this.assertMatch(
      'terms.accept',
      'documentSha256',
      response.documentSha256,
      request.documentSha256,
    );
    this.assertMatch(
      'terms.accept',
      'walletSubjectId',
      response.walletSubjectId,
      session.walletSubjectId,
      'authority_mismatch',
    );
    return response;
  }

  async createQuote(
    request: CreateQuoteRequest,
    options?: EmberRequestOptions,
  ): Promise<SignedQuoteResponse> {
    const quote = await this.authenticated({
      body: request,
      idempotent: false,
      method: 'POST',
      operation: 'quotes.create',
      options,
      path: '/v1/quotes',
      pathTemplate: '/v1/quotes',
      schema: zSignedQuoteResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
    this.assertMatch(
      'quotes.create',
      'offerId',
      quote.payload.offer.offerId,
      request.offerId,
    );
    await this.verifyQuote(quote, options);
    return quote;
  }

  quoteSigningKeys(options?: EmberRequestOptions): Promise<QuoteSigningKeysResponse> {
    return this.transport.publicRequest({
      idempotent: true,
      method: 'GET',
      operation: 'quotes.keys',
      options,
      path: '/v1/quote-signing-keys',
      pathTemplate: '/v1/quote-signing-keys',
      schema: zQuoteSigningKeysResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
  }

  async verifyQuote(
    quote: SignedQuoteResponse,
    options?: EmberRequestOptions,
  ): Promise<void> {
    const parsedQuote = zSignedQuoteResponse.safeParse(quote);
    if (!parsedQuote.success) {
      throw new EmberResponseValidationError(
        'offline signed quote',
        parsedQuote.error.issues.map((issue) => ({
          path: issue.path.length === 0 ? '$' : `$.${issue.path.join('.')}`,
          message: issue.message,
        })),
        { cause: parsedQuote.error },
      );
    }
    quote = parsedQuote.data;
    const session = await this.requireSession();
    const payload = quote.payload;
    const isNonPayableTest =
      payload.mode === 'test' &&
      payload.schemaVersion === 1 &&
      !payload.paymentAllowed &&
      !payload.createsCoverage &&
      payload.benefitSchedule === undefined &&
      payload.payment.treasuryOwner === undefined;
    const isProductionLive =
      payload.mode === 'live' &&
      payload.schemaVersion === 3 &&
      payload.paymentAllowed &&
      payload.createsCoverage &&
      hasCoreAnnualBenefitSchedule(payload) &&
      Boolean(payload.payment.treasuryOwner) &&
      payload.offer.environment === 'production' &&
      payload.payment.genesisHash === MAINNET_GENESIS_HASH;
    if (!isNonPayableTest && !isProductionLive && !isDevnetQaQuote(payload)) {
      throw new EmberQuoteVerificationError('unsupported_schema');
    }
    if (
      payload.offer.environment !== this.config.environment ||
      payload.offer.cluster !== expectedCluster(this.config.environment)
    ) {
      throw new EmberQuoteVerificationError('environment_mismatch');
    }
    if (
      payload.integrationId !== this.config.integrationId ||
      payload.integrationVersion !== session.integrationVersion ||
      payload.partnerId !== session.partnerId ||
      payload.walletSubjectId !== session.walletSubjectId ||
      payload.protectedWallet !== session.walletAddress ||
      payload.payerWallet !== session.walletAddress
    ) {
      throw new EmberQuoteVerificationError('authority_mismatch');
    }
    const now = this.transport.currentDate().getTime();
    if (
      now < Date.parse(payload.validity.issuedAt) ||
      now >= Date.parse(payload.validity.expiresAt)
    ) {
      throw new EmberQuoteVerificationError('expired');
    }

    const canonicalPayload = canonicalQuotePayload(payload);
    const hash = await sha256Hex(this.transport.crypto, canonicalPayload);
    if (hash !== quote.payloadSha256) {
      throw new EmberQuoteVerificationError('hash_mismatch');
    }
    const keys = await this.quoteSigningKeys(options);
    const trusted = keys.keys.find(
      (key) =>
        key.keyId === payload.signingKeyId &&
        key.publicKey === quote.signingPublicKey &&
        key.mode === payload.mode &&
        key.algorithm.toLowerCase() === 'ed25519' &&
        (key.state === 'active' || key.state === 'retired'),
    );
    if (!trusted) throw new EmberQuoteVerificationError('untrusted_key');

    const publicKey = base58Decode(quote.signingPublicKey);
    const signature = base58Decode(quote.signature);
    if (publicKey.length !== 32 || signature.length !== 64) {
      throw new EmberQuoteVerificationError('invalid_signature');
    }
    const verified = await this.transport.crypto.verifyEd25519(
      publicKey,
      appendBytes(QUOTE_DOMAIN, canonicalPayload),
      signature,
    );
    if (!verified) throw new EmberQuoteVerificationError('invalid_signature');
  }

  async createPayment(
    request: CreatePaymentRequest,
    options?: EmberRequestOptions,
  ): Promise<PaymentResponse> {
    const response = await this.authenticated({
      body: request,
      idempotent: true,
      method: 'POST',
      operation: 'payments.create',
      options,
      path: '/v1/payments',
      pathTemplate: '/v1/payments',
      schema: zPaymentResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
    this.assertMatch(
      'payments.create',
      'quoteId',
      response.quoteId,
      request.quoteId,
    );
    this.assertMatch(
      'payments.create',
      'paymentSignature',
      response.paymentSignature,
      request.paymentSignature,
    );
    return response;
  }

  async getPayment(
    paymentId: string,
    options?: EmberRequestOptions,
  ): Promise<PaymentResponse> {
    const response = await this.authenticated({
      idempotent: true,
      method: 'GET',
      operation: 'payments.get',
      options,
      path: `/v1/payments/${encodeURIComponent(paymentId)}`,
      pathTemplate: '/v1/payments/{paymentId}',
      schema: zPaymentResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
    this.assertMatch(
      'payments.get',
      'paymentId',
      response.paymentId,
      paymentId,
      'resource_mismatch',
    );
    return response;
  }

  async getCoverageInstance(
    coverageInstanceId: string,
    options?: EmberRequestOptions,
  ): Promise<CoverageInstanceResponse> {
    const { response, session } = await this.authenticatedWithSession({
      idempotent: true,
      method: 'GET',
      operation: 'coverage.get',
      options,
      path: `/v1/coverage-instances/${encodeURIComponent(coverageInstanceId)}`,
      pathTemplate: '/v1/coverage-instances/{coverageInstanceId}',
      schema: zCoverageInstanceResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
    this.assertMatch(
      'coverage.get',
      'coverageInstanceId',
      response.coverageInstanceId,
      coverageInstanceId,
      'resource_mismatch',
    );
    this.assertCoverageAuthority(response, session, 'coverage.get');
    return response;
  }

  async createDecision(
    request: CreateCoverageDecisionRequest,
    options?: EmberRequestOptions,
  ): Promise<CoverageDecisionResponse> {
    const { response, session } = await this.authenticatedWithSession({
      body: request,
      idempotent: true,
      method: 'POST',
      operation: 'decisions.create',
      options,
      path: '/v1/decisions',
      pathTemplate: '/v1/decisions',
      schema: zCoverageDecisionResponse,
      timeoutMs: this.transport.timeouts.decisionMs,
    });
    this.assertMatch(
      'decisions.create',
      'coverageInstanceId',
      response.coverageInstanceId,
      request.coverageInstanceId,
    );
    this.assertMatch('decisions.create', 'kind', response.kind, request.kind);
    this.assertMatch(
      'decisions.create',
      'protectedWallet',
      response.protectedWallet,
      session.walletAddress,
      'authority_mismatch',
    );
    if (
      Date.parse(response.decisionExpiresAt) <=
      this.transport.currentDate().getTime()
    ) {
      throw new EmberResponseMismatchError(
        'decisions.create',
        'decisionExpiresAt',
        'expired',
      );
    }
    return response;
  }

  async reviewForSigning(
    request: CreateCoverageDecisionRequest,
    options?: EmberRequestOptions,
  ): Promise<SigningReview> {
    try {
      return { status: 'reviewed', decision: await this.createDecision(request, options) };
    } catch (error) {
      return unavailableReview(error);
    }
  }

  async getDecision(
    decisionId: string,
    options?: EmberRequestOptions,
  ): Promise<CoverageDecisionResponse> {
    const { response, session } = await this.authenticatedWithSession({
      idempotent: true,
      method: 'GET',
      operation: 'decisions.get',
      options,
      path: `/v1/decisions/${encodeURIComponent(decisionId)}`,
      pathTemplate: '/v1/decisions/{decisionId}',
      schema: zCoverageDecisionResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
    this.assertMatch(
      'decisions.get',
      'decisionId',
      response.decisionId,
      decisionId,
      'resource_mismatch',
    );
    this.assertMatch(
      'decisions.get',
      'protectedWallet',
      response.protectedWallet,
      session.walletAddress,
      'authority_mismatch',
    );
    return response;
  }

  async getDecisionLineage(
    decisionId: string,
    options?: EmberRequestOptions,
  ): Promise<DecisionLineageResponse> {
    const response = await this.authenticated({
      idempotent: true,
      method: 'GET',
      operation: 'decisions.lineage',
      options,
      path: `/v1/decisions/${encodeURIComponent(decisionId)}/lineage`,
      pathTemplate: '/v1/decisions/{decisionId}/lineage',
      schema: zDecisionLineageResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
    this.assertMatch(
      'decisions.lineage',
      'decisionId',
      response.decisionId,
      decisionId,
      'resource_mismatch',
    );
    return response;
  }

  async submitDecisionEvidence(
    decisionId: string,
    request: SubmitDecisionEvidenceRequest,
    options?: EmberRequestOptions,
  ): Promise<SubmitDecisionEvidenceResponse> {
    const response = await this.authenticated({
      body: request,
      idempotent: true,
      method: 'POST',
      operation: 'decisions.evidence',
      options,
      path: `/v1/decisions/${encodeURIComponent(decisionId)}/post-sign`,
      pathTemplate: '/v1/decisions/{decisionId}/post-sign',
      schema: zSubmitDecisionEvidenceResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
    this.assertMatch(
      'decisions.evidence',
      'decisionId',
      response.decisionId,
      decisionId,
      'resource_mismatch',
    );
    return response;
  }

  async claimEligibility(
    decisionId: string,
    options?: EmberRequestOptions,
  ): Promise<ClaimEligibilityResponse> {
    const response = await this.authenticated({
      idempotent: true,
      method: 'GET',
      operation: 'claims.eligibility',
      options,
      path: `/v1/wallet/decisions/${encodeURIComponent(decisionId)}/claim-eligibility`,
      pathTemplate: '/v1/wallet/decisions/{decisionId}/claim-eligibility',
      schema: zClaimEligibilityResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
    this.assertMatch(
      'claims.eligibility',
      'decisionId',
      response.decisionId,
      decisionId,
      'resource_mismatch',
    );
    return response;
  }

  async createClaim(
    request: CreateClaimRequest,
    options?: EmberRequestOptions,
  ): Promise<WalletClaimResponse> {
    const idempotencyKey =
      options?.idempotencyKey ??
      `claim-${this.transport.crypto.randomUuid().toLowerCase()}`;
    this.assertIdempotencyKey(idempotencyKey);
    const { response, session } = await this.authenticatedWithSession({
      body: request,
      idempotent: true,
      method: 'POST',
      operation: 'claims.create',
      options: { ...options, idempotencyKey },
      path: '/v1/wallet/claims',
      pathTemplate: '/v1/wallet/claims',
      schema: zWalletClaimResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
    this.assertMatch(
      'claims.create',
      'decisionId',
      response.decisionId,
      request.decisionId,
    );
    this.assertClaimAuthority(response, session, 'claims.create');
    return response;
  }

  async listClaims(
    options?: EmberRequestOptions,
  ): Promise<WalletClaimListResponse> {
    const { response, session } = await this.authenticatedWithSession({
      idempotent: true,
      method: 'GET',
      operation: 'claims.list',
      options,
      path: '/v1/wallet/claims',
      pathTemplate: '/v1/wallet/claims',
      schema: zWalletClaimListResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
    for (const claim of response.claims) {
      this.assertClaimAuthority(claim, session, 'claims.list');
    }
    return response;
  }

  async getClaim(
    claimId: string,
    options?: EmberRequestOptions,
  ): Promise<WalletClaimResponse> {
    const { response, session } = await this.authenticatedWithSession({
      idempotent: true,
      method: 'GET',
      operation: 'claims.get',
      options,
      path: `/v1/wallet/claims/${encodeURIComponent(claimId)}`,
      pathTemplate: '/v1/wallet/claims/{claimId}',
      schema: zWalletClaimResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
    this.assertMatch(
      'claims.get',
      'claimId',
      response.claimId,
      claimId,
      'resource_mismatch',
    );
    this.assertClaimAuthority(response, session, 'claims.get');
    return response;
  }

  async appealClaim(
    claimId: string,
    request: AppealClaimRequest,
    options?: EmberRequestOptions,
  ): Promise<WalletClaimResponse> {
    const { response, session } = await this.authenticatedWithSession({
      body: request,
      idempotent: false,
      method: 'POST',
      operation: 'claims.appeal',
      options,
      path: `/v1/wallet/claims/${encodeURIComponent(claimId)}/appeals`,
      pathTemplate: '/v1/wallet/claims/{claimId}/appeals',
      schema: zWalletClaimResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
    this.assertMatch(
      'claims.appeal',
      'claimId',
      response.claimId,
      claimId,
      'resource_mismatch',
    );
    this.assertClaimAuthority(response, session, 'claims.appeal');
    return response;
  }

  async beginClaimEvidenceUpload(
    claimId: string,
    request: BeginEvidenceUploadRequest,
    options?: EmberRequestOptions,
  ): Promise<EvidenceUploadResponse> {
    const response = await this.authenticated({
      body: request,
      idempotent: false,
      method: 'POST',
      operation: 'claims.evidence.begin',
      options,
      path: `/v1/wallet/claims/${encodeURIComponent(claimId)}/evidence-uploads`,
      pathTemplate: '/v1/wallet/claims/{claimId}/evidence-uploads',
      schema: zEvidenceUploadResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
    this.assertMatch(
      'claims.evidence.begin',
      'claimId',
      response.claimId,
      claimId,
      'resource_mismatch',
    );
    this.assertMatch(
      'claims.evidence.begin',
      'requestId',
      response.requestId,
      request.requestId,
    );
    this.assertMatch(
      'claims.evidence.begin',
      'evidenceCode',
      response.evidenceCode,
      request.evidenceCode,
    );
    if (response.status !== 'pending_upload' || !response.upload) {
      throw new EmberResponseMismatchError(
        'claims.evidence.begin',
        'status',
        'unexpected_state',
      );
    }
    assertEvidenceUploadGrant(response.upload, this.transport.currentDate());
    return response;
  }

  async completeClaimEvidenceUpload(
    claimId: string,
    evidenceId: string,
    options?: EmberRequestOptions,
  ): Promise<EvidenceUploadResponse> {
    const response = await this.authenticated({
      idempotent: true,
      method: 'POST',
      operation: 'claims.evidence.complete',
      options,
      path: `/v1/wallet/claims/${encodeURIComponent(claimId)}/evidence-uploads/${encodeURIComponent(evidenceId)}/complete`,
      pathTemplate:
        '/v1/wallet/claims/{claimId}/evidence-uploads/{evidenceId}/complete',
      schema: zEvidenceUploadResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
    this.assertMatch(
      'claims.evidence.complete',
      'claimId',
      response.claimId,
      claimId,
      'resource_mismatch',
    );
    this.assertMatch(
      'claims.evidence.complete',
      'evidenceId',
      response.evidenceId,
      evidenceId,
      'resource_mismatch',
    );
    if (response.status !== 'uploaded' || response.upload != null) {
      throw new EmberResponseMismatchError(
        'claims.evidence.complete',
        'status',
        'unexpected_state',
      );
    }
    return response;
  }

  private async authenticated<T>(
    definition: {
      body?: unknown;
      idempotent: boolean;
      method: 'GET' | 'POST';
      operation: string;
      options?: EmberRequestOptions;
      path: string;
      pathTemplate: string;
      schema: ZodType<T>;
      timeoutMs: number;
    },
  ): Promise<T> {
    return (await this.authenticatedWithSession(definition)).response;
  }

  private async authenticatedWithSession<T>(
    definition: {
      body?: unknown;
      idempotent: boolean;
      method: 'GET' | 'POST';
      operation: string;
      options?: EmberRequestOptions;
      path: string;
      pathTemplate: string;
      schema: ZodType<T>;
      timeoutMs: number;
    },
  ): Promise<{ response: T; session: PersistedWalletSession }> {
    const session = await this.requireSession();
    const response = await this.transport.signedRequest(
      definition,
      session,
      this.sessionSigner,
    );
    return { response, session };
  }

  private async revoke(
    path: string,
    request: RevokeSessionRequest,
    options?: EmberRequestOptions,
  ): Promise<RevocationResponse> {
    const response = await this.authenticated({
      body: request,
      idempotent: false,
      method: 'POST',
      operation: 'wallet_session.revoke',
      options,
      path,
      pathTemplate: path,
      schema: zRevocationResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
    await this.clearPersistedSession();
    return response;
  }

  private async requireSession(): Promise<PersistedWalletSession> {
    const session = await this.currentSession();
    if (!session) throw new EmberSessionRequiredError();
    if (session.sessionPublicKey !== this.sessionSigner.publicKey) {
      throw new EmberSessionRequiredError(
        'The persisted Ember session does not match the active session signer.',
      );
    }
    if (session.integrationId !== this.config.integrationId) {
      throw new EmberSessionRequiredError(
        'The persisted Ember session belongs to a different integration.',
      );
    }
    if (session.integrationVersion !== this.config.integrationVersion) {
      throw new EmberSessionRequiredError(
        'The persisted Ember session belongs to a different integration version.',
      );
    }
    if (session.environment !== this.config.environment) {
      throw new EmberEnvironmentMismatchError(
        this.config.environment,
        session.environment,
        'wallet session',
      );
    }
    if (
      sessionState(session, this.transport.currentDate(), 0).status ===
      'reauthentication_required'
    ) {
      throw new EmberSessionRequiredError('The Ember wallet session has expired.');
    }
    return session;
  }

  private assertNewSession(
    response: WalletSessionResponse,
    walletAddress: string,
    requestedScopes: ReadonlyArray<WalletScope>,
  ): void {
    if (response.environment !== this.config.environment) {
      throw new EmberEnvironmentMismatchError(
        this.config.environment,
        response.environment,
        'wallet session',
      );
    }
    if (
      response.integrationId !== this.config.integrationId ||
      response.integrationVersion !== this.config.integrationVersion ||
      response.walletAddress !== walletAddress ||
      !sameScopes(requestedScopes, response.scopes)
    ) {
      throw new EmberSessionRequiredError(
        'The Ember wallet session authority does not match the requested authority.',
      );
    }
  }

  private validatedPersistedSession(
    response: WalletSessionResponse,
    sessionPublicKey: string,
  ): PersistedWalletSession {
    const persisted = parsePersistedWalletSession({
      ...response,
      sessionPublicKey,
    });
    if (
      !persisted ||
      sessionState(persisted, this.transport.currentDate(), 0).status ===
        'reauthentication_required'
    ) {
      throw new EmberSessionRequiredError(
        'Ember returned a wallet session that is not valid for persistence.',
      );
    }
    return persisted;
  }

  private async persistSession(session: PersistedWalletSession): Promise<void> {
    try {
      await this.config.sessionStore.save(session);
    } catch (cause) {
      try {
        await this.config.sessionStore.clear();
      } catch {
        // Preserve the primary failure. The host must repair or replace a
        // store that cannot remove a possibly partial credential write.
      }
      throw new EmberSessionPersistenceError('save', { cause });
    }
  }

  private async clearPersistedSession(): Promise<void> {
    try {
      await this.config.sessionStore.clear();
    } catch (cause) {
      throw new EmberSessionPersistenceError('clear', { cause });
    }
  }

  private assertScopes(scopes: ReadonlyArray<WalletScope>): void {
    if (
      scopes.length === 0 ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((scope) => !P11_WALLET_SCOPES.includes(scope))
    ) {
      throw new EmberConfigurationError(
        'Request unique supported Ember wallet scopes.',
      );
    }
  }

  private assertIdempotencyKey(value: string): void {
    if (
      value.length < 16 ||
      value.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(value)
    ) {
      throw new EmberConfigurationError(
        'idempotencyKey must contain 16-128 URL-safe characters.',
      );
    }
  }

  private assertOfferEnvironment(offer: AvailableOfferResponse): void {
    if (
      offer.environment !== this.config.environment ||
      offer.cluster !== expectedCluster(this.config.environment)
    ) {
      throw new EmberEnvironmentMismatchError(
        this.config.environment,
        `${offer.environment}/${offer.cluster}`,
        'offer',
      );
    }
  }

  private assertCoverageAuthority(
    response: CoverageInstanceResponse,
    session: PersistedWalletSession,
    operation: string,
  ): void {
    this.assertMatch(
      operation,
      'walletSubjectId',
      response.walletSubjectId,
      session.walletSubjectId,
      'authority_mismatch',
    );
    this.assertMatch(
      operation,
      'protectedWallet',
      response.protectedWallet,
      session.walletAddress,
      'authority_mismatch',
    );
  }

  private assertClaimAuthority(
    response: WalletClaimResponse,
    session: PersistedWalletSession,
    operation: string,
  ): void {
    this.assertMatch(
      operation,
      'protectedWallet',
      response.protectedWallet,
      session.walletAddress,
      'authority_mismatch',
    );
  }

  private assertMatch(
    operation: string,
    field: string,
    received: string | number,
    expected: string | number,
    reason: EmberResponseMismatchReason = 'request_mismatch',
  ): void {
    if (received !== expected) {
      throw new EmberResponseMismatchError(operation, field, reason);
    }
  }
}

export type {
  AcceptTermsRequest,
  AppealClaimRequest,
  AvailableOfferListResponse,
  AvailableOfferResponse,
  BeginEvidenceUploadRequest,
  ClaimEligibilityResponse,
  CoverageDecisionResponse,
  CoverageInstanceResponse,
  CreateClaimRequest,
  CreateCoverageDecisionRequest,
  CreatePaymentRequest,
  CreateQuoteRequest,
  DecisionLineageResponse,
  EvidenceUploadResponse,
  PaymentResponse,
  QuoteSigningKeysResponse,
  SignedQuoteResponse,
  SubmitDecisionEvidenceRequest,
  SubmitDecisionEvidenceResponse,
  TermsAcceptanceResponse,
  WalletChallengeResponse,
  WalletClaimListResponse,
  WalletClaimResponse,
  WalletScope,
};
