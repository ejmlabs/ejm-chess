# Spec Delta

## Purpose

Let people play dependable live chess worldwide, with clear controls, authoritative rules and clocks, and recovery after connection loss.

## ADDED Requirements

### Requirement: Simplified operating budget

The service SHALL use the owner's 2026-10-22 decision: one $100 monthly
spending target, existing $45/$70 usage alerts, and the $85 emergency stop.
This requirement supersedes earlier mandatory per-service allocations and
repeated financial-review gates in this change. Dated cost calculations are
historical estimates. Runtime bounds, source integrity, ranked correctness
and tournament qualification SHALL remain required. Billing alerts SHALL NOT
be described as a guaranteed invoice cap.

#### Scenario: Practical quotas replace stopped preview settings

- **WHEN** the owner enables protected-host use
- **THEN** monthly signup, game and email caps SHALL be 10,000, 10,000 and 5,000, with a 100,000 lifetime signup cap
- **AND** account/game and email stops SHALL be cleared while abuse controls, authentication and accepted-work recovery remain enforced
- **AND** optional server analysis SHALL remain disabled and public Access removal SHALL follow the launch sequence


### Requirement: Bounded chess spending

The product SHALL bound new games, email, analysis and reserved timeout proofs
within the owner's $100 monthly Cloudflare budget, with idempotent receipts and
private stops. Active games, funded proofs, accepted results and recovery SHALL
continue. Invalid configuration or unavailable quota authority SHALL close new
work. Docs SHALL state that delayed account-wide billing alerts exclude
subscriptions and impose no hard invoice cap.

#### Scenario: The approved financial policy is applied

- **WHEN** the service applies the owner's monthly allocation
- **THEN** it SHALL use the single $100 target, billing alerts and emergency stop described by the simplified operating budget
- **AND** financial adoption SHALL NOT raise work or test limits or qualify resources

#### Scenario: Monthly admission budget is exhausted

- **WHEN** a new operation would exceed an enforced quota or an explicit stop is active
- **THEN** the service rejects new expensive work truthfully while existing games and accepted-result delivery continue, and retrying an accepted operation does not consume a second admission receipt

#### Scenario: Billing alerts are configured

- **WHEN** account usage alert thresholds and recipients are saved
- **THEN** the operational record includes their successful readback, billing scope and delay, preserves existing alerts, and does not claim that the alert automatically caps provider charges

### Requirement: Private provider recovery

Recovery controls SHALL keep accepted game and rating identities, account and
seat ownership, and authoritative deadlines consistent across database and
object recovery. They SHALL identify exact targets and boundaries, remain
private, reject incompatible or uncertain recovery plans, and preserve later
accepted work. Local hooks and tests SHALL NOT be reported as a verified
provider restore.

#### Scenario: Capture a private recovery point

- **WHEN** an authorized owner captures recovery metadata for an admitted game or competition authority
- **THEN** the metadata identifies its exact versioned recovery point without changing active state, clocks, receipts, results or outboxes or exposing credentials and private account data

#### Scenario: Rehearse provider recovery

- **WHEN** a recovery drill runs against reviewed isolated provider resources
- **THEN** it uses synthetic identities and actual supported database/object recovery, verifies active-game and accepted-result invariants, and records recovery time, data-loss boundary and unrun coverage without touching production resources

#### Scenario: Recovery target or boundary is unsafe

- **WHEN** a manifest targets another object, namespace, schema or policy, or cannot account for later accepted work
- **THEN** recovery stops before destructive operations and keeps new admission closed without overwriting accepted game or rating authority

#### Scenario: Restore accepted terminal delivery

- **WHEN** an isolated recovery restores a game with a pending terminal delivery or an already accepted result
- **THEN** the ordinary idempotent delivery/reconciliation path preserves the permanent game identity and applies the result and both-player rating change at most once

### Requirement: Automated account data controls

