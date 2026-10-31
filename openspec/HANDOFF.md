# Chess source and OpenSpec handoff

Recorded on 2026-10-26. `ejmlabs/ejm-chess` owns this implementation and the
existing chess planning root. Read the [relocation record](RELOCATION.md)
before using older references to Studio as the planning home.

## Start here

1. Read [product rules](../AGENTS.md), [source recovery and publication scope](../docs/source-handoff.md)
   and the [detailed chess continuation](changes/add-cloudflare-chess/HANDOFF.md).
2. From the product root, run `openspec list --json`, then
   `openspec status --change add-cloudflare-chess --json` and
   `openspec instructions apply --change add-cloudflare-chess --json`.
3. Read the selected change's proposal, design, specs and tasks. Use the
   existing workflow for implementation. Keep unfinished tasks unchecked.

## Planning state

| Change and tasks | Checked | Next work |
| --- | ---: | --- |
| [add-cloudflare-chess](changes/add-cloudflare-chess/tasks.md) | see tasks.md | Launch policy 2026-10-31 (see [proposal](changes/add-cloudflare-chess/proposal.md)): no arbitrary caps, no first-tier run gate, ranked uses the material rule only. Tooling decision 2026-10-31: the capacity harness and server-side Stockfish analysis are deleted, and the restore drill is follow-up only. **3.8/4.5/6.2/6.3/7.3a** checked for source/docs prep; 3.8 is superseded. Critical path: **3.9** retire the proof path, paused **3.6/7.1** player checks including ranked and arenas, live **6.2/6.3** readbacks, then **7.2** open (Access removal, public verification), then **7.3** discovery. Superseded, not gates: **6.4/10.4/18.x**. |
| [archive/2026-10-30-reconcile-chess-planning-baseline](changes/archive/2026-10-30-reconcile-chess-planning-baseline/tasks.md) | 4/4 | Archived; addition-only prerequisite evidence only. Does not prove runtime correctness or release readiness. |
| [archive/2026-10-30-fix-explicit-casual-join](changes/archive/2026-10-30-fix-explicit-casual-join/tasks.md) | 6/6 | Archived after canary Join retest; main spec at [specs/chess-play](specs/chess-play/spec.md). |

Counts describe task checkboxes, not public availability. Current task files
and fresh CLI output are authoritative. Source placement changed no task state,
launch policy, budget or qualification requirement. The 2026-10-31 owner launch
policy did, later; it governs where older text conflicts.

The product root carries all six approved chess deltas. The three small main
specs under [specs/](specs/) are the reviewed prerequisites from
[the baseline patch](changes/archive/2026-10-30-reconcile-chess-planning-baseline/reviewed-prerequisite-additions.patch),
not a copy of the full Studio specification tree. Read
[baseline verification](changes/archive/2026-10-30-reconcile-chess-planning-baseline/verification.md)
for its addition-only scope and evidence limits.

## Source state

The retained 322-file chess source has been restored into this repository.
It includes rules, accounts, ratings, tournaments, replays, browser Stockfish,
product guides, migrations, tests and tooling. The unfinished
capacity diagnostic patch it carried was deleted on 2026-10-31. Source restoration does not establish a current
build, deployment or qualification result.

| Retained archive | Files | SHA-256 |
| --- | ---: | --- |
| `ejm-chess-source.tar.gz` | 322 | `808a000963a2d7eb50015ab2a6950ee5dd5cf111bb66b8fdbe2fe46d37295036` |
| `ejm-chess-source-provenance.tar.gz` | 64 | `58d91a5fe6ee82ef745e8d7251584f2b58e72f23bd3817e11d4f3f9e0bbb604b` |
| `ejm-ui-source.tar.gz` | 1,085 | `544d5bd1fad6261600190c4b19a777a73b34906cbf9a4abc556a34fc178fa90c` |

The archive hashes, each product member hash, byte length and mode matched
their retained inventories. Private archives, manifests and raw evidence stay
outside public Git. Shared UI source remains in its owner and must be supplied
through public package contracts.

The archive omitted six private Wrangler configurations: `wrangler.jsonc`,
`wrangler.capacity.jsonc`, `wrangler.proof-acceptance.jsonc`,
`wrangler.proof-qualification.jsonc`, `wrangler.proof-service.jsonc` and
`wrangler.recovery-drill.jsonc`. Worker tests and dry-run packaging require
reviewed configuration. Do not infer that these commands work from source
restoration alone. See the source guide for current dependency bindings,
configuration gaps and publication revisions.

## Last-known execution state

The detailed handoff retains the final records from 2026-10-23. No new live
provider readback was made for this relocation.

- The timeout-proof path was retired on 2026-10-31, so the proof records in this
  list are history, not open work.
- Proof Q22 failed qualification. G13 remained incomplete. Its stop was
  confirmed, including no active or assigned instances at the recorded readback.
- Tournament capacity full22 failed during registration. No Game objects were
  created. The saved owner stop and local driver exit were confirmed; native
  shutdown was not confirmed.
- The diagnostic patch was partial and unreviewed. It was deleted on 2026-10-31
  with the capacity harness.
- Every old execution window has expired. Preserve all failed attempts,
  reservations and stop receipts. Do not restart old jobs or schedules.

The completed two-player invitation, readiness, moves, resignation, reload,
history, replay and PGN checks remain historical evidence. Repeat checks only
where a changed contract or concrete remaining risk calls for it.

## Owners and next steps

| Owner | Responsibility |
| --- | --- |
| `ejm-chess` | Rules, accounts, game state, clocks, ratings, tournaments, replays, guides, deployment and this plan. |
| `ejm-ui` | Public components, tokens, board and clock surfaces, shared site infrastructure and discovery contracts. |
| `ejmlabs` | Studio pages and public project discovery after the product and guide destinations pass. |

1. Review the restored source and its publication revisions. Bind matching
   public UI source and reconstruct reviewed local configuration without
   publishing secrets or private provider values.
2. Refresh apply instructions. The capacity harness and server-side analysis
   are deleted; the restore drill is follow-up only. Preserve old results as
   dated evidence.
3. Retire the timeout-proof path (task 3.9): ranked uses the material rule at
   the flag, with no proof admission, slots or code.
4. Finish the protected-host player checks (3.6, 7.1), now including ranked and
   arena play, and the live mail, alert, cron and stop readbacks (6.2, 6.3).
5. Remove Access and verify the public host and guides (7.2), then publish
   discovery and Studio through their owners (7.3). Measure real demand after
   opening.
6. Update tasks only from verified results. Sync and archive verified complete
   scope through the matching workflows; keep the superseded 6.4, 10.4 and
   18.x explicit.

This handoff replaces the chess continuation portion of
[the misplaced Studio PR](https://github.com/ejmlabs/ejmlabs/pull/26).
Studio redesign, launch films and unrelated brand work are not part of the
chess source delivery. No launch, provider mutation, workload or live-site
publication was performed for this relocation.
