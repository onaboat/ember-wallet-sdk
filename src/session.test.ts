import { expect, test } from 'vitest';
import { base58Encode } from './encoding';
import { EmberConfigurationError } from './errors';
import type { PersistedWalletSession } from './session';
import { parsePersistedWalletSession, sessionState } from './session';

const WALLET_ADDRESS = '11111111111111111111111111111111';
const SESSION_PUBLIC_KEY = 'SysvarRent111111111111111111111111111111111';

function persistedSession(
  overrides: Partial<PersistedWalletSession> = {},
): PersistedWalletSession {
  return {
    environment: 'sandbox',
    expiresAt: '2026-09-14T12:15:00.000Z',
    integrationId: 'integration_wallet-sdk',
    integrationVersion: 1,
    partnerId: 'partner_ember-cover',
    refreshExpiresAt: '2026-09-15T12:00:00.000Z',
    refreshToken: 'opaque-refresh-credential',
    scopes: ['offers:read', 'cover:evaluate'],
    sessionId: 'session_wallet-sdk',
    sessionPublicKey: SESSION_PUBLIC_KEY,
    walletAddress: WALLET_ADDRESS,
    walletSubjectId: 'wallet_wallet-sdk',
    ...overrides,
  };
}

test('parses a complete persisted wallet session from untrusted storage', () => {
  const stored: unknown = persistedSession();

  expect(parsePersistedWalletSession(stored)).toEqual(stored);
});

test('preserves nonempty opaque server identifiers and refresh credentials', () => {
  const stored = persistedSession({
    integrationId: 'integration identifier from server',
    partnerId: 'legacy/partner:01',
    refreshToken: 'future opaque credential format',
    sessionId: 'session:id:01',
    walletSubjectId: 'subject/id/01',
  });

  expect(parsePersistedWalletSession(stored)).toEqual(stored);
});

test.each([null, undefined, true, 1, 'session', [], {}])(
  'rejects malformed persisted storage value %j',
  (stored) => {
    expect(parsePersistedWalletSession(stored)).toBeNull();
  },
);

test('rejects unexpected persisted authority fields instead of stripping them', () => {
  expect(
    parsePersistedWalletSession({ ...persistedSession(), futureAuthority: true }),
  ).toBeNull();
});

test('rejects domain-schema violations and unknown scopes', () => {
  expect(
    parsePersistedWalletSession(
      persistedSession({ environment: 'preview' as never }),
    ),
  ).toBeNull();
  expect(
    parsePersistedWalletSession(persistedSession({ integrationVersion: -1 })),
  ).toBeNull();
  expect(
    parsePersistedWalletSession(
      persistedSession({ scopes: ['offers:read', 'admin:write' as never] }),
    ),
  ).toBeNull();
  expect(
    parsePersistedWalletSession({
      ...persistedSession(),
      refreshExpiresAt: undefined,
    }),
  ).toBeNull();
});

test('rejects empty and duplicate persisted scope authority', () => {
  expect(parsePersistedWalletSession(persistedSession({ scopes: [] }))).toBeNull();
  expect(
    parsePersistedWalletSession(
      persistedSession({ scopes: ['offers:read', 'offers:read'] }),
    ),
  ).toBeNull();
});

test.each([
  'integrationId',
  'partnerId',
  'refreshToken',
  'sessionId',
  'walletSubjectId',
] as const)(
  'rejects an empty opaque %s',
  (field) => {
    expect(
      parsePersistedWalletSession(persistedSession({ [field]: '' })),
    ).toBeNull();
  },
);

test.each([
  ['walletAddress', '0'.repeat(32)],
  ['walletAddress', base58Encode(new Uint8Array(31).fill(7))],
  ['walletAddress', base58Encode(new Uint8Array(33).fill(7))],
  ['sessionPublicKey', 'not-a-solana-key'],
  ['sessionPublicKey', base58Encode(new Uint8Array(31).fill(9))],
  ['sessionPublicKey', base58Encode(new Uint8Array(33).fill(9))],
] as const)(
  'rejects invalid 32-byte Solana key in %s',
  (field, value) => {
    expect(
      parsePersistedWalletSession(persistedSession({ [field]: value })),
    ).toBeNull();
  },
);

test('rejects absent and non-string session public keys', () => {
  const { sessionPublicKey: _omitted, ...missing } = persistedSession();
  expect(parsePersistedWalletSession(missing)).toBeNull();
  expect(
    parsePersistedWalletSession({ ...persistedSession(), sessionPublicKey: 42 }),
  ).toBeNull();
});

