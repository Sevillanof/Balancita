"""One explicit, comparable plan for every strategy (read-only view, never written back to a spec).

Rule strategies (C25-C30 and anything made in /estrategias) are ``balancita-strategy.v1`` specs; C31 (Qwen
closes) and Kronos are not rules but decide with a model. ``strategy_plan`` shows all of them with the same
fields: signal, entry, exit (stop, target, time), size, products and costs. Defaults are resolved here only:
nothing is added to a spec, so ``spec_hash`` (which binds reliability and forward trades) does not move.
"""

import copy
import json
import os

from .futures_costs import COST_MODEL_VERSION
from .futures_products import resolve_products
from .futures_simulator import DEFAULT_NOTIONAL_USD
from .futures_spec_strategy import _param, declared_indicators, spec_hash

PLAN_SCHEMA = "futures-strategy-plan.v1"
KRONOS_ID = "kronos-small-1h-h4-v1"
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
QWEN_EXIT_CONFIG = os.path.join(_ROOT, "config", "qwen-exit.json")


def _costs():
    return {"model": COST_MODEL_VERSION, "scope": "per_product_shared"}


def _rules_plan(rules, params):
    risk = rules["risk"]
    exit_rules = {side: node.get("cmp") or sorted(node)[0] for side, node in rules["exit"].items()}
    return {
        "entry": {"sides": sorted(rules["sides"]), "checks": [c.get("name") for c in rules["checks"]]},
        "exit": {
            "stop_atr": _param(risk["stop_atr"], params),
            "target_stop_ratio": _param(risk["target_stop_ratio"], params),
            "volatility": risk.get("vol", "1m.atr14"),
            "time_minutes": rules["horizon_minutes"],
            "rule": exit_rules,
        },
    }


def spec_plan(spec):
    """The plan of a rule spec; the input is never modified."""
    spec = copy.deepcopy(spec)
    params = spec.get("params", {})
    kind = spec.get("kind", "rules")
    plan = {
        "schema": PLAN_SCHEMA, "id": spec["id"], "version": spec["version"], "spec_hash": spec_hash(spec),
        "signal": {"type": kind}, "params": dict(params),
        "indicators": {k: list(v) for k, v in declared_indicators(spec).items()},
        "size": {"mode": "fixed_notional", "notional_usd": DEFAULT_NOTIONAL_USD},
        "products": "all", "costs": _costs(),
    }
    if kind == "regime_adapter":
        plan["branches"] = {regime: dict(_rules_plan(b["rules"], params), id=b["id"])
                            for regime, b in spec["branches"].items()}
    else:
        plan.update(_rules_plan(spec["rules"], params))
    return plan


def qwen_exit_plan(config=None):
    """C31: entries from shipped specs, Qwen decides every exit (no stop, target or time stop)."""
    if config is None:
        with open(QWEN_EXIT_CONFIG, encoding="utf-8") as handle:
            config = json.load(handle)
    return {
        "schema": PLAN_SCHEMA, "id": config["strategy_id"], "version": 1, "spec_hash": None,
        "signal": {"type": "model", "model": "qwen", "question": "exit_decision",
                   "entry_specs": list(config["entry_specs"])},
        "params": {}, "indicators": {},
        "entry": {"sides": ["LONG", "SHORT"], "checks": list(config["entry_specs"])},
        "exit": {"stop_atr": None, "target_stop_ratio": None, "volatility": None, "time_minutes": None,
                 "rule": {"LONG": "qwen_exit_decision", "SHORT": "qwen_exit_decision"}},
        "size": {"mode": "fixed_notional", "notional_usd": config["notional_usd"]},
        "products": "all", "costs": _costs(),
    }


def kronos_plan(module=None):
    """Kronos-small: the parameters fixed in ``kronos_lab.lab`` (imported lazily; it needs no weights to import)."""
    if module is None:
        from kronos_lab import lab as module
    return {
        "schema": PLAN_SCHEMA, "id": module.STRATEGY_ID, "version": 1, "spec_hash": None,
        "signal": {"type": "model", "model": "kronos-small", "candles": "1h", "context_candles": 400,
                   "threshold_cost_multiple": module.K},
        "params": {}, "indicators": {},
        "entry": {"sides": ["LONG", "SHORT"], "checks": ["mean_log_return_exceeds_k_round_trip_cost"]},
        "exit": {"stop_atr": None, "target_stop_ratio": None, "volatility": None,
                 "time_minutes": module.HORIZON * 60, "rule": {"LONG": "time_stop", "SHORT": "time_stop"}},
        "size": {"mode": "fixed_notional", "notional_usd": str(module.NOTIONAL)},
        "products": "all", "costs": _costs(),
    }


def all_plans(specs):
    """Plans of every rule spec plus C31 and Kronos, keyed by strategy id."""
    plans = {spec["id"]: spec_plan(spec) for spec in specs.values()}
    for plan in (qwen_exit_plan(), kronos_plan()):
        plans[plan["id"]] = plan
    return plans
