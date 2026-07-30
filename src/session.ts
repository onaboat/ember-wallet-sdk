import type {
  IntegrationEnvironment,
  WalletClientBindingRequest,
  WalletScope,
  WalletSessionResponse,
} from './generated/types.gen';

export interface EmberMessageSigner {
  /** Canonical base58 Ed25519 public key. */
  readonly publicKey: string;
  /** Sign the exact bytes without adding a prefix or encoding transform. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export interface PersistedWalletSession extends WalletSessionResponse {
  /** Public key of the host-custodied ephemeral session signer. */
  sessionPublicKey: string;
}

/**
 * The host owns secure persistence. Implementations must treat refreshToken
 * as a credential and must never persist the wallet private key or seed.
 */
export interface WalletSessionStore {
  load(): Promise<PersistedWalletSession | null>;
  save(session: PersistedWalletSession): Promise<void>;
  clear(): Promise<void>;
}

export interface OpenWalletSessionInput {
  walletSigner: EmberMessageSigner;
  requestedScopes: ReadonlyArray<WalletScope>;
}

export interface EmberWalletIdentity {
  environment: IntegrationEnvironment;
  integrationId: string;
  walletAddress: string;
  walletSubjectId: string;
}

export function nativeApplicationHeader(
  client: WalletClientBindingRequest,
): Record<string, string> {
  return client.kind === 'native'
    ? { 'x-ember-application-id': client.applicationId }
    : {};
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
