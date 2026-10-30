"""Project protocol, online draw precedence and Linux failure regressions."""
import copy
import http.client
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

import chess

import contract
import runner
from validate import InvalidHistory, InvalidWitness, history, native_output, witness


def make_job(initial=chess.STARTING_FEN, moves=(), survivor=None, expires=None):
    board = chess.Board(initial)
    for uci in moves:
        board.push_uci(uci)
    game = "fixture-game-0001"
    job = {"v": 1, "rulesVersion": contract.RULES, "profileVersion": contract.PROFILE,
           "gameId": game, "reservationId": game, "pendingVersion": 7,
           "requestId": f"timeout:{game}:7", "survivor": survivor or ("b" if board.turn else "w"),
           "initialFen": initial, "fen": board.fen(en_passant="legal"), "moves": list(moves),
           "historyDigest": "0" * 64, "positionDigest": "0" * 64,
           "expiresAt": expires if expires is not None else int(time.time() * 1000) + 30_000, "attempt": 1}
    job["historyDigest"] = contract.digest([job["initialFen"], job["moves"]])
    job["positionDigest"] = contract.digest([job["rulesVersion"], game, 7, job["fen"], job["survivor"], job["historyDigest"]])
    return job


class HistoryAndWitness(unittest.TestCase):
    def test_retained_castling_en_passant_and_underpromotion(self):
        for initial, moves in [
            (chess.STARTING_FEN, "e2e4 e7e5 g1f3 b8c6 f1e2 g8f6 e1g1".split()),
            (chess.STARTING_FEN, "e2e4 a7a6 e4e5 d7d5 e5d6".split()),
            ("7k/P3p3/8/8/8/8/8/4K3 w - - 0 1", ["a7a8n"]),
        ]:
            job = make_job(initial, moves)
            board, _ = history(job)
            self.assertEqual(board.fen(en_passant="legal"), job["fen"])
            self.assertEqual(len(board.move_stack), len(moves))

    def test_reconstruction_rejects_legal_but_wrong_fen_and_illegal_or_ended_history(self):
        cases = []
        wrong = make_job(moves=["e2e4"])
        wrong["fen"] = chess.STARTING_FEN
        wrong["positionDigest"] = contract.digest([wrong[k] for k in ("rulesVersion", "gameId", "pendingVersion", "fen", "survivor", "historyDigest")])
        cases.append(wrong)
        illegal = make_job()
        illegal["moves"] = ["e2e5"]
        illegal["historyDigest"] = contract.digest([illegal["initialFen"], illegal["moves"]])
        illegal["positionDigest"] = contract.digest([illegal[k] for k in ("rulesVersion", "gameId", "pendingVersion", "fen", "survivor", "historyDigest")])
        cases.append(illegal)
        cases.append(make_job(moves="g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8".split()))
        cases.append(make_job("7k/8/5K2/6Q1/8/8/8/8 b - - 99 1", ["h8h7"]))
        cases.append(make_job(moves="f2f3 e7e5 g2g4 d8h4".split()))
        cases.append(make_job("8/8/8/4k3/8/8/8/K7 w - - 0 1"))
        cases.append(make_job(survivor="w"))
        for job in cases:
            with self.subTest(fen=job["fen"]), self.assertRaises(InvalidHistory):
                history(job)

    def test_digest_and_canonical_en_passant_are_binding(self):
        job = make_job(moves=["e2e4"])
        changed = copy.deepcopy(job)
        changed["historyDigest"] = "f" * 64
        with self.assertRaises(InvalidHistory):
            history(changed)
        changed = copy.deepcopy(job)
        changed["fen"] = changed["fen"].replace(" b KQkq - ", " b KQkq e3 ")
        changed["positionDigest"] = contract.digest([changed[k] for k in ("rulesVersion", "gameId", "pendingVersion", "fen", "survivor", "historyDigest")])
        with self.assertRaises(InvalidHistory):
            history(changed)

    def test_witness_mate_precedes_fifty_move_draw_but_earlier_draw_refuses(self):
        for halfmove, accepted in [(98, True), (99, False)]:
            job = make_job(f"7k/8/5K2/6Q1/8/8/8/8 b - - {halfmove} 1")
            board, counts = history(job)
            if accepted:
                self.assertEqual(witness(board, counts, ["h8h7", "g5g7"], "w"), ["h8h7", "g5g7"])
                self.assertEqual(board.halfmove_clock, 100)
            else:
                with self.assertRaises(InvalidWitness):
                    witness(board, counts, ["h8h7", "g5g7"], "w")
        job = make_job()
        board, counts = history(job)
        with self.assertRaises(InvalidWitness):
            witness(board, counts, "g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8 e2e4".split(), "b")

    def test_witness_requires_legal_complete_mate_of_flagged_side(self):
        job = make_job(moves="e2e4 e7e5 d1h5 b8c6 f1c4".split())
        for moves, survivor in [(["g8f6", "h5f7"], "w"), (["g8f6", "h5f7"], "b"),
                                (["g8f6"], "w"), (["g8f6", "h5f8"], "w"),
                                (["g8f6", "h5f7", "e8e7"], "w")]:
            board, counts = history(job)
            if survivor == "w" and moves == ["g8f6", "h5f7"]:
                self.assertEqual(witness(board, counts, moves, survivor), moves)
            else:
                with self.assertRaises(InvalidWitness):
                    witness(board, counts, moves, survivor)

    def test_native_format_and_witness_bounds_fail_closed(self):
        job = make_job()
        suffix = f'{job["fen"]} black\n'
        self.assertEqual(native_output(("unwinnable " + suffix).encode(), job), ("unwinnable", []))
        self.assertEqual(native_output(("undetermined " + suffix).encode(), job), ("undetermined", []))
        for raw in [b"unwinnable\n", ("unwinnable " + suffix + "extra\n").encode(),
                    ("unwinnable " + suffix.replace("black", "white")).encode(),
                    ("winnable moves " + ",".join(["g1f3"] * 513) + " " + suffix).encode()]:
            with self.assertRaises(ValueError):
                native_output(raw, job)


