import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const fixtureRoot = join(root, 'conformance', 'origin-host');
const temporary = await mkdtemp(join(tmpdir(), 'ember-origin-hosts-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmEnvironment = {
  ...process.env,
  npm_config_cache: join(root, 'node_modules', '.cache', 'npm-origin-hosts'),
};
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const walletAddress = '11111111111111111111111111111111';
const integrationId = 'integration_browser-conformance';
const offerId = 'offer_browser-conformance';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function browserLaunchOptions() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured) return { executablePath: configured };
  if (existsSync(chromium.executablePath())) return {};
  if (existsSync(systemChrome)) return { executablePath: systemChrome };
  return {};
}

function extensionBrowserLaunchOptions() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  return configured ? { executablePath: configured } : { channel: 'chromium' };
}

function json(response, status, body, origin) {
  const headers = {
    'content-type': 'application/json',
    ...(origin ? corsHeaders(origin) : {}),
  };
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': [
      'content-type',
      'idempotency-key',
      'x-ember-wallet-jti',
      'x-ember-wallet-session',
      'x-ember-wallet-signature',
      'x-ember-wallet-timestamp',
    ].join(', '),
    'access-control-max-age': '300',
    vary: 'Origin',
  };
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function challengeFor({ binding, body, sequence }) {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1_000);
  const challengeId = `challenge_origin-host-${sequence}`;
  const nonce = '111111111111111111111111';
  const bindingSha256 = createHash('sha256').update(binding).digest('hex');
  const resources = [
    `urn:ember:integration:${integrationId}:1`,
    'urn:ember:environment:sandbox',
    `urn:ember:session-key:${body.sessionPublicKey}`,
    'urn:ember:client-kind:browser',
    `urn:ember:client-binding-sha256:${bindingSha256}`,
    ...body.requestedScopes.map((scope) => `urn:ember:scope:${scope}`),
  ];
  const domain = binding.startsWith('chrome-extension://')
    ? binding.slice('chrome-extension://'.length)
    : new URL(binding).host;
  const message = [
    `${domain} wants you to sign in with your Solana account:`,
    body.walletAddress,
    '',
    'Prove ownership of this wallet and authorize a short-lived Ember Cover session. This does not submit a transaction or move funds.',
    '',
    `URI: ${binding}`,
    'Version: 1',
    'Chain ID: devnet',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
    `Request ID: ${challengeId}`,
    'Resources:',
    ...resources.map((resource) => `- ${resource}`),
  ].join('\n');
  return {
    challenge: {
      challengeId,
      expiresAt: expiresAt.toISOString(),
      issuedAt: issuedAt.toISOString(),
      message,
      nonce,
    },
    session: {
      environment: 'sandbox',
      expiresAt: new Date(issuedAt.getTime() + 15 * 60 * 1_000).toISOString(),
      integrationId,
      integrationVersion: 1,
      partnerId: 'partner_browser-conformance',
      refreshExpiresAt: new Date(
        issuedAt.getTime() + 24 * 60 * 60 * 1_000,
      ).toISOString(),
      refreshToken: `refresh_origin-host-${sequence}`,
      scopes: body.requestedScopes,
      sessionId: `session_origin-host-${sequence}`,
      walletAddress: body.walletAddress,
      walletSubjectId: 'wallet_browser-conformance',
    },
  };
}

