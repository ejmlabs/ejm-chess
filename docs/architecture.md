# Architecture

## Product boundary

`ejm-chess` owns the chess service and its guides. It consumes public `@ejm/*`
exports for every visual component, tokens, fonts, the site shell, prerendering,
headers, and site defaults. `ejm-ui` owns those interfaces. `ejmlabs` owns lab discovery.
There is no dependency on the agent harness.

Form choices use `Select` from `@ejm/ui/components/ui/select`. The shared
component owns field colors, padding, touch sizing, focus styles, and its
chevron. It retains native labels, validation, keyboard input, and the platform
picker. Shared application recipes arrange fields and actions.

Board preferences use the public compact Switch from
`@ejm/ui/components/ui/switch`. Show legal moves defaults on, loads its saved
`chess.showLegalMoves` localStorage value after mount, and writes only on user
changes. Blocked storage leaves the in-memory choice usable. Premove and Sound
remain off by default. This adds no account or server state.

The product derives legal destinations from the full saved FEN with chess.js
when an own piece is selected on the player's turn. Its thin Board adapter
passes those destinations to the public lazy `@ejm/ui/components/Chessboard`
surface. The kit wraps maintained cm-chessboard and owns rendering, markers,
input, promotion, orientation, focus, and cleanup. The kit imports no chess
rules, product state types, account code, or server modules. Dots and capture
rings include en passant, with deduplicated promotion destinations. Hints clear with selection, input, position, and
preference transitions while retaining the separate last-move/premove markers.
Off-turn premoves and read-only replays show no hints. Before submitting a move,
the product checks a temporary chess.js position and passes the checked snapshot
version to the command sender. Illegal destinations send no command, even with
hints off. Premoves are checked after the opponent's accepted move, including
its en passant and castling rights. The server still validates every command.

The marker sprite uses Vite's public `?url&no-inline` query because
cm-chessboard needs a fetchable asset URL. A narrow DOM Escape listener cancels
pointer selection when focus remains outside the board. It runs in the bubble
phase, skips consumed/composing events, and is removed when the board unmounts.
The shared board keeps ownership of keyboard navigation and promotion cancellation.

The shared project entry can build the chess site directly. It stays out of
default project discovery until launch. Its generated knight, outlined wordmark,
icons, and social assets come from public `@ejm/tokens` exports. No public source
URL is claimed by the shared entry.

## Shared UI composition

Every route uses the current public ejm-ui design, including protected review,
operations, account forms, play and replay. The product supplies words, chess
state, callbacks and semantic attributes. Shared recipes own widths, spacing,
typography, motion and responsive layout. `src/styles.css` only imports the
public stylesheet. `vite.config.ts` is one public preset,
`ejmlabs({ project: 'chess', headers: chessHeaders })` from `@ejm/site/vite`, and
`tsconfig.json` extends `@ejm/ui/tsconfig.json`. The preset checks the consumer
source and rejects product classes, inline styles, local CSS rules, raw HTML and
opaque JSX prop spreads during both development and builds. After prerendering
it fails the build unless every page has one `h1`, no skipped heading level, the
skip link first, `main#main` and `rel="external"` on links to other hosts. Public
components take no `className` or `style`, and controls inside
`Page variant="application"` are compact without a `density` prop. These checks
cover source ownership and page structure; browser layout still needs its own
verification. Extend the shared owner for a missing pattern.

