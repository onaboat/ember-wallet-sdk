import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { runBuild } = require('metro');
const { mergeConfig } = require('metro-config');
const { getDefaultConfig: getReactNativeConfig } = require(
  '@react-native/metro-config',
);

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const fixtureRoot = join(root, 'conformance', 'native-mobile');
// Metro's file map canonicalizes macOS /var to /private/var. Resolve the
// temporary root up front so entry paths and watched paths use one identity.
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), 'ember-native-mobile-')),
);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmEnvironment = {
  ...process.env,
  npm_config_cache: join(root, 'node_modules', '.cache', 'npm-native-mobile'),
};

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hermesCompiler() {
  const directory =
    process.platform === 'darwin'
      ? 'osx-bin'
      : process.platform === 'win32'
        ? 'win64-bin'
        : 'linux64-bin';
  const executable = process.platform === 'win32' ? 'hermesc.exe' : 'hermesc';
  return join(
    root,
    'node_modules',
    'hermes-compiler',
    'hermesc',
    directory,
    executable,
  );
}

function resolvePackedSdk(sdkEntry) {
  return (context, moduleName, platform) => {
    if (moduleName === '@embercover/wallet-sdk') {
      return { filePath: sdkEntry, type: 'sourceFile' };
    }
    return context.resolveRequest(context, moduleName, platform);
  };
}

function sharedResolver(consumerDirectory, sdkEntry) {
  return {
    nodeModulesPaths: [
      join(consumerDirectory, 'node_modules'),
      join(root, 'node_modules'),
    ],
    resolveRequest: resolvePackedSdk(sdkEntry),
  };
}

async function metroBundle({ config, entry, output }) {
  const built = await runBuild(config, {
    dev: false,
    entry,
    minify: false,
    platform: 'android',
    sourceMap: false,
  });
  await writeFile(output, built.code);
  return built.code;
}

function assertMobileBundle(code, label) {
  assert(!/['"]node:[^'"]+['"]/.test(code), `${label} imports a Node module.`);
  for (const specifier of new Set(
    builtinModules.map((name) => name.replace(/^node:/, '')),
  )) {
    const escaped = escapeRegExp(specifier);
    const pattern = new RegExp(
      `(?:\\bfrom\\s*|\\brequire\\s*\\(|\\bimport\\s*\\()\\s*['"]${escaped}['"]`,
    );
    assert(
      !pattern.test(code),
      `${label} imports the Node built-in ${specifier}.`,
    );
  }
}

function compileHermes(compiler, input, output) {
  run(compiler, ['-O', '-emit-binary', '-out', output, input]);
}

function parseHarnessResult(output) {
  const failure = output
    .split(/\r?\n/)
    .find((line) => line.startsWith('EMBER_NATIVE_FAILURE '));
  if (failure) throw new Error(`Native adapter harness failed: ${failure}`);
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith('EMBER_NATIVE_RESULT '));
  if (!line) throw new Error('Native adapter harness emitted no result.');
  return JSON.parse(line.slice('EMBER_NATIVE_RESULT '.length));
}

async function executableHarness(bundle, output, restoredSession) {
  const bootstrap = [
    'globalThis.print = (...values) => console.log(...values);',
    `globalThis.__EMBER_NATIVE_RESTORED_SESSION__ = ${JSON.stringify(restoredSession)};`,
    '',
  ].join('\n');
  await writeFile(output, `${bootstrap}${bundle}`);
  return parseHarnessResult(run(process.execPath, [output]));
}

