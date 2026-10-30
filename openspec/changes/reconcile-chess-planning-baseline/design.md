# Design

## Context

See `proposal.md` for the scope. Live GitHub main was read on 2026-10-20 at
`c92a4a0df2944e6ac6c22498ad4d132f0518d569`. Its complete tree has only
`.gitkeep` under `openspec/specs/` and no archived copies of the three targets.
Its studio is the older `site/src/index.html`, with a simulated CLI demo and
no six product guide links. It cannot serve as evidence for the local
migration's presentation requirements.

The accepted local migration introduced its main specs in `3917ca0`. The
2026-10-20 publication record names studio source `caa4ec7` and shared UI
`69cbd4f`, with route and asset verification. That dated record supports the
published migration contract. It does not mean those commits were pushed to
GitHub or that every recorded provider setting is still current.

## Goals / Non-Goals

**Goals:**

- Make the four chess modification targets reviewable on the accepted remote
  base, while preserving the richer local specifications and concurrent work.
- Preserve the difference between accepted local source, dated publication,
  current GitHub source, and pending chess release checks.

**Non-Goals:**

- Adopting the whole studio/UI migration on remote main.
- Changing game behavior, shared APIs, public discovery, or provider settings.
- Treating remote source drift as a fabricated blocker for independent chess
  runtime verification.

## Decisions

### 1. Preserve only the prerequisite blocks on the old remote base

The reviewed baseline addition has three small main-spec files and these four
requirements:

| Capability | Requirement |
| --- | --- |
| `ejmlabs-site` | `Home page` |
| `documentation-discovery` | `Direct guide links` |
| `public-web-access` | `Worldwide public access` |
| `public-web-access` | `Public production entry points retain edge protection` |

Take complete requirement and scenario blocks from the current local main
specifications. Record their hashes, source commit, publication evidence, and
the missing remote paths. The remote addition records the published contract;
it does not claim the older checked-in HTML implements that contract.

Do not replace the local main-spec files with these small snapshots. They
already contain the four blocks and unrelated requirements that must remain.
Keep any later remote source adoption in its own reviewed work.

Alternative: copy all local main specs or migration code to fill the gap.
Rejected because chess needs only four modification targets, and the rest has
separate ownership and review history.

### 2. Refresh by comparing whole requirement blocks

Rebuild the four chess MODIFIED blocks against the reviewed baseline, retaining
all prior scenarios plus the chess additions. Preserve current product links,
canonical-domain protection, preview separation, and machine-client behavior.
Record an unchanged block as checked; do not force a wording change just to
produce a diff. Update only the chess proposal/design baseline account where
it still treats missing GitHub specs as unexplained local migration state.

`ejmlabs` owns these planning artifacts. No `ejm-ui`, harness, or product
runtime contract changes. Shared discovery still depends on the release
owner's verification of the real chess and guide destinations.

### 3. Use the existing OpenSpec tooling and review boundary

This change repairs baseline records without adding behavior, so
`skip_specs: true` is intentional. Do not create duplicate delta capabilities.
Prepare a relative addition patch and hashes for the three absent remote
targets, plus a narrow plan refresh patch. Validate both the existing chess
change and this repair. After root reviews the exact delta, prove actual
OpenSpec mergeability in a disposable root before any main integration.

No new dependency or custom spec engine is needed. Use the installed OpenSpec
CLI for parsing, validation, and the disposable merge. Keep any temporary
merge output outside the source checkout. The repair adds zero shipped bytes
and starts no runtime work.

## Risks / Trade-offs

- Source and publication histories differ: retain both exact identities and
  label dated evidence rather than claiming remote adoption.
- Small baseline files could replace richer local specs: make them an
  addition-only patch for the absent remote paths and verify local hashes
  remain unchanged.
- An incomplete replacement could drop a scenario: compare whole blocks and
  check every original scenario after the disposable merge.
- Format validation can pass while merge fails: retain the separate actual
  mergeability result after review.
- Other local requirements may be stale: report them separately and preserve
  their bytes in this bounded repair.

## Migration Plan

1. Capture source identities and the exact four baseline blocks. Prepare the
   three-file addition and narrow chess planning refresh as review artifacts.
2. Have root review those artifacts. Enter apply only after that review.
3. Use the installed CLI in a disposable root to merge the chess deltas into
   the small baselines. Validate the resulting main specs and preserve all
   baseline scenarios. Do not sync or archive the live changes during this
   proof without root approval.
4. Let root choose the reviewed remote integration and close the tracking
   prerequisite. Runtime launch and discovery checks remain separate.

Rollback removes only this repair's added records or restores the exact
planning blocks from their before snapshots. It changes no deployed state.
