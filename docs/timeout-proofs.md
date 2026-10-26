# Private timeout proofs

## Status

The source implements a separate, default-off timeout proof path for new ranked
games. The fixed rules version is `online-2026-10-v3-proof`, and its fixed
execution profile is `cha-native-3484c7e6-v1`. Historical games retain their
stored policy. Casual games, computer practice and unrated tournaments continue
to use `online-2026-10-v2-unattended`.

The checked-in default Wrangler configuration has `TIMEOUT_PROOF_PROFILE=off`,
`MONTHLY_PROOF_LIMIT=0` and no `PROVER` binding. The final release configuration
uses a separate private proof service. Ranked enablement requires recorded
native corpus, Game/Competition settlement, failure/recovery and physical
shutdown checks for the chosen tier. See the published
[timeout-proof qualification report](https://chess.ejmlabs.com/qualification/timeout-proofs.json)
for release measurements. The [earlier provider report](qualification/provider-proof-20261021.md)
and completed [feasibility probe](adjudication-feasibility.md) retain their
historical scope; neither alone establishes the final release result.

Two later local acceptance cases now follow real ranked admission, Game
readiness and timeout arbitration through TimeoutProver receipts and
Competition rating settlement. Duplicate proof/terminal delivery and omitted
proof/settlement replies each preserve one proof attempt, one rating event
and one released reservation. The focused cases passed in two seconds.
Native Container handles and responses, background scheduling and the clock
are explicit test adapters; these cases do not run the solver or establish
provider lifecycle, resource limits, cold starts or cost. Provider evidence is
recorded separately for the selected release.

Private acceptance also rejects new adapter and proof deliveries when its
saved manifest or runtime identity differs from the current seal. Diagnostic
`runnable` requires both saved matches and the configured manifest match.
Inspection, stop, cleanup and accepted-result settlement retain their existing
paths. Both focused local mismatch cases passed with a real SQLite journal,
zero proof deliveries, an untouched proof transport sentinel and an available
stop path. They ran no native solver or provider work and do not
qualify ranked launch.

## Player rules

chess.js still owns live move legality, clocks and supported automatic draws.
Checkmate takes precedence over a draw at the same move boundary. Threefold
repetition and the fifty-move rule draw automatically under this online policy.
See the [FIDE Online Chess Regulations](https://handbook.fide.com/chapter/OnlineChessRegulations)
for the online rules that inform these choices. Full over-the-board FIDE
compliance and complete live dead-position detection are not claimed.

A flag draws immediately when the existing rules library proves insufficient
material or the surviving player has only a king. Other v3 ranked flags freeze
play and ratings while a private bounded proof runs:

- A validated legal mating continuation awards the surviving player a timeout
  win, with reason `timeout-proof-win`.
- A supported proof that the surviving player cannot mate records a draw,
  with reason `timeout-proof-draw`.
- Unknown, exhausted, invalid or failed work leaves the result pending until
  the original flag time plus 30 seconds. The alarm then records one unrated
  `technical-void`, with no winner or rating change.

The winning continuation may require cooperation. This tests whether mate is
possible, rather than whether a player can force it. A material score, engine
evaluation or likely winner cannot replace proof. A successful proof retains
the original flag time as the game's end time. Retries never add time.
Unknown cases remain a competitive limit and may permit loss avoidance.

## Admission and draining

Competition owns four durable timeout-proof slots shared by blitz and rapid.
One slot is held from the creation intent through terminal acceptance and
release, including readiness, pending proof and settlement recovery. It is not
released merely because a player disconnects or a pending result is projected.
With four slots occupied, another eligible pair stays queued.

Before Game initialization, D1 must accept one permanent game-ID receipt with
two attempt credits. A UTC month admits at most 1,000 such games. There are at
most 1,000 retained proof receipts in total, matching the retained ranked-game
ceiling. The pool stores at most two attempt records per game, or 2,000 total.
There is no refund, ID recycling or silent retention reset. These conservative
limits do not support a claim of thousands of concurrent ranked games.

The account slots, proof slot and creation intent commit in Competition's
SQLite transaction. Monthly game and proof authority then commit through D1's
idempotent receipts. This is a recoverable sequence, not a transaction spanning
both services. Lost replies reconcile the same game and receipt. Known denial
cancels unused intent and releases its slots; unavailable or uncertain authority
retains the reservation for retry. Game independently checks both the proof
receipt and Competition's saved slot before admitting a new ranked game.

New proof admission closes unless the profile matches exactly, `PROVER` exists
and `MONTHLY_PROOF_LIMIT` is a valid positive integer at most 1,000. It also
obeys `NEW_WORK_STOPPED` and the existing D1 games stop. Accepted receipts remain
valid across stops, disabled admission and month rollover so existing games can
finish. Keep their binding and fixed image available while they drain.

The policy adopted on 2026-10-22 uses one $100 monthly chess spending target.
Usage alerts at $45 and $70 and the emergency stop at $85 leave headroom for
accepted work. It replaces the earlier per-service allocations, named reserves
and repeated financial approval gates. Fixed admission, attempt, instance and
runtime limits still apply. Optional server analysis remains disabled.

Reservation counts and short jobs cannot guarantee the invoice. Alerts can lag,
accepted work must drain, and provider stop failures can add charges. Retain
the dated estimates as historical evidence and check actual usage when operating
the service. See [the ledger](cost-estimate.md#current-proof-financial-policy),
[budget controls](cloudflare-budget.md) and [operations](operations.md).

### Separate financial, source and provider gates

| Private manifest record | Before finite execution | Bound runtime identity field |
| --- | --- | --- |
| `reviewGates.costReview` | `reviewed`, immutable document SHA-256 | `costReviewSha256` |
| `reviewGates.sourcePermitReview` | `reviewed`, immutable document SHA-256 | `sourcePermitReviewSha256` |
| `reviewGates.ownerResidualCostAcceptance` | `accepted`, actual owner decision SHA-256 | `ownerResidualCostAcceptanceSha256` |
| `reviewGates.providerResourceQualification` | Keep pending for the measurement run | Later retained provider report |

The checked-in manifest remains unarmed, every review pending and every hash
null. The first three retained records must match the frozen manifest, compiled
runtime identity and exact input bundle. A plausible hash or synthetic local
fixture is not review or owner acceptance. Financial records describe the prior
decision and remain bound for protocol compatibility. They do not impose new
per-service approvals under the current $100 policy. Retain provider evidence as a
separate report referencing that unchanged manifest, source, bundle, config and
exact resources; do not rewrite the measurement manifest to claim a later pass.
Bind the passing report in the production release review.

Cost adoption passes no proof, real Game/Competition settlement, restore,
resource, capacity or player-flow check and grants no extra workload. Keep the
fixed finite permits and original-binding native stop path. Lite stays first;
Basic follows only its allowed ordinary resource/watchdog failure after physical
Lite stop and disable, without a full Basic corpus rerun. Production retains
one allocation/job, the fixed singleton with `max_instances=1`, four ranked
reservations, 1,000 monthly admissions, two credits per game and the original
30-second technical-void deadline. Production attachment still needs passing
resource and recovery evidence. Deploy qualified settings behind full-host
Access with persistent admission stops closed; admit protected integration
through the owner control, then open publicly only after that path passes.

## Private production service, inactive

`src/server/proof-service.ts` exports the existing `TimeoutProver` class and
returns HTTP 404. `wrangler.proof-service.jsonc` prepares a separate private
`ejm-chess-timeout-proofs` Worker with a 100 ms CPU ceiling. The public
`ejm-chess` Worker retains its 50 ms ceiling. The template has an invalid
account placeholder, no Container attachment and admission off. It is not a
deployable or qualified production candidate.

The proof service needs only the existing production D1 `DB` and its own
`PROVER` Durable Object namespace. It reads accepted proof-admission receipts
from that database. It has no Game, Competition, synthetic database, test
controller, mail, asset, account-secret, cron, route or public alias binding.
Its self binding identifies the fixed `timeout-proof-v1-singleton` object.

After qualification, public Game and Competition authorities use this private
cross-script binding:

```json
{
  "name": "PROVER",
  "class_name": "TimeoutProver",
  "script_name": "ejm-chess-timeout-proofs"
}
```

The production namespace must be fresh. Never attach an acceptance or
qualification namespace, reuse its consumed singleton, or replace its
synthetic database and authority bindings with production bindings. Retain
those test resources and permanent stop records separately.

The deployment sequence remains unrun:

1. Complete the required native proof, Game/Competition, restore and resource
   gates. Record the current spending policy, exact passing tier,
   immutable image digest and source hashes. No tier or image is selected by
   this template.
2. Prepare a private reviewed copy of `wrangler.proof-service.jsonc`. Replace
   its account placeholder, verify the existing production D1 identity and
   add one Container for class `TimeoutProver` with the qualified image digest,
   passing tier and `max_instances=1`. Create the fresh SQLite namespace
   through its production migration. Keep routes, aliases and admission off.
3. Deploy and read back the private service's source, image, tier, one-instance
   limit, 100 ms CPU cap, production database and self namespace. Check that
   every namespace differs from the isolated acceptance and qualification
   resources. Keep the real provider records with the release evidence.
4. Add the cross-script binding above to the reviewed public Worker config.
   Keep `RANKED_ENABLED=false`, `TIMEOUT_PROOF_PROFILE=off` and
   `MONTHLY_PROOF_LIMIT=0` until the remaining release gates pass. Read back
   the production caller and self bindings. A source export or successful
   upload alone does not establish that wiring.
5. Enable only the approved profile and limits after the release decision.
   Keep one native job, four shared ranked slots, two attempt credits per game
   and at most 1,000 new ranked games per UTC month. Preserve the original
   binding, image, accepted receipts and stop authority while accepted work
   drains, including after an admission stop or month rollover.

The private entry adds no new solver or lifecycle implementation. The existing
pool serializes native jobs, limits each allocation to 22.5 seconds, uses
ten-second idle sleep and preserves unresolved stop debt. Neither that fence
nor the three bounded stop attempts guarantees the provider's final invoice.
Spending controls, native provider evidence, resource attachment and public
enablement remain separate steps.

## Native execution and independent validation

The image builds unchanged CHA-Solver 3.0.0 and its `analyzer` example from
commit `3484c7e65247003fac8705a9290dc2b5d0978b94`, licensed MIT. The adapter
invokes that fixed executable with stdin `<FEN> <white|black>\n`. Requests
cannot select paths, options, engines, variants or shell commands. Pinned
python-chess 1.11.2 independently reconstructs the complete retained history,
requires canonical legal-en-passant FEN, and rejects an already terminal
position or a side that did not survive the flag.

The pinned native format supplies `winnable moves ...`, `unwinnable` or
`undetermined`. A positive continuation is replayed from the reconstructed
history, with legal moves, automatic repetition and move-count draws and
checkmate precedence checked at every boundary. Its final move must checkmate
the flagged side. Invalid or overlong witnesses return unknown, never a draw
or win. `undetermined` and an inconclusive fast classification are unknown.

| Bound | Fixed ceiling |
| --- | --- |
| Container instances / active native jobs | One / one |
| Controller live request queue | Four |
| Idle sleep | Ten seconds |
| Helper CPU / native CPU | One second each |
| Helper / native address space | 128 MiB each |
| Shared helper/native wall time | Two seconds, or the earlier request expiry |
| Native stdout / stderr | 16 KiB / 4 KiB |
| Request / result JSON | 128 KiB / 16 KiB |
| Retained history / positive witness | 12,700 plies / 512 plies |
| Controller startup wait | At most five seconds for native readiness, within the original expiry |
| Controller native HTTP watchdog | 2.5 seconds within original expiry |
| Allocation application deadline | 22.5 seconds from its durable reservation, or the earlier original Game expiry |

The CPU and address-space bounds are per process. They do not describe total
Container CPU or peak memory. A shared external watchdog kills the whole job
process group. Controller cancellation requests Container destruction. A
restarted controller reconciles native work before accepting another start.
Completed request timers are cleared so they do not hold an otherwise idle
object awake. Resource exhaustion produces unknown without raising bounds.

### Durable allocation lifecycle

`proof_lifecycle` retains one bounded SQLite row beside the permanent attempt
receipts. Before a native start, the controller saves and syncs its generation,
fixed deadline, claimed attempt, and start-issued bit. Each attempt can claim
one generation once. A generation issues at most one native start, including
when start validation fails or its reply is lost. A live Container may serve
another charged attempt within the same unchanged deadline. Traffic, retries,
controller restart and month rollover do not extend it or refund a credit.

The deadline is the earlier of the original Game expiry and reservation time
plus 22.5 seconds. A documented SDK schedule requests a stop at that absolute
time. The pinned SDK stores schedules at whole-second precision, so it can
stop up to one second early. The controller also cancels active requests at
their earlier deadline. Scheduling failure closes native admission before
start. The ten-second idle hook remains an additional stop request. This is an
application deadline, not a guarantee about allocated or billed duration.
Provider delays, controller failures and unconfirmed stops can exceed it.

Every controller restart checks the saved lifecycle, including completed
receipts. Native `monitor()` is attached when the Container is running. The
controller requests destruction and persists up to three stop attempts per
generation, waiting at most one second for each reply. It clears stop debt
only after fresh public `ctx.container.running === false`, no local pending
start or stop calls, zero durably pending stop calls, and a saved successful `destroy()` barrier for a
generation that issued a start. An SDK cached state or a resolved signal is
not confirmation. An idle `running=false` can precede a pending native start,
so it cannot replace that destructive barrier after a restart.

Late known destruction can save the barrier and clear debt without a fourth
stop. Every stop is marked pending and synced before dispatch; only its known
settlement removes that durable mark. A successful destroy cannot erase other
unsettled stops. If a reply was lost across restart, that pending debt remains
closed for provider reconciliation even if another destroy succeeded and
`running=false`.
Exhaustion emits one bounded diagnostic. Saved proof results stay readable
while new native work is closed; missing work remains unknown under its
original Game deadline. No native restart, fresh lifetime or fabricated
settlement follows from an unresolved receipt. Legacy receipts without
lifecycle state require destructive reconciliation before a new start.

The private binding-only `lifecycleStatus()` readout reports generation,
deadline, cumulative reserved milliseconds, observed elapsed reservation
milliseconds, start/destruction state, stop attempts, unresolved debt and
schedule failure. Observed elapsed time includes time awaiting stop
confirmation. It is not a provider meter and cannot recover unobserved legacy
allocation time. At most 2,000 permanently charged attempts can reserve at
most 2,000 generations and 45,000 reserved application seconds.
`invoiceHardCap` remains false. Added SQL writes, SDK alarms, requests,
unresolved stop exposure, image storage and all other provider costs still
remain subject to the $100 spending target, existing stops and provider qualification.

This narrow adapter uses public Container platform APIs for start, monitor,
destruction and fixed-port HTTP, plus public SDK schedules, `waitForPort()`
and lifecycle hooks. The installed `@cloudflare/containers` 0.3.7 source at
`dist/lib/container.js` has automatic startup in `containerFetch()` around
lines 867 to 870 and a retry loop in `doStartContainer()` around lines 1317
to 1425. These can issue starts without another product receipt. The product
therefore overrides both public start entry points and sends proof HTTP
through `getTcpPort(8080)` so transport cannot restart a dead generation.
Remove this adapter only when a maintained public SDK contract can prove
one durable charged start per generation, retain the fixed deadline, and
pass the lifecycle regressions. See the
[public native API](https://developers.cloudflare.com/containers/api/durable-object-container/).

## Private delivery contract

There is no public proof submission route or arbitrary-FEN API. Game calls
only the fixed `timeout-proof-v1-singleton` through `PROVER`, using
`POST http://proof.internal/prove`. The request has exactly the fields defined
by `TimeoutProofRequest` in `src/server/proof-contract.ts`:

`v`, `rulesVersion`, `profileVersion`, `gameId`, `reservationId`,
`pendingVersion`, `requestId`, `survivor`, `initialFen`, `fen`, `moves`,
`historyDigest`, `positionDigest`, `expiresAt`, `attempt`.

The two IDs identify the admitted permanent game. `requestId` is
`timeout:<gameId>:<pendingVersion>`. The history digest is SHA-256 of UTF-8
`JSON.stringify([initialFen,moves])`; the position digest hashes
`[rulesVersion,gameId,pendingVersion,fen,survivor,historyDigest]` in the same
format. Expiry is the unchanged flag time plus 30 seconds.

A bounded result echoes that identity, omits FEN and moves, and adds the fixed
solver commit, validator version `python-chess-1.11.2-online-v1`, verdict,
witness and reason. Unknown reasons are `solver-undetermined`, `resource-limit`,
`invalid-input`, `invalid-output`, `invalid-witness`, `unsupported-policy`,
`expired`, `transient-start` or `interrupted`. Supported proofs have a null
reason; only a validated positive proof includes witness moves.

The pool persists `(requestId,attempt)` before native execution and stores its
bounded result before replying. Duplicate delivery reads that receipt or waits
for the same live work. A new pending version cannot grant more game credits.
Only a persisted transient-start or interrupted first result permits attempt
two with the same identity. Deterministic unknown, invalid output, invalid
witness or resource exhaustion never starts another native search. An
interrupted receipt remains consumed even if no result was returned.

Game saves its request before dispatch and permits at most two deliveries for
each of the two attempts. After a restart it first reconciles that saved
receipt. A result may finish only the exact still-pending version, side,
reservation, history, position and deadline once. Late or mismatched results
cannot overwrite a terminal result or cause another rating event.

## Privacy, retention and licenses

The private Cloudflare proof service receives the admitted game ID, saved
position, complete UCI history and proof identity. It receives no account
names, recovery email, password, session, client address or browser focus data.
No external model or token service is used. The proof is an adjudication step,
not a cheating finding.

Pending request payloads are removed when the Game finishes. Permanent proof
admissions and at most 2,000 detailed attempt receipts retain identity,
digests and bounded proof results within the documented storage stop. They
are private and are not exposed by history, leaderboard or replay endpoints.
Game history and immutable ratings keep their existing retention policy.

`proof/pins.json`, `proof/Cargo.lock`, `proof/NOTICES` and `proof/vendor/`
retain pinned upstream sources and licenses. The image retains dependency crate
sources and notices, Rust notices and complete python-chess corresponding
source. python-chess uses GPL-3.0-or-later. Preserve source and all applicable
licenses when distributing the image or source. This is not a completed
external license review or public image release. See [notices](../THIRD_PARTY_NOTICES.md).

## Reproduce and qualify

Run from the product checkout. Docker must support Linux amd64. On an Arm Mac,
label the results as emulated. The image's live socket tests use loopback inside
the container; they need no published port.

```sh
docker build --platform linux/amd64 --target qualification \
  -t ejm-chess-proof-verify:local proof
docker run --rm --platform linux/amd64 --memory=512m --cpus=1 \
  --pids-limit=32 --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges ejm-chess-proof-verify:local
docker run --rm --platform linux/amd64 --memory=512m --cpus=1 \
  --pids-limit=32 --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --entrypoint python \
  ejm-chess-proof-verify:local measure.py
npx vitest run test/proof.test.ts test/proof-authority.test.ts test/proof-qualification.test.ts
```

Retain raw measurements under `proof/measurements/`. The authorized corpus
includes both surviving sides, ordinary flags, minor pieces and blocked walls,
special moves, full-history online draws and checkmate precedence. Preserve
expected supported answers. Ordinary flags must resolve correctly before their
original deadlines, rather than all becoming technical voids.

Repeat the corpus through the private provider binding with four simultaneous
cold requests, allowed retries, killed children, lost replies, controller
restart, stale/duplicate/late results, void races and exhausted admissions.
Measure total and child CPU, peak memory, image/startup/queue time, unknown and
failure rates, storage and retry overhead, and complete cost per 1,000 attempts.
Only then choose the smallest passing tier, configure one instance and its
private binding, and review all other ranked launch gates. No public ranked
enablement follows from the code or this document alone.

### Isolated provider harness

`wrangler.proof-qualification.jsonc` is an unarmed source template for a
separate qualification Worker. It has no canonical route, `workers.dev` alias,
preview URL, cron, assets, mail, gameplay, competition, or analysis binding.
Its D1 ID is an invalid all-zero placeholder, its tier is `unset`, its expiry
is zero, and no Container resource is declared. The main Worker never imports
this entry point. A local dry run does not provision resources or qualify a
tier.

Before deployment, review a temporary copy against the provider inventory and
complete cost model. It needs a fresh isolated D1 database, fresh controller and
prover namespaces, the fixed source revision, and a short expiry no more than
two hours ahead. Add exactly one reviewed Container with `max_instances=1` and
the pinned production Dockerfile only after its tier and complete cost scope
are approved. Do not reuse a production or recovery database or namespace.
The metadata IDs are operator assertions; the source cannot inspect the
provider's ownership graph. Review the real bindings separately.
Keep those original bindings in place until `stopConfirmed=true`; rebinding a
namespace first would prevent the controller from stopping its former instance.

Keep `TIMEOUT_PROOF_PROFILE=off`, `MONTHLY_PROOF_LIMIT=0`,
`NEW_WORK_STOPPED=true` and all other feature flags false. A run command enables
the fixed proof profile only inside the isolated synthetic admission adapter.
Set a dedicated 32 to 128 character URL-safe `PROOF_QUALIFICATION_TOKEN` through
the provider's secret interface. Do not reuse auth, recovery, or account tokens,
and keep it out of shell output and retained reports.

The only Worker action is authenticated `POST /qualify`, with no query string.
It accepts at most 2,048 bytes and exactly one of these JSON commands:

| Body | Effect |
| --- | --- |
| `{"operation":"inspect"}` | Read bounded saved results and scope |
| `{"operation":"run","batch":0}` | Execute the selected fixed batch of at most four corpus entries |
| `{"operation":"stop"}` | Persist a permanent stop, cancel queued work and stop the private Container |

Inspect first for the batch count and final `coldBatch` index. Run the ordinary
batches once, then the final four-request cold batch. The harness only uses the
bundled licensed synthetic corpus. It accepts no FEN, account, engine option,
history, arbitrary job, or reset command. Saved source, corpus digest, tier and
expiry cannot change after the first batch. A stopped run cannot be rearmed.

One durable controller owns all batches, with at most 32 permanent synthetic
reservations and two native credits per reservation. A repeated batch reuses
the original game IDs, expiry, deliveries and saved results. Only a transient
first native result permits the second credit. Each credit has at most two
transport deliveries, which reuse the pool receipt. Restart reconciliation
keeps the saved batch fence and deadline. The final cold reset has a separate
durable receipt so repeating that completed batch does not start fresh work.

At most 128 inspect/run commands are accepted, including failed runs. Stop
remains available. The expiry alarm applies the same permanent stop even if
configuration changes. Failed Container-stop confirmation has at most six
automatic attempts with exponential backoff. After that, `stopped=true` and
`stopConfirmed=false` expose the remaining provider reconciliation task, and
an authenticated stop can try again. No native work is admitted after the
persisted stop. Provider outages can still delay confirmed Container removal;
verify provider state and remove the isolated deployment after collecting
evidence.

The readout is limited to 32 fixture rows and 64 KiB. It exposes expected and
actual verdicts, reason, witness length, attempt, delivery count, start/end
times and whether completion preceded the original deadline. It retains no
player fixtures. A positive authority-test mock is not native proof evidence.
The harness alone does not measure child CPU, process peak memory, provider
invoice cost, Game/rating settlement, or public concurrency. Collect native
metrics and provider billing data separately before claiming qualification.

### Local verification recorded on 2026-10-21 UTC

Worker type checks passed. The focused proof, qualification, Game, Competition,
budget and analysis suite passed 76 tests in seven files before the final two
harness review fixes. A follow-up qualification suite passed 11 tests after
those fixes, covering saved-tier labeling and waiting for every sibling job
before releasing a failed batch fence. The frontend build passed the normal
and stricter guide budgets.

The earlier normal Worker dry run was 2,332.54 KiB raw and 444.78 KiB gzip, with
proof disabled and no private prover binding. Its qualification corpus and
secret names were absent. The final isolated candidate passed its Worker type
check, source-bundle dry run and exact no-bundle dry run using Node v24.19.0 and
Wrangler 4.151.3. Both qualification dry runs reported 183.02 KiB raw and
41.69 KiB gzip. The immutable candidate retains its source, native pins,
57 bundled inputs, exact Worker module, operator commands and file manifest.
The current capture is recorded in
`qualification/proof-worker-candidate-2026-10-21.json`; it supersedes the older
unarmed harness capture. These checks performed no provider mutation.

The additional local native arm64 diagnostic image passed its fixed tests,
27 corpus entries and four serialized ordinary requests at 0.25 CPU and 1 GiB.
The 0.0625 CPU run failed. This is local architecture evidence, not a provider
tier choice: the production image remains pinned to Linux amd64. See
`proof/measurements/corpus-arm64-basic-v3.*` and the native adapter README for
the separate measurements and their limits. Production architecture,
provider cold-start/resource behavior, full recovery and reconciliation remain
launch gates. Neither the profile nor ranked admission is enabled
by these results.

## Further acceptance controller, local preparation

`wrangler.proof-acceptance.jsonc` is a separate, unarmed control-only template.
It declares no Container, D1, Game, Competition, mail, queue, asset, secret or
public route. Its Worker and object HTTP handlers return 404. It does not
replace, reset or rearm the consumed corpus candidate.

The fixed `proof/acceptance-manifest.json` names commands, fault identities and
finite limits. The SQLite journal records a permanent arm identity, command
receipts, consumed fault ordinals, monotone observed time and a permanent stop.
Saved receipts can be read after expiry without permitting new work. Its
internal sealed-identity path exists for local journal verification only.
The checked-in manifest has a null seal and keeps execution unavailable.
No environment switch enables it. A reviewed compiled seal is required for
the private execution entry. Unarmed HTTP handlers remain 404.

Worker types and seven focused native control tests passed locally. They cover permanent identities,
receipts, consumed faults, expiry, strict command input and inspect/stop after
configured manifest drift. Their synthetic seals test the internal journal;
they do not qualify or arm a provider candidate. Two native budget tests cover
permanent permits across transaction rollback, predispatch D1 rejection and
event exhaustion.

The proposed limits include 39 new logical IDs, 78 attempt credits, 168 private
proof deliveries, 64 advancing commands, 256 control alarms, six emergency
cleanup calls and a two-hour lifetime. The source now implements the fixed
corpus and Game scenarios through real Game, Competition and TimeoutProver
classes. It preserves actual clocks, accepted IDs and permanent credit
receipts. Private adapters inject only the manifest's named faults. A permanent
whole-event permit precedes each authority dispatch. Bounded native SQL and D1
measurements retain uncertain work and close later work when an envelope fails.
Only fixed inspection and cleanup operations may use six extra permits on
Control and Prover after normal exhaustion. The unarmed Control event ceiling
is 768, including the required saved-restore orchestration. These source bounds
still require provider qualification and the existing spending controls.

The exact private service entrypoint is `ProofAcceptanceCaller`. Its
`command()` accepts `arm`, `inspect`, `stop`, or `advance` with a manifest ID.
Run `select-lite`, then `C00` through `C26`, then `G00` through `G11` and
`close-v1`. G00 admits the first four Games together. A permitted ordinary lite
resource failure requires `confirm-lite-stopped` on its original binding before
the separately configured `select-basic` phase. It never permits another full
basic corpus run or a second acceptance branch.

For local preparation, run:

```sh
node scripts/rehearse-proof-local.mjs --describe
node scripts/rehearse-proof-local.mjs --execute \
  --output /private/tmp/chess-proof-rehearsal-UNIQUE
```

The helper uses the installed esbuild and Miniflare, an existing pinned amd64
solver image and Miniflare's pinned local ingress image. It binds loopback
only, applies migrations to an isolated native D1 instance and calls the
private service entrypoint. Its temporary compiled fixture supplies local
identity and execution flags without editing the checked-in manifest. Default
work stops after C00; `--through corpus` requests all 27 fixtures. Every run
uses a new evidence directory, preserves failure, saves source and bundle
hashes, and stops its private control before disposing the runtime. Local
fixture flags, emulated amd64 execution and loopback observations cannot
qualify a provider tier or authorize deployment.

Resource readback, complete usage bounds and a frozen provider candidate remain
required before provider work. The existing 31 consumed corpus IDs remain
consumed and must stay in monthly cost attribution.

Adoption of the $100 spending target does not qualify resource, physical stop
or coherent D1/Game/Competition/Prover restore behavior. Registry and historical
charges remain uncertain. Those operational checks stay open. C14/C15 require
real native mating witnesses rejected by
independent online-draw validation as `unknown`/`invalid-witness`. G07 requires
both exact solver-child kill evidence and its native attempt receipt showing
`unknown`/`resource-limit`; a kill or technical void alone does not establish
that reason. Native `undetermined` parser coverage is synthetic. No genuine
native `undetermined` fixture is retained or claimed executed; record that gap
and add a genuine fixture if found. Preserve the production `solver-undetermined`
mapping. Injected results and other unknown reasons cannot substitute for native
evidence. All other qualification gates remain required. A local journal check
cannot qualify costs, provider recovery or ranked play.

### Private four-authority restore preparation

`ProofRecoveryCaller` is a separate named private entrypoint in the same
acceptance Worker. It has no public HTTP route. It reuses the isolated D1,
Game, Competition, selected phase Prover and permanent Control. It creates no
namespace, image, Container allocation or solver job. Control holds the review,
action claims, usage and undo receipts and is never restored.

The operator adapter uses installed Wrangler for the private service binding
and native D1 Time Travel. Native object bookmarks, deferred restore and abort
use the real Durable Object storage APIs. A missing native API fails the drill;
the adapter never substitutes a bookmark or storage handle.

```sh
node scripts/restore-proof-acceptance.mjs --describe
```

`--describe` and `--action review` make no provider calls and start no local
Worker runtime. Provider actions require `--execute`, a fresh compiled seal,
reviewed cost scope and two private configuration files. The client config
must contain exactly one remote service binding:

```json
{
  "name": "ejm-chess-proof-recovery-client",
  "compatibility_date": "2026-10-19",
  "services": [{
    "binding": "RECOVERY",
    "service": "EXACT_REVIEWED_ACCEPTANCE_WORKER",
    "entrypoint": "ProofRecoveryCaller",
    "remote": true
  }]
}
```

The authority config supplies the exact isolated D1 `DB` and selected phase
source seal. Keep both configs and every output in a private directory outside
the product. Each command creates a new directory and writes files exclusively
with private permissions. Retain them until the recovery review is complete.

1. Use `--action capture-prover --execute` before later proof attempts on that
   same phase binding. Save its real idle point as `prover.json`.
2. Permanently stop acceptance. Use `--action capture-boundary --execute
   --games /private/path/game-ids.json --old-prover /private/path/prover.json`.
   The ID file lists at most 12 actual admitted Games. This boundary records
   current D1, Game and Competition state, the older Prover point and current
   full proof-credit ledger with their real capture times.
3. Capture the preserved boundary with the same command and no `--old-prover`.
   No accepted chess or account work may occur between those boundaries.
4. Use `--action review --baseline BASELINE_JSON --preserved PRESERVED_JSON
   --output NEW_PRIVATE_DIRECTORY`. Review its saved `review.json` and exact
   source, phase, IDs, timestamps, credits and bookmarks.
5. After approval, use `--action restore --execute --review REVIEW_JSON`.
   Every provider action also requires `--config PRIVATE_CLIENT_CONFIG
   --d1-config PRIVATE_AUTHORITY_CONFIG --output NEW_PRIVATE_DIRECTORY`.

The bounded drill covers one proof month, 39 admissions, 78 attempts and at
most 12 Games. The accepted D1 fingerprint includes accounts, closure receipts,
games, ratings, budgets and stops. Only proof-admission and proof-month tables
are excluded because their complete credit ledger is reapplied separately.
Accepted D1, Game and Competition fingerprints must agree across boundaries.
The older Prover must be idle, physically stopped and free of pending stops
and alarms. Later genuine stop debt is required for the debt-preservation
drill. This refuses rollback over later accepted product changes; it does not
recover arbitrary older accounts, results, ratings or closures. Existing
privacy-closure recovery evidence remains separate.

Before each object restart, the runner saves its native undo receipt outside
all rollback targets. It also saves a real D1 undo bookmark before native D1
restore. It then reapplies admission receipts and monthly high-water values,
spent attempt receipts, unresolved stop debt and later acceptance event
permits. Missing native proof results stay absent. Each restored constructor
spends a new permit. Lost reapply replies can be checked without spending that
constructor permit twice. Exhausted reconstruction allowance fails before any
restore preparation.

There are at most 96 raw native recovery actions, with at most two claims per
exact operation and object. The full 14-object workflow uses 84. Each action
reserves 16,384 DO rows read, 2,048 DO rows written and 4,096 D1 rows read, with
no D1 writes. Explicit native SQL, credit replay and alarm reads are measured
through the existing native meter. The unchanged physical ceilings are 4 MiB
per object and 16 MiB for D1. Each Control dispatch, claim, receipt and usage
readback also spends a normal permanent Control event. An interrupted action
keeps its entire envelope; a failed measurement permanently closes later
mutating restore actions. Provider-internal bookmark, restore, SDK and
retention charges still need separate attribution and cost approval.
Mutating recovery calls expire at the sealed two-hour expiry plus its fixed
900-second I/O tail. Saved receipts remain readable within the permanent
Control permit ceiling.

Worker types and the adapter's syntax and read-only description pass. Five
focused native checks pass, including saved permit replay, idempotence,
exhausted reconstruction and the D1 admission-stop boundary. They do not
exercise provider PITR. The complete saved four-authority restore has not run.
No provider candidate is armed, and
this preparation does not open ranked play. After an uncertain native response,
preserve every receipt and keep admission closed. Review the saved readbacks
before any further provider action.
