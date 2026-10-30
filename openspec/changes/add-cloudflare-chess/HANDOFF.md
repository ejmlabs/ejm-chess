# Chess continuation handoff

Source placement updated on 2026-10-26. This change has **58 of 71 tasks checked**.
The current [task file](tasks.md) is authoritative. This handoff preserves
source and execution facts; it changes no launch scope, limits or approval.

## Read before resuming

- [Proposal](proposal.md), [design](design.md), [launch scope](launch-scope.md)
  and the six [delta specs](specs/) describe the approved work.
- [Implementation scope](implementation-scope.md) contains dated evidence and
  earlier boundaries. Read it with later approved decisions; do not treat an
  old local-only limit or financial allocation as current policy.
- [Baseline verification](../reconcile-chess-planning-baseline/verification.md)
  records addition-only prerequisite and spec-merge checks. It proves neither
  runtime correctness nor release readiness.
- The [repository handoff](../../HANDOFF.md) covers owner and publication
  dependencies.
- The [relocation record](../../RELOCATION.md) makes this product root
  authoritative where dated records name the earlier Studio planning home.

## Current source state

The former temporary product checkout and temporary PR checkout are absent.
The retained 322-file product source has now been restored into `ejm-chess`
for the corrected product PR. The retained product had no committed HEAD;
the new source delivery establishes its repository history.

This product PR contains the recovered runtime, guides, migrations, tests,
tooling and the existing chess plan. Private deployment configuration and raw
qualification evidence remain outside Git. Shared visual behavior and assets
belong in `ejm-ui`; chess rules, DTOs, state and deployment belong here.
Consume public `@ejm/*` exports. Read [source handoff](../../../docs/source-handoff.md)
for dependency bindings, configuration gaps and publication revisions.

No current build or launch qualification is established by restoration. The
unfinished diagnostic patch below remains part of the recovered source.

## Latest retained execution results

The final records below are from 2026-10-23. No live provider readback was made
while preparing this handoff, so they are last-known state.

| Area | Retained result | What remains unproved |
| --- | --- | --- |
| Friend game | Two players completed e4, d6, resignation, reload, history, replay and PGN before the final deployment. | Later source and deployed revisions need checks only where their contracts changed. |
| Earlier proof Q21 | Transient-start and interrupted results produced one technical void at the original deadline, no rating event and a released slot. Physical stop was confirmed. | The intended killed-solver case did not pass. |
| Proof Q22 | Qualification failed. G13 was incomplete, with two deliveries and no credit. Competition capture returned `proof_acceptance_work_exhausted`; its cause was not established. | Real killed-solver receipt, required recovery and final proof qualification. |
| Q22 cleanup | Logical stop passed. Physical readback showed cap zero and no active or assigned instances. Wrapper and cutoff processes exited. | This stop receipt does not establish qualification. |
| Capacity full22 | Failed at final registration confirmations with five HTTP 503 responses. It recorded 10,829 acknowledged registration replies, 1,225 distinct confirmed accounts, zero charged Game IDs and zero native Game objects. | No passing full workload, first-tier capacity or large-event release claim. |
| Capacity cleanup | Saved owner stop was confirmed, temporary test exception was removed and the local driver exited. Resources and traces were retained. | Native shutdown was not confirmed. Do not claim full native retirement. |

The earlier release evidence map was written before these final outcomes.
Use the stopped-run summaries when continuing. Root acceptance of a packet,
source sealing, local readiness and a buffered trace header are not passing
execution results.

**Every historical qualification window has expired.** Do not restart an old
job, reuse a prior run identity as a new attempt, reopen a stopped control,
refund uncertainty, reuse an old PID or execute an expired schedule. Preserve
all prior failures, permits, reservations, traces and charges.

### Partial capacity diagnostic patch

The retained product source includes an unfinished failure-receipt patch in:

- `src/shared/capacity-failure.ts`
- `src/server/capacity-meter.ts`
- `src/server/capacity-native.ts`
- `src/server/capacity-protocol.ts`
- `src/server/capacity-qualification.ts`
- `scripts/capacity-driver.mjs`
- `test/capacity-failure.test.ts`
- `test/capacity-native.test.ts`

It adds a fixed code allowlist, bounded sanitized RPC failure receipts and
driver retention of matching audit headers. Real HTTP 503 responses remain
failures or uncertainty. Lost transport can still leave the cause unknown.
No audit storage or provider logging was added.

The patch is **partial, unreviewed, untested and undeployed**. Focused tests and
typecheck from earlier source do not verify it. Remaining work includes native
throw-before-finish retention, driver receipt persistence and rejection checks,
affected typecheck, guide updates and source review before sealing a candidate.

## Unchecked tasks

These labels are unchanged from [tasks.md](tasks.md):

| Labels | Remaining contract |
| --- | --- |
| 3.6 | Complete required two-browser board interaction and accessibility coverage. The completed friend flow above is partial evidence. |
| 3.8 | Qualify the timeout-proof contract, ordinary flags, failures, finite attempts, recovery and stops. |
| 4.5 | Finish policy guidance and verify game, history and leaderboard flows together. |
| 6.2 | Complete provider, mail and deployed cost evidence. Reuse verified delivery and reset evidence while those contracts remain unchanged. |
| 6.3 | Finish spending, storage, recovery, privacy and accepted-work controls and their readback. |
| 6.4 | Complete the required measurements. Broader regional work remains unfinished beyond the initial opening gate. |
| 7.1 | Finish critical-path protected-host player and integration checks against recorded deployed source. |
| 7.2 | Open public ranked and first-tier arenas only after their approved critical-path gates pass; verify live limits and guides. |
| 7.3 | Publish verified shared discovery and Studio adoption after product and guide destinations pass. |
| 10.4 | Finish and qualify the large-event design, standings, recovery and published limits. |
| 18.3 | Resolve registration diagnostics while retaining prior failures and accounting. No passing registration-only diagnostic is recorded. |
| 18.4 | Run the full approved native workload against a freshly reviewed repaired candidate. |
| 18.5 | Reconcile all retained failures, usage, receipts, stops and documented measured limits. |

