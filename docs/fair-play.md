# Fair play operations

## Current status

Ordinary operation is unattended. Private reports are informational, with no
engine screening. They cannot convict a player, restrict an account, or remove
ratings. Report receipts state whether review is available. The default receipt
says that human review is unavailable and no action follows from the report.

Server authority rejects illegal commands and forged clocks or results.
Turnstile, session checks, request limits, queue admission, and tournament
reservations add friction to automated abuse. They cannot prove that a player
used no outside help. Unsupervised engine assistance cannot be reliably
eliminated by this product.

## Player rules

Players must choose their own moves without an engine, another person, opening
books, or outside analysis during a live human game. They must not share
accounts, arrange results, farm ratings, or evade a restriction. Use the private
game report flow. Do not publish accusations.

Reports require a completed human game the reporter played, 10 to 1,000
characters of details, and a report challenge. A player may submit five new
reports per day. Repeating the same report returns its existing private
receipt. AI practice cannot be reported as engine use or attached as human
enforcement evidence. Its AI label does not permit assistance in human games.

## Unreviewed report expiry

In unattended mode, an open report case becomes eligible for automatic closure
seven days after creation. The daily private-data cleanup closes at most 500
eligible cases, oldest first, through the indexed age query. Delayed or stopped
maintenance can postpone closure. A human decision, an unresolved appeal or an
explicit future evidence hold prevents this closure. Exact reviewed operation
does not run ordinary report expiry.

The receipt then shows `expired-unreviewed` and its automatic closure time.
Closure means no human review occurred. It is neither clearance nor a cheating
finding. It changes no rating, restriction, result or account access and records
no human decision. The case version advances once and automatic outcome/time
remain separate from human review history.

A repeated report returns the same private receipt and closure, including after
its ordinary evidence expires. It does not reopen the case, refresh retention
or recreate deleted evidence.

Closure and deletion are separate. Existing evidence keeps its ordinary 90-day
expiry and any valid hold. Receipts and permitted case/audit metadata remain;
permanent storage still grows; platform storage bounds and the budget stop apply.

## Optional human review

Only exact `OPERATION_MODE=reviewed` enables new case and appeal decisions.
Other values, including a missing setting, keep those actions disabled.
Switching the setting does not establish staffing, response time, detection
accuracy, or launch readiness. Routine play and deadlines never wait for it.

Review access requires a verified non-guest account in `OWNER_EMAILS` and a
valid Cloudflare Access JWT that matches the account email, issuer, audience,
signature, and expiry. A local request or development header grants no bypass.

A concern is not proof. A reviewed restriction needs retained evidence from
at least two games, a server record, and a written explanation of corroborating
facts. Never sanction on accuracy, a shared IP address, window focus, or report
count alone. Do not collect focus signals or invasive device fingerprints.
Reporter identities, report text, and reviewer notes stay private. A player receives the decision reason and expiry.

The database records case versions, evidence references, reviewer identity,
decision reasons, corroboration, notices, and an audit trail. Restrictions last
from one hour to seven days and expire through the normal eligibility policy.
They are not permanent bans. Repeating an accepted decision ID returns the
same result, including after changing back to unattended mode. It cannot create
another sanction.

## Appeals and expiry

The affected account may submit one appeal against an eligible restriction
within its 14-day decision window. Appeals accept 10 to 2,000 characters, with
at most five new requests per account per day. Player controls are at
`/history/#fair-play`. The API reports review availability; submission does not
promise a response.

A pending appeal becomes eligible for automatic closure 14 days after it was
submitted. Bounded cleanup or the player status route records
`expired-unreviewed` in separate automatic metadata. It creates no human
decision, does not uphold or overturn the old finding, and does not silently
reverse historical rating changes. Cleanup may run after the eligibility time
when a job is delayed. Evidence is no longer held solely by a closed appeal.

In reviewed mode, an authorized reviewer can decide an appeal before it closes.
An overturn revokes the related restriction and preserves the audit trail.
The correction outbox replays the affected rating pool into a separate
generation, publishes the completed projection, and drains results recorded
during repair. Immutable results, rating events, checkpoints, and decision
history are not deleted by expiry or casual payload retirement. The restore
drill is follow-up only; review and appeal acceptance checks apply only if
reviewed mode is enabled.

## Evidence retention and limits