| Public contract | Product use |
| --- | --- |
| `@ejm/ui/shell/SiteLayout` | Header identity artwork, navigation, theme, footer and skip link |
| `@ejm/ui/layout/Band` | `Page variant="application"` supplies application padding and content gaps |
| `@ejm/ui/layout/SectionHead` | `purpose="application"` groups page titles and supporting copy |
| `@ejm/ui/layout/Application` | Fixed content flows, groups, actions, forms, fields, fieldsets, headings and preformatted records |
| `AppSection` | Reading width for home, account, leaderboard and player pages |
| `GameWorkspace`, `PlayerStrip`, `BoardPlaceholder` | Responsive game and replay columns, names, clocks and loading geometry |
| `MovePairs`, `MoveHistory` | Accepted move rows and keyboard-accessible replay selection with bounded scrolling |
| `@ejm/ui/layout/Text`, `Prose`, `Rule`, `Status` | Type, static guides, separators and status words |
| `@ejm/ui/components/ui/button`, `input`, `textarea`, `select`, `checkbox`, `switch`, `radio-group` | Actions, fields, choices and preferences |
| `@ejm/ui/components/ui/disclosure` | Persistent native details content, including report, PGN and private forms |
| `@ejm/ui/components/Table` | Rich cells, native captions and row headers, stable keys, scrolling and table states |
| `@ejm/ui/components/StateBlock` | Loading, empty, error and skeleton states |
| `@ejm/ui/components/Chessboard` | Lazy maintained board rendering and interaction |
| `@ejm/ui/components/GameClock` | Display of the product's monotonic server-clock estimate, without per-tick announcements |

`AppField` groups a native label, shared input and help text. `AppFieldset`
retains the native legend and disabled behavior. Forms keep native validation
and submission semantics. Select retains the platform picker. RadioGroup
retains native radio keyboard and form behavior. Disclosure keeps hidden
children mounted so challenge and form lifecycles stay intact. Inline links
remain normal router links; shared base styles own their appearance.

The game adapter retains all rules, accepted server snapshots, legal
hints, time estimation and versioned commands in this product. The shared
workspace arranges the board and details without importing those types.
Replay keeps its cursor, board orientation and Left/Right/Home/End commands;
shared MoveHistory keeps the selected row in its own scroll region. The board
remains a lazy import. Play loads chess.js for the local move check; guides load
no chess rules. Computer play alone loads Stockfish. Account
settings, data export and closure controls load after the current session check
through a separate module. The security challenge loads when its form renders;
submission stays disabled until it supplies a token. These boundaries keep
native validation, the shared request lock, closure retry IDs and
password clearing after every account request. They make no request on import.

Guide content uses the public `Static` boundary from `@ejm/ssg`. It stays in
prerendered HTML with shared Prose typography and working links, without guide
text, a highlighter, board or engine in the browser load. Navigating to a guide
without a saved static fragment can reload the prerendered page by the shared
router's design. Keep interactive forms outside that boundary. Prose needs no
separate docs stylesheet.

## Cloudflare services

| Service | Purpose |
| --- | --- |
| Workers and static assets | Same-origin pages and HTTP API |
| Per-game Durable Object with SQLite | Serialized moves, clocks, seats, receipts, terminal records, and WebSockets |
| Competition Durable Object | Ranked queue, tournament schedule and rounds, reservations, rating state, result settlement, and leaderboard views |
| D1 | Better Auth records, active-seat guards, private completed PGN, projections, retirement ledgers, fair play cases, reports, evidence, decisions, restrictions, and appeals |
| Turnstile | Account signup, sign-in, recovery, and report abuse friction |
| Cloudflare Access | A second identity check for private owner review |
| Email binding | Security-only verification and recovery delivery, once configured and verified |

The optional private Stockfish Container and bounded analysis pipeline are
implemented but disabled. See [analysis](analysis.md) for pins, resource
measurements, retry controls, source obligations, and deployment gates. An engine
summary is not a calibrated detector or a mating proof.

Optional [Stockfish practice](ai-opponents.md) runs a pinned maintained engine in a browser worker loaded only for computer games. The White owner submits versioned `engine-move` proposals for Black. The Game authority still validates session, game type, turn, legality, deadline, and result; it does not trust client clocks or engine provenance. The browser includes the complete accepted move history in each search and discards stale output. Computer results are always unrated and excluded from human fair play checks. There is no external inference service or provider key.

## Game authority

The browser requests actions. It does not choose a result, timestamp, seat,
rating, or authoritative position.

Each command has a unique ID and an expected game version. The game object
checks the authenticated actor and assigned seat, then the version, game state,
turn, legal move, and server deadline. A repeated accepted command returns its
receipt instead of applying its effect twice. A stale command receives the
current snapshot for recovery.

The game starts only after both players confirm readiness. Unused invitations
expire after ten minutes. Once paired, players have two minutes to get ready.
An active disconnect does not stop the clock. Clocks use server deadlines;
there is no network delay allowance.

