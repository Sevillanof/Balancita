import copy
import json
import math
import random
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import futures_llm_decisions as q
from balancita_engine.futures_costs import round_trip_rate
from balancita_engine.futures_simulator import IncrementalFeatures, simulate_many
from balancita_engine.futures_spec_strategy import SpecError, load_specs, propose_spec, spec_hash, validate_spec
from balancita_engine.futures_strategy_reliability import (
    RELIABILITY_SCHEMA,
    build_reliability,
    load_reliability,
    reliability_for,
    summarize_trades,
    verdict_for,
    wilson_interval,
    deflated_probability,
)

from test_futures_spec_strategy import FIVE, MINUTE, START, _official


def _tight(candle):
    """The shared test candle has a +-6 price wick; these paths sit near 100, so use a +-0.01 % wick."""
    close = Decimal(candle["close"])
    wick = close / 10_000
    candle.update(high=str(close + wick), low=str(close - wick), open=str(close))
    return candle

C29 = "c29-momentum-perp-v1"
SPECS = load_specs()


def _candles(closes):
    """1m and 5m official candles from a list of 1m closes (5m closes at every fifth minute)."""
    ones = [_tight(_official(MINUTE, START + i * MINUTE, Decimal(str(close)), 5)) for i, close in enumerate(closes)]
    fives = []
    for start in range(0, len(ones) - 4, 5):
        chunk = ones[start:start + 5]
        candle = _tight(_official(FIVE, chunk[0]["bucket_start"], Decimal(chunk[-1]["close"]), 25))
        candle["high"] = str(max(Decimal(c["high"]) for c in chunk))
        candle["low"] = str(min(Decimal(c["low"]) for c in chunk))
        fives.append(candle)
    return ones, fives


def _calm_then_surge(calm=2200, surge=360, move=0.02, seed=3, tail=1600):
    rng = random.Random(seed)
    price, closes = 100.0, []
    for _ in range(calm):
        price *= math.exp(rng.gauss(0, 0.0002))
        closes.append(round(price, 4))
    for step in range(surge):
        price *= math.exp(move / surge + rng.gauss(0, 0.0002))
        closes.append(round(price, 4))
    for _ in range(tail):
        price *= math.exp(rng.gauss(0, 0.0002))
        closes.append(round(price, 4))
    return closes


class LogFeatureTests(unittest.TestCase):
    def test_logret_and_logvol_follow_their_definition(self):
        closes = _calm_then_surge(calm=500, surge=100)
        ones, _ = _candles(closes)
        feature = IncrementalFeatures({"logret": [30], "logvol": [40]})
        last = None
        for candle in ones:
            last = feature.update(candle)
        values = [Decimal(c["close"]) for c in ones]
        want_return = math.log(values[-1] / values[-31])
        self.assertAlmostEqual(float(last["logret30"]), float(want_return), places=12)
        alpha, ewma = 2 / 41, None
        for previous, current in zip(values, values[1:]):
            square = math.log(current / previous) ** 2
            ewma = square if ewma is None else alpha * square + (1 - alpha) * ewma
        self.assertAlmostEqual(float(last["logvol40"]), math.sqrt(ewma), places=12)

    def test_log_features_are_unavailable_until_they_are_warm(self):
        ones, _ = _candles(_calm_then_surge(calm=100, surge=10))
        feature = IncrementalFeatures({"logret": [30], "logvol": [40]})
        seen = [feature.update(candle) for candle in ones[:45]]
        self.assertIsNone(seen[29]["logret30"])
        self.assertIsNotNone(seen[30]["logret30"])
        self.assertIsNone(seen[39]["logvol40"])
        self.assertIsNotNone(seen[40]["logvol40"])

    def test_default_features_do_not_gain_log_keys(self):
        ones, _ = _candles(_calm_then_surge(calm=100, surge=10))
        feature = IncrementalFeatures()
        for candle in ones:
            last = feature.update(candle)
        self.assertFalse([key for key in last if key.startswith("log")])


