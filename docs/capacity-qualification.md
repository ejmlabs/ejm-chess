# Private native capacity qualification

This guide describes the approved isolated capacity harness and its fixed
workload. Each provider run retains its source identity, resource records,
measurements, failures and shutdown evidence. The implementation alone does
not qualify public arena capacity or authorize a load test. The release record
must identify the actual passing run before enabling its capacity tier.

## Scope and owner

The product owns this harness. It composes the real `Game` and `Competition`
authorities and reuses their account eligibility, admission, budget, command,
result, replay, projection and cache contracts. No shared UI, harness runtime,
second account store or second receipt engine is needed.

The source permits a once-only allowance of at most 20,000 synthetic game
admissions, permanently charged across retries, restarts, deployment and month
changes. The required workload is 18,000 distinct regular results over the full
900 elapsed seconds plus 1,000 distinct delayed results. The owner approved a
fixed ten-second recovery lead on 2026-10-21 UTC: recover 400 delayed results at
40 per second before the regular stream, then 600 at 20 per second during its
first 30 seconds, alongside 20 regular results per second. All delayed results
must recover within 60 seconds from recovery start, with five matching
duplicates each. The 400 lead results are outside the regular terminal stream.
Duplicates do not count as new results. Failed or uncertain reservations stay
charged. The 1,000 unfinished-game cap and production's 10,000 hard monthly
game ceiling remain unchanged. Late or missing slots remain failures.

The isolated run retains its finite $25 incremental ceiling inside the $100
monthly chess target. The former service allocations and mandatory recovery
reserve no longer apply. Existing alerts and stops remain in place. Current
account spend can be unknown because provider reporting is delayed; a source
model does not guarantee the invoice. Source implementation is not approval
for provisioning or load. See the [cost estimate](cost-estimate.md) and
[budget controls](cloudflare-budget.md).

## Current implementation

- `capacity-policy.ts` binds the isolated game allowance to the exact native
  environment and D1 handle through an internal capability. Copying the
  environment or replacing its database loses that capability. A production
  environment flag cannot select the allowance. The normal atomic D1 game
  receipt transaction is reused.
- `capacity-run.ts` persists one arm record, the complete fixed manifest
  identity, permanent receipt and Game-ID links, a monotonic stop cause, native
  work reservations and per-object permits. Uncertain work never releases a
  permit by timeout. Controller and Competition retain two duration permits.
  A known handler completion also retains its lifetime permit: a return does
  not establish native shutdown. A separate generation-bound retirement path
  fences a drained Game, observes a real running-alarm barrier, deletes its
  alarm and aborts that incarnation with a fresh one-use acknowledgement.
  Only the matching confirmed acknowledgement releases that permit. A lost
  reply retains it. Games that have accepted a socket retain their permits.
- Native work is admitted only after the controller accepts the known object
  and its operation envelope. A signed one-use dispatch ticket binds the run,
  manifest, object, generation, operation and mode. The controller retains
  unconfirmed reservations and rejects repeated dispatch IDs. Completions
  compare the fixed manifest, monotonic time and hard deadline before releasing
  known unused work.
  The normal internal Game namespace adapter links an already charged ID and
  acquires its lifetime permit before invoking a native Game stub. Event begin
  requires that prior permit; it cannot allocate one after wrapper activation.
- Finite ingress grants permanently charge 256 Worker requests, their full
  50 ms per-request CPU allowance, eight D1 rows per slot across three read
  attempts and one 640-row auth
  startup. An isolate consumes each grant once. Each new grant uses the current
  request's controller RPC stub; the isolate retains counters and a pending
  grant, never a completed request's RPC stub. Lost
  replies, isolate loss and unused grants do not refund capacity. This avoids
  a controller RPC for each spectator cache hit.
- `capacity-meter.ts` reads actual native SQLite cursor and D1 response row
  metrics, including index work. Failed work and D1 retry metadata that cannot
  account for earlier attempts remain uncertain. Unknown unmetered D1 methods
  are rejected. Alarm calls receive conservative row charges outside SQL
  cursors. Returned row counts are not used as billing measurements.
- Physical storage reports use per-object DO high water marks and a shared D1
  high water mark. Growth is charged once across known completions. Uncertain
  growth retains its full prior reservation. The controller prepays its full
  finite method plan and retained physical storage at arm, consumes one durable
  slot before each method, and checks actual native SQL usage before returning
  a ticket. Unused or lost method calls do not refund that allowance. Complete
  bootstrap, denial, cleanup and operation envelopes remain unqualified.
- Native adapters use the real Durable Object state for the platform base
  constructor and a private metered context for product work. A stable SQL
  handle resolves the current event's meter for every call, including control
  bridges retained by a native constructor. Explicit wrapper methods avoid a
  generic RPC dispatcher.
- `capacity-standings.ts` exercises the platform Cache API with a real
  10-second lifetime and the production indexed public projection. The cache
  key binds the frozen manifest and fixed page, with no identity or arbitrary
  query variants. Ingress blocks prepay every read, including cache misses,
  so public reads do not call the controller individually. Native D1 metadata
  must stay within 64 rows per miss; hits use no D1. Unknown metrics, retries,
  excess rows and incomplete projections fail the read. The driver records
  cache age, hit or miss and native row use, and rejects stale or absent
  evidence. These local paths still require the full qualified workload. The
  private entry does not import the production router or optional services.

### Native workflow checkpoint

The private candidate now prepays the fixed Game profile mix and one complete
Competition workflow at arm. A signed workflow ticket is reused only by that
object and generation. Each native delivery takes a durable finite event slot,
reserves its next operation, then records measured work. Cold calls use the
profile's separate cold-event limit. Interrupted reservations remain held.
Completion includes its row tail and a trial 32 KiB physical-storage tail;
the actual post-write native high water must still fit. Whole-run funding is
permanent and never refunded. Per-event dispatches remain only for the older
focused fixtures.

The full profile's 10,000-offer registration burst prepays its private guard
in 32-slot blocks, with 16 slots in the last block. One SQLite transaction
reserves every slot's full existing work envelope and claims its exact corpus
bits before native registration. Each invocation consumes its warm permission
once and checks the durable stop and unresolved fences. Middle completions
record measured work in memory without a guard write. A fully completed block
checkpoints that work and its paid completion tail. Other paths, including the
short registration diagnostic, keep their per-event guards.

A cold registration claims its exact corpus bit inside its funded event
before primary authentication can yield. A later warm block that overlaps
that bit falls back to individual claims. The cold permission is consumed
once, including when its durable claim was rejected. A clean reincarnation
can claim an unused step; interrupted block reservations stay fenced.

Unused slots, interrupted calls and uncertain measurements keep the entire
block reserved. A cold reconstruction cannot recover warm permissions or reuse
those slots. Corpus bits remain permanent after a completed checkpoint. A
measured overrun saves a stopped record without releasing the block. The
32-slot grouping changes no arrival, rate, inflight, response-deadline or work
cap. It bounds guard storage work; provider throughput still requires the
complete approved workload.

A rejected or failed private alarm fences its workflow, attempts to delete
the pending alarm, then requests `abort` with `retryAlarm: false`, including
when cleanup I/O fails. An admitted event keeps its full reservation. A
pre-claim rejection uses the separate terminal allocation for its schema and
ledger prefix. A later scheduled alarm sees the durable stopped or unresolved
workflow before product work. These paths never release a permit or supply a
shutdown receipt. The terminal allocation covers two callbacks, 1,024 cursor
reads and three writes per authority. Its deletion can remain uncertain;
the abort request alone does not prove physical shutdown. The second callback
funds one already scheduled tail. It does not establish a numeric bound on the
provider's general at-least-once duplicate delivery.

Direct Game steps verify the permanent signed binding and current primary
session before lookup, then repeat those checks inside the native meter.
The Game owns the issued-step fence, legal command and terminal observation.
Competition still owns normal registration, pairing, allocation, result
settlement and projections. Private fault hooks claim each fault once. Held
results recover through the real saved Game outbox at the fixed source cadence;
they do not write a synthetic result or change a game clock.