Signed-in credential owners SHALL have password-confirmed data export and
closure through maintained auth contracts. Recovery email SHALL remain optional
everywhere. The product SHALL state retained history and snapshot limits without
promising complete anonymization or a staffed account-request service.

#### Scenario: Owner has no recovery email

- **WHEN** a signed-in credential account without recovery email confirms its current password for export or closure
- **THEN** the action uses the same ownership checks as an account with email and does not require mail or an operator

#### Scenario: Owner exports account data

- **WHEN** an authenticated owner confirms its current password and requests a data page
- **THEN** the private attachment contains at most 50 records and 256 KiB, uses no-store caching, excludes secrets and another person's private evidence, and states that pages are not an atomic cross-store snapshot

#### Scenario: Owner closes an idle account

- **WHEN** an authenticated owner confirms its current password and closure has no active or unsettled work
- **THEN** one idempotent atomic batch removes credentials, sessions, recovery/reset data and current profile fields while retaining opaque identity, a minimal closure receipt and the published permanent game, rating/correction and audit history

#### Scenario: Account is active or admission is racing

- **WHEN** closure overlaps a queued request, active game, unsettled reservation or event lock
- **THEN** only an unpaired queue entry may be cancelled, active or unsettled work refuses closure, and a durable admission fence prevents stale requests from creating new work after closure starts

#### Scenario: Closure reply is lost

- **WHEN** the atomic minimization commits before its response is lost
- **THEN** the account stays closed, retry does not duplicate the receipt, and an in-flight signin or reset cannot recreate credentials or sessions

#### Scenario: Export request exceeds its scope

- **WHEN** a request has a wrong password, targets another account, or exceeds the page bounds
- **THEN** it returns no private data, password hash, session/reset token, reporter identity or reviewer evidence

#### Scenario: Closed account exists after a recovery boundary

- **WHEN** an approved restore predates an accepted account closure
- **THEN** preserved later closure receipts are reapplied through idempotent minimization before authentication or admission reopens, and an incomplete or uncertain closure set keeps both closed

### Requirement: Optional browser Stockfish practice

Players SHALL be able to choose labelled, unrated Stockfish games with named difficulty levels. A pinned maintained single-thread engine SHALL run in a lazily loaded browser worker using same-host Cloudflare assets, without a model API, provider key, or token quota. The server SHALL retain authority over legal moves, clocks, history, and results. The interface SHALL explain device-dependent strength and clocks during suspension, without claimed Elo ratings.

#### Scenario: Browser proposes an engine move

- **WHEN** the authenticated White owner submits a versioned engine move on Black's turn in their active unrated Stockfish game
- **THEN** the authority accepts it only if the move is legal and timely, preserving one durable receipt and the authoritative clock and result

#### Scenario: Engine command targets another game mode

- **WHEN** an engine command targets a human, ranked, tournament, historical provider, stale, or terminal game
- **THEN** the authority rejects it without changing a seat, accepted move, clock, or recorded result

#### Scenario: Engine cannot load or a search expires

- **WHEN** the browser engine cannot become ready or complete its bounded search
- **THEN** the interface offers an honest retry without a substitute move, external inference call, or fabricated win, while server clocks keep their published behavior

#### Scenario: A search completes after resignation or reconnect

- **WHEN** engine output belongs to an old game version or a finished game
- **THEN** the client discards it and the server's terminal result remains unchanged

#### Scenario: A player chooses human play

- **WHEN** a player opens ordinary human multiplayer play without choosing computer practice
- **THEN** initial page loading does not download the Stockfish worker or WASM

### Requirement: Cloudflare hosted game service

The game, its authoritative services, stored player data, and background analysis SHALL run on Cloudflare. Production SHALL use `https://chess.ejmlabs.com`. Documentation SHALL distinguish proposed, locally tested, staged, and released behavior.

#### Scenario: Production service inventory

- **WHEN** the product is prepared for release
- **THEN** its deployment record identifies its Cloudflare resources and verified canonical routes without claiming worldwide latency from a single-network check

### Requirement: Human multiplayer and casual invitations

