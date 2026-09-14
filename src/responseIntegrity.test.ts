import { describe, expect, test } from 'vitest';
import { EmberResponseMismatchError } from './errors';
import {
  assertEvidenceUploadGrant,
  type EvidenceUploadGrantInput,
} from './responseIntegrity';

const NOW = new Date('2026-09-14T10:00:00.000Z');

function grant(
  overrides: Partial<EvidenceUploadGrantInput> = {},
): EvidenceUploadGrantInput {
  return {
    expiresAt: '2026-09-14T10:15:00.000Z',
    headers: {
      'content-type': 'application/pdf',
      'x-amz-checksum-sha256': 'checksum',
    },
    method: 'PUT',
    url: 'https://evidence.example/upload?signature=opaque',
    ...overrides,
  };
}

describe('assertEvidenceUploadGrant', () => {
  test('accepts an unexpired HTTPS PUT grant with object-store headers', () => {
    expect(() => assertEvidenceUploadGrant(grant(), NOW)).not.toThrow();
  });

  test.each([
    ['method', grant({ method: 'POST' })],
    ['scheme', grant({ url: 'http://evidence.example/upload' })],
    ['credentials', grant({ url: 'https://user:secret@evidence.example/upload' })],
    ['fragment', grant({ url: 'https://evidence.example/upload#secret' })],
    ['expiry', grant({ expiresAt: NOW.toISOString() })],
    ['authorization header', grant({ headers: { authorization: 'secret' } })],
    ['Ember credential header', grant({ headers: { 'x-ember-token': 'secret' } })],
    ['header injection', grant({ headers: { 'x-meta': 'safe\r\ninjected: true' } })],
  ])('rejects an unsafe %s', (_case, candidate) => {
    expect(() => assertEvidenceUploadGrant(candidate, NOW)).toThrow(
      EmberResponseMismatchError,
    );
  });
});
