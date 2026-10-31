# Operations and launch gates

Source restored into `ejm-chess` on 2026-10-26. This public tree excludes the
private Wrangler configurations. The binding descriptions below document the
historical configuration, not checked-in or freshly verified provider state.
Restore reviewed local configuration before running preview or Worker tests.
See [source handoff](source-handoff.md) and the [current plan](../openspec/HANDOFF.md).

## Status and authority

The product has a local implementation and a protected canonical-host canary
at `https://chess.ejmlabs.com`. The dated 2026-10-21 UTC evidence records
Workers Paid, sender onboarding, recipient verification and recovery delivery,
saved budget alerts and a tested stop webhook. It does not establish public
play, complete operating cost, full recovery or worldwide capacity. See the
[verification record](verification.md) for each check's scope and limits.

Use the [provisioning and recovery runbook](deployment.md) for the private
canonical-host canary, required access, additive migrations, binding setup,
deployment readback, and compatible rollback. Recheck exact resource ownership,
bindings and live configuration for each approved deployment; a dated canary
record does not qualify a later candidate.

New deployments default to closed ranked admission. Enable `RANKED_ENABLED`
only with the qualified private proof binding and the release's player and
recovery checks. A static build or Worker dry run alone does not establish a
working production release.

## Local preview

Use Node 24 and install the sibling public `ejm-ui` workspace and this product
as described in the README. Read the current Wrangler configuration before
running binding commands. Local state must use the explicit local environment.

1. Set `LOCAL_DEV=true`, `AUTH_BASE_URL=http://localhost:8787`, and
   `RANKED_ENABLED=false` in the local environment.
2. Copy `.dev.vars.example` to `.dev.vars.local` and replace its placeholder with
   a development-only `AUTH_SECRET` of at least 32 characters. Keep it out of source control, command history, logs,
   screenshots, and chat. Do not reuse a production secret.
3. Apply the checked-in D1 migrations to the local `DB` binding in order.
4. Run `npm run dev`, then open the exact configured loopback origin.

The intended local migration command is:

```sh
npx wrangler d1 migrations apply DB --local --env local
```

The current `wrangler.jsonc` defines this local `DB` binding with a placeholder
database ID. The game and competition objects use the configured SQLite
Durable Object bindings and migrations. Do not point local commands at a remote
database to work around a configuration error.

Only the explicit loopback environment may accept the local Turnstile marker.
Local mode disables email delivery. It does not bypass owner review access.
Use two separate browser profiles with distinct username/password accounts, with the same configured
origin in each.

## Configuration contract

