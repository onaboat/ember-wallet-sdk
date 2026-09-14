import { EmberChallengeValidationError, EmberConfigurationError } from './errors';
import { base58Decode, sha256Hex, utf8, type EmberCrypto } from './encoding';

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_EMBER_IDENTIFIER_LENGTH = 96;
const MAX_APPLICATION_ID_LENGTH = 200;
const MAX_INTEGRATION_VERSION = 0x7fff_ffff;
const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const CHALLENGE_ID = /^challenge_[a-z0-9-]+$/;
const INTEGRATION_ID = /^integration_[a-z0-9-]+$/;
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const EMBER_WALLET_SCOPES = [
  'offers:read',
  'terms:accept',
  'quotes:create',
  'payments:create',
  'cover:evaluate',
  'evidence:write',
  'records:read',
  'claims:create',
] as const;

export type EmberEnvironment = 'sandbox' | 'production';
export type EmberWalletScope = (typeof EMBER_WALLET_SCOPES)[number];

export interface EmberWalletChallenge {
  readonly challengeId: string;
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly message: string;
  readonly nonce: string;
}

const SCOPE_POSITION = new Map<EmberWalletScope, number>(
  EMBER_WALLET_SCOPES.map((scope, index) => [scope, index]),
);

/** Host identity asserted by the SDK independently of transport wire types. */
export type EmberHostBinding =
  | { readonly kind: 'web'; readonly origin: string }
  | { readonly kind: 'chrome_extension'; readonly origin: string }
  | { readonly kind: 'native'; readonly applicationId: string };

export interface ExpectedChallengeAuthority {
  readonly hostBinding: EmberHostBinding;
  readonly environment: EmberEnvironment;
  readonly integrationId: string;
  readonly integrationVersion: number;
  readonly requestedScopes: ReadonlyArray<EmberWalletScope>;
  readonly sessionPublicKey: string;
  readonly walletAddress: string;
}

/**
 * Validate and normalize a host identity before it crosses the transport edge.
 * The returned value is safe to retain as the expected challenge authority.
 */
export function canonicalizeHostBinding(
  binding: EmberHostBinding,
  environment: EmberEnvironment,
): EmberHostBinding {
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new EmberConfigurationError(
      'environment must be exactly sandbox or production.',
    );
  }
  if (typeof binding !== 'object' || binding === null) {
    throw new EmberConfigurationError(
      'hostBinding must explicitly identify a web, Chrome extension, or native host.',
    );
  }
  if (
    binding.kind !== 'web' &&
    binding.kind !== 'chrome_extension' &&
    binding.kind !== 'native'
  ) {
    throw new EmberConfigurationError(
      'hostBinding.kind must be exactly web, chrome_extension, or native; legacy browser bindings must be migrated.',
    );
  }
  if (binding.kind === 'native') {
    if (
      typeof binding.applicationId !== 'string' ||
      binding.applicationId.length === 0 ||
      binding.applicationId.length > MAX_APPLICATION_ID_LENGTH ||
      !/^[A-Za-z0-9._:-]+$/.test(binding.applicationId)
    ) {
      throw new EmberConfigurationError(
        'Native applicationId must use 1–200 ASCII letters, digits, dots, underscores, colons, or hyphens.',
      );
    }
    return { kind: 'native', applicationId: binding.applicationId };
  }

  if (binding.kind === 'chrome_extension') {
    if (
      typeof binding.origin !== 'string' ||
      !CHROME_EXTENSION_ORIGIN.test(binding.origin)
    ) {
      throw new EmberConfigurationError(
        'Chrome extension origin must be chrome-extension:// followed by its canonical 32-character ID.',
      );
    }
    return { kind: 'chrome_extension', origin: binding.origin };
  }

  let parsed: URL;
  if (typeof binding.origin !== 'string') {
    throw new EmberConfigurationError('Web origin must be a valid absolute URL.');
  }
  try {
    parsed = new URL(binding.origin);
  } catch {
    throw new EmberConfigurationError('Web origin must be a valid absolute URL.');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname.includes('*') ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin === 'null'
  ) {
    throw new EmberConfigurationError(
      'Web origin must contain only a scheme, host, and optional port.',
    );
  }
  const isSecure = parsed.protocol === 'https:';
  const permitsLoopbackHttp =
    environment === 'sandbox' &&
    parsed.protocol === 'http:' &&
    isLoopbackHostname(parsed.hostname);
  if (!isSecure && !permitsLoopbackHttp) {
    throw new EmberConfigurationError(
      environment === 'production'
        ? 'Production web origins must use HTTPS.'
        : 'Sandbox web origins must use HTTPS or loopback HTTP.',
    );
  }
  return { kind: 'web', origin: parsed.origin };
}

/**
 * Fail closed unless the API challenge is the exact message authorized by the
 * session-opening inputs. Call this before exposing bytes to a wallet signer.
 */
