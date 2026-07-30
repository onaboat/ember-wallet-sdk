import { EmberConfigurationError } from './errors';

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE58_INDEX = new Map(
  Array.from(BASE58_ALPHABET, (character, index) => [character, index] as const),
);

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }
  let numeric = 0n;
  for (const byte of bytes) {
    numeric = numeric * 256n + BigInt(byte);
  }
  let encoded = '';
  while (numeric > 0n) {
    const digit = Number(numeric % 58n);
    encoded = BASE58_ALPHABET[digit] + encoded;
    numeric /= 58n;
  }
  return '1'.repeat(leadingZeroes) + encoded;
}

export function base58Decode(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array();
  let numeric = 0n;
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) {
      throw new EmberConfigurationError('Value is not canonical base58.');
    }
    numeric = numeric * 58n + BigInt(digit);
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') {
    leadingZeroes += 1;
  }
  const bytes: number[] = [];
  while (numeric > 0n) {
    bytes.push(Number(numeric & 0xffn));
    numeric >>= 8n;
  }
  bytes.reverse();
  const decoded = new Uint8Array(leadingZeroes + bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    decoded[leadingZeroes + index] = bytes[index] ?? 0;
  }
  if (base58Encode(decoded) !== value) {
    throw new EmberConfigurationError('Value is not canonical base58.');
  }
  return decoded;
}

export function base64Encode(bytes: Uint8Array): string {
  let encoded = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset] ?? 0;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64_ALPHABET[(combined >> 18) & 63];
    encoded += BASE64_ALPHABET[(combined >> 12) & 63];
    encoded += second === undefined ? '=' : BASE64_ALPHABET[(combined >> 6) & 63];
    encoded += third === undefined ? '=' : BASE64_ALPHABET[combined & 63];
  }
  return encoded;
}

export function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface EmberCrypto {
  randomUuid(): string;
  sha256(bytes: Uint8Array): Promise<Uint8Array>;
  verifyEd25519(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean>;
}

export function webCrypto(): EmberCrypto {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle || typeof crypto.randomUUID !== 'function') {
    throw new EmberConfigurationError(
      'Web Crypto SHA-256 and randomUUID are unavailable; provide an EmberCrypto adapter.',
    );
  }
  return {
    randomUuid: () => crypto.randomUUID(),
    async sha256(bytes) {
      return new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer),
      );
    },
    async verifyEd25519(publicKey, message, signature) {
      const key = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(publicKey).buffer,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
      return crypto.subtle.verify(
        { name: 'Ed25519' },
        key,
        new Uint8Array(signature).buffer,
        new Uint8Array(message).buffer,
      );
    },
  };
}

export async function sha256Hex(
  crypto: EmberCrypto,
  bytes: Uint8Array,
): Promise<string> {
  return hexEncode(await crypto.sha256(bytes));
}
