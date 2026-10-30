# Standard-game result bounds

This is a source-derived safety bound for the current standard starting
position, automatic draw policy, and bounded human arena admission contract.
It is not a measured capacity result, a new chess rule, or a deployed limit.
The move and byte estimates are source derived. Focused replay tests cover the
parser boundary; they do not measure physical storage or arena capacity.

## Accepted move count

`Game.init` creates `new Chess()` and saves its standard initial FEN. Browser
commands contain squares and an optional promotion piece. They cannot replace
that FEN, add pieces, submit clocks, or choose an outcome. Each accepted move
passes through chess.js and then `positionOutcome`.

There are 16 original pawns. Each can move at most six times before promotion:
every pawn move advances at least one rank, including a capture or en passant.
A first double step reduces that pawn's possible move count. A promoted piece
is no longer a pawn. Thus there are at most `16 * 6 = 96` pawn moves.

The initial position has 32 pieces. Both kings remain on the board. Each
capture removes one piece; promotion changes a piece's type without adding a
piece. Thus there are at most 30 captures. Counting pawn captures in both
groups deliberately overestimates the number of halfmove-clock resets:

```text
resetting moves <= 96 pawn moves + 30 captures = 126
```

chess.js resets its halfmove clock only on a pawn move or capture and reports
the fifty-move draw at 100 halfmoves. The server checks that after every
accepted move. At most 99 quiet halfmoves can precede each resetting move.
After the last reset, at most 100 more halfmoves can be accepted:

```text
accepted plies <= 126 * (99 + 1) + 100 = 12,700
```

Checkmate, stalemate, insufficient material, threefold repetition, resignation,
readiness expiry, clocks, and arena wall deadlines can only end a game sooner.
Checking checkmate before the fifty-move condition does not allow another
move: both outcomes end the game on that same move. This is a conservative
upper bound, not a claim that a 12,700-ply game is attainable.

The shared `MAX_GAME_PLIES` constant expresses this derivation. The Game
authority continues to use its existing chess rules and has no added ply cap.
Revisit the proof if starting positions, piece rules, draw policy, or move
acceptance changes.

## One serialized human arena result

`GameResult` contains PGN and a small terminal digest. It does not contain
`MoveEvent[]`, the full FEN history, command receipts, or socket state. Bound
UTF-8 bytes of `JSON.stringify(result)`, not JavaScript string length.

The arena admission contract supplies UUID game and reservation IDs, account
IDs of at most 128 UTF-16 units, and a fixed server event ID. Use the larger
existing Game event-ID check of 128 ASCII characters for this calculation.
The exact tournament object has only `id`, `format`, `round`, and `deadlineAt`;
arena round is one. Arena results are human and unrated, so provider model
strings and other AI fields are absent.

Game seats slice names to 80 UTF-16 units. New account usernames use at most
24 ASCII characters, and arena display names use 40, but neither smaller value is needed by
this proof. JSON can expand one UTF-16 unit to six ASCII bytes. Count both the
seat name and its PGN-header occurrence. Account IDs also occur inside the
terminal digest, which is itself JSON encoded as a string; count that second
encoding too. Configured Better Auth normally generates 32 alphanumeric
account IDs, but the calculation permits the larger arena contract.

chess.js emits at most seven ASCII characters for one SAN move: piece,
two-character disambiguation, capture marker, destination, and check suffix,
or a pawn capture with promotion and suffix. The largest numbered move here
uses four digits. With 6,350 full moves, movetext is bounded by:

```text
6,350 * (4 digits + dot + space + 7 SAN + space + 7 SAN)
  + 6,349 separating spaces + space + 7 result characters
  = 139,707 bytes
```

The server adds no PGN comments, variations, arbitrary FEN header, or move
annotations. Allow 4 KiB for all JSON-escaped PGN headers, their newlines,
both bounded names, and the bounded event ID. This exceeds the nine fixed
human-game header values and their syntax. Allow a separate 16 KiB for every
other result field, JSON keys and punctuation, both seats, the twice-encoded
terminal digest, bounded decision IDs, and numeric fields. A 32-character
allowance per server number exceeds its JSON representation. This metadata
allowance covers the following parts, including JSON escaping:

| Part outside PGN | Conservative bytes |
| --- | ---: |
| Two seat names, each at most 80 UTF-16 units | 1,024 |
| Two account IDs in seats and the string-encoded digest, each at most 128 units | 5,120 |
| UUID game/reservation identities and the game/version event ID in all occurrences | 512 |
| Fixed enum/version strings, booleans, and outcome with decision ID | 2,048 |
| Terminal FEN and the exact tournament object, including its digest occurrence | 2,048 |
| At most 24 numeric occurrences with 32 characters each | 768 |
| Remaining fixed keys, quotes, separators, and escaping syntax | 2,048 |
| Total | 13,568 |

The ID row permits six bytes per UTF-16 unit in the direct encoding and
twelve in the string-encoded digest. The decision IDs come only from bounded
server templates or the private 100-character `technicalVoid` input; 256 ASCII
characters covers either template. The standard-start final FEN is below 128
ASCII characters. These rows cover the current fixed `Game.result` shape, not
arbitrary added metadata. They fit inside the 16 KiB allowance. Thus:

```text
139,707 + 4,096 + 16,384 = 160,187 bytes
160,187 < 192 KiB < 256 KiB
```

Use **256 KiB per serialized result copy** as the conservative admission
reserve. The 192 KiB inequality is a proof margin, not a new result rejection
rule. Never truncate PGN or drop an already accepted terminal result to fit a
reserve. If an admission assumption changes, stop new admissions while
accepted games drain and revise the reserve first.

### Scope of the proof

