"""The generic evaluator against the engine, bar by bar, on seeded synthetic candles.

Same method as test_signal_parity.py: ``futures_simulator.frames`` (Decimal, the code the forward runs) feeds
``futures_spec_strategy.propose_spec`` and the result is compared with ``generic_signals.evaluate_spec`` (float64). The
criterion is ZERO signal differences and equal protective levels; a trade-level comparison with the engine's ``Book`` follows.
What the evaluator cannot do must raise ``UnsupportedSpec``, never differ.
"""

import copy

import numpy as np
import pytest

from research.vectorbt import generic_signals as gs
from research.vectorbt import generic_sim, parity
from research.vectorbt.engine import DEFAULT_PERIODS, declared_indicators, frames, load_spec, merge_periods, propose_spec
from research.vectorbt.tests import helpers

PRODUCT = "PF_XBTUSD"
SPECS = ["c25-pullback-perp-v1", "c26-reversion-perp-v1", "c27-breakout-perp-v1", "c28-adapter-perp-v1",
         "c29-momentum-perp-v1", "c30-momentum-12h-perp-v1", "c33-area-de-valor-perp-v1"]
EXIT_REASON = {"strategy_exit": "rule", "time_stop": "time", "stop": "stop", "target": "target"}

# Two specs of our own that use what the shipped ones do not: bollinger / sma / rsi / ema / atr / logvol on 1m,
# `any`/`not`/`regime_in`/`available`, a `target` operand, risk.vol on the 1m series, and position.* inside `mul`.
CUSTOM_A = {
    "schema": "balancita-strategy.v1", "id": "test-custom-a-v1", "version": 1, "name": "Prueba A",
    "params": {"rsi_hi": "58", "rsi_lo": "42", "k": "0.999", "stop_atr": "1.2", "target_stop_ratio": "1.5"},
    "indicators": {"sma": [20], "rsi": [7], "ema": [12], "atr": [20]},
    "rules": {
        "gates": [{"require": "previous", "reason": "previous_bar_unavailable"}],
        "checks": [
            {"name": "up", "node": {"all": [
                {"available": "ema12_ok", "operand": "1m.ema12"},
                {"cmp": "close_above_sma20", "left": "1m.candidate_close", "op": ">", "right": "1m.sma20"},
                {"cmp": "rsi_high", "left": "1m.rsi7", "op": ">=", "right": "$rsi_hi"},
                {"any": [{"regime_in": ["trend"]}, {"not": {"regime_in": ["unknown", "range"]}},
                         {"cmp": "prev_below", "left": "1m_previous.candidate_close", "op": "<", "right": "1m_previous.ema12"}]}]}},
            {"name": "down", "node": {"and": [
                {"cmp": "close_below_sma20", "left": "1m.candidate_close", "op": "<", "right": "1m.sma20"},
                {"cmp": "rsi_low", "left": "1m.rsi7", "op": "<=", "right": "$rsi_lo"},
                {"cmp": "atr_ok", "left": "1m.atr20", "op": ">", "right": {"mul": ["1m.atr14", "0"]}}]}},
        ],
        "sides": {
            "LONG": {"requires": ["up"], "reason": "a_long", "invalidation": "below@{1m.sma20}"},
            "SHORT": {"requires": ["down"], "reason": "a_short", "invalidation": "above@{1m.sma20}"},
        },
        "exit": {
            "LONG": {"any": [{"cmp": "long_back_through", "left": "1m.candidate_close", "op": "<", "right": "position.frozen_invalidation"},
                             {"cmp": "long_near_target", "left": "1m.candidate_close", "op": ">=",
                              "right": {"mul": ["position.frozen_target", "$k"]}}]},
            "SHORT": {"all": [{"cmp": "short_back_through", "left": "1m.candidate_close", "op": ">", "right": "position.frozen_invalidation"},
                              {"not": {"regime_in": ["unknown"], "code": "regime_known"}}]},
        },
        "risk": {"stop_atr": "$stop_atr", "target_stop_ratio": "$target_stop_ratio"},
        "horizon_minutes": 45,
    },
}

