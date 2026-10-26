# Isolated Cloudflare recovery rehearsal, 2026-10-21 UTC

## Status and scope

Native D1 Time Travel and both SQLite Durable Object restores passed for the
original completed and still-active synthetic casual games. An extended v3
matrix also passed a held terminal acknowledgement, ranked correction replay,
a naturally aged tombstone, positive budget-receipt recovery and a complete
native undo rehearsal. All used the separate `ejm-chess-recovery-drill` Worker,
isolated D1 database and `RecoveryDrillGame` / `RecoveryDrillCompetition`
namespaces. No production database, player account, game or object was restored.

This is provider evidence for the recorded boundaries. Task 6.3 remains open.
Production exposes read-only recovery capture, with owner-account and Access
checks; it exposes no native restore or restart endpoint. Follow the
[recovery workflow](../recovery-drill.md) for target checks and private records.

| Original casual-game source record | Value |
| --- | --- |
| Approved source snapshot SHA256 | `fb2877c79a25633727f9add7f301713ea8c74542608cb87ac8997bc4cfddc16a` |
| Isolated Worker version | `d0cbaa10-8dc0-4e36-ad9a-e494fe7f03f1` |
| Source digest definition | SHA256 of compact, sorted path-to-file-SHA256 JSON for 45 runtime, shared, package, migration and drill files |
| Game rules policy | `online-2026-10-v2-unattended` |
| Rating policy | `glicko2-online-2026-10-v1` |

The source was frozen in the release-candidate snapshot before these restores.
This report changes evidence status only. It does not change source, provider
bindings, feature gates, admission allowances or captured data.

## Procedure and observed safeguards

Each boundary paired a real native D1 bookmark and private SQL export with
Game and Competition bookmarks, authority hashes, alarms and bounded metadata.
Only harmless test markers were deliberately changed. The reviewed manifest
digest was approved for the exact isolated scope and source.

For each fixture, native D1 restore completed first. Both DO prepare operations
then succeeded and returned native undo receipts, which were saved privately
before either restart. Both restart requests returned HTTP 503 as the native
abort ended the object session. The later probe and resume checks, rather than
the restart response alone, established the result: all three markers were
`original`, both DO hashes and alarms matched the reviewed manifest, and
`resume` succeeded.

An earlier attempt outlived its five-minute active-game boundary. Both Game and
Competition refused it with HTTP 409 `RECOVERY_LATER_WORK`. The failed manifest
was retained. The subsequent fixtures used fresh reviewed captures. No game
clock or accepted work was changed to make the earlier restore pass.

## Completed-game result

The terminal capture contained a finished casual game at version 5, with one
accepted `e4` move, no Game alarm and no pending result delivery. Competition
had no pending queue, outbox, result or account slot. The recorded outcome was
an automatic unrated technical void under the online adjudication policy.

After D1 and both DO restores:

- Resume returned the same finished version and accepted result boundary.
- Retrying the original accepted move returned its original version 3 receipt
  and accepted-at time. The game still contained one move.
- Two further delivery flushes left the Competition result watermark at 2,
  with no rating events or pending results. They added no duplicate result.
- Private before/after exports matched exactly for all eight compared D1
  tables: `user`, `account`, `session`, `active_game_seats`, `games`,
  `budget_receipts`, `budget_months` and `operations_control`.

The table comparison covers these fixture rows. Empty budget or other tables
do not prove recovery of positive usage receipts or unseeded event state.

## Active-game result

The active capture contained a casual game at version 3 with one accepted `e4`
move. Its stored alarm and running clock deadline both remained
`1792545135415`, or 2026-10-21 01:12:15.415 UTC. Competition had no pending
queue, outbox, result or account slot.

