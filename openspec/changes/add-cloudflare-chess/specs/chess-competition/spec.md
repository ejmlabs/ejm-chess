# Spec Delta

## Purpose

Provide accountable ranked matchmaking and worldwide chess leaderboards whose ratings remain correct through retries, concurrent games, and fair play corrections.

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


### Requirement: Bounded finished-game payload retirement

Retirement SHALL preserve private replay, permanent game identities, immutable results and rating history. It SHALL retire only proved finished unrated payloads after one hour, with no active seats, pending work or evidence hold, and leave a durable tombstone. Scaled maintenance SHALL share a persisted global allowance through Competition.

#### Scenario: Several maintenance entry points request retirement

- **WHEN** alarm, cron and manual maintenance overlap in scaled mode
- **THEN** one Competition pass selects at most 32 indexed due candidates, has at most four archive calls in flight, and shares at most 32 attempts per second across retries and object restart
- **AND** held or failed work has a retry time and cannot block all later due candidates

#### Scenario: A game has evidence or unfinished work

- **WHEN** a retirement candidate has an active seat, pending delivery, AI work, a projected terminal version, rules version or digest mismatch, or an evidence or appeal hold
- **THEN** its payload remains available and retirement does not erase its permanent identity, replay or accepted result

#### Scenario: Retirement configuration selects the preview policy

- **WHEN** retirement mode is absent or exactly preview
- **THEN** maintenance permits at most four attempts per minute
- **AND** only exact scaled selects the larger bounded policy and any other mode closes retirement

### Requirement: AI games stay outside competition

AI games SHALL be labelled in game history and PGN and SHALL NOT enter ranked matchmaking, Glicko-2 settlement, ranked game counts, distinct-opponent eligibility, or competitive leaderboards. The server SHALL enforce this separation regardless of browser input.

#### Scenario: Browser asks to rate an AI game

- **WHEN** an AI game request includes a ranked flag or a model identity in a ranked request
- **THEN** it cannot create a rated AI game or competitive credit

### Requirement: Account access for ranked play

Ranked play SHALL require a validated session for a non-anonymous username account with a password credential and no ranked restriction. Recovery email SHALL be optional for signup and player competition. New casual games SHALL also require a username/password account. Legacy guests SHALL retain only their existing seats and records. Public launch gates and the separate owner administration checks SHALL remain enforced.

#### Scenario: Guest requests ranked play

- **WHEN** a guest chooses a ranked queue
- **THEN** the service offers account sign-in and does not admit the guest to ranked matchmaking

#### Scenario: Session is revoked or an account is restricted

- **WHEN** the account next requests ranked admission
- **THEN** the service checks current authorization and rejects access without relying on a stale public read model

#### Scenario: Recovery email cannot be delivered

- **WHEN** the mail service is unavailable or its quota is exhausted
- **THEN** the service reports a retryable email problem without exposing account existence or disabling verification, while ordinary password signin remains available

#### Scenario: Player creates an account

- **WHEN** a player submits a valid unique username, password, security challenge and an optional private recovery email
- **THEN** the maintained auth provider stores the credential securely, the interface shows the signed-in username, and the account gains no guest rating or marketing subscription

#### Scenario: Player skips recovery email

- **WHEN** signup omits recovery email or supplies a blank value
- **THEN** it creates a credential-backed account that can sign in and meet competitive eligibility without email, while explaining that email password recovery is unavailable

#### Scenario: Internal placeholder is used for recovery

- **WHEN** a request supplies a reserved non-deliverable address or a no-email account requests verification or recovery
- **THEN** supplied reserved addresses cannot become recovery addresses, no placeholder verification or reset work is created, and unauthenticated recovery receipts remain generic

#### Scenario: Username collision or invalid credentials

- **WHEN** usernames differ only by case or a signin supplies an incorrect password
- **THEN** duplicate identity claims fail and signin errors do not disclose private account details

#### Scenario: Password is reset

