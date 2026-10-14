import json
import unittest

from balancita_engine import capture_validation as cv

H = cv.HOUR_MS
T0 = 1_780_000_000_000 - (1_780_000_000_000 % H)  # aligned hour, well before the holdout
T1 = T0 + 6 * H
XBT = ["PF_XBTUSD"]


def kinds(result_or_findings, check=None):
    findings = getattr(result_or_findings, "findings", result_or_findings)
    return sorted(f["kind"] for f in findings if check is None or f["check"] == check)


def checks(result, kind=None):
    return sorted(f["check"] for f in result.findings if kind is None or f["kind"] == kind)


def period(start, rate="0.5", product="PF_XBTUSD", known=None, relative="0.000005", **extra):
    row = {"product_id": product, "start_ms": start, "end_ms": start + H, "funding_rate": rate,
           "unit": "USD/BTC/hour" if product == "PF_XBTUSD" else "USD/ETH/hour",
           "known_at": start + H + 60_000 if known is None else known, "response_sha256": "a" * 64}
    if relative is not None:
        row["relative_rate"] = relative
    row.update(extra)
    return row


def full_funding(product="PF_XBTUSD"):
    return [period(T0 + i * H, product=product) for i in range(6)]


def hourly_polls(product="PF_XBTUSD", delay=60_000):
    """One poll shortly after each period end; each poll holds every period published so far."""
    return [{"product_id": product, "received_at": T0 + (i + 1) * H + delay,
             "starts": [T0 + j * H for j in range(i + 1)]} for i in range(6)]


REFS = {"PF_XBTUSD": [(T0 + i * H - H, "100000") for i in range(7)]}  # a fresh price before every period


def run_funding(rows=None, **kw):
    args = dict(references=REFS, responses=hourly_polls())
    args.update(kw)
    return cv.validate_funding(full_funding() if rows is None else rows, T0, T1, XBT, **args)


class RangeGuardTests(unittest.TestCase):
    def test_holdout_is_refused(self):
        with self.assertRaises(ValueError):
            cv.assert_range_allowed(T0, cv.HOLDOUT_START_MS + 1)
        cv.assert_range_allowed(T0, cv.HOLDOUT_START_MS)  # exclusive end: touching it is not inside it

    def test_empty_or_bad_range(self):
        for bad in ((T0, T0), (T0, "x"), (True, T1)):
            with self.assertRaises(ValueError):
                cv.assert_range_allowed(*bad)

    def test_every_validator_applies_the_guard(self):
        over = cv.HOLDOUT_START_MS + 1
        for call in (lambda: cv.validate_funding([], T0, over, XBT),
                     lambda: cv.validate_quotes([], T0, over, XBT),
                     lambda: cv.validate_candles("PF_XBTUSD", [], [], T0, over)):
            with self.assertRaises(ValueError):
                call()

    def test_products_must_be_explicit_and_valid(self):
        for bad in ([], "PF_XBTUSD", ["PF_DOGEUSD"]):
            with self.assertRaises(ValueError):
                cv.validate_funding([], T0, T1, bad)


