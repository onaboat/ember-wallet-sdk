import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkedInRoot = resolve(sdkRoot, 'src/generated');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'ember-wallet-wire-'));
const candidateRoot = join(temporaryRoot, 'generated');

async function generatedFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await generatedFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

async function runGenerator() {
  const cli = resolve(sdkRoot, 'node_modules/@hey-api/openapi-ts/bin/run.js');
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cli, '--file', 'openapi-ts.config.mjs'], {
      cwd: sdkRoot,
      env: {
        ...process.env,
        EMBER_WIRE_OUTPUT: candidateRoot,
      },
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else {
        rejectRun(
          new Error(
            `OpenAPI generator failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`,
          ),
        );
      }
    });
  });
}

try {
  await runGenerator();
  const checkedInFiles = await generatedFiles(checkedInRoot);
  const candidateFiles = await generatedFiles(candidateRoot);
  if (checkedInFiles.join('\n') !== candidateFiles.join('\n')) {
    throw new Error(
      'Generated wallet file set is stale. Run `npm run generate` and commit the result.',
    );
  }
  for (const file of checkedInFiles) {
    const [checkedIn, candidate] = await Promise.all([
      readFile(join(checkedInRoot, file)),
      readFile(join(candidateRoot, file)),
    ]);
    if (!checkedIn.equals(candidate)) {
      throw new Error(
        `Generated wallet file ${file} is stale. Run \`npm run generate\` and commit the result.`,
      );
    }
  }
  console.log(`Public wallet contract is current (${checkedInFiles.length} files).`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