class LinuxBounds(unittest.TestCase):
    def bound(self, source, seconds=1.8):
        return runner.bounded_process([sys.executable, "-c", source], b"", time.monotonic() + seconds, new_group=True)

    def test_wall_and_both_output_caps_kill_process_group(self):
        for source, seconds in [("import time; time.sleep(10)", 0.2),
                                ("import os; os.write(1,b'x'*20000)", 1.8),
                                ("import os; os.write(2,b'x'*5000)", 1.8)]:
            started = time.monotonic()
            code, stdout, stderr, why = self.bound(source, seconds)
            self.assertEqual(why, "resource-limit")
            self.assertLess(time.monotonic() - started, 2.2)
            self.assertLessEqual(len(stdout), contract.RESULT_LIMIT + 4096)
            self.assertLessEqual(len(stderr), runner.STDERR_LIMIT + 4096)
            self.assertIsNone(runner.ACTIVE_GROUP)

    def test_cpu_and_address_space_limits_fail_without_a_proof(self):
        code, _, _, why = self.bound("while True: pass")
        self.assertEqual(code, -9)
        self.assertIsNone(why)
        code, _, stderr, _ = self.bound("bytearray(512*1024*1024)")
        self.assertNotEqual(code, 0)
        self.assertIn(b"MemoryError", stderr)

    def test_cancelled_connection_and_expired_request_never_start_unbounded_work(self):
        left, right = __import__("socket").socketpair()
        try:
            left.settimeout(2)
            started = time.monotonic()
            self.assertFalse(runner.disconnected(left))
            self.assertLess(time.monotonic() - started, 0.1)
            right.close()
            _, _, _, why = runner.bounded_process([sys.executable, "-c", "import time; time.sleep(10)"], b"",
                time.monotonic() + 1.8, new_group=True, connection=left)
            self.assertEqual(why, "interrupted")
        finally:
            left.close()
            right.close()
        job = make_job(expires=int(time.time() * 1000) - 1)
        answer = runner.execute(job)
        self.assertEqual(answer["reason"], "expired")
        self.assertEqual(answer["expiresAt"], job["expiresAt"])

    def test_parent_crash_kills_helper_and_its_native_child(self):
        native = "import time; time.sleep(10)"
        helper = ("import os,subprocess,sys,runner; parent=os.getpid(); "
                  f"child=subprocess.Popen([sys.executable,'-c',{native!r}], "
                  "preexec_fn=lambda:runner.child_limits(parent)); "
                  "print(os.getpid(),child.pid,flush=True); child.wait()")
        supervisor = ("import os,subprocess,sys,runner; parent=os.getpid(); "
                      f"child=subprocess.Popen([sys.executable,'-c',{helper!r}], "
                      "preexec_fn=lambda:runner.child_limits(parent)); child.wait()")
        process = subprocess.Popen([sys.executable, "-c", supervisor], stdout=subprocess.PIPE)
        children = []
        try:
            children = [int(pid) for pid in process.stdout.readline().split()]
            self.assertEqual(len(children), 2)
            process.kill()
            process.wait(timeout=1)
            until = time.monotonic() + 0.5
            while time.monotonic() < until:
                if all(not Path(f"/proc/{pid}/stat").exists()
                       or Path(f"/proc/{pid}/stat").read_text().split()[2] == "Z" for pid in children):
                    break
                time.sleep(0.01)
            else:
                self.fail("a process remained active after its parent died")
        finally:
            process.stdout.close()
            process.kill()
            process.wait()
            for pid in children:
                try:
                    os.kill(pid, 9)
                except ProcessLookupError:
                    pass

    def test_missing_native_executable_returns_unknown_without_proof(self):
        job = make_job()
        code, raw, _, why = runner.bounded_process(
            [sys.executable, "-c", "import runner; runner.SOLVER='/missing/analyzer'; runner.job_main()"],
            contract.encode(job), time.monotonic() + 1.8, new_group=True)
        self.assertEqual(code, 0)
        self.assertIsNone(why)
        answer = contract.checked_result(raw, job)
        self.assertEqual(answer["verdict"], "unknown")
        self.assertEqual(answer["reason"], "transient-start")


