"""Deterministic rules on top of the Qwen news-card answers (S7, T13): amounts parsed from the text, price recaps
get strength 0, hacks of at least 100 M US$ get strength >= 2. Also the card catalog (scope ``news_card``)."""
import contextlib
import io
import json
import math
import os
import sqlite3
import time
import unittest

from balancita_engine import futures_llm_decisions as q
from balancita_engine import futures_news as n
from balancita_engine import futures_qwen_noticias as noticias
from test_futures_llm_decisions import FakeLlama
from test_futures_news import (HOUR, MINUTE, NOW, SRC_A, FeedServer, ServiceBase, TempDirTest, fresh_item,
                               rss, scripted)

CARD = {"event_type": "other", "scope": "crypto", "direction": "neutral", "strength": 1, "already_happened": True}


def card(**extra):
    return dict(CARD, **extra)


class AmountTests(unittest.TestCase):
    def amount(self, title, summary=""):
        return noticias.parse_amount_usd(title, summary)

    def test_billions_millions_and_thousands_are_converted_to_dollars(self):
        self.assertEqual(self.amount("Hack drains $6.3 billion from exchange"), 6.3e9)
        self.assertEqual(self.amount("Fake Job Interview Opened Path to $6.34 Billion Hack"), 6.34e9)
        self.assertEqual(self.amount("Exploit takes $40M from lender"), 40e6)
        self.assertEqual(self.amount("Exploit takes $40 million from lender"), 40e6)
        self.assertEqual(self.amount("Thieves took $1.5bn"), 1.5e9)
        self.assertEqual(self.amount("MEXC cut off over $16B in transactions"), 16e9)
        self.assertEqual(self.amount("Fund buys $500K of ETH"), 500e3)
        self.assertEqual(self.amount("US$ 300 million deal"), 300e6)

    def test_amounts_written_in_words_with_dollars(self):
        self.assertEqual(self.amount("Attackers stole 133 million dollars"), 133e6)
        self.assertEqual(self.amount("About 1.4 billion US dollars drained"), 1.4e9)
        self.assertEqual(self.amount("Losses of 2 billion USD"), 2e9)

    def test_a_plain_dollar_figure_is_an_amount_of_that_size(self):
        self.assertEqual(self.amount("Ether trades at $3,000"), 3000.0)
        self.assertEqual(self.amount("12,224 ZEC stranded, worth $12,224.50"), 12224.5)

    def test_no_dollar_amount_means_none(self):
        self.assertIsNone(self.amount("Fed holds rates"))
        self.assertIsNone(self.amount("Bitcoin at 90k", "up 3% on the day"))
        self.assertIsNone(self.amount("Company buys 1.4 billion euros of ETH"))
        self.assertIsNone(self.amount("", ""))
        self.assertIsNone(self.amount(None, None))

    def test_the_title_wins_over_the_summary_and_the_largest_amount_of_the_text_is_taken(self):
        self.assertEqual(self.amount("Exploit takes $8 million", "Last year's $1 billion hack was larger"), 8e6)
        self.assertEqual(self.amount("Exploit takes $8 million and $30 million", ""), 30e6)
        self.assertEqual(self.amount("Exploit on lender", "The attacker took $90 million"), 90e6)