Players SHALL be able to play another person through ranked matchmaking or a casual invitation. All new games and new invitation seats SHALL require explicit username/password accounts. Existing guest sessions SHALL retain access to their already owned games and records without competitive credit. Invitations SHALL grant only an unoccupied seat and SHALL NOT grant another player's identity or control. Friendly invitations SHALL be unrated.

#### Scenario: Signed-out player opens an invitation

- **WHEN** a signed-out player opens a valid casual invitation
- **THEN** the service requires signup or signin before granting an available seat and retains the invitation through that flow

#### Scenario: Existing guest resumes an owned game

- **WHEN** a legacy guest session reconnects to its already owned seat
- **THEN** that seat and history remain available without promoting the guest to an account or granting a new game

#### Scenario: An occupied seat is requested

- **WHEN** someone reuses an invitation after its seat has been claimed
- **THEN** the request does not take over either participant's seat

#### Scenario: An invitation has expired or been retired

- **WHEN** a signed-in new opponent opens an expired, claimed or retired invitation
- **THEN** the page explains that the invitation is unavailable, offers a fresh invitation and does not ask the signed-in player to sign in again
- **AND** private game reads, sockets and Replay remain participant-only, with no expired-game revival or reused identity

### Requirement: Authoritative move acceptance

The service SHALL validate the participant, seat, turn, legal move, game version, and deadline before accepting a move. Accepted moves SHALL be recorded before acknowledgement. A client SHALL NOT set an authoritative position, clock, rating, or result.

#### Scenario: Forged or stale move

- **WHEN** a client sends an illegal move, an opponent's move, an expired move, or a stale game version
- **THEN** the service rejects it without advancing the game and returns the current authorized state

#### Scenario: Acknowledgement is lost

- **WHEN** a player retries an accepted command with the same command identity
- **THEN** the original acknowledgement is returned without applying a second move or clock increment

### Requirement: Server clocks and game start

Clocks SHALL start only after both seats are ready. The service SHALL use its own recorded deadlines and move receipt times, award the published increment once per accepted move, and keep clocks running during a participant's disconnection. Client timestamps and delayed timeout processing SHALL NOT create extra time.

#### Scenario: Move arrives after a deadline

- **WHEN** a move reaches the authoritative service at or after the moving player's deadline
- **THEN** the game is adjudicated as a timeout using the published mating-potential rule, even if its timeout task ran late

#### Scenario: One player never becomes ready

- **WHEN** the published readiness window expires before both players are ready
- **THEN** the unstarted match is cancelled without a rating change and any matchmaking reservation is released

### Requirement: Single authoritative termination

Every game-ending action SHALL check the recorded active deadline and existing terminal state before changing the result. Only one terminal outcome SHALL be accepted. Draw acceptance, resignation, retries, and timeout processing SHALL NOT replace an already determined outcome.

#### Scenario: Draw accepted after time expires

- **WHEN** a player accepts a draw after the active clock's deadline but before the timeout task runs
- **THEN** the service records the timeout outcome rather than changing the expired game into an agreed draw

#### Scenario: Terminal actions race

- **WHEN** two game-ending commands are processed concurrently or retried
- **THEN** all participants receive the same recorded terminal outcome and ranked settlement is emitted only for that outcome

### Requirement: Published online adjudication

The product SHALL publish and version its draw and timeout policy. It SHALL support checkmate, resignation, accepted draw offers, stalemate, automatic threefold and 50-move draws, and documented material draws. Full FIDE compliance SHALL NOT be claimed without verified dead-position and side-specific timeout adjudication.

#### Scenario: Repeated positions across a restart

- **WHEN** play repeats a legal position after a reconnect or service restart
- **THEN** adjudication uses retained move history and relevant position rights rather than comparing only board placement

#### Scenario: Timeout against a bare king

- **WHEN** a player's time expires and the opponent has only a king
- **THEN** the service records a draw rather than a win

#### Scenario: Unresolved adjudication cases

