"""Synthetic tests for capture_funding_diagnosis: classification, offsets, shapes and the guards it inherits. No real data is touched."""
import json
import os
import random
import sqlite3
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from unittest import mock

from balancita_engine import capture_funding_diagnosis as d
from balancita_engine import capture_minimal_read as m
from balancita_engine import capture_validation as cv

A0, A1 = m.WINDOW_A
H = 3_600_000
SCHEMA = open(os.path.join(os.path.dirname(__file__), "real_futures_schema.sql"), encoding="utf-8").read()
RATE = "0.00012345"


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def body(server_text, starts):
    rates = ",".join('{"timestamp":"%s","fundingRate":%s,"relativeFundingRate":0.0000125}' % (iso(s), RATE) for s in starts)
    return '{"result":"success","serverTime":"%s","rates":[%s]}' % (server_text, rates)


class Scenario(unittest.TestCase):
    """One product, eight responses: an early case, a late case, an unknown, and two rejected serverTime."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "dev-live", m.DB_NAME)
        os.makedirs(os.path.dirname(self.path))
        self.conn = sqlite3.connect(self.path)
        self.conn.executescript(SCHEMA)
        self.s1, self.s2, self.s4 = A0 + 10 * H, A0 + 14 * H, A0 + 18 * H
        s1, s2, s4 = self.s1, self.s2, self.s4
        rows = [
            # (sha, received_at, server text, periods listed, start of the period row stored with it)
            ("r1", s1 + H + 30_000, iso(s1 + H + 30_000), [s1, s1 + H], s1 + H),                           # open hour: provisional row
            ("r2", s1 + H + 600_000 - 2_000, iso(s1 + H + 600_000 + 5_000), [s1, s1 + H], s1),           # early: server says settled, we received 2 s before
            ("r3", s2 + H + 30_000, iso(s2 + H + 30_000), [s2], s2),                                      # provisional
            ("r4", s2 + H + 75 * 60_000, iso(s2 + H + 75 * 60_000), [s2 + H], s2 + H),                    # after the deadline of s2, without s2
            ("r5", s2 + H + 90 * 60_000, iso(s2 + H + 90 * 60_000), [s2], s2),                            # s2 definitive, too late
            ("r6", s4 + H + 90 * 60_000, iso(s4 + H + 90 * 60_000), [s4], s4),                            # only poll, after the deadline: not measurable
            ("r7", A0 + 30 * H, "2026-10-11T19:00:00.123+00:00", [A0 + 28 * H], A0 + 28 * H),
            ("r8", A0 + 31 * H, "2026-13-45T99:00:00Z", [A0 + 29 * H], A0 + 29 * H),
        ]
        for sha, received, text, starts, stored in rows:
            self.conn.execute("INSERT INTO paper_futures_funding_responses VALUES (?,?,?,?)", (sha, received, text, body(text, starts)))
            self.conn.execute("INSERT INTO paper_futures_funding_periods (response_sha256, start_ms, product_id, end_ms, funding_rate, known_at, unit) VALUES (?,?,?,?,?,?,?)",
                              (sha, stored, m.BTC, stored + H, RATE, received, "USD/BTC/hour"))
        self.conn.commit()

    def reads(self):
        ro = m._open_readonly(self.path)
        self.addCleanup(ro.close)
        guard = m._Guard(ro, time.monotonic())
        ledger, reads = m.Ledger(), m.Reads()
        return m.read_2c(guard, ledger, reads), m.read_2d(guard, ledger, reads)

    def test_the_three_kinds_and_their_offsets(self):
        out = d.diagnose(*self.reads())
        btc = out["per_product"][m.BTC]
        self.assertEqual((btc["publication"]["early_count"], btc["publication"]["late_count"]), (1, 1))
        self.assertGreaterEqual(btc["publication"]["not_measurable_count"], 1)
        early = btc["publication"]["early_cases"][0]
        self.assertEqual(early["start_ms"], self.s1)
        self.assertEqual(early["receipt_minus_end_plus_settle_ms"], -2_000)
        self.assertEqual(early["server_minus_receipt_ms"], 7_000)
        late = btc["publication"]["late_cases"][0]
        self.assertEqual(late["start_ms"], self.s2)
        self.assertEqual(late["first_definitive_received_ms"], self.s2 + H + 90 * 60_000)
        self.assertEqual(late["first_poll_after_deadline_minus_deadline_ms"], 5 * 60_000)
        self.assertEqual(late["stored_polls_between_end_and_deadline"], 1)
        self.assertEqual(late["deadline_minus_last_poll_before_deadline_ms"], 70 * 60_000 - 30_000)
        self.assertTrue(btc["consistent_with_validator"])
        self.assertTrue(out["consistent_with_validator"])
        self.assertFalse(out["matches_stage2"])                  # the scenario is not the stage-2 data

    def test_every_statement_plans_as_a_search_without_scan_or_temp_btree(self):
        ro = m._open_readonly(self.path)
        with mock.patch.object(m, "MIN_SIZE_BYTES", 0):
            out = d.build_result(ro, prior_rows=0)
        ro.close()
        self.assertIsNone(out["stopped"])
        plans = [line for entry in out["reads"] if entry.get("plan") for line in entry["plan"]]
        self.assertTrue(plans)
        self.assertTrue(all(not p.startswith("SCAN") or "subquery" in p or p.strip() in ("SCAN w",) for p in plans))
        self.assertFalse(any("TEMP B-TREE" in p for p in plans))

    def test_clock_offset_quantiles_cover_the_parsed_responses_only(self):
        quant = d.diagnose(*self.reads())["per_product"][m.BTC]["server_minus_receipt_ms"]
        self.assertEqual((quant["n"], quant["min"], quant["max"]), (6, 0, 7_000))

    def test_rejected_serverTime_report_inner_reason_shape_and_receipt(self):
        out = d.diagnose(*self.reads())
        self.assertEqual(out["responses"], {"read": 8, "parsed": 6, "rejected": 2})
        rejected = {(r["inner_reason"], r["shape"]): r for r in out["server_time_rejected"]}
        self.assertEqual(set(rejected), {("timestamp_not_utc", "dddd-dd-ddTdd:dd:dd.ddd+dd:dd"), ("timestamp_invalid", "dddd-dd-ddTdd:dd:ddZ")})
        self.assertEqual(rejected[("timestamp_not_utc", "dddd-dd-ddTdd:dd:dd.ddd+dd:dd")]["received_at_ms"], [A0 + 30 * H])
        self.assertTrue(all(r["reason"] == "server_time_invalid" for r in rejected.values()))
        self.assertEqual(out["server_time_shapes_parsed"], {"dddd-dd-ddTdd:dd:dd.dddZ": 6})

    def test_nothing_with_digits_of_a_time_or_a_rate_is_published(self):
        out = d.diagnose(*self.reads())
        text = json.dumps(out)
        self.assertNotIn(RATE, text)
        self.assertNotIn("2026-10-11T19", text)
        for shape in list(out["server_time_shapes_parsed"]) + [r["shape"] for r in out["server_time_rejected"]]:
            self.assertFalse(any(c.isdigit() for c in shape))

    def test_run_reads_only_the_funding_tables_and_stays_within_the_stage_caps(self):
        self.conn.commit()
        ro = m._open_readonly(self.path)
        seen = []
        ro.set_trace_callback(seen.append)
        with mock.patch.object(m, "MIN_SIZE_BYTES", 0):
            out = d.build_result(ro, prior_rows=47_751)
        ro.close()
        self.assertIsNone(out["stopped"])
        self.assertEqual(out["guards"]["query_only_readback"], 1)
        self.assertEqual(out["global_rows"]["stage_rows_needed"], m.CAPS["2c"] + m.CAPS["2d"])
        self.assertLessEqual(out["rows_total"]["total"], out["rows_total"]["cap"])
        selects = [s for s in seen if s.lstrip().upper().startswith("SELECT")]
        self.assertTrue(selects)
        for sql in selects:
            self.assertNotIn("official_candles", sql)
            self.assertNotIn("candle_revisions", sql)
            self.assertNotIn("market_events", sql)
        self.assertEqual(out["python_version"], sys.version.split()[0])
        self.assertIn("does_not_say", out["diagnosis"])


class ClassificationMatchesTheValidator(unittest.TestCase):
    def test_same_kinds_as_capture_validation_on_random_polls(self):
        rnd = random.Random(1830)
        for _ in range(400):
            starts = sorted(rnd.sample(range(10), rnd.randint(1, 6)))
            starts = [A0 + s * H for s in starts]
            polls = []
            for _p in range(rnd.randint(0, 7)):
                at = A0 + rnd.randint(0, 14 * H) + rnd.choice([0, 0, 600_000, -600_000])
                held = {s for s in starts if rnd.random() < 0.6}
                finals = None if rnd.random() < 0.2 else {s for s in held if rnd.random() < 0.5}
                polls.append((at, frozenset(held), None if finals is None else frozenset(finals)))
            polls.sort(key=lambda p: p[0])
            result = cv.Result("funding", [m.BTC])
            cv._publication(result, m.BTC, starts, polls, d.MAX_LAG_MS, d.SETTLE_LAG_MS)
            theirs = {"early": 0, "late": 0, "unknown": 0}
            for f in result.findings:
                if f["kind"] == cv.DISCREPANCY and "marked definitive" in f["detail"]:
                    theirs["early"] += f["count"]
                elif f["kind"] == cv.DISCREPANCY:
                    theirs["late"] += f["count"]
                elif f["kind"] == cv.ABSENT:
                    theirs["unknown"] += f["count"]
            ours = d.classify_publication(starts, polls)
            self.assertEqual({k: len(v) for k, v in ours.items()}, theirs)


def stored(sha, start, rate=RATE, product=m.BTC):
    return (product, start, start + H, rate, start + H + 30_000, "USD/BTC/hour", sha)


def response(sha, received, starts, server=None, product=m.BTC):
    text = iso(received) if server is None else server
    return (sha, received, "", product, body(text, starts))


class ControlsPublishFalseTests(unittest.TestCase):
    """D-230-01, D-230-03: the published controls must be able to say False, and an out-of-window row must not break them."""

    def _timely(self):
        s = A0 + 10 * H
        # one definitive poll 20 minutes after the end: timely, judged by the validator and by the copy alike
        return [stored("a", s)], [response("a", s + H + 20 * 60_000, [s])]

    def test_consistent_when_the_copy_and_the_validator_judge_the_same_periods(self):
        periods, responses = self._timely()
        out = d.diagnose(periods, responses)
        self.assertTrue(out["per_product"][m.BTC]["consistent_with_validator"])
        self.assertTrue(out["consistent_with_validator"])

    def test_a_period_the_validator_does_not_judge_makes_the_control_false_per_product_and_globally(self):
        periods, responses = self._timely()
        bad = A0 + 12 * H
        periods.append(stored("b", bad, rate="not-a-number"))      # the validator drops it (VALIDATOR_ERROR); the copy would count it
        out = d.diagnose(periods, responses)
        self.assertFalse(out["per_product"][m.BTC]["consistent_with_validator"])
        self.assertFalse(out["consistent_with_validator"])
        self.assertTrue(out["per_product"][m.ETH]["consistent_with_validator"])   # the other product is untouched

    def test_a_forced_divergence_in_the_classification_is_published_as_false(self):
        periods, responses = self._timely()
        real = d.classify_publication
        with mock.patch.object(d, "classify_publication", lambda starts, polls: dict(real(starts, polls), unknown=real(starts, polls)["unknown"] + [A0])):
            out = d.diagnose(periods, responses)
        self.assertFalse(out["consistent_with_validator"])

    def test_rows_outside_the_window_and_provisional_rows_do_not_change_the_control(self):
        periods, responses = self._timely()
        before = A0 - H                                              # starts before the window: the validator skips it
        after = A1                                                   # ends after it
        periods += [stored("c", before), stored("d", after)]
        out = d.diagnose(periods, responses)
        self.assertTrue(out["consistent_with_validator"])
        self.assertEqual(out["per_product"][m.BTC]["periods_judged"], 1)


class SeveralEarlyTests(unittest.TestCase):
    def test_two_early_periods_of_one_product_are_two_in_the_validator_count_and_in_ours(self):
        periods, responses = [], []
        for hour in (10, 14):
            start = A0 + hour * H
            at = start + H + 600_000 - 2_000
            periods.append(stored("e%d" % hour, start))
            periods[-1] = (m.BTC, start, start + H, RATE, at, "USD/BTC/hour", "e%d" % hour)
            responses.append(response("e%d" % hour, at, [start], server=iso(start + H + 600_000 + 5_000)))
        out = d.diagnose(periods, responses)
        self.assertEqual(out["per_product"][m.BTC]["publication"]["early_count"], 2)
        self.assertEqual(out["per_product"][m.BTC]["validator_publication_counts"]["discrepancy"], 2)
        self.assertTrue(out["consistent_with_validator"])


class CombinedEquivalenceTests(unittest.TestCase):
    """BAL-COORD-183-DIAG-CORRECCION-02: the copy and the whole validator agree on combined cases and the control has no false positives."""

    OFFSET = "2026-10-11T19:00:00.123+00:00"

    def _mixed(self, rnd):
        periods, responses, n = [], [], 0
        for product in m.PRODUCTS:
            for hour in sorted(rnd.sample(range(0, 40), rnd.randint(0, 9))):
                start = A0 + hour * H
                kind = rnd.choice(["timely", "early", "late", "open", "rejected_open", "rejected_timely", "unknown"])
                if kind == "timely":
                    at, server = start + H + rnd.randint(11, 59) * 60_000, None
                elif kind == "early":
                    at = start + H + 600_000 - rnd.randint(1, 5_000)
                    server = iso(start + H + 600_000 + rnd.randint(0, 5_000))
                elif kind == "late":
                    at, server = start + H + 75 * 60_000 + rnd.randint(0, 30) * 60_000, None
                elif kind == "open":
                    at, server = start + rnd.randint(1, H - 1), None
                elif kind == "rejected_open":
                    at, server = start + rnd.randint(1, H - 1), self.OFFSET
                elif kind == "rejected_timely":
                    at, server = start + H + rnd.randint(11, 59) * 60_000, self.OFFSET
                else:
                    at, server = start + H + 90 * 60_000, None
                n += 1
                sha = "m%d" % n
                periods.append((product, start, start + H, RATE, at, "USD/X/hour", sha))
                responses.append(response(sha, at, [start], server=server, product=product))
                if kind == "late":          # a later poll that lists it as definitive, so "late" is judged and not unknown
                    n += 1
                    periods_sha = "m%d" % n
                    responses.append(response(periods_sha, at + 60_000, [start], product=product))
        return periods, responses

    def test_random_mixes_of_all_three_reasons_agree_with_the_validator(self):
        rnd = random.Random(2302)
        seen = {"early": 0, "late": 0, "not_causal": 0, "not_measurable": 0}
        for _ in range(250):
            periods, responses = self._mixed(rnd)
            out = d.diagnose(periods, responses)
            self.assertTrue(out["consistent_with_validator"], out["per_product"])
            for p in out["per_product"].values():
                pub = p["publication"]
                self.assertEqual(pub["early_count"] + pub["late_count"] + pub["not_causal_count"], p["validator_publication_counts"]["discrepancy"])
                seen["early"] += pub["early_count"]
                seen["late"] += pub["late_count"]
                seen["not_causal"] += pub["not_causal_count"]
                seen["not_measurable"] += pub["not_measurable_count"]
        self.assertTrue(all(v > 0 for v in seen.values()), seen)      # the mix really exercises every reason

    def test_all_three_reasons_in_one_product_are_counted_together(self):
        s_early, s_late, s_open = A0 + 10 * H, A0 + 14 * H, A0 + 20 * H
        at_early = s_early + H + 600_000 - 2_000
        periods = [(m.BTC, s_early, s_early + H, RATE, at_early, "USD/BTC/hour", "e"),
                   (m.BTC, s_late, s_late + H, RATE, s_late + H + 90 * 60_000, "USD/BTC/hour", "l"),
                   (m.BTC, s_open, s_open + H, RATE, s_open + 30_000, "USD/BTC/hour", "o")]
        periods.append((m.BTC, s_late + H, s_late + 2 * H, RATE, s_late + H + 75 * 60_000, "USD/BTC/hour", "l0"))
        responses = [response("e", at_early, [s_early], server=iso(s_early + H + 600_000 + 5_000)),
                     response("l0", s_late + H + 75 * 60_000, [s_late + H]),      # past the deadline and without s_late
                     response("l", s_late + H + 90 * 60_000, [s_late]),
                     response("o", s_open + 30_000, [s_open], server=self.OFFSET)]
        out = d.diagnose(periods, responses)
        pub = out["per_product"][m.BTC]["publication"]
        self.assertEqual((pub["early_count"], pub["late_count"], pub["not_causal_count"]), (1, 1, 1))
        self.assertEqual(out["per_product"][m.BTC]["validator_publication_counts"]["discrepancy"], 3)
        self.assertTrue(out["consistent_with_validator"])

    def test_clean_data_gives_no_discrepancy_and_a_true_control(self):
        periods, responses = [], []
        for i, hour in enumerate((8, 12, 16, 20)):
            s = A0 + hour * H
            periods.append(stored("c%d" % i, s))
            responses.append(response("c%d" % i, s + H + 30 * 60_000, [s]))
        out = d.diagnose(periods, responses)
        pub = out["per_product"][m.BTC]["publication"]
        self.assertEqual((pub["early_count"], pub["late_count"], pub["not_causal_count"]), (0, 0, 0))
        self.assertEqual(out["per_product"][m.BTC]["validator_publication_counts"]["discrepancy"], 0)
        self.assertTrue(out["consistent_with_validator"])

    def test_the_control_is_false_when_only_one_reason_is_dropped_in_a_mix(self):
        rnd = random.Random(7)
        for dropped in ("early", "late", "not_causal"):
            hit = False
            for _ in range(60):
                periods, responses = self._mixed(rnd)
                real = d.classify_publication
                if dropped == "not_causal":
                    ctx = mock.patch.object(d, "not_causal_cases", lambda *a, **k: [])
                else:
                    ctx = mock.patch.object(d, "classify_publication", lambda s, p, _r=real, _k=dropped: dict(_r(s, p), **{_k: []}))
                base = d.diagnose(periods, responses)
                with ctx:
                    cut = d.diagnose(periods, responses)
                if sum(p["publication"][dropped + "_count"] for p in base["per_product"].values()) > 0:
                    self.assertFalse(cut["consistent_with_validator"], dropped)
                    hit = True
                    break
            self.assertTrue(hit, dropped)


class NotCausalTests(unittest.TestCase):
    """D-230-06: the third reason of a funding.publication DISCREPANCY, a judged row with known_at before the end of its period."""

    OFFSET = "2026-10-11T19:00:00.123+00:00"           # rejected as timestamp_not_utc by every Python

    def _scenario(self):
        s_open = A0 + 20 * H                           # the hour in progress when the rejected response arrives
        rejected_at = s_open + 30_000
        periods = [stored("rej", s_open, product=m.BTC)]
        periods[0] = (m.BTC, s_open, s_open + H, RATE, rejected_at, "USD/BTC/hour", "rej")
        responses = [response("rej", rejected_at, [s_open], server=self.OFFSET)]
        s_ok = A0 + 10 * H                             # a timely, parsed period next to it
        periods.append(stored("ok", s_ok))
        responses.append(response("ok", s_ok + H + 20 * 60_000, [s_ok]))
        return periods, responses, s_open, rejected_at

    def test_a_row_stored_by_a_rejected_response_before_the_period_end_is_counted_and_described(self):
        periods, responses, s_open, rejected_at = self._scenario()
        out = d.diagnose(periods, responses)
        pub = out["per_product"][m.BTC]["publication"]
        self.assertEqual((pub["early_count"], pub["late_count"], pub["not_causal_count"]), (0, 0, 1))
        self.assertEqual(pub["not_causal_cases"], [{"start_ms": s_open, "known_at_ms": rejected_at, "end_minus_known_ms": H - 30_000,
                                                    "response_rejected": True, "response_read": True}])
        self.assertEqual(out["per_product"][m.BTC]["validator_publication_counts"]["discrepancy"], 1)
        self.assertTrue(out["per_product"][m.BTC]["consistent_with_validator"])
        self.assertTrue(out["consistent_with_validator"])

    def test_the_first_version_would_have_published_zero_here_and_the_control_now_catches_it(self):
        periods, responses, _s, _t = self._scenario()
        with mock.patch.object(d, "not_causal_cases", lambda *a, **k: []):     # what D-230-06 found: the third reason ignored
            out = d.diagnose(periods, responses)
        self.assertEqual(out["per_product"][m.BTC]["publication"]["not_causal_count"], 0)
        self.assertEqual(out["per_product"][m.BTC]["validator_publication_counts"]["discrepancy"], 1)
        self.assertFalse(out["per_product"][m.BTC]["consistent_with_validator"])
        self.assertFalse(out["consistent_with_validator"])

    def test_a_provisional_row_and_a_row_known_after_the_end_are_not_counted(self):
        s_open = A0 + 20 * H
        received = s_open + 30_000
        periods = [(m.BTC, s_open, s_open + H, RATE, received, "USD/BTC/hour", "prov")]     # parsed: the open hour is provisional
        responses = [response("prov", received, [s_open])]
        late_known = A0 + 10 * H
        periods.append(stored("after", late_known))                                           # known 30 s after its end
        responses.append(response("after", late_known + H + 20 * 60_000, [late_known]))
        out = d.diagnose(periods, responses)
        self.assertEqual(out["per_product"][m.BTC]["publication"]["not_causal_count"], 0)
        self.assertTrue(out["consistent_with_validator"])

    def test_exactly_at_the_end_is_not_before_it(self):
        s = A0 + 20 * H
        periods = [(m.BTC, s, s + H, RATE, s + H, "USD/BTC/hour", "rej")]
        responses = [response("rej", s + H, [s], server=self.OFFSET)]
        out = d.diagnose(periods, responses)
        self.assertEqual(out["per_product"][m.BTC]["publication"]["not_causal_count"], 0)
        self.assertTrue(out["consistent_with_validator"])

    def test_stage_2_shape_one_for_eth_two_for_xbt_matches_the_published_discrepancy_counts(self):
        periods, responses = [], []
        for product, starts in ((m.ETH, [A0 + 22 * H]), (m.BTC, [A0 + 19 * H, A0 + 23 * H])):
            for start in starts:
                at = start + 30_000
                sha = "%s-%d" % (product, start)
                periods.append((product, start, start + H, RATE, at, "USD/%s/hour" % ("ETH" if product == m.ETH else "BTC"), sha))
                responses.append(response(sha, at, [start], server=self.OFFSET, product=product))
        out = d.diagnose(periods, responses)
        counts = {p: out["per_product"][p]["validator_publication_counts"]["discrepancy"] for p in m.PRODUCTS}
        self.assertEqual(counts, {m.ETH: 1, m.BTC: 2})
        self.assertEqual({p: out["per_product"][p]["publication"]["not_causal_count"] for p in m.PRODUCTS}, {m.ETH: 1, m.BTC: 2})
        self.assertTrue(out["consistent_with_validator"])


class RejectedCapTests(unittest.TestCase):
    def test_at_most_twenty_receipt_times_per_rejected_group_but_every_one_is_counted(self):
        responses = [response("r%02d" % i, A0 + i * 60_000, [A0], server="2026-10-11T19:00:00+00:00") for i in range(25)]
        out = d.diagnose([], responses)
        group = out["server_time_rejected"][0]
        self.assertEqual(group["count"], 25)
        self.assertEqual(len(group["received_at_ms"]), d.MAX_CASES)
        self.assertEqual(out["responses"]["rejected"], 25)


class BoundaryTests(unittest.TestCase):
    def test_a_response_exactly_at_end_plus_settle_is_not_early_and_one_ms_before_is(self):
        start = A0 + 5 * H
        threshold = start + H + d.SETTLE_LAG_MS
        on = [(threshold, frozenset({start}), frozenset({start}))]
        before = [(threshold - 1, frozenset({start}), frozenset({start}))]
        self.assertEqual(d.classify_publication([start], on), {"early": [], "late": [], "unknown": []})
        self.assertEqual(d.classify_publication([start], before)["early"], [start])

    def test_a_first_definitive_exactly_at_the_deadline_is_timely_and_one_ms_after_is_not(self):
        start = A0 + 5 * H
        deadline = start + H + d.SETTLE_LAG_MS + d.MAX_LAG_MS
        timely = [(deadline, frozenset({start}), frozenset({start}))]
        after = [(deadline - 1, frozenset(), frozenset()), (deadline + 1, frozenset({start}), frozenset({start}))]
        self.assertEqual(d.classify_publication([start], timely), {"early": [], "late": [], "unknown": []})
        self.assertEqual(d.classify_publication([start], after)["late"], [])  # the poll at deadline - 1 is not after the deadline
        later = [(deadline + 1, frozenset(), frozenset()), (deadline + 2, frozenset({start}), frozenset({start}))]
        self.assertEqual(d.classify_publication([start], later)["late"], [start])


class ShapeTests(unittest.TestCase):
    def test_digits_become_d_and_other_types_are_named(self):
        self.assertEqual(d.shape_of("2026-10-11T19:00:00.123Z"), "dddd-dd-ddTdd:dd:dd.dddZ")
        self.assertEqual(d.shape_of("Sat, 11 Oct 2026 19:00:00 GMT"), "Sat, dd Oct dddd dd:dd:dd GMT")
        self.assertEqual(d.shape_of(None), "type:NoneType")
        self.assertEqual(d.shape_of(12345), "type:int")
        self.assertLessEqual(len(d.shape_of("x" * 500)), d.SHAPE_MAX)

    def test_missing_and_malformed_bodies_do_not_raise(self):
        self.assertEqual(d._server_time_text("{not json"), "tool:unparseable")
        self.assertEqual(d._server_time_text("[1]"), "tool:not_an_object")
        self.assertEqual(d._server_time_text("{}"), "tool:missing")


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "dev-live", m.DB_NAME)
        os.makedirs(os.path.dirname(self.path))
        sqlite3.connect(self.path).executescript(SCHEMA)

    def test_global_cap_stops_before_any_read(self):
        ro = m._open_readonly(self.path)
        out = d.build_result(ro, prior_rows=m.TOTAL_ROWS_CAP - 10)
        ro.close()
        self.assertEqual(out["stopped"]["reason"], "global_cap")
        self.assertNotIn("reads", out)

    def test_prior_rows_must_be_a_non_negative_integer(self):
        ro = m._open_readonly(self.path)
        out = d.build_result(ro, prior_rows=-1)
        ro.close()
        self.assertEqual(out["stopped"]["reason"], "prior_rows")

    def test_cli_requires_prior_rows_and_takes_nothing_else(self):
        with self.assertRaises(SystemExit):
            d.main(["--db", self.path])
        with self.assertRaises(SystemExit):
            d.main(["--db", self.path, "--prior-rows", "1", "--from", "1"])

    def test_main_refuses_a_file_smaller_than_the_identified_one(self):
        self.assertEqual(d.main(["--db", self.path, "--prior-rows", "1"]), 2)

    def test_caps_are_the_stage_caps_and_not_wider(self):
        self.assertEqual((m.CAPS["2c"], m.CAPS["2d"]), (600, 1_200))
        self.assertEqual(d.need_rows(), 1_800)

    def test_a_connection_that_is_not_query_only_stops_before_any_read(self):
        rw = sqlite3.connect(self.path)                              # plain connection: PRAGMA query_only is 0
        out = d.build_result(rw, prior_rows=0)
        rw.close()
        self.assertEqual(out["guards"]["query_only_readback"], 0)
        self.assertEqual(out["stopped"]["reason"], "connection_not_query_only")
        self.assertNotIn("reads", out)
        self.assertNotIn("diagnosis", out)

    def test_empty_database_gives_an_empty_diagnosis(self):
        ro = m._open_readonly(self.path)
        with mock.patch.object(m, "MIN_SIZE_BYTES", 0):
            out = d.build_result(ro, prior_rows=0)
        ro.close()
        self.assertIsNone(out["stopped"])
        self.assertEqual(out["diagnosis"]["responses"]["read"], 0)
        self.assertTrue(out["diagnosis"]["consistent_with_validator"])


if __name__ == "__main__":
    unittest.main()
