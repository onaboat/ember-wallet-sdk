# Compatibility and rollback

Wallets should pin an exact SDK version in their lockfile. npm distribution
tags select a release channel; they are not safe production version pins.

## Release channels

| Package version | npm tag | Purpose | May be the default install |
| --- | --- | --- | --- |
| `x.y.z-beta.N` | `beta` | Integration testing against sandbox/Devnet | No |
| `x.y.z-rc.N` | `release-candidate` | Final host qualification using the complete release evidence matrix | No |
| `x.y.z` | `latest` | Production after every required host and operational gate passes | Yes |

The staging workflow derives the only permitted tag from the package version.
It cannot stage a beta or release candidate as `latest`. npm assigns no special
meaning to custom tags, while an unqualified install resolves `latest`; this
repository therefore reserves `latest` for stable versions.

## Versioning rules

The SDK follows semantic versioning for its public package surface and
observable behavior.

- A patch may fix behavior without changing valid inputs, trusted output
  meaning or required host capabilities.
- A minor may add optional exports, methods, response states or host support.
  Hosts must opt into newly added authority such as scopes or adapters.
- A major is required when an export is removed or renamed, configuration or a
  previously optional field becomes required, a supported runtime is dropped,
  signer/proof bytes change incompatibly, or a previously accepted public
  state becomes invalid in a way that can break an existing correct wallet.
- Every prerelease is treated as an exact integration contract. Compatibility
  between two beta or release-candidate builds is not implied by their shared
  base version.

## API-contract changes

`contract/wallet-v1.json` is an imported, provenance-checked release artifact.
The SDK must be regenerated and all host gates rerun when its bytes change.

Generally compatible changes include a new optional response field that the
runtime schema deliberately permits and a new opt-in endpoint that leaves
existing behavior unchanged. Breaking or coordinated changes include removing
or renaming fields, changing signed canonical bytes, changing identifier or
amount meaning, adding a required request field, or emitting a new value into a
closed enum before every supported wallet can handle it.

The deployed API must not begin emitting a new closed state until a compatible
SDK is available and the supported wallets have upgraded. Broad upstream
strings are not silently converted into guessed SDK enums.

## Upgrade checkpoint

Before changing a wallet's pinned version:

1. inspect the changelog, contract provenance and supported-host matrix;
2. install the exact tarball without workspace links;
3. run the applicable automated and Manual QA gates from `QA.md`;
4. test existing persisted sessions and durable payment/evidence recovery;
5. confirm expired or incompatible authority causes explicit reauthentication;
6. record the wallet build and exact SDK version approved for rollout.

## Rollback

Rollback means deploying the last known-good wallet build with its exact pinned
SDK version. Do not copy generated files or selected source modules between
versions, and do not move a production wallet to a distribution tag at runtime.

Before rollback, confirm the current API contract remains compatible with the
older SDK. If compatibility is not proven, stop the rollout instead of forcing
the old client against new wire behavior. A restored older wallet may reject
newer persisted session data; clearing the session and requesting fresh wallet
ownership proof is the safe recovery path. Never migrate or reconstruct a
session signer from a refresh credential alone.

Published npm versions are immutable and should not be unpublished as an
ordinary rollback mechanism. Move only the appropriate prerelease tag after
the previous artifact has been requalified. Move `latest` only to a stable,
fully qualified version. Record the before/after tag values and verify a clean
install resolves the intended digest before resuming rollout.

## Signing disposition (1.3.2-beta.4)

A reviewed decision can now include `signingDisposition`. Wallets must enforce
`block` at their signing boundary, require explicit consent for `acknowledge`,
and keep coverage eligibility separate. The SDK transports and validates the
assessment; it does not own the wallet signer. An absent or null disposition
from an older backend means safety assessment is unavailable, even when cover
is available. Do not interpret missing assessment as `allow`.

This candidate adds a contract field; it does not expand custom-program
detection or guarantee that every dangerous transaction will be identified.

Simulation balances (beta.5) are optional observations, not spending intent or a guarantee of execution. SOL changes include network fees and account funding; token amounts are raw units. Hosts must retain incomplete-effect warnings. The default decision timeout is 15 seconds; callers may configure their own bounded budget.
