"""Issue #184, PR 5b: the stale-quote stop of the paper process (``stale_stop``). The value is a parameter named by the operator, never a
default; Captura's 24 h measurement picks the real one. The quote gaps come from the real XBT tickers of the partial sample (they hold three
real WebSocket cuts); the end-to-end run replays the real candles and quotes of the same sample (``real_world``), with 130 s of real quotes left out."""

import json
import os
import shutil
import tempfile
import unittest
from types import SimpleNamespace

import real_sample
from balancita_engine import paper_live_process as LP
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC
from real_world import BTC, MIN, SEC, T0, RealWorld
from test_paper_live_integration import MAX_QUOTE_GAP_MS
from test_paper_live_process_185 import config_dict

DECIDE_FROM = T0 + 600 * MIN
DECIDE_UNTIL = T0 + 1000 * MIN
HOLE = (DECIDE_FROM + 10 * MIN, DECIDE_FROM + 10 * MIN + 130 * SEC)         # 130 s of real quotes left out


def real_windows():
    """The Kraken times of the real XBT tickers, one list per capture window (a window ends at a jump of more than a minute)."""
    times = sorted(row["event_time"] for row in real_sample.rows("market_events", real_sample.PARTIAL_DIR) if row["product_id"] == BTC)
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

    def test_a_product_that_never_quoted_is_measured_from_the_start_and_one_that_did_from_its_last_quote(self):
        self.assertIsNone(LP.stale_product({}, [BTC], 5_000, 65_000, 60_000))
        self.assertEqual(LP.stale_product({}, [BTC], 5_000, 65_001, 60_000), (BTC, 60_001))
        self.assertEqual(LP.stale_product({BTC: 1_000}, [BTC], 5_000, 61_001, 60_000), (BTC, 60_001))      # not given a fresh limit by the start
        self.assertIsNone(LP.stale_product({BTC: 1_000}, [BTC], 5_000, 61_000, 60_000))

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


class Clock(object):
    """Ten-second steps from the first decision; ``sleep`` moves to the next one."""

    def __init__(self):
        self.t = DECIDE_FROM

    def now(self):
        return self.t

    def sleep(self, _seconds):
        self.t += 10 * SEC


class TestStaleStopInTheSession(unittest.TestCase):
    """End to end on the real candles and quotes: a 130 s hole with a 60 s limit ends the session in order, with its own status."""

    def setUp(self):
        SC.disarm()
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.world = RealWorld(self.root, quote_holes=[HOLE])
        self.addCleanup(self.world.close)
        self.world.release_until(DECIDE_FROM - MIN)
        self.directory = os.path.join(self.root, "session")

    def read(self, name):
        with open(os.path.join(self.directory, name), encoding="utf-8") as handle:
            return json.load(handle)

    def test_the_hole_ends_the_session_in_order_with_status_5_and_the_reason_on_record(self):
        clock = Clock()
        config = LP.validate_config(config_dict(decide_from_ms=DECIDE_FROM, decide_until_ms=DECIDE_UNTIL, warmup_minutes=540,
                                                funding_mode="observed", stale_stop={"stop_quote_gap_ms": 60_000}))
        supervisor = LP.Supervisor(config, self.directory, self.world.path, clock=clock.now, sleep=clock.sleep,
                                   tick=self.world.release_until, strategies=RS.load_frozen()[0])
        self.addCleanup(lambda: supervisor.session is not None and supervisor.abandon())
        supervisor.start()
        code = supervisor.run()
        self.assertEqual(code, LP.EXIT_STALE_STOP)
        report = self.read(LP.REPORT_FILE)
        self.assertEqual(report["ended_as"], LP.STOPPED_PHASE)
        self.assertEqual(report["stale_stop"]["stop_reason"], "quote_gap:" + BTC)
        self.assertEqual(report["stale_stop"]["events"][0]["limit_ms"], 60_000)
        self.assertGreater(report["stale_stop"]["events"][0]["gap_ms"], 60_000)
        beat = self.read(LP.HEARTBEAT_FILE)
        self.assertEqual(beat["phase"], LP.STOPPED_PHASE)
        self.assertEqual((beat["stale_stop"]["limit_ms"], beat["stale_stop"]["events"]), (60_000, report["stale_stop"]["events"]))


if __name__ == "__main__":
    unittest.main()
