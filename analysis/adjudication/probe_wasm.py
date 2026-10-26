"""Run each experimental WASM fixture with a two-second external deadline."""
import argparse
import json
from pathlib import Path
import platform
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("wasm")
    parser.add_argument("--seconds", type=float, default=2)
    args = parser.parse_args()
    directory = Path(__file__).parent
    fixtures = json.loads((directory / "fixtures.json").read_text())
    measurements = []
    for index, fixture in enumerate(fixtures):
        for black in [0, 1]:
            for fast in [0, 1]:
                try:
                    result = subprocess.run(["node", "--max-old-space-size=128", str(directory / "wasm-probe/probe.mjs"),
                                             args.wasm, str(index), str(black), str(fast)], text=True,
                                            capture_output=True, timeout=args.seconds, check=True)
                    measured = json.loads(result.stdout)
                except subprocess.TimeoutExpired:
                    measured = {"black": black, "fast": fast, "verdict": "budget-expired"}
                measurements.append({"fixture": fixture["name"], **measured})
    print(json.dumps({"platform": platform.platform(), "deadlineSeconds": args.seconds,
                      "measurements": measurements}, indent=2))


if __name__ == "__main__":
    main()
