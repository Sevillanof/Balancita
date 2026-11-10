"""The news process with the rules engine (S10, T18): every item gets a card at ingestion, instantly, with no model and no
llama-server; the Qwen cascade and the Qwen briefing are off; old Qwen cards stay readable."""
import contextlib
import io
import json
import os
import sqlite3
import time
import unittest
from unittest import mock

from balancita_engine import futures_news as n
from balancita_engine import futures_news_reglas as reglas
from test_futures_llm_decisions import FakeLlama
from test_futures_news import (NOW, SRC_A, FakeFetcher, FeedServer, ServiceBase, TempDirTest, fresh_item, llama_reply,
                               rfc822, rss)

HACK = fresh_item(1, title="Binance hit by record $6.3 billion hack, withdrawals frozen",
                  desc="Attackers drained roughly $6.3 billion from hot wallets.")
RECAP = fresh_item(2, title="Ether slips 2% to $3,400 as traders await Fed decision")
PLAIN = fresh_item(3, title="Coinbase adds a dark mode toggle to its mobile app")


class RaisingProvider:
    """A model that must never be touched."""

    def __init__(self):
        self.calls = []

    def health(self):
        self.calls.append("health")
        raise AssertionError("the rules engine must not ask a model")

    identity = chat = health


class RulesServiceTests(ServiceBase):
    def setUp(self):
        super().setUp()
        self.fetcher = FakeFetcher({SRC_A["url"]: rss([HACK, RECAP, PLAIN])})

    def cards(self, where=""):
        return self.rows("paper_futures_news_cards", where)

    def test_every_new_item_gets_a_done_card_of_version_3_with_no_model_at_all(self):
        service = self.service(engine="reglas")
        result = service.poll()
        self.assertEqual((result["ingested"], result["cards"], result["analyzed"]), (3, 3, 0))
        cards = {row["item_hash"]: row for row in self.cards()}
        self.assertEqual(len(cards), 3)
        for row in cards.values():
            self.assertEqual((row["card_version"], row["status"]), (n.CARD_VERSION_REGLAS, "done"))
            self.assertEqual(json.loads(row["questions_json"]),
                             ["engine:reglas", "lexicon:" + reglas.load_lexicon().version])
            self.assertIsNone(row["scope"])
            self.assertIsNone(row["already_happened"])
        by_title = {item["title"]: cards[item["item_hash"]]
                    for item in map(dict, self.rows("paper_futures_news_items"))}
        hack = by_title[HACK["title"]]
        self.assertEqual((hack["event_type"], hack["direction"], hack["strength"], hack["strength_model"]),
                         ("hack", "bearish", 3, 3))
        self.assertEqual(hack["amount_usd"], 6.3e9)
        self.assertEqual(json.loads(hack["rules_json"]), ["hack_100m", "hack_1b", "hack_withdrawals_halted"])
        recap = by_title[RECAP["title"]]
        self.assertEqual((recap["event_type"], recap["direction"], recap["strength"]), ("price_recap", "neutral", 0))
        self.assertEqual(json.loads(recap["rules_json"]), ["recap"])
        plain = by_title[PLAIN["title"]]
        self.assertEqual((plain["strength"], plain["direction"]), (0, "neutral"))

    def test_the_card_of_a_primary_source_item_keeps_the_strength_before_the_source_prior(self):
        source = {"id": "fed_monetary", "name": "Fed", "url": "https://fed.example/rss"}
        self.fetcher.bodies[source["url"]] = rss([fresh_item(9, title="Fed publishes minutes of its last meeting")])
        self.service(sources=[source], engine="reglas").poll()
        [row] = self.cards()
        self.assertEqual((row["strength"], row["strength_model"]), (2, 1))
        self.assertEqual(json.loads(row["rules_json"]), ["source_boost:fed_monetary"])

    def test_the_card_is_written_in_the_same_poll_that_ingests_the_item_and_only_once(self):
        service = self.service(engine="reglas")
        service.poll()
        self.clock.now += n.DEFAULT_INTERVAL_MS
        self.fetcher.bodies[SRC_A["url"]] = rss([HACK, RECAP, PLAIN, fresh_item(4, title="Fed holds rates steady")])
        result = service.poll()
        self.assertEqual((result["ingested"], result["cards"]), (1, 1))
        self.assertEqual(len(self.cards()), 4)
        self.assertEqual(service.poll()["cards"], 0)

    def test_no_model_is_ever_asked_even_if_one_is_given(self):
        provider = RaisingProvider()
        service = self.service(provider=provider, engine="reglas", cards=True, briefing_enabled=True)
        result = service.poll()
        service.briefing.drain()
        self.assertEqual(provider.calls, [])
        self.assertEqual((result["cards"], result["analyzed"], result["pending"]), (3, 0, 0))
        self.assertEqual(self.rows("paper_futures_news_analysis"), [])
        self.assertEqual(self.rows("paper_futures_news_errors"), [])
        self.assertFalse([line for line in self.logs if "error" in line or "model" in line])

    def test_old_qwen_cards_stay_and_the_new_version_does_not_replace_them(self):
        service = self.service(engine="reglas")
        service.store.add_item({"item_hash": "old", "source_id": "feed_a", "source": "Feed A", "url": "https://a.example/old",
                                "title": "Old item", "summary": "", "published_at": None, "received_at": NOW - 60_000,
                                "content_hash": "c"})
        service.store.append_card({"item_hash": "old", "card_version": n.CARD_VERSION, "status": "done",
                                   "written_at": NOW - 30_000, "event_type": "other", "direction": "neutral",
                                   "strength": 1, "strength_model": 1, "rules": [], "questions": ["q"]})
        service.poll()
        old = self.cards("WHERE item_hash='old' ORDER BY card_version")
        self.assertEqual([row["card_version"] for row in old], [n.CARD_VERSION, n.CARD_VERSION_REGLAS])
        self.assertEqual(old[0]["questions_json"], '["q"]')  # untouched (the table is append-only)

    def test_items_stored_before_the_engine_was_switched_on_get_their_card_at_the_next_start(self):
        self.service(engine="qwen").poll()
        self.assertEqual(self.cards(), [])
        self.clock.now += n.DEFAULT_INTERVAL_MS
        result = self.service(engine="reglas").poll()
        self.assertEqual(result["cards"], 3)

    def test_a_rule_that_fails_leaves_a_failed_card_and_does_not_stop_the_others(self):
        real = reglas.classify

        def flaky(title, summary="", source_id="", lexicon=None):
            if "dark mode" in title:
                raise RuntimeError("boom")
            return real(title, summary, source_id, lexicon=lexicon)

        with mock.patch.object(reglas, "classify", flaky):
            result = self.service(engine="reglas").poll()
        self.assertEqual(result["cards"], 2)
        self.assertEqual(sorted(row["status"] for row in self.cards()), ["done", "done", "failed"])
        self.assertTrue([line for line in self.logs if "boom" in line])

    def test_the_briefing_is_off_and_says_why(self):
        service = self.service(engine="reglas")
        service.poll()
        [row] = self.rows("paper_futures_news_briefings", "ORDER BY briefing_id DESC LIMIT 1")
        self.assertEqual((row["status"], row["reason"], row["text"]), ("off", n.REGLAS_BRIEFING_REASON, None))

    def test_an_unknown_engine_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            self.service(engine="gpt")
        self.assertIn("engine", str(caught.exception))

    def test_a_broken_lexicon_stops_the_start_instead_of_cataloguing_with_nothing(self):
        with mock.patch.object(reglas, "load_lexicon", side_effect=ValueError("types.hack: invalid pattern")):
            with self.assertRaises(ValueError):
                self.service(engine="reglas")