After native D1 and both DO restores, resume returned an active version 3 game.
Retrying the same accepted move returned the original receipt and accepted-at
time, the same one-move position and the exact original running deadline.
The restore did not extend or rebase the clock. Natural expiry of this restored
deadline also passed: the game finished at version 5 with ended-at time
`1792545165415`, exactly 30 seconds after the original deadline. It retained the
same one-move history. The unresolved timeout became an unrated technical void
under the recorded v2 policy, with no winner or score. Competition's global
result watermark was then 4, with zero rating events and zero pending results.
This records the original timeout and adjudication grace path after restore;
it does not verify a later adjudication policy.

## Extended v3 recovery matrix

The later matrix used approved source snapshot
`1018e54651e1e3492e21a122329a43e07f93ef7ff0cb9dcc07428951ffabf20b`
and frozen no-bundle script SHA256
`bfb133281a7b65f8f33f8a22f8193641b1976ca5449f8eafba0db8ff8e12d3fd`.
The script still matched its sealed source record after the drill. Inspections
confirmed the same isolated resources, source and stopped admission. Native
manifests, SQL boundaries and undo receipts were retained privately with mode
0600. The ranked fixture used synthetic proof-admission records only. No solver
or postgame analysis qualification follows from these recovery checks.

### Held terminal acknowledgement

The fixture let real Competition settlement accept a result while the Game
kept its terminal outbox after a deliberately lost acknowledgement. Native
restoration preserved the pending delivery, accepted result and two unreleased
account seats. All 49 D1 tables matched the preserved boundary after restore.

Releasing the held acknowledgement twice left delivery drained and the same
result/rating watermarks. The final aggregate check found zero unreleased seats
for that fixture. This tests the explicit isolated fault adapter, not a real
provider outage.

### Ranked correction and positive budget receipt

A normally finished and settled ranked fixture was restricted through the
bounded normal correction path before capture. Native D1 and both DO restores
preserved blitz epoch 2, its settled projection and `rating_voided=1`. Resume
verified the captured authority hashes and null alarms. The original result
and rating journal counts both remained 6, with no pending results.

Two normal bounded clear requests then completed the reversal. Blitz and the
D1 projection both reached epoch 3, `rating_voided` became 0, and the original
result and rating journal counts remained 6. Correction and restoration records
were appended normally; existing journal entries were not rewritten.

The same native restoration retained a positive one-unit games receipt for the
held fixture. Two exact retries were accepted without another charge. All 49
D1 tables were unchanged by those retries. Final receipt, month, aggregate-count
and stop-control tables also matched the original positive-receipt boundary,
including the original period and creation time. This establishes idempotence
for that retained receipt, not a provider-dollar spending cap.

### Naturally aged tombstone and complete native undo

The casual fixture was 6,166.975 seconds past its actual terminal time when the
normal `retire-aged` path ran. That bounded pass completed two eligible
payload retirements. No clock was backdated and no retention period was
shortened. The target retained its archived admission, terminal digest and PGN,
with a permanent Game tombstone and no heavy game state or pending delivery.

Native D1 and both DO restores recovered the original tombstone boundary.
The drill then executed a complete native undo using D1's saved previous
bookmark and both saved DO undo bookmarks. The separately reviewed undo
manifest required `probeBoundary` values of `changed` for all three stores.
All three changed markers returned, and resume verified the authority hashes
and null alarms. No accepted game command or other fixture mutation occurred
between restore and undo. The final audit found no armed restore left behind.

The retained one-ply PGN matched its original D1 value and parsed successfully
with the pinned chess.js package. The archived ledger and Game tombstone
survived both operations. Attempting to seed the same ID returned HTTP 409
`DRILL_SEED_CONFLICT`. All 49 D1 tables were unchanged by that refusal and the
final read-only fixture checks.

### Exact data comparisons and limits

Private SQL exports were imported into temporary local SQLite databases for
schema and complete-row comparisons. Ranked restore, tombstone restore and
tombstone undo each matched 48 of 49 tables exactly. The sole difference was
`recovery_drill_restores`, whose new native prepare receipts and manifest digest
are expected audit changes. There were no unexpected table differences.
The deliberate probe-change comparison differed only in its probe table.
Budget retries and permanent-ID refusal each matched all 49 tables exactly.
Raw rows, bookmarks and receipt values remain private.

