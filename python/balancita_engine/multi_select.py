"""Selectors of the three experimental arms (PR 100, P1).

Each selector sees the same cycle signals of a product and answers ``{action, signal_id, reason, detail}`` with
action BUY / SELL / WAIT. A selection is only a proposal: the risk engine decides whether it is authorized.

* ``StrategyDirect`` (arm A): a strategy trades its own signal.
* ``DeterministicCombiner`` (arm B): a fixed rule over the strategies' signals; the reference to beat.
* ``QwenSelector`` (arm C): the local model chooses BUY / WAIT / SELL, one letter, no thinking, with the option
  order rotated and the probabilities averaged (the same rules as the existing client). It can only pick among
  the actions backed by a strategy signal; any failure, malformed answer or timeout is WAIT.
"""

import hashlib
import os
import time
from decimal import Decimal

from . import futures_llm_decisions as llm
from .multi_signals import BUY, SELL, WAIT, is_candidate, stable_hash

D = Decimal
SELECT_QUESTION = {
    "id": "multi_select", "version": 1, "type": "choice", "order_debias": "cyclic",
    "instruction": ("Each line in signals is a rule-based strategy signal for this product with its action, strength "
                    "and historical record. Strength is not a probability. Weighing the signals together with the "
                    "market context, which action is most likely to be right now? Choose wait when the signals are "
                    "weak, contradictory or likely noise."),
    "options": [
        {"id": "wait", "description": "make no trade now"},
        {"id": "buy", "description": "open a long position now"},
        {"id": "sell", "description": "open a short position now"},
    ],
}
_ACTION = {"buy": BUY, "sell": SELL, "wait": WAIT}


def _wait(reason, detail=None):
    return {"action": WAIT, "signal_id": None, "reason": reason, "detail": detail or {}}


def _strongest(signals, action):
    pool = [s for s in signals if s["action"] == action]
    return max(pool, key=lambda s: (D(s["strength"]), s["strategy_id"])) if pool else None


class _Plain:
    """Selectors without a model: the identity is just id@version."""

    def identity_key(self):
        return "{}@{}".format(self.selector_id, self.version)


class StrategyDirect(_Plain):
    selector_id, version = "strategy-direct", 1

    def select(self, product_id, cycle_ms, signals, context=None):
        candidates = [s for s in signals if is_candidate(s)]
        if len(candidates) != 1:
            return _wait("no_signal" if not candidates else "ambiguous_strategy_scope")
        return {"action": candidates[0]["action"], "signal_id": candidates[0]["signal_id"],
                "reason": "strategy_signal", "detail": {}}


class DeterministicCombiner(_Plain):
    """Net strength = sum of BUY strengths minus sum of SELL strengths; trade the side that clears the thresholds.

    The side needs a net strength of at least ``min_net`` and, when the other side also has signals, at least
    ``dominance`` times the opposing strength. Otherwise WAIT (``contradiction`` or ``weak``).
    """

    selector_id, version = "deterministic-combiner", 1

    def __init__(self, min_net="0.6", dominance="2"):
        self.min_net, self.dominance = D(min_net), D(dominance)

    def select(self, product_id, cycle_ms, signals, context=None):
        buys = sum((D(s["strength"]) for s in signals if s["action"] == BUY), D(0))
        sells = sum((D(s["strength"]) for s in signals if s["action"] == SELL), D(0))
        if buys == 0 and sells == 0:
            return _wait("no_signal")
        net = buys - sells
        side, mine, other = (BUY, buys, sells) if net > 0 else (SELL, sells, buys)
        detail = {"buy_strength": str(buys), "sell_strength": str(sells)}
        if abs(net) < self.min_net:
            return _wait("weak" if other == 0 else "contradiction", detail)
        if other > 0 and mine < self.dominance * other:
            return _wait("contradiction", detail)
        backing = _strongest(signals, side)
        return {"action": side, "signal_id": backing["signal_id"], "reason": "combined_" + side.lower(),
                "detail": detail}