- **WHEN** a known timeout or dead-position case has no correct implementation under the published policy
- **THEN** public ranked release remains disabled until the policy and implementation agree and the case has a regression fixture

#### Scenario: Checkmate and draw boundary coincide

- **WHEN** an accepted legal mating move also reaches a move-count or repetition boundary
- **THEN** the service records checkmate according to the published precedence rather than replacing it with a generic draw result

#### Scenario: Draw offer is answered

- **WHEN** a player accepts an active opponent draw offer or replies with a legal move
- **THEN** acceptance concludes the game as drawn, while the move rejects the offer and continues play

### Requirement: Unresolved adjudication stays pending

Every game SHALL retain its rule-policy version. If bounded adjudication cannot determine an outcome under that policy, play SHALL stop with a visible pending result and no rating settlement. Unattended maintenance SHALL record an unrated technical void after 30 seconds unless a proved supported result already exists; uncertainty SHALL NOT silently become a timeout win.

#### Scenario: Mating-potential analysis is inconclusive

- **WHEN** an adjudication tool reaches its resource limit without determining whether the non-flagging player can mate
- **THEN** both clocks stop, the result waits at most 30 seconds before a technical void, and neither player receives a fabricated win or loss

### Requirement: Ranked timeout-proof admission

Before ranked initialization, new proof-policy games SHALL reserve a durable
slot and two finite attempt credits. Valid capacity, policy and spend authority
SHALL obey the current single $100 spending target and existing alerts and
emergency stop; superseded per-service allocations SHALL NOT add a gate. Stops SHALL close new reservations while funded work
drains. Historical policies SHALL remain unchanged. Missing authority SHALL
refuse admission.

#### Scenario: A proof reservation passes cost review

- **WHEN** a new proof-policy ranked game reserves capacity and finite credits
- **THEN** its budget authority SHALL use finite credits, current workload caps and spending stops; the record SHALL count billing units once and disclose remaining invoice exposure

#### Scenario: Proof capacity or budget is absent

- **WHEN** a ranked pair has no available proof slot, finite credits or verified budget authority
- **THEN** no ranked game initializes and retry cannot double-book accounts, create another game identity or consume duplicate admission credits

#### Scenario: Admission reply is lost

- **WHEN** capacity or budget reservation succeeds but its reply or game initialization is interrupted
- **THEN** recovery reconciles the same durable intent, receipt and game before releasing capacity or starting play, without assuming a cross-service transaction

#### Scenario: New admission is stopped

- **WHEN** a stop or month rollover occurs after a ranked proof reservation was accepted
- **THEN** its saved finite credits, proof deadline, active game and accepted-result delivery remain valid while new work obeys the current ceiling

### Requirement: Private bounded timeout proofs

The product SHALL use unchanged pinned CHA-Solver through a private bounded
adapter outside move processing. A timeout win SHALL require an independently
validated legal mating witness using retained history and the saved online draw
policy. Supported unwinnability SHALL draw; failed, unsupported or exhausted
work SHALL remain unknown. CPU, wall, memory, output and retries SHALL be capped.
Full FIDE or universal completion SHALL NOT be claimed.

#### Scenario: Positive proof respects the full game history

- **WHEN** a bounded solver returns a mating line for the non-flagging side
- **THEN** an independent maintained rules package verifies the retained history, exact position, legal witness, intended winner and automatic-draw precedence before that pending game may accept one timeout win

#### Scenario: Supported negative proof is returned

- **WHEN** the pinned supported solver proves the surviving side cannot mate for the exact reserved request
- **THEN** the still-pending game records one timeout draw through its ordinary terminal arbitration and durable settlement path

#### Scenario: A result is malformed, stale or late

- **WHEN** proof input or output is invalid, oversized, mismatched, unsupported, duplicated, expired or delivered after a terminal result
- **THEN** no fabricated win or rating change occurs, and stale work cannot replace the saved outcome or extend the original pending deadline

#### Scenario: Proof work fails or exhausts a bound

