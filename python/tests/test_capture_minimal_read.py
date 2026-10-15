"""Synthetic tests for capture_minimal_read: bounded reads, guards and aggregation. No real data is touched."""
import os
import sqlite3
import tempfile
import time
import unittest

from balancita_engine import capture_minimal_read as m

A0, A1 = m.WINDOW_A
B0, B1 = m.WINDOW_B

SCHEMA = """
CREATE TABLE paper_futures_official_candles (product_id TEXT, interval_ms INTEGER, bucket_start INTEGER, revision_hash TEXT,
  known_at INTEGER, open_price TEXT, high_price TEXT, low_price TEXT, close_price TEXT, volume_btc TEXT, response_sha256 TEXT,
  PRIMARY KEY (product_id, interval_ms, bucket_start, revision_hash));
CREATE TABLE paper_futures_candle_revisions (candle_id TEXT, revision INTEGER, interval_ms INTEGER, bucket_start INTEGER,
  known_at INTEGER, close_at INTEGER, is_closed INTEGER, coverage TEXT, open_price TEXT, high_price TEXT, low_price TEXT,
  close_price TEXT, volume_btc TEXT, trade_count INTEGER, source_hash TEXT, PRIMARY KEY (candle_id, revision));
CREATE TABLE paper_futures_funding_periods (response_sha256 TEXT, start_ms INTEGER, product_id TEXT, end_ms INTEGER,
  funding_rate TEXT, known_at INTEGER, unit TEXT, PRIMARY KEY (response_sha256, start_ms));
CREATE TABLE paper_futures_funding_responses (sha256 TEXT PRIMARY KEY, received_at INTEGER, server_time INTEGER, raw_response TEXT);
"""


def make_db(path):
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    return conn


