import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--json', '--dry-run', '--ignore-scripts'],
  {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: join(root, 'node_modules', '.cache', 'npm-package-check'),
    },
  },
);
if (result.status !== 0) {
  throw new Error(result.stderr || 'npm pack dry-run failed');
}
const [packed] = JSON.parse(result.stdout);
const files = packed?.files?.map((file) => file.path).sort();
if (!Array.isArray(files) || files.length === 0) {
  throw new Error('npm pack dry-run returned no package files');
}
const allowedRoots = [
  'COMPATIBILITY.md',
  'LICENSE',
  'README.md',
  'SUPPORT.md',
  'contract/README.md',
  'contract/provenance.json',
  'dist/',
  'package.json',
];
const unexpected = files.filter(
  (file) =>
    !allowedRoots.some((allowed) =>
      allowed.endsWith('/') ? file.startsWith(allowed) : file === allowed,
    ),
);
if (unexpected.length > 0) {
  throw new Error(`Unexpected npm package files:\n${unexpected.join('\n')}`);
}
for (const required of [
  'COMPATIBILITY.md',
  'dist/index.cjs',
  'dist/index.cjs.map',
  'dist/index.d.cts',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/index.js.map',
  'LICENSE',
  'README.md',
  'SUPPORT.md',
  'contract/README.md',
  'contract/provenance.json',
  'package.json',
]) {
  if (!files.includes(required)) {
    throw new Error(`Required npm package file is missing: ${required}`);
  }
}
console.log(`npm package allowlist passed (${files.length} files, ${packed.size} bytes).`);
