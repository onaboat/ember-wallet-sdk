import React from 'react';
import { AppRegistry, StyleSheet, Text, View } from 'react-native';
import { sessionState } from '@embercover/wallet-sdk';

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  text: {
    fontSize: 18,
  },
});

function EmberSdkConformanceApp() {
  const state = sessionState(
    {
      environment: 'sandbox',
      expiresAt: '2099-01-01T00:00:00.000Z',
      integrationId: 'integration_native-conformance',
      integrationVersion: 1,
      partnerId: 'partner_native-conformance',
      refreshExpiresAt: '2099-01-02T00:00:00.000Z',
      refreshToken: 'fixture-runtime-only',
      scopes: ['offers:read'],
      sessionId: 'session_native-conformance',
      sessionPublicKey: 'SysvarRent111111111111111111111111111111111',
      walletAddress: '11111111111111111111111111111111',
      walletSubjectId: 'wallet_native-conformance',
    },
    new Date('2026-09-15T00:00:00.000Z'),
    60_000,
  );

  return (
    <View style={styles.container}>
      <Text style={styles.text}>Ember SDK native state: {state.status}</Text>
    </View>
  );
}

AppRegistry.registerComponent(
  'EmberSdkNativeConformance',
  () => EmberSdkConformanceApp,
);
