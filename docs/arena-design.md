# Arena v1 design and qualification

`arena-v1` is the selected contract for large automatic tournaments. It adds
timed arenas alongside the existing [round-robin preview](tournaments.md).
This contract was selected on 2026-10-20. Local source now includes the arena
authority, DTOs, HTTP API, D1 projections, and Competition hooks. Arenas are
disabled in the private default configuration. Focused native checks and
the [local qualification workloads](local-qualification.md) cover the contracts
listed below. Provider measurements and activation belong to the selected
release record. This design document alone establishes no public capacity,
deployed API or release.

Owner decision, 2026-10-31: arenas open at launch with `ARENAS_ENABLED=true`
and no product caps. The 2,000-player capacity harness is deleted (owner
decision, 2026-10-31); the workload below is a reference target for a future
staging script, not planned work. See [live-ready prep](live-ready-prep.md).

## Status and scope

| Area | Status |
| --- | --- |
| Three- or four-player round robin | Implemented for the local preview; see its guide for existing local checks and limits |
| `arena-v1` rules and owner design | Selected; described below |
| Arena implementation and API | Written locally, with focused native tests and local qualification workloads |
| Reference workload | Not planned work; targets are described below |
| Public deployment and worldwide play | Activation and measured client egress recorded per release |

The first tier targets 2,000 entrants per event, 1,000 live games across modes,
and 20 unique results per second. These are reference targets, not supported
limits or caps. Arenas have no product entrant or game cap. Behavior
under heavy load is still being measured.

The later 10,000-entry and 5,000-live-game tier needs separate qualification.
Passing the first tier cannot establish the later tier. The total chess budget
is $100 per month. A configured ceiling or a local test does not prove that the
workload fits this budget. The Cloudflare budget stop is separate from a
guaranteed dollar total.

## Configuration

