# Release evidence

The staged-publish workflow requires `release/evidence/v<package-version>.json`.
Use the template for the package version's release channel, replace every
placeholder, and commit only the reviewed, public-safe manifest at the exact
source state that will be tagged:

- `evidence.beta.example.json` is for `x.y.z-beta.N`. It requires the real API,
  registered Chrome-extension origin and manual Chrome product-QA records used
  for integration testing. It makes no HTTPS-web or native-device release claim.
- `evidence.example.json` is for `x.y.z-rc.N` and stable `x.y.z`. It requires the
  complete qualified-host evidence set, including HTTPS web-wallet, Android
  emulator and representative Solana-phone records.

Each evidence digest identifies a retained QA record. The record itself stays
in the approved release evidence store and must contain the package version,
tarball SHA-256 where applicable, test host/build, tester, UTC time and result.
The manifest must never contain credentials, private keys, session material,
signed bytes, upload URLs, evidence bodies or customer information.

The SHA-256 fields are digests of the reviewed records, not arbitrary IDs. For
each retained public-safe record, calculate its digest with
`shasum -a 256 <record>` and copy only the lowercase digest into the manifest.

`npm run release:check` fails closed when the selected release channel does not
match the package version, the Git ref is not the exact signed annotated tag,
the manifest is missing, a required gate is absent, or package/contract hashes
do not match. A beta manifest cannot claim or substitute later host qualification;
release-candidate and stable releases remain blocked until every declared host
gate passes.
