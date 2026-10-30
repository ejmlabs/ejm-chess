# Adjudication feasibility

This report records completed feasibility work. The separate default-off
[private native adoption](timeout-proofs.md) implements a stricter executable
contract and has its own local/provider qualification gate. None of the probe
results below alone qualifies that profile or enables ranked play.

## Decision and scope

Use `online-2026-10-v4-unattended` (v2 and v1 games keep their recorded version) and keep ranked admission closed. chess.js remains the live
rules package. CHA-Solver is a promising maintained candidate for proving
side-specific mating possibility, but this work adds no production solver and
does not claim complete FIDE adjudication.

The narrow native and WebAssembly probes below succeeded. They do not establish
a bound for arbitrary legal positions, Worker deployment compatibility, or safe
automatic promotion of pending results to rated wins. The current durable game
policy scores a timeout at once as a win for the surviving side when it has
more than a bare king, otherwise as a draw. A ranked proof game may wait up to
30 seconds for a private proof first. A stored tournament cutoff can void an
unfinished game earlier.

`ejm-chess` owns these product rules and experimental probes. No shared UI or
harness contract changes. The probe is outside runtime imports and the Container
build context. See [architecture](architecture.md) for the current live policy.

## Package gap

chess.js 1.4.0 supplies legal moves, full-history repetition, the fifty-move
counter, checkmate, stalemate, and a limited material-based draw test. Its
`isInsufficientMaterial()` predicate is not a general dead-position proof and
does not answer whether a specified side can ever mate with cooperation.

The implemented online policy draws threefold repetition and the fifty-move
boundary automatically, without an over-the-board claim. Timeout adjudication
draws when the rules library proves insufficient material or the surviving side
has only a king. Otherwise the player who ran out loses, so a fully blocked
position with no possible mate is scored wrongly unless a ranked proof shows the
draw. Alarm and scheduled recovery use the stored deadline; late execution does
not invent extra thinking time. This is not full FIDE timeout adjudication and
needs explicit competitive acceptance before ranked admission opens.
See `src/server/adjudication.ts`, `test/game.test.ts`, and the public `/rules/`
route for the versioned contract and its existing regression fixtures.

A forceable win is a different question from possible mate. Two knights against
a bare king can produce a cooperative mate. A bishop can also mate when the
other side's material helps block its own king. A blocked pawn wall can prevent
one side from mating while allowing the other. A simple piece-count cutoff
would misclassify these positions.

## Pinned candidate

