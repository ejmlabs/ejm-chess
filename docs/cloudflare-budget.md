# Cloudflare budget and admission stops

## Current policy, 2026-10-22

Use one **$100 monthly target**, alerts at $45 and $70, and the existing $85
automatic stop to leave headroom for active games and recovery. Billing alerts
can lag; this is not a guaranteed invoice cap. Earlier service allocations and
dated cost calculations are historical and no longer gate launch.

The configured monthly allowances are 10,000 signup attempts, 10,000 games,
and 5,000 account emails, plus 100,000 lifetime signup attempts. Operational
stops remain available. Ranked and tournaments retain their correctness gates.
The site remains behind Access until launch. These quotas are guardrails, not
measured capacity or dollar estimates. Adjust them when real traffic warrants it.


## Approved scope and current evidence

The owner approved a **$100 monthly spending envelope for chess**, with stops
and alerts. This is an operating limit. It is not a capacity tier, a provider
invoice cap, or proof that the configured workload costs less than $100.
Keep server analysis disabled. Ranked correctness and tournament workload checks
are release gates; repeated per-service financial reviews are not.

The approved 2026-10-20 provisioning confirmed the existing Workers Paid
subscription and enabled the sender domain for `chess@ejmlabs.com`, with body
previews disabled. Dedicated usage policies at $45, $70 and $85 are enabled
and address the approved owner inbox. The existing non-chess policies remain
unchanged. The protected launch deployment uses a 50 ms CPU limit, disabled
preview URLs and workers.dev, and a persistent private admin policy. The
October 22 configuration clears the deployment and account/game/email stops
and installs the monthly allowances above. Feature activation and public
Access removal follow the release checks. The high-threshold policy has a dedicated
secret-authenticated stop webhook. Its provider creation/test succeeded after
the approved exact-path Access and bot-filter exceptions. The approved
recipient completed real verification and password recovery, followed by
new-password sign-in and old-session revocation. The normal owner Operations
form restored persistent stops after exactly two email attempts; the later
October 22 policy clears account/game and email stops while retaining the
analysis stop.
See the [account acceptance report](qualification/provider-accounts-20261021.md).
Never copy another project's sender, database, secret, queue, or allowance into
chess merely because it is visible in the account.

The remote signup-counter migration passed on 2026-10-21 UTC, counting both
existing identities and no new attempts. Later protected deployments added
enforcement and the current settings without resetting counters. The October
22 guide publication reused the same server bundle. Historical zero caps are
retained in dated evidence and are not current configuration.

## Application allowances

Operations labels the dollar amount as the monthly spending target and its
table as configured work caps. The table reports the current deployment's
settings, not estimated capacity available for $100. A cap of zero disables
new work. On 2026-10-22, the protected deployment was updated to 10,000 signup
attempts, 10,000 games and 5,000 emails per month. The deployment stop and saved
account/game and email stops were cleared. Server analysis remains stopped.
Ranked and tournament qualification and the public launch sequence remain open.
Clearing a saved stop does not raise a configured cap.

The checked-in canonical settings use UTC calendar months. Defaults apply only
when a setting is absent:

| Setting | Configured | Default | Hard setting ceiling | Charged work |
| --- | --- | --- | --- | --- |
| `MONTHLY_GAME_LIMIT` | 10,000 | 5,000 | 10,000 | New game reservations across casual, browser computer practice, ranked, and tournaments |
| `MONTHLY_EMAIL_LIMIT` | 5,000 | 1,000 | 5,000 | Account verification/recovery provider send attempts, including failed or uncertain attempts |
| `MONTHLY_ANALYSIS_LIMIT` | 0, disabled | 100 | 1,000 | Reserved server engine attempts, including retries |
| `MONTHLY_SIGNUP_LIMIT` | 10,000 | 1,000 | 10,000 | Signup attempts after basic form validation and server Turnstile, before password hashing |
| `SIGNUP_ATTEMPT_LIMIT` | 100,000 lifetime | 10,000 lifetime | 100,000 | Existing identities plus all later reserved signup attempts; no monthly reset |

These are adjustable safety allowances. They do not imply that
10,000 games fit a measured latency, memory, regional, or spending envelope.
The existing concurrent, retained-payload, permanent-ID, queue, daily-analysis,
and CPU limits remain separate gates. Browser Stockfish uses the player's
device; the optional server analysis service remains `ANALYSIS_ENABLED=false`.
The application month may differ from an account's invoice period.

