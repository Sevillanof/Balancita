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

    def run_cli(self, over, *flags):
        """The command line with an ``authorization_ref`` in the configuration; returns (exit status, stderr, directory created?)."""
        import json, sqlite3, subprocess, sys, tempfile
        here = os.path.dirname(os.path.abspath(__file__))
        with tempfile.TemporaryDirectory() as root:
            path, source = os.path.join(root, "c.json"), os.path.join(root, "source.sqlite")
            db = sqlite3.connect(source)                                          # nothing real is read; the synthetic marker is there so
            db.execute("CREATE TABLE {}(marker TEXT)".format(LP.MARKER_TABLE))   # that the GATE is the only thing that can refuse
            db.execute("INSERT INTO {} VALUES(?)".format(LP.MARKER_TABLE), (LP.MARKER,))
            db.commit()
            db.close()
            with open(path, "w") as handle:
                json.dump(config_dict(authorization_ref="BAL-DECISION-185-07", **over), handle)
            done = subprocess.run([sys.executable, "-m", "balancita_engine.paper_live_process", "run", "--config", path,
                                   "--directory", os.path.join(root, "d"), "--source", source, "--clock-from-ms", "0", *flags],
                                  env=dict(os.environ, PYTHONPATH=os.path.dirname(here) + os.pathsep + here), capture_output=True, text=True)
            return done.returncode, done.stderr, os.path.exists(os.path.join(root, "d"))

    def test_it_does_not_accept_the_wall_clock(self):
        code, err, created = self.run_cli({}, "--wall-clock")                  # a synthetic source: only the clock is at stake
        self.assertEqual(code, LP.EXIT_REFUSED)
        self.assertIn("wall_clock_not_authorized", err)
        self.assertFalse(created)

    def test_it_does_not_open_the_real_source_gate(self):
        code, err, created = self.run_cli({"source_id": "real"})               # no --wall-clock: only the gate is at stake
        self.assertEqual(code, LP.EXIT_REFUSED)
        self.assertIn("real_session_not_authorized", err)
        self.assertFalse(created)


class TestWallClockIsOffButReady(Base):
    """The code for the wall clock exists and is tested with a fake clock; the constant that opens it is False (BAL-DECISION needed to change it)."""

    def run_main(self, instants, guard=True, extra=()):
        import json, signal
        from unittest import mock
        clock = Scripted(instants)
        config = os.path.join(self.root, "wall-config.json")
        with open(config, "w", encoding="utf-8") as handle:
            json.dump(config_dict(**({"clock_guard": GUARD} if guard else {})), handle)
        self.directory = os.path.join(self.root, "wall-session")
        saved = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT)}
        try:
            with mock.patch.object(LP, "WALL_CLOCK_GATE", True), mock.patch.object(LP, "_wall_now_ms", clock.now), \
                    mock.patch.object(LP.time, "sleep", clock.sleep):
                return LP.main(["run", "--config", config, "--directory", self.directory, "--source", self.world.path,
                                "--wall-clock", "--max-steps", "4", *extra])
        finally:
            for number, handler in saved.items():
                signal.signal(number, handler)

    def test_the_gate_is_a_constant_of_the_code_and_it_is_off(self):
        self.assertIs(LP.WALL_CLOCK_GATE, False)
        self.assertNotIn("wall_clock_gate", LP.DEFAULTS)
        self.assertNotIn("wall_clock", LP.OPTIONAL)                         # no configuration key can open it

    def test_a_wall_clock_without_a_guard_is_refused_even_with_the_gate_open(self):
        with self.assertRaises(LP.ProcessError) as caught:
            LP.wall_clock_runtime(LP.validate_config(config_dict()))
        self.assertEqual(caught.exception.reason, "config_invalid")
        self.assertEqual(self.run_main([TIMES[START]], guard=False), LP.EXIT_REFUSED)
        self.assertFalse(os.path.exists(self.directory))

    def test_with_the_gate_open_the_session_follows_the_clock_it_is_given(self):
        t = TIMES[START:START + 6]
        self.assertEqual(self.run_main(t), LP.EXIT_OK)
        self.assertEqual(self.read(LP.REPORT_FILE)["steps"], 4)
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["observed_now_ms"], t[4])      # the instants came from the injected wall clock, not a simulated one

    def test_with_the_gate_open_a_real_clock_that_goes_back_or_jumps_still_halts(self):
        t = TIMES[START:START + 6]
        self.assertEqual(self.run_main([t[0], t[1], t[0]]), LP.EXIT_HALTED)
        self.assertIn("clock_regression", self.read(LP.REPORT_FILE)["halted"])
        self.setUp()
        self.assertEqual(self.run_main([t[0], t[0] + GUARD["max_forward_jump_ms"] + 1]), LP.EXIT_HALTED)
        self.assertIn("clock_jump", self.read(LP.REPORT_FILE)["halted"])

    def test_both_clocks_at_once_are_refused(self):
        self.assertEqual(self.run_main([TIMES[START]], extra=("--clock-from-ms", "0")), LP.EXIT_REFUSED)
        self.assertFalse(os.path.exists(self.directory))


