"""Invented-data tests of capture_control_read on a copy of the REAL schema. No real data is touched."""
import contextlib
import io
import os
import sqlite3
import tempfile
import unittest

from balancita_engine import capture_control_read as c
from balancita_engine import capture_minimal_read as m

SCHEMA = open(os.path.join(os.path.dirname(__file__), "real_futures_schema.sql"), encoding="utf-8").read()
D0 = c.DAY0
H = c.HOUR_MS


def event(conn, product, feed, at, n):
    conn.execute("INSERT INTO paper_futures_market_events (event_id,feed,product_id,epoch,seq,event_time,received_at,persisted_at,uid,"
                 "raw_json,normalized_json,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                 ("%s:%s:%d" % (feed, product, n), feed, product, 1, n, at, at, at, None, "{}", "{}", "h%d" % n))


def gap(conn, at, n):
    conn.execute("INSERT INTO paper_futures_data_gaps (gap_id,feed,product_id,epoch,expected_seq,actual_seq,detected_at,reason,policy_version) "
                 "VALUES (?,?,?,?,?,?,?,?,?)", ("g%d" % n, "trade", m.BTC, 1, 1, 2, at, "seq", "p"))


def candle(conn, bucket, rev=1):
    conn.execute("INSERT INTO paper_futures_candle_revisions (candle_id,interval_ms,bucket_start,revision,known_at,close_at,is_closed,coverage,"
                 "open_price,high_price,low_price,close_price,volume_btc,trade_count,source_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                 ("%s:%d:%d" % (m.BTC, m.MINUTE_MS, bucket), m.MINUTE_MS, bucket, rev, bucket, bucket, 1, "full", "1", "1", "1", "1", "1", 1, "s"))


class ControlTests(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.path = os.path.join(d, "dev-live", m.DB_NAME)
        os.makedirs(os.path.dirname(self.path))
        self.conn = sqlite3.connect(self.path)
        self.conn.executescript(SCHEMA)

    def run_control(self, **caps):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        caps.setdefault("max_events", 1000)
        caps.setdefault("max_candles", 400)
        return c.build_result(ro, read_date_ms=1, **caps)

    def seed(self):
        n = 0
        for at, product, feed in ((D0 - 2 * H, m.BTC, "trade"), (D0 + 7 * H, m.BTC, "book"), (D0 + 7 * H + 5, m.BTC, "trade"),
                                  (D0 + H, m.ETH, "book"), (D0 + 20 * H, m.BTC, "book")):
            n += 1
            event(self.conn, product, feed, at, n)
        gap(self.conn, D0 - 5 * H, 1)
        gap(self.conn, D0 + 9 * H, 2)
        for b in (D0 - 10 * H, D0 + 6 * H, D0 + 6 * H + m.MINUTE_MS, D0 + 30 * H):
            candle(self.conn, b)

    def test_bounds_and_witnesses_on_invented_data(self):
        self.seed()
        r = self.run_control()
        self.assertIsNone(r["stopped"])
        b = r["bounds"]
        self.assertEqual(b["events_overall"], {"oldest": D0 - 2 * H, "newest": D0 + 20 * H})
        self.assertEqual(b["events_xbt"], {"oldest": D0 - 2 * H, "newest": D0 + 20 * H})
        self.assertEqual(b["events_eth"], {"oldest": D0 + H, "newest": D0 + H})
        self.assertEqual(b["gaps"], {"oldest": D0 - 5 * H, "newest": D0 + 9 * H})
        self.assertEqual(b["candles_xbt"], {"oldest": D0 - 10 * H, "newest": D0 + 30 * H})
        xa = r["witnesses"]["xbt_after"]
        self.assertEqual(xa["rows"], 2)
        self.assertEqual(xa["by_hour"][1]["count_by_feed"], {"book": 1, "trade": 1})
        self.assertEqual(r["witnesses"]["eth_same"]["by_hour"][1]["count_by_feed"], {"book": 1})
        self.assertEqual(r["witnesses"]["xbt_candles_after"]["rows"], 2)
        self.assertEqual(r["facts"], {"window_start_ms": D0, "purge_ruled_out": True, "xbt_events_after_window": True,
                                      "eth_events_in_window": True, "xbt_candles_after_window": True})
        self.assertEqual(r["rows_read"]["single_row_reads"], 10)
        self.assertEqual(r["rows_read"]["rows_walked"], 2 + 1 + 2)

    def test_purge_is_not_ruled_out_when_nothing_older_than_the_window_exists(self):
        event(self.conn, m.BTC, "book", D0 + 7 * H, 1)
        r = self.run_control()
        self.assertFalse(r["facts"]["purge_ruled_out"])
        self.assertFalse(r["facts"]["eth_events_in_window"])

    def test_empty_base_gives_none_not_errors(self):
        r = self.run_control()
        self.assertIsNone(r["stopped"])
        self.assertIsNone(r["bounds"]["events_overall"]["oldest"])
        self.assertFalse(r["facts"]["purge_ruled_out"])

    def test_every_plan_is_a_search_without_scan_or_temp_btree(self):
        self.seed()
        r = self.run_control()
        self.assertTrue(r["plans"])
        for d in r["plans"]:
            self.assertFalse(d.startswith("SCAN") or "TEMP B-TREE" in d, d)

    def test_witness_cap_stops_but_keeps_the_bounds(self):
        for i in range(6):
            event(self.conn, m.BTC, "book", D0 + 7 * H + i, i)
        r = self.run_control(max_events=5)
        self.assertEqual(r["stopped"]["reason"], "row_budget")
        self.assertIn("events_overall", r["bounds"])
        self.assertNotIn("xbt_after", r["witnesses"])
        self.assertNotIn("candle", str(r["witnesses"]))

    def test_candle_cap(self):
        for i in range(5):
            candle(self.conn, D0 + 6 * H + i * m.MINUTE_MS)
        self.assertEqual(self.run_control(max_candles=4)["stopped"]["reason"], "row_budget")
        self.assertIsNone(self.run_control(max_candles=5)["stopped"])

    def test_no_product_or_value_leaves_other_than_timestamps_and_counts(self):
        self.seed()
        text = str(self.run_control())
        for forbidden in ("raw_json", "normalized_json", "open_price", "close_price", "event_id"):
            self.assertNotIn(forbidden, text)

    def test_statements_force_their_indexes_without_analyze(self):
        for sql in (c._sql_bound_product("oldest"), c._sql_witness_events(c.WINDOW_XBT_AFTER, 10), c._sql_bound_gaps("newest")):
            self.assertIn("INDEXED BY", sql)
        for sql in (c._sql_bound_candles("oldest"), c._sql_witness_candles(c.WINDOW_XBT_AFTER, 10)):
            self.assertIn("INDEXED BY sqlite_autoindex_paper_futures_candle_revisions_1", sql)

    def test_the_authorizer_denies_other_columns(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        guard = c._Guard(ro, 0)
        for mode, sql in (("bound_rowid", "SELECT raw_json FROM paper_futures_market_events WHERE rowid >= 0 LIMIT 1"),
                          ("bound_gaps", "SELECT reason FROM paper_futures_data_gaps WHERE detected_at >= 0 LIMIT 1"),
                          ("bound_candles", "SELECT close_price FROM paper_futures_candle_revisions LIMIT 1")):
            with self.assertRaises(sqlite3.DatabaseError):
                guard.fetch(mode, sql)

    def test_caps_are_mandatory(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            c.main(["--db", self.path])


if __name__ == "__main__":
    unittest.main()
