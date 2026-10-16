"""Synthetic tests for capture_candle_values: one fixed window, bounded reads, no verdict on a stop. No real data is touched."""
import contextlib
import hashlib
import io
import json
import os
import sqlite3
import tempfile
import time
import unittest
from unittest import mock

from balancita_engine import capture_candle_values as t
from balancita_engine import capture_minimal_read as m
from balancita_engine import capture_validation as cv

C0, C1 = t.WINDOW_C
MIN = m.MINUTE_MS
SCHEMA = open(os.path.join(os.path.dirname(__file__), "real_futures_schema.sql"), encoding="utf-8").read()
PRICE_MARK = "123456.5"          # a distinctive price: it must never reach the output


def values(i, volume="1"):
    return (PRICE_MARK, "123460", "123450", "123455", volume)


def official(conn, bucket, product=m.BTC, vals=None, rev="h", known=None):
    o, h, l, c, v = vals or values(0)
    conn.execute("INSERT INTO paper_futures_official_candles VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                 (product, MIN, bucket, rev, known or bucket + 120_000, o, h, l, c, v, "r"))


def revision(conn, bucket, rev=1, closed=1, vals=None, product=m.BTC):
    o, h, l, c, v = vals or values(0)
    conn.execute("INSERT INTO paper_futures_candle_revisions (candle_id, revision, interval_ms, bucket_start, known_at, close_at, is_closed, coverage, open_price, high_price, low_price, close_price, volume_btc, trade_count, source_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                 ("%s:%d:%d" % (product, MIN, bucket), rev, MIN, bucket, bucket + 61_000, bucket + 60_000,
                  closed, "full", o, h, l, c, v, 3, "s"))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "dev-live", m.DB_NAME)
        os.makedirs(os.path.dirname(self.path))
        self.conn = sqlite3.connect(self.path)
        self.conn.executescript(SCHEMA)

    def fill_window(self, own_volume=None):
        """Both series complete for the 120 minutes; ``own_volume`` maps a minute index to a different own volume."""
        for i in range(t.EXPECTED_MINUTES):
            b = C0 + i * MIN
            official(self.conn, b)
            revision(self.conn, b, 1, 0)
            revision(self.conn, b, 2, 1, values(i, (own_volume or {}).get(i, "1")))

    def ro(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        return ro

    def guard(self):
        return m._Guard(self.ro(), time.monotonic())

    def run_tool(self, prior_rows=0):
        out = t.build_result(self.ro(), prior_rows=prior_rows)
        return out


class ConstantsTests(unittest.TestCase):
    def test_the_window_is_two_hours_inside_the_one_holdout_exception_the_validators_accept(self):
        self.assertEqual((C0, C1), (1_791_720_000_000, 1_791_727_200_000))
        self.assertEqual(C1 - C0, 2 * 3_600_000)
        self.assertTrue(m.HOLDOUT_WINDOW[0] <= C0 and C1 <= m.HOLDOUT_WINDOW[1])
        self.assertEqual(C0 % (5 * MIN), 0)
        self.assertEqual((t.EXPECTED_MINUTES, t.EXPECTED_BUCKETS_5M), (120, 24))

    def test_caps_are_constants_and_their_sum_fits_the_global_budget(self):
        self.assertEqual((t.CAPS["official"], t.CAPS["own"]), (300, 20_000))
        self.assertEqual(t.need_rows(), 300 + 1 + 20_000 + 1)
        self.assertEqual(t.need_rows(), 20_302)
        self.assertEqual(49_291 + t.need_rows(), 69_593)
        self.assertLessEqual(49_291 + t.need_rows(), m.TOTAL_ROWS_CAP)

    def test_the_modules_it_reuses_are_unchanged(self):
        base = os.path.join(os.path.dirname(__file__), "..", "balancita_engine")

        def sha(name):
            return hashlib.sha256(open(os.path.join(base, name), "rb").read()).hexdigest()
        self.assertEqual(sha("capture_minimal_read.py"), "b4e1dc6d4a5568cf37fa4ce800f8acbf8928cdd77e59b8525155ccca2bfd9120")
        self.assertEqual(sha("capture_validation.py"), "0bbb0979fad2fa360e4e83fffac97ac4390ff457fd25997883360491f5f4e2f3")

    def test_both_statements_name_the_primary_key_index(self):
        self.assertIn("INDEXED BY " + m.PK_CANDLES, t._sql_official(301))
        self.assertIn("INDEXED BY " + m.PK_REVISIONS, t._sql_own(20_001))
        self.assertIn("LIMIT 301", t._sql_official(301))
        self.assertIn("LIMIT 20001", t._sql_own(20_001))


class ReadTests(Fixture):
    def test_official_reads_only_the_window_and_the_product_with_a_pk_plan(self):
        for b in (C0, C0 + MIN, C1 - MIN):
            official(self.conn, b)
        official(self.conn, C0 - MIN)                                     # before
        official(self.conn, C1)                                           # the end is excluded
        official(self.conn, C0, product=m.ETH)                            # other product
        ledger = m.Ledger()
        rows = t.read_official(self.guard(), ledger)
        self.assertEqual(sorted(r[1] for r in rows), [C0, C0 + MIN, C1 - MIN])
        self.assertEqual({r[0] for r in rows}, {m.BTC})
        self.assertTrue(any(d.startswith("SEARCH") and m.PK_CANDLES in d for d in ledger.entries[0]["plan"]))

    def test_own_reads_only_the_window_and_the_product_and_hides_open_values(self):
        revision(self.conn, C0, 1, 0, values(0))                          # open: values must be NULL
        revision(self.conn, C0, 2, 1, values(0))
        revision(self.conn, C0 - MIN, 1, 1)                               # before
        revision(self.conn, C1, 1, 1)                                     # the end is excluded
        revision(self.conn, C0, 1, 1, product=m.ETH)                      # other product
        ledger = m.Ledger()
        rows = t.read_own(self.guard(), ledger)
        self.assertEqual(len(rows), 2)
        open_row = [r for r in rows if r[3] == 0][0]
        self.assertTrue(all(v is None for v in open_row[4:]))
        closed_row = [r for r in rows if r[3] == 1][0]
        self.assertEqual(closed_row[4], PRICE_MARK)
        self.assertTrue(any(d.startswith("SEARCH") and m.PK_REVISIONS in d for d in ledger.entries[0]["plan"]))

    def test_official_stops_on_row_budget_without_returning_rows(self):
        for i in range(10):
            official(self.conn, C0 + i * MIN)
        with mock.patch.dict(t.CAPS, {"official": 5}):
            with self.assertRaises(m.Stopped) as ctx:
                t.read_official(self.guard(), m.Ledger())
        self.assertEqual(ctx.exception.reason, "row_budget")

    def test_own_stops_on_row_budget_without_returning_rows(self):
        for i in range(10):
            revision(self.conn, C0 + i * MIN, 1, 1)
        with mock.patch.dict(t.CAPS, {"own": 5}):
            with self.assertRaises(m.Stopped) as ctx:
                t.read_own(self.guard(), m.Ledger())
        self.assertEqual(ctx.exception.reason, "row_budget")

    def test_the_authorizer_denies_any_other_table(self):
        guard = self.guard()
        with self.assertRaises(sqlite3.DatabaseError):
            guard.fetch(t.MODE_OWN, "SELECT product_id FROM paper_futures_funding_periods LIMIT 1")


class MeasuredTests(Fixture):
    def test_equal_values_give_24_buckets_judged_and_no_finding(self):
        self.fill_window()
        out = self.run_tool()
        self.assertIsNone(out["stopped"])
        res = out["outcome"]
        self.assertEqual((res["status"], res["buckets_5m_judged"], res["expected_buckets_5m"]), ("measured", 24, 24))
        self.assertEqual(res["candles_report"]["findings_by_check"], [])
        self.assertEqual(res["own_1m"]["minutes_missing"], 0)
        self.assertEqual(res["official_1m"]["minutes_present"], 120)
        self.assertEqual(out["rows_total"]["rows_read"], 120 + 240)

    def test_one_different_volume_is_one_discrepancy_in_one_bucket(self):
        self.fill_window(own_volume={7: "2"})
        res = self.run_tool()["outcome"]
        findings = res["candles_report"]["findings_by_check"]
        self.assertEqual([(f["kind"], f["check"], f["count"]) for f in findings], [("DISCREPANCY", "candles.volume", 1)])
        self.assertEqual(findings[0]["first_ms"], C0 + 5 * MIN)      # minute 7 is in the second 5-minute bucket
        self.assertEqual(res["buckets_5m_judged"], 24)

    def test_a_missing_own_minute_makes_its_5_minute_bucket_absent_not_a_discrepancy(self):
        self.fill_window()
        self.conn.commit()
        conn2 = sqlite3.connect(self.path)
        conn2.execute("DROP TRIGGER paper_futures_candle_revisions_no_delete")
        conn2.execute("DELETE FROM paper_futures_candle_revisions WHERE bucket_start = ?", (C0 + 3 * MIN,))
        conn2.commit()
        conn2.close()
        res = self.run_tool()["outcome"]
        kinds = {(f["kind"], f["check"]) for f in res["candles_report"]["findings_by_check"]}
        self.assertIn(("ABSENT", "candles.ours"), kinds)
        self.assertFalse(any(k == "DISCREPANCY" for k, _ in kinds))
        self.assertEqual(res["buckets_5m_judged"], 23)

    def test_no_price_or_volume_leaves_the_process(self):
        self.fill_window(own_volume={0: "987654.321"})
        text = json.dumps(self.run_tool())
        for secret in (PRICE_MARK, "123460", "123450", "123455", "987654.321"):
            self.assertNotIn(secret, text)

    def test_the_validator_gets_the_holdout_window_unchanged_and_no_tolerance(self):
        self.fill_window()
        with mock.patch.object(cv, "validate_candles", wraps=cv.validate_candles) as spy:
            self.run_tool()
        self.assertEqual(spy.call_count, 1)
        args, kwargs = spy.call_args
        self.assertEqual(kwargs, {"holdout_window": m.HOLDOUT_WINDOW})
        self.assertEqual(args[0], m.BTC)
        self.assertEqual((args[3], args[4]), (C0, C1))
        self.assertEqual(len(args), 5)                                      # price_tol and volume_tol stay the validator's 0

    def test_the_validator_parameters_say_tolerance_zero(self):
        self.fill_window()
        params = self.run_tool()["outcome"]["candles_report"]["parameters"]
        flat = json.dumps(params)
        self.assertIn('"price_tol": "0"', flat)
        self.assertIn('"volume_tol": "0"', flat)


class NotMeasuredTests(Fixture):
    def test_no_own_revision_at_all_is_not_measured_and_nothing_else_is_read(self):
        for i in range(t.EXPECTED_MINUTES):
            official(self.conn, C0 + i * MIN)
        out = self.run_tool()
        res = out["outcome"]
        self.assertIsNone(out["stopped"])
        self.assertEqual((res["status"], res["reason"]), ("not_measured", "no_own_revision_in_window"))
        self.assertNotIn("candles_report", res)
        self.assertNotIn("buckets_5m_judged", res)
        self.assertEqual([e["stage"] for e in out["reads"]], ["official", "own"])      # no other key, window or product

    def test_only_open_revisions_is_not_measured_too(self):
        for i in range(t.EXPECTED_MINUTES):
            official(self.conn, C0 + i * MIN)
            revision(self.conn, C0 + i * MIN, 1, 0)
        res = self.run_tool()["outcome"]
        self.assertEqual((res["status"], res["reason"]), ("not_measured", "no_closed_own_revision_in_window"))
        self.assertNotIn("candles_report", res)

    def test_an_empty_database_is_not_measured_and_not_an_error(self):
        out = self.run_tool()
        self.assertIsNone(out["stopped"])
        self.assertEqual(out["outcome"]["status"], "not_measured")

    def test_own_revisions_in_other_windows_do_not_count(self):
        revision(self.conn, C0 - MIN, 1, 1)
        revision(self.conn, C1, 1, 1)
        revision(self.conn, C0, 1, 1, product=m.ETH)
        res = self.run_tool()["outcome"]
        self.assertEqual((res["status"], res["reason"]), ("not_measured", "no_own_revision_in_window"))


class StoppedTests(Fixture):
    def assert_no_verdict(self, out, reason):
        self.assertEqual(out["stopped"]["reason"], reason)
        self.assertEqual(out["outcome"]["status"], "stopped")
        text = json.dumps(out)
        for forbidden in ("findings_by_check", "candles_report", "buckets_5m_judged", "fitness", "DISCREPANCY", "minutes_missing"):
            self.assertNotIn(forbidden, text)
        self.assertTrue(out["run_consumed"])

    def test_a_row_budget_stop_in_own_publishes_the_reason_and_the_rows_but_no_verdict(self):
        self.fill_window()
        with mock.patch.dict(t.CAPS, {"own": 50}):
            out = self.run_tool()
        self.assert_no_verdict(out, "row_budget")
        self.assertEqual([e["stage"] for e in out["reads"]], ["official", "own"])
        self.assertGreater(out["rows_total"]["rows_read"], 0)

    def test_a_row_budget_stop_in_official_publishes_no_verdict(self):
        self.fill_window()
        with mock.patch.dict(t.CAPS, {"official": 50}):
            out = self.run_tool()
        self.assert_no_verdict(out, "row_budget")
        self.assertEqual([e["stage"] for e in out["reads"]], ["official"])

    def test_a_query_plan_stop_publishes_no_verdict(self):
        self.fill_window()
        with mock.patch.object(m, "_plan", side_effect=m.Stopped("query_plan", ["SCAN x"])):
            out = self.run_tool()
        self.assert_no_verdict(out, "query_plan")

    def test_a_time_limit_stop_publishes_no_verdict(self):
        self.fill_window()
        with mock.patch.object(m._Guard, "fetch", side_effect=m.Stopped("time_limit", "2b")):
            out = self.run_tool()
        self.assert_no_verdict(out, "time_limit")

    def test_a_database_error_publishes_no_verdict(self):
        self.fill_window()
        with mock.patch.object(m._Guard, "fetch", side_effect=sqlite3.OperationalError("disk I/O error")):
            out = self.run_tool()
        self.assert_no_verdict(out, "database_error")

    def test_a_validator_refusal_publishes_no_verdict(self):
        self.fill_window()
        with mock.patch.object(cv, "validate_candles", side_effect=ValueError("malformed")):
            out = self.run_tool()
        self.assert_no_verdict(out, "validator_refused")

    def test_the_global_budget_stops_before_any_read(self):
        self.fill_window()
        out = self.run_tool(prior_rows=m.TOTAL_ROWS_CAP - 10)
        self.assert_no_verdict(out, "global_cap")
        self.assertNotIn("reads", out)

    def test_exactly_the_remaining_budget_still_runs(self):
        self.fill_window()
        out = self.run_tool(prior_rows=m.TOTAL_ROWS_CAP - t.need_rows())
        self.assertIsNone(out["stopped"])

    def test_a_negative_or_non_integer_prior_rows_stops(self):
        for bad in (-1, True, "3", None):
            out = t.build_result(self.ro(), prior_rows=bad)
            self.assertEqual(out["stopped"]["reason"], "prior_rows")

    def test_a_connection_that_is_not_query_only_stops_before_any_read(self):
        rw = sqlite3.connect(self.path)
        out = t.build_result(rw, prior_rows=0)
        rw.close()
        self.assert_no_verdict(out, "connection_not_query_only")
        self.assertNotIn("reads", out)


class CliTests(Fixture):
    def run_main(self, *extra, min_size=0):
        buf = io.StringIO()
        with mock.patch.object(m, "MIN_SIZE_BYTES", min_size), contextlib.redirect_stdout(buf):
            code = t.main(["--db", self.path] + list(extra))
        return code, buf.getvalue()

    def test_only_db_and_prior_rows_exist_and_both_are_required(self):
        with self.assertRaises(SystemExit):
            t.main(["--db", self.path])
        with self.assertRaises(SystemExit):
            t.main(["--prior-rows", "1"])
        for flag in ("--from", "--to", "--product", "--price-tol", "--volume-tol", "--tolerance"):
            with self.assertRaises(SystemExit):
                t.main(["--db", self.path, "--prior-rows", "1", flag, "1"])

    def test_a_negative_prior_rows_is_refused(self):
        self.assertEqual(t.main(["--db", self.path, "--prior-rows", "-1"]), 2)

    def test_a_file_smaller_than_the_identified_one_is_refused_without_reading(self):
        self.assertEqual(t.main(["--db", self.path, "--prior-rows", "1"]), 2)

    def test_a_completed_run_says_exit_code_0_and_the_same_device_and_inode(self):
        self.fill_window()
        self.conn.commit()
        code, text = self.run_main("--prior-rows", "0")
        out = json.loads(text)
        st = os.stat(self.path)
        self.assertEqual((code, out["exit_code"]), (0, 0))
        self.assertEqual(out["source"]["device_inode_before"], [st.st_dev, st.st_ino])
        self.assertTrue(out["source"]["same_device_and_inode"])
        self.assertEqual(out["outcome"]["status"], "measured")
        self.assertRegex(out["fingerprint_sha256"], r"^[0-9a-f]{64}$")

    def test_a_not_measured_run_is_a_completed_run(self):
        self.conn.commit()
        code, text = self.run_main("--prior-rows", "0")
        out = json.loads(text)
        self.assertEqual((code, out["exit_code"], out["outcome"]["status"]), (0, 0, "not_measured"))

    def test_a_stopped_run_says_exit_code_2_in_its_own_output(self):
        self.conn.commit()
        code, text = self.run_main("--prior-rows", str(m.TOTAL_ROWS_CAP - 10))
        out = json.loads(text)
        self.assertEqual((code, out["exit_code"], out["outcome"]["status"]), (2, 2, "stopped"))

    def test_a_changed_device_or_inode_is_published_as_not_the_same(self):
        st = os.stat(self.path)
        self.assertFalse(t._device_inode(self.path, (st.st_dev, st.st_ino + 1))["same_device_and_inode"])
        self.assertTrue(t._device_inode(self.path, (st.st_dev, st.st_ino))["same_device_and_inode"])

    def test_the_database_is_not_written(self):
        self.fill_window()
        self.conn.commit()
        before = hashlib.sha256(open(self.path, "rb").read()).hexdigest()
        self.run_main("--prior-rows", "0")
        self.assertEqual(hashlib.sha256(open(self.path, "rb").read()).hexdigest(), before)


if __name__ == "__main__":
    unittest.main()
