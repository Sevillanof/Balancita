"""Selectors of the three experimental arms (PR 100, P1).

Each selector sees the same cycle signals of a product and answers ``{action, signal_id, reason, detail}`` with
action BUY / SELL / WAIT. A selection is only a proposal: the risk engine decides whether it is authorized.

* ``StrategyDirect`` (arm A): a strategy trades its own signal.
* ``DeterministicCombiner`` (arm B): a fixed rule over the strategies' signals; the reference to beat.
* ``QwenSelector`` (arm C): the local model chooses BUY / WAIT / SELL, one letter, no thinking, with the option
  order rotated and the probabilities averaged (the same rules as the existing client). It can only pick among
  the actions backed by a strategy signal; any failure, malformed answer or timeout is WAIT.
"""

from decimal import Decimal

from . import futures_llm_decisions as llm
from .multi_signals import BUY, SELL, WAIT, is_candidate

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


class StrategyDirect:
    selector_id, version = "strategy-direct", 1

    def select(self, product_id, cycle_ms, signals, context=None):
        candidates = [s for s in signals if is_candidate(s)]
        if len(candidates) != 1:
            return _wait("no_signal" if not candidates else "ambiguous_strategy_scope")
        return {"action": candidates[0]["action"], "signal_id": candidates[0]["signal_id"],
                "reason": "strategy_signal", "detail": {}}


class DeterministicCombiner:
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


class QwenSelector:
    selector_id, version = "qwen-select", 1

    def __init__(self, provider, *, template=None, mode=None, temperature=1.0, timeout_ms=30_000):
        self.provider = provider
        config = llm.load_prompt_config()
        self.template = template or config["templates"][config["default_version"]]
        self.mode = mode or config["probability_source"]
        self.temperature, self.timeout_ms = temperature, timeout_ms

    def select(self, product_id, cycle_ms, signals, context=None):
        candidates = [s for s in signals if is_candidate(s)]
        state = state_text(product_id, signals, context)
        try:
            answer = llm.ask_state(self.provider, state, SELECT_QUESTION, self.temperature, self.template, self.mode)
            result, output = answer["result"], answer["output"]
            chosen = _ACTION[result["chosen"]]
            latency = output.get("latency_ms") or 0
            detail = {
                "question": "{}@{}".format(SELECT_QUESTION["id"], SELECT_QUESTION["version"]),
                "prompt_version": self.template["version"], "prompt_hash": llm.prompt_hash(answer["prompt"], self.template),
                "state": state, "probabilities": {k: "{:.4f}".format(v) for k, v in result["probabilities"].items()},
                "source": answer["source"], "latency_ms": latency, "model": _model(self.provider),
            }
        except Exception as error:  # a down, slow or malformed model must never become a trade
            return _wait("qwen_failure:" + type(error).__name__, {"error": str(error)[:200]})
        if latency > self.timeout_ms:
            return _wait("qwen_timeout", detail)
        if chosen == WAIT:
            return {"action": WAIT, "signal_id": None, "reason": "qwen_wait", "detail": detail}
        backing = _strongest(candidates, chosen)
        if backing is None:
            return _wait("no_backing_signal", dict(detail, asked=chosen))
        return {"action": chosen, "signal_id": backing["signal_id"], "reason": "qwen_" + chosen.lower(), "detail": detail}


def _model(provider):
    try:
        return provider.identity().get("model_ref")
    except Exception:
        return None