CUSTOM_B = {
    "schema": "balancita-strategy.v1", "id": "test-custom-b-v1", "version": 1, "name": "Prueba B",
    "params": {"z": "1.2", "stop_atr": "1", "target_stop_ratio": "2"},
    "indicators": {"logret": [15], "logvol": [30], "bollinger": [20]},
    "rules": {
        "checks": [
            {"name": "low", "node": {"all": [
                {"cmp": "below_band", "left": "1m.candidate_close", "op": "<", "right": "1m.bollinger_lower20"},
                {"cmp": "dropped", "left": {"mul": ["1m.logret15", "-1"]}, "op": ">", "right": {"mul": ["1m.logvol30", "$z"]}}]}},
            {"name": "high", "node": {"all": [
                {"cmp": "above_band", "left": "1m.candidate_close", "op": ">", "right": "1m.bollinger_upper20"},
                {"cmp": "rose", "left": "1m.logret15", "op": ">", "right": {"mul": ["1m.logvol30", "$z"]}}]}},
        ],
        "sides": {
            "LONG": {"requires": ["low"], "reason": "b_long", "invalidation": "stop", "target": "1m.bollinger_mid20"},
            "SHORT": {"requires": ["high"], "reason": "b_short", "invalidation": "stop", "target": "1m.bollinger_mid20"},
        },
        "exit": {"LONG": {"cmp": "never", "left": "0", "op": ">", "right": "1"},
                 "SHORT": {"cmp": "never", "left": "0", "op": ">", "right": "1"}},
        "risk": {"stop_atr": "$stop_atr", "target_stop_ratio": "$target_stop_ratio", "vol": "1m.logvol30", "vol_minutes": 1},
        "horizon_minutes": 60,
    },
}


def _load(name):
    if name == "custom-a":
        return copy.deepcopy(CUSTOM_A)
    if name == "custom-b":
        return copy.deepcopy(CUSTOM_B)
    return load_spec("config/strategies/{}.json".format(name))


@pytest.fixture(scope="module")
def market():
    rows = helpers.synthetic_regimes(18 * 1440, seed=3, scale=4.0)
    five = helpers.five_minutes(rows)
    return rows, five, gs.Market.from_candles(PRODUCT, rows, five)


@pytest.fixture(scope="module")
def engine_side(market):
    """Per spec, the engine's proposal on every bar (computed once)."""
    rows, five, _ = market
    cache = {}

    def run(name):
        if name not in cache:
            spec = _load(name)
            periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
            n = len(rows)
            side, stop, target = np.zeros(n, dtype=np.int8), np.full(n, np.nan), np.full(n, np.nan)
            for i, (_, current, previous, trend, regime) in enumerate(frames(rows, five, periods)):
                proposal = propose_spec(spec, current, previous=previous, trend=trend, regime=regime, tick_size="1")
                if proposal["action"] in ("LONG", "SHORT"):
                    side[i] = 1 if proposal["action"] == "LONG" else -1
                    stop[i], target[i] = float(proposal["proposed_stop"]), float(proposal["proposed_target"])
            cache[name] = (side, stop, target)
        return cache[name]
    return run


@pytest.mark.parametrize("name", SPECS + ["custom-a", "custom-b"])
def test_signals_and_levels_match_the_engine_bar_by_bar(name, market, engine_side):
    _, _, mk = market
    plan = gs.evaluate_spec(_load(name), mk)
    side, stop, target = engine_side(name)
    differing = np.nonzero(side != plan.raw_side)[0]
    assert len(differing) == 0, [(int(i), int(side[i]), int(plan.raw_side[i])) for i in differing[:10]]
    mask = side != 0
    np.testing.assert_allclose(plan.stop[mask], stop[mask], rtol=1e-9, atol=0)
    np.testing.assert_allclose(plan.target[mask], target[mask], rtol=1e-9, atol=0)


def test_there_are_signals_of_both_sides_and_regimes_to_compare(market, engine_side):
    _, _, mk = market
    for name in ("c27-breakout-perp-v1", "c25-pullback-perp-v1", "c28-adapter-perp-v1", "c29-momentum-perp-v1",
                 "c33-area-de-valor-perp-v1", "custom-a", "custom-b"):
        side, _, _ = engine_side(name)
        assert (side == 1).sum() > 3 and (side == -1).sum() > 3, name
    plan = gs.evaluate_spec(_load("c28-adapter-perp-v1"), mk)
    assert (plan.regime == gs.TREND).sum() > 1000 and (plan.regime == gs.RANGE).sum() > 1000
    assert {b["id"] for b in plan.branches} == {"c25-pullback-perp-v1", "c26-reversion-perp-v1"}


@pytest.mark.parametrize("name", ["c27-breakout-perp-v1", "c25-pullback-perp-v1", "c26-reversion-perp-v1",
                                  "c28-adapter-perp-v1", "c29-momentum-perp-v1", "c33-area-de-valor-perp-v1",
                                  "custom-a", "custom-b"])
