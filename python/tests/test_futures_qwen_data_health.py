import copy
import tempfile
import unittest
from decimal import Decimal
from unittest import mock

from balancita_engine import futures_history as history
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_live import BAR, LIVE_CFG, Policy, make, walk


class DataHealthTests(unittest.TestCase):
    def test_internal_cache_holes_are_refetched_even_when_the_bounds_cover_the_request(self):
        bars = walk(3, 1, 0)
        with tempfile.TemporaryDirectory() as folder:
            cache = history.CandleCache(folder + "/cache.sqlite")
            self.addCleanup(cache.close)
            cache.ensure("PF_ETHUSD", "5m", 0, 3 * BAR, fetch=lambda *args: [bars[0], bars[2]])
            fetch = mock.Mock(return_value=[bars[1]])
            cache.ensure("PF_ETHUSD", "5m", 0, 3 * BAR, fetch=fetch, repair_gaps=True)
            fetch.assert_called_once_with("PF_ETHUSD", "5m", BAR, 2 * BAR)
            self.assertEqual(len(cache.read("5m", 0, 3 * BAR)), 3)

    def test_generated_gap_candles_are_explicitly_unobserved(self):
        bars = walk(3, 1, 0)
        filled = history.fill_gaps([bars[0], bars[2]], BAR, annotate=True)
        self.assertEqual([bar["observed"] for bar in filled], [True, False, True])

    def test_a_fake_gap_candle_cannot_close_a_position_and_real_candles_still_apply_time_exits(self):
        cfg = copy.deepcopy(LIVE_CFG)
        trader = qt.Trader(cfg, "PF_ETHUSD", mock.Mock())
        for bar in walk(qt.MIN_BARS, 1, 0):
            trader.feed(bar, trade=False)
        start = trader.t[-1] + BAR
        position = qt.Position(
            side="SHORT", entry_ms=start, entry_px=Decimal("100"), entry_ref=100,
            qty=Decimal("1"), notional_usd=Decimal("100"), max_hold_ms=BAR,
            mfe_bp=0.0, mae_bp=0.0, trade_no=1)
        trader.position = position
        fake = dict(walk(1, 2, start)[0], observed=False)
        self.assertEqual(trader.feed(fake), [])
        self.assertIs(trader.position, position)
        actual = dict(walk(1, 3, start + BAR)[0], observed=True)
        events = trader.feed(actual)
        self.assertTrue(any(event["type"] == "trade" and event["trade"]["closed_by"] == "tiempo" for event in events))

    def test_incomplete_features_are_not_used_for_an_expert_decision(self):
        trader = qt.Trader(copy.deepcopy(LIVE_CFG), "PF_ETHUSD", mock.Mock())
        for bar in walk(qt.MIN_BARS, 1, 0):
            trader.feed(bar, trade=False)
        start = trader.t[-1] + BAR
        trader.feed(dict(walk(1, 2, start)[0], observed=False))
        with mock.patch.object(trader, "_decide", side_effect=AssertionError("unobserved features")):
            events = trader.feed(dict(walk(1, 3, start + BAR)[0], observed=True))
        self.assertEqual(events[-1]["kind"], "datos_incompletos")

    def test_input_failures_do_not_hide_behind_a_current_heartbeat(self):
        env = make(self, policy=Policy(flat="ESPERAR"))
        env.op.start()
        env.feed.bars = mock.Mock(side_effect=history.HistoryError("Public data unavailable"))
        env.advance(5)
        self.assertTrue(env.op.failed_cycle)
        self.assertTrue(env.rows("SELECT * FROM errors"))
        self.assertEqual(env.store.meta()["data_health_PF_ETHUSD"]["status"], "error")
        self.assertEqual(env.store.meta()["heartbeat_ms"], env.now[0])


if __name__ == "__main__":
    unittest.main()