Ordinary evidence expires after 90 days. Eligible cleanup removes it after any
explicit hold and unresolved appeal end. Eligible report details are cleared
after 90 days. Private reviewer notes, corroboration and appeal text are
eligible for minimization 90 days after the final case action, once appeal
windows, pending appeals and explicit evidence holds end. Cleanup visits at
most 500 records of each kind per pass. Decisions, public decision reasons,
minimal case/report metadata, immutable request hashes and audit identities
remain. This does not erase all private data after 90 days. See the approved
[privacy and account policy](privacy.md) for automated account requests,
retained history and restore rules. Provider acceptance remains a launch gate.

There are at most 20 evidence records per case and 1,000 open or appeal cases.
At the case limit, new reports pause with `REPORT_CAPACITY`. Automatic expiry
frees eligible open slots through bounded maintenance; it does not raise the
cap or promise review. Do not reset the cap or erase accepted history to
hide growth. Raw report details and evidence have bounded retention, while
permanent metadata still grows.

Proved terminal Game payload retirement skips retained evidence and unresolved
appeal holds. A short retirement lease blocks concurrent new evidence. Reports
recorded after retirement may retain the private D1 replay without recreating
the retired Game payload. See [operations](operations.md) for retry, retirement,
permanent storage ceilings, and the limits of automatic recovery.

## Limits of detection

There is no engine screening, assistance classifier, measured false-positive
rate, measured false-negative rate, cheating probability, or enforcement
threshold. Server-side Stockfish analysis was deleted on 2026-10-31. Nothing here
can justify automated accusations, restrictions, rating changes, or a
reviewed-player badge.

Unattended operation keeps reports informational. If reviewed operation is
proposed, first define the staffed case capacity, response window,
corroboration standard and appeal coverage; unattended operation supplies no
review-capacity plan.

## Competitive evidence still needed

Ranked opens with `RANKED_ENABLED=true` (owner decision, 2026-10-31). The
launch path in [live-ready prep](live-ready-prep.md) covers live mail, cron and
player flows. The rest is evidence to gather after opening.

- Tested objective abuse controls, private report access, expiry, and recovery.
- An accepted timeout policy, including the blocked-position limit of the material timeout rule.
  Every mode, ranked included, uses that rule at the flag: a loss for the player who ran out
  when the opponent has mating material, otherwise a draw. Technical voids remain for unfinished
  tournament/arena wall-clock cases; they are not the ordinary timeout outcome.
- Verified production retention and recovery under the published
  [privacy policy](privacy.md), including saved later-closure reapplication.
  Password-confirmed export and closure replace a staffed account-request
  promise; their bounded isolated drill is not production acceptance.
- Measured queue, CPU, memory, storage, latency, and cost under real load, after opening.
- Live email, Turnstile, hostname, and deployed schedule checks.
- If reviewed mode is enabled, staffed review, corroboration, notices, appeals,
  correction/reversal, and recovery acceptance checks.

## Objective request and protocol limits

Authenticated HTTP requests share account limits across sessions and browser
tabs. Guests have account IDs too. Auth routes keep Better Auth's own limits;
the public configuration route stays available without a session. Public arena
schedule, summary, and standings reads also skip session lookup and account
budgets. Their complete published snapshots may be cached for ten seconds.

| Scope | Limit | Window |
| --- | --- | --- |
| Authenticated API reads | 120 requests | 60 seconds |
| Authenticated API writes | 30 requests | 60 seconds |
| Legacy account completion | 3 credential operations, in addition to the normal write window and Turnstile | 60 seconds |
| Game socket connection requests | 12 requests per account | 60 seconds |
| Accepted Game socket connections | 10 connections per account and game | 60 seconds |
| Game commands and socket frames | 30 per account and game | 10 seconds |

Each window starts with its first request. HTTP limits run before route-specific
validation, so malformed writes and unknown game IDs still consume the relevant
budget. Socket connection requests use their own account bucket. Ordinary API
reads do not consume it. A limited HTTP request returns `429` and `Retry-After`
with the remaining whole seconds rounded up. It creates no account restriction.

The Game authority stores its connection and command windows in SQLite. A new
socket, replaced connection, or hibernated object cannot reset them. Each Game
stores at most four seat buckets. Both malformed commands and valid command
retries consume the command budget. A frame flood closes the socket with code
`1008`; a binary frame or text frame above 2,048 UTF-8 bytes closes it with
`1009`. A private command call over the internal binding observes the same
budget. There is no public HTTP move-command endpoint.

