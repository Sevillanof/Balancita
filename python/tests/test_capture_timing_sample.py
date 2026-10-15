import hashlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from balancita_engine import capture_timing_sample as cts

W0, W1 = cts.WINDOW_START_MS, cts.WINDOW_END_MS
XBT, ETH, SOL = "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"
SENTINEL_PRICE = "98765.4321"
SENTINEL_RATE = "0.000123456"
SENTINEL_BODY = "RAWBODY-SENTINEL"

SCHEMA = """
CREATE TABLE paper_futures_funding_responses(sha256 TEXT PRIMARY KEY, received_at INTEGER NOT NULL,
  server_time TEXT NOT NULL, raw_response TEXT NOT NULL) STRICT;
CREATE TABLE paper_futures_funding_periods(response_sha256 TEXT NOT NULL, start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL, funding_rate TEXT NOT NULL, known_at INTEGER NOT NULL, unit TEXT NOT NULL,
  product_id TEXT NOT NULL, PRIMARY KEY(response_sha256, start_ms)) STRICT;
CREATE TABLE paper_futures_official_candles(product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL, revision_hash TEXT NOT NULL, known_at INTEGER NOT NULL, open_price TEXT NOT NULL,
  high_price TEXT NOT NULL, low_price TEXT NOT NULL, close_price TEXT NOT NULL, volume_btc TEXT NOT NULL,
  response_sha256 TEXT NOT NULL, PRIMARY KEY(product_id, interval_ms, bucket_start, revision_hash)) STRICT;
CREATE TABLE paper_futures_candle_revisions(candle_id TEXT NOT NULL, interval_ms INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL, revision INTEGER NOT NULL, known_at INTEGER NOT NULL, close_at INTEGER,
  is_closed INTEGER NOT NULL, open_price TEXT NOT NULL, close_price TEXT NOT NULL, volume_btc TEXT NOT NULL,
  PRIMARY KEY(candle_id, revision)) STRICT;
CREATE TABLE paper_futures_market_events(event_id TEXT PRIMARY KEY, feed TEXT NOT NULL, product_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, seq INTEGER NOT NULL, event_time INTEGER NOT NULL, received_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL, normalized_json TEXT NOT NULL) STRICT;
CREATE INDEX paper_futures_market_received ON paper_futures_market_events(product_id, received_at, seq);
CREATE TABLE paper_futures_data_gaps(gap_id TEXT PRIMARY KEY, feed TEXT NOT NULL, product_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, detected_at INTEGER NOT NULL, reason TEXT NOT NULL) STRICT;
"""


