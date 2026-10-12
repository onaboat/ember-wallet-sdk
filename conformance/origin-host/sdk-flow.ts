import {
  EmberWalletClient,
  P10_WALLET_SCOPES,
  type EmberCrypto,
  type EmberHostBinding,
  type EmberMessageSigner,
  type PersistedWalletSession,
  type WalletSessionStore,
} from '@embercover/wallet-sdk';

export const CONFORMANCE_WALLET = '11111111111111111111111111111111';
export const CONFORMANCE_SESSION_KEY =
  'SysvarRent111111111111111111111111111111111';

export interface OriginHostFixtureInput {
  apiBaseUrl: string;
  crypto?: EmberCrypto;
  hostBinding: EmberHostBinding;
  integrationId: string;
  integrationVersion: number;
  sessionPublicKey?: string;
  sessionStore: WalletSessionStore;
  walletAddress?: string;
  withSessionMutation<T>(operation: () => Promise<T>): Promise<T>;
}

export interface OriginHostFixtureResult {
  challengeSigned: boolean;
  offerId: string;
  sessionId: string;
  sessionOpened: boolean;
  sessionRestored: boolean;
  signedRequestCompleted: boolean;
}

class TestOnlySigner implements EmberMessageSigner {
  calls = 0;

  constructor(
    readonly publicKey: string,
    private readonly signatureByte: number,
  ) {}

  async signMessage(): Promise<Uint8Array> {
    this.calls += 1;
    return new Uint8Array(64).fill(this.signatureByte);
  }
}

/**
 * Exercise the packed public SDK in a real browser runtime. These deterministic
 * signers are protocol fixtures only: they hold no private key and cannot sign
 * or submit a Solana transaction.
 */
export async function runOriginHostFixture(
  input: OriginHostFixtureInput,
): Promise<OriginHostFixtureResult> {
  const sessionSigner = new TestOnlySigner(
    input.sessionPublicKey ?? CONFORMANCE_SESSION_KEY,
    7,
  );
  const walletSigner = new TestOnlySigner(
    input.walletAddress ?? CONFORMANCE_WALLET,
    9,
  );
  const client = new EmberWalletClient({
    baseUrl: input.apiBaseUrl,
    environment: 'sandbox',
    hostBinding: input.hostBinding,
    integrationId: input.integrationId,
    integrationVersion: input.integrationVersion,
    sessionSigner,
    sessionStore: input.sessionStore,
    ...(input.crypto ? { crypto: input.crypto } : {}),
  });

  let opened = false;
  const session = await input.withSessionMutation(async () => {
    const restored = await client.currentSession();
    if (restored) return restored;
    opened = true;
    return client.openSession({
      requestedScopes: P10_WALLET_SCOPES,
      walletSigner,
    });
  });
  const offers = await client.listOffers();
  const firstOffer = offers.offers[0];
  if (!firstOffer) throw new Error('The origin-host fixture received no offers.');

  return {
    challengeSigned: walletSigner.calls === 1,
    offerId: firstOffer.offerId,
    sessionId: session.sessionId,
    sessionOpened: opened,
    sessionRestored: !opened,
    signedRequestCompleted: sessionSigner.calls === 1,
  };
}

export function browserSessionPartitionKey(input: {
  environment: 'sandbox' | 'production';
  integrationId: string;
  integrationVersion: number;
  walletAddress: string;
}): string {
  return [
    'ember.wallet-session.v1',
    input.environment,
    input.integrationId,
    String(input.integrationVersion),
    input.walletAddress,
  ]
    .map(encodeURIComponent)
    .join(':');
}

export function serializedSessionStore(input: {
  clearValue(): Promise<void>;
  readValue(): Promise<string | null>;
  writeValue(value: string): Promise<void>;
}): WalletSessionStore {
  return {
    clear: input.clearValue,
    async load() {
      const value = await input.readValue();
      if (value === null) return null;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return null;
      }
    },
    save(session: PersistedWalletSession) {
      return input.writeValue(JSON.stringify(session));
    },
  };
}
