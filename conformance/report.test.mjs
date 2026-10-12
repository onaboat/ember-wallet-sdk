import { expect, test } from 'vitest';
import { safeConformanceError } from './report.mjs';

test('conformance failure evidence omits messages, paths, responses, and causes', () => {
  const error = Object.assign(
    new Error('secret refresh token and signed upload URL'),
    {
      cause: new Error('private key'),
      code: 'service_unavailable',
      field: 'status',
      operation: 'claims.get',
      path: '/v1/wallet/claims/claim_customer',
      reason: 'unexpected_state',
      response: { refreshToken: 'secret' },
      status: 503,
    },
  );
  const safe = safeConformanceError(error);
  expect(safe).toEqual({
    name: 'Error',
    code: 'service_unavailable',
    field: 'status',
    operation: 'claims.get',
    reason: 'unexpected_state',
    status: 503,
  });
  expect(JSON.stringify(safe)).not.toContain('secret');
  expect(JSON.stringify(safe)).not.toContain('claim_customer');
});
