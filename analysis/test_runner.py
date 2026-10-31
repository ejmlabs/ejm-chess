import json
from http.client import HTTPConnection
from http.server import HTTPServer
import os
import threading
import time
import unittest
from unittest.mock import patch

from runner import ENGINE_VERSION, PROFILE_VERSION, RULES_VERSION, CURRENT_RULES_VERSION, Handler, InvalidJob, parse_game, run_isolated

PGN = """[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5
7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. c4 c6 12. Nc3 Qc7
13. Be3 Bb7 14. Rc1 Rfe8 15. cxb5 axb5 16. a3 Bf8 17. Ba2 exd4
18. Nxd4 Nc5 19. f3 Qb8 20. Bf2 b4 1-0
"""


def job():
    return {"gameId": "d66cf801-96e4-42f4-955f-743f12b142fb", "resultVersion": 42,
            "rulesVersion": RULES_VERSION, "engineVersion": ENGINE_VERSION,
            "profileVersion": PROFILE_VERSION, "pgn": PGN}


class InputBoundary(unittest.TestCase):
    def test_no_request_can_select_engine_options_paths_or_custom_positions(self):
        self.assertIsNotNone(parse_game(job()))
        self.assertIsNotNone(parse_game({**job(), "rulesVersion": CURRENT_RULES_VERSION}))
        for extra in [{"enginePath": "/bin/sh"}, {"nodes": 1_000_000_000}, {"command": "go infinite"}]:
            with self.assertRaises(InvalidJob):
                parse_game({**job(), **extra})
        for change in [{"engineVersion": "latest"}, {"rulesVersion": "online-2026-10-v1"},
                       {"rulesVersion": "unknown-policy"}, {"pgn": "x" * 16_385},
                       {"pgn": '[SetUp "1"]\n[FEN "8/8/8/8/8/8/K6k/8 w - - 0 1"]\n\n*'},
                       {"pgn": PGN + "\n[Result \"0-1\"]\n\n1. d4 d5 0-1"}]:
            with self.assertRaises(InvalidJob):
                parse_game({**job(), **change})

    def test_hard_wall_deadline_kills_job_group(self):
        start = time.monotonic()
        with patch("runner.JOB_TIMEOUT_SECONDS", 0.001), self.assertRaises(TimeoutError):
            run_isolated(job())
        self.assertLess(time.monotonic() - start, 2)

    def test_private_http_timeout_is_not_reported_as_invalid_input(self):
        with HTTPServer(("127.0.0.1", 0), Handler) as server:
            server.timeout = 2
            connection = HTTPConnection(*server.server_address, timeout=2)
            with patch("runner.run_isolated", side_effect=TimeoutError("ENGINE_TIMEOUT")):
                thread = threading.Thread(target=server.handle_request, daemon=True)
                thread.start()
                try:
                    connection.request("POST", "/analyze", body=json.dumps(job()), headers={"Content-Type": "application/json"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 504)
                    self.assertEqual(json.loads(response.read()), {"error": "ENGINE_TIMEOUT"})
                finally:
                    connection.close()
                    thread.join(timeout=2)

    @unittest.skipUnless(os.environ.get("RUN_ENGINE_TESTS") == "1", "Explicit native engine test")
    def test_pinned_engine_produces_bounded_private_summary(self):
        result = run_isolated(job())
        self.assertEqual(result["engineVersion"], ENGINE_VERSION)
        self.assertEqual(result["positions"], 24)
        self.assertEqual(sum(side["moveCount"] for side in result["sides"].values()), 40)
        self.assertLessEqual(result["nodes"], 1_500_000)
        self.assertLess(result["elapsedMs"], 25_000)
        self.assertLess(len(json.dumps(result)), 4096)
        for side in result["sides"].values():
            self.assertGreater(side["positions"], 0)
            self.assertTrue(0 <= side["engineAgreement"] <= 1)
            self.assertTrue(0 <= side["meanLoss"] <= 1000)
        self.assertNotIn("pv", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
