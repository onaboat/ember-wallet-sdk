import { expect, test } from 'vitest';
import { P10_WALLET_SCOPES, P11_WALLET_SCOPES, wireSchemas } from './index';

const walletPublicKey = '1'.repeat(32);

test('generated transaction decision decoder enforces the encoded byte ceiling', () => {
  const result = wireSchemas.zCreateCoverageDecisionRequest.safeParse({
    coverageInstanceId: 'coverage_contract',
    kind: 'transaction',
    transactionBytes: 'A'.repeat(1645),
  });
  expect(result.success).toBe(false);
});

test('generated message decision decoder enforces the encoded byte ceiling', () => {
  const result = wireSchemas.zCreateCoverageDecisionRequest.safeParse({
    coverageInstanceId: 'coverage_contract',
    kind: 'message',
    messageBytes: 'A'.repeat(10925),
    walletMethod: 'signMessage',
  });
  expect(result.success).toBe(false);
});

test('wallet challenge contract is secretless and bound to a public integration', () => {
  const result = wireSchemas.zCreateChallengeRequest.parse({
    client: { kind: 'browser' },
    integrationId: 'integration_contract',
    requestedScopes: [...P10_WALLET_SCOPES],
    sessionPublicKey: walletPublicKey,
    walletAddress: walletPublicKey,
  });
  expect(result).not.toHaveProperty('apiKey');
  expect(result).not.toHaveProperty('partnerSecret');
});

test('P10 lifecycle scope preset excludes the P11 claim scope', () => {
  expect(P10_WALLET_SCOPES).toContain('records:read');
  expect(P10_WALLET_SCOPES).not.toContain('claims:create');
  expect(P11_WALLET_SCOPES).toEqual([
    ...P10_WALLET_SCOPES,
    'claims:create',
  ]);
});

test('generated P11 claim request uses the stable camel-case wire contract', () => {
  expect(
    wireSchemas.zCreateClaimRequest.parse({
      claimedAmountMicros: '1000000',
      decisionId: 'decision_contract',
      lossEvent: 'direct_malicious_signing_loss',
      statement: 'Loss statement.',
    }),
  ).toEqual({
    claimedAmountMicros: '1000000',
    decisionId: 'decision_contract',
    lossEvent: 'direct_malicious_signing_loss',
    statement: 'Loss statement.',
  });
});

test('generated evidence response accepts only canonical lifecycle states', () => {
  const result = wireSchemas.zSubmitDecisionEvidenceResponse.safeParse({
    accepted: true,
    decisionId: 'decision_contract',
    evidenceState: 'invented_state',
  });
  expect(result.success).toBe(false);
});

test('generated offer decoder rejects unknown clusters and environments', () => {
  const result = wireSchemas.zAvailableOfferResponse.safeParse({
    aggregateLimitMicros: '10000000000',
    appealWindowDays: 7,
    availabilityMode: 'test',
    benefitPeriodCount: 12,
    benefitPeriodLimitMicros: '10000000000',
    cancellationRuleCode: 'none',
    catalogueSha256: 'a'.repeat(64),
    cluster: 'testnet',
    coverageDurationDays: 365,
    coverageDurationMonths: 12,
    coveredTransactionLimit: 100,
    deductibleMicros: '0',
    delegateLossTailDays: 30,
    displayName: 'Core Annual',
    environment: 'preview',
    immediateLossClaimWindowDays: 7,
    lifecycle: 'testing',
    offerId: 'offer_core-annual',
    offerVersion: 1,
    payerMustEqualProtectedWallet: true,
    paymentAsset: 'USDC',
    paymentAssetDecimals: 6,
    perLossLimitMicros: '10000000000',
    policySha256: 'b'.repeat(64),
    policyVersion: 'policy-v0.1',
    priceBaseUnits: '249990000',
    productCode: 'core',
    protectedWalletCount: 1,
    refundRuleCode: 'none',
    snapshotSha256: 'c'.repeat(64),
    termsSha256: 'd'.repeat(64),
    termsVersion: 'terms-v0.1',
    waitingPeriodDays: 0,
  });
  expect(result.success).toBe(false);
});