The isolated schedule capability supplies the three fixed event starts to
the normal Arena scheduler. Production never installs it. A local or sealed
candidate can choose a real minute on any day. The full corpus, actual clocks,
native event state, deadlines, result counts and ceilings stay unchanged.
This permits the capacity workload without claiming the deferred real calendar
qualification.

`/capacity/stop` attempts native shutdown before latching the owner stop. Each
of the 1,000 socket Games must have an actual finished result, empty delivery
outbox, no sockets and no alarm. The Competition workflow must have all 20,000
bindings, no unfinished intents, no result outbox, no pending result and no
projection build. It waits for native work to finish and deletes its alarm.
The controller accepts the receipt only after 20,001 native workflow
completions and 19,000 exact retirement acknowledgements. Until then,
`nativeShutdown` is null. Its accepted receipt records the observed zero
work/sockets/alarms alongside 1,002 retained lifetime permits. Those permits
remain charged. A receipt does not claim object eviction or zero duration.

The source-only trial exports in `capacity-candidate-plan.ts` are safe to
import in local Node tooling. Their limits are not measured conservative
bounds. The complete trial allowance fits the approved ceilings after native
sample-based reallocation, including the terminal callback allocation per
private authority. This reserves 4,996,908 DO writes, leaving 3,092 under the
unchanged 5,000,000-write ceiling. This is reservation arithmetic, not observed
runtime fit. An exact regular-intent sample used 14 native Game events,
110 DO writes, 267 DO reads, 592 D1 reads and 6 D1 writes. Its measured Game
workflow closed with an empty delivery outbox. This is one sample, not a bound
for the whole corpus. Focused local safety, exact source freeze, live resource
checks, the full provider workload and its shutdown audit remain required.
A full local performance pass is no longer required before sealing. Failed
local reports remain failed and are retained with the safety record. All verified
manifest, envelope and workflow gates remain null, and protocol readiness
remains false.

One exact regular-intent mechanics probe is available:

```sh
node scripts/probe-capacity-workflow.mjs --output /private/tmp/chess-workflow-local.json
```

It uses two primary synthetic accounts, real native registration, queueing,
pairing, bindings and `qualificationStep` commands. It seeds no event, Game,
clock or outcome. Its setup window is deliberately a local fixture rather
than a sealable full-run manifest. Probe controller, post-reply observations
and explicit Competition maintenance are excluded from capacity claims.
An exhausted trial budget is a failed sample, not permission to raise a cap.

Worker primary auth uses one stable package context and a per-request native
meter through AsyncLocalStorage. It awaits Better Auth's cached schema check
before declaring its startup drained. Registration and queue requests now
authenticate in that Worker boundary, matching the product router, before
entering Competition's admission token bucket. Competition checks the fixed
fixture identity, session, expiry and ready bit, then uses unchanged product
admission and primary-session revalidation. Native Game auth separately funds
its cold schema work. Primary sessions remain uncached. Private step responses
retain bounded Worker-auth and authority timings in `X-Capacity-Timing`,
without identities or SQL. This private header avoids provider additions to
the standard `Server-Timing` header.

Private Competition step replies also carry `X-Capacity-Native-Timing`. Its
bounded epoch milestones cover Worker send and receipt, native entry, verified
ticket, durable claim, native method completion and wrapper return. These
in-memory timestamps add no storage writes or RPCs. Same-process differences
separate ticket, claim, method and completion work. The authority RPC duration
minus total native duration retains transport and input/output gate delay.
Cross-process timestamp gaps may include clock skew and do not prove one gate
as the cause. The driver rejects malformed, regressing or over-60-second spans.
These headers contain no cookies, account IDs or SQL and do not appear on the
player API.

### Local auth-placement diagnostic, 2026-10-22 UTC

The unchanged setup and first 60 seconds of registration completed locally
with all 6,000 account credentials, 11,000 offered registrations and 11,000
replies: 3,296 accepted and 7,704 normal `ARENA_RETRY` responses. There were
no missed offers, uncertain replies, unresolved dependencies or saturated
slots. Peak concurrency was 27 of the fixed 256 slots. Accepted latency p95
was 22.8 ms; normal retry latency p95 was 6.7 ms.

Every reply retained both private timing stages. Source pins stayed unchanged,
the owner stop was acknowledged and Miniflare was disposed. The partial
diagnostic left one native dispatch unresolved and has no final native
shutdown audit. Loopback timings and the local CPU profile cannot qualify
Cloudflare latency, billing or the full tournament workload. All eight failed
provider attempts remain retained.

### Fixed protocol checkpoint, 2026-10-21 UTC

Private fixture helpers create the fixed accounts in the primary Better Auth
tables without recovery mailboxes. A durable setup intent precedes the atomic
D1 batch. A failed or lost reply cannot mint a replacement identity. A later
read can recover the same committed primary session; it cannot recreate a
revoked session. Cookies use the package's signature and existing secure
cookie policy. Account steps read the current primary session and credential
readiness in the Worker. Native Competition checks the fixed account/session
identity, exact expiry and ready bit; accepted admissions still revalidate
primary records. Native Game steps also repeat primary authentication. The
canonical auth environment is reused; player sessions are not cached.

The protocol durably marks an issued step before invoking an authority. A
lost reply cannot dispatch that step again. The intent ledger binds only
normal native reservations and their actual seats. An unresolved binding
fails before Game lookup. A successful observation may still report a pending
binding; the second fixed observation is the driver's final binding deadline.
There is no extra poll, replacement game or shifted slot.

The routing-proof codec uses the existing pinned `jose` package. It binds the
run, source/config/manifest digests, exact expiry, ordinal, event, reservation,
Game, actual seats, generation and workflow nonce. It rejects a different
scope before namespace lookup. Signing after durable workflow prepayment,
direct Game validation against saved state, and generation/replay enforcement
still need native integration. The codec alone grants no work.

Twelve focused local checks across four files passed in 2.18 seconds. They
cover committed-but-lost fixture replies, revoked sessions, durable step
replay, pending binding, actual-seat authorization and routing-proof scope.
Worker types passed before the subsequent shared-header import and canonical
auth-cache edits. Final integrated verification remains required. These are
policy and local primary/SQL checks, not a complete native calendar workload.

The source audit found that routing every command through Competition and
Game exceeds the existing native request ceiling. Even direct routing needs
bounded prepaid workflows and finite cache-fill/failure allowances. The
implementation remains unarmed while those complete costs and work bounds
are unresolved. No cap has been raised.

### Native row measurements, 2026-10-21 UTC

A bounded local probe exercised primary fixture sessions, ordinary arena
registration and queueing, real Game initialization and readiness, four legal
plies, resignation, native alarm delivery, Competition validation, and five
duplicate settlements. It also published 2,000 standings entries in 63 pages
and cleaned up the sampled projection state. Seven checks passed across 3,596
measured native events in 5.874 seconds. Terminal outcomes and score receipts
came from the real authorities. Setup seeded 1,998 additional nonterminal
entrants and 45,954 old zero-score version rows; that setup was excluded from
the measured workload. Competition maintenance was invoked explicitly.

The observed one-Game lifecycle used 97 DO writes, 150 DO reads, 45 D1 reads
and six D1 writes, with a 69,632-byte physical high water. These are one local
shape, not worst-case envelopes or provider throughput. The complete
20,000-Game run, automatic cadence, faults, sockets, cleanup, authentication,
retirement and all failure tails remain unqualified.

A separate identical 2,000-entry, empty-queue maintenance probe found repeated
full entry counts before checking for a waiting player. The authority now
checks its indexed due queue before retained-entry byte accounting and ends a
synchronous pairing pass when no event produces a pair. Every admission guard
still runs before allocation. Claim, release, recovery, publication and cleanup
work continue when pairing has no due entrant.

The following paired measurements use Node 24.19.0 and the same projection
source on both sides, before append-time version pruning. The earlier Arena
source was loaded in memory for the baseline. The idle case exercises the
due-queue guard; it has no Games and does not exercise settlement changes.

