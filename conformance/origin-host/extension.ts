import {
  CONFORMANCE_WALLET,
  browserSessionPartitionKey,
  runOriginHostFixture,
  serializedSessionStore,
} from './sdk-flow';
import { webCrypto } from '@embercover/wallet-sdk';

declare const chrome: {
  runtime: {
    getURL(path: string): string;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      remove(key: string): Promise<void>;
      set(value: Record<string, unknown>): Promise<void>;
    };
  };
};

declare global {
  var __RUN_EMBER_ORIGIN_HOST_CONFORMANCE__: ((input: {
    apiBaseUrl: string;
    bindingOrigin?: string;
  }) => Promise<unknown>) | undefined;
}

const integrationId = 'integration_browser-conformance';
const integrationVersion = 1;
const partitionKey = browserSessionPartitionKey({
  environment: 'sandbox',
  integrationId,
  integrationVersion,
  walletAddress: CONFORMANCE_WALLET,
});
const store = serializedSessionStore({
  async clearValue() {
    await chrome.storage.local.remove(partitionKey);
  },
  async readValue() {
    const values = await chrome.storage.local.get(partitionKey);
    const value = values[partitionKey];
    return typeof value === 'string' ? value : null;
  },
  async writeValue(value) {
    await chrome.storage.local.set({ [partitionKey]: value });
  },
});

globalThis.__RUN_EMBER_ORIGIN_HOST_CONFORMANCE__ = async (input) => {
  try {
    const ownUrl = new URL(chrome.runtime.getURL('/'));
    const ownOrigin = `${ownUrl.protocol}//${ownUrl.host}`;
    return await runOriginHostFixture({
      apiBaseUrl: input.apiBaseUrl,
      crypto: webCrypto(),
      hostBinding: {
        kind: 'chrome_extension',
        origin: input.bindingOrigin ?? ownOrigin,
      },
      integrationId,
      integrationVersion,
      sessionStore: store,
      async withSessionMutation(operation) {
        return navigator.locks.request(`${partitionKey}:mutation`, operation);
      },
    });
  } catch (error) {
    const value = error as { name?: unknown; reason?: unknown };
    return {
      error: {
        name: typeof value?.name === 'string' ? value.name : 'Error',
        reason: typeof value?.reason === 'string' ? value.reason : undefined,
      },
    };
  }
};