- **WHEN** a player consumes a valid recovery token and sets a replacement password
- **THEN** the token cannot be reused and previous sessions are revoked without changing the player's identity or game records

### Requirement: Account credential forms

Signup, password reset, and legacy explicit-account completion SHALL accept passwords of 8 to 128 characters and reject other lengths. Existing-password verification SHALL accept nonempty passwords up to 128 characters without the creation minimum. Each account form SHALL have one submit action and no navigation to its current view.

#### Scenario: Player sets an eight-character password

- **WHEN** signup, reset, or legacy explicit-account completion receives a valid eight-character password
- **THEN** browser and server validation accept its length, while seven-character and 129-character values are rejected

#### Scenario: Player switches account views

- **WHEN** the signin or signup form is shown
- **THEN** it has one submit button for its current action and navigation to the other account view, without a duplicate current-action button

### Requirement: Account privacy and security-only email

Password hashes, private recovery email, internal placeholder addresses, session and recovery secrets SHALL stay out of public profiles and logs. Private account state SHALL expose only whether a recovery email exists, without revealing the address. Signup SHALL create no marketing subscription. Email SHALL serve only account security and recovery.

#### Scenario: Account appears in public competition

- **WHEN** a player profile or ranking is published
- **THEN** it contains the public player identity and competitive state without credentials, private email or recovery secrets

### Requirement: Small ranked format set

The initial ranked formats SHALL be 5+3 blitz and 10+5 rapid, with separate ratings and global leaderboards. Players SHALL see the format, increment, rated status, and provisional rating before joining. No official FIDE or other service rating SHALL be implied.

#### Scenario: Player changes format

- **WHEN** a player moves from blitz to rapid
- **THEN** the service uses that format's rating and queue rather than combining the two ratings

### Requirement: Honest global matchmaking

Matchmaking SHALL pair distinct eligible human accounts in the same format, prefer compatible rating and connection regions, and widen the search within a published policy. It SHALL permit only one ranked reservation, live game, or unsettled ranked result per account across all formats. Empty queues SHALL show a waiting state and a cancel action.

#### Scenario: Concurrent queue requests

- **WHEN** the same account requests both ranked queues from different tabs
- **THEN** only one active reservation is granted

#### Scenario: No suitable opponent exists

- **WHEN** the queue cannot find an eligible opponent
- **THEN** the player remains in a truthful waiting state or cancels without facing an undisclosed bot or fabricated player

#### Scenario: Prior result has not settled

- **WHEN** an account requests another ranked game while its previous result is pending
- **THEN** admission waits for that settlement and the player sees its status instead of entering with a stale rating

#### Scenario: Match creation is interrupted

- **WHEN** a pairing is retried after a partial failure
- **THEN** it creates at most one match, preserves assigned seats, and eventually releases unused reservations

#### Scenario: Eligibility changes while waiting

- **WHEN** a queued or reserved account becomes restricted before its game starts
- **THEN** pairing and start checks reject ranked participation and release the unused reservation

### Requirement: Exactly once ranked settlement

A completed eligible ranked game SHALL update both players' ratings as one accepted settlement. Retries, duplicate results, and concurrent completions SHALL NOT apply partial or repeated changes. Clients SHALL receive a pending state until the authoritative settlement is recorded.

#### Scenario: Duplicate result delivery

- **WHEN** the same completed game's result is delivered more than once
- **THEN** only its original accepted settlement affects ratings and completed-game counts

#### Scenario: Conflicting result delivery

- **WHEN** a result with the same identity but a different outcome is submitted
- **THEN** the service rejects the conflict and records it for investigation without overwriting the accepted result

#### Scenario: Result storage is temporarily unavailable

- **WHEN** a completed game's rating settlement cannot finish
- **THEN** the game result remains recorded, rating changes stay pending, and retry resumes without requiring either player to remain connected

### Requirement: Versioned rating policy

