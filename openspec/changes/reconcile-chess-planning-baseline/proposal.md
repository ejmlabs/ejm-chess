# Proposal

## Why

The chess plan modifies four requirements in three capabilities that exist in
the accepted local studio migration but are absent from GitHub main. Record a
small reviewed baseline and prove that the chess deltas preserve it, without
pulling unrelated migration source into the chess launch.

## What Changes

- Preserve the live GitHub main identity and its missing-spec evidence separately
  from the accepted local migration and its dated publication record.
- Prepare the minimum baseline for `ejmlabs-site`, `documentation-discovery`,
  and `public-web-access`: only the four requirement blocks used by chess.
- Preserve every other requirement and dirty file in the local main checkout.
- Refresh the chess plan's baseline account and check each modified block
  against the reviewed baseline before any spec sync or archive.
- Produce relative patches, source hashes, validation, and a disposable
  mergeability proof for review. No product code or public discovery changes.

## Capabilities

### New Capabilities

None. This is a planning-baseline repair, with no new runtime behavior.

### Modified Capabilities

None. The four existing requirements retain their behavior. This change uses
`skip_specs: true` so its closeout cannot apply duplicate delta requirements to
the local capabilities. Its reviewed baseline snapshots are implementation
evidence, not a second specification authority.

## Impact

`ejmlabs` owns the baseline specifications, plan, discovery content, and review
evidence. `ejm-ui` continues to own shared registry and site contracts; chess
continues to own its game and guides. No public package interface, dependency,
bundle, service, security control, or user flow changes here.

GitHub main `c92a4a0df2944e6ac6c22498ad4d132f0518d569` has only
`openspec/specs/.gitkeep` and an older one-page studio. Local main `ef549ad`
contains the migration specs introduced in `3917ca0`. The dated publication
record identifies studio source `caa4ec7` and shared UI `69cbd4f`. These are
separate source and publication facts. Their difference is not evidence of a
chess runtime defect or permission to publish unrelated source.

Public docs need no product update for this repair: it changes planning and
source provenance only. Studio discovery remains gated on verified chess
destinations through the separate chess release work. Root reviews the exact
delta before main-spec integration, sync, or archive.
