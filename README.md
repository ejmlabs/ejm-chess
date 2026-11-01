# Chess by ejmlabs

Chess by ejmlabs is a multiplayer chess game that runs on Cloudflare. It uses a
server to manage games, legal moves, clocks and results. The source also
includes computer practice, game replays and competition features.

## Status

A protected preview runs behind Cloudflare Access. Public play is closed.
Ranked games, tournaments, arenas and server analysis are not open to the
public. The source and past preview checks do not establish public capacity
or release readiness. See the [verification record](docs/verification.md) and
[launch gates](docs/operations.md#status-and-authority).

## Features

The source includes:

- Unrated games by invitation, with server-managed moves and clocks.
- Username and password accounts, private game history, replays and PGN export.
- Unrated practice against Stockfish in the browser, with four difficulty settings.
- Separate blitz and rapid ratings, matchmaking and leaderboards, subject to
  the ranked launch gates.
- Unrated round-robin tournaments and timed arenas, subject to release checks.

New games require an account. A recovery email is optional. The app uses it only
for verification and password recovery. Without one, you cannot reset a lost
password by email. See [accounts](docs/accounts.md) and
[computer practice](docs/ai-opponents.md).

The app uses React and TypeScript, the shared [ejm-ui](https://github.com/ejmlabs/ejm-ui)
components, chess.js, Better Auth and Glicko-2. Cloudflare Workers, Durable
Objects and D1 run and store games and accounts. See
[architecture](docs/architecture.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Quick start

You need Node.js 24, npm, the pinned `ejm-ui` source beside this checkout, and
reviewed local Wrangler configuration. The public checkout does not include
`wrangler.jsonc`, so these steps alone cannot start the app. See the
[configuration gap](docs/source-handoff.md#configuration-gap) before creating it.

```sh
git clone https://github.com/ejmlabs/ejm-chess.git
cd ejm-chess
git clone https://github.com/ejmlabs/ejm-ui.git ../ejm-ui
git -C ../ejm-ui checkout "$(node -p "require('./.github/ui-source.json').revision")"
npm --prefix ../ejm-ui ci --ignore-scripts
npm ci --ignore-scripts
```

[`.github/ui-source.json`](.github/ui-source.json) records the revision.
After setting up the local bindings, follow the
[local preview steps](docs/operations.md#local-preview) to set a development
secret and apply migrations, then run:

```sh
npm run dev
```

This builds the site and starts Wrangler. Restart it after frontend changes.
Local mode disables email delivery; use a development-only secret and local
bindings.

## Development

From the repository root:

```sh
npm run typecheck
npm test
npm run build
npm run worker:check
```

`npm test` runs the Worker tests and the Node load-driver tests. Run a focused
Worker test with `npm run test:worker -- test/game.test.ts`, or the driver
alone with `npm run test:driver`. Worker tests and the Worker dry run need
reviewed Wrangler configuration; recovery tests also need the recovery-drill
configuration. See the [source handoff](docs/source-handoff.md#configuration-gap).

The build checks the vendored Stockfish assets. Run `npm run engine:check` to
check them separately, or `npm run engine:probe` to test the engine in Node.
There is no lint script in `package.json`.

For deployment, read the [deployment guide](docs/deployment.md) and
[operations guide](docs/operations.md). A build or dry run does not verify a
live deployment. Ranked admission must stay closed until its launch gates pass.

## Project layout

- `src/`: frontend and Worker source.
- `test/`: Worker and product tests.
- `scripts/`: build, engine and local test tools.
- `migrations/`: D1 migrations.
- `analysis/` and `proof/`: private analysis and timeout proof services.
- `docs/`: product and operations guides.
- `openspec/`: specifications, plans and handoff notes.

## Documentation

- [Architecture](docs/architecture.md)
- [Accounts](docs/accounts.md), [privacy](docs/privacy.md) and [fair play](docs/fair-play.md)
- [Replays](docs/replays.md), [computer practice](docs/ai-opponents.md) and [tournaments](docs/tournaments.md)
- [Operations](docs/operations.md), [deployment](docs/deployment.md) and [verification](docs/verification.md)
- [OpenSpec handoff](openspec/HANDOFF.md) and [current change](openspec/changes/add-cloudflare-chess/)

## Contributing

Issues and pull requests are welcome. Read [AGENTS.md](AGENTS.md) and the
[OpenSpec handoff](openspec/HANDOFF.md) before making changes. Keep unfinished
tasks unchecked, and run the relevant checks for your change. Shared visual
components belong in [ejm-ui](https://github.com/ejmlabs/ejm-ui).

## License

This project is licensed under the [MIT License](LICENSE). Third-party software
and assets have their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