def test_trades_match_the_engine_book(name, market):
    rows, five, mk = market
    spec = _load(name)
    plan = gs.evaluate_spec(spec, mk)
    trades, _ = generic_sim.simulate_plan(plan, mk)
    engine, _, _ = parity.engine_trades(spec, rows, five, PRODUCT, [])
    by_engine = {t["entry_bucket_ms"]: t for t in engine}
    by_mine = {int(mk.index[t["entry_i"]]): t for t in trades}
    assert len(by_engine) >= 4, name
    assert sorted(by_mine) == sorted(by_engine)
    high = {int(mk.index[i]): (mk.h[i], mk.l[i]) for i in range(mk.bars)}
    touches = 0
    for bucket, theirs in by_engine.items():
        mine = by_mine[bucket]
        if theirs["exit_bucket_ms"] != int(mk.index[mine["exit_i"]]):
            # the one known difference: the engine's exit candle only TOUCHES the level (VectorBT needs to cross it)
            level = float(theirs["stop_price"] if theirs["exit_reason"] == "stop" else theirs["target_price"])
            top, bottom = high[theirs["exit_bucket_ms"]]
            extreme = bottom if (theirs["exit_reason"] == "stop") == (theirs["side"] == "LONG") else top
            assert theirs["exit_reason"] in ("stop", "target") and extreme == level, (bucket, theirs["exit_reason"])
            touches += 1
            continue
        assert EXIT_REASON[theirs["exit_reason"]] == mine["exit_reason"], (bucket, theirs["exit_reason"], mine["exit_reason"])
        # the two sizings differ in a second-order term that grows with the size of the move (0.01 bp + 0.003 %)
        assert abs(theirs["net_bp"] - mine["net_bp"]) < 0.01 + 3e-5 * abs(theirs["net_bp"]), (bucket, theirs["net_bp"], mine["net_bp"])
    assert touches <= max(2, len(by_engine) // 100)
    assert all(t["exit_reason"] != "unknown" for t in trades)


def test_the_engine_skips_the_same_signals_the_filter_drops(market):
    rows, five, mk = market
    spec = _load("c26-reversion-perp-v1")
    plan = gs.evaluate_spec(spec, mk)
    _, skipped, _ = parity.engine_trades(spec, rows, five, PRODUCT, [])
    # the Book only sees a signal when it is flat, so its skips are a subset of the filter's
    dropped = {int(mk.index[i]) for i in np.nonzero(plan.skipped_cost)[0]}
    assert {s["bucket_ms"] for s in skipped} <= dropped and len(skipped) > 0


def test_funding_is_charged_like_the_engine(market):
    rows, five, mk = market
    spec = _load("c27-breakout-perp-v1")
    start = int(mk.index[0])
    funding = [(start + h * 3_600_000, start + (h + 1) * 3_600_000, 0.00001 * (1 + h % 3)) for h in range(18 * 24 + 2)]
    mk_f = gs.Market.from_candles(PRODUCT, rows, five, funding=funding)
    plan = gs.evaluate_spec(spec, mk_f)
    trades, _ = generic_sim.simulate_plan(plan, mk_f)
    engine, _, _ = parity.engine_trades(spec, rows, five, PRODUCT, funding)
    by_engine = {t["entry_bucket_ms"]: t for t in engine}
    assert trades and all(t["funding_complete"] for t in trades)
    assert any(abs(t["funding_bp"]) > 0 for t in trades)
    for t in trades:
        theirs = by_engine[int(mk_f.index[t["entry_i"]])]
        assert abs(theirs["net_bp"] - t["net_bp"]) < 0.01 + 3e-5 * abs(theirs["net_bp"])


# ------------------------------------------------------------------------------------ C33: value area
C33 = "c33-area-de-valor-perp-v1"


def _engine_area_features(five, spec):
    """The engine's value-area features of every 5m bar (what ``frames`` hands the rules as ``5m``)."""
    from balancita_engine.futures_simulator import IncrementalFeatures
    features = IncrementalFeatures({"valuearea": declared_indicators(spec)["valuearea"]}, series="5m")
    rows = [features.update(c) for c in five]
    return {name: np.array([float(r[name]) if r[name] is not None else np.nan for r in rows])
            for name in ("poc", "vah", "val", "vaside", "vaout", "vain")}


def test_value_area_features_match_the_engine_on_every_5m_bar(market):
    rows, five, mk = market
    spec = _load(C33)
    theirs = _engine_area_features(five, spec)
    store = gs.FeatureStore(mk)
    store.va = declared_indicators(spec)["valuearea"][0]
    for name, expected in theirs.items():
        mine = store.base("5m", name)
        assert np.array_equal(np.isnan(mine), np.isnan(expected)), name
        keep = ~np.isnan(expected)
        np.testing.assert_allclose(mine[keep], expected[keep], rtol=1e-9, atol=0, err_msg=name)
    # every case of the rule shows up in the data: exits of both sides, accepted and rejected
    side, out, inside = theirs["vaside"], theirs["vaout"], theirs["vain"]
    accept_min = float(spec["params"]["accept_min"])
    for direction in (1, -1):
        assert ((side == direction) & (out >= accept_min)).sum() > 3, direction
        assert ((side == direction) & (out < accept_min) & (inside == 1)).sum() > 3, direction
        assert ((side == direction) & (out < accept_min) & (inside == 0)).sum() > 0, direction


def test_value_area_never_reads_a_bar_that_is_not_closed(market):
    _, _, mk = market
    cut = 2600
    head = gs.Market(mk.product, mk.tick, mk.index[:cut * 5], mk.o[:cut * 5], mk.h[:cut * 5], mk.l[:cut * 5], mk.c[:cut * 5],
                     mk.v[:cut * 5], mk.index5[:cut], mk.o5[:cut], mk.h5[:cut], mk.l5[:cut], mk.c5[:cut], mk.v5[:cut])
    spec = _load(C33)
    whole, part = gs.FeatureStore(mk), gs.FeatureStore(head)
    whole.va = part.va = declared_indicators(spec)["valuearea"][0]
    for name in ("poc", "vah", "val", "vaside", "vaout", "vain"):
        np.testing.assert_array_equal(whole.base("5m", name)[:cut], part.base("5m", name))
    assert np.array_equal(gs.evaluate_spec(spec, mk).raw_side[:cut * 5], gs.evaluate_spec(spec, head).raw_side)


def test_params_change_the_vectorbt_profile_like_the_engine(market):
    rows, five, mk = market
    spec = _load(C33)
    spec["params"].update(profile_bars="144", area_pct="60", bins="24", confirm_bars="3", accept_min="2")
    plan = gs.evaluate_spec(spec, mk)
    periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
    side = np.zeros(len(rows), dtype=np.int8)
    for i, (_, current, previous, trend, regime) in enumerate(frames(rows, five, periods)):
        proposal = propose_spec(spec, current, previous=previous, trend=trend, regime=regime, tick_size="1")
        if proposal["action"] in ("LONG", "SHORT"):
            side[i] = 1 if proposal["action"] == "LONG" else -1
    assert (side != 0).sum() > 20
    assert np.array_equal(side, plan.raw_side)


def test_value_area_on_the_one_minute_series_is_refused(market):
    _, _, mk = market
    spec = _load(C33)
    spec["rules"]["checks"][0]["node"]["all"][1]["any"][0]["all"][0]["operand"] = "1m.vaout"
    with pytest.raises(gs.UnsupportedSpec):
        gs.evaluate_spec(spec, mk)


# ---------------------------------------------------------------------------------------- not supported
def test_funding_percentile_is_declared_unsupported(market):
    _, _, mk = market
    with pytest.raises(gs.UnsupportedSpec) as error:
        gs.evaluate_spec(load_spec("config/strategies/c32-funding-contrarian-24h-perp-v1.json"), mk)
    assert "funding" in str(error.value) and "fundpct" in str(error.value)
    plan, reason = gs.supported_or_reason(load_spec("config/strategies/c32-funding-contrarian-24h-perp-v1.json"), mk)
    assert plan is None and "funding" in reason


def test_an_unknown_feature_is_not_ignored(market):
    _, _, mk = market
    spec = _load("custom-b")
    spec["rules"]["checks"][0]["node"]["all"][0]["right"] = "1m.candidate_open"
    with pytest.raises(gs.UnsupportedSpec) as error:
        gs.evaluate_spec(spec, mk)
    assert "candidate_open" in str(error.value)


def test_available_on_a_position_level_is_not_ignored(market):
    _, _, mk = market
    spec = _load("custom-a")
    spec["rules"]["exit"]["LONG"] = {"available": "has_target", "operand": "position.frozen_target"}
    with pytest.raises(gs.UnsupportedSpec) as error:
        gs.evaluate_spec(spec, mk)
    assert "position" in str(error.value)


def test_an_invalid_spec_is_reported_not_run(market):
    _, _, mk = market
    spec = _load("custom-a")
    spec["rules"]["checks"][0]["node"]["all"][1]["right"] = "1m.sma77"
    with pytest.raises(gs.UnsupportedSpec):
        gs.evaluate_spec(spec, mk)