export async function validateWalletChallenge(
  challenge: EmberWalletChallenge,
  expected: ExpectedChallengeAuthority,
  now: Date,
  crypto: EmberCrypto,
): Promise<void> {
  const issuedAt = canonicalTimestamp(challenge.issuedAt);
  const expiresAt = canonicalTimestamp(challenge.expiresAt);
  if (
    issuedAt === undefined ||
    expiresAt === undefined ||
    expiresAt - issuedAt !== CHALLENGE_LIFETIME_MS ||
    !isCanonicalChallengeId(challenge.challengeId) ||
    !isCanonicalNonce(challenge.nonce)
  ) {
    fail('invalid_response');
  }

  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) fail('invalid_response');
  if (nowMs < issuedAt) fail('not_yet_valid');
  if (nowMs >= expiresAt) fail('expired');

  let hostBinding: EmberHostBinding;
  try {
    if (expected.environment !== 'sandbox' && expected.environment !== 'production') {
      fail('authority_mismatch');
    }
    hostBinding = canonicalizeHostBinding(
      expected.hostBinding,
      expected.environment,
    );
  } catch {
    fail('authority_mismatch');
  }

  if (
    !isCanonicalIntegrationId(expected.integrationId) ||
    !Number.isSafeInteger(expected.integrationVersion) ||
    expected.integrationVersion < 0 ||
    expected.integrationVersion > MAX_INTEGRATION_VERSION ||
    !isCanonicalPublicKey(expected.sessionPublicKey) ||
    !isCanonicalPublicKey(expected.walletAddress) ||
    !hasCanonicalScopes(expected.requestedScopes)
  ) {
    fail('authority_mismatch');
  }

  const clientKind = hostBinding.kind === 'native' ? 'native' : 'browser';
  const clientBinding =
    hostBinding.kind === 'native' ? hostBinding.applicationId : hostBinding.origin;
  const bindingHash = await sha256Hex(crypto, utf8(clientBinding));
  if (!/^[0-9a-f]{64}$/.test(bindingHash)) fail('invalid_response');

  const scopes = [...expected.requestedScopes].sort(
    (left, right) =>
      (SCOPE_POSITION.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (SCOPE_POSITION.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
  const resources = [
    `urn:ember:integration:${expected.integrationId}:${expected.integrationVersion}`,
    `urn:ember:environment:${expected.environment}`,
    `urn:ember:session-key:${expected.sessionPublicKey}`,
    `urn:ember:client-kind:${clientKind}`,
    `urn:ember:client-binding-sha256:${bindingHash}`,
    ...scopes.map((scope) => `urn:ember:scope:${scope}`),
  ];
  const domain =
    hostBinding.kind === 'native'
      ? 'api.ember.cover'
      : originDomain(hostBinding.origin);
  const uri =
    hostBinding.kind === 'native'
      ? 'https://api.ember.cover/wallet-session'
      : hostBinding.origin;
  const chain = expected.environment === 'sandbox' ? 'devnet' : 'mainnet';
  const canonicalMessage = `${domain} wants you to sign in with your Solana account:\n${expected.walletAddress}\n\nProve ownership of this wallet and authorize a short-lived Ember Cover session. This does not submit a transaction or move funds.\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chain}\nNonce: ${challenge.nonce}\nIssued At: ${new Date(issuedAt).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}\nRequest ID: ${challenge.challengeId}\nResources:\n- ${resources.join('\n- ')}`;

  if (challenge.message !== canonicalMessage) fail('authority_mismatch');
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]') return true;
  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

function canonicalTimestamp(value: string): number | undefined {
  if (!RFC3339_TIMESTAMP.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isCanonicalChallengeId(value: string): boolean {
  return value.length <= MAX_EMBER_IDENTIFIER_LENGTH && CHALLENGE_ID.test(value);
}

function isCanonicalIntegrationId(value: string): boolean {
  return value.length <= MAX_EMBER_IDENTIFIER_LENGTH && INTEGRATION_ID.test(value);
}

function isCanonicalNonce(value: string): boolean {
  try {
    return base58Decode(value).length === 24;
  } catch {
    return false;
  }
}

function isCanonicalPublicKey(value: string): boolean {
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}

function hasCanonicalScopes(scopes: ReadonlyArray<EmberWalletScope>): boolean {
  return (
    scopes.length > 0 &&
    scopes.length <= EMBER_WALLET_SCOPES.length &&
    scopes.every((scope) => SCOPE_POSITION.has(scope)) &&
    new Set(scopes).size === scopes.length
  );
}

function originDomain(origin: string): string {
  if (origin.startsWith('chrome-extension://')) {
    return origin.slice('chrome-extension://'.length);
  }
  const parsed = new URL(origin);
  return parsed.port === '' ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
}

function fail(
  reason:
    | 'authority_mismatch'
    | 'expired'
    | 'invalid_response'
    | 'not_yet_valid',
): never {
  throw new EmberChallengeValidationError(reason);
}
