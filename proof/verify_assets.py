"""Verify and retain pinned, unchanged upstream source before building."""
import hashlib
import json
from pathlib import Path
import shutil
import tarfile


def main():
    root = Path(__file__).resolve().parent
    pins = json.loads((root / "pins.json").read_text())
    destination = Path("/opt/source")
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("solver", "validator"):
        pin = pins[name]
        archive = root / pin["archive"]
        if hashlib.sha256(archive.read_bytes()).hexdigest() != pin["sha256"]:
            raise ValueError(f"pinned {name} source changed")
        with tarfile.open(archive) as source:
            source.extractall(destination, filter="data")
        shutil.copyfile(archive, destination / archive.name)
    if hashlib.sha256((destination / "chasolver/examples/analyzer.rs").read_bytes()).hexdigest() != pins["solver"]["analyzerSha256"]:
        raise ValueError("upstream analyzer changed")
    if hashlib.sha256((root / "Cargo.lock").read_bytes()).hexdigest() != pins["solver"]["cargoLockSha256"]:
        raise ValueError("Cargo lock changed")
    shutil.copyfile(root / "pins.json", destination / "pins.json")
    shutil.copyfile(root / "Cargo.lock", destination / "Cargo.lock")


if __name__ == "__main__":
    main()
