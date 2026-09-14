import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readConformanceConfig } from './config.mjs';
import { safeConformanceError } from './report.mjs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Signer key must be bytes.');
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }
  const digits = [];
  for (const byte of bytes.subarray(leadingZeroes)) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] * 256;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let output = '1'.repeat(leadingZeroes);
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    output += ALPHABET[digits[index]];
  }
  return output;
}

function createSessionSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicBytes = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);
  return {
    publicKey: base58Encode(publicBytes),
    async signMessage(message) {
      return new Uint8Array(sign(null, message, privateKey));
    },
  };
}

class FileSessionStore {
  constructor(path) {
    this.path = path;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(session) {
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async clear() {
    await rm(this.path, { force: true });
  }
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new Error(`Conformance fixture must provide ${name}().`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Conformance fixture returned an invalid ${name}.`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll(config, label, read, classify) {
  const deadline = Date.now() + config.stateTimeoutMs;
  let lastState = 'unknown';
  while (Date.now() < deadline) {
    const value = await read();
    const result = classify(value);
    lastState = result.state;
    if (result.status === 'complete') return value;
    if (result.status === 'failed') {
      throw new Error(`${label} entered terminal state ${lastState}.`);
    }
    await delay(config.pollIntervalMs);
  }
  throw new Error(`${label} did not complete before timeout (last state ${lastState}).`);
}

const config = readConformanceConfig();
const sdk = await import(pathToFileURL(process.env.EMBER_CONFORMANCE_SDK_ENTRY).href);
const fixtureModule = await import(pathToFileURL(config.fixtureModule).href);
const createFixture = requireFunction(
  fixtureModule.createConformanceWalletFixture,
  'createConformanceWalletFixture',
);
const fixture = await createFixture({
  baseUrl: config.baseUrl,
  environment: config.environment,
});
if (!fixture?.walletSigner || typeof fixture.walletSigner.signMessage !== 'function') {
  throw new Error('Conformance fixture must provide a real walletSigner.');
}
requireString(fixture.walletSigner.publicKey, 'walletSigner.publicKey');
const submitQuotedPayment = requireFunction(
  fixture.submitQuotedPayment,
  'submitQuotedPayment',
);
const prepareCoveredTransaction = requireFunction(
  fixture.prepareCoveredTransaction,
  'prepareCoveredTransaction',
);
const signAndBroadcast = requireFunction(
  fixture.signAndBroadcast,
  'signAndBroadcast',
);
const evidenceForRequest = requireFunction(
  fixture.evidenceForRequest,
  'evidenceForRequest',
);

const reportPath = process.env.EMBER_CONFORMANCE_REPORT_PATH;
const sessionPath = process.env.EMBER_CONFORMANCE_SESSION_PATH;
if (!reportPath || !sessionPath) throw new Error('Conformance harness paths are missing.');
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  outcome: 'running',
  package: {
    name: '@embercover/wallet-sdk',
    version: process.env.EMBER_CONFORMANCE_PACKAGE_VERSION,
    tarballSha256: process.env.EMBER_CONFORMANCE_TARBALL_SHA256,
  },
  contract: {
    version: process.env.EMBER_CONFORMANCE_CONTRACT_VERSION,
    sha256: process.env.EMBER_CONFORMANCE_CONTRACT_SHA256,
    upstreamRevision: process.env.EMBER_CONFORMANCE_UPSTREAM_REVISION,
  },
  authority: {
    apiOrigin: config.baseUrl,
    environment: config.environment,
    hostKind: config.hostBinding.kind,
    integrationId: config.integrationId,
    integrationVersion: config.integrationVersion,
    walletAddress: fixture.walletSigner.publicKey,
  },
  steps: [],
};

async function persistReport() {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function record(name, evidence = {}) {
  report.steps.push({ name, passedAt: new Date().toISOString(), ...evidence });
}

const store = new FileSessionStore(sessionPath);
let activeSigner = createSessionSigner();
const apiFetch = (input, init = {}) => {
  if (config.hostBinding.kind === 'native') return fetch(input, init);
  const headers = new Headers(init.headers);
  headers.set('origin', config.hostBinding.origin);
  return fetch(input, { ...init, headers });
};
const newClient = () =>
  new sdk.EmberWalletClient({
    baseUrl: config.baseUrl,
    environment: config.environment,
    fetch: apiFetch,
    hostBinding: config.hostBinding,
    integrationId: config.integrationId,
    integrationVersion: config.integrationVersion,
    sessionSigner: activeSigner,
    sessionStore: store,
  });
let client = newClient();

try {
  const opened = await client.openSession({
    requestedScopes: [...sdk.P11_WALLET_SCOPES],
    walletSigner: fixture.walletSigner,
  });
  record('session.open', { sessionId: opened.sessionId });

  const nextSigner = createSessionSigner();
  const rotated = await client.rotateSession(nextSigner);
  activeSigner = nextSigner;
  client = newClient();
  if ((await client.currentSession())?.sessionId !== rotated.sessionId) {
    throw new Error('Rotated session did not survive client reconstruction.');
  }
  record('session.rotate_restore', { sessionId: rotated.sessionId });

  const offers = await client.listOffers();
  if (!offers.offers.some((candidate) => candidate.offerId === config.offerId)) {
    throw new Error('Configured conformance offer is not available to this wallet.');
  }
  const offer = await client.getOffer(config.offerId);
  record('offer.read', { offerId: offer.offerId, offerVersion: offer.offerVersion });

  const terms = await client.acceptTerms({
    documentSha256: offer.termsSha256,
    offerId: offer.offerId,
    offerVersion: offer.offerVersion,
    termsVersion: offer.termsVersion,
  });
  client = newClient();
  record('terms.accept', { acceptanceId: terms.acceptanceId });

  const quote = await client.createQuote({ offerId: offer.offerId });
  client = newClient();
  record('quote.create_verify', { quoteId: quote.payload.quoteId });

  const submittedPayment = await submitQuotedPayment({ quote });
  if (submittedPayment?.simulationPassed !== true) {
    throw new Error('Payment fixture did not attest a successful simulation.');
  }
  const paymentSignature = requireString(
    submittedPayment.paymentSignature,
    'paymentSignature',
  );
  const createdPayment = await client.createPayment({
    paymentSignature,
    quoteId: quote.payload.quoteId,
  });
  client = newClient();
  const payment = await poll(
    config,
    'payment',
    () => client.getPayment(createdPayment.paymentId),
    (value) =>
      value.status === 'activated'
        ? { status: 'complete', state: value.status }
        : value.status === 'rejected' || value.status === 'inconsistent'
          ? { status: 'failed', state: value.status }
          : { status: 'pending', state: value.status },
  );
  record('payment.activate', {
    coverageInstanceId: payment.coverageInstanceId,
    paymentId: payment.paymentId,
  });

  const coverageInstanceId = requireString(
    payment.coverageInstanceId,
    'coverageInstanceId',
  );
  const coverage = await client.getCoverageInstance(coverageInstanceId);
  const prepared = await prepareCoveredTransaction({ coverage, quote });
  if (
    prepared?.simulationPassed !== true ||
    prepared?.request?.kind !== 'transaction' ||
    prepared.request.coverageInstanceId !== coverage.coverageInstanceId ||
    typeof prepared.request.transactionBytes !== 'string' ||
    prepared.request.transactionBytes.length === 0
  ) {
    throw new Error('Transaction fixture returned an unsafe decision request.');
  }
  const decision = await client.createDecision(prepared.request);
  if (decision.coverStatus !== 'covered') {
    throw new Error(`Conformance transaction was not covered (${decision.coverStatus}).`);
  }
  record('decision.create', { decisionId: decision.decisionId });

  const signed = await signAndBroadcast({ decision, prepared });
  if (
    signed?.simulationPassed !== true ||
    signed?.evidence?.kind !== 'transaction' ||
    typeof signed.evidence.signedBytes !== 'string' ||
    signed.evidence.signedBytes.length === 0
  ) {
    throw new Error('Transaction fixture did not attest simulation and broadcast evidence.');
  }
  requireString(signed.broadcastSignature, 'broadcastSignature');
  const accepted = await client.submitDecisionEvidence(
    decision.decisionId,
    signed.evidence,
  );
  client = newClient();
  if (!accepted.accepted) throw new Error('Post-sign evidence was not accepted.');
  const lineage = await poll(
    config,
    'decision evidence',
    () => client.getDecisionLineage(decision.decisionId),
    (value) =>
      value.evidenceState === 'sealed'
        ? { status: 'complete', state: value.evidenceState }
        : ['conflict', 'dropped'].includes(value.evidenceState)
          ? { status: 'failed', state: value.evidenceState }
          : { status: 'pending', state: value.evidenceState },
  );
  record('decision.evidence_lineage', {
    decisionId: lineage.decisionId,
    evidenceState: lineage.evidenceState,
  });

  const eligibility = await client.claimEligibility(decision.decisionId);
  if (!eligibility.eligible) throw new Error('Sealed decision is not claim eligible.');
  const createdClaim = await client.createClaim(
    {
      claimedAmountMicros: '1',
      decisionId: decision.decisionId,
      lossEvent: 'direct_malicious_signing_loss',
      statement: 'SDK real-API conformance claim; no production cover.',
    },
    { idempotencyKey: `conformance-claim-${crypto.randomUUID()}` },
  );
  client = newClient();
  const claims = await client.listClaims();
  if (!claims.claims.some((candidate) => candidate.claimId === createdClaim.claimId)) {
    throw new Error('Created claim is absent from the wallet claim list.');
  }
  record('claim.create_read', { claimId: createdClaim.claimId });

  const claimWithRequest = await poll(
    config,
    'claim evidence request',
    () => client.getClaim(createdClaim.claimId),
    (value) => {
      const open = value.evidenceRequests.find(
        (request) => request.status === 'open' && request.evidenceCodes.length > 0,
      );
      if (open) return { status: 'complete', state: value.state };
      if (['approved', 'partially_approved', 'rejected'].includes(value.state)) {
        return { status: 'failed', state: value.state };
      }
      return { status: 'pending', state: value.state };
    },
  );
  const evidenceRequest = claimWithRequest.evidenceRequests.find(
    (request) => request.status === 'open' && request.evidenceCodes.length > 0,
  );
  if (!evidenceRequest) throw new Error('Claim has no open evidence request.');
  const evidence = await evidenceForRequest({
    claim: claimWithRequest,
    evidenceRequest,
  });
  if (!(evidence?.bytes instanceof Uint8Array) || evidence.bytes.length === 0) {
    throw new Error('Evidence fixture must return non-empty Uint8Array bytes.');
  }
  const contentType = requireString(evidence.contentType, 'evidence.contentType');
  const sha256 = createHash('sha256').update(evidence.bytes).digest('hex');
  const upload = await client.beginClaimEvidenceUpload(createdClaim.claimId, {
    contentLength: String(evidence.bytes.length),
    contentType,
    evidenceCode: evidenceRequest.evidenceCodes[0],
    requestId: evidenceRequest.requestId,
    sha256,
  });
  const uploadResponse = await fetch(upload.upload.url, {
    method: upload.upload.method,
    headers: upload.upload.headers,
    body: evidence.bytes,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Evidence object upload returned HTTP ${uploadResponse.status}.`);
  }
  await client.completeClaimEvidenceUpload(createdClaim.claimId, upload.evidenceId);
  client = newClient();
  record('claim.evidence_upload', { evidenceId: upload.evidenceId });

  const rejectedClaim = await poll(
    config,
    'claim rejection for appeal',
    () => client.getClaim(createdClaim.claimId),
    (value) =>
      value.state === 'rejected'
        ? { status: 'complete', state: value.state }
        : ['approved', 'partially_approved'].includes(value.state)
          ? { status: 'failed', state: value.state }
          : { status: 'pending', state: value.state },
  );
  const appealed = await client.appealClaim(rejectedClaim.claimId, {
    reason: 'SDK real-API conformance appeal.',
  });
  client = newClient();
  if (appealed.state !== 'appealed') {
    throw new Error(`Claim appeal returned unexpected state ${appealed.state}.`);
  }
  record('claim.appeal', { claimId: appealed.claimId, state: appealed.state });

  const revoked = await client.revokeSession({ reason: 'conformance_complete' });
  if (revoked.revokedSessions < 1) {
    throw new Error('Session revocation did not revoke the active session.');
  }
  if ((await client.currentSession()) !== null) {
    throw new Error('Revoked conformance session remains locally available.');
  }
  record('session.revoke', { revokedSessions: revoked.revokedSessions });
  report.outcome = 'passed';
} catch (error) {
  report.outcome = 'failed';
  report.error = safeConformanceError(error);
  throw error;
} finally {
  if (report.outcome === 'failed') {
    try {
      if ((await client.currentSession()) !== null) {
        await client.revokeSession({ reason: 'conformance_failed' });
        report.cleanup = { sessionRevoked: true };
      }
    } catch (cleanupError) {
      report.cleanup = {
        sessionRevoked: false,
        error: safeConformanceError(cleanupError),
      };
    }
  }
  report.completedAt = new Date().toISOString();
  await persistReport();
}

console.log(`Real API conformance passed. Evidence: ${reportPath}`);
