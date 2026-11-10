"""Card-only configuration of the news process (T14 of ``odd/tasks/noticias-y-auditor.md``, S7): with the card on,
the two old questions (``news_relevance_btc`` v2, ``news_direction`` v2) and the scope question can be switched off
(``NEWS_LEGACY_QUESTIONS=0``, ``NEWS_CARD_SCOPE=0``). Defaults stay as they were. Also: what every reader of the
stored answers (``NewsFeed``/``priority_v2``, ``news_features``) does when the old rows are absent."""
import contextlib
import io
import json
import os
import sqlite3
import time
import unittest
from unittest import mock

from balancita_engine import futures_llm_decisions as q
from balancita_engine import futures_news as n
from balancita_engine import futures_qwen_noticias as noticias
from test_futures_llm_decisions import FakeLlama
from test_futures_news import MINUTE, NOW, SRC_A, FeedServer, ServiceBase, TempDirTest, fresh_item, rss
from test_futures_news_card import (CARD_QUESTIONS, asked_cards, card, card_reply, cards_script)

OLD_IDS = ("news_relevance_btc", "news_direction")
CARD_ONLY = dict(cards=True, legacy_questions=False, card_scope=False)


class CardOnlyRuleTests(unittest.TestCase):
    """Without the scope question nobody says whether the event already happened (``scope_known=False``)."""

    def rules(self, title, summary="", **extra):
        return noticias.apply_card_rules(card(already_happened=None, scope=None, **extra), title, summary,
                                         scope_known=False)

    def test_a_big_hack_gets_strength_two_under_its_own_rule_name(self):
        out = self.rules("Exchange hacked for $6.3 billion", event_type="hack", strength=1)
        self.assertEqual((out["strength"], out["strength_model"], out["rules"], out["amount_usd"]),
                         (2, 1, ["hack_100m_unconfirmed"], 6.3e9))

    def test_a_hack_typed_as_something_else_still_triggers_by_its_headline(self):
        out = self.rules("Binance hit by record $6.3 billion hack, withdrawals frozen", event_type="network_outage",
                         strength=1)
        self.assertEqual((out["strength"], out["rules"]), (2, ["hack_100m_unconfirmed"]))

    def test_amount_and_strength_limits_are_the_same_as_with_the_scope(self):
        self.assertEqual(self.rules("Exchange hacked for $99.9 million", event_type="hack", strength=1)["rules"], [])
        self.assertEqual(self.rules("Exchange hacked for $6.3 billion", event_type="hack", strength=3)["rules"], [])
        self.assertEqual(self.rules("Spot Ether ETFs log $900 million of outflows", event_type="etf_flows",
                                    strength=1)["rules"], [])

    def test_a_recap_or_an_opinion_is_not_taken_as_an_event_that_happened(self):
        for kind in ("price_recap", "opinion"):
            out = self.rules("Analyst: Binance hack of $6.3 billion could hit ETH", event_type=kind, strength=1)
            self.assertEqual((out["strength"], out["rules"]), (1 if kind == "opinion" else 0,
                                                                [] if kind == "opinion" else ["recap"]), kind)

    def test_the_recap_rule_is_the_same(self):
        out = self.rules("Live updates: Ether drops 3% to $3,300", event_type="macro_fed", strength=2,
                         direction="bearish")
        self.assertEqual((out["strength"], out["direction"], out["rules"]), (0, "neutral", ["recap"]))

    def test_with_the_scope_known_nothing_changed(self):
        # Same call as before the option existed: an explicit "not happened" still blocks the rule.
        out = noticias.apply_card_rules(card(event_type="hack", strength=1, already_happened=False),
                                        "Exchange could be hacked for $500 million, report warns", "")
        self.assertEqual((out["strength"], out["rules"]), (1, []))
        out = noticias.apply_card_rules(card(event_type="hack", strength=1, already_happened=None),
                                        "Exchange hacked for $500 million", "")
        self.assertEqual((out["strength"], out["rules"]), (1, []))