| Name | Purpose and limit |
| --- | --- |
| `ASSETS` | Built static site binding |
| `DB` | D1 auth, active-seat, and fair play records |
| `GAME` | Per-game SQLite Durable Object namespace |
| `COMPETITION` | Serialized queue and rating owner |
| `AUTH_BASE_URL` | Exact canonical origin; only explicit loopback mode permits another host |
| `AUTH_SECRET` | Better Auth secret, at least 32 characters |
| `LOCAL_DEV` | Explicit loopback development only; never enable on the public host |
| `OPERATION_MODE` | `unattended` by default; only exact `reviewed` enables new human case decisions |
| `GAME_RETIREMENT_MODE` | Missing or `preview` keeps four archive attempts per minute; exact `scaled` enables the bounded shared coordinator described below; other values close retirement |
| `TOURNAMENTS_ENABLED` | Enables new automatic unrated round-robin events and entry; accepted events drain when disabled |
| `ARENAS_ENABLED` | Enables timed arenas; their release settings require the corresponding capacity qualification |
| `ARENA_ENTRANT_LIMIT` | No product cap by default; a positive integer may set one. Platform storage and the monthly budget apply |
| `ARENA_GAME_LIMIT` | No product cap by default; a positive integer may set one. Platform storage and the monthly budget apply |
| `ARENA_RETAINED_GAME_LIMIT` | No product cap by default; a positive integer may set one. Retirement and the monthly budget bound growth |
| `ARENA_GAME_ID_LIMIT` | No product cap by default; a positive integer may set one. The monthly budget bounds new IDs |
| `ARENA_AUTHORITY_BYTE_LIMIT` | 4 GiB Competition SQLite platform safety stop, including reserved unfinished-game headroom; accepted results still drain |
| `RANKED_ENABLED` | Closed by default; credential-backed accounts still need eligibility checks; recovery email is optional |
| `TIMEOUT_PROOF_PROFILE` | `off`; only exact `cha-native-3484c7e6-v1` with qualified private binding and positive proof limit permits new ranked games |
| `MONTHLY_PROOF_LIMIT` | `0`; positive settings capped at 1,000 games per UTC month, with two credits per accepted game and 1,000 permanent receipts total |
| `PROVER` | Optional private timeout-proof Container namespace; absent from default configuration; one fixed singleton, four shared ranked slots, one native job |
| `NEW_WORK_STOPPED` | Exact `true` stops new signup attempts, game reservations, account-security sends, and server engine calls; existing signin and accepted games/results retain their recovery paths |
| `MONTHLY_GAME_LIMIT` | Deprecated; usage counter only. No admission cap |
| `MONTHLY_EMAIL_LIMIT` | Deprecated; usage counter only. No admission cap |
| `MONTHLY_ANALYSIS_LIMIT` | Deprecated; usage counter only. Analysis remains disabled |
| `MONTHLY_SIGNUP_LIMIT` | Deprecated; usage counter only. No admission cap |
| `SIGNUP_ATTEMPT_LIMIT` | Deprecated; lifetime usage counter only. No admission cap |
| `CASUAL_GAME_LIMIT` | No product cap by default; a positive integer may set one. Retirement and the monthly budget bound growth |
| `CASUAL_GAME_ID_LIMIT` | No product cap by default; a positive integer may set one. The monthly budget bounds new IDs |
| `RANKED_GAME_LIMIT` | No product cap by default; a positive integer may set one |
| `RANKED_QUEUE_LIMIT` | No product cap by default; a positive integer may set one |
| `RANKED_RETAINED_GAME_LIMIT` | No product cap by default; a positive integer may set one |
| `AI_ENABLED` | Browser Stockfish practice gate; enabled in local config and set explicitly in the public release. No provider key or token quota; see [computer practice](ai-opponents.md). |
| `TURNSTILE_SITE_KEY` | Public challenge key for the configured hostname and actions |
| `TURNSTILE_SECRET_KEY` | Private server verification secret |
| `EMAIL` and `EMAIL_FROM` | Email binding and approved sender `chess@ejmlabs.com`; onboarding and verification/recovery delivery to the approved recipient are recorded; broad delivery, outage and complete cost checks remain open |
| `BUDGET_STOP_WEBHOOK_SECRET` | Optional secret for the dedicated monotonic stop endpoint; absent or invalid keeps it disabled; see [budget setup](cloudflare-budget.md) |
| `CF_ACCESS_TEAM_DOMAIN` | Exact Cloudflare Access team domain |
| `CF_ACCESS_AUD` | Expected Access application audience |
| `OWNER_EMAILS` | Explicit verified account allowlist, also matched to Access identity |
| `ANALYSIS_QUEUE` | Optional delivery hint; D1 retains analysis work for scheduled recovery |
| `ANALYSIS_ENABLED` | `false`; separate from ranked admission |
| `ANALYSIS_DAILY_LIMIT` | 20 attempts per UTC day by default, hard ceiling 100 |
| `ANALYZER` | Optional private sleeping Stockfish Container namespace |
| `ANALYSIS_DEAD_LETTER_QUEUE` | Optional notification path; durable dead letters stay in D1 |

Secrets belong in Cloudflare’s secret storage. Enter them through a provider UI
or hidden input. Never put them in the public bundle or Wrangler variables.
Do not paste them into chat for setup or debugging.

