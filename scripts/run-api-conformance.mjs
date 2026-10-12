import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConformanceConfig } from '../conformance/config.mjs';

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

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
readConformanceConfig(process.env, root);
const temporary = await mkdtemp(join(tmpdir(), 'ember-api-conformance-'));
const consumer = join(temporary, 'consumer');
const artifacts = join(root, 'artifacts', 'api-conformance');
const timestamp = new Date().toISOString().replaceAll(':', '-');
const reportPath = join(artifacts, `${timestamp}.json`);

try {
  await mkdir(artifacts, { recursive: true });
  run(npm, ['run', 'contract:check'], { cwd: root });
  run(npm, ['run', 'build'], { cwd: root });
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const provenance = JSON.parse(
    await readFile(join(root, 'contract', 'provenance.json'), 'utf8'),
  );
  const packed = JSON.parse(
    run(
      npm,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
      { cwd: root },
    ),
  );
  const filename = packed[0]?.filename;
  if (typeof filename !== 'string') throw new Error('npm pack returned no filename.');
  const tarball = join(temporary, filename);
  const tarballSha256 = createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex');
  await writeFile(
    join(temporary, 'package.json'),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );
  run(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      consumer,
      tarball,
    ],
    { cwd: temporary },
  );

  const stdout = run(
    process.execPath,
    [join(root, 'conformance', 'runner.mjs')],
    {
      cwd: root,
      env: {
        ...process.env,
        EMBER_CONFORMANCE_CONTRACT_SHA256: provenance.contract.sha256,
        EMBER_CONFORMANCE_CONTRACT_VERSION: provenance.contract.version,
        EMBER_CONFORMANCE_PACKAGE_VERSION: packageJson.version,
        EMBER_CONFORMANCE_REPORT_PATH: reportPath,
        EMBER_CONFORMANCE_SDK_ENTRY: join(
          consumer,
          'node_modules',
          '@embercover',
          'wallet-sdk',
          'dist',
          'index.js',
        ),
        EMBER_CONFORMANCE_SESSION_PATH: join(temporary, 'session.json'),
        EMBER_CONFORMANCE_TARBALL_SHA256: tarballSha256,
        EMBER_CONFORMANCE_UPSTREAM_REVISION: provenance.upstream.revision,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  process.stdout.write(stdout);
} finally {
  await rm(temporary, { force: true, recursive: true });
}