class CardOnlyServiceTests(ServiceBase):
    def provider(self, **picks):
        return q.FakeProvider(entries=cards_script(**picks))

    def cards(self, where=""):
        return self.rows("paper_futures_news_cards", where)

    def test_card_only_asks_type_strength_and_direction_and_none_of_the_old_questions(self):
        provider = self.provider()
        result = self.service(provider=provider, **CARD_ONLY).poll()
        self.assertEqual(provider.calls, 3 * 2)
        self.assertEqual(sorted(asked_cards(provider)), sorted(["news_card_type", "news_card_strength",
                                                                "news_card_direction"] * 2))
        self.assertEqual({r["question_id"] for r in self.analysis()},
                         {"news_card_type", "news_card_strength", "news_card_direction"})
        self.assertEqual((result["analyzed"], result["cards"], result["skipped_stale"]), (0, 2, 0))

    def test_the_card_has_no_scope_and_says_which_questions_made_it(self):
        self.service(provider=self.provider(news_card_direction="bearish", news_card_strength="significant"),
                     **CARD_ONLY).poll()
        [first, _] = self.cards("ORDER BY card_id")
        self.assertEqual((first["status"], first["card_version"], first["event_type"], first["direction"],
                          first["strength"], first["strength_model"]), ("done", 1, "other", "bearish", 2, 2))
        self.assertEqual((first["scope"], first["already_happened"]), (None, None))
        self.assertEqual(json.loads(first["questions_json"]),
                         ["news_card_type@1", "news_card_strength@1", "news_card_direction@1"])
        self.assertAlmostEqual(first["strength_value"], 0.06 / 3 * (0 + 1 + 3) + 0.94 * 2, places=6)

    def test_a_price_recap_answer_still_stops_after_the_first_question(self):
        provider = self.provider(news_card_type="price_recap", news_card_strength="significant")
        self.service(provider=provider, **CARD_ONLY).poll()
        self.assertEqual(asked_cards(provider), ["news_card_type"] * 2)
        [card_row, _] = self.cards("ORDER BY card_id")
        self.assertEqual((card_row["strength"], card_row["direction"], card_row["scope"]), (0, "neutral", None))

    def test_the_hack_rule_works_without_the_scope_and_records_that_it_assumed_the_event_happened(self):
        self.fetcher.bodies[SRC_A["url"]] = rss([fresh_item(
            1, title="Binance hit by record $6.3 billion hack, withdrawals frozen", desc="crypto exchange")])
        provider = self.provider(news_card_type="network_outage", news_card_direction="bearish")
        self.service(provider=provider, **CARD_ONLY).poll()
        [row] = self.cards()
        self.assertEqual((row["strength"], row["strength_model"], row["amount_usd"], row["already_happened"]),
                         (2, 1, 6.3e9, None))
        self.assertEqual(json.loads(row["rules_json"]), ["hack_100m_unconfirmed"])

    def test_a_recap_headline_and_stale_items_are_resolved_without_the_model_as_before(self):
        self.fetcher.bodies[SRC_A["url"]] = rss([
            fresh_item(1, title="ETH surges above $3,000 as price rallies"),
            fresh_item(2, title="Bitcoin miners increase hashrate after halving", desc="Satoshi era blocks"),
        ])
        provider = self.provider()
        result = self.service(provider=provider, **CARD_ONLY).poll()
        self.assertEqual((provider.calls, result["cards"]), (0, 1))
        self.assertEqual(sorted(r["status"] for r in self.cards()), ["done", "skipped_stale"])

    def test_the_cascade_resumes_without_the_scope_and_never_asks_twice(self):
        self.fetcher.bodies[SRC_A["url"]] = rss([fresh_item(1)])
        provider = self.provider()
        service = self.service(provider=provider, max_analyses_per_poll=2, **CARD_ONLY)
        self.assertEqual(service.poll()["cards"], 0)
        self.clock.now += MINUTE
        self.assertEqual(service.poll()["cards"], 1)
        self.assertEqual(asked_cards(provider), ["news_card_type", "news_card_strength", "news_card_direction"])

    def test_only_the_legacy_questions_off_keeps_the_scope_and_only_the_scope_off_keeps_the_legacy_questions(self):
        provider = self.provider()
        self.service(provider=provider, cards=True, legacy_questions=False).poll()
        self.assertEqual(provider.calls, 4 * 2)
        self.assertFalse({r["question_id"] for r in self.analysis()} & set(OLD_IDS))
        [first, _] = self.cards("ORDER BY card_id")
        self.assertEqual((first["scope"], first["already_happened"]), ("crypto", 1))

    def test_scope_off_with_the_legacy_questions_on_asks_the_two_old_ones_and_three_card_questions(self):
        provider = self.provider()
        self.service(provider=provider, cards=True, card_scope=False).poll()
        self.assertEqual(provider.calls, (2 + 3) * 2)
        self.assertEqual(len([r for r in self.analysis() if r["question_id"] in OLD_IDS]), 4)

    def test_legacy_questions_off_without_cards_is_a_configuration_error_when_a_model_is_given(self):
        with self.assertRaises(ValueError):
            self.service(provider=self.provider(), legacy_questions=False)
        self.service(provider=None, legacy_questions=False).poll()        # ingest only: nothing to ask, no error

    def test_the_defaults_are_the_old_behaviour(self):
        provider = self.provider()
        service = self.service(provider=provider, cards=True)
        self.assertEqual((sorted(service.questions), service.card_scope), (sorted(OLD_IDS), True))
        service.poll()
        self.assertEqual(provider.calls, (2 + 4) * 2)

    def test_card_only_rows_are_the_same_rows_the_full_card_wrote_for_the_shared_questions(self):
        full = self.service(provider=self.provider(), cards=True)
        full.poll()
        shared = ("news_card_type", "news_card_strength", "news_card_direction")
        key = lambda rows: sorted((r["item_hash"], r["question_id"], r["chosen"], r["probabilities_json"])
                                  for r in rows if r["question_id"] in shared)
        full_rows = key(self.analysis())
        self.tearDown()
        self.setUp()
        self.service(provider=self.provider(), **CARD_ONLY).poll()
        self.assertEqual(key(self.analysis()), full_rows)


