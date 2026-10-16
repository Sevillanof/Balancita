"""Issue #185: the life of a paper session as a process (configuration, pre-flight, warm-up, orderly stop, restart). Invented data
only; the clock is simulated and the sleep does nothing, except in the one test that sends a real SIGTERM to a child process."""

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from balancita_engine import paper_live_integration as LI
from balancita_engine import paper_live_process as LP
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC
from live_world import LOAD_START, MIN, World
from test_paper_observed_funding_184 import FIRST_HOUR, HOUR, LAG, hourly_responses, new_world
from test_paper_live_integration import BTC, FIRST_DECISION, INGEST_KW, LAST_DECISION, MAX_QUOTE_GAP_MS, TIMES

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE_PATH = os.path.dirname(HERE)


def config_dict(**over):
    body = {"schema": LP.CONFIG_SCHEMA, "products": [BTC], "decide_from_ms": FIRST_DECISION, "decide_until_ms": LAST_DECISION,
            "ingest_kw": INGEST_KW, "max_quote_gap_ms": MAX_QUOTE_GAP_MS, "min_free_bytes": 1, "warmup_minutes": 2800}
    body.update(over)
    return body


START = min(i for i, t in enumerate(TIMES) if t >= FIRST_DECISION)     # the history is released up to here before the process starts


class Clock(object):
    """The instants of ``TIMES``, one per step; ``sleep`` moves to the next one."""

    def __init__(self, start=0):
        self.index = START + start

    def now(self):
        return TIMES[min(self.index, len(TIMES) - 1)]

    def sleep(self, _seconds):
        self.index += 1


class Base(unittest.TestCase):
    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        cls.cache["dir"] = tempfile.mkdtemp()
        cls.cache["strategies"], _ = RS.load_frozen()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    def setUp(self):
        self.root = tempfile.mkdtemp(dir=self.cache["dir"])
        self.world = World(self.root)
        self.world.release_until(FIRST_DECISION - MIN)              # the history is already there when the process starts
        self.directory = os.path.join(self.root, "session")
        self.supervisors = []

    def tearDown(self):
        for supervisor in self.supervisors:
            if supervisor.session is not None:
                supervisor.abandon()
        self.world.close()

    def supervisor(self, clock, world=None, directory=None, **over):
        config = LP.validate_config(config_dict(**over))
        world = world or self.world
        supervisor = LP.Supervisor(config, directory or self.directory, world.path, clock=clock.now, sleep=clock.sleep,
                                   tick=world.release_until, strategies=self.cache["strategies"])
        self.supervisors.append(supervisor)
        return supervisor

    def read(self, name):
        with open(os.path.join(self.directory, name), encoding="utf-8") as handle:
            return json.load(handle)


class TestConfiguration(unittest.TestCase):
    def test_the_capital_label_follows_the_portfolio_the_runner_really_uses(self):
        portfolio = LP.runner_config_of(LP.validate_config(config_dict())).portfolio
        self.assertEqual(LP.CAPITAL_POLICY, LP.capital_policy_label(portfolio))
        self.assertEqual(LP.CAPITAL_POLICY, "shared-portfolio-1000-usd-risk-1pct-experimental")
        self.assertNotIn("100-usd", LP.CAPITAL_POLICY.replace("1000-usd", ""))
        other = type(portfolio)(initial_equity_usd="2500", risk_per_trade="0.005")
        self.assertEqual(LP.capital_policy_label(other), "shared-portfolio-2500-usd-risk-0.5pct-experimental")

    def test_a_valid_configuration_has_a_stable_digest_and_the_defaults_are_filled(self):
        a, b = LP.validate_config(config_dict()), LP.validate_config(dict(reversed(list(config_dict().items()))))
        self.assertEqual(a["digest"], b["digest"])
        self.assertEqual(a["capital_policy"], LP.CAPITAL_POLICY)
        self.assertEqual(a["on_funding_divergence"], "halt")
        self.assertNotEqual(LP.validate_config(config_dict(max_quote_gap_ms=20_000))["digest"], a["digest"])

    def test_what_is_wrong_is_refused_with_a_reason_and_nothing_is_guessed(self):
        for over in ({"products": []}, {"products": ["BTC-EUR"]}, {"products": [BTC, BTC]}, {"decide_from_ms": "x"},
                     {"decide_until_ms": FIRST_DECISION}, {"funding_mode": "real"}, {"on_funding_divergence": "ignore"}, {"on_funding_divergence": "alert"},
                     {"strategies": "all"}, {"capital_policy": "kelly"}, {"surprise": 1}, {"block_stale_entries": 1}):
            with self.assertRaises(LP.ProcessError, msg=str(over)) as caught:
                LP.validate_config(config_dict(**over))
            self.assertEqual(caught.exception.reason, "config_invalid", str(over))
        body = config_dict()
        del body["products"]
        with self.assertRaises(LP.ProcessError):
            LP.validate_config(body)

    def test_an_unreadable_file_is_a_reason(self):
        with self.assertRaises(LP.ProcessError) as caught:
            LP.load_config("/nonexistent/config.json")
        self.assertEqual(caught.exception.reason, "config_unreadable")