The product SHALL publish its Glicko-2 online adaptation, initial state, provisional status, rating-period and inactivity policy, and version. Updates SHALL retain rating, deviation, volatility, inactivity state, and enough history to reproduce both players' pre-game and post-game ratings. Inactivity SHALL affect uncertainty and ranking eligibility without an unexplained loss of skill points.

#### Scenario: Rating update is reproduced

- **WHEN** an operator replays an accepted result using its recorded policy and prior states
- **THEN** the same authoritative rating values are produced, subject only to the published display rounding

### Requirement: Established global leaderboard entries

Leaderboards SHALL rank eligible established accounts by the selected format's rating and show provisional, inactive, restricted, and pending states honestly. Eligibility SHALL include published requirements for account age, completed games, distinct opponents, uncertainty, recent activity, and fair play standing. Empty rankings SHALL contain no invented entries.

#### Scenario: New account has a high provisional rating

- **WHEN** an account has not met the established-player requirements
- **THEN** its rating is marked provisional and it does not displace established players in the global ranking

#### Scenario: Leaderboard projection is delayed

- **WHEN** rating changes have not yet reached the public leaderboard
- **THEN** the page shows its update time and the participant sees the settlement state without an unsupported promise of immediate global consistency

#### Scenario: Ratings are tied

- **WHEN** two eligible players have the same rating at published display precision
- **THEN** the documented ranking and stable pagination policy handles the tie without duplicate or missing entries

### Requirement: Ranked farming controls

Only eligible matchmade games SHALL affect competitive ratings. The service SHALL enforce a published repeated-opponent policy and detect suspicious reciprocal wins, early resignations, account clusters, and rating transfers for review. Invitations, self-play, and cancelled unstarted games SHALL NOT grant competitive credit.

#### Scenario: Repeated-opponent limit is reached

- **WHEN** a pair reaches the published ranked limit for the rolling window
- **THEN** matchmaking does not offer another rated game between them in that window and casual play remains available

#### Scenario: Accepted ranked results form a play cluster

- **WHEN** scored accepted ranked human results connect all three pairs of three distinct accounts within one 24-hour span
- **THEN** every participating retained game receives an informational account-cluster pattern without a common-ownership finding or automatic penalty

#### Scenario: Wins concentrate through early resignations

- **WHEN** an account receives at least three scored wins from at least two opponents within one 24-hour span, including two resignations before ten plies
- **THEN** the participating wins receive an informational rating-transfer-candidate pattern without claiming calculated rating points or applying a penalty

#### Scenario: Results arrive late or while ratings need repair

- **WHEN** a final ranked human result is accepted out of order or deferred for rating repair
- **THEN** bounded checks still cover the result and update positive patterns on related retained games, while duplicate delivery adds no work or duplicate check

#### Scenario: Informational check work reaches its bound

- **WHEN** a neighborhood exceeds the supported retained-game bound or legacy checks still need an upgrade
- **THEN** settlement remains accepted, private operations show incomplete or pending coverage, and bounded maintenance resumes the versioned check work

### Requirement: Auditable rating corrections

Confirmed fair play corrections SHALL retain the original game record, identify the decision and affected results, and publish a reproducible corrected rating history. Retried corrections SHALL NOT apply twice. The product SHALL NOT repair nonlinear ratings by blindly subtracting historical point changes.

#### Scenario: A rated game is voided after later games

- **WHEN** a reviewed decision removes a result that influenced later ratings
- **THEN** the correction uses the documented replay policy and publishes one consistent corrected leaderboard generation with an auditable decision reference

#### Scenario: A game completes during rating repair

- **WHEN** a game completes while a correction is replaying earlier results
- **THEN** its result remains recorded and settles once in the documented order after repair, without mixing account ratings, eligibility, or public ranks from different correction generations

### Requirement: Scheduled automatic tournaments

The service SHALL create opt-in bounded round-robin events at published UTC cadences and run registration closure, eligibility checks, pairing, game creation, results, no-show handling, standings, expiry, and cancellation without a human operator. Competition SHALL own lifecycle and shared account reservations. Three or four eligible human username/password entrants SHALL play three rounds with published wall deadlines. Events SHALL remain unrated with separate points and honest shared ranks.

