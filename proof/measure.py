"""Reproduce local corpus and four-request cold-process burst measurements.

Run inside the qualification image with no network, one CPU and an explicit
memory/pid cap. Results are local Linux evidence, not provider qualification.
"""
import concurrent.futures
import http.client
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time

import chess

from contract import RESULT_LIMIT, RULES, PROFILE, checked_result, digest, encode, decode
from runner import kill_group


def request_for(fixture, sequence):
    board = chess.Board(fixture["initialFen"])
    for uci in fixture["moves"]:
        board.push_uci(uci)
    game = f"corpus-game-{sequence:05d}"
    history = digest([fixture["initialFen"], fixture["moves"]])
    survivor = fixture.get("survivor", "b" if board.turn else "w")
    fen = board.fen(en_passant="legal")
    return {"v": 1, "rulesVersion": RULES, "profileVersion": PROFILE, "gameId": game, "reservationId": game,
            "pendingVersion": 7, "requestId": f"timeout:{game}:7", "survivor": survivor,
            "initialFen": fixture["initialFen"], "fen": fen, "moves": fixture["moves"],
            "historyDigest": history, "positionDigest": digest([RULES, game, 7, fen, survivor, history]),
            "expiresAt": int(time.time() * 1000) + 30_000, "attempt": 1}


def http_call(method, path, body=None):
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=29)
    try:
        connection.request(method, path, body, {"Content-Type": "application/json"})
        response = connection.getresponse()
        raw = response.read(RESULT_LIMIT + 1)
        if len(raw) > RESULT_LIMIT:
            raise ValueError("unbounded response")
        return response.status, decode(raw)
    finally:
        connection.close()


def cgroup(name):
    path = Path("/sys/fs/cgroup") / name
    return path.read_text().strip() if path.is_file() else None


def query(fixture, sequence):
    job = request_for(fixture, sequence)
    started = time.monotonic()
    status, answer = http_call("POST", "/prove", encode(job))
    wall = (time.monotonic() - started) * 1000
    if status != 200:
        raise ValueError(f"private protocol status {status}")
    checked_result(encode(answer), job)
    expected = fixture["expected"]
    return {"fixture": fixture["name"], "survivor": job["survivor"], "ordinary": fixture.get("ordinary", False),
            "expected": expected, "verdict": answer["verdict"], "reason": answer["reason"],
            "passed": answer["verdict"] == expected and (fixture.get("reason") is None or answer["reason"] == fixture["reason"]),
            "witnessPlies": len(answer["witness"]), "wallMs": round(wall, 3),
            "deadlineUnchanged": answer["expiresAt"] == job["expiresAt"],
            "beforeOriginalDeadline": time.time() * 1000 < job["expiresAt"]}


def start_server():
    log = tempfile.TemporaryFile()
    started = time.monotonic()
    process = subprocess.Popen([sys.executable, "runner.py"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=log, start_new_session=True)
    while time.monotonic() - started < 5:
        try:
            if http_call("GET", "/ping")[0] == 200:
                return process, log, round((time.monotonic() - started) * 1000, 3)
        except OSError:
            time.sleep(0.01)
    kill_group(process.pid)
    process.wait()
    raise RuntimeError("private runner failed startup")


def finish(process, log):
    process.terminate()
    try:
        process.wait(timeout=3)
    finally:
        kill_group(process.pid)
        process.wait()
    log.seek(0)
    metrics = []
    for line in log.read(1_000_000).decode().splitlines():
        try:
            item = json.loads(line)
            if item.get("event") == "proof-job":
                metrics.append(item)
        except ValueError:
            pass
    log.close()
    return metrics


def main():
    fixtures = json.loads(Path("corpus.json").read_text())["fixtures"]
    started = time.time()
    process, log, cold = start_server()
    try:
        measurements = [query(fixture, index) for index, fixture in enumerate(fixtures)]
    finally:
        metrics = finish(process, log)
    ordinary = [fixture for fixture in fixtures if fixture.get("ordinary")][:4]
    process, log, burst_cold = start_server()
    burst_started = time.monotonic()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(query, fixture, 10_000 + index) for index, fixture in enumerate(ordinary)]
            burst = [future.result() for future in futures]
    finally:
        burst_metrics = finish(process, log)
    result = {"schema": "ejm-chess-proof-local-qualification-v1", "checkedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "scope": "Local Docker only. A cold Python parent and helper/native processes; image layers and Linux VM may be warm. No Worker, durable receipt, provider cold start, queue or settlement evidence.",
              "platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version(),
              "limits": {"helperCpuSeconds": 1, "nativeCpuSeconds": 1, "eachAddressSpaceBytes": 134_217_728,
                         "sharedWallSeconds": 2, "stdoutBytes": 16_384, "stderrBytes": 4096},
              "container": {"memoryMax": cgroup("memory.max"), "memoryPeak": cgroup("memory.peak"),
                            "cpuMax": cgroup("cpu.max"), "cpuStat": cgroup("cpu.stat"), "pidsMax": cgroup("pids.max")},
              "coldProcessReadyMs": cold, "measurements": measurements, "jobMetrics": metrics,
              "burst": {"jobs": len(burst), "coldProcessReadyMs": burst_cold,
                        "wallMs": round((time.monotonic() - burst_started) * 1000, 3), "measurements": burst, "jobMetrics": burst_metrics},
              "elapsedSeconds": round(time.time() - started, 3),
              "allExpectedPassed": all(item["passed"] for item in measurements + burst),
              "ordinaryFlagsAllSupported": all(item["passed"] and item["verdict"] != "unknown" for item in measurements + burst if item["ordinary"])}
    print(json.dumps(result, indent=2))
    return 0 if result["allExpectedPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