function offer() {
  return {
    aggregateLimitMicros: '120000000000',
    appealWindowDays: 7,
    availabilityMode: 'test',
    benefitPeriodCount: 12,
    benefitPeriodLimitMicros: '10000000000',
    cancellationRuleCode: 'no_post_activation_cancellation',
    catalogueSha256: 'd'.repeat(64),
    cluster: 'devnet',
    coverageDurationDays: 365,
    coverageDurationMonths: 12,
    coveredTransactionLimit: 100,
    deductibleMicros: '0',
    delegateLossTailDays: 30,
    displayName: 'Browser conformance offer',
    environment: 'sandbox',
    immediateLossClaimWindowDays: 7,
    lifecycle: 'testing',
    offerId,
    offerVersion: 1,
    payerMustEqualProtectedWallet: true,
    paymentAsset: 'USDC',
    paymentAssetDecimals: 6,
    paymentMint: walletAddress,
    paymentTokenProgram: walletAddress,
    perLossLimitMicros: '10000000000',
    policySha256: 'c'.repeat(64),
    policyVersion: 'policy-browser-conformance',
    priceBaseUnits: '1000000',
    productCode: 'core',
    protectedWalletCount: 1,
    refundRuleCode: 'operational_or_mandatory_law_only',
    snapshotSha256: 'a'.repeat(64),
    termsSha256: 'b'.repeat(64),
    termsVersion: 'terms-browser-conformance',
    waitingPeriodDays: 0,
  };
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address.');
  return address.port;
}

