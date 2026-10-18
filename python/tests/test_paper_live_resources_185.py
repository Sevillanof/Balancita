"""Issue #185: resource limits of the paper process (disk and memory warn/stop). The market is the real one; the readings are injected, so no
number here is an approved limit."""

import os
import unittest

from balancita_engine import paper_live_process as LP
from real_session import Base, Clock, config_dict

# Arbitrary test numbers, deliberately not the deferred proposals in the Issues.
LIMITS = {"disk_warn_bytes": 70, "disk_stop_bytes": 90, "memory_warn_bytes": 300, "memory_stop_bytes": 500, "check_every_steps": 2}


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

    def test_a_directory_that_cannot_be_read_is_an_error_not_zero_bytes(self):
        import tempfile
        from unittest import mock
        real = os.scandir
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "locked"))
            with open(os.path.join(root, "locked", "z"), "wb") as handle:
                handle.write(b"0" * 50)

            def scandir(path):
                if str(path).endswith("locked"):
                    raise PermissionError(13, "denied", str(path))
                return real(path)
            with mock.patch("os.scandir", scandir):
                with self.assertRaises(PermissionError):
                    LP.read_resources(root)

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
    def run_with(self, readings, limits=LIMITS, stop_after=None, name="session"):
        clock = Clock()
        self.directory = os.path.join(self.root, name)
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
        reading = {"disk_bytes": 80, "memory_bytes": 10}
        supervisor, code, calls = self.run_with([reading], stop_after=7)
        self.assertEqual(code, LP.EXIT_OK)
        events = self.read(LP.REPORT_FILE)["resources"]["events"]
        self.assertEqual([(e["kind"], e["resource"]) for e in events], [("warning", "disk")])
        self.assertIsNone(self.read(LP.REPORT_FILE)["resources"]["stop_reason"])
        self.assertEqual(calls["n"], 4)                       # steps 1, 2, 4, 6: the first and then every second step

    def test_a_stop_limit_ends_the_session_at_the_step_that_reached_it_and_not_one_step_later(self):
        supervisor, code, calls = self.run_with([{"disk_bytes": 1, "memory_bytes": 10}, {"disk_bytes": 1, "memory_bytes": 800}])
        self.assertEqual(code, LP.EXIT_RESOURCE_STOP)
        report = self.read(LP.REPORT_FILE)
        self.assertEqual(report["resources"]["stop_reason"], "resource_limit:memory")
        self.assertEqual(report["steps"], 2)                    # read at steps 1 and 2; the limit was reached at 2
        self.assertEqual(calls["n"], 2)
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["phase"], LP.STOPPED_PHASE)
        self.assertEqual(report["ended_as"], LP.STOPPED_PHASE)

    def test_the_edges_of_the_limits_are_inclusive(self):
        _, code, _ = self.run_with([{"disk_bytes": 89, "memory_bytes": 499}], stop_after=3, name="below")
        self.assertEqual(code, LP.EXIT_OK)                       # one under each stop limit
        self.assertEqual(sorted(e["resource"] for e in self.read(LP.REPORT_FILE)["resources"]["events"]), ["disk", "memory"])
        _, code, _ = self.run_with([{"disk_bytes": 90, "memory_bytes": 0}], name="disk-edge")
        self.assertEqual((code, self.read(LP.REPORT_FILE)["steps"]), (LP.EXIT_RESOURCE_STOP, 1))
        _, code, _ = self.run_with([{"disk_bytes": 0, "memory_bytes": 500}], name="memory-edge")
        self.assertEqual((code, self.read(LP.REPORT_FILE)["steps"]), (LP.EXIT_RESOURCE_STOP, 1))
        events = self.read(LP.REPORT_FILE)["resources"]["events"]
        self.assertEqual([(e["kind"], e["resource"]) for e in events], [("stop", "memory")])

    def test_a_sigterm_in_the_same_step_still_leaves_the_limit_on_record(self):
        clock = Clock()
        supervisor = self.supervisor(clock, resource_limits=LIMITS)
        supervisor.resources = lambda _d: {"disk_bytes": 1, "memory_bytes": 800}
        supervisor.start()
        supervisor.request_stop(__import__("signal").SIGTERM)      # asked before the limit was read
        supervisor._check_resources(clock.now(), 1)
        self.assertEqual(supervisor.run(), LP.EXIT_RESOURCE_STOP)
        report = self.read(LP.REPORT_FILE)
        self.assertEqual(report["resources"]["stop_reason"], "resource_limit:memory")
        self.assertEqual(report["stop_signal"], __import__("signal").SIGTERM)

    def test_the_stop_is_durable_and_leaves_an_open_position_as_it_is(self):
        clock = Clock()
        supervisor = self.supervisor(clock, resource_limits=LIMITS)
        supervisor.start()
        opened = None
        for _ in range(40):                                     # the forced entry of C29 comes at step 7
            now = clock.now()
            supervisor.tick(now)
            supervisor.session.step(now)
            clock.sleep(0)
            if supervisor.session.runner.portfolio.snapshot()["open_positions"] > 0:
                opened = supervisor.session.runner.portfolio.snapshot()["open_positions"]
                break
        self.assertIsNotNone(opened, "the fixture opens a position")
        supervisor.resources = lambda _d: {"disk_bytes": 1, "memory_bytes": 800}
        supervisor._check_resources(clock.now(), 1)
        self.assertEqual(supervisor.run(), LP.EXIT_RESOURCE_STOP)
        self.assertEqual(self.read(LP.REPORT_FILE)["positions"]["open_at_end"], opened)
        again = self.supervisor(Clock(5), resource_limits=LIMITS)
        with self.assertRaises(LP.ProcessError) as caught:
            again.start()
        self.assertEqual(caught.exception.reason, "session_stopped")
        again.session = None

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
