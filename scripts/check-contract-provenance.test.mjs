import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertContractProvenance,
  checkContractProvenance,
} from './check-contract-provenance.mjs';

const root = resolve(import.meta.dirname, '..');

describe('contract provenance', () => {
  test('accepts the checked-in authoritative contract record', async () => {
    await expect(checkContractProvenance(root)).resolves.toMatchObject({
      packageName: '@embercover/wallet-sdk',
      schemaVersion: 1,
    });
  });

  test('rejects contract bytes that do not match the recorded digest', async () => {
    const provenance = JSON.parse(
      await readFile(resolve(root, 'contract/provenance.json'), 'utf8'),
    );
    expect(() =>
      assertContractProvenance({
        contractBytes: Buffer.from('{"info":{"version":"1.0.0"}}\n'),
        packageName: '@embercover/wallet-sdk',
        provenance,
      }),
    ).toThrow(/digest mismatch/);
  });

  test('rejects an untrusted contract path even when other metadata is valid', async () => {
    const [contractBytes, provenance] = await Promise.all([
      readFile(resolve(root, 'contract/wallet-v1.json')),
      readFile(resolve(root, 'contract/provenance.json'), 'utf8').then(JSON.parse),
    ]);
    provenance.contract.path = '../wallet-v1.json';
    expect(() =>
      assertContractProvenance({
        contractBytes,
        packageName: '@embercover/wallet-sdk',
        provenance,
      }),
    ).toThrow(/path must be contract\/wallet-v1.json/);
  });

  test('rejects a shortened upstream revision', async () => {
    const [contractBytes, provenance] = await Promise.all([
      readFile(resolve(root, 'contract/wallet-v1.json')),
      readFile(resolve(root, 'contract/provenance.json'), 'utf8').then(JSON.parse),
    ]);
    provenance.upstream.revision = provenance.upstream.revision.slice(0, 12);
    expect(() =>
      assertContractProvenance({
        contractBytes,
        packageName: '@embercover/wallet-sdk',
        provenance,
      }),
    ).toThrow(/revision must be a full lowercase Git commit hash/);
  });
});
