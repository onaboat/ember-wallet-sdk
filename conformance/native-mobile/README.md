# Native-mobile conformance

This SDK-owned fixture keeps React Native, Metro, Hermes, Android and secure
storage at the infrastructure edge. The published SDK remains free of mobile
framework imports.

`npm run conformance:native` installs the current npm tarball into a clean
consumer, forces Metro to resolve `@embercover/wallet-sdk` from that installed
artifact, and builds:

- a minimal React Native Android application bundle; and
- a headless adapter harness for request-proof and persistence behavior.

Both bundles are accepted by the Hermes compiler shipped with the pinned React
Native release. The adapter harness executes in two separate processes: the
first opens and persists a session; the second receives only the serialized
host-owned session, restores it without another wallet challenge and performs
the same signed request. The proof bytes are compared with a fixed shared
vector.

The deterministic signers and API responses are fixtures. They contain no
private key, cannot sign a Solana transaction and never contact an RPC or Ember
API.

## Runtime adapters

A native wallet must provide:

- `fetch` with React Native abort and header behavior;
- SHA-256, Ed25519 verification and a cryptographically secure UUID source;
- an ephemeral Ed25519 session signer distinct from the protected wallet key;
- secure, application-private persistence for the refresh credential and
  matching non-exportable signer; and
- the exact registered Android application ID as the native host binding.

Mobile Wallet Adapter and Seed Vault types belong in the wallet application,
not this SDK. The protected-wallet signer must preserve exact message bytes;
transaction review, simulation, approval and broadcast remain wallet-owned.

## Manual Android/Solana-phone gate

The repository CI machine proves Metro resolution, Android bundling, Hermes
bytecode compilation and adapter behavior. It does not claim a device boot.
Before Android support is approved:

1. install the fixture in a supported Android emulator and a representative
   Solana phone;
2. confirm the application starts under Hermes with no Node polyfills;
3. open, restore, rotate and revoke against the Devnet QA API using the final
   registered application ID;
4. terminate the process after persistence and verify the session/signer pair
   restores without another challenge;
5. background beyond the 15-minute access window and confirm reauthentication
   is requested honestly; and
6. record biometric/PIN approval timing for the decision-freshness policy.