class RuleTests(unittest.TestCase):
    def rules(self, title, summary="", **extra):
        return noticias.apply_card_rules(card(**extra), title, summary)

    def test_a_price_recap_gets_strength_zero_and_neutral_direction(self):
        out = self.rules("Ether slips as stocks fall", event_type="price_recap", strength=2, direction="bearish")
        self.assertEqual((out["strength"], out["direction"], out["strength_model"]), (0, "neutral", 2))
        self.assertEqual(out["rules"], ["recap"])

    def test_a_recap_headline_is_a_recap_even_when_the_model_says_something_else(self):
        out = self.rules("Live updates: Ether drops 3% to $3,300", event_type="macro_fed", strength=1,
                         direction="bearish")
        self.assertEqual((out["strength"], out["direction"], out["rules"]), (0, "neutral", ["recap"]))

    def test_a_card_that_is_not_a_recap_is_left_alone(self):
        out = self.rules("Fed speaker repeats known guidance", event_type="macro_fed", strength=1, direction="bearish")
        self.assertEqual((out["strength"], out["direction"], out["rules"], out["amount_usd"]),
                         (1, "bearish", [], None))

    def test_an_opinion_keeps_the_strength_the_model_gave(self):
        out = self.rules("Analyst expects a rally", event_type="opinion", strength=1)
        self.assertEqual((out["strength"], out["rules"]), (1, []))

    def test_a_hack_of_100_million_or_more_gets_strength_two(self):
        out = self.rules("Exchange hacked for $100 million", event_type="hack", strength=1)
        self.assertEqual((out["strength"], out["strength_model"], out["rules"], out["amount_usd"]),
                         (2, 1, ["hack_100m"], 100e6))

    def test_just_under_100_million_does_not_trigger_the_hack_rule(self):
        out = self.rules("Exchange hacked for $99.9 million", event_type="hack", strength=1)
        self.assertEqual((out["strength"], out["rules"], out["amount_usd"]), (1, [], 99.9e6))
        out = self.rules("Lender exploited for $8 million", event_type="hack", strength=1)
        self.assertEqual((out["strength"], out["rules"]), (1, []))

    def test_the_hack_rule_never_lowers_a_strength_and_is_not_recorded_when_nothing_changes(self):
        out = self.rules("Exchange hacked for $6.3 billion", event_type="hack", strength=3)
        self.assertEqual((out["strength"], out["rules"]), (3, []))
        out = self.rules("Exchange hacked for $300 million", event_type="hack", strength=2)
        self.assertEqual((out["strength"], out["rules"]), (2, []))

    def test_a_hack_that_has_not_happened_does_not_trigger_the_rule(self):
        out = self.rules("Exchange could be hacked for $500 million, report warns", event_type="hack", strength=1,
                         already_happened=False)
        self.assertEqual((out["strength"], out["rules"]), (1, []))

    def test_a_hack_the_model_typed_as_something_else_still_triggers_by_its_headline(self):
        out = self.rules("Binance hit by record $6.3 billion hack, withdrawals frozen", event_type="network_outage",
                         strength=1)
        self.assertEqual((out["strength"], out["rules"]), (2, ["hack_100m"]))

    def test_a_big_amount_that_is_not_a_hack_does_not_trigger_the_rule(self):
        out = self.rules("Spot Ether ETFs log $900 million of outflows", event_type="etf_flows", strength=1)
        self.assertEqual((out["strength"], out["rules"], out["amount_usd"]), (1, [], 900e6))

    def test_a_big_hack_wins_over_the_recap_words_in_its_headline(self):
        out = self.rules("Binance hacked for $6.3 billion as ETH falls 5%", event_type="hack", strength=1)
        self.assertEqual((out["strength"], out["direction"]), (2, "neutral"))
        self.assertEqual(out["rules"], ["recap", "hack_100m"])

    def test_a_price_is_not_a_hack_amount(self):
        out = self.rules("Hack fears: Ether holds $3,000", event_type="hack", strength=1)
        self.assertEqual((out["strength"], out["amount_usd"]), (0, 3000.0))

    def test_the_input_card_is_not_modified_and_keeps_its_other_fields(self):
        original = card(event_type="hack", strength=1)
        out = noticias.apply_card_rules(original, "Exchange hacked for $200 million", "")
        self.assertEqual(original, card(event_type="hack", strength=1))
        self.assertEqual((out["scope"], out["already_happened"], out["event_type"]), ("crypto", True, "hack"))