#### Scenario: Cadence starts without an operator

- **WHEN** an enabled event reaches its start with enough eligible available entrants
- **THEN** it starts once and durable pairing retries preserve game identities and account reservations

#### Scenario: Too few players or a scheduling outage

- **WHEN** fewer than three eligible available entrants remain or scheduling resumes after missed periods
- **THEN** the event cancels truthfully and the scheduler creates only bounded current/next work without invented entrants or unbounded catch-up

#### Scenario: Account is already occupied

- **WHEN** a registered account has an incompatible reservation
- **THEN** it is not double-booked, and its event status explains it was skipped under the published policy

#### Scenario: No-show or round deadline

- **WHEN** readiness expires or the published round wall deadline is reached
- **THEN** the event applies its separate no-show or technical-void points policy and advances without fabricated chess outcomes or rating credit

#### Scenario: Duplicate completion after restart

- **WHEN** a result is retried after a restart
- **THEN** the event counts it once, resumes its durable round, and publishes stable standings with shared ranks for tied points

### Requirement: Large-entry automatic events

The release design SHALL support hundreds and thousands of entrants with an
admission limit selected from measured qualification. The four-player preview
SHALL NOT satisfy this claim. Registration, pairing, cross-mode reservations,
scores, public reads and recovery SHALL remain bounded. The first tier SHALL
target 2,000 entrants, 1,000 live games and 20 results/second within storage and
the $100 monthly budget; the later 10,000-entry/5,000-live tier SHALL need separate
qualification.

#### Scenario: Capacity tier is selected

- **WHEN** operators select a public admission ceiling
- **THEN** it stays within measured signup, concurrency, settlement, retention, recovery, region and cost evidence, and a smaller tier never proves the later tier

### Requirement: Initial ranked and large-arena release qualification

Public opening SHALL require real ranked proof/settlement/recovery qualification,
the complete approved first-tier provider workload, protected-host player flows,
and verified privacy, spending, signup and accepted-work controls. Optional
server analysis SHALL stay disabled.

#### Scenario: Financial adoption precedes release evidence

- **WHEN** the owner adopts the reviewed financial policy
- **THEN** it SHALL use the simplified operating budget with one $100 target
- **AND** source integrity and provider-resource evidence SHALL remain required
- **AND** financial adoption SHALL pass no workload or release check

#### Scenario: Initial public release is selected

- **WHEN** the initial ranked and large-arena release gates pass
- **THEN** public access may open with ceilings no higher than passing first-tier evidence, existing production guards and monthly headroom
- **AND** the nine-day calendar observation, full-hour retention/endurance and 25-per-second retirement run, six-region external WAN benchmarks and later tier remain explicit unfinished follow-up qualification without blocking that release or being reported as passed

#### Scenario: The first-tier run has one real client egress

- **WHEN** the frozen approved run uses one named real client egress
- **THEN** its measurements identify that egress and all unrun regions, and make no worldwide latency or sustained monthly throughput claim

### Requirement: Timed arena lifecycle

Large events SHALL use versioned timed arenas alongside small round robins.
Eligible credential-backed entrants SHALL explicitly queue, pause and resume between unrated games. Recovery email SHALL be optional.
Pairing SHALL close after 60 minutes in blitz or 120 minutes in rapid. Accepted
games SHALL drain under published wall deadlines before finalization.

#### Scenario: Pairing closes while games remain

- **WHEN** an arena reaches its pairing cutoff with unresolved accepted game intents
- **THEN** it creates no new games, displays draining and provisional standings, and finalizes only after durable results or published technical voids resolve those intents

### Requirement: Arena points and repeat opponents

