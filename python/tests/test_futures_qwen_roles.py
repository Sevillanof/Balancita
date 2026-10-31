import copy
import contextlib
import io
import unittest
from unittest import mock

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_live import LIVE_CFG, make


class NewsOnlyRolesTests(unittest.TestCase):
    def test_news_only_cli_refuses_candle_probes_without_calling_the_provider(self):
        provider = mock.Mock()
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            code = llm.main(["--probe"], provider=provider, enabled=False)
        self.assertEqual(code, 2)
        self.assertIn("solo se usa para noticias", errors.getvalue())
        self.assertEqual(provider.method_calls, [])

    def test_runtime_opinion_switch_preserves_trading_identity(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg["runtime"]["opinion_enabled"] = False
        self.assertEqual(qt.config_hash(cfg), qt.config_hash(LIVE_CFG))
        self.assertFalse(qt.candle_opinions_enabled(cfg))

    def test_runtime_news_only_never_queries_the_model_on_candles(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg["runtime"]["opinion_enabled"] = False
        env = make(self, cfg=cfg, formula=True)
        with mock.patch.object(env.provider, "health", side_effect=AssertionError("price health dependency")) as health:
            with mock.patch.object(env.provider, "complete", side_effect=AssertionError("price opinion")) as complete:
                env.op.start()
                env.advance(30)
        rows = env.rows("SELECT formula_json,model_action FROM decisions")
        self.assertTrue(rows)
        self.assertTrue(all(r["model_action"] is None for r in rows))
        self.assertEqual(env.op._errors, {})
        health.assert_not_called()
        complete.assert_not_called()
        self.assertEqual(env.rows("SELECT * FROM examples"), [])

    def test_legacy_candle_worker_can_remain_idle_without_model_calls_or_cursors(self):
        provider = mock.Mock()
        store = mock.Mock()
        store.config = {"max_verdict_lag_ms": 60_000}
        service = llm.DecisionService(
            "/not-used/market", "/not-used/verdicts", store, provider, {}, {},
            ["PF_ETHUSD"], enabled=False)
        self.assertEqual(service.poll(), 0)
        self.assertEqual(provider.method_calls, [])
        self.assertIsNone(service.market)
        self.assertIsNone(service.verdicts)


if __name__ == "__main__":
    unittest.main()
