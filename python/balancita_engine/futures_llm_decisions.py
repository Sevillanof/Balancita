"""LLM decision service Q: typed questions answered by a local llama.cpp model.

Q reads the verdicts DB (C) and the official 1m candles of the market DB,
both read-only over persistent connections, and is the single writer of its
own append-only decisions DB. For every new fresh verdict bucket and every
catalog question it asks the model once, with a grammar limited to the option
letters, and stores the normalized probabilities (``top_logprobs`` -> ``exp``
-> renormalized over the valid letters -> calibration temperature) together
with everything needed to audit it. Downstream consumers (scoring, D) read the
stored decisions only; replays never call the model.

Design rules
------------
* Questions are data (``config/decision-questions.json``): id, version, type
  (``choice``, ``bool`` or ``score``), instruction, options and the STATE
  fields the question needs. Callers use ids only; a changed text needs a new
  version. The state fields come from one registry (``STATE_FIELDS``).
* STATE holds normalized numbers only (bp, ATR units, ratios, oscillators,
  regime, strategy actions): no dates, timestamps, absolute prices or product
  names, to reduce memorized-history leakage.
* A model that is down, loading or too slow produces NOTHING for that bucket
  (logged once per state change); a bucket is never retried later, so live and
  replay stay simple and there is no catch-up storm. Verdicts that were late
  when written (backfill, lag above D's 15 s) or are older than
  ``max_age_ms`` on the wall clock (restart after a long stop) are skipped
  with the same effect.
* Stdlib only (``urllib``), Python 3.9+.
"""

import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

from .futures_products import is_product_id
from .futures_verdicts import (
    ONE_MINUTE_MS,
    VERDICT_SCHEMA_VERSION,
    _file_identity,
    _OfficialCandles,
)

_CONFIG_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "config"
)
QUESTIONS_PATH = os.path.join(_CONFIG_DIR, "decision-questions.json")
CALIBRATION_PATH = os.path.join(_CONFIG_DIR, "decision-calibration.json")

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
DEFAULT_LLAMA_PORT = 8088
DEFAULT_MODEL_REF = "unsloth/Qwen3.5-4B-GGUF:Q8_0"
DEFAULT_MAX_AGE_MS = 120_000
VERDICT_BATCH = 500
TOP_LOGPROBS = 20
MAX_RESPONSE_BYTES = 4_000_000

DECISION_CONFIG = {
    "version": "futures-llm-decisions-config.v1",
    "verdict_schema": VERDICT_SCHEMA_VERSION,
    "state_version": "futures-llm-state.v1",
    # Same freshness rule as D: verdicts rebuilt from a backfill are not decided.
    "max_verdict_lag_ms": 15_000,
    "max_tokens": 1,
    "top_logprobs": TOP_LOGPROBS,
}
CONFIG_MISMATCH = "LLM decisions DB was written with a different config; use a new DB"


class ModelUnavailable(Exception):
    """The model is not reachable, still loading or too slow: store nothing."""


class ModelResponseError(Exception):
    """The model answered but not with a usable decision: stored as an error."""

    def __init__(self, kind, message=None):
        super().__init__(message or kind)
        self.kind = kind


class StateError(Exception):
    """The stored data cannot yet describe a state (e.g. indicator warmup)."""


# --------------------------------------------------------------------------- text


