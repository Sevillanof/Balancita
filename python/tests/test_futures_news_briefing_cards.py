"""The news briefing picks its inputs from the news card when an item has no answer of the two old questions
(card-only configuration, T14 of ``odd/tasks/noticias-y-auditor.md``). Old rows always win and keep their exact input."""
import os
import shutil
import tempfile
import unittest

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_news as news
from balancita_engine import futures_news_briefing as briefing
from test_futures_news import Clock, scripted
from test_futures_news_briefing import NOW, TEXT, completion


class CardBriefingTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix=".news-briefing-cards-test-", dir=".")
        self.addCleanup(shutil.rmtree, self.folder)
        self.store = news.NewsStore(os.path.join(self.folder, "news.sqlite"), news.NEWS_CONFIG)
        self.addCleanup(self.store.close)
        self.clock = Clock(NOW)
        self.provider = llm.FakeProvider(entries=scripted, model_ref="Qwen-local.gguf")
        self.provider.chat_script = lambda body: completion()

    def item(self, id_, **changes):
        row = {
            "item_hash": id_, "source_id": "feed_a", "source": "Feed A", "url": "https://a.example/" + id_,
            "title": "Ethereum novedad " + id_, "summary": "La comunidad de Ethereum debate mejoras del protocolo.",
            "published_at": NOW - 2 * news.MINUTE_MS, "received_at": NOW - news.MINUTE_MS, "content_hash": id_ + "-c",
        }
        row.update(changes)
        self.store.add_item(row)

    def old_rows(self, id_, relevance="medium"):
        for question, chosen in (("news_relevance_btc", relevance), ("news_direction", "neutral")):
            self.store.append_analysis({
                "item_hash": id_, "question_id": question, "question_version": 2, "status": "done",
                "analyzed_at": NOW - 1000, "question_type": "score", "model_ref": "Qwen-local.gguf", "model_info": {},
                "prompt_hash": "classification", "prompt_version": 2, "probabilities": {chosen: 1.0},
                "confidence": 1.0, "chosen": chosen, "value": 0.6})

    def card(self, id_, strength=1, direction="neutral", status="done", at=None, version=1):
        row = {"item_hash": id_, "card_version": version, "status": status,
               "written_at": NOW - 1000 if at is None else at}
        if status == "done":
            row.update(event_type="other", scope=None, direction=direction, strength=strength, strength_model=strength,
                       strength_value=float(strength), already_happened=None, amount_usd=None, rules=[],
                       questions=["news_card_type@1"])
        self.store.append_card(row)

    def inputs(self):
        return briefing.select_inputs(self.store.db, NOW)

    def test_items_with_only_a_card_of_strength_one_or_more_are_selected_with_the_card_values(self):
        for id_ in ("weak", "strong", "noise", "late_card", "early_card", "skipped", "failed", "nocard"):
            self.item(id_)
        self.card("weak", 1, "bullish")
        self.card("strong", 3, "bearish")
        self.card("noise", 0)
        self.card("late_card", 2, at=NOW + 1)
        self.card("early_card", 2, at=NOW - 2 * news.MINUTE_MS)           # before the item was received
        self.card("skipped", status="skipped_stale")
        self.card("failed", status="failed")
        got = {row["id"]: row for row in self.inputs()}
        self.assertEqual(set(got), {"weak", "strong"})
        self.assertEqual((got["weak"]["relevance"], got["weak"]["direction"]), ("low", "bullish"))
        self.assertEqual((got["strong"]["relevance"], got["strong"]["direction"]), ("high", "bearish"))
        self.assertEqual((got["strong"]["relevance_at_ms"], got["strong"]["direction_at_ms"]),
                         (NOW - 1000, NOW - 1000))
        self.assertEqual((got["strong"]["analysis_source"], got["strong"]["card_strength"]), ("card", 3))
        self.assertEqual(got["strong"]["license_status"], "unknown")

    def test_the_strength_maps_to_the_relevance_label_of_the_old_rows(self):
        for strength in (1, 2, 3):
            self.item("s%d" % strength)
            self.card("s%d" % strength, strength)
        self.assertEqual({r["id"]: r["relevance"] for r in self.inputs()}, {"s1": "low", "s2": "medium", "s3": "high"})

    def test_the_old_rows_win_and_their_input_has_no_card_fields(self):
        self.item("both")
        self.old_rows("both", "low")
        self.card("both", 3, "bullish")
        [row] = self.inputs()
        self.assertEqual((row["relevance"], row["direction"]), ("low", "neutral"))
        self.assertFalse({"card_strength", "analysis_source"} & set(row))

    def test_an_old_row_that_says_none_is_not_overridden_by_a_card(self):
        self.item("none")
        self.old_rows("none", "none")
        self.card("none", 3)
        self.assertEqual(self.inputs(), [])

    def test_a_card_item_is_filtered_and_deduplicated_like_the_others(self):
        self.item("recap", title="ETH price surges above $3000")
        self.item("btc", title="Bitcoin halving report", summary="Satoshi and hashrate")
        self.item("a", title="Ethereum novedad igual")
        self.item("b", title="Ethereum novedad igual", url="https://a.example/other")
        for id_ in ("recap", "btc", "a", "b"):
            self.card(id_, 2)
        self.assertEqual(len(self.inputs()), 1)
        self.assertEqual(self.inputs()[0]["title"], "Ethereum novedad igual")

    def test_cards_and_old_rows_are_ordered_together_newest_first(self):
        self.item("old_style", published_at=NOW - 3 * news.MINUTE_MS, received_at=NOW - 2 * news.MINUTE_MS)
        self.old_rows("old_style")
        self.item("card_style", published_at=NOW - 2 * news.MINUTE_MS, received_at=NOW - news.MINUTE_MS)
        self.card("card_style", 2)
        self.assertEqual([r["id"] for r in self.inputs()], ["card_style", "old_style"])

    def test_a_briefing_is_generated_from_card_only_news(self):
        self.item("eth")
        self.card("eth", 2, "bullish")
        job = briefing.BriefingService(self.store, self.provider, enabled=True, clock=self.clock, log=lambda line: None)
        self.addCleanup(job.close)
        job.tick()
        job.drain()
        row = self.store.db.execute(
            "SELECT status, text FROM paper_futures_news_briefings ORDER BY briefing_id DESC LIMIT 1").fetchone()
        self.assertEqual(row, ("ok", TEXT))

    def test_the_prompt_the_model_reads_does_not_depend_on_where_the_labels_came_from(self):
        self.item("x")
        self.old_rows("x", "medium")
        legacy = briefing.prompt_news(self.inputs())
        self.item("y", title="Ethereum novedad y")
        self.card("y", 2)
        [_, from_card] = briefing.prompt_news(self.inputs())
        self.assertEqual(set(from_card), set(legacy[0]))

    def test_without_a_card_table_the_old_selection_is_unchanged(self):
        self.item("x")
        self.old_rows("x")
        self.store.db.executescript("DROP TRIGGER paper_futures_news_cards_no_delete; DROP TABLE paper_futures_news_cards;")
        self.assertEqual([r["id"] for r in self.inputs()], ["x"])


if __name__ == "__main__":
    unittest.main()
