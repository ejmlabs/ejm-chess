"""Fetch a bounded CC0 archive prefix. No account token or player API is used.

Python 3.14+ supplies the maintained standard-library zstd reader. Network
acquisition is separate from the offline Python 3.13 analysis image.
"""
import argparse
from compression import zstd
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import urllib.request

MONTH = "2026-09"
SOURCE = f"https://database.lichess.org/standard/lichess_db_standard_rated_{MONTH}.pgn.zst"
LICENSE = "https://database.lichess.org/"
MAX_COMPRESSED = 8 * 1024 * 1024
MAX_DECODED = 64 * 1024 * 1024
MAX_GAMES = 20_000
PER_STRATUM = 4
BANDS = {"800-1399": (800, 1400), "1400-1999": (1400, 2000), "2000-2999": (2000, 3000)}
FORMATS = {"blitz": "300+3", "rapid": "600+5"}


class PrefixReader:
    def __init__(self, response):
        self.response = response
        self.count = 0
        self.sha256 = hashlib.sha256()

    def seekable(self):
        return False

    def read(self, size=-1):
        remaining = MAX_COMPRESSED - self.count
        if remaining <= 0:
            raise ValueError("Compressed-byte budget exhausted before all strata filled")
        block = self.response.read(min(remaining, size if size >= 0 else remaining))
        self.count += len(block)
        self.sha256.update(block)
        return block


def select(pgn):
    # Only extract archive metadata here. The offline evaluator uses python-chess
    # to validate every move, standard start, terminal label and analysis bounds.
    headers = dict(re.findall(r'^\[(\w+) "([^"\n]*)"\]$', pgn, re.MULTILINE))
    if headers.get("Result") not in ("1-0", "0-1", "1/2-1/2"):
        return None
    if any(headers.get(key) == "BOT" for key in ("WhiteTitle", "BlackTitle")):
        return None
    if headers.get("Variant", "Standard") != "Standard" or "FEN" in headers:
        return None
    try:
        ratings = [int(headers[key]) for key in ("WhiteElo", "BlackElo")]
    except (KeyError, ValueError):
        return None
    average = sum(ratings) / 2
    band = next((name for name, (low, high) in BANDS.items() if low <= average < high), None)
    speed = next((name for name, control in FORMATS.items() if headers.get("TimeControl") == control), None)
    site = headers.get("Site", "")
    if not band or not speed or not re.fullmatch(r"https://lichess\.org/[A-Za-z0-9]{8}", site):
        return None
    if not headers.get("Event", "").startswith("Rated " + speed.title()):
        return None
    # Keep ordinary-length games in this small decision-score cohort. Separate
    # controlled examples cover short and forced play. This is selection bias.
    numbers = re.findall(r"(?:^|\s)(\d+)\.", pgn.split("\n\n", 1)[-1])
    if not numbers or not 20 <= max(map(int, numbers)) <= 256 or len(pgn.encode()) > 65_536:
        return None
    return {"stratum": f"{speed}/{band}", "speed": speed, "timeControl": FORMATS[speed],
            "ratingBand": band, "ratingBandBasis": "mean of both recorded ratings",
            "recordedRatings": ratings, "source": site, "sourceDate": headers.get("UTCDate"),
            "accountLabels": "No BOT title in the archive; account type is not independently proved",
            "assistanceGroundTruth": "unknown"}


def fetch(out):
    if (out / "manifest.json").exists():
        raise ValueError("Corpus already exists; preserve it and choose a new output directory")
    out.mkdir(parents=True, exist_ok=True)
    request = lambda url, headers=None: urllib.request.Request(url, headers={
        "User-Agent": "ejm-chess-screening-evaluation/1.0 (bounded research sample)", **(headers or {})})
    # One request at a time. HTTP errors, including 429, stop without retry.
    with urllib.request.urlopen(request(LICENSE), timeout=30) as response:
        license_prefix = response.read(65_536)
    match = re.search(rb'<p class="license">(.*?)</p>', license_prefix, re.DOTALL)
    if not match or b"Creative Commons CC0 license" not in match[1]:
        raise ValueError("Public CC0 license statement was not found")
    license_record = {"url": LICENSE, "retrievedAt": datetime.now(timezone.utc).isoformat(),
                      "license": "CC0-1.0", "sourcePrefixSha256": hashlib.sha256(license_prefix).hexdigest(),
                      "sourcePrefixBytes": len(license_prefix), "quotedHtml": match[0].decode()}
    (out / "license-evidence.json").write_text(json.dumps(license_record, indent=2) + "\n")
    counts = {f"{speed}/{band}": 0 for speed in FORMATS for band in BANDS}
    selected = []
    seen = set()
    examined = 0
    decoded = 0
    started = datetime.now(timezone.utc).isoformat()
    with urllib.request.urlopen(request(SOURCE, {"Range": f"bytes=0-{MAX_COMPRESSED - 1}"}), timeout=30) as response:
        prefix = PrefixReader(response)
        source_headers = {name: response.headers.get(name) for name in ("ETag", "Last-Modified", "Content-Range")}
        with zstd.ZstdFile(prefix) as archive:
            stream = io.TextIOWrapper(archive, encoding="utf-8")
            lines = []
            while examined < MAX_GAMES and decoded < MAX_DECODED:
                line = stream.readline(65_537)
                if len(line.encode()) > 65_536:
                    raise ValueError("Archive line exceeded the parser bound")
                decoded += len(line.encode())
                if (line.startswith("[Event ") and lines) or not line:
                    pgn = "".join(lines).strip() + "\n"
                    examined += 1
                    candidate = select(pgn)
                    if candidate and candidate["source"] not in seen and counts[candidate["stratum"]] < PER_STRATUM:
                        identifier = candidate["source"].rsplit("/", 1)[1]
                        raw = pgn.encode()
                        filename = f"{identifier}.pgn"
                        (out / filename).write_bytes(raw)
                        selected.append({"id": identifier, "path": filename, "sha256": hashlib.sha256(raw).hexdigest(), **candidate})
                        counts[candidate["stratum"]] += 1
                        seen.add(candidate["source"])
                        print(json.dumps({"accepted": len(selected), "stratum": candidate["stratum"]}), flush=True)
                    lines = []
                    if all(value == PER_STRATUM for value in counts.values()) or not line:
                        break
                lines.append(line)
                if sum(map(len, lines)) > 65_536:
                    raise ValueError("Archive game exceeded the parser bound")
        provenance = {"url": SOURCE, "retrievedAt": started, "requestRange": f"bytes=0-{MAX_COMPRESSED - 1}",
                      "responseStatus": response.status, "responseHeaders": source_headers,
                      "compressedBytesRead": prefix.count, "compressedPrefixSha256": prefix.sha256.hexdigest(),
                      "decodedBytesRead": decoded, "gamesExamined": examined,
                      "maxCompressedBytes": MAX_COMPRESSED, "maxDecodedBytes": MAX_DECODED, "maxGames": MAX_GAMES}
    complete = all(value == PER_STRATUM for value in counts.values())
    manifest = {"schema": "screening-corpus-v1", "license": "CC0-1.0", "licenseEvidence": "license-evidence.json",
                "selection": "First matching games in a bounded chronological monthly-archive prefix; stratified convenience sample, not random",
                "assistanceGroundTruth": "unknown", "perStratumTarget": PER_STRATUM,
                "counts": counts, "complete": complete, "acquisition": provenance, "games": selected}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if not complete:
        raise ValueError("Archive budget ended with incomplete strata; the manifest records the gap")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    fetch(parser.parse_args().out)
