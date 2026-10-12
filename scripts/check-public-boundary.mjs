import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const ignoredDirectories = new Set(['.git', 'artifacts', 'node_modules']);
const allowedTopLevel = new Set([
  '.github',
  '.gitignore',
  'CHANGELOG.md',
  'COMPATIBILITY.md',
  'CONFORMANCE.md',
  'LICENSE',
  'QA.md',
  'README.md',
  'RELEASE.md',
  'SECURITY.md',
  'SUPPORT.md',
  'contract',
  'conformance',
  'dist',
  'examples',
  'fixtures',
  'openapi-ts.config.mjs',
  'package-lock.json',
  'package.json',
  'project management',
  'release',
  'scripts',
  'src',
  'tsconfig.json',
  'tsup.config.ts',
]);
const scannedExtensions = new Set([
  '.cjs',
  '.cts',
  '.html',
  '.js',
  '.json',
  '.map',
  '.md',
  '.mjs',
  '.ts',
  '.yaml',
  '.yml',
]);
const forbiddenContent = [
  ['private monorepo URL', /github\.com\/onaboat\/ember(?:\.git)?(?:["/#]|$)/i],
  ['partner-generated contract', /partner-generated|openapi-ts\.partner/i],
  ['partner OpenAPI path', /docs\/openapi\/partner/i],
  ['private Rust source path', /crates\/ember-(?:api|core|engine)/i],
  ['financial operation code', /\bfinancial_[a-z0-9_]+\b/i],
  ['production control code', /\bproduction_control[a-z0-9_]*\b/i],
  ['payout operation code', /\bpayout_[a-z0-9_]+\b/i],
  ['internal exposure snapshot', /exposure(?:Policy|Snapshot|_policy|_snapshot)/],
  ['detailed engine reasons', /\b(?:reasonCodes|ReasonCode)\b/],
  [
    'known engine reason',
    /\b(?:simple_system_transfer|duplicate_writable_accounts)\b/i,
  ],
  ['internal classifier', /\b(?:ember_static_classifier|p08_litesvm)\b/i],
  ['provider agreement internals', /\bproviderAgreement\b/],
  [
    'claim valuation internals',
    /\b(?:valuationCandidates|ClaimValuationCandidate)\b/,
  ],
  ['claim review internals', /\b(?:reviewPhase|verificationState)\b/],
  ['decision confidence internals', /\bConfidence\b/],
];

async function discover(directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Public repository must not contain symlinks: ${relative(root, path)}`,
      );
    }
    if (stat.isDirectory()) files.push(...(await discover(path)));
    else if (stat.isFile()) files.push(path);
  }
  return files;
}

const files = await discover();
const violations = [];
for (const path of files) {
  const relativePath = relative(root, path);
  const topLevel = relativePath.split('/')[0];
  if (!allowedTopLevel.has(topLevel)) {
    violations.push(`${relativePath}: top-level path is not allowlisted`);
  }
  if (basename(path) === 'check-public-boundary.mjs') continue;
  if (!scannedExtensions.has(extname(path))) continue;
  const contents = await readFile(path, 'utf8');
  for (const [name, pattern] of forbiddenContent) {
    if (pattern.test(contents)) violations.push(`${relativePath}: ${name}`);
  }
}

const contract = JSON.parse(
  await readFile(join(root, 'contract/wallet-v1.json'), 'utf8'),
);
const schemas = contract.components?.schemas ?? {};
const allowedErrors = [
  'invalid_request',
  'session_invalid',
  'client_binding_mismatch',
  'permission_denied',
  'not_found',
  'conflict',
  'coverage_limit_reached',
  'rate_limited',
  'service_unavailable',
];
if (JSON.stringify(schemas.ApiErrorCode?.enum) !== JSON.stringify(allowedErrors)) {
  violations.push('contract/wallet-v1.json: public error enum differs from allowlist');
}

const decision = schemas.CoverageDecisionResponse?.properties ?? {};
for (const field of [
  'confidence',
  'reasonCodes',
  'exposureReservationMicros',
  'exposureSnapshot',
]) {
  if (field in decision) {
    violations.push(`contract/wallet-v1.json: private decision field ${field}`);
  }
}
const payment = schemas.PaymentResponse?.properties ?? {};
for (const field of ['outcomeCode', 'providerAgreement']) {
  if (field in payment) {
    violations.push(`contract/wallet-v1.json: private payment field ${field}`);
  }
}
for (const schema of [
  'Confidence',
  'ReasonCode',
  'ProviderAgreementResponse',
  'ClaimValuationCandidateResponse',
  'ProductionClaimResponse',
]) {
  if (schema in schemas) {
    violations.push(`contract/wallet-v1.json: private schema ${schema}`);
  }
}

if (violations.length > 0) {
  throw new Error(`Public boundary check failed:\n${violations.join('\n')}`);
}

console.log(`Public boundary check passed for ${files.length} repository files.`);
