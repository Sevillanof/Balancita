"""Issue #184, PR 5b: the stale-quote stop of the paper process (``stale_stop``). The value is a parameter named by the operator, never a
default; Captura's 24 h measurement picks the real one. The quote gaps come from the real XBT tickers of the partial sample (they hold three
real WebSocket cuts); the end-to-end run reuses the session harness (invented market, to be replaced with the real quotes)."""

import json
import os
import unittest
from types import SimpleNamespace

import real_sample
from balancita_engine import paper_live_process as LP
from live_world import MIN, World
from test_paper_live_integration import FIRST_DECISION, MAX_QUOTE_GAP_MS
from test_paper_live_process_185 import Base, Clock, config_dict

BTC = "PF_XBTUSD"
DECISION_MS = 1763254200000
HOLE = (DECISION_MS - 100_000, DECISION_MS + 30_000)         # no BTC quote for 130 s


def real_windows():
    """The received times of the real XBT tickers, one list per capture window (a window ends at a jump of more than a minute)."""
    times = sorted(row["received_at"] for row in real_sample.rows("market_events", real_sample.PARTIAL_DIR) if row["product_id"] == BTC)
    windows = [[times[0]]]
    for previous, current in zip(times, times[1:]):
        if current - previous > 60_000:
            windows.append([])
        windows[-1].append(current)
    return windows


class TestConfiguration(unittest.TestCase):
    def test_absent_leaves_the_digest_and_the_behaviour_as_before(self):
        plain = LP.validate_config(config_dict())
        self.assertNotIn("stale_stop", plain)
        named = LP.validate_config(config_dict(stale_stop={"stop_quote_gap_ms": MAX_QUOTE_GAP_MS + 1}))
        self.assertNotEqual(plain["digest"], named["digest"])

    def test_bad_values_are_refused(self):
        for bad in ({}, {"stop_quote_gap_ms": MAX_QUOTE_GAP_MS}, {"stop_quote_gap_ms": 1}, {"stop_quote_gap_ms": True},
                    {"stop_quote_gap_ms": 60_000.5}, {"stop_quote_gap_ms": "60000"}, {"stop_quote_gap_ms": 60_000, "bogus": 1}, [], "x", None):
            with self.subTest(bad=bad), self.assertRaises(LP.ProcessError) as caught:
                LP.validate_config(config_dict(stale_stop=bad))
            self.assertEqual(caught.exception.reason, "config_invalid")

    def test_the_stop_has_a_status_of_its_own(self):
        self.assertEqual(len({LP.EXIT_OK, LP.EXIT_REFUSED, LP.EXIT_HALTED, LP.EXIT_RESOURCE_STOP, LP.EXIT_STALE_STOP}), 5)


class TestStaleProduct(unittest.TestCase):
    def test_a_gap_equal_to_the_limit_is_not_stale_and_the_next_millisecond_is(self):
        self.assertIsNone(LP.stale_product({BTC: 1_000}, [BTC], 0, 61_000, 60_000))
        self.assertEqual(LP.stale_product({BTC: 1_000}, [BTC], 0, 61_001, 60_000), (BTC, 60_001))

    def test_a_product_that_never_quoted_is_measured_from_the_start_and_a_quote_before_it_does_not_count(self):
        self.assertIsNone(LP.stale_product({}, [BTC], 5_000, 65_000, 60_000))
        self.assertEqual(LP.stale_product({}, [BTC], 5_000, 65_001, 60_000), (BTC, 60_001))
        self.assertEqual(LP.stale_product({BTC: 1_000}, [BTC], 5_000, 65_001, 60_000), (BTC, 60_001))

    def test_the_longest_silence_among_the_products_is_the_one_reported(self):
        self.assertEqual(LP.stale_product({"PF_A": 0, "PF_B": 30_000, "PF_C": 90_000}, ["PF_A", "PF_B", "PF_C"], 0, 100_000, 50_000), ("PF_A", 100_000))

    def test_the_real_cuts_of_the_websocket_trip_a_limit_below_them_and_not_one_above(self):
        windows = real_windows()
        self.assertEqual(len(windows), 3)
        gaps = [b - a for window in windows for a, b in zip(window, window[1:])]
        longest = max(gaps)
        self.assertTrue(2_000 < longest < 5_000, longest)                      # the real cuts are seconds long
        for limit, tripped in ((longest - 1, True), (longest, False), (longest + 1_000, False)):
            with self.subTest(limit=limit):
                found = False
                for window in windows:
                    for previous, current in zip(window, window[1:]):
                        # the instant just before the next quote arrives: how late is the product then
                        found = found or LP.stale_product({BTC: previous}, [BTC], window[0], current, limit) is not None
                self.assertEqual(found, tripped)


