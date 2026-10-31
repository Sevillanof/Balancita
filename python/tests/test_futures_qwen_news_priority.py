import copy
from decimal import Decimal as D
import json
import os
import tempfile
import unittest
from unittest import mock

from balancita_engine import futures_news as news_mod
from balancita_engine import futures_qwen_corta as sheet
from balancita_engine import futures_qwen_noticias as news
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_live import BAR, BASE, LIVE_CFG, MIN, Policy, make

HOUR = 60 * MIN
POLICY = {
    "policy": "priority_v2",
    "source_licenses": {
        "fed": {
            "status": "public_domain",
            "url": "https://www.federalreserve.gov/disclaimer.htm",
            "host": "federalreserve.gov",
        }
    },
}


def reading(**overrides):
    base = {
        "hechos": {}, "veredicto": 2, "puntaje": 0.3, "flojo": 0.11,
        "portero_si": True, "portero_p": 0.8, "noticias_si": False,
        "volatilidad": "ALTA", "vol_ratio": 1.5, "sigma24": 0.02,
        "range24": 0.03, "range7": 0.02,
    }
    return dict(base, **overrides)


def seed(store, idx, published, received, analyzed, direction="bearish", title="Federal Reserve announces emergency rate decision",
         relevance="high", support=0.9, url=None):
    url = url if url is not None else "https://www.federalreserve.gov/newsevents/pressreleases/{}.htm".format(idx)
    ihash = news_mod.item_hash(url, title)
    store.add_item({
        "item_hash": ihash, "source_id": "fed", "source": "Federal Reserve", "url": url,
        "title": title, "summary": "Official monetary policy announcement.",
        "published_at": published, "received_at": received, "content_hash": news_mod.text_hash(title),
    })
    for qid, chosen, options in (
        ("news_relevance_btc", relevance, ("none", "low", "medium", "high")),
        ("news_direction", direction, ("bullish", "bearish", "neutral")),
    ):
        probs = {key: support if key == chosen else (1 - support) / (len(options) - 1) for key in options}
        store.append_analysis({
            "item_hash": ihash, "question_id": qid, "question_version": 2, "status": "done",
            "analyzed_at": analyzed, "question_type": "choice", "model_ref": "local-test",
            "prompt_hash": "test", "prompt_version": 2, "probability_source": "logprobs",
            "probabilities": probs, "temperature": 1.0, "chosen": chosen, "value": None,
            "confidence": 0.9, "latency_ms": 10,
        })
    return ihash


class PriorityEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.path = os.path.join(self.tmp, "news.sqlite")
        self.store = news_mod.NewsStore(self.path, news_mod.NEWS_CONFIG)
        self.addCleanup(self.store.close)
        self.at = BASE + HOUR

    def feed(self, policy=None):
        return news.NewsFeed(self.path, priority_policy=POLICY if policy is None else policy)

    def test_strong_fresh_evidence_has_full_provenance_and_no_future_knowledge(self):
        ident = seed(self.store, 1, self.at - 5 * MIN, self.at - 4 * MIN, self.at + MIN)
        feed = self.feed()
        self.assertEqual(feed.priority_at(self.at)["status"], "none")
        got = feed.priority_at(self.at + 2 * MIN)
        self.assertEqual(got["status"], "signal")
        self.assertEqual(got["signal"]["side"], -1)
        for key in ("event_id", "source", "url", "published_at", "received_at", "known_at", "license_status"):
            self.assertIn(key, got["signal"])
        self.assertIn(ident, got["signal"]["item_hashes"])
        self.assertEqual(feed.priority_at(self.at + 11 * MIN)["status"], "none")

    def test_medium_weak_stale_unlicensed_and_price_recaps_cannot_trade(self):
        for idx, change in enumerate((
            {"relevance": "medium"}, {"support": 0.7},
            {"title": "Ethereum price surges above $3000"},
            {"title": "Solana foundation announces ecosystem grant"},
        )):
            seed(self.store, idx, self.at - 5 * MIN, self.at - 4 * MIN, self.at - 3 * MIN, **change)
        seed(self.store, 9, self.at - 40 * MIN, self.at - MIN, self.at)
        self.assertEqual(self.feed().priority_at(self.at)["status"], "none")
        seed(self.store, 10, self.at - 5 * MIN, self.at - 4 * MIN, self.at - 3 * MIN)
        self.assertEqual(self.feed({"policy": "priority_v2", "source_licenses": {}}).priority_at(self.at)["status"], "none")
        self.assertTrue(self.feed({"policy": "priority_v2", "source_licenses": {}}).priority_rejections)

    def test_conflicting_fresh_news_blocks_a_new_direction(self):
        seed(self.store, 1, self.at - 6 * MIN, self.at - 5 * MIN, self.at - 4 * MIN, direction="bearish")
        seed(self.store, 2, self.at - 3 * MIN, self.at - 2 * MIN, self.at - MIN, direction="bullish",
             title="Federal Reserve confirms emergency liquidity programme")
        self.assertEqual(self.feed().priority_at(self.at)["status"], "conflict")

    def test_syndicated_titles_have_one_causal_event_identity(self):
        seed(self.store, 1, self.at - 6 * MIN, self.at - 5 * MIN, self.at - 4 * MIN)
        first = self.feed().priority_at(self.at - 3 * MIN)["signal"]["event_id"]
        seed(self.store, 2, self.at - 2 * MIN, self.at - MIN, self.at)
        signal = self.feed().priority_at(self.at)["signal"]
        self.assertEqual(first, signal["event_id"])
        self.assertEqual(len(signal["item_hashes"]), 2)

    def test_a_malformed_url_is_rejected_without_discarding_other_news(self):
        seed(self.store, 1, self.at - 5 * MIN, self.at - 4 * MIN, self.at - 3 * MIN, url="https://[")
        seed(self.store, 2, self.at - 5 * MIN, self.at - 4 * MIN, self.at - 3 * MIN)
        feed = self.feed()
        self.assertEqual(feed.priority_at(self.at)["status"], "signal")
        self.assertEqual(feed.priority_rejections[0]["reason"], "invalid_source_url")

    def test_disappearing_database_clears_all_cached_evidence(self):
        seed(self.store, 1, self.at - 5 * MIN, self.at - 4 * MIN, self.at - 3 * MIN)
        seed(self.store, 2, self.at - 5 * MIN, self.at - 4 * MIN, self.at - 3 * MIN, relevance="medium")
        feed = self.feed()
        self.assertTrue(feed.priority_events)
        self.assertTrue(feed.priority_rejections)
        with mock.patch.object(news.os.path, "isfile", return_value=False):
            self.assertFalse(feed.reload())
        self.assertEqual(feed.priority_events, [])
        self.assertEqual(feed.priority_rejections, [])
        self.assertEqual(feed.priority_at(self.at)["status"], "unavailable")
        self.assertTrue(feed.last_error)

    def test_rejection_diagnostics_do_not_reveal_future_analyses(self):
        seed(self.store, 1, self.at - 5 * MIN, self.at - 4 * MIN, self.at + MIN, relevance="medium")
        feed = self.feed()
        self.assertEqual(feed.priority_at(self.at)["rejections"], [])
        self.assertTrue(feed.priority_at(self.at + MIN)["rejections"])


