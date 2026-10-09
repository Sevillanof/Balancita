import math
import random
import unittest

from balancita_engine.futures_portfolio_risk import (
    DAY_MS,
    daily_close_returns,
    daily_returns,
    pearson,
    portfolio_risk,
    product_correlation,
    series_stats,
)


def _trade(day, pnl):
    return {"exit_time_ms": day * DAY_MS + 1000, "pnl_usd": pnl}


class DailyReturnsTests(unittest.TestCase):
    def test_pnl_is_booked_on_the_exit_day_and_flat_days_are_zero(self):
        trades = [_trade(0, 1.0), _trade(0, -0.5), _trade(3, 2.0)]
        self.assertEqual(daily_returns(trades, 0, 4 * DAY_MS, 100.0), [0.005, 0.0, 0.0, 0.02, 0.0])

    def test_trades_outside_the_window_are_ignored(self):
        self.assertEqual(daily_returns([_trade(9, 1.0)], 0, 2 * DAY_MS), [0.0, 0.0, 0.0])


class StatsTests(unittest.TestCase):
    def test_vol_sharpe_and_drawdown(self):
        returns = [0.01, -0.02] * 10
        stats = series_stats(returns)
        self.assertEqual(stats["days"], 20)
        self.assertAlmostEqual(stats["total_return_pct"], -10.0)
        self.assertLess(stats["sharpe_annual"], 0)
        self.assertLess(stats["max_drawdown_pct"], 0)
        self.assertAlmostEqual(stats["worst_day_pct"], -2.0)

    def test_too_few_days_reports_nothing(self):
        self.assertIsNone(series_stats([0.01] * 3)["sharpe_annual"])

    def test_constant_series_has_no_sharpe_or_correlation(self):
        self.assertIsNone(series_stats([0.0] * 20)["sharpe_annual"])
        self.assertIsNone(pearson([1.0] * 20, list(range(20))))

    def test_pearson_sign(self):
        a = list(range(20))
        self.assertAlmostEqual(pearson(a, [2 * x + 1 for x in a]), 1.0)
        self.assertAlmostEqual(pearson(a, [-x for x in a]), -1.0)


class PortfolioTests(unittest.TestCase):
    def _book(self, seed, days=60):
        rng = random.Random(seed)
        return [_trade(d, rng.gauss(0, 1)) for d in range(days)]

    def test_identical_strategies_are_one_bet_and_independent_ones_are_many(self):
        base = self._book(1)
        same = portfolio_risk({"a": base, "b": list(base), "c": list(base)}, 0, 59 * DAY_MS)
        self.assertAlmostEqual(same["portfolio_equal_weight"]["effective_bets"], 1.0, places=1)
        self.assertAlmostEqual(same["portfolio_equal_weight"]["diversification_ratio"], 1.0, places=1)
        indep = portfolio_risk({s: self._book(s) for s in range(2, 8)}, 0, 59 * DAY_MS)
        self.assertGreater(indep["portfolio_equal_weight"]["effective_bets"], 3.5)
        self.assertGreater(indep["portfolio_equal_weight"]["diversification_ratio"], 1.8)

    def test_single_strategy_has_no_portfolio_and_empty_window_is_none(self):
        one = portfolio_risk({"a": self._book(1)}, 0, 59 * DAY_MS)
        self.assertIsNone(one["portfolio_equal_weight"])
        self.assertIsNone(portfolio_risk({}, None, None))


class ProductCorrelationTests(unittest.TestCase):
    def _candles(self, closes):
        return [{"bucket_start": d * DAY_MS, "close": str(c)} for d, c in enumerate(closes)]

    def test_products_moving_together_correlate(self):
        rng = random.Random(3)
        a = [100.0]
        for _ in range(40):
            a.append(a[-1] * (1 + rng.gauss(0, 0.02)))
        b = [x * 2 for x in a]
        c = [100.0]
        for _ in range(40):
            c.append(c[-1] * (1 + rng.gauss(0, 0.02)))
        out = product_correlation({"A": self._candles(a), "B": self._candles(b), "C": self._candles(c)})
        self.assertAlmostEqual(out["A"]["B"], 1.0, places=3)
        self.assertLess(abs(out["A"]["C"]), 0.6)
        self.assertEqual(out["A"]["A"], 1.0)

    def test_gaps_in_days_are_not_bridged(self):
        candles = [{"bucket_start": 0, "close": "1"}, {"bucket_start": 2 * DAY_MS, "close": "2"}]
        self.assertEqual(daily_close_returns(candles), {})


if __name__ == "__main__":
    unittest.main()
