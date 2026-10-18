"""Issue #184, PR 5b: the three thresholds of the paper path, fixed with the 24 h measurement of the capture (18-oct-2026): the worst
real silence between quotes was 12.1 s, the median gap of the BTC WebSocket 0.4 s. Entries are blocked after 15 s without a quote of a
product, the whole session stops in order after 25 s, and a candle is waited for 15 s (late_candle_tolerance_ms of config/forward-strategies.json, the same as the forward) before it counts as late. They are still parameters
the operator names (never defaults of the code); this test runs the process with exactly those values on the real BTC candles and
quotes: a quiet real market trips neither, a real silence of 20 s blocks the entry without stopping, one of 30 s stops the session."""

import unittest

from balancita_engine import paper_live_process as LP
from balancita_engine.futures_strategy_reliability import LATE_CANDLE_TOLERANCE_MS
from real_session import BUY_AT, Base, Clock, config_dict, forced_signals
from real_world import MIN, SEC

BLOCK_MS, STOP_MS, CANDLE_MS = 15_000, 25_000, LATE_CANDLE_TOLERANCE_MS      # docs/etapa-10e-camino-paper-datos-reales.md 3.3
DECISION = BUY_AT[0]                                        # the candle close of the forced entry; it is decided about 3.4 s later
STEP_OF_DECISION = 7                                        # the clock step whose instant first has the rows of that decision


class TestApprovedThresholds(Base):
    def run_with(self, hole):
        self.world_with([] if hole is None else [hole])
        supervisor = self.supervisor(Clock(), max_quote_gap_ms=BLOCK_MS, stale_stop={"stop_quote_gap_ms": STOP_MS})
        supervisor.start()
        return supervisor, supervisor.run(max_steps=STEP_OF_DECISION + 2)

    def test_the_values_are_a_valid_configuration_with_the_stop_above_the_block(self):
        self.assertGreater(STOP_MS, BLOCK_MS)
        self.assertGreater(BLOCK_MS, 12_100)                                   # above the worst real silence of the 24 h
        config = LP.validate_config(dict(config_dict(), max_quote_gap_ms=BLOCK_MS,
                                         stale_stop={"stop_quote_gap_ms": STOP_MS}))
        self.assertEqual((config["max_quote_gap_ms"], config["stale_stop"]["stop_quote_gap_ms"]), (BLOCK_MS, STOP_MS))

    def test_the_real_market_without_a_silence_trips_neither(self):
        supervisor, code = self.run_with(None)
        self.assertEqual(code, LP.EXIT_OK)
        self.assertEqual(supervisor.stale_events, [])
        first = supervisor.session.runner.orders()[0]
        self.assertEqual(first["state"], "opened")
        self.assertEqual(len(forced_signals(supervisor)), 1)

    def test_a_real_silence_of_twenty_seconds_blocks_the_entry_and_does_not_stop_the_session(self):
        supervisor, code = self.run_with((DECISION - 20 * SEC, DECISION + 3_400))
        self.assertEqual(code, LP.EXIT_OK)
        self.assertEqual(supervisor.stale_events, [])
        first = supervisor.session.runner.orders()[0]
        self.assertEqual((first["state"], first["reasons"]), ("rejected", ["entry_blocked_source_stale"]))

    def test_a_real_silence_of_thirty_seconds_at_a_step_stops_the_session_in_order(self):
        instant = DECISION + 5 * MIN                                          # the instant of the step that has the decision's rows
        supervisor, code = self.run_with((instant - 30 * SEC, instant + SEC))
        self.assertEqual(code, LP.EXIT_STALE_STOP)
        self.assertEqual(supervisor.stop_reason, "quote_gap:" + "PF_XBTUSD")
        event = supervisor.stale_events[0]
        self.assertEqual((event["limit_ms"], event["observed_now_ms"]), (STOP_MS, instant))
        self.assertGreater(event["gap_ms"], STOP_MS)
        self.assertLess(event["gap_ms"], 30 * SEC + 4 * SEC)                    # the silence of 30 s plus the longest real spacing of the sample (3.7 s)


class TestCandleTolerance(Base):
    """The 15 s (the same tolerance as the forward): the real candle of the forced entry is read late (its real ``known_at`` is moved, nothing else),
    and the process runs with the tolerance named. At 10 s and exactly at 15 s the entry happens; at 15.001 s and at 20 s the candle makes no cycle,
    no order exists, and the would-be decision is written down as recovered with reason ``candle_late`` and its lag."""

    def run_with_late_candle(self, lag_ms):
        rows = list(self.world.candle_rows)
        index = next(i for i, r in enumerate(rows) if r["bucket_start"] == DECISION - MIN)
        rows[index] = dict(rows[index], known_at=DECISION + lag_ms)
        self.world.candle_rows = sorted(rows, key=lambda r: (r["known_at"], r["bucket_start"]))
        supervisor = self.supervisor(Clock(), max_quote_gap_ms=BLOCK_MS, stale_stop={"stop_quote_gap_ms": STOP_MS},
                                     evaluator_kw={"candle_tolerance_ms": CANDLE_MS})
        supervisor.start()
        return supervisor, supervisor.run(max_steps=STEP_OF_DECISION + 20)

    def entered(self, lag_ms):
        supervisor, code = self.run_with_late_candle(lag_ms)
        self.assertEqual(code, LP.EXIT_OK)
        self.assertEqual(supervisor.session.runner.orders()[0]["state"], "opened")
        self.assertEqual([s for s in supervisor.session.evaluator.suppressed if s["reason"] == "candle_late"], [])

    def refused(self, lag_ms):
        supervisor, code = self.run_with_late_candle(lag_ms)
        self.assertEqual(code, LP.EXIT_OK)                                     # it does not stop the session by itself
        self.assertEqual(supervisor.session.runner.orders(), [])
        late = [s for s in supervisor.session.evaluator.suppressed if s["reason"] == "candle_late"]
        self.assertEqual([(s["cycle_ms"], s["tolerance_ms"], s["recovered"]) for s in late], [(DECISION, CANDLE_MS, True)])
        self.assertGreater(late[0]["lag_ms"], CANDLE_MS)

    def test_the_tolerance_is_the_shared_15_seconds(self):
        self.assertEqual(CANDLE_MS, 15_000)

    def test_a_candle_read_10_seconds_after_its_minute_still_decides_the_entry(self):
        self.entered(10_000)

    def test_a_candle_read_exactly_15_seconds_after_its_minute_still_decides_the_entry(self):
        self.entered(CANDLE_MS)

    def test_a_candle_read_15_001_ms_after_its_minute_makes_no_cycle_and_no_order(self):
        self.refused(CANDLE_MS + 1)

    def test_a_candle_read_20_seconds_after_its_minute_makes_no_cycle_and_no_order(self):
        self.refused(20_000)

    def test_the_tolerance_must_be_a_positive_integer(self):
        for bad in (0, -1, 15.0, True, "15000"):
            with self.assertRaises(Exception, msg=repr(bad)):
                self.supervisor(Clock(), evaluator_kw={"candle_tolerance_ms": bad}).start()


if __name__ == "__main__":
    unittest.main()
