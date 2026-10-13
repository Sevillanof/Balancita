"""Stage 9B data/execution quality metrics. Synthetic data only; nothing here reads a database or the network."""

import unittest
from decimal import Decimal

from balancita_engine import data_quality as dq
from balancita_engine.futures_costs import side_impact_bps

D = Decimal
S = 1_000


class PercentileTests(unittest.TestCase):
    def test_nearest_rank_returns_observed_values(self):
        v = list(range(1, 101))
        self.assertEqual((dq.percentile(v, 50), dq.percentile(v, 90), dq.percentile(v, 99), dq.percentile(v, 100)),
                         (50, 90, 99, 100))
        self.assertIsNone(dq.percentile([], 50))
        self.assertEqual(dq.percentile([7], 99), 7)

    def test_small_sample_is_flagged_insufficient(self):
        self.assertEqual(dq.summary([1, 2, 3])["evidence"], dq.INSUFFICIENT)
        self.assertEqual(dq.summary(list(range(30)))["evidence"], dq.OBSERVED)

    def test_rule_of_three(self):
        self.assertEqual(dq.rule_of_three_n(0.01), 299)       # ~3 / 0.01
        with self.assertRaises(ValueError):
            dq.rule_of_three_n(0)


class LatencyTests(unittest.TestCase):
    def test_latency_stats_and_bad_stamps(self):
        quotes = [{"product_id": "PF_XBTUSD", "time_ms": 1000 * i, "received_ms": 1000 * i + 40 + i} for i in range(40)]
        quotes += [{"product_id": "PF_XBTUSD", "time_ms": 5000, "received_ms": 4000},      # clock skew
                   {"product_id": "PF_XBTUSD", "time_ms": 5000},                          # no receipt stamp
                   {"product_id": "PF_ETHUSD", "time_ms": 1, "received_ms": 2}]
        r = dq.receive_latency(quotes)
        x = r["PF_XBTUSD"]
        self.assertEqual((x["n"], x["negative"], x["missing_stamp"], x["min"], x["max"]), (40, 1, 1, 40, 79))
        self.assertEqual(x["evidence"], dq.OBSERVED)
        self.assertEqual(r["PF_ETHUSD"]["evidence"], dq.INSUFFICIENT)


class GapTests(unittest.TestCase):
    def test_gaps_longer_than_threshold_only(self):
        r = dq.quote_gaps([10 * S, 20 * S, 200 * S], 0, 300 * S, threshold_ms=120 * S)
        self.assertEqual([(g["kind"], g["duration_ms"]) for g in r["gaps"]], [("internal", 180 * S)])
        self.assertEqual(r["silent_ms"], 180 * S)

    def test_exactly_threshold_is_not_a_gap(self):
        self.assertEqual(dq.quote_gaps([120 * S], 0, 240 * S, threshold_ms=120 * S)["gaps"], [])

    def test_no_quotes_is_one_gap_and_leading_trailing_are_detected(self):
        self.assertEqual(dq.quote_gaps([], 0, 500 * S, threshold_ms=120 * S)["gaps"][0]["kind"], "no_quotes")
        r = dq.quote_gaps([300 * S], 0, 600 * S, threshold_ms=120 * S)
        self.assertEqual([g["kind"] for g in r["gaps"]], ["leading", "trailing"])

    def test_outside_and_duplicate_instants_are_ignored(self):
        r = dq.quote_gaps([-5, 50 * S, 50 * S, 10 ** 9], 0, 100 * S, threshold_ms=60 * S)
        self.assertEqual(r["quotes"], 1)
        self.assertEqual(r["gaps"], [])

    def test_coverage_ratio_and_sensitivity_is_monotonic(self):
        times = [i * 30 * S for i in range(0, 10)] + [900 * S]
        rows = dq.gap_sensitivity(times, 0, 1200 * S)
        silent = [r["silent_ms"] for r in rows]
        self.assertEqual(silent, sorted(silent, reverse=True))     # a looser threshold never flags more time
        self.assertEqual(dq.quote_gaps(times, 0, 0, threshold_ms=1)["coverage_ratio"], None)

    def test_invalid_window(self):
        with self.assertRaises(ValueError):
            dq.quote_gaps([], 10, 5, threshold_ms=1)


class StopCoverageTests(unittest.TestCase):
    T = 120 * S

    def test_classes(self):
        cont = dq.stop_watch_coverage(0, 300 * S, [60 * S, 120 * S, 200 * S, 290 * S], threshold_ms=self.T)
        self.assertEqual(cont["class"], "continuous")
        covered = dq.stop_watch_coverage(0, 400 * S, [10 * S, 390 * S], [[10 * S, 390 * S]], threshold_ms=self.T)
        self.assertEqual(covered["class"], "gaps_covered_by_candles")
        partial = dq.stop_watch_coverage(0, 400 * S, [10 * S, 390 * S], [[10 * S, 100 * S]], threshold_ms=self.T)
        self.assertEqual(partial["class"], "gaps_without_evidence")
        self.assertEqual(partial["uncovered_ms"], 290 * S)

    def test_short_position_without_evidence_is_never_continuous(self):
        r = dq.stop_watch_coverage(0, 30 * S, [], threshold_ms=self.T)
        self.assertEqual((r["class"], r["evidence"]), ("insufficient_evidence", dq.INSUFFICIENT))

    def test_uncovered_stretch_shorter_than_threshold_is_tolerated(self):
        r = dq.stop_watch_coverage(0, 400 * S, [10 * S, 390 * S], [[10 * S, 300 * S]], threshold_ms=self.T)
        self.assertEqual(r["class"], "gaps_covered_by_candles")       # 90 s left uncovered <= threshold


