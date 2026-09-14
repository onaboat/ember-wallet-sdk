import { EmberConfigurationError } from './errors';

export interface ExpiringDecision {
  decisionExpiresAt: string;
}

export type DecisionFreshness =
  | { status: 'fresh'; remainingMs: number }
  | { status: 'near_expiry'; remainingMs: number }
  | { status: 'expired'; expiredByMs: number }
  | { status: 'invalid'; reason: 'invalid_expiry' };

/**
 * Classify decision validity without choosing a host approval-time policy.
 * Web, extension, and native hosts supply their own measured safety window.
 */
export function decisionFreshness(
  decision: ExpiringDecision,
  now: Date,
  minimumRemainingMs: number,
): DecisionFreshness {
  if (
    !Number.isSafeInteger(minimumRemainingMs) ||
    minimumRemainingMs < 0 ||
    !Number.isFinite(now.getTime())
  ) {
    throw new EmberConfigurationError(
      'Decision freshness requires a valid clock and a nonnegative integer safety window.',
    );
  }

  const expiresAt = Date.parse(decision.decisionExpiresAt);
  if (!Number.isFinite(expiresAt)) {
    return { status: 'invalid', reason: 'invalid_expiry' };
  }

  const remainingMs = expiresAt - now.getTime();
  if (remainingMs <= 0) {
    return { status: 'expired', expiredByMs: Math.abs(remainingMs) };
  }
  if (remainingMs <= minimumRemainingMs) {
    return { status: 'near_expiry', remainingMs };
  }
  return { status: 'fresh', remainingMs };
}