class HttpProtocol(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.errors = tempfile.TemporaryFile()
        cls.server = subprocess.Popen([sys.executable, str(Path(runner.__file__))], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=cls.errors, start_new_session=True)
        until = time.monotonic() + 4
        while time.monotonic() < until:
            try:
                if cls.call("GET", "/ping")[0] == 200:
                    return
            except OSError:
                time.sleep(0.02)
        raise RuntimeError("private runner did not become ready")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        try:
            cls.server.wait(timeout=3)
        finally:
            runner.kill_group(cls.server.pid)
            cls.server.wait()
            cls.errors.close()

    @staticmethod
    def call(method, path, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=5)
        try:
            connection.request(method, path, raw, headers or {"Content-Type": "application/json"})
            response = connection.getresponse()
            payload = response.read(contract.RESULT_LIMIT + 1)
            return response.status, contract.decode(payload), response.getheader("Cache-Control")
        finally:
            connection.close()

    def test_only_fixed_paths_and_strict_bounded_json_envelopes(self):
        self.assertEqual(self.call("GET", "/prove")[0], 404)
        self.assertEqual(self.call("POST", "/prove?command=quit", b"{}")[0], 404)
        self.assertEqual(self.call("POST", "/prove", b"x" * (contract.BODY_LIMIT + 1))[0], 413)
        job = make_job()
        for mutate in [lambda j: j.update({"v": True}), lambda j: j.update({"attempt": True}),
                       lambda j: j.update({"command": "quit"}), lambda j: j.update({"moves": ["quit"]}),
                       lambda j: j.update({"reservationId": "another-game"}),
                       lambda j: j.update({"moves": ["e2e4"] * 12_701})]:
            changed = copy.deepcopy(job)
            mutate(changed)
            self.assertEqual(self.call("POST", "/prove", contract.encode(changed))[0], 422)
        for raw in [b'{"v":1,"v":1}', b'{"v":NaN}', b'\xff']:
            self.assertEqual(self.call("POST", "/prove", raw)[0], 422)
        raw = contract.encode(job)
        for extras in [[("Transfer-Encoding", ""), ("Transfer-Encoding", "chunked")],
                       [("Content-Type", "application/json")], [("Content-Length", str(len(raw)))]]:
            connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=5)
            try:
                connection.putrequest("POST", "/prove")
                for name, value in [("Content-Type", "application/json"),
                                    ("Content-Length", str(len(raw))), *extras]:
                    connection.putheader(name, value)
                connection.endheaders(raw)
                response = connection.getresponse()
                self.assertEqual(response.status, 422)
                response.read(contract.RESULT_LIMIT + 1)
            finally:
                connection.close()

    def test_valid_envelope_returns_exact_echoed_unknown_for_bad_history(self):
        job = make_job()
        job["historyDigest"] = "f" * 64
        status, answer, cache = self.call("POST", "/prove", contract.encode(job))
        self.assertEqual(status, 200)
        self.assertEqual(cache, "no-store")
        self.assertEqual(contract.checked_result(contract.encode(answer), job)["reason"], "invalid-input")
        self.assertEqual(answer["expiresAt"], job["expiresAt"])

    def test_real_pinned_solver_validates_an_ordinary_flag(self):
        job = make_job()
        status, answer, _ = self.call("POST", "/prove", contract.encode(job))
        self.assertEqual(status, 200)
        contract.checked_result(contract.encode(answer), job)
        self.assertEqual(answer["verdict"], "winnable", answer)
        board, counts = history(job)
        witness(board, counts, answer["witness"], job["survivor"])


if __name__ == "__main__":
    unittest.main()