_DELIMITER = re.compile(r"(STATE|QUESTION)\s*:", re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def sanitize_text(text):
    """Neutralizes the prompt delimiters in any text that reaches the prompt."""
    return _DELIMITER.sub(lambda match: match.group(1) + "=", _CONTROL.sub("", str(text)))


def text_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- catalog

_ID = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_OPTION_ID = re.compile(r"^[a-z0-9_]{1,32}$")
QUESTION_TYPES = ("choice", "bool", "score")


def question_hash(question):
    """Hash of a question's full definition; pinned per id@version in the tests."""
    return text_hash(json.dumps(question, sort_keys=True, separators=(",", ":")))


def validate_question(question):
    if not isinstance(question, dict):
        raise ValueError("question must be an object")
    name = question.get("id")
    if not isinstance(name, str) or not _ID.match(name):
        raise ValueError("invalid question id {!r}".format(name))
    version = question.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ValueError("{}: version must be an integer >= 1".format(name))
    kind = question.get("type")
    if kind not in QUESTION_TYPES:
        raise ValueError("{}: type must be one of {}".format(name, ", ".join(QUESTION_TYPES)))
    if not isinstance(question.get("instruction"), str) or not question["instruction"].strip():
        raise ValueError("{}: instruction is required".format(name))
    fields = question.get("state_fields")
    if not isinstance(fields, list) or not fields:
        raise ValueError("{}: state_fields must be a non-empty list".format(name))
    for field in fields:
        if field not in STATE_FIELDS:
            raise ValueError("{}: unknown state field {!r}".format(name, field))
    if kind == "bool":
        if question.get("options"):
            raise ValueError("{}: a bool question has no options (A) true B) false)".format(name))
        return question
    options = question.get("options")
    if not isinstance(options, list) or not 2 <= len(options) <= len(LETTERS):
        raise ValueError("{}: needs 2 to {} options".format(name, len(LETTERS)))
    seen = set()
    for option in options:
        if not isinstance(option, dict) or not _OPTION_ID.match(str(option.get("id", ""))):
            raise ValueError("{}: invalid option id".format(name))
        if option["id"] in seen:
            raise ValueError("{}: duplicate option {}".format(name, option["id"]))
        seen.add(option["id"])
        if not isinstance(option.get("description"), str) or not option["description"].strip():
            raise ValueError("{}: option {} needs a description".format(name, option["id"]))
        if kind == "score":
            value = option.get("value")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError("{}: score option {} needs a numeric value".format(name, option["id"]))
    return question


def load_questions(path=None):
    """The catalog as ``{id: question}``; every question is validated."""
    with open(path or QUESTIONS_PATH) as handle:
        body = json.load(handle)
    questions = {}
    for question in body.get("questions", []):
        validate_question(question)
        if question["id"] in questions:
            raise ValueError("duplicate question id {}".format(question["id"]))
        questions[question["id"]] = question
    return questions


def load_calibration(path=None):
    try:
        with open(path or CALIBRATION_PATH) as handle:
            return json.load(handle)
    except FileNotFoundError:
        return {"temperatures": {}}


def temperature_for(calibration, question_id, version):
    value = (calibration.get("temperatures") or {}).get("{}@{}".format(question_id, version), 1.0)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not value > 0 or not math.isfinite(value):
        raise ValueError("invalid calibration temperature for {}@{}".format(question_id, version))
    return float(value)


def question_options(question):
    """``[(option_id, description_or_None, value_or_None)]`` in letter order."""
    if question["type"] == "bool":
        return [("true", None, None), ("false", None, None)]
    return [(o["id"], o["description"], o.get("value")) for o in question["options"]]


def question_letters(question):
    return list(LETTERS[: len(question_options(question))])


def build_prompt(state_text, question):
    lines = [
        "STATE: " + sanitize_text(state_text),
        "QUESTION: " + sanitize_text(question["instruction"]),
    ]
    for letter, (option_id, description, _) in zip(LETTERS, question_options(question)):
        lines.append("{}) {}".format(letter, option_id) + ("" if description is None else " - " + sanitize_text(description)))
    return "\n".join(lines)


def grammar_for(letters):
    return "root ::= " + " | ".join('"{}"'.format(letter) for letter in letters)


def request_body(prompt, letters):
    return {
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 1,
        "temperature": 0,
        "grammar": grammar_for(letters),
        "logprobs": True,
        "top_logprobs": TOP_LOGPROBS,
        "chat_template_kwargs": {"enable_thinking": False},
    }


# --------------------------------------------------------------------------- conversion


def thinking_leaked(entries, content=""):
    return "<think" in (content or "") or any("<think" in str(e.get("token", "")) for e in entries)


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def convert(question, entries, temperature, content=""):
    """Logprobs of the first token -> a decision (guide step 5).

    ``exp`` over the option letters, a missing letter taking the lowest
    observed logprob, logprobs divided by the calibration temperature before
    the softmax, confidence ``1 - H / ln(n)``. No letter at all is an error.
    """
    if isinstance(temperature, bool) or not _finite(temperature) or temperature <= 0:
        raise ValueError("calibration temperature must be a positive number")
    letters = question_letters(question)
    options = question_options(question)
    observed = {}
    for entry in entries:
        logprob = entry.get("logprob")
        letter = str(entry.get("token", "")).strip()
        if letter in letters and _finite(logprob):
            # "A" and " A" are different tokens for the same answer: probabilities add.
            if letter in observed:
                high, low = max(observed[letter], logprob), min(observed[letter], logprob)
                observed[letter] = high + math.log1p(math.exp(low - high))
            else:
                observed[letter] = logprob
    if not observed:
        kind = "thinking_leak" if thinking_leaked(entries, content) else "no_letters"
        raise ModelResponseError(kind, "no option letter among the top logprobs ({})".format(kind))
    lowest = min(e["logprob"] for e in entries if _finite(e.get("logprob")))
    missing = [letter for letter in letters if letter not in observed]
    scaled = [observed.get(letter, lowest) / temperature for letter in letters]
    peak = max(scaled)
    weights = [math.exp(value - peak) for value in scaled]
    total = sum(weights)
    probs = [weight / total for weight in weights]
    entropy = -sum(p * math.log(p) for p in probs if p > 0)
    confidence = min(1.0, max(0.0, 1.0 - entropy / math.log(len(probs))))
    chosen = max(range(len(probs)), key=lambda index: probs[index])
    value = None
    if question["type"] == "bool":
        value = probs[0]
    elif question["type"] == "score":
        value = sum(p * option[2] for p, option in zip(probs, options))
    return {
        "probabilities": {option[0]: p for option, p in zip(options, probs)},
        "chosen": options[chosen][0],
        "confidence": confidence,
        "value": value,
        "temperature": float(temperature),
        "observed": [letter for letter in letters if letter in observed],
        "missing": missing,
    }


# --------------------------------------------------------------------------- state

_QUANTUM = {1: Decimal("0.1"), 2: Decimal("0.01")}


def _dec(value):
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() else None


def _fmt(number, places):
    if number is None:
        return "n/a"
    text = format(number.quantize(_QUANTUM[places], rounding=ROUND_HALF_EVEN), "f")
    return text[1:] if text.startswith("-") and not text.strip("-0.") else text


def _ratio(numerator, denominator):
    if numerator is None or denominator is None or denominator == 0:
        return None
    return numerator / denominator


def _features(ctx):
    return ctx["verdict"]["features"]["1m"]


def _close(ctx):
    return _dec(_features(ctx).get("candidate_close"))


def _field_regime(ctx):
    return "regime: " + sanitize_text(ctx["verdict"].get("regime", "unknown"))


def _field_returns_bp(ctx):
    bucket = ctx["verdict"]["bucket_start_ms"]
    closes = {c["bucket_start"]: _dec(c["close"]) for c in ctx["candles"]}
    now = closes.get(bucket)
    parts = []
    for minutes in (1, 5, 15, 60):
        change = _ratio(now, closes.get(bucket - minutes * ONE_MINUTE_MS))
        parts.append("{}m={}".format(minutes, _fmt(None if change is None else (change - 1) * 10_000, 1)))
    return "ret_bp: " + " ".join(parts)


def _field_dist_atr(ctx):
    features, close = _features(ctx), _close(ctx)
    atr = _dec(features.get("atr14"))
    parts = []
    for name in ("ema9", "ema21", "sma50"):
        level = _dec(features.get(name))
        parts.append("{}={}".format(name, _fmt(_ratio(None if close is None or level is None else close - level, atr), 2)))
    return "dist_atr: " + " ".join(parts)


def _field_rsi14(ctx):
    return "rsi14: " + _fmt(_dec(_features(ctx).get("rsi14")), 1)


def _position(close, low, high):
    if close is None or low is None or high is None:
        return None
    return _ratio(close - low, high - low)


def _field_bollinger_pos(ctx):
    features = _features(ctx)
    position = _position(_close(ctx), _dec(features.get("bollinger_lower20")), _dec(features.get("bollinger_upper20")))
    return "bollinger_pos: " + _fmt(position, 2)


def _field_donchian_pos(ctx):
    features = _features(ctx)
    position = _position(_close(ctx), _dec(features.get("donchian_low20")), _dec(features.get("donchian_high20")))
    return "donchian_pos: " + _fmt(position, 2)


def _field_atr_bp(ctx):
    ratio = _ratio(_dec(_features(ctx).get("atr14")), _close(ctx))
    return "atr_bp: " + _fmt(None if ratio is None else ratio * 10_000, 1)


def _field_volume_rel(ctx):
    features = _features(ctx)
    return "volume_rel: " + _fmt(_ratio(_dec(features.get("candidate_volume")), _dec(features.get("prior_volume_mean20"))), 2)


def _field_proposals(ctx):
    return "proposals: " + ", ".join(
        "{}={}".format(sanitize_text(p.get("strategy_id", "?")), sanitize_text(p.get("action", "?")))
        for p in ctx["verdict"].get("proposals", [])
    )


# The single registry of STATE fields. To give the model a new input, add a
# named function here that returns one normalized line (no dates, no absolute
# prices, no product names) and test it; questions then list it by name.
STATE_FIELDS = {
    "regime": _field_regime,
    "returns_bp": _field_returns_bp,
    "dist_atr": _field_dist_atr,
    "rsi14": _field_rsi14,
    "bollinger_pos": _field_bollinger_pos,
    "donchian_pos": _field_donchian_pos,
    "atr_bp": _field_atr_bp,
    "volume_rel": _field_volume_rel,
    "proposals": _field_proposals,
}


def build_state(verdict, candles, fields):
    """STATE text for one verdict from stored data only, in the order of ``fields``."""
    unknown = [field for field in fields if field not in STATE_FIELDS]
    if unknown:
        raise ValueError("unknown state field(s): {}".format(", ".join(unknown)))
    features = (verdict.get("features") or {}).get("1m")
    if not isinstance(features, dict) or features.get("ready") is not True:
        raise StateError("verdict features are not ready (indicator warmup)")
    ctx = {"verdict": verdict, "candles": candles}
    return sanitize_text("\n".join(STATE_FIELDS[field](ctx) for field in fields))


# --------------------------------------------------------------------------- providers


class FakeProvider:
    """Scripted provider for tests: no network."""

    def __init__(self, entries=None, healthy=True, model_ref="fake-model", info=None):
        self.entries = entries
        self.healthy = healthy
        self.model_ref = model_ref
        self.info = info
        self.fail_with = None
        self.calls = 0
        self.prompts = []

    def health(self):
        return self.healthy

    def identity(self):
        return self.info or {"model_ref": self.model_ref, "props": None}

    def complete(self, prompt, letters):
        if not self.healthy:
            raise ModelUnavailable("fake model is down")
        if self.fail_with is not None:
            raise self.fail_with
        self.calls += 1
        self.prompts.append(prompt)
        scripted = self.entries(prompt, letters) if callable(self.entries) else self.entries
        if scripted is None:
            scripted = [{"token": letter, "logprob": -1.0 - index} for index, letter in enumerate(letters)]
        return {
            "top_logprobs": list(scripted),
            "content": str(scripted[0]["token"]) if scripted else "",
            "timings": {"prompt_ms": 1.0, "predicted_ms": 1.0},
            "latency_ms": 0,
        }

    def tokenize(self, text):
        return [1]


class LlamaCppProvider:
    """llama-server over HTTP (``urllib``); every call has a timeout."""

    PROPS_KEYS = ("model_path", "model_alias", "build_info", "total_slots")

    def __init__(self, base_url, model_ref=None, timeout=30.0, health_timeout=3.0):
        self.base_url = base_url.rstrip("/")
        self.model_ref = model_ref
        self.timeout = timeout
        self.health_timeout = health_timeout
        # llama-server is local: never go through an HTTP(S)_PROXY from the environment.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _request(self, method, path, timeout, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path, data=data, method=method,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self._opener.open(request, timeout=timeout) as response:
                return response.status, response.read(MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as error:
            try:
                return error.code, error.read(MAX_RESPONSE_BYTES)
            finally:
                error.close()
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise ModelUnavailable("{} {}: {}".format(method, path, error)) from error
        except Exception as error:  # http.client errors (BadStatusLine, IncompleteRead, ...)
            raise ModelUnavailable("{} {}: {!r}".format(method, path, error)) from error

    @staticmethod
    def _json(data, what):
        try:
            return json.loads(data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            raise ModelResponseError("bad_json", "{} is not JSON".format(what)) from error

    def health(self):
        try:
            status, _ = self._request("GET", "/health", self.health_timeout)
        except ModelUnavailable:
            return False
        return status == 200

    def props(self):
        try:
            status, data = self._request("GET", "/props", self.health_timeout)
            body = self._json(data, "/props") if status == 200 else None
        except (ModelUnavailable, ModelResponseError):
            return None
        if not isinstance(body, dict):
            return None
        return {key: body[key] for key in self.PROPS_KEYS if key in body}

    def identity(self):
        return {"model_ref": self.model_ref, "props": self.props()}

    def tokenize(self, text):
        status, data = self._request("POST", "/tokenize", self.health_timeout, {"content": text, "add_special": False})
        if status != 200:
            raise ModelResponseError("http_{}".format(status), "/tokenize answered {}".format(status))
        tokens = self._json(data, "/tokenize").get("tokens")
        if not isinstance(tokens, list):
            raise ModelResponseError("malformed_response", "/tokenize has no tokens")
        return tokens

    def complete(self, prompt, letters):
        started = time.monotonic()
        status, data = self._request("POST", "/v1/chat/completions", self.timeout, request_body(prompt, letters))
        latency_ms = int((time.monotonic() - started) * 1000)
        if status == 503:
            raise ModelUnavailable("llama-server answered 503 (model loading or busy)")
        if status != 200:
            raise ModelResponseError("http_{}".format(status), "llama-server answered {}".format(status))
        body = self._json(data, "completion")
        try:
            choice = body["choices"][0]
            first = choice["logprobs"]["content"][0]
            listed = first.get("top_logprobs") or []
            entries = list(listed) if listed else [{"token": first["token"], "logprob": first["logprob"]}]
            content = (choice.get("message") or {}).get("content") or ""
        except (KeyError, IndexError, TypeError, AttributeError) as error:
            raise ModelResponseError("malformed_response", "completion has no first-token logprobs") from error
        timings = body.get("timings")
        return {
            "top_logprobs": entries,
            "content": content,
            "timings": timings if isinstance(timings, dict) else {},
            "latency_ms": latency_ms,
        }


# --------------------------------------------------------------------------- store


class DecisionStore:
    """Single writer of the decisions DB: append-only decisions and errors."""

    def __init__(self, path, config):
        self.config = dict(config)
        self.config_hash = text_hash(json.dumps(self.config, sort_keys=True, separators=(",", ":")))
        self.db = sqlite3.connect(path)
        self.db.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS paper_futures_llm_meta(
              key TEXT PRIMARY KEY, value TEXT NOT NULL
            ) STRICT;
            CREATE TRIGGER IF NOT EXISTS paper_futures_llm_meta_no_update
              BEFORE UPDATE ON paper_futures_llm_meta BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS paper_futures_llm_meta_no_delete
              BEFORE DELETE ON paper_futures_llm_meta BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
            """
        )
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO paper_futures_llm_meta VALUES('config_json', ?)",
                (json.dumps(self.config, sort_keys=True),),
            )
            self.db.execute(
                "INSERT OR IGNORE INTO paper_futures_llm_meta VALUES('config_hash', ?)", (self.config_hash,)
            )
        stored = self.db.execute("SELECT value FROM paper_futures_llm_meta WHERE key='config_hash'").fetchone()[0]
        if stored != self.config_hash:
            self.db.close()
            raise ValueError(CONFIG_MISMATCH)
        # Joinable with verdicts and scores on (product_id, bucket_start). Labels
        # and outcomes live elsewhere (Q2); nothing here is ever updated.
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS paper_futures_llm_decisions(
              product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL,
              question_id TEXT NOT NULL, question_version INTEGER NOT NULL,
              verdict_hash TEXT NOT NULL, question_type TEXT NOT NULL,
              model_ref TEXT NOT NULL, model_info_json TEXT NOT NULL,
              prompt_hash TEXT NOT NULL, state_text TEXT NOT NULL,
              top_logprobs_json TEXT NOT NULL, probabilities_json TEXT NOT NULL,
              temperature REAL NOT NULL, chosen TEXT NOT NULL, value REAL,
              confidence REAL NOT NULL, latency_ms INTEGER NOT NULL, timings_json TEXT NOT NULL,
              written_at INTEGER NOT NULL,
              PRIMARY KEY(product_id, bucket_start, question_id, question_version)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS paper_futures_llm_errors(
              error_id INTEGER PRIMARY KEY, product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL,
              question_id TEXT NOT NULL, question_version INTEGER NOT NULL,
              kind TEXT NOT NULL, message TEXT NOT NULL, model_ref TEXT NOT NULL, written_at INTEGER NOT NULL
            ) STRICT;
            """
        )
        for table in ("paper_futures_llm_decisions", "paper_futures_llm_errors"):
            self.db.executescript(
                """
                CREATE TRIGGER IF NOT EXISTS {t}_no_update
                  BEFORE UPDATE ON {t} BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
                CREATE TRIGGER IF NOT EXISTS {t}_no_delete
                  BEFORE DELETE ON {t} BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
                """.format(t=table)
            )

    def has(self, product_id, bucket_start, question_id, question_version):
        return self.db.execute(
            "SELECT 1 FROM paper_futures_llm_decisions WHERE product_id=? AND bucket_start=? "
            "AND question_id=? AND question_version=?",
            (product_id, bucket_start, question_id, question_version),
        ).fetchone() is not None

    def last_bucket(self, product_id):
        row = self.db.execute(
            "SELECT MAX(bucket_start) FROM paper_futures_llm_decisions WHERE product_id=?", (product_id,)
        ).fetchone()
        return -1 if row[0] is None else row[0]

    def append_decision(self, row):
        dump = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"))
        with self.db:
            self.db.execute(
                "INSERT INTO paper_futures_llm_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    row["product_id"], row["bucket_start"], row["question_id"], row["question_version"],
                    row["verdict_hash"], row["question_type"], row["model_ref"], dump(row["model_info"]),
                    row["prompt_hash"], row["state_text"], dump(row["top_logprobs"]), dump(row["probabilities"]),
                    row["temperature"], row["chosen"], row["value"], row["confidence"], row["latency_ms"],
                    dump(row["timings"]), int(time.time() * 1000),
                ),
            )

    def append_error(self, row):
        with self.db:
            self.db.execute(
                "INSERT INTO paper_futures_llm_errors(product_id, bucket_start, question_id, question_version, "
                "kind, message, model_ref, written_at) VALUES(?,?,?,?,?,?,?,?)",
                (
                    row["product_id"], row["bucket_start"], row["question_id"], row["question_version"],
                    row["kind"], str(row["message"])[:500], row["model_ref"], int(time.time() * 1000),
                ),
            )

    def close(self):
        self.db.close()


# --------------------------------------------------------------------------- inputs


class _VerdictFeed:
    """Read-only, persistent view of the verdicts DB; every query is PK-bounded."""

    def __init__(self, path):
        self.path = path
        self.db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
        self.identity = _file_identity(path)

    def replaced(self):
        return _file_identity(self.path) != self.identity

    def pending(self, product_id, after_bucket):
        """``(bucket, decision_known_at, verdict_hash, written_at)`` after a bucket, oldest first."""
        return self.db.execute(
            "SELECT bucket_start, decision_known_at, verdict_hash, written_at FROM paper_futures_verdicts "
            "WHERE product_id=? AND bucket_start>? ORDER BY bucket_start LIMIT ?",
            (product_id, after_bucket, VERDICT_BATCH),
        ).fetchall()

    def latest_bucket(self, product_id):
        return self.db.execute(
            "SELECT MAX(bucket_start) FROM paper_futures_verdicts WHERE product_id=?", (product_id,)
        ).fetchone()[0]

    def payload(self, product_id, bucket_start):
        row = self.db.execute(
            "SELECT payload_json FROM paper_futures_verdicts WHERE product_id=? AND bucket_start=?",
            (product_id, bucket_start),
        ).fetchone()
        if row is None:
            raise sqlite3.OperationalError("verdict {} {} not found".format(product_id, bucket_start))
        return json.loads(row[0])

    def close(self):
        self.db.close()


def evaluate(provider, verdicts, market, product_id, bucket_start, question, calibration):
    """Builds the state, asks the model once and converts the answer. Stores nothing."""
    verdict = verdicts.payload(product_id, bucket_start)
    candles = market.window(
        product_id, ONE_MINUTE_MS, bucket_start + ONE_MINUTE_MS, verdict["decision_known_at_ms"], 61
    )
    state = build_state(verdict, candles, question["state_fields"])
    prompt = build_prompt(state, question)
    temperature = temperature_for(calibration, question["id"], question["version"])
    output = provider.complete(prompt, question_letters(question))
    result = convert(question, output["top_logprobs"], temperature, content=output.get("content", ""))
    return {"verdict": verdict, "state": state, "prompt": prompt, "output": output, "result": result}


class DecisionService:
    """Poll loop state; ``poll()`` never raises."""

    def __init__(self, market_db_path, verdicts_db_path, store, provider, questions, calibration,
                 products, log=print, clock=None, max_age_ms=DEFAULT_MAX_AGE_MS):
        self.market_db_path = market_db_path
        self.verdicts_db_path = verdicts_db_path
        self.store = store
        self.provider = provider
        self.questions = dict(questions)
        self.calibration = calibration
        self.products = list(products)
        self.log = log
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.max_age_ms = max_age_ms
        self.max_lag_ms = store.config["max_verdict_lag_ms"]
        self.market = None
        self.verdicts = None
        self.cursors = {}
        self._identity = None
        self._model_up = None
        self._problem = None

    # -- helpers
    def _problem_once(self, message):
        if message != self._problem:
            self.log(message)
            self._problem = message

    def _drop_readers(self):
        for name in ("market", "verdicts"):
            reader = getattr(self, name)
            if reader is not None:
                try:
                    reader.close()
                except sqlite3.Error:
                    pass
                setattr(self, name, None)

    def _model_down(self, reason):
        if self._model_up is not False:
            self.log("model unavailable: {} (nothing is stored for the buckets missed; they are not retried)".format(reason))
        self._model_up = False
        self._identity = None

    def _readers(self):
        if (self.market is not None and self.market.replaced()) or (
            self.verdicts is not None and self.verdicts.replaced()
        ):
            self._drop_readers()
        if self.market is None:
            self.market = _OfficialCandles(self.market_db_path)
        if self.verdicts is None:
            self.verdicts = _VerdictFeed(self.verdicts_db_path)
        if not self.market.available:
            raise sqlite3.OperationalError("market DB has no product-keyed candles yet")

    # -- loop
    def poll(self):
        """Decides the new fresh buckets; returns the number of decisions written."""
        try:
            written = self._poll()
        except sqlite3.Error as error:
            self._drop_readers()
            self._problem_once("inputs unavailable: {}".format(error))
            return 0
        except Exception as error:  # a service must outlive any single failure
            self._problem_once("unexpected error: {}".format(error))
            return 0
        self._problem = None
        return written

    def _work(self, now):
        work = []
        for product_id in self.products:
            cursor = self.cursors.get(product_id)
            if cursor is None:
                cursor = self.store.last_bucket(product_id)
            while True:
                rows = self.verdicts.pending(product_id, cursor)
                for bucket, known_at, verdict_hash, written_at in rows:
                    cursor = bucket
                    if known_at - bucket - ONE_MINUTE_MS > self.max_lag_ms or now - written_at > self.max_age_ms:
                        continue
                    for question in self.questions.values():
                        if not self.store.has(product_id, bucket, question["id"], question["version"]):
                            work.append((product_id, bucket, verdict_hash, question))
                if len(rows) < VERDICT_BATCH:
                    break
            self.cursors[product_id] = cursor
        return work

    def _poll(self):
        self._readers()
        work = self._work(self.clock())
        if not work:
            return 0
        if not self.provider.health():
            self._model_down("health check failed")
            return 0
        if self._model_up is False:
            self.log("model available again")
        self._model_up = True
        if self._identity is None:
            self._identity = self.provider.identity()
        model_ref = self._identity.get("model_ref") or "unknown"
        written = 0
        for product_id, bucket, verdict_hash, question in work:
            base = {"product_id": product_id, "bucket_start": bucket, "question_id": question["id"],
                    "question_version": question["version"], "model_ref": model_ref}
            try:
                done = evaluate(self.provider, self.verdicts, self.market, product_id, bucket, question,
                                self.calibration)
            except ModelUnavailable as error:
                self._model_down(str(error))
                break
            except ModelResponseError as error:
                self.store.append_error(dict(base, kind=error.kind, message=error))
                self.log("error {} {} {}: {}".format(product_id, bucket, question["id"], error.kind))
                continue
            except StateError as error:
                self._problem_once("state not ready: {}".format(error))
                continue
            result, output = done["result"], done["output"]
            self.store.append_decision(dict(
                base, verdict_hash=verdict_hash, question_type=question["type"], model_info=self._identity,
                prompt_hash=text_hash(done["prompt"]), state_text=done["state"], top_logprobs=output["top_logprobs"],
                probabilities=result["probabilities"], temperature=result["temperature"], chosen=result["chosen"],
                value=result["value"], confidence=result["confidence"], latency_ms=output.get("latency_ms", 0),
                timings=output.get("timings", {}),
            ))
            written += 1
        if written:
            self.log("decisions +{}".format(written))
        return written

    def close(self):
        self._drop_readers()


# --------------------------------------------------------------------------- env


def decision_products(env):
    raw = (env.get("DECISIONS_PRODUCTS") or "PF_XBTUSD").split(",")
    products = [item.strip() for item in raw if item.strip()]
    for product in products:
        if not is_product_id(product):
            raise ValueError("invalid DECISIONS_PRODUCTS entry {!r}".format(product))
    return products


def llama_url(env):
    port = (env.get("LLAMA_PORT") or "").strip() or str(DEFAULT_LLAMA_PORT)
    return "http://127.0.0.1:{}".format(port)


def model_ref(env):
    return (env.get("LLAMA_MODEL_PATH") or "").strip() or (env.get("LLAMA_HF") or "").strip() or DEFAULT_MODEL_REF


# --------------------------------------------------------------------------- probe and ask

PROBE_STATE = (
    "regime: range\n"
    "ret_bp: 1m=0.4 5m=-1.2 15m=2.0 60m=-3.1\n"
    "dist_atr: ema9=0.10 ema21=-0.05 sma50=0.30\n"
    "rsi14: 52.0\n"
    "bollinger_pos: 0.55\n"
    "donchian_pos: 0.60\n"
    "atr_bp: 9.0\n"
    "volume_rel: 1.10\n"
    "proposals: sample-a=WAIT, sample-b=WAIT"
)


def _fmt_probs(probabilities):
    return " ".join("{}={:.3f}".format(name, p) for name, p in probabilities.items())


def probe(provider, questions, out=None):
    """Guide step 4: one request and what to check in it. Exit 0 ok, 1 not usable, 2 model down."""
    out = out or sys.stdout
    say = lambda text="": print(text, file=out)
    question = questions.get("direction_1h") or next(iter(questions.values()))
    letters = question_letters(question)
    if not provider.health():
        say("model not healthy: GET /health did not answer 200 (still loading, or not running)")
        return 2
    prompt = build_prompt(PROBE_STATE, question)
    try:
        output = provider.complete(prompt, letters)
    except ModelUnavailable as error:
        say("model not healthy: {}".format(error))
        return 2
    except ModelResponseError as error:
        say("unusable response: {}".format(error))
        return 1
    entries = output["top_logprobs"]
    problems = 0
    say("question: {} v{}".format(question["id"], question["version"]))
    say("top_logprobs ({} entries):".format(len(entries)))
    for entry in entries:
        say("  {!r}: {}".format(entry.get("token"), entry.get("logprob")))
    found = {}
    for entry in entries:
        letter = str(entry.get("token", "")).strip()
        if letter in letters:
            found.setdefault(letter, []).append(entry["token"])
    for letter in letters:
        say("letter {}: {}".format(letter, "token strings " + ", ".join(repr(t) for t in found[letter]) if letter in found else "NOT in top_logprobs"))
    missing = [letter for letter in letters if letter not in found]
    if missing:
        problems += 1
        say("missing: {}".format(", ".join(missing)))
    leaked = thinking_leaked(entries, output.get("content", ""))
    say("thinking leaked: {}".format("YES (enable_thinking is ignored: start llama-server with --reasoning off)" if leaked else "no"))
    problems += 1 if leaked else 0
    for letter in letters:
        try:
            count = len(provider.tokenize(letter))
        except (ModelUnavailable, ModelResponseError) as error:
            say("tokenize {!r} failed: {}".format(letter, error))
            problems += 1
            continue
        say("tokens for {!r}: {}".format(letter, count))
        if count != 1:
            problems += 1
    timings = output.get("timings", {})
    say("latency_ms: {} (prompt_ms={} predicted_ms={})".format(
        output.get("latency_ms"), timings.get("prompt_ms"), timings.get("predicted_ms")))
    try:
        result = convert(question, entries, 1.0, content=output.get("content", ""))
        say("probabilities: {} (chosen {}, confidence {:.3f})".format(
            _fmt_probs(result["probabilities"]), result["chosen"], result["confidence"]))
    except ModelResponseError as error:
        say("probabilities: none ({})".format(error.kind))
        problems += 1
    say("RESULT: {}".format("ok" if problems == 0 else "{} problem(s): do not continue".format(problems)))
    return 0 if problems == 0 else 1


def ask(provider, questions, calibration, market_db, verdicts_db, question_id, product_id, out=None):
    """Asks one catalog question against the latest stored state; stores nothing."""
    out = out or sys.stdout
    say = lambda text="": print(text, file=out)
    question = questions[question_id]
    if not provider.health():
        say("model not healthy: GET /health did not answer 200")
        return 2
    market, verdicts = _OfficialCandles(market_db), _VerdictFeed(verdicts_db)
    try:
        bucket = verdicts.latest_bucket(product_id)
        if bucket is None:
            say("no stored verdict for {}".format(product_id))
            return 1
        done = evaluate(provider, verdicts, market, product_id, bucket, question, calibration)
    except ModelUnavailable as error:
        say("model not healthy: {}".format(error))
        return 2
    except (ModelResponseError, StateError) as error:
        say("no decision: {}".format(error))
        return 1
    finally:
        market.close()
        verdicts.close()
    result = done["result"]
    say("question: {} v{} ({})".format(question["id"], question["version"], question["type"]))
    say("state:\n" + done["state"])
    say("probabilities: " + _fmt_probs(result["probabilities"]))
    say("chosen: {}".format(result["chosen"]))
    if result["value"] is not None:
        say("value: {:.4f}".format(result["value"]))
    say("confidence: {:.3f}".format(result["confidence"]))
    say("temperature: {}".format(result["temperature"]))
    say("latency_ms: {}".format(done["output"].get("latency_ms")))
    return 0


# --------------------------------------------------------------------------- cli


def run(service, poll_seconds=1.0, log=print):
    try:
        while True:
            service.poll()
            time.sleep(poll_seconds)
    finally:
        service.close()


def main(argv=None, provider=None, questions=None, calibration=None):
    import argparse

    parser = argparse.ArgumentParser(description="Balancita futures LLM decision service (Q)")
    parser.add_argument("--market-db")
    parser.add_argument("--verdicts-db")
    parser.add_argument("--decisions-db")
    parser.add_argument("--once", action="store_true", help="decide the pending fresh buckets and exit (stored ones are not asked again)")
    parser.add_argument("--probe", action="store_true", help="step-4 check of the model: one request, what to verify")
    parser.add_argument("--ask", metavar="QUESTION_ID", help="ask one catalog question about the latest stored state; stores nothing")
    parser.add_argument("--product", help="product for --ask (default: first of DECISIONS_PRODUCTS)")
    parser.add_argument("--products", help="comma-separated PF_X list (default: DECISIONS_PRODUCTS or PF_XBTUSD)")
    parser.add_argument("--llama-url", help="default: http://127.0.0.1:$LLAMA_PORT (8088)")
    parser.add_argument("--questions-file")
    parser.add_argument("--calibration-file")
    parser.add_argument("--poll-seconds", type=float, default=1.0)
    parser.add_argument("--timeout-seconds", type=float, default=30.0, help="per model call")
    parser.add_argument("--max-age-seconds", type=float, default=DEFAULT_MAX_AGE_MS / 1000)
    args = parser.parse_args(argv)
    env = os.environ
    log = lambda line: print(line, flush=True)
    try:
        questions = questions if questions is not None else load_questions(args.questions_file)
        calibration = calibration if calibration is not None else load_calibration(args.calibration_file)
        products = decision_products(dict(env, DECISIONS_PRODUCTS=args.products or env.get("DECISIONS_PRODUCTS", "")))
    except (OSError, ValueError) as error:
        print("configuration error: {}".format(error), file=sys.stderr)
        return 2
    if provider is None:
        provider = LlamaCppProvider(args.llama_url or llama_url(env), model_ref(env), timeout=args.timeout_seconds)
    if args.probe:
        return probe(provider, questions)
    if args.ask:
        if args.ask not in questions:
            print("unknown question {!r}; catalog: {}".format(args.ask, ", ".join(sorted(questions))), file=sys.stderr)
            return 2
        if not (args.market_db and args.verdicts_db):
            print("--ask needs --market-db and --verdicts-db", file=sys.stderr)
            return 2
        return ask(provider, questions, calibration, args.market_db, args.verdicts_db, args.ask,
                   args.product or products[0])
    if not (args.market_db and args.verdicts_db and args.decisions_db):
        print("--market-db, --verdicts-db and --decisions-db are required", file=sys.stderr)
        return 2
    store = DecisionStore(args.decisions_db, DECISION_CONFIG)
    service = DecisionService(args.market_db, args.verdicts_db, store, provider, questions, calibration, products,
                              log=log, max_age_ms=int(args.max_age_seconds * 1000))
    try:
        if args.once:
            print("decisions written {}".format(service.poll()))
            return 0
        log("decisions writing to {} (config {}) for {}; {} question(s): {}".format(
            args.decisions_db, store.config_hash[:12], ", ".join(products), len(questions), ", ".join(sorted(questions))))
        run(service, args.poll_seconds, log)
    except KeyboardInterrupt:
        pass
    finally:
        service.close()
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
