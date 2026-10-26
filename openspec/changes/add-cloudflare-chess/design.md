# Design

## Current spending decision, 2026-10-22

The owner directs one $100 monthly chess spending target, existing $45/$70
usage alerts, and the $85 emergency stop to leave headroom for accepted work.
This supersedes the earlier mandatory per-service dollar allocations, tax and
unknown-cost reserves, and repeated financial-review gates in this change.
Those dated calculations are historical estimates, not launch requirements.
Use supported monthly caps of 10,000 signup attempts, 10,000 games and 5,000
account emails, with 100,000 lifetime signup attempts. Clear deployment and
account/game/email stops for protected-host use. Preserve abuse rate limits,
authentication and accepted-work recovery. Keep optional server analysis disabled.
Ranked correctness and tournament qualification still apply. Public Access is
removed only through the existing launch sequence. The $100 target is not a
hard provider invoice cap: alerts can lag and accepted work continues.
Owner authorization covers this configuration and financial-policy change;
do not request another approval for the same decision. Runtime test bounds
and source integrity remain required; repeated cost optimization does not.
The product owns these controls and docs; no shared UI API changes are needed.


## Context

See `proposal.md` for the purpose and scope. At the initial proposal, no chess resources, application, account flow, or public hostname had been provisioned or verified. Dated 2026-10-21 UTC product evidence now records a protected canonical-host canary, account/security-mail acceptance for one approved recipient, and saved budget alerts with a tested stop webhook. Public new work remains stopped, and complete recovery, proof, capacity, regional, and launch gates remain open. This PR publishes planning and recorded status only. See `implementation-scope.md` for the owner boundaries and evidence limits.

The local studio UI-migration checkout consumes public `@ejm/*` packages through declared local dependencies. The shared project registry covers four existing identities. Public header/build hooks already support additive CSP sources; chess must verify its policy through those hooks before adding an API. The new `ejm-chess` checkout and upstream `ejm-ui` checkout are outside this change's write scope. This planning home grants no authority to edit either one.

The owner's latest account request on 2026-10-20 requires username/password signup for each player, superseding guest admission for new casual games. Existing guest seats and records remain recoverable without competitive credit. The logo, match replays, automatic tournaments, and unattended ordinary operation remain in scope, superseding the earlier owner-review commitment. The default formats remain 5+3 blitz and 10+5 rapid. Optional review tools do not establish production readiness.

### Planning baseline prerequisite

The four modification targets below exist in the accepted local studio migration, introduced at `3917ca01886280c93795c84126084c32a4415aad` and retained at local main `ef549ada7d4ecb3440d5859a4752812418465fc4`. The dated 2026-10-20 publication record names studio source `caa4ec7f23fb80792e7a4afdb5fc4f8a28a86cea` and shared UI `69cbd4f83e816e613d54a09bf012fd8f2b61bf49`. That record is separate from current GitHub source and is not a fresh provider read. Reviewed GitHub main `c92a4a0df2944e6ac6c22498ad4d132f0518d569` contains only `.gitkeep` under `openspec/specs/` and lacks these targets:

| Spec | Modified requirement |
| --- | --- |
| `ejmlabs-site` | `Home page` |
| `documentation-discovery` | `Direct guide links` |
| `public-web-access` | `Worldwide public access` |
| `public-web-access` | `Public production entry points retain edge protection` |

The separate reviewed change `reconcile-chess-planning-baseline` supplies three minimal baseline additions for the absent remote paths. Each addition contains only the complete prerequisite blocks from local main. The four chess MODIFIED blocks retain the existing scenarios and add the chess behavior; their current wording needs no forced edit after comparison. Do not replace the richer local main specs or import unrelated migration code. Prove the actual merge with the installed OpenSpec CLI in a disposable root before spec sync or archive. Product runtime verification continues independently of this source-history repair. Studio discovery remains gated on verified chess and guide destinations. Strict format validation alone does not prove mergeability or remote runtime adoption.

## Goals / Non-Goals

**Goals:**

- Keep board input and authoritative game processing small, with one durable owner for each state transition.
- Make reconnects, duplicate delivery, restarts, rating repair, and provider outages explicit parts of the design.
- Use Cloudflare for application hosting, storage, mail transport, background execution, and abuse controls.
- Keep public package boundaries and product-owned guides intact.

**Non-Goals:**

- A distributed game clock, a custom chess engine, a custom authentication system, or a second design system.
- Prizes, chat, spectators, variants, lessons, best-move coaching, or public live engine analysis at launch.
- Claims of perfect cheat prevention, exact FIDE adjudication, unlimited capacity, or released behavior before acceptance checks.

## Decisions

### 1. Choose owners and extend shared contracts first

| Owner | Public contract and downstream impact |
| --- | --- |
| `ejm-chess` | Owns the game Worker, assets, Durable Objects, auth composition, ratings, fair play, admin, and product guides. Consumes declared public dependencies. |
| `ejm-ui` | Extends `@ejm/site/projects` with chess identity and an unreleased-project discovery gate. Owns existing public build/header options, any verified policy extensions, shared controls, shell, tokens, and prerendering. |
| `ejmlabs` | Adds honest studio discovery, product-guide links, and the canonical chess host to the public security operations contract after verified publication. |

The direction is chess/studio into `@ejm/tokens`, deep `@ejm/ui` exports, `@ejm/site`, and `@ejm/ssg`. Chess does not use or change the agent harness. Read each owner's instructions and establish scoped work before editing there. Use OpenSpec where the owner already has a root; otherwise work normally and do not initialize it without a user request. The inspected `ejm-ui` checkout has no OpenSpec root. Preserve the ongoing site migration and unrelated files.

The upstream chess registry identity and discovery gate are known contract gaps. Resolve them in `ejm-ui` before adoption; do not copy its registry/header generator or import sibling private source. Current `otherSites()` exposes every entry and consumers use live declared `file:` packages, so merely adding chess can publish premature links on an unrelated rebuild. Add an explicit unreleased/discoverable contract: local/preview builds may use chess metadata while shared navigation excludes it. Existing discovery output remains unchanged until product and guide destinations are verified; only then enable chess discovery.

The public `ejmSite({ project, headers })` API already accepts a custom `Project`, and `HeadersOptions.extra` adds CSP sources for same-host WebSockets and Turnstile. Reuse those contracts and test the actual auth flow. These APIs generate static `_headers`; verify Worker responses separately rather than assuming they inherit static policy. The current `form-action 'none'` default does not by itself prove chess needs a replacement API. Add a narrow shared extension only if verified behavior cannot be expressed through existing public options; record that gap and preserve default policies. Test all four existing identities, the hidden/new chess identity, existing static policies, and the narrow chess policy without wildcard or unrelated-host grants. This plan adds no compatibility adapter.

Alternative: put chess inside the studio. Rejected because a stateful game and its guides need a product owner, independent deployment, and bounded runtime dependencies.

Product form choices consume `Select` from the public `@ejm/ui/components/ui/select` export. The existing shared control supplies themed field styling, touch sizing, focus treatment, and a chevron around a native select. The open picker remains platform controlled. Preserve native labels, required placeholders, disabled states, and controlled change handlers. Product CSS may arrange fields but must not override the shared select's padding or appearance. Apply this to computer strength, reports, appeals, owner decisions, and journal export. No shared API change or new dependency is needed; verify consumer types, emitted budgets, keyboard choice, phone fit, and both themes.

### Site-wide ejm-ui adoption

The owner requires every chess page to use ejm-ui, with no product-owned visual
primitives. Review Play, History, Replay, Home, Leaderboard, Profile, Tournaments,
Admin, operations export, Challenge, guides, and the not-found route. Use the
existing public Button, Input, Textarea, Select, Checkbox, Switch, StateBlock,
Status, Page, SectionHead, Text, Rule, shell, and link contracts. Native forms,
labels, fieldsets, lists, and landmarks remain semantic page composition.

Resolve these measured API gaps in ejm-ui before changing consumers:

- A native RadioGroup with labelled options, controlled value, disabled choices,
  form name, validation, and browser keyboard behavior.
- A general Disclosure that remains collapsible at desktop sizes, accepts native
  details state/events, and preserves form/challenge mount behavior.
- Table cells that accept React nodes, optional captions, row headers, and stable
  row keys. Preserve primitive cells, numeric alignment, truncation, density,
  labelled scrolling regions, and existing state contracts.
- A lean Prose surface for static guide children, using the shared type scale,
  links, lists, and code treatment without loading a highlighter or interactive
  documentation suite into guides.
- A GameClock display for text, active/low states, and accessible labels. Keep
  clock estimation and ticking in the product, with no per-tick live region.
- A lazy Chessboard surface wrapping maintained cm-chessboard, with generic
  FEN, color, enabled/read-only state, markers, legal-destination callback, and
  move callback props. The kit owns board styling, pointer/keyboard interaction,
  promotion, markers, focus, orientation serialization, and disposal. It imports
  no product DTO, server, engine, or chess rules. The product supplies legal
  destinations from chess.js and sends moves to its authority. Keep full-position
  hint correctness, Escape handling, no-inline marker sprite, and licensed pieces.

Existing packages and native platform APIs cover these gaps without another UI
framework. Move the existing cm-chessboard dependency to the shared visual owner;
keep it on a lazy leaf export so unrelated consumers do not load it. Keep custom
product CSS limited to content layout and chess record arrangement. Remove kit
control overrides and copied typography, notice, table, disclosure, clock, and
board appearances. Use shared current-state/focus treatments for selectable
replay moves. Theme-specific logo composition uses public token assets and the
kit's theme utilities.

Preserve server authority, reconnects, invitations, form validation, action gates,
admin confirmation/idempotency and private access, tournament URL/focus/polling,
export bounds, replay limits/selection/shortcuts, and download/source delivery.
Use public leaf imports and acyclic dependencies. Update shared API docs,
catalog/metadata/examples, and meaningful compatibility/lifecycle tests. Verify
the shared owner and affected product types, focused regressions, real browser
flows, both themes and phone layout, build budgets, and Worker dry run. Preserve
95 KiB guide JavaScript/14 KiB CSS and existing route limits. Report access-gated,
physical-device, publication, and performance checks separately. Refresh durable
source, patch, provenance, hashes, product guides, and this plan. This addition
authorizes local work only and does not satisfy unrelated launch/scale gates.

### 2. Use established packages behind thin product adapters

