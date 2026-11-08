"""``futures_news_effect`` reads the news card when an item has no answer of the two old questions (card-only
configuration, T14 of ``odd/tasks/noticias-y-auditor.md``); the old rows always win when they exist."""
import os
import shutil
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_news_effect as effect
from test_futures_news_effect import HOUR, MIN, T0, analysed, market_db, news_db

CARDS = """CREATE TABLE paper_futures_news_cards(card_id INTEGER PRIMARY KEY, item_hash TEXT, card_version INTEGER,
    status TEXT, written_at INTEGER, direction TEXT, strength INTEGER);"""


def add_cards(path, cards):
    db = sqlite3.connect(path)
    db.execute(CARDS)
    for h, version, status, written, direction, strength in cards:
        db.execute("INSERT INTO paper_futures_news_cards(item_hash,card_version,status,written_at,direction,strength)"
                   " VALUES(?,?,?,?,?,?)", (h, version, status, written, direction, strength))
    db.commit()
    db.close()


class CardEffectTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix=".news-effect-cards-test-", dir=".")
        self.addCleanup(shutil.rmtree, self.folder)
        self.news = os.path.join(self.folder, "news.sqlite")
        self.market = os.path.join(self.folder, "market.sqlite")

    def build(self, items, analyses, cards):
        news_db(self.news, items, analyses)
        add_cards(self.news, cards)
        market_db(self.market, [2000.0 if i < 12 else 2020.0 for i in range(60)])

    def report(self):
        return effect.measure(self.news, self.market)

    def test_a_card_gives_the_direction_and_a_strength_group_when_there_are_no_old_rows(self):
        self.build([("a", "coindesk", "x", T0, T0 + 50 * MIN), ("b", "coindesk", "y", T0, T0 + 50 * MIN),
                    ("n", "decrypt", "z", T0, T0 + 50 * MIN)], [],
                   [("a", 1, "done", T0 + HOUR, "bullish", 2), ("b", 1, "done", T0 + HOUR, "bearish", 3),
                    ("n", 1, "done", T0 + HOUR, "neutral", 1)])
        report = self.report()
        rows = {r["item_hash"]: r for r in report["items"]}
        self.assertEqual(rows["a"]["known_at_ms"], T0 + HOUR)
        self.assertEqual((rows["a"]["relevance"], rows["a"]["direction"], rows["a"]["moves_bp"]["1h"]),
                         ("ficha 2", "bullish", 100.0))
        self.assertEqual((rows["b"]["relevance"], rows["b"]["moves_bp"]["1h"]), ("ficha 3", -100.0))
        self.assertEqual([(r["item_hash"], r["relevance"]) for r in report["neutral"]], [("n", "ficha 1")])
        groups = {(g["by"], g["key"]): g for g in report["groups"]}
        self.assertEqual(groups[("relevance", "ficha 2")]["hit_pct"]["1h"], 100.0)
        self.assertEqual(groups[("source/relevance/direction", "coindesk/ficha 3/bearish")]["n"]["1h"], 1)

    def test_the_old_rows_win_and_are_not_mixed_with_the_card(self):
        self.build([("a", "coindesk", "x", T0, T0 + 50 * MIN)], analysed("a", "medium", "bearish", T0 + HOUR),
                   [("a", 1, "done", T0 + HOUR, "bullish", 3)])
        [row] = self.report()["items"]
        self.assertEqual((row["relevance"], row["direction"], row["moves_bp"]["1h"]), ("medium", "bearish", -100.0))

    def test_skipped_and_failed_cards_are_counted_as_without_analysis(self):
        self.build([("s", "coindesk", "t1", T0, T0 + HOUR), ("f", "coindesk", "t2", T0, T0 + HOUR)], [],
                   [("s", 1, "skipped_stale", T0 + HOUR, None, None), ("f", 1, "failed", T0 + HOUR, None, None)])
        report = self.report()
        self.assertEqual(report["items"], [])
        self.assertEqual(report["skipped"]["count_by_status"], {"failed": 1, "skipped_stale": 1})

    def test_the_latest_card_version_counts(self):
        self.build([("a", "coindesk", "x", T0, T0 + 50 * MIN)], [],
                   [("a", 1, "done", T0 + HOUR, "bearish", 1), ("a", 2, "done", T0 + 2 * HOUR, "bullish", 3)])
        [row] = self.report()["items"]
        self.assertEqual((row["relevance"], row["direction"], row["known_at_ms"]), ("ficha 3", "bullish", T0 + 2 * HOUR))

    def test_the_report_labels_a_card_group_without_calling_it_relevance(self):
        self.build([("a", "coindesk", "x", T0, T0 + 50 * MIN)], [], [("a", 1, "done", T0 + HOUR, "bullish", 2)])
        text = effect.render(self.report())
        self.assertIn("ficha 2", text)
        self.assertNotIn("relevancia ficha", text)

    def test_a_database_without_the_card_table_reads_as_before(self):
        news_db(self.news, [("a", "coindesk", "x", T0, T0 + 50 * MIN)], analysed("a", "high", "bullish", T0 + HOUR))
        market_db(self.market, [2000.0] * 60)
        self.assertEqual([r["relevance"] for r in self.report()["items"]], ["high"])


if __name__ == "__main__":
    unittest.main()