def digest(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def make_db(path):
    c = sqlite3.connect(path)
    c.executescript(SCHEMA)
    n = [0]

    def tick(product, epoch, seq, event_time, received_at, feed="ticker"):
        n[0] += 1
        c.execute("INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?,?,?,?)",
                  ("e%d" % n[0], feed, product, epoch, seq, event_time, received_at, SENTINEL_BODY, SENTINEL_PRICE))

    # XBT ticker: received_at 1 s, 2 s, 20 s, 50 s after the window start, plus a seq regression; lags 100/200/300/400
    for seq, (ev, rec, epoch) in enumerate([(W0 + 900, W0 + 1_000, 1), (W0 + 1_800, W0 + 2_000, 1),
                                           (W0 + 19_700, W0 + 20_000, 1), (W0 + 49_600, W0 + 50_000, 1)]):
        tick(XBT, epoch, seq + 1, ev, rec)
    tick(XBT, 1, 4, W0 + 60_000, W0 + 60_100)  # seq 4 again in the same epoch: not increasing
    tick(XBT, 2, 1, W0 + 70_000, W0 + 70_100)  # a new epoch restarts seq: fine
    tick(ETH, 1, 1, W0 + 5_000, W0 + 5_050)
    # outside the window, other feed, other product: never counted
    tick(XBT, 1, 99, W0 - 1, W0 - 1)
    tick(XBT, 1, 100, W1, W1 + 5)
    tick(XBT, 1, 101, W0 + 10, W0 + 10, feed="trade")
    tick(SOL, 1, 1, W0 + 10, W0 + 10)
    tick(XBT, 1, 102, W1 - 100, W1 + 50)  # event inside the window, recorded after it: left out
    tick(XBT, 1, 103, W0 - 50, W0 + 50)  # recorded inside the window, event before it: left out

    def candle(product, bucket, revision, known_at, closed):
        c.execute("INSERT INTO paper_futures_candle_revisions VALUES(?,?,?,?,?,?,?,?,?,?)",
                  ("%s:300000:%d" % (product, bucket), 300_000, bucket, revision, known_at, None, closed,
                   SENTINEL_PRICE, SENTINEL_PRICE, SENTINEL_PRICE))

    candle(XBT, W0, 1, W0 + 300_500, 0)
    candle(XBT, W0, 2, W0 + 301_000, 1)
    candle(XBT, W0 + 300_000, 1, W0 + 600_200, 1)
    candle(ETH, W0, 1, W0 + 300_100, 1)
    candle(XBT, W0 - 300_000, 1, W0, 1)  # before the window
    candle(XBT, W1, 1, W1 + 400_000, 1)  # at the end of the window (exclusive)
    candle(SOL, W0, 1, W0 + 300_100, 1)
    c.execute("INSERT INTO paper_futures_candle_revisions VALUES(?,?,?,?,?,?,?,?,?,?)",
              ("%s:60000:%d" % (XBT, W0), 60_000, W0, 1, W0 + 60_100, None, 1, "1", "1", "1"))  # 1 m: not 5 m

    def funding(product, sha, start, received_at, server_time):
        c.execute("INSERT OR IGNORE INTO paper_futures_funding_responses VALUES(?,?,?,?)",
                  (sha, received_at, server_time, SENTINEL_BODY))
        c.execute("INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
                  (sha, start, start + 3_600_000, SENTINEL_RATE, received_at, "u", product))

    funding(XBT, "x1", W0, W0 + 3_700_000, "2026-10-15T07:01:40.500Z")  # server 3 100 ms before... see test
    funding(XBT, "x1", W0 + 3_600_000, W0 + 3_700_000, "2026-10-15T07:01:40.500Z")
    funding(XBT, "x2", W0 + 7_200_000, W0 + 7_300_000, "not a timestamp")
    funding(ETH, "y1", W0, W0 + 3_650_000, "2026-10-15T07:00:50Z")
    funding(XBT, "late", W0 + 10_800_000, W1 + 1_000, "2026-10-15T12:00:01Z")  # history repeated after the window
    funding(XBT, "late2", W0 + 14_400_000, W1 + 84_600_000, "2026-10-16T11:30:00Z")  # a response 23.5 h after
    funding(XBT, "xo", W0 - 3_600_000, W0 + 100, "2026-10-15T06:00:00Z")  # period before the window
    funding(XBT, "xe", W1, W1 + 100, "2026-10-15T12:00:00Z")  # period starting at the end: excluded

    for i, (product, reason, at) in enumerate([(XBT, "seq_gap", W0 + 1), (XBT, "seq_gap", W0 + 9), (XBT, "reconnect", W0 + 5),
                                               (ETH, "seq_gap", W0 + 2), (XBT, "seq_gap", W1 + 1), (SOL, "seq_gap", W0 + 3)]):
        c.execute("INSERT INTO paper_futures_data_gaps VALUES(?,?,?,?,?,?)", ("g%d" % i, "ticker", product, 1, at, reason))

    for i, (product, bucket) in enumerate([(XBT, W0), (XBT, W0 + 300_000), (ETH, W0), (XBT, W1)]):
        c.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                  (product, 300_000, bucket, "h%d" % i, bucket + 400_000, SENTINEL_PRICE, "1", "1", "1", "1", "s"))
    c.commit()
    c.close()


class TimingSampleTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = os.path.join(self.dir.name, "capture.sqlite")
        make_db(self.db)

    def sample(self):
        conn = cts._open_readonly(self.db)
        try:
            return cts.build_sample(conn)
        finally:
            conn.close()

    def test_window_is_fixed_and_exclusive_at_the_end(self):
        self.assertEqual((W0, W1), (1_792_044_000_000, 1_792_065_600_000))
        out = self.sample()
        self.assertIsNone(out["stopped"])
        self.assertEqual(out["row_counts"], {"ticker": 7, "candles_5m": 4, "funding": 4, "data_gaps": 4,
                                             "official_candles_5m": 3})

    def test_ticker_counters(self):
        xbt = self.sample()["sections"]["ticker"][XBT]
        self.assertEqual(xbt["rows"], 6)
        self.assertEqual(xbt["epochs"], 2)
        self.assertEqual(xbt["min_event_time"], W0 + 900)
        self.assertEqual(xbt["max_received_at"], W0 + 70_100)
        self.assertEqual(xbt["seq_not_increasing_within_epoch"], 1)
        # received_at gaps: 1 000, 18 000, 30 000, 10 100, 10 000
        self.assertEqual(xbt["max_silence_ms"], 30_000)
        self.assertEqual(xbt["silences_over_ms"], {"15000": 2, "25000": 1, "45000": 0})
        lag = xbt["received_minus_event_ms"]
        self.assertEqual((lag["n"], lag["min"], lag["max"]), (6, 100, 400))
        self.assertEqual(xbt["negative_received_minus_event"], 0)
        self.assertEqual(self.sample()["sections"]["ticker"][ETH]["rows"], 1)

    def test_candles_and_official_existence(self):
        out = self.sample()["sections"]
        xbt = out["candles_5m"][XBT]
        self.assertEqual((xbt["revisions"], xbt["distinct_buckets"], xbt["expected_buckets"]), (3, 2, 72))
        self.assertEqual(xbt["missing_buckets"], 70)
        self.assertEqual(xbt["buckets_with_a_closed_revision"], 2)
        self.assertEqual(xbt["known_at_minus_bucket_end_ms"]["min"], 200)
        self.assertEqual(out["candles_5m"][ETH]["revisions"], 1)
        self.assertEqual(out["official_candles_5m"][XBT]["rows"], 2)
        self.assertEqual(out["official_candles_5m"][XBT]["max_bucket_start"], W0 + 300_000)
        self.assertEqual(out["official_candles_5m"][ETH]["rows"], 1)

    def test_funding_periods_and_clock_offset(self):
        out = self.sample()["sections"]["funding"]
        xbt = out[XBT]
        self.assertEqual((xbt["periods"], xbt["expected_periods"], xbt["missing_periods"]), (3, 6, 3))
        self.assertEqual(xbt["responses"], 2)
        self.assertEqual(xbt["responses_with_unparseable_server_time"], 1)
        # x1 received at W0+3 700 000 ms = 07:01:40.000Z; server_time 07:01:40.500Z -> -500 ms
        self.assertEqual(xbt["received_minus_server_time_ms"], {"min": -500, "max": -500})
        self.assertEqual(out[ETH]["received_minus_server_time_ms"], {"min": 0, "max": 0})
        self.assertEqual(out[ETH]["periods"], 1)

    def test_data_gaps_by_product_and_reason(self):
        out = self.sample()["sections"]["data_gaps"]
        self.assertEqual(out[XBT]["seq_gap"], {"count": 2, "min_detected_at": W0 + 1, "max_detected_at": W0 + 9})
        self.assertEqual(out[XBT]["reconnect"]["count"], 1)
        self.assertEqual(out[ETH]["seq_gap"]["count"], 1)

    def test_late_responses_and_late_receipts_are_outside_the_window(self):
        out = self.sample()
        self.assertEqual(out["sections"]["funding"][XBT]["max_received_at"], W0 + 7_300_000)
        self.assertEqual(out["sections"]["funding"][XBT]["responses"], 2)
        self.assertLess(out["sections"]["ticker"][XBT]["max_received_at"], W1)
        self.assertGreaterEqual(out["sections"]["ticker"][XBT]["min_received_at"], W0)

    def test_ticker_query_uses_the_received_at_index(self):
        conn = cts._open_readonly(self.db)
        plan = " ".join(str(r) for r in conn.execute("EXPLAIN QUERY PLAN " + cts.SQL["ticker"][1]).fetchall())
        conn.close()
        self.assertIn("paper_futures_market_received", plan)
        self.assertNotIn("SCAN paper_futures_market_events", plan.replace("USING INDEX", ""))

    def test_no_market_value_reaches_the_output(self):
        text = json.dumps(self.sample())
        for forbidden in (SENTINEL_PRICE, SENTINEL_RATE, SENTINEL_BODY, SOL):
            self.assertNotIn(forbidden, text)

    def test_authorizer_denies_every_unlisted_column(self):
        conn = cts._open_readonly(self.db)
        conn.set_authorizer(cts._authorizer)
        for sql in ("SELECT close_price FROM paper_futures_candle_revisions",
                    "SELECT open_price FROM paper_futures_official_candles",
                    "SELECT raw_json FROM paper_futures_market_events",
                    "SELECT normalized_json FROM paper_futures_market_events",
                    "SELECT raw_response FROM paper_futures_funding_responses",
                    "SELECT funding_rate FROM paper_futures_funding_periods",
                    "SELECT * FROM paper_futures_market_events",
                    "SELECT 1 FROM sqlite_master"):
            with self.assertRaises(sqlite3.DatabaseError, msg=sql):
                conn.execute(sql).fetchall()
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM paper_futures_market_events").fetchone()[0], 13)
        conn.close()

    def test_authorizer_denies_writes_and_pragmas(self):
        conn = sqlite3.connect(self.db)
        conn.set_authorizer(cts._authorizer)
        for sql in ("INSERT INTO paper_futures_data_gaps VALUES('z','t','PF_XBTUSD',1,1,'r')",
                    "DELETE FROM paper_futures_data_gaps", "PRAGMA writable_schema = ON",
                    "ATTACH DATABASE ':memory:' AS other"):
            with self.assertRaises(sqlite3.DatabaseError, msg=sql):
                conn.execute(sql)
        conn.close()

    def test_every_query_only_uses_allowed_columns(self):
        conn = cts._open_readonly(self.db)
        conn.set_authorizer(cts._authorizer)
        for name, (count_sql, rows_sql) in cts.SQL.items():
            conn.execute(count_sql).fetchall()
            conn.execute(rows_sql).fetchall()
        conn.close()

    def test_other_window_or_products_are_refused(self):
        conn = cts._open_readonly(self.db)
        self.addCleanup(conn.close)
        with self.assertRaises(ValueError):
            cts.build_sample(conn, window=(W0, W1 + 1))
        with self.assertRaises(ValueError):
            cts.build_sample(conn, window=(W0 - 1, W1))
        with self.assertRaises(ValueError):
            cts.build_sample(conn, products=(XBT, ETH, SOL))
        with self.assertRaises(SystemExit):
            cts.main(["--db", self.db, "--from", "0"])

    def test_row_budget_stops_before_fetching_rows(self):
        with mock.patch.object(cts, "ROW_BUDGET", 5):
            out = self.sample()
        self.assertEqual(out["stopped"]["reason"], "row_budget")
        self.assertEqual(out["sections"], {})
        self.assertEqual(out["stopped"]["detail"]["total"], 22)

    def test_query_time_limit_stops(self):
        with mock.patch.object(cts, "QUERY_TIMEOUT_S", -1), mock.patch.object(cts, "PROGRESS_OPS", 1):
            out = self.sample()
        self.assertEqual(out["stopped"]["reason"], "query_time_limit")
        self.assertEqual(out["sections"], {})

    def test_missing_table_is_reported_not_crashed(self):
        c = sqlite3.connect(self.db)
        c.execute("DROP TABLE paper_futures_data_gaps")
        c.commit()
        c.close()
        out = self.sample()
        self.assertEqual(out["stopped"]["reason"], "database_error")

    def test_mode_ro_rejects_writes_without_the_pragma_or_the_authorizer(self):
        conn = sqlite3.connect("file:%s?mode=ro" % self.db, uri=True)  # no query_only, no authorizer
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("INSERT INTO paper_futures_data_gaps VALUES('z','t','PF_XBTUSD',1,1,'r')")
        conn.close()
        ours = cts._open_readonly(self.db)
        self.assertEqual(ours.execute("PRAGMA query_only").fetchone()[0], 1)
        with self.assertRaises(sqlite3.OperationalError):
            ours.execute("DELETE FROM paper_futures_data_gaps")
        ours.close()

    def test_connection_that_is_not_query_only_is_refused_and_reports_the_readback(self):
        conn = sqlite3.connect("file:%s?mode=ro" % self.db, uri=True)
        self.addCleanup(conn.close)
        out = cts.build_sample(conn)
        self.assertEqual(out["stopped"]["reason"], "connection_not_query_only")
        self.assertEqual(out["sections"], {})
        self.assertEqual(self.sample()["guards"], {"opened_with": "mode=ro", "query_only_readback": 1})

    def test_edge_limits_and_last_hour_are_stated(self):
        out = self.sample()
        self.assertEqual(len(out["edge_limits"]), 3)
        xbt = out["sections"]["funding"][XBT]
        self.assertEqual(xbt["missing_periods"], 3)
        # starts present: hours 0, 1, 2 (+ 3 and 4 are "late" responses, excluded): 5 observable starts expected
        self.assertEqual(xbt["missing_periods_excluding_last_hour"], 5 - 3)

    def test_read_only_and_cli_output(self):
        before = digest(self.db)
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cts.main(["--db", self.db])
        self.assertEqual(code, 0)
        self.assertEqual(digest(self.db), before)
        out = json.loads(buf.getvalue())
        self.assertEqual(out["source"]["db_name"], "capture.sqlite")
        self.assertNotIn(self.dir.name, buf.getvalue())
        self.assertEqual(out["tool_version"], cts.TOOL_VERSION)
        body = {k: v for k, v in out.items() if k != "fingerprint_sha256"}
        self.assertEqual(out["fingerprint_sha256"], cts.fingerprint(body))

    def test_links_and_missing_files_are_refused(self):
        link = os.path.join(self.dir.name, "link.sqlite")
        os.symlink(self.db, link)
        with self.assertRaises(FileNotFoundError):
            cts._open_readonly(link)
        with self.assertRaises(FileNotFoundError):
            cts._open_readonly(os.path.join(self.dir.name, "nope.sqlite"))

    def test_deterministic(self):
        self.assertEqual(json.dumps(self.sample(), sort_keys=True), json.dumps(self.sample(), sort_keys=True))


if __name__ == "__main__":
    unittest.main()
