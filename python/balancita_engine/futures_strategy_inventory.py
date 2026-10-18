"""Read-only inventory of every strategy: operational state apart from research state.

``GET /api-strategies/inventory`` (contract: ``docs/strategy-inventory-api.md``) combines what is
already written elsewhere and writes nothing:

* the registry S (lifecycle state of each strategy, from ``registry.list()``),
* ``config/strategy-closed.json``, ``config/strategy-freeze.json``,
  ``config/forward-strategies.json``, ``config/qwen-exit.json``,
* ``config/strategy-reliability.json`` (verdict and numbers of the backtest),
* the shipped specs and the model descriptor of Kronos,
* the carry counter summary, when it exists.

Two axes are never mixed: ``operational`` (does it run: active, closed, ...) and ``research``
(what the evidence says: the reliability verdict). Nothing is invented: a datum with no source is
``None`` and the front shows "No disponible". Forward results (trades, PnL, open positions) are
not in any config: they are B5, listed in ``MISSING``.
"""

import json
import os

from .futures_spec_strategy import DEFAULT_SPEC_DIR, load_specs, spec_hash
from .futures_strategy_plan import kronos_plan, spec_plan
from .futures_simulator import DEFAULT_NOTIONAL_USD

INVENTORY_SCHEMA = "futures-strategy-inventory.v1"
DEFAULT_CONFIG_DIR = os.path.dirname(DEFAULT_SPEC_DIR)

# What the inventory cannot say yet, exactly, so nobody fills it with a guess.
MISSING = (
    "B5: forward trades per strategy (count and net result) - no table or endpoint exposes "
    "forward.sqlite / forward-reliability.json; config files only say when a strategy was registered",
    "B5: open positions of the forward books",
    "B5: whether the forward, C31 and Kronos processes are running right now (config registers a "
    "start, it does not prove execution)",
    "B5: C31 and Kronos results (qwen-exit and kronos_lab keep them in local files, no endpoint)",
)

RESEARCH_VERDICTS = (
    "reliable_edge", "tentative_edge", "candidate_edge", "no_edge", "negative_edge", "insufficient_data",
)
# Verdicts that count as "evidence of advantage" (candidate or better).
EDGE_EVIDENCE = ("candidate_edge", "tentative_edge", "reliable_edge")
# Verdicts after which a strategy is still under study (the evidence is not conclusive).
INVESTIGATING = ("candidate_edge", "insufficient_data")


def _read(config_dir, name):
    try:
        with open(os.path.join(config_dir, name), encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, ValueError):
        return None


def _backtest(entry):
    ranges = {}
    for key, value in (entry.get("by_range") or {}).items():
        ranges[key] = {k: value.get(k) for k in ("trades", "mean_net_bp", "t_stat", "folds_positive", "folds_judged")}
    keys = ("trades", "hit_rate", "mean_net_bp", "median_net_bp", "pnl_usd", "t_stat", "deflated_probability",
            "folds_judged", "folds_positive", "selection_trials", "verdict")
    return dict({k: entry.get(k) for k in keys}, ranges=ranges)


def _research(entry, closed):
    if entry is None:
        return {"state": "unmeasured", "evidence_of_edge": False, "investigating": not closed, "backtest": None}
    verdict = entry.get("verdict")
    state = verdict if verdict in RESEARCH_VERDICTS else "unmeasured"
    return {
        "state": state,
        "evidence_of_edge": state in EDGE_EVIDENCE,
        "reliable": state == "reliable_edge",
        "investigating": (not closed) and state in INVESTIGATING + ("unmeasured",),
        "backtest": _backtest(entry),
    }


def _horizon(plan):
    return None if plan is None else (plan.get("exit") or {}).get("time_minutes")


