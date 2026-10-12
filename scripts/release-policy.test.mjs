import { describe, expect, it } from 'vitest';
import {
  assertReleaseEvidence,
  assertReleasePolicy,
  assertSelectedChannel,
  assertSignedTagCheckout,
  releaseChannelForVersion,
} from './release-policy.mjs';

const policy = {
  schemaVersion: 2,
  packageName: '@embercover/wallet-sdk',
  channels: [
    {
      id: 'beta',
      npmDistTag: 'beta',
      prereleaseIdentifier: 'beta',
      purpose: 'integration_testing',
      requiredEvidence: [
        'apiConformance',
        'chromeExtensionCors',
        'manualProductQa',
      ],
    },
    {
      id: 'release-candidate',
      npmDistTag: 'release-candidate',
      prereleaseIdentifier: 'rc',
      purpose: 'final_qualification',
      requiredEvidence: [
        'apiConformance',
        'httpsWebCors',
        'chromeExtensionCors',
        'manualProductQa',
      ],
    },
    {
      id: 'latest',
      npmDistTag: 'latest',
      prereleaseIdentifier: null,
      purpose: 'production',
      requiredEvidence: [
        'apiConformance',
        'httpsWebCors',
        'chromeExtensionCors',
        'manualProductQa',
      ],
    },
  ],
  hosts: [
    {
      id: 'https-web-wallet',
      releaseStatus: 'qualification_required',
      automatedGate: 'conformance:origins',
      requiredEvidence: [
        'apiConformance',
        'httpsWebCors',
        'manualProductQa',
      ],
    },
    {
      id: 'chrome-extension',
      releaseStatus: 'qualification_required',
      automatedGate: 'conformance:origins',
      requiredEvidence: [
        'apiConformance',
        'chromeExtensionCors',
        'manualProductQa',
      ],
    },
    {
      id: 'android-native-wallet',
      releaseStatus: 'unsupported',
      automatedGate: null,
      requiredEvidence: [],
    },
    {
      id: 'ios-native-wallet',
      releaseStatus: 'unsupported',
      automatedGate: null,
      requiredEvidence: [],
    },
  ],
};

const qualifiedGateNames = [
  'apiConformance',
  'httpsWebCors',
  'chromeExtensionCors',
  'manualProductQa',
];

function evidence({ gateNames = qualifiedGateNames, version = '1.4.0-rc.0' } = {}) {
  const gate = {
    status: 'passed',
    recordedAt: '2026-09-15T00:00:00.000Z',
    evidenceSha256: 'b'.repeat(64),
  };
  return {
    schemaVersion: 1,
    package: {
      name: '@embercover/wallet-sdk',
      version,
      tarballSha256: 'a'.repeat(64),
      contractVersion: '1.0.0',
      contractSha256: 'c'.repeat(64),
      upstreamRevision: 'd'.repeat(40),
    },
    gates: Object.fromEntries(gateNames.map((gateName) => [gateName, { ...gate }])),
  };
}