Arena wins SHALL score 1, draws 0.5, and losses, no-shows and technical voids 0.
Ties SHALL share ranks. There SHALL be no bye, streak or berserk credit. An
unordered pair SHALL meet at most twice per event with another opponent between
meetings. No-shows SHALL pause until explicit resume.

#### Scenario: No valid opponent is available

- **WHEN** the bounded candidate window has no allowed opponent
- **THEN** the entrant remains waiting without a point or a relaxed repeat-opponent rule

### Requirement: Atomic arena scoring

Competition SHALL own arena reservations and idempotent score receipts in
indexed bounded state. The accepted terminal result, its score receipt and the
two entrant totals SHALL commit in the same transaction.

#### Scenario: An arena result is delivered twice

- **WHEN** matching terminal results repeat after restart
- **THEN** the score changes once, conflicting results become incidents, and a delayed control message cannot release an unresolved live-game reservation

### Requirement: Arena public and private reads

Public standings SHALL use complete cached paged generations without private
caller state or session lookups. Pages SHALL carry bounded rows, generation,
watermark and age. Private queue status SHALL require primary session validation
and no-store responses.

#### Scenario: Public standings are refreshed

- **WHEN** an unauthenticated viewer fetches a standings page
- **THEN** the response belongs to a complete generation with bounded rows, watermark and age, performs no caller-session lookup, and exposes no registration or current-game state

#### Scenario: Many players register together

- **WHEN** registration requests arrive in a burst near an event start
- **THEN** accepted entrants receive stable registration state, duplicate requests do not duplicate entrants, and excess work receives an honest retry or waiting state without losing accepted entries

#### Scenario: Many games finish after a recovery

- **WHEN** delayed results and retries arrive across concurrent event games
- **THEN** each accepted result contributes once, account reservations remain consistent, and paged standings recover without loading or rewriting the full event for each client request

#### Scenario: Public capacity is announced

- **WHEN** an event's supported entrant or concurrent-game capacity is published
- **THEN** the claim identifies the measured admission envelope and recovery/cost limits rather than treating a configured maximum or local test as production evidence

### Requirement: Once-only isolated native capacity qualification

The private harness SHALL preserve failed run evidence and permit only the
confirmed fixture repair after exact candidate review. All attempts SHALL share
a $25 ceiling and at most 20,000 permanently charged Game IDs. Normal atomic
receipts and native Game/Competition authority SHALL apply. Production SHALL
reject the private budget exception and retain its ceilings.

#### Scenario: A run is retried or restarted

- **WHEN** restart, retry, month change, token replacement or deployment occurs
- **THEN** the run is not renewed, uncertain reservations are not refunded and unresolved work permits remain charged
- **AND** all attempts share the same $25 isolated test ceiling inside the current single $100 target; savings grant no additional work

#### Scenario: The stopped preparation failures are corrected

