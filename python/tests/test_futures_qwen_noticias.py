"""Tests for the News Analyst (futures_qwen_noticias) as an OR entry enabler alongside Maestro and Portero."""
import os
import tempfile
import unittest
from unittest import mock

from balancita_engine import futures_news as news_mod
from balancita_engine import futures_qwen_aprende as ap
from balancita_engine import futures_qwen_corta as corta
from balancita_engine import futures_qwen_noticias as noticias
from test_futures_qwen_live import Policy, make

MIN = 60_000
HOUR = 60 * MIN


def _seed_news_item(store, idx, title, published_at, received_at, analyzed_at, relevance, rel_val, direction):
    url = "https://example.com/news/{}".format(idx)
    ihash = news_mod.item_hash(url, title)
    store.add_item({
        "item_hash": ihash,
        "source_id": "fed",
        "source": "Federal Reserve",
        "url": url,
        "title": title,
        "summary": "Summary text",
        "published_at": published_at,
        "received_at": received_at,
        "content_hash": news_mod.text_hash(title),
    })
    for qid, chosen, val, probs in (
        ("news_relevance_btc", relevance, rel_val, {relevance: 0.9}),
        ("news_direction", direction, None, {direction: 0.85}),
    ):
        store.append_analysis({
            "item_hash": ihash,
            "question_id": qid,
            "question_version": 1,
            "status": "done",
            "analyzed_at": analyzed_at,
            "question_type": "score" if val is not None else "choice",
            "model_ref": "qwen-test",
            "prompt_hash": "p1",
            "prompt_version": 1,
            "probability_source": "logprobs",
            "probabilities": probs,
            "temperature": 1.0,
            "chosen": chosen,
            "value": val,
            "confidence": 0.85,
            "latency_ms": 50,
        })


class NewsAnalystFilterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = os.path.join(self.tmp.name, "news.sqlite")
        self.store = news_mod.NewsStore(self.db_path, news_mod.NEWS_CONFIG)
        self.addCleanup(self.store.close)
        self.t0 = 1_793_000_000_000

    def test_fresh_exogenous_news_enables_aligned_side_and_ignores_stale_recap_or_future_items(self):
        # 1. Stale item (published 40 min before received -> ignored)
        _seed_news_item(
            self.store, 1, "Federal Reserve announces emergency liquidity facility",
            self.t0 - 50 * MIN, self.t0 - 10 * MIN, self.t0 - 9 * MIN,
            "high", 1.0, "bullish"
        )
        # 2. Price recap headline (narrating price move -> ignored)
        _seed_news_item(
            self.store, 2, "Bitcoin slides below $80,000 as traders react",
            self.t0 - 8 * MIN, self.t0 - 5 * MIN, self.t0 - 4 * MIN,
            "high", 1.0, "bearish"
        )
        # 3. Future item (analyzed after decision time t0 -> no look-ahead, ignored at t0)
        _seed_news_item(
            self.store, 3, "SEC approves new institutional custody rule",
            self.t0 - 2 * MIN, self.t0 - 1 * MIN, self.t0 + 2 * MIN,
            "high", 1.0, "bullish"
        )
        feed = noticias.NewsFeed(self.db_path)
        ok_long, info = noticias.verdict(feed, self.t0, 1)
        self.assertFalse(ok_long)
        self.assertEqual(info["n"], 0)

        # At t0 + 5 min, item 3 is now known and fresh (received - published = 1 min <= 15 min)
        ok_long_later, info_later = noticias.verdict(feed, self.t0 + 5 * MIN, 1)
        self.assertTrue(ok_long_later)
        self.assertEqual(info_later["n"], 1)
        self.assertGreater(info_later["sentimiento"], 0.5)

        # For a short side (-1), a bullish catalyst does not enable entry
        ok_short_later, _ = noticias.verdict(feed, self.t0 + 5 * MIN, -1)
        self.assertFalse(ok_short_later)


