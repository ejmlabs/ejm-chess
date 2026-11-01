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
included a partial capacity failure-receipt patch, since deleted with the
capacity harness (2026-10-31). This PR preserves the retained state; it is not
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

The shared source is the public `ejmlabs/ejm-ui` revision recorded in
[`.github/ui-source.json`](../.github/ui-source.json), the pin file the other
consumers use, and the single home of the revision. It is an ejm-ui `main`
commit that includes the systemic kit
([ejm-ui PR #59](https://github.com/ejmlabs/ejm-ui/pull/59)), the public
`@ejm/ui/components/Chessboard` leaf and `useSearch` from `@ejm/ssg`. A pin selects
source. It does not publish a package or prove compatibility; the install,
typecheck and build below do. No shared implementation is vendored into this
product.

Check out the pinned revision beside this checkout, install its lockfile, then
install chess:

```sh
git -C ../ejm-ui checkout <revision from .github/ui-source.json>
npm --prefix ../ejm-ui ci --ignore-scripts
npm ci --ignore-scripts
```

The linked packages resolve their own dependencies from the `ejm-ui` install, so
the chess build fails until that install exists. `@ejm/ui` carries Tailwind, the
React plugin and the single React copy through `ejmlabs()` in `vite.config.ts`,
so this product lists none of `@tailwindcss/vite`, `@vitejs/plugin-react` or
`tailwindcss`. Its `tsconfig.json` extends `@ejm/ui/tsconfig.json`. The lockfile
keeps the registry versions and integrity fields of every remaining package.

## Configuration gap

Two private provider configurations were intentionally excluded and are ignored
by Git:

- `wrangler.jsonc`
- `wrangler.recovery-drill.jsonc`

Reconstruct them from reviewed current provider state and the retained private
records. The three `wrangler.proof-*.jsonc` configs of the retired timeout-proof
path (2026-10-31) and `wrangler.capacity.jsonc` of the deleted capacity
harness are no longer needed. Preserve distinct production, local and recovery
boundaries. Do not paste provider identifiers, private destinations, credentials
or old execution windows into public source. Keep secrets in local variables
or the provider secret store.

Status on 2026-10-30: a reviewed local `wrangler.jsonc` (gitignored) exists with
production bindings plus `env.local` for Worker tests and the protected canary
deploy. The specialty config remains absent as a private copy in this
checkout. Non-secret templates live under [`config-examples/`](../config-examples/README.md);
copy an example to the matching gitignored filename, then fill IDs from private
records before recovery-drill commands. Shared UI source is the pinned `ejm-ui`
revision above; keep discovery publication behind an approved public opening.
See [live-ready prep](live-ready-prep.md).

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
