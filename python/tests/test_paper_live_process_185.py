"""Issue #185: the life of a paper session as a process (configuration, pre-flight, warm-up, orderly stop, restart). The market is the real
one (``real_session``: BTC candles and quotes of the 17-18 Oct 2026 sample, one hand-written purchase of C29); the clock is simulated and the
sleep does nothing, except in the one test that sends a real SIGTERM to a child process. The observed-funding half is in
``test_paper_live_observed_lifecycle_185``."""

import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from balancita_engine import paper_live_process as LP
from real_session import DECIDE_FROM, DECIDE_UNTIL, STEP, Base, Clock, config_dict
from real_world import BTC, HOUR, MIN, T0, RealWorld

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE_PATH = os.path.dirname(HERE)
RUN_STEPS = 12                                   # the evaluator is live from the step 7 on (the real history is read 5000 rows a step)


class TestConfiguration(unittest.TestCase):
    def test_the_capital_label_follows_the_portfolio_the_runner_really_uses(self):
        portfolio = LP.runner_config_of(LP.validate_config(config_dict())).portfolio
        self.assertEqual(LP.CAPITAL_POLICY, LP.capital_policy_label(portfolio))
        self.assertEqual(LP.CAPITAL_POLICY, "shared-portfolio-1000-usd-notional-100usd-experimental")
        self.assertEqual((portfolio.sizing_mode, portfolio.notional_per_trade_usd), ("fixed_notional", "100"))
        other = type(portfolio)(initial_equity_usd="2500", risk_per_trade="0.005")
        self.assertEqual(LP.capital_policy_label(other), "shared-portfolio-2500-usd-risk-0.5pct-experimental")

    def test_the_operation_size_is_one_easy_setting_that_changes_the_identity_of_a_new_session(self):
        """BAL-DECISION-185-DIMENSIONAMIENTO-03: 100 USD is the provisional default; another value is another configuration (other digest, other label)."""
        base, other = LP.validate_config(config_dict()), LP.validate_config(config_dict(notional_per_trade_usd="150"))
        self.assertEqual(other["capital_policy"], "shared-portfolio-1000-usd-notional-150usd-experimental")
        self.assertNotEqual(base["digest"], other["digest"])
        self.assertEqual(LP.runner_config_of(other).portfolio.notional_per_trade_usd, "150")
        self.assertEqual(LP.runner_config_of(base).portfolio.notional_per_trade_usd, "100")
        for bad in ("5", "abc", "NaN", "100.123", 100, None, ""):
            with self.subTest(bad=bad), self.assertRaises(LP.ProcessError):
                LP.validate_config(config_dict(notional_per_trade_usd=bad))
        with self.assertRaises(LP.ProcessError):          # a label written by hand cannot disagree with the size
            LP.validate_config(config_dict(notional_per_trade_usd="150", capital_policy=LP.CAPITAL_POLICY))

    def test_a_valid_configuration_has_a_stable_digest_and_the_defaults_are_filled(self):
        a, b = LP.validate_config(config_dict()), LP.validate_config(dict(reversed(list(config_dict().items()))))
        self.assertEqual(a["digest"], b["digest"])
        self.assertEqual(a["capital_policy"], LP.CAPITAL_POLICY)
        self.assertEqual(a["on_funding_divergence"], "halt")
        self.assertNotEqual(LP.validate_config(config_dict(max_quote_gap_ms=20_000))["digest"], a["digest"])

    def test_the_sources_of_a_session_are_always_chosen_and_never_implied(self):
        """#184: the accounting source and the market source are chosen, not defaults. A configuration without ``funding_mode`` or
        without ``source_id`` is refused (both used to fall back to a fixture); the only funding mode is ``observed``, and the former
        ``synthetic`` one no longer exists."""
        for key in ("funding_mode", "source_id"):
            body = config_dict()
            del body[key]
            with self.assertRaises(LP.ProcessError) as caught:
                LP.validate_config(body)
            self.assertEqual(caught.exception.reason, "config_invalid")
            self.assertIn(key, str(caught.exception))
        with self.assertRaises(LP.ProcessError) as caught:
            LP.validate_config(config_dict(funding_mode="synthetic"))
        self.assertEqual(caught.exception.reason, "config_invalid")

    def test_what_is_wrong_is_refused_with_a_reason_and_nothing_is_guessed(self):
        for over in ({"products": []}, {"products": ["BTC-EUR"]}, {"products": [BTC, BTC]}, {"decide_from_ms": "x"},
                     {"decide_until_ms": DECIDE_FROM}, {"funding_mode": "real"}, {"on_funding_divergence": "ignore"}, {"on_funding_divergence": "alert"},
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
        self.assertEqual({c["name"] for c in report["checks"]} >= {"real_session_authorized", "disk_free", "source_readable", "warmup_" + BTC}, True)
        self.assertFalse(os.path.exists(self.directory))

    def test_a_source_without_the_warmup_is_refused_before_anything_is_created(self):
        config = LP.validate_config(config_dict(decide_from_ms=T0 + HOUR))
        report = LP.preflight(config, self.directory, self.world.path, strategies=self.cache["strategies"])
        self.assertFalse(report["ok"])
        self.assertEqual([c["name"] for c in report["checks"] if not c["ok"]], ["warmup_" + BTC])
        with self.assertRaises(LP.ProcessError) as caught:
            self.supervisor(Clock(), decide_from_ms=T0 + HOUR).start()
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

    def test_a_configuration_with_the_old_capital_label_is_refused_and_says_what_the_label_is(self):
        """BAL-REV-185-CAP-02: the message names the real label (not 'the sizing is the ADR's') and an older label is refused, not migrated."""
        for label in ("adr-0001-fixed-100-usd", "kelly", ""):
            with self.subTest(label=label), self.assertRaises(LP.ProcessError) as caught:
                LP.validate_config(config_dict(capital_policy=label))
            self.assertEqual(caught.exception.reason, "config_invalid")
            self.assertIn(LP.CAPITAL_POLICY, str(caught.exception))
            self.assertIn("refused, not migrated", str(caught.exception))
            self.assertNotIn("the sizing is the ADR's", str(caught.exception))

    def test_a_directory_made_with_the_old_capital_label_is_refused_untouched_with_or_without_restart(self):
        """The label is part of the digest, so a directory created before the fix has another digest: nothing resumes it, nothing migrates,
        repairs or deletes it, and every byte of its evidence stays as it was."""
        first = self.supervisor(Clock())
        first.start()
        first.abandon()
        stored = LP._read_json(os.path.join(self.directory, LP.CONFIG_FILE))
        old = {k: v for k, v in stored.items() if k != "digest"}
        old["capital_policy"] = "adr-0001-fixed-100-usd"
        old["digest"] = LP.stable_hash({k: v for k, v in old.items() if k != "authorization_ref"})[:20]
        self.assertNotEqual(old["digest"], stored["digest"])
        LP._write_json(os.path.join(self.directory, LP.CONFIG_FILE), old)

        def snapshot():
            seen = {}
            for base, _, names in os.walk(self.directory):
                for name in names:
                    path = os.path.join(base, name)
                    with open(path, "rb") as handle:
                        seen[os.path.relpath(path, self.directory)] = hashlib.sha256(handle.read()).hexdigest()
            return seen

        before = snapshot()
        for restart in (False, True):
            with self.subTest(restart=restart):
                again = self.supervisor(Clock(5))
                with self.assertRaises(LP.ProcessError) as caught:
                    again.start(restart=restart)
                self.assertEqual(caught.exception.reason, "preflight_failed")
                self.assertIn("configuration_matches_directory", str(caught.exception))
                self.assertIsNone(again.session)
                self.assertEqual(snapshot(), before)

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
        self.assertEqual(supervisor.run(max_steps=RUN_STEPS), LP.EXIT_OK)
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
        for _ in range(40):                                     # the forced entry of C29 comes at step 7
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
        reference_world = RealWorld(reference_root)
        self.addCleanup(reference_world.close)
        reference_world.release_until(DECIDE_FROM - MIN)
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
        cmd = [sys.executable, os.path.join(HERE, "cli_with_synthetic_source.py"), "run", "--config", config, "--directory", self.directory,
               "--source", self.world.path, "--clock-from-ms", str(DECIDE_FROM)]
        env = dict(os.environ, PYTHONPATH=ENGINE_PATH + os.pathsep + HERE)
        done = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=300)
        self.assertEqual(done.returncode, LP.EXIT_REFUSED, done.stderr)
        self.assertIn("restart_requires_operator", done.stdout + done.stderr)


