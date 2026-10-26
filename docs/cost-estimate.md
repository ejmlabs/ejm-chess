# Cloudflare cost estimate

Prices checked **20 October 2026, Pacific time**. Amounts are USD before tax.
This estimate supports the [$100 monthly chess budget](cloudflare-budget.md).
It gives explicit usage scenarios. Later isolated proof usage is recorded in
the [dated provider report](qualification/provider-proof-20261021.md). Complete
monthly and whole-account costs remain unqualified, so these figures are
neither a forecast nor an invoice cap.

The current policy, adopted October 22, is one $100 monthly spending target,
usage alerts and an emergency stop (thresholds are kept in the private provider record). Earlier service allocations,
mandatory reserves and repeated financial reviews are superseded. The dated
calculations below remain estimates, not launch requirements.

## Current scope

Workers Paid is already active. Its account minimum is $5/month. The tables
allocate that entire fee to chess; they do not add a second subscription charge.
Other projects use the same account, and their usage can consume included
quantities or trigger the account-wide alerts.

The private canonical configuration allows 10,000 signup attempts, 10,000
new game reservations and 5,000 account email attempts per UTC month, plus
100,000 lifetime signup attempts. Its deployment stop is clear. Feature gates
still disable ranked, tournaments, arenas, browser computer games and server
analysis until the final release. These are work quotas, not measured capacity
or dollar allowances. The [deployment guide](deployment.md) records actual
publication and activation state.

The estimate includes Worker traffic, Game and Competition SQLite Durable
Objects, D1, and account mail. Browser Stockfish runs on the player's device,
with no model tokens or server-engine inference charge. Its downloaded files
still use hosting resources. No server-analysis queue or Container is bound in
the canonical configuration. Enabling those services needs a separate deployed
cost and cold-start assessment. Observability is disabled in this snapshot.

## Published rates used