class CardOnlyCliTests(TempDirTest):
    def setUp(self):
        super().setUp()
        self.server = FeedServer()
        self.addCleanup(self.server.stop)
        self.sources = os.path.join(self.dir, "sources.json")
        with open(self.sources, "w") as handle:
            json.dump({"sources": [{"id": "local", "name": "Local", "url": self.server.url}]}, handle)

    def run_main(self, *argv, env=None):
        out = io.StringIO()
        # The model path is what these tests are about: the default engine is the rules one (S10).
        with mock.patch.dict(os.environ, dict({"NEWS_ENGINE": "qwen"}, **(env or {}))), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(out):
            for name in ("NEWS_CARDS", "NEWS_LEGACY_QUESTIONS", "NEWS_CARD_SCOPE", "NEWS_ANALYSIS"):
                if name not in (env or {}):
                    os.environ.pop(name, None)
            code = n.main(list(argv))
        return code, out.getvalue()

    def run_news(self, *flags, env=None):
        self.server.body = rss([fresh_item(1, now=int(time.time() * 1000), minutes_ago=1,
                                          title="Ethereum protocol update")])
        server = FakeLlama()
        self.addCleanup(server.stop)
        server.pick = card_reply
        code, out = self.run_main("--once", "--news-db", self.path, "--sources-file", self.sources,
                                  "--llama-url", server.url, "--no-briefing", *flags, env=env)
        db = sqlite3.connect(self.path)
        asked = [r[0] for r in db.execute("SELECT question_id FROM paper_futures_news_analysis ORDER BY analysis_id")]
        card = db.execute("SELECT scope, questions_json FROM paper_futures_news_cards").fetchall()
        db.close()
        return code, out, asked, card, len(server.completions())

    def test_the_env_vars_give_the_card_only_mode(self):
        env = {"NEWS_ANALYSIS": "1", "NEWS_CARDS": "1", "NEWS_LEGACY_QUESTIONS": "0", "NEWS_CARD_SCOPE": "0"}
        code, out, asked, cards, calls = self.run_news(env=env)
        self.assertEqual((code, calls), (0, 3))
        self.assertEqual(asked, ["news_card_type", "news_card_strength", "news_card_direction"])
        self.assertEqual(cards, [(None, '["news_card_type@1","news_card_strength@1","news_card_direction@1"]')])
        self.assertIn("cards 1", out)

    def test_the_flags_give_the_card_only_mode(self):
        code, _, asked, cards, calls = self.run_news("--analyze", "--cards", "--no-legacy-questions",
                                                     "--no-card-scope")
        self.assertEqual((code, calls, len(cards)), (0, 3, 1))
        self.assertFalse(set(asked) & set(OLD_IDS))

    def test_off_spellings_and_empty_values_keep_the_default(self):
        for value in ("false", "off", "no", " 0 "):
            self.tearDown()
            self.setUp()
            _, _, asked, _, calls = self.run_news(env={"NEWS_ANALYSIS": "1", "NEWS_CARDS": "1",
                                                       "NEWS_LEGACY_QUESTIONS": value, "NEWS_CARD_SCOPE": value})
            self.assertEqual(calls, 3, value)
        for value in ("", "1", "true"):
            self.tearDown()
            self.setUp()
            _, _, asked, _, calls = self.run_news(env={"NEWS_ANALYSIS": "1", "NEWS_CARDS": "1",
                                                       "NEWS_LEGACY_QUESTIONS": value, "NEWS_CARD_SCOPE": value})
            self.assertEqual(calls, 6, value)

    def test_without_the_new_options_the_cards_run_is_what_it_was(self):
        code, _, asked, cards, calls = self.run_news("--analyze", "--cards")
        self.assertEqual((code, calls, len(cards)), (0, 6, 1))
        self.assertEqual(cards[0][0], "eth")

    def test_the_old_questions_off_without_the_cards_is_refused_before_anything_is_asked(self):
        code, out, asked, cards, calls = self.run_news("--analyze", "--no-legacy-questions")
        self.assertEqual((code, calls), (2, 0))
        self.assertIn("configuration error", out)
        self.assertIn("cards", out)

    def test_the_new_options_without_analysis_do_nothing(self):
        code, _, asked, cards, calls = self.run_news("--no-legacy-questions", "--no-card-scope")
        self.assertEqual((code, calls), (0, 0))


