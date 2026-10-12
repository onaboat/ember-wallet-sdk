import {
  EmberWalletClient,
  P10_WALLET_SCOPES,
  type CreateCoverageDecisionRequest,
  type EmberMessageSigner,
  type PersistedWalletSession,
  type SubmitDecisionEvidenceRequest,
  type WalletSessionStore,
} from '../../src/index';

interface ExtensionSessionStorage {
  delete(key: string): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

class BrowserSessionStore implements WalletSessionStore {
  constructor(private readonly storage: ExtensionSessionStorage) {}

  load(): Promise<PersistedWalletSession | null> {
    return this.storage.get('ember.wallet-session');
  }

  save(session: PersistedWalletSession): Promise<void> {
    return this.storage.set('ember.wallet-session', session);
  }

  clear(): Promise<void> {
    return this.storage.delete('ember.wallet-session');
  }
}

interface DurableEvidenceQueue {
  put(value: {
    decisionId: string;
    request: SubmitDecisionEvidenceRequest;
  }): Promise<void>;
}

export function createBrowserEmberClient(input: {
  extensionOrigin: string;
  integrationId: string;
  integrationVersion: number;
  sessionSigner: EmberMessageSigner;
  storage: ExtensionSessionStorage;
}) {
  return new EmberWalletClient({
    baseUrl: 'https://sandbox-api.example.ember.cover',
    environment: 'sandbox',
    hostBinding: { kind: 'chrome_extension', origin: input.extensionOrigin },
    integrationId: input.integrationId,
    integrationVersion: input.integrationVersion,
    sessionSigner: input.sessionSigner,
    sessionStore: new BrowserSessionStore(input.storage),
  });
}

export async function enrolBrowserWallet(
  client: EmberWalletClient,
  walletSigner: EmberMessageSigner,
): Promise<void> {
  await client.openSession({
    walletSigner,
    requestedScopes: P10_WALLET_SCOPES,
  });
}

export async function reviewAndPersistSignedTransaction(input: {
  client: EmberWalletClient;
  evidenceQueue: DurableEvidenceQueue;
  request: Extract<CreateCoverageDecisionRequest, { kind: 'transaction' }>;
  signExactTransaction(): Promise<string>;
}): Promise<string> {
  const review = await input.client.reviewForSigning(input.request);
  const signedBytes = await input.signExactTransaction();
  if (review.status === 'reviewed') {
    await input.evidenceQueue.put({
      decisionId: review.decision.decisionId,
      request: { kind: 'transaction', signedBytes },
    });
  }
  return signedBytes;
}
