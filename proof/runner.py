"""Private one-job HTTP adapter for unchanged pinned CHA-Solver.

Only /prove accepts fixed envelopes. The parent never imports chess or searches.
Linux limits and a process-group watchdog bound each helper and native child.
"""
import ctypes
import math
import os
from pathlib import Path
import resource
import select
import selectors
import signal
import socket
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from contract import BODY_LIMIT, RESULT_LIMIT, checked_result, decode, encode, request, result

ROOT = Path(__file__).resolve().parent
SOLVER = "/opt/cha/analyzer"
ADDRESS_SPACE = 128 * 1024 * 1024
STDERR_LIMIT = 4096
WALL_SECONDS = 2.0
ACTIVE_GROUP = None


def child_limits(expected_parent):
    if sys.platform != "linux":
        raise OSError("Linux resource controls required")
    # Parent death is also handled if it happens between fork and prctl.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "parent-death signal unavailable")
    if os.getppid() != expected_parent:
        os.kill(os.getpid(), signal.SIGKILL)
    resource.setrlimit(resource.RLIMIT_CPU, (1, 1))
    resource.setrlimit(resource.RLIMIT_AS, (ADDRESS_SPACE, ADDRESS_SPACE))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def kill_group(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def disconnected(connection):
    if connection is None:
        return False
    try:
        # A Python socket timeout can poll before recv despite MSG_DONTWAIT.
        # Check readiness first so cancellation never blocks the wall watchdog.
        if not select.select([connection], [], [], 0)[0]:
            return False
        return connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
    except BlockingIOError:
        return False
    except OSError:
        return True


def bounded_process(command, payload, deadline, *, new_group, connection=None):
    """Read both pipes while enforcing caps; never collect unbounded output."""
    global ACTIVE_GROUP
    parent = os.getpid()
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=new_group, preexec_fn=lambda: child_limits(parent),
                               cwd=ROOT, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
                                              "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
                                              **({"PYTHONPATH": os.environ["PYTHONPATH"]} if "PYTHONPATH" in os.environ else {})})
    if new_group:
        ACTIVE_GROUP = process.pid
    group = process.pid if new_group else os.getpgrp()
    output = {"stdout": bytearray(), "stderr": bytearray()}
    why = None
    selector = selectors.DefaultSelector()
    try:
        for stream, name in ((process.stdout, "stdout"), (process.stderr, "stderr")):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        os.set_blocking(process.stdin.fileno(), False)
        selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        offset = 0
        while selector.get_map():
            if time.monotonic() >= deadline:
                why = "resource-limit"
                break
            if disconnected(connection):
                why = "interrupted"
                break
            for key, _ in selector.select(min(0.02, max(0, deadline - time.monotonic()))):
                stream, name = key.fileobj, key.data
                if name == "stdin":
                    try:
                        offset += os.write(stream.fileno(), payload[offset:offset + 8192])
                    except BrokenPipeError:
                        offset = len(payload)
                    if offset == len(payload):
                        selector.unregister(stream)
                        stream.close()
                else:
                    data = os.read(stream.fileno(), 4096)
                    if not data:
                        selector.unregister(stream)
                        stream.close()
                    else:
                        output[name].extend(data)
                        if len(output[name]) > (RESULT_LIMIT if name == "stdout" else STDERR_LIMIT):
                            why = "resource-limit"
                            break
            if why:
                break
        if why:
            # A native limit kills its helper too. The outer parent returns unknown.
            kill_group(group)
        remaining = max(0.001, deadline - time.monotonic())
        try:
            code = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            why = "resource-limit"
            kill_group(group)
            code = process.wait()
        return code, bytes(output["stdout"]), bytes(output["stderr"]), why
    finally:
        selector.close()
        if new_group:
            kill_group(group)
            ACTIVE_GROUP = None
        for stream in (process.stdin, process.stdout, process.stderr):
            if not stream.closed:
                stream.close()
        if process.poll() is None:
            process.kill()
        process.wait()


def execute(job, connection=None):
    started = time.monotonic()
    remaining = (job["expiresAt"] - time.time() * 1000) / 1000
    queue_age_ms = max(0, 30_000 - remaining * 1000)
    if remaining <= 0:
        return result(job, reason="expired")
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    why = None
    child_metrics = None
    try:
        code, raw, helper_metrics, why = bounded_process(
            [sys.executable, str(ROOT / "runner.py"), "--job"], encode(job),
            started + min(WALL_SECONDS, remaining), new_group=True, connection=connection)
        try:
            measured = decode(helper_metrics)
            fields = {"helperCpuMs", "helperMaxRssBytes", "nativeCpuMs", "nativeMaxRssBytes"}
            if (isinstance(measured, dict) and set(measured) == fields
                    and all(type(value) in (int, float) and math.isfinite(value) and value >= 0
                            for value in measured.values())):
                child_metrics = measured
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            pass
        if why:
            return result(job, reason=why)
        if code != 0:
            return result(job, reason="resource-limit" if code < 0 else "invalid-output")
        if time.time() * 1000 >= job["expiresAt"]:
            return result(job, reason="expired")
        try:
            return checked_result(raw, job)
        except (ValueError, TypeError, KeyError):
            return result(job, reason="invalid-output")
    except (OSError, subprocess.SubprocessError):
        return result(job, reason="transient-start")
    finally:
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        metric = {"event": "proof-job", "queueAgeMs": round(queue_age_ms, 3),
                  "wallMs": round((time.monotonic() - started) * 1000, 3),
                  "totalChildCpuMs": round((after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime) * 1000, 3),
                  "childLifetimeMaxRssBytes": after.ru_maxrss * 1024, "transportStop": why,
                  "completedProcessMetrics": child_metrics}
        # No FENs, moves, player identifiers or private request identities in logs.
        print(encode(metric).decode(), file=sys.stderr, flush=True)


