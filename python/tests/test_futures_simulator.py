import random
import time
import unittest

from balancita_engine.futures_hits import direction_hit, gross_bp, trade_hit
from balancita_engine.futures_indicators import calculate_features
from balancita_engine.futures_simulator import IncrementalFeatures, simulate, simulate_many
from balancita_engine.futures_spec_strategy import load_specs
from balancita_engine.futures_verdicts import ONE_MINUTE_MS, _feature_candle

from test_futures_spec_strategy import _random_walk

SPECS = load_specs()
ONES, FIVES = _random_walk(random.Random(11), 1500)


class ParityTests(unittest.TestCase):
    def test_incremental_features_equal_calculate_features_on_the_whole_history(self):
        incremental = IncrementalFeatures()
        bars = [_feature_candle(c) for c in ONES]
        for index, candle in enumerate(ONES):
            got = incremental.update(candle)
            if index + 1 not in (1, 14, 15, 20, 21, 22, 49, 50, 51, 300, len(ONES)):
                continue
            want = calculate_features(bars[:index + 1], interval_ms=ONE_MINUTE_MS,
                                      decision_time_ms=bars[index]["known_at_ms"])
            self.assertEqual(got["ready"], want["ready"], index)
            if index + 1 < 50:
                continue  # below the minimum history calculate_features reports nothing
            for key, value in want.items():
                if key not in ("reason_codes", "candidate_low", "candidate_high", "candidate_bucket_start_ms"):
                    self.assertEqual(got[key], value, (index, key))


class HitTests(unittest.TestCase):
    def test_definitions(self):
        self.assertTrue(trade_hit("0.01"))
        self.assertFalse(trade_hit(0))
        self.assertTrue(direction_hit("SHORT", "100", "99"))
        self.assertFalse(direction_hit("LONG", "100", "99"))
        self.assertEqual(float(gross_bp("LONG", "100", "101")), 100.0)


class BookTests(unittest.TestCase):
    def test_every_strategy_has_its_own_book_and_fixed_notional(self):
        books = simulate_many(list(SPECS.values()), ONES, FIVES)
        self.assertEqual({b.spec["id"] for b in books}, set(SPECS))
        for book in books:
            for trade in book.trades:
                self.assertEqual(trade["notional_usd"], "100")
                self.assertEqual(trade["hit"], trade["pnl_usd"] > 0)
        self.assertGreater(sum(len(b.trades) for b in books), 0)

    def test_a_book_alone_equals_the_same_book_among_others(self):
        spec = SPECS["c27-breakout-perp-v1"]
        alone = simulate(spec, ONES, FIVES)
        among = [b for b in simulate_many(list(SPECS.values()), ONES, FIVES) if b.spec["id"] == spec["id"]][0]
        self.assertEqual(alone.trades, among.trades)
        self.assertEqual(alone.decisions, among.decisions)

    def test_decisions_keep_their_outcome_and_traded_ones_their_trade_result(self):
        book = simulate_many(list(SPECS.values()), ONES, FIVES)
        judged = [d for b in book for d in b.decisions if d["direction_hit"] is not None]
        self.assertTrue(judged)
        traded = [d for b in book for d in b.decisions if d["trade_hit"] is not None]
        self.assertTrue(all(d["traded"] for d in traded))

    def test_cost_makes_a_flat_market_lose(self):
        for book in simulate_many(list(SPECS.values()), ONES, FIVES):
            for trade in book.trades:
                gross = (float(trade["exit_price"]) - float(trade["entry_price"])) * float(trade["quantity"])
                if trade["side"] == "SHORT":
                    gross = -gross
                self.assertLess(trade["pnl_usd"], gross + 1e-9)


class SpeedTests(unittest.TestCase):
    def test_a_day_of_one_minute_candles_runs_in_seconds(self):
        started = time.time()
        simulate_many(list(SPECS.values()), ONES, FIVES)
        self.assertLess(time.time() - started, 20)


if __name__ == "__main__":
    unittest.main()
