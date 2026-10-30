# Local arena and settlement qualification

These checks use native Cloudflare `workerd`, SQLite, D1 and Game Durable
Objects on one developer machine. They establish local behavior and measured
service times for the workloads below. They do not establish a public arena
capacity, deployed resource limit, worldwide latency or monthly cost.

The public admission limits remain closed. Keep the conservative defaults in
[the arena design](arena-design.md#configuration-and-conservative-defaults).
The production release and regional gates remain separate.

## Reproduce the checks

Use Node 24 and the locked product dependencies. The tests create isolated
local D1 data. They do not connect to a production database or create paid
resources. The Cloudflare test runtime needs permission to open a loopback
server.

```sh
npm run qualify:local -- --quick
npm run qualify:local
npm run qualify:local -- --three-events --quick
npm run qualify:local -- --three-events
npm run qualify:local -- --sustained --quick
npm run qualify:local -- --sustained
```

The default phase uses 2,000 existing credential-backed accounts and 1,000
real Game objects. The three-event phase uses 2,000 accounts per event,
6,000 distinct accounts, and 1,000 combined Game objects. `--quick` uses
128 entrants per event. The sustained phase runs for 900 elapsed seconds;
its quick option runs for ten seconds and is smoke evidence only.

Each command saves its stdout, stderr, Wrangler log, measurements and report
under `.qualification/<UTC timestamp>/`. The report records the exit code,
host and package versions. The current wrapper also fingerprints the affected
runtime, migration, configuration and phase source before and after the run.
Inspect `sourceChangedDuringRun` before comparing a result with later source.
Raw logs stay ignored. Selected passing full reports are retained in
`docs/qualification/` for review.

The harness uses the maintained Cloudflare Vitest integration and its public
Durable Object test helpers. It does not change runtime admission caps,
production counters or monthly allowances. Existing D1 account fixtures
represent credential-backed accounts, with no recovery email. They skip
signup, password hashing, Turnstile and email delivery.

## Machine and interpretation

Measurements were collected on 2026-10-21 UTC, or 2026-10-20 Pacific:

| Item | Value |
| --- | --- |
| Machine | Apple M4 Pro, 12 logical CPUs, 24 GiB RAM |
| OS | macOS, Darwin 25.5.0 |
| Node | 24.19.0 |
| Vitest / Cloudflare integration | 5.0.5 / 1.4.6 |
| Wrangler / chess.js | 4.151.3 / 1.4.0 |

RPC latency includes the local private binding and commit. It excludes public
HTTP, internet routing and browser work. It is not a CPU measurement.
`/usr/bin/time -l` reports the maximum resident size of the local command;
this is not a Game object's memory requirement or the provider's memory use.
Some phases ran alongside the sustained settlement check on this machine.
These results are single runs, not repeated hardware benchmarks.

## Native arena, sockets and retirement

The native arena phase checks a real complete workload:

- 10,000 logical registration arrivals over 30 seconds from 2,000 accounts,
  including duplicate requests and truthful busy responses. Retries must leave
  exactly 2,000 registrations.
- 1,000 accepted Game objects, two ready players and a legal move per game.
- 2,000 participant WebSockets and a burst of 2,000 replacement connections.
- 1,000 unique real terminal results and five duplicate deliveries per result,
  with exact score receipts and entrant totals.
- Complete paged D1 standings, reservation release, finalization and real
  Game outbox acknowledgements.
- 1,000 actual Game archives and D1 acknowledgements, preserving all permanent
  IDs and replay records.

Registration arrivals, event cadence and the one-hour hot-payload hold use a
virtual policy clock. Service measurements use `performance.now()`. Retirement
token refill follows actual elapsed time. A logical 30-second registration
window is not a public registrations-per-second result.

The final native run passed with unchanged source fingerprints in
[the retained report](qualification/2026-10-21-native-arena.json), originally
`.qualification/2026-10-21T00-36-01-105Z/report.json`. An earlier passing rerun
detected concurrent recovery-hook edits and was replaced by this stable run.

| Measurement | Passing native run |
| --- | --- |
| Accounts registered initially / after retry | 1,597 / 2,000 |
| Local legal-move service p95 | 19 ms |
| Participant reconnect burst | 2,000 in 1,289 ms |
| Unique terminal settlement | 1,000 in 1,420 ms, p95 33 ms |
| Full standings and reservation release | 2,425 ms, 63 pages |
| Competition SQLite after result burst | 9,990,144 bytes |
| Real archive plus D1 acknowledgement | 1,000 in 30,263 ms |
| Archive rate after the initial 32 | 32.042 successes per second |
| Whole command max resident size | 1,193,721,856 bytes |

Retirement uses the explicit `scaled` mode, 32 candidates per pass, four RPCs
in flight and a persisted 32-attempt-per-second bucket with a burst of 32.
Focused tests separately cover held and failed oldest records, concurrency,
eviction, exact digest conflicts and lost acknowledgement recovery. The batch
rate above measures clean eligible records; it is not a mixed-hold endurance
measurement.

### Storage reclamation limit

A sample short game had 1,072 bytes of state and four command receipts. After
archival it had no heavy state or command receipts and retained one 584-byte
tombstone. Its SQLite allocated size remained 53,248 bytes before and after.
Logical payload removal passed. Physical page reclamation and billed storage
reduction are unproved. Replay, permanent identity, tombstones and immutable
results continue to occupy storage.

At 20 completions per second, the mandatory one-hour hot hold alone requires
72,000 completed payloads. This single 1,000-game batch does not establish that
steady state, growth over many events, permanent-record cost or a fit within
$100 per month. Retirement never resets a ledger or reuses an ID.

## Three simultaneous events and recovery

The full three-event phase passed against unchanged source fingerprints in
[the retained report](qualification/2026-10-21-three-events.json), originally
`.qualification/2026-10-21T00-34-57-065Z/report.json`.

It exercises the real Sunday 18:00 UTC boundary: weekly rapid drains while
daily rapid and hourly blitz start. Each event has 2,000 entrants. There are
333 weekly games, 333 daily games and 334 hourly games, with 2,000 distinct
seated players. Every game accepts readiness and a legal move. One terminal
verification call is made unavailable, then Competition is evicted and
restored before all 1,000 real results and 5,000 duplicates are delivered.

| Measurement | Result |
| --- | --- |
| Registration fixtures and actions | 6,000 distinct accounts across three events |
| Local blitz move p95 | 17 ms, 334 samples |
| Local rapid move p95 | 28 ms, 666 samples |
| Unique native results after eviction | 1,000 in 1,473 ms |
| Score receipts / aggregate played-game entries | 1,000 / 2,000 |
| Competition SQLite after settlement | 11,956,224 bytes |
| Complete standings | 63 pages for each event, exactly 2,000 distinct rows each |
| Game outboxes acknowledged | 1,000 |
| Finalization | All three finished with no unresolved games |
| Whole command max resident size | 1,030,586,368 bytes |

This recovery burst does not include simultaneous continuing native-game
traffic. The separate synthetic phase below measures continuing settlement
traffic with different limits.

The check found and now protects a cadence regression. Due running and draining
events must close before scheduled starts consume open slots. Otherwise the
empty previous hourly event can temporarily consume the third slot and cancel
the next hourly event. The fix preserves the six-row lifecycle pass and the
three-open-event cap. Its focused regression failed before the fix and passed
after it, alongside the existing arena and retirement tests.

## Sustained synthetic settlement phase

The full 900-second run passed. Its measurements are retained in
[the sustained report](qualification/2026-10-21-sustained.json), originally
`.qualification/2026-10-21T00-23-21-153Z/report.json`.

| Measurement | Result |
| --- | --- |
| Actual elapsed window | 900,003 ms |
| Regular synthetic results | 18,000, paced at 20 per second |
| Unique acknowledgement latency | p95 14 ms, maximum 126 ms, 19,000 samples |
| One-second work batch | p95 36 ms, maximum 227 ms |
| Delayed unique results during regular traffic | 1,000 in 355 ms |
| Duplicate delayed results | 5,000 in 856 ms |
| Exact accepted identities / D1 game projections | 19,000 / 19,000 |
| Pending D1 outbox rows | Peak 976 after catch-up; zero after final drain |
| Competition SQLite after final drain | 25,223,168 bytes |
| Whole command max resident size | 558,432,256 bytes |

The coordinator was evicted and restored after five minutes. This run began
before the cadence fix and separate recovery-hook additions. Its report has
start fingerprints, but predates the wrapper's end-fingerprint check. The
later native arena and three-event passes use stable updated fingerprints.
Do not describe the sustained run as full-duration testing of those later
source changes. It also ran alongside other local qualification phases.

This phase feeds 20 unique pre-admitted terminal results per elapsed second
for 15 minutes. It evicts and restores Competition after five minutes. At the
halfway point, it releases 1,000 delayed unique results and 5,000 duplicates
alongside normal traffic. It uses native Competition SQLite, normal bounded
D1 projection passes and exact identity checks.

Terminal `Game.status` verification is replaced by a deterministic fixture
based on one real native seed Game. Apart from that seed, the phase creates no
Game objects, admissions or monthly work receipts. It does not measure
18,000 real Game objects,
production admission, credential load, participant sockets, rated Glicko work
or provider alarm delivery.

This distinction is required by the current allowance: 20 new game results
per second for 15 minutes needs 18,000 games, exceeding the 10,000-game hard
monthly maximum. The synthetic fixture isolates settlement throughput. It
does not bypass or qualify that production admission limit.

## Gates still open

- Public HTTP, account creation and password hashing under load, Turnstile,
  recovery email delivery, authentication limits and D1 contention.
- Provider alarms, eviction and outages in the deployed service.
- 10,000 public standings viewers and real cache hit rate.
- Deployed move CPU, per-object memory, projection age and regional pairs in
  US West, US East, Europe, Asia-Pacific, Australia and South America.
- Combined ongoing native admission and outage recovery for the target
  duration within an authorized allowance.
- At least 72,000 hot payloads, physical storage behavior, permanent-record
  growth and long-run archive throughput with evidence holds.
- Measured cost per 1,000 games and per 10,000 spectator-hours, including auth,
  retries, storage and active-object duration, within the $100 monthly scope.

Use these local results to plan the next bounded qualification. Do not raise
public ceilings, open ranked play or advertise worldwide capacity from them.