- **WHEN** a solver or validator reaches its CPU, wall, memory or output limit, returns unknown, or is interrupted
- **THEN** only saved finite transient retry credits may be used, the original 30-second deadline remains, and any unresolved result becomes one unrated technical void

#### Scenario: A delivery acknowledgement is lost

- **WHEN** the same private proof request and attempt are delivered again
- **THEN** a durable attempt receipt returns its recorded result without duplicate native execution, budget use or terminal settlement

### Requirement: Qualified ordinary flagging

The proof profile SHALL remain disabled until local and provider tests resolve
the required ordinary timeout corpus correctly under fixed resource and cost
limits, including full histories and a cold burst of all reserved slots.
Failure, unknown and race tests SHALL preserve the technical-void fallback.
This gate SHALL NOT replace other ranked release gates or imply full FIDE
adjudication, measured worldwide latency or large-event ranked capacity.

#### Scenario: Native unknown evidence is kept distinct

- **WHEN** local and provider timeout-proof qualification is assessed
- **THEN** C14/C15 SHALL use real native witnesses and record `unknown`/`invalid-witness` after independent online-draw validation
- **AND** G07 SHALL retain both exact solver-child kill evidence and its native attempt receipt showing `unknown`/`resource-limit`
- **AND** native `undetermined` parser coverage SHALL be labelled synthetic, production SHALL retain the `solver-undetermined` mapping, and neither SHALL count as a genuine native observation
- **AND** qualification SHALL disclose that no known legal native `undetermined` fixture is retained or claimed executed, record that observation gap and add a genuine fixture if found
- **AND** injected results or other unknown reasons SHALL NOT substitute for real native evidence or be relabelled `solver-undetermined`
- **AND** all ordinary-answer, original-deadline, no-rating technical-void, once-only settlement, slot-release, resource, cost, failure and recovery gates SHALL remain required

#### Scenario: Retained Basic native corpus evidence is reused

- **WHEN** the historical Basic run is matched to the same immutable image and all 27 current fixture inputs, including the exact raw-file to structured-JSON digest mapping
- **THEN** its native corpus and four cold-request coverage SHALL remain reusable without another full corpus run
- **AND** the different current Worker build SHALL require its own Game/Competition settlement, Prover restart/restore, spent-credit reconciliation and physical shutdown evidence; the historical synthetic transport and dated stop SHALL NOT pass those gates
- **AND** preparation of the renewed inert 12-Game Basic candidate SHALL pass no current Game branch or authorize unreviewed execution

#### Scenario: Finite execution is reviewed

- **WHEN** a private finite measurement is prepared
- **THEN** execution SHALL require separate immutable cost and source-permit reviews and actual owner residual-cost acceptance, bound by document hashes in the frozen manifest and runtime identity
- **AND** the checked-in template SHALL remain unarmed with all reviews pending and hashes null
- **AND** provider qualification SHALL remain a distinct later report bound to the unchanged measurement manifest, source, bundle, config and exact resources; production SHALL require that passing report and all existing release gates

#### Scenario: Financial adoption precedes provider qualification

- **WHEN** the owner accepts the disclosed estimate, named reserve and residual pricing or stop-failure risk
- **THEN** only that financial decision is recorded; real proof, Game/Competition settlement, restore, capacity and player-flow gates remain incomplete until their own evidence passes
- **AND** finite execution still requires the exact source-permit and cost review hashes, fixed work bounds, original-binding stop path and matching immutable runtime identity

#### Scenario: A cost line is unpriced or a cycle changes

- **WHEN** an image, historical, current-spend, tax or provider-stop cost is unknown, or the common billing cycle or quantity bounds differ
- **THEN** it remains explicit unknown exposure, the ledger is rebuilt as needed and neither zero cost nor a hard invoice fit is claimed
- **AND** unexpected cost evidence closes new proof and ranked work while accepted work and bounded shutdown continue

#### Scenario: Qualification is incomplete

