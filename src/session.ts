import * as z from 'zod';
import {
  EMBER_WALLET_SCOPES,
  type EmberEnvironment,
  type EmberWalletScope,
} from './challenge';
import { base58Decode } from './encoding';
import { EmberConfigurationError } from './errors';

export interface EmberMessageSigner {
  /** Canonical base58 Ed25519 public key. */
  readonly publicKey: string;
  /** Sign the exact bytes without adding a prefix or encoding transform. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export interface PersistedWalletSession {
  environment: EmberEnvironment;
  expiresAt: string;
  integrationId: string;
  integrationVersion: number;
  partnerId: string;
  refreshExpiresAt: string;
  refreshToken: string;
  scopes: Array<EmberWalletScope>;
  sessionId: string;
  /** Public key of the host-custodied ephemeral session signer. */
  sessionPublicKey: string;
  walletAddress: string;
  walletSubjectId: string;
}

/**
 * The host owns secure persistence. Implementations must treat refreshToken
 * as a credential and must never persist the wallet private key or seed.
 */
export interface WalletSessionStore {
  load(): Promise<unknown>;
  save(session: PersistedWalletSession): Promise<void>;
  clear(): Promise<void>;
}

export type WalletSessionState =
  | { status: 'active' }
  | { status: 'rotate_soon' }
  | { status: 'refresh_window_expired' }
  | { status: 'reauthentication_required'; reason: 'access_expired' };

export interface OpenWalletSessionInput {
  walletSigner: EmberMessageSigner;
  requestedScopes: ReadonlyArray<EmberWalletScope>;
}

export interface EmberWalletIdentity {
  environment: EmberEnvironment;
  integrationId: string;
  walletAddress: string;
  walletSubjectId: string;
}

const PERSISTED_SESSION_FIELDS = [
  'environment',
  'expiresAt',
  'integrationId',
  'integrationVersion',
  'partnerId',
  'refreshExpiresAt',
  'refreshToken',
  'scopes',
  'sessionId',
  'sessionPublicKey',
  'walletAddress',
  'walletSubjectId',
] as const;
const PERSISTED_SESSION_FIELD_NAMES: ReadonlySet<string> = new Set(
  PERSISTED_SESSION_FIELDS,
);
const MAX_INT32 = 2_147_483_647;

const persistedWalletSessionSchema = z.strictObject({
  environment: z.enum(['sandbox', 'production']),
  expiresAt: z.iso.datetime({ offset: true }),
  integrationId: z.string(),
  integrationVersion: z.int().min(0).max(MAX_INT32),
  partnerId: z.string(),
  refreshExpiresAt: z.iso.datetime({ offset: true }),
  refreshToken: z.string(),
  scopes: z.array(z.enum(EMBER_WALLET_SCOPES)),
  sessionId: z.string(),
  sessionPublicKey: z.string(),
  walletAddress: z.string(),
  walletSubjectId: z.string(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactPersistedSessionFields(value: Record<string, unknown>): boolean {
  const fields = Reflect.ownKeys(value);
  return (
    fields.length === PERSISTED_SESSION_FIELDS.length &&
    fields.every(
      (field) =>
        typeof field === 'string' &&
        PERSISTED_SESSION_FIELD_NAMES.has(field),
    )
  );
}

function isCanonicalSolanaPublicKey(value: string): boolean {
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}

/**
 * Parse a session loaded from host-owned storage without trusting its shape.
 * Invalid persisted authority is represented as null so callers can clear it.
 */
export function parsePersistedWalletSession(
  value: unknown,
): PersistedWalletSession | null {
  try {
    if (
      !isRecord(value) ||
      !hasExactPersistedSessionFields(value) ||
      typeof value.sessionPublicKey !== 'string'
    ) {
      return null;
    }

    const parsed = persistedWalletSessionSchema.safeParse(value);
    if (!parsed.success) return null;

    const session = parsed.data;
    if (
      [
        session.integrationId,
        session.partnerId,
        session.refreshToken,
        session.sessionId,
        session.walletSubjectId,
      ].some((field) => field.length === 0) ||
      session.scopes.length === 0 ||
      new Set(session.scopes).size !== session.scopes.length ||
      !isCanonicalSolanaPublicKey(session.walletAddress) ||
      !isCanonicalSolanaPublicKey(session.sessionPublicKey)
    ) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

/**
 * Describe whether a validated session can be used, should be rotated before
 * access expiry, or requires the wallet owner to authenticate again.
 */
export function sessionState(
  session: PersistedWalletSession,
  now: Date,
  rotateBeforeMs: number,
): WalletSessionState {
  if (!Number.isFinite(rotateBeforeMs) || rotateBeforeMs < 0) {
    throw new EmberConfigurationError(
      'rotateBeforeMs must be a finite, nonnegative number of milliseconds.',
    );
  }

  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new EmberConfigurationError('now must be a valid Date.');
  }

  const expiresAtMs = Date.parse(session.expiresAt);
  const refreshExpiresAtMs = Date.parse(session.refreshExpiresAt);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(refreshExpiresAtMs)) {
    throw new EmberConfigurationError(
      'Session expiry timestamps must be valid ISO date-times.',
    );
  }

  if (nowMs >= expiresAtMs) {
    return {
      status: 'reauthentication_required',
      reason: 'access_expired',
    };
  }
  if (nowMs >= refreshExpiresAtMs) {
    return { status: 'refresh_window_expired' };
  }
  if (expiresAtMs - nowMs <= rotateBeforeMs) {
    return { status: 'rotate_soon' };
  }
  return { status: 'active' };
}

export function walletRequestPayload(input: {
  bodySha256: string;
  jti: string;
  method: string;
  pathAndQuery: string;
  sessionId: string;
  timestamp: string;
}): Uint8Array {
  return new TextEncoder().encode(
    [
      'ember-wallet-request-v1',
      input.sessionId,
      input.method,
      input.pathAndQuery,
      input.timestamp,
      input.jti,
      input.bodySha256,
    ].join('\n'),
  );
}
