# Spec Delta

## Purpose

Protect competitive chess with preventive controls, reproducible evidence, accountable review, and appeals while stating the limits of engine-cheating detection.

## ADDED Requirements

### Requirement: AI mode remains separate from human fair play

The optional computer opponent mode SHALL NOT weaken the ban on outside assistance in human games. Computer-opponent results SHALL be excluded from engine-use screening and player farming findings. The privacy guidance SHALL explain browser Stockfish execution, same-host asset delivery, private server game records, and the absence of external model inference. A selected browser engine label SHALL NOT be treated as audited execution provenance.

#### Scenario: AI game completes

- **WHEN** a game against a disclosed AI opponent finishes
- **THEN** the game is retained as an unrated AI game without creating an engine-use case against the model or the human player

### Requirement: Layered preventive controls

The service SHALL enforce participant authorization, legal moves, deadlines, ranked eligibility, and bounded request rates. Signup, matchmaking, and reporting abuse controls SHALL be enforced on the server. Bot challenges SHALL NOT be presented as proof that a player is unassisted.

#### Scenario: Challenge response is replayed

- **WHEN** an abuse-sensitive request supplies an invalid, expired, or reused challenge token
- **THEN** the service rejects the protected action without interrupting an unrelated ongoing game

#### Scenario: A player floods a game connection

- **WHEN** a participant exceeds the published message limits or sends oversized messages
- **THEN** the service rejects excess input, bounds resource use, and preserves the recorded game and opponent's access

### Requirement: Server recorded fair play evidence

Fair play evidence SHALL come from recorded server moves, timing, results, and account history. Client engine evaluations SHALL NOT be trusted. Evidence SHALL identify its game version, analysis version, and source records so a reviewer can reproduce the relevant findings.

#### Scenario: Client submits a claimed engine score

- **WHEN** a client submits a score or accuracy claim for an opponent
- **THEN** it cannot alter the trusted analysis record or directly change ranked standing

### Requirement: Bounded postgame engine screening

Engine screening SHALL run after games and remain separate from live move handling. Screening SHALL prioritize reports, suspicious patterns, and leaderboard candidates, and include random sampling. Its findings SHALL consider meaningful decisions and multiple games, rather than engine agreement alone.

#### Scenario: A short forced game has high accuracy

- **WHEN** a game contains mostly forced or obvious moves
- **THEN** a high agreement score alone does not establish engine assistance or trigger a sanction

#### Scenario: Analysis is backlogged

- **WHEN** the analysis service reaches its concurrency or spending limit
- **THEN** work remains pending or enters a visible retry state, live games continue, and the service does not describe unscreened leaderboard candidates as reviewed

### Requirement: Reports and private review

Participants SHALL be able to report a completed game through a bounded reporting flow. Only authorized reviewers SHALL access private evidence. A reviewer SHALL record a decision, reason, evidence references, and any account or ranking action. Reporter identities and internal detection details SHALL NOT be exposed publicly.

#### Scenario: Participant reports suspected assistance

- **WHEN** a participant reports a completed game
- **THEN** the report is recorded once, the participant receives its status, and no automatic penalty follows from the report alone

#### Scenario: Public user requests a case

- **WHEN** an unauthorized user requests private evidence or a review decision endpoint
- **THEN** the service returns no private case or reporter data

### Requirement: Evidence based sanctions

Engine-use sanctions and case-based ranked restrictions SHALL require an authorized human decision with corroborated evidence. Accuracy, one brilliant game, IP address, tab focus, or report count alone SHALL NOT justify either. Restrictions SHALL have a reason, review deadline, and player-visible status. Objective request-abuse throttles SHALL NOT imply engine-use findings.

#### Scenario: Players share a network

- **WHEN** several accounts use the same household, school, club, or public connection
- **THEN** shared network data alone does not close accounts or remove their ratings

#### Scenario: Review is inconclusive

- **WHEN** the reviewer finds insufficient evidence
- **THEN** the service records that outcome without an engine-use sanction and resolves any case-based temporary restriction according to the published policy

#### Scenario: Temporary restriction reaches its deadline

- **WHEN** a case-based restriction expires without a supported reviewer decision to renew it
- **THEN** ranked access is restored and the expiry is recorded in the case history

### Requirement: Appeals and rating repair

Affected account owners SHALL receive a decision notice and an appeal path. Authorized reviewers SHALL record appeal outcomes and corrections. Rating repair SHALL follow the reproducible correction contract and SHALL NOT expose another person's private evidence.

#### Scenario: An appeal reverses a decision

- **WHEN** a reviewer overturns a sanction
- **THEN** the account's restriction and affected ratings are repaired through auditable, idempotent actions and the player receives the updated decision

### Requirement: Fair play privacy and retention

Before collection, the product SHALL publish data purposes, access and bounded
cleanup ages for account, connection, report and analysis records. It SHALL
preserve appeal-held evidence, permanent competition history and minimal audit,
exclude secrets from evidence and private telemetry/analysis from live moves,
and require no cameras, screen recording or invasive fingerprinting.

#### Scenario: Evidence retention expires