Limits use account and assigned seat IDs. A shared IP address or network does
not merge accounts or create a farming flag. No focus or device fingerprint
signal is collected. Account rotation can still evade account limits; challenge,
identity, seat, storage, and monthly work limits bound separate parts of that
risk. These controls do not detect engine assistance.

The private `GET /api/admin/operations` response includes account request policy
and daily counts of exhausted account windows. These are counts of windows,
not all rejected requests. `GET /api/admin/games/:id/security` returns that
known game's protocol policy, exhausted windows, and invalid frame count.
Both routes require the same owner session and Access JWT as private review.
Counters have a fixed set of keys and saturate at one billion. The account and
Game security counter objects contain no account IDs, email addresses, IP
addresses, or session tokens. Other private Operations fields include the
operator identity and reason recorded when budget stops change.
Proved payload retirement clears temporary Game protocol buckets and counters.

## Informational rating-farming checks

Every newly accepted finished rated human result receives one durable check
under `informational-2026-10-v3`, including results waiting for rating repair.
Pending adjudications wait for a final result. Casual and computer games do
not enter these checks. A duplicate terminal delivery reuses the existing
check. Results that make both seats the same account are rejected.

The check records the accepted game ID, result event and terminal digest,
policy, normalized account pair, score and winner if any, result reason,
ply count, end time, check time, coverage, and these factual patterns:

- `repeated-pair`: another accepted result for the same unordered pair ended
  within 24 hours, across both rated formats and either color assignment.
- `reciprocal-wins`: this game and another result in that window show a win
  for each account.
- `early-resignation`: a scored resignation or timeout win occurred before ten plies.
- `account-cluster`: scored ranked human results connect all three unordered
  pairs of three distinct accounts within a single 24-hour span. Every game
  that participates in such a triangle receives the pattern. Draws can connect
  accounts; technical voids cannot. This describes a play cluster and makes no
  claim that the accounts share an owner.
- `rating-transfer-candidate`: one account wins at least three ranked games
  from at least two distinct opponents in a single 24-hour span, including at
  least two scored resignations or timeout wins before ten plies. The participating wins
  receive the pattern. This describes concentrated score flow, not a calculated
  transfer of Glicko rating points or proof of arranged play.

The comparison uses result end times in both directions. When a delayed result
arrives, both it and its matching earlier records receive the relevant pattern.
All windows include their exact 24-hour boundary. Flags use positive motifs
and a fixed pattern order, so duplicate and delayed deliveries do not change
which games qualify. Draws and voids have no invented winner. One early
resignation or timeout win is a recorded fact, not proof of arranged play. The queue still
permits at most two started games for an unordered pair in a rolling 24 hours.

`authority.farming` in the private operations response includes the policy,
checked and flagged totals, pattern counts, coverage, lookup limits, and at
most 20 recent flagged game references. Account IDs and raw check records stay
inside the Competition authority. A fixed guard of 1,000 retained check rows
bounds checks. A normal check visits at most 4,000 candidate rows
through indexed pair, account, and winner windows, and updates at most 1,000
distinct check records. Each lookup returns at most 1,001 rows. Its extra row
detects an unexpected breach of the retained bound, after which motif work
stops and only the basic durable record and incomplete coverage remain.
Sentinel reads and empty index seeks count toward actual SQLite reads in
addition to candidate rows. The dense local 1,000-game fixture measured 4,000
candidate rows and 4,002 SQLite reads. This is local query-work evidence, not a
public throughput or latency claim.

Older v1 records upgrade from their accepted result journal through a
versioned keyset cursor, at most eight per maintenance alarm. The cursor
survives restart. Indexed pending probes keep scheduling work small; the
private full status still scans the capped retained checks for aggregates.
Coverage reports pending upgrades and incomplete checks separately. A missing
accepted source or a lookup/update guard leaves an explicit reason. Neither
condition denies game settlement or invents a farming result. Coverage is
complete only when neither pending nor incomplete records remain.

These records remain with the authority; ordinary evidence cleanup does not
erase them. Production retention and backup expiry remain launch gates.

Farming facts do not change ratings, outcomes, eligibility, restrictions, or
queue priority. They provide no calibrated score or automatic sanction. The
current rules can miss larger coordinated rings, selective engine help,
slower transfers, and play outside the defined motifs. Shared networks, focus,
device fingerprints, and account identity guesses do not enter these rules.
