# Local capacity rehearsal

The local runner exercises the fixed isolated workload for diagnosis. It is
not a deployment command or provider approval. Its source-owned trial
allowances remain unqualified. A failed allowance or unfinished target remains
a failure.

## Required focused safety

The initial release requires focused local safety and the full provider
workload. A second full local performance pass is not a sealing prerequisite.
Use Node 24 and a fresh private directory:

```sh
node scripts/qualify-capacity-safety.mjs --execute \
  --output /private/tmp/chess-capacity-safety-UNIQUE \
  --prior-failure /absolute/path/to/failed-full-local/report.json
```

The command runs the named uncertainty, fencing, lifetime-permit, work and
storage regressions. It then exercises one real native Game workflow with
legal play and drained result delivery, and one actual native retirement
abort with its exact one-use acknowledgement. It records the raw source graph,
unarmed Worker bundle, checked finite allowance, test results and probe
reports. It fails if the source changes during the checks. No provider or
production binding is used.

The v2 sealer rechecks those artifacts against the current source. It retains
references to failed full-local reports and rejects missing native drain,
incomplete cases, changed source, or work above the fixed ceilings. The safety
record explicitly has `fullWorkload: false` and `providerQualification: false`.
It does not claim full Competition shutdown, provider CPU or throughput. The
full approved provider stream and final shutdown audit remain release gates.

