# Private postgame analysis

## Status and owner

`ejm-chess` owns this pipeline. It uses Cloudflare D1, Queues, a private
Container binding, the maintained Cloudflare Container helper, Stockfish, and
python-chess. It has no harness dependency and adds no browser engine.

The implementation and local checks below are complete. No analysis Container,
Queue, paid plan, or public hostname was provisioned or deployed by this work.
`ANALYSIS_ENABLED=false` is the default. Ranked admission remains closed.
These summaries have not been calibrated to distinguish human play from engine
assistance. They never trigger sanctions or rating changes.

The source accepts completed human games saved under both v2 unattended and
v3 timeout-proof rules, including recovery of reported-game analysis intents.
Screening remains informational and separate from timeout mating proofs. A
previously built analysis image needs rebuilding to accept v3 metadata; this
source change does not enable or deploy that optional service.

## Safe boundary

Only completed human-versus-human games qualify. AI games are excluded during
Queue admission, report recovery, pre-engine validation, and evidence attachment.
The browser cannot submit a PGN, FEN, engine path, UCI command, search budget,
or evaluation to the analyzer.

A Queue job contains exactly these fields:

```json
{
  "gameId": "d66cf801-96e4-42f4-955f-743f12b142fb",
  "resultVersion": 1,
  "rulesVersion": "online-2026-10-v4-unattended",
  "priority": "report",
  "engineVersion": "stockfish-17.1",
  "profileVersion": "screen-v1"
}
```

Game IDs must be UUIDv4. Result versions must be positive safe integers no
greater than 1,000,000. Unknown fields and versions are rejected. Before an
engine attempt, the consumer reads the stored server game, requires a finished
result with matching result and rules versions, and uses chess.js to rebuild a
standard-start PGN. Account names, headers, comments, variations, and custom
starting positions do not cross the engine boundary. PGN is limited to 16 KiB
and 2 to 512 plies.
Historical v1 games remain available for private replay and settlement recovery,
but this version of the optional analyzer accepts only the current v2 profile.

The private binding accepts only `POST http://analysis.internal/analyze`.
The public Worker has no forwarding route to it. The Container has outbound
internet disabled and one active request at a time. Use the single named
instance `screen-v1-singleton` and a deployment limit of one instance. Do not
bind this service to a public Container route.

## Durable work and recovery

1. Competition retains a durable projection/analysis outbox. Only exact
   `ANALYSIS_ENABLED=true` adds eligible completed rated games at the lower
   `sample` priority. Disabled or missing configuration projects results and
   drains the outbox without a Queue binding or a new sample intent. When
   enabled, each eligible result enters the bounded backlog; this is not a
   randomized game sample. Missing or failed Queue delivery retains the
   enabled intent for retry.
2. A participant report leaves `fairplay_reports.analysis_requested_at` empty
   until its D1 analysis intent is accepted. The minute job scans up to 20
   pending report games, so a lost request or absent Queue does not lose a report.
3. The Queue consumer stores D1 intent before acknowledging a message. The
   identity is game, result version, rules version, engine version, and profile.
   Redelivery cannot create another job. An open report raises an existing job's
   priority. Expired report cases cannot request new report-priority work.
4. One drain processes one due job. A 90-second global D1 lease and the named
   Container prevent normal overlap. An expired lease can be reclaimed after a
   crash. Reports precede samples among due stored jobs.
5. An atomic UTC-day reservation charges each engine attempt before execution.
   Engine failures retry after 30 then 60 seconds, up to three attempts. Work
   older than seven days is rejected. Queued work survives a disabled analyzer
   or an exhausted daily budget.
6. A successful bounded summary is stored before evidence delivery. Evidence
   delivery retries use the saved summary, including after the third engine
   attempt, without another engine charge. Duplicate evidence is ignored.

The backlog contains at most 5,000 jobs. When full, valid Queue deliveries retry
after ten minutes and report intents remain available for reconciliation.
Invalid messages and permanently failed jobs leave metadata-only D1 dead letters.
The optional dead-letter Queue receives at most ten notices per cleanup call.
Its consumer must be an operator inspection/recovery flow, not this Worker's
analysis Queue handler. Failed notice delivery leaves `notified_at` empty.

