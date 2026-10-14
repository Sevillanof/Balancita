import json
import unittest

from balancita_engine import capture_validation as cv

H = cv.HOUR_MS
T0 = 1_780_000_000_000 - (1_780_000_000_000 % H)  # aligned hour, well before the holdout
T1 = T0 + 6 * H


def kinds(findings, check=None):
    return sorted(f["kind"] for f in findings if check is None or f["check"] == check)


def period(start, rate="0.5", product="PF_XBTUSD", known=None, **extra):
    row = {"product_id": product, "start_ms": start, "end_ms": start + H, "funding_rate": rate,
           "unit": "USD/BTC/hour" if product == "PF_XBTUSD" else "USD/ETH/hour",
           "known_at": start + H + 60_000 if known is None else known, "response_sha256": "a" * 64}
    row.update(extra)
    return row


def full_funding(product="PF_XBTUSD"):
    return [period(T0 + i * H, product=product) for i in range(6)]


class RangeGuardTests(unittest.TestCase):
    def test_holdout_is_refused(self):
        with self.assertRaises(ValueError):
            cv.assert_range_allowed(T0, cv.HOLDOUT_START_MS + 1)
        cv.assert_range_allowed(T0, cv.HOLDOUT_START_MS)  # touching the boundary is not inside it

    def test_empty_or_bad_range(self):
        for bad in ((T0, T0), (T0, "x"), (True, T1)):
            with self.assertRaises(ValueError):
                cv.assert_range_allowed(*bad)

    def test_every_validator_applies_the_guard(self):
        for call in (lambda: cv.validate_funding([], T0, cv.HOLDOUT_START_MS + 1),
                     lambda: cv.validate_quotes([], T0, cv.HOLDOUT_START_MS + 1),
                     lambda: cv.validate_candles("PF_XBTUSD", [], [], T0, cv.HOLDOUT_START_MS + 1)):
            with self.assertRaises(ValueError):
                call()


class FundingTests(unittest.TestCase):
    def test_clean_series_has_only_the_other_products_missing(self):
        findings = cv.validate_funding(full_funding(), T0, T1)
        self.assertEqual(findings, [])

    def test_unit_mismatch_is_discrepancy(self):
        rows = full_funding()
        rows[2]["unit"] = "relative_per_hour"
        self.assertEqual(kinds(cv.validate_funding(rows, T0, T1), "funding.unit"), [cv.DISCREPANCY])

    def test_period_must_be_one_aligned_hour(self):
        rows = full_funding()
        rows[1]["end_ms"] += 1
        rows[3]["start_ms"] += 1
        rows[3]["end_ms"] += 1
        self.assertEqual(len(kinds(cv.validate_funding(rows, T0, T1), "funding.period")), 2)

    def test_missing_hours_are_absent_not_discrepancy(self):
        rows = [r for i, r in enumerate(full_funding()) if i not in (2, 3)]
        found = [f for f in cv.validate_funding(rows, T0, T1) if f["check"] == "funding.coverage"]
        self.assertEqual([(f["kind"], f["missing_count"], f["first_missing_ms"]) for f in found],
                         [(cv.ABSENT, 2, T0 + 2 * H)])

    def test_contradictory_revisions(self):
        rows = full_funding() + [period(T0 + H, rate="0.7")]
        found = [f for f in cv.validate_funding(rows, T0, T1) if f["check"] == "funding.revision"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["rates"], ["0.5", "0.7"])

    def test_identical_revisions_do_not_conflict(self):
        rows = full_funding() + [period(T0 + H, rate="0.50")]
        self.assertEqual(kinds(cv.validate_funding(rows, T0, T1), "funding.revision"), [])

    def test_relative_vs_absolute_with_reference_price(self):
        refs = {"PF_XBTUSD": [(T0 - H, "100000")]}
        rows = full_funding()
        rows[0]["relative_rate"] = "0.000005"  # 0.000005 * 100000 = 0.5
        rows[1]["relative_rate"] = "0.00001"   # 1.0 != 0.5
        found = [f for f in cv.validate_funding(rows, T0, T1, refs) if f["check"] == "funding.relative_vs_absolute"]
        self.assertEqual([f["start_ms"] for f in found], [T0 + H])

    def test_relative_without_price_is_absent(self):
        rows = full_funding()
        rows[0]["relative_rate"] = "0.000005"
        refs = {"PF_XBTUSD": [(T0 + 10 * H, "100000")]}  # price only from the future: not usable
        found = [f for f in cv.validate_funding(rows, T0, T1, refs) if f["check"] == "funding.reference_price"]
        self.assertEqual([f["kind"] for f in found], [cv.ABSENT])

    def test_known_before_period_end_is_not_causal(self):
        rows = full_funding()
        rows[0]["known_at"] = T0 + 10
        self.assertEqual(kinds(cv.validate_funding(rows, T0, T1), "funding.publication"), [cv.DISCREPANCY])

    def test_late_live_publication_flagged_but_backfill_is_not_judged(self):
        rows = full_funding()
        rows[0]["known_at"] = T0 + H + 90 * 60_000  # live, 90 min after the end
        rows[1]["known_at"] = T0 + 30 * H           # backfilled much later: lag says nothing
        found = [f for f in cv.validate_funding(rows, T0, T1) if f["check"] == "funding.publication"]
        self.assertEqual([f["first_start_ms"] for f in found], [T0])

    def test_malformed_rows_are_validator_errors_not_capture_findings(self):
        rows = full_funding()
        rows[0]["funding_rate"] = "abc"
        rows[1]["funding_rate"] = 0.5  # float: not a decimal string
        rows.append({"product_id": "PF_XBTUSD"})
        rows.append("not a dict")
        found = cv.validate_funding(rows, T0, T1)
        self.assertEqual(kinds(found, "funding.record[0]"), [cv.VALIDATOR_ERROR])
        self.assertEqual(sum(1 for f in found if f["kind"] == cv.VALIDATOR_ERROR), 4)

    def test_product_outside_the_eight_is_rejected_as_malformed(self):
        found = cv.validate_funding([period(T0, product="PF_DOGEUSD")], T0, T1)
        self.assertEqual(kinds(found), [cv.VALIDATOR_ERROR])


