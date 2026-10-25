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
not in any config: they come from ``futures_forward_result.read_forward`` (``forward.trades``, docs/forward-result-api.md).
"""

import calendar
import json
import os
import re
import time

from .futures_forward_result import strategy_block
from .futures_spec_strategy import DEFAULT_SPEC_DIR, load_specs, spec_hash
from .futures_strategy_plan import kronos_plan, spec_plan
from .futures_simulator import DEFAULT_NOTIONAL_USD
from .strategy_gate_models import QWEN_LIVE_ID

INVENTORY_SCHEMA = "futures-strategy-inventory.v1"
DEFAULT_CONFIG_DIR = os.path.dirname(DEFAULT_SPEC_DIR)

# What the inventory cannot say yet, exactly, so nobody fills it with a guess.
MISSING = (
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


_OFF_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def qwen_exit_off(config):
    """The one C31 switch rule (the same in the launcher and the gateway): ``None`` when the ``off`` key is absent (on);
    otherwise ``{"since", "reason", "invalid"}``. The block is valid only as an object with a non-empty ``reason`` and a
    ``since`` date ``YYYY-MM-DD``; anything else (``{}``, ``null``, ``true``, a blank reason) is a config error: the
    strategy stays off (fail-safe), ``invalid`` is true and the reason says so."""
    if "off" not in config:
        return None
    off = config["off"]
    reason = off.get("reason") if isinstance(off, dict) else None
    since = off.get("since") if isinstance(off, dict) else None
    if isinstance(reason, str) and reason.strip() and isinstance(since, str) and _OFF_DATE.match(since):
        return {"since": since, "reason": reason, "invalid": False}
    return {"since": None, "invalid": True,
            "reason": 'config/qwen-exit.json: bloque "off" inválido (hace falta "reason" no vacío y "since" AAAA-MM-DD): apagada por seguridad'}


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


def build_inventory(entries, specs, *, config_dir=None, carry=None, forward_result=None):
    """The inventory. ``entries`` is ``registry.list()``; ``specs`` maps ``id`` to the stored spec of that entry."""
    config_dir = config_dir or DEFAULT_CONFIG_DIR
    reliability = _read(config_dir, "strategy-reliability.json") or {}
    table = reliability.get("strategies") or {}
    thresholds = reliability.get("thresholds") or {}
    freeze = _read(config_dir, "strategy-freeze.json") or {"ids": [], "min_forward_trades": None}
    closed = _read(config_dir, "strategy-closed.json") or {"ids": []}
    forward = _read(config_dir, "forward-strategies.json") or {"strategies": {}}
    qwen_exit = _read(config_dir, "qwen-exit.json")
    qwen_live = _read(config_dir, "qwen-live.json")
    kronos = _read(os.path.join(config_dir, "models"), "kronos-small-1h-h4-v1.json")
    shipped = load_specs(os.path.join(config_dir, "strategies")) if os.path.isdir(
        os.path.join(config_dir, "strategies")) else {}
    products = (reliability.get("period") or {}).get("products") or []
    frozen = set(freeze.get("ids") or [])
    min_forward = forward.get("min_forward_trades")
    registered = forward.get("strategies") or {}
    retired = closed.get("retired") or {}

    def retirement(strategy_id):
        """``(since_ms, reason)`` of a closed strategy: its own retirement (date, reason) or the file's general one."""
        own = retired.get(strategy_id) or {}
        return _day_ms(own.get("date")), own.get("reason") or closed.get("reason")

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
            "available": False,
            "missing": None,
            "problems": [],
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
        since_ms, closed_reason = retirement(strategy_id) if is_closed else (None, None)
        add({
            "id": strategy_id, "version": entry["version"], "name": entry["name"],
            "description": entry.get("description", ""), "kind": "rules", "spec_hash": entry.get("spec_hash"),
            "operational": {
                "state": "closed" if is_closed else state, "basis": "registry",
                "since_ms": since_ms or entry.get("state_known_at") or None,
                "reason": closed_reason or entry.get("state_reason"),
            },
            "frozen": strategy_id in frozen,
            "research": research,
            "forward": forward_block((info or {}).get("start_ms"), (info or {}).get("registered")),
            "market": {"products": len(products) or None, "horizon_minutes": _horizon(plan),
                       "exit_by": "rules"},
            "note": None if is_closed and strategy_id in retired else (info or {}).get("why"),
            "no_backtest": bool((info or {}).get("no_backtest")),
        })

    # Closed strategies are deleted from the registry at start: they come back from the shipped specs.
    for strategy_id in closed.get("ids") or []:
        spec = shipped.get(strategy_id)
        if strategy_id in seen or spec is None:
            continue
        plan = spec_plan(spec)
        since_ms, closed_reason = retirement(strategy_id)
        add({
            "id": strategy_id, "version": spec["version"], "name": spec["name"],
            "description": spec.get("description", ""), "kind": "rules", "spec_hash": spec_hash(spec),
            "operational": {"state": "closed", "basis": "config", "since_ms": since_ms,
                            "reason": closed_reason},
            "frozen": strategy_id in frozen,
            "research": _research(research_entry(spec), True),
            "forward": forward_block(),
            "market": {"products": len(products) or None, "horizon_minutes": _horizon(plan),
                       "exit_by": "rules"},
            "note": None if strategy_id in retired else closed.get("note"), "no_backtest": False,
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
        off = qwen_exit_off(qwen_exit)  # the one switch (owner decision): shown as "off" with its reason, never hidden
        off_since = _day_ms(off["since"]) if off is not None and not off["invalid"] else None
        rows.append({
            "id": strategy_id, "version": 1, "name": "C31 Qwen decide salidas",
            "description": "Entradas de {}; Qwen decide cada salida.".format(
                ", ".join(s.split("-")[0].upper() for s in qwen_exit["entry_specs"])),
            "kind": "qwen_exit", "spec_hash": None,
            # Registered in config with a start; a config does not prove the process runs now.
            "operational": ({"state": "off", "basis": "config", "since_ms": off_since,
                             "reason": off["reason"] if off["invalid"] else
                             "apagada desde {}: {}".format(off["since"], off["reason"])}
                            if off is not None else
                            {"state": "unverified", "basis": "config", "since_ms": qwen_exit.get("start_ms"),
                             "reason": "registered_in_qwen_exit_config"}),
            "frozen": strategy_id in frozen,
            "research": {"state": "unmeasured", "evidence_of_edge": False, "reliable": False,
                         "investigating": off is None, "backtest": None},
            "forward": forward_block(qwen_exit.get("start_ms"), qwen_exit.get("registered")),
            "market": {"products": len(products) or None, "horizon_minutes": None, "exit_by": "qwen"},
            "note": qwen_exit.get("note"), "no_backtest": True,
        })

    if qwen_live is not None:
        rows.append({
            "id": QWEN_LIVE_ID, "version": 1, "name": "Qwen en vivo",
            "description": "Qwen decide cada entrada y cada salida, cada 15 minutos, en {}.".format(
                ", ".join(qwen_live.get("products") or [])),
            "kind": "qwen_live", "spec_hash": None,
            # It trades in the paper all the time; a config does not prove the process runs now.
            "operational": {"state": "unverified", "basis": "config", "since_ms": None,
                            "reason": "registered_in_qwen_live_config"},
            "frozen": QWEN_LIVE_ID in frozen,
            "research": {"state": "unmeasured", "evidence_of_edge": False, "reliable": False,
                         "investigating": True, "backtest": None},
            "forward": forward_block(),
            "market": {"products": len(qwen_live.get("products") or []) or None, "horizon_minutes": 240,
                       "exit_by": "qwen"},
            "note": qwen_live.get("note"), "no_backtest": True,
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

    for row in rows:
        _attach_forward(row, forward_result, min_forward)

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
        "forward_health": None if forward_result is None else {
            key: forward_result[key] for key in ("generated_ms", "cadence_s", "late_after_s", "summary_updated_ms",
                                                 "summary_available", "funding", "q_skips")},
        "missing": list(MISSING),
    }


def _day_ms(day):
    try:
        return calendar.timegm(time.strptime(day, "%Y-%m-%d")) * 1000
    except (TypeError, ValueError):
        return None


# Strategies the forward runner does not measure in forward.sqlite: where their result lives, said, not "unknown".
_NOT_IN_FORWARD = {
    "qwen_live": "Qwen en vivo guarda su resultado en su propia base (qwen-live); este resumen no la lee",
    "qwen_exit": "C31 guarda su resultado en su propia base (qwen-exit); este resumen no la lee",
    "model": "Kronos guarda su actividad aparte (kronos_lab); este resumen no la lee",
    "carry": "contador aparte: no abre operaciones forward",
}


def _attach_forward(row, forward_result, min_trades):
    """Fills ``row['forward']`` from the forward reader: ``trades`` is the result block, or ``None`` with why."""
    forward = row["forward"]
    operational = row["operational"]
    reason = _NOT_IN_FORWARD.get(row["kind"])
    if row["kind"] == "qwen_exit" and operational["state"] == "off":
        reason = "apagada: " + str(operational.get("reason"))
    elif operational["state"] == "closed":
        reason = "cerrada: ya no se mide en el forward"
    if reason is None and forward_result is None:
        reason = ("el servicio no tiene configurada la lectura del forward "
                  "(--forward-db / --forward-summary o STRATEGY_FORWARD_PATH)")
    if reason is not None:
        forward["missing"] = reason
        return
    block = strategy_block(forward_result, row["id"], operational, min_trades=min_trades,
                           spec_hash=row.get("spec_hash"))
    forward["problems"] = block["problems"]
    if block["available"]:
        forward.update(trades=block, available=True, missing=None)
    else:
        forward["missing"] = "; ".join(p["reason"] for p in block["problems"]) or "sin resumen del forward"


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
