import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['sbom', '--sbom-format', 'cyclonedx'],
  { encoding: 'utf8' },
);
if (result.status !== 0) {
  throw new Error(result.stderr || 'npm sbom failed');
}
const parsed = JSON.parse(result.stdout);
const output = new URL('../artifacts/ember-wallet-sdk.cdx.json', import.meta.url);
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(output, `${JSON.stringify(parsed, null, 2)}\n`);
console.log(`wrote ${output.pathname}`);