async function close(server) {
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function bundle(entryPoint, outfile, sdkEntry) {
  const result = await build({
    absWorkingDir: root,
    bundle: true,
    conditions: ['browser', 'import'],
    entryPoints: [entryPoint],
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    outfile,
    platform: 'browser',
    sourcemap: false,
    target: ['es2022'],
    plugins: [
      {
        name: 'packed-wallet-sdk',
        setup(context) {
          context.onResolve(
            { filter: /^@embercover\/wallet-sdk$/ },
            () => ({ path: sdkEntry }),
          );
        },
      },
    ],
  });
  const inputs = Object.keys(result.metafile.inputs).map((input) => resolve(root, input));
  assert(
    inputs.some((input) => input === sdkEntry),
    'Browser bundle did not consume the packed SDK entry point.',
  );
  assert(
    inputs.every((input) => !input.startsWith(join(root, 'src'))),
    'Browser bundle imported SDK source instead of the installed package.',
  );
  const output = await readFile(outfile, 'utf8');
  assert(!/\bnode:/.test(output), 'Browser bundle contains a Node built-in import.');
  assert(!/\bBuffer\b/.test(output), 'Browser bundle contains a Node Buffer dependency.');
}

async function resolvedPageResult(page) {
  return page.evaluate(async () => {
    const value = globalThis.__EMBER_ORIGIN_HOST_RESULT__;
    if (!value) throw new Error('Web fixture did not publish a result.');
    return await value;
  });
}

async function extensionWorker(context) {
  const existing = context
    .serviceWorkers()
    .find((worker) => worker.url().startsWith('chrome-extension://'));
  return (
    existing ??
    (await context.waitForEvent('serviceworker', {
      predicate: (worker) => worker.url().startsWith('chrome-extension://'),
      timeout: 15_000,
    }))
  );
}

async function runExtension(worker, input) {
  return worker.evaluate(async (configuration) => {
    const run = globalThis.__RUN_EMBER_ORIGIN_HOST_CONFORMANCE__;
    if (!run) throw new Error('Extension fixture did not expose its runner.');
    return run(configuration);
  }, input);
}

let apiServer;
let webServer;
let browser;
let extensionContext;

try {
  const packageDirectory = join(temporary, 'package');
  const consumerDirectory = join(temporary, 'consumer');
  const webDirectory = join(temporary, 'web');
  const extensionDirectory = join(temporary, 'extension');
  const certificateDirectory = join(temporary, 'certificate');
  await Promise.all([
    mkdir(packageDirectory),
    mkdir(consumerDirectory),
    mkdir(webDirectory),
    mkdir(extensionDirectory),
    mkdir(certificateDirectory),
  ]);

  const packed = JSON.parse(
    run(
      npm,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', packageDirectory],
      { cwd: root, env: npmEnvironment },
    ),
  );
  const filename = packed[0]?.filename;
  if (typeof filename !== 'string') throw new Error('npm pack returned no filename.');
  const tarball = join(packageDirectory, filename);
  await writeFile(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );
  run(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      '--prefix',
      consumerDirectory,
      tarball,
    ],
    { cwd: temporary, env: npmEnvironment },
  );
  const sdkEntry = join(
    consumerDirectory,
    'node_modules',
    '@embercover',
    'wallet-sdk',
    'dist',
    'index.js',
  );
  await Promise.all([
    bundle(join(fixtureRoot, 'web.ts'), join(webDirectory, 'web.js'), sdkEntry),
    bundle(
      join(fixtureRoot, 'extension.ts'),
      join(extensionDirectory, 'background.js'),
      sdkEntry,
    ),
    copyFile(join(fixtureRoot, 'web.html'), join(webDirectory, 'index.html')),
    copyFile(
      join(fixtureRoot, 'manifest.json'),
      join(extensionDirectory, 'manifest.json'),
    ),
  ]);

  const keyPath = join(certificateDirectory, 'localhost-key.pem');
  const certificatePath = join(certificateDirectory, 'localhost-cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout',
    keyPath,
    '-out',
    certificatePath,
  ], { stdio: 'ignore' });
  const tls = {
    cert: await readFile(certificatePath),
    key: await readFile(keyPath),
  };

  const allowedOrigins = new Set();
  const challenges = new Map();
  const sessions = new Map();
  const observations = {
    challenges: 0,
    offers: 0,
    preflights: [],
    requests: [],
  };

  apiServer = createServer(tls, async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'https://127.0.0.1');
      const origin = request.headers.origin;
      observations.requests.push({
        method: request.method ?? '',
        origin: origin ?? '',
        path: url.pathname,
      });
      if (request.method === 'OPTIONS') {
        observations.preflights.push({
          headers: request.headers['access-control-request-headers'] ?? '',
          origin: origin ?? '',
          path: url.pathname,
        });
        if (!origin || !allowedOrigins.has(origin)) {
          response.writeHead(403, { vary: 'Origin' });
          response.end();
          return;
        }
        response.writeHead(204, corsHeaders(origin));
        response.end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/wallet-sessions/challenges') {
        if (!origin || !allowedOrigins.has(origin)) {
          json(response, 403, { error: 'client_binding_mismatch' });
          return;
        }
        const body = await requestBody(request);
        observations.challenges += 1;
        const record = challengeFor({
          binding: origin,
          body,
          sequence: observations.challenges,
        });
        challenges.set(record.challenge.challengeId, { origin, ...record });
        json(response, 200, record.challenge, origin);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/wallet-sessions') {
        const body = await requestBody(request);
        const record = challenges.get(body.challengeId);
        if (!record || (origin && origin !== record.origin)) {
          json(response, 403, { error: 'client_binding_mismatch' }, origin);
          return;
        }
        sessions.set(record.session.sessionId, record.origin);
        json(response, 200, record.session, origin ?? record.origin);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/wallet/offers') {
        const sessionId = request.headers['x-ember-wallet-session'];
        const sessionOrigin = sessions.get(sessionId);
        const permittedMissingExtensionOrigin =
          !origin && sessionOrigin?.startsWith('chrome-extension://');
        if (
          typeof sessionId !== 'string' ||
          !sessionOrigin ||
          (!permittedMissingExtensionOrigin && origin !== sessionOrigin)
        ) {
          json(response, 403, { error: 'client_binding_mismatch' }, origin);
          return;
        }
        for (const header of [
          'x-ember-wallet-jti',
          'x-ember-wallet-signature',
          'x-ember-wallet-timestamp',
        ]) {
          if (!request.headers[header]) {
            json(response, 400, { error: 'invalid_request' }, origin);
            return;
          }
        }
        observations.offers += 1;
        json(response, 200, { offers: [offer()] }, origin);
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.name : 'Error');
    }
  });
  const apiPort = await listen(apiServer);
  const apiBaseUrl = `https://127.0.0.1:${apiPort}`;

  webServer = createServer(tls, async (request, response) => {
    const path = new URL(request.url ?? '/', 'https://127.0.0.1').pathname;
    const filename = path === '/web.js' ? 'web.js' : 'index.html';
    response.writeHead(200, {
      'content-security-policy':
        "default-src 'self'; connect-src https://127.0.0.1:*; script-src 'self'; style-src 'self'",
      'content-type': filename.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : 'text/html; charset=utf-8',
    });
    response.end(await readFile(join(webDirectory, filename)));
  });
  const webPort = await listen(webServer);
  const approvedWebOrigin = `https://127.0.0.1:${webPort}`;
  allowedOrigins.add(approvedWebOrigin);
  const approvedWebUrl = `${approvedWebOrigin}/?api=${encodeURIComponent(apiBaseUrl)}`;

  browser = await chromium.launch({
    headless: true,
    ...browserLaunchOptions(),
  });
  const webContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await webContext.newPage();
  await page.goto(approvedWebUrl);
  const firstWebRun = await resolvedPageResult(page);
  assert(firstWebRun.sessionOpened === true, 'HTTPS web fixture did not open a session.');
  assert(firstWebRun.signedRequestCompleted === true, 'HTTPS web signed request failed.');
  const challengeCountAfterOpen = observations.challenges;

  await page.reload();
  const reloadedWebRun = await resolvedPageResult(page);
  assert(reloadedWebRun.sessionRestored === true, 'HTTPS reload did not restore its session.');
  assert(
    observations.challenges === challengeCountAfterOpen,
    'HTTPS reload opened a duplicate session.',
  );

  await page.evaluate(() => localStorage.clear());
  const challengeCountBeforeTabs = observations.challenges;
  const tabA = await webContext.newPage();
  const tabB = await webContext.newPage();
  await Promise.all([tabA.goto(approvedWebUrl), tabB.goto(approvedWebUrl)]);
  const [tabAResult, tabBResult] = await Promise.all([
    resolvedPageResult(tabA),
    resolvedPageResult(tabB),
  ]);
  assert(
    [tabAResult, tabBResult].filter((result) => result.sessionOpened).length === 1,
    'Web Locks did not elect one session-opening tab.',
  );
  assert(
    observations.challenges === challengeCountBeforeTabs + 1,
    'Multi-tab contention created more than one authority.',
  );

  const primaryPartition = await tabA.evaluate(
    () => globalThis.__EMBER_ORIGIN_HOST_CONTROL__.partitionKey,
  );
  const secondaryWallet = 'Vote111111111111111111111111111111111111111';
  const secondarySessionKey = 'Stake11111111111111111111111111111111111111';
  const secondaryPage = await webContext.newPage();
  await secondaryPage.goto(
    `${approvedWebUrl}&wallet=${encodeURIComponent(secondaryWallet)}` +
      `&sessionKey=${encodeURIComponent(secondarySessionKey)}`,
  );
  const secondaryResult = await resolvedPageResult(secondaryPage);
  assert(
    secondaryResult.sessionOpened === true,
    'Switching accounts did not open an isolated session partition.',
  );
  const secondaryPartition = await secondaryPage.evaluate(
    () => globalThis.__EMBER_ORIGIN_HOST_CONTROL__.partitionKey,
  );
  assert(
    secondaryPartition !== primaryPartition,
    'Different protected wallets resolved to the same browser partition.',
  );
  await secondaryPage.evaluate(() =>
    globalThis.__EMBER_ORIGIN_HOST_CONTROL__.clear(),
  );
  const partitionState = await tabA.evaluate(
    ({ primary, secondary }) => ({
      primary: localStorage.getItem(primary) !== null,
      secondary: localStorage.getItem(secondary) !== null,
    }),
    { primary: primaryPartition, secondary: secondaryPartition },
  );
  assert(
    partitionState.primary && !partitionState.secondary,
    'Clearing one wallet partition affected another wallet authority.',
  );

  await page.evaluate(() => localStorage.clear());
  const mismatchedBinding =
    `${approvedWebUrl}&bindingOrigin=${encodeURIComponent('https://wallet-mismatch.example')}`;
  await page.goto(mismatchedBinding);
  const mismatchResult = await resolvedPageResult(page);
  assert(
    mismatchResult.error?.name === 'EmberChallengeValidationError',
    'A mismatched HTTPS challenge binding did not fail locally.',
  );

  const unapprovedPage = await webContext.newPage();
  await unapprovedPage.goto(
    `https://localhost:${webPort}/?api=${encodeURIComponent(apiBaseUrl)}`,
  );
  const unapprovedResult = await resolvedPageResult(unapprovedPage);
  assert(
    unapprovedResult.error?.name === 'EmberNetworkError',
    'An unapproved HTTPS origin was not blocked by CORS.',
  );
  await webContext.close();
  await browser.close();
  browser = undefined;

  const userDataDirectory = join(temporary, 'extension-profile');
  const extensionOptions = {
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      '--ignore-certificate-errors',
    ],
    headless: true,
    ignoreHTTPSErrors: true,
    ...extensionBrowserLaunchOptions(),
  };
  extensionContext = await chromium.launchPersistentContext(
    userDataDirectory,
    extensionOptions,
  );
  let worker = await extensionWorker(extensionContext);
  const extensionUrl = new URL(worker.url());
  const extensionOrigin = `${extensionUrl.protocol}//${extensionUrl.host}`;
  allowedOrigins.add(extensionOrigin);
  const firstExtensionRun = await runExtension(worker, { apiBaseUrl });
  assert(
    firstExtensionRun.sessionOpened === true &&
      firstExtensionRun.signedRequestCompleted === true,
    `MV3 service-worker fixture did not complete the signed SDK flow: ${JSON.stringify({ result: firstExtensionRun, requests: observations.requests.slice(-4) })}`,
  );
  const challengeCountAfterExtensionOpen = observations.challenges;
  await extensionContext.close();
  extensionContext = undefined;

  extensionContext = await chromium.launchPersistentContext(
    userDataDirectory,
    extensionOptions,
  );
  worker = await extensionWorker(extensionContext);
  const restoredExtensionRun = await runExtension(worker, { apiBaseUrl });
  assert(
    restoredExtensionRun.sessionRestored === true,
    'MV3 worker restart did not restore its partitioned session.',
  );
  assert(
    observations.challenges === challengeCountAfterExtensionOpen,
    'MV3 worker restart opened a duplicate session.',
  );
  await worker.evaluate(() => chrome.storage.local.clear());
  const wrongExtensionOrigin =
    'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const extensionMismatch = await runExtension(worker, {
    apiBaseUrl,
    bindingOrigin: wrongExtensionOrigin,
  });
  assert(
    extensionMismatch.error?.name === 'EmberChallengeValidationError',
    'A mismatched extension challenge binding did not fail locally.',
  );

  assert(
    observations.preflights.some(
      (preflight) =>
        preflight.origin === approvedWebOrigin &&
        preflight.path === '/v1/wallet-sessions/challenges' &&
        preflight.headers.includes('content-type'),
    ),
    'The HTTPS challenge CORS preflight was not observed.',
  );
  assert(
    observations.preflights.some(
      (preflight) =>
        preflight.origin === approvedWebOrigin &&
        preflight.path === '/v1/wallet/offers' &&
        preflight.headers.includes('x-ember-wallet-signature'),
    ),
    'The HTTPS signed-header CORS preflight was not observed.',
  );

  console.log(
    `Origin-host conformance passed: packed SDK, HTTPS window, MV3 worker, ` +
      `${observations.challenges} sessions, ${observations.offers} signed reads, ` +
      `${observations.preflights.length} CORS preflights.`,
  );
} finally {
  if (extensionContext) await extensionContext.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (webServer) await close(webServer).catch(() => undefined);
  if (apiServer) await close(apiServer).catch(() => undefined);
  await rm(temporary, { force: true, recursive: true });
}
