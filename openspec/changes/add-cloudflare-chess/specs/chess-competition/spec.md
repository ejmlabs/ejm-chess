# Spec Delta

## Purpose

Provide accountable ranked matchmaking and worldwide chess leaderboards whose ratings remain correct through retries, concurrent games, and fair play corrections.

## ADDED Requirements

### Requirement: Simplified operating budget

The service SHALL use the owner's one $100 monthly spending target (2026-10-22). Under the 2026-10-31 launch policy, Cloudflare budget alerts and the existing $85 stop webhook SHALL be the economic limit, with no arbitrary product admission or retention caps. Security and abuse limits, protocol and input bounds, bounded per-request and per-alarm work, platform-safety bounds and ranked correctness SHALL remain. Alerts and the stop SHALL NOT be described as a guaranteed invoice cap.

#### Scenario: Earlier allocations are history

- **WHEN** a dated per-service allocation, reserve, cost calculation or repeated financial-review gate is read
- **THEN** it is a historical estimate and imposes no current requirement

#### Scenario: Application caps are off

- **WHEN** the owner enables protected-host use
- **THEN** monthly and lifetime signup, game and email application caps SHALL be off
- **AND** account/game and email stops SHALL be cleared while abuse controls, authentication, protocol and input bounds, platform-safety bounds and accepted-work recovery remain enforced
- **AND** public Access removal SHALL follow the launch sequence


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

The release design SHALL support hundreds and thousands of entrants without an arbitrary product entrant or concurrent-game cap. The four-player preview SHALL NOT satisfy this. Registration, pairing, cross-mode reservations, scores, public reads and recovery SHALL stay bounded per request and per alarm. The 2,000-entrant/1,000-live-game first tier and the later 10,000-entry/5,000-live tier SHALL be reference targets only, neither caps nor launch gates.

#### Scenario: Capacity is published

- **WHEN** operators publish a capacity figure
- **THEN** it states the measured signup, concurrency, settlement, retention, recovery, region and cost evidence, a smaller tier never proves the later tier, and the lack of a measurement does not by itself close admission

### Requirement: Initial ranked and large-arena release qualification

Public opening of ranked play and arenas SHALL require retirement of the
timeout-proof path so ranked uses the material timeout rule, protected-host
player checks that include ranked and arena play, and live readbacks of mail
delivery, budget alerts, cron and the stop webhook. Access removal and public
verification SHALL follow. No provider load run or restore-and-replay provider
drill SHALL gate opening; the capacity harness was deleted on 2026-10-31.

#### Scenario: Financial adoption precedes release evidence

- **WHEN** the owner adopts the reviewed financial policy
- **THEN** it SHALL use the simplified operating budget with one $100 target
- **AND** source integrity SHALL remain required
- **AND** financial adoption SHALL pass no workload or release check

#### Scenario: Initial public release is selected

- **WHEN** the protected-host player checks and the live mail, alert, cron and stop readbacks pass
- **THEN** Access may be removed and public ranked play and arenas open with no product admission caps, and public verification follows
- **AND** the first-tier provider run, nine-day calendar observation, full-hour retention/endurance and 25-per-second retirement run, six-region external WAN benchmarks and later tier are not planned, block nothing and SHALL NOT be reported as passed

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
- **THEN** the claim identifies the measured envelope and recovery/cost limits rather than treating a configured maximum or local test as production evidence