class NewsExecutionTests(unittest.TestCase):
    def env(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg.update(cuenta="entera", notional_usd="1000", products=["PF_ETHUSD"], opinion_enabled=False)
        cfg["noticias"] = dict(POLICY, version=2)
        folder = self.enterContext(tempfile.TemporaryDirectory())
        path = os.path.join(folder, "news.sqlite")
        cfg["news_db"] = path
        store = news_mod.NewsStore(path, news_mod.NEWS_CONFIG)
        self.addCleanup(store.close)
        env = make(self, cfg=cfg, db=folder, policy=Policy(flat="ESPERAR"), formula=True, now=BASE + 5 * MIN + 5_000)
        return env, store

    def test_news_opens_without_maestro_and_does_not_call_qwen_on_candles(self):
        env, store = self.env()
        at = BASE + 10 * MIN
        seed(store, 1, at - 5 * MIN, at - 4 * MIN, at - 3 * MIN)
        with mock.patch.object(env.provider, "health", side_effect=AssertionError("candle model dependency")):
            env.op.start()
            env.advance(5)
        row = env.rows("SELECT * FROM trades WHERE status='open'")[0]
        self.assertEqual(row["side"], "SHORT")
        self.assertEqual(row["entry_reason"], "noticias")
        self.assertEqual(row["max_hold_ms"], 24 * HOUR)
        self.assertLessEqual(float(row["notional_usd"]), 1000)
        self.assertEqual(env.provider.calls, 0)
        self.assertFalse(any("Qwen opina" in line for line in env.logs))

    def test_ethereum_news_cannot_be_applied_to_another_product(self):
        env, _ = self.env()
        cfg = copy.deepcopy(env.cfg)
        cfg["products"] = ["PF_XBTUSD"]
        with self.assertRaises(qt.TraderError):
            env.op.__class__(cfg, env.store, env.feed, env.provider)

    def test_same_direction_news_never_pyramids_or_restarts_the_24_hour_clock(self):
        env, store = self.env()
        env.op.start()
        seed(store, 1, BASE + 5 * MIN, BASE + 6 * MIN, BASE + 7 * MIN, direction="bullish")
        env.advance(5)
        before = env.rows("SELECT qty,entry_ms,max_hold_ms FROM trades")[0]
        seed(store, 2, BASE + 15 * MIN, BASE + 16 * MIN, BASE + 17 * MIN, direction="bullish",
             title="Federal Reserve confirms emergency liquidity programme")
        env.advance(15)
        self.assertEqual(env.rows("SELECT qty,entry_ms,max_hold_ms FROM trades"), [before])
        self.assertEqual(len(env.rows("SELECT * FROM news_actions")), 2)

    def test_rejected_reopening_still_persists_the_close_and_consumes_the_event(self):
        env, store = self.env()
        env.op.start()
        seed(store, 1, BASE + 5 * MIN, BASE + 6 * MIN, BASE + 7 * MIN)
        env.advance(5)
        seed(store, 2, BASE + 15 * MIN, BASE + 16 * MIN, BASE + 17 * MIN, direction="bullish",
             title="Federal Reserve confirms emergency liquidity programme")
        for bar in env.candles["PF_ETHUSD"]:
            if bar["bucket_start"] == BASE + 15 * MIN:
                bar.update(close="250", high="250")
        env.advance(10)
        trades = env.rows("SELECT status,side,net_usd FROM trades")
        self.assertEqual([(t["status"], t["side"]) for t in trades], [("closed", "SHORT")])
        self.assertLess(D(trades[0]["net_usd"]), -D("1000"))
        self.assertEqual(len(env.rows("SELECT * FROM news_actions")), 2)
        self.assertTrue(env.rows("SELECT * FROM decisions WHERE action='CERRAR' AND override='saldo_insuficiente'"))

    def test_opposite_news_closes_then_opens_and_restart_does_not_repeat_event(self):
        env, store = self.env()
        env.op.start()
        seed(store, 1, BASE + 5 * MIN, BASE + 6 * MIN, BASE + 7 * MIN, direction="bullish")
        env.advance(5)
        seed(store, 2, BASE + 15 * MIN, BASE + 16 * MIN, BASE + 17 * MIN, direction="bearish",
             title="Federal Reserve announces unexpected restrictive policy")
        env.advance(10)
        trades = env.rows("SELECT * FROM trades ORDER BY trade_no")
        self.assertEqual([(t["status"], t["side"]) for t in trades], [("closed", "LONG"), ("open", "SHORT")])
        self.assertEqual(trades[0]["exit_ms"], trades[1]["entry_ms"])
        balance = D("1000") + D(trades[0]["net_usd"])
        self.assertLessEqual(D(trades[1]["notional_usd"]) * (1 + qt.fee_rate()), balance)
        before = [(t["trade_no"], t["qty"], t["entry_ms"]) for t in trades]
        env.restart().start()
        self.addCleanup(env.store.close)
        env.advance(5)
        after = env.rows("SELECT * FROM trades ORDER BY trade_no")
        self.assertEqual([(t["trade_no"], t["qty"], t["entry_ms"]) for t in after], before)
        self.assertEqual(len(env.rows("SELECT * FROM news_actions")), 2)

    def test_news_position_ignores_rebound_master_but_closes_after_24_hours(self):
        env, store = self.env()
        env.op.start()
        seed(store, 1, BASE + 5 * MIN, BASE + 6 * MIN, BASE + 7 * MIN, direction="bullish")
        env.advance(5)
        with mock.patch.object(sheet, "readings", side_effect=AssertionError("news exits depend on candle experts")) as experts:
            env.advance(60)
            self.assertEqual(len(env.rows("SELECT * FROM trades WHERE status='open'")), 1)
            self.assertTrue(env.rows("SELECT * FROM decisions WHERE action='MANTENER' AND t_ms>=?", BASE + 45 * MIN))
            env.advance(23 * 60)
            experts.assert_not_called()
        rows = env.rows("SELECT * FROM trades")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "closed")
        self.assertEqual(rows[0]["hold_min"], 1440)
        self.assertEqual(env.provider.calls, 0)

    def test_coordinator_does_not_invent_an_independent_keepers_vote(self):
        env, _ = self.env()
        strong_legacy = reading()
        with mock.patch.object(sheet, "readings", return_value=strong_legacy):
            env.op.start()
            env.advance(30)
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertTrue(env.rows("SELECT * FROM decisions"))
        self.assertTrue(all(r["action"] == "ESPERAR" for r in env.rows("SELECT * FROM decisions")))

    def test_missing_autonomous_model_never_queries_or_displays_the_legacy_gate(self):
        env, _ = self.env()
        with mock.patch.object(sheet.portero, "verdict", side_effect=AssertionError("legacy prediction dependency")):
            env.op.start()
            env.advance(15)
        decisions = env.rows("SELECT formula_json,state_text FROM decisions")
        self.assertTrue(decisions)
        for row in decisions:
            formula = json.loads(row["formula_json"])
            self.assertIsNone(formula["portero_si"])
            self.assertIsNone(formula["portero_p"])
            self.assertIn("sin modelo", row["state_text"])

    def test_experts_must_agree_without_news(self):
        for gate_side, expected in ((-1, 0), (0, 0), (1, 1)):
            env, _ = self.env()
            facts = reading(portero_si=gate_side != 0, portero_direccion=gate_side)
            with mock.patch.object(sheet, "readings", return_value=facts):
                env.op.start()
                env.advance(15)
            self.assertEqual(len(env.rows("SELECT * FROM trades WHERE status='open'")), expected)

    def test_late_news_candle_cannot_open_an_operation(self):
        env, store = self.env()
        env.op.start()
        seed(store, 1, BASE + 5 * MIN, BASE + 6 * MIN, BASE + 7 * MIN)
        env.now[0] += 20 * MIN
        env.op.poll()
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertTrue(env.rows("SELECT * FROM skipped WHERE reason='proceso_detenido'"))

    def test_news_execution_uses_the_exact_15_second_candle_tolerance(self):
        for lateness, expected in ((15_000, 1), (15_001, 0)):
            with self.subTest(lateness=lateness):
                env, store = self.env()
                self.assertLessEqual(env.op.poll_s, 5)
                env.op.start()
                seed(store, 1, BASE + 5 * MIN, BASE + 6 * MIN, BASE + 7 * MIN)
                env.now[0] = BASE + 10 * MIN + lateness
                env.op.poll()
                self.assertEqual(len(env.rows("SELECT * FROM trades")), expected)

    def test_execution_lateness_is_checked_again_immediately_before_opening(self):
        env, store = self.env()
        env.op.start()
        seed(store, 1, BASE + 5 * MIN, BASE + 6 * MIN, BASE + 7 * MIN)
        trader = env.op.traders["PF_ETHUSD"]
        original = trader._open

        def delayed(*args, **kwargs):
            env.now[0] += 15_000
            return original(*args, **kwargs)

        with mock.patch.object(trader, "_open", side_effect=delayed):
            env.advance(5)
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertTrue(env.rows("SELECT * FROM decisions WHERE override='proceso_detenido'"))

    def test_receipt_records_actual_completion_time_not_the_start_of_the_poll(self):
        env, store = self.env()
        env.op.start()
        seed(store, 1, BASE + 5 * MIN, BASE + 6 * MIN, BASE + 7 * MIN)
        trader = env.op.traders["PF_ETHUSD"]
        original = trader._open

        def delayed(*args, **kwargs):
            env.now[0] += 10_000
            return original(*args, **kwargs)

        with mock.patch.object(trader, "_open", side_effect=delayed):
            env.advance(5)
        self.assertEqual(env.rows("SELECT opened_at_ms FROM trades"), [{"opened_at_ms": env.now[0]}])
        self.assertEqual(env.rows("SELECT decided_at_ms FROM decisions"), [{"decided_at_ms": env.now[0]}])
        self.assertEqual(env.rows("SELECT consumed_ms FROM news_actions"), [{"consumed_ms": env.now[0]}])

    def test_news_that_expires_during_execution_cannot_open(self):
        env, store = self.env()
        env.op.start()
        published = BASE - 5 * MIN + 10_000
        seed(store, 1, published, published + 1000, BASE + 7 * MIN)
        trader = env.op.traders["PF_ETHUSD"]
        original = trader._open

        def delayed(*args, **kwargs):
            env.now[0] += 10_000
            return original(*args, **kwargs)

        with mock.patch.object(trader, "_open", side_effect=delayed):
            env.advance(5)
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertTrue(env.rows("SELECT * FROM decisions WHERE override='noticia_vencida'"))

    def test_expired_opposite_news_cannot_close_a_position(self):
        env, store = self.env()
        env.op.start()
        seed(store, 1, BASE + 5 * MIN, BASE + 6 * MIN, BASE + 7 * MIN, direction="bullish")
        env.advance(5)
        before = env.rows("SELECT qty,entry_ms,status FROM trades")[0]
        published = BASE + 5 * MIN + 10_000
        seed(store, 2, published, published + 1000, BASE + 17 * MIN,
             title="Federal Reserve announces unexpected restrictive policy")
        env.now[0] = BASE + 20 * MIN + 15_000
        env.op.poll()
        self.assertEqual(env.rows("SELECT qty,entry_ms,status FROM trades"), [before])
        self.assertTrue(env.rows("SELECT * FROM decisions WHERE override='noticia_vencida'"))

    def test_failed_write_rolls_back_both_trade_and_news_consumption(self):
        env, store = self.env()
        env.op.start()
        seed(store, 1, BASE + 5 * MIN, BASE + 6 * MIN, BASE + 7 * MIN)
        original = env.store.save_state
        failed = []

        def fail_once(*args):
            if not failed:
                failed.append(True)
                raise RuntimeError("synthetic transaction failure")
            return original(*args)

        with mock.patch.object(env.store, "save_state", side_effect=fail_once):
            env.advance(5)
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertEqual(env.rows("SELECT * FROM news_actions"), [])
        env.op.poll()
        self.assertEqual(len(env.rows("SELECT * FROM trades")), 1)
        self.assertEqual(len(env.rows("SELECT * FROM news_actions")), 1)


if __name__ == "__main__":
    unittest.main()