| Warm empty-queue maintenance | Before due-queue guard | After |
| --- | ---: | ---: |
| Native DO rows read | 2,366 | 325 |
| Native DO rows written | 27 | 25 |
| D1 rows read | 16 | 15 |
| Full entry-count scans | 1 | 0 |

A separate paired one-Game probe used ordinary readiness, four legal plies,
resignation, native result delivery and five duplicate deliveries. Settlement
now commits each entrant's score and release fields in one guarded update and
the event watermark and revision in one update. Its primary Competition
settlement changed from 58 to 55 native DO reads and from 36 to 31 writes.
Each duplicate still used three reads and two writes. Both sides included the
same score-version index, which was absent from the earlier 34-write sample.

That variant skipped the full probe's projection and cleanup loops. It used
excluded nonterminal entrant and historical-version setup, and it invoked
Competition maintenance explicitly. Its five scoped checks passed before
append-time version pruning. It does not qualify complete publication,
cleanup, native alarm cadence, worst-case envelopes or the full workload.

New version appends now retain the newest version and the active build's
greatest revision at or below its frozen revision, including invisible
withdrawals. In the same transaction, an independent indexed anchor seek
protects legacy history, a query inspects at most three newest candidates,
and exact primary-key deletes remove at most two obsolete rows. Starting
from fresh state, an entrant retains at most two versions during a build and
one without a build. Older backlogs still need the existing bounded sweep.
The number of versions present at one instant does not bound all candidates
visited while new updates arrive; full qualification must count those arrivals.

A separate Node 24.19.0 comparison exercised 256 real registration renames
across two authenticated players before the same real four-ply Game. It kept
all seven publication, native-delivery, cleanup and unresolved-reply checks.
Both sides published all 2,000 entrants and finished with 2,000 versions.
They used one excluded historical version per nonterminal entrant and the
same projection source; only append-time pruning differed.

| Paired local shape | Before pruning | After |
| --- | ---: | ---: |
| DO writes per real rename | 8 | 9 |
| Primary two-player settlement DO writes | 31 | 33 |
| Primary settlement DO reads | 55 | 62 |
| Projection advance calls | 70 | 65 |
| Explicit cleanup calls | 6 | 1 |
| Total DO writes, excluding account setup | 3,050 | 3,010 |
| Total DO reads, excluding account setup | 544,994 | 544,889 |

The measured ordinary deletion adds one DO write in this shape. Most deletion
writes move from later cleanup into appends; they are not free lifetime
savings. The paired workload saved 40 total DO writes and ten native calls
after cleanup. The five exact duplicate settlements stayed at three reads
and two writes each. Retained-entry accounting still dominates rename reads.
These single-run results do not establish full history, arrival, CPU, storage,
calendar or provider bounds.

Focused Arena regressions cover a second-entrant reservation conflict rolling
back the first entrant, event, versions and receipt; five retries committing
one result; mixed readiness pausing only the absent player; visible and
invisible frozen anchors across multiple updates and restart; and bounded
legacy pruning. All 14 focused Arena tests passed locally on Node 24.19.0.
Existing live and byte-stop cases still cover due queues. The row reductions
do not establish the full workload's row, CPU or latency bounds.

The direct standings stream was also measured against fresh and retained
history with the same pinned sources. Each probe exercised one real Game,
five duplicate settlements and complete publication of 2,000 entrants in
63 pages. Both passed seven checks, ended without an unresolved native reply
and left 2,000 latest versions with no snapshot rows.

| Local history shape | One initial version per seeded entrant | 23 initial versions |
| --- | ---: | ---: |
| Excluded seeded version rows | 1,998 | 45,954 |
| Projection advances | 65 | 1,435 |
| Projection DO write rows | 336 | 5,816 |
| Projection DO read rows | 5,059 | 113,342 |
| Cleanup advances | 1 | 1,434 |
| Cleanup DO write rows | 8 | 49,706 |
| Cleanup DO read rows | 134 | 177,045 |

These fixtures measure different retained-history shapes. They are not a
speed comparison. Initial metadata inserts are excluded setup, maintenance
bodies are invoked explicitly, and no terminal Game or score receipt is
seeded. The legacy case demonstrates bounded recovery without assuming old
history already satisfies the fresh pruning invariant. It does not measure
live arrivals during a full run or native automatic cadence. The feasibility
probe's advance allowance now derives from its declared historical fixture
size instead of assuming all history fits 160 passes.

The historical observed-shape worksheet reaches 7,715,594 DO writes when it
combines the fixed controller plan, Game paths, setup, registrations and 270
event projection generations. That conditional product already exceeds the
five-million-write ceiling and still omits required work. It is neither a
complete upper bound nor proof that every implementation must incur that
cost. The empty-queue fix does not establish a complete fit. A Game-only
prepaid workflow is not implemented, and controller batching alone has not
shown a fit. Keep the four readiness gates disabled until a complete finite
design, measurements and cost ledger agree within the approved ceilings.

## Fresh private ledger layout

Seven controller ledgers and the one-use wrapper dispatch ledger now use
SQLite `WITHOUT ROWID` when first created. Their explicit text or composite
keys remain the authority. Integer-key singleton tables and the separate
receipt-to-Game lookup index are unchanged. No retained table is converted,
dropped or reset. Existing ledgers keep their stored plan and conservative
accounting. A lower sealed envelope still needs verified fresh resource and
schema readback. Generic native recovery uses rowids and is not exposed by
these private wrappers.

The focused controller, native-wrapper and metering suite passed 32 tests.
Paired fresh controller probes passed eleven checks each. Their 400,000-row
retained fixture used 204,795,904 bytes before and 184,094,720 bytes after.
At the same deterministic per-call clock, a first charge changed from three
DO writes to two, a first link from six to four, begin from four to three,
retirement preparation from four to three, and ingress reservation from
three to two. Sampled unchanged methods retain their existing costs.

A companion ordinary Game probe passed seven checks on each layout. Its
thirteen-event Game lifecycle changed from 97 to 83 DO writes, including
the cold wrapper schema; the projection's 65 advances changed from 336 to
271 writes. This is a pinned local shape, not a per-operation upper bound,
latency result or full-workload saving. No controller plan or native envelope
was sealed from these samples.

The subsequent disjoint accounting review found protocol claim writes and
ordinary Competition maintenance missing from earlier partial products.
The apparent spare writes therefore cannot fund new work. No complete fit
or impossibility result has been proved. The next source change must fund
the controller's final stop read/write tail, then separate maintenance-stage
measurements before assigning finite automatic-work allowances or prepaid
Game grants. The terminal stop can latch once; repeated denied deliveries
still need a finite read allowance. These are unresolved accounting terms,
not approval to increase a ceiling.

## Independent disabled gates

All four gates remain disabled in source:

| Gate | Checked-in value | Required evidence |
| --- | --- | --- |
| `SEALED_CAPACITY_MANIFEST` | `null` | Exact source/config/resource identities, fixed UTC times, complete cost ledger and owner approval |
| `VERIFIED_NATIVE_ENVELOPES` | `null` | Complete conservative per-operation bounds, controller overhead, in-flight headroom and local native measurements |
| `VERIFIED_CONTROLLER_PLAN` | `null` | Finite method counts, conservative controller envelopes, retained-state storage, bootstrap, denial and cleanup accounting |
| `CAPACITY_PROTOCOL_READY` | `false` | Complete fixed protocol, finite faults, focused native safety and exact source review |

No HTTP request or environment variable can supply those missing values. The
private manifest and status routes report blockers without instantiating a
controller when the manifest is absent. The manifest route returns compiled
metadata only. Arming and workload routes are absent while the
protocol remains incomplete. The isolated config has placeholder resources,
no routes, no `workers.dev` or preview URL, and the unchanged 50 ms Worker cap.

The only intended bindings are fresh isolated D1, Game, Competition and run
controller resources plus fresh private authentication secrets. Unknown
bindings fail the private entry's resource check. There is no mail, queue,
Container, engine, analysis, proof, assets or production service binding.
Exact resource identity readback and bundle inspection remain required before
arming. Names and configuration shape alone do not prove isolation.