# Like the news questions' pins: a card question's text may not change without a version bump (a rewritten
# question is a different question and its stored answers no longer mean the same).
CARD_QUESTION_PINS = {
    "news_card_type@1": "a890b5a0a039d8bb3872a358b609e21677eb204251d599dd986db103a2844940",
    "news_card_strength@1": "52bbadaddc36248c3792dcc78d2b07e50848a5cd1d043757f2b6f96bf64683ba",
    "news_card_direction@1": "4f25d09a90e811fb41c384425e69103e4f42d9c4df6e29f02b9ed930e3984e02",
    "news_card_scope_status@1": "de1e468ffc7e3bf308bd4ca4613926e5df9501b3fc61c796fcb56a34c174bdf1",
}


class CardCatalogTests(unittest.TestCase):
    IDS = ["news_card_type", "news_card_strength", "news_card_direction", "news_card_scope_status"]

    def test_the_card_questions_live_in_their_own_scope(self):
        cards = q.load_questions(scope="news_card")
        self.assertEqual(sorted(cards), sorted(self.IDS))
        self.assertEqual([len(cards[i]["options"]) for i in self.IDS], [9, 4, 3, 6])
        self.assertEqual(cards["news_card_strength"]["type"], "score")
        self.assertEqual([o["value"] for o in cards["news_card_strength"]["options"]], [0.0, 1.0, 2.0, 3.0])
        for question in cards.values():
            self.assertEqual((question["scope"], question["version"]), ("news_card", 1))
            self.assertNotIn("state_fields", question)

    def test_neither_q_nor_the_news_classifier_sees_the_card_questions(self):
        for scope in ("verdict", "news"):
            self.assertFalse(set(self.IDS) & set(q.load_questions(scope=scope)))

    def test_a_card_question_carries_the_item_text_not_state_fields(self):
        base = dict(q.load_questions(scope="news_card")["news_card_type"])
        q.validate_question(base)
        with self.assertRaises(ValueError):
            q.validate_question(dict(base, state_fields=["regime"]))

    def test_the_card_catalog_is_pinned_and_the_old_news_questions_are_still_there(self):
        for question in q.load_questions(scope="news_card").values():
            key = "{}@{}".format(question["id"], question["version"])
            self.assertIn(key, CARD_QUESTION_PINS, "new id@version needs a pin: " + key)
            self.assertEqual(q.question_hash(question), CARD_QUESTION_PINS[key], key + " changed without a version bump")
        self.assertEqual(sorted(q.load_questions(scope="news")), ["news_direction", "news_relevance_btc"])

    def test_every_option_of_the_card_questions_fits_one_letter_and_the_item_text_comes_first(self):
        for question in q.load_questions(scope="news_card").values():
            prompt = q.build_prompt("headline: x", question, q.default_template())
            self.assertTrue(prompt.startswith("STATE: headline: x\nQUESTION: "))
            self.assertEqual(len(q.question_letters(question)), len(question["options"]))


CARD_QUESTIONS = q.load_questions(scope="news_card")


def card_reply(body):
    """llama-server double that answers every question with all its letters (a card question has up to 9)."""
    letters = [part.strip().strip('"') for part in body["grammar"].split("::=")[1].split("|")]
    entries = [{"token": letter, "logprob": math.log(0.9 if index == 0 else 0.1 / (len(letters) - 1))}
               for index, letter in enumerate(letters)]
    return FakeLlama.default_completion(entries, content="A")


def cards_script(**picks):
    """Scripted Qwen: 0.94 on the picked option of each card question (by option id); the legacy questions as in
    test_futures_news. ``picks`` values may be callables of the prompt."""
    defaults = {"news_card_type": "other", "news_card_strength": "minor", "news_card_direction": "neutral",
                "news_card_scope_status": "crypto_happened"}
    defaults.update(picks)

    def script(prompt, letters):
        for qid, question in CARD_QUESTIONS.items():
            if question["instruction"] in prompt:
                ids = [o["id"] for o in question["options"]]
                pick = defaults[qid](prompt) if callable(defaults[qid]) else defaults[qid]
                rest = 0.06 / (len(ids) - 1)
                return [{"token": letter, "logprob": math.log(0.94 if ids[i] == pick else rest)}
                        for i, letter in enumerate(letters)]
        return scripted(prompt, letters)

    return script


