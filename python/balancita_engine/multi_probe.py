"""Diagnostics for the Qwen selector (arm C): what did it see and why did it say WAIT.

Two read-only tools, neither changes a threshold or a prompt:

* ``summarize_stored(store)``: per stored Qwen selection, the signals it saw, the per-option probability of every
  rotated question and the merged answer; totals by outcome and by number of backing strategies.
* ``probe(selector)``: the selector's answer on synthetic states with known structure (coherent strong signals,
  one strong signal alone, contradiction, weak signals, none), to check that it *can* choose BUY or SELL.

``python -m balancita_engine.multi_probe --qwen llama`` asks the real model (local only); ``--store path`` summarizes a
stored experiment.
"""

import argparse
import json
from decimal import Decimal

from .multi_select import QwenSelector
from .multi_signals import BUY, SELL, WAIT, make_signal

PRODUCT = "PF_XBTUSD"
STRATEGIES = (("mx-funding-v1", 1440), ("mx-momentum-v1", 240), ("mx-meanrev-v1", 120))
CONTEXT = {"regime": "unknown"}
HISTORY = {"sample_size": 150, "hit_rate": Decimal("0.62")}


def _signals(actions, strength, history=None, cycle_ms=1_800_000_000_000):
    """One signal per strategy; ``actions`` is BUY / SELL / WAIT per strategy, in STRATEGIES order."""
    out = []
    for (strategy_id, horizon), action in zip(STRATEGIES, actions):
        out.append(make_signal(strategy_id=strategy_id, strategy_version=1, product_id=PRODUCT, bucket_ms=cycle_ms,
                               action=action, strength=strength if action != WAIT else 0, horizon_minutes=horizon,
                               evidence={"synthetic": "yes"} if action != WAIT else {}, reliability=history))
    return out


def scenarios():
    """name -> (signals, what a sensible selector is expected to do: 'trade' / 'wait' / 'either')."""
    return {
        "coherent_sell_3_of_3": (_signals((SELL, SELL, SELL), "0.9"), "trade"),
        "coherent_buy_3_of_3": (_signals((BUY, BUY, BUY), "0.9"), "trade"),
        "coherent_sell_with_record": (_signals((SELL, SELL, SELL), "0.9", HISTORY), "trade"),
        "two_of_three_buy": (_signals((BUY, BUY, WAIT), "0.8"), "trade"),
        "single_strong_sell": (_signals((SELL, WAIT, WAIT), "0.9"), "either"),
        "single_strong_sell_with_record": (_signals((SELL, WAIT, WAIT), "0.9", HISTORY), "either"),
        "single_weak_sell": (_signals((SELL, WAIT, WAIT), "0.3"), "wait"),
        "contradiction": (_signals((BUY, SELL, WAIT), "0.9"), "wait"),
        "weak_3_of_3": (_signals((BUY, BUY, BUY), "0.2"), "either"),
        "no_signals": (_signals((WAIT, WAIT, WAIT), "0"), "wait"),
    }


def probe(selector, cycle_ms=1_800_000_000_000):
    rows = []
    for name, (signals, expected) in scenarios().items():
        answer = selector.select(PRODUCT, cycle_ms, signals, CONTEXT)
        detail = answer.get("detail") or {}
        rows.append({"scenario": name, "expected": expected, "action": answer["action"], "reason": answer["reason"],
                     "probabilities": detail.get("probabilities"), "by_order": detail.get("order_probabilities")})
    return rows


def summarize_stored(store):
    """Totals over the stored Qwen selections (arm C) and, per selection, what Qwen saw and answered."""
    rows, totals = [], {"selections": 0, "by_action": {}, "by_reason": {}, "by_backing": {}, "wait_probability": []}
    signals = {s["signal_id"]: s for s in store.signals()}
    for selection in store.selections(arm="C"):
        detail = selection.get("detail") or {}
        if "probabilities" not in detail:
            continue  # not asked: no candidate, or the model failed before answering
        seen = [signals[i] for i in selection["signal_ids"] if i in signals]
        backing = sum(1 for s in seen if s["action"] != WAIT)
        probabilities = detail["probabilities"]
        row = {"decision_id": selection["decision_id"], "product_id": selection["product_id"],
               "cycle_ms": selection["cycle_ms"], "action": selection["action"], "reason": selection["reason"],
               "probabilities": probabilities, "by_order": detail.get("order_probabilities"),
               "signals": [[s["strategy_id"], s["action"], s["strength"], s["evidence"]] for s in seen]}
        rows.append(row)
        totals["selections"] += 1
        for key, value in (("by_action", selection["action"]), ("by_reason", selection["reason"]),
                           ("by_backing", str(backing))):
            totals[key][value] = totals[key].get(value, 0) + 1
        totals["wait_probability"].append(float(probabilities.get("wait", 0)))
    waits = totals.pop("wait_probability")
    totals["wait_probability_mean"] = round(sum(waits) / len(waits), 4) if waits else None
    totals["wait_probability_min"] = min(waits) if waits else None
    return {"totals": totals, "selections": rows}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Qwen selector diagnostics (read-only).")
    parser.add_argument("--qwen", choices=("llama",), help="probe the real local model on synthetic states")
    parser.add_argument("--store", help="summarize the Qwen selections stored in this multi.sqlite")
    args = parser.parse_args(argv)
    result = {}
    if args.qwen:
        from . import futures_llm_decisions as llm
        import os

        selector = QwenSelector(llm.LlamaCppProvider(llm.llama_url(os.environ), llm.model_ref(os.environ)))
        result["model"] = selector.model_identity()
        result["probe"] = probe(selector)
    if args.store:
        from .multi_store import DecisionStore

        store = DecisionStore(args.store)
        try:
            result["stored"] = summarize_stored(store)
        finally:
            store.close()
    print(json.dumps(result, indent=2, sort_keys=True, default=str))


if __name__ == "__main__":
    main()
