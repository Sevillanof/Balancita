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
CREATE INDEX paper_futures_candle_revisions_bucket ON paper_futures_candle_revisions(interval_ms, bucket_start);
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
            m.main(["--db", "x", "--prior-first-rows", "1", "--prior-v2-rows", "1", "--prior-stage2-rows", "1", "--from", "1"])
        with self.assertRaises(SystemExit):
            m.main(["--db", "x"])                      # the two prior-rows arguments are mandatory
        with self.assertRaises(SystemExit):
            m.main(["--db", "x", "--prior-first-rows", "1"])


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

    def test_2d_reads_only_the_range_and_counts_every_read_of_the_stage(self):
        self._responses(120, start=A0 - 20 * 60_000, step=60_000)           # 20 before the window, 100 inside
        for i in range(120):
            self.conn.execute("INSERT INTO paper_futures_funding_periods VALUES (?,?,?,?,?,?,?)",
                              ("h%05d" % i, A0 + i, m.BTC if i % 2 else "PF_SOLUSD", A0 + i + 1, "1", A0 + i, "u"))
        self.conn.commit()
        g, rd, led = self.guard(), m.Reads(), m.Ledger()
        out = m.read_2d(g, led, rd)
        entry = led.entries[-1]
        self.assertEqual(len(out), 50)                                       # only XBT responses
        self.assertEqual(entry["rows_walked"], 100)
        self.assertEqual(rd.count["2d_lookup"], 100)
        self.assertEqual(rd.count["2d_size"], 50)
        self.assertEqual(rd.count["2d_body"], 50)
        self.assertEqual(entry["rows"], 100 + entry["search_reads"] + 100 + 50 + 50)

    def test_2d_stage_reads_over_the_cap_stop_before_any_body(self):
        self._responses(120, start=A0, step=60_000)
        for i in range(120):
            self.conn.execute("INSERT INTO paper_futures_funding_periods VALUES (?,?,?,?,?,?,?)",
                              ("h%05d" % i, A0 + i, m.BTC, A0 + i + 1, "1", A0 + i, "u"))
        self.conn.commit()
        old = m.CAPS["2d"]
        m.CAPS["2d"] = 300                                                   # 120 walk + ~25 + 120 products + 240 > 300
        self.addCleanup(m.CAPS.__setitem__, "2d", old)
        g, rd = self.guard(), m.Reads()
        with self.assertRaises(m.Stopped) as ctx:
            m.read_2d(g, m.Ledger(), rd)
        self.assertEqual(ctx.exception.reason, "row_budget")
        self.assertEqual(rd.count["2d_body"], 0)

    def test_stage_results_survive_a_later_stop(self):
        for b in range(B0, B1, m.MINUTE_MS):
            official(self.conn, m.BTC, b)
            revision(self.conn, b, 2, 1)
        self._responses(2000, start=A0, step=60_000)                    # 2d will exceed its cap
        self.conn.commit()
        self.conn.close()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        result = m.build_result(ro, prior_rows=17_131)
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


class SinglePassTests(Fixture):
    def _periods(self, n_products_rows):
        ins = "INSERT INTO paper_futures_funding_periods VALUES (?,?,?,?,?,?,?)"
        for i, product in enumerate(n_products_rows):
            self.conn.execute(ins, ("s%d" % i, A0 + i * 1000, product, A0 + i * 1000 + 1, "7.77" if product.startswith("PF_SOL") or product.startswith("PF_ADA") else "1.5",
                                    A0 + i, "u"))
        self.conn.commit()

    def test_one_pass_walks_each_row_once_and_hides_other_products(self):
        self._periods([m.BTC, "PF_SOLUSD", m.ETH, "PF_ADAUSD"])
        g, led = self.guard(), m.Ledger()
        rows = m.read_2c(g, led, m.Reads())
        entry = led.entries[-1]
        self.assertEqual((entry["rows_walked"], entry["rows_returned"]), (4, 2))
        self.assertNotIn("7.77", repr(rows))
        raw = g.fetch("2c", m._sql_2c(10), (1, 5))
        self.assertNotIn("7.77", repr(raw))
        self.assertEqual(sum(1 for r in raw if r[2] is None), 2)

    def test_walk_over_the_cap_stops_before_reading(self):
        self._periods([m.BTC if i % 2 else "PF_SOLUSD" for i in range(m.CAPS["2c"] + 38)])
        g, led = self.guard(), m.Ledger()
        with self.assertRaises(m.Stopped) as ctx:
            m.read_2c(g, led, m.Reads())
        self.assertEqual(ctx.exception.reason, "row_budget")
        self.assertEqual(ctx.exception.detail["walk_upper_bound"], m.CAPS["2c"] + 38)