def asked_cards(provider):
    """Card question ids in the order the provider was asked them."""
    out = []
    for prompt in provider.prompts:
        for qid, question in CARD_QUESTIONS.items():
            if question["instruction"] in prompt:
                out.append(qid)
    return out


class CardStoreTests(TempDirTest):
    def row(self, **extra):
        row = {"item_hash": "h1", "card_version": 1, "status": "done", "written_at": NOW, "event_type": "hack",
               "scope": "crypto", "direction": "bearish", "strength": 2, "strength_model": 1, "strength_value": 1.2,
               "already_happened": True, "amount_usd": 6.3e9, "rules": ["hack_100m"],
               "questions": ["news_card_type@1"]}
        row.update(extra)
        return row

    def store(self):
        store = n.NewsStore(self.path, n.NEWS_CONFIG)
        self.addCleanup(store.close)
        return store

    def test_a_card_is_stored_append_only_with_its_fields(self):
        store = self.store()
        store.append_card(self.row())
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        [card] = db.execute("SELECT * FROM paper_futures_news_cards").fetchall()
        self.assertEqual((card["event_type"], card["scope"], card["direction"], card["strength"],
                          card["strength_model"], card["already_happened"], card["amount_usd"]),
                         ("hack", "crypto", "bearish", 2, 1, 1, 6.3e9))
        self.assertEqual(json.loads(card["rules_json"]), ["hack_100m"])
        self.assertEqual(json.loads(card["questions_json"]), ["news_card_type@1"])
        for sql in ("UPDATE paper_futures_news_cards SET strength=0", "DELETE FROM paper_futures_news_cards"):
            with self.assertRaises(sqlite3.IntegrityError, msg=sql):
                db.execute(sql)
        db.close()

    def test_one_card_per_item_and_version_and_a_strength_out_of_range_is_refused(self):
        store = self.store()
        store.append_card(self.row())
        with self.assertRaises(sqlite3.IntegrityError):
            store.append_card(self.row())
        store.append_card(self.row(card_version=2))
        with self.assertRaises(sqlite3.IntegrityError):
            store.append_card(self.row(item_hash="h2", strength=4))
        with self.assertRaises(sqlite3.IntegrityError):
            store.append_card(self.row(item_hash="h3", status="whatever"))
        with self.assertRaises(sqlite3.IntegrityError):
            store.append_card(self.row(item_hash="h4", event_type=None))
        store.append_card({"item_hash": "h5", "card_version": 1, "status": "skipped_stale", "written_at": NOW})

    def test_the_table_is_added_to_an_old_database_without_changing_its_config(self):
        store = self.store()
        self.assertEqual(store.config, n.NEWS_CONFIG)
        store.close()
        db = sqlite3.connect(self.path)
        db.execute("DROP TRIGGER paper_futures_news_cards_no_delete")
        db.execute("DROP TABLE paper_futures_news_cards")
        db.close()
        reopened = n.NewsStore(self.path, n.NEWS_CONFIG)
        self.addCleanup(reopened.close)
        reopened.append_card(self.row())

    def test_unresolved_cards_are_the_items_without_a_card_of_that_version(self):
        store = self.store()
        for index in (1, 2):
            store.add_item({"item_hash": "h%d" % index, "source_id": "feed_a", "source": "Feed A",
                            "url": "https://a.example/%d" % index, "title": "T%d" % index, "summary": "S",
                            "published_at": NOW - MINUTE, "received_at": NOW, "content_hash": "c%d" % index})
        store.append_card(self.row(item_hash="h1"))
        self.assertEqual([r[1] for r in store.unresolved_cards(1)], ["h2"])
        self.assertEqual([r[1] for r in store.unresolved_cards(2)], ["h2", "h1"])