The isolated config's local Wrangler dry run passed with a 419.08 KiB bundle
and 91.85 KiB gzip output, listing only those four resource bindings. This
measures the checked local capacity sources before later edits and does not
establish a final frozen bundle or provider resource identity.

## Approved ceilings

These are proof obligations. They are not measured capacity or a provider
invoice cap.

| Whole-run dimension | Maximum |
| --- | ---: |
| Permanently charged game admissions | 20,000 |
| Synthetic credential-backed accounts | 6,000 |
| Generated Worker requests | 1,200,000 |
| Native DO request equivalents, RPCs and alarms | 1,000,000 |
| Worker CPU | 60,000,000 ms |
| DO SQLite rows written / read | 5,000,000 / 500,000,000 |
| D1 rows written / read | 1,000,000 / 100,000,000 |
| Aggregate physical DO storage | 3 GiB |
| Physical D1 storage | 512 MiB |
| Simultaneously nonhibernatable objects, all classes | 2,048 |
| Setup / admission-and-read / issue / pending-I/O close | 10 / 30 / 45 / 60 minutes |
| Regular result stream | 900 elapsed seconds |
| Stored evidence lifetime before disposal review | 30 days |

The intended workload has three 2,000-entry events and at most 1,000 combined
unfinished games. Keep normal pair, initialization, concurrency, retry,
repeat-opponent, scoring and page limits. Missing regions remain unqualified.
Do not increase a limit, move a clock, refund work or reseed a ledger to make a
failed target pass.

## Fixed-date rehearsal and calendar follow-up

The isolated full-corpus run uses a fixed real UTC minute as its arm anchor.
Its weekly event starts 110 minutes before that anchor and ends ten minutes
after it. Daily and hourly start at that end boundary. A private capability
bound to the isolated DB fixes these three native event starts. It does not
change production cadence, clocks, deadlines or event durations. Ordinary
hourly, daily and weekly calendar qualification remains a separate follow-up.

The weekly event holds the 1,000 delayed games; daily and hourly each supply
9,000 regular games and 500 later socket games. Native Competition supplies
every actual event, game, reservation and seat identity. A missing or uncertain
identity stays pending. All three events retain their overlapping windows.

| Draft phase, subject to a qualified sealed candidate | Elapsed from arm anchor |
| --- | --- |
| Earliest arm / latest arm | 00:00 / 00:30 |
| Planned account preparation, first runner only | 00:02 through 02:01.980 |
| Session artifact sealed / each runner loads once | 02:08 / 02:25 |
| Registration burst / confirmation start | 02:30 / 03:05 |
| Setup end and delayed recovery start | 10:00 |
| Regular terminal stream | 10:10 through 25:10 |
| Last delayed recovery target | 10:40 |
| Admissions and generated reads close | 30:00 |
| New native work closes | 45:00 |
| Pending native I/O closes | 60:00 |

The regular result slots run every 50 ms, from 10:10.000 through 25:09.950
after the anchor, within the full 900-second window. Weekly results must have a
real terminal outcome before its normal Game deadline. Their delayed delivery
can continue while the weekly event drains; unresolved intents prevent early
event finalization. Five exact duplicates per delayed result remain required.
The post-stream socket phase waits for the prior backlog to drain and stays
within the original cutoffs. A missed dependency stays a failure.

The driver prepares the 6,000 sessions only after arm, at 50 per second with
one offer per identity and a burst of at most two. That burst matches the old
20 ms slot schedule with its 25 ms tolerance. A finite virtual clock retains
at most one slot of credit, so timer overhead does not accumulate across all
6,000 offers and a stall cannot cause an unbounded burst. Each preparation uses
the fixed 02:08 aggregate reply deadline rather than the regular stream's
25 ms per-slot cutoff. A late reply cannot populate the credential artifact.
Every other scheduled slot retains its 25 ms cutoff. The
first runner must receive every preparation reply by 02:08 and seal one
private, exclusive session artifact. A first-tier candidate must use
`egressMode: "single-egress"`: one actual US West runner executes every work,
read and socket shard, then loads its local artifact once at 02:25. It
offers 1,190,011 requests including setup and five network controls. This
mode does not test US East, Europe, Asia Pacific, Australia or South America.
Their qualification remains unrun and is not a first-tier release gate.

The optional six-region schedule keeps its full 1,190,026 requests, including
20 network controls. It still requires reviewed external credential transfer;
execution rejects that mode before seed loading or network work. Cookies and
routing proofs stay out of traces. A missing, late or invalid artifact closes
admission. Both modes preserve all 19,000 required games, the full 900-second
stream, fixed failures and the unchanged 1,200,000 request ceiling. Schedule
arithmetic does not establish measured native throughput or regional coverage.

The Node 24 driver uses the pinned `ws` development dependency to send the
bearer, session cookie, origin and private routing proof on real WebSocket
handshakes. Node's built-in browser-style WebSocket cannot send these custom
headers. This driver package is not part of the player bundle.

The final audit requires the controller's native shutdown receipt for all
20,000 games, including 1,000 closed socket workflows, 20,001 completed native
workflows and 19,000 confirmed retirements. The receipt must report zero
pending native work, Game and Competition outboxes, projection builds,
unfinished games, sockets and alarms. Its timestamp must fall at or after
admissions close, before the hard deadline and no later than the audit. The audit retains
the 1,002 lifetime permits for the controller, Competition and socket cohort,
and checks that they match the controller's accounting. It preserves physical
storage and work reservations in the report. This receipt checks drained work;
it does not establish native eviction, storage disposal or zero provider
billing. Complete native and provider qualification remains open.

The single-egress driver issues its final status GET immediately after the
scheduled 30-minute native stop is acknowledged. It keeps the same GET count,
full workload and hard 60-minute deadline. It cannot read a successful final
audit before that acknowledgement. This removes idle waiting after shutdown;
it does not extend a work slot or qualify the deferred endurance checks.

`runLocalCapacityRehearsal()` shares the same runner, fixed dates, corpus and
deadlines. It accepts a loopback HTTP or HTTPS origin, maps HTTP and socket
traffic to that endpoint, and keeps the manifest's canonical Host and Origin.
It requires Node 24 and single-egress mode. Only the local fetch and WebSocket
adapters may be supplied. Its traces and final report say `localOnly: true`
and `qualificationPassed: false`. It does not open the provider CLI gate or
establish provider capacity, regional reach or billing.
The local HTTP adapter uses Node's standard HTTP client because Node fetch
rewrites Host. It follows no redirects. The provider runner keeps fetch.

The optional `--registration-profile` diagnostic keeps setup and at most the
first 60 seconds of registration, stopping on the first failure. It records
the user Worker's CPU profile at 2 ms intervals, capped at 32 MiB. Successful
inspector commands may omit a result; `Profiler.stop` must return a valid
profile. The profile covers metering and product JavaScript in that isolate,
but cannot measure time waiting for D1 or CPU in a separate service isolate.
This partial workload cannot pass capacity qualification. Use a new output
directory and keep private session credentials out of shared evidence.

The second full local attempt stopped after account preparation index 256
became uncertain. It retained 256 ready primary accounts, the open Competition
workflow and both lifetime permits, with zero Game admissions and no shutdown
receipt. All 676 sealed source hashes still matched. The first ingress block
had completed; obtaining the next block reused the first request's RPC stub.
A separate native loopback reproduction confirmed Cloudflare's cross-request
I/O rejection at that exact boundary. Passing the current request's grant
callback preserves the same counters and credits and passes 257 requests with
two grants. This focused regression does not pass the full rehearsal.

The third attempt retained 2,561 ready primary accounts after the old driver
skipped preparation index 397 for a 37 ms timer slip. It had no uncertain
native reply, no Game admission, no shutdown receipt and no changed sealed
source. That attempt was interrupted and remains failed evidence. Preparation
now uses the existing aggregate deadline and bounded 50/s pacing described
above. The full regular and recovery streams retain every fixed slot rule.

The fourth attempt enforced a one-offer burst and retained 5,857 ready primary
accounts at the aggregate deadline. Local timer overhead accumulated across
that stricter pacing rule, so the attempt failed and was stopped. The source
now preserves the earlier two-offer burst allowance. All four attempts remain
local failed evidence; none has armed a provider run or qualified public load.

