"""Issue #184, PR 5b: the three thresholds of the paper path, fixed with the 24 h measurement of the capture (18-oct-2026): the worst
real silence between quotes was 12.1 s, the median gap of the BTC WebSocket 0.4 s. Entries are blocked after 15 s without a quote of a
product, the whole session stops in order after 25 s, and a candle is waited for 45 s before it counts as late. They are still parameters
the operator names (never defaults of the code); this test runs the process with exactly those values on the real BTC candles and
quotes: a quiet real market trips neither, a real silence of 20 s blocks the entry without stopping, one of 30 s stops the session."""

import unittest

from balancita_engine import paper_live_process as LP
from real_session import BUY_AT, Base, Clock, config_dict, forced_signals
from real_world import MIN, SEC

BLOCK_MS, STOP_MS, CANDLE_MS = 15_000, 25_000, 45_000      # docs/etapa-10e-camino-paper-datos-reales.md 3.3
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


if __name__ == "__main__":
    unittest.main()
