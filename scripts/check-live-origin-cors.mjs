const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

function exactOrigin(name, value, protocol) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute origin.`);
  }
  if (
    parsed.protocol !== protocol ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error(`${name} must be an exact credential-free ${protocol} origin.`);
  }
  return parsed.origin;
}

function chromeOrigin(value) {
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(value)) {
    throw new Error(
      'EMBER_ORIGIN_CONFORMANCE_EXTENSION_ORIGIN must be an exact Chrome extension origin.',
    );
  }
  return value;
}

function tokens(value) {
  return new Set(
    (value ?? '')
      .toLowerCase()
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

async function preflight({ baseUrl, headers, method, origin, path }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': method,
      'access-control-request-headers': headers.join(', '),
    },
    redirect: 'error',
  });
  return {
    allowHeaders: tokens(response.headers.get('access-control-allow-headers')),
    allowMethods: tokens(response.headers.get('access-control-allow-methods')),
    allowOrigin: response.headers.get('access-control-allow-origin'),
    status: response.status,
    vary: tokens(response.headers.get('vary')),
  };
}

function assertAllowed(result, expectedOrigin, method, headers, label) {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${label} preflight returned HTTP ${result.status}.`);
  }
  if (result.allowOrigin !== expectedOrigin) {
    throw new Error(`${label} did not echo the exact approved origin.`);
  }
  if (!result.vary.has('origin')) {
    throw new Error(`${label} did not include Vary: Origin.`);
  }
  if (!result.allowMethods.has(method.toLowerCase())) {
    throw new Error(`${label} did not allow ${method}.`);
  }
  for (const header of headers) {
    if (!result.allowHeaders.has(header.toLowerCase())) {
      throw new Error(`${label} did not allow ${header}.`);
    }
  }
}

const baseUrl = exactOrigin(
  'EMBER_ORIGIN_CONFORMANCE_BASE_URL',
  required('EMBER_ORIGIN_CONFORMANCE_BASE_URL'),
  'https:',
);
const webOrigin = exactOrigin(
  'EMBER_ORIGIN_CONFORMANCE_WEB_ORIGIN',
  required('EMBER_ORIGIN_CONFORMANCE_WEB_ORIGIN'),
  'https:',
);
const extensionOrigin = chromeOrigin(
  required('EMBER_ORIGIN_CONFORMANCE_EXTENSION_ORIGIN'),
);
const signedHeaders = [
  'content-type',
  'x-ember-wallet-jti',
  'x-ember-wallet-session',
  'x-ember-wallet-signature',
  'x-ember-wallet-timestamp',
];

for (const [label, origin] of [
  ['HTTPS web challenge', webOrigin],
  ['Chrome extension challenge', extensionOrigin],
]) {
  const result = await preflight({
    baseUrl,
    headers: ['content-type'],
    method: 'POST',
    origin,
    path: '/v1/wallet-sessions/challenges',
  });
  assertAllowed(result, origin, 'POST', ['content-type'], label);
}

for (const [label, origin] of [
  ['HTTPS web signed request', webOrigin],
  ['Chrome extension signed request', extensionOrigin],
]) {
  const result = await preflight({
    baseUrl,
    headers: signedHeaders,
    method: 'GET',
    origin,
    path: '/v1/wallet/offers',
  });
  assertAllowed(result, origin, 'GET', signedHeaders, label);
}

const rejected = await preflight({
  baseUrl,
  headers: signedHeaders,
  method: 'GET',
  origin: 'https://unapproved-origin.invalid',
  path: '/v1/wallet/offers',
});
if (rejected.allowOrigin === 'https://unapproved-origin.invalid') {
  throw new Error('The API allowed an unregistered origin.');
}

console.log(
  `Live CORS conformance passed for ${baseUrl}: HTTPS web and Chrome extension origins.`,
);