class RulesCliTests(TempDirTest):
    def setUp(self):
        super().setUp()
        self.server = FeedServer()
        self.addCleanup(self.server.stop)
        now = int(time.time() * 1000)
        self.server.body = rss([fresh_item(1, now=now, minutes_ago=1, title="Binance hit by $6.3 billion hack"),
                                fresh_item(2, now=now, minutes_ago=2, title="Ether slips 2% to $3,400 as traders wait")])
        self.sources = os.path.join(self.dir, "sources.json")
        with open(self.sources, "w") as handle:
            json.dump({"sources": [{"id": "local", "name": "Local", "url": self.server.url}]}, handle)

    def run_main(self, *argv, env=None):
        out = io.StringIO()
        with mock.patch.dict(os.environ, env or {}), contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            for name in ("NEWS_ENGINE", "NEWS_ANALYSIS", "NEWS_CARDS", "NEWS_LEGACY_QUESTIONS", "NEWS_CARD_SCOPE"):
                if name not in (env or {}):
                    os.environ.pop(name, None)
            code = n.main(["--once", "--news-db", self.path, "--sources-file", self.sources, *argv])
        return code, out.getvalue()

    def query(self, sql):
        db = sqlite3.connect(self.path)
        try:
            return db.execute(sql).fetchall()
        finally:
            db.close()

    def test_by_default_a_poll_without_llama_catalogues_every_item(self):
        code, out = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("cards 2", out)
        self.assertEqual(self.query("SELECT card_version, status, strength FROM paper_futures_news_cards ORDER BY strength"),
                         [(3, "done", 0), (3, "done", 3)])

    def test_analyze_with_the_rules_engine_never_contacts_the_model(self):
        server = FakeLlama()
        self.addCleanup(server.stop)
        server.pick = llama_reply
        code, out = self.run_main("--analyze", "--cards", "--llama-url", server.url)
        self.assertEqual(code, 0)
        self.assertEqual(server.completions(), [])
        self.assertIn("cards 2", out)
        self.assertEqual(self.query("SELECT COUNT(*) FROM paper_futures_news_analysis"), [(0,)])

    def test_a_dead_llama_port_does_not_matter(self):
        code, out = self.run_main("--analyze", "--llama-url", "http://127.0.0.1:9")
        self.assertEqual(code, 0)
        self.assertIn("cards 2", out)

    def test_the_qwen_engine_is_still_there_and_writes_no_rules_cards(self):
        code, _ = self.run_main(env={"NEWS_ENGINE": "qwen"})
        self.assertEqual(code, 0)
        self.assertEqual(self.query("SELECT COUNT(*) FROM paper_futures_news_cards"), [(0,)])

    def test_an_unknown_engine_is_a_configuration_error(self):
        code, out = self.run_main(env={"NEWS_ENGINE": "gpt"})
        self.assertEqual(code, 2)
        self.assertIn("configuration error", out)
        self.assertIn("NEWS_ENGINE", out)

    def test_the_engine_is_read_from_the_environment_case_insensitively_and_blank_means_the_default(self):
        self.assertEqual(n.news_engine({}), "reglas")
        self.assertEqual(n.news_engine({"NEWS_ENGINE": "  "}), "reglas")
        self.assertEqual(n.news_engine({"NEWS_ENGINE": "Qwen"}), "qwen")
        self.assertEqual(n.news_engine({"NEWS_ENGINE": "REGLAS"}), "reglas")


if __name__ == "__main__":
    unittest.main()
