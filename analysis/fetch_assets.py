"""Build-time verifier for official fixed assets. No request data is used here."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


def download(asset, destination):
    digest = hashlib.sha256()
    with urllib.request.urlopen(asset["url"], timeout=60) as response, destination.open("wb") as output:
        while chunk := response.read(128 * 1024):
            digest.update(chunk)
            output.write(chunk)
    if digest.hexdigest() != asset["sha256"]:
        raise RuntimeError("Official asset checksum mismatch")


def main():
    locks = json.loads(Path("locks.json").read_text())
    destination = Path("/opt/stockfish")
    source = Path("/opt/source")
    destination.mkdir(parents=True)
    source.mkdir(parents=True)
    with tempfile.TemporaryDirectory() as scratch:
        archive = Path(scratch) / "stockfish.tar"
        download(locks["release"], archive)
        with tarfile.open(archive) as package:
            # Extract only named regular files. Archive paths never choose destinations.
            for member, name in [(locks["release"]["member"], "stockfish"),
                                 ("stockfish/Copying.txt", "COPYING"),
                                 ("stockfish/AUTHORS", "AUTHORS")]:
                entry = package.getmember(member)
                if not entry.isfile():
                    raise RuntimeError("Unexpected release archive member")
                with package.extractfile(entry) as incoming, (destination / name).open("wb") as output:
                    shutil.copyfileobj(incoming, output)
        binary = destination / "stockfish"
        binary.chmod(0o555)
        files = [Path(scratch) / network["file"] for network in locks["networks"]]
        subprocess.run([str(binary)], input=f"export_net {files[0]} {files[1]}\nquit\n", text=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=20)
        for network, path in zip(locks["networks"], files):
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != network["sha256"]:
                raise RuntimeError("Embedded NNUE checksum mismatch")
        download(locks["source"], source / "stockfish-17.1.tar.gz")
        download(locks["pythonChessSource"], source / "chess-1.11.2.tar.gz")
    print("Verified official binary, source, and both embedded NNUE networks.")


if __name__ == "__main__":
    main()
