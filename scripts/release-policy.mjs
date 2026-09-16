import { readFile } from 'node:fs/promises';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-z][a-z0-9-]*)\.(0|[1-9]\d*))?$/;
const EVIDENCE_GATES = [
  'apiConformance',
  'httpsWebCors',
  'chromeExtensionCors',
  'androidEmulator',
  'solanaPhone',
  'manualProductQa',
];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function parseReleaseVersion(version) {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(
      `Release version must be stable x.y.z or prerelease x.y.z-beta.N/x.y.z-rc.N; received ${version}.`,
    );
  }
  return {
    prereleaseIdentifier: match[4] ?? null,
    version,
  };
}

export function assertReleasePolicy(policy) {
  assert(
    hasExactKeys(policy, ['schemaVersion', 'packageName', 'channels', 'hosts']),
    'Release policy has unexpected top-level fields.',
  );
  assert(policy.schemaVersion === 2, 'Release policy schemaVersion must be 2.');
  assert(
    policy.packageName === '@embercover/wallet-sdk',
    'Release policy packageName is invalid.',
  );

  const expectedChannels = [
    [
      'beta',
      'beta',
      'beta',
      'integration_testing',
      ['apiConformance', 'chromeExtensionCors', 'manualProductQa'],
    ],
    [
      'release-candidate',
      'release-candidate',
      'rc',
      'final_qualification',
      EVIDENCE_GATES,
    ],
    ['latest', 'latest', null, 'production', EVIDENCE_GATES],
  ];
  assert(
    Array.isArray(policy.channels) &&
      policy.channels.length === expectedChannels.length,
    'Release policy must define exactly three channels.',
  );
  expectedChannels.forEach(
    ([id, npmDistTag, prereleaseIdentifier, purpose, requiredEvidence], index) => {
      const channel = policy.channels[index];
      assert(
        hasExactKeys(channel, [
          'id',
          'npmDistTag',
          'prereleaseIdentifier',
          'purpose',
          'requiredEvidence',
        ]),
        `Release channel ${id} is malformed.`,
      );
      assert(
        channel.id === id &&
          channel.npmDistTag === npmDistTag &&
          channel.prereleaseIdentifier === prereleaseIdentifier &&
          channel.purpose === purpose &&
          JSON.stringify(channel.requiredEvidence) ===
            JSON.stringify(requiredEvidence),
        `Release channel ${id} differs from the supported policy.`,
      );
    },
  );

  const expectedHosts = [
    [
      'https-web-wallet',
      'qualification_required',
      'conformance:origins',
      ['apiConformance', 'httpsWebCors', 'manualProductQa'],
    ],
    [
      'chrome-extension',
      'qualification_required',
      'conformance:origins',
      ['apiConformance', 'chromeExtensionCors', 'manualProductQa'],
    ],
    [
      'android-native-wallet',
      'qualification_required',
      'conformance:native',
      [
        'apiConformance',
        'androidEmulator',
        'solanaPhone',
        'manualProductQa',
      ],
    ],
    ['ios-native-wallet', 'unsupported', null, []],
  ];
  assert(
    Array.isArray(policy.hosts) && policy.hosts.length === expectedHosts.length,
    'Release policy must define exactly four host declarations.',
  );
  expectedHosts.forEach(
    ([id, releaseStatus, automatedGate, requiredEvidence], index) => {
      const host = policy.hosts[index];
      assert(
        hasExactKeys(host, [
          'id',
          'releaseStatus',
          'automatedGate',
          'requiredEvidence',
        ]),
        `Release host ${id} is malformed.`,
      );
      assert(
        host.id === id &&
          host.releaseStatus === releaseStatus &&
          host.automatedGate === automatedGate,
        `Release host ${id} differs from the supported policy.`,
      );
      assert(
        Array.isArray(host.requiredEvidence) &&
          JSON.stringify(host.requiredEvidence) ===
            JSON.stringify(requiredEvidence),
        `Release host ${id} has an incorrect evidence policy.`,
      );
      if (releaseStatus === 'unsupported') {
        assert(
          host.requiredEvidence.length === 0,
          `Unsupported host ${id} must not imply release evidence.`,
        );
      } else {
        assert(
          host.requiredEvidence.length > 0,
          `Candidate host ${id} must require release evidence.`,
        );
      }
    },
  );
  const policyGates = new Set(
    policy.hosts.flatMap((host) => host.requiredEvidence),
  );
  assert(
    policyGates.size === EVIDENCE_GATES.length &&
      EVIDENCE_GATES.every((gate) => policyGates.has(gate)),
    'Release host declarations do not cover every required evidence gate.',
  );
  return policy;
}

