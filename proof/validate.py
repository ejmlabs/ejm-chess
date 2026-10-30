"""Independent legal-history and online-policy witness validation, no search."""
from collections import Counter

import chess

from contract import UCI, WITNESS_LIMIT, digests_match


class InvalidHistory(ValueError):
    pass


class InvalidWitness(ValueError):
    pass


def position_key(board):
    # Public canonical FEN supplies legal en passant and castling rights.
    return " ".join(board.fen(en_passant="legal").split(" ")[:4])


def ended(board, counts):
    # A mating move ends the game before an automatic move-count draw.
    return (board.is_checkmate() or board.is_stalemate() or board.is_insufficient_material()
            or board.halfmove_clock >= 100 or counts[position_key(board)] >= 3)


def history(job):
    if chess.__version__ != "1.11.2" or not digests_match(job):
        raise InvalidHistory("validator or digest mismatch")
    try:
        board = chess.Board(job["initialFen"])
        if not board.is_valid() or board.fen(en_passant="legal") != job["initialFen"]:
            raise InvalidHistory("noncanonical or illegal initial position")
        counts = Counter({position_key(board): 1})
        for uci in job["moves"]:
            if ended(board, counts):
                raise InvalidHistory("history continued after termination")
            board.push_uci(uci)
            counts[position_key(board)] += 1
        if (not board.is_valid() or board.fen(en_passant="legal") != job["fen"]
                or ended(board, counts) or board.turn == (job["survivor"] == "w")):
            raise InvalidHistory("position, termination or surviving side mismatch")
        return board, counts
    except (ValueError, IndexError) as error:
        raise InvalidHistory("illegal retained history") from error


def native_output(raw, job):
    try:
        line = raw.decode("ascii")
    except UnicodeDecodeError as error:
        raise ValueError("non-ASCII solver output") from error
    suffix = f'{job["fen"]} {"white" if job["survivor"] == "w" else "black"}\n'
    for verdict in ("unwinnable", "undetermined"):
        if line == f"{verdict} {suffix}":
            return verdict, []
    prefix = "winnable moves "
    if not line.startswith(prefix) or not line.endswith(" " + suffix):
        raise ValueError("unsupported solver output")
    text = line[len(prefix):-(len(suffix) + 1)]
    moves = text.split(",")
    if len(moves) > WITNESS_LIMIT or any(not UCI.fullmatch(move) for move in moves):
        raise InvalidWitness("invalid or overlong witness")
    return "winnable", moves


def witness(board, counts, moves, survivor):
    if not 1 <= len(moves) <= WITNESS_LIMIT:
        raise InvalidWitness("invalid witness length")
    for index, uci in enumerate(moves):
        if ended(board, counts):
            raise InvalidWitness("witness continued after termination")
        try:
            board.push_uci(uci)
        except ValueError as error:
            raise InvalidWitness("illegal witness move") from error
        counts[position_key(board)] += 1
        if board.is_checkmate():
            if index != len(moves) - 1 or board.turn == (survivor == "w"):
                raise InvalidWitness("wrong or earlier mate")
            return moves
        if ended(board, counts):
            raise InvalidWitness("automatic draw before mate")
    raise InvalidWitness("witness did not mate the flagged side")