class TestRealCaptureStaysRefusedAndUntouched(Base):
    """A capture-shaped file without the fixture's marker (what the real capture looks like) is refused by the GATE, whatever the configuration
    says, and the file is not changed by being looked at."""

    def digest(self, path):
        import hashlib
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()

    def test_preflight_and_run_refuse_it_and_leave_the_file_and_the_directory_as_they_were(self):
        import json, shutil, sqlite3, subprocess, sys
        real = os.path.join(self.root, "real-capture.sqlite")
        shutil.copyfile(self.world.path, real)
        db = sqlite3.connect(real)
        db.execute("DROP TABLE {}".format(LP.MARKER_TABLE))                       # what the real capture does not have
        db.commit()
        db.close()
        before = self.digest(real)
        over = {"source_id": "kraken-capture", "ingest_kw": dict(config_dict()["ingest_kw"], causal_until_clock=True)}
        config = os.path.join(self.root, "real-config.json")
        with open(config, "w", encoding="utf-8") as handle:
            json.dump(config_dict(**over), handle)
        report = LP.preflight(LP.load_config(config), self.directory, real)
        failed = sorted(c["name"] for c in report["checks"] if not c["ok"])
        self.assertFalse(report["ok"])
        self.assertIn("real_session_gate", failed)
        self.assertIn("synthetic_marker", failed)
        here = os.path.dirname(os.path.abspath(__file__))
        env = dict(os.environ, PYTHONPATH=os.path.dirname(here) + os.pathsep + here)
        done = subprocess.run([sys.executable, "-m", "balancita_engine.paper_live_process", "run", "--config", config, "--directory", self.directory,
                               "--source", real, "--clock-from-ms", str(TIMES[START])], env=env, capture_output=True, text=True)
        self.assertEqual(done.returncode, LP.EXIT_REFUSED)
        self.assertIn("real_session_not_authorized", done.stderr)
        self.assertFalse(os.path.exists(self.directory))
        self.assertEqual(self.digest(real), before)
        with self.assertRaises(Exception):                                          # the reader itself cannot write to what it reads
            LP.SourceReader(real).db.execute("CREATE TABLE x(a)")


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

    def test_a_one_millisecond_regression_halts(self):
        t = TIMES[START]
        _, code = self.go([t, t + 60_000, t + 59_999], "one-ms")
        self.assertEqual(code, LP.EXIT_HALTED)
        self.assertIn("clock_regression", self.read(LP.REPORT_FILE)["halted"])
        self.assertEqual(self.read(LP.REPORT_FILE)["steps"], 2)
        _, code = self.go([t, t + 60_000, t + 60_000], "same", )               # the same instant twice is not a regression
        self.assertEqual(code, LP.EXIT_OK)

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
