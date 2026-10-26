"""Bounded feasibility probe of the unchanged upstream example, not a game adjudicator."""
import argparse
import json
from pathlib import Path
import platform
import resource
import subprocess
import time

import chess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("--seconds", type=float, default=2)
    args = parser.parse_args()
    fixtures = json.loads(Path(__file__).with_name("fixtures.json").read_text())
    measurements = []
    for fixture in fixtures:
        for color in ["white", "black"]:
            started = time.monotonic()
            before = resource.getrusage(resource.RUSAGE_CHILDREN)
            try:
                result = subprocess.run([args.binary], input=f'{fixture["fen"]} {color}\n', text=True,
                                        capture_output=True, timeout=args.seconds, check=True)
                line = result.stdout.strip()
                verdict = line.split(" ", 1)[0]
                if verdict not in ["winnable", "unwinnable", "undetermined"]:
                    raise ValueError("Unexpected solver output")
                witness_valid = None
                if verdict == "winnable":
                    moves = line.removeprefix("winnable moves ").split(" ", 1)[0]
                    board = chess.Board(fixture["fen"])
                    for move in filter(None, moves.split(",")):
                        board.push_uci(move)
                    winner = chess.WHITE if color == "white" else chess.BLACK
                    witness_valid = board.is_checkmate() and board.turn != winner
                    if not witness_valid:
                        raise ValueError("Invalid helpmate witness")
            except subprocess.TimeoutExpired:
                verdict, witness_valid = "budget-expired", None
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            measurements.append({"fixture": fixture["name"], "color": color, "verdict": verdict,
                                 "expected": fixture["expected"][color], "witnessValid": witness_valid,
                                 "wallMs": round((time.monotonic() - started) * 1000, 3),
                                 "cpuMs": round((after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime) * 1000, 3)})
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    rss = usage.ru_maxrss if platform.system() == "Darwin" else usage.ru_maxrss * 1024
    print(json.dumps({"platform": platform.platform(), "deadlineSeconds": args.seconds,
                      "binaryBytes": Path(args.binary).stat().st_size,
                      "maxChildRssBytes": rss, "measurements": measurements}, indent=2))


if __name__ == "__main__":
    main()