class ExactBudgetTests(Fixture):
    def _setup(self, n=60):
        self.conn.executemany("INSERT INTO paper_futures_funding_responses VALUES (?,?,?,?)",
                              [("h%05d" % i, A0 + i * 60_000, "t", "x" * 10) for i in range(n)])
        self.conn.executemany("INSERT INTO paper_futures_funding_periods VALUES (?,?,?,?,?,?,?)",
                              [("h%05d" % i, A0 + i, m.BTC, A0 + i + 1, "1", A0 + i * 60_000, "u") for i in range(n)])
        self.conn.commit()

    def _run(self, cap):
        old = m.CAPS["2d"]
        m.CAPS["2d"] = cap
        self.addCleanup(m.CAPS.__setitem__, "2d", old)
        g, rd = self.guard(), m.Reads()
        executed = []
        real_fetch = g.fetch
        g.fetch = lambda mode, *a, **k: (executed.append(mode), real_fetch(mode, *a, **k))[1]
        return g, rd, executed

    def test_exact_frontier_never_executes_a_read_over_the_cap(self):
        self._setup()
        g, rd, _ = self._run(10_000)
        m.read_2d(g, m.Ledger(), rd)
        needed = rd.used["2d"]
        self.assertEqual(rd.reserved["2d"], 0)
        g, rd, _ = self._run(needed)
        m.read_2d(g, m.Ledger(), rd)                                 # exactly at the cap: allowed
        self.assertEqual(rd.used["2d"], needed)
        g, rd, executed = self._run(needed - 1)                      # one under: stops BEFORE the read that would exceed it
        with self.assertRaises(m.Stopped) as ctx:
            m.read_2d(g, m.Ledger(), rd)
        self.assertEqual(ctx.exception.reason, "row_budget")
        self.assertLessEqual(rd.used["2d"] + rd.reserved["2d"], needed - 1)
        self.assertEqual(rd.count["2d_body"], 0)
        self.assertLessEqual(len([e for e in executed if e in ("2d_lookup", "2d_size", "2d_body")]) + rd.count["2d_bound"], needed - 1)

    def test_size_reads_cannot_pass_the_cap_after_the_products(self):
        self._setup(100)
        g, rd, _ = self._run(10_000)
        m.read_2d(g, m.Ledger(), rd)
        walk_search_products = rd.used["2d"] - rd.count["2d_size"] - rd.count["2d_body"]
        g, rd, _ = self._run(walk_search_products + 5)               # products fit, only a few sizes may follow
        with self.assertRaises(m.Stopped):
            m.read_2d(g, m.Ledger(), rd)
        self.assertLessEqual(rd.used["2d"] + rd.reserved["2d"], walk_search_products + 5)
        self.assertEqual(rd.count["2d_body"], 0)


class CapsTests(unittest.TestCase):
    def test_caps_are_the_authorised_ones(self):
        self.assertEqual(m.CAPS, {"2a": 12_000, "2b": 100_000, "2c": 600, "2d": 1_200})
        self.assertEqual(m.MAX_BODY_BYTES, 200_000_000)
        self.assertEqual(m.TOTAL_ROWS_CAP, 173_000)


