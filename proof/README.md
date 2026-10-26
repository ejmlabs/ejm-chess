# Private timeout proof adapter

This image runs the unchanged pinned CHA-Solver analyzer and validates its
answer with pinned python-chess. It has no public chess API. The Worker owns
reservations, durable attempt receipts, credits, retries and final settlement.
An HTTP request to this adapter executes work again, so only that controller
may call it after recording an attempt.

The production target is Linux amd64. `pins.json` records source archives,
checksums, analyzer and Cargo.lock hashes, official base image digests and
versions. The build checks those hashes before compiling. It retains complete
solver and validator sources, crate archives and package notices in the image.
See `NOTICES` and the product's third-party notices before distributing it.

## Protocol

The process listens on port 8080 with one active job. It accepts any forwarded
Host. Only these paths are supported:

| Request | Response |
| --- | --- |
| `GET /ping` | A bounded JSON readiness response. |
| `POST /prove` | The exact private request and result contract in `../src/server/proof-contract.ts`. |

A proof request must have exactly one Content-Length, one `application/json`
Content-Type and no Transfer-Encoding. It must contain at most 131,072 UTF-8
bytes of strict JSON. Duplicate JSON fields, extra fields, non-finite constants
and malformed envelopes return 422. Oversized bodies return 413. These errors
have no proof body. Valid envelopes with bad history or digests return 200 with
the checked identity and an unknown result. Responses use `Cache-Control:
no-store` and contain at most 16,384 bytes.

The helper reconstructs every retained move from the legal canonical initial
FEN. It checks the final FEN, surviving side, policy and both digests. It rejects
history that already ended. It then passes only `<FEN> <white|black>\n` on stdin
to the fixed native executable. No caller supplies a path, shell, options,
variant or engine commands.

A native positive answer needs a legal mating witness of at most 512 plies.
Independent replay honors automatic online threefold and 50-move draws, with
checkmate precedence. Failed validation stays unknown. It never becomes an
unsupported negative proof. A supported native negative answer permits a draw.

## Bounds

The HTTP parent starts a fresh helper process for each job. The helper starts
the fixed native executable. Each child has a separate one-CPU-second hard
limit and a 128 MiB address-space limit. One outer watchdog covers the complete
helper and native work for two wall seconds, or the earlier original expiry.
Native stdout is capped at 16 KiB and stderr at 4 KiB while reading. A limit or
cancelled connection kills the whole process group. Linux parent-death signals
also cover an HTTP parent or helper crash.

These process limits do not describe total Container memory or CPU. The host
must enforce its own tier bounds. An underpowered tier returns unknown and
fails qualification. The controller must preserve the original 30-second Game
deadline through queueing, startup, retries and restarts. The configured
Container lifecycle owns idle sleep.

The image runs as uid/gid 65532. The local checks below use no network, a
read-only root, dropped capabilities and a bounded temporary filesystem for the
qualification harness's logs. Build-time bytecode caches cover only the
adapter's import chain, so jobs do not reparse those modules or write caches.

## Build and qualify on native Linux amd64

Run from the product repository root. The Docker build context is `proof/`.
The default target and named `runtime` target both start the private server.

```sh
docker build --platform linux/amd64 --target runtime -t ejm-chess-proof:local proof
docker build --platform linux/amd64 --target qualification -t ejm-chess-proof-qualification:local proof
docker run --rm --platform linux/amd64 --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=4m,mode=1777 \
  --memory 128m --cpus 1 --pids-limit 32 --cap-drop ALL \
  --security-opt no-new-privileges ejm-chess-proof-qualification:local
```

The tests protect strict HTTP framing, digest and history binding, move
legality, the surviving side, automatic draws, witness bounds, mate precedence,
CPU, address space, wall and output limits, cancellation, failed startup and
the parent-death chain. They do not prove provider startup or settlement.

Run the licensed synthetic corpus at the candidate host tier. For example,
this command measures the local shape of Cloudflare basic:

```sh
docker run --rm --platform linux/amd64 --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=4m,mode=1777 \
  --memory 1g --cpus 0.25 --pids-limit 32 --cap-drop ALL \
  --security-opt no-new-privileges ejm-chess-proof-qualification:local \
  python measure.py
```

`measure.py` prints bounded JSON and exits nonzero if an expected answer fails.
It checks 27 fixtures, then restarts the Python parent and submits four
simultaneous ordinary flags. The server handles them in sequence. Each request
retains its own original 30-second deadline. The output separates cold-process
readiness, active job time and queue age. It does not start four native jobs in
parallel. Image layers and the Linux VM may already be warm.

The corpus includes both surviving sides, starting and middlegame flags, a
complete original cooperative endgame history, castling, en passant,
underpromotion, bare king, two knights, bishop versus knight, blocked walls and
draw boundaries. C14/C15 require real native mating witnesses rejected by
independent online-draw validation as `unknown`/`invalid-witness`. G07 requires
both exact solver-child kill evidence and its native attempt receipt showing
`unknown`/`resource-limit`. A kill or technical void alone does not establish
that reason. Native `undetermined` parser coverage is synthetic. No genuine
native `undetermined` fixture is retained or claimed executed; record that gap
and add a genuine fixture if found. Preserve the production `solver-undetermined`
mapping. Injected results and other unknown reasons cannot substitute for native
evidence. All other qualification gates remain required.

## Read local evidence correctly

`measurements/` retains exact commands, timestamps, logs and the additional
native arm64 build pins used on the local Apple Silicon host. That arm64 build
changes only official base architecture digests and the toolchain notice path.
Its solver and adapter sources are the same. It is additional local evidence.
The production Dockerfile and pins remain amd64.

amd64 emulation on an arm64 host can consume the fixed CPU allowance or alter
address-space behavior. An emulated run that returns correct unknowns is not a
passing ordinary-flag qualification. Do not increase the fixed limits to make
such a run pass.

Parent metrics contain no FEN, moves, player IDs or request IDs. They report
queue age, active wall time and cumulative-child CPU deltas. Completed helper
and native metrics add per-process CPU and RSS high-water values, including
pre-exec work. Killed jobs may lack those completed-process metrics. Container
cgroup CPU and peak memory cover the whole local harness, including its client
and parent processes. `childLifetimeMaxRssBytes` is a lifetime high-water mark,
not an allocation sum or a fresh per-job peak.

No local run proves a provider tier, production readiness, durable receipts,
once-only settlement or a complete cost model. The exact deployed amd64 image
must pass through the private Worker binding, including the serialized burst,
allowed retry and failure races, before enabling the proof profile.

Financial adoption does not qualify that run. The current policy uses one $100
monthly spending target, with usage alerts and an emergency stop. It replaces per-service allocations and repeated financial approvals.
Retain immutable source and provider evidence. Older financial records stay
bound to the private measurement identity as historical protocol records.
See [the private review records](../docs/timeout-proofs.md#separate-financial-source-and-provider-gates)
and [budget controls](../docs/cloudflare-budget.md).
The checked-in acceptance template stays unarmed with pending records and null
hashes; a later provider report references the unchanged measurement identity.
