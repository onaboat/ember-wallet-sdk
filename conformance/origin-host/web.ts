import { runOriginHostFixture, browserSessionPartitionKey, serializedSessionStore, CONFORMANCE_WALLET } from './sdk-flow';

declare global {
  interface Window {
    __EMBER_ORIGIN_HOST_CONTROL__?: {
      clear(): Promise<void>;
      partitionKey: string;
    };
    __EMBER_ORIGIN_HOST_RESULT__?: unknown;
  }
}

const parameters = new URLSearchParams(location.search);
const apiBaseUrl = requiredParameter('api');
const expectedOrigin = parameters.get('bindingOrigin') ?? location.origin;
const walletAddress = parameters.get('wallet') ?? CONFORMANCE_WALLET;
const sessionPublicKey =
  parameters.get('sessionKey') ??
  'SysvarRent111111111111111111111111111111111';
const partitionKey = browserSessionPartitionKey({
  environment: 'sandbox',
  integrationId: 'integration_browser-conformance',
  integrationVersion: 1,
  walletAddress,
});
const store = serializedSessionStore({
  async clearValue() {
    localStorage.removeItem(partitionKey);
  },
  async readValue() {
    return localStorage.getItem(partitionKey);
  },
  async writeValue(value) {
    localStorage.setItem(partitionKey, value);
  },
});
window.__EMBER_ORIGIN_HOST_CONTROL__ = {
  clear: () => store.clear(),
  partitionKey,
};

window.__EMBER_ORIGIN_HOST_RESULT__ = runOriginHostFixture({
  apiBaseUrl,
  hostBinding: { kind: 'web', origin: expectedOrigin },
  integrationId: 'integration_browser-conformance',
  integrationVersion: 1,
  sessionPublicKey,
  sessionStore: store,
  walletAddress,
  async withSessionMutation(operation) {
    return navigator.locks.request(`${partitionKey}:mutation`, operation);
  },
}).catch(safeFailure);

function requiredParameter(name: string): string {
  const value = parameters.get(name);
  if (!value) throw new Error(`Missing ${name} query parameter.`);
  return value;
}

function safeFailure(error: unknown) {
  const value = error as { name?: unknown; reason?: unknown };
  return {
    error: {
      name: typeof value?.name === 'string' ? value.name : 'Error',
      reason: typeof value?.reason === 'string' ? value.reason : undefined,
    },
  };
}