def build_inventory(entries, specs, *, config_dir=None, carry=None):
    """The inventory. ``entries`` is ``registry.list()``; ``specs`` maps ``id`` to the stored spec of that entry."""
    config_dir = config_dir or DEFAULT_CONFIG_DIR
    reliability = _read(config_dir, "strategy-reliability.json") or {}
    table = reliability.get("strategies") or {}
    thresholds = reliability.get("thresholds") or {}
    freeze = _read(config_dir, "strategy-freeze.json") or {"ids": [], "min_forward_trades": None}
    closed = _read(config_dir, "strategy-closed.json") or {"ids": []}
    forward = _read(config_dir, "forward-strategies.json") or {"strategies": {}}
    qwen_exit = _read(config_dir, "qwen-exit.json")
    kronos = _read(os.path.join(config_dir, "models"), "kronos-small-1h-h4-v1.json")
    shipped = load_specs(os.path.join(config_dir, "strategies")) if os.path.isdir(
        os.path.join(config_dir, "strategies")) else {}
    products = (reliability.get("period") or {}).get("products") or []
    frozen = set(freeze.get("ids") or [])
    min_forward = freeze.get("min_forward_trades") or forward.get("min_forward_trades")
    registered = forward.get("strategies") or {}

    def research_entry(spec):
        if spec is None:
            return None
        entry = table.get(spec["id"])
        return entry if entry is not None and entry.get("spec_hash") == spec_hash(spec) else None

    def forward_block(start_ms=None, registered_on=None):
        return {
            "registered": start_ms is not None,
            "start_ms": start_ms,
            "registered_at": registered_on,
            "min_trades": min_forward,
            "trades": None,
            "net_bp": None,
            "available": False,
            "missing": "B5",
        }

    rows, seen = [], set()

    def add(row):
        seen.add(row["id"])
        rows.append(row)

    for entry in entries:
        strategy_id = entry["id"]
        spec = specs.get(strategy_id)
        info = registered.get(strategy_id)
        is_closed = strategy_id in (closed.get("ids") or [])
        state = entry["state"]
        research = _research(research_entry(spec), is_closed)
        plan = spec_plan(spec) if spec else None
        add({
            "id": strategy_id, "version": entry["version"], "name": entry["name"],
            "description": entry.get("description", ""), "kind": "rules", "spec_hash": entry.get("spec_hash"),
            "operational": {
                "state": "closed" if is_closed else state, "basis": "registry",
                "since_ms": entry.get("state_known_at") or None,
                "reason": entry.get("state_reason"),
            },
            "frozen": strategy_id in frozen,
            "research": research,
            "forward": forward_block((info or {}).get("start_ms"), (info or {}).get("registered")),
            "market": {"products": len(products) or None, "horizon_minutes": _horizon(plan),
                       "exit_by": "rules"},
            "note": (info or {}).get("why"), "no_backtest": bool((info or {}).get("no_backtest")),
        })

    # Closed strategies are deleted from the registry at start: they come back from the shipped specs.
    for strategy_id in closed.get("ids") or []:
        spec = shipped.get(strategy_id)
        if strategy_id in seen or spec is None:
            continue
        plan = spec_plan(spec)
        add({
            "id": strategy_id, "version": spec["version"], "name": spec["name"],
            "description": spec.get("description", ""), "kind": "rules", "spec_hash": spec_hash(spec),
            "operational": {"state": "closed", "basis": "config", "since_ms": None,
                            "reason": closed.get("reason")},
            "frozen": strategy_id in frozen,
            "research": _research(research_entry(spec), True),
            "forward": forward_block(),
            "market": {"products": len(products) or None, "horizon_minutes": _horizon(plan),
                       "exit_by": "rules"},
            "note": closed.get("note"), "no_backtest": False,
        })

    # Shipped specs the registry does not know and nothing closes: state unknown.
    for strategy_id, spec in shipped.items():
        if strategy_id in seen:
            continue
        add({
            "id": strategy_id, "version": spec["version"], "name": spec["name"],
            "description": spec.get("description", ""), "kind": "rules", "spec_hash": spec_hash(spec),
            "operational": {"state": "unverified", "basis": "none", "since_ms": None, "reason": None},
            "frozen": strategy_id in frozen,
            "research": _research(research_entry(spec), False),
            "forward": forward_block(),
            "market": {"products": len(products) or None, "horizon_minutes": _horizon(spec_plan(spec)),
                       "exit_by": "rules"},
            "note": None, "no_backtest": False,
        })

    if qwen_exit is not None:
        strategy_id = qwen_exit["strategy_id"]
        off = qwen_exit.get("off")  # the one switch (owner decision): shown as "off" with its reason, never hidden
        rows.append({
            "id": strategy_id, "version": 1, "name": "C31 Qwen decide salidas",
            "description": "Entradas de {}; Qwen decide cada salida.".format(
                ", ".join(s.split("-")[0].upper() for s in qwen_exit["entry_specs"])),
            "kind": "qwen_exit", "spec_hash": None,
            # Registered in config with a start; a config does not prove the process runs now.
            "operational": ({"state": "off", "basis": "config", "since_ms": None,
                             "reason": "apagada desde {}: {}".format(off.get("since"), off.get("reason"))}
                            if off else
                            {"state": "unverified", "basis": "config", "since_ms": qwen_exit.get("start_ms"),
                             "reason": "registered_in_qwen_exit_config"}),
            "frozen": strategy_id in frozen,
            "research": {"state": "unmeasured", "evidence_of_edge": False, "reliable": False,
                         "investigating": not off, "backtest": None},
            "forward": forward_block(qwen_exit.get("start_ms"), qwen_exit.get("registered")),
            "market": {"products": len(products) or None, "horizon_minutes": None, "exit_by": "qwen"},
            "note": qwen_exit.get("note"), "no_backtest": True,
        })

    if kronos is not None:
        plan = kronos_plan(kronos)
        rows.append({
            "id": kronos["id"], "version": kronos["version"],
            "name": kronos["name"],
            "description": "Modelo de predicción de velas de {} · horizonte {} min.".format(
                kronos["candles"], kronos["horizon_minutes"]),
            "kind": "model", "spec_hash": None,
            # No config registers a start for Kronos: whether it runs is not verifiable here.
            "operational": {"state": "unverified", "basis": "none", "since_ms": None, "reason": None},
            "frozen": kronos["id"] in frozen,
            "research": {"state": "unmeasured", "evidence_of_edge": False, "reliable": False,
                         "investigating": True, "backtest": None},
            "forward": forward_block(),
            "market": {"products": len(products) or None, "horizon_minutes": _horizon(plan), "exit_by": "time"},
            "note": kronos.get("note"), "no_backtest": True,
        })

    if carry is not None:
        rows.append({
            "id": carry["id"], "version": 1, "name": carry["name"], "description": carry.get("note", ""),
            "kind": "carry", "spec_hash": None,
            # Without a state or summary file the "enabled" flag is only the config default: not verified.
            "operational": {"state": ("unverified" if carry.get("start_ms") is None and carry.get("updated_ms") is None
                                      else "tracking" if carry.get("enabled") else "inactive"),
                            "basis": "registry",
                            "since_ms": carry.get("start_ms"), "reason": None},
            "frozen": False,
            "research": {"state": "registry_note", "evidence_of_edge": False, "reliable": False,
                         "investigating": False, "backtest": None, "text": carry.get("label")},
            "forward": forward_block(),
            "market": {"products": len(carry.get("products") or []) or None, "horizon_minutes": None,
                       "exit_by": None},
            "note": carry.get("note"), "no_backtest": True,
        })

    order = {"closed": 1}
    rows.sort(key=lambda r: (order.get(r["operational"]["state"], 0), r["kind"] == "carry", r["id"]))
    return {
        "schema": INVENTORY_SCHEMA,
        "cost_model": reliability.get("cost_model"),
        "notional_usd": DEFAULT_NOTIONAL_USD,
        "thresholds": thresholds,
        "forward_min_trades": min_forward,
        "period": reliability.get("period"),
        "counts": _counts(rows),
        "strategies": rows,
        "missing": list(MISSING),
    }


def _counts(rows):
    open_rows = [r for r in rows if r["operational"]["state"] != "closed" and r["kind"] != "carry"]
    return {
        "strategies": len([r for r in rows if r["kind"] != "carry"]),
        "active": len([r for r in open_rows if r["operational"]["state"] == "active"]),
        "frozen": len([r for r in rows if r["frozen"]]),
        "closed": len([r for r in rows if r["operational"]["state"] == "closed"]),
        "investigating": len([r for r in rows if r["research"]["investigating"]]),
        "edge_evidence": len([r for r in rows if r["research"]["evidence_of_edge"]]),
    }
