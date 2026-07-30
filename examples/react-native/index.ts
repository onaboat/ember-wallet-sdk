import {
  EmberWalletClient,
  P10_WALLET_SCOPES,
  type EmberCrypto,
  type EmberFetch,
  type EmberMessageSigner,
  type PersistedWalletSession,
  type WalletSessionStore,
} from '../../src/index';

interface NativeSecureStorage {
  delete(key: string): Promise<void>;
  readJson<T>(key: string): Promise<T | null>;
  writeJson<T>(key: string, value: T): Promise<void>;
}

class NativeSessionStore implements WalletSessionStore {
  constructor(private readonly storage: NativeSecureStorage) {}

  load(): Promise<PersistedWalletSession | null> {
    return this.storage.readJson('ember.wallet-session');
  }

  save(session: PersistedWalletSession): Promise<void> {
    return this.storage.writeJson('ember.wallet-session', session);
  }

  clear(): Promise<void> {
    return this.storage.delete('ember.wallet-session');
  }
}

export function createReactNativeEmberClient(input: {
  applicationId: string;
  crypto: EmberCrypto;
  fetch: EmberFetch;
  integrationId: string;
  secureStorage: NativeSecureStorage;
  sessionSigner: EmberMessageSigner;
}) {
  return new EmberWalletClient({
    baseUrl: 'https://sandbox-api.example.ember.cover',
    client: {
      kind: 'native',
      applicationId: input.applicationId,
    },
    crypto: input.crypto,
    environment: 'sandbox',
    fetch: input.fetch,
    integrationId: input.integrationId,
    sessionSigner: input.sessionSigner,
    sessionStore: new NativeSessionStore(input.secureStorage),
  });
}

export async function enrolNativeWallet(
  client: EmberWalletClient,
  walletSigner: EmberMessageSigner,
): Promise<void> {
  await client.openSession({
    walletSigner,
    requestedScopes: P10_WALLET_SCOPES,
  });
}