test('rejects a session public key inherited through the prototype', () => {
  const { sessionPublicKey: _omitted, ...fields } = persistedSession();
  const stored = Object.assign(
    Object.create({ sessionPublicKey: SESSION_PUBLIC_KEY }),
    fields,
  );

  expect(parsePersistedWalletSession(stored)).toBeNull();
});

test.each([
  ['expiresAt', 'not-a-date'],
  ['refreshExpiresAt', '2026-09-15'],
] as const)(
  'rejects invalid %s value %s',
  (field, value) => {
    expect(
      parsePersistedWalletSession(persistedSession({ [field]: value })),
    ).toBeNull();
  },
);

test('accepts late rotations whose fixed refresh deadline precedes access expiry', () => {
  const lateRotation = persistedSession({
    expiresAt: '2026-09-15T12:10:00.000Z',
    refreshExpiresAt: '2026-09-15T12:00:00.000Z',
  });
  const equalDeadlines = persistedSession({
    expiresAt: '2026-09-15T12:00:00.000Z',
    refreshExpiresAt: '2026-09-15T12:00:00.000Z',
  });

  expect(parsePersistedWalletSession(lateRotation)).toEqual(lateRotation);
  expect(parsePersistedWalletSession(equalDeadlines)).toEqual(equalDeadlines);
});

test('returns null rather than invoking a throwing storage getter', () => {
  const stored = persistedSession() as PersistedWalletSession & {
    sessionPublicKey: string;
  };
  Object.defineProperty(stored, 'sessionPublicKey', {
    get() {
      throw new Error('corrupt host storage');
    },
  });

  expect(parsePersistedWalletSession(stored)).toBeNull();
});

test('uses a caller policy to distinguish active and rotate-soon sessions', () => {
  const session = persistedSession();

  expect(
    sessionState(session, new Date('2026-09-14T12:09:59.999Z'), 5 * 60_000),
  ).toEqual({ status: 'active' });
  expect(
    sessionState(session, new Date('2026-09-14T12:10:00.000Z'), 5 * 60_000),
  ).toEqual({ status: 'rotate_soon' });
  expect(
    sessionState(session, new Date('2026-09-14T12:14:59.999Z'), 0),
  ).toEqual({ status: 'active' });
});

test('requires reauthentication at the exact access boundary', () => {
  const session = persistedSession();

  expect(
    sessionState(session, new Date('2026-09-14T12:15:00.000Z'), 5 * 60_000),
  ).toEqual({
    status: 'reauthentication_required',
    reason: 'access_expired',
  });
});

test('models the late-rotation refresh boundary while access remains live', () => {
  const lateRotation = persistedSession({
    expiresAt: '2026-09-15T12:10:00.000Z',
    refreshExpiresAt: '2026-09-15T12:00:00.000Z',
  });

  expect(
    sessionState(lateRotation, new Date('2026-09-15T11:59:59.999Z'), 15 * 60_000),
  ).toEqual({ status: 'rotate_soon' });
  expect(
    sessionState(lateRotation, new Date('2026-09-15T12:00:00.000Z'), 15 * 60_000),
  ).toEqual({ status: 'refresh_window_expired' });
  expect(
    sessionState(lateRotation, new Date('2026-09-15T12:10:00.000Z'), 15 * 60_000),
  ).toEqual({
    status: 'reauthentication_required',
    reason: 'access_expired',
  });
});

test('prioritizes access expiry when access and refresh deadlines are equal', () => {
  const equalDeadlines = persistedSession({
    expiresAt: '2026-09-15T12:00:00.000Z',
    refreshExpiresAt: '2026-09-15T12:00:00.000Z',
  });

  expect(
    sessionState(equalDeadlines, new Date('2026-09-15T12:00:00.000Z'), 0),
  ).toEqual({
    status: 'reauthentication_required',
    reason: 'access_expired',
  });
});

test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects invalid rotation window %s',
  (rotateBeforeMs) => {
    expect(() =>
      sessionState(
        persistedSession(),
        new Date('2026-09-14T12:00:00.000Z'),
        rotateBeforeMs,
      ),
    ).toThrow(EmberConfigurationError);
  },
);

test('rejects an invalid current time', () => {
  expect(() =>
    sessionState(persistedSession(), new Date('invalid'), 5 * 60_000),
  ).toThrow(EmberConfigurationError);
});