describe('release policy', () => {
  it.each([
    ['1.4.0-beta.2', 'beta'],
    ['1.4.0-rc.0', 'release-candidate'],
    ['1.4.0', 'latest'],
  ])('maps %s only to %s', (version, expected) => {
    assertReleasePolicy(policy);
    expect(releaseChannelForVersion(version, policy).id).toBe(expected);
  });

  it.each(['android-native-wallet', 'ios-native-wallet'])(
    'rejects a release policy that claims support for deferred host %s', (id) => {
      const overclaimed = structuredClone(policy);
      const host = overclaimed.hosts.find((candidate) => candidate.id === id);
      host.releaseStatus = 'qualification_required';
      host.automatedGate = 'conformance:origins';
      host.requiredEvidence = ['apiConformance', 'manualProductQa'];
      expect(() => assertReleasePolicy(overclaimed)).toThrow(/differs from the supported policy/);
    },
  );

  it('rejects the earlier policy schema without channel evidence requirements', () => {
    expect(() => assertReleasePolicy({ ...policy, schemaVersion: 1 })).toThrow(
      /schemaVersion must be 2/,
    );
  });

  it('prevents a prerelease from using latest', () => {
    expect(() =>
      assertSelectedChannel({
        policy,
        selectedChannel: 'latest',
        version: '1.4.0-rc.0',
      }),
    ).toThrow(/requires release channel release-candidate/);
  });

  it('rejects unrecognized prerelease identifiers', () => {
    expect(() => releaseChannelForVersion('1.4.0-next.0', policy)).toThrow(
      /No release channel accepts/,
    );
  });

  it('accepts a signed annotated tag for the checked-out revision', () => {
    expect(() =>
      assertSignedTagCheckout({
        expectedTag: 'v1.4.0-rc.0',
        headRevision: 'a'.repeat(40),
        tagContents: 'tag message\n-----BEGIN SSH SIGNATURE-----\nfixture',
        tagObjectType: 'tag',
        tagRevision: 'a'.repeat(40),
      }),
    ).not.toThrow();
  });

  it.each([
    ['commit', 'tag message\n-----BEGIN PGP SIGNATURE-----', 'a', /annotated tag/],
    ['tag', 'unsigned tag message', 'a', /must contain a Git signature/],
    [
      'tag',
      'tag message\n-----BEGIN PGP SIGNATURE-----',
      'b',
      /does not match/,
    ],
  ])('rejects an invalid tag checkout', (type, contents, revision, message) => {
    expect(() =>
      assertSignedTagCheckout({
        expectedTag: 'v1.4.0-rc.0',
        headRevision: 'a'.repeat(40),
        tagContents: contents,
        tagObjectType: type,
        tagRevision: revision.repeat(40),
      }),
    ).toThrow(message);
  });

  it('accepts complete evidence bound to the exact package and contract', () => {
    expect(
      assertReleaseEvidence({
        evidence: evidence(),
        packageJson: { name: '@embercover/wallet-sdk', version: '1.4.0-rc.0' },
        policy,
        provenance: {
          contract: { version: '1.0.0', sha256: 'c'.repeat(64) },
          upstream: { revision: 'd'.repeat(40) },
        },
        tarballSha256: 'a'.repeat(64),
      }),
    ).toBeTruthy();
  });

  it('accepts beta integration evidence without unqualified host claims', () => {
    const betaEvidence = evidence({
      gateNames: ['apiConformance', 'chromeExtensionCors', 'manualProductQa'],
      version: '1.4.0-beta.2',
    });
    expect(
      assertReleaseEvidence({
        evidence: betaEvidence,
        packageJson: { name: '@embercover/wallet-sdk', version: '1.4.0-beta.2' },
        policy,
        provenance: {
          contract: { version: '1.0.0', sha256: 'c'.repeat(64) },
          upstream: { revision: 'd'.repeat(40) },
        },
        tarballSha256: 'a'.repeat(64),
      }),
    ).toBeTruthy();
  });

  it('rejects beta evidence that omits a beta integration gate', () => {
    const incomplete = evidence({
      gateNames: ['apiConformance', 'manualProductQa'],
      version: '1.4.0-beta.2',
    });
    expect(() =>
      assertReleaseEvidence({
        evidence: incomplete,
        packageJson: { name: '@embercover/wallet-sdk', version: '1.4.0-beta.2' },
        policy,
        provenance: {
          contract: { version: '1.0.0', sha256: 'c'.repeat(64) },
          upstream: { revision: 'd'.repeat(40) },
        },
        tarballSha256: 'a'.repeat(64),
      }),
    ).toThrow(/channel beta must contain exactly its required gates/);
  });

  it('rejects beta evidence that claims qualified-only host gates', () => {
    const overclaimed = evidence({ version: '1.4.0-beta.2' });
    expect(() =>
      assertReleaseEvidence({
        evidence: overclaimed,
        packageJson: { name: '@embercover/wallet-sdk', version: '1.4.0-beta.2' },
        policy,
        provenance: {
          contract: { version: '1.0.0', sha256: 'c'.repeat(64) },
          upstream: { revision: 'd'.repeat(40) },
        },
        tarballSha256: 'a'.repeat(64),
      }),
    ).toThrow(/channel beta must contain exactly its required gates/);
  });

  it('rejects a failed or missing release gate', () => {
    const failed = evidence();
    failed.gates.httpsWebCors.status = 'failed';
    expect(() =>
      assertReleaseEvidence({
        evidence: failed,
        packageJson: { name: '@embercover/wallet-sdk', version: '1.4.0-rc.0' },
        policy,
        provenance: {
          contract: { version: '1.0.0', sha256: 'c'.repeat(64) },
          upstream: { revision: 'd'.repeat(40) },
        },
        tarballSha256: 'a'.repeat(64),
      }),
    ).toThrow(/httpsWebCors did not pass/);
  });

  it('rejects evidence for a different tarball', () => {
    expect(() =>
      assertReleaseEvidence({
        evidence: evidence(),
        packageJson: { name: '@embercover/wallet-sdk', version: '1.4.0-rc.0' },
        policy,
        provenance: {
          contract: { version: '1.0.0', sha256: 'c'.repeat(64) },
          upstream: { revision: 'd'.repeat(40) },
        },
        tarballSha256: 'e'.repeat(64),
      }),
    ).toThrow(/tarball SHA-256 does not match/);
  });
});
