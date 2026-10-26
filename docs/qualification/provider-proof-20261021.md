# Isolated timeout-proof qualification, 2026-10-21 UTC

## Scope and result

The fixed native proof transport passed all 27 corpus cases and four
simultaneous forced-cold cases on Cloudflare's basic Container tier. All 31
completed on their first attempt before the original 30-second deadline.
This was a private synthetic run. It did not run a real Game timeout or settle
a rating through Competition. Task 3.8 remains open and ranked admission stays
closed.

The final controller state was `stopped=true`, `stopConfirmed=true` and
`enabled=false`, with 31 permanently charged reservations, nine commands and
one stop attempt. The Container was inactive. Provider preview URLs and
workers.dev were disabled, with no public route. The consumed run and its
receipts must not be reset, rearmed or replaced to obtain more work.

| Frozen input | SHA256 or version |
| --- | --- |
| Source digest | `11f8e5d06cce1983f88d50ac9922ab0d7b5263921771bf292f4bb79b5df3c93c` |
| Worker bundle | `76c4fc779a22b3b3e518e2da8f8c121e592e41b303deb4c28120890347a6764c` |
| Fixed synthetic corpus | `a37b4d12e4c0eaaae30bd95de2eac9ea9e03c9b90e25dae3e477b842b8530183` |
| Native image | `sha256:4e66a8b70f12948e091815d7443001d629a97e90c98e6043736bf5935e0cc93f` |
| Architecture and tier | Linux amd64, basic: 0.25 vCPU, 1 GiB memory, 4 GB disk |
| Instance / active native job limits | One / one |
| Uploaded Worker version | `91df582c-b298-40f0-b145-799e5da0be19` |

The [sanitized measurement record](../../proof/measurements/provider-basic-20261021.json)
contains individual fixed-case outcomes, aggregate native measurements, usage
and hashes of the private source records. It excludes request headers,
credentials, account data, recovery bookmarks and raw provider logs.

## Timing and native process measurements

The four simultaneous forced-cold requests took 2,145, 1,877, 2,442 and 2,768
milliseconds end to end. Across all 31 requests, the longest was 2,768 ms.
This is one small fixed corpus, not a public service latency objective.

| Native job measurement | Observed value |
| --- | ---: |
| Parent job wall time, p95 / maximum | 199.361 / 204.361 ms |
| Queue age, p95 / maximum | 2,844.293 / 3,102.086 ms |
| Combined child CPU, p95 / maximum | 185.701 / 192.326 ms |
| Combined child CPU, sum | 4,848.671 ms |
| Largest child lifetime peak RSS | 25,755,648 bytes |
| Helper CPU, maximum / sum | 169.333 / 4,188.759 ms |
| Native solver CPU, maximum / sum | 8.800 / 103.173 ms |

Percentiles use the nearest-rank method. The child lifetime metric and helper
or solver RSS are process high-water marks. Adding them would not measure
concurrent Container memory. The separate provider workload series recorded
peak memory of 37,715,968 bytes and 6.888941 CPU seconds.

Only basic was measured on the native provider. The smaller local arm64
diagnostic failed; local architecture and emulation results do not establish
the smallest passing Linux amd64 provider tier.

## Provider usage and diagnostics

Container analytics cover 02:28 through 02:37 UTC. The usage dataset recorded
13.36 billed CPU seconds, about 100.004 allocated GiB-seconds of memory,
400.016 allocated GB-seconds of disk and 91,491 transmitted bytes. Memory and
disk billing use allocations, rather than the much smaller observed workload
RSS. Usage and workload CPU are separate provider measurements.

The Worker/D1/DO lifecycle query covers 00:00 through 03:02 UTC:

| Metric | Observed value |
| --- | ---: |
| Worker requests / CPU / errors | 10 / 24,945 microseconds / 0 |
| Worker CPU p95 and p99 | 3,851 microseconds |
| DO requests / reported errors | 90 / 8 |
| DO active time / CPU | 120.098096 / 0.544812 seconds |
| DO duration | 15.372556288 GB-seconds |
| DO SQL rows read / written | 2,120 / 390 |
| Maximum recorded DO stored bytes | 102,400 |
| D1 rows read / written | 2,374 / 374 |
| Maximum recorded D1 database bytes | 651,264 |

DO telemetry reported no exceeded-CPU, exceeded-memory or fatal-internal
errors. The eight reported invocation errors remain visible. Event logs show
eight cancelled alarms and eight corresponding `Activity expired, signalling
container to stop` diagnostics, alongside the successful native jobs. The
diagnostics establish the idle lifecycle context; they do not erase the error
counter or prove other failure paths.

The retained event query returned 106 Worker log events and 31 Container job
events. Adaptive analytics and event logs use different scopes and collection
methods. Their counts are not forced to match. A calculations-view count of
zero was rejected as absence evidence because the events view returned the
known records.

## Cost interpretation

Using the official rates checked on 2026-10-21 UTC, charging the observed
quantities without any shared inclusion and allocating one full started DO
request unit and one full started DO duration unit gives a **partial $12.6514**
sensitivity. The $12.50 duration increment dominates it. SQL rows use their
published per-million rates without rounding each row dimension to a whole
million. The exact line items are in the sanitized measurement record.

This is not an invoice or a complete monthly model. It omits ongoing retained
storage, image registry storage, setup/image operations, taxes and unrelated
account usage. Observed log records are not a complete ingestion meter. Shared
account inclusions and billing increments can change the actual marginal
charge. Do not multiply this small-run total by a game count or claim the
approved $20 monthly proof share has passed.

Sources: [Containers](https://developers.cloudflare.com/containers/platform/pricing/),
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[Workers](https://developers.cloudflare.com/workers/platform/pricing/) and
[logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

## Remaining qualification

- A real provider Game pending timeout and Competition settlement with the
  proof binding, including exactly one rating event.
- Provider failure, restart and lost-reply cases under the original deadline.
- A complete incremental monthly model for 1,000 permanent reservations and
  two attempt credits each, including idle time, retry, all storage and registry
  charges, with no double-counted account inclusion.
- The smallest passing provider tier and all other privacy, abuse, cost,
  capacity, regional and two-person acceptance gates.

The canonical deployment has no proof Container binding and keeps the proof
profile off. This source report does not establish publication of updated live
guides or authorize another provider run.
