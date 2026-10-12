import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, appendFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const outputDirectory = join(root, 'artifacts', 'release');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const candidateName = `${packageJson.name.replace(/^@/, '').replace('/', '-')}-${packageJson.version}.tgz`;
let candidateExists = false;
try {
  await access(join(outputDirectory, candidateName));
  candidateExists = true;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (candidateExists) throw new Error(`Refusing to overwrite immutable candidate ${candidateName}. Choose a new version.`);
run(process.execPath, ['scripts/check-contract-provenance.mjs'], { cwd: root });
await mkdir(outputDirectory, { recursive: true });
const npmOptions = {
  cwd: root,
  env: {
    ...process.env,
    npm_config_cache: join(root, 'node_modules', '.cache', 'npm-release'),
  },
};
run(npm, ['run', 'prepack'], npmOptions);
const packed = JSON.parse(
  run(
    npm,
    [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      outputDirectory,
    ],
    npmOptions,
  ),
);
const filename = packed[0]?.filename;
if (typeof filename !== 'string' || !filename.endsWith('.tgz')) {
  throw new Error('npm pack returned no release tarball filename.');
}
const tarball = join(outputDirectory, filename);
const sha256 = createHash('sha256')
  .update(await readFile(tarball))
  .digest('hex');

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `tarball=${tarball}\ntarball_sha256=${sha256}\n`,
  );
}
console.log(`Release tarball prepared: ${tarball} (${sha256}).`);