| Service and unit | Included monthly quantity | Excess rate |
| --- | ---: | ---: |
| [Worker requests](https://developers.cloudflare.com/workers/platform/pricing/) | 10 million | $0.30/million |
| Worker CPU milliseconds | 30 million | $0.02/million |
| [Durable Object equivalent requests](https://developers.cloudflare.com/durable-objects/platform/pricing/) | 1 million | $0.15/started million |
| DO active duration | 400,000 GB-seconds | $12.50/started million GB-seconds |
| DO SQLite rows read | 25 billion | $0.001/million |
| DO SQLite rows written | 50 million | $1/million |
| DO SQLite stored data | 5 GB-month | $0.20/GB-month |
| [D1 rows read](https://developers.cloudflare.com/d1/platform/pricing/) | 25 billion | $0.001/million |
| D1 rows written | 50 million | $1/million |
| D1 stored data | 5 GB | $0.75/GB-month |
| [Outbound email](https://developers.cloudflare.com/email-service/platform/pricing/) | 3,000/account | $0.35/1,000 |

DO duration uses the provider's 0.128 GB allocation example. Eligible hibernation
does not accrue active duration. Each excess DO compute dimension rounds up to
its next million-unit increment. A small duration overage can therefore add
$12.50. Incoming WebSocket messages count at 20:1 toward DO requests; RPC calls
and connection upgrades also count. Outgoing messages do not add request charges.
Hibernation savings in this deployment remain unmeasured.

SQL usage includes scans, writes, indexes, deletes, alarms and retained data as
applicable, rather than just rows returned to a player. Published DO SQL
allowances match D1's quantities, but this assessment has not established
cross-product pooling or the account's remaining entitlements. The first
scenario column assumes each published allowance is available to chess. The
second removes all included quantities. Do not count one account entitlement
twice when reconciling the real bill.

[Turnstile Free](https://developers.cloudflare.com/turnstile/plans/) costs $0
for up to 20 widgets with 10 hostnames each and unlimited challenges and
verification requests. Worker and database handling still costs normally.
[Access](https://www.cloudflare.com/sase/products/access/) advertises a free
plan for teams under 50 users and $7/user/month paid annually above it. The
scenarios assume the owner canary and admin fit existing free entitlements;
shared seats, widgets and the actual plan need readback. Public Better Auth
player accounts do not themselves require Access seats.

Mail quantities follow the account billing cycle, which can differ from the
app's UTC month. Provider-accepted sends, including hard bounces, count. App
allowances count attempts, including failures and uncertain outcomes. The model
treats all 1,000 as ordinary accepted recipient emails. Even with no remaining
email inclusion, their direct sending cost is $0.35, plus request/auth costs.

## Monthly usage scenarios

These inputs are deliberately hypothetical. A game count alone cannot predict
asset hits, signins, public reads, retries, or active-object time. All Worker
totals below include assumed traffic from those paths and maintenance.

| Assumed input | Lower, 5,000 games | Higher, 5,000 games | Higher, 10,000-game sensitivity |
| --- | ---: | ---: | ---: |
| Worker requests | 1 million | 20 million | 30 million |
| Worker CPU milliseconds | 2 million | 200 million | 300 million |
| DO equivalent requests | 0.5 million | 5 million | 9 million |
| Billed active seconds/game | 10 | 2,400 | 2,400 |
| Other billed active object-seconds | 86,400 | 2,592,000 | 2,592,000 |
| DO duration, GB-seconds | 17,459.2 | 1,867,776 | 3,403,776 |
| DO SQL rows read / written | 25m / 5m | 1,000m / 40m | 1,900m / 75m |
| DO stored GB-month | 1 | 5 | 9 |
| D1 rows read / written | 5m / 1m | 100m / 10m | 190m / 19m |
| D1 stored GB-month | 1 | 1 | 1.8 |
| Accepted outbound emails | 1,000 | 1,000 | 1,000 |

The higher cases bill every game active for 40 minutes and another object for
the entire 30-day month. They make no hibernation saving assumption. The lower
case assumes only ten billed active seconds per game, plus one day of other
object activity. Neither activity profile has been measured. The 10,000-game
case doubles specified game-dependent work while retaining fixed traffic and
maintenance; its full construction is saved with the calculation inputs.

| Allocated monthly cost, including $5 base | Published allowances available | No included quantities available |
| --- | ---: | ---: |
| Lower, 5,000 games | **$5.00** | **$25.32** |
| Higher, 5,000 games | **$37.00** | **$93.95** |
| Higher, 10,000-game sensitivity | **$93.40** | **$170.94** |
| Higher, 5,000 games, per 1,000 games | $7.40 | $18.79 |

For example, the higher 5,000-game case with inclusions is $5 base + $3 Worker
requests + $3.40 CPU + $0.60 DO requests + $25 DO duration. Its other modeled
units fit the published allowances. Without inclusions, SQL writes add $50 and
the total reaches $93.95. Whole-account invoice rounding and allocation can
differ. The 10,000-game row is a sensitivity calculation, not approval to raise
the current game limit.

For a separate spectator unit, 10,000 spectator-hours refreshing every ten
seconds produce 3.6 million refreshes. At an assumed ten CPU milliseconds per
refresh and no available Worker inclusions, the Worker-only marginal cost is
$1.80. This excludes assets, auth, reconnects, database misses, projections,
storage, and the base fee. Measure those paths before publishing cost per
10,000 spectator-hours.

## Exposure outside game quotas

[Direct static delivery](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
has no request or asset-storage charge. This app currently sets
`assets.run_worker_first=true`, which invokes the Worker for asset requests.
Those script invocations use normal request and CPU billing. Cached public
API responses can avoid database work, but do not make all public traffic free.
Workers has no egress charge under the cited standard pricing.

Signups, password hashing, signins, invalid requests, public browsing, attacks,
maintenance, existing sockets, accepted work draining after a stop, and retained
replays or permanent ledgers can still consume resources. The 50 ms Worker CPU
limit bounds one invocation, not monthly request volume. Rate limits and
Turnstile reduce exposure; they do not enforce the $100 invoice envelope.

The 1,000-live-game target remains unqualified. If 1,000 DOs were continuously
billed active for 30 days, duration alone would be 331,776,000 GB-seconds,
or **$4,150** after the published included quantity and rounding. This is a
sustained-activity example, not a prediction for hibernating games. Concurrency
cannot be priced without active time and traffic measurements.

The saved usage alerts exclude the plan fee and are processed daily.
The high-threshold webhook association was read back and its provider Save/Test
callback passed. An actual threshold-crossing event and its email delivery have
not been observed. Even working alerts can arrive after more charges accrue.
Keep the private stop controls available and preserve accepted game results.
See [budget stops and recovery](cloudflare-budget.md).

## Qualification spend and remaining measurements

### Timeout-proof review, 21 October 2026 UTC

The isolated basic-tier proof run passed its fixed corpus. Its then-current
$20 monthly share remained unqualified at that review. A conditional 1,000-game model with at most 2,000
native attempts has a known subtotal of $13.6551 before image registry, setup,
extra retention and billing adjustments. It assumes at most 45,000 allocated
Container seconds and bounded Worker, SQL, storage and log use. Those are
planning envelopes, not measured or enforced complete monthly limits.

A basic Container left allocated for 31 days uses $7.445952 in memory and disk
alone. Without shared inclusions, the first DO request and duration increments
raise that to $20.095952 before CPU or other costs. At full allocated CPU the
same sensitivity reaches $33.487952. A completed proof receipt therefore cannot
serve as evidence of shutdown or budget compliance. Stop failures must remain
recorded across controller restarts and block further native starts until
reconciled. Provider outages can still delay shutdown and billing readback.

Cloudflare documents that its managed image registry uses R2, but the reviewed
sources did not establish a managed-registry tariff. Do not assume its storage
and operations are free or apply retail R2 billing without confirmation. The
[provider proof report](qualification/provider-proof-20261021.md) records that
completed run and its measurement limits. It remains dated evidence; the current
financial policy below does not turn its unresolved checks into passes.

### Current proof financial policy

Use the single $100 target, existing alerts and stop described above. The
isolated capacity run keeps its approved $25 incremental ceiling. Runtime
bounds, source integrity and actual proof and tournament results remain
required. No per-service financial review is an additional release gate.

#### Historical allocation worksheet, 2026-10-21

This superseded model divided the monthly target into $25 proof, $45 core,
$5 base, $5 email and $20 accepted-work/recovery. It included a $25 capacity
reservation inside core, one $5 pretax reserve for unknown proof/image/historical
charges and a 12% planning tax reserve. These were planning assumptions, not a
provider tax quote or current operating limits. Registry tariff, complete prior
setup/log charges, current spend and final tax were unresolved in that model.

| Conditional work, including the named reserve and planning tax | Estimate |
| --- | ---: |
| Finite proof acceptance, corrected recovery addendum v2 | $20.9008533556418 |
| Finite plus normal proof, common billing units counted once | $22.0265653556418 |
| Remaining inside $25 proof | $2.9734346443582 |
| Capacity plus finite and normal proof | $33.3385653556418 |

The v2 correction reserved all 480 extra recovery request equivalents at the
existing private 100 ms Worker CPU ceiling, rather than 50 ms. That adds
$0.000480 pretax and $0.000537600 with planning tax to v1. Total added recovery
SQL, SDK and Worker planning cost is $0.278087808 pretax or $0.311458344960 with
tax. Full guarded SQL is 9,510,912 DO reads, 289,632 DO writes, 4,411,392 D1 reads
and 112,944 D1 writes. The unqualified hidden-SDK sensitivity of 28,192 writes is
already priced once. These are planning allowances, not measured SDK work.

The common account-cycle envelope is 977,300.440324992 GB-seconds and 1,201,327
DO request equivalents. With no free allowance assumed, assign the one started
$12.50 duration unit once to proof and one $0.15 request unit each to proof and
capacity. Modeled duration headroom before the second unit was 22,699.559675008 GB-seconds.
The old standalone capacity worksheet is $22.60 pretax or $25.312 with planning
tax, so it alone does not prove a $25 fit. Shared attribution gives capacity
$10.10 pretax or $11.312 with planning tax; the model reserved $25 for that run.
Different billing cycles, quantities or rates require a rebuilt ledger. These
estimates are not a complete monthly invoice forecast and grant no extra work.

One additional awake Prover month adds 342,835.2 GB-seconds and triggers a second
duration unit in that combined envelope. No guaranteed stop-failure maximum was
proved. This worksheet does not replace the current alerts and stop or actual
provider results. Accepted work and bounded shutdown continue through a stop.
Production proof and ranked activation require the real proof, settlement,
recovery and remaining release checks. See
[proof gates](timeout-proofs.md#separate-financial-source-and-provider-gates).

### Other qualification work

The saved 29-game screening evaluation used a network-disabled local Docker
run. It made no cloud engine or token calls. Local wall time is not billed
Worker CPU. Deployment, migrations and provider checks may incur usage; their
actual delta has not been collected, so their cost is not recorded as zero.

The proposed 20 unique settlements/second for 15 minutes requires **18,000
games**. That exceeds the current 10,000 allowance and its hard ceiling.
The owner approved a separate once-only isolated plan with at most
20,000 permanently charged synthetic admissions and a $25 incremental ceiling
inside the $100 monthly target. It requires 18,000 regular native results and 1,000 distinct
delayed results. Its frozen candidate, fixed UTC schedule and fresh complete
cost ledger still need separate owner approval before provisioning or load.
Production ceilings stay unchanged. See the
[capacity qualification guide](capacity-qualification.md) and
[arena qualification](arena-design.md#qualification-gates).
Do not reset counters, refund reservations or recycle IDs to fit the run.
This estimate alone authorizes no provider action or additional spend.

Before any cloud drill, record its one-time dollar allowance inside the $100
monthly envelope, resource IDs, initial usage, stop criteria and headroom for
accepted work. Start with a bounded canary, read provider usage afterward,
and reconcile delayed billing before expanding. No defensible dollar estimate
for the full drill exists until its actual request, duration and SQL profile is
measured.

Before public or ranked expansion, collect:

- Billed request mix and CPU for assets, signup, password signin, recovery,
  public reads, denied requests and maintenance, including the 50 ms auth limit.
- DO equivalent requests, billed active duration, hibernation, retries and I/O
  that keeps objects active.
- D1/DO rows read and written, including indexes, auth limits, outboxes and
  cleanup; storage growth from replays, tombstones, history and ledgers.
- Broader email delivery and quota behavior beyond the two approved-recipient
  verification/recovery sends, plus the relation between sends and app attempts.
- Account-wide included usage, Access seats, plan charges, alert delivery,
  actual billing-event delivery and complete chess resource costs.
- Real cron/alarm execution, regional recovery, load limits and measured cost
  per 1,000 games and 10,000 spectator-hours.

Public price sources, exact inputs, per-service calculations, local config hash
and a standard-library reproduction script are retained in
[`analysis/qualification/costs/`](../analysis/qualification/costs/README.md).
This doc does not establish deployed costs, capacity, worldwide latency,
restoration, alert delivery, or readiness to open ranked play.