def quote(i, product="PF_XBTUSD", at=None, bid="100", ask="101", epoch=1, seq=None, event=None):
    at = T0 + i * 1_000 if at is None else at
    return {"product_id": product, "bid": bid, "ask": ask, "received_at": at,
            "event_time": at - 50 if event is None else event, "epoch": epoch, "seq": i if seq is None else seq}


def all_products(count=10):
    return [dict(quote(i, product=p), seq=i) for p in sorted(cv.ALLOWED_PRODUCTS) for i in range(count)]


class QuoteTests(unittest.TestCase):
    END = T0 + 10_000

    def run_quotes(self, rows, **kw):
        return cv.validate_quotes(rows, T0, self.END, **kw)

    def test_clean_feed(self):
        self.assertEqual(self.run_quotes(all_products()), [])

    def test_missing_bid_or_ask_is_absent_and_crossed_is_discrepancy(self):
        rows = all_products()
        rows[1]["bid"] = None
        rows[2]["bid"], rows[2]["ask"] = "102", "101"
        rows[3]["bid"] = "0"
        found = self.run_quotes(rows)
        self.assertEqual(kinds(found, "quote.bid_ask"), [cv.ABSENT, cv.DISCREPANCY, cv.DISCREPANCY])

    def test_identity_outside_the_universe_is_validator_error(self):
        rows = all_products() + [quote(0, product="PF_DOGEUSD")]
        self.assertEqual(kinds(self.run_quotes(rows)), [cv.VALIDATOR_ERROR])

    def test_timestamp_skew(self):
        rows = all_products()
        rows[4]["event_time"] = rows[4]["received_at"] - 60_000
        self.assertEqual(kinds(self.run_quotes(rows), "quote.timestamp_skew"), [cv.DISCREPANCY])

    def test_arrival_order_backwards(self):
        rows = all_products()
        rows[5]["received_at"] = rows[3]["received_at"]
        rows[5]["event_time"] = rows[5]["received_at"]
        self.assertEqual(kinds(self.run_quotes(rows), "quote.arrival_order"), [cv.DISCREPANCY])

    def test_sequence_gap_and_reconnect(self):
        rows = all_products()
        rows[2]["seq"] = 5  # jump inside one epoch
        for i, row in enumerate(rows[6:10]):  # reconnection: a new epoch restarts the sequence
            row["epoch"], row["seq"] = 2, i
        rows[6]["epoch"] = 2
        found = self.run_quotes(rows)
        self.assertEqual(kinds(found, "quote.sequence"), [cv.ABSENT, cv.ABSENT])  # 1->5 and then 5->3 after the jump
        self.assertEqual(kinds(found, "quote.reconnect"), [cv.DISCREPANCY])

    def test_freshness_silence_in_the_middle_and_at_the_end(self):
        rows = all_products()
        rows = [r for r in rows if not (r["product_id"] == "PF_ETHUSD" and r["seq"] in (3, 4, 5, 7, 8, 9))]
        found = self.run_quotes(rows, stale_ms=3_000)
        silent = [f for f in found if f["check"] == "quote.freshness" and f["product"] == "PF_ETHUSD"]
        self.assertEqual(len(silent), 2)  # interior 2s->6s and the tail 6s->10s, both above 3 s
        self.assertTrue(all(f["kind"] == cv.ABSENT for f in silent))

    def test_product_with_no_quotes_is_absent(self):
        rows = [r for r in all_products() if r["product_id"] != "PF_ZECUSD"]
        found = self.run_quotes(rows)
        self.assertEqual([(f["kind"], f["product"]) for f in found if f["check"] == "quote.coverage"],
                         [(cv.ABSENT, "PF_ZECUSD")])

    def test_malformed_quote_does_not_stop_the_run(self):
        rows = all_products()
        rows[0]["received_at"] = "x"
        rows[1]["bid"] = "oops"
        found = self.run_quotes(rows)
        self.assertEqual(sum(1 for f in found if f["kind"] == cv.VALIDATOR_ERROR), 2)


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

    def test_match_is_clean(self):
        ours = five_minutes(self.A) + five_minutes(self.A + cv.FIVE_MIN_MS)
        ref = [official_for(self.A), official_for(self.A + cv.FIVE_MIN_MS)]
        self.assertEqual(cv.validate_candles("PF_XBTUSD", ours, ref, self.A, self.B), [])

    def test_field_discrepancies_and_tolerance(self):
        ours = five_minutes(self.A)
        ref = [dict(official_for(self.A), close="105.4", volume="10.1")]
        found = cv.validate_candles("PF_XBTUSD", ours, ref, self.A, self.A + cv.FIVE_MIN_MS)
        self.assertEqual(sorted(f["check"] for f in found), ["candles.close", "candles.volume"])
        loose = cv.validate_candles("PF_XBTUSD", ours, ref, self.A, self.A + cv.FIVE_MIN_MS, price_tol="0.5", volume_tol="0.2")
        self.assertEqual(loose, [])

    def test_missing_minute_is_absent_ours_not_zero(self):
        ours = [c for c in five_minutes(self.A) if c["bucket_start"] != self.A + 2 * cv.MINUTE_MS]
        found = cv.validate_candles("PF_XBTUSD", ours, [official_for(self.A)], self.A, self.A + cv.FIVE_MIN_MS)
        self.assertEqual([(f["kind"], f["check"]) for f in found], [(cv.ABSENT, "candles.ours")])

    def test_missing_official_and_both_missing(self):
        found = cv.validate_candles("PF_XBTUSD", five_minutes(self.A), [], self.A, self.A + 2 * cv.FIVE_MIN_MS)
        self.assertEqual(sorted(f["check"] for f in found), ["candles.both", "candles.official"])

    def test_official_misaligned_bucket_is_timezone_style_error(self):
        shifted = dict(official_for(self.A), bucket_start=self.A + 3_600_000 + 60_000)
        found = cv.validate_candles("PF_XBTUSD", [], [shifted], self.A, self.B)
        self.assertIn((cv.DISCREPANCY, "candles.alignment"), [(f["kind"], f["check"]) for f in found])

    def test_minute_candle_outside_the_range_is_ignored(self):
        ours = five_minutes(self.A - cv.FIVE_MIN_MS)
        found = cv.validate_candles("PF_XBTUSD", ours, [], self.A, self.A + cv.FIVE_MIN_MS)
        self.assertEqual([f["check"] for f in found], ["candles.both"])

    def test_malformed_input_is_validator_error(self):
        bad = [minute_candle(self.A + 1, "1", "1", "1", "1")]
        found = cv.validate_candles("PF_XBTUSD", bad, [], self.A, self.B)
        self.assertEqual(kinds(found), [cv.VALIDATOR_ERROR])
        found = cv.validate_candles("PF_XBTUSD", [], [{"bucket_start": self.A}], self.A, self.B)
        self.assertIn(cv.VALIDATOR_ERROR, kinds(found))


