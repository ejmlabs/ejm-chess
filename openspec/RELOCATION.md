# Chess planning relocation

Recorded on 2026-10-26 after the owner corrected the PR destination to
`ejmlabs/ejm-chess`.

## Current authority

This repository owns the recovered chess implementation and the existing
`add-cloudflare-chess` planning root. The approved plan and its baseline
reconciliation moved here together. This is a relocation of the existing
workflow, not initialization of a second competing plan.

The following were carried forward:

- All six delta specs, proposal, design, tasks and evidence-scope records for
  [add-cloudflare-chess](changes/add-cloudflare-chess/).
- The completed
  [baseline reconciliation](changes/reconcile-chess-planning-baseline/).
- The existing `config.yaml` and the exact three main-spec additions in the
  [reviewed prerequisite patch](changes/reconcile-chess-planning-baseline/reviewed-prerequisite-additions.patch):
  `ejmlabs-site`, `documentation-discovery` and `public-web-access`.

The three prerequisites preserve four requirements and nine scenarios needed
by the existing MODIFIED deltas. They are not the broader Studio spec tree.
Their historical verification and source identities remain in the baseline
record.

## Historical records

Older proposal, design, implementation-scope and baseline records describe
Studio as the planning home or say that the product has no OpenSpec root.
Those statements describe the earlier location. This note supersedes their
location and no-root guidance only. It does not rewrite dated evidence or
authorize a different runtime, release scope, budget or qualification policy.

The main plan remains **58/71** checked and baseline reconciliation remains
**4/4**. No checkbox was changed for relocation. The current
[product handoff](HANDOFF.md) and [detailed continuation](changes/add-cloudflare-chess/HANDOFF.md)
describe recovered source and remaining work.

## Cross-repository work

The coordination deltas remain intact so task IDs and approved dependencies
stay traceable. Shared UI and discovery changes still belong in `ejm-ui`;
Studio presentation still belongs in `ejmlabs`. Those owners use their own
workflows. Do not import their runtime source, full planning trees, launch
films or unrelated brand work into this repository.

The former Studio PR remains a historical source record. The replacement PR
is opened from this product repository. Private credentials, provider
configuration, raw qualification traces and source-retention archives are not
part of either public handoff.
