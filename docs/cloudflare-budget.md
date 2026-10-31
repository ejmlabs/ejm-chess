# Cloudflare budget and admission stops

## Current policy, 2026-10-31

The owner set one economic control: Cloudflare budget alerts and the automatic
stop. The application enforces no monthly game, signup, email or analysis cap
and no arbitrary product cap on ranked, arena, tournament or casual play (owner
decision, 2026-10-31; first set 2026-10-30). Usage counters remain for the
private Operations page; they do not deny new work. Billing alerts can lag, so
this is not a guaranteed invoice cap. Security and abuse limits, input bounds,
fair-play rules and platform safety bounds are not spending controls and stay.

The Cloudflare account has saved budget alerts at $10, $45, $70 and $85 account
usage, plus the $85 stop webhook. The $100 monthly target is the envelope. The
stop webhook sets the same `gamesStopped` control as the owner form. Existing
signin, sessions, issued verification/reset links and accepted work continue
under their normal checks.

## Approved scope and current evidence

The owner approved a $100 monthly spending envelope for chess. This is an
operating limit, not a capacity tier, provider invoice cap, or proof that the
configured workload costs less than $100. Keep server analysis disabled.
Ranked, arenas and tournaments open under the 2026-10-31 launch policy; see
[live-ready prep](live-ready-prep.md).

The approved 2026-10-20 provisioning confirmed the existing Workers Paid
subscription and enabled the sender domain for `chess@ejmlabs.com`, with body
previews disabled. Dedicated usage policies are enabled and address the
approved owner inbox. The existing non-chess policies remain unchanged. The
protected launch deployment uses a 50 ms CPU limit, disabled preview URLs and
workers.dev, and a persistent private admin policy. The high-threshold policy
has a dedicated secret-authenticated stop webhook. Its provider creation/test
succeeded after the approved exact-path Access and bot-filter exceptions. The
approved recipient completed real verification and password recovery, followed
by new-password sign-in and old-session revocation. The normal owner Operations
form restored persistent stops after exactly two email attempts.
See the [account acceptance report](qualification/provider-accounts-20261021.md).
Never copy another project's sender, database, secret, queue, or allowance into
chess merely because it is visible in the account.

## Application usage and stops

The application records usage but does not enforce monthly category caps.
`NEW_WORK_STOPPED=true`, or any value other than exact `false` or an absent
value, closes all new budgeted work. The existing `gamesStopped` control stops
both new accounts and games; the billing webhook sets that same stop. Existing
signin, sessions, issued verification/reset links and admitted work remain
available under their normal checks. Recovery email sends retain their separate
email stop.

One atomic D1 transaction admits a stable private work ID and records its
category. Retries of the same accepted game reservation cost no additional
units, even after a stop or month change. A reservation that later loses a seat
race, fails to initialize, or returns an uncertain result stays recorded. Do not
refund it by deleting records or resetting counters. Usage counters and
receipts remain for the private Operations page and audit history.

Signup records an attempt before Better Auth's rate limits and hashing,
including failed, duplicate or uncertain requests. A stop closes new attempts;
existing signin remains available. Account closure and failed creation refund
none. There is no monthly or lifetime application signup cap.

## Stored budget records

Aggregate keys are fixed: three categories across twelve reusable month slots,
plus three receipt-count rows, one control row and one signup aggregate row. Each category keeps at most
twelve stored month records; an inactive slot can retain an older month.
Receipts contain private work IDs, timestamps, and unit counts.
They contain no email address, sign-in token, engine position, or report text.

Game receipts remain permanent, and unused charged reservations also count.
Email and analysis receipts expire after 62 days.
The normal minute maintenance cycle removes at most 100 expired receipts per
call. No receipt row count closes admission. Cleanup does not refund
monthly usage or delete game history. Stale operator changes cannot overwrite
a newer control version. The latest 64 changes retain actor ID, time, stop
settings, and a short reason; export records privately if longer audit retention
is required.

## Cost estimates and billing alerts

The October 22 policy replaces the earlier proof/core/email allocations,
mandatory recovery and unknown-cost reserves, and repeated financial reviews.
The [dated cost worksheet](cost-estimate.md#historical-allocation-worksheet-2026-10-21)
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

Configured usage thresholds are kept in the private provider record. Workers Paid's existing
$5 monthly base fee was verified. If that fee is allocated to chess, the
thresholds are higher by that amount. Shared-account usage
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
| First usage alert, or 50% of an app allowance | Review chess and shared-account usage, growth, oldest work, and remaining days |
| Second usage alert, or unexpectedly rising unit cost | Stop server analysis; investigate before allowing more optional work |
| Final usage alert | The associated dedicated webhook stops new games, email, and analysis when Cloudflare delivers the notification; reporting and delivery can be delayed |
| Spending threatens the $100 envelope before that alert | Use the private stop controls, preserve accepted work, and inspect billing |
| Stop set, or receipt cleanup behind | Keep the stop, inspect reservations and cleanup, and reconcile actual spend before resuming |
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
enabled highest account-usage policy, preserving its email recipient and the two
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
cap. The Cloudflare stop and versioned feature stops are the immediate admission
safeguards.

## Stop and recover

1. Open `/admin/` with both the verified owner account and matching Cloudflare
   Access identity. Refresh Operations. Save its current budget `control.version`,
   usage counts, pending work, and cost evidence privately.
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
   remain; there is no monthly allowance or lifetime-ID cap.

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

Use the actual version from status. Do not reset counters or delete receipts to
conceal an exhausted budget. Counters are observability only. Permanent IDs,
game receipts, accepted results, pending work, storage costs, and account
billing remain.

## Provider references

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare billing notifications](https://developers.cloudflare.com/billing/notifications/)
- [Configure Cloudflare notification webhooks](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Durable Object point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#point-in-time-recovery-api)