class FundingTests(unittest.TestCase):
    def test_fully_measured_clean_series(self):
        result = run_funding()
        self.assertEqual(result.findings, [])
        self.assertEqual(result.coverage["funding.rows"], {"PF_XBTUSD": 6})
        self.assertEqual(result.coverage["funding.publication"], {"PF_XBTUSD": 6})
        self.assertEqual(result.coverage["funding.relative"], {"PF_XBTUSD": 6})

    def test_no_rows_is_not_measurable_not_clean(self):
        result = cv.validate_funding([], T0, T1, XBT)
        self.assertEqual(sorted((f["kind"], f["check"]) for f in result.findings if f.get("not_measurable")),
                         [(cv.ABSENT, "funding.publication"), (cv.ABSENT, "funding.relative"), (cv.ABSENT, "funding.rows")])
        coverage = [f for f in result.findings if f["check"] == "funding.coverage"]
        self.assertEqual(coverage[0]["missing_count"], 6)  # an expected product with no rows still has missing hours

    def test_expected_product_without_rows_is_reported_among_others(self):
        result = cv.validate_funding(full_funding(), T0, T1, ["PF_XBTUSD", "PF_ETHUSD"], references=REFS, responses=hourly_polls())
        eth = [f for f in result.findings if f["product"] == "PF_ETHUSD" and f["check"] == "funding.coverage"]
        self.assertEqual([f["kind"] for f in eth], [cv.ABSENT])

    def test_backfill_only_without_relative_is_blocked_by_the_report(self):
        rows = [period(T0 + i * H, known=T0 + 40 * H, relative=None) for i in range(6)]
        result = cv.validate_funding(rows, T0, T1, XBT)
        self.assertEqual(result.coverage["funding.publication"], {"PF_XBTUSD": 0})
        self.assertEqual(result.coverage["funding.relative"], {"PF_XBTUSD": 0})
        sample = {"source": "fixture", "version": "v0", "from_ms": T0, "to_ms": T1, "products": XBT}
        report = cv.build_report(sample, [result], ("funding",))
        self.assertEqual(report["fitness"], "bloqueada")

    def test_unit_mismatch_is_discrepancy(self):
        rows = full_funding()
        rows[2]["unit"] = "relative_per_hour"
        self.assertEqual(kinds(run_funding(rows), "funding.unit"), [cv.DISCREPANCY])

    def test_period_must_be_one_aligned_hour(self):
        rows = full_funding()
        rows[1]["end_ms"] += 1
        rows[3]["start_ms"] += 1
        rows[3]["end_ms"] += 1
        self.assertEqual(len(kinds(run_funding(rows), "funding.period")), 2)

    def test_missing_hours_are_absent_not_discrepancy(self):
        rows = [r for i, r in enumerate(full_funding()) if i not in (2, 3)]
        found = [f for f in run_funding(rows).findings if f["check"] == "funding.coverage"]
        self.assertEqual([(f["kind"], f["missing_count"], f["first_missing_ms"]) for f in found], [(cv.ABSENT, 2, T0 + 2 * H)])

    def test_contradictory_revisions(self):
        rows = full_funding() + [period(T0 + H, rate="0.7")]
        found = [f for f in run_funding(rows).findings if f["check"] == "funding.revision"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["rates"], ["0.5", "0.7"])

    def test_identical_revisions_do_not_conflict(self):
        rows = full_funding() + [period(T0 + H, rate="0.50")]
        self.assertEqual(kinds(run_funding(rows), "funding.revision"), [])

    def test_relative_vs_absolute_uses_a_relative_tolerance(self):
        rows = full_funding()
        rows[1]["relative_rate"] = "0.00001"  # implies 1.0 against 0.5
        found = [f for f in run_funding(rows).findings if f["check"] == "funding.relative_vs_absolute"]
        self.assertEqual([f["start_ms"] for f in found], [T0 + H])

    def test_tolerance_scales_with_the_price_of_a_cheap_product(self):
        # ADA-like: absolute 1e-7, relative 2e-7 at price 0.5 implies 1e-7 vs 1.2e-7 (20 % off) -> must be flagged
        ref = {"PF_ADAUSD": [(T0 - H, "0.5")]}
        row = {"product_id": "PF_ADAUSD", "start_ms": T0, "end_ms": T0 + H, "funding_rate": "0.0000001",
               "unit": "USD/ADA/hour", "known_at": T0 + H + 1, "response_sha256": "b" * 64, "relative_rate": "0.00000024"}
        result = cv.validate_funding([row], T0, T0 + H, ["PF_ADAUSD"], references=ref)
        self.assertEqual(kinds(result, "funding.relative_vs_absolute"), [cv.DISCREPANCY])

    def test_stale_reference_price_does_not_count(self):
        old = {"PF_XBTUSD": [(T0 - 200 * 24 * H, "100000")]}
        found = [f for f in run_funding(references=old).findings if f["check"] == "funding.reference_price"]
        self.assertEqual({f["kind"] for f in found}, {cv.ABSENT})
        self.assertEqual(len(found), 6)

    def test_future_reference_price_does_not_count(self):
        future = {"PF_XBTUSD": [(T0 + 10 * H, "100000")]}
        self.assertEqual(len([f for f in run_funding(references=future).findings if f["check"] == "funding.reference_price"]), 6)

    def test_known_before_period_end_is_not_causal(self):
        rows = full_funding()
        rows[0]["known_at"] = T0 + 10
        self.assertEqual(kinds(run_funding(rows), "funding.publication"), [cv.DISCREPANCY])

    def test_publication_late_is_proven_only_by_a_later_poll_that_lacks_it(self):
        polls = hourly_polls()
        # period 0 first appears 3 h late; the poll at the 2 h mark (past the 1 h deadline) lacks it: proven late
        for poll in polls:
            poll["starts"] = [s for s in poll["starts"] if s != T0 or poll["received_at"] > T0 + 4 * H]
        found = [f for f in run_funding(responses=polls).findings if f["check"] == "funding.publication"]
        self.assertEqual([(f["kind"], f["count"]) for f in found], [(cv.DISCREPANCY, 1)])

    def test_collector_down_is_not_attributed_to_kraken(self):
        # polls missing between period 0's deadline and its first holder: nothing proves lateness -> not measurable
        polls = [p for p in hourly_polls() if p["received_at"] not in (T0 + 2 * H + 60_000, T0 + 3 * H + 60_000)]
        for poll in polls:
            poll["starts"] = [s for s in poll["starts"] if s != T0 or poll["received_at"] >= T0 + 4 * H]
        found = [f for f in run_funding(responses=polls).findings if f["check"] == "funding.publication"]
        self.assertEqual([f["kind"] for f in found], [cv.ABSENT])
        self.assertTrue(found[0]["not_measurable"])

    def test_holdout_rows_and_references_are_dropped_not_judged(self):
        late = period(cv.HOLDOUT_START_MS + H, rate="0.31415")
        refs = {"PF_XBTUSD": REFS["PF_XBTUSD"] + [(cv.HOLDOUT_START_MS + 1, "999999")]}
        result = run_funding(full_funding() + [late], references=refs)
        errors = [f for f in result.findings if f["kind"] == cv.VALIDATOR_ERROR]
        self.assertEqual(len(errors), 1)
        self.assertNotIn("0.31415", json.dumps(result.findings))
        self.assertEqual(result.coverage["funding.rows"], {"PF_XBTUSD": 6})

    def test_malformed_rows_are_validator_errors_not_capture_findings(self):
        rows = full_funding()
        rows[0]["funding_rate"] = "abc"
        rows[1]["funding_rate"] = 0.5  # float: not a decimal string
        rows.append({"product_id": "PF_XBTUSD"})
        rows.append("not a dict")
        found = run_funding(rows).findings
        self.assertEqual(sum(1 for f in found if f["kind"] == cv.VALIDATOR_ERROR), 4)

    def test_product_outside_the_expected_list_is_malformed(self):
        found = run_funding([period(T0, product="PF_ETHUSD")])
        self.assertIn(cv.VALIDATOR_ERROR, kinds(found))


