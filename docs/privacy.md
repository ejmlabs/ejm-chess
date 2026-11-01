# Account privacy and retention

## Availability

Policy `account-2026-10-v1` adds password-confirmed account export and closure.
An isolated provider rehearsal passed password-confirmed export and closure for
one no-email synthetic account, a native D1 rollback and two exact saved-receipt
reapplications.
See the [dated privacy report](qualification/provider-privacy-20261021.md) for
the measured boundary and untested cases.
Recovery email is optional, including for ranked play. The service sends no
marketing email and promises no staffed support inbox.

## Download your data

Sign in at `/account/`, open **Download account data**, choose a category and
confirm your current password. Download each page before choosing the next.
Categories cover your profile and recovery information, reports you submitted,
your appeals and notices, and your game metadata. Game pages link to the
existing participant-only PGN downloads. Download wanted PGNs before closure;
closing your account removes your ability to sign in and use those links.

Each page holds at most 50 records and 256 KiB. Pages are not one transaction
across stores and can reflect different moments. Every page requires password
confirmation. No archive is stored on the server. Keep downloaded files private.
Exports exclude password hashes, session/reset tokens, other reporters'
identities, reviewer notes and private investigation evidence. Internal email
placeholders are returned as `null`.

`POST /api/account/export` accepts same-origin JSON:

```json
{"password":"<current password>","category":"games","cursor":"<optional last record ID>"}
```

Omit `cursor` for the first page. Use the returned `nextCursor` until it is
`null`. Profile has one page and accepts no cursor. Responses use
`Cache-Control: no-store` and attachment disposition. Put no password in a URL.

## Close your account

Finish active games and leave events first. Sign in, open **Close account**,
confirm your password and type `CLOSE`. An unpaired ranked queue entry can be
cancelled during closure. An active seat, pending match or event reservation
blocks closure until it finishes or is released.

Closure commits one native D1 batch. It removes credential/account rows,
sessions and account-owned reset records, clears recovery email, username,
image and verification state, and hides the account from leaderboards. It
retains a neutral account label, creation time, opaque player ID and a minimal
closure receipt. A durable Competition fence and database guards prevent
in-flight sign-in, reset or admission from reviving the account. A lost response
does not undo a committed closure. Old cookies and reset links lose access.
A leaderboard page or public profile already in the edge cache can still show
the account's previous public name and rating for up to 10 seconds after
closure. No private field is ever cached.

Game IDs, player IDs, PGNs, moves, results, historical player names, tournament
records, rating/correction history, tombstones and minimal case audit remain.
Closure is not full anonymization and does not erase an opponent's history.
The closed identity cannot be reopened through signup or password recovery.

`POST /api/account/close` accepts same-origin JSON:

```json
{"password":"<current password>","confirmation":"CLOSE","requestId":"<stable UUID>"}
```

Both actions require an authenticated credential account and share the
credential request allowance. Wrong passwords are rejected. An active game or
reservation returns `409`; request exhaustion returns `429`. An uncertain
authority returns a retryable error and leaves new admission fenced until its
lease is safely reconciled. The receipt contains request ID, player ID, policy
version and completion time, without credentials or email.

## Retention and access

Ages below are cleanup eligibility, not a promise of deletion at that instant.
Scheduled cleanup is bounded and can be delayed. Appeal and evidence holds apply.
The edge keeps public leaderboard, profile and arena reads for 10 seconds. They
carry no cookie, session or private field, and the cache key ignores both.

| Records | Policy |
| --- | --- |
| Credentials and recovery email | Account lifetime; removed on accepted closure |
| Minimized account identity and closure receipt | Permanent competition and minimal audit exceptions |
| Sessions, including stored IP/user-agent fields | Seven-day validity; cleanup every minute in bounded batches; removed on closure |
| Reset/verification secrets | Fifteen-minute validity; cleanup after expiry plus one day; account-owned reset rows removed on closure |
| Request windows and sign-in rate limits | One-day cleanup eligibility; minute-schedule batches |
| Released seat records | 30-day cleanup eligibility; minute-schedule batches |
| Cron heartbeat | One row per schedule with run times and failed stage names; no personal data |
| Ordinary evidence and report text | 90 days, subject to appeal and evidence holds |
| Private reviewer notes, corroboration and appeal text | Minimized 90 days after final case action, once appeal windows and holds end |
| Email budget receipts | 62-day cleanup eligibility |
| Game IDs, PGNs, results, historical names, rating/correction history and minimal case audit | Permanent retained history |
| Native provider recovery history | Rolling 30 days on the verified Paid D1 and SQLite Durable Object backends |
| Raw synthetic drill files | Delete after acceptance within 30 days; retain sanitized reports and hashes |

Proved eligible unrated Game payloads can retire after one hour. Permanent
replay, IDs and audit remain. Ranked authority remains stored. Platform storage
bounds and the budget stop limit admission; retention does not imply unlimited
service capacity.

Your account actions require your current session and password. Private case
and operational access requires the verified owner account and Cloudflare
Access. Reports remain informational in unattended mode.
These automated controls are the account-request route; no human response time
is offered. Losing a password without recovery email has no operator bypass.

## Recovery cannot reopen closed accounts

Native provider history is not an independent downloaded backup or a
transaction across all stores. A SQL export is a separate private copy with
its own approved destination, access and expiry. This policy requires and
authorizes no production account/session SQL export.

Before an approved restore, preserve receipts for every closure accepted after
the selected boundary outside all restore targets. Keep authentication and
admission closed, reapply those receipts through the same idempotent lifecycle
adapter, and verify that credentials, recovery addresses and sessions remain
removed. Reconcile later game/rating events as well. If the closure set or any
authority is uncertain, keep access closed. There is no public restore endpoint.
See [the isolated recovery drill](recovery-drill.md).