The private retry meter permits up to two automatic retries of a read-only
query inside a prepaid three-pass bound. It retains final-attempt row metadata
and the conservative retry surcharge separately, including across workflow
reconstruction. Writes with retries, missing row metadata and exhausted bounds
still fail closed. See the [D1 retry accounting](capacity-qualification.md#bounded-d1-read-retries)
for the eight-row warm lookup audit and the unchanged per-run read cap.

## Run

Use Node 24 with installed lockfile dependencies:

```sh
node scripts/rehearse-capacity-local.mjs --describe
node scripts/rehearse-capacity-local.mjs --execute \
  --output /private/tmp/chess-rehearsal-UNIQUE
```

Choose a new output directory for each local source revision. The command
refuses an existing directory. It chooses a fixed UTC minute at least two
minutes ahead. An explicit `--start-at` ISO timestamp must be between one
minute and one day ahead and have no seconds or milliseconds. A complete
single-egress run audits native shutdown after the 30-minute admission close,
with the full 900-second regular stream and unchanged 60-minute hard stop.
Do not shift the system clock or retry missing workload slots.

The first account preparation is scheduled eight seconds after arm. This
leaves both initial control requests their full five-second response window.
Preparation, credential and registration offsets include the same fixed
six-second startup allowance. Request counts, preparation and registration
rates, game and recovery times, and the 900-second stream remain unchanged.
Control timeout or unreadiness still stops the run; no slot is rescheduled.

The script uses maintained esbuild, Miniflare, the native D1 migration reader
and the existing Node protocol driver. A generated local bundle supplies only
the source trial plans and fixture manifest. Its small entry adapter maps
loopback transport to the fixed canonical test host. The driver sends real
HTTP and `ws` handshakes with the original Host, Origin and private credentials.
Production source gates stay closed, and no provider API is called.

For the native request-ownership regression, use a fresh directory:

```sh
node scripts/rehearse-capacity-local.mjs --execute --request-ownership-probe \
  --output /private/tmp/chess-rehearsal-ownership-UNIQUE
```

This bounded diagnostic repeats 160 account fixtures through 6,128 real HTTP
preparation calls, then overlaps 160 registration arrivals across the next
256-request ingress grant. Each request drains its bounded 128-byte body before
grant coordination. A follower owns its promise and one platform timer, capped
at five seconds and the original issue deadline. Completion, denial, rejection,
stop and expiry clear that timer. A denied, lost or expired wait permanently
stops new work; accepted charges stay consumed. There is no polling loop.
The report keeps safe Worker/native source
frames and expected registration denials, then stops the controller and
disposes the runtime. It does not dispatch games or qualify throughput,
provider cost, or the full workload.

Add `--request-ownership-cold` to overlap the first eight preparations while a
generated local-only controller delays initial Competition funding by 100 ms.
This exercises the private entry's cold shared-funding path without changing
production code, the corpus, or workload clocks.

The private, database-bound policy supplies only three fixed event dates.
Normal Arena scheduling, eligibility, pairing, Game readiness, legal moves,
terminal rules, outboxes and Competition settlement remain authoritative.
Production still uses its ordinary calendar. This load run does not qualify
the deferred real-calendar observation.

## Bounded account preparation

The private setup route prepares at most 32 synthetic accounts per request.
It inserts real primary user, credential and session rows through a batch of
at most 96 D1 statements. A committed intent prevents a lost reply from
creating replacement credentials. The route reads back all primary rows,
checks their fixed ownership and expiry, and signs their session cookies with
Better Auth. Normal registration still authenticates every cookie and checks
the primary credential records. This setup does not measure public signup or
password hashing.

Run the complete preparation diagnostic, including a ten-second first-batch
delay, in a fresh directory:

```sh
node scripts/rehearse-capacity-local.mjs --execute \
  --preparation-batch-probe --preparation-stall \
  --output /private/tmp/chess-rehearsal-batch-UNIQUE
```

This probe keeps all 6,000 accounts, the fixed credential deadline and the
15-second preparation response timeout. It does not register entrants or
dispatch games. On 22 October 2026, it retained 6,000 users, credentials,
sessions and ready fixture rows, with all 188 preparation replies received
and 6,309 ms left before the credential deadline. No request was uncertain;
maximum concurrency was two. These are local workerd observations, not
provider throughput, CPU, cost or tournament qualification.

Fixture metering reserves three read passes per native fixture event: up to
640 measured reads and up to 1,280 conservative units for two automatic
read-only retries. Retry units remain separate from final-attempt metadata
and persist through workflow reconstruction. Write retries, missing metadata,
an exhausted envelope or a lost native reply still stop qualification and
retain the reservation. The first HTTP batch also includes the separate
bounded Better Auth startup event, so its combined response can exceed the
single-event read count.

Queue identities do not prescribe Arena opponents. The private binding ledger
discovers at most two already-generated native intent rows per observation and
binds each Game once to a pending ordinal for its actual event. A durable
global row cursor and an indexed pending lookup bound cross-event reads.
Transactions retain the native Game, reservation and both actual seats through
unknown replies and reconstruction. A second scheduled queue actor still
enters the normal queue after discovery; the claimed-step bitmap prevents
replay. A missing binding stays unresolved, and a conflicting mapping stops
the ledger without replacing an ordinal or Game. Counts, request slots,
commands, clocks and run limits do not change.

Run the focused native binding regressions with:

```sh
npx vitest run test/capacity-protocol.test.ts test/capacity-intents.test.ts
```

These checks reproduce cross-ordinal native pairing, distinct Game discovery,
event isolation, unknown replies, reconstruction and conflict fencing. Native
SQLite cursor metadata includes index work. Their small local fixtures do not
qualify the cumulative Competition allowance, provider CPU or full workload.

## Evidence and failures

The directory contains the local manifest and trial plans, source hashes,
generated local-only bundle, checked aggregate allowance, migration usage,
compressed request trace and final report. Source changes during preparation
or execution fail the record. The normal driver records late slots,
saturation, unknown replies and unmet dependencies without replaying them.
The local runner stops new offers after the first failed slot or uncertain
request, waits for offered requests to finish, then closes the trace. Known
request and native error codes are retained before runtime disposal. Exception
text, request bodies and credentials are excluded.

The transport cancels unread HTTP error bodies before recording a denial or
an uncertain server failure. It does not retry the request. Cleanup failure
also stops the run as uncertain. This bounds response ownership; it does not
establish throughput or explain a stalled run.

`sessions.private.json` contains expiring synthetic credentials. The directory
and artifact are private. Keep that file out of published evidence. The
report and trace omit bearer tokens, cookies and routing proofs. Local
setup migrations are recorded separately from the controller's native work;
the final provider ledger must include all setup work.

The runtime is disposed after completion or a terminal script error. There is
no automatic restart or change to a consumed record. A later local attempt
needs a new directory and source evidence. The once-only provider run has its
own permanent admission ledger and cannot be renewed this way.

A local pass cannot prove Cloudflare's 50 ms CPU ceiling, WAN latency, live
resource ownership, actual client egress or complete provider cost. The frozen
provider candidate still needs owner approval before provisioning or load.
