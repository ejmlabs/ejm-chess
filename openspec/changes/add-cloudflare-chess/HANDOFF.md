# Chess continuation handoff

Source placement updated on 2026-10-26. Task counts move; the current
[task file](tasks.md) is authoritative. This handoff preserves source and
execution facts. Updated on 2026-10-31 for the owner's launch policy (see
[proposal](proposal.md)): no arbitrary product caps, no first-tier load-test
gate, and ranked uses the material timeout rule only. Later the same day the
tooling decision deleted the capacity harness and server-side Stockfish analysis
and made the restore drill follow-up only. Sections that predate these are dated
history.

## Read before resuming

- [Proposal](proposal.md), [design](design.md), [launch scope](launch-scope.md)
  and the six [delta specs](specs/) describe the approved work.
- [Implementation scope](implementation-scope.md) contains dated evidence and
  earlier boundaries. Read it with later approved decisions; do not treat an
  old local-only limit or financial allocation as current policy.
- [Baseline verification](../archive/2026-10-30-reconcile-chess-planning-baseline/verification.md)
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
capacity diagnostic patch it carried was deleted on 2026-10-31.

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

The proof rows above are history: the timeout-proof path was retired on
2026-10-31, and the capacity harness behind the capacity rows was deleted the
same day. They are dated history, not launch gates.
The earlier release evidence map was written before these final outcomes.
Use the stopped-run summaries when continuing. Root acceptance of a packet,
source sealing, local readiness and a buffered trace header are not passing
execution results.

**Every historical qualification window has expired.** Do not restart an old
job, reuse a prior run identity as a new attempt, reopen a stopped control,
refund uncertainty, reuse an old PID or execute an expired schedule. Preserve
all prior failures, permits, reservations, traces and charges.

### Capacity diagnostic patch (deleted)

The unfinished failure-receipt patch and every `capacity-*` source, script, test
and config example were deleted on 2026-10-31 with the harness. The failed
attempts stay recorded in [design](design.md) ("Superseded: isolated native
capacity run").

## Unchecked tasks

These are the open tasks in [tasks.md](tasks.md). Task 3.9 (proof path retired) is checked; 7.2 still needs the live 6.2 and 6.3 readbacks:

| Labels | Remaining contract |
| --- | --- |
| 3.6 | Complete required two-browser board interaction and accessibility coverage. The completed friend flow above is partial evidence. |
| 6.4 | Superseded 2026-10-31: no load run is planned. Measure real demand after opening. |
| 7.1 | Finish protected-host player and integration checks, now including ranked and arena play, against recorded deployed source. |
| 7.2 | Open ranked play and arenas after 3.9, the 3.6 and 7.1 player checks and the live 6.2 and 6.3 mail, alert, cron and stop readbacks. Then remove Access and verify the public host and guides. |
| 7.3 | Publish verified shared discovery and Studio adoption after product and guide destinations pass. |
| 10.4 | Superseded 2026-10-31: no large-event qualification run is planned. |
| 18.3 | Superseded 2026-10-31: the harness is deleted. The six failed attempts stay recorded as history. |
| 18.4 | Superseded 2026-10-31: the full native workload is no longer planned. |
| 18.5 | Superseded 2026-10-31: nothing to reconcile. Any isolated capacity resources left in the provider account need an owner readback and decision. |

The former capacity targets (three 2,000-entry events, 1,000 unfinished games,
19,000 required native admissions, a 900-second stream) are reference targets
only in `docs/arena-design.md`, not supported capacity and not planned work. If
demand ever needs checking, write a small staging load script then.

The current plan retains the single $100 monthly target and existing spending
stops. A target, quota or alert cannot guarantee a provider invoice cap. This
handoff adds no allowance and changes no limit.

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
  private proof-acceptance re-run is no longer needed: the proof path was
  retired on 2026-10-31 (task 3.9).
- Protected canary player checklist steps 1–7 plus the explicit Join retest are
  done. **Steps 8+ are paused** by owner request; they are not abandoned.
- Ranked-inclusive source/docs prep checked in tasks: **3.8**, **4.5**, **6.2**,
  **6.3**, **7.3a**. Specialty Wrangler examples, timeout-proof status JSON,
  color-balance guidance, and provisioning checklist are in tree. Still open:
  paused **3.6**/**7.1**, ranked open **7.2** (**3.9** proof path retired and checked),
  discovery publish **7.3**. Superseded **6.4**/**10.4**/**18.x** (2026-10-31).

### Configuration and shared UI notes

- Matching `ejm-ui` source for chess contracts is `main` at `5a88e6a` (PRs #55
  and #58, 2026-10-31). Publish discovery and Studio listing only after public
  opening is approved.
- Local production `wrangler.jsonc` (gitignored) is reconstructed with
  `env.local` for Worker tests and canary deploy. Only
  `wrangler.recovery-drill.jsonc` is still needed and absent from this checkout;
  rebuild it from private records before a recovery drill. The capacity and proof
  configs are deleted or retired and need no rebuild.
  Do not commit secrets or provider IDs.

## Resume in this order

1. Finish the protected-host player checks from step 8 onward (3.6, 7.1), now
   including ranked and arena play, and record results in
   `docs/verification.md`.
2. Read back live mail, budget alerts, cron and the stop webhook (6.2, 6.3).
3. Remove Access, verify the public host and guides (7.2), then publish
   discovery in `ejm-ui` and Studio through their owner processes (7.3). Measure
   real demand after opening.
4. Follow-up only, not gates: the restore-and-replay provider drill (its code
   stays) and any small staging load script if demand needs checking. The
   capacity harness and server-side analysis were deleted on 2026-10-31; retain
   old results as history and never infer success from readiness.
5. Update task checkboxes only from verified results. Sync and archive completed
   scope after required checks pass; retain follow-up work explicitly.

No public launch, provider mutation beyond the approved protected canary, or
live discovery publication was performed while updating this handoff.