def quote(i, product="PF_XBTUSD", bid="100", ask="101", epoch=1, at=None, seq=None, event=None):
    at = T0 + i * 1_000 if at is None else at
    return {"product_id": product, "bid": bid, "ask": ask, "received_at": at,
            "event_time": at - 50 if event is None else event, "epoch": epoch, "seq": at if seq is None else seq}


ALL = sorted(cv.ALLOWED_PRODUCTS)


def all_products(count=10):
    return [quote(i, product=p) for p in ALL for i in range(count)]


class QuoteTests(unittest.TestCase):
    END = T0 + 10_000

    def run_quotes(self, rows, **kw):
        return cv.validate_quotes(rows, T0, self.END, ALL, **kw)

    def test_clean_rest_feed_with_seq_equal_to_received_at(self):
        result = self.run_quotes(all_products())
        self.assertEqual(result.findings, [])  # no contiguity is demanded of a seq that is a timestamp
        self.assertEqual(set(result.coverage["quote.intervals"].values()), {9})

    def test_contiguous_seq_is_opt_in(self):
        rows = [dict(r, seq=i % 10) for i, r in enumerate(all_products())]
        result = self.run_quotes(rows, contiguous_seq=True)
        self.assertEqual(result.findings, [])
        rows[2]["seq"] = 5
        self.assertEqual(kinds(self.run_quotes(rows, contiguous_seq=True), "quote.sequence"), [cv.ABSENT])  # 1 -> 5 is a gap; 5 -> 3 is an ordering error
        self.assertEqual(kinds(self.run_quotes(rows, contiguous_seq=True), "quote.arrival_order"), [cv.DISCREPANCY])

    def test_seq_must_increase_inside_an_epoch(self):
        rows = all_products()
        rows[3]["seq"] = rows[2]["seq"]
        self.assertEqual(kinds(self.run_quotes(rows), "quote.arrival_order"), [cv.DISCREPANCY])

    def test_reconnect_is_an_event_not_a_finding(self):
        rows = all_products()
        for row in rows[6:10]:
            row["epoch"] = 2
        result = self.run_quotes(rows)
        self.assertEqual(result.findings, [])
        self.assertEqual([(e["event"], e["from_epoch"], e["to_epoch"]) for e in result.events], [("reconnect", 1, 2)])

    def test_missing_bid_or_ask_is_absent_and_crossed_is_discrepancy(self):
        rows = all_products()
        rows[1]["bid"] = None
        rows[2]["bid"], rows[2]["ask"] = "102", "101"
        rows[3]["bid"] = "0"
        self.assertEqual(kinds(self.run_quotes(rows), "quote.bid_ask"), [cv.ABSENT, cv.DISCREPANCY, cv.DISCREPANCY])

    def test_timestamp_skew_and_order(self):
        rows = all_products()
        rows[4]["event_time"] = rows[4]["received_at"] - 60_000
        rows[5]["received_at"] = rows[3]["received_at"]
        rows[5]["event_time"] = rows[5]["received_at"]
        found = self.run_quotes(rows)
        self.assertEqual(kinds(found, "quote.timestamp_skew"), [cv.DISCREPANCY])
        self.assertEqual(kinds(found, "quote.arrival_order"), [cv.DISCREPANCY])

    def test_initial_interior_and_final_silence(self):
        rows = [r for r in all_products() if not (r["product_id"] == "PF_ETHUSD" and r["received_at"] - T0 in (0, 1_000, 2_000, 4_000, 5_000, 7_000, 8_000, 9_000))]
        found = [f for f in self.run_quotes(rows, stale_ms=2_500).findings if f["check"] == "quote.freshness"]
        self.assertEqual(len(found), 3)  # T0->3 s initial, 3->6 s interior, 6->10 s final
        self.assertTrue(all(f["kind"] == cv.ABSENT and f["product"] == "PF_ETHUSD" for f in found))

    def test_one_quote_per_product_judges_no_interval(self):
        rows = [quote(0, product=p) for p in ALL]
        result = self.run_quotes(rows, stale_ms=100_000)
        self.assertEqual(set(result.coverage["quote.intervals"].values()), {0})
        self.assertEqual(len([f for f in result.findings if f.get("not_measurable") and f["check"] == "quote.intervals"]), 8)

    def test_product_with_no_quotes_is_absent(self):
        rows = [r for r in all_products() if r["product_id"] != "PF_ZECUSD"]
        found = self.run_quotes(rows).findings
        self.assertEqual([(f["kind"], f["product"]) for f in found if f["check"] == "quote.coverage"], [(cv.ABSENT, "PF_ZECUSD")])

    def test_unexpected_product_and_malformed_rows_are_validator_errors(self):
        rows = all_products() + [quote(0, product="PF_DOGEUSD")]
        rows[0]["received_at"] = "x"
        rows[1]["bid"] = "oops"
        found = self.run_quotes(rows)
        self.assertEqual(sum(1 for f in found.findings if f["kind"] == cv.VALIDATOR_ERROR), 3)