An unavailable join returns `INVITATION_UNAVAILABLE` without a game snapshot.
This includes the creator reopening an expired invitation after its live payload
has been archived. Completed games still offer Replay.
Retired links still return 404 to a new opponent; private reads and Replay
remain participant-only. Play also handles the older join 404 response, explains
that the link is unavailable and offers New invitation without creating a game
until the player submits the ordinary form.

chess.js validates movement and detects supported terminal positions. The rule
contract automatically draws threefold repetition and the fifty-move rule.
This differs from over-the-board claim procedures. The public `/rules/` page
states the version and these choices.

Timeout handling draws positions where insufficient material is proven or the
side with time left has only a king. Otherwise the player who ran out loses. A
disconnect does not stop the clock. No process may infer a win from a positive
displayed clock. This bounded online policy does not prove all possible mating
paths, so a fully blocked position with no possible mate scores as a loss.

New ranked games may use the separate default-off `online-2026-10-v3-proof`
profile only after qualification. Competition holds four shared proof slots and
reserves two finite native credits per permanent game before initialization.
One private Container runs unchanged pinned CHA-Solver with independent
complete-history/witness validation. Only an exact, timely supported proof can
settle a pending v3 result. Unknown keeps the original 30-second deadline and
then applies the same material timeout rule, which is rated; historical and unrated games retain their saved rules. There is no public proof
API or engine-score substitute. See [timeout proofs](timeout-proofs.md) for the
private contract, per-process limits, retention and unrun provider gates.

## Accounts and active seats

Better Auth uses native D1, its maintained username plugin, and its password
provider. The product does not add a credential engine or second session implementation.
An internal endpoint uses Better Auth's public server-only API. After package
cookie verification, it overlaps the package's primary session/user lookup
with an indexed credential lookup for the same token. It requires matching
user, session and expiry values, drains both reads before returning, and keeps
the public session response unchanged. Cookie caching and refresh are disabled.
Host-only HttpOnly cookies use SameSite Lax and Secure outside explicit local
loopback mode. Sessions last seven days without automatic refresh. Passwords
use the maintained provider's salted hashing. Security-only verification and
recovery use the maintained expiring token flows. See [accounts](accounts.md).

All new games require a non-anonymous username account backed by a password
credential. Legacy guests retain existing seats and private records only. A
nullable unique username migration preserves every existing identity ID.
Recovery email is optional, including for player competition. Better Auth's
public placeholder helper supplies its required private schema field when
email is absent; placeholder accounts remain unverified and cannot request
email tokens or delivery. Ranked and tournament admission check credential-backed
accounts, feature gates and active restrictions. Owner administration separately
requires a real verified email matching Cloudflare Access. Identity changes
must not transfer active seats between accounts. The active-seat guard and
identity-change lease coordinate that boundary against primary auth records.

### Account export, closure and restoration

Policy `account-2026-10-v1` uses the maintained password verifier for bounded
account export and closure. Export returns private pages of at most 50 records
and 256 KiB, without password hashes, tokens or other reporters' identities.
It stores no server archive. Closure commits credential/session/reset removal
and profile minimization in one native D1 batch, while retaining the opaque
competition identity, history and a minimal original receipt.

Competition keeps a durable closure fence outside D1. Identity leases and
database guards coordinate in-flight authentication and admission. A restore
must preserve every later closure receipt outside its targets, keep access
closed, and reapply the exact receipts through the same idempotent lifecycle
adapter before reopening access. A D1 rollback alone cannot clear the current
Competition fence. This is a recovery procedure, not an automatic transaction
across all stores.

The isolated [provider privacy drill](qualification/provider-privacy-20261021.md)
verified a no-email account, a native rollback and two reapplications of the
same saved closure receipt. Production closure/restore, positive reset-row
restoration and a set of concurrent later closures remain untested. See
[privacy and retention](privacy.md) for player controls and exact limits.

## Competition and recovery

Blitz 5 + 3 and rapid 10 + 5 have separate rating pools. Glicko-2 calculations
use the maintained package through product policy. The competition owner
serializes admissions and settlement. Game terminal records carry a stable event
identity and digest. Duplicate result delivery must not apply a second rating update.