def seed_item(store, ident, title="Ethereum protocol update", published=NOW - 2 * MINUTE, received=NOW - MINUTE,
              source_id="fed"):
    url = "https://www.federalreserve.gov/newsevents/{}.htm".format(ident)
    hash_ = n.item_hash(url, title)
    store.add_item({"item_hash": hash_, "source_id": source_id, "source": "Federal Reserve", "url": url,
                    "title": title, "summary": "Official statement.", "published_at": published,
                    "received_at": received, "content_hash": n.text_hash(title)})
    return hash_


def seed_card(store, hash_, strength=3, direction="bearish", status="done", at=NOW, **extra):
    row = {"item_hash": hash_, "card_version": 1, "status": status, "written_at": at}
    if status == "done":
        row.update(event_type="macro_fed", scope=None, direction=direction, strength=strength,
                   strength_model=strength, strength_value=float(strength), already_happened=None,
                   amount_usd=None, rules=[], questions=["news_card_type@1"])
    row.update(extra)
    store.append_card(row)


class ReadersWithoutTheOldRowsTests(TempDirTest):
    """The consumers of the stored answers when only cards exist: nothing breaks and nothing is invented."""

    def setUp(self):
        super().setUp()
        self.store = n.NewsStore(self.path, n.NEWS_CONFIG)
        self.addCleanup(self.store.close)
        self.hash = seed_item(self.store, 1)
        seed_card(self.store, self.hash)
        self.policy = {"policy": "priority_v2", "source_licenses": {"fed": {
            "status": "public_domain", "url": "https://www.federalreserve.gov/disclaimer.htm",
            "host": "federalreserve.gov"}}}

    def test_priority_v2_stays_inert_a_strong_card_is_not_a_trading_signal(self):
        feed = noticias.NewsFeed(self.path, priority_policy=self.policy)
        self.assertTrue(feed.available)
        self.assertEqual((feed.priority_events, feed.priority_rejections), ([], []))
        self.assertEqual(feed.priority_at(NOW + MINUTE), {"status": "none", "rejections": []})
        view = feed.lifecycle_at(NOW + MINUTE)
        self.assertEqual((view["policy"], view["status"], view["items"]), ("priority_v2", "none", {}))

    def test_the_legacy_enabler_has_no_events_and_says_no(self):
        feed = noticias.NewsFeed(self.path)
        self.assertTrue(feed.available)
        self.assertEqual(feed.events, [])
        ok, detail = noticias.verdict(feed, NOW + MINUTE, 1)
        self.assertEqual((ok, detail["disponible"], detail["n"], detail["a_favor"]), (False, True, 0, False))

    def test_news_features_are_empty_and_do_not_fail(self):
        out = n.news_features_at(self.path, NOW + MINUTE)
        self.assertEqual([out["windows"][w]["items"] for w in ("1h", "4h")], [0, 0])

    def test_old_rows_present_for_an_item_still_drive_the_trader_readers_as_before(self):
        seed_old_answers(self.store, self.hash, relevance="high", direction="bearish")
        feed = noticias.NewsFeed(self.path, priority_policy=self.policy)
        self.assertEqual(len(feed.priority_events), 1)
        self.assertEqual(feed.priority_at(NOW + 2 * MINUTE)["status"], "signal")


def seed_old_answers(store, hash_, relevance="high", direction="bearish", analyzed=NOW):
    for qid, chosen, options in (("news_relevance_btc", relevance, ("none", "low", "medium", "high")),
                                 ("news_direction", direction, ("bullish", "bearish", "neutral"))):
        probs = {key: 0.9 if key == chosen else 0.1 / (len(options) - 1) for key in options}
        store.append_analysis({
            "item_hash": hash_, "question_id": qid, "question_version": 2, "status": "done",
            "analyzed_at": analyzed, "question_type": "choice", "model_ref": "local-test", "prompt_hash": "t",
            "prompt_version": 2, "probability_source": "logprobs", "probabilities": probs, "temperature": 1.0,
            "chosen": chosen, "value": None, "confidence": 0.9, "latency_ms": 1})


if __name__ == "__main__":
    unittest.main()
