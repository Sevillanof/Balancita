"""Declarative futures strategies (``balancita-strategy.v1``) and their interpreter.

A spec is data, never code: operands come from the closed feature catalog or are
decimal strings, and nodes are a closed set of comparisons and combinators. The
interpreter returns exactly the proposal shape of ``futures_strategies.propose``,
so C, D, E and the terminal treat a spec strategy like C25-C28.

Evaluation order is part of the contract: every node appends its conditions in
the order written, ``all``/``any`` evaluate every child, and ``and`` stops at
the first failing child (like Python ``and``).
"""

import json
import os
import re
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, localcontext

from .canonical import canonical_hash
from .futures_costs import side_impact_bps
from .futures_strategies import (
    _availability,
    _compare,
    _condition,
    _decimal,
    _proposal,
    _text,
)

SPEC_SCHEMA = "balancita-strategy.v1"
COMPARATORS = (">", ">=", "<", "<=")
SIDES = ("LONG", "SHORT")
REGIMES = ("unknown", "trend", "range")
# Feature sets an operand may read: "1m" current, "1m_previous", "5m" trend,
# and the frozen levels of an open position for exits.
SCOPES = ("1m", "1m_previous", "5m", "position")
POSITION_FIELDS = ("frozen_target", "frozen_invalidation")
REQUIREMENTS = ("previous", "trend")
DEFAULT_SPEC_DIR = os.path.normpath(os.path.join(
    os.path.dirname(__file__), "..", "..", "config", "strategies"))


class SpecError(ValueError):
    """A spec that does not follow ``balancita-strategy.v1``."""


# --- validation -----------------------------------------------------------

def _require(condition, message):
    if not condition:
        raise SpecError(message)


def _check_code(code, where):
    _require(isinstance(code, str) and code and len(code) <= 80, where + ": code must be a short string")


def _check_operand(operand, params, where):
    if isinstance(operand, dict):
        _require(set(operand) == {"mul"}, where + ": only {\"mul\": [a, b]} is a computed operand")
        factors = operand["mul"]
        _require(isinstance(factors, list) and len(factors) == 2, where + ": mul takes two operands")
        for factor in factors:
            _check_operand(factor, params, where)
        return
    _require(isinstance(operand, str) and operand, where + ": operand must be a string")
    if operand.startswith("$"):
        _require(operand[1:] in params, where + ": unknown parameter " + operand)
        return
    if "." in operand:
        scope, field = operand.split(".", 1)
        _require(scope in SCOPES, where + ": unknown scope " + scope)
        if scope == "position":
            _require(field in POSITION_FIELDS, where + ": unknown position field " + field)
        else:
            _require(field.replace("_", "").isalnum(), where + ": invalid feature name " + field)
        return
    _check_decimal(operand, where + " constant")


def _check_decimal(value, where):
    try:
        _decimal(value, where)
    except ValueError as error:
        raise SpecError(str(error)) from error


def _check_node(node, params, where):
    _require(isinstance(node, dict) and len(node) >= 1, where + ": node must be an object")
    if "cmp" in node:
        _require(set(node) == {"cmp", "left", "op", "right"}, where + ": cmp takes left, op, right")
        _check_code(node["cmp"], where)
        _require(node["op"] in COMPARATORS, where + ": op must be one of " + ", ".join(COMPARATORS))
        _check_operand(node["left"], params, where)
        _check_operand(node["right"], params, where)
    elif "available" in node:
        _require(set(node) == {"available", "operand"}, where + ": available takes operand")
        _check_code(node["available"], where)
        _check_operand(node["operand"], params, where)
    elif "regime_in" in node:
        _require(set(node) <= {"regime_in", "code"}, where + ": regime_in takes an optional code")
        _require(isinstance(node["regime_in"], list) and node["regime_in"]
                 and all(r in REGIMES for r in node["regime_in"]), where + ": invalid regimes")
        if "code" in node:
            _check_code(node["code"], where)
    elif "not" in node:
        _require(len(node) == 1, where + ": not takes one node")
        _check_node(node["not"], params, where)
    else:
        kinds = [key for key in ("all", "any", "and") if key in node]
        _require(len(kinds) == 1 and len(node) == 1, where + ": unknown node")
        children = node[kinds[0]]
        _require(isinstance(children, list) and children, where + ": " + kinds[0] + " needs children")
        for index, child in enumerate(children):
            _check_node(child, params, "{}.{}[{}]".format(where, kinds[0], index))


