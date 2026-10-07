"""Buy / hold / sell probabilities for every strategy, from its spec and its proposal.

Every strategy proposal in a verdict is turned into three numbers that add up
to 1, the same shape as an LLM decision, so the model in process Q can read
every strategy's vote and decide over all of them. It works for any
``balancita-strategy.v1`` spec (C25-C28 and every strategy made in the front),
because it reads only the spec's own checks and the conditions the proposal
recorded; no spec field and no proposal field is added.

The numbers are a deterministic score of how close each side is to firing, not
a calibrated probability:

* Each side's score is the mean of its required checks, scored recursively:
  a leaf (``cmp``, ``available``, ``regime_in``) is 1 when it passed, 0 when
  it failed or was not evaluated; ``all``/``and`` are the mean of their
  children, ``any`` their maximum and ``not`` one minus its child.
* ``buy = long_score**2 / 3``, plus ``2/3`` when the proposal is LONG;
  ``sell`` likewise with SHORT; ``hold = 1 - buy - sell`` (never below 0);
  then the three are renormalized.
* So the most likely value always matches the proposal (LONG -> buy,
  SHORT -> sell, anything else -> hold), and a setup close to firing shows up
  as a larger buy or sell share inside hold.
* A proposal that cannot trade (warming up, a missing bar, ABSTAIN, an exit, a
  strategy without a spec) is ``hold = 1``.

The signal is computed from stored data only, so live and replay agree. Any
change to these rules is a new ``SIGNAL_VERSION`` and a new version of every
question that reads it (``config/decision-questions.json``).
"""

from fractions import Fraction

SIGNAL_VERSION = "futures-strategy-signals.v1"
ACTIONS = ("buy", "hold", "sell")
_FIRED = Fraction(2, 3)
_NEAR = Fraction(1, 3)


def _neutral(strategy_id, reason):
    return {"strategy_id": strategy_id, "buy": 0.0, "hold": 1.0, "sell": 0.0,
            "chosen": "hold", "reason": reason}


def _score(node, passed, regime):
    if "cmp" in node or "available" in node:
        return Fraction(int(passed.get(node.get("cmp", node.get("available"))) is True))
    if "regime_in" in node:
        if "code" in node and node["code"] in passed:
            return Fraction(int(passed[node["code"]] is True))
        return Fraction(int(regime in node["regime_in"]))
    if "not" in node:
        return 1 - _score(node["not"], passed, regime)
    if "any" in node:
        return max(_score(child, passed, regime) for child in node["any"])
    children = node["all" if "all" in node else "and"]
    return sum(_score(child, passed, regime) for child in children) / len(children)


def _rules_for(spec, proposal):
    if spec.get("kind", "rules") != "regime_adapter":
        return spec.get("rules")
    delegated = proposal.get("delegated_strategy_id")
    branch = next((b for b in spec["branches"].values() if b["id"] == delegated), None)
    return None if branch is None else branch["rules"]


def strategy_signal(spec, proposal, regime="unknown"):
    """``{strategy_id, buy, hold, sell, chosen, reason}`` for one entry proposal of ``spec``."""
    strategy_id = str(proposal.get("strategy_id", "?"))
    action = proposal.get("action")
    if spec is None:
        return _neutral(strategy_id, "no_spec")
    rules = _rules_for(spec, proposal)
    if rules is None:
        return _neutral(strategy_id, proposal.get("reason_code") or "no_branch")
    if (proposal.get("status") != "ready" or action not in ("LONG", "SHORT", "WAIT")
            or proposal.get("reason_code") in {g.get("reason") for g in rules.get("gates", [])}):
        return _neutral(strategy_id, proposal.get("reason_code") or "not_tradable")
    passed = {}
    for condition in proposal.get("conditions") or []:
        if isinstance(condition, dict):
            code = condition.get("code")
            passed[code] = passed.get(code, True) and condition.get("passed") is True
    checks = {check["name"]: check["node"] for check in rules["checks"] if "name" in check}

    def side_score(side):
        entry = rules["sides"].get(side)
        if entry is None:
            return Fraction(0)
        return sum(_score(checks[name], passed, regime) for name in entry["requires"]) / len(entry["requires"])

    buy = side_score("LONG") ** 2 * _NEAR + (_FIRED if action == "LONG" else 0)
    sell = side_score("SHORT") ** 2 * _NEAR + (_FIRED if action == "SHORT" else 0)
    hold = max(Fraction(0), 1 - buy - sell)
    total = buy + hold + sell
    values = {"buy": buy / total, "hold": hold / total, "sell": sell / total}
    # Ties go to hold: a strategy only votes for a trade it actually proposes.
    chosen = max(("hold", "buy", "sell"), key=lambda name: values[name])
    return dict({name: float(value) for name, value in values.items()},
                strategy_id=strategy_id, chosen=chosen, reason=proposal.get("reason_code"))


def verdict_signals(verdict, specs):
    """One signal per proposal of a stored verdict payload, in the verdict's order.

    ``specs`` maps strategy id to spec (``futures_spec_strategy.load_specs``).
    """
    regime = verdict.get("regime", "unknown")
    return [strategy_signal(specs.get(p.get("strategy_id")), p, regime)
            for p in verdict.get("proposals", []) if isinstance(p, dict)]


def consensus(signals):
    """The mean buy / hold / sell over the signals (``None`` when there are none)."""
    if not signals:
        return None
    return {name: sum(s[name] for s in signals) / len(signals) for name in ACTIONS}