Missing allowance settings use the defaults. A zero, malformed, negative,
fractional, or above-ceiling setting closes new work in that category. D1
failure also prevents new budget reservations. `NEW_WORK_STOPPED=true` closes
all three receipt categories and signup for new work; any value other than exact `false` or an
absent value also closes them. This switch does not stop ordinary HTTP traffic
or create an account-wide Cloudflare billing cap.

One atomic D1 transaction admits a stable private work ID and charges its
category. Concurrent requests cannot spend the same last allowance slot.
Retries of the same accepted game reservation cost no additional units, even
after a stop or month change. A preview tournament reserves its complete three
or six game allowance together. Games already admitted before this migration
are not charged again. A reservation that later loses a seat race, fails to
initialize, or returns an uncertain result stays charged. Do not refund it by
deleting records or resetting counters.

Signup uses one fixed aggregate row and a conditional D1 update, rather than
per-attempt receipts. The monthly and lifetime check, stop check and charge are
atomic. Existing user rows count against its lifetime allowance at migration.
Each later admitted attempt is charged before Better Auth's rate limits and
hashing, including failed, duplicate or uncertain requests. Every new HTTP
retry needs another unit. Account closure and failed creation refund none.
The lifetime counter never resets; an older UTC period cannot reopen work.
Missing or invalid quota state denies signup.

The existing `gamesStopped` Operations control stops both new accounts and
games. The billing webhook sets that same stop. Existing signin, sessions,
issued verification/reset links and admitted work remain available under their
normal checks. Recovery email sends retain their separate email stop.

An exhausted allowance closes new game IDs and new queue or tournament entry.
Admitted invitations can still be joined. Existing games, reserved tournament
rounds, clocks, result outboxes, rating events, corrections, replay, maintenance,
and private exports retain their normal recovery paths. A budget stop never
changes an accepted result. A database or provider outage may still delay those
paths; a stop does not make dependencies available.

Email stops prevent the next verification/recovery send. Username/password
signin does not depend on that send. Stops do not revoke existing sessions
or already issued links. An analysis stop prevents the next server engine call;
an already running call may complete, and a stored summary can still be saved
as evidence. Pending analysis retains its existing bounded retention, retry,
and dead-letter policy. Informational analysis is not required to settle a game.

## Stored budget records

Aggregate keys are fixed: three categories across twelve reusable month slots,
plus three receipt-count rows, one control row and one signup aggregate row. Each category keeps at most
twelve stored month records; an inactive slot can retain an older month.
Receipts contain private work IDs, timestamps, and unit counts.
They contain no email address, sign-in token, engine position, or report text.

Game receipts remain permanent, with a separate 111,000-row ceiling. It can
close admission before a larger configured ID ceiling, including arena
qualification settings. Unused charged reservations also count. Email and
analysis receipts expire after 62 days.
The normal minute maintenance cycle removes at most 100 expired receipts per
call. Separate retained-receipt ceilings of 15,000 email and 3,000 analysis
receipts close admission if cleanup falls behind. Cleanup does not refund
monthly usage or delete game history. Stale operator changes cannot overwrite
a newer control version. The latest 64 changes retain actor ID, time, stop
settings, and a short reason; export records privately if longer audit retention
is required.

## Cost estimates and billing alerts