def _check_rules(rules, params, where):
    _require(isinstance(rules, dict), where + " must be an object")
    unknown = set(rules) - {"gates", "checks", "sides", "exit", "risk", "horizon_minutes"}
    _require(not unknown, where + ": unknown keys " + ", ".join(sorted(unknown)))
    for gate in rules.get("gates", []):
        _require(isinstance(gate, dict) and gate.get("require") in REQUIREMENTS,
                 where + ".gates: require must be previous or trend")
        _check_code(gate.get("reason"), where + ".gates")
        if "condition" in gate:
            _check_code(gate["condition"], where + ".gates")
    checks = rules.get("checks")
    _require(isinstance(checks, list) and checks, where + ".checks must be a non-empty list")
    names = set()
    for index, check in enumerate(checks):
        label = "{}.checks[{}]".format(where, index)
        _require(isinstance(check, dict) and set(check) <= {"name", "node"} and "node" in check,
                 label + " takes node and an optional name")
        if "name" in check:
            _check_code(check["name"], label)
            _require(check["name"] not in names, label + ": duplicate name")
            names.add(check["name"])
        _check_node(check["node"], params, label)
    sides = rules.get("sides")
    _require(isinstance(sides, dict) and sides and set(sides) <= set(SIDES),
             where + ".sides must map LONG and/or SHORT")
    for side, entry in sides.items():
        label = where + ".sides." + side
        _require(isinstance(entry, dict), label + " must be an object")
        unknown = set(entry) - {"requires", "reason", "invalidation", "target", "target_condition"}
        _require(not unknown, label + ": unknown keys " + ", ".join(sorted(unknown)))
        requires = entry.get("requires")
        _require(isinstance(requires, list) and requires and all(n in names for n in requires),
                 label + ".requires must name checks")
        _check_code(entry.get("reason"), label + ".reason")
        invalidation = entry.get("invalidation")
        _require(isinstance(invalidation, str) and invalidation, label + ".invalidation is required")
        _check_template(invalidation, params, label + ".invalidation")
        if "target" in entry:
            _check_operand(entry["target"], params, label + ".target")
        if "target_condition" in entry:
            _require("target" in entry, label + ".target_condition needs a target")
            _check_code(entry["target_condition"], label + ".target_condition")
    exits = rules.get("exit")
    _require(isinstance(exits, dict) and set(exits) == set(SIDES), where + ".exit must map LONG and SHORT")
    for side in SIDES:
        _check_node(exits[side], params, where + ".exit." + side)
    risk = rules.get("risk")
    _require(isinstance(risk, dict) and set(risk) == {"stop_atr", "target_stop_ratio"},
             where + ".risk takes stop_atr and target_stop_ratio")
    for key in ("stop_atr", "target_stop_ratio"):
        _check_decimal(_param(risk[key], params), where + ".risk." + key)
        _require(_decimal(_param(risk[key], params), where + ".risk." + key) > 0,
                 where + ".risk." + key + " must be positive")
    horizon = rules.get("horizon_minutes")
    _require(isinstance(horizon, int) and not isinstance(horizon, bool) and 0 < horizon <= 1440,
             where + ".horizon_minutes must be 1-1440")


def _check_template(template, params, where):
    rest = template
    while "{" in rest:
        start = rest.index("{")
        _require("}" in rest[start:], where + ": unclosed {")
        end = rest.index("}", start)
        _check_operand(rest[start + 1:end], params, where)
        rest = rest[end + 1:]