try {
  const packageDirectory = join(temporary, 'package');
  const consumerDirectory = join(temporary, 'consumer');
  await Promise.all([mkdir(packageDirectory), mkdir(consumerDirectory)]);

  const packed = JSON.parse(
    run(
      npm,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', packageDirectory],
      { cwd: root, env: npmEnvironment },
    ),
  );
  const filename = packed[0]?.filename;
  if (typeof filename !== 'string') throw new Error('npm pack returned no filename.');
  const tarball = join(packageDirectory, filename);
  const tarballSha256 = createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex');
  await writeFile(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );
  run(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      '--prefix',
      consumerDirectory,
      tarball,
    ],
    { cwd: temporary, env: npmEnvironment },
  );

  const appEntry = join(consumerDirectory, 'App.js');
  const harnessEntry = join(consumerDirectory, 'hermes-harness.js');
  await Promise.all([
    copyFile(join(fixtureRoot, 'App.js'), appEntry),
    copyFile(join(fixtureRoot, 'hermes-harness.js'), harnessEntry),
  ]);
  const sdkEntry = join(
    consumerDirectory,
    'node_modules',
    '@embercover',
    'wallet-sdk',
    'dist',
    'index.js',
  );
  const resolver = sharedResolver(consumerDirectory, sdkEntry);
  const reactNativeConfig = mergeConfig(
    getReactNativeConfig(consumerDirectory),
    {
      projectRoot: consumerDirectory,
      resolver,
      watchFolders: [consumerDirectory, root],
    },
  );
  const harnessConfig = mergeConfig(getReactNativeConfig(consumerDirectory), {
    projectRoot: consumerDirectory,
    resolver,
    serializer: {
      getModulesRunBeforeMainModule: () => [],
      getPolyfills: () => [],
    },
    watchFolders: [consumerDirectory, root],
  });

  const appBundlePath = join(temporary, 'android-app.bundle.js');
  const harnessBundlePath = join(temporary, 'android-hermes-harness.bundle.js');
  // Metro's file map is process-global. Build the two deliberately different
  // configurations sequentially so one graph cannot replace the other's
  // project root while files are being hashed.
  const appBundle = await metroBundle({
    config: reactNativeConfig,
    entry: appEntry,
    output: appBundlePath,
  });
  const harnessBundle = await metroBundle({
    config: harnessConfig,
    entry: harnessEntry,
    output: harnessBundlePath,
  });
  assertMobileBundle(appBundle, 'React Native Android bundle');
  assertMobileBundle(harnessBundle, 'Native adapter harness bundle');
  assert(
    appBundle.includes('EmberSdkNativeConformance'),
    'React Native Android entry was not registered.',
  );
  assert(
    harnessBundle.includes('ember-wallet-request-v1'),
    'The packed SDK request-proof implementation is absent from the harness.',
  );

  const compiler = hermesCompiler();
  const compilerDetails = run(compiler, ['-version']);
  const compilerVersion = compilerDetails.match(
    /Hermes release version:\s*([^\s]+)/,
  )?.[1];
  assert(compilerVersion, 'Hermes compiler reported no release version.');
  const appBytecode = join(temporary, 'android-app.hbc');
  const harnessBytecode = join(temporary, 'android-hermes-harness.hbc');
  compileHermes(compiler, appBundlePath, appBytecode);
  compileHermes(compiler, harnessBundlePath, harnessBytecode);
  assert((await readFile(appBytecode)).length > 0, 'Android Hermes bytecode is empty.');
  assert(
    (await readFile(harnessBytecode)).length > 0,
    'Native harness Hermes bytecode is empty.',
  );

  const firstRun = await executableHarness(
    harnessBundle,
    join(temporary, 'native-first-process.cjs'),
    null,
  );
  assert(firstRun.restored === false, 'First native process unexpectedly restored state.');
  assert(firstRun.challengeCalls === 1, 'First native process did not open one session.');
  assert(firstRun.signedReadCalls === 1, 'First native signed read did not execute.');
  assert(firstRun.requestProofMatches === true, 'Native request proof differs from vector.');
  assert(firstRun.offerId === 'offer_native-conformance', 'Native offer response was not validated.');
  assert(firstRun.persistedSession, 'Native secure-store adapter saved no session.');

  const restoredRun = await executableHarness(
    harnessBundle,
    join(temporary, 'native-restored-process.cjs'),
    firstRun.persistedSession,
  );
  assert(restoredRun.restored === true, 'Second native process did not restore state.');
  assert(
    restoredRun.challengeCalls === 0,
    'Second native process opened a duplicate wallet challenge.',
  );
  assert(restoredRun.signedReadCalls === 1, 'Restored native signed read did not execute.');
  assert(restoredRun.requestProofMatches === true, 'Restored request proof differs from vector.');

  console.log(
    `Native-mobile conformance passed: packed SDK ${tarballSha256.slice(0, 12)}, ` +
      `Metro Android bundle, Hermes ${compilerVersion}, request-proof vector, ` +
      'and two-process session restoration.',
  );
} finally {
  await rm(temporary, { force: true, recursive: true });
}