class TestPreflightAndStart(Base):
    def test_preflight_reports_every_check_and_writes_nothing(self):
        config = LP.validate_config(config_dict())
        report = LP.preflight(config, self.directory, self.world.path, strategies=self.cache["strategies"])
        self.assertTrue(report["ok"], report)
        self.assertEqual({c["name"] for c in report["checks"]} >= {"real_session_gate", "disk_free", "source_readable", "warmup_" + BTC}, True)
        self.assertFalse(os.path.exists(self.directory))

    def test_a_source_without_the_warmup_is_refused_before_anything_is_created(self):
        config = LP.validate_config(config_dict(decide_from_ms=LOAD_START + 3_600_000))
        report = LP.preflight(config, self.directory, self.world.path, strategies=self.cache["strategies"])
        self.assertFalse(report["ok"])
        self.assertEqual([c["name"] for c in report["checks"] if not c["ok"]], ["warmup_" + BTC])
        with self.assertRaises(LP.ProcessError) as caught:
            self.supervisor(Clock(), decide_from_ms=LOAD_START + 3_600_000).start()
        self.assertEqual(caught.exception.reason, "preflight_failed")
        self.assertFalse(os.path.exists(self.directory))

    def test_a_real_source_is_not_authorized_and_nothing_is_written(self):
        with self.assertRaises(LP.ProcessError) as caught:
            self.supervisor(Clock(), source_id="kraken-live").start()
        self.assertEqual(caught.exception.reason, "real_session_not_authorized")
        self.assertFalse(os.path.exists(self.directory))

    def test_a_missing_disk_margin_or_an_unreadable_source_is_refused(self):
        config = LP.validate_config(config_dict(min_free_bytes=1 << 62))
        report = LP.preflight(config, self.directory, self.world.path, strategies=self.cache["strategies"])
        self.assertEqual([c["name"] for c in report["checks"] if not c["ok"]], ["disk_free"])
        report = LP.preflight(LP.validate_config(config_dict()), self.directory, os.path.join(self.root, "nothing.sqlite"),
                              strategies=self.cache["strategies"])
        self.assertFalse(report["ok"])
        self.assertIn("source_readable", [c["name"] for c in report["checks"] if not c["ok"]])

    def test_another_configuration_cannot_continue_a_directory(self):
        first = self.supervisor(Clock())
        first.start()
        first.abandon()
        other = self.supervisor(Clock(), max_quote_gap_ms=20_000)
        with self.assertRaises(LP.ProcessError) as caught:
            other.start()
        self.assertEqual(caught.exception.reason, "preflight_failed")
        self.assertIn("configuration_matches_directory", str(caught.exception))

    def test_a_directory_with_a_live_writer_is_refused(self):
        first = self.supervisor(Clock())
        first.start()
        second = self.supervisor(Clock())
        with self.assertRaises(LP.ProcessError) as caught:
            second.start()
        self.assertIn("directory_unlocked", str(caught.exception))