def validate_spec(spec):
    """Raise ``SpecError`` unless ``spec`` is a valid ``balancita-strategy.v1``."""
    _require(isinstance(spec, dict), "spec must be an object")
    unknown = set(spec) - {"schema", "id", "version", "name", "description", "params", "kind", "rules", "branches", "indicators"}
    _require(not unknown, "unknown keys " + ", ".join(sorted(unknown)))
    _require(spec.get("schema") == SPEC_SCHEMA, "schema must be " + SPEC_SCHEMA)
    strategy_id = spec.get("id")
    _require(isinstance(strategy_id, str) and 0 < len(strategy_id) <= 64
             and all(c.isalnum() or c in "-_." for c in strategy_id), "id must be a short slug")
    _require(isinstance(spec.get("version"), int) and not isinstance(spec.get("version"), bool)
             and spec["version"] >= 1, "version must be a positive integer")
    _require(isinstance(spec.get("name"), str) and spec["name"], "name is required")
    params = spec.get("params", {})
    _require(isinstance(params, dict), "params must be an object")
    for key, value in params.items():
        _require(isinstance(key, str) and key.replace("_", "").isalnum(), "invalid parameter name " + str(key))
        _check_decimal(value, "parameter " + key)
    kind = spec.get("kind", "rules")
    if kind == "rules":
        _check_rules(spec.get("rules"), params, "rules")
    elif kind == "regime_adapter":
        branches = spec.get("branches")
        _require(isinstance(branches, dict) and branches and set(branches) <= {"trend", "range"},
                 "branches must map trend and/or range")
        ids = set()
        for regime, branch in branches.items():
            _require(isinstance(branch, dict) and isinstance(branch.get("id"), str) and branch["id"],
                     "branches." + regime + ".id is required")
            _require(branch["id"] not in ids, "branch ids must differ")
            ids.add(branch["id"])
            _check_rules(branch.get("rules"), params, "branches." + regime + ".rules")
    else:
        raise SpecError("kind must be rules or regime_adapter")
    _check_indicators(spec)
    return spec


_PERIOD_FEATURE = re.compile(
    r"^(ema|sma|rsi|atr|bollinger_(?:mid|variance|stddev|lower|upper)|donchian_(?:high|low|mid)|prior_volume_mean)(\d+)$")
_KIND_OF = {"ema": "ema", "sma": "sma", "rsi": "rsi", "atr": "atr", "prior_volume_mean": "donchian"}
_DEFAULT_PERIODS = {"ema": (9, 21), "sma": (50,), "rsi": (14,), "atr": (14,), "bollinger": (20,), "donchian": (20,)}


def declared_indicators(spec):
    """The ``indicators`` block of a spec: kind -> periods, on top of the default set."""
    block = spec.get("indicators", {})
    _require(isinstance(block, dict), "indicators must be an object")
    for kind, periods in block.items():
        _require(kind in _DEFAULT_PERIODS, "unknown indicator kind " + str(kind))
        _require(isinstance(periods, list) and 0 < len(periods) <= 8
                 and all(isinstance(v, int) and not isinstance(v, bool) and 2 <= v <= 400 for v in periods),
                 "indicators." + kind + " takes up to 8 integer periods from 2 to 400")
    return block


def _check_indicators(spec):
    block = declared_indicators(spec)
    allowed = {kind: set(values) | set(block.get(kind, ())) for kind, values in _DEFAULT_PERIODS.items()}

    def walk(node):
        if isinstance(node, str):
            scope, _, field = node.partition(".")
            match = _PERIOD_FEATURE.match(field) if scope in ("1m", "1m_previous", "5m") else None
            if match:
                name, period = match.group(1), int(match.group(2))
                kind = _KIND_OF.get(name) or name.split("_")[0]
                _require(period in allowed.get(kind, ()),
                         "{} uses period {} that is not declared under indicators.{}".format(node, period, kind))
        elif isinstance(node, dict):
            for key, value in node.items():
                if key != "indicators":
                    walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk({k: v for k, v in spec.items() if k in ("rules", "branches")})


def spec_hash(spec):
    """Identity of one spec version: the canonical hash of the whole spec."""
    return canonical_hash(spec)


def load_spec(path):
    with open(path, encoding="utf-8") as handle:
        return validate_spec(json.load(handle))


