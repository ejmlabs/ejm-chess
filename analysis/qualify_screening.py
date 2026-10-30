"""Offline screening evaluation. No classifier, sanction or launch switch.

Uses the existing pinned python-chess and Stockfish image. Retained public
games have unknown assistance status. Synthetic controls are never called human.
Prints one JSON report; progress goes to stderr. No network access is needed.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import platform
import random
import resource
import statistics
import sys
import time
import uuid

import chess
import chess.engine
import chess.pgn

from benchmark import GAMES
from runner import (ENGINE, ENGINE_VERSION, PROFILE_VERSION, RULES_VERSION,
                    MAX_POSITIONS, NODES_PER_SEARCH, SECONDS_PER_SEARCH,
                    parse_game, run_isolated, sampled_positions)

CONTROL_NODES = 4_000
CONTROL_PLIES = 80


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def canonical_game(pgn):
    stream = io.StringIO(pgn)
    game = chess.pgn.read_game(stream)
    if (game is None or game.errors or game.board().fen() != chess.STARTING_FEN
            or chess.pgn.read_game(stream) is not None):
        raise ValueError("Corpus game must be one legal standard-start game")
    canonical = game.accept(chess.pgn.StringExporter(headers=False, variations=False, comments=False))
    return game, canonical


def human_games(corpus):
    manifest_path = corpus / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get("schema") != "screening-corpus-v1" or manifest.get("license") != "CC0-1.0"
            or manifest.get("assistanceGroundTruth") != "unknown" or not manifest.get("complete")):
        raise ValueError("Corpus needs a complete licensed manifest with unknown assistance labels")
    expected = {f"{speed}/{band}" for speed in ("blitz", "rapid")
                for band in ("800-1399", "1400-1999", "2000-2999")}
    counts = defaultdict(int)
    cases = []
    seen = set()
    for entry in manifest["games"]:
        path = corpus / entry["path"]
        if (path.is_symlink() or path.resolve().parent != corpus.resolve() or not path.is_file()
                or path.stat().st_size > 65_536 or digest(path) != entry["sha256"]):
            raise ValueError("Corpus path, size or digest mismatch")
        if entry["id"] in seen or entry["stratum"] not in expected or entry.get("assistanceGroundTruth") != "unknown":
            raise ValueError("Duplicate, unstratified or falsely labelled public game")
        game, canonical = canonical_game(path.read_text())
        if game.headers.get("Result") not in ("1-0", "0-1", "1/2-1/2"):
            raise ValueError("Public cohort contains an unfinished game")
        if any(game.headers.get(key) == "BOT" for key in ("WhiteTitle", "BlackTitle")):
            raise ValueError("Public cohort contains a declared bot account")
        if game.headers.get("TimeControl") != entry["timeControl"]:
            raise ValueError("Public time-control metadata differs from the PGN")
        ratings = [int(game.headers[key]) for key in ("WhiteElo", "BlackElo")]
        low, high = map(int, entry["ratingBand"].split("-"))
        if ratings != entry["recordedRatings"] or not low <= statistics.mean(ratings) < high + 1:
            raise ValueError("Public rating metadata differs from the PGN or band")
        if not 39 <= game.end().ply() <= 512:
            raise ValueError("Public game is outside the declared ordinary-length cohort")
        seen.add(entry["id"])
        counts[entry["stratum"]] += 1
        cases.append({"id": entry["id"], "kind": "public-human-account-game", "pgn": canonical,
                      "source": entry["source"], "stratum": entry["stratum"],
                      "ratings": ratings, "assistanceGroundTruth": "unknown"})
    if set(counts) != expected or any(counts[key] != manifest["perStratumTarget"] for key in expected):
        raise ValueError("One or more public cohort strata are incomplete")
    license_path = corpus / manifest["licenseEvidence"]
    if license_path.is_symlink() or license_path.resolve().parent != corpus.resolve():
        raise ValueError("License evidence must remain inside the corpus")
    license_record = json.loads(license_path.read_text())
    if license_record.get("license") != "CC0-1.0" or "Creative Commons CC0 license" not in license_record.get("quotedHtml", ""):
        raise ValueError("CC0 source evidence is missing")
    return cases, manifest


def controls():
    """Known engine choices in synthetic play, plus a forced historical line.

    Random legal moves are a seeded test policy, never a model of human play.
    Fixed nodes make generation independent of a per-move wall-time target.
    Generated PGNs are embedded in the report for exact later replay.
    """
    cases = []
    with chess.engine.SimpleEngine.popen_uci([ENGINE], timeout=10) as engine:
        if engine.id.get("name") != "Stockfish 17.1":
            raise ValueError("Control generator requires the pinned Stockfish build")
        engine.configure({"Threads": 1, "Hash": 32, "SyzygyPath": "", "Skill Level": 20})
        forced_game, forced_pgn = canonical_game(GAMES["opera-1858"])
        board = forced_game.board()
        assisted = []
        for move in forced_game.mainline_moves():
            if board.legal_moves.count() == 1:
                engine.configure({"Clear Hash": None})
                chosen = engine.play(board, chess.engine.Limit(nodes=CONTROL_NODES)).move
                if chosen != move:
                    raise ValueError("Forced control changed the single legal move")
                assisted.append(board.ply() + 1)
            board.push(move)
        if not assisted:
            raise ValueError("Forced control needs a genuine single-legal-move position")
        cases.append({"id": "forced-only-opera", "kind": "controlled-historical-line", "pgn": forced_pgn,
                      "assistanceGroundTruth": "Engine deliberately consulted only at single-legal-move positions",
                      "assistedPlies": assisted, "source": "Existing public-domain Opera 1858 resource fixture"})
        schedules = [("seeded-legal-baseline", set()), ("selective-opening", {3, 5}),
                     ("selective-middle", {15, 31, 47}), ("full-engine", set(range(1, CONTROL_PLIES + 1)))]
        for name, schedule in schedules:
            rng = random.Random(20261020)
            game = chess.pgn.Game()
            node = game
            board = game.board()
            assisted = []
            while board.ply() < CONTROL_PLIES and not board.is_game_over(claim_draw=True):
                ply = board.ply() + 1
                legal = sorted(board.legal_moves, key=lambda move: move.uci())
                if ply in schedule:
                    engine.configure({"Clear Hash": None})
                    move = engine.play(board, chess.engine.Limit(nodes=CONTROL_NODES)).move
                    assisted.append(ply)
                else:
                    move = rng.choice(legal)
                if move not in board.legal_moves:
                    raise ValueError("Control generator returned an illegal move")
                node = node.add_main_variation(move)
                board.push(move)
            # A capped synthetic transcript is a resource/evidence fixture, not
            # a fabricated played result. The private runner accepts prefixes.
            game.headers["Result"] = board.result(claim_draw=True)
            pgn = game.accept(chess.pgn.StringExporter(headers=False, comments=False, variations=False))
            cases.append({"id": name, "kind": "synthetic-controlled-transcript", "pgn": pgn,
                          "assistanceGroundTruth": "Known generator choices; not human play",
                          "assistedPlies": assisted, "seed": 20261020, "generationNodesPerChoice": CONTROL_NODES})
    return cases


def evaluate(case):
    game, canonical = canonical_game(case["pgn"])
    job_id = str(uuid.UUID(hashlib.sha256(case["id"].encode()).hexdigest()[:32], version=4))
    job = {"gameId": job_id, "resultVersion": 1, "rulesVersion": RULES_VERSION,
           "engineVersion": ENGINE_VERSION, "profileVersion": PROFILE_VERSION, "pgn": canonical}
    parse_game(job)
    selected, _ = sampled_positions(game)
    selected_plies = [board.ply() + 1 for board, _, _ in selected]
    board = game.board()
    forced = []
    for move in game.mainline_moves():
        if board.legal_moves.count() == 1:
            forced.append(board.ply() + 1)
        board.push(move)
    result = {key: value for key, value in case.items() if key != "pgn"}
    result.update({"plies": board.ply(), "canonicalPgnSha256": hashlib.sha256(canonical.encode()).hexdigest(),
                   "sampledPlies": selected_plies, "forcedPlies": forced})
    if case["kind"] != "public-human-account-game":
        planted = set(case["assistedPlies"])
        result["pgn"] = canonical
        result["assistanceCoverage"] = {
            "plantedChoices": len(planted), "sampledChoices": len(planted.intersection(selected_plies)),
            "forcedChoices": len(planted.intersection(forced)), "openingChoices": len([ply for ply in planted if ply <= 8]),
            "meaning": "Known position-sampling coverage, not assistance detection sensitivity"}
    started = time.monotonic()
    result["summary"] = run_isolated(job)
    result["wallMs"] = round((time.monotonic() - started) * 1000, 3)
    return result


def distribution(values):
    return {"n": len(values), "min": min(values), "median": statistics.median(values),
            "mean": statistics.mean(values), "max": max(values)} if values else {"n": 0}


def report(corpus, image_id, previous_controls=None):
    started = time.monotonic()
    humans, manifest = human_games(corpus)
    generated = previous_controls if previous_controls is not None else controls()
    results = []
    errors = []
    for case in humans + generated:
        try:
            result = evaluate(case)
            results.append(result)
            print(json.dumps({"case": case["id"], "positions": result["summary"]["positions"]}), file=sys.stderr, flush=True)
        except (ValueError, TimeoutError, OSError) as error:
            errors.append({"id": case["id"], "error": type(error).__name__, "message": str(error)})
    strata = {}
    for name in sorted(manifest["counts"]):
        games = [row for row in results if row.get("stratum") == name]
        sides = [side for row in games for side in row["summary"]["sides"].values() if side["positions"] > 0]
        strata[name] = {"games": len(games), "analysedSides": len(sides),
                        "meanLossCp": distribution([side["meanLoss"] for side in sides]),
                        "engineAgreement": distribution([side["engineAgreement"] for side in sides]),
                        "sampledPositions": sum(side["positions"] for side in sides)}
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {"schema": "screening-evaluation-v1", "createdAt": datetime.now(timezone.utc).isoformat(),
            "evaluationCompleted": not errors and len(results) == len(humans) + len(generated),
            "rankedAdmissionDecision": "Separate owner review required; this tool cannot change admission",
            "engineVersion": ENGINE_VERSION, "profileVersion": PROFILE_VERSION,
            "profile": {"maxPositions": MAX_POSITIONS, "nodesPerSearch": NODES_PER_SEARCH, "secondsPerSearch": SECONDS_PER_SEARCH},
            "provenance": {"imageId": image_id, "python": platform.python_version(), "pythonChess": chess.__version__,
                           "platform": platform.platform(), "engineSha256": digest(ENGINE),
                           "runnerSha256": digest(Path(__file__).with_name("runner.py")),
                           "evaluationScriptSha256": digest(__file__),
                           "corpusManifestSha256": digest(corpus / "manifest.json"),
                           "licenseEvidenceSha256": digest(corpus / manifest["licenseEvidence"])},
            "humanCohort": {"games": len(humans), "strata": strata, "selection": manifest["selection"],
                            "source": manifest["acquisition"]["url"], "assistanceGroundTruth": "unknown"},
            "errorAndUncertainty": {
                "failedJobs": errors, "falsePositiveRate": None, "falseNegativeRate": None, "sanctionThreshold": None,
                "reasons": ["No assistance classifier or adjudicated assistance labels exist",
                            "Public human-account games are not proved unassisted; absence of a BOT title is incomplete account-type evidence",
                            "Four convenience games per format/rating stratum do not estimate population error rates or prevalence",
                            "Both sides of a game are correlated and must not be counted as independent human samples",
                            "Only 24 non-forced positions after the first eight plies are sampled; obvious choices are not otherwise identified",
                            "Synthetic seeded legal moves and capped transcripts do not model realistic human decisions or complete assistance strategies",
                            "Fixed-node control generation is replayable from retained PGN; time-capped screening scores can vary across CPUs"],
                "unattendedPolicy": "Informational only. No statistical finding can convict, restrict, remove ratings or imply reviewed play. No automated sanction is justified."},
            "resources": {"wallMs": round((time.monotonic() - started) * 1000, 3),
                          "childCpuSeconds": round(usage.ru_utime + usage.ru_stime, 3),
                          "maxChildRssBytes": usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024},
            "results": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", required=True, type=Path)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--controls-from", type=Path, help="Replay retained control PGNs instead of generating new ones")
    args = parser.parse_args()
    previous = None
    if args.controls_from:
        previous = [row for row in json.loads(args.controls_from.read_text())["results"] if row["kind"] != "public-human-account-game"]
    result = report(args.corpus, args.image_id, previous)
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["evaluationCompleted"] else 1)