An unsettled game must retain its result-delivery state and retry safely. An
unmatched digest pauses settlement instead of inventing an outcome. Automatic
retries keep the original record. Recovery must use the authoritative game
record. Never repair a rating by accepting a client-supplied result or editing
one player’s current rating in isolation.

### Automatic tournaments

Timed `arena-v1` events are implemented locally alongside the small round-robin
preview below. They start disabled and have no qualified public capacity.
Competition owns indexed entrant rows, continuous bounded pairing, shared
account claims, game intents, and unique score receipts. Each terminal score
and both entrant totals commit in the same authority transaction. Standings
builds scan at most 32 indexed version candidates per step at one frozen
revision, retain a bounded page buffer, and stage exact page bytes before D1.
Existing snapshot builds remain compatible. D1 publishes complete generations
in pages of at most 32 rows. Public schedule,
summary, and standings responses skip session lookup and use a ten-second edge
cache; private entry and queue actions remain authenticated and `no-store`.
See [the arena contract and qualification targets](arena-design.md).

The Worker sheds arena registration overflow before primary authentication.
Each isolate admits at most 16 outstanding registration calls and returns
`429 ARENA_RETRY` immediately for overflow. It does not queue requests, cache
eligibility, or set a global traffic limit. Admitted calls keep package session
authentication, account request limits, and all durable entry checks. Slots
release after success or failure. This outer gate also applies to registration
confirmations; clients may retry a busy confirmation without losing entry.

New arena registrations also use a nonqueued 256-preflight limit across the authority's
events, then spend a durable 50-per-second, burst-100 bucket before
external checks. Overflow returns `ARENA_RETRY` without spending a token or
starting native D1 or controller calls. Every admitted slot releases after
success or failure. Current entries bypass the new-entry limit and token charge
but keep their fresh checks; a concurrent withdrawal requires a token before
rejoining. Failed checks retain spent tokens. One primary query
checks session ownership, expiry, credentials and restrictions for registration
and queue entry. The insertion transaction still checks
session expiry, closure, event state, entrant capacity and storage. Registration
returns its local view after persistence; public account-state reads authenticate
again. These bounds do not establish provider throughput.

Competition owns fixed UTC schedules and advances three-round events through
durable intents. Hourly blitz begins at minute 00, daily rapid at 18:00 UTC, and
weekly rapid on Sunday at 16:00 UTC. Registration opens 15 minutes before start.
In the preview, three or four eligible human accounts play a round robin using the pinned
`@echecs/round-robin` and `@echecs/tournament` packages. Games are unrated;
tournament points do not enter Glicko-2 or the global leaderboard.

The same active-seat guards prevent casual, ranked, and tournament overlap.
Admission checks current eligibility and availability at start and before later
games. A tournament account lock spans its rounds. Readiness has a two-minute
window. Blitz rounds end within 18 minutes and rapid within 40, followed by a
one-minute break. An unfinished game at the round deadline is void. A single
ready player receives one event point for a no-show, without a played win.

Alarms and the existing minute trigger recover pending work. Recovery creates
only bounded current/next events, with a five-minute start grace after outages.
It never replays every missed cadence. Caps are three active events, 256 retained
events, no product cap on retained tournament payloads or permanent game IDs,
and seven days of public event history. See [tournaments](tournaments.md).

### Unattended operation and retained records

`OPERATION_MODE=unattended` disables new case and appeal decisions.
Reports retain private evidence without promising review. Statistical engine
signals cannot restrict an account. Legacy restrictions expire, and unanswered
legacy appeals close as `expired-unreviewed` after 14 days without fabricating
a human decision or reversing historical ratings. Optional reviewed operation
requires the explicit `reviewed` mode and an available owner.

