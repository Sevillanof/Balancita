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


def event(conn, product, feed, at, n, persisted=None):
    conn.execute("INSERT INTO paper_futures_market_events (event_id,feed,product_id,epoch,seq,event_time,received_at,persisted_at,uid,"
                 "raw_json,normalized_json,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                 ("%s:%s:%d" % (feed, product, n), feed, product, 1, n, at, at, at if persisted is None else persisted, None, "{}", "{}", "h%d" % n))


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
        for at, product, feed in ((D0 - 2 * H, m.BTC, "trade"), (D0 + H, m.ETH, "book"), (D0 + 7 * H, m.BTC, "book"),
                                  (D0 + 7 * H + 5, m.BTC, "trade"), (D0 + 20 * H, m.BTC, "book")):
            n += 1
            event(self.conn, product, feed, at, n)
        gap(self.conn, D0 - 5 * H, 1)
        gap(self.conn, D0 + 9 * H, 2)
        for b in (D0 - 10 * H, D0 + 6 * H, D0 + 6 * H + m.MINUTE_MS, D0 + 30 * H):
            candle(self.conn, b)

    def test_bounds_probe_and_inferences_on_invented_data(self):
        self.seed()
        r = self.run_control()
        self.assertIsNone(r["stopped"])
        b = r["bounds"]
        self.assertEqual(b["events_overall"]["oldest"], {"rowid": 1, "received_at": D0 - 2 * H, "event_time": D0 - 2 * H,
                                                         "persisted_at": D0 - 2 * H})
        self.assertEqual(b["events_overall"]["newest"]["received_at"], D0 + 20 * H)
        self.assertEqual(b["events_xbt"]["oldest"], {"received_at": D0 - 2 * H, "event_time": D0 - 2 * H, "persisted_at": D0 - 2 * H})
        self.assertEqual(b["events_eth"]["newest"]["received_at"], D0 + H)
        self.assertEqual(b["gaps"], {"oldest": D0 - 5 * H, "newest": D0 + 9 * H})
        self.assertEqual(b["candles_xbt"], {"oldest": D0 - 10 * H, "newest": D0 + 30 * H})
        xa = r["witnesses"]["xbt_after"]
        self.assertEqual(xa["rows"], 2)
        self.assertEqual(xa["by_hour"][1]["count_by_feed"], {"book": 1, "trade": 1})
        self.assertEqual(r["witnesses"]["eth_same"]["by_hour"][1]["count_by_feed"], {"book": 1})
        self.assertEqual(r["witnesses"]["xbt_candles_after"]["rows"], 2)
        self.assertEqual(r["witnesses"]["xbt_candles_before"]["rows"], 0)
        self.assertTrue(r["probe"]["monotone_nondecreasing"])
        inf = r["inferences"]
        self.assertIs(inf["window_not_trimmed_by_retention"]["holds"], True)
        self.assertIs(inf["own_candles_absence_not_explained_by_retention"]["holds"], False)   # no candles before the window
        self.assertEqual(r["rows_read"]["single_row_reads"], 10 + len(r["probe"]["points"]))
        self.assertLessEqual(r["rows_read"]["total"], r["rows_read"]["total_cap"])
        self.assertNotIn("purge_ruled_out", r)

    def test_candles_inference_needs_candles_on_both_sides(self):
        candle(self.conn, D0 - 3 * H)
        candle(self.conn, D0 + 7 * H)
        r = self.run_control()
        self.assertIs(r["inferences"]["own_candles_absence_not_explained_by_retention"]["holds"], True)

    def test_a_newer_oldest_event_is_undetermined_not_purged(self):
        event(self.conn, m.BTC, "book", D0 + 7 * H, 1)
        inf = self.run_control()["inferences"]["window_not_trimmed_by_retention"]
        self.assertIsNone(inf["holds"])
        self.assertIn("undetermined", inf["says"])
        self.assertIn("never having been captured", inf["says"])

    def test_non_monotone_rowid_makes_the_retention_inference_undetermined(self):
        event(self.conn, m.BTC, "book", D0 - 2 * H, 1)
        event(self.conn, m.BTC, "book", D0 + 7 * H, 2)
        event(self.conn, m.BTC, "book", D0 - H, 3)          # late load: high rowid, old received_at
        r = self.run_control()
        self.assertFalse(r["probe"]["monotone_nondecreasing"])
        self.assertIsNotNone(r["probe"]["first_inversion"])
        self.assertIsNone(r["inferences"]["window_not_trimmed_by_retention"]["holds"])

    def test_probe_is_bounded_and_reads_single_rows(self):
        for i in range(200):
            event(self.conn, m.BTC, "book", D0 - 2 * H + i, i)
        r = self.run_control()
        self.assertEqual(len(r["probe"]["points"]), c.PROBES - 1 if len(r["probe"]["points"]) < c.PROBES else c.PROBES)
        self.assertLessEqual(r["rows_read"]["single_row_reads"], c.SINGLE_MAX)

    def test_oldest_rowid_above_one_is_reported_as_an_observation(self):
        for i in range(5):
            event(self.conn, m.BTC, "book", D0 + i, i)
        for (name,) in self.conn.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'").fetchall():
            self.conn.execute("DROP TRIGGER " + name)
        self.conn.execute("DELETE FROM paper_futures_market_events WHERE rowid <= 2")
        self.conn.commit()
        obs = self.run_control()["inferences"]["observations"]
        self.assertTrue(obs["oldest_rowid_above_1"])

    def test_a_late_load_at_the_lowest_rowid_is_undetermined(self):
        """D-216-04: received_at is old but it was stored after the window start, so a prefix deletion could have removed the window first."""
        event(self.conn, m.BTC, "book", D0 - 2 * H, 1, persisted=D0 + 8 * H)
        event(self.conn, m.BTC, "book", D0 + 7 * H, 2)
        r = self.run_control()
        self.assertTrue(r["probe"]["monotone_nondecreasing"])
        inf = r["inferences"]["window_not_trimmed_by_retention"]
        self.assertIsNone(inf["holds"])
        self.assertIn("late load", inf["says"])
        self.assertEqual(r["inferences"]["observations"]["oldest_event_persisted_at_ms"], D0 + 8 * H)

    def test_the_boundary_is_inclusive_on_both_clocks(self):
        event(self.conn, m.BTC, "book", D0, 1)
        self.assertIs(self.run_control()["inferences"]["window_not_trimmed_by_retention"]["holds"], True)

    def test_one_millisecond_after_the_boundary_is_undetermined(self):
        event(self.conn, m.BTC, "book", D0 + 1, 1)
        self.assertIsNone(self.run_control()["inferences"]["window_not_trimmed_by_retention"]["holds"])
        other = tempfile.mkdtemp()
        path = os.path.join(other, "dev-live", m.DB_NAME)
        os.makedirs(os.path.dirname(path))
        conn = sqlite3.connect(path)
        conn.executescript(SCHEMA)
        event(conn, m.BTC, "book", D0, 1, persisted=D0 + 1)
        conn.commit()
        ro = m._open_readonly(path)
        self.addCleanup(ro.close)
        r = c.build_result(ro, read_date_ms=1, max_events=10, max_candles=10)
        self.assertIsNone(r["inferences"]["window_not_trimmed_by_retention"]["holds"])

    def test_a_witness_that_goes_backwards_stops_the_run(self):
        class Fake:
            def fetch(self, *_args, **_kwargs):
                return [("book", 20), ("book", 10)]
        with self.assertRaises(m.Stopped) as ctx:
            c.read_witness_events(Fake(), m.BTC, (0, 10 * H), 10, c.Count())
        self.assertEqual(ctx.exception.reason, "order")

    def test_empty_base_gives_none_not_errors(self):
        r = self.run_control()
        self.assertIsNone(r["stopped"])
        self.assertIsNone(r["bounds"]["events_overall"]["oldest"])
        self.assertIsNone(r["inferences"]["window_not_trimmed_by_retention"]["holds"])

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
        self.assertIn("xbt_candles_after", r["witnesses"])         # the small witnesses are read first and survive
        self.assertNotIn("xbt_after", r["witnesses"])

    def test_candle_cap(self):
        for i in range(5):
            candle(self.conn, D0 + 6 * H + i * m.MINUTE_MS)
        self.assertEqual(self.run_control(max_candles=4)["stopped"]["reason"], "row_budget")
        self.assertIsNone(self.run_control(max_candles=5)["stopped"])

    def test_no_product_or_value_leaves_other_than_timestamps_and_counts(self):
        self.seed()
        text = str(self.run_control())
        for forbidden in ("raw_json", "normalized_json", "open_price", "close_price", "event_id", "uid"):
            self.assertNotIn(forbidden, text)

    def test_statements_force_their_indexes_without_analyze(self):
        for sql in (c._sql_bound_product("oldest"), c._sql_witness_events(c.WINDOW_XBT_AFTER, 10), c._sql_bound_gaps("newest")):
            self.assertIn("INDEXED BY", sql)
        self.assertIn("rowid", c.SQL_PROBE)
        for sql in (c._sql_bound_candles("oldest"), c._sql_witness_candles(c.WINDOW_XBT_AFTER, 10),
                    c._sql_witness_candles(c.WINDOW_CANDLES_BEFORE, 10)):
            self.assertIn("INDEXED BY sqlite_autoindex_paper_futures_candle_revisions_1", sql)

    def test_the_authorizer_denies_other_columns(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        guard = c._Guard(ro, 0)
        for mode, sql in (("bound_rowid", "SELECT raw_json FROM paper_futures_market_events WHERE rowid >= 0 LIMIT 1"),
                          ("bound_gaps", "SELECT reason FROM paper_futures_data_gaps WHERE detected_at >= 0 LIMIT 1"),
                          ("bound_candles", "SELECT close_price FROM paper_futures_candle_revisions LIMIT 1"),
                          ("probe", "SELECT event_time FROM paper_futures_market_events WHERE rowid >= 0 LIMIT 1"),
                          ("bound_rowid", "SELECT uid FROM paper_futures_market_events WHERE rowid >= 0 LIMIT 1")):
            with self.assertRaises(sqlite3.DatabaseError):
                guard.fetch(mode, sql)

    def test_caps_are_mandatory(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            c.main(["--db", self.path])


if __name__ == "__main__":
    unittest.main()
