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
| [add-cloudflare-chess](changes/add-cloudflare-chess/tasks.md) | 58/71 | Review the partial capacity diagnostic patch, qualify ranked proofs and recovery, complete the approved tournament workload and remaining player checks, then release and publish discovery. |
| [reconcile-chess-planning-baseline](changes/reconcile-chess-planning-baseline/tasks.md) | 4/4 | Review the recorded prerequisite and merge evidence before sync and archive. This does not prove runtime correctness or release readiness. |

Counts describe task checkboxes, not public availability. Current task files
and fresh CLI output are authoritative. No task state, launch policy, budget
or qualification requirement changed during source placement.

The product root carries all six approved chess deltas. The three small main
specs under [specs/](specs/) are the reviewed prerequisites from
[the baseline patch](changes/reconcile-chess-planning-baseline/reviewed-prerequisite-additions.patch),
not a copy of the full Studio specification tree. Read
[baseline verification](changes/reconcile-chess-planning-baseline/verification.md)
for its addition-only scope and evidence limits.

## Source state

The retained 322-file chess source has been restored into this repository.
It includes rules, accounts, ratings, tournaments, replays, browser Stockfish,
product guides, migrations, tests and tooling. It also includes the unfinished
capacity diagnostic patch. Source restoration does not establish a current
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

- Proof Q22 failed qualification. G13 remained incomplete. Its stop was
  confirmed, including no active or assigned instances at the recorded readback.
- Tournament capacity full22 failed during registration. No Game objects were
  created. The saved owner stop and local driver exit were confirmed; native
  shutdown was not confirmed.
- The diagnostic patch is partial, unreviewed, untested and undeployed.
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
2. Refresh apply instructions. Finish the affected diagnostic checks and
   typecheck before sealing another candidate. Preserve old results as dated
   evidence.
3. Diagnose retained proof and registration failures. Reconcile current
   provider state and prior uncertainty before planning a fresh, finite run.
4. Complete the approved ranked proof/recovery and tournament critical-path
   gates. Finish only the remaining player and release checks.
5. Publish verified product guides and accepted source, verify the canonical
   host, then update shared discovery and Studio through their owners.
6. Update tasks only from verified results. Sync and archive verified complete
   scope through the matching workflows; keep longer follow-up work explicit.

This handoff replaces the chess continuation portion of
[the misplaced Studio PR](https://github.com/ejmlabs/ejmlabs/pull/26).
Studio redesign, launch films and unrelated brand work are not part of the
chess source delivery. No launch, provider mutation, workload or live-site
publication was performed for this relocation.
