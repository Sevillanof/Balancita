"""Invented-data tests of capture_gap_diagnosis on a copy of the REAL schema. No real data is touched."""
import os
import sqlite3
import tempfile
import time
import unittest

from balancita_engine import capture_gap_diagnosis as g
from balancita_engine import capture_minimal_read as m

SCHEMA = open(os.path.join(os.path.dirname(__file__), "real_futures_schema.sql"), encoding="utf-8").read()
W0 = g.WINDOW[0]


def event(conn, product, feed, at, n, seq=None):
    conn.execute("INSERT INTO paper_futures_market_events (event_id,feed,product_id,epoch,seq,event_time,received_at,persisted_at,uid,"
                 "raw_json,normalized_json,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                 ("%s:%s:%d" % (feed, product, n), feed, product, 1, seq if seq is not None else n, at, at, at, None, "{}", "{}", "h%d" % n))


def gap(conn, product, feed, at, reason, n):
    conn.execute("INSERT INTO paper_futures_data_gaps (gap_id,feed,product_id,epoch,expected_seq,actual_seq,detected_at,reason,policy_version) "
                 "VALUES (?,?,?,?,?,?,?,?,?)", ("g%d" % n, feed, product, 1, 1, 2, at, reason, "p"))


class DiagTests(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.path = os.path.join(d, "dev-live", m.DB_NAME)
        os.makedirs(os.path.dirname(self.path))
        self.conn = sqlite3.connect(self.path)
        self.conn.executescript(SCHEMA)

    def run_diag(self, **caps):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        caps.setdefault("max_events", 1000)
        caps.setdefault("max_gaps", 100)
        return g.build_result(ro, read_date_ms=1, **caps)

    def test_counts_by_hour_and_feed_only_for_the_product_and_window(self):
        n = 0
        for hour, feed, count in ((0, "trade", 3), (0, "book", 2), (5, "trade", 4), (3, "ticker", 1)):
            for i in range(count):
                n += 1
                event(self.conn, m.BTC, feed, W0 + hour * g.HOUR_MS + i * 1000, n)
        for at in (W0 - 1, g.WINDOW[1], g.WINDOW[1] + 5):                 # outside the window: never counted
            n += 1
            event(self.conn, m.BTC, "trade", at, n)
        n += 1
        event(self.conn, m.ETH, "trade", W0 + 10, n)                       # other product
        result = self.run_diag()
        self.assertIsNone(result["stopped"])
        hours = {h["start_ms"]: h["by_feed"] for h in result["events"]["by_hour"]}
        self.assertEqual(hours[W0], {"trade": 3, "book": 2})
        self.assertEqual(hours[W0 + 3 * g.HOUR_MS], {"ticker": 1})
        self.assertEqual(hours[W0 + 5 * g.HOUR_MS], {"trade": 4})
        self.assertEqual(result["events"]["rows"], 10)
        self.assertEqual(result["classification"], "trades_received")

    def test_plans_are_searches_without_scan_or_temp_btree(self):
        for i in range(50):
            event(self.conn, m.BTC, "trade", W0 + i * 1000, i)
            gap(self.conn, m.BTC, "trade", W0 + i * 1000, "seq", i)
        result = self.run_diag()
        for read in ("events", "gaps"):
            plan = result[read]["plan"]
            self.assertTrue(any(d.startswith("SEARCH") for d in plan), plan)
            self.assertFalse([d for d in plan if "TEMP B-TREE" in d or (d.startswith("SCAN") and d.strip() != "SCAN w")], plan)

    def test_gaps_of_other_products_are_walked_but_not_exposed(self):
        gap(self.conn, m.BTC, "trade", W0 + 10, "seq", 1)
        gap(self.conn, m.ETH, "book", W0 + 20, "secret_reason_eth", 2)
        result = self.run_diag()
        self.assertEqual(result["gaps"]["rows_walked"], 2)
        self.assertEqual(result["gaps"]["rows_of_the_product"], 1)
        self.assertNotIn("secret_reason_eth", str(result))
        self.assertEqual(result["gaps"]["by_hour"][0]["by_feed_reason"], {"trade:seq": 1})

    def test_event_cap_counts_every_walked_event_and_publishes_no_counts_when_exceeded(self):
        for i in range(11):
            event(self.conn, m.BTC, "book", W0 + i, i)
        result = self.run_diag(max_events=10)
        self.assertEqual(result["stopped"]["reason"], "row_budget")
        self.assertNotIn("events", result)
        self.assertEqual(self.run_diag(max_events=11)["stopped"], None)

    def test_gaps_are_read_first_and_survive_an_events_stop(self):
        gap(self.conn, m.BTC, "trade", W0 + 10, "seq", 1)
        for i in range(5):
            event(self.conn, m.BTC, "book", W0 + i, i)
        result = self.run_diag(max_events=3)
        self.assertEqual(result["stopped"]["reason"], "row_budget")
        self.assertEqual(result["gaps"]["by_hour"][0]["by_feed_reason"], {"trade:seq": 1})
        self.assertNotIn("events", result)
        self.assertNotIn("classification", result)

    def test_both_statements_force_their_index_whatever_the_planner_thinks(self):
        # no ANALYZE here: the guarantee is the hint itself, so a statement without it must fail this test
        self.assertIn("INDEXED BY paper_futures_market_received", g.sql_events(10))
        self.assertIn("INDEXED BY paper_futures_data_gaps_detected_at", g.sql_gaps(10))

    def test_classification(self):
        self.assertEqual(self.run_diag()["classification"], "no_events")
        event(self.conn, m.BTC, "book", W0 + 5, 1)
        self.assertEqual(self.run_diag()["classification"], "events_without_trades")

    def test_caps_are_mandatory_and_positive(self):
        for bad in (0, -1, True, None):
            with self.assertRaises(m.Stopped):
                g._valid_cap(bad, "x")
        import contextlib
        import io
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            g.main(["--db", self.path])

    def test_the_authorizer_denies_other_columns_and_tables(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        guard = g._DiagGuard(ro, time.monotonic())
        for sql in ("SELECT raw_json FROM paper_futures_market_events WHERE rowid < 0",
                    "SELECT close_price FROM paper_futures_candle_revisions WHERE rowid < 0"):
            with self.assertRaises(sqlite3.DatabaseError):
                guard.fetch("events", sql)

    def test_it_carries_the_retention_caveat(self):
        self.assertIn("never recorded", self.run_diag()["retention_caveat"])


if __name__ == "__main__":
    unittest.main()