class SpreadAndImpactTests(unittest.TestCase):
    def test_spread_report_against_model_and_repeats(self):
        quotes = [{"bid": "99.99", "ask": "100.01"}] * 4 + [{"bid": "100", "ask": "100.04"}, {"bid": "x", "ask": "1"},
                                                              {"bid": "101", "ask": "100"}]
        r = dq.spread_report("PF_XBTUSD", quotes)
        self.assertEqual((r["n"], r["invalid"]), (5, 2))
        self.assertAlmostEqual(r["repeat_ratio"], 3 / 4)
        self.assertEqual(r["evidence"], dq.INSUFFICIENT)
        self.assertEqual(r["model_median_bps"], D("0.12"))

    def test_book_impact_walks_levels(self):
        asks = [("100", "5"), ("101", "10")]                  # 500 USD at 100, then 101
        self.assertEqual(dq.book_impact_bps(asks, "LONG", 400, 100), D(0))
        v = dq.book_impact_bps(asks, "LONG", 1000, 100)
        self.assertGreater(v, 0)
        bids = [("100", "5"), ("99", "10")]
        self.assertGreater(dq.book_impact_bps(bids, "SHORT", 1000, 100), 0)
        self.assertIsNone(dq.book_impact_bps(asks, "LONG", 10_000, 100))     # depth not enough: no extrapolation


class ExecutionVsModelTests(unittest.TestCase):
    def fill(self, slip_bps, execution="observed", side="LONG"):
        mid = D(100)
        price = mid * (1 + D(slip_bps) / 10000) if side == "LONG" else mid * (1 - D(slip_bps) / 10000)
        return {"product_id": "PF_ADAUSD", "side": side, "mid": mid, "price": price, "execution": execution}

    def test_residual_sign_and_modelled_exclusion(self):
        model = side_impact_bps("PF_ADAUSD")
        fills = [self.fill(model + 2) for _ in range(5)] + [self.fill(model + 2, side="SHORT")]
        fills += [self.fill(0, execution="modelled") for _ in range(3)]
        r = dq.execution_vs_model(fills)
        p = r["products"]["PF_ADAUSD"]
        self.assertEqual(r["excluded_modelled"], 3)
        self.assertEqual(p["n"], 6)
        self.assertAlmostEqual(float(p["mean_residual_bps"]), 2.0, places=6)
        self.assertEqual(p["optimistic_share"], 1.0)

    def test_only_modelled_fills_give_no_product(self):
        self.assertEqual(dq.execution_vs_model([self.fill(1, execution="modelled")])["products"], {})


class ThresholdEvidenceTests(unittest.TestCase):
    def test_never_approves(self):
        r = dq.threshold_evidence([200 * S] * 500, 10 ** 9, threshold_ms=120 * S, possible_breaches=0)
        self.assertEqual((r["verdict"], r["approved"]), ("supports_review", False))

    def test_small_sample_and_missing_breach_rate_are_insufficient(self):
        self.assertEqual(dq.threshold_evidence([200 * S] * 5, 10 ** 9, threshold_ms=120 * S,
                                               possible_breaches=0)["verdict"], "insufficient_evidence")
        self.assertEqual(dq.threshold_evidence([200 * S] * 500, 10 ** 9, threshold_ms=120 * S)["verdict"],
                         "insufficient_evidence")

    def test_breaches_are_reported(self):
        r = dq.threshold_evidence([200 * S] * 500, 10 ** 9, threshold_ms=120 * S, possible_breaches=3)
        self.assertEqual(r["verdict"], "breaches_observed")

    def test_gap_stop_exposure_is_an_upper_bound(self):
        gaps = [{"from_ms": 100, "to_ms": 200}, {"from_ms": 1000, "to_ms": 1100}, {"from_ms": 5000, "to_ms": 5100}]
        candles = [{"open_ms": 50, "close_ms": 150, "low": "97", "high": "101"},
                   {"open_ms": 950, "close_ms": 1150, "low": "99", "high": "101"}]
        r = dq.gap_stop_exposure(gaps, candles, stop="98", side="LONG")
        self.assertEqual([x["possible_breach"] for x in r], [True, False, None])


class PurityTests(unittest.TestCase):
    def test_module_has_no_io_or_clock_and_no_9a_dependency(self):
        import ast
        import inspect
        tree = ast.parse(inspect.getsource(dq))
        imported = {n.module if isinstance(n, ast.ImportFrom) else a.name
                    for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))
                    for a in (n.names if isinstance(n, ast.Import) else [n])}
        banned = {"time", "datetime", "socket", "sqlite3", "random", "urllib", "os", "balancita_engine.paper_runner"}
        self.assertFalse({i for i in imported if i and (i.split(".")[0] in banned or i in banned)})
        self.assertFalse({i for i in imported if i and ("paper_runner" in i or "portfolio" in i)})


if __name__ == "__main__":
    unittest.main()