def official(conn, product, bucket, known=None, rev="h", close="100"):
    conn.execute("INSERT INTO paper_futures_official_candles VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                 (product, m.MINUTE_MS, bucket, rev, known or bucket + 120_000, "100", "101", "99", close, "1", "r"))


def revision(conn, bucket, rev, closed, close="100"):
    conn.execute("INSERT INTO paper_futures_candle_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                 ("%s:%d:%d" % (m.BTC, m.MINUTE_MS, bucket), rev, m.MINUTE_MS, bucket, bucket + 61_000, bucket + 60_000,
                  closed, "full", "100", "101", "99", close, "1", 3, "s"))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "dev-live", m.DB_NAME)
        os.makedirs(os.path.dirname(self.path))
        self.conn = make_db(self.path)

    def guard(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        return m._Guard(ro, time.monotonic())


class ReadTests(Fixture):
    def test_2a_reads_only_the_window_and_products_with_pk_plan(self):
        for b in range(A0, A0 + 3 * m.MINUTE_MS, m.MINUTE_MS):
            official(self.conn, m.BTC, b)
            official(self.conn, m.ETH, b)
        official(self.conn, m.BTC, A1)                      # outside the window
        official(self.conn, "PF_SOLUSD", A0)                # other product
        rows = m.read_2a(self.guard(), m.Ledger())
        self.assertEqual(len(rows), 6)
        self.assertEqual({r[0] for r in rows}, {m.BTC, m.ETH})

    def test_2a_stops_on_row_budget_without_returning_rows(self):
        self.conn.executemany("INSERT INTO paper_futures_official_candles VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                              [(m.BTC, m.MINUTE_MS, A0 + i * m.MINUTE_MS, "h", 0, "1", "1", "1", "1", "1", "r") for i in range(30)])
        old = m.CAPS["2a"]
        m.CAPS["2a"] = 10
        self.addCleanup(m.CAPS.__setitem__, "2a", old)
        with self.assertRaises(m.Stopped) as ctx:
            m.read_2a(self.guard(), m.Ledger())
        self.assertEqual(ctx.exception.reason, "row_budget")

    def test_2b_hides_values_of_open_revisions(self):
        revision(self.conn, B0, 1, 0, close="777")
        revision(self.conn, B0, 2, 1, close="105")
        revision(self.conn, B1, 1, 1)                        # outside
        rows = m.read_2b(self.guard(), m.Ledger())
        self.assertEqual(len(rows), 2)
        open_row = [r for r in rows if r[3] == 0][0]
        self.assertTrue(all(v is None for v in open_row[4:]))
        self.assertEqual([r for r in rows if r[3] == 1][0][7], "105")

    def test_2c_filters_by_start_and_product_inside_sqlite(self):
        ins = "INSERT INTO paper_futures_funding_periods VALUES (?,?,?,?,?,?,?)"
        self.conn.execute(ins, ("a", A0, m.BTC, A0 + 3_600_000, "0.1", A0 + 10, "u"))
        self.conn.execute(ins, ("b", A0, "PF_SOLUSD", A0 + 3_600_000, "9.99", A0 + 20, "u"))
        self.conn.execute(ins, ("c", A1, m.BTC, A1 + 3_600_000, "0.1", A1 + 30, "u"))
        rows = m.read_2c(self.guard(), m.Ledger(), m.Reads())
        self.assertEqual(len(rows), 1)
        self.assertNotIn("9.99", repr(rows))

    def test_2c_stops_when_time_decreases_inside_the_range(self):
        ins = "INSERT INTO paper_futures_funding_periods VALUES (?,?,?,?,?,?,?)"
        self.conn.execute(ins, ("a", A0, m.BTC, A0 + 1, "0.1", A0 + 50, "u"))
        self.conn.execute(ins, ("b", A0 + 1, m.BTC, A0 + 2, "0.1", A0 + 10, "u"))
        with self.assertRaises(m.Stopped) as ctx:
            m.read_2c(self.guard(), m.Ledger(), m.Reads())
        self.assertEqual(ctx.exception.reason, "rowid_order")

    def test_2d_byte_budget_stops_before_reading_bodies(self):
        self.conn.execute("INSERT INTO paper_futures_funding_periods VALUES ('s',?,?,?,?,?,?)", (A0, m.BTC, A0 + 1, "1", 1, "u"))
        self.conn.execute("INSERT INTO paper_futures_funding_responses VALUES ('s',?,?,?)", (A0 + 5, str(A0 + 5), "x" * 50))
        old = m.MAX_BODY_BYTES
        m.MAX_BODY_BYTES = 10
        self.addCleanup(setattr, m, "MAX_BODY_BYTES", old)
        with self.assertRaises(m.Stopped) as ctx:
            m.read_2d(self.guard(), m.Ledger(), m.Reads())
        self.assertEqual(ctx.exception.reason, "byte_budget")


class GuardTests(Fixture):
    def test_authorizer_denies_writes_and_other_columns(self):
        g = self.guard()
        with self.assertRaises(sqlite3.DatabaseError):
            g.fetch("2a", "SELECT response_sha256 FROM paper_futures_official_candles")
        with self.assertRaises(sqlite3.DatabaseError):
            g.fetch("2a", "SELECT * FROM paper_futures_funding_periods")
        with self.assertRaises(sqlite3.DatabaseError):
            g.conn.execute("DELETE FROM paper_futures_official_candles")

    def test_connection_is_query_only(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        self.assertEqual(ro.execute("PRAGMA query_only").fetchone()[0], 1)

    def test_identity_requires_dir_name_and_size(self):
        with self.assertRaises(m.Stopped):
            m.check_identity(self.path)                       # too small
        other = os.path.join(self.dir, "x.sqlite")
        open(other, "w").close()
        with self.assertRaises(m.Stopped):
            m.check_identity(other)


class SummaryTests(unittest.TestCase):
    def test_official_summary_counts_gaps_and_differing_revisions(self):
        rows = [(m.BTC, A0, 5, "h1", "1", "2", "0", "1", "1"), (m.BTC, A0, 9, "h2", "1", "2", "0", "2", "1"),
                (m.BTC, A0 + 3 * m.MINUTE_MS, 5, "h1", "1", "2", "0", "1", "1")]
        s = m.summarize_official(rows)[m.BTC]
        self.assertEqual(s["minutes_present"], 2)
        self.assertEqual(s["minutes_with_differing_revisions"], 1)
        self.assertEqual(s["minutes_missing"], m.EXPECTED_MINUTES_A - 2)
        self.assertEqual(s["missing_runs"]["longest"][0]["minutes"], m.EXPECTED_MINUTES_A - 4)

    def test_own_minutes_uses_first_and_last_closed_revision(self):
        rows = [(B0, 1, B0 + 1, 0, None, None, None, None, None), (B0, 2, B0 + 2, 1, "1", "2", "0", "1", "1"),
                (B0, 3, B0 + 3, 1, "1", "2", "0", "2", "1")]
        candles, summary = m.own_minutes(rows)
        self.assertEqual(len(candles), 2)
        self.assertEqual(summary["minutes_whose_first_and_last_closed_revision_differ"], 1)

    def test_cli_only_takes_db(self):
        with self.assertRaises(SystemExit):
            m.main(["--db", "x", "--from", "1"])


if __name__ == "__main__":
    unittest.main()


class EvaluateTests(Fixture):
    def _fill(self, own_close="100"):
        for b in range(B0, B1, m.MINUTE_MS):
            official(self.conn, m.BTC, b)
            revision(self.conn, b, 1, 0, close="1")
            revision(self.conn, b, 2, 1, close=own_close)
        self.conn.commit()

    def _evaluate(self):
        g = self.guard()
        led, rd = m.Ledger(), m.Reads()
        return m.evaluate(m.read_2a(g, led), m.read_2b(g, led), m.read_2c(g, led, rd), m.read_2d(g, led, rd))

    def test_candles_agree_and_no_value_is_published(self):
        self._fill()
        out = self._evaluate()
        report = out["candles_report"]
        self.assertEqual(report["counts"]["DISCREPANCY"], 0)
        self.assertNotIn("100", repr(report["findings_by_check"]))

    def test_a_different_own_close_is_a_discrepancy_without_values(self):
        self._fill(own_close="150")
        report = self._evaluate()["candles_report"]
        self.assertEqual(report["fitness"], "no_apta")
        self.assertTrue(all("detail" not in g for g in report["findings_by_check"]))
        self.assertNotIn("150", repr(report))


class HoldoutWindowTests(unittest.TestCase):
    def test_default_still_refuses_after_the_cut(self):
        from balancita_engine import capture_validation as cv
        with self.assertRaises(ValueError):
            cv.assert_range_allowed(A0, A1)
        with self.assertRaises(ValueError):
            cv.validate_candles(m.BTC, [], [], A0, A1)

    def test_window_allows_only_ranges_inside_it(self):
        from balancita_engine import capture_validation as cv
        cv.assert_range_allowed(B0, B1, m.HOLDOUT_WINDOW)
        with self.assertRaises(ValueError):
            cv.assert_range_allowed(A0, A1 + m.MINUTE_MS, m.HOLDOUT_WINDOW)
        with self.assertRaises(ValueError):
            cv.assert_range_allowed(cv.HOLDOUT_START_MS - m.MINUTE_MS, A1, m.HOLDOUT_WINDOW)

    def test_window_before_the_cut_is_rejected(self):
        from balancita_engine import capture_validation as cv
        with self.assertRaises(ValueError):
            cv.holdout_exception((cv.HOLDOUT_START_MS - 1, A1))


class FundingSmokeTests(Fixture):
    def test_funding_path_runs_and_publishes_no_rates(self):
        from datetime import datetime, timezone

        def iso(ms):
            return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        hour = 3_600_000
        start = A0 + 10 * hour
        rel, price = "0.0000125", 80_000
        server = start + 3 * hour
        body = '{"result":"success","serverTime":"%s","rates":[{"timestamp":"%s","fundingRate":%s,"relativeFundingRate":%s}]}' % (
            iso(server), iso(start), "1.0", rel)
        self.conn.execute("INSERT INTO paper_futures_funding_responses VALUES ('s',?,?,?)", (server, str(server), body))
        self.conn.execute("INSERT INTO paper_futures_funding_periods VALUES ('s',?,?,?,?,?,?)",
                          (start, m.BTC, start + hour, "1.0", server, "USD/BTC/hour"))
        for b in range(A0, A1, m.MINUTE_MS * 60):
            official(self.conn, m.BTC, b, close=str(price))
        self.conn.commit()
        g = self.guard()
        led, rd = m.Ledger(), m.Reads()
        out = m.evaluate(m.read_2a(g, led), m.read_2b(g, led), m.read_2c(g, led, rd), m.read_2d(g, led, rd))
        self.assertEqual(out["funding_rows"]["adapter"]["responses_parsed"], 1)
        self.assertNotIn(rel, repr(out["funding_report"]))


class BoundedWalkTests(Fixture):
    def _responses(self, n, start=None, step=60_000):
        start = A0 - 5 * 3_600_000 if start is None else start
        self.conn.executemany("INSERT INTO paper_futures_funding_responses VALUES (?,?,?,?)",
                              [("h%05d" % i, start + i * step, "t", "x") for i in range(n)])
        self.conn.commit()

    def test_binary_search_finds_the_window_edges_in_few_reads(self):
        self._responses(5000, start=A0 - 100 * 60_000, step=60_000)        # one per minute, 100 min before A0
        g, rd = self.guard(), m.Reads()
        lo, ev = m._lower_bound(g, "2d_bound", m._RESPONSES, "received_at", A0, rd)
        self.assertEqual(lo, 101)                                        # rowids start at 1; row i has time A0 + (i-101) min
        self.assertLess(rd.total(), 25)

    def test_span_wider_than_the_cap_stops_before_reading_rows(self):
        self._responses(2000, start=A0, step=60_000)
        g, rd, led = self.guard(), m.Reads(), m.Ledger()
        with self.assertRaises(m.Stopped) as ctx:
            m.read_2d(g, led, rd)
        self.assertEqual(ctx.exception.reason, "row_budget")
        self.assertEqual(ctx.exception.detail["stage"], "2d")
        self.assertEqual(led.entries[-1]["rows"], 0)

    def test_2d_reads_only_the_range_and_counts_point_reads(self):
        self._responses(300, start=A0 - 100 * 60_000, step=60_000)          # 100 before the window, 200 inside
        for i in range(300):
            self.conn.execute("INSERT INTO paper_futures_funding_periods VALUES (?,?,?,?,?,?,?)",
                              ("h%05d" % i, A0 + i, m.BTC, A0 + i + 1, "1", A0 + i, "u"))
        self.conn.commit()
        g, rd, led = self.guard(), m.Reads(), m.Ledger()
        out = m.read_2d(g, led, rd)
        self.assertEqual(len(out), 200)
        self.assertEqual(led.entries[-1]["rows"], 200)
        self.assertEqual(rd.count["2d_product"], 200)
        self.assertEqual(rd.count["2d_body"], 200)

    def test_stage_results_survive_a_later_stop(self):
        for b in range(B0, B1, m.MINUTE_MS):
            official(self.conn, m.BTC, b)
            revision(self.conn, b, 2, 1)
        self._responses(2000, start=A0, step=60_000)                    # 2d will exceed its cap
        self.conn.commit()
        self.conn.close()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        result = m.build_result(ro)
        self.assertEqual(result["stopped"]["reason"], "row_budget")
        self.assertIn("candles_report", result["evaluation"])
        self.assertIn("single_row_reads", result["rows_total"])


class AuthorizedWindowTests(unittest.TestCase):
    def test_only_the_exact_authorised_window(self):
        from balancita_engine import capture_validation as cv
        cv.holdout_exception(m.HOLDOUT_WINDOW)
        for window in ((A0, A1 + m.MINUTE_MS), (A0 - m.MINUTE_MS, A1), (cv.HOLDOUT_START_MS, 10 ** 13), (B0, B1)):
            with self.assertRaises(ValueError):
                cv.holdout_exception(window)
            with self.assertRaises(ValueError):
                cv.assert_range_allowed(window[0], window[1], window)