[CHA-Solver](https://github.com/miguel-ambrona/chasolver), version 3.0.0, commit
`3484c7e65247003fac8705a9290dc2b5d0978b94`, uses MIT licensing. The inspected
revision declares Rust 2021, MSRV 1.82, chess 3.2, and rustc-hash 2.1. The
experimental probe retains a Cargo lockfile. It uses the public APIs:

```rust
winnability(&Board, Color) -> Option<Winnability>
is_unwinnable_fast(&Board, Color) -> bool
```

`Some(Winnable)` supplies a helpmate witness. `Some(Unwinnable)` is a proof that
the intended winner cannot mate. `None` is unknown. The fast API's `true` is an
unwinnability proof; `false` is inconclusive, not permission to award a win.

The public API does not accept a caller node, memory, fuel, or wall-time budget.
The inspected full search has multiple phases, searches to depth 128, and its
final phase allows `1 << 24` nodes with growing hash tables. Upstream reports
33 microseconds average and 930 milliseconds worst-case native time over a
10-million-game sample on an Intel Xeon w3-2435. Those are upstream results,
not measurements of this product or a universal bound. Upstream explicitly
states that completeness is not proved in theory.

## Fixture evidence

`analysis/adjudication/fixtures.json` contains eight positions, each tested for
both intended winners. Blocked-wall positions credit the pinned upstream
README and `tests/positions.txt`. Positive native witnesses were replayed with
the independent maintained python-chess rules package and ended in checkmate
by the intended winner.

| Fixture | White full result | Black full result | Why it matters |
| --- | --- | --- | --- |
| Bare kings | Unwinnable | Unwinnable | Basic dead position |
| Bishop versus king | Unwinnable | Unwinnable | Insufficient material |
| Two knights versus king | Winnable | Unwinnable | Possible mate differs from a forced win |
| Bishop versus knight | Winnable | Winnable | Opponent material can permit mate |
| Blocked bishops | Unwinnable | Unwinnable | Dead position beyond a piece-count test |
| Side-specific wall | Winnable | Unwinnable | Timeout depends on the surviving side |
| Complex dead wall | Unwinnable | Unwinnable | Heavy material can still be dead |
| Standard start | Winnable | Winnable | Ordinary legal position |

All 16 full results matched the fixtures. All six positive native witnesses
passed replay. Fast checks returned unknown for the winning side with two
knights, both bishop-versus-knight sides, the winning side of the asymmetric
wall, and both starting-position sides. These are concrete unknown verdict
fixtures. No full-search `None` occurred in this small set; that is not evidence
that `None` can be ignored. Existing game regressions keep uncertain timeouts
unrated. Repetition, history reconstruction, and fifty-move-boundary coverage
remain in the product game suite, not this position-only solver probe.

## Local measurements, 2026-10-20

Host: M4 Pro, macOS 26.5.2 arm64. Native build used Homebrew rustc 1.99.1 with
two build jobs. The unchanged upstream `analyzer` example built in 22.60 seconds.
Its binary was 1,428,960 bytes. Across 16 one-process queries, the maximum child
RSS was 3,293,184 bytes. CPU per query ranged from 1.481 to 3.188 ms. The first
process launch took 273.603 ms wall; later calls took 2.408 to 5.033 ms, including
process launch and output validation. Each subprocess had an external two-second
deadline. These fixtures did not reach it.

The library passed `cargo check --lib --target wasm32-unknown-unknown` under
rustc 1.88.0. An experimental numeric fixture ABI built to a 1,036,913-byte
WebAssembly module. It has no production FEN/input ABI. Node 24.19.0 V8 ran each
fixture in a fresh instance and process, with a two-second external deadline:

| Measurement | Observed range or maximum |
| --- | --- |
| Module instantiation | 0.415 to 3.579 ms |
| Full fixture call wall time | 0.835 to 5.198 ms |
| Full call process CPU | At most 10.561 ms |
| Fast fixture call wall time | 0.760 to 1.014 ms |
| Linear memory after calls | At most 2,883,584 bytes |
| Node process peak RSS | At most 58,656 KiB, including Node/V8 |

Raw results and probe source are under `analysis/adjudication/` and
`analysis/measurements/chasolver-*.json`. No WebAssembly binary is committed,
served, imported by the Worker, or added to the analysis Container.
Node V8 is compatibility evidence, not a workerd CPU or memory measurement.
No deployed Cloudflare Container adjudication was tested.

## Reproduce

```sh
git clone https://github.com/miguel-ambrona/chasolver /tmp/chasolver-check
git -C /tmp/chasolver-check checkout 3484c7e65247003fac8705a9290dc2b5d0978b94
cargo build --manifest-path /tmp/chasolver-check/Cargo.toml --release --example analyzer
python analysis/adjudication/probe.py /tmp/chasolver-check/target/release/examples/analyzer
rustup target add wasm32-unknown-unknown
cargo build --manifest-path analysis/adjudication/wasm-probe/Cargo.toml \
  --locked --release --target wasm32-unknown-unknown
python analysis/adjudication/probe_wasm.py \
  analysis/adjudication/wasm-probe/target/wasm32-unknown-unknown/release/ejm_adjudication_feasibility.wasm
```

Use Python with the hash-pinned `chess==1.11.2` dependency for native witness
validation, Node 24, and a matching Rust compiler and installed target. The
local machine had two Rust installations; selecting a target through rustup
alone did not select that compiler. The successful WASM build explicitly used
the rustup 1.88 compiler and Cargo. That setup failure was not a solver defect.

## Adoption and cost gates

Do not run the unbounded full search inside the game move/clock transaction.
Its public API cannot enforce this product's 50 ms Worker CPU budget. The fast
proof API may fit a later bounded Worker adapter, with unknown preserved, but
that needs real workerd limits, legal-FEN validation, witness handling, history
semantics, and adversarial tests before adoption.

A private Container could impose process memory, CPU, and wall limits around
the full package. Budget expiry must return unknown and leave the durable
adjudication request recoverable. Use a separate versioned profile and admission
budget; do not turn postgame screening scores into mating proofs. This work
does not select or deploy that adapter.

At a hypothetical 0.1 active CPU-second per adjudication, 1,000 requests would
use $0.002 in marginal CPU at the current $0.000020/vCPU-second rate. Provisioned
memory/disk while running, cold starts, ten-second sleep, DO/D1/Queue usage,
the paid-plan base, included allowances, and real worst cases change that cost.
This example is arithmetic, not measured provider use. See the measured
[analysis cost method](analysis.md#cost-estimate-and-remaining-gates).

Before ranked launch: resolve the versioned rule policy, test position history
and fifty-move boundaries with any solver, measure workerd or private Container
limits on a representative difficult corpus, verify unknown/retry/technical-void
handling and automatic recovery, review licenses/source obligations, and run the
deployed two-player acceptance flow. A fast result on eight positions does not
complete these gates.
