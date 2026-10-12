import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  canonicalizeHostBinding,
  validateWalletChallenge,
  type EmberHostBinding,
  type EmberWalletChallenge,
  type EmberWalletScope,
  type ExpectedChallengeAuthority,
} from './challenge';
import { EmberChallengeValidationError, EmberConfigurationError } from './errors';
import type { EmberCrypto } from './encoding';

const NOW = new Date('2026-07-27T12:05:01.000Z');
const WALLET = '11111111111111111111111111111111';
const SESSION_KEY = 'SysvarRent111111111111111111111111111111111';
const CHALLENGE_ID = 'challenge_11111111-1111-4111-8111-111111111111';
const NONCE = '111111111111111111111111';
const SCOPES: EmberWalletScope[] = ['cover:evaluate', 'offers:read'];

const crypto: EmberCrypto = {
  randomUuid: () => '00000000-0000-4000-8000-000000000001',
  async sha256(bytes) {
    return new Uint8Array(createHash('sha256').update(bytes).digest());
  },
  async verifyEd25519() {
    return true;
  },
};

function authority(
  hostBinding: EmberHostBinding,
  overrides: Partial<ExpectedChallengeAuthority> = {},
): ExpectedChallengeAuthority {
  return {
    environment: 'sandbox',
    hostBinding,
    integrationId: 'integration_demo-wallet',
    integrationVersion: 7,
    requestedScopes: SCOPES,
    sessionPublicKey: SESSION_KEY,
    walletAddress: WALLET,
    ...overrides,
  };
}

async function challengeFor(
  expected: ExpectedChallengeAuthority,
): Promise<EmberWalletChallenge> {
  const binding = canonicalizeHostBinding(
    expected.hostBinding,
    expected.environment,
  );
  const clientBinding =
    binding.kind === 'native' ? binding.applicationId : binding.origin;
  const bindingHash = createHash('sha256').update(clientBinding).digest('hex');
  const clientKind = binding.kind === 'native' ? 'native' : 'browser';
  const domain =
    binding.kind === 'native'
      ? 'api.ember.cover'
      : binding.kind === 'chrome_extension'
        ? binding.origin.slice('chrome-extension://'.length)
        : new URL(binding.origin).host;
  const uri =
    binding.kind === 'native'
      ? 'https://api.ember.cover/wallet-session'
      : binding.origin;
  const scopeOrder: EmberWalletScope[] = [
    'offers:read',
    'terms:accept',
    'quotes:create',
    'payments:create',
    'cover:evaluate',
    'evidence:write',
    'records:read',
    'claims:create',
  ];
  const orderedScopes = [...expected.requestedScopes].sort(
    (left, right) => scopeOrder.indexOf(left) - scopeOrder.indexOf(right),
  );
  const resources = [
    `urn:ember:integration:${expected.integrationId}:${expected.integrationVersion}`,
    `urn:ember:environment:${expected.environment}`,
    `urn:ember:session-key:${expected.sessionPublicKey}`,
    `urn:ember:client-kind:${clientKind}`,
    `urn:ember:client-binding-sha256:${bindingHash}`,
    ...orderedScopes.map((scope) => `urn:ember:scope:${scope}`),
  ];
  const issuedAt = '2026-07-27T12:05:00.000Z';
  const expiresAt = '2026-07-27T12:10:00.000Z';
  return {
    challengeId: CHALLENGE_ID,
    expiresAt,
    issuedAt,
    message: `${domain} wants you to sign in with your Solana account:\n${expected.walletAddress}\n\nProve ownership of this wallet and authorize a short-lived Ember Cover session. This does not submit a transaction or move funds.\n\nURI: ${uri}\nVersion: 1\nChain ID: ${expected.environment === 'sandbox' ? 'devnet' : 'mainnet'}\nNonce: ${NONCE}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}\nRequest ID: ${CHALLENGE_ID}\nResources:\n- ${resources.join('\n- ')}`,
    nonce: NONCE,
  };
}

async function expectReason(
  promise: Promise<unknown>,
  reason: EmberChallengeValidationError['reason'],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'EmberChallengeValidationError',
    reason,
  });
}

