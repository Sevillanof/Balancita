"""Stage 10D on the real market: the whole circuit (SQLite -> SourceReader -> Ingestor -> LiveEvaluator -> PaperRunner -> Portfolio ->
journals -> recovery) run on the real PF_XBTUSD sample of ``real_world`` (17-oct 12:40Z on: official candles, WebSocket tickers and the
20 hourly funding responses, each row at the time it really arrived). The entries are the two ``Forcing`` makes (``real_session``); the
market, the fills, the stops and the funding are Kraken's. No row is invented.

One continuous run, a second run recovered from a warm-up snapshot, and from snapshots just before the entry, the exit and the first
funding the same step is repeated with the process dying at every boundary of the step. Whatever the death, every step after the restart
must equal the continuous run."""

import json
import os
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from decimal import Decimal

from balancita_engine import paper_live_evaluator as LE
from balancita_engine import paper_live_ingest as ING
from balancita_engine import paper_live_integration as LI
from balancita_engine import signal_continuity as SC
from balancita_engine.multi_signals import stable_hash

import real_session as RSN
from real_session import (BUY_AT, DECIDE_FROM, DECIDE_UNTIL, INGEST_KW, STEP, abandon, journal_clock, new_session, record, recover_session,
                          runner_config, strategies)
from real_world import BTC, MIN, RealWorld

