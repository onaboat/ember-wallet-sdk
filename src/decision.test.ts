import { describe, expect, test } from 'vitest';
import { decisionFreshness } from './decision';
import { EmberConfigurationError } from './errors';

const NOW = new Date('2026-09-14T10:00:00.000Z');

describe('decisionFreshness', () => {
  test.each([
    [
      'fresh',
      '2026-09-14T10:00:30.001Z',
      30_000,
      { status: 'fresh', remainingMs: 30_001 },
    ],
    [
      'near the safety boundary',
      '2026-09-14T10:00:30.000Z',
      30_000,
      { status: 'near_expiry', remainingMs: 30_000 },
    ],
    [
      'near expiry',
      '2026-09-14T10:00:00.001Z',
      30_000,
      { status: 'near_expiry', remainingMs: 1 },
    ],
    [
      'expired at equality',
      NOW.toISOString(),
      30_000,
      { status: 'expired', expiredByMs: 0 },
    ],
    [
      'expired before now',
      '2026-09-14T09:59:59.999Z',
      30_000,
      { status: 'expired', expiredByMs: 1 },
    ],
    [
      'invalid',
      'not-a-date',
      30_000,
      { status: 'invalid', reason: 'invalid_expiry' },
    ],
  ] as const)(
    'classifies %s decisions',
    (_case, decisionExpiresAt, margin, expected) => {
      expect(decisionFreshness({ decisionExpiresAt }, NOW, margin)).toEqual(
        expected,
      );
    },
  );

  test.each([-1, 0.5, Number.NaN])(
    'rejects an invalid safety window: %s',
    (margin) => {
      expect(() =>
        decisionFreshness(
          { decisionExpiresAt: NOW.toISOString() },
          NOW,
          margin,
        ),
      ).toThrow(EmberConfigurationError);
    },
  );

  test('rejects an invalid host clock', () => {
    expect(() =>
      decisionFreshness(
        { decisionExpiresAt: NOW.toISOString() },
        new Date(Number.NaN),
        0,
      ),
    ).toThrow(EmberConfigurationError);
  });
});
