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
* Prompts are data too (``config/decision-prompts.json``): a versioned template
  (system message, last answer line, optional assistant prefill). The version is
  stored with every decision and hashed into ``prompt_hash``.
* Two probability sources. ``raw_logprobs``: the logprobs llama-server computes
  BEFORE the grammar, so a model whose natural first token is not a letter
  ("To", "Based") pushes the letters out of the top 20. ``post_sampling``:
  ``post_sampling_probs`` returns the probabilities after the sampler chain; with
  the grammar masking everything but the option letters and no truncation
  (temperature 1, top_k 0, top_p 1, min_p 0) they are the model's distribution
  over the allowed letters. The decision always uses the returned probabilities,
  never the sampled token. ``auto`` tries raw first and re-asks with post_sampling
  when an option letter is missing.
* The model is local and offline: the provider only talks to loopback.
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
import urllib.parse
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
PROMPTS_PATH = os.path.join(_CONFIG_DIR, "decision-prompts.json")

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
DEFAULT_LLAMA_PORT = 8088
DEFAULT_MODEL_REF = "unsloth/Qwen3.5-4B-GGUF:Q8_0"
DEFAULT_MAX_AGE_MS = 120_000
VERDICT_BATCH = 500
TOP_LOGPROBS = 20
MAX_RESPONSE_BYTES = 4_000_000
RAW_SOURCE = "raw_logprobs"
POST_SOURCE = "post_sampling"
PROBABILITY_SOURCES = (RAW_SOURCE, POST_SOURCE)
SOURCE_MODES = PROBABILITY_SOURCES + ("auto",)
# post_sampling answers whose candidates are the unmasked vocabulary (the first,
# unconstrained draw happened to be an allowed token) are asked again this many times.
POST_SAMPLING_ATTEMPTS = 3
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")