Competition reconciles at most 16 due casual intents per maintenance pass.
The minute trigger attempts at most four legacy D1 game recoveries. Payload
retirement defaults to a separate four-attempt minute budget. Exact
`GAME_RETIREMENT_MODE=scaled` routes cron, alarms and manual calls through the
existing global Competition single-flight coordinator. Its indexed D1 queue
selects at most 32 candidates per pass, with four archive RPCs in flight and a
persisted token bucket refilling at 32 attempts per second, burst 32. The
existing Competition alarm stores the next-due hint. Missing or `preview`
keeps the small path; invalid modes close retirement. Migration
`0011_retirement_work.sql` installs and backfills the work queue and bucket.
Retirement waits at least one hour after
settlement and checks the D1 version, rules version, and terminal digest. Active
delivery, AI work, or evidence holds prevent deletion. A D1 lease closes the race
with a new evidence hold. A permanent minimal Game tombstone prevents ID reuse;
private D1 PGN and immutable rating history survive. Reopening a retired game
returns participant-only HTTP 410 with its replay link.

A local native batch removed the heavy state of 1,000 games, kept permanent
IDs and replay, and exceeded 25 successful archives per second after its
initial burst. Physical page reclamation and the 72,000-payload steady state
remain unproved. This does not establish production capacity or cost. See
the [qualification methods and evidence](local-qualification.md).

`CASUAL_GAME_LIMIT` and `CASUAL_GAME_ID_LIMIT` have no product cap by default.
Retirement and the Cloudflare budget stop bound growth. Retirement frees a payload
slot, never an ID. Permanent
records still grow, so reaching a journal ceiling closes admission. Local checks
do not establish unlimited unattended capacity. See [operations](operations.md).

### Matchmaking and ratings

Each account has one ranked reservation across both formats through settlement.
Queue status renews a 120-second ticket lease. Rating preference starts within
100 points and widens by five per second to 800; region preference relaxes after
30 seconds. A pair may start at most two ranked games in a rolling 24 hours.
Cancelled unstarted games and AI games do not earn competitive credit.

Color assignment prefers the queued player with the lower White balance. Equal
balances flip a coin. When the ranked game starts, White’s balance increases by
one and Black’s decreases by one. The balance is per account across blitz and
rapid; it is not a rating input.

The versioned Glicko-2 policy starts at rating 1500, deviation 350, volatility
0.06, and tau 0.5. Each settled game is one active period. Whole empty weeks
since Monday UTC increase uncertainty lazily through the maintained package.
They do not silently subtract skill points. Display ratings round to integers;
equal display ratings sort by user ID for stable cursor pagination.

Corrections verify the empty-genesis checkpoint hash and replay accepted events
in sequence in batches of 20. New admission pauses for the affected pool; games
already underway can finish into pending settlement. A shadow generation
publishes atomically before later finishes drain once. Unknown policy versions
leave repair paused for investigation. Do not edit current ratings, subtract
historical point deltas, or delete reservations to bypass a repair.

## Client read contracts

The API is same-origin. JSON responses must remain private where they concern
accounts or games. Errors include a machine-readable `error` and a short
`message`; the client presents retry or recovery guidance.

