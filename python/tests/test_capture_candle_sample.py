import hashlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from balancita_engine import capture_candle_sample as ccs
from balancita_engine import capture_timing_sample as cts
from test_capture_timing_sample import SCHEMA, SENTINEL_BODY, SENTINEL_PRICE, digest

W0, W1 = ccs.WINDOW_START_MS, ccs.WINDOW_END_MS
XBT, ETH, SOL = "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"
M1, M5, H1 = 60_000, 300_000, 3_600_000


def make_db(path):
    c = sqlite3.connect(path)
    c.executescript(SCHEMA)

    def candle(product, interval, bucket, revision, known_at, closed=1):
        c.execute("INSERT INTO paper_futures_candle_revisions VALUES(?,?,?,?,?,?,?,?,?,?)",
                  ("%s:%d:%d" % (product, interval, bucket), interval, bucket, revision, known_at, None, closed,
                   SENTINEL_PRICE, SENTINEL_PRICE, SENTINEL_PRICE))

    # XBT 1 m: every minute except 07:00-07:10 (10 minutes); two revisions at the first bucket
    missing = set(range(W0 + H1, W0 + H1 + 10 * M1, M1))
    for b in range(W0, W1, M1):
        if b not in missing:
            candle(XBT, M1, b, 1, b + M1 + 200)
    candle(XBT, M1, W0, 2, W0 + M1 + 900)
    candle(XBT, H1, W0, 1, W0 + H1 + 100, closed=1)  # one hourly candle only
    candle(ETH, M5, W0, 1, W0 + M5 + 100)  # ETH: a single 5 m candle
    candle(XBT, M1, W0 - M1, 1, W0)  # before the window
    candle(XBT, M1, W1, 1, W1 + M1)  # at the end (exclusive)
    candle(SOL, M1, W0, 1, W0 + M1)  # another product

    n = [0]

    def trade(product, epoch, seq, event_time, received_at, feed="trade"):
        n[0] += 1
        c.execute("INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?,?,?,?)",
                  ("t%d" % n[0], feed, product, epoch, seq, event_time, received_at, SENTINEL_BODY, SENTINEL_PRICE))

    for i, (ev, rec) in enumerate([(W0 + 500, W0 + 600), (W0 + 20_500, W0 + 20_700), (W0 + 21_000, W0 + 21_100)]):
        trade(XBT, 1, i + 1, ev, rec)
    trade(ETH, 1, 1, W0 + 10, W0 + 10)
    trade(XBT, 1, 50, W0 - 5, W0 - 5)  # outside
    trade(XBT, 1, 51, W1 - 5, W1 + 5)  # recorded after the window
    trade(XBT, 1, 52, W0 + 5, W0 + 5, feed="ticker")  # other feed
    trade(SOL, 1, 1, W0 + 5, W0 + 5)
    c.commit()
    c.close()


class CandleSampleTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = os.path.join(self.dir.name, "capture.sqlite")
        make_db(self.db)

    def sample(self):
        conn = cts._open_readonly(self.db)
        try:
            return ccs.build_sample(conn)
        finally:
            conn.close()

    def test_candles_per_interval(self):
        out = self.sample()
        self.assertIsNone(out["stopped"])
        xbt = out["sections"]["candles"][XBT]
        self.assertEqual(xbt["intervals_present"], [M1, H1])
        m1 = xbt["by_interval_ms"][str(M1)]
        self.assertEqual((m1["distinct_buckets"], m1["expected_buckets"], m1["missing_buckets"]), (350, 360, 10))
        self.assertEqual(m1["revisions"], 351)
        self.assertEqual(m1["off_grid_buckets"], 0)
        self.assertEqual(m1["missing_runs"]["count"], 1)
        self.assertEqual(m1["missing_runs"]["longest"], [{"start_ms": W0 + H1, "buckets": 10}])
        self.assertEqual(m1["known_at_minus_bucket_end_ms"]["min"], 200)
        self.assertEqual(m1["known_at_minus_bucket_end_ms"]["max"], 900)
        h1 = xbt["by_interval_ms"][str(H1)]
        self.assertEqual((h1["distinct_buckets"], h1["expected_buckets"], h1["missing_buckets"]), (1, 6, 5))
        self.assertEqual(h1["missing_runs"]["longest"], [{"start_ms": W0 + H1, "buckets": 5}])
        eth = out["sections"]["candles"][ETH]
        self.assertEqual(eth["intervals_present"], [M5])
        self.assertEqual(eth["by_interval_ms"][str(M5)]["missing_buckets"], 71)

    def test_product_without_candles_reports_nothing_present(self):
        c = sqlite3.connect(self.db)
        c.execute("DELETE FROM paper_futures_candle_revisions WHERE candle_id LIKE 'PF_ETHUSD%'")
        c.commit()
        c.close()
        eth = self.sample()["sections"]["candles"][ETH]
        self.assertEqual(eth, {"intervals_present": [], "by_interval_ms": {}})

    def test_trades(self):
        out = self.sample()
        self.assertEqual(out["row_counts"]["trades"], 4)
        xbt = out["sections"]["trades"][XBT]
        self.assertEqual(xbt["rows"], 3)
        self.assertEqual(xbt["max_silence_ms"], 20_100)
        self.assertEqual(xbt["silences_over_ms"], {"15000": 1, "25000": 0, "45000": 0})
        self.assertEqual(xbt["received_minus_event_ms"]["max"], 200)
        self.assertEqual(out["sections"]["trades"][ETH]["rows"], 1)
        self.assertLess(xbt["max_received_at"], W1)

    def test_no_market_value_reaches_the_output(self):
        text = json.dumps(self.sample())
        for forbidden in (SENTINEL_PRICE, SENTINEL_BODY, SOL):
            self.assertNotIn(forbidden, text)

    def test_every_query_only_uses_allowed_columns(self):
        conn = cts._open_readonly(self.db)
        conn.set_authorizer(cts._authorizer)
        for count_sql, rows_sql in ccs.SQL.values():
            conn.execute(count_sql).fetchall()
            conn.execute(rows_sql).fetchall()
        conn.close()

    def test_other_window_or_products_are_refused(self):
        conn = cts._open_readonly(self.db)
        self.addCleanup(conn.close)
        with self.assertRaises(ValueError):
            ccs.build_sample(conn, window=(W0, W1 + 1))
        with self.assertRaises(ValueError):
            ccs.build_sample(conn, products=(XBT, ETH, SOL))
        with self.assertRaises(SystemExit):
            ccs.main(["--db", self.db, "--from", "0"])

    def test_guards_budget_time_and_query_only(self):
        with mock.patch.object(cts, "ROW_BUDGET", 5):
            out = self.sample()
        self.assertEqual(out["stopped"]["reason"], "row_budget")
        self.assertEqual(out["sections"], {})
        with mock.patch.object(cts, "QUERY_TIMEOUT_S", -1), mock.patch.object(cts, "PROGRESS_OPS", 1):
            self.assertEqual(self.sample()["stopped"]["reason"], "query_time_limit")
        conn = sqlite3.connect("file:%s?mode=ro" % self.db, uri=True)
        self.addCleanup(conn.close)
        self.assertEqual(ccs.build_sample(conn)["stopped"]["reason"], "connection_not_query_only")
        self.assertEqual(self.sample()["guards"], {"opened_with": "mode=ro", "query_only_readback": 1})

    def test_missing_table_is_reported(self):
        c = sqlite3.connect(self.db)
        c.execute("DROP TABLE paper_futures_candle_revisions")
        c.commit()
        c.close()
        self.assertEqual(self.sample()["stopped"]["reason"], "database_error")

    def test_read_only_and_cli_output(self):
        before = digest(self.db)
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = ccs.main(["--db", self.db])
        self.assertEqual(code, 0)
        self.assertEqual(digest(self.db), before)
        out = json.loads(buf.getvalue())
        self.assertEqual(out["source"]["db_name"], "capture.sqlite")
        self.assertNotIn(self.dir.name, buf.getvalue())
        body = {k: v for k, v in out.items() if k != "fingerprint_sha256"}
        self.assertEqual(out["fingerprint_sha256"], ccs.fingerprint(body))

    def test_tiny_and_huge_intervals_do_not_blow_up(self):
        c = sqlite3.connect(self.db)
        for interval, bucket in ((1, W0 + 5), (W1 - W0 + 1, W0)):
            c.execute("INSERT INTO paper_futures_candle_revisions VALUES(?,?,?,?,?,?,?,?,?,?)",
                      ("PF_ETHUSD:%d:%d" % (interval, bucket), interval, bucket, 1, bucket + interval, None, 1, "1", "1", "1"))
        c.commit()
        c.close()
        eth = self.sample()["sections"]["candles"][ETH]["by_interval_ms"]
        self.assertEqual(eth["1"]["distinct_buckets"], 1)
        self.assertEqual(eth[str(W1 - W0 + 1)]["expected_buckets"], 0)
        self.assertIsNone(eth[str(W1 - W0 + 1)]["missing_runs"])


if __name__ == "__main__":
    unittest.main()
