# Release evidence

The staged-publish workflow requires `release/evidence/v<package-version>.json`.
Copy `evidence.example.json`, replace every placeholder, and commit only the
reviewed, public-safe manifest at the exact source state that will be tagged.

Each evidence digest identifies a retained QA record. The record itself stays
in the approved release evidence store and must contain the package version,
tarball SHA-256 where applicable, test host/build, tester, UTC time and result.
The manifest must never contain credentials, private keys, session material,
signed bytes, upload URLs, evidence bodies or customer information.

`npm run release:check` fails closed when the selected release channel does not
match the package version, the Git ref is not the exact signed annotated tag,
the manifest is missing, a required gate is absent, or package/contract hashes
do not match.
