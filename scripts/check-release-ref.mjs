import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const expectedTag = `v${packageJson.version}`;
if (!/-beta\.\d+$/.test(packageJson.version)) {
  throw new Error(
    `Staged releases require a beta prerelease version, received ${packageJson.version}.`,
  );
}
if (
  process.env.GITHUB_REF_TYPE !== 'tag' ||
  process.env.GITHUB_REF_NAME !== expectedTag
) {
  throw new Error(
    `Run this workflow from exact tag ${expectedTag}; received ${process.env.GITHUB_REF_TYPE ?? 'unknown'} ${process.env.GITHUB_REF_NAME ?? 'unknown'}.`,
  );
}
console.log(`Release ref matches ${expectedTag}.`);
