# Scheduled tournaments

`TOURNAMENTS_ENABLED=true` enables automatic scheduling and new registration
for the small round-robin format.
Turning it off cancels new starts; events already running continue to drain.
Ranked games remain a separate gated feature.

This guide covers the three- or four-player round-robin format. The large-event
format is `arena-v1`, a timed arena with continuous pairing and its own
`ARENAS_ENABLED` gate. See the
[arena design and qualification contract](arena-design.md) for its rules,
resource bounds, and qualification evidence. Configuration ceilings are not
measurements; the release record states the tested workload.

## Local page and arena entry

The local `/tournaments/` page has separate **Arena events** and **Round-robin
preview** sections. Choose **View arena** to inspect an arena. Register first,
then choose **Join queue** when ready. Use **Open your game** once a game is
ready. After it settles and the reservation releases, choose **Queue for
another game** to play again. Navigation is explicit.

Arena standings pages stay in one published snapshot. Use **Latest first page**
to see the newest snapshot. An expired cursor restarts pagination with a notice.
Private entry state loads only for the selected arena and a signed-in
username/password account. Recovery email is optional for every player event.
Public standings remain available separately. Public schedule,
keyboard selection, empty standings, reload, and both themes at phone width
passed local browser checks. Credential-backed entry, queue/pause/resume,
nonempty multi-page standings, and expired-generation recovery remain browser
acceptance work.

## Schedule and entry

| Event | Start, in UTC | Game clock | Round wall limit |
| --- | --- | --- | --- |
| Hourly blitz | Every hour at minute zero | 5 minutes plus 3 seconds per move | 18 minutes |
| Daily rapid | Every day at 18:00 | 10 minutes plus 5 seconds per move | 40 minutes |
| Weekly rapid | Sunday at 16:00 | 10 minutes plus 5 seconds per move | 40 minutes |

Registration opens 15 minutes before the start and closes at the start.
An event admits three or four eligible human username/password accounts. Guests cannot enter.
There is no waiting list, entry fee, prize, or federation rating.

Registration does not reserve your account. You can withdraw before the start.
At the start the service checks current credentials, restrictions, other game
seats, and account reservations. Busy or ineligible entrants are skipped. Fewer
than three remaining entrants cancels the event. A missed start can recover
within five minutes; later recovery cancels an uncommitted event. If D1 already
admitted its fixed game IDs, recovery drains that committed event with its
original first-round cutoff. The next event remains
available when capacity permits.

An admitted account stays reserved through all three rounds and intermissions.
It cannot start casual games, join ranked play, enter another running event,
or change browser identity while reserved. Entry in another event before either
starts is allowed, but only one can admit the account. You cannot withdraw after
the start. You can close the page; scheduled deadlines continue on the server.
Closing the page does not make you ready for a round.

## Rounds and points

The service uses three Berger round-robin rounds. Each entrant meets every
other entrant once. Three entrants produce three games and one bye per entrant.
Four entrants produce six games. The initial order uses the existing pool
rating, then account ID. No additional rating is created from event points.

Each round has a 120-second readiness window within its wall limit. Both
players must press Ready. A 60-second intermission follows each completed
round before the next begins. The wall limit includes readiness and play.
The stored limit never resets after a retry or service restart.

| Event result | Points |
| --- | --- |
| Win | Winner 1, opponent 0 |
| Draw | 0.5 each |
| Bye | 1 |
| Exactly one player ready when readiness expires | Ready player 1, opponent 0 |
| Neither player ready | 0 each |
| Time runs out, other side has mating material | Other side 1, player who ran out 0 |
| Time runs out, other side cannot mate | 0.5 each |
| Round cutoff void or revoked eligibility | 0 each |

No-show points belong only to the event. The corresponding chess record keeps
no winner and no scored result. The service does not invent a checkmate,
resignation, or Glicko-2 result for a no-show. Every tournament game is unrated.
Event standings do not enter the global ranked leaderboard. Equal point totals
share a rank, with account IDs providing a stable display order.

The service checks current credential-backed account eligibility before every new game.
An account that loses eligibility during an intermission receives an immediate
zero-score terminal game record in its next pairing. It cannot open a playable
board for that pairing. A revoked or expired browser session cannot send game
commands. A currently valid session for the same eligible identity can continue
using its held account reservation.

