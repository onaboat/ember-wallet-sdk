import { resolve } from 'node:path';

export const DEVNET_TRANSACTION_APPROVAL = 'I_APPROVE_DEVNET_TRANSACTIONS';

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function hostBinding(env) {
  const kind = required(env, 'EMBER_CONFORMANCE_HOST_KIND');
  const identity = required(env, 'EMBER_CONFORMANCE_HOST_ID');
  if (kind === 'native') return { kind, applicationId: identity };
  if (kind === 'web' || kind === 'chrome_extension') {
    return { kind, origin: identity };
  }
  throw new Error(
    'EMBER_CONFORMANCE_HOST_KIND must be native, web, or chrome_extension.',
  );
}

export function readConformanceConfig(env = process.env, cwd = process.cwd()) {
  const environment = required(env, 'EMBER_CONFORMANCE_ENVIRONMENT');
  if (environment !== 'sandbox') {
    throw new Error('Real-API conformance is restricted to the sandbox environment.');
  }
  if (required(env, 'EMBER_CONFORMANCE_TRANSACTION_APPROVAL') !== DEVNET_TRANSACTION_APPROVAL) {
    throw new Error(
      `EMBER_CONFORMANCE_TRANSACTION_APPROVAL must equal ${DEVNET_TRANSACTION_APPROVAL}.`,
    );
  }

  const baseUrl = required(env, 'EMBER_CONFORMANCE_BASE_URL');
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error('EMBER_CONFORMANCE_BASE_URL must be an absolute URL.');
  }
  const local =
    parsedBaseUrl.hostname === 'localhost' ||
    parsedBaseUrl.hostname === '127.0.0.1' ||
    parsedBaseUrl.hostname === '[::1]';
  if (parsedBaseUrl.protocol !== 'https:' && !(parsedBaseUrl.protocol === 'http:' && local)) {
    throw new Error('Conformance requires HTTPS or an exact local sandbox URL.');
  }
  if (
    parsedBaseUrl.username ||
    parsedBaseUrl.password ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash ||
    !['', '/'].includes(parsedBaseUrl.pathname)
  ) {
    throw new Error('EMBER_CONFORMANCE_BASE_URL must be a credential-free origin.');
  }

  const integrationVersion = Number(
    required(env, 'EMBER_CONFORMANCE_INTEGRATION_VERSION'),
  );
  if (!Number.isSafeInteger(integrationVersion) || integrationVersion < 0) {
    throw new Error(
      'EMBER_CONFORMANCE_INTEGRATION_VERSION must be a nonnegative integer.',
    );
  }

  return Object.freeze({
    baseUrl: parsedBaseUrl.origin,
    environment,
    fixtureModule: resolve(
      cwd,
      required(env, 'EMBER_CONFORMANCE_FIXTURE_MODULE'),
    ),
    hostBinding: hostBinding(env),
    integrationId: required(env, 'EMBER_CONFORMANCE_INTEGRATION_ID'),
    integrationVersion,
    offerId: required(env, 'EMBER_CONFORMANCE_OFFER_ID'),
    pollIntervalMs: positiveInteger(
      env,
      'EMBER_CONFORMANCE_POLL_INTERVAL_MS',
      2_000,
    ),
    stateTimeoutMs: positiveInteger(
      env,
      'EMBER_CONFORMANCE_STATE_TIMEOUT_MS',
      120_000,
    ),
  });
}