DECISION_CONFIG = {
    "version": "futures-llm-decisions-config.v2",
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
# ``verdict`` (default, the only scope Q asks) questions describe a verdict STATE; ``news`` questions
# are asked by the news process N about one news item (its text is the state), never by Q.
QUESTION_SCOPES = ("verdict", "news")


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
    scope = question.get("scope", "verdict")
    if scope not in QUESTION_SCOPES:
        raise ValueError("{}: scope must be one of {}".format(name, ", ".join(QUESTION_SCOPES)))
    fields = question.get("state_fields")
    if scope == "news":
        if fields:
            raise ValueError("{}: a news question carries the item text, not state_fields".format(name))
    else:
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


def load_questions(path=None, scope="verdict"):
    """The catalog as ``{id: question}``; every question is validated.

    ``scope`` filters by the question's scope (``verdict`` by default, so Q never asks a news
    question); ``None`` returns every scope.
    """
    with open(path or QUESTIONS_PATH) as handle:
        body = json.load(handle)
    questions = {}
    for question in body.get("questions", []):
        validate_question(question)
        if question["id"] in questions:
            raise ValueError("duplicate question id {}".format(question["id"]))
        questions[question["id"]] = question
    if scope is not None:
        questions = {k: v for k, v in questions.items() if v.get("scope", "verdict") == scope}
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


# --------------------------------------------------------------------------- prompts

# The original prompt: no system message, no answer line, no prefill. Kept as the
# default of the low-level helpers and as version 1 of the shipped templates.
LEGACY_TEMPLATE = {"version": 1, "system": None, "answer_line": None, "prefill": None}
_TEMPLATE_TEXT_FIELDS = ("system", "answer_line", "prefill")


def validate_prompt_config(config):
    """Checks a decision-prompts document; returns it."""
    if not isinstance(config, dict):
        raise ValueError("prompt config must be an object")
    source = config.get("probability_source", "auto")
    if source not in SOURCE_MODES:
        raise ValueError("probability_source must be one of {}".format(", ".join(SOURCE_MODES)))
    versions = config.get("versions")
    if not isinstance(versions, dict) or not versions:
        raise ValueError("prompt config needs versions")
    for key, template in versions.items():
        if not re.match(r"^[1-9][0-9]{0,5}$", str(key)):
            raise ValueError("invalid prompt version {!r}".format(key))
        if not isinstance(template, dict):
            raise ValueError("prompt version {} must be an object".format(key))
        for field in _TEMPLATE_TEXT_FIELDS:
            value = template.get(field)
            if value is not None and not isinstance(value, str):
                raise ValueError("prompt version {}: {} must be a string or null".format(key, field))
    default = config.get("default_version")
    if isinstance(default, bool) or not isinstance(default, int) or str(default) not in versions:
        raise ValueError("default_version must name one of the versions")
    return config


def load_prompt_config(path=None):
    """``{default_version, probability_source, templates: {int: template}}`` from the prompts file."""
    with open(path or PROMPTS_PATH) as handle:
        config = validate_prompt_config(json.load(handle))
    templates = {}
    for key, template in config["versions"].items():
        templates[int(key)] = dict({field: template.get(field) for field in _TEMPLATE_TEXT_FIELDS}, version=int(key))
    return {
        "default_version": config["default_version"],
        "probability_source": config.get("probability_source", "auto"),
        "templates": templates,
    }


def default_template(path=None):
    config = load_prompt_config(path)
    return config["templates"][config["default_version"]]


def template_hash(template):
    """Hash of a template's full definition; pinned per version in the tests."""
    fields = {field: template.get(field) for field in _TEMPLATE_TEXT_FIELDS}
    return text_hash(json.dumps(dict(fields, version=template["version"]), sort_keys=True, separators=(",", ":")))


def prompt_hash(prompt, template=None):
    """Identity of what the model saw: the version, the system message, the user text and the prefill."""
    template = template or LEGACY_TEMPLATE
    return text_hash(json.dumps(
        {
            "prompt_version": template["version"], "system": template.get("system"),
            "user": prompt, "prefill": template.get("prefill"),
        },
        sort_keys=True, separators=(",", ":"),
    ))


def _letters_phrase(letters):
    return letters[0] if len(letters) == 1 else ", ".join(letters[:-1]) + " or " + letters[-1]


def build_prompt(state_text, question, template=None):
    """The user message: STATE first, QUESTION and the options, then the template's answer line."""
    template = template or LEGACY_TEMPLATE
    lines = [
        "STATE: " + sanitize_text(state_text),
        "QUESTION: " + sanitize_text(question["instruction"]),
    ]
    for letter, (option_id, description, _) in zip(LETTERS, question_options(question)):
        lines.append("{}) {}".format(letter, option_id) + ("" if description is None else " - " + sanitize_text(description)))
    if template.get("answer_line"):
        lines.append(template["answer_line"].format(letters=_letters_phrase(question_letters(question))))
    return "\n".join(lines)


def grammar_for(letters):
    return "root ::= " + " | ".join('"{}"'.format(letter) for letter in letters)


def request_body(prompt, letters, template=None, source=RAW_SOURCE):
    """POST /v1/chat/completions body for one answer.

    ``raw_logprobs``: temperature 0, ``logprobs``/``top_logprobs`` (computed before the grammar).
    ``post_sampling``: ``post_sampling_probs`` with temperature 1 and no truncation so the returned
    probabilities are the model's distribution over the grammar-allowed letters.
    """
    if source not in PROBABILITY_SOURCES:
        raise ValueError("unknown probability source {!r}".format(source))
    template = template or LEGACY_TEMPLATE
    messages = []
    if template.get("system"):
        messages.append({"role": "system", "content": template["system"]})
    messages.append({"role": "user", "content": prompt})
    if template.get("prefill"):
        messages.append({"role": "assistant", "content": template["prefill"]})
    body = {
        "messages": messages,
        "max_tokens": 1,
        "temperature": 0,
        "grammar": grammar_for(letters),
        "logprobs": True,
        "top_logprobs": TOP_LOGPROBS,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if source == POST_SOURCE:
        body.update({"temperature": 1, "top_k": 0, "top_p": 1, "min_p": 0, "post_sampling_probs": True})
    return body


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


def check_loopback_url(url):
    """The model runs locally and offline: only ``http://`` loopback URLs are accepted."""
    try:
        parts = urllib.parse.urlsplit(str(url))
        host = (parts.hostname or "").lower()
        parts.port  # noqa: B018 - raises ValueError on a bad port
    except ValueError as error:
        raise ValueError("invalid llama-server URL {!r}: {}".format(url, error)) from error
    if parts.scheme != "http" or host not in LOOPBACK_HOSTS:
        raise ValueError(
            "llama-server URL {!r} is not loopback: the model only runs locally "
            "(http://127.0.0.1, http://localhost or http://[::1])".format(url)
        )
    return url


class FakeProvider:
    """Scripted provider for tests: no network."""

    def __init__(self, entries=None, healthy=True, model_ref="fake-model", info=None, post_entries=None):
        self.entries = entries
        self.post_entries = post_entries
        self.healthy = healthy
        self.model_ref = model_ref
        self.info = info
        self.fail_with = None
        self.calls = 0
        self.prompts = []
        self.sources = []

    def health(self):
        return self.healthy

    def identity(self):
        return self.info or {"model_ref": self.model_ref, "props": None}

    def complete(self, prompt, letters, source=RAW_SOURCE, template=None):
        if not self.healthy:
            raise ModelUnavailable("fake model is down")
        if self.fail_with is not None:
            raise self.fail_with
        self.calls += 1
        self.prompts.append(prompt)
        self.sources.append(source)
        script = self.post_entries if source == POST_SOURCE and self.post_entries is not None else self.entries
        scripted = script(prompt, letters) if callable(script) else script
        if scripted is None:
            scripted = [{"token": letter, "logprob": -1.0 - index} for index, letter in enumerate(letters)]
        return {
            "top_logprobs": list(scripted),
            "content": str(scripted[0]["token"]) if scripted else "",
            "timings": {"prompt_ms": 1.0, "predicted_ms": 1.0},
            "latency_ms": 0,
            "source": source,
        }

    def tokenize(self, text):
        return [1]


class LlamaCppProvider:
    """llama-server over HTTP (``urllib``); every call has a timeout."""

    PROPS_KEYS = ("model_path", "model_alias", "build_info", "total_slots")

    def __init__(self, base_url, model_ref=None, timeout=30.0, health_timeout=3.0):
        check_loopback_url(base_url)
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

    def _first_token(self, body, what):
        try:
            return body["choices"][0], body["choices"][0]["logprobs"]["content"][0]
        except (KeyError, IndexError, TypeError, AttributeError) as error:
            raise ModelResponseError("malformed_response", "completion has no first-token {}".format(what)) from error

    @staticmethod
    def _post_sampling_entries(first):
        """``top_probs`` (``prob`` in 0..1, only the candidates left after the sampler chain) as logprobs."""
        listed = first.get("top_probs")
        if not isinstance(listed, list) or not listed:
            raise ModelResponseError(
                "post_sampling_unsupported",
                "answer has no top_probs: this llama-server does not honor post_sampling_probs",
            )
        entries = []
        for item in listed:
            prob = item.get("prob") if isinstance(item, dict) else None
            if _finite(prob) and prob > 0:
                entries.append({"token": item.get("token", ""), "logprob": math.log(prob)})
        if not entries:
            raise ModelResponseError("malformed_response", "top_probs has no positive probability")
        return entries

    def complete(self, prompt, letters, source=RAW_SOURCE, template=None):
        started = time.monotonic()
        body = request_body(prompt, letters, template, source)
        for attempt in range(POST_SAMPLING_ATTEMPTS if source == POST_SOURCE else 1):
            status, data = self._request("POST", "/v1/chat/completions", self.timeout, body)
            if status == 503:
                raise ModelUnavailable("llama-server answered 503 (model loading or busy)")
            if status != 200:
                raise ModelResponseError("http_{}".format(status), "llama-server answered {}".format(status))
            answer = self._json(data, "completion")
            if source == RAW_SOURCE:
                choice, first = self._first_token(answer, "logprobs")
                listed = first.get("top_logprobs") or []
                try:
                    entries = list(listed) if listed else [{"token": first["token"], "logprob": first["logprob"]}]
                except KeyError as error:
                    raise ModelResponseError("malformed_response", "completion has no first-token logprobs") from error
                break
            choice, first = self._first_token(answer, "probabilities")
            entries = self._post_sampling_entries(first)
            tokens = {str(entry["token"]).strip() for entry in entries}
            # Masked by the grammar: only letters. Otherwise the unconstrained first draw was allowed and
            # the candidates are the whole vocabulary: fine if every letter is there, else draw again.
            if tokens <= set(letters) or set(letters) <= tokens:
                break
        else:
            raise ModelResponseError(
                "post_sampling_unmasked",
                "post_sampling candidates were the unmasked vocabulary {} times".format(POST_SAMPLING_ATTEMPTS),
            )
        latency_ms = int((time.monotonic() - started) * 1000)
        timings = answer.get("timings")
        try:
            content = (choice.get("message") or {}).get("content") or ""
        except AttributeError:
            content = ""
        return {
            "top_logprobs": entries,
            "content": content,
            "timings": timings if isinstance(timings, dict) else {},
            "latency_ms": latency_ms,
            "source": source,
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
              prompt_hash TEXT NOT NULL, prompt_version INTEGER NOT NULL,
              probability_source TEXT NOT NULL, state_text TEXT NOT NULL,
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
                "INSERT INTO paper_futures_llm_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    row["product_id"], row["bucket_start"], row["question_id"], row["question_version"],
                    row["verdict_hash"], row["question_type"], row["model_ref"], dump(row["model_info"]),
                    row["prompt_hash"], row["prompt_version"], row["probability_source"], row["state_text"], dump(row["top_logprobs"]), dump(row["probabilities"]),
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


def ask_model(provider, prompt, letters, question, temperature, template, mode):
    """Asks for one answer and converts it; returns ``{output, result, source}``.

    ``raw_logprobs`` and ``post_sampling`` use that source only. ``auto`` asks raw first and, when
    an option letter is missing (or none is there), asks again with post_sampling; a partial raw
    answer is kept only if post_sampling cannot be read.
    """
    if mode not in SOURCE_MODES:
        raise ValueError("unknown probability source {!r}".format(mode))
    first = RAW_SOURCE if mode != POST_SOURCE else POST_SOURCE
    output = provider.complete(prompt, letters, source=first, template=template)
    try:
        result = convert(question, output["top_logprobs"], temperature, content=output.get("content", ""))
        raw_error = None
    except ModelResponseError as error:
        result, raw_error = None, error
    if mode != "auto" or (result is not None and not result["missing"]):
        if raw_error is not None:
            raise raw_error
        return {"output": output, "result": result, "source": first}
    try:
        second = provider.complete(prompt, letters, source=POST_SOURCE, template=template)
        second_result = convert(question, second["top_logprobs"], temperature, content=second.get("content", ""))
    except ModelResponseError:
        if result is not None:
            return {"output": output, "result": result, "source": RAW_SOURCE}
        raise
    second = dict(second, latency_ms=(output.get("latency_ms") or 0) + (second.get("latency_ms") or 0))
    return {"output": second, "result": second_result, "source": POST_SOURCE}


def evaluate(provider, verdicts, market, product_id, bucket_start, question, calibration,
             template=None, mode="auto"):
    """Builds the state, asks the model and converts the answer. Stores nothing."""
    template = template or default_template()
    verdict = verdicts.payload(product_id, bucket_start)
    candles = market.window(
        product_id, ONE_MINUTE_MS, bucket_start + ONE_MINUTE_MS, verdict["decision_known_at_ms"], 61
    )
    state = build_state(verdict, candles, question["state_fields"])
    prompt = build_prompt(state, question, template)
    temperature = temperature_for(calibration, question["id"], question["version"])
    answer = ask_model(provider, prompt, question_letters(question), question, temperature, template, mode)
    return {"verdict": verdict, "state": state, "prompt": prompt, "output": answer["output"],
            "result": answer["result"], "source": answer["source"], "template": template}


class DecisionService:
    """Poll loop state; ``poll()`` never raises."""

    def __init__(self, market_db_path, verdicts_db_path, store, provider, questions, calibration,
                 products, log=print, clock=None, max_age_ms=DEFAULT_MAX_AGE_MS,
                 template=None, probability_source=None):
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
        defaults = load_prompt_config()
        self.template = template or defaults["templates"][defaults["default_version"]]
        self.probability_source = probability_source or defaults["probability_source"]
        if self.probability_source not in SOURCE_MODES:
            raise ValueError("unknown probability source {!r}".format(self.probability_source))
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
                                self.calibration, self.template, self.probability_source)
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
                prompt_hash=prompt_hash(done["prompt"], self.template), prompt_version=self.template["version"],
                probability_source=done["source"], state_text=done["state"], top_logprobs=output["top_logprobs"],
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


def _present_letters(entries, letters):
    found = {}
    for entry in entries:
        letter = str(entry.get("token", "")).strip()
        if letter in letters:
            found.setdefault(letter, []).append(entry["token"])
    return found


def _run_source(provider, prompt, letters, question, source, template):
    """One request through one probability source; never raises ModelResponseError."""
    report = {"source": source, "output": None, "entries": [], "found": {}, "error": None, "result": None,
              "missing": list(letters), "latency_ms": None}
    try:
        output = provider.complete(prompt, letters, source=source, template=template)
    except ModelResponseError as error:
        report["error"] = error
        return report
    report["output"] = output
    report["entries"] = output["top_logprobs"]
    report["latency_ms"] = output.get("latency_ms")
    report["found"] = _present_letters(report["entries"], letters)
    report["missing"] = [letter for letter in letters if letter not in report["found"]]
    try:
        report["result"] = convert(question, report["entries"], 1.0, content=output.get("content", ""))
    except ModelResponseError as error:
        report["error"] = error
    return report


def _letters_cell(report, letters):
    shown = " ".join(letter for letter in letters if letter in report["found"]) or "none"
    return "{} ({}/{})".format(shown, len(report["found"]), len(letters))


def _complete(report):
    return report["result"] is not None and not report["missing"]


def _service_source(mode, reports):
    """``(source or None, note)``: what the service would use for these reports (dict by source)."""
    raw, post = reports.get(RAW_SOURCE), reports.get(POST_SOURCE)
    if mode == RAW_SOURCE:
        order = [raw]
    elif mode == POST_SOURCE:
        order = [post]
    else:
        order = [raw, post]
    for report in order:
        if report is not None and _complete(report):
            return report["source"], ""
    partial = [r for r in order if r is not None and r["result"] is not None]
    if mode == "auto" and raw is not None and raw["result"] is not None:
        return None, "degraded: raw_logprobs would be kept with {} missing".format(", ".join(raw["missing"]))
    if partial:
        return None, "degraded: {} has {} missing".format(partial[0]["source"], ", ".join(partial[0]["missing"]))
    return None, ""


def _table(rows, out_say, letters):
    out_say("{:<15}{:<19}{:<44}{}".format("source", "letters present", "probabilities", "latency_ms"))
    for report in rows:
        probs = _fmt_probs(report["result"]["probabilities"]) if report["result"] is not None else "-"
        latency = "-" if report["latency_ms"] is None else str(report["latency_ms"])
        out_say("{:<15}{:<19}{:<44}{}".format(report["source"], _letters_cell(report, letters), probs, latency))


def probe(provider, questions, out=None, source="auto", template=None):
    """Guide step 4: one request per probability source and what to check in them.

    Exit 0 ok, 1 not usable, 2 model down. ``source`` is the service's configured mode, which decides
    which of the two answers counts.
    """
    out = out or sys.stdout
    say = lambda text="": print(text, file=out)
    template = template or default_template()
    question = questions.get("direction_1h") or next(iter(questions.values()))
    letters = question_letters(question)
    if not provider.health():
        say("model not healthy: GET /health did not answer 200 (still loading, or not running)")
        return 2
    prompt = build_prompt(PROBE_STATE, question, template)
    reports = {}
    try:
        for name in PROBABILITY_SOURCES:
            if source in (name, "auto"):
                reports[name] = _run_source(provider, prompt, letters, question, name, template)
    except ModelUnavailable as error:
        say("model not healthy: {}".format(error))
        return 2
    problems = 0
    say("question: {} v{} | prompt v{} | probability_source={}".format(
        question["id"], question["version"], template["version"], source))
    raw = reports.get(RAW_SOURCE)
    post = reports.get(POST_SOURCE)
    leaked = False
    if raw is not None:
        say("== raw_logprobs (logprobs before the grammar) ==")
        if raw["output"] is None:
            say("unusable response: {}".format(raw["error"]))
        else:
            entries = raw["entries"]
            say("top_logprobs ({} entries):".format(len(entries)))
            for entry in entries:
                say("  {!r}: {}".format(entry.get("token"), entry.get("logprob")))
            for letter in letters:
                found = raw["found"]
                say("letter {}: {}".format(letter, "token strings " + ", ".join(repr(t) for t in found[letter]) if letter in found else "NOT in top_logprobs"))
            if raw["missing"]:
                say("missing: {}".format(", ".join(raw["missing"])))
            leaked = thinking_leaked(entries, raw["output"].get("content", ""))
            say("thinking leaked: {}".format("YES (enable_thinking is ignored: start llama-server with --reasoning off)" if leaked else "no"))
            problems += 1 if leaked else 0
    if post is not None:
        say("== post_sampling (probabilities after the grammar and sampler chain) ==")
        if post["output"] is None:
            say("post_sampling: unavailable ({}: {})".format(post["error"].kind, post["error"]))
        else:
            say("top_probs ({} entries, zero probabilities are not listed):".format(len(post["entries"])))
            for entry in post["entries"]:
                say("  {!r}: {:.6f}".format(entry.get("token"), math.exp(entry["logprob"])))
            if post["missing"]:
                say("missing: {}".format(", ".join(post["missing"])))
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
    for report in (raw, post):
        if report is None or report["output"] is None:
            continue
        timings = report["output"].get("timings", {})
        say("{}: latency_ms: {} (prompt_ms={} predicted_ms={})".format(
            report["source"], report["latency_ms"], timings.get("prompt_ms"), timings.get("predicted_ms")))
        if report["result"] is not None:
            say("{}: probabilities: {} (chosen {}, confidence {:.3f})".format(
                report["source"], _fmt_probs(report["result"]["probabilities"]), report["result"]["chosen"],
                report["result"]["confidence"]))
        else:
            say("{}: probabilities: none ({})".format(report["source"], report["error"].kind))
    say()
    _table([r for r in (raw, post) if r is not None], say, letters)
    chosen, note = _service_source(source, reports)
    say("service would use: {}{}".format(chosen or "none", " ({})".format(note) if note else ""))
    if chosen is None:
        problems += 1
    say("RESULT: {}".format(
        "ok (probabilities from {})".format(chosen) if problems == 0 else "{} problem(s): do not continue".format(problems)))
    return 0 if problems == 0 else 1


def probe_prompt_variants(provider, questions, out=None, source="auto", config=None):
    """Compares every prompt version through both probability sources on the same state."""
    out = out or sys.stdout
    say = lambda text="": print(text, file=out)
    config = config or load_prompt_config()
    question = questions.get("direction_1h") or next(iter(questions.values()))
    letters = question_letters(question)
    if not provider.health():
        say("model not healthy: GET /health did not answer 200 (still loading, or not running)")
        return 2
    rows, by_version = [], {}
    try:
        for version, template in sorted(config["templates"].items()):
            prompt = build_prompt(PROBE_STATE, question, template)
            by_version[version] = {}
            for name in PROBABILITY_SOURCES:
                by_version[version][name] = _run_source(provider, prompt, letters, question, name, template)
    except ModelUnavailable as error:
        say("model not healthy: {}".format(error))
        return 2
    say("question: {} v{} | prompt versions: {} | probability_source={}".format(
        question["id"], question["version"], ", ".join(str(v) for v in sorted(config["templates"])), source))
    say("{:<5}{:<15}{:<19}{:<44}{}".format("v", "source", "letters present", "probabilities", "latency_ms"))
    for version in sorted(by_version):
        for name in PROBABILITY_SOURCES:
            report = by_version[version][name]
            probs = _fmt_probs(report["result"]["probabilities"]) if report["result"] is not None else (
                "-" if report["error"] is None else report["error"].kind)
            latency = "-" if report["latency_ms"] is None else str(report["latency_ms"])
            say("{:<5}{:<15}{:<19}{:<44}{}{}".format(
                "v{}".format(version), name, _letters_cell(report, letters), probs, latency,
                "  (default prompt)" if version == config["default_version"] else ""))
    say()
    raw_ok = [v for v in sorted(by_version) if _complete(by_version[v][RAW_SOURCE])]
    post_ok = [v for v in sorted(by_version) if _complete(by_version[v][POST_SOURCE])]
    say("all letters present in raw_logprobs for prompt versions: {}".format(
        ", ".join("v{}".format(v) for v in raw_ok) or "none"))
    say("all letters present in post_sampling for prompt versions: {}".format(
        ", ".join("v{}".format(v) for v in post_ok) or "none"))
    default = config["default_version"]
    chosen, note = _service_source(source, by_version[default])
    say("service would use (prompt v{}, probability_source={}): {}{}".format(
        default, source, chosen or "none", " ({})".format(note) if note else ""))
    say("RESULT: {}".format(
        "ok (prompt v{} -> {})".format(default, chosen) if chosen else "1 problem(s): prompt v{} gets no usable probabilities".format(default)))
    return 0 if chosen else 1


def ask(provider, questions, calibration, market_db, verdicts_db, question_id, product_id, out=None,
        template=None, mode="auto"):
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
        done = evaluate(provider, verdicts, market, product_id, bucket, question, calibration, template, mode)
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
    say("prompt: v{}".format(done["template"]["version"]))
    say("state:\n" + done["state"])
    say("probability_source: {}".format(done["source"]))
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
    parser.add_argument("--probe-prompt-variants", action="store_true",
                        help="compare every prompt version through both probability sources (one request each)")
    parser.add_argument("--probability-source", choices=SOURCE_MODES,
                        help="raw_logprobs, post_sampling or auto (default: decision-prompts.json)")
    parser.add_argument("--prompt-version", type=int, help="prompt template version (default: decision-prompts.json)")
    parser.add_argument("--prompts-file")
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
        prompts = load_prompt_config(args.prompts_file)
        version = args.prompt_version if args.prompt_version is not None else prompts["default_version"]
        if version not in prompts["templates"]:
            raise ValueError("unknown prompt version {} (have {})".format(
                version, ", ".join(str(v) for v in sorted(prompts["templates"]))))
        template = prompts["templates"][version]
        mode = args.probability_source or prompts["probability_source"]
        if provider is None:
            provider = LlamaCppProvider(args.llama_url or llama_url(env), model_ref(env), timeout=args.timeout_seconds)
    except (OSError, ValueError) as error:
        print("configuration error: {}".format(error), file=sys.stderr)
        return 2
    if args.probe_prompt_variants:
        return probe_prompt_variants(provider, questions, source=mode, config=prompts)
    if args.probe:
        return probe(provider, questions, source=mode, template=template)
    if args.ask:
        if args.ask not in questions:
            print("unknown question {!r}; catalog: {}".format(args.ask, ", ".join(sorted(questions))), file=sys.stderr)
            return 2
        if not (args.market_db and args.verdicts_db):
            print("--ask needs --market-db and --verdicts-db", file=sys.stderr)
            return 2
        return ask(provider, questions, calibration, args.market_db, args.verdicts_db, args.ask,
                   args.product or products[0], template=template, mode=mode)
    if not (args.market_db and args.verdicts_db and args.decisions_db):
        print("--market-db, --verdicts-db and --decisions-db are required", file=sys.stderr)
        return 2
    store = DecisionStore(args.decisions_db, DECISION_CONFIG)
    service = DecisionService(args.market_db, args.verdicts_db, store, provider, questions, calibration, products,
                              log=log, max_age_ms=int(args.max_age_seconds * 1000),
                              template=template, probability_source=mode)
    try:
        if args.once:
            print("decisions written {}".format(service.poll()))
            return 0
        log("decisions writing to {} (config {}) for {}; {} question(s): {}; prompt v{}, probability_source={}".format(
            args.decisions_db, store.config_hash[:12], ", ".join(products), len(questions), ", ".join(sorted(questions)),
            template["version"], mode))
        run(service, args.poll_seconds, log)
    except KeyboardInterrupt:
        pass
    finally:
        service.close()
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