These checks cover the recorded synthetic boundaries. A later, separately
sealed [single-account privacy rehearsal](provider-privacy-20261021.md)
verified reapplication of one saved closure receipt after native D1 rollback,
with both DOs kept current. The v3 matrix itself predates that privacy check.
Neither rehearsal establishes enabled-event recovery, multi-account or
concurrent closure replay, a production restore, independent backup, complete
cross-store recovery, or service-wide RTO/RPO.

## Measured intervals and data boundary

| Fixture | Recorded sequence start, UTC | Verified resume, UTC | Elapsed |
| --- | --- | --- | --- |
| Completed casual game | 01:04:21.240 | 01:05:21.267 | 60.027 seconds |
| Active casual game | 01:08:12.755 | 01:09:09.510 | 56.755 seconds |

The extended matrix recorded the following single-run intervals from native D1
restore dispatch to verified all-store resume:

| Extended fixture | Elapsed |
| --- | --- |
| Ranked epoch-2 boundary | 149.571 seconds |
| Naturally aged tombstone restore | 86.401 seconds |
| Complete tombstone native undo | 99.093 seconds |

These are single-run wall-clock intervals for the recorded restore sequences.
They exclude initial provisioning, capture preparation, approval setup and
later service reconciliation. The extended intervals include the agent's
command and verification time. They do not measure fleet recovery, regional
outages, concurrent traffic or a production recovery-time objective.

The last accepted move and its original receipt were retained within both
reviewed fixture boundaries. This does not establish a service-wide
recovery-point objective or recovery of work accepted after capture. Native
bookmarks and provider retention are not an independent offline backup.

## Retained evidence

The owner-controlled launch evidence records contain:

- `provider-recovery-private/native-verification-v3.json`: compact assertions,
  source/version and recorded intervals.
- `provider-recovery-private/native-verification-v4-natural-deadline.json`:
  adds the natural-deadline result while preserving the original v3 record.
- `provider-recovery-private/isolated-http.ndjson`: the `isolated-terminal-*`
  and `isolated-active-v3-*` operation results, including expected restart
  failures, restored markers, verified resumes and receipt retries.
- `terminal-d1-restore.json` and `active-v3-d1-native-restore.json`: successful
  native D1 CLI results and provider undo boundaries.
- Private reviewed manifests, DO undo receipts, SQL exports and
  `terminal-boundary-comparison.json` for the eight-table comparison.
- `provider-recovery-private/native-verification-v5-ranked-held-tombstone-undo.json`:
  the extended matrix assertions, sealed source, final aggregate state and
  restore/undo intervals.
- The `v3-held-*`, `v3-ranked-*` and `v3-tombstone-*` manifests, native CLI
  results, SQL boundaries, undo receipts and complete-table comparisons.
  `v3-budget-replay-d1-comparison.json` and
  `v3-permanent-id-refusal-comparison.json` record their 49-table equality.
- `v3-tombstone-replay-check.json`: pinned-package parsing of the retained PGN.

Keep full manifests, bookmarks, undo receipts, private rows and credentials out
of public docs. This summary is source documentation; it does not establish
publication of updated guides on the live site.

## Recovery checks still open

- Enabled tournament/arena state and broader concurrent-work recovery.
- Later accepted work beyond the reviewed boundary, including complete sets
  of later account closures. The separate privacy rehearsal covers one saved
  receipt with current DOs. The completed terminal undo deliberately accepted
  no new commands between its boundaries.
- Accepted provider retention, independent backup and automated privacy/expiry
  policy, including multi-account and concurrent closure replay and proof
  receipts or unresolved lifecycle debt outside any rollback target.
- Complete cross-store outage, rollback and reconciliation coverage, with
  production acceptance and service-wide RTO/RPO.

Keep production restore, public ranked admission and service-wide RTO/RPO
claims gated until their separate requirements pass.
