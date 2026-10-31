import copy
import os
import tempfile
import unittest
from unittest import mock

from balancita_engine import futures_qwen_quick_api as api
from balancita_engine import futures_qwen_quick_variants as variants
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as exam
from balancita_engine import strategy_gate_models as models
from balancita_engine.futures_strategy_gate_api import GateApiError
from test_futures_qwen_live import BAR, LIVE_CFG, walk


class ReplayControlTests(unittest.TestCase):
    def test_news_only_api_refuses_candle_model_variants_and_sends_account_mode_to_the_runner(self):
        with tempfile.TemporaryDirectory() as folder:
            spawn = mock.Mock()
            service = api.QuickTestApi(folder + "/exam.sqlite", python="py", spawn=spawn, news_only=True)
            with self.assertRaises(GateApiError):
                service.launch(models.QWEN_LIVE_ID, "actual")
            spawn.assert_not_called()
            service.launch(models.QWEN_LIVE_ID, "formula", {"maestro": 5, "portero": 5, "analista": "fuerte", "cuenta": "entera"})
            self.assertEqual(spawn.call_args.args[1]["QWEN_CUENTA"], "entera")

    def test_replay_uses_the_real_trader_and_does_not_read_contemporary_news_as_historical_evidence(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg.update(products=["PF_ETHUSD"], cuenta="entera", notional_usd="1000", decide_by="formula", opinion_enabled=False)
        cfg["exam"]["products"] = ["PF_ETHUSD"]
        cfg["exam"]["from"] = cfg["practice"]["from"] = "2026-01-01"
        cfg.pop("analista", None)
        start = qt.date_ms("2026-01-01")
        bars = walk(qt.MIN_BARS + 300, 1, start - qt.MIN_BARS * BAR, price=100)
        reader = mock.Mock()
        reader.bars.side_effect = lambda product, low, high, **kw: [b for b in bars if low <= b["bucket_start"] < high]
        reader.funding.return_value = [(at, 0) for at in range(start - qt.DAY_MS, start + qt.DAY_MS, qt.HOUR_MS)]
        actual_feed = qt.Trader.feed
        seen = []

        def feed(trader, candle, trade=True):
            self.assertIsNone(trader.news)
            seen.append((candle["bucket_start"], trade))
            return actual_feed(trader, candle, trade=trade)

        with mock.patch.object(qt.Trader, "feed", feed), \
                mock.patch.object(qt.Trader, "_decide", return_value=[]):
            result = exam.replay_formula(reader, cfg, start + qt.DAY_MS)
        self.assertTrue(seen)
        self.assertEqual(result["execution"], "terminal.v2")
        self.assertFalse(result["news_evaluated"])
        self.assertEqual(result["capital_inicial_usd"], "1000")
        self.assertEqual(result["saldo_final_usd"], "1000")

    def test_whole_account_replay_caps_actual_exposure_instead_of_multiplying_the_result_by_one_and_a_half(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg.update(cuenta="entera", notional_usd="1000", decide_by="formula", opinion_enabled=False)
        cfg["exam"]["products"] = ["PF_ETHUSD"]
        cfg["exam"]["from"] = cfg["practice"]["from"] = "2026-01-01"
        cfg.pop("analista", None)
        start = qt.date_ms("2026-01-01")
        bars = walk(qt.MIN_BARS + 300, 1, start - qt.MIN_BARS * BAR, price=100)
        reader = mock.Mock()
        reader.bars.side_effect = lambda product, low, high, **kw: [b for b in bars if low <= b["bucket_start"] < high]
        reader.funding.return_value = [(at, 0) for at in range(start - qt.DAY_MS, start + qt.DAY_MS, qt.HOUR_MS)]

        def decide(trader, t_ms, reasons):
            if trader.position is None:
                trader._open(t_ms, "LONG", 1, "controlled_test")
                return []
            return trader._close(t_ms, trader.c[-1], "strategy_exit", "controlled_test", None)

        with mock.patch.object(qt.Trader, "_decide", decide), \
                mock.patch("balancita_engine.futures_qwen_analista.multiplier", return_value=1.5):
            result = exam.replay_formula(reader, cfg, start + qt.DAY_MS)
        first = result["curvas"]["formula"][0]
        self.assertLessEqual(qt.D(first["notional_usd"]) * qt.D("1.0005"), qt.D(1000))
        cash = qt.D(1000)
        for trade in result["curvas"]["formula"]:
            cash += qt.D(trade["pnl_usd"])
        self.assertEqual(qt.D(result["saldo_final_usd"]), cash)


if __name__ == "__main__":
    unittest.main()