The critical-path capacity target remains three 2,000-entry events, a combined
1,000 unfinished-game cap, 19,000 required and 20,000 maximum native admissions,
the full 900-second stream and the approved ten-second recovery lead. These are
test requirements, not supported capacity. The shorter run does not complete
the longer calendar, full-hour endurance, regional or later-tier qualification.

The current plan retains the single $100 monthly target and existing spending
stops, including the combined $25 capacity-test ceiling. A target, quota or
alert cannot guarantee a provider invoice cap. This handoff adds no allowance
and changes no limit.

## Retained source

The private recovery note accompanying PR preparation names archive storage and
private manifests. They remain outside this public repository. The retention
audit verified every archive hash, member hash, mode and inventory
against those manifests with no mismatches.

| Archive | Files | SHA-256 |
| --- | ---: | --- |
| `ejm-chess-source.tar.gz` | 322 | `808a000963a2d7eb50015ab2a6950ee5dd5cf111bb66b8fdbe2fe46d37295036` |
| `ejm-chess-source-provenance.tar.gz` | 64 | `58d91a5fe6ee82ef745e8d7251584f2b58e72f23bd3817e11d4f3f9e0bbb604b` |
| `ejm-ui-source.tar.gz` | 1,085 | `544d5bd1fad6261600190c4b19a777a73b34906cbf9a4abc556a34fc178fa90c` |

Retention is not a complete repository freeze or a build result. It excludes
credentials, private configuration, dependencies, generated app and Worker
bundles, caches and runtime state. All six Wrangler configurations are omitted.
The retained archive used machine-specific absolute `file:` references to
public UI packages. The publication copy binds those dependencies through
relative sibling package paths. Supply matching public owner source and
reconstruct reviewed configuration before checking the product. See
[source handoff](../../../docs/source-handoff.md) for the exact revisions.
Do not copy private provider configuration or secrets into the public tree.

The archives retain engine and proof inputs and notices. Their preservation
does not claim a new integrity audit, license review, build or execution
qualification. The provenance archive and private records must be reviewed
before any wider publication.

## Progress since this handoff (2026-10-30)

Completed outside the original resume list, with the protected canary still
closed to the public:

- Deployed Worker version `6aa3ef0c-7286-4fab-9cc7-d3790792c882` on
  `chess.ejmlabs.com` (Access retained), including explicit Join and the
  material timeout rule from `main`. Application monthly caps stay off;
  Cloudflare alerts and the `$85` stop remain the economic control.
- Merged OpenSpec policy reconcile (PR #6) and explicit casual Join (PR #7);
  archived `fix-explicit-casual-join` and synced `openspec/specs/chess-play`.
  Archived `reconcile-chess-planning-baseline` (no delta specs).
- Owner accepted and merged the material timeout rule (PR #3). Doc and UI gaps
  for the old automatic void were closed; `AGENTS.md` matches the rule. The
  private proof-acceptance re-run against the new expectations remains
  unexecuted and still gates ranked proof enablement.
- Protected canary player checklist steps 1–7 plus the explicit Join retest are
  done. **Steps 8+ are paused** by owner request; they are not abandoned.

### Configuration and shared UI notes

- Matching `ejm-ui` source for chess contracts remains local branch
  `wip/preserve-all-20261025` in the sibling `ejm-ui` checkout. Publish discovery
  and Studio listing only after public opening is approved; do not merge that
  branch to `ejm-ui` main solely for the protected canary.
- Local production `wrangler.jsonc` (gitignored) is reconstructed with
  `env.local` for Worker tests and canary deploy. The five specialty configs
  (`wrangler.capacity.jsonc`, `wrangler.proof-acceptance.jsonc`,
  `wrangler.proof-qualification.jsonc`, `wrangler.proof-service.jsonc`,
  `wrangler.recovery-drill.jsonc`) are still absent from this checkout and must
  be rebuilt from private records before proof, capacity or recovery drills.
  Do not commit secrets or provider IDs.

## Resume in this order

1. When unpausing the canary checklist, finish protected-host player checks from
   step 8 onward and record results in `docs/verification.md`.
2. Refresh OpenSpec apply status for `add-cloudflare-chess`. Review the partial
   capacity patch and finish only the affected failure, native and driver checks
   plus typecheck. Retain old results as historical evidence.
3. Diagnose the retained proof and registration failures. Reconcile prior work
   and current provider state before preparing any fresh execution packet.
   Preserve all held uncertainty and stop receipts. Re-run private
   proof-acceptance only after specialty Wrangler configs are reconstructed.
4. Prepare a new feasible schedule and immutable candidate within the existing
   approved scope. Follow the review and finite-work requirements in the plan.
   Never resume an expired packet or infer success from readiness.
5. Finish ranked proof and recovery, then the full capacity workload and its
   accounting and stop readback. Derive enabled limits from actual results.
6. Update product guides with measured limits and unrun checks. Build and deploy
   accepted source, verify canonical public access, then publish discovery in
   `ejm-ui` and Studio through their owner processes.
7. Update task checkboxes only from verified results. Sync and archive completed
   scope after required checks pass; retain longer follow-up work explicitly.

No public launch, provider mutation beyond the approved protected canary, or
live discovery publication was performed while updating this handoff.