- **WHEN** root reviews the fresh candidate under the owner's finish-and-launch instruction
- **THEN** the initial two failed identities remain consumed and permanently stopped, and the third failed arm remains unchanged with its original trace, empty-resource diagnostic and arm-delivery uncertainty; held permits, unresolved dispatches and measured or uncertain work remain retained without a native-shutdown claim
- **AND** failed fourth run `e8932527-765c-4613-b453-b09a6d6842de` in `capacity-provider-20261022-warm-v1` retains its historical empty `firsttier03` reuse, successful arm, incomplete trace with 297 successful preparation responses and 11 uncertain requests, and owner stop with zero charged Game IDs, two active objects, one unresolved dispatch and no native-shutdown receipt
- **AND** fifth run `f92e8db1-9991-4432-8c30-487eedaf6d17` retains all 6,000 prepared primary accounts, 256 uncertain registration replies, zero acknowledged registration replies, its stop, zero charged Game IDs, two held permits and one unresolved dispatch; no passing full candidate is recorded
- **AND** sixth diagnostic `56089a5b-0826-45e2-85ed-8a7bae106eb0` retains 256 prepared accounts, 238 registration offers, 56 expected retries, 182 uncertain HTTP 503 replies, zero acknowledged registrations and the accepted controller-call-allowance stop; native reads show zero Games, admissions and Game receipts, but two permits and one dispatch remain held without native closure, for ten held permits and five unresolved dispatches across six attempts
- **AND** a corrected diagnostic addresses the finite ingress grant envelope, carries the saved signed Competition ticket from arm and recovers only saved workflow state for stop, without changing production ceilings, required workload or the shared allowance
- **AND** one reviewed, sealed registration-only diagnostic may use 256 primary accounts and exactly 768 normal registration attempts at 3 ms intervals, at most 256 inflight requests, five-second response deadlines and a 90-second hard window; it SHALL reject Games, queues, sockets, proofs, spectator/cache-load and fault work before dispatch and reserve no Game workflow
- **AND** the diagnostic SHALL preserve authentication, finite native/controller envelopes, original failures and the shared ledger, require an exact native zero-Game stop with drained work and deleted alarms, and establish no first-tier capacity or launch pass
- **AND** exact native prearm status remains readiness evidence only, and account preparation may wait at most 15 seconds for a response, clipped to the unchanged credential-seal deadline
- **AND** game/control response deadlines, fixed slots, the full 19,000-game workload, 900-second stream, fixed recovery lead and every runtime ceiling remain required
- **AND** fresh resource readbacks, exact frozen bytes, feasible UTC times and root's final review remain required before load, with no claim of owner hash inspection

#### Scenario: Fixture reads have platform retries

- **WHEN** a bounded private fixture operation has a 640-read single-attempt limit and the platform may make up to three total read attempts while returning metadata for the final attempt only
- **THEN** the operation SHALL reserve up to 1,280 extra read units before dispatch and preserve conservative retry charges separately from observed final-attempt metadata
- **AND** those units SHALL remain inside the unchanged 100-million-read run ceiling and combined $25 test ceiling, with no write retry, new fixture identity, uncertainty refund or financial reapproval

#### Scenario: Capacity resources are prepared

- **WHEN** the approved isolated harness is built
- **THEN** it has reviewed isolated synthetic resources with current state readbacks, fixed expiry, private authentication, a once-only arm per run identity, native work/storage/request metering and at most 2,048 non-hibernatable objects over 60 minutes, with no production, mail, engine, analysis or Container binding
- **AND** a frozen exact candidate and shared complete test ledger require root review under the owner's finish-and-launch instruction before load
- **AND** a common account-cycle ledger counts each started billing unit once with no assumed shared allowance; changed cycles, quantities or tariffs require reconciliation, and missing costs remain explicit unknowns under the reviewed policy

#### Scenario: The sustained and delayed workload is measured

- **GIVEN** focused local native checks have established uncertainty fencing, held permits, accounting and drained shutdown for the exact source, without requiring a separate full local performance pass

- **WHEN** the first-tier provider run is accepted
- **THEN** 18,000 distinct native regular results span 900 elapsed seconds, with 400 of 1,000 additional distinct delayed results recovered during a fixed ten-second lead at 40 per second and the remaining 600 during the stream's first 30 seconds at 20 per second alongside 20 regular results per second
- **AND** all 1,000 delayed results recover within 60 seconds from recovery start with five matching duplicates each, unchanged normal authority, account and score checks, the unchanged 1,000 unfinished-game cap, and missed or late slots recorded as failures
- **AND** real registration, sockets, reconnects, public cached standings, declared faults and named regional paths are reported without fabricated clocks, terminal rows or unsupported regional claims

#### Scenario: A run reaches a safety boundary

- **WHEN** expiry, a finite work ceiling, uncertain control state, missing metrics or complete-cost headroom blocks further work
- **THEN** new synthetic admission stops permanently, accepted receipts reconcile only under their original IDs, unresolved work remains charged, and the failed or unrun target remains visible
- **AND** this run does not complete the separate full retention, calendar, regional, ranked or later-tier measurements; initial public opening still requires its own ranked and operational release gates
