"""Corpus-integrity and forced-decision contracts, without an engine process."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import chess
import chess.pgn

from benchmark import GAMES
from qualify_screening import human_games
from runner import sampled_positions
from test_runner import PGN


class QualificationBoundary(unittest.TestCase):
    def test_forced_moves_and_opening_moves_cannot_inflate_scored_agreement(self):
        game = chess.pgn.read_game(io.StringIO(GAMES["opera-1858"]))
        selected, counts = sampled_positions(game)
        self.assertTrue(selected)
        self.assertGreater(sum(side["forcedPositions"] for side in counts.values()), 0)
        self.assertLessEqual(len(selected), 24)
        for board, _, _ in selected:
            self.assertGreater(board.legal_moves.count(), 1)
            self.assertGreaterEqual(board.ply(), 8)

    def test_corpus_cannot_pass_with_changed_moves_missing_strata_or_invented_clean_labels(self):
        # Artificial unit fixtures exercise validation only. They are not part
        # of the public cohort or evidence of dataset permission.
        with tempfile.TemporaryDirectory() as directory:
            corpus = Path(directory)
            entries = []
            for speed, control in (("blitz", "300+3"), ("rapid", "600+5")):
                for band, rating in (("800-1399", 1000), ("1400-1999", 1600), ("2000-2999", 2200)):
                    identifier = f"fixture-{len(entries)}"
                    pgn = (f'[WhiteElo "{rating}"]\n[BlackElo "{rating}"]\n[TimeControl "{control}"]\n' + PGN)
                    filename = f"{identifier}.pgn"
                    (corpus / filename).write_text(pgn)
                    entries.append({"id": identifier, "path": filename, "sha256": hashlib.sha256(pgn.encode()).hexdigest(),
                                    "source": "https://example.test/artificial-unit-fixture", "stratum": f"{speed}/{band}",
                                    "ratingBand": band, "recordedRatings": [rating, rating], "timeControl": control,
                                    "assistanceGroundTruth": "unknown"})
            manifest = {"schema": "screening-corpus-v1", "license": "CC0-1.0", "licenseEvidence": "license.json",
                        "complete": True, "assistanceGroundTruth": "unknown", "perStratumTarget": 1, "games": entries}
            (corpus / "license.json").write_text(json.dumps({"license": "CC0-1.0", "quotedHtml": "Creative Commons CC0 license"}))
            manifest_path = corpus / "manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            self.assertEqual(len(human_games(corpus)[0]), 6)
            for change in ({"games": entries[:-1]}, {"assistanceGroundTruth": "proved clean"},
                           {"games": [{**entries[0], "assistanceGroundTruth": "unassisted"}, *entries[1:]]}):
                manifest_path.write_text(json.dumps({**manifest, **change}))
                with self.assertRaises(ValueError):
                    human_games(corpus)
            manifest_path.write_text(json.dumps(manifest))
            (corpus / entries[0]["path"]).write_text(PGN)
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                human_games(corpus)


if __name__ == "__main__":
    unittest.main()