class CardServiceTests(ServiceBase):
    def provider(self, **picks):
        return q.FakeProvider(entries=cards_script(**picks))

    def cards(self, where=""):
        return self.rows("paper_futures_news_cards", where)

    def test_without_the_cards_option_nothing_changes(self):
        provider = self.provider()
        result = self.service(provider=provider).poll()
        self.assertEqual((result["analyzed"], provider.calls), (4, 4))
        self.assertEqual(self.cards(), [])
        self.assertEqual(asked_cards(provider), [])

    def test_with_cards_each_item_gets_the_four_card_questions_after_the_two_it_already_had(self):
        provider = self.provider()
        result = self.service(provider=provider, cards=True).poll()
        self.assertEqual(result["analyzed"], 4)
        self.assertEqual(provider.calls, 4 + 2 * 4)
        self.assertEqual(sorted(asked_cards(provider)), sorted(list(CARD_QUESTIONS) * 2))
        rows = self.analysis()
        self.assertEqual(len(rows), 4 + 2 * 4)
        self.assertEqual({r["question_version"] for r in rows if r["question_id"].startswith("news_card_")}, {1})
        [first, second] = self.cards("ORDER BY card_id")
        self.assertEqual(result["cards"], 2)
        self.assertEqual((first["status"], first["card_version"], first["written_at"]), ("done", 1, NOW))
        self.assertEqual((first["event_type"], first["scope"], first["direction"], first["strength"],
                          first["strength_model"], first["already_happened"], first["amount_usd"]),
                         ("other", "crypto", "neutral", 1, 1, 1, None))
        self.assertEqual(json.loads(first["rules_json"]), [])
        self.assertEqual(json.loads(first["questions_json"]),
                         ["news_card_type@1", "news_card_strength@1", "news_card_direction@1",
                          "news_card_scope_status@1"])
        self.assertAlmostEqual(first["strength_value"], 0.06 / 3 * (0 + 2 + 3) + 0.94, places=6)
        self.assertNotEqual(first["item_hash"], second["item_hash"])

    def test_the_fixed_rules_are_applied_and_the_model_strength_is_kept(self):
        self.fetcher.bodies[SRC_A["url"]] = rss([fresh_item(
            1, title="Binance hit by record $6.3 billion hack, withdrawals frozen", desc="crypto exchange")])
        provider = self.provider(news_card_type="network_outage", news_card_direction="bearish")
        self.service(provider=provider, cards=True).poll()
        [card] = self.cards()
        self.assertEqual((card["event_type"], card["strength"], card["strength_model"], card["direction"],
                          card["amount_usd"]), ("network_outage", 2, 1, "bearish", 6.3e9))
        self.assertEqual(json.loads(card["rules_json"]), ["hack_100m"])

    def test_the_scope_and_already_happened_come_from_the_combined_answer(self):
        provider = self.provider(news_card_scope_status="eth_planned")
        self.service(provider=provider, cards=True).poll()
        [card, _] = self.cards("ORDER BY card_id")
        self.assertEqual((card["scope"], card["already_happened"]), ("eth", 0))

    def test_a_price_recap_answer_asks_nothing_else_and_gets_strength_zero(self):
        provider = self.provider(news_card_type="price_recap", news_card_strength="significant")
        self.service(provider=provider, cards=True).poll()
        self.assertEqual(asked_cards(provider), ["news_card_type"] * 2)
        [card, _] = self.cards("ORDER BY card_id")
        self.assertEqual((card["event_type"], card["strength"], card["strength_model"], card["direction"],
                          card["scope"], card["already_happened"], card["strength_value"]),
                         ("price_recap", 0, 0, "neutral", None, None, None))
        self.assertEqual(json.loads(card["rules_json"]), ["recap"])
        self.assertEqual(json.loads(card["questions_json"]), ["news_card_type@1"])

    def test_a_recap_headline_gets_its_card_without_asking_the_model(self):
        self.fetcher.bodies[SRC_A["url"]] = rss([fresh_item(1, title="ETH surges above $3,000 as price rallies")])
        provider = self.provider()
        result = self.service(provider=provider, cards=True).poll()
        self.assertEqual(provider.calls, 0)
        self.assertEqual(result["cards"], 1)
        [card] = self.cards()
        self.assertEqual((card["status"], card["event_type"], card["strength"], card["direction"], card["amount_usd"]),
                         ("done", "price_recap", 0, "neutral", 3000.0))
        self.assertEqual(json.loads(card["rules_json"]), ["recap"])
        self.assertEqual(json.loads(card["questions_json"]), [])

    def test_stale_and_bitcoin_only_items_are_marked_without_asking_the_model(self):
        self.fetcher.bodies[SRC_A["url"]] = rss([
            fresh_item(1, title="Bitcoin miners increase hashrate after halving", desc="Satoshi era blocks"),
            fresh_item(2, title="Ethereum Foundation announces Pectra upgrade date", desc="Layer 2 blobs expand"),
        ])
        provider = self.provider()
        provider.healthy = False
        service = self.service(provider=provider, cards=True)
        result = service.poll()
        self.assertEqual(result["cards"], 0)
        self.assertEqual([r["status"] for r in self.cards()], ["skipped_stale"])        # Bitcoin-only: at once
        self.clock.now += 40 * MINUTE                                                   # past the 30 min retry window
        service.poll()
        self.assertEqual([r["status"] for r in self.cards("ORDER BY card_id")], ["skipped_stale", "skipped_stale"])
        self.assertEqual(provider.calls, 0)
        self.assertTrue(all(r["event_type"] is None and r["strength"] is None for r in self.cards()))

    def test_a_model_that_is_down_writes_no_card_and_the_item_is_asked_again_later(self):
        provider = self.provider()
        provider.healthy = False
        service = self.service(provider=provider, cards=True)
        service.poll()
        self.assertEqual((provider.calls, self.cards()), (0, []))
        provider.healthy = True
        self.clock.now += MINUTE
        result = service.poll()
        self.assertEqual(result["cards"], 2)
        self.assertEqual(len(self.cards()), 2)

    def test_the_cascade_resumes_where_the_per_poll_budget_stopped_it_without_asking_twice(self):
        self.fetcher.bodies[SRC_A["url"]] = rss([fresh_item(1)])
        provider = self.provider()
        service = self.service(provider=provider, cards=True, max_analyses_per_poll=3)
        first = service.poll()
        self.assertEqual(first["cards"], 0)
        self.assertEqual(len(asked_cards(provider)), 3)
        self.assertEqual(self.cards(), [])
        for _ in range(4):
            self.clock.now += MINUTE
            service.poll()
        self.assertEqual(len(self.cards()), 1)
        self.assertEqual(asked_cards(provider), list(CARD_QUESTIONS))        # each question once, in cascade order
        keys = [(r["item_hash"], r["question_id"], r["question_version"]) for r in self.analysis()]
        self.assertEqual(len(keys), len(set(keys)))

    def test_a_question_that_keeps_failing_ends_the_item_with_a_failed_card(self):
        self.fetcher.bodies[SRC_A["url"]] = rss([fresh_item(1)])
        provider = q.FakeProvider(entries=lambda prompt, letters: (
            [{"token": "Z", "logprob": -1.0}] if CARD_QUESTIONS["news_card_strength"]["instruction"] in prompt
            else cards_script()(prompt, letters)))
        service = self.service(provider=provider, cards=True)
        for _ in range(4):
            service.poll()
            self.clock.now += MINUTE
        [card] = self.cards()
        self.assertEqual((card["status"], card["event_type"], card["strength"]), ("failed", None, None))
        self.assertEqual(len(self.rows("paper_futures_news_errors", "WHERE question_id='news_card_strength'")), 3)
        self.assertNotIn("news_card_direction", asked_cards(provider))
        self.assertEqual([r["status"] for r in self.analysis(question_id="news_card_strength")], ["failed"])

    def test_card_prompts_carry_the_item_text_first_and_share_it_between_questions_for_the_prompt_cache(self):
        server = FakeLlama()
        self.addCleanup(server.stop)
        server.pick = card_reply
        self.fetcher.bodies[SRC_A["url"]] = rss([fresh_item(1)])
        provider = q.LlamaCppProvider(server.url, model_ref="qwen-test", timeout=5, health_timeout=2)
        self.service(provider=provider, cards=True).poll()
        bodies = server.completions()
        card_bodies = [b for b in bodies
                       if any(x["instruction"] in b["messages"][-1]["content"] for x in CARD_QUESTIONS.values())]
        self.assertEqual(len(card_bodies), 4)
        states = {b["messages"][-1]["content"].split("\nQUESTION:")[0] for b in card_bodies}
        self.assertEqual(len(states), 1)
        self.assertTrue(states.pop().startswith("STATE: headline:"))
        self.assertEqual(len({b["messages"][0]["content"] for b in card_bodies}), 1)
        for body in card_bodies:
            self.assertIs(body["cache_prompt"], True)
            self.assertEqual(body["max_tokens"], 1)

    def test_cards_never_change_the_classifier_rows_of_the_two_old_questions(self):
        plain = self.provider()
        self.service(provider=plain).poll()
        old = [(r["item_hash"], r["question_id"], r["chosen"], r["probabilities_json"]) for r in self.analysis()]
        with_cards = self.service(provider=self.provider(), cards=True)
        with_cards.poll()
        self.assertEqual(sorted(old), sorted(
            (r["item_hash"], r["question_id"], r["chosen"], r["probabilities_json"])
            for r in self.analysis() if not r["question_id"].startswith("news_card_")))


