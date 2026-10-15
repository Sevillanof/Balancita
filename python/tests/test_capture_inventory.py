import hashlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout

from balancita_engine import capture_inventory as inv
from balancita_engine.capture_validation import HOLDOUT_START_MS

H = HOLDOUT_START_MS
HOUR = 3_600_000
SENTINEL_PRICE = "98765.4321"
SENTINEL_RATE = "0.000123456"

SCHEMA = """
CREATE TABLE paper_futures_funding_responses(sha256 TEXT PRIMARY KEY, received_at INTEGER NOT NULL,
  server_time TEXT NOT NULL, raw_response TEXT NOT NULL) STRICT;
CREATE TABLE paper_futures_funding_periods(response_sha256 TEXT NOT NULL, start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL, funding_rate TEXT NOT NULL, known_at INTEGER NOT NULL, unit TEXT NOT NULL,
  product_id TEXT NOT NULL, PRIMARY KEY(response_sha256, start_ms)) STRICT;
CREATE TABLE paper_futures_official_candle_responses(product_id TEXT NOT NULL, sha256 TEXT NOT NULL,
  interval_ms INTEGER NOT NULL, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, received_at INTEGER NOT NULL,
  raw_response TEXT NOT NULL, PRIMARY KEY(product_id, sha256)) STRICT;
CREATE TABLE paper_futures_official_candles(product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL, revision_hash TEXT NOT NULL, known_at INTEGER NOT NULL, open_price TEXT NOT NULL,
  high_price TEXT NOT NULL, low_price TEXT NOT NULL, close_price TEXT NOT NULL, volume_btc TEXT NOT NULL,
  response_sha256 TEXT NOT NULL, PRIMARY KEY(product_id, interval_ms, bucket_start, revision_hash)) STRICT;
CREATE TABLE paper_futures_candle_revisions(candle_id TEXT NOT NULL, interval_ms INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL, revision INTEGER NOT NULL, known_at INTEGER NOT NULL, open_price TEXT NOT NULL,
  close_price TEXT NOT NULL, PRIMARY KEY(candle_id, revision)) STRICT;
CREATE TABLE paper_futures_market_events(event_id TEXT PRIMARY KEY, feed TEXT NOT NULL, product_id TEXT NOT NULL,
  received_at INTEGER NOT NULL, event_time INTEGER NOT NULL, raw_json TEXT NOT NULL) STRICT;
"""
QUOTES = """
CREATE TABLE quote_snapshot(product_id TEXT NOT NULL, received_at INTEGER NOT NULL, bid TEXT NOT NULL,
  ask TEXT NOT NULL, PRIMARY KEY(product_id, received_at)) STRICT;
"""


def digest(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def make_main(path):
    c = sqlite3.connect(path)
    c.executescript(SCHEMA)
    base = H - 10 * HOUR  # hourly periods ending before the holdout, plus some at/after it
    n = 0
    for k, start in enumerate([base + i * HOUR for i in range(12)]):  # last 2 reach the holdout
        n += 1
        sha = "r%d" % k
        c.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)", (sha, start + HOUR + 60_000, "t", "{}"))
        c.execute(
            "INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
            (sha, start, start + HOUR, SENTINEL_RATE, start + HOUR + 60_000, "u", "PF_XBTUSD"),
        )
    # a hole: ETH has hours 0 and 2 only
    for k, off in enumerate([0, 2]):
        start = base + off * HOUR
        c.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)", ("e%d" % k, start + HOUR + 1, "t", "{}"))
        c.execute(
            "INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
            ("e%d" % k, start, start + HOUR, SENTINEL_RATE, start + HOUR + 1, "u", "PF_ETHUSD"),
        )
    for i in range(6):  # 5 m official candles; two reach the holdout
        b = H - 4 * 300_000 + i * 300_000
        c.execute(
            "INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            ("PF_XBTUSD", 300_000, b, "h%d" % i, b + 300_000, SENTINEL_PRICE, "1", "1", "1", "1", "s"),
        )
    c.execute("INSERT INTO paper_futures_official_candle_responses VALUES(?,?,?,?,?,?,?)",
              ("PF_XBTUSD", "s", 300_000, H - 3_600_000, H - 300_000, H - 1_000, "{}"))
    c.execute("INSERT INTO paper_futures_official_candle_responses VALUES(?,?,?,?,?,?,?)",
              ("PF_XBTUSD", "late", 300_000, H - 3_600_000, H + 300_000, H + 1_000, "{}"))
    for i in range(4):
        b = H - 60_000 * 2 + i * 60_000
        c.execute("INSERT INTO paper_futures_candle_revisions VALUES(?,?,?,?,?,?,?)",
                  ("PF_ETHUSD:60000:%d" % b, 60_000, b, 1, b + 60_000, SENTINEL_PRICE, SENTINEL_PRICE))
    for i, (feed, rec) in enumerate([("ticker", H - 5), ("ticker", H + 5), ("trade", H - 5)]):
        c.execute("INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?)",
                  ("e%d" % i, feed, "PF_SOLUSD", rec, rec, SENTINEL_PRICE))
    c.commit()
    c.close()