The minute schedule repairs report intents and drains work. Daily cleanup removes
completed/dead jobs and dead letters after 30 days and old daily counters after
31 days. Case evidence has its separate 90-day retention and appeal holds. In unattended
operation, eligible open reports close after seven days through bounded daily
cleanup without a finding. Late saved summaries do not reopen these cases, add
case evidence or extend retention; existing private job records keep their
own cleanup policy.
These cleanup jobs do not erase decisions, audit events, or private review notes.
Pending appeals close without a review outcome after 14 days. That expiry
does not overturn a decision or repair ratings. Human case actions are disabled
unless `OPERATION_MODE=reviewed`; an engine summary cannot enable them.

### Operator actions

- To stop compute and new automatic sample intents, set `ANALYSIS_ENABLED=false`.
  Competition then drains older projection rows without delivering their
  optional sample step. Enabling analysis later does not backfill those games.
  Already accepted Queue/D1 jobs, report intents and results remain intact;
  stored engine jobs wait for analysis to resume. Closing ranked admission is
  a separate control.
- Inspect counts by `status`, oldest pending age, `last_error`, daily attempts,
  expired `running` leases, unnotified dead letters, and Competition outbox age.
- Restore a failed binding or image first. The minute drain reclaims an expired
  lease and resumes due work. Do not clear an unexpired lease or daily counters.
- Review each dead letter before retrying it. A reviewed maintenance change may
  restore a specific failed job within the seven-day window, using the same
  pinned identity and current daily budget. There is no public requeue endpoint.
- Invalid, stale, live, AI, and mismatched-version games must not be restored to
  engine work. A changed engine/profile needs a new versioned job identity.
- Watch the 5,000-row cap. A default 20 attempts per day is a small canary bound,
  not capacity for a busy public service. Raise it only after cost and review
  capacity are measured and approved.

## Fixed engine profile

| Control | Bound |
| --- | --- |
| Engine | Official Stockfish 17.1, portable Linux x86-64 release |
| Search | One thread, 32 MiB hash, one PV, no pondering or tablebases |
| Positions | Up to 24 deterministic spread positions after the first eight plies |
| Forced moves | Counted separately and excluded from analyzed candidates |
| Each position | Best-move search and played-root-move search |
| Each search | At most 20,000 nodes or 150 ms, with engine check granularity |
| Startup/command allowance | python-chess timeout of 10 seconds, inside the job deadline |
| Child limits | 384 MiB address space, 20/21 CPU seconds, 64 file descriptors, 16 KiB file output |
| Hard deadline | 25 seconds, then kill the job's full process group |
| Binding request | 45-second abort; Container instance/port readiness each limited to ten seconds |
| HTTP input/output | At most 32 KiB input and 4 KiB output |
| Stored summary | At most 24 positions, 1.5 million reported nodes, 25 seconds, 4 KiB |

The summary stores each side's move count, sampled count, forced count, mean
centipawn loss capped at 1,000, and agreement with the engine's first move.
It drops raw variations and arbitrary fields. Only the reported subject's side
is attached to that person's open or appeal-open case. A cached result can attach
to a later report. No probability of cheating or automated accuracy cutoff exists.

The time limit means results can vary with available CPU. Pins, stored inputs,
and the profile make the method inspectable; they do not promise identical
scores across hardware or turn these shallow summaries into proof of cheating.

## Pins and source obligations

`analysis/locks.json` pins the official release archive, source archive, embedded
NNUE hashes, and python-chess source archive. The build extracts only named
regular files and verifies SHA-256 before use. It uses Stockfish's own
`export_net` command to verify both embedded networks. Runtime downloads are
disabled. `requirements*.txt` pin Python package hashes.

- Stockfish tag `sf_17.1`, source commit
  `03e27488f3d21d8ff4dbf3065603afa21dbd0ef3`.
- NNUE networks `nn-1c0000000000.nnue` and `nn-37f18f62d772.nnue`, with full
  hashes in the lock file.
- `chess==1.11.2` supplies maintained PGN parsing and UCI transport.
- Python 3.13.16 slim-bookworm amd64 base manifest is pinned by digest in the
  Dockerfile. Runtime uses UID/GID 65532.
- `@cloudflare/containers==0.3.7` supplies the platform lifecycle adapter.

Stockfish uses GPLv3. The Python chess package uses GPLv3 or later. Their
corresponding unmodified source archives are retained under `/opt/source` in
the runtime image; Stockfish's AUTHORS and COPYING are under `/opt/stockfish`.
Retain the full image, build scripts, source archives, and applicable notices
when distributing the image. A public image release needs a source-availability
review. Neither component is imported into the browser or Worker bundle.
See [third-party notices](../THIRD_PARTY_NOTICES.md).

## Reproduce local checks