export function releaseChannelForVersion(version, policy) {
  const parsed = parseReleaseVersion(version);
  const channel = policy.channels.find(
    (candidate) =>
      candidate.prereleaseIdentifier === parsed.prereleaseIdentifier,
  );
  if (!channel) {
    throw new Error(`No release channel accepts package version ${version}.`);
  }
  return channel;
}

export function assertSelectedChannel({ policy, selectedChannel, version }) {
  const channel = releaseChannelForVersion(version, policy);
  if (selectedChannel !== channel.id) {
    throw new Error(
      `Package version ${version} requires release channel ${channel.id}; received ${selectedChannel}.`,
    );
  }
  return channel;
}

export function assertSignedTagCheckout({
  expectedTag,
  headRevision,
  tagContents,
  tagObjectType,
  tagRevision,
}) {
  if (tagObjectType !== 'tag') {
    throw new Error(
      `Release ref ${expectedTag} must be an annotated tag, not a lightweight tag.`,
    );
  }
  if (!/-----BEGIN (?:PGP|SSH) SIGNATURE-----/.test(tagContents)) {
    throw new Error(`Release tag ${expectedTag} must contain a Git signature.`);
  }
  if (headRevision !== tagRevision) {
    throw new Error(
      `Checked-out revision ${headRevision} does not match ${expectedTag} at ${tagRevision}.`,
    );
  }
}

export function assertReleaseEvidence({
  evidence,
  packageJson,
  policy,
  provenance,
  tarballSha256,
}) {
  const channel = releaseChannelForVersion(packageJson.version, policy);
  const requiredGates = channel.requiredEvidence;
  assert(
    hasExactKeys(evidence, ['schemaVersion', 'package', 'gates']),
    'Release evidence has unexpected top-level fields.',
  );
  assert(evidence.schemaVersion === 1, 'Release evidence schemaVersion must be 1.');
  assert(
    hasExactKeys(evidence.package, [
      'name',
      'version',
      'tarballSha256',
      'contractVersion',
      'contractSha256',
      'upstreamRevision',
    ]),
    'Release evidence package metadata is malformed.',
  );
  assert(
    evidence.package.name === policy.packageName &&
      evidence.package.name === packageJson.name,
    'Release evidence package name does not match.',
  );
  assert(
    evidence.package.version === packageJson.version,
    'Release evidence package version does not match.',
  );
  assert(
    SHA256_PATTERN.test(tarballSha256) &&
      evidence.package.tarballSha256 === tarballSha256,
    'Release evidence tarball SHA-256 does not match the packed artifact.',
  );
  assert(
    evidence.package.contractVersion === provenance.contract.version &&
      evidence.package.contractSha256 === provenance.contract.sha256 &&
      evidence.package.upstreamRevision === provenance.upstream.revision,
    'Release evidence contract provenance does not match.',
  );
  assert(
    SHA256_PATTERN.test(evidence.package.contractSha256) &&
      REVISION_PATTERN.test(evidence.package.upstreamRevision),
    'Release evidence provenance digests are malformed.',
  );
  assert(
    hasExactKeys(evidence.gates, requiredGates),
    `Release evidence for channel ${channel.id} must contain exactly its required gates.`,
  );
  for (const gateName of requiredGates) {
    const gate = evidence.gates[gateName];
    assert(
      hasExactKeys(gate, ['status', 'recordedAt', 'evidenceSha256']),
      `Release evidence gate ${gateName} is malformed.`,
    );
    assert(gate.status === 'passed', `Release evidence gate ${gateName} did not pass.`);
    const recordedAt =
      typeof gate.recordedAt === 'string' ? new Date(gate.recordedAt) : null;
    assert(
      recordedAt !== null &&
        Number.isFinite(recordedAt.getTime()) &&
        recordedAt.toISOString() === gate.recordedAt,
      `Release evidence gate ${gateName} has an invalid UTC timestamp.`,
    );
    assert(
      SHA256_PATTERN.test(gate.evidenceSha256),
      `Release evidence gate ${gateName} has an invalid SHA-256.`,
    );
  }
  return evidence;
}

export const releaseEvidenceGateNames = Object.freeze([...EVIDENCE_GATES]);
