"""Issue #185: clock guard of the paper process (regression and jump stop in order). Invented data; the clock is simulated."""

import os
import unittest

from balancita_engine import paper_live_process as LP
from test_paper_live_integration import TIMES
from test_paper_live_process_185 import START, Base, config_dict

GUARD = {"max_forward_jump_ms": 15 * 60_000}          # arbitrary test number, not a proposal


class Scripted(object):
    """``now()`` returns the listed instants one per call; ``sleep`` does nothing."""

    def __init__(self, instants):
        self.instants, self.i = list(instants), 0

    def now(self):
        value = self.instants[min(self.i, len(self.instants) - 1)]
        return value

    def sleep(self, _s):
        self.i += 1


class TestClockConfig(unittest.TestCase):
    def test_absent_guard_changes_nothing_and_bad_guards_are_refused(self):
        plain = LP.validate_config(config_dict())
        self.assertNotIn("clock_guard", plain)
        self.assertNotEqual(LP.validate_config(config_dict(clock_guard=GUARD))["digest"], plain["digest"])
        for bad in ({}, {"max_forward_jump_ms": 0}, {"max_forward_jump_ms": True}, {"max_forward_jump_ms": 1.5},
                    {"max_forward_jump_ms": 5, "x": 1}, [], 7):
            with self.assertRaises(LP.ProcessError, msg=repr(bad)) as caught:
                LP.validate_config(config_dict(clock_guard=bad))
            self.assertEqual(caught.exception.reason, "config_invalid")


class TestAuthorizationRef(unittest.TestCase):
    def test_it_is_validated_audit_only_and_not_part_of_the_identity(self):
        plain = LP.validate_config(config_dict())
        tagged = LP.validate_config(config_dict(authorization_ref="BAL-DECISION-185-07"))
        self.assertEqual(plain["digest"], tagged["digest"])
        self.assertEqual(tagged["authorization_ref"], "BAL-DECISION-185-07")
        for bad in ("", "BAL-DECISION-185", "bal-decision-185-07", "BAL-DECISION-185-07 ", 7, True, ["BAL-DECISION-185-07"]):
            with self.assertRaises(LP.ProcessError, msg=repr(bad)):
                LP.validate_config(config_dict(authorization_ref=bad))

    def test_it_opens_nothing(self):
        import json, subprocess, sys, tempfile
        here = os.path.dirname(os.path.abspath(__file__))
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "c.json")
            with open(path, "w") as handle:
                json.dump(config_dict(authorization_ref="BAL-DECISION-185-07", source_id="real"), handle)
            done = subprocess.run([sys.executable, "-m", "balancita_engine.paper_live_process", "run", "--config", path,
                                   "--directory", os.path.join(root, "d"), "--source", os.path.join(root, "none.sqlite"), "--wall-clock"],
                                  env=dict(os.environ, PYTHONPATH=os.path.dirname(here) + os.pathsep + here), capture_output=True, text=True)
        self.assertEqual(done.returncode, LP.EXIT_REFUSED)
        self.assertFalse(os.path.exists(os.path.join(root, "d")))


class TestClockGuard(Base):
    def go(self, instants, name, **over):
        clock = Scripted(instants)
        self.directory = os.path.join(self.root, name)
        supervisor = self.supervisor(clock, clock_guard=GUARD, **over)
        supervisor.wall_time = lambda: 123
        supervisor.start()
        return supervisor, supervisor.run(max_steps=20)

    def test_a_clock_that_goes_back_halts_before_stepping_on_it_and_a_restart_needs_the_operator(self):
        t = TIMES[START:START + 5]
        supervisor, code = self.go([t[0], t[1], t[2], t[1], t[3]], "back")
        self.assertEqual(code, LP.EXIT_HALTED)
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["phase"], LP.HALTED)
        self.assertIn("clock_regression", self.read(LP.REPORT_FILE)["halted"])
        self.assertEqual(self.read(LP.REPORT_FILE)["steps"], 3)          # the fourth instant was the bad one: never stepped
        self.assertTrue(os.path.exists(os.path.join(self.directory, LP.HALT_FILE)))
        again = self.supervisor(Scripted([t[3]]), clock_guard=GUARD)
        with self.assertRaises(LP.ProcessError) as caught:
            again.start()
        self.assertEqual(caught.exception.reason, "restart_requires_operator")
        again.session = None

    def test_a_jump_past_the_bound_halts_and_exactly_the_bound_does_not(self):
        t = TIMES[START]
        _, code = self.go([t, t + GUARD["max_forward_jump_ms"] + 1], "jump")
        self.assertEqual((code, self.read(LP.REPORT_FILE)["steps"]), (LP.EXIT_HALTED, 1))
        self.assertIn("clock_jump", self.read(LP.REPORT_FILE)["halted"])
        _, code = self.go([t, t + GUARD["max_forward_jump_ms"], t + GUARD["max_forward_jump_ms"]], "edge")
        self.assertEqual(code, LP.EXIT_OK)
        self.assertEqual(self.read(LP.REPORT_FILE)["clock"]["events"], [])

    def test_the_wall_time_changes_neither_the_decisions_nor_the_digests(self):
        t = [TIMES[START + i] for i in range(4)]
        out = []
        for name, wall in (("wall-a", 1), ("wall-b", 987_654_321)):
            clock = Scripted(t)
            self.directory = os.path.join(self.root, name)
            supervisor = self.supervisor(clock, clock_guard=GUARD)
            supervisor.wall_time = lambda wall=wall: wall
            supervisor.start()
            supervisor.run(max_steps=4)
            report = self.read(LP.REPORT_FILE)
            out.append((report["digests"], report["config_digest"], report["steps"], self.read(LP.HEARTBEAT_FILE)["wall_ms"]))
        self.assertEqual(out[0][:3], out[1][:3])
        self.assertEqual((out[0][3], out[1][3]), (1, 987_654_321))

    def test_the_heartbeat_carries_the_wall_time_only_with_the_guard(self):
        t = TIMES[START]
        self.go([t, t + 60_000], "beat")
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["wall_ms"], 123)

    def test_without_the_guard_nothing_is_added_and_the_clock_is_not_read(self):
        clock = Scripted([TIMES[START], TIMES[START] - 1, TIMES[START]])
        self.directory = os.path.join(self.root, "plain")
        supervisor = self.supervisor(clock)
        supervisor.wall_time = lambda: self.fail("wall time read without the guard")
        supervisor.start()
        supervisor.run(max_steps=3)
        self.assertNotIn("wall_ms", self.read(LP.HEARTBEAT_FILE))
        self.assertNotIn("clock", self.read(LP.REPORT_FILE))


if __name__ == "__main__":
    unittest.main()
