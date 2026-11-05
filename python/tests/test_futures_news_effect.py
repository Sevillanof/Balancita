import hashlib
import io
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from balancita_engine import futures_news_effect as effect


def digest(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


T0 = 1_793_750_400_000  # 2026-11-04 00:00 UTC
MIN = 60_000
HOUR = 60 * MIN


def news_db(path, items, analyses):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE paper_futures_news_items(item_id INTEGER PRIMARY KEY, item_hash TEXT, source_id TEXT,
          source TEXT, url TEXT, title TEXT, summary TEXT, published_at INTEGER, received_at INTEGER,
          content_hash TEXT);
        CREATE TABLE paper_futures_news_analysis(analysis_id INTEGER PRIMARY KEY, item_hash TEXT,
          question_id TEXT, question_version INTEGER, status TEXT, analyzed_at INTEGER, chosen TEXT);
    """)
    for h, source, title, published, received in items:
        db.execute("INSERT INTO paper_futures_news_items(item_hash,source_id,source,url,title,summary,"
                   "published_at,received_at,content_hash) VALUES(?,?,?,?,?,?,?,?,?)",
                   (h, source, source, "https://x/" + h, title, "", published, received, h))
    for h, question, status, analyzed, chosen in analyses:
        db.execute("INSERT INTO paper_futures_news_analysis(item_hash,question_id,question_version,status,"
                   "analyzed_at,chosen) VALUES(?,?,2,?,?,?)", (h, question, status, analyzed, chosen))
    db.commit()
    db.close()


def market_db(path, closes, start=T0, product="PF_ETHUSD"):
    """closes[i] is the close of the 5m candle starting at start + i*5min."""
    db = sqlite3.connect(path)
    db.execute("""CREATE TABLE paper_futures_official_candles(product_id TEXT, interval_ms INTEGER,
        bucket_start INTEGER, revision_hash TEXT, known_at INTEGER, open_price TEXT, high_price TEXT,
        low_price TEXT, close_price TEXT, volume_btc TEXT, response_sha256 TEXT)""")
    for i, close in enumerate(closes):
        if close is None:
            continue
        b = start + i * 5 * MIN
        db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                   (product, 300_000, b, "r", b + 5 * MIN, str(close), str(close), str(close), str(close), "1", "s"))
    db.commit()
    db.close()


def analysed(h, relevance, direction, at):
    return [(h, "news_relevance_btc", "done", at, relevance), (h, "news_direction", "done", at, direction)]


class NewsEffectTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix=".news-effect-test-", dir=".")
        self.addCleanup(shutil.rmtree, self.folder)
        self.news = os.path.join(self.folder, "news.sqlite")
        self.market = os.path.join(self.folder, "market.sqlite")

    def build(self, items, analyses, closes):
        news_db(self.news, items, analyses)
        market_db(self.market, closes)

    def report(self, **kw):
        return effect.measure(self.news, self.market, **kw)

    def flat_then(self, level, at_index, base=2000.0, n=60):
        return [base if i < at_index else level for i in range(n)]

    def test_signed_moves_per_horizon_from_when_balancita_knew_the_news(self):
        # Known at 01:00 (received 00:50, analysed 01:00). Price 2000 until 01:00, 2020 afterwards.
        closes = self.flat_then(2020.0, 12)
        self.build([("a", "coindesk", "ETH up", T0 + 40 * MIN, T0 + 50 * MIN),
                    ("b", "decrypt", "ETH down", T0 + 40 * MIN, T0 + 50 * MIN)],
                   analysed("a", "medium", "bullish", T0 + HOUR) + analysed("b", "medium", "bearish", T0 + HOUR),
                   closes)
        rows = {r["item_hash"]: r for r in self.report()["items"]}
        self.assertEqual(rows["a"]["known_at_ms"], T0 + HOUR)
        self.assertEqual(rows["a"]["moves_bp"], {"1h": 100.0, "4h": 100.0, "12h": None})
        self.assertEqual(rows["b"]["moves_bp"], {"1h": -100.0, "4h": -100.0, "12h": None})

    def test_neutral_news_are_reported_apart_without_sign(self):
        self.build([("n", "theblock", "ETH flat", T0, T0 + 10 * MIN)],
                   analysed("n", "low", "neutral", T0 + HOUR), self.flat_then(1980.0, 12))
        report = self.report()
        self.assertEqual(report["items"], [])
        self.assertEqual(report["neutral"], [{"item_hash": "n", "source_id": "theblock", "relevance": "low",
                                              "abs_moves_bp": {"1h": 100.0, "4h": 100.0, "12h": None}}])

    def test_groups_count_hits_and_average_by_source_relevance_and_direction(self):
        closes = self.flat_then(2020.0, 12)
        self.build([("a", "coindesk", "x", T0, T0 + 5 * MIN), ("b", "coindesk", "y", T0, T0 + 5 * MIN),
                    ("c", "coindesk", "z", T0, T0 + 5 * MIN)],
                   analysed("a", "medium", "bullish", T0 + HOUR) + analysed("b", "medium", "bullish", T0 + HOUR)
                   + analysed("c", "medium", "bearish", T0 + HOUR), closes)
        groups = {(g["by"], g["key"]): g for g in self.report()["groups"]}
        bull = groups[("source/relevance/direction", "coindesk/medium/bullish")]
        self.assertEqual(bull["n"], {"1h": 2, "4h": 2, "12h": 0})
        self.assertEqual(bull["hit_pct"], {"1h": 100.0, "4h": 100.0, "12h": None})
        self.assertEqual(bull["avg_bp"], {"1h": 100.0, "4h": 100.0, "12h": None})
        rel = groups[("relevance", "medium")]
        self.assertEqual(rel["n"]["1h"], 3)
        self.assertEqual(rel["hit_pct"]["1h"], 66.7)
        self.assertEqual(rel["avg_bp"]["1h"], 33.3)

    def test_ingest_latency_median_and_p90_by_source(self):
        items = [("l%d" % i, "coindesk", "t", T0, T0 + m * MIN) for i, m in enumerate([5, 10, 20, 40, 80])]
        items.append(("x", "decrypt", "t", None, T0))
        self.build(items, [], self.flat_then(2000.0, 0))
        latency = {r["source_id"]: r for r in self.report()["latency"]}
        self.assertEqual(latency["coindesk"], {"source_id": "coindesk", "n": 5, "median_min": 20.0, "p90_min": 80.0})
        self.assertNotIn("decrypt", latency)

    def test_skipped_news_are_counted_with_the_market_move_after_reception(self):
        closes = self.flat_then(2050.0, 12)
        self.build([("s", "coindesk", "Live updates: Bitcoin and stocks reverse overnight plunge", T0, T0 + HOUR)],
                   [("s", "news_relevance_btc", "skipped_stale", T0 + HOUR, None),
                    ("s", "news_direction", "skipped_stale", T0 + HOUR, None)], closes)
        report = self.report()
        self.assertEqual(report["items"], [])
        self.assertEqual(report["skipped"]["count_by_status"], {"skipped_stale": 1})
        self.assertEqual(report["skipped"]["items"], [{
            "item_hash": "s", "source_id": "coindesk", "status": "skipped_stale",
            "title": "Live updates: Bitcoin and stocks reverse overnight plunge",
            "received_at_ms": T0 + HOUR, "abs_move_1h_bp": 250.0}])

    def test_missing_candles_leave_the_horizon_empty_instead_of_inventing_a_price(self):
        closes = [2000.0] * 12 + [None] * 188
        self.build([("a", "coindesk", "x", T0, T0 + 5 * MIN)], analysed("a", "high", "bullish", T0 + HOUR), closes)
        row = self.report()["items"][0]
        self.assertEqual(row["moves_bp"], {"1h": None, "4h": None, "12h": None})

    def test_date_range_filters_by_known_time(self):
        closes = self.flat_then(2020.0, 12, n=400)
        self.build([("early", "coindesk", "x", T0, T0 + 5 * MIN), ("late", "coindesk", "y", T0, T0 + 5 * MIN)],
                   analysed("early", "medium", "bullish", T0 + HOUR)
                   + analysed("late", "medium", "bullish", T0 + 25 * HOUR), closes)
        self.assertEqual([r["item_hash"] for r in self.report(until_ms=T0 + 24 * HOUR)["items"]], ["early"])
        self.assertEqual([r["item_hash"] for r in self.report(since_ms=T0 + 24 * HOUR)["items"]], ["late"])

    def test_cli_json_is_stable_and_never_writes_the_databases(self):
        self.build([("a", "coindesk", "x", T0, T0 + 5 * MIN)], analysed("a", "medium", "bullish", T0 + HOUR),
                   self.flat_then(2020.0, 12))
        before = [digest(p) for p in (self.news, self.market)]
        out = io.StringIO()
        with redirect_stdout(out):
            code = effect.main(["--news-db", self.news, "--market-db", self.market, "--json",
                                "--desde", "2026-11-04", "--hasta", "2026-11-05"])
        self.assertEqual(code, 0)
        data = json.loads(out.getvalue())
        self.assertEqual(sorted(data), ["groups", "items", "latency", "neutral", "range", "skipped"])
        self.assertEqual(data["range"], {"since_ms": T0, "until_ms": T0 + 24 * HOUR})
        self.assertEqual(before, [digest(p) for p in (self.news, self.market)])

    def test_cli_text_report_is_readable(self):
        self.build([("a", "coindesk", "x", T0, T0 + 5 * MIN)], analysed("a", "medium", "bullish", T0 + HOUR),
                   self.flat_then(2020.0, 12))
        out = io.StringIO()
        with redirect_stdout(out):
            code = effect.main(["--news-db", self.news, "--market-db", self.market])
        self.assertEqual(code, 0)
        text = out.getvalue()
        self.assertIn("Noticias con dirección: 1", text)
        self.assertIn("relevancia medium", text)
        self.assertIn("acierto", text)
        self.assertIn("Latencia de ingesta", text)

    def test_cli_rejects_a_missing_database(self):
        err = io.StringIO()
        with redirect_stdout(io.StringIO()):
            with redirect_stderr(err):
                code = effect.main(["--news-db", os.path.join(self.folder, "nope.sqlite"),
                                    "--market-db", self.market])
        self.assertEqual(code, 2)
        self.assertIn("no existe", err.getvalue())


if __name__ == "__main__":
    unittest.main()