| Request | Consumer |
| --- | --- |
| `GET /api/config` | Ranked, AI, tournament, and review gates, Turnstile site key, and explicit local mode |
| `GET /api/me` | Private current browser account with `hasRecoveryEmail`, or `null`; no address |
| `POST /api/auth/sign-up/email` | Username, password and optional private recovery email; maintained credential/signup provider |
| `POST /api/auth/sign-in/username` | Username/password signin with generic failure and a security challenge |
| `POST /api/auth/request-password-reset`, `POST /api/auth/reset-password` | Bounded single-use recovery, followed by session revocation |
| `POST /api/auth/send-verification-email`, `GET /api/auth/verify-email` | Security-only email verification; no marketing subscription |
| `POST /api/auth/sign-out` | End the browser session after the active-seat identity guard permits it |
| `POST /api/account/complete` | Existing signed-in explicit account sets username/password while preserving its player ID |
| `GET /api/leaderboard?pool=blitz\|rapid&cursor=…` | Bounded leaderboard entries, update time, and next cursor |
| `GET /api/players/:id` | Public credential-backed player profile and two bounded rating-pool states; no guest, private email or private case records |
| `GET /api/history` | Current account’s latest 50 terminal games, AI labels, and available PGN |
| `GET /api/games/:id/pgn` | Participant-only completed PGN from D1, including retired games |
| `GET /api/tournaments` | Bounded public schedule/standings and current caller’s event status |
| `GET /api/tournaments/:id` | One public event with caller-specific game/status fields |
| `POST /api/tournaments/:id/register` | Eligible credential-backed account registration; no seat is held until start |
| `POST /api/tournaments/:id/withdraw` | Caller-only withdrawal before start |
| `GET /api/arenas` | Public bounded arena schedule, without session lookup |
| `GET /api/arenas/:id` | Public arena summary from a complete published generation |
| `GET /api/arenas/:id/standings?cursor=…` | Public standings page of at most 32 rows; the returned cursor binds later pages to one generation |
| `GET /api/arenas/:id/me` | Private current entrant status and accepted game link |
| `POST /api/arenas/:id/register\|withdraw\|queue\|pause\|resume` | Authenticated entrant actions under current account and cross-mode reservation checks |
| `POST /api/games` | `{id, format, ai?: {modelId, level}}`; creator-bound idempotent casual/Stockfish admission, with the pinned engine build and one named strength |
| `POST /api/games/:id/join` | Single-claim invitation or authorized participant reopen |
| `GET /api/games/:id/connect` | Same-origin authenticated WebSocket |
| `GET /api/admin/operations` | Access and owner protected status/cap/lag counters |
| `POST /api/admin/operations/maintenance` | Bounded retry of authority, unattended games, and analysis work |
| `GET /api/admin/operations/export/manifest` | Fixed journal watermarks and policy versions |
| `GET /api/admin/operations/export?kind=…&watermark=…&after=…` | At most 50 accepted journal events and a SHA-256 page hash |

Leaderboard entries contain IDs, names, ratings, and game counts. They do not
carry an absolute rank. The UI must not invent one on a paginated view. Results
in PGN and history read from White’s side. The history response does not grant
permission to call a result the current player’s win without a seat field.
History and notices return at most 50 rows per view. The leaderboard uses
50-entry cursor pages. Leaderboard eligibility requires 20 ranked games, eight
distinct opponents, an account age of seven days, rating deviation at most 100,
activity within 30 days, and current ranked eligibility.

Casual and browser-practice creation passes through Competition before any
new Game RPC. A durable intent holds combined game-count and byte capacity;
the permanent D1 creator/reservation stamp must commit before initialization.
All modes share the start-rate bucket. An uncertain initialization retains its
intent and seat so the same admitted ID can recover after a stop or a lower
limit. Only a matching accepted terminal result releases that intent. The
authority refreshes account identity from the current session and never accepts
the caller's display name as current account data.

Private Operations exposes fixed account and game protocol counters plus
versioned informational farming coverage. Account-limit and exhausted-window
counter updates commit in one native D1 batch. Farming facts never alter an
outcome, rating, eligibility, or queue priority. See
[fair-play limits and patterns](fair-play.md#objective-request-and-protocol-limits)
for exact windows, retained bounds, and incomplete-coverage behavior.

The `/replay/?game=…` route fetches only the private PGN endpoint. It never joins
a game, opens a WebSocket, or loads an engine. chess.js reconstructs legal SAN
and positions, including custom starting FEN. The viewer bounds the fetched
record to 1 MiB and rendered history to 12,700 half-moves. Move selection, board
flip, and Left/Right/Home/End act within the focused replay. Tournament standings
are public; these replay permissions remain participant-only. See [replays](replays.md).

## Build and resource limits

The site prerenders public routes and lazy-loads page modules. The board package
belongs on the play path. Build budgets are 180 KiB initial JavaScript and 20 KiB CSS on play,
95 KiB JavaScript and 14 KiB CSS on static guides, 70 KiB raw WOFF2 fonts,
and 30 KiB gzip HTML. The build enforces the narrower guide budgets separately;
lazy board/replay chunks are reported apart from the initial page. These are
build gates, not measured latency or worldwide capacity guarantees.

Measure peak active games, WebSocket reconnects, Durable Object CPU and storage,
auth writes, queue wait, settlement lag, D1 use, egress, and cost before choosing
a public concurrency limit. Use hibernation and bounded reads where the owning
code supports them. A larger fleet or a paid binding requires separate owner approval.
