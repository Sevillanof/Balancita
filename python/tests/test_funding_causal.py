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
LAG = 600_000  # the capture's poll lag in these fixtures; the context itself has no floor


def hourly(n=800, late=None, rate=lambda i: 1e-5 + i * 1e-8):
    """``n`` hourly periods, each known ``LAG`` after it closed, except ``late = {index: known_at}``."""
    late = late or {}
    return [(i * H, rate(i), late.get(i, (i + 1) * H + LAG)) for i in range(n)]


class ContextIsCausalTests(unittest.TestCase):
    def test_a_period_the_capture_learned_late_is_not_used_before_it_was_known(self):
        known = 791 * H + 600_000  # Kraken listed hour 790 ten minutes after it closed
        rows = hourly(791, late={790: known})  # the newest hour is the late one
        ctx = fc.FundingContext(rows)
        before, after = ctx.percentile(known - 1), ctx.percentile(known)
        self.assertEqual(before[0], rows[789][1])  # still the previous hour
        self.assertEqual(after[0], rows[790][1])

    def test_there_is_no_floor_the_real_known_at_is_used_even_right_after_the_close(self):
        rows = hourly(800, late={789: 790 * H + 1})  # seen one millisecond after it closed
        ctx = fc.FundingContext(rows)
        self.assertEqual(ctx.percentile(790 * H + 1)[0], rows[789][1])
        self.assertEqual(ctx.assess(790 * H)[0][0], rows[788][1])  # not yet seen: the previous hour

    def test_a_period_stamped_before_it_closed_is_still_not_judged_before_it_ended(self):
        ctx = fc.FundingContext([(s, r, 0) for s, r, _ in hourly()])
        self.assertEqual(ctx.percentile(790 * H + H - 1)[0], hourly()[789][1])
        self.assertEqual(ctx.percentile(790 * H + H)[0], hourly()[790][1])

    def test_a_pair_without_known_at_is_known_when_it_closes(self):
        ctx = fc.FundingContext([(s, r) for s, r, _ in hourly()])
        self.assertEqual(ctx.percentile(790 * H + H)[0], hourly()[790][1])

    def test_a_period_the_capture_has_not_seen_cannot_be_judged_at_all(self):
        ctx = fc.FundingContext(hourly())
        found, code, reason = ctx.assess(H // 2)
        self.assertEqual((found, code), (None, "no_history"))
        self.assertIn("sin ninguna tasa", reason)

    def test_the_age_limit_is_71_minutes_from_the_end_of_the_newest_period(self):
        self.assertEqual(fc.MAX_PERIOD_AGE_MS, 71 * 60_000)

    def test_stale_funding_is_unknown_with_the_age_and_the_limit_in_the_reason(self):
        ctx = fc.FundingContext(hourly())
        last_end = 800 * H
        self.assertEqual(ctx.assess(last_end + fc.MAX_PERIOD_AGE_MS)[1:], ("ok", ""))
        found, code, reason = ctx.assess(last_end + 5 * H)
        self.assertEqual((found, code), (None, "stale"))
        self.assertEqual(reason, "la hora 08:00Z no llegó: 229 min por encima del límite de 71 min "
                                 "(última tasa conocida de hace 5 h)")
        self.assertEqual(ctx.assess(last_end + fc.MAX_PERIOD_AGE_MS + 1)[1], "stale")
        self.assertEqual(ctx.line(last_end + 7 * H), "funding: unknown")

    def test_the_window_is_thirty_days_of_time_and_must_be_complete(self):
        rows = hourly(1000, rate=lambda i: 0.1)
        rows = [(s, 9.0 if 229 <= i < 279 else r, k) for i, (s, r, k) in enumerate(rows)]
        rows[-1] = (rows[-1][0], 5.0, rows[-1][2])  # judged: above every 0.1 and below the old 9.0
        found = fc.FundingContext(rows).percentile(1000 * H + LAG)
        self.assertEqual(found[0], 5.0)
        self.assertEqual(found[1], 100.0)  # the 9.0 hours are older than 30 days; a count of 720 entries would see them

    def test_one_missing_hour_makes_funding_unusable_and_names_it(self):
        rows = [row for i, row in enumerate(hourly(1000)) if i != 500]
        found, code, reason = fc.FundingContext(rows).assess(1000 * H + LAG)
        self.assertEqual((found, code), (None, "window_gaps"))
        self.assertEqual(reason, "faltan 1 horas de funding entre 1970-01-21T20:00Z y 1970-01-21T21:00Z "
                                 "(captura apagada o sin relleno)")

    def test_a_gap_reports_its_count_and_span_and_the_number_of_runs(self):
        rows = [row for i, row in enumerate(hourly(1000)) if i not in (500, 501, 502, 600)]
        _, code, reason = fc.FundingContext(rows).assess(1000 * H + LAG)
        self.assertEqual(code, "window_gaps")
        self.assertIn("faltan 4 horas de funding entre 1970-01-21T20:00Z y 1970-01-26T01:00Z, en 2 tramos", reason)

    def test_less_than_thirty_days_of_history_says_how_many(self):
        found, code, reason = fc.FundingContext(hourly(300)).assess(300 * H + LAG)
        self.assertEqual((found, code), (None, "insufficient_history"))
        self.assertEqual(reason, "sin historia suficiente: 12 de 30 días")

    def test_exactly_thirty_days_before_the_judged_hour_is_enough(self):
        self.assertEqual(fc.FundingContext(hourly(721)).assess(721 * H + LAG)[1], "ok")
        self.assertEqual(fc.FundingContext(hourly(720)).assess(720 * H + LAG)[1], "insufficient_history")

    def test_window_hours_backfilled_before_the_decision_count_even_when_known_late(self):
        late = {i: 990 * H for i in range(300, 400)}  # the capture was off; the history filled the hole at hour 990
        ctx = fc.FundingContext(hourly(1000, late=late))
        self.assertEqual(ctx.assess(1000 * H + LAG)[1], "ok")  # known_at <= t: a late-known past hour is fine
        self.assertEqual(ctx.assess(989 * H)[1], "window_gaps")  # before the backfill the same hours are missing

    def test_hours_learned_after_the_decision_do_not_count(self):
        late = {i: 2000 * H for i in range(300, 330)}
        ctx = fc.FundingContext(hourly(1000, late=late))
        self.assertEqual(ctx.assess(1000 * H + LAG)[1], "window_gaps")
        self.assertEqual(ctx.assess(2000 * H)[1], "stale")

    def test_the_prompt_line_keeps_its_format_and_says_unknown_when_stale(self):
        ctx = fc.FundingContext(hourly())
        self.assertRegex(ctx.line(800 * H + LAG), r"^funding: (high|normal|low) \(pctl30d=\d+, (longs|shorts) pay\)$")
        self.assertEqual(ctx.line(800 * H + 40 * H), "funding: unknown")


class RecoveredFundingTests(unittest.TestCase):
    """An off period filled afterwards: the forward judges it on what is known by then and marks every such instant."""

    def rows(self):
        return hourly(1000, late={i: 1100 * H for i in range(900, 1000)})  # hours 900-999 backfilled at hour 1100

    def test_without_recovery_the_off_period_stays_unknown(self):
        found, code, _ = fc.FundingContext(self.rows()).assess(950 * H)
        self.assertEqual((found, code), (None, "stale"))  # the newest hour the capture had was 899

    def test_with_recovery_the_instant_is_judged_on_the_backfilled_hours_and_marked(self):
        ctx = fc.FundingContext(self.rows(), recover_until_ms=1100 * H)
        result, code, reason, quality = ctx.assess_detail(950 * H)
        self.assertIsNotNone(result)
        self.assertEqual((code, reason, quality["recovered"]), ("ok", "", True))
        self.assertEqual(ctx.late_at, {950 * H})

    def test_an_instant_usable_live_is_never_marked(self):
        ctx = fc.FundingContext(self.rows(), recover_until_ms=1100 * H)
        self.assertNotIn("recovered", ctx.assess_detail(899 * H + LAG)[3])
        self.assertEqual(ctx.late_at, set())

    def test_recovery_cannot_invent_what_was_never_backfilled(self):
        rows = hourly(1000, late={i: 1100 * H for i in range(900, 950)})
        rows = [r for r in rows if r[0] // H < 950 or r[0] // H >= 960]  # hours 950-959 never came back
        ctx = fc.FundingContext(rows, recover_until_ms=1100 * H)
        self.assertEqual(ctx.assess(980 * H)[1], "window_gaps")
        self.assertEqual(ctx.late_at, set())

    def test_the_live_state_ignores_the_recovery(self):
        ctx = fc.FundingContext(self.rows(), recover_until_ms=1100 * H)
        self.assertEqual(fc.funding_state(ctx, 950 * H)["usable"], False)
        self.assertEqual(ctx.late_at, set())

    def test_no_history_state_has_a_reason(self):
        state = fc.funding_state(None, 5)
        self.assertEqual((state["usable"], state["code"]), (False, "no_history"))
        self.assertTrue(state["reason"])


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
            "CREATE TABLE IF NOT EXISTS paper_futures_funding_polls(product_id TEXT, started_at INTEGER, purpose TEXT,"
            " scheduled_at INTEGER, finished_at INTEGER, outcome TEXT, http_status INTEGER, detail TEXT, response_sha256 TEXT,"
            " extract_text TEXT, extract_sha256 TEXT, extract_periods INTEGER);")
        for start, received, absolute, relative in rows:
            sha = "s%d_%d" % (start, received)
            self.db.execute("INSERT INTO paper_futures_funding_sightings VALUES(?,?,?,?,?,?,?)",
                            ("PF_XBTUSD", start, received, absolute, start + H, "t", sha))
            line = json.dumps({"timestamp": stamp(start), "fundingRate": 1, "relativeFundingRate": relative})
            self.poll(received, sha, "serverTime=t\n" + line)
        self.db.commit()

    def poll(self, started, sha=None, extract=None, outcome="ok", took=2_000):
        self.db.execute("INSERT INTO paper_futures_funding_polls VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                        ("PF_XBTUSD", started, "hourly", started, started + took, outcome, None, None, sha, extract, None, None))
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

    def test_the_era_boundary_hours_before_use_the_periods_table_hours_seen_only_open_after_need_a_sighting(self):
        self.response("before", 5 * H + 40, [(4 * H, 0.1)], [(4 * H, "1")])        # closed at 5 h, seen at 5 h 40: exact
        self.sightings((5 * H, 6 * H + 30, "1", 0.2))                                # sightings start at 6 h 30
        periods, info = fc.load_periods_detailed(self.path, "PF_XBTUSD")
        self.assertEqual(periods, [(4 * H, 0.1, 5 * H + 40), (5 * H, 0.2, 6 * H + 30)])
        self.assertEqual(info["approximate"], set())

    def test_the_era_boundary_hour_seen_after_the_close_in_periods_only_is_known_when_it_arrived(self):
        self.sightings((5 * H, 6 * H + 30, "1", 0.2))
        self.response("poll-failed", 9 * H + 30, [(8 * H, 0.3)], [(8 * H, "1")])    # closed at 9 h, first seen at 9 h 30
        self.response("open-only", 10 * H + 30, [(10 * H, 0.4)], [(10 * H, "1")])   # seen only while open inside the era
        periods = fc.load_periods(self.path, "PF_XBTUSD")
        self.assertIn((8 * H, 0.3, 9 * H + 30), periods)  # the stored arrival time, not adjusted
        self.assertNotIn(10 * H, [p[0] for p in periods])  # still not guessed

    def test_a_ten_hour_stop_with_a_rest_backfill_loses_no_hour_and_marks_the_decisions_recovered(self):
        """Through the DB: sightings only for the last 2 h before the backfill poll, the rest only in ``periods``."""
        off, hours_off = 800, 10                                     # capture off for hours 800..809
        arrival = (off + hours_off) * H + 600_000                    # back at hour 810 + 10 min
        for i in range(off):                                         # normal capture before the stop
            self.response("n%d" % i, (i + 1) * H + LAG, [(i * H, 1e-5 + i * 1e-8)], [(i * H, "1")])
        self.sightings(*[(i * H, (i + 1) * H + LAG, "1", 1e-5 + i * 1e-8) for i in range(off - 24, off)])
        rates = [(i * H, 1e-5 + i * 1e-8) for i in range(off, off + hours_off)]
        self.response("backfill", arrival, rates, [(start, "1") for start, _ in rates])  # REST: periods only
        self.sightings(*[(i * H, arrival, "1", 1e-5 + i * 1e-8) for i in range(off + hours_off - 2, off + hours_off)])
        periods, info = fc.load_periods_detailed(self.path, "PF_XBTUSD")
        known = {start: known_at for start, _, known_at in periods}
        for i in range(off, off + hours_off):                        # every hour is there, at its real arrival time
            self.assertEqual(known[i * H], arrival, i)
        self.assertEqual(info["approximate"], set())
        ctx = fc.funding_for(self.path, "PF_XBTUSD", recover_until_ms=arrival + H)
        during = (off + 4) * H + LAG                                  # a decision in the middle of the stop
        self.assertEqual(ctx.assess_live(during)[1], "stale")
        found, code, _, quality = ctx.assess_detail(during)
        self.assertEqual(code, "ok")                                  # no window_gaps: judged on what is known by then
        self.assertTrue(quality["recovered"])
        self.assertIn(during, ctx.late_at)
        live_ctx = fc.funding_for(self.path, "PF_XBTUSD")
        self.assertEqual(live_ctx.assess(arrival + 5 * 60_000)[1], "ok")   # after the arrival, live and complete
        self.assertEqual(len(fc.funding_periods(ctx)), off + hours_off)    # accounting keeps them

    def stopped_mid_hour(self, off_hour=800):
        """Capture on until hour ``off_hour`` 14:00-style: that hour was listed while open (a periods row with known_at < end);
        the machine shut down mid-hour; at the restart no new periods row exists for it (store dedup) and the sightings cover
        only the last 2 h before the restart."""
        for i in range(off_hour):
            self.response("n%d" % i, (i + 1) * H + LAG, [(i * H, 1e-5 + i * 1e-8)], [(i * H, "1")])
        self.sightings(*[(i * H, (i + 1) * H + LAG, "1", 1e-5 + i * 1e-8) for i in range(off_hour - 24, off_hour)])
        rate = 1e-5 + off_hour * 1e-8
        self.response("open", off_hour * H + 30_000, [(off_hour * H, rate)], [(off_hour * H, "1")])   # seen open, known_at < end
        self.restart = (off_hour + 8) * H                                                                 # back 8 h later
        rates = [(i * H, 1e-5 + i * 1e-8) for i in range(off_hour + 1, off_hour + 6)]                     # fresh pairs: stored
        self.response("backfill", self.restart + 20_000, rates, [(start, "1") for start, _ in rates])
        self.sightings(*[(i * H, self.restart + 60_000, "1", 1e-5 + i * 1e-8) for i in range(off_hour + 6, off_hour + 8)])
        return off_hour, rate

    def test_an_hour_listed_open_when_the_machine_shut_down_is_known_at_the_first_successful_poll_after_its_close(self):
        hour, rate = self.stopped_mid_hour()
        self.poll(self.restart + 30_000, "p1")                         # the restart's first successful poll
        self.poll(self.restart + H, "p2")
        periods, info = fc.load_periods_detailed(self.path, "PF_XBTUSD")
        known = {start: known_at for start, _, known_at in periods}
        self.assertEqual(known[hour * H], self.restart + 30_000 + 2_000)       # the stored finish of that poll, not adjusted
        self.assertEqual(dict((s, r) for s, r, _ in periods)[hour * H], rate)
        self.assertIn(hour * H, info["approximate"])                            # its rate is the one seen while open
        ctx = fc.funding_for(self.path, "PF_XBTUSD", recover_until_ms=self.restart + 2 * H)
        found, code, _, quality = ctx.assess_detail((hour + 3) * H + LAG)       # a decision during the stop
        self.assertEqual((code, quality.get("recovered")), ("ok", True))
        self.assertEqual(ctx.assess_live(self.restart + 5 * 60_000)[1], "ok")   # after the restart nothing is missing

    def test_without_a_successful_poll_after_the_close_the_hour_is_still_missing(self):
        hour, _ = self.stopped_mid_hour()
        self.db.execute("UPDATE paper_futures_funding_polls SET outcome='http_error'")  # none succeeded; extracts stay readable
        self.poll(hour * H + 40_000, "early")                          # before the close
        self.poll(self.restart + 30_000, "p1", outcome="http_error")  # failed attempt
        self.poll(self.restart + 40_000, None)                          # ok without a response
        periods = fc.load_periods(self.path, "PF_XBTUSD")
        self.assertNotIn(hour * H, [p[0] for p in periods])
        gaps = fc.funding_for(self.path, "PF_XBTUSD").assess(self.restart + 5 * 60_000)
        self.assertEqual(gaps[1], "window_gaps")

    def test_a_poll_of_another_product_does_not_date_the_hour(self):
        hour, _ = self.stopped_mid_hour()
        self.db.execute("UPDATE paper_futures_funding_polls SET outcome='http_error'")
        self.db.execute("INSERT INTO paper_futures_funding_polls VALUES('PF_ETHUSD',?,'hourly',?,?,'ok',NULL,NULL,'x',NULL,NULL,NULL)",
                        (self.restart + 30_000, self.restart + 30_000, self.restart + 32_000))
        self.db.commit()
        self.assertNotIn(hour * H, [p[0] for p in fc.load_periods(self.path, "PF_XBTUSD")])

    def test_the_context_reports_how_many_hours_of_its_window_are_approximate_or_conflicting(self):
        ctx = fc.FundingContext(hourly(800), approximate={5 * H, 790 * H}, conflicts={200 * H: 1, 799 * H: 2, 6 * H: 1})
        result, reason, _, quality = ctx.assess_detail(800 * H + LAG)
        self.assertEqual(reason, "ok")
        self.assertEqual((quality["approximate_hours"], quality["conflicting_hours"]), (1, 2))
        self.assertEqual(fc.FundingContext(hourly(800)).assess_detail(800 * H + LAG)[3]["approximate_hours"], 0)

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
        rows = hourly(791, late={790: 791 * H + 600_000})
        shas = {}
        for start, rate, known in rows:
            self.response("r%d" % (start // H), known, [(start, rate)], [(start, "1")])
        ctx = fc.funding_for(self.path, "PF_XBTUSD")
        self.assertEqual(ctx.percentile(791 * H + 600_000 - 1)[0], rows[789][1])
        self.assertEqual(ctx.percentile(791 * H + 600_000)[0], rows[790][1])


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
