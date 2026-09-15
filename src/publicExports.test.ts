import { describe, expect, test } from 'vitest';
import * as sdk from './index';

describe('public runtime exports', () => {
  test('exports every session helper advertised by the package declarations', () => {
    expect(sdk.parsePersistedWalletSession).toBeTypeOf('function');
    expect(sdk.sessionState).toBeTypeOf('function');
    expect(sdk.walletRequestPayload).toBeTypeOf('function');
  });
});
