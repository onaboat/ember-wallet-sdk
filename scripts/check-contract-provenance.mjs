import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXPECTED_CONTRACT_PATH = 'contract/wallet-v1.json';
const EXPECTED_UPSTREAM_AUTHORITY = 'Ember wallet API OpenAPI';
const EXPECTED_UPSTREAM_ARTIFACT_PATH = 'docs/openapi/wallet-v1.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join('\n') === [...expected].sort().join('\n')
  );
}

export function assertContractProvenance({ contractBytes, packageName, provenance }) {
  if (!hasExactKeys(provenance, ['schemaVersion', 'packageName', 'contract', 'upstream'])) {
    throw new Error('Contract provenance must contain only the documented top-level fields.');
  }
  if (provenance.schemaVersion !== 1) {
    throw new Error('Contract provenance schemaVersion must be exactly 1.');
  }
  if (provenance.packageName !== packageName) {
    throw new Error(
      `Contract provenance packageName must match ${packageName}.`,
    );
  }
  if (!hasExactKeys(provenance.contract, ['path', 'version', 'sha256'])) {
    throw new Error('Contract provenance contract metadata is malformed.');
  }
  if (provenance.contract.path !== EXPECTED_CONTRACT_PATH) {
    throw new Error(`Contract provenance path must be ${EXPECTED_CONTRACT_PATH}.`);
  }
  if (
    typeof provenance.contract.version !== 'string' ||
    provenance.contract.version.trim().length === 0
  ) {
    throw new Error('Contract provenance version must be a non-empty string.');
  }
  if (!SHA256_PATTERN.test(provenance.contract.sha256)) {
    throw new Error('Contract provenance sha256 must be 64 lowercase hexadecimal characters.');
  }
  if (!hasExactKeys(provenance.upstream, ['authority', 'artifactPath', 'revision'])) {
    throw new Error('Contract provenance upstream metadata is malformed.');
  }
  if (provenance.upstream.authority !== EXPECTED_UPSTREAM_AUTHORITY) {
    throw new Error(`Contract provenance authority must be ${EXPECTED_UPSTREAM_AUTHORITY}.`);
  }
  if (provenance.upstream.artifactPath !== EXPECTED_UPSTREAM_ARTIFACT_PATH) {
    throw new Error(
      `Contract provenance artifactPath must be ${EXPECTED_UPSTREAM_ARTIFACT_PATH}.`,
    );
  }
  if (!REVISION_PATTERN.test(provenance.upstream.revision)) {
    throw new Error('Contract provenance revision must be a full lowercase Git commit hash.');
  }

  let contract;
  try {
    contract = JSON.parse(contractBytes.toString('utf8'));
  } catch (cause) {
    throw new Error('Wallet contract is not valid JSON.', { cause });
  }
  if (!isRecord(contract.info) || contract.info.version !== provenance.contract.version) {
    throw new Error('Contract provenance version does not match wallet-v1.json info.version.');
  }
  const actualSha256 = createHash('sha256').update(contractBytes).digest('hex');
  if (actualSha256 !== provenance.contract.sha256) {
    throw new Error(
      `Contract provenance digest mismatch: expected ${provenance.contract.sha256}, received ${actualSha256}.`,
    );
  }
}

export async function checkContractProvenance(root) {
  const [packageBytes, provenanceBytes, contractBytes] = await Promise.all([
    readFile(resolve(root, 'package.json')),
    readFile(resolve(root, 'contract/provenance.json')),
    readFile(resolve(root, EXPECTED_CONTRACT_PATH)),
  ]);
  const packageJson = JSON.parse(packageBytes.toString('utf8'));
  const provenance = JSON.parse(provenanceBytes.toString('utf8'));
  assertContractProvenance({
    contractBytes,
    packageName: packageJson.name,
    provenance,
  });
  return provenance;
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (scriptPath === import.meta.url) {
  const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const provenance = await checkContractProvenance(sdkRoot);
  console.log(
    `Wallet contract provenance passed (${provenance.contract.version}, ${provenance.contract.sha256}, upstream ${provenance.upstream.revision}).`,
  );
}
