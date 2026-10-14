"""The frozen declarative strategies (C29, C30, C32) as signal producers for the runner pipeline (stage 9A).

``SpecSignalStrategy`` does not re-implement anything: it hands the cycle's frame to ``futures_spec_strategy.propose_spec``
(the interpreter the forward uses) and maps its proposal onto the ``multi_signals.Strategy`` contract the runner consumes.
The spec files are loaded, validated and hashed as they are; nothing is edited, renamed or re-versioned.

What is the same as the forward, by construction: the proposal (action, side, stop, target, horizon, reason code,
conditions) for the same closed frame, because it is the same function on the same inputs.

What is not the same, and is declared instead of hidden:

* cadence: the forward evaluates a book on every closed 1-minute candle; the runner pipeline decides on the last minute of
  each 5-minute bar. The three specs read 5-minute features only, so the entry condition is constant inside a bar; the
  forward can re-enter a few minutes after a same-bar exit, the runner cannot (one position per product);
* accounting: the forward runs one independent 100 USD book per strategy; the runner shares one portfolio, so trades differ
  by design (a position blocks the next signal, capital is shared). Signal parity is proven; trade parity is not claimed;
* levels: the runner derives the stop and the target from ``cycle atr`` with the portfolio's risk policy. ``cycle_atr`` is
  the spec's own volatility (the log volatility of the horizon, price * sigma * sqrt(bars)), so that stop = price -
  stop_atr * atr matches the spec's stop; the target can differ from the spec's by less than one tick (the spec rounds it
  to the tick, the portfolio does not);
* strength: the specs carry none, every entry has strength 1 (declared constant).
"""

import hashlib
import json
import os
from decimal import Decimal, localcontext

from .futures_products import load_pinned_products
from .futures_spec_strategy import DEFAULT_SPEC_DIR, SpecError, declared_indicators, load_spec, propose_spec, spec_hash
from .multi_risk import RiskPolicy
from .multi_signals import BUY, SELL, WAIT, Strategy

D = Decimal
FROZEN_IDS = ("c29-momentum-perp-v1", "c30-momentum-12h-perp-v1", "c32-funding-contrarian-24h-perp-v1")
SCHEMA = "balancita-replay-specs.v1"
STRENGTH = D(1)
# Pinned identity of the three frozen specs (canonical hash of the whole spec file, as ``futures_strategy_registry`` and the
# forward compute it). A spec edited in place fails to load.
FROZEN_SPEC_HASHES = {
    "c29-momentum-perp-v1": "ca81f9ce070d1db8410e9a8b06688555d9c80e33fd6f6eab056f84d8d452f871",
    "c30-momentum-12h-perp-v1": "29de8c4ff4d53cd477a1689508035455d402bd57aa6028390bd2a7e8f54da2e1",
    "c32-funding-contrarian-24h-perp-v1": "1481148d45aea9b0969d0a5a4a37126d002ccf1f8c14d504338ee7279cba7612",
}


class FrozenSpecError(ValueError):
    """A spec that is not what was frozen, or that this adapter cannot run without changing it."""