The generic private `Game.init` RPC does not itself enforce every premise. It
bounds the game and event IDs and seat names, but does not bound arbitrary
account IDs or reservation IDs, and it spreads extra tournament properties
if an internal caller supplies them. Therefore no unconditional finite byte
bound follows from that RPC's current validation alone. The arena owner must
preserve its bounded identity contract and construct the exact server metadata
object. Any new internal caller needs the same review. Database corruption or
unbounded administrative imports are outside this admission proof.

chess.js 1.4.0 writes header values directly. Its maintained PGN grammar uses
`tagValue = $[^"]*` and does not support escaped quotes. A local package probe
confirmed that either a raw quote or a backslash-escaped quote makes
`loadPgn(..., { strict: true })` fail. Raw backslashes and newlines parse in
that package, but do not form portable PGN string labels.

The product's thin `pgnPlayerName` adapter therefore changes only export
labels: quotes become apostrophes, backslashes become slashes, and control
characters and line breaks become spaces. It leaves saved account and seat
names intact. Each replacement is one ASCII character, so it does not
increase the header byte bound above. chess.js still owns PGN structure,
movetext, legality, and parsing. Revisit this adapter when a maintained package
version can write and parse PGN-standard escaped header strings.

A durable header-format marker applies the safe labels to new games and
new terminal events. Existing terminal games without the marker preserve
their prior export bytes and outbox identity. This compatibility rule does
not repair malformed retained PGNs. The marker stays in Game state and adds
no field to the serialized `GameResult`.

The focused local Game suite passed all 18 tests on 2026-10-20 with Node
24.19.0 in 2.04 seconds total. Its new regression completes a real game with
quotes, backslashes, CR/LF, a Unicode line separator, and header-like text in
account names, projects its PGN to D1, and replays the saved export. It checks
unchanged account/seat names, the recorded result and final FEN, restart
stability, and a retained terminal/outbox fixture without the format marker.

## Reserve accepted work before admission

A game may emit one pending-adjudication result and then one final result.
The existing Competition path can retain each event in `result_events` and
in a projection `outbox` at the same time. Reserve four copies before accepting
a new game:

```text
2 terminal events * 2 coordinator copies * 256 KiB = 1 MiB per game
```

This is the coordinator's serialized-result reserve floor. Projection wrappers
fit within the difference between the derived result bound and each 256 KiB
allowance. Arena control itself keeps minimal intent, terminal identity,
sequence, and score rows rather than another serialized `GameResult`.

Keep separate headroom for those fixed rows, indexes, SQLite pages and
fragmentation, immutable prior results, public standings generations, and
other modes' accepted work. A serialized-byte counter is not a physical
database-size measurement. Admission must charge pending reserves atomically
against the chosen byte ceiling, retain them through uncertain initialization,
and release them only when durable completion replaces the reserve with its
actual retained charge. Expiring a timer or losing a response is not proof of
completion.

D1 replay storage, the Game result-delivery copy, and the hot Game payload also
need their own accounting. Full move history stores a FEN and server fields
for every move, and non-move draw commands add receipts. A 256 KiB result
reserve does not bound those stores, parser memory, or live object memory.
Measure and check their provider row and storage limits separately.

At 1,000 accepted concurrent games, the coordinator floor alone is 1,000 MiB,
before existing history and physical overhead. That can force a much lower
admission ceiling until the owner design and measured storage headroom support
the intended tier. Do not advertise the entrant target as established capacity.

## Replay contract

The old replay limit of 4,096 plies was lower than the derived server bound.
It could reject a completed server record without any new chess rule ending
that game. The replay adapter now uses `MAX_GAME_PLIES` and preserves the
1 MiB UTF-8 input protection and maintained chess.js parser.

The 1 MiB byte gate exceeds the PGN size bound above for current bounded
server games. Imported PGNs with custom FENs or comments do not share this
standard-start proof and still observe both replay safety limits. Excessive
records fail explicitly; the viewer does not return a partial game. Browser
memory, browser parser latency, and navigation at the upper bound are not
established by this source derivation.

The focused local Workers replay suite passed all 19 tests on 2026-10-20 with
Node 24.19.0 in 4.40 seconds total. It parses 12,700 legal repeated SAN moves,
rejects move 12,701, and retains the existing exact 1 MiB UTF-8 and private
fetch checks. That cyclic fixture exercises parser bounds beyond the former
4,096-ply limit. The server would end that particular fixture by repetition;
it is not evidence that a live 12,700-ply game is attainable. No load, physical
storage, deployed, or browser upper-bound qualification follows from this run.

## Source evidence

- `src/server/game.ts`: `seat`, `parseCommand`, `init`, accepted move handling,
  `result`, `finish`, and pending-adjudication expiry.
- `src/server/adjudication.ts`: automatic outcome checks after each move.
- `src/shared/protocol.ts`: result fields and the shared derived bound.
- `src/server/auth.ts`: account creation name bound and configured ID strategy.
- `src/server/competition.ts`: result journal and projection outbox copies.
- `node_modules/chess.js/src/chess.ts`, pinned 1.4.0: `_makeMove` halfmove
  reset, `isDrawByFiftyMoves`, `_moveToSan`, `getDisambiguator`, and `pgn`.
- `node_modules/@better-auth/core/dist/utils/id.mjs`, under pinned Better Auth
  1.7.12: default 32-character alphanumeric identity generator.

The current arena registration path bounds account/session IDs to 128 UTF-16
units and actor names to 120; `Game.seat` applies the smaller 80-unit name
bound used above. Pairing creates UUID game and reservation IDs. Arena game
initialization constructs only the four tournament fields above, and arena
receipts retain terminal identity, digest, sequence, and scores. These source
checks establish the current admission premises, not enforcement of a physical
storage reserve. No load or storage qualification has passed through this
document.