| Package | Use and constraint |
| --- | --- |
| [`chess.js`](https://github.com/jhlywa/chess.js) | Legal moves, position history, SAN, PGN, checkmate, and supported draw predicates. The server decides outcomes through a separate, documented online adjudication policy. |
| [`cm-chessboard`](https://github.com/shaack/cm-chessboard) | SVG board, pointer input, promotion and accessibility extensions. Mount/destroy it through one React adapter; keep it out of static guide bundles. |
| [`glicko2`](https://github.com/mmai/glicko2js) | Server rating calculations, including empty rating periods. Product code supplies the versioned online rating policy and serialization. |
| [Better Auth](https://better-auth.com/blog/1-5#cloudflare-d1-support) | Native D1 adapter, maintained username/password auth, verification/recovery, sessions, and database-backed auth rate limits. Retain anonymous schema for legacy records. No custom credential engine. |
| [Stockfish](https://github.com/official-stockfish/Stockfish) | Pinned native engine and network files in a private analysis Container image, with notices and source obligations reviewed for the chosen distribution. |

Pin compatible stable versions and record licenses, advisories, maintenance evidence, Worker compatibility, startup, and bundle measurements in the owning change. Prefer direct D1 integration over adding an ORM only for auth. Do not replace a package because of an unmeasured footprint concern.

The board code is MIT, but its piece assets have separate licenses. Do not ship the noncommercial Staunty set by default. Use the commercial-compatible Wikimedia set with its CC BY-SA attribution and obligations, or an approved licensed set. Verify the files actually included in the build.

Alternative: hand-built board, rules, ratings, or login. Rejected because correctness and maintenance would become product obligations without evidence of a package gap.

### Optional legal-move hints

The product owns the preference, legality calculation, and a thin adapter into the shared board surface. Use the existing
public ejm-ui compact Switch for Show legal moves alongside Premove and Sound.
Default hints on; read the browser preference after mount and write on explicit
changes with guarded localStorage access. No account field, cookie, or network
request is needed. Storage failure leaves an in-memory toggle usable.

Keep chess.js inside the lazy board path. On accepted selection start, derive
legal moves from the full authoritative FEN and selected own piece. Use the
cm-chessboard Markers public API for destination dots and capture rings,
including en passant, with one marker per promotion destination. Show these
only during the player's current turn; do not fabricate future premove paths.
Keep last-move and premove markers separate. Clear selection hints on completion,
cancellation, position/turn changes, input disable, orientation/read-only
changes, or toggle off. Include pointer, touch, and keyboard selection and
cancellation using public APIs and DOM input boundaries. No custom chess rules,
engine suggestions or server authority changes are needed. Site-wide adoption moves visual hint lifecycle into the shared Chessboard while the product retains legality.

Protect the adapter's legal-destination and cleanup contracts with focused
regressions, then verify real click/drag/keyboard behavior, toggle persistence,
phone fit, both themes, and unchanged initial/lazy bundle limits. Update public
help and developer guidance in the product; studio discovery remains unchanged.

### 3. Use one small control plane and one object per game

| Cloudflare resource | Authority or purpose |
| --- | --- |
| Workers Static Assets and application Worker | Prerendered routes, lazy play UI, HTTP/auth APIs, validated WebSocket upgrades. |
| `Game` SQLite-backed Durable Object per game | Seats, ordered events, legal position/history, clock deadlines, durable receipts, terminal result, and delivery outbox. |
| One launch `Competition` SQLite-backed Durable Object | Both ranked queues, regional preferences, active-account reservations, both rating pools, immutable rating events, processed results, projection outbox, and correction cursor. |
| D1 | Primary auth state; query projections for profiles, games, completed PGNs, leaderboards, and capped private fair-play evidence. |
| Queues and capped native Stockfish Containers | Postgame analysis with retry, deduplication, bounded work, and a dead-letter path. |
| Turnstile and Cloudflare security controls | Signup/guest-creation abuse prevention, request limits, WAF and DDoS protection. |

Moves never pass through `Competition`, D1, an engine, or a queue. The single control object is an explicit launch capacity bound, not a claim of unlimited global writes. Split it only after measurements identify a bottleneck and a new plan preserves cross-format account reservations and atomic rating changes.

Do not add KV or R2 initially. Completed PGNs and bounded evidence fit D1 until measured growth shows otherwise. Set storage alerts and review capacity before approaching the database limit; adding storage later needs a measured owner change. D1 is not a game clock or active position authority.

Alternative: several regional control objects at launch. Deferred because cross-region account locks and result ordering would add coordination machinery before capacity requires it.

### 4. Require explicit player accounts on the primary

Use Better Auth's maintained username plugin and email/password provider with native D1. Require a unique, case-normalized username and a password of 8 to 128 characters for signup, reset, and legacy explicit-account completion. Existing-password verification accepts nonempty passwords up to 128 characters without imposing the creation minimum. Keep the library's maintained salted password hashing and verification. Recovery email is optional at signup and for competition. Use any supplied private email for account verification and password reset, with no marketing subscription or promotional messages. Password signin, ordinary play, and player competitive eligibility do not depend on email or mail delivery. Existing restrictions and launch gates still apply. Owner administration retains its separate real verified-email and Cloudflare Access checks. Recovery uses the library's expiring single-use tokens and revokes existing sessions after a reset. Never log passwords, recovery values, cookies, or email bodies.

Account forms have one submit action. Signin offers Create account navigation; signup offers Sign in navigation. Do not repeat the current form's action as a view-switch button. Compose these controls through existing public ejm-ui exports. Password policy belongs to the chess product and requires no shared-kit change. Verify the changed password boundaries and account-view navigation, then types and the normal build; do not repeat unrelated game or capacity tests for this correction.

Better Auth's native D1 schema requires a unique email string. Use its public `createPlaceholderEmail` helper from the directly pinned `@better-auth/core` package with a random identifier when recovery email is omitted or blank. This is a thin product adapter, not another auth store. No migration or identity rewrite is needed. Reject caller-supplied `.invalid` recovery addresses, keep placeholder accounts unverified, and suppress placeholder verification/reset requests before token or mail work. Guard delivery again at the mail boundary. Expose only `hasRecoveryEmail` in private account state and no address in public responses. Explain before signup and on the account page that skipping email disables email password recovery. Adding or changing email later remains unavailable until a separately guarded provider flow is implemented; do not open the provider's session-creating email-change callback as part of this correction.

Use an explicit canonical origin, host-only Secure/HttpOnly cookies, appropriate SameSite settings, origin/CSRF protections, trusted `CF-Connecting-IP`, and [database-backed rate limits](https://better-auth.com/docs/concepts/rate-limit). Auth and revocation reads use primary D1 semantics. Do not enable an unconstrained read-replica or stale cookie-cache path for authorization.

Disable public anonymous signup and magic-link account creation. New game creation and new invitation seats require a non-anonymous username account backed by a password credential. Enforce this in server admission as well as the interface. Existing guest sessions may reconnect to already owned seats and replay their records. Retain the anonymous schema so legacy guests remain identifiable. Do not backfill guest usernames, credentials, email verification, ratings, or owned records. Add a nullable unique username column without rewriting identity IDs. A legacy signed-in explicit account may set its username/password through maintained APIs under the identity-change lease. Account changes wait until no active game or tournament reservation exists; live seats never change identity midgame. Clearing a guest cookie still loses that browser's seat access.

At WebSocket upgrade, the Worker validates the session, origin, game membership, and session expiry, then supplies trusted identity through the internal binding. A room ID or client-supplied user ID grants no seat. Reconnects repeat these checks; active connections have a bounded revalidation/expiry policy. Limit connections and frames per identity, reject oversized messages, and avoid credential-bearing URLs.

Email Sending is [public beta](https://developers.cloudflare.com/email-service/) and needs paid-plan access, sending-domain onboarding, quota checks, and verified recovery/verification delivery before public account launch. A missing mail service closes email operations without weakening verification or blocking an existing password signin. Require same-origin JSON, bounded auth requests, database-backed per-route limits, and server Turnstile on signup, signin, and recovery requests before expensive credential work. Return generic signin and recovery errors. Use public ejm-ui Input/Button/state contracts with password-manager autocomplete, paste support, visible account identity, and no stored browser passwords. Preserve invitations through signin and provide a password-reset form without placing tokens in logs or persistent browser storage. Measure native Worker password cost and emitted bytes without claiming production capacity. Passkeys need separate scope.

Alternative: OAuth-only or passkey-first signup. Deferred to keep the first login and recovery path small and fully Cloudflare hosted.

#### Automated account data controls and closure

Use password-confirmed `Download account data` and `Close account` actions on
the existing account page as the primary account-request route. Recovery email
remains optional everywhere. Publish no staffed inbox, human response time or
inbound-support claim without verified service. This replaces the unresolved
operator-contact launch gate with the controls and limits below.

Better Auth owns password checks, sessions and cookie clearing. Use its public
`api.verifyPassword` and `api.signOut` contracts. Its hard-delete adapter removes
credentials and sessions before attempting user deletion, which conflicts with
the product's restricted player foreign keys and permanent rating repair. It
also has no complete personal-data export contract. Keep generic deletion
routes closed. The narrow product adapter owns one atomic native D1 batch for
private-data minimization while retaining competition identity. Record this
package gap and remove the adapter if a maintained public contract meets it.

Closure requires a signed-in credential account, current password, same-origin
bounded input and existing credential request limits. Acquire the existing
identity-change lease and a durable Competition closure fence. Cancel only an
unpaired queue entry; refuse active games, unsettled reservations and event
locks. Recheck the fence inside admission transactions after awaited checks,
including casual intents and tournament/arena reservation bridges, so stale
requests cannot create seats after closure starts.

In one idempotent D1 batch, remove credentials, sessions and account-owned reset
verification records; clear recovery email, username, image and verification
state; keep the opaque user ID, creation time, neutral label and a private
receipt containing only request ID, user ID, policy version and completion
time. Use the maintained placeholder-email helper for the required unique
email column. Keep the tombstone non-anonymous. Guard account and session
writes against accepted closure receipts at the D1 boundary so an in-flight
signin or reset cannot reactivate the account. Return Better Auth's cookie
clearing headers after commit. Lost replies must leave closure safe to retry.

Original player/game IDs, historical usernames in competition records, PGNs,
moves, results, rating/correction history, tombstones and minimal case audit
remain permanent. Closure is private-data removal with stated exceptions, not
complete anonymization. Historical identity and ownership use stable IDs even
if a cleared username is later reused.

Export requires the same current-password ownership check. Bound each JSON
page to 50 records and 256 KiB; include the owner's profile/recovery information,
reports, appeals, notices and game metadata, with existing participant PGN
links. Filter every query by owner ID. Exclude password hashes, session/reset
tokens, other reporters, reviewer notes and investigation evidence. Suppress
placeholder emails. Return an attachment with `Cache-Control: no-store`; put
no password in a URL and create no stored archive. State that pages are not an
atomic snapshot across stores. Use public ejm-ui controls without a new service
or shared primitive.

Publish retention as cleanup eligibility, since maintenance is bounded:
credentials/recovery email last until closure; sessions have seven-day validity
and daily cleanup; reset/verification tokens last 15 minutes with cleanup after
expiry plus one day; request windows one day; released seats 30 days; ordinary
evidence/report text 90 days with appeal holds; private reviewer notes,
corroboration and appeal text are minimized 90 days after final case action
once appeal windows and holds end; analysis summaries/dead letters 30 days;
email/analysis budget receipts 62 days. Preserve the permanent competition and
minimal audit exceptions above. Delete private raw synthetic drill files after
acceptance within 30 days, retaining sanitized reports and hashes. Verify the
actual paid plan and SQLite backends before claiming a 30-day native recovery
window. Private operational/case data retains owner-account and Access checks.

Before any approved restore, preserve closure receipts accepted after the
selected boundary outside all restore targets. Reapply the same idempotent
minimization before reopening authentication or admission. Verify that no
credential, recovery address or session was revived. Keep both closed if the
later closure set is incomplete or uncertain. Rehearse this on synthetic native
provider stores; this adds no production restore endpoint or restore authority.

### 5. Reuse the site shell and keep the board central

Use explicit `@ejm/ssg` routes for `/`, `/play/`, `/leaderboard/`, `/history/`, `/help/`, `/rules/`, `/fair-play/`, `/privacy/`, and `/admin/`. Open a game as `/play/?game=<id>`; do not assume dynamic path matching. Auth and application APIs remain Worker routes. Private/authenticated content is not prerendered or cached publicly.

The play view prioritizes the board, two clocks, opponent, move list, and a few clear actions. Provide click/tap and drag input, keyboard/text moves through the board extension, all promotion pieces, visible focus, legible coordinates, reduced motion, optional muted-by-default sound, and clear reconnect/pending-move states. Verify touch targets and screen-reader use on the assembled product. A premove is a local intention revalidated by the server when its turn arrives; no move is sent on the opponent's turn.

Use public tokens and controls for the shell and dialogs. Keep board styling in the public shared Chessboard surface and its maintained package assets. Import no engine into play, and lazy-load the board and auth client only where needed. No promotional film or demo runtime belongs in the first play load.

Invitation failure states remain part of tasks 3.6 and 7.1. An unused link
expires after ten minutes and may later point to a retired payload. A signed-in
opponent must see an unavailable-invitation message and a fresh-invitation
action, rather than a sign-in instruction or an endless Join retry. Preserve
private GET, socket and Replay authorization and existing participant archive
recovery. Do not revive an expired game, reset its ID or expose its private
record. Use the existing public ejm-ui controls and product API error contract.

Alternative: a new landing-page design system or a homegrown SVG interaction layer. Rejected because the existing public shell and board package already own those jobs.

### 6. Persist events and deadlines, not clock ticks

Capture the authoritative server timestamp at handler entry before external I/O. A move request contains a bounded command ID, expected game sequence, and move coordinates/promotion. It contains no trusted clock, position, rating, result, or client timestamp.

For every game command, check existing terminal state and the recorded active deadline before accepting a draw, resignation, or move. Validate actor/seat, sequence, turn, and move legality where applicable. A timestamp at or beyond the active deadline flags before another action can conclude the game. A valid move consumes elapsed server time, applies the format's increment, switches the active side, and commits its event, new state, receipt, and next due work through durable storage before acknowledgement/broadcast. Illegal moves and duplicates do not reset time or add increment. Preserve repeat-command receipts so a lost acknowledgement cannot apply a move twice; conflicting reuse is rejected. Checkmate takes precedence over generic automatic-draw predicates on an accepted mating move.

Store starting position, ordered accepted moves, full repetition history or replayable history, clock state, deadlines, participant IDs, rule-policy version, and terminal reason. A FEN alone cannot restore repetition rights. On reconnect, send an authoritative snapshot plus events after the client's last sequence, or a complete bounded resync when necessary. A replacement player connection invalidates the old connection's move authority.

Clients animate clocks with a local monotonic clock and server snapshots. Disconnects do not pause ranked clocks. No client timestamp or artificial network delay earns time; initial clocks use server-arrival semantics with no lag credit. Publish that policy and measure distant play before changing it. Schedule the next real deadline or outbox retry, not a per-second callback. Late alarms recompute from the persisted deadline and never grant extra time.

[Hibernating WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) keep connections while object memory resets. Persist game state in SQLite and only per-connection identity/sequence metadata in socket attachments. Use idempotent alarms and restart recovery. Do not use intervals that prevent hibernation.

Alternative: browser clocks or frequent server ticks. Rejected because client claims are untrusted and tick loops add cost without improving the authoritative deadline.

### 7. Match once and rate through one atomic owner

`Competition` holds separate 5+3 and 10+5 queues, with nearby-region and rating preferences that widen over waiting time. Match players only within the same format. Recheck current eligibility when pairing and when starting a reservation. Use authoritative queue tickets and leases, color balancing, cancellation, and idempotent game IDs. One account may hold only one queued/reserved/active/settling ranked slot across both formats. Proposed repeated-pair policy: no more than two ranked games for the same unordered pair in a rolling 24 hours; validate its effect on small queues before public ranked launch.

Reserve both accounts and a game-creation intent atomically before initializing `Game`. Retry initialization under the same ID. A lost reply must not create a second match. Reconcile pending reservations against the game's actual state before releasing them; never expire a live game's reservation because a control-plane message was delayed. Invitation games are always unrated, including account-to-account games. Guests never enter ranked queues.

Proposed Glicko-2 profile: initial rating 1500, deviation 350, volatility 0.06, tau 0.5. Each accepted match is one active rating period for its two players. Before their next match settles, apply one library empty-period update per whole inactive UTC week, with deviation capped at 350. Store the exact timestamps and policy version so week boundaries replay identically. Apply inactivity lazily to those two players only; do not scan the population or subtract skill points for inactivity. This is a documented online adaptation, not an external federation rating.

For a registered ranked game, validate its participants, format, terminal digest, and result version. Use one SQLite transaction to check the unique processed-result marker, read both states, apply the package calculation, write both states and immutable pre/post event records, release reservations, and add projection intents. Same result repeats are no-ops; conflicting results become an incident. Neither clients nor general D1 consumers may write rating authority.

Proposed leaderboard eligibility is 20 rated games, eight distinct opponents, account age seven days, deviation at most 100, activity within 30 days, and no active restriction. Keep this profile versioned and visibly mark provisional accounts. These are uncalibrated defaults; test their effect before ranked launch. Apply stable tie ordering and paginate indexed projections.

Alternative: compute ratings in independent queue consumers. Rejected because unordered deliveries and shared opponents permit lost updates and nondeterministic histories.

### 8. Use durable outboxes and replay rating corrections

`Game` commits its terminal result and a pending delivery record in the same storage transaction. Its alarm calls `Competition` through a binding using a stable event ID; only a durable acknowledgement clears the record. `Competition` persists acceptance and both-player updates atomically. Retry after lost replies is safe. Alarm scheduling tracks the earliest clock, reservation, or outbox work without overwriting earlier due work.

`Competition` keeps a separate durable outbox for D1 projections and analysis messages. D1 upserts use pool, account/game ID, rating epoch, and monotonic event version. Old or duplicate projection deliveries cannot overwrite newer state. Publish related result/rating projection rows in an atomic D1 batch; acknowledge only after commit. Queues are [at least once and unordered](https://developers.cloudflare.com/queues/reference/how-queues-works/), so analysis jobs also use game, engine, and profile version keys. Queue acceptance and a DO write are not a shared transaction.

Public read models may lag briefly and show their update state. Use [D1 Sessions API bookmarks](https://developers.cloudflare.com/d1/best-practices/read-replication/) when a user's next read must include a completed projection; otherwise wait or read authority for the narrow operation. Never describe read replicas as globally instantaneous.

A review or technical correction appends an immutable decision that references the original game/event. Capture a stable event watermark and recompute the affected pool from a verified checkpoint before the earliest affected result, replaying subsequent events and their policy versions in order through that watermark. Do not subtract old rating deltas: later ratings depend on earlier states and opponents. Run bounded replay batches with a durable cursor, validate a shadow epoch, then atomically publish the new projection epoch. Keep original records and the reason for repair auditable. Account ratings, eligibility, and public ranks carry the accepted epoch; do not expose a mixture during publication.

Pause new ranked admission for the affected pool during repair; existing games may finish and persist pending settlement. Resume those settlements in a recorded order after the new authority is committed. Repeated correction requests and crashes resume the same job. Restore/rollback never reintroduces an older epoch over newer accepted events.

Alternative: best-effort background writes or reversing historic point changes. Rejected because those approaches lose work or corrupt rating history after failures and appeals.

### 9. Resolve adjudication limits before public play

Use `chess.js` for the behavior it supplies, and make the online rule policy explicit: move acceptance, checkmate, stalemate, repetition, move-count draws, resignation, agreed draws, flags, aborts, and service failure. Distinguish claim-based draws from automatic draws and record the terminal rule version.

`chess.js` cannot fully establish every dead position or whether only the non-flagging side can mate through any legal continuation. A general draw predicate is not a side-specific timeout decision. Do not claim exact FIDE compliance, infer mating possibility from engine scores, or silently handroll a full rules engine. Before release, document and test a concrete online adjudication policy, assess maintained adjudication dependencies if needed, and obtain owner acceptance of any stated limit. This unresolved accuracy requirement blocks public play, especially ranked outcomes.

Adopt the MIT-licensed maintained Rust [CHA-Solver](https://github.com/miguel-ambrona/chasolver) 3.0.0 at commit `3484c7e65247003fac8705a9290dc2b5d0978b94` for a narrow private native Container timeout-proof path. Keep the package and its `analyzer` example unchanged, with a thin product adapter and existing hash-pinned python-chess for independent witness validation. Do not fork a solver, use engine scores as proof, or put full search inside a Game move/clock transaction. No shared UI or harness contracts change. Review the private image's package notices and source obligations before distribution.

Task 3.4 remains completed feasibility. Its 16 native queries and numeric-only WASM fixture ABI establish neither arbitrary-position bounds nor a production FEN/witness contract. The upstream public full-search API has no caller resource budget and can return unknown. The following task 3.8 is a distinct adoption and qualification gate. Use the [FIDE Online Chess Regulations](https://handbook.fide.com/chapter/OnlineChessRegulations), including automatic online draws, when documenting policy differences; this path does not prove complete dead-position detection during live play or full FIDE compliance.

#### Reserve timeout-proof capacity before ranked admission

Use saved rules version `online-2026-10-v3-proof` and profile `cha-native-3484c7e6-v1` only for newly admitted eligible ranked games after all existing ranked gates and task 3.8 pass. Historical games retain their saved policy. The profile defaults off. Missing, invalid or unavailable proof configuration closes new ranked admission rather than selecting an unqualified fallback.

Start with one private sleeping Container instance and one active proof job. Competition shares four durable proof slots across both ranked formats. Hold one slot from the game-creation intent through authoritative terminal delivery and reservation release, including pending adjudication. Reserve two attempt credits under the permanent game ID before Game initialization. Reserve at most 1,000 such games per UTC month, consuming both credits conservatively even when a game never needs a proof; do not refund uncertain work or reset accepted credits at month rollover. These are initial ceilings to qualify, not capacity claims. Existing casual and unrated arena limits do not increase.

Reuse the account-reservation and idempotent budget-receipt flow. Competition commits account/proof-slot ownership and the creation intent together; initialization waits until the matching monthly proof receipt also exists. This is a recoverable sequence across authorities, not a claimed D1/DO transaction. A lost reply reconciles the same intent, game and receipt. Known admission denial releases unused slots; uncertain state remains reserved until reconciliation proves release safe. No game starts without both capacity and spend authority. Stops close new reservations while previously reserved proof, terminal delivery and recovery work drain. Sleeping slots do not keep a Container awake.

#### Private executable proof contract

The product-owned pool is reachable only through a Worker binding. Expose no public or client-supplied arbitrary-FEN endpoint. Accept one strict JSON request, at most 128 KiB of UTF-8, with exactly these fields:

| Field | Contract |
| --- | --- |
| `v` | Integer `1`. |
| `rulesVersion`, `profileVersion` | The two fixed versions above. |
| `gameId`, `reservationId` | The permanent admitted game ID; both must agree with the saved reservation. |
| `pendingVersion` | The exact positive safe-integer Game version that entered pending adjudication. |
| `requestId` | `timeout:<gameId>:<pendingVersion>`, stable across delivery retries. |
| `survivor` | `w` or `b`, matching the non-flagging seat in the saved pending result. |
| `initialFen`, `fen` | The saved legal initial position and canonical current six-field FEN, each at most 128 ASCII bytes. Current FEN uses legal en-passant notation and retains castling rights and move counters. |
| `moves` | Authoritative lowercase UCI strings, each matching `[a-h][1-8][a-h][1-8][qrbn]?`, at most 12,700 plies. No SAN, PGN commands, variant or solver options. |
| `historyDigest` | Lowercase SHA-256 of UTF-8 `JSON.stringify([initialFen,moves])`. |
| `positionDigest` | Lowercase SHA-256 of UTF-8 `JSON.stringify([rulesVersion,gameId,pendingVersion,fen,survivor,historyDigest])`. |
| `expiresAt` | The original pending deadline in integer UTC milliseconds, exactly flag time plus 30 seconds. |
| `attempt` | `1` or `2`, covered by the game's saved proof credits. |

Validate bounds, identity, policy, digests and remaining time before native execution. Independently replay the complete stored history with pinned python-chess, require legal moves and matching canonical FEN, and reject a position that already ended under the saved online policy. This is validation of retained authority, not a second source of live game moves.

Invoke only the unchanged pinned native example with stdin `<FEN> <white|black>\n`; no shell, user path, executable argument or UCI engine command is accepted. Parse its bounded pinned-format output: `winnable moves <comma-separated-UCI> ...`, `unwinnable`, or `undetermined`. A positive result requires at most 512 witness plies. Replay each legal witness move from the reconstructed history, respecting automatic threefold and 50-move draws and checkmate precedence at each boundary. Accept `winnable` only when the last move checkmates the flagged side and no earlier draw or termination occurred. An invalid or overlong witness is unknown, never evidence of a win. A supported native `unwinnable` result permits a timeout draw; `undetermined`, an inconclusive fast classification or any unsupported output is unknown. Do not infer a negative proof from failed witness validation.

Return at most 16 KiB of JSON with exactly `v`, `rulesVersion`, `profileVersion`, `gameId`, `reservationId`, `pendingVersion`, `requestId`, `survivor`, `historyDigest`, `positionDigest`, `expiresAt`, `attempt`, `solverCommit`, `validatorVersion`, `verdict`, `witness`, and `reason`. Echo the checked request identity, fix `solverCommit` to the full pinned commit, and use validator version `python-chess-1.11.2-online-v1`. `verdict` is `winnable`, `unwinnable` or `unknown`; `witness` is the validated UCI array only for `winnable`, otherwise `[]`. `reason` is `null` for supported proofs, otherwise one of `solver-undetermined`, `resource-limit`, `invalid-input`, `invalid-output`, `invalid-witness`, `unsupported-policy`, `expired`, `transient-start`, or `interrupted`. Transport failure has no proof body. An invalid envelope is a private protocol failure, not an outcome.

#### Bound execution, delivery and arbitration

Use the existing maintained Container lifecycle and subprocess facilities. A job helper that validates input/history and output/witness has a one-CPU-second limit; its native solver child has a separate one-CPU-second limit. Both have 128 MiB address-space ceilings, and an external watchdog kills their whole process group after one shared two-second wall deadline or the earlier remaining request deadline. These are per-process address-space and helper-CPU ceilings, not a claim that the whole Container uses 128 MiB or one CPU-second. Limit native stdout to 16 KiB and stderr to 4 KiB while reading; exceeding either limit kills the group and returns unknown. The hosting Container tier must enforce and measure its own total memory/CPU bound and use ten-second idle sleep. No child survives a cancelled request, process crash or pool restart. These values are safety ceilings to qualify, not measured universal completion guarantees; do not silently raise them to make fixtures pass.

Persist an attempt receipt keyed by `(requestId,attempt)` before execution, and persist its bounded result before acknowledgement. Duplicate delivery reads the same receipt without rerunning or charging work. Reconcile a lost reply before using another credit. An interrupted in-flight attempt is consumed and can yield unknown; at most one further attempt is allowed for transient start/delivery interruption when credit and original time remain. Native unknown, resource exhaustion, malformed output and failed witness validation do not trigger another search. Bound receipt retention through the existing retained-game/storage admission ceiling and preserve the permanent game/result identity after detailed receipt expiry.

Game retains the pending request identity and original expiry. A private result may finalize that exact still-pending version once only after every version, side, reservation and digest agrees and its deadline remains open. `winnable` awards the survivor a timeout win; supported `unwinnable` records a timeout draw. Stale, mismatched, duplicate, late, expired or failed work cannot overwrite a terminal result or change ratings. Unknown freezes play and settlement, then the existing alarm records one unrated technical void at the original 30-second deadline unless a supported proof already won arbitration. Retries and restarts never extend it. Tournament cutoffs retain their earlier published deadline and existing unrated policy.

#### Qualification before enabling the profile

Use a licensed or authorized difficult corpus with full histories and both surviving sides. Cover ordinary starting/middlegame/endgame flags; bare king, two knights, bishop versus knight, asymmetric and blocked walls; castling, en passant, promotions; repeated positions, 50-move boundaries and checkmate precedence. Include invalid, wrong-side and overlong witnesses, real native-process unknowns, killed children, memory/output limits, failed startup, restart, lost replies, duplicates, stale results, timeout/technical-void races and exhausted admission budgets. Preserve expected supported answers; ordinary flagging fixtures must resolve correctly within the stated limits rather than all falling through to technical void.

Use existing C14/C15 to require real native witnesses rejected by independent online-draw validation as `unknown`/`invalid-witness`. Require G07 to retain both exact solver-child kill evidence and its native attempt receipt showing `unknown`/`resource-limit`; a kill or technical void alone does not establish that reason. Preserve synthetic native `undetermined` parser coverage and the production `solver-undetermined` mapping, without counting them as native observations. Pinned upstream reports no known legal position its full search cannot resolve, but does not prove completeness. No genuine native `undetermined` fixture is retained or claimed executed. Record that observation gap and add a genuine fixture if found. Do not inject results as real native evidence or relabel invalid input, rejected witnesses or resource limits as `solver-undetermined`. All ordinary-answer, original-deadline, no-rating technical-void, once-only settlement, slot-release, resource, cost, failure and recovery gates remain required.

Run the corpus locally and through the private provider binding, including four simultaneous cold timeout requests and their allowed retries. Every required ordinary flag must finish before its original 30-second deadline with correct once-only settlement, and every failed/unknown proof must preserve the fallback. Measure total provider and child CPU, peak memory, cold start, queue age, wall time, failure/unknown rates, retry/storage overhead and cost per 1,000 attempts. Use the pinned passing provider tier within the current single $100 target and existing stops. Retain measured quantities and common-cycle billing units counted once. Do not reopen superseded service-allocation or financial-review gates. Unknown costs remain unknown; a reviewed estimate is not a measured invoice ceiling. The existing 16-query feasibility result, a Node WASM probe, or local Container tests do not complete this gate. Update player rules, privacy, operations, package notices and developer reproduction guidance in the product change, clearly separating local, deployed and released evidence.

The retained 2026-10-21 Basic run covers all 27 current corpus fixtures and four
cold requests on immutable image
`sha256:4e66a8b70f12948e091815d7443001d629a97e90c98e6043736bf5935e0cc93f`.
The 2026-10-22 private `basic-corpus-reuse-review.json` verifies every fixture,
receipt and public evidence pin. Current raw corpus SHA-256
`2e69967d7ec143d5487a4b71a6b901fcb3e743dbc5d052ef1aa9cade32be2254`
maps to the retained `JSON.stringify([corpus])` digest
`a37b4d12e4c0eaaae30bd95de2eac9ea9e03c9b90e25dae3e477b842b8530183`.
Reuse that native corpus coverage without another full corpus run. The current
Worker build differs. Historical synthetic transport and dated physical stop
prove neither current Game/Competition settlement nor current Prover
restart/restore, spent-credit reconciliation or physical shutdown. Those gates
remain separate and unpassed by this evidence review.

The renewed Basic candidate is inert preparation for 12 current Game branches.
It reuses the historical native corpus only. Candidate preparation passes no
current Game, settlement, restore or shutdown branch, and does not authorize
execution without its exact source/resource review.

Keep four private review records: `reviewGates.costReview`,
`reviewGates.sourcePermitReview`, `reviewGates.ownerResidualCostAcceptance` and
`reviewGates.providerResourceQualification`. Before finite execution, the first
two need `status: reviewed` and the owner record needs `status: accepted`, each
with the SHA-256 of its actual immutable document. Bind them into the frozen
manifest and runtime identity as `costReviewSha256`,
`sourcePermitReviewSha256` and `ownerResidualCostAcceptanceSha256`. A plausible
hash or synthetic local fixture is not review or owner acceptance.

The checked-in template stays unarmed with all four records pending and hashes
null. The provider record stays pending in the frozen measurement manifest;
retain later provider results in a separate report tied to that exact manifest,
source, bundle, config and resource identities. Production review binds that
report without rewriting the frozen manifest. Cost adoption permits no extra
image, native allocation, job, attempt, admission, experiment or lifetime and
passes no real proof/Game/Competition, restore, capacity or player-flow check.


Preserve fixtures for practical edge cases: underpromotion, en passant, castling rights after reconstruction, repetition, move-count boundaries, mate on a deadline, bare king and minor-piece flag cases, and blocked dead positions. Protect product adjudication contracts rather than reimplementing the dependency's own test suite.

Alternative: call `isGameOver()` and award every flag as a win. Rejected because that hides known errors in draw and timeout behavior.

### 10. Keep fair play private and bounded, with optional review

Prevent protocol and account abuse first: authoritative rules, bounded rates, authenticated seats, replay rejection, one ranked reservation, farming/repeated-pair checks, and server move timing. Validate Turnstile tokens server-side on signup/guest-creation or abuse step-up, not every move. A challenge token proves no chess skill or engine-free play.

Competition owns versioned informational checks for every accepted final ranked
human result, including results waiting for rating repair. The checks cover
repeated pairs, reciprocal wins, and scored resignations before ten plies.
`account-cluster` means three distinct accounts have all three scored pairings
within one 24-hour span. It describes a play cluster, not common ownership.
`rating-transfer-candidate` means one account received at least three scored
wins from at least two opponents within one 24-hour span, including at least
two resignations before ten plies. It records concentrated wins, not a computed
Glicko transfer or a finding of arranged play. Draws and voids cannot supply
scored wins. Neither pattern changes ratings, eligibility, or queue priority.

Use native SQLite indexes over normalized pair accounts and winner/end time,
with event times in both directions and canonical unions of positive patterns.
Delayed results update every participating retained check; duplicate deliveries
do no extra motif work. Under the 1,000 retained ranked-game ceiling, examine
at most 4,000 candidate rows and update at most 1,000 distinct checks per new
result. Guard each neighborhood query with `LIMIT 1001`. A bound breach leaves
the basic durable check in place and reports incomplete extra coverage without
rejecting settlement. Upgrade legacy check coverage through a durable keyset
cursor of at most eight games per alarm. Expose pending and incomplete coverage
in private operations. These are work ceilings to verify with SQLite cursor
counters and query plans, not a measured latency or detection-accuracy claim.

After completion, enqueue bounded analysis with a pinned Stockfish version, network checksum, options, and analysis profile. Native [Cloudflare Containers are generally available](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/) on Workers Paid. Start with an explicitly capped sleeping pool and fixed safe engine inputs. Bound instances, consumer concurrency, positions, nodes/CPU, wall time, memory, retries, and daily spend. Stop or defer analysis when its budget is reached; never block move processing. Do not force full NNUE analysis into the Worker's 128 MB, single-threaded runtime.

Store completed PGN and a capped structured evidence summary in D1, not unbounded engine output. Keep evidence, reports, IP/security telemetry, and reviewer notes private. Document retention and deletion before collection; hold decision evidence through the published appeal window after notice and any timely appeal. Record missed/failed analysis and queue lag; a missing report is neither clearance nor guilt. Queue/alarm retries need a dead-letter/reconciliation path, because automatic [alarm retries are finite](https://developers.cloudflare.com/durable-objects/api/alarms/).

Optional authorized owner maintenance may use a private `/admin/` view for reports, position/context review, related games, decisions, and appeals. Protect that view and every admin API with the approved Cloudflare Access policy and application owner authorization, validate the Access token, and keep session/restriction checks fresh. Public game/leaderboard APIs never expose evidence or emails.

Engine agreement, centipawn loss, move timing, and shared IPs are signals, not automatic sanctions. Do not collect tab focus or invasive fingerprints in v1. An accuracy threshold never bans or restricts an account by itself. Case-based restrictions require a corroborated human decision, a review deadline, player-visible reason/status, and expiry unless supported renewal is recorded; objective abuse throttles do not imply cheating findings. Calibrate on representative legitimate games and controlled assistance examples, preserve uncertainty, audit human decisions, offer a clear private appeal route, and repair ratings through replay. Routine operation must not wait for a reviewer. In unattended mode reports and screening are informational, and no cheating conviction, account restriction, or rating removal follows automatically. Disclose that unsupervised engine assistance cannot be reliably eliminated. Competitive launch still requires tested objective abuse controls and an accepted adjudication policy.

Alternative: a single match-accuracy cutoff or browser monitoring presented as proof. Rejected because either can punish strong legitimate players while missing selective assistance.

### 11. Treat budgets as acceptance targets, not measurements

| Path | Proposed initial target and check |
| --- | --- |
| Initial play route | At most 180 KB gzip JavaScript, including its initial shared code; report lazy chunk sizes separately. |
| Static product guides | At most 95 KB gzip initial JavaScript; no board, auth workflow, or engine chunk in the guide load. |
| Product layout/assets | At most 20 KB gzip CSS on play, 14 KB on guides, 70 KB fonts, and 30 KB HTML per route; report board/piece asset costs. Existing studio budgets remain in force. |
| Move validation | p95 server CPU at most 10 ms on representative positions and histories. |
| Durable move commit | p95 service time at most 50 ms, excluding WAN; separately report end-to-end latency by tested region. |
| Admission envelope | Exercise 1,000 live games and 20 settlements/second, including reconnect bursts and both formats; derive the enforced admission cap from passing results. |
| Analysis | Benchmark locally and estimate cost before provisioning; under an owner-approved canary spending ceiling, measure deployed cold start, memory, nodes/second, queue delay, and cost per 1,000 games before wider use. |

All figures above are proposed and unmeasured. No worldwide performance or concurrent-player guarantee follows from them. Record hardware/provider context, workload, samples, and failure rates with results. A budget miss requires a measured change or an explicit accepted trade-off, not a silent target increase.

Use Cloudflare's maintained Worker/DO test tools and focused browser tests. Cover duplicate moves/results, timeout races, hibernation, reconnects, failed init, outbox failure windows, stale projection delivery, revocation, guest/ranked separation, rating replay and restart, API/admin authorization, accessibility, and regional clock fairness. Avoid expensive unrelated product suites.

#### Authorized monthly spending and stops

On 2026-10-20 the owner authorized $100 per month for chess and requested stops
and alerts. This replaces the earlier missing spending ceiling. The budget
covers chess's Workers subscription and usage; existing resources for other
products remain outside chess's authority. It does not authorize raising
unmeasured admission limits, public ranked launch, or unrelated account changes.
The owner confirmed `chess@ejmlabs.com` as the sender and supplied the private
delivery-test and alert destination. Sender onboarding and delivered messages
were initial verification gates. Dated canary evidence records onboarding and
delivery to that one recipient; complete task 6.2 remains open.

Use fixed bounded monthly counters and idempotent operation receipts to close
new game creation, sign-in email, and optional server analysis at conservative
workload ceilings. Explicit private stops remain available independently of
quota resets. Invalid configuration or unavailable quota authority closes new
expensive work. Retries cannot double-charge a game ID or bypass its admission
receipt. Active games, terminal delivery, replay, and necessary recovery continue.
Retain storage ceilings separately because a new month does not free retained
records. Set ceilings from measured request, duration, write, mail, and analysis
costs before expanding admission. Disable server analysis first and reserve
headroom for accepted work and service recovery.

### Historical budget calculations, superseded on 2026-10-22

The following dated calculations are retained as evidence. They do not impose
current per-service allocations, reserves or repeated approval requirements.
The current single target, alerts and stop at the start of this design control.

The prior owner-approved proof allocation was $20 of the same $100 envelope
on 2026-10-21 UTC, replacing the proposed $10 share. The owner-approved
$25 proof/$45 core policy supersedes that historical $20 proof/$50 core split
by transferring $5 from core to proofs. It preserves
the full $25 capacity reservation inside core and the separate $20 recovery
share. Include startup, awake/idle memory and disk, helper/native CPU, private
binding/DO/D1 work, receipts, retries, physical storage, restore/SDK work,
images and historical setup/log charges. Reserve one named $5 pretax amount
for all unknown proof/image/historical costs together, plus 12% planning tax.
These are planning choices, not a known registry tariff or provider tax quote.
Missing tariffs, current spend and final tax remain explicit unknowns. The
owner accepted the disclosed residual pricing and provider-stop risk with
this policy. Retain that acceptance separately from cost, source-permit and
provider-resource reviews; it qualifies no runtime or provider resource.

Count complete excess billing units once in a common account billing cycle,
with no assumed shared free allowance. The corrected finite-plus-normal proof
estimate is $22.0265653556418 including the named reserve and planning tax,
leaving $2.9734346443582 inside proof. The capacity-plus-finite-plus-normal
estimate is $33.3385653556418 across their separate allocations. These are
conditional estimates, not full monthly invoice forecasts or passed gates.
They include the recovery addendum v2: 480 extra request equivalents at the
existing private 100 ms CPU ceiling, $0.278087808 added pretax overall, and
$0.311458344960 with planning tax. Preserve prior dated arithmetic.

The combined envelope is 977,300.440324992 GB-seconds and 1,201,327 DO request
equivalents. At reviewed rates, assign the one started $12.50 duration unit
to proof and one $0.15 request unit each to proof and capacity. The duration
margin before a second unit is only 22,699.559675008 GB-seconds. If cycle,
quantities or tariffs differ, rebuild the ledger. Do not subtract another first
unit or grant work from shared-unit savings. Refresh primary rates and actual
account headroom before qualification.

One additional awake Prover month adds 342,835.2 GB-seconds and pushes that
combined model into a second duration unit. No maximum provider stop-failure
time is proved. Fuses and delayed alerts cannot guarantee a $100 invoice;
unexpected cost evidence closes new proof/ranked work while accepted work and
bounded shutdown continue. Money adoption raises no workload or test limit.

| Use | Monthly allocation |
| --- | ---: |
| Existing Workers base fee attributed to chess | $5 |
| Core game, account, projection and retained data work | $45 |
| Timeout proofs, including complete incremental billing units | $25 |
| Verification and recovery email | $5 |
| Optional postgame server analysis at launch | $0, disabled |
| Accepted work and recovery headroom | $20 |
| Total | $100 |

These are internal allocations to qualify, not measured invoice amounts or
provider-enforced dollar caps. Optional analysis must not consume recovery
headroom. The unchanged alerts and stops retain their existing limits.

Use one instance, four reserved ranked slots, at most 1,000 monthly game
reservations and two attempt credits per reservation, with ten-second idle
sleep. Enable the profile only after the pinned provider tier passes the required
proof, settlement and recovery checks within current runtime and spending
controls. Historical allocation calculations add no current approval gate. Keep new
ranked admission closed when capacity, configuration or budget authority is
absent. Existing reserved attempts remain funded through stops and month
rollover; optional Stockfish screening may stop first. These workload controls
do not remove the account-wide invoice exposure described below.

Configure Cloudflare billing alerts at $45, $70, and $85 of account-wide usage
charges, which approximate $50, $75, and $90 when adding one $5 Workers base
fee. Record the actual billing cycle, existing subscriptions, account usage,
recipients, and successful readback. Preserve existing alerts and other products.
Cloudflare evaluates usage daily, excludes recurring subscription charges, and
does not stop usage when an alert fires. Application counters limit supported
workloads, not the provider invoice: rejected HTTP traffic, persistent storage,
other products, tax, and delayed billing can still incur charges. Document the
remaining exposure and verified emergency actions without promising an exact
$100 hard cap. No alert or stop is configured merely by writing this plan.

#### Provider recovery capture and isolated rehearsal for task 6.3

Use native D1 Time Travel and SQLite Durable Object bookmarks through thin
product-owned hooks. Native provider history is automatic on supported
backends and is not an independent downloaded backup. A separate SQL export
needs an approved private destination, access rules and expiry; a production
account/session export is not required or authorized by this plan. Synthetic
isolated drill exports remain separate. Add no database engine, production
import endpoint, new storage service or routine background job. Verify native
retention and distinguish it from offline copies and cross-store transactions.

Add `captureRecoveryPoint()` to Game and Competition. It runs storage sync,
bookmark capture and bounded metadata inspection under one object's concurrency
barrier. Return a versioned private envelope with exact object identity, native
bookmark, capture time, alarm, policy versions, and relevant state/event digests,
watermarks and pending-work counts. Capture errors fail closed. Metadata capture
does not change a game, clock, command receipt, result, epoch or outbox. Add a
bounded admitted-ID inventory across D1 ledgers/projections and Competition
matches so pending ranked games are included. Existing owner-account and Access
checks protect any HTTP capture route; validate admission before touching a
Game object. Keep raw account/session/evidence data and credentials out of the
capture response. Ordinary play and existing UI packages need no new contract.

Use a separate recovery-drill entry point and checked config with fresh D1 and
SQLite DO resources, synthetic identities, explicit rehearsal-only resource
names, and no production bindings or custom-domain routes. Root owns protected
invocation, provisioning and real provider operations. Native prepare-restore
and restart hooks exist only in the isolated entry point, never the production
Worker export. They reject a mismatched object, namespace, schema or policy,
record the provider undo bookmark before restart, and accept only the reviewed
manifest. Test hooks locally with maintained Worker test tools; do not label a
mocked or local bookmark as a provider restore.

The private manifest pairs exact D1 database/schema/bookmark data with each
object's identity, bookmark and authority metadata, plus the fixed journal
watermarks, pending reservations/outboxes, published epochs and approved source
revision. Keep it in an owner-controlled private directory outside rollback
targets. Budget stops close admission but do not freeze active games, alarms,
cron or queues. A drained boundary needs explicit verification. Active-game
recovery must retain the last accepted command, deadlines, original seat owners,
receipts and pending terminal delivery. Preserve current state and later
accepted work before any destructive operation. Reject uncertain boundaries
rather than replaying an old move with a new clock arrival or overwriting a
newer accepted terminal event. D1 projections never replace DO authority.

The provider drill captures, deliberately changes and restores the same isolated
resources using native D1/DO APIs. It verifies account/session/seat ownership,
a retry of an accepted active-game command, deadline behavior, terminal delivery
with a lost reply, a retained tombstone, rating/correction epochs, budget receipt
counts and enabled event state. Include stale/mismatched manifests and later
accepted work; refuse unsafe rollback or reconcile through the documented
idempotent authority path without duplication. Measure elapsed recovery and the
actual data-loss boundary. RTO/RPO, provider retention, complete cross-store
coverage, automated privacy/retention controls and real restoration remain task 6.3
and ranked-launch gates until root records a successful provider rehearsal.
Update product operations, deployment and developer guidance with the hooks,
exact rehearsal commands, undo path and unrun checks. Do not claim that capture
hooks or local tests alone establish full-service restoration.

### 12. Publish the operational contract with the product

Product-owned guides cover setup, architecture/public interfaces, configuration, local development, migrations, formats, server-arrival clocks, adjudication limits, reconnect recovery, provisional ratings, leaderboard eligibility, fair play, privacy, appeals, queue failures, rating repair, backups, admission, and rollback. Keep route links, examples, API errors, package notices, and generated pages in the normal docs build.

Extend the canonical-host policy specifically to `chess.ejmlabs.com`, keeping worldwide access, TLS, managed WAF, and DDoS protections. Avoid blanket challenges on auth APIs and WebSockets. Disable unwanted `workers.dev` and preview URLs; use a separately protected preview. Configure existing public CSP options for same-host `wss`, auth connections and Turnstile script/frame/connect origins; extend the owner API only for a verified missing capability. No wildcard policy or hand-maintained duplicate `_headers` file.

## Risks / Trade-offs

### Added scope: browser Stockfish practice

The owner's later request on 2026-10-20 replaces free OpenRouter opponents with Stockfish to avoid tokens. This changes product-owned practice only. Shared UI contracts, live human fair play, ranked gates, and Cloudflare hosting stay under their existing owners.

Use maintained `stockfish@19.0.1`, pinned to its lite single-thread classic Web Worker build. Its published JavaScript and WASM total 1,874,201 bytes. Vendor only the required assets with exact hashes, upstream GPL notice, and corresponding source. Keep the engine off initial route downloads and the server bundle. Cap raw engine JavaScript plus WASM at 3 MiB and its configured transposition table at 32 MiB. Measure startup/search behavior, emitted assets, and initial route budgets. A hash-table setting is not a total browser-memory bound. Single-thread mode avoids adding global cross-origin-isolation headers.

Offer Relaxed, Club, Strong, and Maximum using built-in Skill Level 0/6/12/20 and 150/300/600/1,200 ms searches, with Threads=1, Hash=16 MiB, Ponder=false, and MultiPV=1. The upstream build starts with 128 MiB WASM memory and can grow; measure actual browser use rather than claiming a 16 MiB total limit. Do not invent Elo ratings or claim the browser's engine provenance is audited. The browser may alter its own engine, so these games remain private unrated practice. Use the complete accepted UCI move history with `position startpos moves` to retain repetition context. Permit same-host workers and the narrow wasm-unsafe-eval CSP token through the existing public HeadersOptions extra contract, without unsafe-eval, wildcards, or shared-owner changes.

Keep the existing internal AI/history label for compatibility. The server selects the fixed build and difficulty. The authenticated White owner alone may submit an `engine-move` proposal for Black in that active unrated Stockfish game, with the existing command ID and expected version. The server validates session, ownership, engine identity, turn, legality, deadline, and terminal state through the common move path. Human, ranked, tournament, and historical OpenRouter games reject engine commands. A Black metadata seat has no session or WebSocket authority. Duplicate commands retain one receipt.

The browser discards stale search output and terminates the worker when the game ends, the page unmounts, or access is lost. Reconnect restarts from an authoritative snapshot and preserves pending command replay. Startup/search failures show a recoverable error, with no invented move or result. Server clocks continue while the tab is suspended or disconnected; explain this before play. Preserve historical OpenRouter records, but end any old unfinished provider turn truthfully without invoking the provider.

Remove active OpenRouter catalog/inference/credential/quota paths. No engine position or identity is sent to an inference provider. Practice still stores accepted moves and private replays on Cloudflare. Verify server authority, stale/duplicate/terminal races, real browser worker readiness and legal output, failure/retry/disposal, history/PGN labels, competitive exclusion, license/source delivery, and affected build budgets.

### Added requirement: large automatic tournaments

#### Selected format and package fit, 2026-10-20

Use `arena-v1` alongside the unchanged versioned small round robin. Preserve
hourly blitz and daily/weekly rapid cadences. Pair for 60 minutes in blitz or
120 minutes in rapid. Eligible username/password entrants explicitly queue and may pause or
resume between games; registration alone reserves no account. Stop creating
games at closure and drain accepted games with 18-minute blitz or 40-minute
rapid wall deadlines. Publish `draining` and provisional standings until every
intent resolves. Score wins 1, draws 0.5, losses 0, and technical voids/no-shows
0. Give no bye, streak, or berserk points. Keep all event games unrated. Equal
scores share ranks with stable account-ID display order. Pause a no-show until
explicit resume. Permit at most two meetings for an unordered pair per event,
with another opponent between repeat meetings; never relax this silently.

The maintained `@echecs/round-robin` supplies fixed Berger tables for 3 to 16
players, and `@echecs/tournament` retains full rounds and requires the previous
round to finish. Keep both for the preview. Maintained MIT `@echecs/swiss`
implements round-based FIDE systems. GPL `tournament-pairings` offers Swiss
weighted matching but lacks the required oldest-waiter priority. Neither fits
continuous pause/resume arena policy. Use maintained SQLite ordering, indices,
transactions, and bounded cursors for product-specific FIFO/aging policy, not
a new general matching solver. Primary package references:
https://github.com/echecsjs/round-robin,
https://github.com/echecsjs/tournament,
https://github.com/echecsjs/swiss, and
https://github.com/slashinfty/tournament-pairings.

#### Authority, public reads, and bounded work

Competition remains the sole score and cross-mode reservation owner for the
first qualification tier. Store arena metadata, entrants, waiting lanes, stable
game intents, pair counts, score receipts, and projection cursors in normalized
indexed rows. Commit each score receipt and the two entrant totals in the same
SQLite transaction as the accepted terminal result. Conflicts stay incidents;
duplicate delivery changes neither scores nor reservations. Partition work by
event and indexed score/rating lanes with rotating cursors. Split coordinators
only if measurements demand it and a separately reviewed reservation protocol
preserves the existing atomic owner contract.

Select the oldest eligible waiter and inspect at most 64 candidates. Prefer
nearby score/rating, widen preferences with wait time, balance colors, and
retain honest waiting when no allowed opponent exists. Pair at most eight per
pass, initialize at most eight intents with at most four external operations
in flight, and cap global new starts at 32/second. Recovery, deadlines, and
projection passes process at most 32 records with durable cursors. Permit at
most three open arenas. Reconcile creating/live intents before releasing their
reservations; wall-clock expiry alone cannot release an unresolved live game.

Public event/schedule/standings endpoints contain no caller state and perform
no session lookup. Private `me` and queue actions use primary auth and
`no-store`. Publish complete standings generations with watermark, timestamp,
at most 32-row/32-KiB pages, and generation-bound cursors. Publish the new head only
after every page exists, cache public pages for 10 seconds, retain two complete
generations, and show projection age. Keep one snapshot build per event.
Eligibility reads must not perform broad maintenance writes.

#### Critical-path public release

The owner approved these release gates on 2026-10-21. Ranked play and large
arenas remain in the initial release. Before opening public access:

1. Qualify real Game, timeout-proof and Competition settlement/recovery within
   four concurrent ranked games, 1,000 monthly proof admissions, two attempts
   per game within the current single $100 target and existing stops. Preserve the original 30-second
   unresolved timeout deadline and prove spent-credit/stop-debt recovery.
2. Pass the full approved once-only first-tier provider run below, including
   three 2,000-entry events, 1,000 combined unfinished games, the complete
   19,000-required/20,000-maximum native workload, 900-second stream, approved
   recovery lead, sockets, real cache reads and faults. Its frozen source,
   exact UTC schedule and shared $25 ledger require root review under the owner's
   finish-and-launch instruction before load. Record actual available client egress and its limits.
3. Complete protected-host player flows for accounts, friend/ranked games,
   rating/history, replay, browser Stockfish and tournament entry/queue/results.
   Check affected board controls, reconnects, privacy and canonical security.
   Reuse the verified email/reset evidence unless its implementation changes.
4. Read back live limits, signup/spending stops, budget alerts and accepted-work
   recovery. Preserve private administration and disable optional server
   analysis. Verify public access and guides after opening the canonical host.

The nine-day real-calendar observation, full-hour 72,000-hot-payload endurance
and 25-per-second retirement run, six-region external WAN benchmarks and later
10,000-entry/5,000-live tier remain unfinished follow-up qualification. They do
not block this initial release or become passed checks. Keep their requirements
and report unrun measurements. The initial public ceilings must fit passing
first-tier evidence, existing production safety limits and monthly headroom.
Do not promise sustained monthly throughput or worldwide latency from a short
single-egress run. No chess rule, retention age, workload corpus or budget
ceiling changes through this release sequencing decision.

#### Qualification and retention

| Workload | First-tier acceptance target |
| --- | --- |
| Entries | 2,000 per event, three simultaneous events |
| Live games | 1,000 combined creating/reserved/active/settling games across modes; 2,000 participant sockets |
| Event registration burst | 10,000 requests in 30 seconds from 2,000 existing username/password accounts, including retries |
| Registration admission | 50 durable registrations/second, burst 100, truthful retry/full responses |
| Results | 20 unique settlements/second for 15 minutes |
| Recovery | 1,000 delayed results, five duplicates each; clear within 60 seconds while sustaining traffic; at least 40 unique settlements/second during catch-up |
| Standings | 10,000 viewers refreshing every 10 seconds; p95 ordinary projection lag at most 15 seconds |
| Latency | Existing move CPU/service budgets; p95 settlement acknowledgement at most 250 ms |
| Initial-run egress | Record actual available real client egress and latency; no unsupported worldwide latency claim |
| Follow-up regions | Separate US West/East, Europe, Asia-Pacific, Australia, and South America benchmarks |

Retain the proposed 10,000-entry/5,000-live tier as later qualification. Neither
configuration nor local tests establish deployed, regional, email, or account
creation capacity. Choose enabled admission ceilings from actual passing cost
and recovery evidence within the owner's $100/month chess budget.

At 20 finishes/second, the one-hour hold requires at least 72,000 completed hot
payloads plus live games and evidence holds. Four retirements/minute and 10,000
permanent IDs cannot sustain it. Large-tier qualification therefore requires
at least 25 successful retirements/second after warmup with bounded concurrency,
retry cursors, and nonblocking holds. Preserve permanent IDs, terminal receipts,
private replay, and immutable results. Archive final standings before removing
temporary event rows; history expiry uses `finishedAt`. Enforce separate record
and byte ceilings with headroom for accepted work. Report cost per 1,000 games
and 10,000 spectator-hours, including auth, projection, storage, retries, and
active-object duration. Retain initial preview limits until the approved
first-tier release gates pass; sustained retention/endurance claims require
the separate full-hour qualification.

Product owns arena runtime/DTOs and UI composition through existing public kit
exports, migrations, tournament guides, and capacity evidence. The security
owner integrates HTTP/deadline/farming hooks. The operations owner supplies
budget/retention controls. No harness or new shared visual contract is needed.

#### Approved isolated native capacity run

The owner approved the bounded plan on 2026-10-21 and directed completion and
public launch again on 2026-10-22. Retain all six failed attempts unchanged.
Fourth run `e8932527-765c-4613-b453-b09a6d6842de` in
`capacity-provider-20261022-warm-v1` reused the exact empty `firsttier03`
Worker, D1 database and namespaces, with no new provider resources. All retained
attempts and any separately reviewed correction share the same $25 ceiling
inside the single $100 target and at most 20,000 charged synthetic Game IDs.
Fifth run `f92e8db1-9991-4432-8c30-487eedaf6d17` prepared all 6,000
accounts, then failed during registration. Keep its 256 uncertain replies, zero
acknowledged registration replies, stop, zero charged Game IDs, two held permits
and one unresolved dispatch. Across the five failures, eight permits and four
dispatches remain held. The 105-entry projection is a snapshot, not an exact
authority count or an acknowledged registration response. No passing full
candidate is recorded. A correction still requires exact frozen source,
resource identities, a feasible UTC schedule and root review before load. This records review under the owner's
instruction, not owner inspection of final hashes or financial reapproval.

Sixth run `56089a5b-0826-45e2-85ed-8a7bae106eb0` used the registration-only
profile. It prepared 256 accounts, offered 238 registrations, received 56
expected retry replies and 182 uncertain HTTP 503 replies, then reached the
eight-grant controller allowance. No registration was acknowledged. Its
complete trace confirms the accepted stop. Scoped native reads confirm zero
Games, admissions and Game receipts, with one Competition and one Controller.
Two permits and one dispatch remain held; the combined six-attempt ledger
retains ten permits and five dispatches. No native shutdown is claimed. The
misnamed `final-provider-status.json` is an initial pre-stop observation; the
complete gzip supplies a separate retained stop receipt. Correct the bounded
ingress grant envelope, carry the signed Competition ticket from arm and
recover only saved workflow state for stop. A corrected exact diagnostic
still needs review. This changes no production ceiling or required workload.

Before the full retry, use one sealed registration-only diagnostic through
the repaired normal registration path: exactly 256 primary users, credential
records and sessions, 768 unique existing registration ordinals, 3 ms offer
spacing, 256 inflight requests, five-second response deadlines and a 90-second
hard window. Permit only preparation, authentication, registration, status and
stop. Reject Game, queue, socket, proof, spectator/cache-load and fault routes
before dispatch. Scale the existing finite controller and Competition work
envelopes to this profile, reserve no Game workflow, and require a native
zero-Game stop receipt with drained work and deleted alarms. Retain all failures
and uncertain work in the same ledger. This is a registration diagnosis, not
first-tier workload or launch evidence. Review the exact final profile, frozen
bytes, feasible UTC times, resources and complete allowance before execution.

The first attempt failed before Game admission. Retain its complete trace,
permanent stop, two lifetime permits, unresolved Competition dispatch and zero
Game-object readback. The successor also failed before Game admission when
account preparation index 10 exceeded its five-second response timeout. Retain
its original interrupted gzip trace, separately labelled recovered prefix,
260 prepared accounts, two held permits, one unresolved dispatch, zero Game
objects, permanent stop and uncertain charges. Neither failure proves native
shutdown or drained permits. Never reset or refund their state.

The third attempt timed out while arming, before any corpus offer. Its retained
native diagnostic found no armed row, users, sessions, games or admissions;
the namespace inventory found only its original controller. Keep that controller,
the failed trace, failed stop response and original arm-delivery uncertainty
unchanged. Those observations permit exact empty-resource reuse for a new run
identity; they do not prove native shutdown or explain the delayed arm.

The fourth run's native prearm read at 15:53:29 UTC reached the new controller
and returned the expected unarmed denial. It armed at 15:55 UTC, then saturated
at preparation index 256 at 15:55:13.120 UTC with 256 requests in flight. The
retained `preparation-trace-summary.json` records 297 successful HTTP 200
responses and 11 uncertain requests; the original trace is incomplete. Retain
that trace and its separately labelled summary. Owner stop in
`failed-warm-stop.json` acknowledged at 15:57:50.627 UTC with zero charged Game
IDs, two active objects, one unresolved dispatch and `nativeShutdown: null`.
Neither successful preparation responses nor stop acknowledgement establish
Game workload, drained permits or native shutdown.

The approved repair is limited to diagnosed fixture setup: seed the existing
6,000 synthetic accounts in bounded private batches, preserving real primary
user, credential-account and session records, fixed identities and ordinary
session eligibility. Retain the complete normal registration work across three
2,000-entry events. Do not substitute fixture acknowledgements for registration,
Game admission or results. Root must review the exact repaired candidate before
execution; unreviewed changes and another run are not preapproved.

The existing fixture verification bound is 640 D1 reads for one attempt. The
platform may retry a read up to three total attempts, while returned metadata
covers only the final attempt. Reserve up to 1,280 additional read units before
dispatch, for a 1,920-read operation envelope, and retain observed final-attempt
metadata separately from conservative retry charges. No uncertainty is refunded
or treated as zero. This read-only reserve permits no write retry or extra
fixture identity and remains inside the unchanged 100-million D1-read run cap.

Preserve the 15-second preparation response timeout clipped to the unchanged
credential-seal deadline. Game/control timeouts, fixed slots, 19,000 required
games, the full 900-second stream, ten-second recovery lead, 1,000 unfinished
games, 20,000 permanent IDs, 2,048 non-hibernatable objects, 50 ms Worker CPU
and 60-minute interval remain unchanged. Prior preparation and unresolved work
remain charged in the shared ledger. Retain the earlier four held permits and
two unresolved dispatches separately from the fourth run's two active objects
and one unresolved dispatch. Production's 10,000 monthly game ceiling remains
unchanged. This repair introduces no new financial approval or allowance.

Product owns the isolated entry, config, run controls, protocol driver, narrow
budget-policy boundary, native fixtures, reports and operations guides. Reuse
Game, Competition, arena admission, primary account/session eligibility,
normal atomic game receipts, permanent IDs, score receipts, public cache reads
and native metrics. Keep the shared UI, studio and harness interfaces unchanged.
The once-only policy is constructed only by the isolated entry and bound to
the sealed database, namespaces and run manifest. An environment flag or HTTP
input cannot select it. Do not copy the budget SQL or bypass normal authority
verification. Production rejects the exception.

Use isolated synthetic Worker, D1, Game and Competition resources and a small
durable run controller, with a private expiring authenticated ingress. The
fourth run's prior empty-resource reuse is historical. Any further resource
assignment requires current readbacks and exact root review; no earlier identity
is reset or rearmed and no resource set is assumed empty after setup work.
Disable version previews and public product routes. Verify exact resource
ownership before arming. No production/account-service, sender, mail, analysis,
proof, queue, Container, model or production-secret binding belongs here. Reject
unknown run IDs before creating a Game stub. Client input cannot choose SQL,
classes, resources, clocks, results, FENs, policies or counters.

Reserve a run unit and normal game receipt before initialization. A durable
once-only arm, charged-ID ledger, monotonic stop and expiry, bounded request
and work counters, unresolved permits and final accounting digest survive
restart, lost replies, month changes, token changes and deployment. No timeout
releases unresolved work or renews its allowance. Denied or uncertain control
reads close new work; existing accepted receipts may reconcile under the same
IDs after a stop. Preserve all accepted state until evidence disposal review.

Use 6,000 synthetic no-email credential accounts across three 2,000-entry
events, imported as existing-account fixtures rather than signup evidence.
Keep ordinary pair, initialization, concurrency, retry, repeat-opponent,
projection and page-size limits. Allow 1,000 combined unfinished games, 20,000
retained tournament payloads/IDs, 2 GiB authority admission budget, 32 starts
per second with burst 32, 50 registrations per second with burst 100, and the
unchanged 50 ms Worker CPU cap. If normal limits miss the target, record failure.

| Complete run bound, including setup, retries, faults and cleanup | Ceiling |
| --- | ---: |
| New charged game IDs / synthetic accounts | 20,000 / 6,000 |
| Generated Worker requests / native DO request equivalents | 1,200,000 / 1,000,000 |
| Worker CPU | 60,000,000 ms |
| DO SQLite rows written / read | 5,000,000 / 500,000,000 |
| D1 rows written / read | 1,000,000 / 100,000,000 |
| Aggregate physical DO / D1 storage | 3 GiB / 512 MiB |
| Simultaneously non-hibernatable objects, all classes | 2,048 |
| Absolute compute accounting interval from successful arm | 60 minutes |
| Raw synthetic evidence retention before disposal review | 30 days |

Use actual SQL cursor and D1 metadata, not returned-row counts. Reserve the
worst next operation and concurrent overshoot before dispatch, including
metering and reconciliation. Keep each object's durable permit until all
native event work finishes. Include active, settling and terminal objects
with pending I/O, controllers, alarms and instrumentation. A lost reply cannot
free a permit. Prove every exported operation, alarm and follow-on path obeys
expiry and work bounds; fail local qualification if any path is unbounded.
Inactive completed objects must have no unnecessary I/O, timers or alarms.

For the 2026-10-22 critical path, local preparation requires focused native
safety evidence for uncertain replies, held permits, fencing, accounting and
drained shutdown against the exact candidate source. A full local performance
pass is not an additional prerequisite. Remove the implementation-added full
local performance gate from the sealer rather than declaring a failed run
passed. Retain prior failures. The complete provider workload below remains
mandatory and must fail on unresolved errors or missed performance targets.

Allow setup and initial occupancy at most 10 minutes, retain the full 900-second
regular phase, close new admissions/generated reads by minute 30, stop issuing
work by minute 45, and allow at most 15 more minutes for already pending native
I/O. Freeze unresolved synthetic state and fail if normal work does not drain.
Private test stopping cannot change production accepted-work policy. The
driver and independent server guards enforce the same fixed manifest and
deadlines, without a free-running cron or an extendable run.

The combined sustained phase requires 19,000 distinct admitted native games:
1,000 initial games form the delayed-result set, and 18,000 later games form
the 20-per-second regular stream over 900 elapsed seconds. Real Game readiness,
legal moves and authoritative terminal rules must produce each result. The
owner approved a fixed ten-second recovery lead on 2026-10-21 UTC because the
1,000 initial unsettled games occupy the unchanged 1,000 unfinished-game cap.
Recover 400 delayed results at 40 per second during that lead. Recover the
remaining 600 at 20 per second during the regular stream's first 30 seconds,
alongside 20 regular results per second. The resulting catch-up target is 40
unique settlements per second for 40 seconds from recovery start, within the
original 60-second limit. The 400 lead results are explicitly outside the
regular terminal stream; that stream still spans its full 900 seconds. All
1,000 delayed results retain five exact duplicate deliveries each. Missed or
late slots remain failures, without shifting deadlines or shortening the
stream. Duplicates are requests, not new results or admissions. Reserve at
most the remaining 1,000 admissions for declared safety cases and uncertainty.
This short-run clarification does not complete the original broader retention,
calendar or regional requirements. The approved critical-path release section
separates those follow-up measurements from initial public opening.

Also exercise the existing registration burst with truthful rate-limit retry,
2,000 participant sockets and a 2,000 replacement burst, actual move CPU/commit
latency under occupancy, public standings read load equivalent to 10,000
viewers refreshing every 10 seconds, and head/varied pages through the real
10-second cache contract. Require p95 settlement acknowledgement at most 250 ms
and ordinary p95 projection lag at most 15 seconds. Report driver saturation,
missed schedules, offered/admitted/accepted rates, cache locality and all stalls.
Finite declared faults cover real restart evidence, D1 outage, lost replies,
conflicting/duplicate results, exhausted limits, expiry, no-shows, eligibility,
pause/resume and repeat-opponent controls. Do not edit clocks or fabricate
terminal rows, acknowledgements or alarm eviction evidence.

The initial provider run may use one named real client egress; the approved
frozen candidate must identify it and its costs. Report the five other regions
as unrun. Separate US West/East, Europe, Asia-Pacific, Australia and South
America follow-up probes need named real egress runners and transport paths.
Colo hints or inter-Worker calls do not prove those WAN paths. Unavailable
regions remain unqualified; paid runners need a reviewed cost line. Every
probe used in a run counts toward that run's finite work allowance.

At zero shared included allowance, the earlier standalone capacity model
is $22.60 pretax. Adding the 12% planning tax gives $25.312, so that table alone
does not establish a fit under $25. The 2,048-object/60-minute bound remains
943,718.4 GB-seconds. In the common-cycle ledger above, assign its shared first
duration unit once to proof; capacity's remaining model is $10.10 pretax or
$11.312 with planning tax. Keep the combined $25 isolated test ceiling inside the current single $100 target.
The remaining dimensions cover requests, CPU, rows and a full month of bounded
storage. Refresh rates, taxes, plan, prior usage and attribution before live
approval. Different cycles or quantities require a rebuilt ledger. Missing or
delayed metrics or insufficient headroom stops new work.
Private ingress and finite work units do not create a hard provider invoice cap.

Seal exact source, config, fixture corpus and driver before live approval.
After a run, reconcile physical/native usage, billing units, unique IDs and
final projections, disable ingress/alarms, verify no continuing synthetic work,
and publish sanitized evidence with all failures and unrun checks. A passing
run does not complete the 72,000-hot-payload steady state, 25-per-second
retirement after the full one-hour hold, mixed holds, real hourly/daily/weekly
calendar, ranked cost, long-term growth or later 10,000-entry/5,000-live tier.
Plan those separately without removing the existing acceptance requirements.

The owner requires hundreds and thousands of entrants in one automatic event. The existing three/four-player round-robin implementation is a local preview and does not satisfy this requirement. The selected arena design above resolves the format; implementation and capacity qualification remain incomplete. Do not raise a cap and claim scale.

Qualification candidates are 10,000 entrants, 5,000 concurrent games, registration bursts, simultaneous completions/reconnects, and cached spectator standings. These are proposed test targets, not supported capacity. Evaluate partitioned entrant/pairing state, per-game authorities, shared account reservations across modes, idempotent score receipts, paged standings, retirement throughput, D1 auth load, regional behavior, and cost. Select admission limits from evidence. Party mode remains conversation only until its design and implementation scope are confirmed.

- [One global Competition object can bottleneck or delay matching/ratings] -> Keep it off the move path, bound admission and queues, measure the stated envelope, and plan a split only with preserved global invariants.
- [A game object has one physical region] -> Prefer nearby players, widen searches transparently, test distant pairs, and publish server-arrival semantics. [Location hints are best effort](https://developers.cloudflare.com/durable-objects/reference/data-location/), not a worldwide latency guarantee.
- [Adjudication package limits can cause incorrect results] -> Block public release until the documented policy, dependencies, difficult positions, and owner acceptance meet the accuracy contract.
- [Engine signals cause false positives or weak screening] -> Keep optional sanctions human reviewed, disable case-based actions when unattended, publish detection limits, and verify objective abuse controls before competitive launch.
- [Analysis/mail are paid or quota constrained] -> Verify Email beta access/domain delivery and measure capped Containers under a spending ceiling before enabling the dependent feature.
- [D1 projections or storage lag/grow] -> Version writes, use primary auth reads and session bookmarks where needed, alert on lag/capacity, and retain retryable authority outside projections.
- [Deployments or provider outages interrupt games] -> Test reconnect/version compatibility, preserve durable events, and use a documented technical-abort policy that voids affected ratings when server records are unreliable; player disconnects alone do not qualify.
- [Owner checkout/API scope is unavailable] -> Establish scoped work and access in `ejm-chess`/`ejm-ui` during apply through each owner's existing workflow; do not work around missing shared APIs in studio files or initialize OpenSpec without a user request.

## Migration Plan

1. Review this planning change, then enter apply only after a new implementation request. Establish owner checkouts, instructions, and scoped work through each owner's existing workflow; do not initialize OpenSpec without a user request. Reconcile the baseline specs before affected studio implementation or sync/archive. No repository or resource is created by this document.
2. Add and check the upstream chess registry/discovery contracts, verify existing public header options, and extend them only for a proven gap before consumer adoption. Keep unreleased chess out of existing cross-site discovery while building the product/docs locally.
3. Implement and test active-game recovery, auth, atomic competition/outboxes, projections, corrections, private review, and the resolved adjudication policy. Run bundle, service, load, accessibility, and failure checks.
4. Before resource creation, obtain the deployment/spending scope, verify Workers Paid and Email beta eligibility, onboard the sender domain, and measure/approve the analysis budget. Prepare scoped secrets, additive D1 migrations, DO migrations, backups, retention and recovery runbooks. Do not place credentials in artifacts.
5. After separately authorized deployment, test the protected preview and exact public host/routes: two distinct browsers, username/password signup with and without recovery email, account invitations, legacy guest reconnect, credential-backed ranked eligibility, promotion, clocks, reconnect, terminal settlement, leaderboard update, replay, automatic tournament rounds, report receipts, and unattended recovery. Exercise owner review, appeal decisions, and rating repair only when explicit reviewed operation is enabled. Verify access denial, headers, aliases, delivery, quotas, regional latency, and deployed revision. A dry run or configured setting does not establish these results.
6. Open public ranked and first-tier arena admission only after the critical-path public release gates above pass. Keep longer calendar/endurance/regional and later-tier qualification unfinished and publish their limits. Enable shared chess discoverability and add studio discovery only after product and guide publication are verified. On failure, close new admission, preserve/drain active games and outboxes, and roll back compatible code through the normal release process. Do not restore an old database over accepted game/rating events; use journal replay and versioned projections. Sync specs and archive only verified completed scope.

### 13. Private match replays

Add noindex /replay/?game=<UUID> using the existing participant-authorized completed PGN endpoint. Reuse GameReplay, chess.js, and the lazy cm-chessboard adapter. Support the recorded initial FEN, start/previous/next/end, selectable SAN, scoped Left/Right/Home/End keys, and board flipping. Reset the cursor on record changes. A read-only board submits no moves and does not capture conflicting keyboard input. Mount one viewer at a time.

Bound each replay at 1 MiB and 12,700 plies, independently of analysis limits. The online automatic fifty-move rule allows at most 100 plies per interval, with at most 96 pawn moves and 30 captures resetting that interval. The conservative 127-interval bound keeps accepted games replayable. It supersedes the former 4,096-ply viewer limit without changing Game rules. Invalid or excessive records show safe errors, never invented positions. Keep history/completed-game links and PGN download. Verify actual exports, custom FEN, special moves, access denial, parsing limits, phone/keyboard use, lazy bytes, and initial route budgets.

### 14. Owned chess logo family

The shared UI owner owns packages/tokens/assets/projects/chess. Extend its native SVG brand system with an original compact chess silhouette, Manrope wordmark, Ink/Paper theme variants, Sage/Forest icons, favicon family, manifest, and social image. Use maintained existing rendering tools for raster icons. Record source/generation provenance. Product composition uses public @ejm/tokens/assets exports. Check contrast, 16-pixel readability, manifests, consumer builds, and unchanged hidden discovery.

### 15. Automatic tournaments

Keep lifecycle state inside the single Competition authority and share its account reservations. Use the maintained @echecs round-robin pairer after archive/API/license/footprint checks, through a thin adapter. Start with three or four eligible human username/password entrants, three Berger rounds, and at most six games per event. Registration does not hold a live seat; start rechecks credentials and restrictions and skips busy entrants. Recovery email is optional. Hold one account tournament reservation through all rounds. Never double-book casual, ranked, or another event.

Defaults are hourly blitz at minute zero, daily rapid at 18:00 UTC, and weekly rapid Sunday at 16:00 UTC. Bound active events and retained events. Fixed event IDs, durable game intents, exactly-once points, alarm recovery, and cron reconciliation prevent duplicates. Create only bounded current/next events after an outage, not all missed periods. Fewer than three eligible available entrants cancels the event truthfully.

Games are unrated, with separate event standings. Normal wins/draws/losses score one/half/zero, a bye scores one, a single ready player receives an event-only no-show point, and double no-shows/technical voids score zero for both. No-show points are not a fabricated chess outcome. Publish shared ranks for tied points and stable ID ordering. Readiness is 120 seconds within an 18-minute blitz or 40-minute rapid round wall budget, with 60-second intermissions. At the wall deadline, unfinished games become technical voids and the event advances. Show these limits before entry; no guaranteed hourly completion or official federation format is claimed.

### 16. Unattended recovery and retention

Routine play, event scheduling, retry, expiry, quota handling, and maintenance must proceed without an operator. Engine reports and statistical screening stay informational. Report receipts disclose review availability. Existing private review tools may remain optional, but unattended mode disables new case-based sanctions and appeal decisions. Temporary restrictions expire automatically; no account is convicted from accuracy, IP, focus, or report count. In unattended mode, close an open report as expired-unreviewed after seven days only when it has no human decision, unresolved appeal, or future evidence hold. Use an indexed oldest-first age query and at most 500 closures per existing maintenance pass. Record automatic outcome/time and increment the case version once, preserving private receipt identity, the 1,000-open-case cap, normal 90-day evidence retention, permanent audit metadata and all rating history. Duplicate submissions return the same receipt and closure without extending evidence expiry. Late optional analysis cannot reopen or add evidence to an expired case; pending analysis does not extend the review window. Closure is not clearance, conviction or a fabricated human review.

For new games on the qualified proof profile, unknown timeout adjudication first uses the capacity and finite attempts reserved at ranked admission. Accept a supported validated proof once under section 9. Any remaining unknown becomes one versioned technical void at the original 30-second deadline, using the durable result outbox to release seats. Historical policies do not change. The fallback remains conservative and can be exploited to avoid losses; competitive launch stays gated until ordinary-flag proof coverage, exhaustion behavior and all other launch gates are accepted and verified. A private tournament deadline RPC may technical-void a game at its published round cutoff without claiming a winner.

Retire proved finished unrated Game payloads after at least one hour. Missing or exact `GAME_RETIREMENT_MODE=preview` preserves at most four attempts per minute. Exact `scaled` selects indexed durable work with at most 32 candidates per pass, four archive calls in flight, and one persisted global allowance of 32 attempts per second shared by alarm, cron, and manual entry points through Competition. Invalid mode values close retirement. Held and failed rows receive bounded retry times so they cannot block later due work. Qualification must measure at least 25 successful retirements per second after warmup before increased admission ceilings are selected.

Both modes require a matching D1 terminal version, rules version, and digest, no active seat, delivery or AI work, and no evidence or appeal hold. Keep a durable minimal Game tombstone and permanent D1 ID ledger; never deleteAll or recycle IDs. Retry retirement after partial failure. History/replay remains in D1. Count retained payloads separately from archived tombstones. Never reset or delete accepted rating events, correction checkpoints, or immutable result history. Permanent records still grow; a separate storage ceiling closes new admission honestly. Do not claim unlimited or operator-free production readiness before retention, failure, and capacity checks pass.

### 17. Compact application spacing

The History browser baseline shows 152px of top page padding at 1280px and a
description detached into SectionHead's second grid column. Those public
marketing defaults work as documented. The product owns compact application
composition: use 32px phone and 48px desktop page padding, stack a title-only
SectionHead and sibling Text, and use roughly 24px between content groups and
8px within label/input/help groups. Keep article prose rhythm, useful form
measure, table scrolling, and the centered board. Apply the same spacing rules
to account, lobby, history, replay, rankings, profiles, tournaments, guides,
private forms, home, and fallback routes without redesigning their content.

Use router Links with the public `link` class inside sentences. Keep shared
Buttons for separate actions and preserve their touch targets. Let one layout
parent own action and form separation; remove duplicated margins and omit
empty pagination or local challenge layout nodes. Preserve every existing
validation, auth, challenge, busy, private-access, and command-identity gate.
Product CSS may arrange content but may not override shared component internals.

The one shared defect is Table loading cells ignoring `density="compact"`.
Fix this in ejm-ui by reusing its existing cell-density layout and clarify the
public docs. Keep the public API and dependency direction unchanged, with no
new packages or harness changes. Verify existing focused Table behavior, owner
and consumer types, one frontend build/budget pass followed by Worker dry run,
and the affected routes at desktop and 360px phone widths. Record grouped
spacing and overflow from the real render, run one final layout detector pass,
update product guides, and deliver a new immutable source snapshot. This local
correction does not satisfy deployment, budget-alert, scale, or ranked gates.

### 18. Shared application layout and regression checks

The owner approved making the spacing correction reusable across ejm-ui
consumers. The isolated and main local UI checkouts have no OpenSpec root;
this existing change remains their planning home. Scope is local source,
documentation, contract checks and consumer adoption. No new package, remote,
publication, deployment or paid work is included.

Extend existing public Page with `variant="application"`: the same page column,
32px phone and 48px desktop vertical padding, and 24px content groups. Default
Page and Band behavior remain unchanged. Extend SectionHead with
`layout="stacked"` to keep title and body-sized description in one column with
an 8px gap. Keep heading size and semantic heading level independent. Add
`gap-field` and `gap-content` theme aliases derived from the existing spacing
scale for native semantic field and content groups. No new form component or
form state system is required. Shared class merging must recognize the aliases
and preserve caller overrides. Chess consumes these public options and utility
names instead of copying padding and field-gap rules into product CSS.

ejm-ui owns the public layout source, theme aliases, layout and Table behavior
checks, complete gallery application page, capture tooling and shared guides.
Chess owns page content, semantic forms, auth/game gates, useful widths and
product guidance. Dependencies remain consumer to public @ejm exports, with no
harness, auth or chess rules in shared UI.

The gallery fixture includes a stacked page heading, form labels/inputs/help,
inline prose links, standalone actions, and loading, empty, error and populated
tables in both densities. Reuse existing Chrome CDP capture and static-server
helpers for four browser passes: 360px and 1280px, each light and dark. Measure
actual padding, heading/copy alignment, field/content gaps, data/loading cell
padding parity, horizontal overflow and standalone touch sizing. Missing Chrome,
fixture markers or results must fail the dedicated check rather than silently
skip. Wire the check after the existing gallery build in the local quality
pipeline, with documented Chrome prerequisites. Capture evidence and retain
focused functional/accessibility tests rather than testing class strings.

Integrate only this pass into the main `ejm-ui` owner checkout after
reviewing current source and preserving concurrent edits. The main checkout
uses base.css while the isolated checkout embeds the theme in styles.css;
translate only the new aliases. Merge the Table density correction without
copying the older isolated rich-table implementation over newer owner source.
Keep marketing default output, public exports and existing downstream layouts
compatible. Check owner types, focused tests, the gallery build/geometry gate,
chess types and unchanged frontend budgets, then the Worker dry run. Record
local integration separately from publication and preserve prior immutable
deliveries and unfinished chess launch gates.
