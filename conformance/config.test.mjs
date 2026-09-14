import { describe, expect, test } from 'vitest';
import {
  DEVNET_TRANSACTION_APPROVAL,
  readConformanceConfig,
} from './config.mjs';

function environment(overrides = {}) {
  return {
    EMBER_CONFORMANCE_BASE_URL: 'https://qa.ember.example',
    EMBER_CONFORMANCE_ENVIRONMENT: 'sandbox',
    EMBER_CONFORMANCE_FIXTURE_MODULE: './fixture.mjs',
    EMBER_CONFORMANCE_HOST_ID: 'com.ember.conformance',
    EMBER_CONFORMANCE_HOST_KIND: 'native',
    EMBER_CONFORMANCE_INTEGRATION_ID: 'integration_conformance',
    EMBER_CONFORMANCE_INTEGRATION_VERSION: '1',
    EMBER_CONFORMANCE_OFFER_ID: 'offer_devnet-qa-core-annual',
    EMBER_CONFORMANCE_TRANSACTION_APPROVAL: DEVNET_TRANSACTION_APPROVAL,
    ...overrides,
  };
}

describe('real API conformance configuration', () => {
  test('accepts an explicit sandbox authority and transaction approval', () => {
    expect(readConformanceConfig(environment(), '/workspace')).toMatchObject({
      baseUrl: 'https://qa.ember.example',
      environment: 'sandbox',
      fixtureModule: '/workspace/fixture.mjs',
      hostBinding: { kind: 'native', applicationId: 'com.ember.conformance' },
      integrationId: 'integration_conformance',
      integrationVersion: 1,
      pollIntervalMs: 2_000,
      stateTimeoutMs: 120_000,
    });
  });

  test.each([
    ['production', { EMBER_CONFORMANCE_ENVIRONMENT: 'production' }],
    ['missing approval', { EMBER_CONFORMANCE_TRANSACTION_APPROVAL: '' }],
    ['wrong approval', { EMBER_CONFORMANCE_TRANSACTION_APPROVAL: 'yes' }],
    ['remote HTTP', { EMBER_CONFORMANCE_BASE_URL: 'http://qa.ember.example' }],
    ['URL credentials', { EMBER_CONFORMANCE_BASE_URL: 'https://user:secret@qa.ember.example' }],
    ['URL path', { EMBER_CONFORMANCE_BASE_URL: 'https://qa.ember.example/v1' }],
    ['unknown host', { EMBER_CONFORMANCE_HOST_KIND: 'electron' }],
    ['invalid version', { EMBER_CONFORMANCE_INTEGRATION_VERSION: '1.5' }],
    ['invalid timeout', { EMBER_CONFORMANCE_STATE_TIMEOUT_MS: '0' }],
  ])('rejects %s configuration', (_case, overrides) => {
    expect(() => readConformanceConfig(environment(overrides))).toThrow();
  });

  test('maps origin-bound host configuration without runtime globals', () => {
    expect(
      readConformanceConfig(
        environment({
          EMBER_CONFORMANCE_HOST_ID: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
          EMBER_CONFORMANCE_HOST_KIND: 'chrome_extension',
        }),
      ).hostBinding,
    ).toEqual({
      kind: 'chrome_extension',
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    });
  });
});
