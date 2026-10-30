# Source restoration and handoff

Recorded 2026-10-26 for the corrected `ejmlabs/ejm-chess` source PR.

## Source and ownership

This repository owns the chess implementation, product guides and migrated
`add-cloudflare-chess` OpenSpec plan. The owner corrected the earlier Lab PR
placement on 2026-10-26. Read [the current handoff](../openspec/HANDOFF.md) and
[the unchanged task record](../openspec/changes/add-cloudflare-chess/tasks.md).
The plan retains 58 of 71 checked tasks. Restoration closes no launch gate.

The implementation was restored from a private source-retention archive:

| Archive | Files | SHA-256 |
| --- | ---: | --- |
| `ejm-chess-source.tar.gz` | 322 | `808a000963a2d7eb50015ab2a6950ee5dd5cf111bb66b8fdbe2fe46d37295036` |

Archive integrity, member hashes, sizes and modes were verified against the
private inventory. The retained source had no committed product HEAD. It
includes the partial capacity failure-receipt patch, which was unreviewed,
untested and undeployed when retained. This PR preserves that state; it is not
a qualified release candidate or proof of current live service behavior.

The old temporary checkout is gone. The private archive and original planning
checkout remain preserved. The PR adds the restored product source to its
own repository rather than copying Lab, launch-film or shared UI source.

## Shared UI dependency

The five public `@ejm/*` dependencies use version `0.1.0` and portable sibling
paths in both npm files:

```text
workspace/
  ejm-ui/
    packages/{core,site,ssg,tokens,ui}/
  ejm-chess/
```

The matching retained `ejm-ui` source archive has SHA-256
`544d5bd1fad6261600190c4b19a777a73b34906cbf9a4abc556a34fc178fa90c`
and 1,085 files. Its recorded base HEAD is
`7ac2b2d4e3540d0e216a5200b67770c5f6d30aeb`, with additional working-source
changes. That commit or package version alone is not an exact source pin.
The archive remains private pending its owner's source review and delivery.
No shared implementation is vendored into this product.

Restore that matching owner source beside this checkout, install its lockfile,
and build required token outputs before installing or checking chess. Registry
versions and integrity fields in the product lockfile are unchanged by the
path rebinding. Fresh owner acceptance, installation, typecheck and build must
establish compatibility before release; retention is not that evidence.

## Configuration gap

Six private provider configurations were intentionally excluded and are ignored
by Git:

- `wrangler.jsonc`
- `wrangler.capacity.jsonc`
- `wrangler.proof-acceptance.jsonc`
- `wrangler.proof-qualification.jsonc`
- `wrangler.proof-service.jsonc`
- `wrangler.recovery-drill.jsonc`

Reconstruct them from reviewed current provider state and the retained private
records. Preserve distinct production, local, recovery, proof and capacity
boundaries. Do not paste provider identifiers, private destinations, credentials
or old execution windows into public source. Keep secrets in local variables
or the provider secret store.

Status on 2026-10-30: a reviewed local `wrangler.jsonc` (gitignored) exists with
production bindings plus `env.local` for Worker tests and the protected canary
deploy. The five specialty configs remain absent in this checkout. Rebuild each
from private records before capacity, proof-acceptance, proof-qualification,
proof-service or recovery-drill commands. Matching shared UI source for chess
contracts is the sibling `ejm-ui` branch `wip/preserve-all-20261025`; keep
discovery publication behind an approved public opening.

Worker tests read `wrangler.jsonc` in the local environment. Recovery tests also
read `wrangler.recovery-drill.jsonc`. Worker dry-run packaging and preview need
reviewed bindings. Specialty-config omission means those commands cannot be
claimed as passing from this restored checkout. Configuration templates, if
added later, must be labelled separately from actual private bindings.

## Publication revisions

Only packaging and location corrections change the restored source here:

- Npm local dependencies and matching lock targets now use sibling paths.
- Git preserves exact vendored engine bytes, including upstream line endings.
  Only incidental whitespace in two first-party Markdown files was normalized;
  vendor inputs, licenses, binaries and runtime source remain byte-exact.
- Current README and agent guidance point to the local OpenSpec root.
- The prerequisite verification record names its private artifact directory by
  basename, with a publication note; historical hashes and results stay intact.
- Three dated local qualification JSON records replace the personal absolute
  Node executable path with `node`. Each contains a `publicationRevision`
  marker and its original record SHA-256. Historical source hashes,
  measurements, outcomes and limits remain unchanged. These are revised public
  copies, not new runs or hashes of this PR source.

Raw provider records, private accounts, source-retention manifests, credentials,
runtime state and the separate generated provenance archive remain outside
Git. The private recovery note records their locations. No capture, workload,
provider mutation or public launch follows from this source restoration.
