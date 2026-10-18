"""Funding as the capture knew it (docs/forward-funding-causal.md): a period is usable only once the capture had seen it."""
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

from balancita_engine import futures_funding_context as fc
from balancita_engine.futures_replay import load_range

from test_futures_replay import DDL

H = fc.HOUR_MS
LAG = fc.PUBLICATION_LAG_MS


def hourly(n=800, late=None, rate=lambda i: 1e-5 + i * 1e-8):
    """``n`` hourly periods, each known 10 minutes after it closed, except ``late = {index: known_at}``."""
    late = late or {}
    return [(i * H, rate(i), late.get(i, (i + 1) * H + LAG)) for i in range(n)]


class ContextIsCausalTests(unittest.TestCase):
    def test_a_period_the_capture_learned_late_is_not_used_before_it_was_known(self):
        known = 790 * H + 17 * H  # Kraken listed hour 790 about 17 h after it closed
        rows = hourly(791, late={790: known})  # the newest hour is the late one
        ctx = fc.FundingContext(rows)
        before, after = ctx.percentile(known - 1), ctx.percentile(known)
        self.assertEqual(before[0], rows[789][1])  # still the previous hour
        self.assertEqual(after[0], rows[790][1])

    def test_a_period_is_never_usable_before_it_closed_plus_the_lag_even_if_stamped_earlier(self):
        ctx = fc.FundingContext([(s, r, 0) for s, r, _ in hourly()])
        self.assertEqual(ctx.percentile(790 * H + H + LAG - 1)[0], hourly()[789][1])
        self.assertEqual(ctx.percentile(790 * H + H + LAG)[0], hourly()[790][1])

    def test_a_period_the_capture_has_not_seen_cannot_be_judged_at_all(self):
        ctx = fc.FundingContext(hourly())
        self.assertEqual(ctx.assess(H // 2), (None, "no_history"))

    def test_stale_funding_is_unknown_with_its_reason_at_the_age_limit(self):
        ctx = fc.FundingContext(hourly())
        last_end = 800 * H
        self.assertEqual(ctx.assess(last_end + fc.MAX_PERIOD_AGE_MS)[1], "ok")
        self.assertEqual(ctx.assess(last_end + fc.MAX_PERIOD_AGE_MS + 1), (None, "stale"))
        self.assertEqual(ctx.line(last_end + 30 * H + 7 * H), "funding: unknown")

    def test_a_capture_gap_of_thirty_hours_after_the_newest_hour_is_not_read_as_current(self):
        ctx = fc.FundingContext(hourly())
        gap_end = 800 * H + 30 * H
        self.assertIsNotNone(ctx.percentile(gap_end))  # 30 h old: inside the provisional limit
        self.assertIsNone(ctx.percentile(gap_end + 7 * H))  # the gap goes on: the old hour is not "current"

    def test_the_window_is_thirty_days_of_time_not_720_entries(self):
        rows = hourly(1000, rate=lambda i: 0.1)
        rows = [(s, 9.0 if 229 <= i < 279 else r, k) for i, (s, r, k) in enumerate(rows) if not 279 <= i < 329]
        rows[-1] = (rows[-1][0], 5.0, rows[-1][2])  # judged: above every 0.1 and below the old 9.0
        at = 1000 * H + LAG
        found = fc.FundingContext(rows).percentile(at)
        self.assertEqual(found[0], 5.0)
        self.assertEqual(found[1], 100.0)  # only the 670 hours inside the 30 days; a count of 720 would give 93.05

    def test_too_many_missing_hours_make_the_percentile_unknown(self):
        sparse = [row for i, row in enumerate(hourly(1000)) if i % 2 == 0 or i >= 990]
        self.assertEqual(fc.FundingContext(sparse).assess(1000 * H + LAG), (None, "window_gaps"))

    def test_window_hours_the_capture_learned_after_the_decision_do_not_count(self):
        late = {i: 2000 * H for i in range(300, 400)}  # a hole filled long after the decision
        ctx = fc.FundingContext(hourly(1000, late=late))
        self.assertEqual(ctx.assess(1000 * H + LAG), (None, "window_gaps"))
        self.assertEqual(ctx.assess(2000 * H)[1], "stale")  # and by then the newest hour is old
        ok = fc.FundingContext(hourly(1000, late={i: 2000 * H for i in range(300, 330)}))
        self.assertEqual(ok.assess(1000 * H + LAG)[1], "ok")

    def test_the_prompt_line_keeps_its_format_and_says_unknown_when_stale(self):
        ctx = fc.FundingContext(hourly())
        self.assertRegex(ctx.line(800 * H + LAG), r"^funding: (high|normal|low) \(pctl30d=\d+, (longs|shorts) pay\)$")
        self.assertEqual(ctx.line(800 * H + 40 * H), "funding: unknown")


def stamp(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class LoadPeriodsTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "m.sqlite")
        self.db = sqlite3.connect(self.path)
        self.db.executescript(
            "CREATE TABLE paper_futures_funding_responses(sha256 TEXT, received_at INTEGER, server_time TEXT, raw_response TEXT);"
            "CREATE TABLE paper_futures_funding_periods(response_sha256 TEXT, start_ms INTEGER, end_ms INTEGER,"
            " funding_rate TEXT, known_at INTEGER, unit TEXT, product_id TEXT);")

    def tearDown(self):
        self.db.close()
        self.dir.cleanup()

    def response(self, sha, received, rates, rows, raw=None):
        body = raw if raw is not None else json.dumps({"rates": [
            {"timestamp": stamp(s), "fundingRate": 1, "relativeFundingRate": r} for s, r in rates]})
        self.db.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)", (sha, received, "t", body))
        for start, absolute in rows:
            self.db.execute("INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
                            (sha, start, start + H, absolute, received, "u", "PF_XBTUSD"))
        self.db.commit()

    def test_known_at_is_when_the_capture_saw_the_closed_period_not_its_end(self):
        self.response("a", 5 * H + 17 * H, [(5 * H, 0.5)], [(5 * H, "1")])
        self.assertEqual(fc.load_periods(self.path, "PF_XBTUSD"), [(5 * H, 0.5, 22 * H)])

    def test_a_rate_seen_while_the_period_was_open_is_provisional_and_the_first_one_after_the_close_wins(self):
        self.response("open", 5 * H + 30, [(5 * H, 0.1)], [(5 * H, "1")])         # seen 30 ms after it began
        self.response("closed", 6 * H + 30, [(5 * H, 0.2)], [(5 * H, "2")])        # first after the close
        self.response("later", 9 * H, [(5 * H, 0.3)], [(5 * H, "3")])              # a later revision
        self.assertEqual(fc.load_periods(self.path, "PF_XBTUSD"), [(5 * H, 0.2, 6 * H + 30)])

    def test_an_hour_seen_only_while_open_before_the_sightings_existed_is_known_an_hour_after_its_end_and_flagged(self):
        self.response("open", 5 * H + 30, [(5 * H, 0.1)], [(5 * H, "1")])
        periods, info = fc.load_periods_detailed(self.path, "PF_XBTUSD")
        self.assertEqual(periods, [(5 * H, 0.1, 7 * H)])  # end (6 h) + 1 h
        self.assertEqual(info["approximate"], {5 * H})

    def test_funding_for_hands_the_flags_to_the_context(self):
        self.response("open", 5 * H + 30, [(5 * H, 0.1)], [(5 * H, "1")])
        ctx = fc.funding_for(self.path, "PF_XBTUSD")
        self.assertEqual(ctx.approximate, {5 * H})

    def test_an_hour_with_a_row_after_the_close_is_exact_not_approximate(self):
        self.response("closed", 6 * H + 30, [(5 * H, 0.2)], [(5 * H, "2")])
        self.assertEqual(fc.load_periods_detailed(self.path, "PF_XBTUSD")[1]["approximate"], set())

    def sightings(self, *rows):
        """rows: (start, received_at, absolute_rate, relative_rate); the extract keeps the literal period, as the capture does."""
        self.db.executescript(
            "CREATE TABLE IF NOT EXISTS paper_futures_funding_sightings(product_id TEXT, start_ms INTEGER, received_at INTEGER,"
            " funding_rate TEXT, end_ms INTEGER, server_time TEXT, response_sha256 TEXT);"
            "CREATE TABLE IF NOT EXISTS paper_futures_funding_polls(product_id TEXT, started_at INTEGER, response_sha256 TEXT,"
            " extract_text TEXT);")
        for start, received, absolute, relative in rows:
            sha = "s%d_%d" % (start, received)
            self.db.execute("INSERT INTO paper_futures_funding_sightings VALUES(?,?,?,?,?,?,?)",
                            ("PF_XBTUSD", start, received, absolute, start + H, "t", sha))
            line = json.dumps({"timestamp": stamp(start), "fundingRate": 1, "relativeFundingRate": relative})
            self.db.execute("INSERT INTO paper_futures_funding_polls VALUES(?,?,?,?)",
                            ("PF_XBTUSD", received, sha, "serverTime=t\n" + line))
        self.db.commit()

    def test_a_sighting_after_the_close_gives_the_known_at_and_the_rate_even_when_the_periods_table_saw_it_open(self):
        self.response("open", 5 * H + 30, [(5 * H, 0.5)], [(5 * H, "1")])  # the only periods row: seen open, same final rate
        self.sightings((5 * H, 6 * H + 30, "1", 0.5))
        periods, info = fc.load_periods_detailed(self.path, "PF_XBTUSD")
        self.assertEqual(periods, [(5 * H, 0.5, 6 * H + 30)])  # no gap, not approximate
        self.assertEqual((info["approximate"], info["conflicts"]), (set(), {}))

    def test_a_sighting_while_the_period_was_open_does_not_count(self):
        self.sightings((5 * H, 5 * H + 30, "1", 0.4), (5 * H, 6 * H + 30, "2", 0.6))
        self.assertEqual(fc.load_periods(self.path, "PF_XBTUSD"), [(5 * H, 0.6, 6 * H + 30)])

    def test_conflicting_sightings_keep_the_first_seen_and_are_counted(self):
        self.sightings((5 * H, 6 * H + 30, "1", 0.5), (5 * H, 7 * H + 30, "2", 0.6), (5 * H, 9 * H, "3", 0.7), (5 * H, 9 * H + 1, "3", 0.7))
        periods, info = fc.load_periods_detailed(self.path, "PF_XBTUSD")
        self.assertEqual(periods, [(5 * H, 0.5, 6 * H + 30)])
        self.assertEqual(info["conflicts"], {5 * H: 2})  # two other rates

    def test_the_era_boundary_hours_before_use_the_periods_table_hours_after_need_a_sighting(self):
        self.response("before", 5 * H + 40, [(4 * H, 0.1)], [(4 * H, "1")])        # closed at 5 h, seen at 5 h 40: exact
        self.sightings((5 * H, 6 * H + 30, "1", 0.2))                                # sightings start at 6 h 30
        self.response("poll-failed", 9 * H + 30, [(8 * H, 0.3)], [(8 * H, "1")])    # in the era but no sighting: not guessed
        periods, info = fc.load_periods_detailed(self.path, "PF_XBTUSD")
        self.assertEqual(periods, [(4 * H, 0.1, 5 * H + 40), (5 * H, 0.2, 6 * H + 30)])
        self.assertEqual(info["approximate"], set())

    def test_the_context_reports_how_many_hours_of_its_window_are_approximate_or_conflicting(self):
        ctx = fc.FundingContext(hourly(800), approximate={5 * H, 790 * H}, conflicts={200 * H: 1, 799 * H: 2, 6 * H: 1})
        result, reason, quality = ctx.assess_detail(800 * H + LAG)
        self.assertEqual(reason, "ok")
        self.assertEqual((quality["approximate_hours"], quality["conflicting_hours"]), (1, 2))
        self.assertEqual(fc.FundingContext(hourly(800)).assess_detail(800 * H + LAG)[2]["approximate_hours"], 0)

    def test_a_response_that_cannot_be_read_leaves_its_periods_out_instead_of_guessing(self):
        self.response("bad", 7 * H, [], [(5 * H, "1")], raw="not json")
        self.response("good", 8 * H, [(6 * H, 0.4)], [(6 * H, "2")])
        self.assertEqual(fc.load_periods(self.path, "PF_XBTUSD"), [(6 * H, 0.4, 8 * H)])

    def test_since_leaves_out_older_periods(self):
        self.response("old", 3 * H, [(H, 0.1)], [(H, "1")])
        self.response("new", 9 * H, [(5 * H, 0.4)], [(5 * H, "2")])
        self.assertEqual(fc.load_periods(self.path, "PF_XBTUSD", since_ms=2 * H), [(5 * H, 0.4, 9 * H)])

    def test_each_body_is_parsed_once_however_many_times_it_is_loaded(self):
        self.response("a", 9 * H, [(5 * H, 0.4)], [(5 * H, "2")])
        with mock.patch.object(fc.json, "loads", wraps=json.loads) as loads:
            for _ in range(3):
                fc.load_periods(self.path, "PF_XBTUSD")
        self.assertEqual(loads.call_count, 1)

    def test_the_context_built_from_the_db_waits_for_the_stored_known_at(self):
        rows = hourly(791, late={790: 790 * H + 17 * H})
        shas = {}
        for start, rate, known in rows:
            self.response("r%d" % (start // H), known, [(start, rate)], [(start, "1")])
        ctx = fc.funding_for(self.path, "PF_XBTUSD")
        self.assertEqual(ctx.percentile(790 * H + 17 * H - 1)[0], rows[789][1])
        self.assertEqual(ctx.percentile(790 * H + 17 * H)[0], rows[790][1])


class LoadRangeLiveViewTests(unittest.TestCase):
    """A candle backfilled hours later is not part of a live view of the market; the default still returns it."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "m.sqlite")
        db = sqlite3.connect(self.path)
        db.executescript(DDL)
        for bucket, known_at in ((0, 60_000), (60_000, 120_000), (120_000, 3 * H), (180_000, 240_000 + 300_000)):
            db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       ("PF_XBTUSD", 60_000, bucket, "h%d" % bucket, known_at, "1", "2", "0.5", "1.5", "1", "x"))
        db.commit()
        db.close()

    def tearDown(self):
        self.dir.cleanup()

    def buckets(self, **kwargs):
        ones, _ = load_range(self.path, "PF_XBTUSD", 0, 10 * 60_000, **kwargs)
        return [c["bucket_start"] for c in ones]

    def test_the_default_returns_every_stored_candle(self):
        self.assertEqual(self.buckets(), [0, 60_000, 120_000, 180_000])

    def test_a_lag_limit_leaves_out_what_the_capture_learned_later_than_the_limit(self):
        self.assertEqual(self.buckets(max_lag_ms=5 * 60_000), [0, 60_000, 180_000])
        self.assertEqual(self.buckets(max_lag_ms=60_000), [0, 60_000])  # the last one was 5 min late: out at 1 min


if __name__ == "__main__":
    unittest.main()