## Build and review

Run these checks from the product under Node 24:

```sh
npm run typecheck
npm test
npm run build
npm run worker:check
```

Inspect the generated public guides, navigation, metadata, piece credits, and
asset links. Check desktop and narrow screens, light and dark themes, keyboard
move controls, focus, promotion, touch interaction, and reduced motion. Record
the actual check results and limitations in the change summary.

Use a real local Worker for same-origin cookies, HTTP routes, WebSockets,
reconnection, and durable state. A static preview cannot establish game or
account behavior. Production email, Turnstile, Access, cache headers, and the
canonical host each need a later check on the approved environment.

## Safety ceilings and maintenance

The owner approved a $100 monthly chess spending envelope, with stops and
alerts. [Budget and stop controls](cloudflare-budget.md) document the usage
counters, private operator API, alert thresholds, shared-account accounting,
recovery, and limits. Application counters and Cloudflare alerts do not enforce
a hard invoice cap. The three usage-alert policies and the high
policy's dedicated stop-webhook association were saved and read back. The
secret-authenticated provider Save/Test callback passed. An actual billing
threshold event, its email delivery and complete deployed costs remain
unverified. The webhook can only stop new work; a successful test does not
establish a dollar ceiling.

The per-feature ceilings default to off. The monthly budget stop is the
economic governor; only the platform byte bound and security/rate controls
remain. Do not lower a ceiling to shape demand.

The existing new-game stop also stops signup. Operations shows monthly and
lifetime signup use. One D1 update reserves an attempt after server Turnstile
and basic validation, before Better Auth's rate limits and hashing. Failed,
uncertain and retried requests stay charged. One fixed aggregate row keeps
this accounting bounded. Signin and existing games continue. Exhaustion pauses
signup; do not reset counters or delete accounts to conceal it. These caps
do not bound ordinary HTTP traffic, signin attempts or the provider invoice.

These admission limits protect this local beta. They are not measured
worldwide capacity. Finishing a game or releasing a seat does not free retained
payload capacity. Successful proved retirement does. The permanent ID ledger
and minimal Game tombstone remain. Admitted creators may retry and opponents
may join an available retained invitation when the cap is full.
Unknown IDs and cap-denied creates must not invoke a Game RPC and allocate
empty object storage. Invalid casual limits close new admission.

Ranked limits use their defaults for invalid/nonpositive values, cap positive
values at 1000, and can be reduced before a deployment. The retained-ranked
ceiling is separate from the unsettled limit. Existing games and result
outboxes must drain even while new admission is closed. Do not delete a ledger
or raise a ceiling to hide storage growth. Ranked authority and rating events
are not retired by the casual payload job. Their retained ceiling still closes
new admission. Permanent replay, account, case, tournament ID, and rating records
also grow. A separate permanent ID ceiling stops new admission; payload
retirement does not prove bounded total storage or unlimited operation.