def state_text(product_id, signals, context):
    """STATE for the model: the signals, their records and the market context. Plain facts, no instructions."""
    context = context or {}
    lines = ["product={} regime={}".format(product_id, context.get("regime", "unknown"))]
    for key in ("trend", "volatility_bp", "cost_round_trip_bp", "open_exposure_usd", "contradiction"):
        if key in context:
            lines.append("{}={}".format(key, context[key]))
    for signal in sorted(signals, key=lambda s: s["strategy_id"]):
        record = signal["reliability"]
        history = "no history" if not record["sample_size"] else "hit_rate={} n={}".format(
            record["hit_rate"], record["sample_size"])
        evidence = ", ".join("{}={}".format(k, v) for k, v in sorted(signal["evidence"].items()))
        lines.append("signal {} v{}: {} strength={} horizon={}m record: {} evidence: {}".format(
            signal["strategy_id"], signal["strategy_version"], signal["action"], signal["strength"],
            signal["horizon_minutes"], history, evidence))
    return "; ".join(lines)


class QwenTimeout(llm.ModelUnavailable):
    """The time budget of one selection (all its rotated questions together) ran out."""


class _Budget:
    """Wraps a provider so the rotated questions of one selection share a single time budget.

    Before each call the remaining budget is checked (none left: ``QwenTimeout``, the model is not asked again) and the
    provider's own socket timeout is lowered to what remains, so a blocked request is interrupted at the deadline
    instead of after its full per-request timeout.
    """

    def __init__(self, provider, budget_s, clock):
        self.provider, self.budget_s, self.clock, self.started = provider, budget_s, clock, clock()

    def __getattr__(self, name):
        return getattr(self.provider, name)

    def complete(self, *args, **kwargs):
        remaining = self.budget_s - (self.clock() - self.started)
        if remaining <= 0:
            raise QwenTimeout("selection time budget exhausted")
        previous = getattr(self.provider, "timeout", None)
        if previous is not None:
            self.provider.timeout = min(previous, remaining)
        try:
            return self.provider.complete(*args, **kwargs)
        finally:
            if previous is not None:
                self.provider.timeout = previous


_FILE_HASHES = {}


def file_sha256(path):
    """SHA-256 of a model file, cached per (path, size, mtime): hashing a multi-GB GGUF once per process is enough."""
    stat = os.stat(path)
    key = (path, stat.st_size, stat.st_mtime_ns)
    if key not in _FILE_HASHES:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1 << 22), b""):
                digest.update(block)
        _FILE_HASHES[key] = digest.hexdigest()
    return _FILE_HASHES[key]


def served_model(provider, hash_file=file_sha256):
    """What the model server really loaded: configured ref, GGUF path/size/sha256, alias and build (None = unknown)."""
    try:
        info = provider.identity() or {}
    except Exception:
        info = {}
    props = info.get("props") or {}
    path = props.get("model_path")
    found = {"configured_ref": info.get("model_ref"), "model_path": path, "model_file": os.path.basename(path) if path else None,
             "model_alias": props.get("model_alias"), "build_info": props.get("build_info"), "size_bytes": None, "sha256": None}
    if path:
        try:
            found["size_bytes"] = os.stat(path).st_size
            found["sha256"] = hash_file(path)
        except OSError:
            pass  # the server may run on another machine: the file is then not hashable from here
    return found


def model_fingerprint(found):
    """Short stable id of the served model: the file hash when readable, else file name + size + alias + build, else
    the configured ref marked unverified. Two different answers here never share stored decisions."""
    if found.get("sha256"):
        return "sha256:" + found["sha256"][:16]
    if found.get("model_file"):
        return "file:" + stable_hash([found["model_file"], found.get("size_bytes"), found.get("model_alias"),
                                      found.get("build_info")])[:16]
    return "unverified:" + str(found.get("configured_ref"))