def load_specs(directory=DEFAULT_SPEC_DIR):
    """All specs in ``directory``, keyed by id, in file-name order."""
    specs = {}
    for name in sorted(os.listdir(directory)):
        if name.endswith(".json"):
            spec = load_spec(os.path.join(directory, name))
            if spec["id"] in specs:
                raise SpecError("duplicate strategy id " + spec["id"])
            specs[spec["id"]] = spec
    return specs


# --- evaluation -----------------------------------------------------------

def _param(value, params):
    return params[value[1:]] if isinstance(value, str) and value.startswith("$") else value


def _resolve(operand, scope, params):
    if isinstance(operand, dict):
        left, right = (_resolve(factor, scope, params) for factor in operand["mul"])
        if left is None or right is None:
            return None
        with localcontext() as ctx:
            ctx.prec = 50
            return _text(_decimal(left, "operand") * _decimal(right, "operand"))
    if operand.startswith("$"):
        return params[operand[1:]]
    if "." in operand:
        name, field = operand.split(".", 1)
        features = scope.get(name)
        return features.get(field) if isinstance(features, dict) else None
    return operand


def _evaluate(node, scope, params, regime, conditions):
    if "cmp" in node:
        return _compare(conditions, node["cmp"], _resolve(node["left"], scope, params), node["op"],
                        _resolve(node["right"], scope, params))
    if "available" in node:
        return _availability(conditions, node["available"], _resolve(node["operand"], scope, params))
    if "regime_in" in node:
        passed = regime in node["regime_in"]
        if "code" in node:
            conditions.append(_condition(node["code"], passed, "is", True, passed))
        return passed
    if "not" in node:
        return not _evaluate(node["not"], scope, params, regime, conditions)
    if "and" in node:
        for child in node["and"]:
            if not _evaluate(child, scope, params, regime, conditions):
                return False
        return True
    results = [_evaluate(child, scope, params, regime, conditions)
               for child in node["all" if "all" in node else "any"]]
    return all(results) if "all" in node else any(results)


def _render(template, scope, params):
    out = ""
    rest = template
    while "{" in rest:
        start = rest.index("{")
        end = rest.index("}", start)
        out += rest[:start] + str(_resolve(rest[start + 1:end], scope, params))
        rest = rest[end + 1:]
    return out + rest