When a player's clock runs out, the player who ran out loses if the other side
has mating material. If the other side has only a king, or the position is a
material draw, the game is a draw. A disconnect does not stop the clock, so it
scores the same way. A fully blocked position with no possible mate is not
detected and scores as a loss.

At a round's wall limit, an unfinished game becomes a technical void with zero
points for both players. A chess clock or readiness deadline that expired first
keeps chronological precedence. A completed game never changes because of a late
deadline or duplicate result.

The service does not guarantee that an hourly event finishes before the next
hour. Delays can extend an event. If three events are already active, a new
start is cancelled. These are bounded online events, not an official federation
format or a claim of exact federation adjudication.

## Recovery and resource limits

`Competition` owns the schedule, entries, pairings, event account locks, and
points. Moves and clocks remain in each `Game` Durable Object. The existing
minute trigger reconciles missed alarms and retryable work. See
[architecture](architecture.md) and [operations](operations.md).

Occurrence IDs use cadence and UTC start time. The service creates only the
current occurrence within its five-minute grace window and the next occurrence
of each cadence. It never creates all events missed during an outage.

Before round one, the service persists and atomically admits all three or six
game IDs needed by that event. Each round persists its game and reservation
IDs and cutoff before calling Game. A lost initialization response therefore
retries the same game. Accepted terminal results, points, and result markers
commit in one Competition transaction. Duplicate delivery cannot add points.

| Fixed tournament limit | Value |
| --- | --- |
| Active events, including starts and intermissions | 3 |
| Entrants per event | 3 to 4 |
| Rounds per event | 3 |
| Retained event records | 256 |
| Retained tournament Game payloads | 128 |
| Permanent tournament game IDs | 10,000 |
| Public terminal event visibility | 7 days from event start |
| Events processed per maintenance pass | At most 4 |
| Recent terminal events per public list | At most 12 |
| Upcoming or active events per public list | At most 9 |

These preview limits are fixed in `TOURNAMENT_LIMITS`. The new arena settings
do not raise the preview's fixed limits. Both formats count rows in the same
permanent D1 tournament game ledger, so arena use can consume space that the
preview also needs. Shared game, monthly work, and authority byte guards may
close preview starts earlier. The combined game and byte guards apply to
casual, computer, ranked, preview, and arena work even when new arenas are
disabled. All actual game initialization attempts share a 32-per-second start
bucket with burst 32. Reaching a limit cancels or closes new admission;
it does not delete accepted results or recycle game IDs. Terminal events leave
public views after seven days from their start. Event metadata cleanup waits
for all admitted Game payloads to retire. A retained or failed payload can
therefore keep private event metadata longer. Active reservations end after the
event finishes or cancels, even when terminal payload retirement is pending.

Settled payload retirement keeps the D1 replay and a minimal Game tombstone.
Permanent identity and result records still grow. The 10,000-ID ceiling is a
deliberate stopping point, not unlimited service capacity. Changing that limit
requires a measured storage plan. No live load or worldwide cost guarantee has
been established.

Casual play also uses its own optional limits. `CASUAL_GAME_LIMIT` counts only
retained payload rows and `CASUAL_GAME_ID_LIMIT` counts all casual IDs, including
archived tombstones. Both default to no product cap; a positive integer may set
one. Invalid values close
new casual admission. Retirement can free payload capacity but never frees a
permanent ID. These limits apply alongside the shared combined game and byte
caps; they do not admit or rate a tournament game.

`Competition` now persists casual creation intents before calling Game and
requires a committed D1 admission first. Initialization retries keep the same
game ID, creator, reservation, format, and computer setting. A
`GAME_INITIALIZATION_PENDING` (503) response means the request is saved; reopen
that same request. A changed pending request returns
`GAME_INITIALIZATION_CONFLICT` (409). Accepted D1 admissions, their idempotent
retries, and the second participant can continue through new-work stops and
lowered limits. Legacy admitted games retain that recovery path.
Disabling computer practice blocks new practice requests. An accepted legacy
computer request can still initialize, end unrated with `ai-unavailable`, and
release its held seat after verified result delivery.