class QwenSelector:
    selector_id, version = "qwen-select", 1

    def __init__(self, provider, *, template=None, mode=None, temperature=1.0, timeout_ms=30_000, clock=time.monotonic):
        """``timeout_ms`` is the budget of the whole selection, not of one question: with 8 products it must stay
        well under the 300 s cycle (8 x 30 s = 240 s in the worst case)."""
        self.provider, self.clock = provider, clock
        config = llm.load_prompt_config()
        self.template = template or config["templates"][config["default_version"]]
        self.mode = mode or config["probability_source"]
        self.temperature, self.timeout_ms = temperature, timeout_ms
        self._served = None

    def model_identity(self):
        """The model as served when this selector was created or first used (cached; see ``select`` for changes)."""
        if self._served is None:
            self._served = served_model(self.provider)
        return dict(self._served, fingerprint=model_fingerprint(self._served))

    def model_fingerprint(self):
        return model_fingerprint(self.model_identity())

    def identity_key(self):
        return "{}@{}:{}".format(self.selector_id, self.version, self.model_fingerprint())

    def _known_hash(self, path):
        """Re-checking the model each cycle must not re-hash gigabytes: reuse the hash while path/size/mtime match."""
        return file_sha256(path)

    def select(self, product_id, cycle_ms, signals, context=None):
        candidates = [s for s in signals if is_candidate(s)]
        state = state_text(product_id, signals, context)
        expected = self.model_fingerprint()
        now_served = model_fingerprint(served_model(self.provider, hash_file=self._known_hash))
        if now_served != expected:  # the server swapped its model under a running experiment: never mix the two
            return _wait("model_changed", {"expected": expected, "served": now_served})
        try:
            budget = _Budget(self.provider, self.timeout_ms / 1000, self.clock)
            answer = llm.ask_state(budget, state, SELECT_QUESTION, self.temperature, self.template, self.mode)
            result, output = answer["result"], answer["output"]
            chosen = _ACTION[result["chosen"]]
            latency = output.get("latency_ms") or 0
            detail = {
                "question": "{}@{}".format(SELECT_QUESTION["id"], SELECT_QUESTION["version"]),
                "prompt_version": self.template["version"], "prompt_hash": llm.prompt_hash(answer["prompt"], self.template),
                "state": state, "probabilities": {k: "{:.4f}".format(v) for k, v in result["probabilities"].items()},
                "source": answer["source"], "latency_ms": latency, "model": self.model_identity(),
                "order_probabilities": [
                    {"order": o["order"], "probabilities": {k: "{:.4f}".format(v) for k, v in o["probabilities"].items()}}
                    for o in (output.get("timings") or {}).get("order_probabilities", [])],
            }
        except QwenTimeout:
            return _wait("qwen_timeout", {"budget_ms": self.timeout_ms})
        except Exception as error:  # a down, slow or malformed model must never become a trade
            return _wait("qwen_failure:" + type(error).__name__, {"error": str(error)[:200]})
        if (self.clock() - budget.started) * 1000 > self.timeout_ms or latency > self.timeout_ms:
            return _wait("qwen_timeout", detail)
        if chosen == WAIT:
            return {"action": WAIT, "signal_id": None, "reason": "qwen_wait", "detail": detail}
        backing = _strongest(candidates, chosen)
        if backing is None:
            return _wait("no_backing_signal", dict(detail, asked=chosen))
        return {"action": chosen, "signal_id": backing["signal_id"], "reason": "qwen_" + chosen.lower(), "detail": detail}


class StoredOnly:
    """Stands in for a selector when a run is rebuilt from stored selections only (same identity, never decides)."""

    def __init__(self, selector_id, version, fingerprint=None):
        self.selector_id, self.version, self.fingerprint = selector_id, version, fingerprint

    def model_fingerprint(self):
        return self.fingerprint

    def identity_key(self):
        base = "{}@{}".format(self.selector_id, self.version)
        return base if self.fingerprint is None else "{}:{}".format(base, self.fingerprint)

    def select(self, product_id, cycle_ms, signals, context=None):
        return _wait("not_stored")
