# Match replays

Open **History**, then **Replay**, or choose **Replay game** after a game ends.
Replays are private to the current guest session or participant account. Clearing
a guest cookie can lose access. No spectator access or live engine analysis is
included. Tournament standings are public; their game records remain private.

Use Start, Previous, Next, and End, or select a SAN move. Flip changes the
view, not the recorded position. When the replay controls have focus, Left and
Right step through moves; Home and End select the first and last position.
PGN remains available for download and use in another chess program.

New completed exports normalize player labels for PGN compatibility: double
quotes become apostrophes, backslashes become slashes, and control characters
and line breaks become spaces. Account names, recorded seats, and history
labels stay unchanged. Retained terminal exports keep their original bytes;
this does not repair older malformed PGN headers.

The viewer reads the server's completed PGN through
`GET /api/games/:uuid/pgn`. It needs a current participant session, returns
`Cache-Control: no-store`, and does not open a game socket. A live or pending
game has no completed replay. A result projection can briefly lag behind the
board; retry when the completed record is not ready. Unrelated users receive
no private record.

The viewer uses chess.js and a read-only cm-chessboard adapter, including
recorded SetUp/FEN headers. It accepts at most 1 MiB of UTF-8 PGN and 12,700
half-moves. The move limit covers the conservative standard-start maximum
under the server's existing automatic draw rules. It adds no server chess rule;
see the [result-bound derivation](result-bounds.md). Invalid or excessive
records show an error instead of a partial or invented game. No engine is
downloaded or called.

Live Game payloads may retire after one hour when a matching saved terminal
record is proved. Permanent ID tombstones prevent reuse. Completed PGNs stay
in D1 and the replay route continues to work. Permanent records consume
storage; no unlimited retention or capacity is promised.

This is local implementation guidance. Publication, production privacy policy,
account recovery, and full backup restoration still need their release checks.
