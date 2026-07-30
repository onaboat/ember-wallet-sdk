import type { ZodType } from 'zod';
import { base58Decode, base58Encode, sha256Hex, utf8 } from './encoding';
import {
  EmberAbortError,
  EmberApiError,
  EmberConfigurationError,
  EmberEnvironmentMismatchError,
  EmberNetworkError,
  EmberQuoteVerificationError,
  EmberResponseValidationError,
  EmberSessionRequiredError,
  EmberSigningError,
  EmberTimeoutError,
} from './errors';
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
  type PersistedWalletSession,
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
    this.transport = new EmberTransport(config);
    this.sessionSigner = config.sessionSigner;
  }

  async openSession(input: OpenWalletSessionInput): Promise<PersistedWalletSession> {
    this.assertScopes(input.requestedScopes);
    if (input.walletSigner.publicKey === this.sessionSigner.publicKey) {
      throw new EmberConfigurationError(
        'The wallet signer and ephemeral session signer must use different keys.',
      );
    }
    const challenge = await this.transport.publicRequest({
      body: {
        client: this.config.client,
        integrationId: this.config.integrationId,
        requestedScopes: [...input.requestedScopes],
        sessionPublicKey: this.sessionSigner.publicKey,
        walletAddress: input.walletSigner.publicKey,
      },
      method: 'POST',
      operation: 'wallet_session.challenge',
      path: '/v1/wallet-sessions/challenges',
      schema: zWalletChallengeResponse,
      timeoutMs: this.transport.timeouts.bootstrapMs,
    });
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
      schema: zWalletSessionResponse,
      timeoutMs: this.transport.timeouts.bootstrapMs,
    });
    this.assertNewSession(
      response,
      input.walletSigner.publicKey,
      input.requestedScopes,
    );
    const persisted = {
      ...response,
      sessionPublicKey: this.sessionSigner.publicKey,
    };
    await this.config.sessionStore.save(persisted);
    return persisted;
  }

  async rotateSession(
    nextSigner: EmberMessageSigner,
    options?: EmberRequestOptions,
  ): Promise<PersistedWalletSession> {
    if (nextSigner.publicKey === this.sessionSigner.publicKey) {
      throw new EmberConfigurationError('Session rotation requires a new key.');
    }
    const current = await this.requireSession();
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
        schema: zWalletSessionResponse,
        timeoutMs: this.transport.timeouts.mutationMs,
      },
      current,
      this.sessionSigner,
    );
    this.assertNewSession(response, current.walletAddress, current.scopes);
    const persisted = { ...response, sessionPublicKey: nextSigner.publicKey };
    await this.config.sessionStore.save(persisted);
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
    return this.config.sessionStore.load();
  }

  async clearLocalSession(): Promise<void> {
    await this.config.sessionStore.clear();
  }

  async listOffers(options?: EmberRequestOptions): Promise<AvailableOfferListResponse> {
    const response = await this.authenticated(
      {
        idempotent: true,
        method: 'GET',
        operation: 'offers.list',
        options,
        path: '/v1/wallet/offers',
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
      schema: zAvailableOfferResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
    this.assertOfferEnvironment(response);
    return response;
  }

  acceptTerms(
    request: AcceptTermsRequest,
    options?: EmberRequestOptions,
  ): Promise<TermsAcceptanceResponse> {
    return this.authenticated({
      body: request,
      idempotent: false,
      method: 'POST',
      operation: 'terms.accept',
      options,
      path: '/v1/wallet/terms-acceptances',
      schema: zTermsAcceptanceResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
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
      schema: zSignedQuoteResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
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

  createPayment(
    request: CreatePaymentRequest,
    options?: EmberRequestOptions,
  ): Promise<PaymentResponse> {
    return this.authenticated({
      body: request,
      idempotent: true,
      method: 'POST',
      operation: 'payments.create',
      options,
      path: '/v1/payments',
      schema: zPaymentResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
  }

  getPayment(
    paymentId: string,
    options?: EmberRequestOptions,
  ): Promise<PaymentResponse> {
    return this.authenticated({
      idempotent: true,
      method: 'GET',
      operation: 'payments.get',
      options,
      path: `/v1/payments/${encodeURIComponent(paymentId)}`,
      schema: zPaymentResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
  }

  getCoverageInstance(
    coverageInstanceId: string,
    options?: EmberRequestOptions,
  ): Promise<CoverageInstanceResponse> {
    return this.authenticated({
      idempotent: true,
      method: 'GET',
      operation: 'coverage.get',
      options,
      path: `/v1/coverage-instances/${encodeURIComponent(coverageInstanceId)}`,
      schema: zCoverageInstanceResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
  }

  createDecision(
    request: CreateCoverageDecisionRequest,
    options?: EmberRequestOptions,
  ): Promise<CoverageDecisionResponse> {
    return this.authenticated({
      body: request,
      idempotent: true,
      method: 'POST',
      operation: 'decisions.create',
      options,
      path: '/v1/decisions',
      schema: zCoverageDecisionResponse,
      timeoutMs: this.transport.timeouts.decisionMs,
    });
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

  getDecision(
    decisionId: string,
    options?: EmberRequestOptions,
  ): Promise<CoverageDecisionResponse> {
    return this.authenticated({
      idempotent: true,
      method: 'GET',
      operation: 'decisions.get',
      options,
      path: `/v1/decisions/${encodeURIComponent(decisionId)}`,
      schema: zCoverageDecisionResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
  }

  getDecisionLineage(
    decisionId: string,
    options?: EmberRequestOptions,
  ): Promise<DecisionLineageResponse> {
    return this.authenticated({
      idempotent: true,
      method: 'GET',
      operation: 'decisions.lineage',
      options,
      path: `/v1/decisions/${encodeURIComponent(decisionId)}/lineage`,
      schema: zDecisionLineageResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
  }

  submitDecisionEvidence(
    decisionId: string,
    request: SubmitDecisionEvidenceRequest,
    options?: EmberRequestOptions,
  ): Promise<SubmitDecisionEvidenceResponse> {
    return this.authenticated({
      body: request,
      idempotent: true,
      method: 'POST',
      operation: 'decisions.evidence',
      options,
      path: `/v1/decisions/${encodeURIComponent(decisionId)}/post-sign`,
      schema: zSubmitDecisionEvidenceResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
  }

  claimEligibility(
    decisionId: string,
    options?: EmberRequestOptions,
  ): Promise<ClaimEligibilityResponse> {
    return this.authenticated({
      idempotent: true,
      method: 'GET',
      operation: 'claims.eligibility',
      options,
      path: `/v1/wallet/decisions/${encodeURIComponent(decisionId)}/claim-eligibility`,
      schema: zClaimEligibilityResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
  }

  createClaim(
    request: CreateClaimRequest,
    options?: EmberRequestOptions,
  ): Promise<WalletClaimResponse> {
    const idempotencyKey =
      options?.idempotencyKey ??
      `claim-${this.transport.crypto.randomUuid().toLowerCase()}`;
    this.assertIdempotencyKey(idempotencyKey);
    return this.authenticated({
      body: request,
      idempotent: true,
      method: 'POST',
      operation: 'claims.create',
      options: { ...options, idempotencyKey },
      path: '/v1/wallet/claims',
      schema: zWalletClaimResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
  }

  listClaims(options?: EmberRequestOptions): Promise<WalletClaimListResponse> {
    return this.authenticated({
      idempotent: true,
      method: 'GET',
      operation: 'claims.list',
      options,
      path: '/v1/wallet/claims',
      schema: zWalletClaimListResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
  }

  getClaim(
    claimId: string,
    options?: EmberRequestOptions,
  ): Promise<WalletClaimResponse> {
    return this.authenticated({
      idempotent: true,
      method: 'GET',
      operation: 'claims.get',
      options,
      path: `/v1/wallet/claims/${encodeURIComponent(claimId)}`,
      schema: zWalletClaimResponse,
      timeoutMs: this.transport.timeouts.readMs,
    });
  }

  appealClaim(
    claimId: string,
    request: AppealClaimRequest,
    options?: EmberRequestOptions,
  ): Promise<WalletClaimResponse> {
    return this.authenticated({
      body: request,
      idempotent: false,
      method: 'POST',
      operation: 'claims.appeal',
      options,
      path: `/v1/wallet/claims/${encodeURIComponent(claimId)}/appeals`,
      schema: zWalletClaimResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
  }

  beginClaimEvidenceUpload(
    claimId: string,
    request: BeginEvidenceUploadRequest,
    options?: EmberRequestOptions,
  ): Promise<EvidenceUploadResponse> {
    return this.authenticated({
      body: request,
      idempotent: false,
      method: 'POST',
      operation: 'claims.evidence.begin',
      options,
      path: `/v1/wallet/claims/${encodeURIComponent(claimId)}/evidence-uploads`,
      schema: zEvidenceUploadResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
  }

  completeClaimEvidenceUpload(
    claimId: string,
    evidenceId: string,
    options?: EmberRequestOptions,
  ): Promise<EvidenceUploadResponse> {
    return this.authenticated({
      idempotent: true,
      method: 'POST',
      operation: 'claims.evidence.complete',
      options,
      path: `/v1/wallet/claims/${encodeURIComponent(claimId)}/evidence-uploads/${encodeURIComponent(evidenceId)}/complete`,
      schema: zEvidenceUploadResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
  }

  private async authenticated<T>(
    definition: {
      body?: unknown;
      idempotent: boolean;
      method: 'GET' | 'POST';
      operation: string;
      options?: EmberRequestOptions;
      path: string;
      schema: ZodType<T>;
      timeoutMs: number;
    },
  ): Promise<T> {
    const session = await this.requireSession();
    return this.transport.signedRequest(
      definition,
      session,
      this.sessionSigner,
    );
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
      schema: zRevocationResponse,
      timeoutMs: this.transport.timeouts.mutationMs,
    });
    await this.config.sessionStore.clear();
    return response;
  }

  private async requireSession(): Promise<PersistedWalletSession> {
    const session = await this.config.sessionStore.load();
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
    if (session.environment !== this.config.environment) {
      throw new EmberEnvironmentMismatchError(
        this.config.environment,
        session.environment,
        'wallet session',
      );
    }
    if (this.transport.currentDate().getTime() >= Date.parse(session.expiresAt)) {
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
      response.walletAddress !== walletAddress ||
      !sameScopes(requestedScopes, response.scopes)
    ) {
      throw new EmberSessionRequiredError(
        'The Ember wallet session authority does not match the requested authority.',
      );
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
