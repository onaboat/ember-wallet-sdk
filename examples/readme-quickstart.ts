import {
  EmberWalletClient,
  P11_WALLET_SCOPES,
  type AvailableOfferResponse,
  type EmberMessageSigner,
  type OfferCluster,
  type QuotePaymentFactsResponse,
} from '../src/index';

export interface QuotedUsdcPayment {
  cluster: OfferCluster;
  expiresAt: string;
  payerWallet: string;
  payment: QuotePaymentFactsResponse;
  quoteId: string;
}

export interface WalletPaymentAdapter {
  simulateReviewSignAndSend(input: QuotedUsdcPayment): Promise<string>;
}

export async function activateDevnetCoverage(input: {
  client: EmberWalletClient;
  confirmTerms(offer: AvailableOfferResponse): Promise<void>;
  paymentAdapter: WalletPaymentAdapter;
  walletSigner: EmberMessageSigner;
}) {
  await input.client.openSession({
    walletSigner: input.walletSigner,
    requestedScopes: P11_WALLET_SCOPES,
  });

  const { offers } = await input.client.listOffers();
  const offer = offers.find(
    (candidate) =>
      candidate.environment === 'sandbox' &&
      candidate.cluster === 'devnet' &&
      candidate.availabilityMode === 'live' &&
      candidate.lifecycle === 'active',
  );
  if (!offer) throw new Error('No devnet Ember offer is currently available.');

  await input.confirmTerms(offer);
  await input.client.acceptTerms({
    documentSha256: offer.termsSha256,
    offerId: offer.offerId,
    offerVersion: offer.offerVersion,
    termsVersion: offer.termsVersion,
  });

  const quote = await input.client.createQuote({ offerId: offer.offerId });
  if (
    !quote.payload.paymentAllowed ||
    !quote.payload.createsCoverage ||
    quote.payload.offer.cluster !== 'devnet'
  ) {
    throw new Error('The returned quote is not a payable devnet quote.');
  }

  const paymentSignature =
    await input.paymentAdapter.simulateReviewSignAndSend({
      cluster: quote.payload.offer.cluster,
      expiresAt: quote.payload.validity.expiresAt,
      payerWallet: quote.payload.payerWallet,
      payment: quote.payload.payment,
      quoteId: quote.payload.quoteId,
    });
  const payment = await input.client.createPayment({
    paymentSignature,
    quoteId: quote.payload.quoteId,
  });

  return {
    offer,
    payment,
    quote,
    refreshPayment: () => input.client.getPayment(payment.paymentId),
  };
}
