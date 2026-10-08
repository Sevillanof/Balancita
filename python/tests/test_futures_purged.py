import random
import unittest

from balancita_engine.futures_purged import (
    cscv_pbo,
    embargo_ms,
    fold_summary,
    lookahead_leaks,
    purged_folds,
    purged_split,
    stress,
)
from balancita_engine.futures_spec_strategy import load_specs
from balancita_engine.futures_strategy_backtest import run_backtest, simulate

from test_futures_spec_strategy import _random_walk

HOUR = 3_600_000
SPECS = load_specs()


def _trade(net_bp, entry_h, hold_h=1, side="LONG"):
    entry = int(entry_h * HOUR)
    return {"net_bp": net_bp, "pnl_usd": net_bp / 100, "entry_time_ms": entry,
            "exit_time_ms": entry + int(hold_h * HOUR), "entry_bucket_ms": entry - 60_000, "side": side}


class PurgedSplitTests(unittest.TestCase):
    def test_a_trade_that_crosses_the_cut_is_in_neither_side_and_the_embargo_is_skipped(self):
        trades = [_trade(1, 5), _trade(1, 9.5, hold_h=1), _trade(1, 10.5), _trade(1, 12), _trade(1, 20)]
        inside, outside, dropped = purged_split(trades, 10 * HOUR, embargo=2 * HOUR)
        self.assertEqual([t["entry_time_ms"] // HOUR for t in inside], [5])
        self.assertEqual([t["entry_time_ms"] // HOUR for t in outside], [12, 20])
        self.assertEqual(dropped, 2)

    def test_embargo_is_the_longest_hold_capped_by_a_share_of_the_block(self):
        trades = [_trade(1, 0, hold_h=3), _trade(1, 5, hold_h=48)]
        self.assertEqual(embargo_ms(trades), 48 * HOUR)
        self.assertEqual(embargo_ms(trades, width_ms=100 * HOUR), 25 * HOUR)


class PurgedFoldTests(unittest.TestCase):
    def test_crossing_and_embargoed_trades_are_dropped_from_the_blocks(self):
        # Two blocks of 100 h; the longest hold is 4 h, so block 2 skips its first 4 h.
        trades = [_trade(10, 10), _trade(10, 98, hold_h=4), _trade(-4, 101), _trade(-4, 150), _trade(2, 40, hold_h=4)]
        blocks = purged_folds(trades, 0, 200 * HOUR, folds=2)
        self.assertEqual([b["trades"] for b in blocks], [2, 1])
        self.assertEqual([b["dropped"] for b in blocks], [1, 1])
        self.assertEqual(blocks[0]["mean_net_bp"], 6.0)
        self.assertEqual(blocks[1]["mean_net_bp"], -4.0)

    def test_every_trade_of_the_period_belongs_to_some_block_when_nothing_crosses(self):
        trades = [_trade(1, h) for h in (0, 30, 60, 90, 120, 199)]
        blocks = purged_folds(trades, 0, 200 * HOUR, folds=4)
        self.assertEqual(sum(b["trades"] + b["dropped"] for b in blocks), len(trades))

    def test_a_block_with_too_few_trades_is_not_judged(self):
        blocks = purged_folds([_trade(5, h) for h in range(0, 100)] + [_trade(-50, 150)], 0, 200 * HOUR, folds=2)
        summary = fold_summary(blocks, min_trades=5)
        self.assertEqual((summary["judged"], summary["positive"]), (1, 1))


class OverfittingTests(unittest.TestCase):
    def _variants(self, edges, seed):
        rng = random.Random(seed)
        return {"v{}".format(i): [_trade(edge + rng.gauss(0, 30), h) for h in range(0, 800, 2)]
                for i, edge in enumerate(edges)}

    def test_variants_with_the_same_edge_are_a_coin_toss(self):
        result = cscv_pbo(self._variants([0] * 8, 1), 0, 800 * HOUR)
        self.assertGreater(result["pbo"], 0.3)
        self.assertEqual((result["variants"], result["combinations"]), (8, 70))

    def test_a_variant_that_really_is_better_is_not_flagged(self):
        result = cscv_pbo(self._variants([0, 0, 0, 40], 2), 0, 800 * HOUR)
        self.assertLess(result["pbo"], 0.1)
        self.assertEqual(result["picked"], {"v3": 70})

    def test_a_variant_that_barely_traded_is_left_out_instead_of_winning_by_doing_nothing(self):
        variants = self._variants([-20, -20, -20], 4)
        variants["idle"] = [_trade(500, 3)]
        result = cscv_pbo(variants, 0, 800 * HOUR)
        self.assertEqual((result["excluded"], result["variants"]), (["idle"], 3))
        self.assertNotIn("idle", result["picked"])

    def test_one_variant_has_nothing_to_compare_with(self):
        self.assertIsNone(cscv_pbo(self._variants([5], 3), 0, 800 * HOUR))


class StressTests(unittest.TestCase):
    def test_extra_cost_and_one_bar_late_entry_reprice_the_same_trades(self):
        candles = [{"bucket_start": 59 * 60_000 + i * 60_000, "open": "100", "close": "100"} for i in range(4)]
        candles[1]["open"] = "100.1"  # the bar after the signal opens 10 bp higher
        trades = [{"net_bp": 30.0, "pnl_usd": 0.3, "entry_time_ms": 60 * 60_000, "entry_bucket_ms": 59 * 60_000,
                   "side": "LONG"}]
        result = stress(trades, candles, "PF_XBTUSD")
        self.assertAlmostEqual(result["late_entry_mean_net_bp"], 20.0, places=1)
        self.assertLess(result["extra_cost_mean_net_bp"], 30.0)
        self.assertEqual(result["break_even_extra_bp"], 30.0)
        short = dict(trades[0], side="SHORT")
        self.assertAlmostEqual(stress([short], candles, "PF_XBTUSD")["late_entry_mean_net_bp"], 40.0, places=1)

    def test_no_trades_no_stress(self):
        self.assertIsNone(stress([], [], "PF_XBTUSD")["late_entry_mean_net_bp"])


class LookaheadSentinelTests(unittest.TestCase):
    ONES, FIVES = _random_walk(random.Random(11), 1500)

    def test_shipped_strategies_do_not_peek_at_candles_that_have_not_closed(self):
        for spec in SPECS.values():
            leaks = lookahead_leaks(lambda ones, fives: simulate(spec, ones, fives)[0], self.ONES, self.FIVES, 1000)
            self.assertEqual(leaks, [], spec["id"])

    def test_a_runner_that_reads_the_future_is_caught(self):
        spec = SPECS["c27-breakout-perp-v1"]
        full_length = len(self.ONES)

        def peeking(ones, fives):
            trades = simulate(spec, ones, fives)[0]
            # Whatever the run knows about how long the data is changes its trades: a future-dependent rule.
            return [dict(t, net_bp=t["net_bp"] + (len(ones) == full_length)) for t in trades]

        self.assertTrue(lookahead_leaks(peeking, self.ONES, self.FIVES, 1000))


class BacktestIntegrationTests(unittest.TestCase):
    ONES, FIVES = _random_walk(random.Random(7), 1500)

    def test_the_backtest_reports_purged_folds_split_and_stress(self):
        result = run_backtest(SPECS["c27-breakout-perp-v1"], self.ONES, self.FIVES)
        total, inside, outside = result["all"]["trades"], result["in_sample"]["trades"], result["out_of_sample"]["trades"]
        self.assertEqual(total, inside + outside + result["split_purge"]["dropped"])
        self.assertLessEqual(outside, result["out_of_sample_unpurged"]["trades"])
        folds = result["purged_folds"]
        self.assertEqual(len(folds["blocks"]), folds["folds"])
        self.assertLessEqual(sum(b["trades"] for b in folds["blocks"]), total)
        self.assertIsNotNone(result["stress"]["late_entry_mean_net_bp"])


if __name__ == "__main__":
    unittest.main()