```sh
docker build --platform linux/amd64 -t ejm-chess-analysis:local analysis
docker build --platform linux/amd64 --network=none \
  -f analysis/Dockerfile.verify -t ejm-chess-analysis-verify:local analysis
docker run --rm --platform linux/amd64 --memory=512m --cpus=1 \
  --pids-limit=32 --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --env RUN_ENGINE_TESTS=1 \
  ejm-chess-analysis-verify:local
docker run --rm --platform linux/amd64 --memory=512m --cpus=1 \
  --pids-limit=32 --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --entrypoint python \
  ejm-chess-analysis-verify:local benchmark.py
npx vitest run test/analysis.test.ts
```

Builds fetch public, hash-pinned assets. The verification image is local tooling;
the runtime image contains neither test files nor the experimental solver.
The final Python suite passed all four tests, including a real loopback HTTP
request that verifies an engine timeout returns 504 instead of an input error.

## Local measurements, 2026-10-20

Hardware was an M4 Pro Mac running Colima's Linux aarch64 VM, with four VM CPUs
and 4,094,013,440 bytes of VM memory. The image was Linux amd64 under emulation.
Tests used one CPU and a 512 MiB cgroup limit. The engine used its smaller
384 MiB child address-space limit. No network or public port was enabled.

| Historical resource fixture | Sampled positions | Nodes | Job wall time |
| --- | --- | --- | --- |
| Opera, 1858 | 24 | 219,938 | 11.693 s |
| Immortal, 1851 | 24 | 228,783 | 11.794 s |
| Evergreen, 1852 | 24 | 249,163 | 15.579 s |

Mean job wall time was 13.022 seconds. Total child CPU was 38.876 seconds for
three jobs. Maximum child RSS was 291,753,984 bytes; cgroup peak was 333,664,256
bytes, about 318 MiB. These are three small resource fixtures, not a detection
dataset or a test of 512-ply worst cases. The test image overlaid the current
runner on the pinned runtime. The final runtime was also rebuilt successfully.
Raw measurements are in `analysis/measurements/`.

The rebuilt runtime image ID was
`sha256:f67454222e5976939c78e82c99f7496048d347b44b61471342f958edc657b4ec`,
with Docker-reported size 117,750,727 bytes and user `65532:65532`. The small
metadata record is `analysis/measurements/image-inspect.json`. This local tag
and image ID are evidence of a build, not a registry publication.

At one quarter of a CPU, a valid job reached the 25-second hard deadline.
The fixed startup allowance did not resolve that limit. A native macOS probe
using host Python 3.15 also failed its earlier UCI startup deadline; the supported
target image uses Python 3.13.16. Neither failure is a successful throughput test.
The 256 MiB `lite` tier is too small for the measured peak. `basic` has enough
provisioned memory but its quarter-CPU throughput has not passed locally.

One CPU could process about 276 of these jobs per hour if continuously busy,
before orchestration overhead. The current scheduled drain admits one per
minute, and the daily default limits attempts to 20. None of these figures is
a Cloudflare capacity or worldwide performance claim.

## Cost estimate and remaining gates

[Cloudflare's Container pricing](https://developers.cloudflare.com/containers/platform/pricing/),
read on 2026-10-20, lists Workers Paid at $5/month with 25 GiB-hours of memory,
375 vCPU-minutes, and 200 GB-hours of disk included. Additional running usage
costs $0.0000025/GiB-second of provisioned memory, $0.000020/active vCPU-second,
and $0.00000007/GB-second of provisioned disk. Billing stops after sleep.

For the one-CPU `standard-2` tier, provisioned memory is 6 GiB and disk is 12 GB.
Using the measured mean, plus ten seconds of idle sleep for every isolated job:

```text
per job = (13.022 + 10) * (6 * 0.0000025 + 12 * 0.00000007)
        + 12.9586 * 0.000020
        = about $0.000624
1,000 such isolated jobs = about $0.62 before included allowances
```

This is a marginal resource estimate, not a bill forecast or purchase approval.
It excludes cold starts, Python/server overhead, DO, Queues, D1, egress, other
account use, and the shared paid-plan base. Emulation and native provider CPU
costs differ. The attempt cap bounds work, not the exact provider dollar charge.

Before enabling analysis, approve the resource/spending scope, configure a
private one-instance binding, and measure native deployed cold starts, CPU,
memory, timeout rate, queue lag, and real costs. Then evaluate representative
authorized human games and controlled assistance examples, estimate review
capacity, and verify reports, appeals, privacy, and recovery. Ranked play stays
closed until those launch gates pass.
