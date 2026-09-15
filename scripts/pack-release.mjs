import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
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
