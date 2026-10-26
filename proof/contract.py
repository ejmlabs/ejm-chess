"""Exact private timeout-proof envelope shared with proof-contract.ts."""
import hashlib
import json
import re

RULES = "online-2026-10-v3-proof"
PROFILE = "cha-native-3484c7e6-v1"
COMMIT = "3484c7e65247003fac8705a9290dc2b5d0978b94"
VALIDATOR = "python-chess-1.11.2-online-v1"
BODY_LIMIT = 131_072
RESULT_LIMIT = 16_384
HISTORY_LIMIT = 12_700
WITNESS_LIMIT = 512
UCI = re.compile(r"[a-h][1-8][a-h][1-8][qrbn]?", re.ASCII)
FIELDS = {"v", "rulesVersion", "profileVersion", "gameId", "reservationId", "pendingVersion", "requestId",
          "survivor", "initialFen", "fen", "moves", "historyDigest", "positionDigest", "expiresAt", "attempt"}
IDENTITY = FIELDS - {"initialFen", "fen", "moves"}
RESULT_FIELDS = IDENTITY | {"solverCommit", "validatorVersion", "verdict", "witness", "reason"}
REASONS = {"solver-undetermined", "resource-limit", "invalid-input", "invalid-output", "invalid-witness",
           "unsupported-policy", "expired", "transient-start", "interrupted"}


def encode(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(encode(value)).hexdigest()


def decode(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON field")
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError("non-finite JSON number")

    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique, parse_constant=invalid_constant)


def safe_positive(value):
    return type(value) is int and 0 < value <= 9_007_199_254_740_991


def request(value):
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise ValueError("invalid envelope")
    if (type(value["v"]) is not int or value["v"] != 1 or value["rulesVersion"] != RULES
            or value["profileVersion"] != PROFILE or not isinstance(value["gameId"], str)
            or not re.fullmatch(r"[\w-]{8,100}", value["gameId"], re.ASCII)
            or value["reservationId"] != value["gameId"] or not safe_positive(value["pendingVersion"])
            or value["requestId"] != f'timeout:{value["gameId"]}:{value["pendingVersion"]}'
            or value["survivor"] not in ("w", "b") or not safe_positive(value["expiresAt"])
            or type(value["attempt"]) is not int or value["attempt"] not in (1, 2)):
        raise ValueError("invalid identity")
    if any(not isinstance(value[key], str) or not re.fullmatch(r"[\x20-\x7e]{1,128}", value[key])
           for key in ("initialFen", "fen")):
        raise ValueError("invalid FEN envelope")
    if (not isinstance(value["moves"], list) or len(value["moves"]) > HISTORY_LIMIT
            or any(not isinstance(move, str) or not UCI.fullmatch(move) for move in value["moves"])):
        raise ValueError("invalid history envelope")
    if any(not isinstance(value[key], str) or not re.fullmatch(r"[a-f0-9]{64}", value[key])
           for key in ("historyDigest", "positionDigest")):
        raise ValueError("invalid digest envelope")
    return value


def digests_match(job):
    history = digest([job["initialFen"], job["moves"]])
    position = digest([job["rulesVersion"], job["gameId"], job["pendingVersion"], job["fen"], job["survivor"], history])
    return job["historyDigest"] == history and job["positionDigest"] == position


def result(job, verdict="unknown", witness=None, reason="invalid-output"):
    return {**{key: job[key] for key in sorted(IDENTITY)}, "solverCommit": COMMIT,
            "validatorVersion": VALIDATOR, "verdict": verdict, "witness": witness or [], "reason": reason}


def checked_result(raw, job):
    value = decode(raw)
    if (not isinstance(value, dict) or set(value) != RESULT_FIELDS
            or any(type(value[key]) is not type(job[key]) or value[key] != job[key] for key in IDENTITY)
            or value["solverCommit"] != COMMIT or value["validatorVersion"] != VALIDATOR
            or value["verdict"] not in ("winnable", "unwinnable", "unknown")
            or not isinstance(value["witness"], list) or len(value["witness"]) > WITNESS_LIMIT
            or any(not isinstance(move, str) or not UCI.fullmatch(move) for move in value["witness"])):
        raise ValueError("invalid helper result")
    if value["verdict"] == "winnable":
        if not value["witness"] or value["reason"] is not None:
            raise ValueError("invalid positive proof")
    elif value["witness"] or (value["reason"] is not None if value["verdict"] == "unwinnable"
                              else value["reason"] not in REASONS):
        raise ValueError("invalid negative or unknown proof")
    return value
