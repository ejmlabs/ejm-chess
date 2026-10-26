# Chess by ejmlabs

A multiplayer chess game for `chess.ejmlabs.com`, built for
Cloudflare Workers. The board, clocks, and moves are the main interface. All routes use the public
shared ejm-ui design, including account, replay and private review workflows.

## Status

This repository restores the retained chess implementation and its OpenSpec
plan for source review. It includes a partial, unverified capacity diagnostic
patch. Restoration does not establish a current build, deployment, public
launch or supported capacity. Start with the
[OpenSpec handoff](openspec/HANDOFF.md) and
[source and configuration recovery notes](docs/source-handoff.md).

The [deployment guide](docs/deployment.md) records historical protected-host
evidence. Feature flags open only with the corresponding qualification and
player checks in [the operations guide](docs/operations.md).

The game includes casual invitations, authoritative game state and clocks,
versioned commands, username/password player accounts, separate blitz and
rapid competition pools, Glicko-2 settlement, private history and interactive replays, a chess brand family,
and unattended opt-in tournament previews. Private fair-play tools remain optional. It also includes labelled, unrated browser Stockfish practice and a private, disabled-by-default postgame analysis pipeline.
The board offers a remembered Show legal moves toggle, on by default, with
legal destination dots and capture rings when selecting a piece on your turn.
Source code is not evidence of public availability or load capacity.
See the [verification record](docs/verification.md) for the local and provider checks actually run.
The [local capacity qualification](docs/local-qualification.md) separates native
game, socket and three-event evidence from synthetic settlement and public
release gates.
The [local full-workload runner](docs/capacity-local-rehearsal.md) uses real
clocks and loopback transport. It cannot qualify provider capacity or costs.

Known limits:

- New games require a username/password account. Recovery email is optional, including for competition. Any supplied address is private and used only for verification and password recovery, with no marketing. Skipping email means a lost password cannot be reset by email. Local development disables email delivery but supports password signup/signin and casual play. Real verification and recovery delivery passed for one approved recipient in the protected preview. This does not establish broad deliverability. See [accounts](docs/accounts.md).
- A timeout draws when the rules library proves insufficient material or the
  player with time left has only a king. Other timeout positions need adjudication.
  Pending results do not settle ratings and become technical voids after 30 seconds under the unattended v2 policy. A separate default-off v3 ranked timeout-proof path is implemented; native/provider qualification and all launch gates remain required. See [private timeout proofs](docs/timeout-proofs.md).
- Browser chess cannot guarantee cheat prevention. Engine screening, thresholds,
  objective abuse controls, privacy, and rating corrections need validation before ranked launch. Reports are informational in unattended mode; there is no automatic cheating conviction.
- Computer practice runs Stockfish on the player's device with four named strengths, without model APIs or tokens. Strength depends on the device and search budget; no Elo is claimed. Computer games never affect ratings or human fair play screening.
- Round-robin events support three or four players. Timed arenas use paged standings and explicit queue/pause controls. Their release configuration and qualification record state the current entrant and game limits; configuration ceilings alone do not prove capacity.
- The Stockfish image and bounded pipeline passed local checks. Three amd64
  emulation resource fixtures took about 12 to 16 seconds at one CPU and peaked
  near 318 MiB. A quarter-CPU job timed out. Deployed native limits and costs
  remain unverified; these figures are not a public throughput claim.
- Isolated native D1 and Game/Competition restoration, correction replay,
  tombstone recovery, undo and saved account-closure reapplication passed the
  recorded synthetic drills. Production restoration, service-wide recovery
  objectives, worldwide latency, public capacity and complete operating costs
  remain unverified.
- No public chat, spectator mode, teaching mode, or live engine evaluation is included.

## Local setup