Optional automatic analysis requires exact `ANALYSIS_ENABLED=true`. Disabled
or missing analysis configuration leaves ranked result projection and outbox
drain independent of a Queue binding, including rows saved by older deployments.
Those optional sample steps are skipped after successful projection; enabling
analysis later does not backfill them. Already accepted Queue/D1 jobs remain
stored. With analysis enabled, a missing or failed Queue keeps its saved
outbox intent for retry. See [analysis recovery](analysis.md#durable-work-and-recovery).

The private Game binding also supports `retryResultDelivery` after transport
recovery. It requires the exact saved terminal event ID and digest, then uses
normal Competition settlement and seat release. It can bypass a delivery retry
delay but cannot create a result or change clocks, history or the outcome.
Ordinary alarms retain their backoff. No public HTTP route exposes this method.

The per-minute scheduled handler runs bounded Competition, game recovery,
payload retirement, and report-to-analysis maintenance before draining analysis. Independent tasks
report safe stage names on failure. Authority status retains failed stages,
projection lag, repair lag, incidents, and pending counts. The daily 03:15 UTC
trigger also runs bounded private-data and analysis cleanup. A
source schedule is not proof a deployed trigger is operating.
Wrangler development does not run checked-in cron expressions on its own.
Use its `--test-scheduled` mode and the displayed local scheduled endpoint to
dispatch the minute or daily expression, or run an authorized owner maintenance
cycle. Merely refreshing History reads its D1 projection and does not repair a
missed local scheduled invocation.

Game recovery checks at most four admitted IDs per UTC minute across repeated
or concurrent calls. It retries missing terminal projections and overdue
adjudication through the authority's normal status/outbox path. Failed or live
records have a five-minute poll cooldown so the oldest four cannot starve the
rest. A large outage backlog may delay this fallback; the stored outcome time
still uses the original deadline. Durable Object alarms remain the first path.
Competition serializes alarm updates and keeps an earlier pending deadline.
A full maintenance pass can advance a deadline due when it began, while keeping
alarms armed after its start. After dispatch, maintenance arms the next deadline.
Repeated player requests cannot postpone a pending alarm.
New arena entries reserve the existing 50-per-second, burst-100 registration
bucket before external session, eligibility and budget checks. An empty bucket
returns `ARENA_RETRY` without D1 or controller calls, event discovery or
maintenance scheduling. Failed checks keep spent tokens; retries cannot refund
them. Current entries skip the charge, while a concurrent withdrawal requires
a token before rejoining. The final transaction still checks session expiry,
closure, event state, entrant capacity and storage. Fresh session and eligibility
reads run together. Registration returns the persisted local view without
another D1 read; public account-state reads still authenticate.
An identical repeat registration skips its write, sync and alarm calculation.
Session refresh still persists the actor, and new events, entrants and renamed
standings still schedule maintenance. Other actions and uncertain failures
retain conservative scheduling. This change has no measured throughput claim.

Payload retirement has two modes. Missing `GAME_RETIREMENT_MODE` or exact
`preview` preserves the separate global four-attempt budget per UTC minute.
Exact `scaled` uses the existing global Competition as the single coordinator,
an indexed D1 work queue, at most 32 candidates per pass and four archive RPCs
in flight. A fixed D1 token bucket permits a burst of 32 and refills at 32
attempts per second across callers and restarts. Any other value closes
retirement work. Neither mode changes admission or usage counters.

Apply migration `0011_retirement_work.sql` before this source. It backfills
eligible work and maintains queue rows through triggers. The Competition
alarm retains its next-due hint; minute and manual maintenance wake the same
single-flight path. No additional service or per-game cleanup loop is used.
Held or failed records receive a five-minute retry marker so other due work
can progress. Recovery still has its independent four-attempt minute budget.

Both modes select only finished unrated casual or tournament games that ended
at least one hour ago. The Game object independently verifies the exact D1 terminal
version, rules version, and digest; no active seats, result delivery, AI turn,
retained evidence, or unresolved appeal may remain. A short D1 lease blocks
new evidence attachment while it commits the tombstone and removes the heavy
state, command receipts, and connection rows. It clears its engine cache,
closes sockets, and removes the alarm. It never calls `deleteAll`.

Only a stable Game receipt permits D1 to mark the payload archived. A crash
between these steps leaves a retained ledger entry; retry returns the same
receipt. Failure applies a five-minute cooldown. D1 game history and PGN remain
private and available for replay. Authorized live-game requests for an archived
ID return `410 GAME_ARCHIVED` with a `/replay/?game=<id>` link before any Game
RPC. Unrelated accounts receive 404. A used ID can never start another game.
Evidence recorded after archival retains the D1 replay, rather than recreating
the retired payload. A setup that never produced a proved terminal record
cannot be safely retired by this path.

Local native checks archived 1,000 real games and preserved their permanent
IDs and replay. This proves logical cleanup for that batch. A sample SQLite
database kept the same allocated size after cleanup; physical storage
reclamation, 72,000-payload steady state and live cost remain unproved. Use
the [local qualification report](local-qualification.md) for methods and
measurements. Keep public admission at its conservative limits.

When tournaments are enabled, registration opens 15 minutes before hourly
blitz, daily rapid at 18:00 UTC, and Sunday rapid at 16:00 UTC. The initial
events have three or four eligible entrants, three rounds, and at most six
games, with a 60-second intermission. A blitz round ends after 18 minutes and a
rapid round after 40 minutes. Event standings are separate from global ratings.
Missing players, changed eligibility, service interruptions, and round cutoffs
use stored cancellation or no-score outcomes and release event reservations.
The current fixed safety limits are three active events, 256 retained event
records, 100,000 retained event Game payloads, and 1,000,000 permanent event game IDs.
Old event presentation records can be removed after seven days once all their
Game payloads are retired; game replay and permanent ID records remain.

The requested public capacity for hundreds and thousands of entrants is not
qualified. Native local checks cover three 2,000-entry events sharing 1,000
real games, duplicate results, restart recovery and complete paged standings.
The default-disabled arena work still needs deployed authentication, cache,
alarm, regional, sustained admission, storage and cost evidence before public
admission is raised. See [the local methods and limits](local-qualification.md).

Arena configuration keeps the feature disabled. Larger accepted settings are inputs for explicitly scoped local
qualification. They do not raise the approved monthly spending envelope,
authorize a public deployment, or prove capacity. Malformed or out-of-range
arena limits close admission. Record and byte headroom, budget stop,
start-rate admission, cross-mode reservations, permanent IDs, and retirement
throughput remain separate checks. Per-event entrants and global game/storage
ceilings must not be confused when planning a workload.

Open `/admin/` with the matching verified owner account and Cloudflare Access
identity. Cases use 20-row cursor pages; use Older cases or Newest cases to
reach the rest of the review queue. Under Operations, use Refresh status to inspect usage counts,
oldest work, failed outboxes, pending corrections, and paused pools. Retry pending
work runs one bounded maintenance cycle and reports safe stage errors. Repeat
only after investigating persistent failures. It does not reset an accepted event.
The private status response also includes monthly usage, usage counters,
operator stops, receipt pressure, recent control changes, and bounded history.
The stop API requires the current control version and records who changed it.

Account request windows and their exhausted-window counter commit in one D1
batch. Private operations reports fixed counter keys, not request bodies or
account identifiers inside those counter objects. Game-specific security
counters require both the owner account and Access identity. Informational
ranked farming checks include pending rating-repair results and expose their
policy, work limits, and pending or incomplete coverage. They never apply a
penalty or change queue priority. See [fair-play operations](fair-play.md) for
the exact patterns, public request windows, counter privacy, and retained bounds.

See [analysis](analysis.md) for the private engine build, disabled Container
bindings, measured memory/throughput, daily cap, leases, dead letters, and canary
gates. The 0.25-CPU local profile hit its deadline. Do not provision that tier
as a validated analysis service.

## Recovery

### Capture native recovery metadata

The owner-only recovery endpoints provide bounded admitted-ID inventory and
read-only native bookmarks for Game and Competition. They require the same
verified owner account and matching Access identity as `/admin/`. Unknown game
IDs are rejected before a Game RPC. Inventory includes pending ranked matches,
permanent admission IDs and archived tombstones. It is not a cross-store snapshot.

Capture synchronizes one object's storage, inspects its schema/state under a
concurrency barrier and returns hashes, native bookmark, exact object ID, alarm,
policy versions, watermarks and pending counts. It never changes a clock,
receipt, result, epoch or outbox. It returns no raw account, session or evidence
rows. The format fails closed above 4,096 rows or 2 MiB per object, or when the
provider cannot supply a bookmark. Production has no restore/restart endpoint.

See [the exact capture routes and isolated provider drill](recovery-drill.md)
for protected invocation, resource checks, D1-before-DO ordering, private
manifests, undo records and verification limits. Local guard and fixture checks
do not establish provider restoration or full-service recovery. Keep task 6.3
and ranked launch gates open until the actual rehearsal and retention policy
are recorded.

### Client disconnect or stale position

Reopen the same game URL with the same account. Let the server snapshot replace
the displayed state. The active clock continues. Do not reset a game clock or
invent an accepted move to compensate for a client failure.

### Missing result or rating settlement

Keep the game terminal record and delivery state. Compare the result’s event
ID, version, rules version, and digest with the authoritative game object.
Investigate the competition owner’s reservation and receipt before retrying.
Use the existing idempotent delivery path. Do not replay a browser-supplied
result or apply ad hoc updates to one player’s rating.

A timeout ends the game at its deadline with a loss for the player who ran out
when the other side has mating material, otherwise a draw. Only a ranked v3
proof game waits up to 30 seconds for a private proof and then applies the same
rule, rated. The durable result outbox releases seats through accepted
settlement. Late or repeated alarms, maintenance, and result delivery cannot
duplicate a terminal event. A fully blocked position with no possible mate
scores as a loss; ranked play stays closed until the policy and recovery limits
are accepted and verified.
Recovery preserves a stored game's original rules version. The settlement
boundary accepts known v1, v2 and the default-off v3 proof policy and still
requires exact authority data. Historical automatic void decisions name the v2
operational policy even when the original game record remains v1; new v3 voids
name v3. Existing v1 delivery receipts retain their original wire shape; an
unknown rules version is rejected.

The private v3 proof pool holds its slot and two game credits through pending
adjudication and settlement. Existing accepted proof work drains through the
same game stop used by monthly budget controls. Do not remove its binding while
reserved games remain. A supported exact proof can settle once before the
unchanged deadline; failed or unknown work cannot extend it. Profile and ranked
enablement remain gated on local and provider corpus/resource/cost qualification.
See [timeout-proof operations and reproduction](timeout-proofs.md).
The same guide documents the separate unarmed fixed-corpus provider harness.
Its isolated bindings, permanent stop, two-hour expiry, finite reservations
and command allowance are qualification controls, not production launch or an
invoice cap. Review fresh resource ownership and complete costs before adding
any paid Container to that template. Keep cost and source-permit reviews,
actual owner residual-cost acceptance and later provider-resource evidence
separate, with immutable hashes bound to the exact private candidate.
Financial adoption alone grants no extra work or production admission.
See [the four records](timeout-proofs.md#separate-financial-source-and-provider-gates).

### Authentication or mail outage

Keep ranked admission closed and show a retryable failure for email operations.
Password signup, signin and player competition eligibility do not need mail.
Recovery email is optional; accounts without one have no email password reset.
Verify the sender and budget settings before retrying verification or recovery.
See [account operations](accounts.md). Do not disable
origin checks, cookie security, session revalidation, Turnstile, or credential
requirements to restore access. Owner administration still requires its real
verified email and matching Access identity. Local mail failure is expected.
Active seats must remain owned by their original account during an identity change.

### Account privacy controls

The Account page offers password-confirmed bounded export and account closure
without requiring email or an operator. Closure removes private account data
atomically, retains permanent competition identity, and fences admission and
in-flight auth writes. Abandoned pending fences recover after their five-minute
identity lease; an accepted closure remains blocked. See [privacy](privacy.md)
for API, retention, export limits and lost-password limits. The isolated
[privacy drill](qualification/provider-privacy-20261021.md) passed one no-email
account's export, closure, native D1 rollback and two exact saved-receipt
reapplications. Release on the canonical host and the broader privacy gate
remain open.

Keep native recovery history separate from a downloaded SQL export. D1 Paid
and SQLite Durable Objects retain rolling 30-day native history. An additional
private export needs its own approved destination, access rules and expiry;
no production account/session SQL export is required or authorized here.
Before an approved restore, preserve later closure receipts outside every
target, reapply them through the same lifecycle adapter, and reconcile durable
closure fences before authentication or admission reopens. Keep access closed
if any later closure or authority boundary is uncertain. Delete accepted raw
synthetic drill files within 30 days and retain sanitized reports and hashes.

### Optional private review

Check the Access application policy, issuer, audience, owner allowlist, and
account email verification. Do not add a local or emergency header bypass.
Ordinary operation does not wait for Access or a reviewer. In unattended mode,
reports disclose unavailable review and cannot cause a cheating finding,
restriction, or rating removal. New human case and appeal decisions require
exact `OPERATION_MODE=reviewed` as well as the existing Access/account controls.
Existing restrictions still expire within seven days. In unattended mode, an
open report becomes eligible for `expired-unreviewed` closure after seven days,
without a human decision, unresolved appeal or future evidence hold. The daily
private cleanup closes at most 500 through an indexed age query, preserves the
1,000-open-case cap, receipts and normal evidence expiry, and records automatic
outcome/time separately. Duplicate reports and late analysis cannot reopen a
case or extend retention. An unresolved appeal closes after 14 days as
`expired-unreviewed`, with its separate automatic metadata.
It creates no human decision and does not silently reverse historical ratings.
Keep notices and historical decisions intact. See [fair play](fair-play.md).

### Export the authority event journal

Use `/admin/` > Operations > Capture export manifest. Save the manifest, then
select each journal and save every page through its fixed watermark. Pages hold
at most 50 events and include `nextCursor` and a SHA-256 hash. Keep them private.
The hash covers the compact JSON page without `sha256`, preserving field and
row order. Verify hashes before using the records in a restore drill.

The exported kinds are results, ratings, correctedRatings, corrections, voids,
restorations, checkpoints, and arenaScores. Arena score receipts preserve the
accepted event, game, points, and policy identities; they are not a complete
backup of active entrants or queue claims. The manifest includes policy versions, published
epochs, pending results, and repair state. Do not treat an export taken during
repair as a complete stable backup. Repeat after repair and reconcile later
accepted events before recovery. Published checkpoint and event rows are
append-only in this foundation.

The local fixture drill restores a multi-page journal into a fresh isolated
authority, replays accepted results, and compares ratings after eviction. There
is no production import endpoint. This journal excludes Better Auth accounts,
private cases, active game state, sockets, and game delivery outboxes. It cannot
restore the entire service. A coordinated provider backup/export and rehearsal
of those stores, privacy controls, restore tooling, and backup expiry remain
launch gates. Keep the originals and an offline copy under an owner-approved
retention and access policy.

### Data loss or corruption

Close ranked admission, preserve current state, and stop repairs that could
overwrite evidence. Follow an approved backup and restore procedure for D1 and
the affected Durable Objects. No production backup restoration has been
verified yet. Restoration and rating replay must be rehearsed before launch.

### Full-service backup and restore gates

The authority journal drill proves a bounded event replay contract. It does not
prove service restoration. Use the maintained provider D1 Time Travel and
SQLite Durable Object point-in-time recovery APIs where available. They do not
create one transaction across D1, Competition, and every Game object.

The remaining recovery work is concrete:

| Store | Required backup and isolated restore evidence |
| --- | --- |
| D1 | Rehearse approved native recovery of accounts, sessions, replay, seats, reports, restrictions, admissions, budget receipts/counters and stops on isolated synthetic data; verify schema and reapply post-boundary closures before access opens; any separate SQL export needs explicit approval |
| Competition | Capture a fixed-watermark private journal; restore the serialized authority with pending reservations, outboxes, repair state, and rating epochs; reconcile events accepted after the watermark |
| Game objects | Enumerate admitted permanent IDs; capture supported recovery bookmarks and rehearse active clocks, accepted command receipts, pending results, archived tombstones, and reconnect ownership |
| Optional analysis | Reconcile durable D1 jobs and existing queue deliveries without duplicate evidence or losing a stored summary |
| Configuration | Preserve resource IDs, bindings, secret names, cron, origin, Access, Turnstile, sender configuration, and the exact deployable revision; keep secret values in an approved secret store |

Before any production restore, close new admission, preserve the current state,
choose a coherent recovery boundary, and obtain approval for the exact target.
Restore to isolated resources first. Check that no accepted terminal event or
permanent ID disappears, no ID is reused, no rating is applied twice, session
and seat owners match, and budget receipts match their aggregate counts.
Keep new work closed if any store's boundary is uncertain. Follow the normal
idempotent outbox and reconciliation paths for later accepted events.

No full-service backup/export coordinator, production restore endpoint or
measured recovery objective is established here. The dated isolated report
records native rehearsals and their limits. The approved privacy policy covers
automated account requests, retained history and restore reapplication. The
single-account provider drill passed; positive reset-row recovery, concurrent
later-closure sets and production acceptance remain open. Do not expose a public import
endpoint or copy private production data into fixtures.

## Public launch gates

**Owner policy update, 2026-10-30.** Do not gate public opening on a pre-run
2,000-player workload. The monthly billing stop, security controls and
platform-safety ceilings govern admission. Measure demand after opening. The
capacity-run requirements below are retained as follow-up qualification, not a
launch blocker.

The owner approved the initial release sequence on 2026-10-21 UTC. Public
ranked play and the first large-arena tier open together after four checks:
the real Game/proof/Competition recovery path; the full approved
2,000-player-per-event provider workload; protected-host player flows; and live
privacy, admission and spending-control readback. The October 22 spending policy
uses one $100 monthly target, usage alerts and an emergency stop (thresholds are kept in the private provider record).
Earlier service allocations and mandatory reserves no longer gate launch.
The isolated capacity run retains its approved $25 incremental ceiling.
See [proof qualification](timeout-proofs.md),
[the fixed capacity run](capacity-qualification.md),
[spending controls](cloudflare-budget.md), and
[live-ready prep](live-ready-prep.md) for offline prep versus live verify rows.

The nine-day calendar observation, full-hour retention/endurance workload,
six-region WAN benchmarks and later capacity tier remain unfinished
[follow-up qualification](capacity-follow-up.md). They do not block this
initial release or establish supported performance. Keep public ceilings
within the passing first-tier evidence and remaining monthly headroom.
Optional server analysis stays disabled. A frozen provider workload still
requires the separate approval recorded in its run plan.

| Gate | Required evidence |
| --- | --- |
| Legal rules | Versioned online rules, tested legal moves, clocks, restart recovery, material timeout rule, and ranked proof fallback when enabled |
| Ranked docs vs code | Player Guide and architecture match implemented matchmaking, color balance, Glicko starts (1500 / RD 350 / vol 0.06), pair limit (2/24h), and correction batches of 20; two-session verify still required |
| Accounts | Canonical host, secure cookies, real email delivery, session expiry/revocation, and active-seat identity checks |
| Fair play | Tested objective abuse controls, private reports with honest review availability, no statistical sanctions, expiry, and accepted cheating limits; optional reviewed mode needs corroboration and appeal/correction checks |
| Abuse controls | Turnstile host/action checks, bounded requests, rate limits, queue limits, and reconnect admission |
| Access policy | Validated Access JWT, owner account match, least privilege, and no development bypass |
| Privacy | Password-confirmed export/closure, retained history, appeal/evidence holds, bounded minimization, native-history expiry and reapplication of later closures before restored authentication or admission opens |
| Recovery | Tested outbox retries, duplicate delivery, object restart, database restoration, and rating replay/reversal |
| Capacity and cost | Measured workload with explicit concurrency, CPU, storage, latency, queue, and spending limits |
| Publication | Owner-approved resources and release, live origin/TLS checks, public docs, navigation, assets, and license notices |

Record the test environment, date, workload, result, and owner for each gate.
No gate passes merely because its source or configuration exists. Do not claim
the live site or public docs changed until publication is verified.