Migration `0009_arenas.sql` seeds fixed casual and tournament admission counts
once and maintains them with triggers. A separate live count includes older
casual games until their last seat releases. New-work checks use these counters
without scanning the permanent ledgers. Apply the migration before this source;
missing counters close new admission. See the
[shared admission contract](arena-design.md#shared-game-admission) for defaults,
recovery, and the remaining reserve proof.

## Public API and privacy

| Endpoint | Result |
| --- | --- |
| `GET /api/tournaments` | Bounded schedule, standings, server time, and caller status |
| `GET /api/tournaments/:id` | One active or publicly retained event, or 404 |
| `POST /api/tournaments/:id/register` | Current eligible username/password caller enters an open event |
| `POST /api/tournaments/:id/withdraw` | Current caller withdraws before start |

POST requests require an authenticated same-origin session and a JSON body.
The HTTP actions return a public event view. Across the private Durable Object
boundary, expected failures use `TournamentActionResult`: an `ok` result with a
value, or an error containing only HTTP status, stable code, and public message.
This preserves deliberate errors when RPC does not preserve Error subclasses.

Routine codes include `SIGN_IN_REQUIRED` (401), `TOURNAMENT_INELIGIBLE` (403),
`TOURNAMENT_NOT_FOUND` (404), `REGISTRATION_CLOSED` (409), `TOURNAMENT_FULL`
(409), `TOURNAMENT_STARTED` (409), and `TOURNAMENTS_CLOSED` (503). Unexpected
storage or service errors remain generic and retryable at the HTTP boundary.

Public views contain display names, account IDs, admitted or not-admitted
status, game IDs, point totals, shared ranks, and generic result reasons. They
exclude email addresses, session IDs, session expiry, private actor records,
restriction reasons, and startup lock state. Only the caller's `myStatus`
distinguishes busy from ineligible non-admission. Public game reasons map
revoked eligibility to a technical void. `myGameId` appears only after a board
is ready, active, or awaiting adjudication. A creating intent is not an openable
board. Live Game access still requires its own participant/session checks.

Tournaments share the published [fair play](fair-play.md) limits. Unsupervised
engine assistance cannot be reliably eliminated. Statistical signals and reports
do not automatically convict, restrict accounts, remove ratings, or change event
points. Routine event progression does not wait for a human reviewer.

## Package choice

Pairing and standings use the exact maintained releases
[`@echecs/round-robin` 4.1.0](https://github.com/echecsjs/round-robin) and
[`@echecs/tournament` 3.3.0](https://github.com/echecsjs/tournament).
Both were published on 2026-05-27, use MIT, and have no runtime dependencies.
The round-robin package has the tournament package as a peer dependency. Their
published archives were checked against registry SHA-512 integrity before
installation. Both complete license notices are retained in
[third-party notices](../THIRD_PARTY_NOTICES.md).

The published package metadata reports 35,226 and 67,190 unpacked bytes. Their
minified runtime JavaScript files measure 3,266 and 6,520 bytes. These are
package measurements, not incremental Worker bundle or CPU claims.

`@echecs/swiss` 5.0.0 was evaluated but includes 430,469 unpacked bytes and a
pairing format this fixed event does not need. `tournament-pairings` 2.0.1 was
also evaluated: it uses GPL-3.0-or-later, reports 148,124 unpacked bytes, and
adds a runtime dependency. The selected MIT packages meet the three-round
format with less installed code. The service supplies only persistence,
admission, deadline, and result adapters; it does not handwrite a pairing or
standings engine.

## Local verification

Native Workers tests cover UTC cadence and outage bounds, registration privacy
and limits, unavailable or ineligible entrants, account claim crashes, uncertain
initialization, fixed deadlines, three-round completion, duplicate settlement,
shared standings, byes, no-shows, cross-mode booking, later eligibility changes,
typed HTTP errors, and storage ceilings. See `test/tournaments.test.ts` and
`test/tournament-api.test.ts` for the accepted contracts.

These fixtures do not prove live email, DNS, deployment, public participation,
worldwide latency, calibrated cheating detection, or capacity under real load.
They cover the round-robin preview. They do not qualify `arena-v1`, its larger
entry target, or its storage and recovery throughput. Three focused arena
cleanup tests and the product typecheck pass locally. The final combined suite
passed 201 tests across 28 files in 8.99 seconds. The public arena browser checks
listed above passed in that local build. Authenticated acceptance and deployed
capacity are recorded per release. See the
[arena verification limits](arena-design.md#package-boundary-and-verification-limits)
for the focused coverage and unverified release work.