def job_main():
    from contract import digests_match
    from validate import InvalidHistory, InvalidWitness, history, native_output, witness
    raw = sys.stdin.buffer.read(BODY_LIMIT + 1)
    job = request(decode(raw))
    if len(raw) > BODY_LIMIT:
        raise ValueError("overlong helper request")
    answer = result(job, reason="invalid-input")
    try:
        if not digests_match(job):
            raise InvalidHistory("digest mismatch")
        if time.time() * 1000 >= job["expiresAt"]:
            answer = result(job, reason="expired")
        else:
            board, counts = history(job)
            payload = f'{job["fen"]} {"white" if job["survivor"] == "w" else "black"}\n'.encode("ascii")
            remaining = (job["expiresAt"] - time.time() * 1000) / 1000
            if remaining <= 0:
                answer = result(job, reason="expired")
            else:
                try:
                    code, output, _, why = bounded_process([SOLVER], payload,
                        time.monotonic() + min(WALL_SECONDS, remaining), new_group=False)
                except (OSError, subprocess.SubprocessError):
                    answer = result(job, reason="transient-start")
                else:
                    if why or code != 0:
                        answer = result(job, reason="resource-limit" if why or code < 0 else "invalid-output")
                    else:
                        verdict, moves = native_output(output, job)
                        if verdict == "winnable":
                            witness(board, counts, moves, job["survivor"])
                            answer = result(job, verdict="winnable", witness=moves, reason=None)
                        elif verdict == "unwinnable":
                            answer = result(job, verdict="unwinnable", reason=None)
                        else:
                            answer = result(job, reason="solver-undetermined")
    except InvalidHistory:
        answer = result(job, reason="invalid-input")
    except InvalidWitness:
        answer = result(job, reason="invalid-witness")
    except ValueError:
        answer = result(job, reason="invalid-output")
    except MemoryError:
        answer = result(job, reason="resource-limit")
    if time.time() * 1000 >= job["expiresAt"]:
        answer = result(job, reason="expired")
    encoded = encode(answer)
    if len(encoded) > RESULT_LIMIT:
        encoded = encode(result(job, reason="invalid-output"))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
    helper = resource.getrusage(resource.RUSAGE_SELF)
    native = resource.getrusage(resource.RUSAGE_CHILDREN)
    print(encode({"helperCpuMs": round((helper.ru_utime + helper.ru_stime) * 1000, 3),
                  "helperMaxRssBytes": helper.ru_maxrss * 1024,
                  "nativeCpuMs": round((native.ru_utime + native.ru_stime) * 1000, 3),
                  "nativeMaxRssBytes": native.ru_maxrss * 1024}).decode(), file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "PrivateTimeoutProof"
    sys_version = ""

    def setup(self):
        self.request.settimeout(2)
        super().setup()

    def log_message(self, *_):
        pass

    def reply(self, status, body):
        encoded = encode(body)
        if len(encoded) > RESULT_LIMIT:
            raise ValueError("response exceeds contract")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)
        self.close_connection = True

    def do_GET(self):
        if self.path == "/ping":
            ready = sys.platform == "linux" and os.access(SOLVER, os.X_OK)
            self.reply(200 if ready else 503, {"ready": ready})
        else:
            self.reply(404, {"error": "NOT_FOUND"})

    def do_POST(self):
        if self.path != "/prove":
            self.reply(404, {"error": "NOT_FOUND"})
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            types = self.headers.get_all("Content-Type", [])
            if (len(lengths) != 1 or not lengths[0].isdigit()
                    or self.headers.get_all("Transfer-Encoding", [])
                    or types != ["application/json"]):
                raise ValueError("invalid framing")
            length = int(lengths[0])
            if not 0 < length <= BODY_LIMIT:
                self.reply(413, {"error": "BODY_LIMIT"})
                return
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("truncated request")
            job = request(decode(raw))
        except (ValueError, TypeError, KeyError, RecursionError, UnicodeError):
            self.reply(422, {"error": "INVALID_ENVELOPE"})
            return
        except OSError:
            return
        try:
            self.reply(200, execute(job, self.connection))
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass


def stop(_signum, _frame):
    if ACTIVE_GROUP is not None:
        kill_group(ACTIVE_GROUP)
    raise SystemExit(0)


def main():
    if sys.argv[1:] == ["--job"]:
        job_main()
    elif not sys.argv[1:]:
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        class Server(HTTPServer):
            request_queue_size = 4
        Server(("0.0.0.0", 8080), Handler).serve_forever()
    else:
        raise SystemExit("unsupported invocation")


if __name__ == "__main__":
    main()