- **WHEN** only feasibility fixtures, local execution or an unbounded search have passed, or ordinary required flags fall through to technical void
- **THEN** the proof profile and public ranked launch stay disabled until the fixed-bound difficult-corpus and provider evidence passes

### Requirement: Focused and accessible board controls

The playing screen SHALL center the board, clocks, participants, moves, and essential game actions. Players SHALL be able to move using touch, drag, click, and keyboard; choose any legal promotion; and use the board at phone and desktop sizes. Motion, sound, and move hints SHALL respect player settings and accessibility needs.

#### Scenario: Keyboard underpromotion

- **WHEN** a keyboard user promotes a pawn
- **THEN** all four promotion choices are reachable, the chosen legal move is submitted, and focus returns to a useful board location

#### Scenario: Phone play and reduced motion

- **WHEN** a player uses a 360-pixel-wide screen with reduced motion enabled
- **THEN** the board and clocks remain usable without horizontal page overflow or required animation

#### Scenario: Invalid local interaction

- **WHEN** a player cancels a selected move or attempts an illegal destination
- **THEN** no move is submitted and the current authoritative position remains clear

### Requirement: Optional legal-move hints

Players SHALL have a Show legal moves toggle, on by default and remembered in
the browser when storage is available. When enabled, selecting an own piece on
the player's turn SHALL show legal destination dots and capture rings from the
current authoritative position. Hints SHALL respect check, pins, castling,
en passant, and promotion without recommending a best move.

#### Scenario: A novice selects a piece

- **WHEN** a player clicks, drags, taps, or selects an own piece by keyboard while hints are on and it is their turn
- **THEN** legal landing squares appear, captures use rings, and illegal king-exposing destinations do not appear

#### Scenario: Clear stale or disabled hints

- **WHEN** selection is canceled or completed, the position or orientation changes, input is disabled, hints are switched off, or the board is read-only
- **THEN** selection hints clear while last-move and premove markers remain valid
- **AND** no current-turn legal hints are displayed for a future premove

#### Scenario: Remember the toggle safely

- **WHEN** a player changes Show legal moves and reloads in the same browser
- **THEN** the saved choice returns when storage is available, and blocked storage leaves the toggle usable for the current page

### Requirement: Shared form choices

Product form choices SHALL use the public ejm-ui Select with shared theme, focus, and touch styles while retaining native labels, validation, disabled states, and platform picker behavior.

#### Scenario: Shared computer strength field

- **WHEN** a player selects computer strength by keyboard or opens the field on a phone in either theme
- **THEN** the field uses the shared ejm-ui styling and chevron, remains within the page width, and preserves the selected difficulty

### Requirement: Site-wide shared UI

Every chess route SHALL compose public ejm-ui controls, typography, states,
tables, disclosures, shell, and game visual surfaces. The product SHALL NOT
maintain a second visual component system or override kit control appearances.
Missing reusable contracts SHALL be implemented and documented in ejm-ui before
consumer adoption. Shared components SHALL NOT depend on product state types,
rules, authentication, or server modules. Native semantic HTML and product
layout remain valid composition.

#### Scenario: Player visits any chess page

- **WHEN** a player opens the lobby, live game, history, replay, rankings, profile, tournaments, help, or an error route in either theme
- **THEN** controls and visual states use public ejm-ui components with usable keyboard focus, phone sizing, labels, and preserved product behavior

#### Scenario: Protected forms use shared controls

- **WHEN** an authorized user opens private review, appeal, or operations forms
- **THEN** shared fields, choices, disclosures, and actions preserve validation, busy gates, confirmation, privacy, and command identity without bypassing access

#### Scenario: Board rendering moves to the shared owner

- **WHEN** a game or replay renders the public lazy Chessboard surface
- **THEN** maintained package input, promotion, hints, orientation, focus, markers, and cleanup remain correct while only the product computes chess legality and submits authoritative commands
- **AND** ordinary guides load no board or engine and remain within their existing initial byte budgets