class PlanAndGlobalCapTests(Fixture):
    def test_no_executed_statement_scans_a_table(self):
        for b in range(B0, B1, m.MINUTE_MS):
            official(self.conn, m.BTC, b)
            revision(self.conn, b, 2, 1)
        self.conn.executemany("INSERT INTO paper_futures_funding_responses VALUES (?,?,?,?)",
                              [("h%05d" % i, A0 + i * 60_000, "t", "x" * 10) for i in range(40)])
        self.conn.executemany("INSERT INTO paper_futures_funding_periods VALUES (?,?,?,?,?,?,?)",
                              [("h%05d" % i, A0 + i, m.BTC, A0 + i + 1, "1", A0 + i * 60_000, "u") for i in range(40)])
        self.conn.commit()
        g, led, rd = self.guard(), m.Ledger(), m.Reads()
        m.read_2a(g, led)
        m.read_2b(g, led)
        m.read_2c(g, led, rd)
        m.read_2d(g, led, rd)
        self.assertGreater(len(g.planned), 8)
        for (mode, sql), details in g.planned.items():
            self.assertFalse([d for d in details if d.startswith("SCAN") and "subquery" not in d and d.strip() != "SCAN w"],
                             (mode, sql, details))

    def test_a_statement_with_a_table_scan_is_refused_before_it_runs(self):
        g = self.guard()
        with self.assertRaises(m.Stopped) as ctx:
            g.fetch("2c_bound", "SELECT min(rowid), max(rowid) FROM %s" % m._PERIODS)
        self.assertEqual(ctx.exception.reason, "query_plan")

    def test_bound_search_cost_does_not_grow_with_the_table(self):
        def steps(n):
            d = tempfile.mkdtemp()
            path = os.path.join(d, "dev-live", m.DB_NAME)
            os.makedirs(os.path.dirname(path))
            conn = make_db(path)
            conn.executemany("INSERT INTO paper_futures_funding_periods VALUES (?,?,?,?,?,?,?)",
                             [("h%07d" % i, A0 + i, m.BTC, A0 + i + 1, "1", A0 + i * 1000, "u") for i in range(n)])
            conn.commit()
            conn.close()
            ro = m._open_readonly(path)
            self.addCleanup(ro.close)
            count = [0]
            g = m._Guard(ro, time.monotonic())
            ro.set_progress_handler(lambda: count.__setitem__(0, count[0] + 1) or 0, 1)
            m._lower_bound(g, "2c_bound", m._PERIODS, "known_at", A0 + n * 500, m.Reads())
            return count[0]
        small, large = steps(1000), steps(30000)
        self.assertLess(large, small * 3 + 200)

    def test_global_total_frontier(self):
        self.assertEqual(m.stage_rows_needed(), 12_001 + 100_001 + 600 + 1_200)
        self.conn.commit()
        self.conn.close()
        remaining_ok = m.TOTAL_ROWS_CAP - m.stage_rows_needed()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        over = m.build_result(ro, prior_rows=remaining_ok + 1)           # one row short: stops without reading
        self.assertEqual(over["stopped"]["reason"], "global_cap")
        self.assertNotIn("reads", over)
        self.assertNotIn("evaluation", over)
        ok = m.build_result(m._open_readonly(self.path), prior_rows=remaining_ok)   # exactly what is left: allowed to start
        self.assertNotEqual((ok["stopped"] or {}).get("reason"), "global_cap")
        self.assertIn("reads", ok)


class RealSchemaPlanTests(Fixture):
    """The run of 2026-10-15 20:38Z stopped because, on SQLite 3.51 and with the real secondary index, 2b was planned on
    ``paper_futures_candle_revisions_bucket`` with a temporary sort. The test schema now has that index too."""

    def test_2b_uses_the_primary_key_and_no_temp_btree_even_with_the_secondary_index(self):
        for i in range(2000):
            revision(self.conn, B0 + (i % 360) * m.MINUTE_MS, i, 1)
        self.conn.execute("ANALYZE")
        self.conn.commit()
        g = self.guard()
        rows = m.read_2b(g, m.Ledger())
        self.assertEqual(len(rows), 2000)
        plan = g.planned[("2b", m._sql_2b(m.CAPS["2b"] + 1))]
        self.assertTrue(any("sqlite_autoindex_paper_futures_candle_revisions_1" in d for d in plan), plan)
        self.assertFalse(any("TEMP B-TREE" in d for d in plan), plan)

    def test_2b_statement_names_the_primary_key_index(self):
        self.assertIn("INDEXED BY sqlite_autoindex_paper_futures_candle_revisions_1", m._sql_2b(10))
        self.assertIn("INDEXED BY sqlite_autoindex_paper_futures_official_candles_1", m._sql_2a(10))

    def test_the_secondary_index_would_have_been_rejected_by_the_gate(self):
        g = self.guard()
        sql = ("SELECT bucket_start FROM paper_futures_candle_revisions INDEXED BY paper_futures_candle_revisions_bucket "
               "WHERE interval_ms = 60000 AND bucket_start >= 0 AND bucket_start < 10 ORDER BY candle_id, revision LIMIT 5")
        with self.assertRaises(m.Stopped) as ctx:
            g.fetch("2b", sql)
        self.assertEqual(ctx.exception.reason, "query_plan")
