# Isolated account-closure recovery rehearsal, 2026-10-21 UTC

## Status and scope

Account closure reapplication passed after a real native D1 Time Travel
restore in the separate `ejm-chess-recovery-drill` Worker and database. A fresh
synthetic rated game supplied the account and retained history. Game and
Competition stayed current throughout, including the committed closure fence.
Neither Durable Object was restored. No production resource or real player
account was exported, restored or changed.

This establishes the recorded single-account recovery path. Task 6.3 remains
open. Follow the [private fixture recipe](../recovery-drill.md#account-closure-after-a-native-d1-restore)
and the broader [recovery report](provider-recovery-20261021.md) for procedure
and remaining recovery gates. No public authentication or game-admission route
was exposed by the isolated Worker. Its deployment stop stayed set, feature
flags stayed off, and monthly game, email and analysis allowances stayed zero.

| Reviewed artifact | Value |
| --- | --- |
| Frozen source SHA256 | `cea0925bca8ebc885b56924254022e5fcda42550531f17bf8360e5215a060bc7` |
| Uploaded bundle SHA256 | `911440fa2d29235cbfa526b430b725940db2a89304eba75ae137997bad5959ef` |
| No-bundle upload config SHA256 | `8c2e964a3924dec929a538a618759bd90912c5e6cc6f42c85c2b1405feafb4ec` |
| Isolated Worker version | `d33d5370-34c6-48c7-a917-dd60de53c2b6` |
| Account policy | `account-2026-10-v1` |
| D1 migrations | All 14, including `0014_account_privacy.sql` |

The pinned verifier passed before deployment and after the provider rehearsal.
It checked 51 source inputs, 21 artifacts, 7,004 recorded dependency files and
132 installed packages, plus the declared links, Node runtime and exports.
Concurrent local checks added disposable Vitest cache files outside the frozen
inventory. Their exact bytes and hashes were preserved privately before only
those added files were removed under explicit task authorization. No recorded
dependency, source file, config, link or manifest was changed or resealed.

## Prepared account and ordinary closure

The new rated fixture finished through a normal versioned resignation. Its
result settled at projection epoch 3, with no pending Game delivery or result
repair. Result and rating watermarks were both 7 before the privacy boundary.

Maintained Better Auth handled password hashing, sign-in, session cookies,
password confirmation and sign-out. The private fixture selected only its
existing synthetic white account. It accepted no supplied account, email,
password, cookie or credential hash.

Preparation passed the ordinary password-confirmed exports: one profile and
one participant game. Recovery email was null. The baseline contained one
credential, two sessions and no reset rows. The identity, creation time,
historical names, PGN and rating/result watermarks were retained.

A real native D1 bookmark was saved after preparation. Its source, resources,
schema hash and baseline were recorded privately. Closure then used the normal
password-confirmed lifecycle. Its exact opaque receipt was saved outside all
restore targets before rollback. Closure established:

- Zero credential, session and account-owned reset rows, with one receipt.
- A minimized profile and the original retained identity and game history.
- A committed closed Competition fence.
- Rejection of the old session cookie and maintained sign-in returning HTTP
  401. A rate-limit response would not satisfy this check.

## Native rollback and receipt reapplication

The current closed-state D1 undo boundary was preserved. Native D1 restoration
then returned to the saved pre-closure bookmark and supplied its real
`previous_bookmark` undo receipt. Both native records remain private. The undo
was preserved and was not executed in this lane.

The restored export matched the saved baseline exactly across all 50 D1
tables, including schema and complete rows. It contained the expected one
credential, two sessions and zero D1 closure receipts. The current Competition
fence and preserved accepted receipt stayed closed and present. No sign-in was
attempted in this temporary state. The internal old-cookie lookup could see
the restored session while all public access remained closed.

The exact preserved receipt, including its original completion time, was
reapplied twice through the shared idempotent minimization path. Each call
returned the same original receipt and passed every closure check. The final
state had zero credentials, sessions, resets and identity-change leases; one
receipt; and zero armed restores. The profile remained minimized, the old
cookie and maintained sign-in were denied, and identity, history and rating
watermarks remained intact. The finished rated game remained settled at epoch
3 without a rating void.

Private exports after the first and second reapplications matched in 49 of 50
D1 tables. Only Better Auth's `rateLimit` table differed because the required
maintained sign-in-denial probe updates its counter. No closure, identity,
history, rating, budget or control table changed during the duplicate call.

Current captures before rollback and after both reapplications had identical
Game and Competition authority hashes, metadata and alarms. All three existing
probe values also matched. No probe was reset and no DO restore or restart
request was sent. The source, resource bindings and D1 schema hash stayed the
same.

## Measured intervals and limits

| Observed interval from native D1 restore request | Seconds |
| --- | ---: |
| Native restoration observed complete | 37.546 |
| First receipt reapplication verified | 127.021 |
| Both receipt reapplications verified | 184.027 |

These wall-clock intervals include evidence exports, local comparison and
polling. They are measurements of this isolated rehearsal, not service-wide
RTO or RPO promises.

This fixture had no recovery mailbox and no positive reset-token row. It does
not establish deletion of a populated reset set, recovery-email delivery,
multi-account closure replay, concurrent later closures, or a full service
restore. No native DO rollback, production restore, admission reopening or
independent-backup policy was approved by this result. Keep authentication and
admission closed on a missing receipt, changed boundary, incomplete later
closure set or failed check. The remaining recovery and launch gates still
apply. This report was checked locally; no documentation publication is
claimed.
