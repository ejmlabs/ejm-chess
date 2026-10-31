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

New deployments default to closed ranked admission. `RANKED_ENABLED=true`
alone opens ranked play, after the release's player and recovery checks. A
static build or Worker dry run alone does not establish a working production
release. The ordered release sequence and exact production values are in
[live-ready prep](live-ready-prep.md).

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
| `TOURNAMENTS_ENABLED` | Exact `true` enables new automatic unrated round-robin events and entry; any other value closes them. Disabling cancels events that have not started; running events finish. No fixed event, payload or ID cap applies |
| `ARENAS_ENABLED` | Exact `true` opens timed arenas, independent of ranked; any other value closes them. Disabling cancels unstarted events; running events finish |
| `ARENA_ENTRANT_LIMIT` | Unset means no product cap; a positive integer sets one; `0` or a malformed value closes admission. Platform storage and the monthly budget apply |
| `ARENA_GAME_LIMIT` | Unset means no product cap; a positive integer sets one; `0` or a malformed value closes admission. Platform storage and the monthly budget apply |
| `ARENA_RETAINED_GAME_LIMIT` | Unset means no product cap; a positive integer sets one; `0` or a malformed value closes admission. Retirement and the monthly budget bound growth |
| `ARENA_GAME_ID_LIMIT` | Unset means no product cap; a positive integer sets one; `0` or a malformed value closes admission. The monthly budget bounds new IDs |
| `ARENA_AUTHORITY_BYTE_LIMIT` | 4 GiB (`4294967296`) is both default and maximum; a lower positive integer reduces it; `0`, a malformed or a larger value closes admission. Competition SQLite platform safety stop, including reserved unfinished-game headroom; accepted results still drain |
| `RANKED_ENABLED` | Exact `true` opens ranked queueing and play; closed otherwise. Credential-backed accounts still need eligibility checks; recovery email is optional. `/api/config` reports `ranked` from this flag. Setting `false` is the ranked-only stop in [live-ready prep](live-ready-prep.md#stop-levers) |
| `PRODUCTION_RESOURCE_IDS` | Private comma list of production D1 and namespace IDs. The isolated recovery drill Worker reads it and refuses those resources; unset or empty refuses every run. The public Worker does not read it |
| `NEW_WORK_STOPPED` | Unset or exact `false` leaves new work open. `true`, and any other value, stops new signup attempts, game reservations, account-security sends; existing signin and accepted games/results retain their recovery paths |
| `CASUAL_GAME_LIMIT` | Unset means no product cap; a positive integer sets one; `0` or a malformed value closes new casual admission. Retirement and the monthly budget bound growth |
| `CASUAL_GAME_ID_LIMIT` | Unset means no product cap; a positive integer sets one; `0` or a malformed value closes new casual admission. The monthly budget bounds new IDs |
| `RANKED_GAME_LIMIT` | No product cap by default; a positive integer sets one. `0` or a malformed value keeps no cap |
| `RANKED_QUEUE_LIMIT` | No product cap by default; a positive integer sets one. `0` or a malformed value keeps no cap |
| `RANKED_RETAINED_GAME_LIMIT` | No product cap by default; a positive integer sets one. `0` or a malformed value keeps no cap |
| `AI_ENABLED` | Browser Stockfish practice gate. Exact `true` opens new practice; unset or any other value closes it. Enabled in local config and in the protected canary. No provider key or token quota; see [computer practice](ai-opponents.md). |
| `TURNSTILE_SITE_KEY` | Public challenge key for the configured hostname and actions |
| `TURNSTILE_SECRET_KEY` | Private server verification secret |
| `EMAIL` and `EMAIL_FROM` | Email binding and approved sender `chess@ejmlabs.com`; onboarding and verification/recovery delivery to the approved recipient are recorded; broad delivery, outage and complete cost checks remain open |
| `BUDGET_STOP_WEBHOOK_SECRET` | Optional secret for the dedicated monotonic stop endpoint; absent or invalid keeps it disabled; see [budget setup](cloudflare-budget.md) |
| `CF_ACCESS_TEAM_DOMAIN` | Exact Cloudflare Access team domain |
| `CF_ACCESS_AUD` | Expected Access application audience |
| `OWNER_EMAILS` | Explicit verified account allowlist, also matched to Access identity |

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
npm run budget
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

Product admission limits are off by default (owner decision, 2026-10-31).
Behavior under heavy load is still being measured, and worldwide capacity is
not established. If an owner sets a casual limit, finishing a game or releasing
a seat does not free retained payload capacity. Successful proved retirement
does. The permanent ID ledger and minimal Game tombstone remain. Admitted
creators may retry and opponents may join an available retained invitation when
a set limit is full. Unknown IDs and limit-denied creates must not invoke a Game
RPC and allocate empty object storage. Invalid casual limits close new
admission.

Ranked limits also default to no product cap. A nonpositive or malformed value
keeps that default, and a positive value sets one before a deployment. Existing
games and result outboxes must drain even while new admission is closed. Do not
delete a ledger or raise a ceiling to hide storage growth. Ranked authority and
rating events are not retired by the casual payload job. Permanent replay,
account, case, tournament ID, and rating records also grow; payload retirement
does not prove bounded total storage or unlimited operation.

The private Game binding also supports `retryResultDelivery` after transport
recovery. It requires the exact saved terminal event ID and digest, then uses
normal Competition settlement and seat release. It can bypass a delivery retry
delay but cannot create a result or change clocks, history or the outcome.
Ordinary alarms retain their backoff. No public HTTP route exposes this method.

The per-minute scheduled handler runs bounded Competition, game recovery and
payload retirement maintenance. Independent tasks report safe stage names on
failure. Authority status retains failed stages,
projection lag, repair lag, incidents, and pending counts. An incident records
a rejected result (conflicting, unverified, or a ranked result with no matching
reservation) and changes no rating or outcome. Every minute it also trims
expired rows (see below). The daily 03:15 UTC trigger adds bounded private-case
retention cleanup. A source schedule is not proof a deployed trigger is
operating; read the [cron heartbeat](#cron-heartbeat).
Wrangler development does not run checked-in cron expressions on its own.
Use its `--test-scheduled` mode and the displayed local scheduled endpoint to
dispatch the minute or daily expression, or run an authorized owner maintenance
cycle. Merely refreshing History reads its D1 projection and does not repair a
missed local scheduled invocation.

Game recovery checks at most four admitted IDs per UTC minute across repeated
or concurrent calls. It retries overdue pending adjudication (games saved under
earlier rules versions) and missing terminal projections through the
authority's normal status/outbox path. D1 holds no Game deadlines, so it cannot
tell a healthy game from an overdue one. Competition already reconciles every
game it admitted through a durable intent (casual, round-robin and arena) at
least every 30 seconds, so recovery skips those until the admission is a day
old, longer than any clock allows. A casual game admitted before durable
intents (no reservation) has no such owner and is polled once 30 seconds have
passed. Polled records have a five-minute cooldown so the oldest four cannot
starve the rest. Fifteen healthy admitted games cost 30 recovery polls in ten
minutes before this change and none after (local run, not staged or released).
A large outage backlog may delay this fallback; the stored outcome time
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
measurements. Measure live demand after opening.

When tournaments are enabled, registration opens 15 minutes before hourly
blitz, daily rapid at 18:00 UTC, and Sunday rapid at 16:00 UTC. The initial
events have three or four eligible entrants, three rounds, and at most six
games, with a 60-second intermission. A blitz round ends after 18 minutes and a
rapid round after 40 minutes. Event standings are separate from global ratings.
Missing players, changed eligibility, service interruptions, and round cutoffs
use stored cancellation or no-score outcomes and release event reservations.
Round-robin and arena events have no product cap on active events, retained
event records, retained Game payloads or game IDs (owner decision, 2026-10-31).
Old event presentation records can be removed after seven days once all their
Game payloads are retired; game replay and permanent ID records remain.

Public capacity for hundreds and thousands of entrants is not qualified. The
2,000-player capacity harness was deleted on 2026-10-31 and no provider load run
is planned. Native local checks cover three 2,000-entry events sharing 1,000
real games, duplicate results, restart recovery and complete paged standings.
Deployed authentication, cache, alarm, regional, sustained admission, storage
and cost behavior is measured after opening. See
[the local methods and limits](local-qualification.md). If demand ever needs
checking, write a small staging load script then.

The `ARENA_*` limit variables are optional owner inputs. Unset means no product
cap. They do not raise the approved monthly spending envelope or prove
capacity. Malformed or out-of-range values close admission. Record and byte
headroom, budget stop, start-rate admission, cross-mode reservations, permanent
IDs, and retirement throughput remain safety checks. Per-event entrants and
global game/storage ceilings must not be confused when planning a workload.

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
policy, work limits, and pending or incomplete coverage. Their status reads a
bounded window and reports `truncated` beyond it. They never apply a
penalty or change queue priority. See [fair-play operations](fair-play.md) for
the exact patterns, public request windows, counter privacy, and retained bounds.

### Cron heartbeat

Each cron invocation records one D1 row per schedule in `cron_heartbeats`
(migration `0016`): when the run started, when it finished and the stages of the
latest failure. `GET /api/admin/operations` returns it as `cron.minute` and
`cron.daily` with `schedule`, `startedAt`, `finishedAt`, `lastError` and
`lastErrorAt`; all are null for a schedule that has not run. Implemented and
locally tested; the canary records nothing until migration `0016` is applied and
this revision is released.

A schedule is healthy when `finishedAt` is not older than `startedAt`, is recent
(the minute schedule within about three minutes, the daily one within a day plus
the run), and `lastErrorAt` is null or older than `startedAt`. A run that died
leaves `startedAt` newer than `finishedAt`. `lastError` lists stage names
(`competition`, `unattended_games`, `expired_rows`, `private_cleanup`), never
messages, and a later clean run does not erase it. A failing stage never stops
the others. A failed heartbeat write is logged as `heartbeat_failed` and never
stops maintenance. Alarm-driven Competition maintenance is not part of this
record; `authority.lastMaintenanceError` still reports it.

### Expired-row cleanup

The minute schedule removes one bounded batch of 500 rows per table per run
(`cleanupExpiredRows`) from the tables that grow with traffic: account request
windows (`request_limits`), identity-change leases, expired verification
secrets, expired sessions, sign-in rate limits (`rateLimit`) and seats released
30 days ago. That is room for 720,000 deletions per table per day, and a backlog
larger than one batch drains over the next runs. Each statement seeks an index;
migration `0016` adds the missing released-seat index, so an idle run reads no
rows. Implemented and locally tested; the released canary still runs the daily
pass until this revision ships.

Growth measured on a local D1 by driving the real routes:

| Activity | Rows created | Removed |
| --- | --- | --- |
| One sign-up or sign-in | 1 `session`, and 1 `rateLimit` per client address and path | Session 7 days after sign-in; limit row 1 day after last request |
| A signed-in account reading, writing or opening sockets | 1 `request_limits` row per kind used, reused in place, plus 1 `seat:` row when it takes a seat | 1 day after last use |
| One game | 1 `active_game_seats` row per player | 30 days after release |

The earlier daily pass removed 500 rows per table per day. At 4 rows per active
account, 2 per game and 1 per sign-in it fell behind above about 125 daily
active accounts, 250 games or 500 sign-ins a day. Watch `lastError` on the
minute heartbeat; a table that still lags would show as a rising D1 size, not as
an error. The daily run keeps private-case retention (report expiry, evidence
and text minimization) and legacy guest removal (at most 100 a day, no new rows).
Those grow only with reports, which the 1,000-open-case cap and the daily limit
per reporter already bound.

### Public read cache

Unauthenticated public JSON reads share one helper (`src/server/public-cache.ts`):
the arena schedule, summary and standings, the leaderboard and public player
profiles. The edge keeps a response for 10 seconds in the Cache API; browsers
receive `public, no-cache` and revalidate against it. The cache key is the path
plus the route's documented parameters only: `cursor` for arena standings, and
`pool` and `cursor` for the leaderboard. Cookies, headers and any other query
parameter never create a variant. A warm read does no D1 query and no session
lookup, so these routes do not count against the per-account read window. A
failed or missing read is never stored. Private or per-viewer data and every
mutation stay outside the helper. Leaderboard and profile caching is implemented
and locally tested, not yet released.

Not cached, on purpose: `GET /api/config` (reads no storage) and
`GET /api/tournaments[/:id]` (they carry the caller's own status and a
`serverNow` clock sample that countdowns depend on).

The cache bounds repeat reads, not distinct ones. Random player IDs, many
leaderboard cursors and the uncached tournament reads still reach D1 or the
Competition, and the product adds no cap for them. The Cloudflare-side control
is a WAF rate-limiting rule on the zone, counted per client IP, for example
`http.request.method eq "GET" and (starts_with(http.request.uri.path, "/api/players/") or http.request.uri.path eq "/api/leaderboard" or starts_with(http.request.uri.path, "/api/tournaments") or starts_with(http.request.uri.path, "/api/arenas"))`
with a Managed Challenge once a client passes a threshold the owner picks (120
requests a minute is a starting point). The owner creates it in the dashboard;
this repository does not apply it.

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
rows. A Competition larger than one page (4,096 rows or 2 MiB) captures page by
page: each response carries a `cursor` to send back until a response is the
complete envelope. A Game must fit one page and otherwise answers
`409 RECOVERY_CAPTURE_LIMIT`. Capture fails closed when the provider cannot
supply a bookmark. Production has no restore/restart endpoint.

See [the exact capture routes and isolated provider drill](recovery-drill.md)
for protected invocation, resource checks, D1-before-DO ordering, private
manifests, undo records and verification limits. Local guard and fixture checks
do not establish provider restoration or full-service recovery. The
restore-and-replay provider drill is follow-up only, not a launch gate (owner
decision, 2026-10-31); its code stays.

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
when the other side has mating material, otherwise a draw. This is the same in
every mode, including ranked, and the result is rated there. The durable result
outbox releases seats through accepted settlement. Late or repeated alarms,
maintenance, and result delivery cannot duplicate a terminal event. A fully
blocked position with no possible mate scores as a loss.

Recovery preserves a stored game's original rules version. The settlement
boundary accepts the known stored versions and still requires exact authority
data. Historical automatic void decisions name the v2 operational policy even
when the original game record remains v1. Existing v1 delivery receipts retain
their original wire shape; an unknown rules version is rejected.

### Authentication or mail outage

Show a retryable failure for email operations. Ranked and arena play continue.
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
outcome/time separately. Duplicate reports cannot reopen a case or extend
retention. An unresolved appeal closes after 14 days as
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
follow-up work, not launch gates. Keep the originals and an offline copy under an owner-approved
retention and access policy.

### Data loss or corruption

Stop new work, preserve current state, and stop repairs that could
overwrite evidence. Follow an approved backup and restore procedure for D1 and
the affected Durable Objects. No production backup restoration has been
verified yet. Rehearse restoration and rating replay as follow-up work.

### Full-service backup and restore follow-up

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

**Owner policy update, 2026-10-31.** Ranked play, arenas and tournaments open
with `RANKED_ENABLED`, `ARENAS_ENABLED` and `TOURNAMENTS_ENABLED` after the
critical path in [live-ready prep](live-ready-prep.md): protected-host player
flows, then live mail, alert, cron and stop readbacks. There are no arbitrary
product caps. Cloudflare budget alerts and the `$85` stop webhook are the
economic limit; alerts can lag, so this is not a hard invoice cap. Security and
abuse limits, protocol and input bounds, bounded per-request and per-alarm work,
fair-play rules (including 2 ranked games per pair per 24 hours), platform
safety bounds and the explicit stops stay. Ranked uses the material timeout
rule only, as casual does.

**Tooling decision, 2026-10-31.** The 2,000-player capacity harness and
server-side Stockfish analysis are deleted. No provider load run is planned, and
reports carry no engine screening. The restore-and-replay provider drill is
follow-up only and gates nothing. Browser Stockfish practice stays. Measure
demand after opening; if it ever needs checking, write a small staging load
script then. The October 22 spending policy (one $100 monthly target, usage
alerts, an emergency stop; thresholds are kept in the private provider record)
replaces earlier service allocations and reserves. See
[spending controls](cloudflare-budget.md).

| Gate | Required evidence |
| --- | --- |
| Legal rules | Versioned online rules, tested legal moves, clocks, restart recovery, material timeout rule in every mode |
| Ranked docs vs code | Player Guide and architecture match implemented matchmaking, color balance, Glicko starts (1500 / RD 350 / vol 0.06), pair limit (2/24h), and correction batches of 20; two-session verify still required |
| Accounts | Canonical host, secure cookies, real email delivery, session expiry/revocation, and active-seat identity checks |
| Fair play | Tested objective abuse controls, private reports with honest review availability, no statistical sanctions, expiry, and accepted cheating limits; optional reviewed mode needs corroboration and appeal/correction checks |
| Abuse controls | Turnstile host/action checks, bounded requests, rate limits, queue limits, and reconnect admission |
| Access policy | Validated Access JWT, owner account match, least privilege, and no development bypass |
| Privacy | Password-confirmed export/closure, retained history, appeal/evidence holds, bounded minimization, native-history expiry and reapplication of later closures before restored authentication or admission opens |
| Recovery | Tested outbox retries, duplicate delivery and object restart. The restore-and-replay provider drill is follow-up only |
| Capacity and cost | Not a launch gate. Spending follows budget alerts and the stop; load, CPU, storage and latency are measured after opening |
| Publication | Owner-approved resources and release, live origin/TLS checks, public docs, navigation, assets, and license notices |

Record the test environment, date, workload, result, and owner for each gate.
No gate passes merely because its source or configuration exists. Do not claim
the live site or public docs changed until publication is verified.
