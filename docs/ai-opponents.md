# Stockfish computer practice

## Status and choice

Computer practice replaces the earlier OpenRouter opponent. Stockfish runs on
the player's device without a model API, provider key, or token charge. The
server still records accepted moves and owns legality, clocks, and results.
See [verification](verification.md) for the recorded build and player checks.

Players do not install an app, extension, or a separate Stockfish program.
Cloudflare serves the pinned engine files with the game. The browser fetches
them automatically when a computer game opens and runs the engine in a worker.
The normal asset transfer is about 1.8 MiB; human games do not load it.
Keep the maintained upstream build rather than forking a second chess engine.

Choose Relaxed, Club, Strong, or Maximum. These are built-in skill settings with
short search budgets, not Elo ratings or a guarantee of calibrated strength.
The device, browser scheduling, and position affect play. Even Maximum is a
bounded browser search rather than an unlimited engine analysis service.

## Player flow

1. Open `/play/`, choose Play Stockfish, and select a strength and clock.
2. Create a username/password account or sign in. You play White. Computer games are unrated.
3. Wait for the engine to load, then select Ready to play.
4. Play using the usual mouse, touch, keyboard, or typed-move controls.
5. Open completed games in private History for replay or PGN download.

Show legal moves below the board is on by default. Pick up or select your piece
on your turn for legal destination dots and capture rings. Switch it off at any
time; the choice is saved in this browser when storage is available. These hints
use chess rules locally and do not ask Stockfish for advice. They are also
available in human games, with no hints for future premoves.

Keep the tab open. Server clocks continue while a tab sleeps, the browser closes,
or the connection drops. If loading or searching fails, choose Retry computer.
Return to the same game link with the same account to recover the authoritative
position. Reconnect rebuilds the search from all accepted moves. An engine
failure does not grant an invented move or win. The published timeout rule
still applies. Draw offers are unavailable in practice.

Computer games are labelled and always unrated. They grant no competitive
rating, qualification, farming evidence, or human engine-use case. A browser can
change its own engine or its legal move proposals, so the selected engine label
is not audited execution provenance. Outside assistance remains forbidden in
live games against people.

## Runtime and resources

The maintained `stockfish@19.0.1` lite single-thread build runs in one classic
Web Worker. Same-host Cloudflare static assets provide its JavaScript and WASM.
The two runtime files total 1,874,201 bytes, about 1.8 MiB, loaded only after a
computer game opens. Human play does not download them. No engine computation
runs in the Cloudflare Worker and no position goes to an inference provider.
Normal Cloudflare game and asset hosting still use infrastructure resources.

| Strength | Stockfish Skill Level | Requested search time |
| --- | --- | --- |
| Relaxed | 0 | 150 ms |
| Club | 6 | 300 ms |
| Strong | 12 | 600 ms |
| Maximum | 20 | 1,200 ms |

Threads=1, Hash=16 MiB, Ponder=false, MultiPV=1, and UCI_LimitStrength=false.
A requested search time is not a hard browser wall-clock promise. The adapter
has a separate bounded deadline and terminates failed workers. The upstream
WASM starts with 128 MiB of memory and can grow; the hash setting does not cap
total browser memory. Modern WebAssembly and Worker support are required.
The worker terminates on game completion, loss of access, disconnect, or unmount.
Startup has a 30-second deadline. Each search has its requested time plus a
five-second deadline. An unanswered game command triggers reconnect after ten
seconds; the same bound covers reconnect while waiting for a fresh snapshot.
The client retries the original command ID so recovery cannot accept it twice.

The browser sends the complete accepted UCI history using `position startpos
moves` so Stockfish retains repetition context. It displays no live engine
scores or suggested human moves. Server validation accepts only the White
owner's versioned Black proposal in their active unrated fixed-build game.
Human, ranked, tournament, stale, and terminal games reject this command. Command
receipts prevent duplicate acceptance after lost acknowledgements.

## Configuration and recovery

`AI_ENABLED=true` enables browser practice without a provider API credential.
Player accounts are still required. The local configuration enables it; the
final public release must also set it explicitly. `AI_ENABLED=false` closes new practice
and ends unfinished practice truthfully on the next authority read, command,
or alarm after ordinary deadline processing. Existing terminal records remain.
Casual account, retained-payload, and permanent-ID admission limits still apply.

Active OpenRouter catalog, inference, key, and quota paths have been removed.
Do not configure `OPENROUTER_API_KEY` or `AI_DAILY_REQUEST_LIMIT`. Old migration
tables and historical AI metadata remain for compatibility, with no provider
requests. An unfinished historical provider game ends without a score when the
new authority encounters it. Finished records remain available privately.

## License and corresponding source

The browser port is maintained by Nathan Rugg and Chess.com under GPL-3.0.
Exact release source revision:
`0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6`.

The served `/engines/stockfish-19.0.1-lite-single/` directory includes:

- `COPYING.txt` and `AUTHORS` with upstream notices.
- `source.tar.gz` for the exact source revision.
- Required network `nn-61e7af4bb97d.nnue`.
- `BUILD.md` with source/network placement and build requirements.
- `PROVENANCE.json` with pins, byte sizes, source URLs, and SHA-256 hashes.

The public `/credits/` route links these files. Preserve this accessible source,
network, build instructions, and license path whenever distributing the engine.
Run `npm run engine:check` to check the pins and `npm run engine:probe` for a real
Node UCI smoke check at all four strengths. `npm run engine:fetch` restores
missing pinned inputs from the recorded upstream URLs. The build runs the pin
check before emitting assets.
The acquisition check verifies pinned assets; bit-for-bit recompilation of the
upstream binary remains unverified. See [third-party notices](../THIRD_PARTY_NOTICES.md).
