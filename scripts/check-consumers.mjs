import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const node = process.execPath;
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'ember-wallet-sdk-consumer-'));

try {
  const pack = JSON.parse(
    run(
      npm,
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        temporary,
      ],
      { cwd: root },
    ),
  );
  const filename = pack[0]?.filename;
  if (typeof filename !== 'string') throw new Error('npm pack returned no filename');
  const tarball = join(temporary, filename);
  const consumer = join(temporary, 'consumer');
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
  await writeFile(
    join(consumer, 'esm.mjs'),
    [
      "import { EmberWalletClient, P10_WALLET_SCOPES } from '@embercover/wallet-sdk';",
      "if (typeof EmberWalletClient !== 'function') throw new Error('missing ESM client');",
      "if (P10_WALLET_SCOPES.includes('claims:create')) throw new Error('P11 scope leaked');",
      '',
    ].join('\n'),
  );
  await writeFile(
    join(consumer, 'cjs.cjs'),
    [
      "const sdk = require('@embercover/wallet-sdk');",
      "if (typeof sdk.EmberWalletClient !== 'function') throw new Error('missing CJS client');",
      "if (!Array.isArray(sdk.P10_WALLET_SCOPES)) throw new Error('missing CJS exports');",
      '',
    ].join('\n'),
  );
  run(node, ['esm.mjs'], { cwd: consumer });
  run(node, ['cjs.cjs'], { cwd: consumer });
  console.log('ESM and CommonJS consumer installation checks passed.');
} finally {
  await rm(temporary, { force: true, recursive: true });
}