def minute_candle(start, o, h, l, c, v="1"):
    return {"bucket_start": start, "open": o, "high": h, "low": l, "close": c, "volume": v}


def five_minutes(start, base=100):
    return [minute_candle(start + i * cv.MINUTE_MS, str(base + i), str(base + i + 2), str(base + i - 1), str(base + i + 1), "2")
            for i in range(5)]


def official_for(start, base=100):
    return {"bucket_start": start, "open": str(base), "high": str(base + 6), "low": str(base - 1),
            "close": str(base + 5), "volume": "10"}


class CandleTests(unittest.TestCase):
    A = (T0 // cv.FIVE_MIN_MS) * cv.FIVE_MIN_MS
    B = A + 2 * cv.FIVE_MIN_MS

    def test_aggregation_math(self):
        bucket = cv.aggregate_to_five_minutes(five_minutes(self.A))[self.A]
        self.assertEqual((str(bucket["open"]), str(bucket["high"]), str(bucket["low"]), str(bucket["close"]), str(bucket["volume"])),
                         ("100", "106", "99", "105", "10"))

    def test_incomplete_bucket_is_not_aggregated(self):
        self.assertEqual(cv.aggregate_to_five_minutes(five_minutes(self.A)[:4]), {})

    def test_match_is_clean_and_counts_what_it_compared(self):
        ours = five_minutes(self.A) + five_minutes(self.A + cv.FIVE_MIN_MS)
        ref = [official_for(self.A), official_for(self.A + cv.FIVE_MIN_MS)]
        result = cv.validate_candles("PF_XBTUSD", ours, ref, self.A, self.B)
        self.assertEqual(result.findings, [])
        self.assertEqual(result.coverage["candles.buckets"], {"PF_XBTUSD": 2})

    def test_nothing_compared_is_not_measurable(self):
        result = cv.validate_candles("PF_XBTUSD", [], [], self.A, self.B)
        self.assertEqual(result.coverage["candles.buckets"], {"PF_XBTUSD": 0})
        self.assertTrue(any(f.get("not_measurable") for f in result.findings))

    def test_field_discrepancies_and_tolerance(self):
        ours = five_minutes(self.A)
        ref = [dict(official_for(self.A), close="105.4", volume="10.1")]
        end = self.A + cv.FIVE_MIN_MS
        found = cv.validate_candles("PF_XBTUSD", ours, ref, self.A, end)
        self.assertEqual(sorted(f["check"] for f in found.findings), ["candles.close", "candles.volume"])
        self.assertEqual(cv.validate_candles("PF_XBTUSD", ours, ref, self.A, end, price_tol="0.5", volume_tol="0.2").findings, [])

    def test_missing_minute_is_absent_ours_not_zero(self):
        ours = [c for c in five_minutes(self.A) if c["bucket_start"] != self.A + 2 * cv.MINUTE_MS]
        found = cv.validate_candles("PF_XBTUSD", ours, [official_for(self.A)], self.A, self.A + cv.FIVE_MIN_MS)
        self.assertEqual([(f["kind"], f["check"]) for f in found.findings if not f.get("not_measurable")], [(cv.ABSENT, "candles.ours")])

    def test_missing_official_and_both_missing(self):
        found = cv.validate_candles("PF_XBTUSD", five_minutes(self.A), [], self.A, self.A + 2 * cv.FIVE_MIN_MS)
        self.assertEqual(sorted(f["check"] for f in found.findings if not f.get("not_measurable")), ["candles.both", "candles.official"])

    def test_misaligned_official_bucket_is_the_reference_problem(self):
        shifted = dict(official_for(self.A), bucket_start=self.A + 3_600_000 + 60_000)
        found = cv.validate_candles("PF_XBTUSD", [], [shifted], self.A, self.B)
        self.assertIn((cv.VALIDATOR_ERROR, "candles.alignment"), [(f["kind"], f["check"]) for f in found.findings])
        self.assertNotIn(cv.DISCREPANCY, kinds(found))

    def test_conflicting_revisions_of_one_minute_are_reported_and_skipped(self):
        ours = five_minutes(self.A) + [minute_candle(self.A + cv.MINUTE_MS, "1", "2", "0", "1", "9")]
        found = cv.validate_candles("PF_XBTUSD", ours, [official_for(self.A)], self.A, self.A + cv.FIVE_MIN_MS)
        self.assertEqual([f["check"] for f in found.findings if f["kind"] == cv.DISCREPANCY], ["candles.revision_conflict"])
        self.assertEqual(found.coverage["candles.buckets"], {"PF_XBTUSD": 0})

    def test_identical_duplicate_minute_is_harmless(self):
        ours = five_minutes(self.A) + [five_minutes(self.A)[0]]
        found = cv.validate_candles("PF_XBTUSD", ours, [official_for(self.A)], self.A, self.A + cv.FIVE_MIN_MS)
        self.assertEqual(found.findings, [])

    def test_holdout_candles_are_dropped(self):
        late = [dict(official_for(cv.HOLDOUT_START_MS + cv.FIVE_MIN_MS), close="77777")]
        found = cv.validate_candles("PF_XBTUSD", five_minutes(self.A), late, self.A, self.A + cv.FIVE_MIN_MS)
        self.assertNotIn("77777", json.dumps(found.findings))
        self.assertIn(cv.VALIDATOR_ERROR, kinds(found))

    def test_malformed_input_is_validator_error(self):
        bad = [minute_candle(self.A + 1, "1", "1", "1", "1")]
        self.assertIn(cv.VALIDATOR_ERROR, kinds(cv.validate_candles("PF_XBTUSD", bad, [], self.A, self.B)))
        found = cv.validate_candles("PF_XBTUSD", [], [{"bucket_start": self.A}], self.A, self.B)
        self.assertIn(cv.VALIDATOR_ERROR, kinds(found))


class ThresholdTests(unittest.TestCase):
    def test_never_adopts_and_rejects_by_evidence(self):
        gaps = [1_000] * 990 + [20_000] * 9 + [30_000]
        result = cv.calibrate_thresholds(gaps)
        self.assertIsNone(result["adopted"])
        by = {r["threshold_ms"]: r for r in result["candidates"]}
        self.assertEqual(by[15_000]["over"], 10)
        self.assertEqual(by[15_000]["verdict"], "rechazado")
        self.assertEqual(by[25_000]["verdict"], "no_rechazado")
        self.assertEqual(by[45_000]["verdict"], "no_rechazado")
        self.assertEqual(result["quantiles_ms"]["p50"], 1_000)

    def test_small_sample_has_no_evidence(self):
        result = cv.calibrate_thresholds([1_000] * 10)
        self.assertEqual({r["verdict"] for r in result["candidates"]}, {"sin_evidencia"})
        self.assertEqual(cv.calibrate_thresholds([])["candidates"][0]["false_alarm_rate"], None)

    def test_bad_parameters(self):
        with self.assertRaises(ValueError):
            cv.calibrate_thresholds([1], max_false_alarm_rate=1)
        with self.assertRaises(ValueError):
            cv.calibrate_thresholds([-1])


class ReportTests(unittest.TestCase):
    SAMPLE = {"source": "fixture", "version": "v0", "from_ms": T0, "to_ms": T1, "products": XBT}

    def quotes_result(self):
        rows = [quote(i, at=T0 + i * 10_000) for i in range(int((T1 - T0) / 10_000))]
        return cv.validate_quotes(rows, T0, T1, XBT)

    def test_fully_measured_and_clean_is_sin_hallazgos(self):
        report = cv.build_report(self.SAMPLE, [run_funding(), self.quotes_result()], ("funding", "quotes"))
        self.assertEqual((report["fitness"], report["counts"]), ("sin_hallazgos", {"ABSENT": 0, "DISCREPANCY": 0, "VALIDATOR_ERROR": 0}))

    def test_report_without_validators_is_blocked_not_clean(self):
        report = cv.build_report(self.SAMPLE, [], ("funding", "quotes", "candles"))
        self.assertEqual(report["fitness"], "bloqueada")
        self.assertTrue(all(f.get("validator_not_run") for f in report["findings"]))
        self.assertEqual(len(report["findings"]), 6)  # 3 funding + 2 quotes + 1 candles checks, one product

    def test_required_family_that_did_not_run_is_flagged(self):
        report = cv.build_report(self.SAMPLE, [run_funding()], ("funding", "quotes"))
        self.assertEqual(report["fitness"], "bloqueada")
        self.assertEqual({f["check"] for f in report["findings"]}, {"quote.records", "quote.intervals"})

    def test_expected_product_missing_from_coverage_is_flagged(self):
        sample = dict(self.SAMPLE, products=["PF_XBTUSD", "PF_ETHUSD"])
        report = cv.build_report(sample, [run_funding()], ("funding",))
        self.assertEqual({f["product"] for f in report["findings"]}, {"PF_ETHUSD"})

    def test_required_must_be_valid_and_non_empty(self):
        for bad in ((), ("nope",)):
            with self.assertRaises(ValueError):
                cv.build_report(self.SAMPLE, [], bad)

    def test_fitness_ladder(self):
        def result_with(*findings):
            r = cv.Result("candles", XBT)
            r.coverage["candles.buckets"]["PF_XBTUSD"] = 1
            r.findings.extend(findings)
            return r
        absent, err, disc = (cv.Finding(k, "x", None, "d") for k in (cv.ABSENT, cv.VALIDATOR_ERROR, cv.DISCREPANCY))
        fit = [cv.build_report(self.SAMPLE, [result_with(*f)], ("candles",))["fitness"]
               for f in ((), (absent,), (err,), (absent, disc))]
        self.assertEqual(fit, ["sin_hallazgos", "bloqueada", "bloqueada", "no_apta"])

    def test_fingerprint_is_deterministic_and_events_are_reported(self):
        rows = [quote(i, at=T0 + i * 10_000, epoch=1 if i < 5 else 2) for i in range(int((T1 - T0) / 10_000))]
        one = cv.build_report(self.SAMPLE, [run_funding(), cv.validate_quotes(rows, T0, T1, XBT)], ("funding", "quotes"))
        two = cv.build_report(self.SAMPLE, [cv.validate_quotes(rows, T0, T1, XBT), run_funding()], ("funding", "quotes"))
        self.assertEqual(one["fingerprint"], two["fingerprint"])
        self.assertEqual(len(one["events"]), 1)
        json.dumps(one)

    def test_sample_must_be_identified_and_off_the_holdout(self):
        with self.assertRaises(ValueError):
            cv.build_report({"source": "x"}, [], ("funding",))
        with self.assertRaises(ValueError):
            cv.build_report(dict(self.SAMPLE, to_ms=cv.HOLDOUT_START_MS + 1), [], ("funding",))

    def test_finding_kind_is_checked(self):
        with self.assertRaises(ValueError):
            cv.Finding("OTHER", "c", None, "d")


if __name__ == "__main__":
    unittest.main()
