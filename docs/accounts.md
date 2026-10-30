# Player accounts

## Current scope

New games require explicit username/password signup. Casual invitations and
computer practice stay unrated. Existing guest sessions can finish their
already owned games and access their private history. They cannot create new
games, take new seats, or earn competitive credit.

Protected signup with and without recovery email, live Turnstile, verification
and recovery passed the
[approved-recipient test](qualification/provider-accounts-20261021.md).
The [deployment guide](deployment.md) records the protected baseline and later
release state. Private administration keeps its own verified owner and
Cloudflare Access checks.

## Signup and signin

Open `/account/` and choose Create account. Supply:

- A unique username of 3 to 24 ASCII letters, digits or underscores. Usernames
  are normalized to lowercase, and case changes do not create another identity.
- A password of 8 to 128 characters. Password managers, spaces and paste work.
  There is no required mix of symbols, digits or uppercase letters.
- Optionally, a private email address for account verification and password recovery.

Email is used only for account security. Signup creates no marketing
subscription, and the product has no promotional-email flow. Public game,
profile and ranking responses exclude email addresses and password hashes.
You can leave recovery email blank. Without it, a lost password cannot be reset
by email. Save the password in a password manager. Adding or changing a recovery
address after signup is not available in this release.

Sign in with the username and password. The account screen and lobby identify
the current player. When the applicable admission gates are open, signup,
password signin and casual play do not require email delivery. Ranked and tournament entry do not require email or
email verification. They still require current credential-backed account
eligibility, no active restriction, and the applicable feature gates.

The account form preserves a same-origin Play invitation and time control
through signin. A return URL cannot redirect to another site. Passwords are
sent only to the same-origin auth API and never stored in localStorage or
application logs.

Signup can pause when its monthly or lifetime attempt allowance is full, or
when the service stops new accounts and games. Existing players can still
sign in. A failed or retried signup can consume an attempt; waiting for a new
month does not reset the lifetime allowance. These safeguards bound work and
account growth, not the Cloudflare invoice.

## Verification and recovery

If you supplied a recovery email, use Account to request a verification email.
The server uses the current
account's private email rather than accepting another destination. Follow its expiring link to prove
ownership of the private address. Verification is optional for player
competition and does not bypass public ranked launch, account restrictions,
or the requirement for a password credential. Owner administration separately
requires a real verified email matching Cloudflare Access.

If a password is lost and you supplied a recovery email at signup, choose
Forgot password and enter that address. Recovery can be requested before email
verification; the reset link proves access to the mailbox.
The response does not disclose whether an address owns an account. A valid
reset link lets the owner set a replacement password. The provider consumes
the reset token once and revokes old sessions. Email verification uses a signed
expiring provider token; revisiting it is idempotent, unlike a password reset.
Verification alone creates no session. Sign in again with the same
username and new password. The player ID, games and ratings do not change.

Reset tokens are not stored in browser preferences. The reset page removes the
token from the address bar after reading it. Links, passwords, email bodies
and tokens must stay out of analytics, command output and support reports.
Address-bar removal cannot erase the initial HTTP request. Keep full URL,
query-string and body logging off or redacted for Account and auth callbacks,
including upstream request capture. The account page and auth API use no-store
responses and no-referrer policy. Provider observability is disabled in the
checked-in Worker; do not enable raw request logging to diagnose recovery.
Do not resend a token to a third party. There is no operator bypass for a lost
recovery email or for an account that skipped email. A typo in the signup address
can prevent recovery. Email editing and operator identity recovery are not
available; do not claim those paths have been verified locally.

The deployed global stop currently closes new verification and recovery sends.
The approved sender domain is enabled, with Google mail DNS preserved and email
body previews disabled. The approved recipient completed real verification and
password recovery, then signed in with the new password. The earlier browser
session was revoked. The test recorded two email attempts and restored all
stops. This does not guarantee delivery to every mailbox.

Local development disables real email. It can create and sign in to password
accounts for casual play. The native Worker tests use a controlled mail binding
to exercise verification expiry and idempotence, single-use password resets,
and session revocation. That is
not evidence of inbox delivery. Missing mail configuration or an exhausted
email allowance closes email operations without disabling existing password
signin. All provider send attempts count toward the existing email cap.

## Account data and closure

Account includes password-confirmed JSON export and permanent account closure.
Recovery email is not required for either control. Exports are limited to
50 records and 256 KiB per page and exclude credentials, sessions and other
people's private evidence. Download wanted PGNs before closing your account.
Closure removes credentials, sessions and current private profile data while
retaining permanent game/player identity, historical names and rating history.
Finish games and leave event reservations first. These controls have passed
local native D1 tests; provider closure/restore acceptance and release remain
open. See [privacy, API details and retention](privacy.md).

## Stable identity and existing records

The additive username migration leaves existing user IDs and records intact.
It does not assign guest passwords, usernames or verified-email status. Keep
the anonymous schema declaration so existing guest sessions remain identified
as guests. Existing guest cookies retain their earlier access limits; clearing
one still loses that guest's seat access. Creating an account does not copy a
guest's games or ratings.