The fifth attempt prepared all 6,000 accounts and sealed and loaded its
credential artifact on schedule. The registration burst then reached the
normal arena throttle. Its private adapter returned HTTP 200 with a denied
`ARENA_RETRY` reply, while the driver correctly expected HTTP 429. Dependent
work closed, so the run was stopped before any Game-intent request. All 676
frozen input hashes still matched. The interrupted trace remains failed
evidence, with no native shutdown receipt or provider qualification.

The adapter now preserves the native action's HTTP status. A focused native
regression registers 100 distinct accounts at one time, verifies the 101st
receives `ARENA_RETRY` through an HTTP 429 response, and admits that account
after the unchanged 20 ms token refill. The driver's existing expected-denial
check also exercises that HTTP response. These checks do not pass the full
workload.

These offsets are a source-derived draft. No provider runnable manifest is sealed.
No full rehearsal has passed. An hourly-only local run can measure its covered
paths, but leaves the complete 19,000-game, three-event requirement open.
The exact real-clock local rehearsal must precede frozen-candidate provider
approval. A later fixed minute anchor can run the same complete corpus after
local qualification and review. Keep all readiness gates disabled until their
full evidence passes. The separate real-calendar and
long-retention requirements also remain open.

## Local evidence and reproduction

Focused tests cover native cursor/D1 metering, normal receipt reuse, immutable
run identity, once-only admission, lost replies, reconstruction, month changes,
expiry, the actual SQLite 2,048-object boundary and native Game composition.
A native Competition regression verifies that a later queue event receives
the storage work from constructor-retained seat bridges.

Run from the product repository with its installed Node 24 dependencies:

```sh
./node_modules/.bin/tsc -p tsconfig.worker.json --pretty false
WRANGLER_LOG_PATH=/private/tmp/chess-capacity-tests.log \
  ./node_modules/.bin/vitest run test/capacity-meter.test.ts \
  test/capacity-run.test.ts test/capacity-native.test.ts test/budget.test.ts
WRANGLER_LOG_PATH=/private/tmp/chess-capacity-config.log \
  ./node_modules/.bin/wrangler deploy --config wrangler.capacity.jsonc \
  --dry-run --outdir /private/tmp/chess-capacity-worker-build
node scripts/probe-capacity-abort.mjs \
  --output /private/tmp/chess-capacity-abort-local.json
node scripts/probe-capacity-ingress.mjs \
  --output /private/tmp/chess-capacity-ingress-local.json
node scripts/probe-capacity-feasibility.mjs \
  --output /private/tmp/chess-capacity-feasibility-local.json
node scripts/probe-capacity-maintenance-sql.mjs \
  --output /private/tmp/chess-capacity-maintenance-sql-local.json
```

The feasibility probe defaults to 23 seeded historical versions per entrant.
Use `--history-versions 1` to measure a fresh history separately. Both variants
record their fixed entrant/history/pass limits and source hashes. The seeded
history is excluded setup. Neither variant establishes normal history growth,
the complete workload, automatic cadence or a worst-case envelope.

These commands use local workerd and native local SQLite/D1. They do not
provision or deploy resources. The dry run only checks bundling and config;
it cannot prove provider CPU, placement, identity, pricing or native billing.
One warm four-ply casual Game probe passed readiness, legal moves, resignation,
native status and delivery. That probe does not establish cold schema,
Competition workload, private alarm delivery, complete retained-state costs,
maximum-history CPU or provider capacity.