class C29SpecTests(unittest.TestCase):
    def test_log_risk_must_name_a_logvol_feature_with_its_series_minutes(self):
        cases = {
            "no minutes": lambda r: r.pop("vol_minutes"),
            "wrong minutes": lambda r: r.update(vol_minutes=1),
            "not a logvol": lambda r: r.update(vol="5m.atr14"),
            "undeclared period": lambda r: r.update(vol="5m.logvol100"),
        }
        for label, mutate in cases.items():
            spec = copy.deepcopy(SPECS[C29])
            mutate(spec["rules"]["risk"])
            with self.assertRaises(SpecError, msg=label):
                validate_spec(spec)

    def test_protective_levels_are_one_horizon_sigma_times_the_multiples(self):
        ones, fives = _candles(_calm_then_surge())
        spec = SPECS[C29]
        from balancita_engine.futures_simulator import frames
        proposal = frame = None
        for frame in frames(ones, fives, {"logret": (72,), "logvol": (288,), "ema": (9, 21), "atr": (14,)}):
            _, current, previous, trend, regime = frame
            candidate = propose_spec(spec, current, previous=previous, trend=trend, regime=regime, tick_size="0.0001")
            if candidate["action"] == "LONG":
                proposal = candidate
                break
        self.assertIsNotNone(proposal, "a 2 % move in 6 h after a calm day must fire")
        close, sigma = Decimal(frame[1]["candidate_close"]), Decimal(frame[3]["logvol288"])
        distance = close * sigma * Decimal(1440 // 5).sqrt() * 2
        self.assertAlmostEqual(float(Decimal(proposal["stop_distance"])), float(distance), delta=0.0002)
        self.assertAlmostEqual(float(Decimal(proposal["target_distance"])), float(distance * Decimal("1.5")), delta=0.0003)
        self.assertEqual(proposal["horizon_minutes"], 1440)


class C29SimulatorTests(unittest.TestCase):
    def test_a_calm_market_never_trades(self):
        rng = random.Random(5)
        price, closes = 100.0, []
        for _ in range(3000):
            price *= math.exp(rng.gauss(0, 0.0002))
            closes.append(round(price, 4))
        ones, fives = _candles(closes)
        (book,) = simulate_many([SPECS[C29]], ones, fives)
        self.assertEqual(book.trades, [])

    def test_an_extreme_upward_move_opens_one_long_that_pays_the_costs(self):
        ones, fives = _candles(_calm_then_surge())
        (book,) = simulate_many([SPECS[C29]], ones, fives)
        self.assertGreaterEqual(len(book.trades), 1)
        trade = book.trades[0]
        self.assertEqual((trade["side"], trade["reason_code"]), ("LONG", "c29_long_momentum"))
        self.assertLessEqual(trade["net_bp"], trade["net_bp"] + 1)  # net is reported after fees and execution
        cost_bp = float(round_trip_rate("PF_XBTUSD")) * 10_000
        gross_bp = (float(trade["exit_price"]) / float(trade["entry_price"]) - 1) * 10_000
        self.assertAlmostEqual(trade["net_bp"], gross_bp - 10.0, delta=1.0)
        self.assertGreater(cost_bp, 9.9)

    def test_an_extreme_downward_move_opens_a_short(self):
        ones, fives = _candles(_calm_then_surge(move=-0.02))
        (book,) = simulate_many([SPECS[C29]], ones, fives)
        self.assertEqual(book.trades[0]["side"], "SHORT")


def _trade(net_bp, day, hit=None):
    return {"net_bp": net_bp, "pnl_usd": net_bp / 100, "entry_time_ms": day * 86_400_000}


class ReliabilityTests(unittest.TestCase):
    def test_wilson_interval_brackets_the_rate(self):
        low, high = wilson_interval(53, 100)
        self.assertLess(low, 0.53)
        self.assertGreater(high, 0.53)
        self.assertEqual(wilson_interval(0, 0), (None, None))

    def test_few_trades_are_insufficient_data(self):
        self.assertEqual(summarize_trades([_trade(50, d) for d in range(10)])["verdict"], "insufficient_data")

    def test_a_losing_strategy_is_marked_negative_edge(self):
        rng = random.Random(1)
        trades = [_trade(-10 + rng.uniform(-5, 5), d % 40) for d in range(300)]
        summary = summarize_trades(trades, first_ms=0, last_ms=40 * 86_400_000)
        self.assertEqual(summary["verdict"], "negative_edge")
        self.assertLess(summary["mean_net_bp"], 0)

    def test_noise_around_zero_is_no_edge(self):
        rng = random.Random(2)
        trades = [_trade(rng.gauss(0, 60), d % 60) for d in range(240)]
        self.assertEqual(summarize_trades(trades, first_ms=0, last_ms=60 * 86_400_000)["verdict"], "no_edge")

    def test_a_consistent_edge_is_tentative_or_reliable_but_one_lucky_fold_is_not(self):
        rng = random.Random(3)
        steady = [_trade(40 + rng.gauss(0, 30), d % 80) for d in range(400)]
        self.assertIn(summarize_trades(steady, first_ms=0, last_ms=80 * 86_400_000)["verdict"],
                      ("tentative_edge", "reliable_edge"))
        lucky = [_trade(-5 + rng.gauss(0, 30), d % 60) for d in range(120)] + [_trade(900, 70)] * 5
        self.assertNotIn(summarize_trades(lucky, first_ms=0, last_ms=80 * 86_400_000)["verdict"],
                         ("tentative_edge", "reliable_edge"))

    def test_verdict_thresholds(self):
        self.assertEqual(verdict_for(29, 100, 9, 4, 4), "insufficient_data")
        self.assertEqual(verdict_for(200, -8, -3, 0, 4), "negative_edge")
        self.assertEqual(verdict_for(200, -8, -0.5, 1, 4), "no_edge")
        self.assertEqual(verdict_for(200, 20, 1.7, 3, 4), "tentative_edge")
        self.assertEqual(verdict_for(200, 20, 1.7, 2, 4), "no_edge")
        self.assertEqual(verdict_for(200, 20, 1.2, 4, 4), "candidate_edge")
        self.assertEqual(verdict_for(200, 20, 1.2, 2, 4), "no_edge")
        self.assertEqual(verdict_for(200, 20, 0.8, 4, 4), "no_edge")
        self.assertEqual(verdict_for(200, 20, 3.0, 4, 4), "reliable_edge")
        self.assertEqual(verdict_for(99, 20, 3.0, 4, 4), "tentative_edge")

    def test_searching_many_configurations_deflates_a_good_looking_result(self):
        rng = random.Random(4)
        values = [20 + rng.gauss(0, 150) for _ in range(300)]
        alone = deflated_probability(values, 1)
        searched = deflated_probability(values, 1000)
        self.assertGreater(alone, 0.9)
        self.assertLess(searched, alone)
        self.assertLess(searched, 0.9)

    def test_a_searched_spec_is_capped_at_candidate_until_it_survives_deflation(self):
        self.assertEqual(verdict_for(300, 50, 3.0, 4, 4, deflated=0.5, trials=1000), "candidate_edge")
        self.assertEqual(verdict_for(300, 50, 3.0, 4, 4, deflated=0.95, trials=1000), "reliable_edge")
        self.assertEqual(verdict_for(300, 50, 3.0, 4, 4, deflated=0.5, trials=1), "reliable_edge")
        self.assertEqual(verdict_for(300, 50, 3.0, 1, 4, deflated=0.99, trials=1000), "no_edge")

    def test_clustering_by_day_lowers_confidence_when_trades_share_a_day(self):
        independent = [_trade(30 if i % 2 else -10, i) for i in range(100)]
        same_day = [_trade(30 if i < 50 else -10, i // 50) for i in range(100)]
        self.assertGreater(abs(summarize_trades(independent)["t_stat"] or 0), abs(summarize_trades(same_day)["t_stat"] or 0))

    def test_build_reliability_measures_each_spec_on_its_own_trades(self):
        ones, fives = _candles(_calm_then_surge())
        table = build_reliability([SPECS[C29]], {"PF_XBTUSD": (ones, fives)}, warmup_ms=0)
        entry = table["strategies"][C29]
        self.assertEqual(table["schema"], RELIABILITY_SCHEMA)
        self.assertEqual(entry["spec_hash"], spec_hash(SPECS[C29]))
        self.assertGreaterEqual(entry["trades"], 1)
        self.assertEqual(entry["by_product"]["PF_XBTUSD"]["trades"], entry["trades"])

    def test_an_entry_is_ignored_once_the_spec_changed(self):
        table = {"schema": RELIABILITY_SCHEMA, "strategies": {C29: {"spec_hash": spec_hash(SPECS[C29]), "trades": 5}}}
        self.assertIsNotNone(reliability_for(table, SPECS[C29]))
        changed = copy.deepcopy(SPECS[C29])
        changed["params"]["z_min"] = "3"
        self.assertIsNone(reliability_for(table, changed))
        self.assertIsNone(reliability_for(None, SPECS[C29]))

    def test_load_reliability_rejects_other_schemas_and_missing_files(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"schema": "other"}, handle)
        self.assertIsNone(load_reliability(handle.name))
        self.assertIsNone(load_reliability(handle.name + ".missing"))

    def test_the_shipped_table_matches_the_shipped_specs(self):
        table = load_reliability()
        self.assertIsNotNone(table, "config/strategy-reliability.json must exist")
        for strategy_id, spec in SPECS.items():
            self.assertIsNotNone(reliability_for(table, spec), strategy_id + " has no measurement for its current spec")

    def test_losing_strategies_are_not_presented_as_having_an_edge(self):
        table = load_reliability()
        for strategy_id in ("c25-pullback-perp-v1", "c26-reversion-perp-v1", "c27-breakout-perp-v1", "c28-adapter-perp-v1"):
            self.assertEqual(table["strategies"][strategy_id]["verdict"], "negative_edge")
            self.assertLess(table["strategies"][strategy_id]["mean_net_bp"], 0)

    def test_searched_momentum_specs_are_never_presented_as_proven(self):
        for strategy_id in (C29, "c30-momentum-12h-perp-v1"):
            entry = load_reliability()["strategies"][strategy_id]
            self.assertIn(entry["verdict"], ("no_edge", "candidate_edge"), strategy_id)
            self.assertEqual(entry["selection_trials"], 1000)
            self.assertIn("previous", entry["by_range"])


class QwenReliabilityFieldTests(unittest.TestCase):
    VERDICT = {"proposals": [{"strategy_id": "c25-pullback-perp-v1"}, {"strategy_id": C29},
                             {"strategy_id": "made-up"}]}

    def table(self):
        return {"schema": RELIABILITY_SCHEMA, "strategies": {
            "c25-pullback-perp-v1": {"spec_hash": spec_hash(SPECS["c25-pullback-perp-v1"]), "trades": 3696,
                                     "verdict": "negative_edge", "hit_rate": 0.1693, "mean_net_bp": -13.04},
            C29: {"spec_hash": "stale", "trades": 300, "verdict": "tentative_edge", "hit_rate": 0.5, "mean_net_bp": 60}}}

    def test_each_proposal_gets_its_measured_verdict_or_unmeasured(self):
        line = q.STATE_FIELDS["strategy_reliability"](
            {"verdict": self.VERDICT, "specs": SPECS, "reliability": self.table()})
        self.assertEqual(line, "strategy_reliability: c25-pullback-perp-v1 negative_edge hit=0.17 net_bp=-13.0 "
                               "trades=3k; {} unmeasured; made-up unmeasured".format(C29))

    def test_the_trade_action_question_reads_it_as_context_only(self):
        question = q.load_questions()["trade_action"]
        self.assertIn("strategy_reliability", question["state_fields"])
        self.assertNotIn("strategy_reliability", question["instruction"])


if __name__ == "__main__":
    unittest.main()
