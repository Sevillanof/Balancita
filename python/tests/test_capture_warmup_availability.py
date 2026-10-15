import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from balancita_engine import capture_warmup_availability as cwa

W0, W1, M1 = cwa.WINDOW_START_MS, cwa.WINDOW_END_MS, cwa.INTERVAL_MS
XBT, ETH = "PF_XBTUSD", "PF_ETHUSD"
SENTINEL = "98765.4321"          # a price the tool must never return
SCHEMA = """
CREATE TABLE paper_futures_official_candles(
  product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL, revision_hash TEXT NOT NULL,
  known_at INTEGER NOT NULL, open_price TEXT NOT NULL, high_price TEXT NOT NULL, low_price TEXT NOT NULL,
  close_price TEXT NOT NULL, volume_btc TEXT NOT NULL, response_sha256 TEXT NOT NULL,
  PRIMARY KEY(product_id, interval_ms, bucket_start, revision_hash)) STRICT;
CREATE TABLE paper_futures_official_candle_responses(sha256 TEXT PRIMARY KEY, raw_response TEXT NOT NULL) STRICT;
"""


def make_db(path, skip=(), revisions=1, empty_at=None, extra=True, second=()):
    if os.path.exists(path):
        os.remove(path)
    c = sqlite3.connect(path)
    c.executescript(SCHEMA)
    rows = []
    for i, b in enumerate(range(W0, W1, M1)):
        if i in skip:
            continue
        for r in range(2 if i in second else revisions):
            value = "" if i == empty_at and r == 0 else SENTINEL
            rows.append((XBT, M1, b, "h%d-%d" % (b, r), b + M1 + 3_000 + r, value, SENTINEL, SENTINEL, SENTINEL, SENTINEL, "s"))
    if extra:
        rows += [(ETH, M1, W0, "e", W0 + M1, SENTINEL, "1", "1", "1", "1", "s"),         # another product
                 (XBT, 300_000, W0, "m5", W0 + 300_000, SENTINEL, "1", "1", "1", "1", "s"),   # another interval
                 (XBT, M1, W0 - M1, "before", W0, SENTINEL, "1", "1", "1", "1", "s"),         # before the window
                 (XBT, M1, W1, "end", W1 + M1, SENTINEL, "1", "1", "1", "1", "s")]            # at the end: excluded
    c.executemany("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
    c.execute("INSERT INTO paper_futures_official_candle_responses VALUES('s', ?)", ("raw " + SENTINEL,))
    c.commit()
    c.close()


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = os.path.join(self.dir.name, cwa.DB_NAME)

    def report(self, **kwargs):
        make_db(self.db, **kwargs)
        conn = cwa._open_readonly(self.db)
        try:
            return cwa.build_report(conn)
        finally:
            conn.close()


class Constants(unittest.TestCase):
    def test_the_window_is_the_authorized_one_and_the_requirement_is_the_frozen_strategies(self):
        self.assertEqual(cwa.EXPECTED_MINUTES, 17_340)
        self.assertEqual(cwa.REQUIRED_MINUTES, 17_290)
        self.assertEqual(W0, 1_790_812_800_000)       # 2026-10-01T00:00:00Z
        self.assertEqual(W1, 1_791_853_200_000)       # 2026-10-13T01:00:00Z
        self.assertEqual(cwa.ROW_BUDGET, 60_000)
        self.assertEqual(cwa.QUERY_TIMEOUT_S, 60)
        self.assertEqual(cwa.RUN_TIMEOUT_S, 600)

    def test_the_requirement_matches_required_warmup_ms(self):
        from balancita_engine import replay_specs as RS
        from balancita_engine.multi_experiment import required_warmup_ms
        from balancita_engine.multi_signals import merged_indicators
        need = required_warmup_ms(merged_indicators(RS.load_frozen()[0]))
        self.assertEqual(need // M1, cwa.REQUIRED_MINUTES)


class Availability(Base):
    def test_a_complete_window_is_apta(self):
        r = self.report()
        self.assertIsNone(r["stopped"])
        self.assertEqual(r["counts"]["rows"], 17_340)               # the extra rows are outside the filters
        self.assertEqual(r["counts"]["distinct_buckets"], 17_340)
        self.assertEqual((r["counts"]["min_bucket_start"], r["counts"]["max_bucket_start"]), (W0, W1 - M1))
        self.assertEqual(r["counts"]["empty_fields_rows"], 0)
        self.assertEqual(r["availability"]["consecutive_minutes_up_to_the_end"], 17_340)
        self.assertEqual(r["verdict"]["fitness"], "apta")
        self.assertEqual(r["rows_scanned"], {"aggregate": 17_340, "fetch_planned": 17_340, "total_planned": 34_680, "fetched": 17_340})
        self.assertEqual(r["guards"], {"opened_with": "mode=ro", "query_only_readback": 1})

    def test_the_margin_is_exactly_fifty_minutes(self):
        self.assertEqual(self.report(skip=range(0, 50))["verdict"]["fitness"], "apta")          # 17 290 consecutive
        self.assertEqual(self.report(skip=range(0, 51))["verdict"]["fitness"], "bloqueada")     # 17 289

    def test_a_hole_at_the_end_blocks(self):
        r = self.report(skip=[17_339])
        self.assertEqual(r["availability"]["consecutive_minutes_up_to_the_end"], 0)
        self.assertEqual(r["verdict"]["fitness"], "bloqueada")
        self.assertEqual(r["availability"]["missing_runs"]["longest"], [{"start_ms": W1 - M1, "minutes": 1}])

    def test_a_hole_in_the_middle_with_a_long_enough_tail_is_apta_and_still_reported(self):
        r = self.report(skip=[30, 31])
        self.assertEqual(r["availability"]["consecutive_minutes_up_to_the_end"], 17_340 - 32)
        self.assertEqual(r["availability"]["minutes_missing"], 2)
        self.assertEqual(r["availability"]["missing_runs"]["longest"], [{"start_ms": W0 + 30 * M1, "minutes": 2}])
        self.assertEqual(r["verdict"]["fitness"], "apta")

    def test_a_capture_that_starts_late_is_bloqueada_with_what_was_found(self):
        r = self.report(skip=range(0, 9_000))
        self.assertEqual(r["verdict"]["fitness"], "bloqueada")
        self.assertEqual(r["counts"]["min_bucket_start"], W0 + 9_000 * M1)
        self.assertEqual(r["availability"]["minutes_missing"], 9_000)

    def test_an_empty_price_field_blocks_and_is_only_counted(self):
        r = self.report(empty_at=100)
        self.assertEqual(r["counts"]["empty_fields_rows"], 1)
        self.assertEqual(r["verdict"]["fitness"], "bloqueada")
        self.assertIn("1 rows with an empty", r["verdict"]["reasons"][0])

    def test_revisions_are_counted_and_late_ones_show_in_known_at(self):
        r = self.report(second=range(0, 1_000))
        self.assertEqual(r["counts"]["rows"], 18_340)
        self.assertEqual(r["counts"]["distinct_buckets"], 17_340)
        self.assertEqual(r["availability"]["revisions"], {"rows": 18_340, "buckets_with_more_than_one": 1_000, "max_per_bucket": 2})
        self.assertEqual(r["availability"]["known_at_minus_bucket_end_ms"]["min"], 3_000)
        self.assertEqual(r["availability"]["known_at_minus_bucket_end_ms"]["max"], 3_001)
        self.assertEqual(r["verdict"]["fitness"], "apta")

    def test_two_revisions_on_every_minute_do_not_fit_the_budget(self):
        r = self.report(revisions=2)           # 34 680 rows scanned twice: 69 360 > 60 000
        self.assertEqual(r["stopped"], {"reason": "row_budget", "detail": {"total_planned": 69_360, "limit": 60_000}})

    def test_over_the_scan_budget_nothing_is_fetched_and_nothing_is_sampled(self):
        # 3 revisions: the aggregate scans 52 020 rows and the fetch would scan them again: 104 040 > 60 000
        fetched = []
        make_db(self.db, revisions=3)
        conn = cwa._open_readonly(self.db)
        real = cwa._Guard.fetch

        def spy(guard, mode, sql):
            fetched.append(mode)
            return real(guard, mode, sql)
        with mock.patch.object(cwa._Guard, "fetch", spy):
            r = cwa.build_report(conn)
        conn.close()
        self.assertEqual(fetched, ["aggregate"])
        self.assertEqual(r["stopped"], {"reason": "row_budget", "detail": {"total_planned": 104_040, "limit": 60_000}})
        self.assertEqual(r["counts"]["rows"], 52_020)
        self.assertNotIn("availability", r)
        self.assertNotIn("verdict", r)

    def test_the_limit_is_on_the_total_scanned_rows_aggregate_included(self):
        r = self.report(second=range(0, 12_660))      # 30 000 rows: 60 000 scanned, exactly the budget
        self.assertIsNone(r["stopped"])
        self.assertEqual(r["rows_scanned"]["total_planned"], 60_000)
        r = self.report(second=range(0, 12_661))      # one more row: refused
        self.assertEqual(r["stopped"]["reason"], "row_budget")

    def test_off_grid_buckets_are_reported_not_counted_as_minutes(self):
        a = cwa.analyse([(W0 + 5, W0 + M1), (W0, W0 + M1 + 1)])
        self.assertEqual((a["minutes_present"], a["off_grid_buckets"]), (1, 1))


class Guards(Base):
    def setUp(self):
        super().setUp()
        make_db(self.db)
        self.conn = cwa._open_readonly(self.db)
        self.addCleanup(self.conn.close)

    def test_the_price_columns_cannot_be_fetched_only_counted(self):
        guard = cwa._Guard(self.conn, 0.0)
        self.addCleanup(guard.close)
        with self.assertRaises(sqlite3.DatabaseError):
            guard.fetch("fetch", "SELECT open_price FROM paper_futures_official_candles LIMIT 1")
        with self.assertRaises(sqlite3.DatabaseError):
            guard.fetch("fetch", "SELECT COUNT(*) FROM paper_futures_official_candles WHERE open_price = ''")
        self.assertEqual(guard.fetch("aggregate", "SELECT COUNT(*) FROM paper_futures_official_candles WHERE open_price = ''"), [(0,)])

    def test_nothing_else_is_readable_and_nothing_is_writable(self):
        guard = cwa._Guard(self.conn, 0.0)
        self.addCleanup(guard.close)
        for mode in ("aggregate", "fetch"):
            with self.assertRaises(sqlite3.DatabaseError):
                guard.fetch(mode, "SELECT raw_response FROM paper_futures_official_candle_responses")
            with self.assertRaises(sqlite3.DatabaseError):
                guard.fetch(mode, "SELECT response_sha256 FROM paper_futures_official_candles LIMIT 1")
            with self.assertRaises(sqlite3.DatabaseError):
                guard.fetch(mode, "DELETE FROM paper_futures_official_candles")
            with self.assertRaises(sqlite3.DatabaseError):
                guard.fetch(mode, "PRAGMA query_only = OFF")

    def test_the_connection_is_read_only_and_query_only(self):
        self.assertEqual(self.conn.execute("PRAGMA query_only").fetchone()[0], 1)
        with self.assertRaises(sqlite3.OperationalError):
            self.conn.execute("DELETE FROM paper_futures_official_candles")

    def test_a_connection_that_is_not_query_only_stops_before_reading(self):
        raw = sqlite3.connect("file:%s?mode=ro" % self.db, uri=True)          # no PRAGMA query_only
        self.addCleanup(raw.close)
        r = cwa.build_report(raw)
        self.assertEqual(r["guards"]["query_only_readback"], 0)
        self.assertEqual(r["stopped"], {"reason": "connection_not_query_only", "detail": None})
        self.assertNotIn("counts", r)

    def test_the_time_limit_stops_the_run(self):
        with mock.patch.object(cwa, "QUERY_TIMEOUT_S", -1), mock.patch.object(cwa, "PROGRESS_OPS", 1):
            r = cwa.build_report(self.conn)
        self.assertEqual(r["stopped"], {"reason": "time_limit", "detail": "aggregate"})

    def test_the_run_limit_stops_the_run(self):
        with mock.patch.object(cwa, "PROGRESS_OPS", 1):
            r = cwa.build_report(self.conn, started=-10_000_000.0)
        self.assertEqual(r["stopped"]["reason"], "time_limit")

    def test_another_window_or_product_is_refused(self):
        with self.assertRaises(ValueError):
            cwa.build_report(self.conn, window=(W0, W1 + M1))
        with self.assertRaises(ValueError):
            cwa.build_report(self.conn, window=(W0 - M1, W1))
        with self.assertRaises(ValueError):
            cwa.build_report(self.conn, product=ETH)

    def test_a_link_or_a_missing_file_is_refused(self):
        link = os.path.join(self.dir.name, "link.sqlite")
        os.symlink(self.db, link)
        with self.assertRaises(FileNotFoundError):
            cwa._open_readonly(link)
        with self.assertRaises(FileNotFoundError):
            cwa._open_readonly(os.path.join(self.dir.name, "nothing.sqlite"))


class Output(Base):
    def run_main(self, path):
        out = io.StringIO()
        with redirect_stdout(out):
            code = cwa.main(["--db", path])
        return code, json.loads(out.getvalue()), out.getvalue()

    def test_the_output_carries_no_price_and_has_identity_before_and_after(self):
        make_db(self.db)
        code, result, text = self.run_main(self.db)
        self.assertEqual(code, 0)
        self.assertNotIn(SENTINEL, text)
        self.assertNotIn("raw ", text)
        source = result["source"]
        self.assertEqual(source["before"]["db_name"], cwa.DB_NAME)
        self.assertEqual(source["before"]["size_bytes"], source["after"]["size_bytes"])
        self.assertTrue(source["before"]["regular_file_not_a_link"])
        self.assertEqual(result["verdict"]["fitness"], "apta")
        self.assertEqual(result["fingerprint_sha256"], cwa.fingerprint(result))

    def test_the_database_is_not_modified(self):
        make_db(self.db)
        before = open(self.db, "rb").read()
        self.run_main(self.db)
        self.assertEqual(open(self.db, "rb").read(), before)

    def test_a_stopped_run_exits_with_2_and_still_prints_the_counts(self):
        make_db(self.db, revisions=3)
        code, result, _ = self.run_main(self.db)
        self.assertEqual(code, 2)
        self.assertEqual(result["stopped"]["reason"], "row_budget")

    def test_a_file_with_another_name_is_refused(self):
        other = os.path.join(self.dir.name, "history.sqlite")
        make_db(other)
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            self.assertEqual(cwa.main(["--db", other]), 2)
        self.assertIn("must be called", err.getvalue())


if __name__ == "__main__":
    unittest.main()