A separate one-object native workerd abort probe preserved committed SQLite,
prevented catch/continuation after `ctx.abort`, created a new incarnation and
observed no immediate alarm retry after `{ retryAlarm: false }`. The tagged
abort exception did not carry `.remote=true`; it carried an undocumented
`durableObjectReset` property. This is local lifecycle evidence, not a
documented release acknowledgment or an active-duration proof. The probe
retains this limit in its report. No permit release uses that signal.
See Cloudflare's [state API](https://developers.cloudflare.com/durable-objects/api/state/)
and [lifecycle guidance](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

## Source work required before a candidate can arm

1. Meter and bound every controller RPC, SQL row, storage change and cold
   initialization. Include grants, admission checks, linking, status, stop,
   native begin/complete calls and denied or uncertain work. Reserve complete
   in-flight, recovery and cleanup headroom before dispatch.
2. Prove native operation envelopes at their permitted retained-state maxima,
   including scans, indexes, alarm API work, schema, follow-on tasks, D1
   retries, physical growth and SQL failure. A few average samples are not
   ceilings. A scan without a proved finite bound cannot be admitted.
3. Finish and audit lifetime-permit coverage in every future private route,
   socket, alarm and follow-on caller before a wrapper is activated. The
   internal Game namespace adapter's prior permit is only one covered path.
   Reserve and meter private expiry freeze. Establish a trusted abort/
   incarnation boundary before releasing a permit, while preserving it on
   transport uncertainty. Prove that no test work can continue beyond 60
   minutes. Handler return or idle eligibility cannot substitute for a shutdown
   boundary. The implemented no-socket incarnation retirement path has a small
   local native probe, not complete workload or provider qualification. Without
   confirmed retirement, the two permanent permits leave at most 2,046 linked
   Games, which cannot meet the required 19,000-game workload.
4. Complete the fixed synthetic account/event setup and normal primary-session
   routes, run-ID rejection before Game stubs, real public cache reads and
   finite delayed-result/D1 fault gates. The client must not choose SQL,
   authorities, resources, time, policy, FEN, results, alarms or counters.
5. Build and seal the Node 24 fetch/WebSocket protocol driver and legal short
   game corpus. Measure driver CPU/RSS, request concurrency, offered versus
   admitted versus acknowledged traffic, missed schedules and every failed
   target. Prove the finite safety bounds and run the focused native safety
   command before sealing. The full 19,000-game performance gate runs against
   the isolated provider candidate.

## Sealing and provider approval

After the source gates pass, freeze exact source, dependencies, bundle,
config, corpus, fault controls and driver. The v2 sealer requires the
[focused safety record](capacity-local-rehearsal.md#required-focused-safety),
including retained failed full-local reports. Supply exact digests, fixed UTC
times, fresh isolated resource identities, the named actual client egress and
independent stop instructions. Read back available account billing and usage
without claiming delayed reports establish invoice headroom. Missing prices
or incomplete reporting stay visible as unknowns. They do not create another
financial approval gate. The one-run $25 incremental ceiling, runtime work
ceilings, $100 monthly target and existing alerts and stops remain in place.
Bind the actual candidate to the owner's execution authorization before live
load. A hash alone does not authenticate that authorization.

No provider execution, new capacity claim or public launch gate can be inferred
from this guide. Even a passing isolated run will not prove 72,000 hot payloads,
25-per-second retirement after the real one-hour hold, evidence-hold growth,
ranked cost, hourly/daily/weekly alarm cadence or the later 10,000-entry and
5,000-live tier. Those need their own bounded measurements.

## Provider attempt on 22 October 2026

The isolated candidate armed, then failed during synthetic account setup.
The driver offered 145 account preparations, acknowledged 11 and retained
134 uncertain outcomes. It admitted no games. The controller is permanently
stopped with two lifetime permits and one unresolved Competition workflow.
Its prepaid allowance and all uncertain work remain charged. This attempt
does not qualify tournament capacity.

The driver has finished. Its complete compressed trace and paginated provider
inventory confirm zero Game objects, one Competition object and one controller.
Native shutdown is unconfirmed, so the two permits and unresolved dispatch
remain reserved. The temporary network exception was removed, with every other
rule unchanged.

A later preparation reached Better Auth startup before the first native
preparation finished its D1 work. The later call had a 128-row D1 read
allowance. Startup exceeded that allowance and stopped the workflow; the
reported completion errors followed that stop. The preparation allowance
was raised to 640 reads within that candidate's Competition lifetime envelope. A focused
local regression forced that ordering: the later call used 522 reads, the
first call used five, and both settled with no stop or unresolved reservation.
That regression verifies the correction, not the full provider workload.

Any successor must retain this failed record and every prior measured or
uncertain charge in the combined $25 test ledger. A new identity cannot erase
the first attempt or grant another $25 allowance.

Three later provider attempts also failed before admitting a Game. Their
original traces and identities remain retained. The third attempt's original
arm delivery is uncertain; its later diagnostic found no armed row and zero
primary users, games or admissions. That diagnostic does not erase the
uncertain delivery.

The fourth attempt received 297 successful preparation responses and retained
11 uncertain requests before an owner stop. A later provider read found 302
users, credentials and sessions, zero games, admissions or game receipts, and
zero Game, one Competition and two controller objects. One controller belongs
to the earlier unarmed attempt on those same isolated resources. The accepted
fourth stop still held two lifetime permits and one unresolved dispatch, with
no native shutdown receipt. Across the retained failures, six lifetime permits
and three known unresolved dispatches remain held. Object listings cannot
prove that native calls, alarms or sockets have stopped.

The confirmed local repair batches 32 fixture accounts while preserving all
6,000 primary identities and normal registration checks. Its complete local
preparation probe passed with a ten-second first-batch delay and a 6,309 ms
credential-deadline margin. See the [bounded preparation diagnostic](capacity-local-rehearsal.md#bounded-account-preparation).
This is preparation evidence only.

The fifth provider attempt prepared all 6,000 primary accounts, then filled
the 256-request registration inflight limit. All 256 registration replies
timed out at five seconds. The trace acknowledged no registration and no
Game admission. Its owner stop retained two permits, one unresolved dispatch
and no native shutdown receipt. The five failures together retain eight
permits, four unresolved dispatches and zero known charged Game IDs.

Provider measurements showed low CPU and roughly five-second wall times for
these calls. They support a wait or queue delay; they do not identify its
exact cause. The reviewed registration repair takes the normal rate token
before primary account reads and avoids repeated authentication when returning
the accepted registration view.

### Short registration diagnostic

The sealed `registration-diagnostic-v1` profile isolates that repair. It uses
256 real primary users, credentials and sessions, eight existing 32-account
preparation batches, and exactly 768 unique registration ordinals. It offers
one request every 3 ms, with 256 inflight requests and a five-second response
deadline, inside a fixed 90-second window. Only normal successful replies and
HTTP 429 `ARENA_RETRY` replies count as completed outcomes. Accepted accounts
are counted once across all three attempts.

Both the private entry and native wrapper reject queue, Game, socket, proof,
spectator, cache-load and fault work in this profile. It reserves no Game
workflow. Its exact native stop must find zero Game bindings and queues,
drained results and projections, no sockets or pending native work, deleted
alarms, and one completed Competition workflow. Fixture, entrant and claimed
step counts come from native state. A partial or uncertain stop cannot pass.

This diagnostic measures one short registration burst. It does not qualify
2,000-player tournaments, sustained throughput or the complete launch workload.
The full profile retains its original corpus and 900-second result stream.
Each candidate must retain the shared cost and uncertainty ledger, fit its
finite work bounds, and pass root review before execution. No diagnostic
provider result has been accepted in this source record.

The sixth provider attempt prepared all 256 accounts, offered 238 of the 768
registration requests, and received 56 normal retry replies and 182 HTTP 503
failures. Its durable stop reason was `controller-call-allowance`. The plan
funded only eight ingress grants, which assumed Worker reuse. The complete
trace retains that failed stop, two lifetime permits and one unresolved
Competition dispatch. The file originally named `final-provider-status.json`
contains the initial status, not shutdown evidence. A separate corrected stop
record preserves the actual failed state.

The repaired diagnostic funds one full grant for each of its 776 possible
ingress requests. A native local regression first reproduced the eight-grant
failure and then completed all 776 fresh Worker consumers under the same
ceilings. Arm issues one signed Competition workflow ticket, which stays in
the private driver's memory and reaches later Competition requests in a private
header. New Worker instances no longer begin that same workflow again. Stop
recovers only the saved durable ticket and can drain it after a stop. It never
opens replacement work. The driver still sends its one final status after a
failed or uncertain stop; the recorded failure cannot qualify the run.

The full profile offers 1,184,194 funded ingress requests. Its 4,687 blocks fund
1,199,872 slots plus 32 separate control requests. That leaves 15,678 funded
slots above the offered workload. This is a finite allowance, not proof that
all requests can run from fresh Worker instances. Every abandoned block stays
spent. Actual diagnostic grant usage must be checked before a full provider
run. Confirmation offers retain all 6,000 account ordinals and now run at
40 per second, below the unchanged production policy of 50 per second with a
100-request burst. The 10,000-request burst and full result stream stay fixed.

### Bounded D1 read retries

D1 can retry a read-only query twice. Its row metadata reports the final
attempt. The private candidate retains that measurement and charges a separate
conservative surcharge for earlier attempts. Missing row metadata, a write
retry, a fourth attempt or work above the admitted bound stops the run and
retains its reservation.

Warm primary authentication uses two indexed queries. The fixed isolated
corpus has one credential per user; it does not assert that `account.userId`
is globally unique. Warm standings use indexed event and page lookups. Source
plans allow eight rows per warm request, including index work and the missing
page fallback. Local native metadata measured four rows for authentication
and three rows for representative populated standings pages. Those local
samples support the lookup audit; they are not provider capacity evidence.

Each permanently prepaid block of 256 ingress requests reserves 6,144 warm
reads and 1,920 startup reads, or 8,064 total. At most 4,687 blocks reserve
37,795,968 reads without assuming a cache hit. Native workflow reservations
cover three complete read passes and total 56,616,000 reads for the fixed
corpus. Their combined 94,411,968 rows fit the unchanged 100-million-read
per-run cap. Other request, CPU, storage, write and active-object caps remain
unchanged.

The 100-million-read cap applies to each run. The $25 capacity spending
ceiling and 20,000 permanent Game IDs cover all retained attempts together.
Failed reservations remain in the combined cost ledger. They are conservative
charges, not measured completed work or an invoice. Eight failed attempts
retain fourteen lifetime permits and six known unresolved dispatches. The
eighth prepared all 6,000 primary accounts, then its first registration burst
filled 256 inflight slots before a response. It acknowledged 112 accepted
registrations and 180 normal retry replies, with 110 transport timeouts and
1,266 locally saturated slots. Owner stop was saved, the driver was terminated
and its exact temporary bot-filter exception was removed. Native reads found
zero Games, admissions and Game budget receipts. Native shutdown remains
unconfirmed. Its complete trace prefix and all earlier failed evidence remain
retained. The local auth-placement repair does not qualify provider capacity.

Standings responses and driver traces expose final-attempt rows and retry
surcharge separately. A cache hit records zero for both. A miss permits up to
eight measured rows and a surcharge of zero, eight or 16. The sum cannot exceed
24. Native workflow state persists the surcharge across reconstruction.

### Prepaid registration guard repair

A focused native local check exercised 100 accepted registrations and 60
normal HTTP 429 `ARENA_RETRY` replies. One complete 32-retry block measured
four guard row writes: three for reservation and corpus bits, zero for each
middle event, and one final checkpoint. The same check lost a native reply,
rejected replay without redispatch, retained all 32 slots, and rejected a cold
host's next operation. Separate native SQLite checks covered the final
16-slot block, atomic bitmap conflict, a stopped overrun and permanent bits.
These checks prove local guard behavior. They do not establish provider
latency, throughput, billed spend or full-workload qualification.

The ten-attempt ledger retained eighteen lifetime permits, eight unresolved
native dispatches and 300,272,512 conservative D1 read reservations, with zero
known Game charges. That historical ledger remains unchanged.

### Overlapping registration preflight

The eleventh provider attempt prepared all 6,000 primary accounts. Its burst
offered and acknowledged 5,054 requests: 1,951 accepted and 3,103 normal retry
replies. Another 4,946 slots saturated locally. Saturation first occurred at
770 ms, before the first acknowledgement at 1,460 ms. Three later confirmation
requests were accepted and one was uncertain. No Game workload began. Owner
stop was read back, the exact driver exited and its temporary bot rule was
removed. The original incomplete trace and recovered complete prefix remain
retained. Native counts showed zero Games, admissions and Game receipts;
inventory freshness and native shutdown remain unconfirmed.

All eleven failures and the unarmed DNS closure now retain twenty lifetime
permits, nine unresolved dispatches, zero known Game charges and 359,025,472
conservative D1 read reservations across attempts. These are reservations,
not measured billed work. No failed work or uncertainty is refunded or reset.

After spending its normal registration token, registration now starts the
primary credential/restriction check and game-budget preflight together. The
private preflight also overlaps Controller availability with its D1 allowance
read. Both branches settle before return. Account errors retain precedence;
stops, current session expiry, atomic Game admission and normal retry behavior
remain enforced. A denied account may now perform the already funded budget
read that sequential code skipped. Valid actors use the same queries.

The per-registration envelope remains 384 D1 read rows across three bounded
passes, 16 D1 writes, 64 DO writes and 16,384 DO reads. Each registration can
make at most one availability call. The fixed 16,000 registrations and 40,000
queue requests therefore still fit the full Controller's 56,000 availability
calls. The short diagnostic's 768 registrations fit its 768 calls. This repair
changes no work allowance, request cap, corpus, schedule or run identity.

Twelve focused local checks passed on Node 24.22.1, covering concurrent checks,
error order, live eligibility, stop/last-slot behavior, registration races,
lost replies, held slots and native alarm coalescing. A 32-registration local
native burst completed in 47 ms with two alarm passes and a proved zero-Game
stop. The maintained package session read and its concurrent token-indexed
credential companion consumed five warm D1 rows across two statements after
real fixture preparation warmed the stable package context. The check enforced
the unchanged eight-row single-attempt bound and 24-row three-attempt allowance,
with zero writes, retries, unresolved reads or uncertainty. Worker types also
passed. These local results establish behavior, not
provider throughput. The prior provider retry median was 813 ms; 256 inflight
slots at 3 ms spacing allow only 768 ms of mean residency at a sustained burst.
Preflight overlap does not change that retry path. Provider headroom and the
complete workload remain unproved, and no further provider run is authorized
by these local checks.

### Initial arm and status ordering

The twelfth provider attempt offered arm at +3 ms and initial status at
+1,002 ms. Status returned HTTP 500 at +1,730 ms, before arm acknowledged at
+1,834 ms. No fixture, registration or Game request was offered. Source allowed
status to reach a cold controller before its arm ledger row existed, and the
private status route sat outside the bounded error catch. No exception trace
establishes the actual object execution order.

The arm-owning runner now waits for its exact validated arm promise before
making the one initial status request. A denied, invalid or failed arm permits
no status request. The status job retains its +1-second slot; the first fixture
retains +8 seconds. Both network calls retain five-second timeouts. If their
combined delay exceeds the first fixture slot, that fixture fails its existing
readiness gate. No slot moves, retry, rearm or timeout extension is added.
Private status failures now use the existing bounded error response, including
the fixed controller-call denial code.

One later status confirmed the twelfth attempt's saved owner stop. The original
stop reply and HTTP status remain unknown. The driver group exited and its
temporary bot rule was removed. Primary counts were all zero. Native shutdown
and namespace-inventory freshness remain unconfirmed. The combined twelve
failed attempts and unarmed DNS closure retain 22 lifetime permits, ten
unresolved dispatches, zero known Game charges and 415,641,472 conservative
D1 read reservations. These reservations remain spent for admission accounting.
They are not a measured invoice. The earlier records and uncertainties stay
unchanged.

### Registration work concurrency

The thirteenth provider attempt passed startup and prepared all 6,000 primary
accounts. The fixed registration burst saturated 256 inflight requests at
index 259, 777 ms after registration began. Its retained complete trace prefix
contains 2,274 offers, 1,269 accepted replies, 918 expected retry replies and
87 uncertain requests. No Game binding, admission or Game receipt was found.
The saved owner stop was confirmed, the exact driver exited and its temporary
bot rule was removed. Native shutdown remains unproved. All thirteen attempts
and the unarmed DNS closure retain 24 lifetime permits, eleven unresolved
dispatches and zero known Game charges. Earlier records stay unchanged.

Accepted registration replies had a 4,024 ms median and 4,735 ms p95. The
normal native method interval had a 2,276 ms median; expected retries reported
zero for that interval but a 1,677 ms median total response. These intervals
do not isolate remote I/O, interleaved work or durable RPC gates. Standings
publication already runs in maintenance, outside the registration response.

`ArenaControl` now admits at most 16 new-entry registration preflights at once
across its events. A busy request returns `429 ARENA_RETRY` without queuing,
spending a token or starting native eligibility/budget reads. Admitted calls
keep the existing durable token and fresh session, credential, restriction
and budget checks. Every admitted new-entry slot releases in `finally`,
including eligibility and storage-sync failures. Existing registered entries
keep their fresh checks and bypass this new-entry limit, so busy new joins do
not turn an existing confirmation into a retry.

One focused local regression covers that bound, immediate rejection, existing
confirmations and release after eligibility and storage-sync failures. Worker
types pass. The 16-slot choice remains a measurement candidate.

The fourteenth attempt used the unchanged 256-account, 768-registration, 3 ms,
256-inflight, 90-second diagnostic. It prepared all accounts, offered 284
registrations and received every reply within 2,408 ms: 70 accepted replies
covering 62 distinct entrants and 214 expected retries. The driver then hit
its 256-request cap. Its failure latch left 188 slots saturated and 296
dependent slots unresolved. No Game work ran. The scheduled stop acknowledged
drained native work with no sockets, alarms, outboxes or unfinished Games.
The exact driver exited, its temporary bot rule was removed, and primary D1
readback showed zero Games, admissions and Game receipts. The incomplete
768-slot diagnostic remains failed. All fourteen attempts and the unarmed DNS
closure retain 26 lifetime permits and eleven unresolved dispatches from the
combined history, with zero known Game charges and no refunds or resets.

The successor full candidate raises only the driver's fetch bound to 2,048.
At the unchanged 3 ms burst spacing and five-second response deadline, at
most 1,667 burst requests overlap. The short diagnostic keeps its 256-request
bound. Final confirmations use fixed 67 ms spacing, about 14.93 per second,
so the 16-slot native gate has room above the observed 698 ms maximum new-entry
method duration. Every one of the 6,000 final confirmations retains its
five-second deadline before that account's first queue slot. The smallest
remaining margin is 2,050 ms. The last confirmation is offered at setup second
592.933 and its response deadline is second 597.933. All Game, fault, recovery
and stream slots remain unchanged. This candidate
has no provider performance pass. Full-load execution still requires its own
frozen review.

The next sealed candidate missed its fixed start and was retained as an
unarmed closure. A new identity reused its resources after primary zero counts
and complete empty namespace inventories. No native data or counters were reset.
That full run passed preparation of all 6,000 primary accounts, credential
sealing and loading, then failed in the registration burst. It offered 1,671
registrations before the first five-second uncertainty latched further work
closed. The retained trace has 55 accepted registrations, 1,353 expected retry
replies and 263 timed-out replies. Peak client concurrency was 1,214, below the
2,048 bound, and maximum offer lateness was 9 ms.

Completed retry replies spent a median 1,456 ms and p95 3,568 ms in Worker
primary authentication, with a zero native method interval. Accepted replies
spent a median 1,491 ms in primary authentication and 670 ms in the native
method. Requests which timed out before headers have no server-stage timing.
Cross-object epoch timestamps showed clock skew and do not isolate queue time.
The exact driver stopped, the single owner stop was later confirmed persisted,
and the temporary bot rule was removed. Primary D1 has zero Games, admissions
and Game receipts. Two lifetime permits and one unresolved workflow remain
held for this run; no native shutdown receipt was obtained.

The product and qualification Worker now share a nonqueued 16-call isolate
gate before primary authentication. Overflow returns the existing registration
`429 ARENA_RETRY` reply without primary D1 or native authority work. In the
private runner it still follows authorization, fixed windows and prepaid ingress.
Every admitted request retains package authentication and the authority's fresh
eligibility, rate, budget, entry and storage checks. The gate applies to new
registrations and confirmations, releases in `finally`, and does not claim a
global concurrency or throughput bound. Cloudflare's rate-limit binding counts
requests over time, so it does not replace this outstanding-work bound.

The sixteenth provider workload completed the unchanged 10,000-offer burst:
629 registrations were accepted and 9,371 received normal retry replies.
There were no transport failures. The fixed final-confirmation pass accepted
93 calls, then the native 16-preflight limit rejected slots 10,093 to 10,095
during an eligibility stall. The driver correctly stopped dependent work at
slot 10,096. Native method intervals reached 3,200 ms. Ignoring these replies
would leave required entrants missing and cannot qualify the workload.

The exact scheduler stopped, the single owner-stop reply remained uncertain,
and a later raw status confirmed persisted `owner-stop`. Its two lifetime
permits and one unresolved dispatch remain held without a native-shutdown
claim. Primary D1 and the complete Game namespace inventory show zero Games,
admissions and Game receipts. The temporary bot rule was removed. All sixteen
failed workloads and two unarmed closures retain 30 lifetime permits,
13 unresolved dispatches and 606,093,952 controller D1 read reservations.
These reservations are not a measured invoice. No counter or allowance resets.

The next candidate separates the two concurrency policies: Worker primary
authentication stays at 16 outstanding calls per isolate, while the authority
admits at most 64 new-entry preflights. At the fixed 67 ms confirmation spacing,
a 3,200 ms eligibility stall requires 48 concurrent checks. The native bound
therefore covers the observed interval while keeping the early filter, fresh
checks, durable rate bucket and every finite workload ceiling. A focused local
regression reproduces the 96-call prefix with that spacing and stall: the old
16-call policy rejects required entries. The 64-call policy still needs its
own provider qualification. This change adds no driver retries or ignored
required replies, changes no schedule slots, and grants no new financial scope.

That seventeenth workload prepared all 6,000 primary accounts and credentials,
then failed during the burst. Its retained trace contains 1,757 offers,
154 accepted replies, 1,544 normal retries and 59 five-second timeouts. Before
the failure latch, Worker authentication p95 rose to 3,197 ms and native method
p95 to 1,742 ms. The preceding 16-slot workload completed all 10,000 burst
offers without a transport failure. More concurrent native eligibility reads
increased shared primary-read pressure; the larger outstanding bound alone
did not qualify capacity.

The exact driver stopped, a later raw read confirmed the single owner-stop,
and the temporary bot rule was removed. Primary D1 retained all 6,000 accounts
with zero Games, admissions or Game receipts. Native shutdown remains unproved.
All seventeen failed workloads and two unarmed closures retain 32 lifetime
permits, 14 unresolved dispatches and 663,766,336 controller D1 read
reservations. These reservations are not a measured invoice. No refunds,
counter resets or new allowance.

The next candidate retains the 64 outstanding native checks and the 16-call
Worker isolate gate. It reduces the native new-entry bucket from 50 per second
with a 100-request burst to 16 per second with a 16-request burst. This limits
new expensive reads while allowing the fixed 67 ms confirmation pace, about
14.93 per second, to retain 48 pending checks during a 3,200 ms stall. Existing
entries retain fresh checks without spending a new-entry token. A focused
regression covers initial burst shedding followed by the fixed confirmation
prefix, with every final reply inside its five-second deadline. This candidate
still needs its full provider workload. Driver counts, deadlines, relative
schedule, result stream and finite ceilings remain unchanged.

### Global registration authentication order

The eighteenth workload prepared all 6,000 primary accounts, then failed during
the burst. It offered 1,942 registrations, received 93 admissions and 1,809
expected retries, and retained 40 uncertain five-second responses. There was
no Game work. The exact driver stopped, persisted owner-stop was read back,
and the temporary bot rule was removed. All eighteen failed workloads and two
unarmed closures retain 34 lifetime permits and 15 unresolved dispatches, with
zero known Game charges. No native shutdown, refund or reset is claimed.

The completed native-denied replies had already performed Worker cookie auth.
Their auth p95 was 2,395 ms; the per-isolate filter did not bound all isolates'
primary reads. The local repair moves actual Better Auth and the account write
limit inside Competition's global 16-call authentication guard. It releases
those slots before the existing 64-call eligibility stage and unchanged
16-per-second new-entry bucket. Existing confirmations still retain fresh
checks without spending a new-entry token. Origin and 1 KiB empty-body checks
remain before native dispatch. The private workload uses that same native
authentication entry and then checks its fixed fixture identity.

Fixtures and normal native authentication share one stable package context
with the production cookie policy and a database proxy charged to the current
event. Schema discovery is awaited inside its funded event. The existing
conservative Worker ingress reservations stay charged. No envelope is increased.
Seventeen focused local registrations measured at most 14 D1 reads, three D1
writes, 41 Durable Object writes and 84 Durable Object reads per response,
with no unresolved I/O. Focused regressions also cover global shedding before
auth, release on primary failure, forged identity, live credential removal,
and release before slow eligibility. These checks do not qualify provider
latency or the full workload.

Epoch timestamps from different Worker isolates showed clock offsets,
including negative intervals. They cannot measure dispatch, input gating,
output gating or RPC transport. Same-isolate performance-clock durations remain
usable. Timed-out requests returned no server-stage timing. The original
compressed trace and original timing analysis are retained unchanged.

### Cold registration claim order

The nineteenth workload prepared all 6,000 primary accounts, then stopped
after 360 registration offers. It retained 23 accepted replies, 336 expected
retries and one rejected HTTP 200 reply. No registration response timed out
and no Game work began. The driver did not retain that rejection's code.
Frozen source makes `capacity_step_already_issued` the only reachable shape
with that status and rejection, so the diagnosis is source-inferred.

A focused test reproduces the race in the frozen candidate. Its cold
registration waited for primary authentication before claiming its corpus
bit. A concurrent warm registration prepaid the same 32-slot block, which
marked the cold request's bit first. The repair claims the cold request's
exact bit before authentication, after funding its existing cold event.
The unchanged block guard falls back to individual claims when it overlaps
that bit. One shared initializer owns the existing protocol table.

The local regression now accepts both legitimate overlapping requests,
repeats after clean reincarnation, and rejects a cold replay. The separate
interrupted-block check still rejects reconstruction and retains unused
slots. The driver retains only known rejection codes, including on HTTP 200;
it still fails the workload on unexpected denials. None of these checks
qualifies provider capacity.

The stopped provider run's owner-stop was read back, its exact driver exited,
and its temporary bot rule was removed. All nineteen failed workloads and
two unarmed closures retain 36 lifetime permits and 16 unresolved dispatches,
with zero known Game charges. Their controller D1 read reservations total
777,925,696. These are conservative reservations, not invoice measurements.
The same combined $25 test ceiling remains within the $100 monthly target.
No native shutdown, refund, counter reset or new allowance is claimed.

### Lost registration replies and fixed confirmations

The twentieth workload prepared all 6,000 primary accounts. It offered 1,785
registrations, received 86 accepted replies and 1,698 normal retry replies,
then retained one `TimeoutError` at 5,001 ms. That request returned no HTTP
status, failure code or native timing. Its native completion is unknown.
The driver closed later work before the planned confirmations. No Game ran.
A later read confirmed the single saved owner stop, zero charged Game IDs,
two held permits and one unresolved dispatch, without native shutdown.
The exact driver exited and both temporary bot rules were removed.

The driver now lets only a timed-out full-workload burst registration reach
its existing fixed confirmation. It adds no retry, identity, request or time.
The confirmation must return the same account's accepted native membership
in its fixed event. A different account or event cannot resolve it. The
original timeout, latency and charged work remain in the record; final totals
separate resolved and unresolved replies. An unresolved reply still fails.
Uncertain controls, Game work, confirmations, server errors and invalid
responses still close dependent work. Native shutdown and the full required
Game workload remain separate requirements. These local checks do not pass
provider qualification.