class CardCliTests(TempDirTest):
    def setUp(self):
        super().setUp()
        self.server = FeedServer()
        self.addCleanup(self.server.stop)
        self.sources = os.path.join(self.dir, "sources.json")
        with open(self.sources, "w") as handle:
            json.dump({"sources": [{"id": "local", "name": "Local", "url": self.server.url}]}, handle)

    def run_main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = n.main(list(argv))
        return code, out.getvalue()

    def run_cards(self, *flags):
        self.server.body = rss([fresh_item(1, now=int(time.time() * 1000), minutes_ago=1,
                                          title="Ethereum protocol update")])
        server = FakeLlama()
        self.addCleanup(server.stop)
        server.pick = card_reply
        code, out = self.run_main("--once", "--news-db", self.path, "--sources-file", self.sources,
                                  "--llama-url", server.url, "--no-briefing", *flags)
        db = sqlite3.connect(self.path)
        cards = db.execute("SELECT COUNT(*) FROM paper_futures_news_cards").fetchone()[0]
        db.close()
        return code, out, cards, len(server.completions())

    def test_cards_are_off_by_default_even_with_analyze(self):
        code, out, cards, asked = self.run_cards("--analyze")
        self.assertEqual((code, cards, asked), (0, 0, 2))

    def test_the_cards_flag_asks_the_card_cascade_for_new_items(self):
        code, out, cards, asked = self.run_cards("--analyze", "--cards")
        self.assertEqual((code, cards), (0, 1))
        self.assertEqual(asked, 2 + 4)
        self.assertIn("cards 1", out)

    def test_the_cards_flag_without_analyze_asks_nothing(self):
        code, out, cards, asked = self.run_cards("--cards")
        self.assertEqual((code, cards, asked), (0, 0, 0))


if __name__ == "__main__":
    unittest.main()
