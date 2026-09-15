import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertReleaseEvidence,
  assertReleasePolicy,
  assertSelectedChannel,
  assertSignedTagCheckout,
  readJson,
} from './release-policy.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const [packageJson, policy, provenance] = await Promise.all([
  readJson(resolve(root, 'package.json')),
  readJson(resolve(root, 'release', 'policy.json')),
  readJson(resolve(root, 'contract', 'provenance.json')),
]);
assertReleasePolicy(policy);
const selectedChannel = process.env.EMBER_RELEASE_CHANNEL?.trim();
if (!selectedChannel) throw new Error('EMBER_RELEASE_CHANNEL is required.');
const channel = assertSelectedChannel({
  policy,
  selectedChannel,
  version: packageJson.version,
});
const expectedTag = `v${packageJson.version}`;

if (
  process.env.GITHUB_REF_TYPE !== 'tag' ||
  process.env.GITHUB_REF_NAME !== expectedTag
) {
  throw new Error(
    `Run this workflow from exact tag ${expectedTag}; received ${process.env.GITHUB_REF_TYPE ?? 'unknown'} ${process.env.GITHUB_REF_NAME ?? 'unknown'}.`,
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${args.join(' ')} failed.`);
  }
  return result.stdout;
}

const tagRef = `refs/tags/${expectedTag}`;
assertSignedTagCheckout({
  expectedTag,
  headRevision: run('git', ['rev-parse', 'HEAD']).trim(),
  tagContents: run('git', ['cat-file', '-p', tagRef]),
  tagObjectType: run('git', ['cat-file', '-t', tagRef]).trim(),
  tagRevision: run('git', ['rev-list', '-n', '1', tagRef]).trim(),
});

const configuredTarball = process.env.EMBER_RELEASE_TARBALL?.trim();
if (!configuredTarball) throw new Error('EMBER_RELEASE_TARBALL is required.');
const tarball = await realpath(configuredTarball);
const releaseDirectory = await realpath(join(root, 'artifacts', 'release'));
if (dirname(tarball) !== releaseDirectory || !basename(tarball).endsWith('.tgz')) {
  throw new Error('Release tarball must be an npm archive under artifacts/release.');
}
const tarballSha256 = createHash('sha256')
  .update(await readFile(tarball))
  .digest('hex');
const evidencePath = resolve(
  root,
  'release',
  'evidence',
  `${expectedTag}.json`,
);
let evidence;
try {
  evidence = await readJson(evidencePath);
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error(
      `Reviewed release evidence is missing: release/evidence/${expectedTag}.json.`,
    );
  }
  throw error;
}
assertReleaseEvidence({
  evidence,
  packageJson,
  policy,
  provenance,
  tarballSha256,
});

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `dist_tag=${channel.npmDistTag}\nevidence=${evidencePath}\n`,
  );
}
console.log(
  `Release candidate passed: ${expectedTag}, npm tag ${channel.npmDistTag}, ` +
    `tarball ${tarballSha256}.`,
);
