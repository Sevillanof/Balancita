"""Issue #185: resource limits of the paper process (disk and memory warn/stop). Invented data; the readings are injected, so no
number here is an approved limit."""

import os
import unittest

from balancita_engine import paper_live_process as LP
from test_paper_live_process_185 import Base, Clock, config_dict

LIMITS = {"disk_warn_bytes": 100, "disk_stop_bytes": 150, "memory_warn_bytes": 400, "memory_stop_bytes": 600, "check_every_steps": 2}


class TestResourceConfig(unittest.TestCase):
    def test_absent_limits_leave_the_digest_and_the_behaviour_as_before(self):
        plain = LP.validate_config(config_dict())
        self.assertNotIn("resource_limits", plain)
        with_limits = LP.validate_config(config_dict(resource_limits=LIMITS))
        self.assertNotEqual(plain["digest"], with_limits["digest"])

    def test_bad_limits_are_refused(self):
        for bad in ({}, {"check_every_steps": 3}, {"disk_warn_bytes": 5, "disk_stop_bytes": 5}, {"memory_stop_bytes": 0},
                    {"memory_stop_bytes": True}, {"disk_stop_bytes": 1.5}, {"disk_stop_bytes": 9, "bogus": 1}, [], "x",
                    {"disk_stop_bytes": 9, "check_every_steps": 0}):
            with self.assertRaises(LP.ProcessError, msg=repr(bad)) as caught:
                LP.validate_config(config_dict(resource_limits=bad))
            self.assertEqual(caught.exception.reason, "config_invalid")

    def test_a_single_limit_is_enough_and_the_cadence_defaults(self):
        config = LP.validate_config(config_dict(resource_limits={"disk_stop_bytes": 9}))
        self.assertEqual(config["resource_limits"], {"disk_stop_bytes": 9, "check_every_steps": LP.DEFAULT_CHECK_EVERY_STEPS})

    def test_the_real_reader_counts_the_files_of_the_directory(self):
        import tempfile
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "a"))
            for name, size in (("x", 10), (os.path.join("a", "y"), 25)):
                with open(os.path.join(root, name), "wb") as handle:
                    handle.write(b"0" * size)
            reading = LP.read_resources(root)
        self.assertEqual(reading["disk_bytes"], 35)
        self.assertGreater(reading["memory_bytes"], 0)


class TestResourceMonitor(Base):
    def run_with(self, readings, limits=LIMITS, stop_after=None):
        clock = Clock()
        supervisor = self.supervisor(clock, resource_limits=limits)
        calls = {"n": 0}

        def resources(_directory):
            reading = readings[min(calls["n"], len(readings) - 1)]
            calls["n"] += 1
            if isinstance(reading, Exception):
                raise reading
            return reading
        supervisor.resources = resources
        supervisor.start()
        original = supervisor.tick
        steps = {"n": 0}

        def tick(now):
            original(now)
            steps["n"] += 1
            if stop_after and steps["n"] == stop_after:
                supervisor.request_stop(None)
        supervisor.tick = tick
        return supervisor, supervisor.run(), calls

    def test_a_warning_is_recorded_once_and_the_session_goes_on(self):
        reading = {"disk_bytes": 120, "memory_bytes": 10}
        supervisor, code, calls = self.run_with([reading], stop_after=7)
        self.assertEqual(code, LP.EXIT_OK)
        events = self.read(LP.REPORT_FILE)["resources"]["events"]
        self.assertEqual([(e["kind"], e["resource"]) for e in events], [("warning", "disk")])
        self.assertIsNone(self.read(LP.REPORT_FILE)["resources"]["stop_reason"])
        self.assertEqual(calls["n"], 4)                       # steps 1, 2, 4, 6: the first and then every second step

    def test_a_stop_limit_ends_the_session_in_order_with_its_own_exit_status(self):
        supervisor, code, _ = self.run_with([{"disk_bytes": 1, "memory_bytes": 10}, {"disk_bytes": 1, "memory_bytes": 700}])
        self.assertEqual(code, LP.EXIT_RESOURCE_STOP)
        report = self.read(LP.REPORT_FILE)
        self.assertEqual(report["resources"]["stop_reason"], "resource_limit:memory")
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["phase"], LP.STOPPED_PHASE)

    def test_a_measurement_that_fails_stops_in_order_too(self):
        _, code, _ = self.run_with([{"disk_bytes": 1, "memory_bytes": 1}, OSError("gone")])
        self.assertEqual(code, LP.EXIT_RESOURCE_STOP)
        events = self.read(LP.REPORT_FILE)["resources"]["events"]
        self.assertEqual(events[-1]["resource"], "measurement")

    def test_the_heartbeat_carries_the_last_reading(self):
        self.run_with([{"disk_bytes": 5, "memory_bytes": 6}], stop_after=3)
        beat = self.read(LP.HEARTBEAT_FILE)
        self.assertEqual(beat["resources"]["last"]["disk_bytes"], 5)

    def test_without_limits_nothing_is_measured_or_written(self):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.resources = lambda _d: self.fail("measured without limits")
        supervisor.start()
        supervisor.request_stop(None)
        self.assertEqual(supervisor.run(), LP.EXIT_OK)
        self.assertNotIn("resources", self.read(LP.REPORT_FILE))


if __name__ == "__main__":
    unittest.main()
