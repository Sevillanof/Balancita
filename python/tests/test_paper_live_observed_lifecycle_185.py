"""Issue #185 (D-205-01..05), observed funding: the halt on a divergence, seen from the process. The market and the accounting funding are
the real ones of PF_XBTUSD (``real_world``: 17-oct 12:40Z on, the 20 hourly responses Kraken sent); the entries are the ones ``Forcing`` makes
(``real_session``). The rest of the process tests are in ``test_paper_live_process_185``."""

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from balancita_engine import paper_live_process as LP
from balancita_engine import paper_live_publish as PUB
from balancita_engine import signal_continuity as SC
from real_session import DECIDE_FROM, Clock, config_dict, strategies
from real_world import BTC, MIN, RealWorld

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE_PATH = os.path.dirname(HERE)
CATCH_UP = 12                                     # the real history is read 5000 rows a step: from here on a step brings no funding response that the halted one could have half-applied


class TestObservedLifecycle(unittest.TestCase):
    """D-205-01..05: the halt is durable and does not depend on the heartbeat, a failing disk is a halt, the report of a halted process
    carries the funding evidence, and the gates hold. The accounting funding is the observed one (#184) so a divergence can be made."""

    def setUp(self):
        SC.disarm()
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.world = RealWorld(self.root, with_funding=True)
        self.addCleanup(self.world.close)
        self.world.release_until(DECIDE_FROM - MIN)
        self.directory = os.path.join(self.root, "session")
        self.strategies = strategies()
        self.supervisors = []
        self.addCleanup(self.close_all)

    def close_all(self):
        for supervisor in self.supervisors:
            if supervisor.session is not None:
                supervisor.abandon()

    def supervisor(self, clock, world=None, **over):
        config = LP.validate_config(config_dict(funding_mode="observed", **over))
        supervisor = LP.Supervisor(config, self.directory, (world or self.world).path, clock=clock.now, sleep=clock.sleep,
                                   tick=(world or self.world).release_until, strategies=self.strategies)
        self.supervisors.append(supervisor)
        return supervisor

    def read(self, name):
        with open(os.path.join(self.directory, name), encoding="utf-8") as handle:
            return json.load(handle)

    def diverge_at(self, supervisor, step):
        """From ``step`` on, the first time the portfolio holds a funding row, it loses it while the book keeps it: two authoritative
        states of our own code now disagree."""
        seen = {"n": 0, "done": False}
        original = supervisor.tick

        def tick(now):
            original(now)
            seen["n"] += 1
            funding = supervisor.session.runner.portfolio.funding.get(BTC)
            if seen["n"] >= step and not seen["done"] and funding:
                del funding[0]
                seen["done"] = True
        supervisor.tick = tick

    def halted_run(self, step=CATCH_UP):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        self.diverge_at(supervisor, step)
        self.assertEqual(supervisor.run(max_steps=60), LP.EXIT_HALTED)
        return supervisor, clock

    def test_a_divergence_halts_the_process_with_the_evidence_and_the_pnl_not_verified(self):
        supervisor, _ = self.halted_run()
        halt, report, beat = self.read(LP.HALT_FILE), self.read(LP.REPORT_FILE), self.read(LP.HEARTBEAT_FILE)
        self.assertIn("funding_book_diverged", halt["reason"])
        self.assertEqual((report["ended_as"], beat["phase"]), (LP.HALTED, LP.HALTED))
        self.assertFalse(report["funding"]["pnl_verified"])                      # D-205-04: the report of a halted process carries the funding
        self.assertIn("divergence_evidence_recorded", report["funding"]["unverified_reasons"])
        self.assertGreaterEqual(report["funding"]["divergence_evidence"], 1)

    def test_the_halt_does_not_depend_on_the_heartbeat(self):
        """D-205-01: the heartbeat still says LIVE (the process died before writing HALTED), says nothing, or the halt file is gone:
        the restart still needs the operator, because the audit holds a divergence nobody acknowledged."""
        _, _ = self.halted_run()
        beat_path, halt_path = os.path.join(self.directory, LP.HEARTBEAT_FILE), os.path.join(self.directory, LP.HALT_FILE)
        beat = self.read(LP.HEARTBEAT_FILE)
        probes = []
        probes.append(("heartbeat says LIVE", lambda: LP._write_json(beat_path, dict(beat, phase=LP.LIVE))))
        probes.append(("heartbeat missing", lambda: os.remove(beat_path)))
        probes.append(("halt file missing as well", lambda: os.remove(halt_path)))
        for name, tamper in probes:
            tamper()
            with self.subTest(probe=name):
                again = self.supervisor(Clock(5))
                with self.assertRaises(LP.ProcessError) as caught:
                    again.start()
                self.assertEqual(caught.exception.reason, "restart_requires_operator")
                self.assertIn("funding_book_diverged", str(caught.exception))        # D-830-01: the refusal says WHY, not just "restart explicitly"
                self.assertIsNone(again.session)

    def test_the_operator_restart_is_on_record_and_a_later_crash_restarts_without_asking(self):
        _, clock = self.halted_run()
        restarted = self.supervisor(clock)
        restarted.start(restart=True)
        self.assertEqual(self.read(LP.RESTARTS_FILE)["restarts"], 1)
        self.assertFalse(os.path.exists(os.path.join(self.directory, LP.HALT_FILE)))
        self.assertTrue(os.path.exists(os.path.join(self.directory, "halt-acknowledged-1.json")))
        self.assertEqual(restarted.run(max_steps=2), LP.EXIT_OK)
        report = self.read(LP.REPORT_FILE)
        self.assertEqual(report["ended_as"], LP.STOPPED_PHASE)
        self.assertGreaterEqual(report["funding"]["divergence_evidence"], 1)       # the evidence is still there
        self.assertFalse(report["funding"]["pnl_verified"])

    def test_a_halt_in_the_step_a_funding_response_arrives_still_restarts(self):
        """D-302-02: the halted step took the response of the next hour from the capture and never checkpointed it. The restart clock
        is later than the response's arrival, so the runner used to refuse the hour as out of order, the book kept it, and the session
        halted again at its first step, at every restart."""
        _, clock = self.halted_run(step=4)
        restarted = self.supervisor(clock)
        restarted.start(restart=True)
        self.assertEqual(restarted.run(max_steps=2), LP.EXIT_OK)
        funding = restarted.session.runner.portfolio.funding[BTC]
        self.assertEqual(restarted.session.funding_divergence(), {"missing": [], "extra": [], "rate_differs": []})
        self.assertGreaterEqual(len(funding), 2)                                   # the hour that was in flight reached the portfolio

    def test_the_published_funding_of_a_diverged_session_says_observed_and_not_verified(self):
        """#187: the block restates the session's own funding report; a divergence is never published as a verified result."""
        supervisor, _ = self.halted_run()
        block = PUB.session_status(self.read(LP.HEARTBEAT_FILE), self.read(LP.HALT_FILE), self.read(LP.REPORT_FILE),
                                   funding=supervisor.session.funding_report())
        self.assertEqual((block["phase"], block["funding"]["source"], block["funding"]["pnl_verified"]), ("HALTED", "observed", False))
        self.assertIn("divergence_evidence_recorded", block["funding"]["reasons"])
        from_file = PUB.session_status(self.read(LP.HEARTBEAT_FILE), self.read(LP.HALT_FILE), self.read(LP.REPORT_FILE))
        self.assertEqual(from_file["funding"]["reasons"], block["funding"]["reasons"])        # the copy in report.json says the same

    def test_the_old_report_of_a_halted_run_does_not_make_a_restarted_session_look_ended(self):
        """D-223-01: ``report.json`` outlives an operator restart; while the new run works the published block follows the heartbeat."""
        _, clock = self.halted_run()
        old_report = self.read(LP.REPORT_FILE)
        restarted = self.supervisor(clock)
        restarted.start(restart=True)
        beat = self.read(LP.HEARTBEAT_FILE)
        self.assertEqual(self.read(LP.REPORT_FILE), old_report)                      # nothing rewrote it
        self.assertGreaterEqual(beat["observed_now_ms"], old_report["ended_at_observed_ms"])        # the first beat of the new run ties with the halt
        block = PUB.session_status(beat, None, old_report)
        self.assertEqual(block["phase"], PUB.PUBLISHED_PHASE[beat["phase"]])
        self.assertNotIn(block["phase"], PUB.FINAL_PHASES)
        self.assertNotIn("report_ended_after_heartbeat", block["reasons"])
        self.assertIsNone(block["halt_reason"])
        self.assertIsNone(block["orderly_stop"])
        restarted.run(max_steps=2)

    def test_the_same_divergence_after_an_acknowledged_restart_is_a_new_occurrence_the_operator_must_see(self):
        """D-205-06 / BAL-COORD-205-02: the audit dedupes by content, so the SAME divergence that comes back after an acknowledged
        restart used to add no line, the count stayed at what the operator had acknowledged, and if the process then died before
        ``halt.json`` (here: its write fails) with the heartbeat saying LIVE or absent, the next start went through unattended."""
        _, clock = self.halted_run()
        before = self.read(LP.RESTARTS_FILE) if os.path.exists(os.path.join(self.directory, LP.RESTARTS_FILE)) else None
        self.assertIsNone(before)
        restarted = self.supervisor(clock)
        restarted.start(restart=True)
        acknowledged = self.read(LP.RESTARTS_FILE)["acknowledged_divergences"]
        self.diverge_at(restarted, 1)
        real, halt_path = LP._write_json, os.path.join(self.directory, LP.HALT_FILE)

        def refuse_halt(path, body):
            if path == halt_path:
                raise OSError(28, "No space left on device")
            return real(path, body)
        LP._write_json = refuse_halt
        try:
            self.assertEqual(restarted.run(max_steps=60), LP.EXIT_HALTED)
        finally:
            LP._write_json = real
        self.assertFalse(os.path.exists(halt_path))                                  # the halt file never made it
        self.assertGreater(restarted._divergences_in_audit(), acknowledged)          # the occurrence is in the audit anyway
        beat_path = os.path.join(self.directory, LP.HEARTBEAT_FILE)
        beat = self.read(LP.HEARTBEAT_FILE)
        for name, tamper in (("heartbeat says LIVE", lambda: LP._write_json(beat_path, dict(beat, phase=LP.LIVE))),
                             ("heartbeat missing", lambda: os.remove(beat_path))):
            tamper()
            with self.subTest(probe=name):
                again = self.supervisor(Clock(5))
                with self.assertRaises(LP.ProcessError) as caught:
                    again.start()                                                    # unattended: still refused
                self.assertEqual(caught.exception.reason, "restart_requires_operator")
                self.assertIsNone(again.session)

    def test_a_crash_after_an_acknowledged_halt_needs_the_operator_again(self):
        _, clock = self.halted_run()
        restarted = self.supervisor(clock)
        restarted.start(restart=True)
        restarted.abandon()                                                        # it dies later, with nothing new wrong
        third = self.supervisor(clock)
        with self.assertRaises(LP.ProcessError) as caught:
            third.start()
        self.assertEqual(caught.exception.reason, "restart_requires_operator")
        third.start(restart=True)
        self.assertIn(third.phase, (LP.WARMUP, LP.LIVE))
        self.assertEqual(self.read(LP.RESTARTS_FILE)["restarts"], 2)

    def test_a_heartbeat_that_cannot_be_written_is_a_durable_halt_with_exit_3(self):
        """D-205-03: the disk refuses the heartbeat; the process halts (not a traceback with exit 1 and a heartbeat that still says LIVE)."""
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        real, calls = supervisor._beat, {"n": 0}

        def failing(now, state):
            calls["n"] += 1
            if calls["n"] == 3:
                raise OSError(28, "No space left on device")
            return real(now, state)
        supervisor._beat = failing
        self.assertEqual(supervisor.run(max_steps=10), LP.EXIT_HALTED)
        self.assertIn("heartbeat", self.read(LP.HALT_FILE)["reason"])
        again = self.supervisor(Clock(5))
        with self.assertRaises(LP.ProcessError) as caught:
            again.start()
        self.assertEqual(caught.exception.reason, "restart_requires_operator")

    def test_ending_a_halted_process_never_writes_stopped(self):
        supervisor, _ = self.halted_run()
        self.assertEqual(supervisor.end(), LP.EXIT_HALTED)
        self.assertEqual(self.read(LP.REPORT_FILE)["ended_as"], LP.HALTED)
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["phase"], LP.HALTED)

    def test_ending_twice_writes_nothing_twice(self):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        self.assertEqual(supervisor.run(max_steps=3), LP.EXIT_OK)
        before = open(os.path.join(self.directory, LP.REPORT_FILE), "rb").read()
        self.assertEqual(supervisor.end(), LP.EXIT_OK)
        self.assertEqual(open(os.path.join(self.directory, LP.REPORT_FILE), "rb").read(), before)

    def test_the_preflight_does_not_touch_the_source(self):
        def digest():
            return hashlib.sha256(open(self.world.path, "rb").read()).hexdigest()
        config = LP.validate_config(config_dict(funding_mode="observed"))
        before = digest()
        self.assertTrue(LP.preflight(config, self.directory, self.world.path, strategies=self.strategies)["ok"])
        self.assertEqual(digest(), before)
        self.assertFalse(os.path.exists(self.directory))

    def test_a_source_that_does_not_carry_the_fixture_marker_is_refused_even_with_the_synthetic_label(self):
        """D-205-02: the gate is not the label alone. A copy of the source without the marker (what a real capture is) is refused."""
        real = os.path.join(self.root, "real-looking.sqlite")
        shutil.copyfile(self.world.path, real)
        db = sqlite3.connect(real)
        db.execute("DROP TABLE balancita_synthetic_fixture")
        db.commit()
        db.close()
        config = LP.validate_config(config_dict(funding_mode="observed"))
        self.assertEqual(config["source_id"], "synthetic")
        report = LP.preflight(config, self.directory, real, strategies=self.strategies)
        self.assertEqual([c["name"] for c in report["checks"] if not c["ok"]], ["source_kind"])
        supervisor = LP.Supervisor(config, self.directory, real, clock=Clock().now, strategies=self.strategies)
        with self.assertRaises(LP.ProcessError) as caught:
            supervisor.start()
        self.assertEqual(caught.exception.reason, "real_session_not_authorized")
        self.assertFalse(os.path.exists(self.directory))

    def test_the_funding_mode_is_part_of_what_a_directory_was_created_with(self):
        first = self.supervisor(Clock())
        first.start()
        first.abandon()
        config = LP.validate_config(config_dict(funding_mode="synthetic"))
        self.assertNotEqual(config["digest"], first.config["digest"])
        report = LP.preflight(config, self.directory, self.world.path, strategies=self.strategies)
        self.assertIn("configuration_matches_directory", [c["name"] for c in report["checks"] if not c["ok"]])

    def test_a_directory_that_cannot_be_created_is_a_refusal_not_a_traceback(self):
        config_path = os.path.join(self.root, "config.json")
        with open(config_path, "w", encoding="utf-8") as handle:
            json.dump(config_dict(funding_mode="observed"), handle)
        blocker = os.path.join(self.root, "a-file")
        open(blocker, "w").close()
        done = subprocess.run([sys.executable, os.path.join(HERE, "cli_with_synthetic_source.py"), "run", "--config", config_path,
                               "--directory", os.path.join(blocker, "inside"), "--source", self.world.path,
                               "--clock-from-ms", str(DECIDE_FROM)], env=dict(os.environ, PYTHONPATH=ENGINE_PATH + os.pathsep + HERE),
                              capture_output=True, text=True, timeout=300)
        self.assertEqual(done.returncode, LP.EXIT_REFUSED, done.stderr)
        self.assertNotIn("Traceback", done.stderr)


if __name__ == "__main__":
    unittest.main()