class ThresholdTests(unittest.TestCase):
    def test_never_adopts_and_rejects_by_evidence(self):
        gaps = [1_000] * 990 + [20_000] * 9 + [30_000]
        result = cv.calibrate_thresholds(gaps)
        self.assertIsNone(result["adopted"])
        by = {r["threshold_ms"]: r for r in result["candidates"]}
        self.assertEqual(by[15_000]["over"], 10)
        self.assertEqual(by[15_000]["verdict"], "rechazado")   # 1% over > 0.1%
        self.assertEqual(by[25_000]["verdict"], "no_rechazado")  # 1 in 1000 is not above 0.1%
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
    SAMPLE = {"source": "fixture", "version": "v0", "from_ms": T0, "to_ms": T1, "products": ["PF_XBTUSD"]}

    def test_fitness_ladder(self):
        clean = cv.build_report(self.SAMPLE, [])
        absent = cv.build_report(self.SAMPLE, [cv.Finding(cv.ABSENT, "x", None, "d")])
        error = cv.build_report(self.SAMPLE, [cv.Finding(cv.VALIDATOR_ERROR, "x", None, "d")])
        both = cv.build_report(self.SAMPLE, [cv.Finding(cv.ABSENT, "x", None, "d"), cv.Finding(cv.DISCREPANCY, "y", None, "d")])
        self.assertEqual([r["fitness"] for r in (clean, absent, error, both)], ["sin_hallazgos", "bloqueada", "bloqueada", "no_apta"])
        self.assertEqual(both["counts"], {"ABSENT": 1, "DISCREPANCY": 1, "VALIDATOR_ERROR": 0})

    def test_fingerprint_is_deterministic_and_order_independent(self):
        a, b = cv.Finding(cv.ABSENT, "a", "PF_XBTUSD", "d"), cv.Finding(cv.DISCREPANCY, "b", "PF_XBTUSD", "d")
        one, two = cv.build_report(self.SAMPLE, [a, b]), cv.build_report(self.SAMPLE, [b, a])
        self.assertEqual(one["fingerprint"], two["fingerprint"])
        self.assertNotEqual(one["fingerprint"], cv.build_report(self.SAMPLE, [a])["fingerprint"])
        json.dumps(one)

    def test_sample_must_be_identified_and_off_the_holdout(self):
        with self.assertRaises(ValueError):
            cv.build_report({"source": "x"}, [])
        with self.assertRaises(ValueError):
            cv.build_report(dict(self.SAMPLE, to_ms=cv.HOLDOUT_START_MS + 1), [])

    def test_finding_kind_is_checked(self):
        with self.assertRaises(ValueError):
            cv.Finding("OTHER", "c", None, "d")

    def test_end_to_end_synthetic_run_reproduces_exactly(self):
        def run():
            findings = (cv.validate_funding(full_funding(), T0, T1) + cv.validate_quotes(all_products(), T0, T0 + 10_000))
            return cv.build_report(self.SAMPLE, findings)
        self.assertEqual(run(), run())
        self.assertEqual(run()["fitness"], "bloqueada" if run()["counts"]["ABSENT"] else "sin_hallazgos")


if __name__ == "__main__":
    unittest.main()