def propose_spec(spec, current, *, previous=None, trend=None, regime="unknown",
                 delegated_strategy_id=None, age_ms=None, tick_size="1",
                 cost_config=None, position_side=None, frozen_target=None,
                 frozen_invalidation=None):
    """Evaluate one spec; same arguments and result shape as ``propose``."""
    params = spec.get("params", {})
    strategy_id = spec["id"]
    rules = spec.get("rules")
    delegated = None
    if spec.get("kind", "rules") == "regime_adapter":
        branches = spec["branches"]
        branch = next((b for b in branches.values() if b["id"] == delegated_strategy_id), None)
        if branch is None:
            branch = branches.get(regime)
        if branch is None:
            return _proposal(strategy_id, "ABSTAIN", "regime_unavailable", [], age_ms)
        delegated = branch["id"]
        strategy_id = delegated
        rules = branch["rules"]
    owner_id = spec["id"] if delegated else strategy_id

    def proposal(*args, **kwargs):
        result = _proposal(strategy_id, *args, delegated=delegated, **kwargs)
        result["strategy_id"] = owner_id
        result["horizon_minutes"] = rules["horizon_minutes"]
        return result

    if not isinstance(current, dict) or current.get("ready") is not True:
        missing = current.get("reason_codes", []) if isinstance(current, dict) else []
        return proposal("WAIT", "warming_up", [
            _condition("features_ready", bool(isinstance(current, dict) and current.get("ready")), "is", True, False),
            *[_condition("unavailable:" + str(reason), None, "available", True, False) for reason in missing],
        ], age_ms)

    scope = {"1m": current, "1m_previous": previous, "5m": trend,
             "position": {"frozen_target": frozen_target, "frozen_invalidation": frozen_invalidation}}

    if position_side in SIDES:
        conditions = []
        exits = _evaluate(rules["exit"][position_side], scope, params, regime, conditions)
        return proposal("FLAT" if exits else "WAIT",
                        "owner_exit_condition_met" if exits else "owner_exit_condition_not_met",
                        conditions, age_ms, invalidation="strategy_exit")

    for gate in rules.get("gates", []):
        if gate["require"] == "previous":
            missing = not isinstance(previous, dict)
        else:
            missing = not isinstance(trend, dict) or trend.get("ready") is not True
        if missing:
            gate_conditions = ([_condition(gate["condition"], False, "is", True, False)]
                               if "condition" in gate else [])
            return proposal("WAIT", gate["reason"], gate_conditions, age_ms)

    conditions = []
    results = {}
    for check in rules["checks"]:
        passed = _evaluate(check["node"], scope, params, regime, conditions)
        if "name" in check:
            results[check["name"]] = passed
    side = None
    for candidate in SIDES:
        entry = rules["sides"].get(candidate)
        if entry is not None and all(results[name] for name in entry["requires"]):
            side = candidate
            break
    if side is None:
        return proposal("WAIT", "entry_conditions_not_met", conditions, age_ms)
    entry = rules["sides"][side]
    reason = entry["reason"]
    invalidation = _render(entry["invalidation"], scope, params)
    target = None
    if "target" in entry:
        target = _resolve(entry["target"], scope, params)
        if target is None:
            _availability(conditions, entry.get("target_condition", "frozen_target_available"), target)
            return proposal("ABSTAIN", "frozen_target_unavailable", conditions, age_ms)
    close = current.get("candidate_close")
    atr = current.get("atr14")
    if close is None or atr is None:
        conditions.append(_condition("atr_and_close_available", False, "is", True, False))
        return proposal("ABSTAIN", "protective_levels_unavailable", conditions, age_ms)
    price, volatility, tick = (_decimal(v, "protective level") for v in (close, atr, tick_size))
    if price <= 0 or volatility <= 0 or tick <= 0:
        return proposal("ABSTAIN", "invalid_protective_level_input", conditions, age_ms)
    stop_atr = _decimal(_param(rules["risk"]["stop_atr"], params), "stop_atr")
    ratio = _decimal(_param(rules["risk"]["target_stop_ratio"], params), "target_stop_ratio")
    with localcontext() as ctx:
        ctx.prec = 50
        distance = volatility * stop_atr
        raw_stop = price - distance if side == "LONG" else price + distance
        stop_rounding = ROUND_FLOOR if side == "LONG" else ROUND_CEILING
        stop = (raw_stop / tick).to_integral_value(rounding=stop_rounding) * tick
        if stop <= 0:
            return proposal("ABSTAIN", "invalid_stop_after_tick_rounding", conditions, age_ms)
        if target is None:
            raw_target = price + distance * ratio if side == "LONG" else price - distance * ratio
            target_rounding = ROUND_CEILING if side == "LONG" else ROUND_FLOOR
            target = _text((raw_target / tick).to_integral_value(rounding=target_rounding) * tick)
        else:
            target_value = _decimal(target, "frozen target")
            if (side == "LONG" and target_value <= price) or (side == "SHORT" and target_value >= price):
                return proposal("ABSTAIN", "target_on_wrong_side", conditions, age_ms)
            target_rounding = ROUND_FLOOR if side == "LONG" else ROUND_CEILING
            target = _text((target_value / tick).to_integral_value(rounding=target_rounding) * tick)
    result = proposal(side, reason, conditions, age_ms, invalidation=invalidation, proposed_target=target,
                      signal_key="{}:{}:{}".format(strategy_id, side, current.get("candidate_bucket_start_ms")))
    result["proposed_stop"] = _text(stop)
    result["stop_distance"] = _text(abs(price - stop))
    result["target_distance"] = _text(abs(_decimal(target, "proposed target") - price))
    result["invalidation"] = invalidation
    if cost_config is not None:
        taker = _decimal(cost_config.get("taker_rate"), "taker rate")
        # What D charges: taker on both legs plus the product's execution cost.
        execution = 2 * side_impact_bps(cost_config.get("product_id"))
        result["estimated_round_trip_cost_bps"] = _text(2 * taker * Decimal("10000") + execution)
    return result