Use Node 24. The repository declares public `@ejm/*` packages through portable
sibling `file:../ejm-ui/packages/<package>` dependencies in the manifest and
lockfile. Use the matching retained shared source described in the
[source handoff](docs/source-handoff.md#shared-ui-dependency). A package version
alone does not identify the unpublished owner changes this source consumed:

```text
workspace/
  ejm-ui/
  ejm-chess/
```

Install the sibling workspace with its lockfile, then this product:

```sh
cd ../ejm-ui
npm ci
cd ../ejm-chess
npm ci
```

If the shared token outputs are absent, run the token build in `ejm-ui` before
building the product. Do not import private sibling source or copy shared components.

The private Wrangler configurations are excluded from this source handoff.
Restore reviewed local bindings as described in the
[source handoff](docs/source-handoff.md#configuration-gap), then follow
[the local operations steps](docs/operations.md#local-preview) to configure the
explicit loopback environment and apply local migrations. Only then run:

```sh
npm run dev
```

The development command builds static routes before starting Wrangler. Restart
it after changing frontend source. A production sign-in secret must never be
used for this local environment.

## Checks

```sh
npm run typecheck
npm test
npm run engine:check
npm run engine:probe
npm run build
npm run worker:check
npm run budget
```

`npm test` runs the native workerd suite, then the Node load-driver suite.
Use `npm run test:worker -- test/game.test.ts` for a focused Worker check or
`npm run test:driver` for the driver alone. The driver tests use local fixtures
and a loopback WebSocket probe; they do not generate provider load.

Run the optional local capacity phases with `npm run qualify:local`,
`npm run qualify:local -- --three-events`, or
`npm run qualify:local -- --sustained`. Add `--quick` for smoke checks. The full
sustained phase takes 15 elapsed minutes. Read its
[methods and limits](docs/local-qualification.md) before interpreting results.

Worker tests and the Worker dry run require the omitted Wrangler configuration;
recovery tests also require the recovery-drill configuration. These commands
are documented entry points, not new passing results for this restored source.
The Worker check is a dry run. It does not prove bindings, email, Access,
Turnstile, DNS, or production behavior. Budget checks enforce the configured
compressed build limits. Do not claim a performance improvement from a budget pass.

`engine:check` checks the vendored browser runtime, source, network, and notices
against their pins. `engine:probe` starts the real engine in Node and checks a
legal reply at all four strengths; it does not measure a phone or browser.
If a pinned input is missing, `npm run engine:fetch` restores it from its
recorded upstream URL. Keep the source and license files with any distribution.

## Ownership and dependencies

| Owner | Responsibility |
| --- | --- |
| `ejm-chess` | Rules, game commands, clocks, invitations, matchmaking, ratings, history, account policy, and fair play composition |
| `ejm-ui` | Every visual primitive, including board and clock surfaces, shared tokens, fonts, site shell, prerendering, headers, and project registry contracts |
| `ejmlabs` | Studio content and public project discovery |

All pages, guides, game surfaces, fields, actions, tables, disclosures, and
states compose public ejm-ui exports. Shared application recipes also own
widths, spacing, forms, game columns and move lists. The product stylesheet
only imports public UI styles. The public `ejmSite` build guard rejects local visual
classes, inline styles and CSS rules. Native semantic HTML retains labels and
validation inside those recipes.
The kit owns maintained cm-chessboard rendering and input; chess owns legality,
clock estimation, and authoritative commands. Static guides keep prose in HTML
through the shared prerender boundary.

Dependency direction is `ejm-chess` to public `@ejm/*` exports. Shared packages
must not depend on this product. No agent harness runtime is needed. The chess
entry remains outside shared project discovery while public play is closed.

Maintained packages provide chess rules (`chess.js`), board interaction
(`cm-chessboard`), tournament pairing and standings (`@echecs/round-robin` and `@echecs/tournament`), accounts (`better-auth`), Glicko-2 calculations (`glicko2`),
Access JWT verification (`jose`), and Container lifecycle (`@cloudflare/containers`).
The optional analysis image uses pinned Stockfish and python-chess with retained
source and notices. The maintained Stockfish 19.0.1 lite single-thread browser port is vendored as separate lazy assets with corresponding source and GPL notices. It is absent from initial human-play downloads and the Worker bundle.
The separate default-off timeout proof image uses pinned CHA-Solver and
python-chess. Its production binding belongs to a fresh private service after
qualification. Cloudflare platform
services provide the runtime and storage.
See [third-party notices](THIRD_PARTY_NOTICES.md) for image obligations and the
separate piece-art license.

## Documentation

- [OpenSpec continuation and remaining tasks](openspec/HANDOFF.md)
- [Source restoration, dependency binding and configuration gaps](docs/source-handoff.md)
- [Architecture and interfaces](docs/architecture.md)
- [Operations, recovery, and launch gates](docs/operations.md)
- [Cloudflare provisioning and deployment runbook](docs/deployment.md)
- [Monthly budget, stops, and billing-alert setup](docs/cloudflare-budget.md)
- [Fair play and unattended limits](docs/fair-play.md)
- [Account export, closure, privacy and retention](docs/privacy.md)
- [Automatic tournaments, schedules, points, and limits](docs/tournaments.md)
- [Timed arena design and capacity targets](docs/arena-design.md)
- [Local arena, socket, retirement and settlement qualification](docs/local-qualification.md)
- [Private match replays](docs/replays.md)
- [Stockfish practice, difficulty, recovery, and privacy](docs/ai-opponents.md)
- [Private analysis contract, measurements, and cost estimate](docs/analysis.md)
- [Adjudication candidate and remaining accuracy gates](docs/adjudication-feasibility.md)
- [Private timeout proofs, limits and qualification](docs/timeout-proofs.md)
- Public routes: `/help/`, `/rules/`, `/fair-play/`, `/privacy/`,
  `/docs/developer-guide/`, and `/credits/`

Product guides, implementation and the migrated OpenSpec plan live here.
Shared UI guides and public visual contracts belong in `ejm-ui`; Studio discovery
belongs in `ejmlabs`. The owner's 2026-10-26 repository correction makes this
local OpenSpec root authoritative for chess continuation. Historical records
that named Studio as the planning home remain dated evidence.