class TestSupervisorCheck(unittest.TestCase):
    def supervisor(self, last_quote, limit=60_000):
        config = LP.validate_config(config_dict(stale_stop={"stop_quote_gap_ms": limit}))
        supervisor = LP.Supervisor(config, "/nonexistent", "/nonexistent", clock=lambda: 0)
        supervisor.session = SimpleNamespace(last_quote=last_quote)
        return supervisor

    def test_a_silent_product_asks_for_the_orderly_stop_once_and_says_why(self):
        supervisor = self.supervisor({BTC: 1_000})
        supervisor._check_quote_gap(1_000)
        supervisor._check_quote_gap(61_000)
        self.assertFalse(supervisor.stop_requested)
        supervisor._check_quote_gap(61_001)
        supervisor._check_quote_gap(90_000)
        self.assertTrue(supervisor.stop_requested)
        self.assertEqual(supervisor.stop_reason, "quote_gap:" + BTC)
        self.assertEqual(supervisor.stale_events, [{"kind": "stop", "product_id": BTC, "gap_ms": 60_001, "limit_ms": 60_000, "observed_now_ms": 61_001}])

    def test_a_product_that_keeps_quoting_never_stops_the_session(self):
        last = {}
        supervisor = self.supervisor(last)
        for now in range(0, 600_000, 20_000):
            last[BTC] = now
            supervisor._check_quote_gap(now)
        self.assertFalse(supervisor.stop_requested)
        self.assertIsNone(supervisor.stop_reason)

    def test_without_the_parameter_nothing_is_checked(self):
        config = LP.validate_config(config_dict())
        supervisor = LP.Supervisor(config, "/nonexistent", "/nonexistent", clock=lambda: 0)
        supervisor.session = SimpleNamespace(last_quote={})
        supervisor._check_quote_gap(0)
        supervisor._check_quote_gap(10 ** 9)
        self.assertFalse(supervisor.stop_requested)

    def test_a_stop_already_asked_by_a_resource_limit_keeps_its_reason(self):
        supervisor = self.supervisor({BTC: 0})
        supervisor.stop_reason = "resource_limit:disk"
        supervisor._check_quote_gap(1)
        supervisor._check_quote_gap(100_000)
        self.assertEqual(supervisor.stop_reason, "resource_limit:disk")


class TestStaleStopInTheSession(Base):
    """End to end on the session harness: a 130 s hole in the quotes with a 60 s limit ends the session in order, with its own status."""

    def setUp(self):
        super().setUp()
        self.world.close()
        holey = os.path.join(self.root, "holey")
        os.makedirs(holey)
        self.world = World(holey, quote_holes=[HOLE])
        self.world.release_until(FIRST_DECISION - MIN)

    def test_the_hole_ends_the_session_in_order_with_status_5_and_the_reason_on_record(self):
        clock = Clock()
        supervisor = self.supervisor(clock, stale_stop={"stop_quote_gap_ms": 60_000})
        supervisor.start()
        code = supervisor.run()
        self.assertEqual(code, LP.EXIT_STALE_STOP)
        report = self.read(LP.REPORT_FILE)
        self.assertEqual(report["ended_as"], LP.STOPPED_PHASE)
        self.assertEqual(report["stale_stop"]["stop_reason"], "quote_gap:" + BTC)
        self.assertEqual(report["stale_stop"]["events"][0]["limit_ms"], 60_000)
        self.assertGreater(report["stale_stop"]["events"][0]["gap_ms"], 60_000)
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["phase"], LP.STOPPED_PHASE)


if __name__ == "__main__":
    unittest.main()
