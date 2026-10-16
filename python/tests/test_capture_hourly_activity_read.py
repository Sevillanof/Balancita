"""Invented-data tests of capture_hourly_activity_read (v3) on a copy of the REAL schema. No real data is touched."""
import contextlib
import io
import os
import sqlite3
import tempfile
import unittest
import unittest.mock

from balancita_engine import capture_hourly_activity_read as h
from balancita_engine import capture_minimal_read as m

SCHEMA = open(os.path.join(os.path.dirname(__file__), "real_futures_schema.sql"), encoding="utf-8").read()
S = h.START_MS
H = h.HOUR_MS
LAST = h.HOURS - 1


def event(conn, product, feed, at, n):
    conn.execute("INSERT INTO paper_futures_market_events (event_id,feed,product_id,epoch,seq,event_time,received_at,persisted_at,uid,"
                 "raw_json,normalized_json,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                 ("%s:%s:%d" % (feed, product, n), feed, product, 1, n, at, at, at, None, "{}", "{}", "h%d" % n))


def analytics(conn, product, at, n):
    conn.execute("INSERT INTO paper_futures_analytics_responses VALUES (?,?,?,?,?,?,?)", (product, "a%d" % n, "orderbook", 60000, at, at, "SECRET"))


class HourlyTests(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.path = os.path.join(d, "dev-live", m.DB_NAME)
        os.makedirs(os.path.dirname(self.path))
        self.conn = sqlite3.connect(self.path)
        self.conn.executescript(SCHEMA)

    def run_read(self, **caps):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        read_date = caps.pop("read_date_ms", 1)
        for name, value in (("max_analytics_hour", 1000), ("max_analytics_table", 100000), ("max_events_hour", 1000),
                            ("max_events_table", 100000)):
            caps.setdefault(name, value)
        return h.build_result(ro, read_date_ms=read_date, **caps)

    def seed(self):
        n = 0
        for hour, product, feed in ((0, m.BTC, "trade"), (0, m.ETH, "book"), (1, m.BTC, "book"), (1, m.BTC, "book"), (5, m.BTC, "trade"),
                                    (LAST, m.BTC, "trade")):
            n += 1
            event(self.conn, product, feed, S + hour * H + n, n)
        for hour in (0, 1, 2, 3):                     # analytics keep arriving in hours 2 and 3, where there are no events
            analytics(self.conn, m.BTC, S + hour * H + 7, hour)

    def test_only_events_and_analytics_are_read(self):
        self.seed()
        r = self.run_read()
        self.assertEqual(sorted(r["hours_by_part"]), ["analytics", "events"])
        for d in r["plans"]:
            self.assertNotIn("candle", d)
            self.assertNotIn("official", d)
        self.assertEqual(h.HOURS, 50)

    def test_hourly_counts_on_invented_data(self):
        self.seed()
        r = self.run_read()
        self.assertIsNone(r["stopped"])
        ev = r["hours_by_part"]["events"]
        self.assertEqual(len(ev), h.HOURS)
        self.assertEqual((ev[0]["rows"], ev[0]["by_product"], ev[0]["by_feed"]), (2, {m.BTC: 1, m.ETH: 1}, {"trade": 1, "book": 1}))
        self.assertEqual((ev[1]["rows"], ev[1]["by_feed"]), (2, {"book": 2}))
        self.assertEqual([e["rows"] for e in ev[2:5]], [0, 0, 0])
        self.assertEqual(ev[5]["rows"], 1)
        self.assertEqual(ev[LAST]["rows"], 1)
        an = r["hours_by_part"]["analytics"]
        self.assertEqual([a["rows"] for a in an[:5]], [1, 1, 1, 1, 0])
        self.assertEqual(sum(e.get("misplaced", 0) for p in r["hours_by_part"].values() for e in p), 0)

    def test_inferences_only_say_which_hours_have_rows(self):
        self.seed()
        inf = self.run_read()["inferences"]
        self.assertEqual(inf["hours_retention_possible"], [S])                    # the oldest event is in hour 0
        self.assertEqual(inf["hours_without_events_with_analytics"], [S + 2 * H, S + 3 * H])
        self.assertIn(S + 4 * H, inf["hours_without_events_or_analytics"])
        self.assertIn(S + H, inf["hours_with_events"])
        self.assertNotIn(S + 3 * H, inf["hours_without_events_or_analytics"])
        text = str(inf["does_not_say"])
        self.assertIn("whether the capture process was running or down", text)
        self.assertIn("causality", text)
        self.assertIn("NOT evidence that the process was down", inf["says"]["hours_without_events_or_analytics"])

    def test_an_hour_over_the_cap_is_flagged_and_not_counted(self):
        event(self.conn, m.BTC, "book", S, 0)
        for i in range(6):
            event(self.conn, m.BTC, "book", S + 2 * H + i, i + 1)
        r = self.run_read(max_events_hour=5)
        self.assertIsNone(r["stopped"])
        hour = r["hours_by_part"]["events"][2]
        self.assertTrue(hour["over_cap"])
        self.assertNotIn("by_product", hour)
        self.assertEqual(hour["rows"], 0)                                     # nothing published as a count
        self.assertIn(S + 2 * H, r["inferences"]["hours_with_events"])        # over the cap still means "has events"

    def test_the_events_cap_stops_but_keeps_finished_events_and_the_analytics(self):
        for hour in range(10):
            for i in range(3):
                event(self.conn, m.BTC, "book", S + hour * H + i, hour * 10 + i)
        analytics(self.conn, m.BTC, S + H, 1)
        r = self.run_read(max_events_hour=100, max_events_table=7)
        self.assertEqual(r["stopped"]["reason"], "row_budget")
        self.assertEqual(r["stopped"]["detail"]["stage"], "events")
        self.assertEqual(len(r["hours_by_part"]["events"]), 3)                # hours 0..2 finished (9 rows > 7)
        self.assertEqual(len(r["hours_by_part"]["analytics"]), h.HOURS)       # analytics run first and are complete
        self.assertEqual(r["hours_by_part"]["analytics"][1]["rows"], 1)

    def test_a_stop_in_analytics_keeps_its_finished_hours_and_skips_the_events(self):
        for i in range(6):
            analytics(self.conn, m.BTC, S + 2 * H + i, i)
        event(self.conn, m.BTC, "book", S + 1, 1)
        r = self.run_read(max_analytics_table=3)
        self.assertEqual(r["stopped"]["detail"]["stage"], "analytics")
        self.assertEqual(len(r["hours_by_part"]["analytics"]), 3)
        self.assertEqual(r["hours_by_part"]["events"], [])

    def test_hours_before_the_oldest_surviving_event_are_left_out_of_the_inferences(self):
        """D-218-01: retention keeps moving; an hour that starts before the hour after the oldest event may have been trimmed."""
        event(self.conn, m.BTC, "book", S + 3 * H + H // 2, 1)
        event(self.conn, m.BTC, "book", S + 6 * H + 5, 2)
        for hour in range(8):
            analytics(self.conn, m.BTC, S + hour * H + 9, hour)
        r = self.run_read()
        self.assertEqual(r["oldest_event"]["received_at"], S + 3 * H + H // 2)
        self.assertEqual(r["retention_boundary_ms"], S + 4 * H)
        flags = [e["retention_possible"] for e in r["hours_by_part"]["events"][:6]]
        self.assertEqual(flags, [True, True, True, True, False, False])
        inf = r["inferences"]
        self.assertEqual(inf["hours_retention_possible"], [S + k * H for k in range(4)])
        self.assertEqual(inf["hours_without_events_with_analytics"], [S + 4 * H, S + 5 * H, S + 7 * H])
        self.assertNotIn(S + 2 * H, inf["hours_without_events_with_analytics"])

    def test_ticker_rows_are_kept_apart_and_flagged_not_informative_when_old(self):
        event(self.conn, m.BTC, "book", S + 1, 1)
        for i in range(3):
            event(self.conn, m.ETH, "ticker", S + 2 + i, 10 + i)
        old = self.run_read(read_date_ms=S + 30 * H)["hours_by_part"]["events"][0]
        self.assertEqual((old["rows"], old["ticker_rows"], old["ticker_informative"]), (1, 3, False))
        self.assertEqual(old["by_product"], {m.BTC: 1})
        self.assertNotIn("ticker", old["by_feed"])
        recent = self.run_read(read_date_ms=S + 2 * H)["hours_by_part"]["events"][0]
        self.assertTrue(recent["ticker_informative"])

    def test_rows_out_of_their_hour_are_counted_as_misplaced(self):
        event(self.conn, m.BTC, "book", S + 2 * H, 1)
        event(self.conn, m.BTC, "book", S + 5 * H, 2)
        event(self.conn, m.BTC, "book", S + 2 * H + 5, 3)                     # high rowid, old time
        event(self.conn, m.BTC, "book", S + 7 * H, 4)
        r = self.run_read()
        self.assertGreater(sum(e["misplaced"] for e in r["hours_by_part"]["events"]), 0)
        self.assertTrue(r["inferences"]["hours_with_misplaced_rows"])

    def test_empty_database_gives_zero_rows_in_every_hour(self):
        r = self.run_read()
        self.assertIsNone(r["stopped"])
        self.assertEqual([e["rows"] for e in r["hours_by_part"]["events"]], [0] * h.HOURS)
        self.assertEqual(r["inferences"]["hours_without_events_or_analytics"], [])    # no event survives: retention cannot be excluded anywhere
        self.assertEqual(len(r["inferences"]["hours_retention_possible"]), h.HOURS)

    def test_boundaries_are_found_with_few_single_row_reads(self):
        for i in range(2000):
            event(self.conn, m.BTC, "book", S + (i * h.HOURS * H) // 2000, i)
        r = self.run_read(max_events_hour=100, max_events_table=100000)
        self.assertIsNone(r["stopped"])
        self.assertLess(r["rows_read"]["single_row_reads"], (h.HOURS + 1) * 14 + 20)
        self.assertEqual(sum(e["rows"] for e in r["hours_by_part"]["events"]), 2000)
        self.assertLessEqual(r["rows_read"]["single_row_reads"], r["rows_read"]["single_row_cap"])
        self.assertLessEqual(sum(r["rows_read"]["walked_by_part"].values()), r["rows_read"]["total_cap"])

    def test_every_plan_is_a_search_without_scan_or_temp_btree(self):
        self.seed()
        r = self.run_read()
        self.assertTrue(r["plans"])
        for d in r["plans"]:
            self.assertFalse(d.startswith("SCAN") or "TEMP B-TREE" in d, d)

    def test_the_authorizer_denies_bodies_and_other_columns(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        guard = h._Guard(ro, 0)
        for mode, sql in (("walk_analytics", "SELECT raw_response FROM paper_futures_analytics_responses WHERE rowid >= 0 LIMIT 1"),
                          ("walk_events", "SELECT raw_json FROM paper_futures_market_events WHERE rowid >= 0 LIMIT 1"),
                          ("bisect_events", "SELECT product_id FROM paper_futures_market_events WHERE rowid >= 0 LIMIT 1"),
                          ("edge_events", "SELECT received_at FROM paper_futures_market_events WHERE rowid >= 0 LIMIT 1"),
                          ("walk_events", "SELECT close_price FROM paper_futures_candle_revisions LIMIT 1"),
                          ("walk_events", "SELECT raw_response FROM paper_futures_official_candle_responses LIMIT 1")):
            with self.assertRaises(sqlite3.DatabaseError):
                guard.fetch(mode, sql)

    def test_nothing_but_counts_and_ids_is_published(self):
        self.seed()
        text = str(self.run_read())
        for forbidden in ("SECRET", "raw_json", "normalized_json", "event_id", "open_price", "close_price"):
            self.assertNotIn(forbidden, text)

    def test_four_caps_are_mandatory_and_positive(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            h.main(["--db", self.path])
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(h.main(["--db", self.path, "--max-analytics-hour", "0", "--max-analytics-table", "9",
                                     "--max-events-hour", "5", "--max-events-table", "10"]), 2)

    def test_main_refuses_a_file_smaller_than_the_identified_capture(self):
        self.conn.commit()
        with contextlib.redirect_stderr(io.StringIO()) as err:
            code = h.main(["--db", self.path, "--max-analytics-hour", "1", "--max-analytics-table", "1", "--max-events-hour", "1",
                           "--max-events-table", "1"])
        self.assertEqual(code, 2)
        self.assertIn("refused", err.getvalue())

    def test_main_passes_the_four_caps_to_the_run(self):
        self.conn.commit()
        out = io.StringIO()
        with unittest.mock.patch.object(m, "MIN_SIZE_BYTES", 0), contextlib.redirect_stdout(out):
            code = h.main(["--db", self.path, "--max-analytics-hour", "11", "--max-analytics-table", "22",
                           "--max-events-hour", "33", "--max-events-table", "44"])
        self.assertEqual(code, 0)
        import json
        result = json.loads(out.getvalue())
        self.assertEqual(result["caps"], {"analytics_hour": 11, "analytics_table": 22, "events_hour": 33, "events_table": 44})
        self.assertEqual(result["tool_version"], h.TOOL_VERSION)
        self.assertIn("fingerprint_sha256", result)


if __name__ == "__main__":
    unittest.main()