def make_quotes(path):
    c = sqlite3.connect(path)
    c.executescript(QUOTES)
    c.execute("INSERT INTO quote_snapshot VALUES('PF_XBTUSD', ?, ?, ?)", (H - 10, SENTINEL_PRICE, SENTINEL_PRICE))
    c.execute("INSERT INTO quote_snapshot VALUES('PF_XBTUSD', ?, ?, ?)", (H + 10, SENTINEL_PRICE, SENTINEL_PRICE))
    c.commit()
    c.close()


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = os.path.join(self.dir.name, "capture.sqlite")
        self.qdb = os.path.join(self.dir.name, "quotes.sqlite")
        make_main(self.db)
        make_quotes(self.qdb)

    def run_inventory(self):
        main_db = inv._open_readonly(self.db)
        quotes_db = inv._open_readonly(self.qdb)
        try:
            return inv.build_inventory(main_db, quotes_db)
        finally:
            main_db.close()
            quotes_db.close()

    def rows(self, out, name):
        s = out["sections"][name]
        return [dict(zip(s["columns"], r)) for r in s["rows"]]

    def test_holdout_rows_are_not_counted_or_returned(self):
        out = self.run_inventory()
        funding = {r["product_id"]: r for r in self.rows(out, "funding_periods")}
        self.assertEqual(funding["PF_XBTUSD"]["rows"], 9)  # 12 inserted; end_ms < H is strict, so the one ending at H is cut too
        self.assertLess(funding["PF_XBTUSD"]["max_end_ms"], H + 1)
        self.assertLessEqual(funding["PF_XBTUSD"]["max_end_ms"], H - 1 + 1)
        candles = self.rows(out, "official_candles")[0]
        self.assertEqual(candles["rows"], 4)  # 6 inserted; the cut is on bucket_start, so 4 start before H
        self.assertLess(candles["max_bucket_start"], H)
        self.assertLess(candles["max_known_at"], H)
        self.assertEqual(candles["rows_known_after_cut"], 1)  # the 4th bucket is recorded at the cut: counted, not shown
        self.assertEqual(self.rows(out, "official_candle_responses")[0]["responses"], 1)
        ticker = self.rows(out, "ticker_events")[0]
        self.assertEqual(ticker["rows"], 1)  # only the pre-holdout ticker; trades are not counted
        self.assertEqual(self.rows(out, "quote_snapshot")[0]["rows"], 1)
        self.assertLess(self.rows(out, "quote_snapshot")[0]["max_received_at"], H)

    def test_gaps_and_off_grid_are_counted_arithmetically(self):
        out = self.run_inventory()
        gaps = {g["product_id"]: g for g in out["sections"]["funding_periods"]["derived_gaps"]}
        self.assertEqual(gaps["PF_ETHUSD"]["span_slots"], 3)
        self.assertEqual(gaps["PF_ETHUSD"]["missing_slots"], 1)
        self.assertEqual(gaps["PF_XBTUSD"]["missing_slots"], 0)
        self.assertEqual(self.rows(out, "funding_periods")[0]["starts_off_hour_grid"], 0)

    def test_capture_candles_product_comes_from_the_id(self):
        out = self.run_inventory()
        rows = self.rows(out, "capture_candles")
        self.assertEqual([r["product_id"] for r in rows], ["PF_ETHUSD"])
        self.assertEqual(rows[0]["rows"], 2)  # 4 minutes inserted; 2 start in the holdout
        self.assertIn("PF_XBTUSD", out["sections"]["capture_candles"]["products_without_rows"])

    def test_no_value_leaves_the_inventory(self):
        text = json.dumps(self.run_inventory())
        self.assertNotIn(SENTINEL_PRICE, text)
        self.assertNotIn(SENTINEL_RATE, text)

    def test_queries_touch_no_value_column_and_carry_the_cut(self):
        forbidden = (r"open_price", r"high_price", r"low_price", r"close_price", r"volume", r"funding_rate", r"raw_",
                     r"normalized_json", r"\bbid\b", r"\bask\b", r"SELECT \*", r"bids_json", r"asks_json",
                     r"\bmark\b", r"\blast\b")
        for name, (_, _, sql) in inv.QUERIES.items():
            for token in forbidden:
                self.assertNotRegex(sql, token, (name, token))
            self.assertIn("< %d" % H, sql, name)
            self.assertNotRegex(sql, r"(?i)\b(insert|update|delete|drop|alter|create|attach|pragma)\b", name)

    def test_database_is_opened_read_only_and_left_untouched(self):
        before = digest(self.db)
        conn = inv._open_readonly(self.db)
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("INSERT INTO paper_futures_market_events VALUES('x','ticker','PF_XBTUSD',1,1,'')")
        conn.close()
        self.run_inventory()
        self.assertEqual(before, digest(self.db))

    def test_backfilled_rows_recorded_after_the_cut_are_counted_by_event_time(self):
        """v1 cut on receipt time too, so every backfilled row (recorded months later) vanished: empty by construction."""
        bf = os.path.join(self.dir.name, "backfill.sqlite")
        c = sqlite3.connect(bf)
        c.executescript(SCHEMA)
        late = H + 40 * 24 * HOUR  # recorded long after the cut, describing events before it
        for i in range(3):
            start = H - (5 - i) * HOUR
            c.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)", ("b%d" % i, late, "t", "{}"))
            c.execute("INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
                      ("b%d" % i, start, start + HOUR, SENTINEL_RATE, late, "u", "PF_XBTUSD"))
        c.commit()
        c.close()
        conn = inv._open_readonly(bf)
        try:
            out = inv.build_inventory(conn)
        finally:
            conn.close()
        row = dict(zip(out["sections"]["funding_periods"]["columns"], out["sections"]["funding_periods"]["rows"][0]))
        self.assertEqual((row["rows"], row["rows_known_after_cut"]), (3, 3))
        self.assertIsNone(row["min_known_at"])  # no receipt time at or beyond the cut is ever returned
        self.assertIsNone(row["max_known_at"])
        resp = dict(zip(out["sections"]["funding_responses"]["columns"], out["sections"]["funding_responses"]["rows"][0]))
        self.assertEqual((resp["responses"], resp["responses_received_after_cut"]), (3, 3))
        self.assertIsNone(resp["max_received_at"])
        self.assertNotIn(str(late), json.dumps(out))

    def test_path_with_percent_and_hash_opens_the_right_file(self):
        odd = os.path.join(self.dir.name, "cap%41 #1?.sqlite")
        make_main(odd)
        conn = inv._open_readonly(odd)
        try:
            self.assertGreater(inv.build_inventory(conn)["sections"]["funding_periods"]["rows"][0][1], 0)
        finally:
            conn.close()

    def test_read_only_inventory_coexists_with_a_live_wal_writer(self):
        wal = os.path.join(self.dir.name, "wal.sqlite")
        writer = sqlite3.connect(wal, isolation_level=None)
        self.addCleanup(writer.close)
        self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.executescript(SCHEMA)
        writer.execute("INSERT INTO paper_futures_market_events VALUES('a','ticker','PF_XBTUSD',?,?,'')", (H - 9, H - 9))
        main_before = digest(wal)
        wal_before = os.path.getsize(wal + "-wal")
        reader = inv._open_readonly(wal)
        out = inv.build_inventory(reader)
        self.assertEqual(out["sections"]["ticker_events"]["rows"][0][1], 1)  # sees the uncheckpointed row
        # the writer is not blocked while the reader is open, and its commit reaches a fresh read
        writer.execute("INSERT INTO paper_futures_market_events VALUES('b','ticker','PF_XBTUSD',?,?,'')", (H - 8, H - 8))
        reader.close()
        self.assertEqual(main_before, digest(wal))  # no checkpoint by the reader
        self.assertGreaterEqual(os.path.getsize(wal + "-wal"), wal_before)
        again = inv._open_readonly(wal)
        try:
            self.assertEqual(inv.build_inventory(again)["sections"]["ticker_events"]["rows"][0][1], 2)
        finally:
            again.close()

    def test_missing_table_is_reported_as_unavailable_not_as_zero(self):
        c = sqlite3.connect(self.db)
        c.execute("DROP TABLE paper_futures_candle_revisions")
        c.commit()
        c.close()
        out = self.run_inventory()
        self.assertIn("unavailable", out["sections"]["capture_candles"])
        self.assertNotIn("rows", out["sections"]["capture_candles"])

    def test_without_quotes_db_the_section_is_unavailable(self):
        main_db = inv._open_readonly(self.db)
        out = inv.build_inventory(main_db, None)
        main_db.close()
        self.assertEqual(out["sections"]["quote_snapshot"], {"unavailable": "database not provided"})

    def test_cli_prints_json_without_the_path(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(inv.main(["--db", self.db, "--quotes-db", self.qdb]), 0)
        out = json.loads(buf.getvalue())
        self.assertEqual(out["source"]["db_name"], "capture.sqlite")
        self.assertNotIn(self.dir.name, buf.getvalue())
        self.assertTrue(out["holdout_excluded_in_sql"])

    def test_missing_file_is_an_error_not_an_empty_database(self):
        with self.assertRaises(FileNotFoundError):
            inv._open_readonly(os.path.join(self.dir.name, "nope.sqlite"))


if __name__ == "__main__":
    unittest.main()
