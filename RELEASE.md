# Release process

Releases are human-gated. The repository contains no npm token, and automation
may stage but never approve a package. Approval requires a maintainer's 2FA.

## Channels

| Version shape | npm tag | Use |
| --- | --- | --- |
| `x.y.z-beta.N` | `beta` | Sandbox/Devnet integration testing |
| `x.y.z-rc.N` | `release-candidate` | Final supported-host qualification |
| `x.y.z` | `latest` | Production after all required evidence passes |

`release/policy.json` is the machine-readable authority. The workflow requires
the matching channel as an explicit choice and rejects prereleases selected for
`latest`. Consumers must still pin an exact version.

Registry inspection on 15 September 2026 found `beta` at `1.3.2-beta.1` but
`latest` at `1.3.2-beta.0`. That existing prerelease `latest` assignment
violates the new policy. It was not changed by Branch 07. Before recommending
an unqualified install, a maintainer must remove that prerelease tag or replace
it only with a fully qualified stable release, then record the before/after
values. Never move `latest` to another beta or release candidate.

## Trusted staging prerequisites

Configure the npm trusted publisher for:

- owner: `onaboat`;
- repository: `ember-wallet-sdk`;
- workflow: `publish.yml`;
- GitHub environment: `npm-stage`; and
- allowed action: `npm stage publish` only.

Require a reviewer on the public repository's `npm-stage` environment. On npm,
require 2FA, disallow traditional publishing tokens, and verify the repository
URL matches `package.json`. Staged publishing requires npm 11.15 or later and
Node 22.14 or later; the workflow pins Node 24 and npm 11.18.

## Prepare one exact candidate

1. Choose an unused version whose suffix matches the intended channel. Update
   `package.json`, `package-lock.json`, and `CHANGELOG.md` together.
2. Run `npm ci`, `npm audit --audit-level=high`, and `npm run verify`.
3. Run `npm run release:pack`. Retain the reported tarball and SHA-256.
4. Run `npm run conformance:api` against the designated sandbox using that
   exact package state and review its provenance-bearing report.
5. Run `npm run conformance:cors` with the registered HTTPS and Chrome origins.
6. Complete the Android emulator, representative Solana-phone and full product
   Manual QA checkpoints in `QA.md`.
7. Hash each approved QA record. Copy `release/evidence.example.json` to
   `release/evidence/v<package-version>.json` and fill every exact package,
   contract and evidence field. Only public-safe hashes and timestamps belong
   in this manifest.
8. Run `npm run release:pack` again. Adding release evidence must not change the
   package tarball because `release/` is outside the published allowlist. The
   second SHA-256 must match the manifest.
9. Commit the reviewed release state, then create an annotated signed tag
   `v<package-version>`. Confirm the hosting service reports the tag signature
   as verified before starting the workflow.

The current `1.3.2-beta.1` version already exists on npm. Branch 07 deliberately
does not guess the next version or create an evidence manifest, commit or tag.

## Stage and approve

Run `publish.yml` manually from the exact tag and select its matching channel.
The workflow:

1. checks out full tag history without persisted Git credentials;
2. installs dependencies from the lockfile and runs audit plus full verification;
3. writes the SBOM;
4. packs one exact tarball;
5. verifies the channel, annotated tag signature material, tarball digest,
   contract provenance and every required evidence gate;
6. uploads the tarball, SBOM and evidence manifest together; and
7. stages that same tarball with OIDC using the policy-selected npm tag.

Download the staged tarball, compare its digest with the uploaded artifact and
manifest, inspect the thirteen-file allowlist and SBOM, and verify provenance
before approval. The maintainer then approves through npm with 2FA. After
publication, install the exact version into clean consumers, rerun smoke tests,
and record the resulting dist-tags.

If any check or review fails, reject the staged package rather than approving
it. The tag attached to a staged package is immutable; changing channels
requires rejection and a new version/candidate. See `COMPATIBILITY.md` for the
wallet rollback procedure. Do not unpublish an ordinary bad rollout.
