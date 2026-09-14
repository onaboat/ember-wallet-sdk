import {
  EmberWalletClient,
  P10_WALLET_SCOPES,
} from '@embercover/wallet-sdk';

const API_BASE_URL = 'https://native-conformance.ember.invalid';
const APPLICATION_ID = 'cover.ember.native.conformance';
const FIXED_NOW = new Date('2026-09-15T00:00:00.000Z');
const SESSION_KEY = 'SysvarRent111111111111111111111111111111111';
const WALLET = '11111111111111111111111111111111';
const SHA256_HEX = 'ab'.repeat(32);

class TestOnlySigner {
  constructor(publicKey, signatureByte) {
    this.publicKey = publicKey;
    this.signatureByte = signatureByte;
    this.messages = [];
  }

  async signMessage(message) {
    this.messages.push(message);
    return new Uint8Array(64).fill(this.signatureByte);
  }
}

class SerializedNativeSessionStore {
  constructor(seed) {
    this.serialized = seed == null ? null : JSON.stringify(seed);
  }

  async clear() {
    this.serialized = null;
  }

  async load() {
    return this.serialized == null ? null : JSON.parse(this.serialized);
  }

  async save(session) {
    this.serialized = JSON.stringify(session);
  }

  snapshot() {
    return this.serialized == null ? null : JSON.parse(this.serialized);
  }
}

function response(body, status = 200) {
  return {
    headers: { get: () => null },
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function challenge(body) {
  const challengeId = 'challenge_native-conformance';
  const nonce = '111111111111111111111111';
  const issuedAt = FIXED_NOW.toISOString();
  const expiresAt = new Date(FIXED_NOW.getTime() + 5 * 60 * 1_000).toISOString();
  const resources = [
    'urn:ember:integration:integration_native-conformance:1',
    'urn:ember:environment:sandbox',
    `urn:ember:session-key:${body.sessionPublicKey}`,
    'urn:ember:client-kind:native',
    `urn:ember:client-binding-sha256:${SHA256_HEX}`,
    ...body.requestedScopes.map((scope) => `urn:ember:scope:${scope}`),
  ];
  const message = [
    'api.ember.cover wants you to sign in with your Solana account:',
    body.walletAddress,
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

function session(scopes) {
  return {
    environment: 'sandbox',
    expiresAt: new Date(FIXED_NOW.getTime() + 15 * 60 * 1_000).toISOString(),
    integrationId: 'integration_native-conformance',
    integrationVersion: 1,
    partnerId: 'partner_native-conformance',
    refreshExpiresAt: new Date(
      FIXED_NOW.getTime() + 24 * 60 * 60 * 1_000,
    ).toISOString(),
    refreshToken: 'refresh_native-conformance.runtime-only',
    scopes,
    sessionId: 'session_native-conformance',
    walletAddress: WALLET,
    walletSubjectId: 'wallet_native-conformance',
  };
}

function offer() {
  return {
    aggregateLimitMicros: '120000000000',
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
    displayName: 'Native conformance offer',
    environment: 'sandbox',
    immediateLossClaimWindowDays: 7,
    lifecycle: 'testing',
    offerId: 'offer_native-conformance',
    offerVersion: 1,
    payerMustEqualProtectedWallet: true,
    paymentAsset: 'USDC',
    paymentAssetDecimals: 6,
    paymentMint: WALLET,
    paymentTokenProgram: WALLET,
    perLossLimitMicros: '10000000000',
    policySha256: 'c'.repeat(64),
    policyVersion: 'policy-native-conformance',
    priceBaseUnits: '1000000',
    productCode: 'core',
    protectedWalletCount: 1,
    refundRuleCode: 'operational_or_mandatory_law_only',
    snapshotSha256: 'a'.repeat(64),
    termsSha256: 'b'.repeat(64),
    termsVersion: 'terms-native-conformance',
    waitingPeriodDays: 0,
  };
}

function ascii(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
}

async function main() {
  const restoredSeed = globalThis.__EMBER_NATIVE_RESTORED_SESSION__ ?? null;
  const store = new SerializedNativeSessionStore(restoredSeed);
  const sessionSigner = new TestOnlySigner(SESSION_KEY, 7);
  const walletSigner = new TestOnlySigner(WALLET, 9);
  let challengeCalls = 0;
  let signedReadCalls = 0;
  let uuidSequence = 0;
  const crypto = {
    randomUuid() {
      uuidSequence += 1;
      return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, '0')}`;
    },
    async sha256() {
      return new Uint8Array(32).fill(0xab);
    },
    async verifyEd25519() {
      return false;
    },
  };
  const nativeFetch = async (input, init = {}) => {
    const url = String(input);
    if (url === `${API_BASE_URL}/v1/wallet-sessions/challenges`) {
      challengeCalls += 1;
      const body = JSON.parse(init.body);
      if (
        body.client?.kind !== 'native' ||
        body.client.applicationId !== APPLICATION_ID
      ) {
        return response({ error: 'client_binding_mismatch' }, 403);
      }
      return response(challenge(body));
    }
    if (url === `${API_BASE_URL}/v1/wallet-sessions`) {
      return response(session(P10_WALLET_SCOPES));
    }
    if (url === `${API_BASE_URL}/v1/wallet/offers`) {
      signedReadCalls += 1;
      return response({ offers: [offer()] });
    }
    return response({ error: 'not_found' }, 404);
  };

  const client = new EmberWalletClient({
    baseUrl: API_BASE_URL,
    crypto,
    environment: 'sandbox',
    fetch: nativeFetch,
    hostBinding: { kind: 'native', applicationId: APPLICATION_ID },
    integrationId: 'integration_native-conformance',
    integrationVersion: 1,
    now: () => FIXED_NOW,
    retry: { maxRetries: 0 },
    sessionSigner,
    sessionStore: store,
  });

  const existing = await client.currentSession();
  const active =
    existing ??
    (await client.openSession({
      requestedScopes: P10_WALLET_SCOPES,
      walletSigner,
    }));
  const offers = await client.listOffers();
  const requestProof = ascii(sessionSigner.messages[0] ?? new Uint8Array());
  const expectedProof = [
    'ember-wallet-request-v1',
    active.sessionId,
    'GET',
    '/v1/wallet/offers',
    FIXED_NOW.toISOString(),
    'jti_00000000-0000-4000-8000-000000000001',
    SHA256_HEX,
  ].join('\n');

  print(
    `EMBER_NATIVE_RESULT ${JSON.stringify({
      challengeCalls,
      offerId: offers.offers[0]?.offerId,
      persistedSession: store.snapshot(),
      requestProofMatches: requestProof === expectedProof,
      restored: existing !== null,
      signedReadCalls,
    })}`,
  );
}

main().catch((error) => {
  print(
    `EMBER_NATIVE_FAILURE ${JSON.stringify({
      name: typeof error?.name === 'string' ? error.name : 'Error',
    })}`,
  );
});