class TestLifecycle(Base):
    def test_warmup_then_live_then_an_orderly_stop_that_leaves_the_files_a_supervisor_needs(self):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["phase"], LP.WARMUP)
        phases = [LP.WARMUP]
        original = supervisor._beat

        def spy(now, state):
            original(now, state)
            phases.append(supervisor.phase)
        supervisor._beat = spy
        self.assertEqual(supervisor.run(max_steps=len(TIMES) // 2), LP.EXIT_OK)
        self.assertIn(LP.WARMUP, phases)
        self.assertIn(LP.LIVE, phases)
        self.assertLess(phases.index(LP.WARMUP), phases.index(LP.LIVE))
        self.assertEqual(phases[-2:], [LP.STOPPING, LP.STOPPED_PHASE])
        beat, report = self.read(LP.HEARTBEAT_FILE), self.read(LP.REPORT_FILE)
        self.assertEqual((beat["phase"], report["ended_as"]), (LP.STOPPED_PHASE, LP.STOPPED_PHASE))
        self.assertEqual(report["policy_status"], "experimental")
        self.assertEqual(report["evidence_class"], "not_forward_evidence")
        self.assertEqual(report["capital_policy"], LP.CAPITAL_POLICY)
        self.assertEqual(report["pending_at_end"], 0)
        self.assertEqual(beat["session_id"], report["session_id"])

    def test_a_stopped_session_is_over(self):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        supervisor.run(max_steps=3)
        again = self.supervisor(Clock(4))
        with self.assertRaises(LP.ProcessError) as caught:
            again.start()
        self.assertEqual(caught.exception.reason, "session_stopped")

    def test_the_stop_request_only_sets_a_flag_and_the_loop_ends_after_its_step(self):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        steps = {"n": 0}
        original = supervisor.tick

        def tick(now):
            original(now)
            steps["n"] += 1
            if steps["n"] == 4:
                supervisor.request_stop(signal.SIGTERM)
        supervisor.tick = tick
        self.assertEqual(supervisor.run(), LP.EXIT_OK)
        self.assertEqual(steps["n"], 4)
        self.assertEqual(self.read(LP.REPORT_FILE)["stop_signal"], signal.SIGTERM)
        self.assertEqual(self.read(LP.REPORT_FILE)["steps"], 4)

    def test_a_stop_with_a_position_open_leaves_it_open_and_says_so(self):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        opened = None
        for _ in range(len(TIMES)):
            now = clock.now()
            supervisor.tick(now)
            supervisor.session.step(now)
            clock.sleep(0)
            if supervisor.session.runner.portfolio.snapshot()["open_positions"] > 0:
                opened = supervisor.session.runner.portfolio.snapshot()
                break
        self.assertIsNotNone(opened, "the fixture opens a position")
        before = {t["trade_id"] if "trade_id" in t else None for t in supervisor.session.runner.portfolio.trades}
        self.assertEqual(supervisor.end(), LP.EXIT_OK)
        report = self.read(LP.REPORT_FILE)
        self.assertEqual(report["positions"]["open_at_end"], opened["open_positions"])
        self.assertEqual({t["trade_id"] if "trade_id" in t else None for t in supervisor.session.runner.portfolio.trades}, before)
        self.assertIn("nobody evaluates", report["positions"]["note"])

    def test_a_step_that_fails_halts_the_process_and_a_restart_needs_the_operator(self):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()

        def fault(point, info=None):
            if point == "after_runner" and supervisor.session.stats["steps"] >= 5:
                raise OSError("disk refused the write")
        supervisor.session.fault = fault
        self.assertEqual(supervisor.run(), LP.EXIT_HALTED)
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["phase"], LP.HALTED)
        self.assertIn("disk refused", self.read(LP.REPORT_FILE)["halted"])
        again = self.supervisor(Clock(5))
        with self.assertRaises(LP.ProcessError) as caught:
            again.start()
        self.assertEqual(caught.exception.reason, "restart_requires_operator")
        again.session = None
        restarted = self.supervisor(Clock(5))
        restarted.start(restart=True)
        self.assertEqual(restarted.run(max_steps=3), LP.EXIT_OK)

    def test_a_killed_process_restarts_only_when_asked_and_ends_with_the_same_signals_as_a_continuous_run(self):
        steps = 40
        reference_root = tempfile.mkdtemp(dir=self.cache["dir"])
        reference_world = World(reference_root)
        self.addCleanup(reference_world.close)
        reference_world.release_until(FIRST_DECISION - MIN)
        reference_dir = os.path.join(reference_root, "session")
        continuous = self.supervisor(Clock(), world=reference_world, directory=reference_dir)
        continuous.start()
        continuous.run(max_steps=steps)
        with open(os.path.join(reference_dir, LP.REPORT_FILE), encoding="utf-8") as handle:
            reference = json.load(handle)["digests"]
        clock = Clock()
        first = self.supervisor(clock)
        first.start()
        for _ in range(steps // 2):
            now = clock.now()
            first.tick(now)
            first.session.step(now)
            clock.sleep(0)
        first.abandon()                                                  # the process dies: no stop, no report
        self.assertFalse(os.path.exists(os.path.join(self.directory, LP.REPORT_FILE)))
        self.assertIn(self.read(LP.HEARTBEAT_FILE)["phase"], (LP.WARMUP, LP.LIVE))
        second_clock = Clock(steps // 2 - 1)                             # restarts at the instant of the last step: no downtime to account for
        unasked = self.supervisor(second_clock)
        with self.assertRaises(LP.ProcessError) as caught:                # BAL-DECISION-185-01: a cut is not taken up on its own
            unasked.start()
        self.assertEqual(caught.exception.reason, "restart_requires_operator")
        second = self.supervisor(second_clock)
        second.start(restart=True)
        second_clock.sleep(0)
        second.run(max_steps=steps // 2)
        digests = self.read(LP.REPORT_FILE)["digests"]
        self.assertEqual(digests["signals"], reference["signals"])


class TestAnyCutNeedsTheOperator(Base):
    """BAL-DECISION-185-01: a directory that holds a started session is taken up again only on an explicit request, whatever marks exist."""

    def snapshot(self):
        out = {}
        for name in sorted(os.listdir(self.directory)):
            path = os.path.join(self.directory, name)
            if os.path.isfile(path):
                with open(path, "rb") as handle:
                    out[name] = hashlib.sha256(handle.read()).hexdigest()
        return out

    def killed(self, steps=3):
        clock = Clock()
        first = self.supervisor(clock)
        first.start()
        for _ in range(steps):
            now = clock.now()
            first.tick(now)
            first.session.step(now)
            clock.sleep(0)
        first.abandon()
        return clock

    def refused(self, clock):
        before = self.snapshot()
        again = self.supervisor(clock)
        with self.assertRaises(LP.ProcessError) as caught:
            again.start()
        self.assertEqual(caught.exception.reason, "restart_requires_operator")
        self.assertIsNone(again.session)                      # nothing opened, so no lock taken either
        self.assertEqual(self.snapshot(), before)             # and nothing written, repaired or stepped
        self.assertFalse(os.path.exists(os.path.join(self.directory, LP.HALT_FILE)))

    def test_an_ordinary_kill_with_no_mark_at_all_is_refused_whatever_the_heartbeat_says(self):
        clock = self.killed()
        beat_path = os.path.join(self.directory, LP.HEARTBEAT_FILE)
        with open(beat_path, encoding="utf-8") as handle:
            beat = json.load(handle)
        self.assertEqual(beat["phase"] in (LP.WARMUP, LP.LIVE), True)
        self.refused(clock)                                                       # heartbeat says what it said at the kill
        LP._write_json(beat_path, dict(beat, phase=LP.LIVE))
        self.refused(clock)                                                       # heartbeat says LIVE
        os.remove(beat_path)
        self.refused(clock)                                                       # heartbeat missing
        with open(beat_path, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        self.refused(clock)                                                       # heartbeat unreadable

    def test_a_halt_whose_two_writes_both_failed_leaves_no_mark_and_is_still_refused(self):
        """The double write failure of D-205-09: neither the audit line nor halt.json exists, the heartbeat still says LIVE."""
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        real, halt_path = LP._write_json, os.path.join(self.directory, LP.HALT_FILE)

        def refuse(path, body):
            if path in (halt_path, os.path.join(self.directory, LP.HEARTBEAT_FILE)) and supervisor.phase == LP.HALTED:
                raise OSError(28, "No space left on device")
            return real(path, body)
        original_step = supervisor.session.step
        calls = {"n": 0}

        def failing(now):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("a step that cannot go on")
            return original_step(now)
        supervisor.session.step = failing
        LP._write_json = refuse
        try:
            self.assertEqual(supervisor.run(max_steps=10), LP.EXIT_HALTED)
        finally:
            LP._write_json = real
        self.assertFalse(os.path.exists(halt_path))
        self.assertEqual(self.read_beat()["phase"] in (LP.WARMUP, LP.LIVE), True)    # the heartbeat still says it was alive
        self.refused(clock)

    def read_beat(self):
        with open(os.path.join(self.directory, LP.HEARTBEAT_FILE), encoding="utf-8") as handle:
            return json.load(handle)

    def test_the_request_is_on_record_and_the_checks_still_run(self):
        clock = self.killed()
        other = self.supervisor(clock, max_quote_gap_ms=20_000)                   # identity: another configuration is refused even with --restart
        with self.assertRaises(LP.ProcessError) as caught:
            other.start(restart=True)
        self.assertEqual(caught.exception.reason, "preflight_failed")
        asked = self.supervisor(clock)
        asked.start(restart=True)
        with open(os.path.join(self.directory, LP.RESTARTS_FILE), encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["restarts"], 1)
        locked = self.supervisor(clock)                                           # exclusion of writers: the directory is held now
        with self.assertRaises(LP.ProcessError) as caught:
            locked.start(restart=True)
        self.assertIn("directory_unlocked", str(caught.exception))

    def test_an_orderly_stop_is_still_terminal_even_with_the_restart_request_and_without_a_heartbeat(self):
        supervisor = self.supervisor(Clock())
        supervisor.start()
        supervisor.run(max_steps=3)
        os.remove(os.path.join(self.directory, LP.HEARTBEAT_FILE))                 # the report still says STOPPED
        again = self.supervisor(Clock(4))
        with self.assertRaises(LP.ProcessError) as caught:
            again.start(restart=True)
        self.assertEqual(caught.exception.reason, "session_stopped")

    def test_the_command_line_refuses_a_cut_directory_without_the_flag(self):
        self.killed()
        config = os.path.join(self.root, "config.json")
        with open(config, "w", encoding="utf-8") as handle:
            json.dump(config_dict(), handle)
        cmd = [sys.executable, "-m", "balancita_engine.paper_live_process", "run", "--config", config, "--directory", self.directory,
               "--source", self.world.path, "--clock-from-ms", str(TIMES[START])]
        env = dict(os.environ, PYTHONPATH=ENGINE_PATH + os.pathsep + HERE)
        done = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=300)
        self.assertEqual(done.returncode, LP.EXIT_REFUSED, done.stderr)
        self.assertIn("restart_requires_operator", done.stdout + done.stderr)


class TestCommandLine(Base):
    def run_cli(self, *args, **kw):
        env = dict(os.environ, PYTHONPATH=ENGINE_PATH + os.pathsep + HERE)
        return subprocess.run([sys.executable, "-m", "balancita_engine.paper_live_process"] + list(args), env=env, capture_output=True,
                              text=True, timeout=600, **kw)

    def files(self):
        config = os.path.join(self.root, "config.json")
        with open(config, "w", encoding="utf-8") as handle:
            json.dump(config_dict(), handle)
        return config

    def test_the_wall_clock_and_a_real_source_are_refused_with_exit_status_2_and_nothing_written(self):
        config = self.files()
        done = self.run_cli("run", "--config", config, "--directory", self.directory, "--source", self.world.path, "--wall-clock")
        self.assertEqual(done.returncode, LP.EXIT_REFUSED)
        self.assertIn("wall_clock_not_authorized", done.stderr)
        real = os.path.join(self.root, "real.json")
        with open(real, "w", encoding="utf-8") as handle:
            json.dump(config_dict(source_id="kraken-live"), handle)
        done = self.run_cli("run", "--config", real, "--directory", self.directory, "--source", self.world.path,
                            "--clock-from-ms", str(TIMES[0]))
        self.assertEqual(done.returncode, LP.EXIT_REFUSED)
        self.assertIn("real_session_not_authorized", done.stderr)
        self.assertFalse(os.path.exists(self.directory))

    def test_preflight_by_command_line(self):
        done = self.run_cli("preflight", "--config", self.files(), "--directory", self.directory, "--source", self.world.path)
        self.assertEqual(done.returncode, LP.EXIT_OK, done.stderr)
        self.assertTrue(json.loads(done.stdout)["ok"])

    def test_a_real_sigterm_ends_the_process_in_order(self):
        self.world.release_until(TIMES[-1])                               # the whole invented source is there: the child reads a file
        args = ["run", "--config", self.files(), "--directory", self.directory, "--source", self.world.path,
                "--clock-from-ms", str(TIMES[0]), "--clock-step-ms", "600000", "--step-sleep-s", "0.3"]
        env = dict(os.environ, PYTHONPATH=ENGINE_PATH + os.pathsep + HERE)
        child = subprocess.Popen([sys.executable, "-m", "balancita_engine.paper_live_process"] + args, env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            beat_path = os.path.join(self.directory, LP.HEARTBEAT_FILE)
            deadline = time.time() + 300
            while time.time() < deadline and child.poll() is None:
                try:
                    with open(beat_path, encoding="utf-8") as handle:
                        if json.load(handle)["steps"] >= 3:
                            break
                except (OSError, ValueError, KeyError):
                    pass
                time.sleep(0.2)
            self.assertIsNone(child.poll(), "the child is still running when the signal is sent")
            child.send_signal(signal.SIGTERM)
            out, err = child.communicate(timeout=300)
        finally:
            if child.poll() is None:
                child.kill()
        self.assertEqual(child.returncode, LP.EXIT_OK, err)
        report = self.read(LP.REPORT_FILE)
        self.assertEqual((report["ended_as"], report["stop_signal"]), (LP.STOPPED_PHASE, int(signal.SIGTERM)))
        self.assertGreaterEqual(report["steps"], 3)
        self.assertEqual(self.read(LP.HEARTBEAT_FILE)["phase"], LP.STOPPED_PHASE)
        again = self.run_cli("run", "--config", self.files(), "--directory", self.directory, "--source", self.world.path,
                             "--clock-from-ms", str(TIMES[10]))
        self.assertEqual(again.returncode, LP.EXIT_REFUSED)
        self.assertIn("session_stopped", again.stderr)


class TestObservedLifecycle(unittest.TestCase):
    """D-205-01..05: the halt is durable and does not depend on the heartbeat, a failing disk is a halt, the report of a halted process
    carries the funding evidence, and the gates hold. The accounting funding is the observed one (#184) so a divergence can be made."""

    def setUp(self):
        SC.disarm()
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.world = new_world(self.root, observed=True)
        self.addCleanup(self.world.close)
        hourly_responses(self.world, FIRST_HOUR, ((TIMES[-1] - LAG) // HOUR - 1) * HOUR)
        self.world.release_until(FIRST_DECISION - MIN)
        self.directory = os.path.join(self.root, "session")
        self.strategies = RS.load_frozen()[0]
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

    def halted_run(self):
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        self.diverge_at(supervisor, 4)
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
        import sqlite3
        db = sqlite3.connect(real)
        db.execute("DROP TABLE balancita_synthetic_fixture")
        db.commit()
        db.close()
        config = LP.validate_config(config_dict(funding_mode="observed"))
        self.assertEqual(config["source_id"], "synthetic")
        report = LP.preflight(config, self.directory, real, strategies=self.strategies)
        self.assertEqual([c["name"] for c in report["checks"] if not c["ok"]], ["synthetic_marker"])
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
        done = subprocess.run([sys.executable, "-m", "balancita_engine.paper_live_process", "run", "--config", config_path,
                               "--directory", os.path.join(blocker, "inside"), "--source", self.world.path,
                               "--clock-from-ms", str(TIMES[START])], env=dict(os.environ, PYTHONPATH=ENGINE_PATH + os.pathsep + HERE),
                              capture_output=True, text=True, timeout=300)
        self.assertEqual(done.returncode, LP.EXIT_REFUSED, done.stderr)
        self.assertNotIn("Traceback", done.stderr)


if __name__ == "__main__":
    unittest.main()
