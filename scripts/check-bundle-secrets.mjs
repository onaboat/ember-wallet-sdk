import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = fileURLToPath(new URL('../', import.meta.url));
const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));

const forbidden = [
  ['partner Bearer security scheme', /partnerBearer/i],
  ['partner credential description', /Ember partner credential/i],
  ['legacy wallet request signature header', /x-ember-auth/i],
  ['legacy wallet authorization header', /x-ember-session/i],
  ['API-key configuration property', /\bapiKey\s*[:=]/],
  ['known test credential', /test-partner-key/i],
];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const discovered = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) discovered.push(...(await files(path)));
    else discovered.push(path);
  }
  return discovered;
}

const violations = [];
for (const path of await files(distRoot)) {
  if (!['.cjs', '.js', '.map'].includes(extname(path))) continue;
  const contents = await readFile(path, 'utf8');
  for (const [name, pattern] of forbidden) {
    if (pattern.test(contents)) violations.push(`${path}: ${name}`);
  }
}

if (violations.length > 0) {
  throw new Error(`Secretless bundle scan failed:\n${violations.join('\n')}`);
}

console.log(`Secretless bundle scan passed for ${sdkRoot}`);
