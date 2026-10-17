"""Synthetic tests for capture_funding_184: the measurements, the hypotheses and the guards it inherits. No real data is touched."""
import contextlib
import io
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from unittest import mock

from balancita_engine import capture_funding_184 as t
from balancita_engine import capture_minimal_read as m
from balancita_engine import capture_validation as cv

A0, A1 = m.WINDOW_A
H = 3_600_000
SCHEMA = open(os.path.join(os.path.dirname(__file__), "real_futures_schema.sql"), encoding="utf-8").read()
PRICE, REL, RATE = "81234.5", "0.0000125", "1.01543125"          # REL * PRICE == RATE exactly
SECRETS = (PRICE, REL, RATE)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def body(server_ms, start, rate, rel):
    return ('{"result":"success","serverTime":"%s","rates":[{"timestamp":"%s","fundingRate":%s,"relativeFundingRate":%s}]}'
            % (iso(server_ms), iso(start), rate, rel))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "dev-live", m.DB_NAME)
        os.makedirs(os.path.dirname(self.path))
        self.conn = sqlite3.connect(self.path)
        self.conn.executescript(SCHEMA)

    def candles(self, product=m.BTC):
        for b in range(A0, A1, H):
            self.conn.execute("INSERT INTO paper_futures_official_candles VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                              (product, m.MINUTE_MS, b, "h", b + 120_000, PRICE, PRICE, PRICE, PRICE, "1", "r"))

    def period(self, sha, start, rate=RATE, rel=REL, lag_ms=11 * 60_000, product=m.BTC, server_lag_ms=5_000, server_text=None):
        """One response received ``lag_ms`` after the period end, showing the period, and the period row it stored."""
        received = start + H + lag_ms
        text = server_text or iso(received + server_lag_ms)
        raw = body(received + server_lag_ms, start, rate, rel).replace(iso(received + server_lag_ms), text)
        self.conn.execute("INSERT INTO paper_futures_funding_responses VALUES (?,?,?,?)", (sha, received, text, raw))
        self.conn.execute("INSERT INTO paper_futures_funding_periods (response_sha256, start_ms, product_id, end_ms, funding_rate, known_at, unit) VALUES (?,?,?,?,?,?,?)",
                          (sha, start, product, start + H, rate, received, "USD/BTC/hour"))

    def scenario(self):
        self.candles()
        self.period("r1", A0 + 10 * H)                                          # clean
        self.period("r2", A0 + 12 * H)                                          # a period with two rates
        self.period("r3", A0 + 12 * H, rate="2.0308", rel="0.000025385", lag_ms=20 * 60_000)
        self.period("r4", A0 + 14 * H, rate="5.0")                              # absolute != relative * price
        self.conn.commit()

    def guard(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        return m._Guard(ro, time.monotonic())

    def rows(self):
        g = self.guard()
        ledger, reads = m.Ledger(), m.Reads()
        return t.read_reference(g, ledger), m.read_2c(g, ledger, reads), m.read_2d(g, ledger, reads)

    def run_tool(self, **patches):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        try:
            with mock.patch.object(m, "MIN_SIZE_BYTES", 0):
                return t.build_result(ro, prior_rows=63_089)
        finally:
            ro.close()


class MeasurementTests(Fixture):
    def setUp(self):
        super().setUp()
        self.scenario()
        self.out = t.measure(*self.rows())

    def test_coverage_is_per_product_and_per_hour(self):
        btc, eth = self.out["coverage"][m.BTC], self.out["coverage"][m.ETH]
        self.assertEqual((btc["expected_hours"], btc["hours_with_a_definitive_period"], btc["hours_not_covered"]), (48, 3, 45))
        self.assertEqual(len(btc["mask"]), 48)
        self.assertEqual([i for i, c in enumerate(btc["mask"]) if c == "1"], [10, 12, 14])
        self.assertEqual((btc["first_not_covered_ms"], btc["last_not_covered_ms"]), (A0, A1 - H))
        self.assertEqual((btc["hours_without_any_row"], btc["hours_only_provisional"], btc["hours_only_from_rejected_responses"]), (45, 0, 0))
        self.assertEqual((eth["hours_with_a_definitive_period"], eth["hours_not_covered"], eth["hours_without_any_row"]), (0, 48, 48))

    def test_an_hour_with_only_a_provisional_row_is_not_covered_and_is_published_apart(self):
        self.period("p1", A0 + 20 * H, lag_ms=30_000)                    # received 30 s after the end: the server clock shows it still open
        self.period("p2", A0 + 22 * H, server_text="2026-13-45T99:00:00Z")      # stored by a response the adapter rejects
        out = t.measure(*self.rows())
        btc = out["coverage"][m.BTC]
        self.assertEqual([i for i, c in enumerate(btc["mask"]) if c == "1"], [10, 12, 14])
        self.assertEqual((btc["hours_with_a_definitive_period"], btc["hours_only_provisional"], btc["hours_only_from_rejected_responses"]),
                         (3, 1, 1))
        self.assertEqual(btc["hours_without_any_row"], 43)
        self.assertEqual(btc["hours_not_covered"], 45)

    def test_revisions_count_rows_and_distinct_rates_without_publishing_them(self):
        rev = self.out["revisions"][m.BTC]
        self.assertEqual(rev["periods"], 3)
        self.assertEqual(rev["periods_by_number_of_rows"], {"1": 2, "2": 1})
        self.assertEqual(rev["periods_with_distinct_rates"], 1)

    def test_units_error_is_a_ratio_and_the_reference_age_is_measured(self):
        u = self.out["units_and_reference"][m.BTC]
        self.assertEqual(u["units"], {"USD/BTC/hour": 4})
        self.assertEqual((u["rows_with_relative_rate"], u["rows_checked"], u["rows_without_fresh_reference"]), (4, 4, 0))
        self.assertEqual(u["relative_error"]["n"], 4)
        self.assertEqual(Decimal_(u["relative_error"]["min"]), 0)
        self.assertGreater(Decimal_(u["relative_error"]["max"]), Decimal_("0.5"))          # 5.0 vs 1.0154
        self.assertEqual(u["reference_age_ms"]["max"], H - 60_000)          # the candle of the previous hour, whose close is one minute later
        self.assertEqual(u["reference_max_age_ms"], 2 * H)

    def test_a_period_without_a_fresh_reference_is_counted_not_guessed(self):
        official, periods, responses = self.rows()
        official = [r for r in official if not A0 + 6 * H <= r[1] < A0 + 11 * H]
        out = t.measure(official, periods, responses)
        u = out["units_and_reference"][m.BTC]
        self.assertGreaterEqual(u["rows_without_fresh_reference"], 1)
        self.assertEqual(u["rows_checked"] + u["rows_without_fresh_reference"], u["rows_with_relative_rate"])

    def test_publication_offsets_and_classification(self):
        first = self.out["publication"]["first_definitive_response"][m.BTC]
        self.assertEqual((first["periods"], first["with_a_definitive_response"], first["without"]), (3, 3, 0))
        self.assertEqual(first["received_minus_end_ms"]["min"], 11 * 60_000)
        cls = self.out["publication"]["classification"]["per_product"][m.BTC]["publication"]
        self.assertEqual((cls["early_count"], cls["late_count"], cls["not_causal_count"]), (0, 0, 0))

    def test_timings_publish_the_clock_offset_and_no_digit_of_a_time(self):
        q = self.out["timings"]["server_minus_receipt_ms"][m.BTC]
        self.assertEqual((q["n"], q["min"], q["max"]), (4, 5_000, 5_000))
        self.assertEqual(self.out["timings"]["server_time_rejected"], [])

    def test_hypotheses_are_mechanical_and_carry_their_counts(self):
        h = self.out["hypotheses"]
        self.assertEqual(h["relativo_por_precio_igual_al_absoluto"]["verdict"], "contradicha")
        self.assertEqual(h["relativo_por_precio_igual_al_absoluto"]["against"], 1)
        self.assertEqual(h["definitivo_no_antes_de_10_min"]["verdict"], "sostenida")
        self.assertEqual(h["definitivo_no_antes_de_10_min"]["periods_measured"], 3)
        self.assertEqual(h["definitivo_dentro_del_plazo"]["verdict"], "sostenida")
        self.assertEqual(h["primero_visto_gana"]["verdict"], "contradicha")
        self.assertEqual(h["primero_visto_gana"]["periods_with_distinct_rates"], 1)

    def test_an_early_response_contradicts_the_ten_minute_hypothesis(self):
        # received 2 s before end + 10 min, while the server clock already shows the period definitive
        self.period("r5", A0 + 16 * H, lag_ms=10 * 60_000 - 2_000, server_lag_ms=62_000)
        out = t.measure(*self.rows())
        h = out["hypotheses"]
        self.assertEqual((h["definitivo_no_antes_de_10_min"]["verdict"], h["definitivo_no_antes_de_10_min"]["against_early"]), ("contradicha", 1))
        self.assertEqual(h["definitivo_dentro_del_plazo"]["verdict"], "sostenida")

    def test_a_not_causal_row_contradicts_the_ten_minute_hypothesis(self):
        # stored 30 minutes before the end of its period by a response the adapter rejects (never flagged provisional)
        self.period("r6", A0 + 18 * H, lag_ms=-30 * 60_000, server_text="2026-13-45T99:00:00Z")
        h = t.measure(*self.rows())["hypotheses"]
        self.assertEqual((h["definitivo_no_antes_de_10_min"]["verdict"], h["definitivo_no_antes_de_10_min"]["against_not_causal"]),
                         ("contradicha", 1))
        self.assertEqual(h["definitivo_dentro_del_plazo"]["verdict"], "sostenida")

    def test_a_late_period_contradicts_the_deadline_hypothesis_and_not_the_ten_minute_one(self):
        s2 = A0 + 20 * H
        self.period("l1", s2, lag_ms=30_000)                             # open when seen
        self.period("l2", s2 + H, lag_ms=15 * 60_000)                    # 75 min after the end of s2: past the deadline, s2 not listed
        self.period("l3", s2, lag_ms=90 * 60_000)                        # s2 definitive, too late
        out = t.measure(*self.rows())
        pub = out["publication"]["classification"]["per_product"][m.BTC]["publication"]
        self.assertEqual(pub["late_count"], 1)
        h = out["hypotheses"]
        self.assertEqual((h["definitivo_dentro_del_plazo"]["verdict"], h["definitivo_dentro_del_plazo"]["against_late"]), ("contradicha", 1))
        self.assertEqual(h["definitivo_no_antes_de_10_min"]["verdict"], "sostenida")

    def test_the_first_definitive_response_is_the_earliest_one(self):
        # A0 + 12 h is shown definitive by r2 at +11 min and again by r3 at +20 min: the offset is the first one
        first = self.out["publication"]["first_definitive_response"][m.BTC]
        self.assertEqual((first["with_a_definitive_response"], first["received_minus_end_ms"]["min"], first["received_minus_end_ms"]["max"]),
                         (3, 11 * 60_000, 11 * 60_000))

    def test_provisional_rows_are_not_revisions(self):
        self.period("r8", A0 + 20 * H, rate="9.0", lag_ms=30_000)        # the open hour, seen with another rate before it closed
        self.period("r9", A0 + 20 * H)                                   # the definitive row of the same period
        rev = t.measure(*self.rows())["revisions"][m.BTC]
        self.assertEqual((rev["periods"], rev["periods_by_number_of_rows"], rev["periods_with_distinct_rates"]), (4, {"1": 3, "2": 1}, 1))

    def test_units_only_judge_rows_inside_the_window(self):
        official, period_rows, responses = self.rows()
        periods = m.funding_inputs(period_rows, responses)[0]
        outside = dict(next(p for p in periods if p["product_id"] == m.BTC and "relative_rate" in p), start_ms=A1 + H, end_ms=A1 + 2 * H,
                       funding_rate="500.0")
        u = t.units_and_reference(periods + [outside], official)[m.BTC]
        self.assertEqual((u["rows_checked"], u["units"]), (4, {"USD/BTC/hour": 4}))

    def test_nothing_with_a_rate_or_a_price_is_published(self):
        text = json.dumps(self.out)
        for secret in SECRETS + ("2.0308", "0.000025385", "5.0"):
            self.assertNotIn(secret, text)

    def test_the_verdict_has_no_threshold(self):
        self.assertEqual(t.verdict(0, 0), "no_medible")
        self.assertEqual(t.verdict(5, 0), "no_medible")
        self.assertEqual(t.verdict(0, 1), "sostenida")
        self.assertEqual(t.verdict(1, 1000), "contradicha")


def Decimal_(x):
    from decimal import Decimal
    return Decimal(x)


class EmptyCaptureTests(Fixture):
    def test_nothing_measured_is_not_measurable_never_sustained(self):
        out = self.run_tool()
        self.assertIsNone(out["stopped"])
        h = out["measurements"]["hypotheses"]
        self.assertTrue(all(v["verdict"] == "no_medible" for v in h.values()))
        self.assertEqual(out["measurements"]["coverage"][m.BTC]["mask"], "0" * 48)


class GuardTests(Fixture):
    def test_the_window_and_the_exception_are_the_only_ones_the_validators_accept(self):
        self.assertEqual((t.WINDOW, m.HOLDOUT_WINDOW), ((1_791_590_400_000, 1_791_763_200_000),) * 2)
        self.assertEqual(cv.HOLDOUT_START_MS, 1_785_628_800_000)                      # not touched
        cv.holdout_exception(m.HOLDOUT_WINDOW)
        for window in ((A0 - H, A1 + 3 * H), (A0, A1 + m.MINUTE_MS), (A0 - m.MINUTE_MS, A1), (cv.HOLDOUT_START_MS, 10 ** 13)):
            with self.assertRaises(ValueError):
                cv.holdout_exception(window)

    def test_products_and_decisions_are_fixed(self):
        self.assertEqual(t.PRODUCTS, (m.BTC, m.ETH))
        self.assertIn("BAL-DECISION-184-02", t.DECISIONS)

    def test_caps_are_the_proposed_ones_and_the_total_covers_the_stages(self):
        self.assertEqual((t.CAP_REFERENCE, t.TOTAL_ROWS_CAP, t.MAX_BODY_BYTES), (6_000, 8_000, 200_000_000))
        self.assertEqual((m.CAPS["2c"], m.CAPS["2d"]), (600, 1_200))
        self.assertEqual(t.need_rows(), 7_800)
        self.assertLessEqual(t.need_rows(), t.TOTAL_ROWS_CAP)
        self.assertGreaterEqual(t.CAP_REFERENCE, 2 * 2_880 + 1)
        self.assertEqual(m.TOTAL_ROWS_CAP, 173_000)                                   # the 185-02 total is neither used nor changed

    def test_the_run_reads_only_the_three_authorised_tables_and_never_writes(self):
        self.scenario()
        self.conn.commit()
        ro = m._open_readonly(self.path)
        seen = []
        ro.set_trace_callback(seen.append)
        with mock.patch.object(m, "MIN_SIZE_BYTES", 0):
            out = t.build_result(ro, prior_rows=63_089)
        ro.close()
        self.assertIsNone(out["stopped"])
        self.assertEqual(out["guards"], {"opened_with": "mode=ro", "query_only_readback": 1})
        selects = [s for s in seen if s.lstrip().upper().startswith("SELECT") or s.lstrip().upper().startswith("EXPLAIN")]
        self.assertTrue(selects)
        self.assertFalse([s for s in seen if s.lstrip().upper().split(" ")[0] in ("INSERT", "UPDATE", "DELETE", "ATTACH", "CREATE", "DROP")
                               or s.strip().upper().startswith("PRAGMA") and s.strip().lower() != "pragma query_only"])
        for sql in selects:
            for forbidden in ("candle_revisions", "market_events", "ticker", "quote"):
                self.assertNotIn(forbidden, sql)
        tables = {tb for tb in ("official_candles", "funding_periods", "funding_responses") if any(tb in s for s in selects)}
        self.assertEqual(tables, {"official_candles", "funding_periods", "funding_responses"})

    def test_every_statement_plans_as_a_search_without_scan_or_temp_btree(self):
        self.scenario()
        out = self.run_tool()
        plans = [line for entry in out["reads"] if entry.get("plan") for line in entry["plan"]]
        self.assertTrue(plans)
        self.assertTrue(all(not p.startswith("SCAN") or "subquery" in p or p.strip() in ("SCAN w",) for p in plans))
        self.assertFalse(any("TEMP B-TREE" in p for p in plans))

    def test_the_reference_stage_stops_on_its_own_row_cap(self):
        self.scenario()
        with mock.patch.object(t, "CAP_REFERENCE", 10):
            out = self.run_tool()
        self.assertEqual(out["stopped"]["reason"], "row_budget")
        self.assertEqual(out["stopped"]["detail"]["stage"], "2a")
        self.assertNotIn("measurements", out)

    def test_the_reference_cap_is_the_total_of_both_products(self):
        self.scenario()
        self.candles(m.ETH)                                              # 48 candles each: 96 together, 48 alone
        with mock.patch.object(t, "CAP_REFERENCE", 60):
            out = self.run_tool()
        self.assertEqual((out["stopped"]["reason"], out["stopped"]["detail"]["stage"], out["stopped"]["detail"]["product"]),
                         ("row_budget", "2a", m.ETH))
        with mock.patch.object(t, "CAP_REFERENCE", 96):
            self.assertIsNone(self.run_tool()["stopped"])
        with mock.patch.object(t, "CAP_REFERENCE", 95):
            self.assertEqual(self.run_tool()["stopped"]["reason"], "row_budget")

    def test_the_total_is_checked_before_reading(self):
        self.scenario()
        with mock.patch.object(t, "TOTAL_ROWS_CAP", 100):
            out = self.run_tool()
        self.assertEqual(out["stopped"]["reason"], "global_cap")
        self.assertNotIn("reads", out)

    def test_the_total_counts_every_single_row_read_and_is_checked_after(self):
        self.scenario()
        with mock.patch.object(m.Reads, "total", return_value=10 ** 6):
            out = self.run_tool()
        self.assertEqual(out["stopped"]["reason"], "total_rows")
        self.assertNotIn("measurements", out)

    def test_a_clean_run_counts_within_the_total_and_does_not_add_prior_rows(self):
        self.scenario()
        out = self.run_tool()
        self.assertIsNone(out["stopped"])
        self.assertLessEqual(out["rows_total"]["total"], t.TOTAL_ROWS_CAP)
        self.assertEqual(out["global_rows"]["prior_rows_published_not_counted"], 63_089)
        self.assertIn("single_row_reads_by_kind", out["rows_total"])

    def test_a_connection_that_is_not_query_only_stops(self):
        rw = sqlite3.connect(self.path)
        self.addCleanup(rw.close)
        out = t.build_result(rw, prior_rows=0)
        self.assertEqual(out["stopped"]["reason"], "connection_not_query_only")

    def test_negative_or_non_integer_prior_rows_stop(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        for bad in (-1, True, "1"):
            self.assertEqual(t.build_result(ro, prior_rows=bad)["stopped"]["reason"], "prior_rows")

    def test_the_authorizer_denies_the_candle_revisions_table_and_writes(self):
        g = self.guard()
        with self.assertRaises(sqlite3.DatabaseError):
            g.fetch("2c", "SELECT candle_id FROM paper_futures_candle_revisions")
        with self.assertRaises(sqlite3.DatabaseError):
            g.fetch("2c", "SELECT raw_response FROM paper_futures_funding_responses")      # a column 2c does not allow


class CliTests(Fixture):
    def test_cli_takes_only_db_and_prior_rows(self):
        for extra in (["--window", "1"], ["--product", "PF_XBTUSD"], ["--out", "x"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                t.main(["--db", self.path, "--prior-rows", "0"] + extra)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            t.main(["--db", self.path])

    def test_a_file_that_is_not_the_identified_capture_is_refused(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(t.main(["--db", self.path, "--prior-rows", "0"]), 2)           # smaller than the identified file
        self.assertIn("refused", err.getvalue())

    def test_a_negative_prior_rows_is_refused(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(t.main(["--db", self.path, "--prior-rows", "-1"]), 2)

    def test_two_runs_over_the_same_rows_give_the_same_measurements(self):
        self.scenario()
        outs = []
        for _ in range(2):
            buf = io.StringIO()
            with mock.patch.object(m, "MIN_SIZE_BYTES", 0), contextlib.redirect_stdout(buf):
                self.assertEqual(t.main(["--db", self.path, "--prior-rows", "63089"]), 0)
            outs.append(json.loads(buf.getvalue()))
        self.assertEqual(outs[0]["measurements"], outs[1]["measurements"])
        self.assertEqual(outs[0]["reads"], outs[1]["reads"])
        self.assertEqual(outs[0]["python_version"], sys.version.split()[0])
        self.assertTrue(outs[0]["source"]["same_device_and_inode"])
        self.assertEqual(len(outs[0]["fingerprint_sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