describe('host binding', () => {
  test('canonicalizes HTTPS and sandbox loopback web origins', () => {
    expect(
      canonicalizeHostBinding(
        { kind: 'web', origin: 'https://Wallet.Example:443' },
        'production',
      ),
    ).toEqual({ kind: 'web', origin: 'https://wallet.example' });
    expect(
      canonicalizeHostBinding(
        { kind: 'web', origin: 'http://127.1:3000' },
        'sandbox',
      ),
    ).toEqual({ kind: 'web', origin: 'http://127.0.0.1:3000' });
  });

  test.each([
    ['production HTTP', { kind: 'web', origin: 'http://wallet.example' }, 'production'],
    ['sandbox non-loopback HTTP', { kind: 'web', origin: 'http://wallet.example' }, 'sandbox'],
    ['wildcard host', { kind: 'web', origin: 'https://*.wallet.example' }, 'production'],
    ['path', { kind: 'web', origin: 'https://wallet.example/path' }, 'production'],
    ['query', { kind: 'web', origin: 'https://wallet.example?q=1' }, 'production'],
  ] as const)('rejects %s origins', (_label, binding, environment) => {
    expect(() => canonicalizeHostBinding(binding, environment)).toThrow(
      EmberConfigurationError,
    );
  });

  test('requires an exact Chrome extension origin', () => {
    const binding = {
      kind: 'chrome_extension',
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    } as const;
    expect(canonicalizeHostBinding(binding, 'production')).toEqual(binding);
    expect(() =>
      canonicalizeHostBinding(
        { ...binding, origin: `${binding.origin}/` },
        'production',
      ),
    ).toThrow(EmberConfigurationError);
  });

  test('retains an exact native application identity', () => {
    expect(
      canonicalizeHostBinding(
        { kind: 'native', applicationId: 'cover.ember.reference' },
        'production',
      ),
    ).toEqual({ kind: 'native', applicationId: 'cover.ember.reference' });
  });

  test('rejects an unknown runtime environment', () => {
    expect(() =>
      canonicalizeHostBinding(
        { kind: 'native', applicationId: 'cover.ember.reference' },
        'staging' as 'production',
      ),
    ).toThrow(EmberConfigurationError);
  });

  test.each([
    ['missing binding', undefined],
    ['legacy browser binding', { kind: 'browser' }],
    ['missing web origin', { kind: 'web' }],
    ['non-string extension origin', { kind: 'chrome_extension', origin: 7 }],
    ['non-string native application ID', { kind: 'native', applicationId: 7 }],
    ['unsafe native application ID', { kind: 'native', applicationId: 'cover/app' }],
    ['non-ASCII native application ID', { kind: 'native', applicationId: 'cöver.app' }],
  ])('reports a configuration error for %s', (_label, binding) => {
    expect(() =>
      canonicalizeHostBinding(binding as EmberHostBinding, 'sandbox'),
    ).toThrow(EmberConfigurationError);
  });
});