class FormulaOrEnablerTests(unittest.TestCase):
    def test_or_enabler_opens_when_maestro_is_strong_and_either_portero_or_news_agrees(self):
        # Portero NO + News YES -> opens with news reason
        r_news = {"veredicto": 2, "portero_si": False, "noticias_si": True}
        self.assertEqual(corta.formula_action(r_news, None), ("LARGO", "maestro fuerte y noticias a favor"))
        self.assertEqual(
            corta.formula_action(dict(r_news, veredicto=-2), None),
            ("CORTO", "maestro fuerte y noticias a favor"),
        )
        self.assertEqual(ap.formula_flat(2, False, True), "LARGO")
        self.assertEqual(ap.formula_flat(-2, False, True), "CORTO")

        # Portero YES + News NO -> still opens with portero reason (never vetoes Portero)
        r_portero = {"veredicto": 2, "portero_si": True, "noticias_si": False}
        self.assertEqual(corta.formula_action(r_portero, None), ("LARGO", "maestro fuerte y portero a favor"))
        self.assertEqual(ap.formula_flat(2, True, False), "LARGO")

        # Weak maestro + News YES -> still waits (Maestro must be strong)
        r_weak = {"veredicto": 1, "portero_si": False, "noticias_si": True}
        self.assertEqual(corta.formula_action(r_weak, None), ("ESPERAR", "el maestro no está fuerte"))
        self.assertEqual(ap.formula_flat(1, False, True), "ESPERAR")

        # Legacy dict without noticias_si preserves previous behavior
        self.assertEqual(
            corta.formula_action({"veredicto": 2, "portero_si": False}, None),
            ("ESPERAR", "el portero dice que no conviene"),
        )

    def test_live_operator_opens_trade_when_news_enables_strong_maestro(self):
        env = make(self, policy=Policy(flat="ESPERAR", position="MANTENER"), formula=True)
        fake_reading = {
            "hechos": {},
            "puntaje": 0.25,
            "flojo": 0.11,
            "veredicto": 2,
            "portero_p": 0.64,
            "portero_si": False,
            "noticias_si": True,
            "vol_ratio": 1.0,
            "volatilidad": "NORMAL",
            "sigma24": 0.02,
            "range24": 0.03,
            "range7": 0.03,
        }
        with mock.patch.object(corta, "readings", return_value=fake_reading):
            env.op.start()
            env.advance(15)
        trades = env.rows("SELECT * FROM trades WHERE status='open'")
        self.assertEqual(len(trades), 2)
        decisions = env.rows("SELECT action, formula_action, formula_json FROM decisions WHERE action='LARGO'")
        self.assertEqual(len(decisions), 2)
        self.assertIn("noticias a favor", decisions[0]["formula_json"])


class AuditAndIdentityTests(unittest.TestCase):
    def test_formula_json_keeps_the_news_detail_that_enabled_the_entry(self):
        detail = {"disponible": True, "n": 2, "sentimiento": 0.5, "max_relevancia": 0.96, "a_favor": True}
        reading = {"veredicto": 2, "puntaje": 0.3, "portero_si": False, "portero_p": 0.5, "noticias_si": True, "noticias": detail,
                   "volatilidad": "BAJA"}
        out = corta.formula_json(reading, "maestro fuerte y noticias a favor")
        self.assertTrue(out["noticias_si"])
        self.assertEqual(out["noticias"], detail)

    def test_formula_json_without_news_detail_stays_valid(self):
        reading = {"veredicto": 0, "puntaje": 0.0, "portero_si": False, "portero_p": 0.5, "volatilidad": "BAJA"}
        out = corta.formula_json(reading, "el maestro no está fuerte")
        self.assertFalse(out["noticias_si"])
        self.assertIsNone(out["noticias"])

    def test_the_news_rule_version_changes_the_config_identity_but_the_machine_path_does_not(self):
        from balancita_engine import futures_qwen_trader as qt
        cfg = qt.load_config(os.path.join(os.path.dirname(__file__), "..", "..", "config", "qwen-live.json"))
        base = qt.config_hash(cfg)
        self.assertEqual(cfg["noticias"]["version"], 1)
        self.assertEqual(qt.config_hash(dict(cfg, news_db="/otra/ruta/noticias.sqlite")), base)
        self.assertNotEqual(qt.config_hash(dict(cfg, noticias={"version": 2})), base)


if __name__ == "__main__":
    unittest.main()
