# Release process

Releases are intentionally human-gated. Never add an npm token to this
repository or its GitHub secrets.

## First package version

npm staged publishing and trusted-publisher configuration require the package
to exist first. The initial beta is therefore a one-time manual bootstrap:

1. Enable two-factor authentication on the maintainer npm account.
2. From the exact public tag, run `npm ci` and `npm run verify`.
3. Run the packed SDK against the designated sandbox using the process in
   `CONFORMANCE.md`, and review the provenance-bearing evidence report.
4. Confirm `contract/provenance.json` identifies the reviewed upstream contract
   revision and exact SHA-256.
5. Run `npm pack` and inspect the eleven-file tarball.
6. Publish that exact tarball with
   `npm publish <tarball> --tag beta --access public`.
7. Confirm `npm install @embercover/wallet-sdk@beta` resolves the expected
   version and run the consumer smoke test.

## Subsequent versions

Configure the npm trusted publisher for:

- owner: `onaboat`
- repository: `ember-wallet-sdk`
- workflow: `publish.yml`
- environment: `npm-stage`
- allowed action: `npm stage publish` only

Then set package publishing access to require 2FA and disallow traditional
tokens. Configure the public GitHub `npm-stage` environment with a required
reviewer and tag protection.

For each beta:

1. update `package.json`, `package-lock.json`, and `CHANGELOG.md`;
2. verify the recorded contract revision and digest, then run `npm ci` and
   `npm run verify`;
3. run `npm run conformance:api` against the designated sandbox and review its
   evidence report;
4. run `npm run conformance:cors` with the registered HTTPS and Chrome origins
   and retain the exact-origin result;
5. retain the `npm run conformance:native` result, then complete the Android
   emulator and representative Solana-phone Manual QA checkpoint from `QA.md`;
6. create the exact signed tag `v<package-version>`;
7. manually run `publish.yml` from that tag;
8. download and inspect the staged tarball and its provenance manifest on npm;
9. approve it with maintainer 2FA; and
10. install by exact version and rerun the smoke test.

The workflow cannot publish directly. It can only place a package in npm's
private staging area for later human approval.