- **WHEN** a record reaches its published expiry and is outside its appeal window and any documented timely-appeal hold
- **THEN** the service deletes or minimizes it while retaining only the permitted audit and rating-replay record

#### Scenario: Player has time to appeal

- **WHEN** a player receives a decision notice shortly before ordinary evidence expiry
- **THEN** the decision evidence is held through the published appeal window and any timely appeal so ordinary expiry cannot defeat review

#### Scenario: Private case text reaches its cleanup age

- **WHEN** 90 days have passed since final case action and all appeal windows and holds have ended
- **THEN** bounded maintenance minimizes reviewer notes, corroboration and appeal text while preserving only the permitted competition and minimal audit record

#### Scenario: Account requests use automated controls

- **WHEN** the product publishes its account-request route
- **THEN** password-confirmed controls replace an unverified staffed contact promise, without publishing the private alert recipient or promising a human response

#### Scenario: Native recovery and drill records are retained

- **WHEN** recovery guidance states retention and access rules
- **THEN** it distinguishes verified native provider history from separately approved private exports, treats cleanup ages as eligibility limits, and deletes raw synthetic drill files after acceptance within 30 days while allowing sanitized evidence to remain

#### Scenario: Account closure and recovery overlap

- **WHEN** native history is restored from before an accepted closure
- **THEN** later closure receipts remain outside restore targets and their private-data removal is reapplied before access reopens, without deleting retained rating or correction history

### Requirement: Bounded and recoverable analysis operations

Analysis SHALL have enforced instance, concurrency, job, retry, storage, and spending controls. Failed work SHALL be visible to operators and safe to retry without duplicate cases or sanctions. Private analysis services SHALL NOT be publicly callable as unrestricted engine endpoints.

#### Scenario: Analysis fails after processing

- **WHEN** a job is retried after its result was saved but acknowledgement was lost
- **THEN** the accepted analysis identity is reused without charging another investigation or applying any action twice

### Requirement: Honest fair play launch gate

Public ranked launch SHALL require tested unattended adjudication, objective abuse controls, correction/recovery, and privacy limits. Optional reviewed sanctions SHALL still require human corroboration. Engine screening and reports SHALL be informational when no reviewer is active. The product SHALL state that engine assistance cannot be fully prevented in unsupervised browser chess.

#### Scenario: A readiness gate is unmet

- **WHEN** adjudication, unattended abuse/recovery, privacy, or rating correction is not ready
- **THEN** the product remains a clearly labelled beta with public competitive launch disabled, while verified casual play can remain available

### Requirement: Unattended runtime

Ordinary play and tournaments SHALL not wait indefinitely for human review. Unknown adjudication SHALL become one versioned technical void after 30 seconds. Unattended mode SHALL disclose report review availability and disable new case-based sanctions and appeal decisions. Engine accuracy, IP, focus, report count, or other statistical screening alone SHALL never convict or restrict an account.

#### Scenario: No reviewer is active

- **WHEN** a participant reports suspected engine assistance
- **THEN** the private receipt discloses review unavailability, promises no human action, and triggers no automatic sanction

#### Scenario: Unknown adjudication expires

- **WHEN** no proved result exists after the bounded wait
- **THEN** one technical void preserves the record and normal durable settlement releases reservations without a fabricated winner

### Requirement: Bounded unreviewed report closure

In unattended mode, an open case SHALL close as expired-unreviewed after seven days only without a human decision, unresolved appeal, or future evidence hold. An indexed pass SHALL close at most 500 cases and preserve the 1,000-open-case cap. Closure SHALL record automatic outcome/time and one version change without a human finding. Receipts and normal evidence retention SHALL remain. Duplicate reports and late analysis SHALL NOT reopen the case or extend retention.

#### Scenario: A report receives no review

- **WHEN** an unattended open report reaches seven days without a human decision, unresolved appeal, or future evidence hold
- **THEN** bounded maintenance records one expired-unreviewed closure, preserves receipts and normal evidence retention, and changes no rating or account access

#### Scenario: A closed report is retried

- **WHEN** a participant resubmits an automatically expired report or its optional analysis arrives later
- **THEN** the original receipt and closure remain, no case is reopened, and evidence expiry is not extended

### Requirement: Safe automatic terminal retirement

Settled casual payloads SHALL retire only after one hour and matching projected terminal version, rules version, and digest, with no active work or evidence hold. Batches SHALL contain at most four records per minute. Permanent ID tombstones SHALL prevent reinitialization. Completed PGN and immutable rating/correction records SHALL remain recoverable. Storage exhaustion SHALL close new admission without deleting accepted results or claiming unlimited retention.

#### Scenario: Retirement reply is lost

- **WHEN** a retired Game is retried before its D1 archive marker was saved
- **THEN** its durable tombstone returns the same retirement receipt and maintenance completes without recreating or deleting the game twice

#### Scenario: Active game or evidence hold exists

- **WHEN** a candidate has active delivery, AI work, pending settlement, or an evidence hold
- **THEN** maintenance preserves its payload and retries only after the contract permits retirement