The October 22 policy replaces the earlier proof/core/email allocations,
mandatory recovery and unknown-cost reserves, and repeated financial reviews.
The [dated cost worksheet](cost-estimate.md#current-proof-financial-policy)
retains those assumptions for comparison. They are not current operating caps
or launch requirements. The isolated capacity run retains its approved $25
incremental ceiling within the single $100 target.

Work counters do not measure dollars. Provider billing units, shared-account
usage, retained storage and delayed reporting still affect the invoice. Keep
accepted games and recovery running through a stop. Qualification reports must
state actual resource use and failures; historical estimates do not pass them.

Three enabled Cloudflare account-wide usage policies now target the owner's
approved alert address, recorded privately. Their filters and destination
association were read back successfully. The high-threshold policy also names
the verified generic stop destination. An actual threshold-crossing billing
event and its email delivery have not been observed.
Cloudflare usage alerts are processed daily and exclude monthly subscription
fees. They can arrive after further charges accrue. They are notifications,
not spending caps, and they are not connected to the application's D1 counters.

Configured usage thresholds are **$45, $70, and $85**. Workers Paid's existing
$5 monthly base fee was verified. If that fee is allocated to chess, these
thresholds are approximately $50, $75, and $90 total. Shared-account usage
includes other products and can trigger these
alerts before chess reaches its own allowance. The included request, CPU, D1,
Durable Object, queue, email, and storage allowances are also shared where the
provider's plan says so. Do not count an account-wide included allowance twice.

Keep a private monthly cost sheet with chess resource IDs, base-fee allocation,
usage quantities, billed rates, retries, storage growth, and the other projects'
share. Update it from Cloudflare's billing and resource reports. The application
does not estimate dollars from a game count. Count attack traffic, public reads,
authentication, sockets, maintenance, logs if enabled, and accepted work still
draining after a stop. No account-wide or chess invoice ceiling is enforced by
these application counters.

| Signal | Operator action |
| --- | --- |
| $45 usage alert, or 50% of an app allowance | Review chess and shared-account usage, growth, oldest work, and remaining days |
| $70 usage alert, or unexpectedly rising unit cost | Stop server analysis; investigate before allowing more optional work |
| $85 usage alert | The associated dedicated webhook stops new games, email, and analysis when Cloudflare delivers the notification; reporting and delivery can be delayed |
| Spending threatens the $100 envelope before that alert | Use the private stop controls, preserve accepted work, and inspect billing |
| Exhausted allowance or retained-receipt ceiling | Keep the stop, inspect reservations and cleanup, and reconcile actual spend before resuming |
| Failed result outbox or correction, or lag above two minutes | Inspect authority status and provider health; run one bounded retry cycle and investigate persistent failures |
| Analysis queue age above ten minutes while enabled | Check its daily/monthly allowance, lease, provider response, and dead letters; do not enable more concurrency |

These are response thresholds, not measured service objectives. Provider outage,
attack traffic, a shared subscription, or charges reported late can exceed the
envelope before an operator acts. Start with a small approved canary and review
actual costs before expanding admission.

### Provider usage readback

On 2026-10-21 UTC, read-only account queries succeeded for Cloudflare's
[billable usage](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/paygo/)
and [usage coverage](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/paygo_info/)
endpoints:

```text
GET /accounts/{account_id}/billable-usage/info
GET /accounts/{account_id}/billable-usage
```

Use the approved private API credential. Keep raw account responses private.
The first response supplies coverage and subscription billing anchors; the
second defaults to the current billing period. An explicit date range must
include the subscription's billing anchor. Both routes are deprecated alpha
APIs in the current reference. Recheck their documented replacements before
building an automated billing dependency.

The observed coverage was true, with a billing anchor of 2026-09-29 UTC. The
usage response contained 128 account-wide records, with charge periods ending
as late as 2026-10-21 UTC. Its returned cost fields were zero. This is a dated,
partial readback. It does not establish complete current chess costs, unused
shared allowances, or a free proof run. Reconcile service quantities against
the exact chess resources, retained storage, subscription fees and later
billing updates before approving more paid work. Preserve an allowance for
usage that has not yet appeared.

## Dedicated automatic stop notification

The source implements a dedicated endpoint at
`POST https://chess.ejmlabs.com/api/operations/budget-stop`. It uses Cloudflare's
documented generic notification shape and exact `cf-webhook-auth` secret
header. At the application layer it does not require a browser session,
Cloudflare Access login, Origin header, or Turnstile. The canonical origin and normal response security headers
still apply. The endpoint stays disabled unless its separate secret is valid.

On 2026-10-20 the owner approved an Access exception for this exact path, then
a separate Super Bot Fight Mode exception for POST requests from Cloudflare's
network with a nonempty auth header. Both were saved and read back. The latter
skips only that bot challenge; application secret authentication remains. Main
site and administration denials still pass. Other hosts and paths keep their
existing rules.

Cloudflare's destination creation/test returned 201 after its initial test was
blocked by the bot challenge. The destination is associated only with the
enabled $85 account-usage policy, preserving its email recipient and the two
lower email-only policies. During this historical callback test, the application
control row recorded all three stops at version 1; repeated authenticated
delivery while stopped added no version. The later mail acceptance restored all
three stops through the normal owner form at version 3.
The destination's last_success and last_failure fields were null at readback.
No actual threshold-crossing billing event has been observed. This establishes
tested callback reachability and a saved association, not an invoice ceiling or
a measured billing-event delivery delay.

Configure it only after approving the deployed resource and destination:

1. Create a fresh secret from at least 32 random bytes. Store its base64url text
   in the Worker's secret store as `BUDGET_STOP_WEBHOOK_SECRET` and in the
   dedicated Cloudflare webhook destination's secret field. The endpoint accepts
   32 to 128 base64url characters. Do not put it in Wrangler variables, source,
   URLs, screenshots, logs, browser bundles, or chat. Do not reuse an auth secret.
2. Use the exact HTTPS URL above, publicly resolvable on port 443. Leave ordinary
   site/admin protections intact. Any path-specific challenge exception must be
   limited to this endpoint; its secret authentication must remain enforced.
3. Bind this unique destination **only to the high-threshold billing policy**.
   Keep lower informational alerts on their separate email destinations. Save
   and read back the actual destination, policy type, threshold, enabled state,
   and association through the provider before claiming automatic dollar stops.
4. While admission is already closed, send Cloudflare's Save/Test notification.
   Verify a successful response and the private control/audit state. A test
   notification deliberately stops all three categories. Repeated notifications
   while already stopped do not add control versions. A new notification after
   an owner reopens work will stop it again.
5. Read back the real billing policy's destination association as well. A generic
   webhook test proves reachability and authentication; the saved policy must
   also retain its webhook destination. Record actual billing-event delivery
   separately when it occurs; do not spend money merely to cross a threshold.

After authenticating, the endpoint accepts an object with nonempty `text` of
at most 4,096 characters inside an 8,192-byte JSON body. It ignores other
metadata. Every accepted notification, including Save/Test, atomically sets all
three stops. The endpoint cannot clear a stop, reset an allowance, select an
account, or change the spending envelope. It stores only a fixed audit actor
and reason. It does not parse an asserted dollar amount or store/log/return the
provider message or raw payload. Wrong secrets fail before body parsing or D1.
A failed database commit returns a retryable failure rather than a false
acknowledgement. Monitor provider delivery failures and preserve existing work.

The initial inventory lacked billing permissions. The later approved token
saved and read back all three usage-alert policies and the high policy's
webhook association. The successful provider callback test does not prove an
actual threshold-crossing event or email receipt. Even a working daily billing
alert can arrive after further charges accrue and cannot enforce a hard invoice
cap. Application work quotas remain the immediate admission safeguards.

## Stop and recover

1. Open `/admin/` with both the verified owner account and matching Cloudflare
   Access identity. Refresh Operations. Save its current budget `control.version`,
   allowance counts, pending work, and cost evidence privately.
2. Use the versioned stop form under Operations. Its private JSON `POST` goes to
   `/api/admin/operations/budget`. Supply `expectedVersion`, all three boolean
   settings `gamesStopped` (new accounts and games), `emailStopped`, and `analysisStopped`, plus a reason
   of 10 to 240 characters. Stop settings are private operational metadata; keep
   credentials and personal data out of the reason.
3. Refresh status and verify the new version and flags. A `409
   BUDGET_CONTROL_CHANGED` means another update won; refresh before deciding
   again. A `400 INVALID_BUDGET_CONTROL` means the complete input contract was
   not met. Access and account checks cannot be bypassed for recovery.
4. If D1 or Access is unavailable, preserve data and use the approved deployment
   path to set `NEW_WORK_STOPPED=true`. Keep alarms, cron, bindings, and accepted
   work intact. This environment switch may take a deployment to apply and does
   not stop charges from existing work or HTTP requests.
5. Inspect provider health and the cause. Retry accepted work through Operations
   once per investigation cycle. Check result/correction lag, archive cooldowns,
   analysis state, and receipt cleanup. Do not clear a lease or delete an outbox
   merely because it is old.
6. Before resuming, reconcile actual chess cost against the $100 monthly envelope
   and confirm headroom for accepted work and a late bill. Clear only the desired
   D1 stops using the latest version and return `NEW_WORK_STOPPED` to exact
   `false` through the approved configuration path if it was used. Feature gates
   and exhausted allowance or lifetime-ID ceilings still apply.

Example body to stop every new budgeted category:

```json
{
  "expectedVersion": 0,
  "gamesStopped": true,
  "emailStopped": true,
  "analysisStopped": true,
  "reason": "Investigating the monthly usage alert."
}
```

Use the actual version from status. Do not reset counters, invent an older
month, or raise a ceiling to conceal an exhausted budget. A new UTC month resets
only the monthly allowance. Permanent IDs, game receipts, accepted results,
pending work, storage costs, and account billing remain.

## Provider references

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare billing notifications](https://developers.cloudflare.com/billing/notifications/)
- [Configure Cloudflare notification webhooks](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Durable Object point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#point-in-time-recovery-api)