def _file_sha256(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def _scan(node, found):
    if isinstance(node, str):
        scope = node.partition(".")[0] if "." in node else None
        if scope in ("1m_previous", "position"):
            found.add(scope)
    elif isinstance(node, dict):
        for value in node.values():
            _scan(value, found)
    elif isinstance(node, list):
        for value in node:
            _scan(value, found)


class SpecSignalStrategy(Strategy):
    def __init__(self, spec, tick_sizes):
        if spec.get("kind", "rules") != "rules":
            raise FrozenSpecError("{}: only 'rules' specs are supported".format(spec["id"]))
        rules = spec["rules"]
        unsupported = set()
        _scan(rules.get("checks"), unsupported)
        _scan(rules.get("gates"), unsupported)
        if any(g.get("require") == "previous" for g in rules.get("gates", [])):
            unsupported.add("previous")
        if unsupported:
            raise FrozenSpecError("{}: the runner pipeline does not provide {}".format(spec["id"], sorted(unsupported)))
        if "target" in rules["sides"].get("LONG", {}) or "target" in rules["sides"].get("SHORT", {}):
            raise FrozenSpecError("{}: frozen targets are not supported".format(spec["id"]))
        risk = rules["risk"]
        policy = RiskPolicy()
        params = spec.get("params", {})
        stop_atr = D(params[risk["stop_atr"][1:]]) if str(risk["stop_atr"]).startswith("$") else D(risk["stop_atr"])
        ratio = D(params[risk["target_stop_ratio"][1:]]) if str(risk["target_stop_ratio"]).startswith("$") else D(risk["target_stop_ratio"])
        if stop_atr != D(policy.stop_atr_mult) or ratio != D(policy.target_stop_ratio) or "vol" not in risk \
                or rules["horizon_minutes"] > policy.max_horizon_minutes:
            raise FrozenSpecError("{}: its levels do not map onto the portfolio risk policy".format(spec["id"]))
        self.id, self.version, self.horizon_minutes = spec["id"], spec["version"], rules["horizon_minutes"]
        self.indicators = {kind: list(periods) for kind, periods in declared_indicators(spec).items()}
        self.spec_hash = spec_hash(spec)
        self.spec_json = json.dumps(spec, sort_keys=True)
        self.uses_funding = "fundpct" in self.spec_json     # reads the funding percentile (a funding-dependent strategy)
        self.tick_sizes = dict(tick_sizes)
        self.vol_feature, self.vol_minutes = risk["vol"], risk["vol_minutes"]
        self._spec = spec

    def decide(self, ctx):
        tick = self.tick_sizes.get(ctx.product_id)
        if tick is None:
            raise FrozenSpecError("no pinned tick size for " + str(ctx.product_id))
        proposal = propose_spec(self._spec, ctx.one, trend=ctx.five, regime=ctx.regime, tick_size=tick)
        action = {"LONG": BUY, "SHORT": SELL}.get(proposal["action"], WAIT)
        reason = proposal["reason_code"]
        evidence = {"spec_hash": self.spec_hash, "proposal_action": proposal["action"], "proposal_reason": reason,
                    "conditions": ";".join("{}|{}|{}|{}".format(c["code"], c["value"], c["threshold"], c["passed"])
                                           for c in proposal["conditions"])}
        if action == WAIT:
            return WAIT, D(0), evidence, reason
        evidence.update(proposed_stop=proposal["proposed_stop"], proposed_target=proposal["proposed_target"],
                        stop_distance=proposal["stop_distance"], target_distance=proposal["target_distance"],
                        spec_signal_key=proposal["signal_key"])
        return action, STRENGTH, evidence, reason

    def cycle_atr(self, frame):
        """The spec's volatility for the portfolio's levels (``price * sigma_bar * sqrt(bars in the horizon)``), or ``None``."""
        trend = frame[3]
        scope, _, field = self.vol_feature.partition(".")
        bar_vol = trend.get(field) if scope == "5m" else frame[1].get(field)
        close = trend.get("candidate_close")
        if bar_vol is None or close is None:
            return None
        with localcontext() as ctx:
            ctx.prec = 50
            return D(str(bar_vol)) * (D(self.horizon_minutes) / D(self.vol_minutes)).sqrt() * D(str(close))


def pinned_tick_sizes():
    return dict(load_pinned_products())


def load_frozen(directory=DEFAULT_SPEC_DIR, ids=FROZEN_IDS, tick_sizes=None):
    """``(strategies, identity)`` of the frozen specs, straight from their files. ``identity`` lists file hash, spec hash and
    version per strategy, to be recorded in the manifest."""
    ticks = tick_sizes or pinned_tick_sizes()
    strategies, identity = [], {}
    for strategy_id in ids:
        path = os.path.join(directory, strategy_id + ".json")
        if not os.path.isfile(path):
            raise FrozenSpecError("missing spec file " + path)
        try:
            spec = load_spec(path)
        except SpecError as error:
            raise FrozenSpecError("{}: {}".format(strategy_id, error))
        if spec["id"] != strategy_id:
            raise FrozenSpecError("{} holds spec {}".format(path, spec["id"]))
        pinned = FROZEN_SPEC_HASHES.get(strategy_id)
        if pinned is None or spec_hash(spec) != pinned:
            raise FrozenSpecError("{}: the spec is not the frozen one (hash {})".format(strategy_id, spec_hash(spec)))
        strategy = SpecSignalStrategy(spec, ticks)
        strategies.append(strategy)
        identity[strategy_id] = {"version": spec["version"], "spec_hash": strategy.spec_hash,
                                 "file_sha256": _file_sha256(path), "horizon_minutes": strategy.horizon_minutes,
                                 "indicators": strategy.indicators}
    cycle_atrs = {(s.vol_feature, s.vol_minutes, s.horizon_minutes) for s in strategies}
    if len(cycle_atrs) > 1:
        raise FrozenSpecError("the runner takes one volatility per cycle; these specs declare different ones: {}".format(
            sorted(cycle_atrs)))
    return strategies, identity
