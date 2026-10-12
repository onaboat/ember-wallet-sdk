import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertReleasePolicy,
  readJson,
  releaseChannelForVersion,
} from './release-policy.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const [packageJson, policy] = await Promise.all([
  readJson(resolve(root, 'package.json')),
  readJson(resolve(root, 'release', 'policy.json')),
]);
assertReleasePolicy(policy);
if (packageJson.name !== policy.packageName) {
  throw new Error('Release policy package name does not match package.json.');
}
const channel = releaseChannelForVersion(packageJson.version, policy);
console.log(
  `Release policy passed: ${packageJson.version} maps only to npm tag ${channel.npmDistTag}.`,
);