An existing signed-in explicit account without a username/password can complete
its account through the maintained provider APIs. This keeps its original ID.
Guests cannot use that upgrade to promote themselves. Finish active games and
leave tournament reservations before signing out or changing account identity.
The primary database identity lease serializes these actions with seat
admission, so signin cannot silently transfer a live game to another player.

This prelaunch migration supports retained local sessions. It does not claim
that every logged-out legacy email-link account has a deployed recovery flow.
The public service has never been released.

## Maintained auth and request boundaries

Better Auth 1.7.12 owns D1 users, credential hashes, sessions, username
normalization, verification and recovery. Product code composes those public
APIs with account policy, the existing Cloudflare Email binding and seat guards.
There is no second credential store or custom password cryptography.

The provider's D1 user schema requires a unique email string. When signup omits
email or sends a blank value, its public `createPlaceholderEmail` helper from
the directly pinned `@better-auth/core` generates a random non-deliverable
address under `chess.placeholder.invalid`. It does not make the account a guest
or mark its email verified. This thin adapter needs no schema migration.
Caller-supplied `.invalid` addresses are rejected as recovery email. Internal
addresses cannot trigger verification tokens, reset tokens or mail sends.
They stay out of responses; private `/api/me` exposes only `hasRecoveryEmail`
alongside verification state. Email add/change endpoints remain closed.

Auth endpoints require the canonical origin. Writes require same-origin JSON.
Signup, signin, recovery, verification requests and legacy account completion use server-verified Turnstile and database-backed
request limits. Other auth endpoints stay closed unless explicitly listed.
Private responses use `Cache-Control: no-store`; sessions use host-only HttpOnly,
SameSite Lax cookies, with Secure outside explicit loopback development mode.
Sessions last seven days without automatic refresh or a stale cookie-cache
authorization path.

| Request | Purpose |
| --- | --- |
| `POST /api/auth/sign-up/email` | `{username, name: username, password, email?}`; email omitted or blank creates an explicit account without email recovery |
| `POST /api/auth/sign-in/username` | `{username, password}`; ordinary signin |
| `GET /api/me` | Private current identity, `username`, `accountReady`, `hasRecoveryEmail`, anonymity and verification state; no email address |
| `POST /api/auth/send-verification-email` | `{}`; security-only verification when the current account has a real recovery email |
| `GET /api/auth/verify-email` | Provider verification callback |
| `POST /api/auth/request-password-reset` | `{email}`; generic recovery request with a server-fixed callback |
| `POST /api/auth/reset-password` | `{token, newPassword}`; consume reset and revoke sessions |
| `POST /api/account/complete` | `{username, password}`; retained explicit-account upgrade |
| `POST /api/auth/sign-out` | End the current session after the identity guard permits it |

Public anonymous signup and magic-link signin are retired. A valid old guest
session does not bypass credential-backed new-game or competition checks.

Signup passes server Turnstile and basic form validation before one atomic D1
reservation, then enters Better Auth's rate limits and password hashing. Each
attempt reserves one unit, including a duplicate username, provider failure,
uncertain reply or new HTTP retry. No unit is refunded. The default allowance
is 1,000 attempts per UTC month and 10,000 lifetime attempts. The additive
`0015_signup_budget.sql` migration counts existing identities against the
lifetime allowance and stores only one aggregate row. Signup returns
`503 SIGNUP_UNAVAILABLE` when stopped or exhausted, or `BUDGET_UNAVAILABLE`
when quota storage fails. These paths do not invoke password hashing.

## Release and recovery checks

Apply the additive migration without resetting local or deployed game state.
Test omitted, blank and real recovery email, reserved-address rejection,
placeholder token/mail suppression and email-independent player eligibility.
Test lowercase collisions, duplicate signup, wrong passwords, origin/challenge
failures, request exhaustion and private-data denial. Test existing guest
reconnect and replay while rejecting new guest seats. Verify reset replay and
expiry, old-session denial, identity-change races and stable IDs. Measure the
maintained password hashing path in the native Worker runtime, then build and
check the Worker with the existing byte limits.

Local password timings measure wall time, not billed Worker CPU. They do not
prove that production hashing fits the checked-in 50 ms CPU limit. Qualify
signup, signin and reset under the deployed cap before publication, or review
and measure a cap change within the approved budget. Do not weaken password
hashing to meet an unverified performance target.

Before publication, verify real recovery and verification inbox delivery on
the protected canonical host with the approved sender and canary accounts.
Never mark an address verified by hand to pass a release check. See
[deployment](deployment.md), [operations](operations.md), and the current
[verification record](verification.md) for remaining gates.

## Account screens

Play shows the game types enabled by the server. Closed ranked and computer
modes are absent from the selector. A recovery email is optional; the signup
field explains that skipping it removes email password reset. The account
page retains recovery status, verification, session and privacy actions.