class TestCommandLine(Base):
    def run_cli(self, *args, **kw):
        env = dict(os.environ, PYTHONPATH=ENGINE_PATH + os.pathsep + HERE)
        return subprocess.run([sys.executable, os.path.join(HERE, "cli_with_synthetic_source.py")] + list(args), env=env, capture_output=True,
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
        self.assertIn("config_invalid", done.stderr)                                  # the gate is open since BAL-DECISION-184-07, but a wall clock needs clock_guard
        real = os.path.join(self.root, "real.json")
        with open(real, "w", encoding="utf-8") as handle:
            json.dump(config_dict(source_id="kraken-live"), handle)
        done = self.run_cli("run", "--config", real, "--directory", self.directory, "--source", self.world.path,
                            "--clock-from-ms", str(DECIDE_FROM))
        self.assertEqual(done.returncode, LP.EXIT_REFUSED)
        self.assertIn("real_session_not_authorized", done.stderr)
        self.assertFalse(os.path.exists(self.directory))

    def test_preflight_by_command_line(self):
        done = self.run_cli("preflight", "--config", self.files(), "--directory", self.directory, "--source", self.world.path)
        self.assertEqual(done.returncode, LP.EXIT_OK, done.stderr)
        self.assertTrue(json.loads(done.stdout)["ok"])

    def test_a_real_sigterm_ends_the_process_in_order(self):
        self.world.release_until(DECIDE_UNTIL)                            # the whole real source is there: the child reads a file
        args = ["run", "--config", self.files(), "--directory", self.directory, "--source", self.world.path,
                "--clock-from-ms", str(DECIDE_FROM), "--clock-step-ms", str(STEP), "--step-sleep-s", "0.3"]
        env = dict(os.environ, PYTHONPATH=ENGINE_PATH + os.pathsep + HERE)
        child = subprocess.Popen([sys.executable, os.path.join(HERE, "cli_with_synthetic_source.py")] + args, env=env,
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
                             "--clock-from-ms", str(DECIDE_FROM + 10 * STEP))
        self.assertEqual(again.returncode, LP.EXIT_REFUSED)
        self.assertIn("session_stopped", again.stderr)


if __name__ == "__main__":
    unittest.main()