Only the exact value `true` of `ARENAS_ENABLED` admits new arena work; the
launch release sets it (see [live-ready prep](live-ready-prep.md#production-values)).
New entry and pairing close when it is off; accepted games, scores, and
reservation release continue to drain.

| Setting | Default | Accepted maximum | Meaning |
| --- | --- | --- | --- |
| `ARENA_ENTRANT_LIMIT` | No cap | No cap | Registered entrants in one event |
| `ARENA_GAME_LIMIT` | No cap | No cap | Shared cap for admitted or pending casual, ranked, preview, and arena games, including when new arenas are disabled |
| `ARENA_RETAINED_GAME_LIMIT` | No cap | No cap | Retained rows in the shared preview and arena tournament game ledger |
| `ARENA_GAME_ID_LIMIT` | No cap | No cap | All permanent IDs in that shared ledger, including archived games |
| `ARENA_AUTHORITY_BYTE_LIMIT` | 4,294,967,296 bytes, or 4 GiB | 4,294,967,296 bytes, or 4 GiB | Competition SQLite platform byte stop plus space reserved for accepted games |

Numeric arena settings accept unsigned decimal integers, including zero.
Missing values use the defaults. Malformed values or values above the maximum
become zero and close the affected admission path. A positive value is an
optional owner cap; it does not establish supported public capacity.

The byte stop currently reserves 1,310,720 bytes per accepted game and 32 KiB
per retained arena entrant. Registration checks this headroom before adding an entrant. These reserves
still need a proof against bounded terminal results, journals, and projections.
Treat them as unverified safety allowances, not proof that accepted results
always fit. Actual row and byte growth remain part of qualification.

The retained entrant count is a single SQLite row. Insert and delete triggers
update it in the same transaction as the entry, including cleanup and rollback.
The first schema upgrade counts existing entries once. Later admission guards
read one counter row; a missing or invalid row closes new admission. Existing
games and accepted results can still drain. This local change still needs
measurement under real demand.

The round-robin preview and arenas share D1 tournament admission rows and have
no product cap. Casual payloads and permanent casual IDs keep their separate
optional limits alongside the shared game and authority byte guards.

The full 20-new-game-results-per-second target for 15 minutes needs 18,000 games.
No provider run is planned and it gates no production opening. A separate
synthetic pre-admitted settlement fixture measures coordinator throughput
without creating new game admissions or monthly receipts. It cannot qualify
that admission target. Never reset counters, delete receipts, recycle IDs, or
refund uncertain work to make a load run fit.

### Shared game admission

`Competition` owns the combined game count, authority byte guard, and start
bucket for casual invitations, computer practice, ranked play, the round-robin
preview, and arenas. These guards remain active when `ARENAS_ENABLED=false`.
The arena flag controls new arena entry and pairing. It does not remove the
shared limits from other modes or stop accepted games from draining.

Casual creation now saves a durable `casual_intents` row before admission. It
commits the D1 seat and permanent game admission before calling a Game binding.
The intent retains its original game ID, creator, reservation, format, and
computer setting across retries. A lost initialization reply uses that same
identity; the alarm and minute recovery paths reconcile it. Reusing a pending
ID with changed settings returns `GAME_INITIALIZATION_CONFLICT` (409).

`GAME_INITIALIZATION_PENDING` (503) means the request was saved. Reopen the
original game request and keep its ID. A creator retry can return the existing
game with HTTP 200; a newly created game returns 201. Another account cannot
claim the creator's request. Archived payloads return `GAME_ARCHIVED` (410)
and remain available through completed history and replay.

New casual requests can return `SEAT_UNAVAILABLE` (409) at a count, byte,
monthly, or account seat stop. Accepted D1 admissions and their retries retain
their identities through these stops. Existing games remain playable and their
results drain. The shared 32-per-second start bucket still paces initialization
attempts in every mode, including accepted recovery work.

Disabling computer practice refuses new practice admissions. A retained admission
from an older build, including one with no reservation value, can still finish
initializing. It ends unrated with `ai-unavailable` and releases its held seat
after verified result delivery.

Migration `0009_arenas.sql` seeds two fixed `game_admission_counts` rows from the
existing casual and tournament ledgers. Triggers maintain permanent ID and
retained payload counts on admission and retirement. New admission reads those
fixed rows instead of counting the full permanent ledgers. Retirement frees
retained payload capacity; it never frees a permanent ID.

The migration also seeds `legacy_casual_seats` for older admitted casual games
that still hold seats. Its triggers count each game once, including games with
two participants, and lower the legacy live count when its last seat releases.
This count joins the Competition-owned intents in the shared game and byte
guards. Missing counter rows close new admission. Apply the migration before
running this source; do not zero counters to reopen a stopped service.
The arena stage of a maintenance pass reuses the count Competition read at the
start of that pass. A casual request reads it only for a new admission, not
when resuming a saved or admitted one.

## Schedule and finish rules

Keep the published UTC cadences and the existing game clocks:

| Event | UTC start | Game clock | Pairing window | Game wall limit |
| --- | --- | --- | --- | --- |
| Hourly blitz | Each hour at minute zero | 5 minutes plus 3 seconds per move | 60 minutes | 18 minutes |
| Daily rapid | Each day at 18:00 | 10 minutes plus 5 seconds per move | 120 minutes | 40 minutes |
| Weekly rapid | Sunday at 16:00 | 10 minutes plus 5 seconds per move | 120 minutes | 40 minutes |

Registration alone does not reserve an account or enter the pairing queue.
Eligible human username/password entrants must explicitly queue. Recovery email
is optional. Players may pause and resume
between games. A normal settled game returns its entrant to `registered` after
the reservation has released; queue or resume explicitly for another game.
Guests and computer opponents cannot enter. All arena games are
unrated and give no credit toward the global ranked leaderboard.

At the pairing cutoff, stop accepting new game intents. Already accepted
intents remain durable and may need initialization or recovery. The event
enters `draining` until every accepted intent has a settled result or a terminal
technical void. Standings remain provisional during this period. The final
standings must not omit an unresolved accepted game.

Persist each game's identity, reservation, and wall deadline before external
initialization. Retries and restarts must use those same values. The game wall
limit includes readiness and play. An earlier chess clock, readiness, or proven
terminal result keeps precedence. The common online rules and the material
timeout rule still apply.

A game still unresolved at its published wall limit receives the defined
technical void. Never infer a winner from a scheduling failure. Service or
storage delays may keep an event in `draining` beyond its nominal wall limits;
show that state and preserve accepted work.

Turning off new admission must still allow accepted games, results, and
reservations to drain. Automatic cadence work must remain bounded after an
outage rather than creating every missed event.

Due running and draining events are processed before scheduled starts, within
the existing bounded lifecycle pass. This lets an empty expired hourly event
release its slot before the next hourly and daily events start while weekly
games drain. No cap limits open events.

The Competition alarm is armed for the next real due time only. A running
event nobody waits in sleeps until its close. While a player is queued, pairing
retries once a second, so pairing latency is unchanged. A draining event waits
for its last settlement. A live game is read when its Game next reports work
(its readiness end, clock deadline or cutoff) and never more than five minutes
later, and publication, cleanup and release batches arm their own due times.
The minute trigger still runs a full pass, so switching `ARENAS_ENABLED` off
drains running events at the next pass.

Implemented and tested locally with a mocked clock, not staged or released.
An idle running hourly arena woke 3,665 times from start through close before
this change and 7 times after. In the first two minutes after a start, an arena
with one player left waiting woke 123 times before and after, and an arena
whose queued players all had games woke 7 times, down from 123, and 4 times
after Games reported their own due times, which moved their reads from every 30
seconds to the end of the two-minute readiness wait.

## Points and opponents

| Arena result | Points |
| --- | --- |
| Win | Winner 1, opponent 0 |
| Draw | 0.5 each |
| Loss | 0 |
| No-show | 0 |
| Time runs out, other side has mating material | Other side 1, player who ran out 0 |
| Time runs out, other side cannot mate | 0.5 each |
| Round cutoff void, including revoked eligibility | 0 each |
| Waiting without an opponent | 0 |

There are no bye, streak, or berserk points. No-show scoring differs from the
round-robin preview: it does not award the ready player an arena win. A no-show
pauses that entrant until an explicit resume action.

Equal scores share a rank. Account ID supplies stable display order within a
tie. It does not break the tie or award a higher competitive rank.

An unordered pair may meet at most twice in one arena, with another opponent
between repeat meetings. Keep this rule when the queue is small. If no allowed
opponent exists, keep the entrant waiting without points or a silent exception.

## Pairing and reservations

`Competition` remains the single owner of arena scores and cross-mode account
reservations for the first qualification tier. Each `Game` Durable Object owns
its seats, moves, clocks, and terminal result. Arena control stays off the move
path. There is no new harness or shared UI runtime dependency.

Use normalized indexed rows for events, entrants, waiting lanes, game intents,
pair counts, score receipts, and projection cursors. Partition work by event
and indexed score/rating lanes with rotating cursors. Do not load or rewrite a
complete event for each pairing, result, or public request.

Select the oldest eligible waiter first. Inspect a bounded candidate window,
prefer nearby score and rating, widen preferences as the wait grows, and
balance colors. Repeat-opponent, eligibility, and reservation rules remain
hard limits. A separate coordinator design needs measured evidence and a
reviewed protocol that preserves the existing atomic reservation contract.

| Local work bound | Maximum |
| --- | --- |
| Candidates inspected for one oldest waiter | 64 |
| Pairings accepted in one pass | 8 |
| Game intents initialized in one pass | 8 |
| External operations in flight during initialization | 4 |
| New game starts across Competition modes | Token rate 32 per second, burst 32 |
| Records in an arena recovery, deadline, or projection pass | 32 |
| Standings builds in progress for one event | 1 |

Each bounded pass needs a durable cursor or retry marker. A slow or failed
record must not make unrelated accepted work disappear. Reconcile creating and
live intents before releasing their reservations. A delayed control message,
pause request, expired timer, or missing response cannot release an unresolved
live game.

At private queue actions and game admission, check the current primary account
and session state. Keep claims atomic against casual, ranked, and other event
reservations. Eligibility reads must not perform broad restriction maintenance
writes. Run expiry cleanup separately in bounded work.

## Result and scoring contract

Accept a game result only when it matches the stored event, game, players,
reservation, format, deadline, and terminal identity. Commit the accepted
terminal result, its unique arena score receipt, and both entrant totals in the
same SQLite transaction.

A matching duplicate returns the original accepted state. It changes neither
scores nor reservations. A conflicting terminal identity remains an incident;
it must not replace the accepted result. Restart recovery reuses the durable
receipt and game intent.

Engine signals and reports are informational under the published
[fair play policy](fair-play.md). They do not automatically convict a player,
remove ratings, or change event points. The arena rules limit repeat-opponent
farming, but do not prove that unsupervised engine assistance is absent.

## Public standings and private state

Public schedule, event, and standings reads use D1 alone, contain no caller
state, and perform no session lookup. They do not expose email, sessions,
eligibility reasons, private queue state, or the caller's current game. Private
`me` and queue actions require current primary authentication and
`Cache-Control: no-store`.

Registration validates its same-origin, empty JSON request at the Worker before
one Competition call. The global authority admits at most 16 concurrent
package-auth and account-limit checks; overflow returns `429 ARENA_RETRY`
without starting primary authentication. Those slots release before the
separate 256-call fresh eligibility stage. New entries spend the durable
50-per-second registration bucket, with a burst of 100. Existing entries keep
fresh session, credential, restriction and budget checks without spending a
new-entry token. The Worker also keeps its 16-call isolate filter. These bounds
are local implementation controls; provider qualification remains separate.

Build complete standings generations. Every page carries its generation,
accepted-result watermark, and publication timestamp so the client can show
projection age. The local implementation uses at most 32 rows and at most
32 KiB per page. Cursors bind to one
generation; clients must not combine pages from different generations.

New builds reuse immutable entrant versions instead of copying every entrant
into temporary snapshot rows. A score/user/revision index supplies at most 32
candidate versions per step, including obsolete and post-build candidates.
The authority selects each user's latest version at the frozen revision, then
checks visibility. This keeps later score changes and withdrawals outside the
current generation and prevents an older visible row from reviving a player
who already withdrew.

The durable scan cursor and at most one page of lookahead rows survive an
eviction. A page and its remaining scan state commit locally before the D1
write, so a lost reply retries the same bytes and successor cursor. Exact
32-row final pages wait for scan exhaustion before declaring completion.
Older capture/page builds can finish using their retained snapshot rows.
The first upgrade adds a generated score key and builds its index over all
retained versions. That one-time migration is separate from the bounded
advance step and needs retained-state CPU and row accounting before deployment.

Publish the new generation head only after every page exists. Retain two
complete generations and allow only one build per event at a time. Public
responses are stored in the Cloudflare Cache API for 10 seconds
(`public, max-age=10, s-maxage=10`) and sent to browsers as `public, no-cache`,
so a refresh revalidates against that edge copy instead of reusing a stale local
one. Each event's public summary is rebuilt at most once every 10 seconds
(`snapshotIntervalMs`), so a new registration can take up to about 20 seconds to
appear in the public count. The registering player sees their own entry at once. A warm cache read skips D1 and session lookup. Public
cache keys include only the path and documented standings cursor; cookies,
authorization headers, and other query parameters do not create variants.
Failed reads stay uncached. Deployed cache behavior and hit rate remain
unverified. If a cursor's generation is no longer retained, start again from
the current head.
During `draining`, even a complete published generation remains provisional
until all accepted intents resolve.

Each local snapshot, entrant-version, and public page cleanup job visits at
most 32 candidate keys per pass before checking whether each may be deleted.
Persistent keyset cursors advance through protected rows and resume after
eviction. Cleanup preserves the newest entrant version at each active build's
frozen revision and every later version, legacy snapshots, both published generations,
and unpublished pages. Publication requests a fresh sweep after each current
sweep finishes, so rows that became obsolete behind a cursor are revisited.
The durable cleanup marker keeps work scheduled after all events have ended;
completed sweeps remain idle until the next publication. These bounds have
focused local coverage. Cleanup throughput at the target load is unqualified.

### Local player flow

The local `/tournaments/` page separates **Arena events** and **Round-robin
preview**. Choose **View arena** to open an arena's standings and private entry
controls. Registration saves an entry. Use **Join queue** when ready to play.
When a game is ready, use **Open your game**. The page does not navigate
automatically. After the result and reservation release, use **Queue for
another game** to play again.

Standings pagination stays in one published snapshot. **Latest first page**
starts again at the current head. An expired cursor restarts pagination and
shows a notice. The client fetches private `me` state only for the selected
arena and a signed-in username/password account; public standings load separately.
Local browser checks cover public schedule publication, keyboard selection,
empty standings, selected-event reload, and both themes at 360-pixel width.
Credential-backed entry, queue/pause/resume, nonempty multi-page standings, and
expired-generation browser recovery remain unverified.

### Local HTTP API

These routes are written locally. They are separate from the existing
`/api/tournaments` preview API and have not been verified on the public host.
Event IDs use `arena-<cadence>-<UTC-start-milliseconds>`.

| Endpoint | Response or action |
| --- | --- |
| `GET /api/arenas` | Up to 21 projected event summaries, `enabled`, `serverNow`, and limits with `measuredCapacity: null` |
| `GET /api/arenas/:id` | One projected `ArenaSummary`, or 404 |
| `GET /api/arenas/:id/standings` | First page of the current complete generation |
| `GET /api/arenas/:id/standings?cursor=generation:page` | The requested page in the current or previous retained generation |
| `GET /api/arenas/:id/me` | Authenticated caller's `ArenaMe` from the authority |
| `POST /api/arenas/:id/register` | Eligible username/password caller registers during the entry window |
| `POST /api/arenas/:id/withdraw` | Registered or paused caller withdraws before start, with no game held |
| `POST /api/arenas/:id/queue` | Registered caller requests a shared account reservation and joins when it commits |
| `POST /api/arenas/:id/pause` | Queued caller requests release to `paused`; an active game or pending claim returns busy |
| `POST /api/arenas/:id/resume` | The same action as `queue`, including after a no-show pause |

POST actions require a valid same-origin session and the JSON body `{}`.
The body limit is 1,024 bytes; extra properties are rejected. Successful actions
return `ArenaMe` directly. Across the private Durable Object boundary,
`ArenaActionResult` carries either that value or a deliberate public error.

`ArenaMe` includes event ID and format, server time, event status, registration
state, private entry state, current game ID, points, game count, queue time, and
a public reason. Entry states are `registered`, `reserving`, `queued`,
`playing`, `paused`, `releasing`, and `withdrawn`. A pending allocation or
initialization does not expose an openable game ID. After an accepted result,
the state can remain `releasing` while D1 seat cleanup retries. Resume after it
has released; do not infer release from the game clock alone.

Each public standings page contains `id`, `format`, `generation`, `watermark`,
`generatedAt`, `provisional`, `standings`, and `nextCursor`. Each row contains
only account ID, display name, points, settled game count, and shared rank.
The cursor returned by the service has the form `generation:page`, with a
zero-based page index. Omit it to restart from the current first page. Terminal
events leave public reads seven days after `finishedAt`; archived final pages
are retained separately.

| HTTP status | Common stable codes | Recovery |
| --- | --- | --- |
| 400 | `INVALID_ARENA_ACCOUNT`, `INVALID_ARENA_REQUEST`, `INVALID_ARENA_CURSOR` | Correct the account or request; restart pagination for a malformed cursor |
| 401 | `SIGN_IN_REQUIRED` | Sign in again |
| 403 | `ARENA_INELIGIBLE` | Use an eligible human username/password account |
| 404 | `ARENA_NOT_FOUND` | Refresh the schedule; the event may be absent, unpublished, or outside public retention |
| 405 | `METHOD_NOT_ALLOWED` | Use the method shown in the API table |
| 409 | `ARENA_ENTRY_CLOSED`, `ARENA_WITHDRAWAL_CLOSED`, `ARENA_FULL` | Refresh event and private state; wait for another open event when needed |
| 409 | `ARENA_REGISTER_FIRST`, `PLAYER_BUSY`, `ARENA_BUSY`, `ARENA_RELEASE_PENDING` | Register first, leave incompatible work, finish the game, or wait for the pending claim/release |
| 409 | `ARENA_CURSOR_EXPIRED` | Discard the old cursor and start from the current first page |
| 429 | `ARENA_RETRY` | Retry new registration after a second; duplicate accepted entries remain stable |
| 503 | `ARENAS_CLOSED`, `NEW_GAMES_PAUSED`, `BUDGET_UNAVAILABLE`, `SERVICE_UNAVAILABLE` | Preserve accepted state, refresh it, and retry when admission or service recovers |

HTTP errors use `{ "error": "CODE", "message": "public message" }`.
General origin, session, request-size, and account-rate limits also apply.

## Retention and storage admission

Keep the one-hour minimum hold for completed hot Game payloads. At 20 finishes
per second, that requires at least 72,000 completed payloads before counting
live games, retry work, and evidence holds. The preview's four retirements per
minute cannot sustain this workload.

Large-tier qualification requires at least 25 successful retirements per second
after warmup, with bounded concurrency, durable retry cursors, and holds that do
not block unrelated retirement. Preserve private replay, permanent game IDs,
terminal receipts, and immutable results. Never recycle an ID or reset a safety
counter to reopen admission.

The explicit `GAME_RETIREMENT_MODE=scaled` source path uses the existing
Competition alarm and a D1 indexed queue. It permits at most 32 candidates per
pass, four archive RPCs in flight, and a persisted 32-attempt-per-second token
bucket with a burst of 32. Missing or exact `preview` keeps four attempts per
minute; invalid values close retirement. Apply migration
`0011_retirement_work.sql` first. A 1,000-game native batch exceeded 25 clean
archives per second after its initial burst. Held/failing-record progress has
separate focused coverage. Combined endurance, physical page reclamation and
steady-state cost remain unqualified. See [local evidence](local-qualification.md).

Archive final standings before removing temporary event rows. Measure history
expiry from `finishedAt`. Keep enough permanent terminal identity to recognize
old retries after temporary rows are gone. Apply separate record and byte
ceilings, with space reserved for accepted games and their results. Close new
admission before that headroom is consumed; continue draining accepted work.

Permanent records still grow. Passing a short run does not prove sustainable
storage or cost. See [operations](operations.md) and
[verification](verification.md#limits-and-remaining-release-work) for release
evidence and limits.

## Reference workload targets

The following first-tier targets are kept as a reference for a future small
staging load script, written only if demand needs checking (owner decision,
2026-10-31). No run is planned and they gate no opening. The table does not
declare them passed; see [the local report](local-qualification.md) for measured
parts and their limits.
Account creation and email delivery need their own evidence; the signup load
below uses accounts that already have username/password credentials. Recovery
email and its verification are optional.

| Area | Acceptance target |
| --- | --- |
| Entrants | 2,000 per event, with 3 simultaneous events |
| Live games | 1,000 combined creating, reserved, active, or settling games across modes; 2,000 participant sockets |
| Event registration requests | 10,000 requests in 30 seconds from 2,000 existing username/password accounts, including retries |
| Durable registration | 50 accepted registrations per second, burst 100, with truthful retry or full responses |
| Settlements | 20 unique results per second for 15 minutes |
| Recovery | 1,000 delayed results with 5 duplicates each; drain within 60 seconds while normal traffic continues, reaching at least 40 unique settlements per second during catch-up |
| Spectators | 10,000 viewers refreshing every 10 seconds |
| Projection age | Ordinary p95 standings lag at most 15 seconds |
| Settlement latency | p95 acknowledgement at most 250 ms, alongside the existing move CPU and service budgets |
| Regions | Separate measurements for US West, US East, Europe, Asia-Pacific, Australia, and South America |
| Retirement | At least 25 successful payload retirements per second after warmup, with holds and retries present |
| Cost | Whole workload within the owner's $100 monthly chess budget |

Exercise signup bursts, restarts, outages, duplicate and conflicting results,
cross-mode claims, no-shows, repeated opponents, reconnects, and finalization
with unresolved accepted games. Record the source revision, configuration,
duration, participant and spectator load, regional pairs, queue age, latency,
storage growth, and recovery outcome.

Report cost per 1,000 games and per 10,000 spectator-hours. Include auth,
projections, retained payloads, permanent records, retries, and active-object
duration. Publish the tested workload with its results; it is a measurement,
not a cap. Do not infer worldwide latency or budget compliance from local
correctness checks.

## Package boundary and verification limits

The existing MIT `@echecs/round-robin` and `@echecs/tournament` packages remain
the preview's pairing and standings owners. Their fixed-round model waits for
the previous round to complete, which does not fit continuous arena pairing.
Maintained MIT `@echecs/swiss` supplies round-based FIDE systems. GPL
`tournament-pairings` supplies Swiss weighted matching without the selected
oldest-waiter policy. Neither meets this arena contract.

Arena code therefore uses platform SQLite ordering, indices, transactions, and
bounded cursors for the product's waiting and scoring policy. It does not add a
general matching solver, chess engine, credential system, or ratings engine.
See [the preview package evaluation](tournaments.md#package-choice) for package
versions, licensing, and measured package sizes.

Three focused native cleanup tests pass locally. They cover bounded candidate
visits, active-build and generation protection, eviction recovery, continued
cleanup after events end, and publication during a sweep. The product typecheck
also passes. See `test/arena-projection-cleanup.test.ts`. The final combined
native suite passed 201 tests across 28 files in 8.99 seconds. Public schedule,
selection, and empty standings passed local browser checks. Authenticated
browser acceptance and broader release checks remain open.

The final result-reserve proof, deployed public edge caching, registration auth
load, cleanup throughput, and alarm/recovery behavior under load remain open.
Native local qualification additionally covers one 2,000-entry event with
1,000 Game objects and 2,000 participant sockets, a replacement connection
burst, and three simultaneous 2,000-entry events sharing 1,000 real games.
The latter includes unavailable verification, Competition eviction, 5,000
duplicate results, real outbox acknowledgements and finalization. The exact
workloads, source fingerprints and storage limits are in the
[local qualification report](local-qualification.md).

Public registration, regional latency, deployed archive
throughput and monthly cost remain unverified and are measured after opening.
Make no public capacity claim from local checks. Deployment evidence is tracked
separately in the [runbook](deployment.md).
