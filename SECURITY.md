# Security

Please do not disclose security vulnerabilities in a public issue.

Report suspected vulnerabilities privately through GitHub Security Advisories
for this repository. Include the affected SDK version, platform, reproduction
steps, and whether wallet keys, session credentials, signed bytes, or user data
may be involved.

The SDK must never receive a wallet private key, seed phrase, partner
credential, or administrative credential. If an integration appears to require
one, stop the integration and report it privately.

## Merge checks

Before handing a branch back for merge, run a clean `npm ci`,
`npm audit --audit-level=high`, and `npm run verify`. Passing the behavioral
suite alone does not establish that the dependency audit passes. CI and release
staging retain the full audit, including development dependencies, with no
advisory exceptions.
