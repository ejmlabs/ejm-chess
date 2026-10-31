"""Private bounded postgame evidence, using python-chess for PGN and UCI."""
import io
import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import chess
import chess.engine
import chess.pgn

ENGINE_VERSION = "stockfish-17.1"
PROFILE_VERSION = "screen-v1"
RULES_VERSION = "online-2026-10-v2-unattended"
CURRENT_RULES_VERSION = "online-2026-10-v4-unattended"
MAX_BODY_BYTES = 32_768
MAX_PGN_BYTES = 16_384
MAX_PLIES = 512
MAX_POSITIONS = 24
NODES_PER_SEARCH = 20_000
SECONDS_PER_SEARCH = 0.15
JOB_TIMEOUT_SECONDS = 25
ENGINE = os.environ.get("STOCKFISH_PATH", "/opt/stockfish/stockfish")


class InvalidJob(ValueError):
    pass


def parse_game(job):
    expected = {"gameId", "resultVersion", "rulesVersion", "engineVersion", "profileVersion", "pgn"}
    if not isinstance(job, dict) or set(job) != expected:
        raise InvalidJob("INVALID_INPUT")
    if (job["engineVersion"] != ENGINE_VERSION or job["profileVersion"] != PROFILE_VERSION
            or job["rulesVersion"] not in [RULES_VERSION, CURRENT_RULES_VERSION] or type(job["resultVersion"]) is not int
            or not 1 <= job["resultVersion"] <= 1_000_000
            or not isinstance(job["gameId"], str) or len(job["gameId"]) != 36
            or not isinstance(job["pgn"], str) or len(job["pgn"].encode()) > MAX_PGN_BYTES):
        raise InvalidJob("INVALID_INPUT")
    stream = io.StringIO(job["pgn"])
    game = chess.pgn.read_game(stream)
    if (game is None or game.errors or game.board().fen() != chess.STARTING_FEN
            or chess.pgn.read_game(stream) is not None):
        raise InvalidJob("INVALID_GAME")
    moves = list(game.mainline_moves())
    if not 2 <= len(moves) <= MAX_PLIES:
        raise InvalidJob("INVALID_GAME")
    return game


def sampled_positions(game):
    board = game.board()
    candidates = []
    counts = {"w": {"moveCount": 0, "forcedPositions": 0}, "b": {"moveCount": 0, "forcedPositions": 0}}
    for ply, move in enumerate(game.mainline_moves()):
        color = "w" if board.turn == chess.WHITE else "b"
        counts[color]["moveCount"] += 1
        legal_count = board.legal_moves.count()
        if legal_count <= 1:
            counts[color]["forcedPositions"] += 1
        elif ply >= 8:
            candidates.append((board.copy(stack=True), move, color))
        board.push(move)
    count = min(MAX_POSITIONS, len(candidates))
    # Deterministic spread over the game after the first four moves per side.
    selected = [candidates[index * len(candidates) // count] for index in range(count)] if count else []
    return selected, counts


def analyse_job(job):
    game = parse_game(job)
    positions, counts = sampled_positions(game)
    started = time.monotonic()
    totals = {color: {"loss": 0, "agree": 0, "positions": 0} for color in ["w", "b"]}
    nodes = 0
    if positions:
        with chess.engine.SimpleEngine.popen_uci([ENGINE], timeout=10.0) as engine:
            if engine.id.get("name") != "Stockfish 17.1":
                raise InvalidJob("ENGINE_VERSION_MISMATCH")
            engine.configure({"Threads": 1, "Hash": 32, "SyzygyPath": ""})
            for board, played, color in positions:
                if time.monotonic() - started > 20:
                    raise TimeoutError("ENGINE_BUDGET")
                engine.configure({"Clear Hash": None})
                limit = chess.engine.Limit(nodes=NODES_PER_SEARCH, time=SECONDS_PER_SEARCH)
                best = engine.analyse(board, limit)
                played_info = engine.analyse(board, limit, root_moves=[played])
                best_score = best["score"].pov(board.turn).score(mate_score=10_000)
                played_score = played_info["score"].pov(board.turn).score(mate_score=10_000)
                if best_score is None or played_score is None or not best.get("pv"):
                    raise InvalidJob("ENGINE_OUTPUT_MISSING")
                totals[color]["loss"] += min(1000, max(0, best_score - played_score))
                totals[color]["agree"] += int(best["pv"][0] == played)
                totals[color]["positions"] += 1
                nodes += best.get("nodes", 0) + played_info.get("nodes", 0)
    sides = {}
    for color in ["w", "b"]:
        measured = totals[color]
        sides[color] = {**counts[color], "positions": measured["positions"],
                        "meanLoss": round(measured["loss"] / measured["positions"], 3) if measured["positions"] else 0,
                        "engineAgreement": round(measured["agree"] / measured["positions"], 6) if measured["positions"] else 0}
    return {"engineVersion": ENGINE_VERSION, "profileVersion": PROFILE_VERSION,
            "sides": sides, "positions": len(positions), "nodes": nodes,
            "elapsedMs": round((time.monotonic() - started) * 1000, 3)}


def set_job_limits():
    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024, 384 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (20, 21))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16_384, 16_384))


def run_isolated(job):
    # One new process group per job. A hard deadline kills both adapter and engine.
    process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--job"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               start_new_session=True)
    try:
        output, _ = process.communicate(json.dumps(job).encode(), timeout=JOB_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise TimeoutError("ENGINE_TIMEOUT")
    if process.returncode != 0 or len(output) > 4096:
        raise InvalidJob("ENGINE_FAILURE")
    return json.loads(output)


class Handler(BaseHTTPRequestHandler):
    server_version = "PrivateAnalysis"
    sys_version = ""

    def log_message(self, *_):
        pass

    def reply(self, status, body):
        encoded = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path in ["/ping", "/health"]:
            self.reply(200, {"ready": True})
        else:
            self.reply(404, {"error": "UNAVAILABLE"})

    def do_POST(self):
        if self.path != "/analyze":
            self.reply(404, {"error": "UNAVAILABLE"})
            return
        self.connection.settimeout(2)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY_BYTES or self.headers.get("Content-Type") != "application/json":
                raise InvalidJob("INVALID_INPUT")
            job = json.loads(self.rfile.read(length))
            parse_game(job)
            self.reply(200, run_isolated(job))
        except TimeoutError:
            self.reply(504, {"error": "ENGINE_TIMEOUT"})
        except (ValueError, KeyError, OSError):
            self.reply(422, {"error": "INVALID_OR_FAILED_JOB"})


def main():
    if sys.argv[1:] == ["--job"]:
        set_job_limits()
        raw = sys.stdin.buffer.read(MAX_BODY_BYTES + 1)
        if len(raw) > MAX_BODY_BYTES:
            raise InvalidJob("INVALID_INPUT")
        print(json.dumps(analyse_job(json.loads(raw)), separators=(",", ":")))
    else:
        # Single request at a time, private binding only, no background tick loop.
        server = HTTPServer(("0.0.0.0", 8080), Handler)
        server.request_queue_size = 1
        server.serve_forever()


if __name__ == "__main__":
    main()