describe('wallet challenge validation', () => {
  test.each([
    [
      'web',
      authority(
        { kind: 'web', origin: 'https://wallet.example:8443' },
        { environment: 'production' },
      ),
    ],
    [
      'extension',
      authority({
        kind: 'chrome_extension',
        origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      }),
    ],
    ['native', authority({ kind: 'native', applicationId: 'cover.ember.reference' })],
  ])('accepts the canonical %s vector', async (_label, expected) => {
    const challenge = await challengeFor(expected);
    await expect(
      validateWalletChallenge(challenge, expected, NOW, crypto),
    ).resolves.toBeUndefined();
  });

  test('accepts equivalent RFC3339 response timestamps while requiring canonical message time', async () => {
    const expected = authority({ kind: 'web', origin: 'https://wallet.example' });
    const challenge = {
      ...(await challengeFor(expected)),
      expiresAt: '2026-07-27T12:10:00+00:00',
      issuedAt: '2026-07-27T12:05:00Z',
    };
    await expect(
      validateWalletChallenge(challenge, expected, NOW, crypto),
    ).resolves.toBeUndefined();
  });

  test.each([
    ['wallet address', 'walletAddress', 'SysvarC1ock11111111111111111111111111111111'],
    ['session key', 'sessionPublicKey', WALLET],
    ['integration id', 'integrationId', 'integration_other'],
    ['integration version', 'integrationVersion', 8],
    ['environment', 'environment', 'production'],
    ['host binding', 'hostBinding', { kind: 'web', origin: 'https://other.example' }],
    ['scope', 'requestedScopes', ['offers:read']],
  ] as const)(
    'rejects a message when the expected %s differs',
    async (_label, key, value) => {
      const original = authority({ kind: 'web', origin: 'https://wallet.example' });
      const challenge = await challengeFor(original);
      const changed = { ...original, [key]: value } as ExpectedChallengeAuthority;
      await expectReason(
        validateWalletChallenge(challenge, changed, NOW, crypto),
        'authority_mismatch',
      );
    },
  );

  test.each([
    [
      'nonce',
      (value: EmberWalletChallenge) => ({ ...value, nonce: `${value.nonce}1` }),
      'invalid_response',
    ],
    [
      'request ID',
      (value: EmberWalletChallenge) => ({
        ...value,
        challengeId: 'challenge_22222222-2222-4222-8222-222222222222',
      }),
      'authority_mismatch',
    ],
    [
      'issued time',
      (value: EmberWalletChallenge) => ({
        ...value,
        issuedAt: '2026-07-27T12:04:59.000Z',
      }),
      'invalid_response',
    ],
    [
      'expiry time',
      (value: EmberWalletChallenge) => ({
        ...value,
        expiresAt: '2026-07-27T12:10:01.000Z',
      }),
      'invalid_response',
    ],
  ] as const)('rejects mismatched response %s', async (_label, mutate, reason) => {
    const expected = authority({ kind: 'web', origin: 'https://wallet.example' });
    const original = await challengeFor(expected);
    await expectReason(
      validateWalletChallenge(mutate(original), expected, NOW, crypto),
      reason,
    );
  });

  test.each([
    ['wallet address', WALLET, SESSION_KEY],
    [
      'statement',
      'Prove ownership of this wallet and authorize a short-lived Ember Cover session.',
      'Authorize Ember.',
    ],
    ['domain', 'wallet.example', 'attacker.example'],
    ['URI', 'URI: https://wallet.example', 'URI: https://attacker.example'],
    ['version', 'Version: 1', 'Version: 2'],
    ['chain', 'Chain ID: devnet', 'Chain ID: mainnet'],
    ['nonce', `Nonce: ${NONCE}`, `Nonce: ${NONCE.slice(0, -1)}2`],
    [
      'issued time',
      'Issued At: 2026-07-27T12:05:00.000Z',
      'Issued At: 2026-07-27T12:05:01.000Z',
    ],
    [
      'expiration time',
      'Expiration Time: 2026-07-27T12:10:00.000Z',
      'Expiration Time: 2026-07-27T12:10:01.000Z',
    ],
    ['request ID', `Request ID: ${CHALLENGE_ID}`, 'Request ID: challenge_other'],
    ['integration resource', 'integration_demo-wallet:7', 'integration_demo-wallet:8'],
    ['environment resource', 'environment:sandbox', 'environment:production'],
    ['session-key resource', `session-key:${SESSION_KEY}`, `session-key:${WALLET}`],
    ['client-kind resource', 'client-kind:browser', 'client-kind:native'],
    ['binding hash resource', 'client-binding-sha256:', 'client-binding-sha256:0'],
    ['scope resource', 'scope:cover:evaluate', 'scope:claims:create'],
    ['extra line', 'Resources:', 'Unexpected: value\nResources:'],
    ['missing line', 'Version: 1\n', ''],
  ])('rejects tampered message %s', async (_label, from, to) => {
    const expected = authority({ kind: 'web', origin: 'https://wallet.example' });
    const original = await challengeFor(expected);
    const challenge = { ...original, message: original.message.replace(from, to) };
    await expectReason(
      validateWalletChallenge(challenge, expected, NOW, crypto),
      'authority_mismatch',
    );
  });

  test.each([
    ['reordered', (lines: string[]) => [lines[1]!, lines[0]!, ...lines.slice(2)]],
    ['duplicated', (lines: string[]) => [lines[0]!, ...lines]],
  ])('rejects %s resources', async (_label, arrange) => {
    const expected = authority({ kind: 'web', origin: 'https://wallet.example' });
    const original = await challengeFor(expected);
    const marker = 'Resources:\n- ';
    const [prefix, resourceText] = original.message.split(marker);
    const resources = resourceText!.split('\n- ');
    const challenge = {
      ...original,
      message: `${prefix}${marker}${arrange(resources).join('\n- ')}`,
    };
    await expectReason(
      validateWalletChallenge(challenge, expected, NOW, crypto),
      'authority_mismatch',
    );
  });

  test('rejects a missing resource', async () => {
    const expected = authority({ kind: 'web', origin: 'https://wallet.example' });
    const original = await challengeFor(expected);
    const challenge = {
      ...original,
      message: original.message.replace(`\n- urn:ember:scope:${SCOPES[0]}`, ''),
    };
    await expectReason(
      validateWalletChallenge(challenge, expected, NOW, crypto),
      'authority_mismatch',
    );
  });

  test('accepts API challenges within the wallet clock-skew boundary', async () => {
    const expected = authority({ kind: 'native', applicationId: 'cover.ember.reference' });
    const challenge = await challengeFor(expected);
    await expect(
      validateWalletChallenge(
        challenge,
        expected,
        new Date('2026-07-27T12:04:00.000Z'),
        crypto,
      ),
    ).resolves.toBeUndefined();
  });

  test('rejects challenges beyond clock skew and at expiration', async () => {
    const expected = authority({ kind: 'native', applicationId: 'cover.ember.reference' });
    const challenge = await challengeFor(expected);
    await expectReason(
      validateWalletChallenge(
        challenge,
        expected,
        new Date('2026-07-27T12:03:59.999Z'),
        crypto,
      ),
      'not_yet_valid',
    );
    await expectReason(
      validateWalletChallenge(
        challenge,
        expected,
        new Date('2026-07-27T12:10:00.000Z'),
        crypto,
      ),
      'expired',
    );
  });

  test.each([
    ['noncanonical public key', { walletAddress: `1${WALLET}` }],
    ['duplicate scopes', { requestedScopes: ['offers:read', 'offers:read'] }],
    ['negative version', { integrationVersion: -1 }],
    ['fractional version', { integrationVersion: 1.5 }],
    ['out-of-range version', { integrationVersion: 0x8000_0000 }],
  ])('rejects invalid expected authority: %s', async (_label, overrides) => {
    const valid = authority({ kind: 'native', applicationId: 'cover.ember.reference' });
    const challenge = await challengeFor(valid);
    await expectReason(
      validateWalletChallenge(
        challenge,
        { ...valid, ...overrides } as ExpectedChallengeAuthority,
        NOW,
        crypto,
      ),
      'authority_mismatch',
    );
  });
});
