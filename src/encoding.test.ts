import { Buffer } from 'node:buffer';
import { expect, test } from 'vitest';
import {
  base58Decode,
  base58Encode,
  base64Encode,
  hexEncode,
  utf8,
} from './encoding';

test('base58 encoding round-trips canonical Solana values including leading zeroes', () => {
  for (const value of [
    '1',
    '11111111111111111111111111111111',
    '2iXtA8oeZqUU5pofxK971TCEvFGfems2AcDRaZHKD2pQ',
    '4KoARpEnp9BqTe2Gyzz4NVcL2t2f1xQMRD1bZMactxGBGtUFgx7zWV5a2BE2P7q4PSAdo3uHgRUJyUUCtJaLAdzS',
  ]) {
    expect(base58Encode(base58Decode(value))).toBe(value);
  }
});

test('base64 encoder matches the standard padded representation used by P05', () => {
  for (const value of [
    new Uint8Array(),
    new Uint8Array([0]),
    new Uint8Array([0, 1]),
    new Uint8Array(64).fill(7),
    utf8('Ember wallet proof'),
  ]) {
    expect(base64Encode(value)).toBe(Buffer.from(value).toString('base64'));
  }
});

test('hex encoder preserves leading zeroes', () => {
  expect(hexEncode(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
});