D = Decimal
DOWNTIME_MS = 5 * MIN
END = RSN.T0 + 600 * MIN                                 # after the second forced position has been stopped out (19:40Z entry, 22:25Z stop)
TIMES = [DECIDE_FROM + i * STEP for i in range(0, (END - DECIDE_FROM) // STEP + 1)]
FORCED = (BUY_AT[1],)                                    # one forced entry (19:40Z), stopped out by the real fall at 22:25Z: it holds three funding hours
PREFIX_INDEX = 14                                        # 70 minutes in: the real history (read 5000 rows a step) has been caught up and the entry (index 31) is still ahead


def circuit_strategies():
    return strategies(FORCED)


class Circuit(unittest.TestCase):
    """One continuous reference run, a second run from the warm-up snapshot (with snapshots before each instant), shared."""

    cache = {}
    ingest_kw = INGEST_KW

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        if "dir" in cls.cache:
            return
        started, rss0 = time.time(), resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        cache = cls.cache
        cache["dir"] = root = tempfile.mkdtemp()
        cache["strategies"] = circuit_strategies()
        world = RealWorld(root, with_funding=True)
        cache["world"] = world
        world.release_until(DECIDE_FROM - MIN)
        session = new_session(world, os.path.join(root, "a"), cache["strategies"], cls.ingest_kw)
        timeline, prefix = [], None
        for index, now in enumerate(TIMES):
            world.release_until(now)
            session.step(now)
            timeline.append(record(session, now))
            if index == PREFIX_INDEX:
                prefix = cls.take_snapshot(root, "prefix", session, world, index + 1)
        cache.update(timeline=timeline, prefix=prefix, a=session, rss_mb=None)
        cache["a_seconds"] = time.time() - started
        # the instants in the continuous run
        first = lambda predicate: next((i for i, r in enumerate(timeline) if predicate(r)), None)       # noqa: E731
        instants = {"open": first(lambda r: r["open"] > 0), "close": first(lambda r: r["closed"] > 0),
                    "funding": first(lambda r: r["funding_adjustments"] > 0)}
        cache["instants"] = instants
        # run B: from the warm-up snapshot (a recovery), with snapshots just before each instant
        fork_dir = os.path.join(root, "b-world")
        os.makedirs(fork_dir)
        world_b = world.fork(fork_dir, prefix["world"])
        shutil.copytree(prefix["session"], os.path.join(root, "b"))
        session_b = recover_session(world_b, os.path.join(root, "b"), cache["strategies"], journal_clock(os.path.join(root, "b")), cls.ingest_kw)
        wanted = {}                                      # snapshot one step before each instant, so the step itself can be killed
        for name, i in instants.items():
            wanted.setdefault(max(i - 1, PREFIX_INDEX + 1), []).append(name)
        timeline_b, snaps = [], {}
        for index in range(PREFIX_INDEX + 1, len(TIMES)):
            for name in wanted.get(index, ()):
                snaps[name] = prefix if index == PREFIX_INDEX + 1 else cls.take_snapshot(root, "pre-" + name, session_b, world_b, index)
            world_b.release_until(TIMES[index])
            session_b.step(TIMES[index])
            timeline_b.append(record(session_b, TIMES[index]))
        cache.update(timeline_b=timeline_b, snaps=snaps, b=session_b, world_b=world_b)
        cache["rss_mb"] = (resource.getrusage(resource.RUSAGE_SELF).ru_maxrss - rss0) / (1024 * 1024 if os.uname().sysname == "Darwin" else 1024)
        cache["seconds"] = time.time() - started

    @classmethod
    def take_snapshot(cls, root, name, session, world, next_index):
        target = os.path.join(root, "snap-" + name)
        os.makedirs(target)
        shutil.copytree(session.directory, os.path.join(target, "session"))
        return {"session": os.path.join(target, "session"), "world": world.snapshot(target), "index": next_index}

    # ---- helpers ------------------------------------------------------------------------------------------
    @property
    def strategies(self):
        return self.cache["strategies"]

    @property
    def timeline(self):
        return self.cache["timeline"]

    def scratch(self):
        path = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, path, True)
        return path

    def scenario(self, instant, point=None, *, occurrence=1, predicate=None, downtime=0, steps_after=4, compare=True):
        """Forks the world just before ``instant``, kills the 'process' at ``point`` (the ``occurrence``-th time ``predicate``
        accepts it), restarts it from the directory and keeps stepping. Returns the per-step records and the session."""
        snap = self.cache["snaps"][instant]
        root = self.scratch()
        world = self.cache["world"].fork(root, snap["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(snap["session"], directory)
        session = recover_session(world, directory, self.strategies, journal_clock(directory), self.ingest_kw)
        counter, fired, records = {"n": 0}, {"done": False}, []

        def arm(session):
            def fault(name, info=None):
                if fired["done"] or point is None or name != point:
                    return
                if predicate is not None and not predicate(session, info):
                    return
                counter["n"] += 1
                if counter["n"] >= occurrence:
                    fired["done"] = True
                    raise LI.FaultInjected(name)
            session.fault = fault
        arm(session)
        for index in range(snap["index"], min(snap["index"] + 1 + steps_after, len(TIMES))):
            now = TIMES[index]
            world.release_until(now)
            try:
                session.step(now)
            except LI.FaultInjected:
                abandon(session)
                session = recover_session(world, directory, self.strategies, journal_clock(directory) + downtime, self.ingest_kw)
                arm(session)
                session.step(now)
            records.append(record(session, now))
            if compare:
                self.assertEqual(records[-1], self.timeline[index], "step {} differs from the continuous run".format(index))
        self.addCleanup(abandon, session)
        if point is not None:
            self.assertTrue(fired["done"], "the fault at {} never fired".format(point))
        return records, session




# ------------------------------------------------------------------------------------------------ 1. the financial circuit
class TestFinancialCircuit(Circuit):
    def test_the_session_covers_entry_fill_exit_fees_and_funding_accounting(self):
        last = self.timeline[-1]
        snapshot = self.cache["a"].runner.portfolio.snapshot()
        self.assertGreaterEqual(snapshot["closed_trades"], 1)                   # at least one entry, fill and exit
        self.assertGreaterEqual(len([o for o in self.cache["a"].runner.orders() if o["state"] == "opened"]), 1)
        self.assertGreater(D(snapshot["fees_usd"]), 0)                          # commissions
        self.assertGreater(last["funding_adjustments"], 0)                      # the funding of Kraken's responses was applied
        self.assertNotEqual(D(snapshot["funding_usd"]), 0)
        self.assertEqual(self.cache["a"].runner.integrity()["open_funding"], [])        # no funding obligation left over
        self.assertEqual(self.cache["a"].runner.integrity()["open_cycles"], [])

    def test_the_instants_exist_in_the_continuous_run(self):
        self.assertTrue(all(v is not None for v in self.cache["instants"].values()), self.cache["instants"])

    def test_a_second_run_from_the_warm_up_snapshot_reaches_the_same_state_at_every_step(self):
        rest = self.timeline[PREFIX_INDEX + 1:]
        self.assertEqual(self.cache["timeline_b"], rest)


    def test_the_funding_hours_the_runner_applied_are_hours_kraken_sent(self):
        session = self.cache["a"]
        applied = [e["data"]["event"]["payload"]["periods"][0] for e in session.runner.journal.entries
                   if e["kind"] == "event_accepted" and e["data"]["event"]["kind"] == "funding"]
        real = {(p["start_ms"], p["end_ms"]) for row in self.cache["world"].funding_rows for p in row["periods"]}
        self.assertTrue(applied)
        self.assertTrue(all((a[0], a[1]) in real for a in applied), applied)               # the rate is Kraken's, made relative by the adapter

    def test_the_memory_of_the_session_is_bounded(self):
        a = self.cache["a"]
        self.assertLess(self.cache["rss_mb"], 1500)
        self.assertEqual(a.evaluator.report()["memory"]["pending_frames"], len(a.evaluator.frames))


# ------------------------------------------------------------------------------------------------ 2. process faults
class TestFaultsAtEveryBoundary(Circuit):
    """The same input must give the same signals, orders, fills, trades, result and accounting after a death at each boundary.
    ``scenario`` compares every step after the restart with the continuous run (financial digest, signal digest, order digest,
    portfolio snapshot, fees, funding, pending orders)."""

    def run_boundary(self, point, instant, **kw):
        records, session = self.scenario(instant, point, **kw)
        ref = self.timeline[self.cache["snaps"][instant]["index"]:][:len(records)]
        self.assertEqual(records, ref)
        runner = session.runner
        self.assertEqual(runner.integrity()["open_funding"], [])                          # no funding obligation was lost
        self.assertEqual(runner.integrity()["open_cycles"], [])
        return session

    def test_every_boundary_at_the_entry(self):
        for point in LI.POINTS:
            with self.subTest(point=point):
                self.run_boundary(point, "open")

    def test_the_candle_boundaries_at_the_exit_and_the_funding_application(self):
        for instant in ("close", "funding"):
            for point in ("input_logged", "after_evaluation", "after_runner", "after_audit", "checkpoint_tmp_written"):
                with self.subTest(instant=instant, point=point):
                    self.run_boundary(point, instant)

    def test_a_death_on_the_last_candle_of_a_step_loses_no_cycle_and_makes_none_twice(self):
        for point in ("input_logged", "after_evaluation"):
            with self.subTest(point=point):
                self.run_boundary(point, "open", occurrence=5)

    def test_a_death_just_before_the_funding_event_is_handled_applies_it_once(self):
        def funding_event(session, event):
            return event is not None and event["kind"] == "funding"
        session = self.run_boundary("before_handle", "funding", predicate=funding_event)
        self.assertEqual(session.runner.stats.get("funding_adjustments"), self.timeline[self.cache["instants"]["funding"] + 3]["funding_adjustments"])

    def test_a_death_with_an_order_pending_and_no_downtime_leaves_the_order_alone(self):
        def pending_quote(session, event):
            return event is not None and event["kind"] == "quote" and len(session.runner.executor.pending) > 0
        session = self.run_boundary("before_handle", "open", predicate=pending_quote, steps_after=6)
        self.assertEqual([o for o in session.runner.orders() if o["state"] == "cancelled"], [])

    def test_a_death_with_an_order_pending_and_a_downtime_cancels_it_and_says_so(self):
        """Documented deviation, not a failure: the runner's own policy cancels an order whose window the downtime overlapped
        (``runner_interrupted``). The result differs from the continuous run exactly by that order."""
        def pending_quote(session, event):
            return event is not None and event["kind"] == "quote" and len(session.runner.executor.pending) > 0
        records, session = self.scenario("open", "before_handle", predicate=pending_quote, downtime=DOWNTIME_MS, steps_after=6,
                                         compare=False)
        cancelled = [o for o in session.runner.orders() if o["state"] == "cancelled"]
        self.assertEqual(len(cancelled), 1)
        self.assertIn("runner_interrupted", cancelled[0]["reasons"])
        self.assertNotEqual(records[-1]["financial"], self.timeline[self.cache["snaps"]["open"]["index"] + len(records) - 1]["financial"])

    def test_two_deaths_in_a_row_still_converge(self):
        snap = self.cache["snaps"]["open"]
        root = self.scratch()
        world = self.cache["world"].fork(root, snap["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(snap["session"], directory)
        session = recover_session(world, directory, self.strategies, journal_clock(directory), self.ingest_kw)
        deaths = iter(("after_evaluation", "checkpoint_tmp_written", None))
        point = next(deaths)

        def arm(session, point):
            hit = {"done": False}

            def fault(name, info=None):
                if point is not None and name == point and not hit["done"]:
                    hit["done"] = True
                    raise LI.FaultInjected(name)
            session.fault = fault
        arm(session, point)
        for index in range(snap["index"], snap["index"] + 5):
            now = TIMES[index]
            world.release_until(now)
            while True:
                try:
                    session.step(now)
                    break
                except LI.FaultInjected:
                    abandon(session)
                    session = recover_session(world, directory, self.strategies, journal_clock(directory), self.ingest_kw)
                    point = next(deaths, None)
                    arm(session, point)
            self.assertEqual(record(session, now), self.timeline[index])
        self.addCleanup(abandon, session)

    def test_the_full_decision_day_with_a_death_at_the_entry_equals_the_continuous_result(self):
        """The headline comparison: continuous run vs a run that dies and recovers, to the end of the world."""
        records, session = self.scenario("open", "after_runner", steps_after=len(TIMES), compare=False)
        self.assertEqual(records[-1], self.timeline[-1])
        self.assertEqual(session.digests(), self.cache["a"].digests())
        self.assertEqual(session.runner.portfolio.snapshot(), self.cache["a"].runner.portfolio.snapshot())


# ------------------------------------------------------------------------------------------------ 3. one session, three journals
class ClockCircuit(Circuit):
    """The same circuit with the ingestor's clock events at their normal cadence (every 5 s of source time), which the other
    classes switch off to compare with an independent reference that has none."""

    cache = {}
    ingest_kw = {}

    def kill_scenario(self, point, instant="open", *, occurrence=1, steps_after=4):
        """A real process is killed with SIGKILL at ``point`` during the step of ``instant``; this process then recovers the
        directory and keeps stepping. Every step is compared with the continuous run."""
        snap = self.cache["snaps"][instant]
        root = self.scratch()
        world = self.cache["world"].fork(root, snap["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(snap["session"], directory)
        index = snap["index"]
        world.release_until(TIMES[index])
        env = dict(os.environ, PYTHONPATH=os.pathsep.join((os.path.dirname(os.path.dirname(os.path.abspath(LI.__file__))),
                                                           os.path.dirname(os.path.abspath(__file__)))))
        done = subprocess.run([sys.executable, "-W", "ignore", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                                           "live_kill_worker.py"),
                               directory, world.path, str(journal_clock(directory)), point, str(occurrence), str(index),
                               "clock" if self.ingest_kw == {} else "plain"],
                              env=env, capture_output=True, text=True, timeout=600)
        self.assertEqual(done.returncode, -signal.SIGKILL, "the boundary {} was not crossed\n{}".format(point, done.stderr[-2000:]))
        session = recover_session(world, directory, self.strategies, journal_clock(directory), self.ingest_kw)
        self.addCleanup(abandon, session)
        for step in range(index, min(index + 1 + steps_after, len(TIMES))):
            now = TIMES[step]
            world.release_until(now)
            session.step(now)
            self.assertEqual(record(session, now), self.timeline[step], "step {} differs from the continuous run".format(step))
        self.assertEqual(session.runner.integrity()["open_funding"], [])
        self.assertEqual(session.runner.integrity()["open_cycles"], [])
        return session


class TestClockAtItsNormalCadence(ClockCircuit):
    def test_the_clock_events_reach_the_runner_at_the_normal_cadence(self):
        a = self.cache["a"]
        self.assertGreater(a.stats["clock_events"], 3_000)                      # 5 s ticks of the source time, not a handful
        self.assertEqual(a.ingestor.clock_every_ms, ING.DEFAULT_CLOCK_EVERY_MS)
        self.assertEqual(a.runner.integrity()["open_cycles"], [])

    def test_the_continuous_run_with_the_clock_is_deterministic(self):
        """Run B reached every step through a recovery from a snapshot: same records as the continuous run."""
        self.assertEqual(self.cache["timeline_b"], self.timeline[PREFIX_INDEX + 1:])
        self.assertEqual(self.cache["b"].digests(), self.cache["a"].digests())

    def test_every_boundary_at_the_entry_with_the_clock_running(self):
        for point in LI.POINTS:
            with self.subTest(point=point):
                records, session = self.scenario("open", point)
                self.assertEqual(session.runner.integrity()["open_cycles"], [])

    def test_a_death_between_two_clock_events_neither_repeats_nor_skips_a_tick(self):
        def clock_event(session, event):
            return event is not None and event["kind"] == "clock"
        self.scenario("open", "before_handle", predicate=clock_event, occurrence=3, steps_after=6)       # compares every step


class TestRealProcessTermination(ClockCircuit):
    """The same boundaries as the injected faults, but the process really dies (SIGKILL, no unwinding) with the clock at its
    normal cadence, and a different process recovers from what is on disk."""

    def test_a_killed_process_is_recovered_at_every_boundary(self):
        for point in LI.POINTS:
            with self.subTest(point=point):
                self.kill_scenario(point)

    def test_a_process_killed_in_the_middle_of_a_step_of_candles_is_recovered(self):
        for point in ("input_logged", "after_evaluation"):
            with self.subTest(point=point):
                self.kill_scenario(point, occurrence=5)




class AuditAlternative(object):
    @staticmethod
    def build(text):
        """The same audit journal with a different header content (a valid chain that is not the one the checkpoint saw)."""
        lines = text.rstrip("\n").split("\n")
        header = json.loads(lines[0])
        body = {"seq": 1, "kind": "header", "data": dict(header["data"], note="rewritten"), "prev": LI.GENESIS}
        header = dict(body, hash=stable_hash(body))
        out, prev = [json.dumps(header, sort_keys=True)], header["hash"]
        for line in lines[1:]:
            entry = json.loads(line)
            body = {"seq": entry["seq"], "kind": entry["kind"], "data": entry["data"], "prev": prev}
            entry = dict(body, hash=stable_hash(body))
            out.append(json.dumps(entry, sort_keys=True))
            prev = entry["hash"]
        return "\n".join(out) + "\n"


class TestSessionIdentityAndCheckpoints(Circuit):
    def fork_prefix(self):
        snap = self.cache["prefix"]
        root = self.scratch()
        world = self.cache["world"].fork(root, snap["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(snap["session"], directory)
        return root, world, directory

    def refuses(self, world, directory, reason, **kw):
        with self.assertRaises(LI.IntegrationError) as bad:
            session = recover_session(world, directory, self.strategies, journal_clock(directory), **kw)
            abandon(session)
        self.assertEqual(bad.exception.reason, reason)
        return bad.exception

    def test_the_parts_of_a_session_are_bound_by_one_identity(self):
        identity = self.cache["a"].identity
        self.assertEqual(identity["evaluator_config_digest"], self.cache["a"].evaluator.config_digest)
        self.assertEqual(identity["runner_start_hash"], self.cache["a"].runner.journal.entries[0]["hash"])
        self.assertEqual(self.cache["a"].audit.entries[0]["data"]["session_id"], identity["session_id"])
        checkpoint = LI._read_checkpoint(os.path.join(self.cache["a"].directory, LI.CHECKPOINT_FILE))
        self.assertEqual(checkpoint["session_id"], identity["session_id"])
        self.assertEqual(checkpoint["runner"]["seq"], len(self.cache["a"].runner.journal.entries))      # saved after the last step

    def test_recovering_with_other_bounds_or_another_source_is_refused_explicitly(self):
        _root, world, directory = self.fork_prefix()
        error = self.refuses(world, directory, "evaluator_config_incompatible", evaluator_kw={"max_pending_frames": 7})
        self.assertIn("bounds", str(error))
        error = self.refuses(world, directory, "evaluator_config_incompatible", evaluator_kw={"retain_cycles": 11})
        self.assertIn("bounds", str(error))
        self.refuses(world, directory, "session_mismatch", source_id="another-capture")
        self.refuses(world, directory, "session_mismatch", max_quote_gap_ms=1_000)

    def test_another_ingestor_configuration_is_refused(self):
        _root, world, directory = self.fork_prefix()
        with self.assertRaises(LI.IntegrationError) as bad:
            LI.LiveSession.recover(directory, world.path, self.strategies, (BTC,), runner_config(), journal_clock(directory),
                                   decide_from_ms=DECIDE_FROM, source_id="synthetic", funding_mode="observed", decide_until_ms=DECIDE_UNTIL,
                                   ingest_kw=dict(INGEST_KW, hold_ms=5_000))
        self.assertEqual(bad.exception.reason, "session_mismatch")

    def test_a_checkpoint_of_another_session_is_refused(self):
        _root, world, directory = self.fork_prefix()
        foreign = os.path.join(self.cache["a"].directory, LI.CHECKPOINT_FILE)
        shutil.copyfile(foreign, os.path.join(directory, LI.CHECKPOINT_FILE))                # same session id, later journals
        self.refuses(world, directory, "checkpoint_ahead_of_runner")
        body = LI._read_checkpoint(os.path.join(directory, LI.CHECKPOINT_FILE))
        body["session_id"] = "0" * 20
        LI._atomic_write(os.path.join(directory, LI.CHECKPOINT_FILE), dict(body, digest=stable_hash(body)))
        self.refuses(world, directory, "checkpoint_foreign_session")

    def test_a_checkpoint_ahead_of_the_evaluator_or_the_audit_journal_is_refused(self):
        for name, reason in ((LI.EVALUATOR_FILE, "checkpoint_ahead_of_evaluator"), (LI.AUDIT_FILE, "checkpoint_ahead_of_audit")):
            with self.subTest(journal=name):
                _root, world, directory = self.fork_prefix()
                session = recover_session(world, directory, self.strategies, journal_clock(directory))
                session.audit.add({"source": "test", "kind": "extra evidence"})
                session.save_checkpoint()                                                  # the checkpoint now counts it
                abandon(session)
                path = os.path.join(directory, name)
                with open(path, "rb") as handle:
                    lines = handle.read().split(b"\n")
                with open(path, "wb") as handle:
                    handle.write(b"\n".join(lines[:-2]) + b"\n")                           # the last complete entry is gone
                self.refuses(world, directory, reason)

    def test_a_refused_recovery_leaves_the_runner_exactly_as_it_was(self):
        _root, world, directory = self.fork_prefix()
        before = {name: os.path.getsize(os.path.join(directory, LI.RUNNER_DIR, name)) for name in os.listdir(os.path.join(directory, LI.RUNNER_DIR))}
        self.refuses(world, directory, "session_mismatch", source_id="another-capture")
        after = {name: os.path.getsize(os.path.join(directory, LI.RUNNER_DIR, name)) for name in os.listdir(os.path.join(directory, LI.RUNNER_DIR))}
        self.assertEqual({k: v for k, v in before.items() if not k.endswith(".lock")}, {k: v for k, v in after.items() if not k.endswith(".lock")})

    def test_a_journal_that_is_not_the_one_the_checkpoint_saw_is_refused(self):
        _root, world, directory = self.fork_prefix()
        path = os.path.join(directory, LI.AUDIT_FILE)
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        other = AuditAlternative.build(text)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(other)
        with self.assertRaises(LI.IntegrationError) as bad:
            session = recover_session(world, directory, self.strategies, journal_clock(directory))
            abandon(session)
        self.assertIn(bad.exception.reason, ("audit_corrupt", "audit_foreign_session", "checkpoint_foreign_audit_journal"))

    def test_the_evaluator_log_of_another_session_is_refused(self):
        _root, world, directory = self.fork_prefix()
        other_root = self.scratch()
        other = LE.LiveEvaluator.create(os.path.join(other_root, "e.jsonl"), self.strategies, (BTC,),
                                        decide_from_ms=DECIDE_FROM + 60 * MIN, decide_until_ms=DECIDE_UNTIL)
        shutil.copyfile(other.log.path, os.path.join(directory, LI.EVALUATOR_FILE))
        with self.assertRaises(LI.IntegrationError) as bad:
            session = recover_session(world, directory, self.strategies, journal_clock(directory))
            abandon(session)
        self.assertTrue(bad.exception.reason.startswith("evaluator_") or bad.exception.reason in ("session_mismatch", "config_incompatible"))



def tearDownModule():
    for cache in (Circuit.cache, ClockCircuit.cache):
        shutil.rmtree(cache.get("dir", ""), True)
        cache.clear()


if __name__ == "__main__":
    unittest.main()