### Requirement: Compact application layout

Chess application pages SHALL use consistent compact padding and grouped
spacing, with descriptions below titles and inline prose links. Empty controls
SHALL NOT create blank layout rows. Shared Table loading and data rows SHALL
honor the selected density. Product composition SHALL preserve public ejm-ui
visual contracts, accessible controls, useful content widths, and centered play.

#### Scenario: Player reads History on desktop or phone

- **WHEN** a player opens History at desktop width or 360px phone width
- **THEN** the title and description form one aligned group, results and actions have deliberate separation, links within sentences remain inline, and the page has no horizontal overflow

#### Scenario: Account form has no local challenge widget

- **WHEN** the local account form renders its fields and actions without a Turnstile widget
- **THEN** labels, controls, and help remain grouped and no empty widget row adds space, while the existing local challenge token behavior is preserved

#### Scenario: Compact table changes from loading to data

- **WHEN** a table using compact density finishes loading
- **THEN** its loading and data rows use the same density contract without changing its columns, accessible busy state, or horizontal scrolling

#### Scenario: Another application adopts the compact layout

- **WHEN** a consumer uses public ejm-ui application Page, stacked SectionHead and named field/content spacing utilities
- **THEN** page padding, heading alignment and grouped form spacing come from the shared kit without product copies of those rules, while existing marketing defaults remain compatible

#### Scenario: Shared application spacing regresses

- **WHEN** the shared application gallery check runs at 360px and 1280px in light and dark themes
- **THEN** it measures rendered padding, heading alignment, field/content gaps, data/loading density parity, overflow and standalone touch sizing, and fails on regressions or missing browser/fixture evidence
- **AND** the example covers populated, empty, loading and error states through public shared components

### Requirement: Recoverable live state

Participants SHALL see connection status and recover the latest recorded position, history, clocks, and result after a connection or service restart. A disconnected client SHALL NOT show an unacknowledged move as confirmed or continue submitting stale moves.

#### Scenario: Connection returns after missed moves

- **WHEN** a participant reconnects with an older game version
- **THEN** the service restores the current state and clearly shows any timeout or other result that occurred while disconnected

### Requirement: Private live play and completed game records

Participants SHALL have access to their game history and completed PGN exports. Public records SHALL exclude email, session data, private fair play evidence, and connection metadata. Live state SHALL be available only to authorized participants in the first release; completed-game visibility SHALL follow the published privacy policy.

#### Scenario: Unrelated account requests live state

- **WHEN** an unrelated account requests a game that is still in progress
- **THEN** it receives no private position, player session, or analysis data

#### Scenario: Completed game export

- **WHEN** a participant exports a completed game
- **THEN** the PGN contains its legal moves, time control, result, and termination reason without private account or investigation information

### Requirement: Private participant match replays

Participants SHALL replay completed human and AI games from history and completed-game links using the authoritative PGN. The read-only viewer SHALL support recorded initial FEN, start/previous/next/end, move selection, board flip, scoped keyboard navigation, and PGN download. Sources SHALL be bounded at 1 MiB and 12,700 plies. Invalid records SHALL show safe errors without invented partial games.

#### Scenario: Participant revisits a completed game

- **WHEN** a participant opens Replay and selects moves or uses Left/Right/Home/End
- **THEN** each position matches the record, the cursor and current move agree, and no live move is submitted

#### Scenario: Record starts from a custom position

- **WHEN** a valid recorded PGN has a SetUp/FEN header
- **THEN** the replay starts at that FEN and follows its recorded moves

#### Scenario: Access or parsing fails

- **WHEN** an unrelated user requests the record or it is invalid or exceeds its limits
- **THEN** the viewer shows a safe access or record error without private leakage or a fabricated game

#### Scenario: Accepted game reaches the conservative move bound

- **WHEN** a legal server export stays within the online fifty-move policy's conservative 12,700-ply maximum and the byte limit
- **THEN** the viewer accepts it without imposing a smaller move limit than the server's accepted rules
