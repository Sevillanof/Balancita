"""Stage 10D: the offline integration of the whole circuit, on a synthetic capture-shaped database.

    SQLite -> SourceReader -> Ingestor -> LiveEvaluator -> PaperRunner -> Portfolio -> journals -> recovery

Invented data only: the 9A fixture's minute candles, deterministic bid/ask around them and two separate funding tables. No real
database, no network, no wall clock, no persistent process. The frozen strategies C29/C30/C32 run through the shared 9A pipeline;
nothing financial is implemented here."""

import copy
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
from types import SimpleNamespace

from balancita_engine import paper_live_evaluator as LE
from balancita_engine import paper_live_ingest as ING
from balancita_engine import paper_live_integration as LI
from balancita_engine import replay_driver as RP
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC
from balancita_engine.multi_signals import stable_hash
from balancita_engine.paper_runner import PaperRunner, RunnerConfig, RunnerError, make_event
from balancita_engine.paper_runner_store import JOURNAL_FILE, FileRunnerJournal
from balancita_engine.portfolio import PortfolioPolicy
from balancita_engine.portfolio_watch import WatchPolicy

import test_paper_runner_recovery as RR
from live_world import (ACCRUAL_RATE, BTC, ETH, FIRST_DECISION, HOUR, LAST_DECISION, LOAD_START, MIN, SEC, WORLD_END, World)
from test_paper_live_ingest import Source

D = Decimal
INGEST_KW = {"clock_every_ms": 10 ** 12}                 # no clock events: the independent reference has none either
PREFIX_BEFORE = 30 * MIN                                 # the warm-up snapshot is taken this long before the first decision
DOWNTIME_MS = 5 * MIN
MAX_QUOTE_GAP_MS = 25 * SEC          # above the synthetic quotes' own 20 s cadence: the circuit's holes are the ones a test makes


def schedule():
    """The instants at which the session is stepped: coarse during the warm-up, fine in the decision day."""
    times, t = [], LOAD_START
    while t < FIRST_DECISION - HOUR:
        t += HOUR
        times.append(t)
    while t < WORLD_END + MIN:
        t += 10 * MIN
        times.append(t)
    return times


TIMES = schedule()
PREFIX_INDEX = max(i for i, t in enumerate(TIMES) if t <= FIRST_DECISION - PREFIX_BEFORE)


def runner_config():
    return RunnerConfig(portfolio=PortfolioPolicy(), execution=RP.execution_policy(), watch=WatchPolicy(), funding=(),
                        start_ms=FIRST_DECISION, execution_mode="quotes")


def journal_clock(directory):
    """The last time the runner's journal reached (what a restart without downtime hands to the runner)."""
    journal = FileRunnerJournal.load(os.path.join(directory, LI.RUNNER_DIR, JOURNAL_FILE))
    return max(e["t_ms"] for e in journal.entries)


def new_session(world, directory, strategies, ingest_kw=INGEST_KW, max_quote_gap_ms=MAX_QUOTE_GAP_MS, products=(BTC,)):
    return LI.LiveSession.create(directory, world.path, strategies, products, runner_config(), decide_from_ms=FIRST_DECISION,
                                 decide_until_ms=LAST_DECISION, ingest_kw=ingest_kw, max_quote_gap_ms=max_quote_gap_ms)


def recover_session(world, directory, strategies, recovery_ms, ingest_kw=INGEST_KW, products=(BTC,), **kw):
    return LI.LiveSession.recover(directory, world.path, strategies, products, runner_config(), recovery_ms,
                                  decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION, ingest_kw=ingest_kw,
                                  **dict({"max_quote_gap_ms": MAX_QUOTE_GAP_MS}, **kw))


def record(session, now):
    """What must be equal at every step between a continuous run and a recovered one."""
    runner = session.runner
    snapshot = runner.portfolio.snapshot()
    digests = session.digests()
    return {"now": now, "financial": digests["financial"], "signals": digests["signals"], "orders": digests["orders"],
            "portfolio": stable_hash(snapshot), "closed": snapshot["closed_trades"], "open": snapshot["open_positions"],
            "fees": snapshot["fees_usd"], "funding_usd": snapshot["funding_usd"],
            "funding_adjustments": runner.stats.get("funding_adjustments", 0), "pending": len(runner.executor.pending),
            "accounting_orders": len([o for o in runner.orders() if o["state"] == "opened"])}


def abandon(session):
    """The process dies: nothing is flushed or closed in an orderly way (only the OS-level lock goes away)."""
    session.runner.close()
    session.reader.close()
    session.funding.close()


def tearDownModule():
    for cache in (Circuit.cache, ClockCircuit.cache):
        shutil.rmtree(cache.get("dir", ""), True)
        cache.clear()


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
        cache["strategies"], cache["spec_identity"] = RS.load_frozen()
        world = World(root)
        cache["world"] = world
        world.release_until(LOAD_START)
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
    def test_the_synthetic_session_covers_entry_fill_exit_fees_and_funding_accounting(self):
        last = self.timeline[-1]
        snapshot = self.cache["a"].runner.portfolio.snapshot()
        self.assertGreaterEqual(snapshot["closed_trades"], 1)                   # at least one entry, fill and exit
        self.assertGreaterEqual(len([o for o in self.cache["a"].runner.orders() if o["state"] == "opened"]), 1)
        self.assertGreater(D(snapshot["fees_usd"]), 0)                          # commissions
        self.assertGreater(last["funding_adjustments"], 0)                      # the runner's own funding accounting was applied
        self.assertNotEqual(D(snapshot["funding_usd"]), 0)
        self.assertEqual(self.cache["a"].runner.integrity()["open_funding"], [])        # no funding obligation left over
        self.assertEqual(self.cache["a"].runner.integrity()["open_cycles"], [])

    def test_the_instants_exist_in_the_continuous_run(self):
        self.assertTrue(all(v is not None for v in self.cache["instants"].values()), self.cache["instants"])

    def test_a_second_run_from_the_warm_up_snapshot_reaches_the_same_state_at_every_step(self):
        rest = self.timeline[PREFIX_INDEX + 1:]
        self.assertEqual(self.cache["timeline_b"], rest)

    def test_the_session_equals_an_independent_reference_built_from_the_source_lists(self):
        """The oracle shares nothing with the ingestor, the evaluator or the session: its events come straight from the
        synthetic market lists (quotes and accrual rows as the data defines them, candles and cycles from the 9A replay
        assembly) and run through a plain in-memory PaperRunner."""
        world = self.cache["world"]
        session = self.cache["a"]
        bound = session.ingestor.released_ms
        half = D("0.05") / D(10_000)
        events = [((t, 1), make_event("quote", {"product_id": BTC, "time_ms": t, "received_ms": t, "bid": str(mid * (1 - half)),
                                                "ask": str(mid * (1 + half))}, t_ms=t, source="oracle", stream="ticker:" + BTC))
                  for t, mid in world.quotes]
        data = {"1m": world.ones, "5m": world.fives, "funding": world.fundpct, "_by_minute": {c["bucket_start"]: c for c in world.ones}}
        cfg = SimpleNamespace(decision_start_ms=FIRST_DECISION, decision_end_ms=LAST_DECISION, data_end_ms=WORLD_END)
        strategies, _ = RS.load_frozen()
        frames = {}
        cycle_atr = next((s.cycle_atr for s in strategies if hasattr(s, "cycle_atr")), None)
        for key, event in RP.product_events(BTC, data, strategies, cfg, frames, cycle_atr, {}):
            events.append(((event["t_ms"], key[1]), event))
        accrual = (FIRST_DECISION // HOUR) * HOUR - 2 * HOUR
        while accrual < WORLD_END:
            t = accrual + HOUR + RP.FUNDING_LAG_MS
            events.append(((t, 0), make_event("funding", {"product_id": BTC, "periods": [[accrual, accrual + HOUR, ACCRUAL_RATE]]},
                                              t_ms=t, source="oracle", stream="funding:" + BTC)))
            accrual += HOUR
        events = [e for _k, e in sorted(events, key=lambda x: (x[0][0], x[0][1], x[1]["kind"] != "candle"))
                  if e["t_ms"] <= bound]
        root = self.scratch()
        log = SC.SignalLog.create(os.path.join(root, "signals.jsonl"), FIRST_DECISION)

        def evaluator(chosen, payload):
            return SC.evaluate_cycle(chosen, payload["product_id"], payload["cycle_ms"], frames.pop((payload["product_id"], payload["cycle_ms"])))
        oracle = PaperRunner(runner_config(), strategies, log, evaluator=evaluator)
        for event in events:
            oracle.handle(event)
        mine = session.digests()
        self.assertEqual(stable_hash([e["data"]["signal"]["signal_id"] for e in oracle.log.signals() if e["data"]["origin"] == "original"]),
                         mine["signals"])
        self.assertEqual(oracle.financial_digest(), mine["financial"])
        self.assertEqual(oracle.portfolio.snapshot(), session.runner.portfolio.snapshot())
        self.assertEqual(oracle.stats.get("funding_adjustments"), session.runner.stats.get("funding_adjustments"))

    def test_the_funding_that_feeds_the_percentile_is_not_the_funding_accrued_by_positions(self):
        session, world = self.cache["a"], self.cache["world"]
        runner_funding = [e["data"]["event"]["payload"]["periods"][0] for e in session.runner.journal.entries
                          if e["kind"] == "event_accepted" and e["data"]["event"]["kind"] == "funding"]
        evaluator_funding = [e["data"] for e in session.evaluator.log.entries if e["kind"] == "funding"]
        self.assertTrue(runner_funding and evaluator_funding)
        self.assertEqual({str(p[2]) for p in runner_funding}, {ACCRUAL_RATE})              # the explicit synthetic accrual rate only
        by_start = dict((start, float(rate)) for start, rate in world.fundpct)
        self.assertTrue(all(by_start[d["start_ms"]] == d["rate"] for d in evaluator_funding))     # the evaluator got the fundpct series
        self.assertNotIn(float(ACCRUAL_RATE), {d["rate"] for d in evaluator_funding})              # and none of the accrual rate
        self.assertTrue(len(evaluator_funding) > len(runner_funding))                             # different volume, different tables

    def test_changing_the_accrual_rate_changes_the_money_and_not_one_signal(self):
        snap = self.cache["snaps"]["open"]
        root = self.scratch()
        world = World.__new__(World)
        world.__dict__.update(self.cache["world"].fork(root, snap["world"]).__dict__)
        world.accrual_rate = "0.0002"
        world.source.db.execute("UPDATE synthetic_accrual SET rate='0.0002'")
        world.source.commit()
        directory = os.path.join(root, "s")
        shutil.copytree(snap["session"], directory)
        session = recover_session(world, directory, self.strategies, journal_clock(directory))
        self.addCleanup(abandon, session)
        last = self.cache["instants"]["close"]
        for index in range(snap["index"], last + 3):
            world.release_until(TIMES[index])
            session.step(TIMES[index])
        mine, ref = record(session, TIMES[last + 2]), self.timeline[last + 2]
        self.assertEqual(mine["signals"], ref["signals"])                                  # the percentile line did not move
        self.assertNotEqual(mine["funding_usd"], ref["funding_usd"])                       # the accounting did
        self.assertNotEqual(mine["financial"], ref["financial"])

    def test_the_measurements_of_the_synthetic_session_are_reported(self):
        a = self.cache["a"]
        metrics = {"wall_seconds_total": round(self.cache["seconds"], 1), "continuous_run_seconds": round(self.cache["a_seconds"], 1),
                   "peak_rss_growth_mb": round(self.cache["rss_mb"], 1), "steps": len(TIMES), "runner_events": a.stats["events"],
                   "runner_journal_entries": len(a.runner.journal.entries), "evaluator_log_entries": len(a.evaluator.log.entries),
                   "audit_entries": len(a.audit.entries), "evaluator_memory": a.evaluator.report()["memory"]}
        print("\n10D metrics: " + json.dumps(metrics, sort_keys=True))
        snap = a.runner.portfolio.snapshot()
        results = {key: snap.get(key) for key in ("closed_trades", "open_positions", "fees_usd", "funding_usd", "realized_pnl_usd", "equity_usd")}
        print("10D results: " + json.dumps({"portfolio": results, "digests": a.digests(), "signals": len(list(a.runner.log.signals())),
                                           "orders": len(a.runner.orders()), "funding_adjustments": self.timeline[-1]["funding_adjustments"]},
                                          sort_keys=True, default=str))
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
                self.run_boundary(point, "open", occurrence=7)

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
        self.assertGreater(a.stats["clock_events"], 10_000)                     # a day of 5 s ticks, not a handful
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
            return event is not None and event["kind"] == "clock" and len(session.runner.executor.pending) > 0
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
                self.kill_scenario(point, occurrence=7)


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
                                   decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION,
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
                                        decide_from_ms=FIRST_DECISION + HOUR, decide_until_ms=LAST_DECISION)
        shutil.copyfile(other.log.path, os.path.join(directory, LI.EVALUATOR_FILE))
        with self.assertRaises(LI.IntegrationError) as bad:
            session = recover_session(world, directory, self.strategies, journal_clock(directory))
            abandon(session)
        self.assertTrue(bad.exception.reason.startswith("evaluator_") or bad.exception.reason in ("session_mismatch", "config_incompatible"))


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


# ------------------------------------------------------------------------------------------------ 4. adapter and evidence
class TestAdapterAndEvidence(unittest.TestCase):
    """A small session, no market: just enough to push single rows through the real circuit and read what stays on disk."""

    @classmethod
    def setUpClass(cls):
        cls.strategies, _ = RS.load_frozen()

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = os.path.join(self.dir, "capture.sqlite")
        self.src = Source(self.path)
        self.src.db.executescript("""
CREATE TABLE synthetic_fundpct (product_id TEXT NOT NULL, start_ms INTEGER NOT NULL, rate REAL NOT NULL, arrival_ms INTEGER NOT NULL);
CREATE TABLE synthetic_accrual (product_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, rate TEXT NOT NULL,
  arrival_ms INTEGER NOT NULL);""")
        self.src.commit()

    def session(self, **kw):
        return LI.LiveSession.create(os.path.join(self.dir, "s"), self.path, self.strategies, (BTC,), runner_config(),
                                     decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW, **kw)

    def recover(self, **kw):
        return LI.LiveSession.recover(os.path.join(self.dir, "s"), self.path, self.strategies, (BTC,), runner_config(),
                                      journal_clock(os.path.join(self.dir, "s")), decide_from_ms=FIRST_DECISION,
                                      decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW, **kw)

    def candles(self, count, bad_at=None, bad_volume="not-a-number"):
        for i in range(count):
            bucket = FIRST_DECISION - 2 * HOUR + i * MIN
            self.src.candle(BTC, bucket, 100000, 100010, 99990, 100005, volume=bad_volume if i == bad_at else "12.5")
        self.src.ticker(BTC, FIRST_DECISION - 2 * HOUR + (count + 2) * MIN, 100000)
        self.src.commit()

    def test_a_candle_with_a_volume_that_is_not_a_number_is_evidence_never_a_signal(self):
        session = self.session()
        self.addCleanup(abandon, session)
        self.candles(12, bad_at=5)
        session.step(FIRST_DECISION)
        kinds = [r["kind"] for r in session.audit.records()]
        self.assertIn("rejected_input", kinds)
        bad = [r for r in session.audit.records() if r["kind"] == "rejected_input"][0]["item"]
        self.assertEqual(bad["reason"], "invalid_candle")
        self.assertEqual(list(session.runner.log.signals()), [])                                    # no signal exists
        self.assertEqual(session.evaluator.stats["cycles"], 0)

    def test_a_candle_event_without_volume_is_not_given_one(self):
        session = self.session()
        self.addCleanup(abandon, session)
        bucket = FIRST_DECISION - HOUR
        event = make_event("candle", {"product_id": BTC, "bucket_ms": bucket,
                                      "candle": {"open": "100000", "high": "100010", "low": "99990", "close": "100005"}},
                           t_ms=bucket + MIN + 2 * SEC, source=ING.SOURCE, stream="candle1m:" + BTC, source_offset=bucket // MIN)
        session._deliver("event", event)
        report = session.evaluator.report()
        self.assertEqual(report["rejected"][-1]["reason"], "invalid_candle")                  # nothing was invented
        self.assertEqual(report["stats"]["candles"], 0)

    def test_a_death_after_the_audit_write_and_before_the_checkpoint_neither_loses_nor_repeats_evidence(self):
        session = self.session()
        self.candles(12, bad_at=5)

        def fault(name, info=None):
            if name == "after_audit":
                raise LI.FaultInjected(name)
        session.fault = fault
        with self.assertRaises(LI.FaultInjected):
            session.step(FIRST_DECISION)
        written = [r for r in session.audit.records() if r["kind"] == "rejected_input"]
        self.assertEqual(len(written), 1)                                                      # on disk before the checkpoint
        abandon(session)
        revived = self.recover()
        self.addCleanup(abandon, revived)
        revived.step(FIRST_DECISION)                                                           # the older checkpoint reads it again
        again = [r for r in revived.audit.records() if r["kind"] == "rejected_input"]
        self.assertEqual(len(again), 1)                                                        # idempotent: no second copy
        self.assertEqual(len(revived.audit.entries), len(set(e["data"]["record_id"] for e in revived.audit.entries if e["kind"] == "audit")) + 1)

    def test_evidence_that_was_not_yet_written_is_re_derived_after_a_death_before_the_audit(self):
        session = self.session()
        self.candles(12, bad_at=5)

        def fault(name, info=None):
            if name == "after_runner":
                raise LI.FaultInjected(name)
        session.fault = fault
        with self.assertRaises(LI.FaultInjected):
            session.step(FIRST_DECISION)
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "rejected_input"], [])        # not written yet
        abandon(session)
        revived = self.recover()
        self.addCleanup(abandon, revived)
        revived.step(FIRST_DECISION)
        self.assertEqual(len([r for r in revived.audit.records() if r["kind"] == "rejected_input"]), 1)  # nothing was lost

    def test_late_funding_conflicts_and_expired_frames_reach_the_audit_journal(self):
        session = self.session()
        self.addCleanup(abandon, session)
        ev = session.evaluator
        ev.late_funding.append({"product_id": BTC, "hour_ms": 1, "due_ms": 2, "arrival_ms": 3, "cycles_evaluated_without_it": 4})
        ev.conflicts.append({"product_id": BTC, "bucket_start": 5, "arrival_ms": 6, "candle": {"open": "1"}})
        ev.frames_expired.append({"product_id": BTC, "cycle_ms": 7, "reason": "frame_expired"})
        ev.evaluation_misses.append({"product_id": BTC, "cycle_ms": 8, "reason": "frame_expired"})
        self.assertEqual(session.flush_audit(), 4)
        kinds = sorted(r["kind"] for r in session.audit.records())
        self.assertEqual(kinds, ["candle_conflict", "evaluation_failed", "frame_expired", "late_funding"])
        self.assertEqual(session.flush_audit(), 0)                                             # idempotent

    def test_an_outage_of_the_source_reaches_the_audit_journal(self):
        session = self.session()
        self.addCleanup(abandon, session)
        base = FIRST_DECISION + HOUR
        for t in (0, 5 * SEC, 10 * SEC):
            self.src.ticker(BTC, base + t, 100000)
        self.src.ticker(BTC, base + 2 * MIN, 100000)                       # 110 s of silence: longer than the 45 s limit
        self.src.ticker(BTC, base + 2 * MIN + 5 * SEC, 100000)
        self.src.commit()
        session.step(base + 3 * MIN)
        outages = [r for r in session.audit.records() if r["kind"] == "source_outage"]
        self.assertEqual(len(outages), 1)

    def test_the_audit_journal_refuses_a_cut_chain_and_repairs_a_half_written_last_line(self):
        session = self.session()
        self.addCleanup(abandon, session)
        session.audit.add({"source": "test", "kind": "one"})
        path = session.audit.path
        with open(path, "ab") as handle:
            handle.write(b'{"seq": 99, "kind": "audit", "da')
        reopened = LI.AuditJournal.open(path)
        self.assertEqual(reopened.tail_discarded, 1)
        self.assertEqual(reopened.head, session.audit.head)
        self.assertFalse(reopened.add({"source": "test", "kind": "one"}))                     # already there
        with open(path, "r+") as handle:
            text = handle.read().replace('"one"', '"two"', 1)
            handle.seek(0)
            handle.write(text)
        with self.assertRaises(LI.IntegrationError) as bad:
            LI.AuditJournal.open(path)
        self.assertEqual(bad.exception.reason, "audit_corrupt")


# ------------------------------------------------------------------------------------------------ 5. source stale policy
class TestSourceStalePolicy(unittest.TestCase):
    """D-10-01 = B, designed and tested on synthetic sources. The cancellation itself needs an entry point in
    ``paper_runner.py`` (owner: 9A), so here the session only records which pending orders it would cancel."""

    @classmethod
    def setUpClass(cls):
        cls.strategies, _ = RS.load_frozen()

    def scratch(self):
        path = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, path, True)
        return path

    def order(self, product=BTC, start=1_000_000, deadline=1_000_000 + 60 * SEC):
        return {"product_id": product, "timeline": {"earliest_fill_ms": start, "deadline_ms": deadline}}

    def test_a_26_second_cut_is_flagged_even_though_the_ingestor_calls_it_alive(self):
        times = [0, 5 * SEC, 10 * SEC, 36 * SEC, 41 * SEC]                  # a 26 s hole between 10 s and 36 s
        gaps = LI.stale_quote_gaps(times, 15 * SEC)
        self.assertEqual(gaps, [{"from_ms": 10 * SEC, "to_ms": 36 * SEC}])
        pending = {"i1": self.order(start=20 * SEC, deadline=80 * SEC)}
        hits = LI.affected_orders(pending, {BTC: gaps})
        self.assertEqual([h["intent_id"] for h in hits], ["i1"])
        # the ingestor's own 45 s limit does not see it: this is the regression case the 45 s silence cannot cover
        self.assertGreater(45 * SEC, 36 * SEC - 10 * SEC)

    def test_a_45_second_silence_is_not_the_only_guarantee(self):
        gaps = LI.stale_quote_gaps([0, 20 * SEC, 41 * SEC], 15 * SEC)         # two 20 s holes, none reaches 45 s
        self.assertEqual(len(gaps), 2)
        self.assertEqual(LI.stale_quote_gaps([0, 5 * SEC, 10 * SEC, 15 * SEC], 15 * SEC), [])      # a regular cadence is fine
        self.assertEqual(LI.stale_quote_gaps([0, 15 * SEC], 15 * SEC), [])                          # exactly the limit is not a hole

    def test_only_pending_orders_of_the_affected_product_whose_window_overlaps_the_hole_are_selected(self):
        gaps = {BTC: [{"from_ms": 100, "to_ms": 200}]}
        pending = {"a": self.order(start=150, deadline=400), "b": self.order(start=250, deadline=400),
                   "c": self.order(start=0, deadline=100), "d": self.order(product="PF_ETHUSD", start=150, deadline=400)}
        self.assertEqual([h["intent_id"] for h in LI.affected_orders(pending, gaps)], ["a"])
        self.assertEqual(LI.affected_orders({}, gaps), [])                    # open positions are not pending orders: not touched

    def test_a_hole_inside_the_limit_selects_nothing_and_the_session_does_not_call_the_runner(self):
        """The session's own selection is pure: a regular cadence, or a hole of another product, produces no cancellation call."""
        gaps = {BTC: LI.stale_quote_gaps([0, 5 * SEC, 10 * SEC, 15 * SEC, 20 * SEC], 15 * SEC)}
        pending = {"intent-1": self.order(start=0, deadline=80 * SEC), "intent-2": self.order(product="PF_ETHUSD", start=0, deadline=80 * SEC)}
        self.assertEqual(LI.affected_orders(pending, gaps), [])
        self.assertEqual(LI.affected_orders(pending, {"PF_ETHUSD": [{"from_ms": 10 * SEC, "to_ms": 36 * SEC}]}),
                         [{"intent_id": "intent-2", "product_id": "PF_ETHUSD", "gap": {"from_ms": 10 * SEC, "to_ms": 36 * SEC},
                           "action": "cancel", "window": [0, 80 * SEC]}])

    def test_an_order_over_before_the_silence_was_excessive_expires_and_the_boundary_is_decided(self):
        """D-17-19 / D-17-22: the silence is excessive only when it exceeds the limit, so a deadline at ``from + limit`` (the
        equality included) was over before that and the order expires; one millisecond later it is still executable when the
        limit is exceeded (``from + limit + 1``) and it is cancelled."""
        limit, gap = 15 * SEC, {"from_ms": 10 * SEC, "to_ms": 10 * SEC + 15 * SEC + 1}
        pending = {name: self.order(start=11 * SEC, deadline=deadline) for name, deadline in
                   (("before", 10 * SEC + limit - 1), ("equal", 10 * SEC + limit), ("after", 10 * SEC + limit + 1))}
        actions = {h["intent_id"]: h["action"] for h in LI.affected_orders(pending, {BTC: [gap]}, limit)}
        self.assertEqual(actions, {"before": "expire", "equal": "expire", "after": "cancel"})
        self.assertEqual({h["action"] for h in LI.affected_orders(pending, {BTC: [gap]})}, {"cancel"})         # no limit given: as before


# ------------------------------------------------------------------------------------------------ 6. the durable cancellation
ENTRY_QUOTE_MS = FIRST_DECISION + 50 * MIN + 10 * SEC           # the 10 s quote of the minute that opens the first order of the day
HOLE = (ENTRY_QUOTE_MS - 5 * SEC, ENTRY_QUOTE_MS + 5 * SEC)     # that one quote is missing: the source is silent for 40 s (> the 25 s limit, < 45 s)
GAP_FROM, GAP_TO = ENTRY_QUOTE_MS - 20 * SEC, ENTRY_QUOTE_MS + 20 * SEC       # the silence and the quote that ends it
DECLARED_TO = GAP_FROM + MAX_QUOTE_GAP_MS + 1                                   # what is declared: the first instant over the limit (D-174-01)
BEFORE_ENTRY = FIRST_DECISION + 50 * MIN + 25 * SEC          # the order is decided and the quote that opens the hole is delivered; the one that ends it is not
ENTRY_STEP = next(i for i, t in enumerate(TIMES) if t >= FIRST_DECISION + 50 * MIN + 2 * SEC)


def first_order(session):
    return session.runner.orders()[0]


class TestSourceStaleCancellation(unittest.TestCase):
    """Decision D-10C-3 wired through the runner's ``cancel_for_source_loss``: the 40 s hole (shorter than the ingestor's 45 s
    silence) in which the first order waits cancels it before the quote that ends the hole is delivered, in the continuous run
    and after a real process death at any of the neighbouring boundaries. The same hole with the limit switched off lets that
    quote fill the order."""

    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        if cls.cache:
            return
        cls.cache["dir"] = root = tempfile.mkdtemp()
        strategies, _ = RS.load_frozen()
        cls.cache["strategies"] = strategies
        world = World(root, quote_holes=[HOLE])
        world.release_until(LOAD_START)
        session = new_session(world, os.path.join(root, "a"), strategies)
        loose_root = os.path.join(root, "loose-world")
        os.makedirs(loose_root)
        loose_world = World(loose_root, quote_holes=[HOLE])
        loose_world.release_until(LOAD_START)
        loose = new_session(loose_world, os.path.join(root, "loose"), strategies, max_quote_gap_ms=10 ** 9)
        for now in TIMES[:ENTRY_STEP] + [BEFORE_ENTRY]:       # the quote that opens the hole is in a step that is already checkpointed
            world.release_until(now)
            session.step(now)
            loose_world.release_until(now)
            loose.step(now)
        cls.cache["snap"] = Circuit.take_snapshot(root, "pre-hole", session, world, ENTRY_STEP)
        world.release_until(TIMES[ENTRY_STEP])
        session.step(TIMES[ENTRY_STEP])
        loose_world.release_until(TIMES[ENTRY_STEP])
        loose.step(TIMES[ENTRY_STEP])
        cls.cache.update(world=world, a=session, loose=loose, loose_world=loose_world, record=record(session, TIMES[ENTRY_STEP]),
                         losses=sorted(session.runner.source_losses.items()), comparable=session.comparable_state(), cancelled=cls.cancel_trace(session))

    @classmethod
    def tearDownClass(cls):
        for name in ("a", "loose"):
            if name in cls.cache:
                abandon(cls.cache.pop(name))
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    def scratch(self):
        path = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, path, True)
        return path

    @staticmethod
    def cancel_trace(session):
        """What the journals say about the cancellation, without the bookkeeping a recovery adds."""
        entries = session.runner.journal.entries
        return {"source_loss": [e["data"] for e in entries if e["kind"] == "source_loss"],
                "cancelled": [(e["data"]["intent_id"], e["data"]["reason"], e["data"]["uncovered_from_ms"], e["data"]["uncovered_to_ms"])
                              for e in entries if e["kind"] == "order_cancelled"],
                "audit": sorted(stable_hash(r) for r in session.audit.records() if r["kind"] in ("source_loss", "source_stale_detected"))}

    @staticmethod
    def quote_seq(session, time_ms):
        return next(e["seq"] for e in session.runner.journal.entries
                    if e["kind"] == "event_accepted" and e["data"]["event"]["kind"] == "quote"
                    and e["data"]["event"]["payload"]["time_ms"] == time_ms)

    def assert_cancelled_before_the_quote(self, session):
        order = first_order(session)
        self.assertEqual(order["state"], "cancelled")
        entries = session.runner.journal.entries
        losses = [e for e in entries if e["kind"] == "source_loss"]
        cancels = [e for e in entries if e["kind"] == "order_cancelled" and e["data"]["reason"] == "source_stale"]
        self.assertEqual(len(losses), 1)
        self.assertEqual([c["data"]["intent_id"] for c in cancels], [order["intent_id"]])
        self.assertEqual({k: losses[0]["data"][k] for k in ("product_id", "gap_from_ms", "gap_to_ms")},
                         {"product_id": BTC, "gap_from_ms": GAP_FROM, "gap_to_ms": DECLARED_TO})
        self.assertLess(cancels[0]["seq"], self.quote_seq(session, GAP_TO))        # before the quote that ends the hole was delivered
        self.assertLess(losses[0]["seq"], cancels[0]["seq"])
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "source_loss"][0]["cancelled"], [order["intent_id"]])

    def test_the_hole_cancels_the_pending_order_before_the_quote_that_ends_it(self):
        session = self.cache["a"]
        self.assert_cancelled_before_the_quote(session)
        evidence = [r for r in session.audit.records() if r["kind"] == "source_stale_detected"]
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["gap"], {"from_ms": GAP_FROM, "to_ms": DECLARED_TO})
        self.assertEqual(evidence[0]["pending_hit"], [first_order(session)["intent_id"]])
        self.assertEqual(sorted(evidence[0]["ingestor"]), ["data_gaps", "epoch_changes", "product_silence", "sample_capped",
                                                           "source_silence", "unexplained"])
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "source_stale_refused"], [])
        self.assertEqual({k: evidence[0]["ingestor"][k] for k in ("source_silence", "product_silence", "unexplained")},
                         {"source_silence": True, "product_silence": False, "unexplained": False})      # one product: the source itself was silent
        self.assertEqual(session.ingestor.outages, [])                          # the ingestor never called it an outage
        self.assertEqual(session.runner.integrity()["open_cycles"], [])

    def test_without_the_cancellation_the_quote_after_the_hole_fills_the_order(self):
        """The regression: the same hole, the limit switched off, and the order that waited blind is filled on the first quote
        after it."""
        loose = self.cache["loose"]
        order = first_order(loose)
        self.assertEqual(order["state"], "opened")
        self.assertEqual(order["timeline"]["entry_ms"], GAP_TO)
        self.assertEqual([e for e in loose.runner.journal.entries if e["kind"] == "source_loss"], [])
        self.assertEqual([r for r in loose.audit.records() if r["kind"] in ("source_stale_detected", "source_loss")], [])

    def test_nothing_else_changes_the_cancellation_touches_only_the_pending_orders_of_the_hole(self):
        """Open positions, other decisions and the accounting are the runner's own: the only order cancelled is the one
        that was pending in the hole."""
        session = self.cache["a"]
        cancelled = [o for o in session.runner.orders() if o["state"] == "cancelled"]
        self.assertEqual([o["intent_id"] for o in cancelled], [first_order(session)["intent_id"]])

    # ---- real process death around the cancellation -----------------------------------------------------------
    def fork(self):
        snap = self.cache["snap"]
        root = self.scratch()
        world = self.cache["world"].fork(root, snap["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(snap["session"], directory)
        return world, directory

    def boundaries(self):
        """How many times the step crosses ``before_handle`` before the quote that ends the hole (counted in-process)."""
        world, directory = self.fork()
        session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory))
        self.addCleanup(abandon, session)
        seen = {"n": 0, "end": None}

        def fault(name, info=None):
            if name == "before_handle":
                seen["n"] += 1
                if info is not None and info["kind"] == "quote" and info["payload"]["time_ms"] == GAP_TO and seen["end"] is None:
                    seen["end"] = seen["n"]
        session.fault = fault
        world.release_until(TIMES[ENTRY_STEP])
        session.step(TIMES[ENTRY_STEP])
        self.assertIsNotNone(seen["end"])
        return seen["end"]

    def kill_and_recover(self, point, occurrence):
        world, directory = self.fork()
        world.release_until(TIMES[ENTRY_STEP])
        env = dict(os.environ, PYTHONPATH=os.pathsep.join((os.path.dirname(os.path.dirname(os.path.abspath(LI.__file__))),
                                                           os.path.dirname(os.path.abspath(__file__)))))
        done = subprocess.run([sys.executable, "-W", "ignore", os.path.join(os.path.dirname(os.path.abspath(__file__)), "live_kill_worker.py"),
                               directory, world.path, str(journal_clock(directory)), point, str(occurrence), str(ENTRY_STEP), "plain"],
                              env=env, capture_output=True, text=True, timeout=600)
        self.assertEqual(done.returncode, -signal.SIGKILL, "the boundary {} #{} was not crossed\n{}".format(point, occurrence, done.stderr[-2000:]))
        session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory))
        self.addCleanup(abandon, session)
        session.step(TIMES[ENTRY_STEP])
        return session

    def test_a_killed_process_still_cancels_the_order_once_and_before_the_quote(self):
        end = self.boundaries()
        for point, occurrence in (("after_poll", 1), ("before_handle", end - 1), ("before_handle", end), ("before_handle", end + 1),
                                  ("after_runner", 1), ("after_audit", 1), ("after_runner_checkpoint", 1), ("checkpoint_tmp_written", 1),
                                  ("after_checkpoint", 1)):
            with self.subTest(point=point, occurrence=occurrence):
                session = self.kill_and_recover(point, occurrence)
                self.assert_cancelled_before_the_quote(session)
                self.assertEqual(record(session, TIMES[ENTRY_STEP]), self.cache["record"])
                self.assertEqual(self.cancel_trace(session), self.cache["cancelled"])      # one loss, one cancellation, same evidence
                # ``state_digest`` counts what a recovery adds by design; the comparable state leaves that out
                self.assertEqual(sorted(session.runner.source_losses.items()), self.cache["losses"])
                self.assertEqual(session.comparable_state(), self.cache["comparable"])
                self.assertEqual(session.runner.integrity()["open_cycles"], [])

    def test_repeating_the_same_interval_cancels_nothing_more(self):
        session = self.cache["a"]
        before = (len(session.runner.journal.entries), self.cancel_trace(session), session.runner.state_digest())
        again = session.runner.cancel_for_source_loss(BTC, GAP_FROM, DECLARED_TO, session.runner.clock, MAX_QUOTE_GAP_MS)       # declared already: any clock, no writes
        self.assertEqual(again, [first_order(session)["intent_id"]])
        session.last_quote.clear()
        session.last_quote[BTC] = GAP_FROM
        session._continuity(make_event("quote", {"product_id": BTC, "time_ms": GAP_TO, "received_ms": GAP_TO, "bid": "1", "ask": "2"},
                                        t_ms=GAP_TO, source=ING.SOURCE, stream="ticker:" + BTC), session.runner.executor.pending)
        self.assertEqual((len(session.runner.journal.entries), self.cancel_trace(session), session.runner.state_digest()), before)

    def test_a_refused_cancellation_is_never_recorded_as_applied_and_the_session_stops(self):
        world, directory = self.fork()
        session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory))
        self.addCleanup(abandon, session)
        refused = []

        def refuse(*args):
            refused.append(args)
            raise RunnerError("source_loss_after_quote", "test")
        session.runner.cancel_for_source_loss = refuse
        world.release_until(TIMES[ENTRY_STEP])
        with self.assertRaises(RunnerError):
            session.step(TIMES[ENTRY_STEP])
        self.assertEqual(len(refused), 1)
        records = [r for r in session.audit.records() if r["kind"] == "source_stale_refused"]
        self.assertEqual([(r["applied"], r["reason"]) for r in records], [(False, "source_loss_after_quote")])
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "source_loss"], [])         # nothing is recorded as cancelled
        session.flush_audit()
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "source_loss"], [])
        self.assertEqual([e for e in session.runner.journal.entries if e["kind"] == "source_loss"], [])
        self.assertNotEqual(first_order(session)["state"], "opened")        # the quote that would have filled it was not delivered

    def test_a_recovered_session_takes_the_previous_quote_from_the_runner_not_from_its_own_memory(self):
        """The hole is seen from the runner's last quote, not from what the dead process remembered."""
        world, directory = self.fork()
        session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory))
        self.addCleanup(abandon, session)
        self.assertEqual(session.last_quote[BTC], FIRST_DECISION + 50 * MIN - 10 * SEC)      # the last quote the runner received before the step


class Killed(Exception):
    """The process dies right here (the session is abandoned as it is: nothing is flushed)."""


UNTIL_ORDER = ENTRY_QUOTE_MS + 15 * SEC            # BTC's order is decided and delivered (ETH's rows carry the watermark past it)


class TestSilenceStillOpen(unittest.TestCase):
    """D-10B-17 (Fran 15:52Z and 16:07Z): BTC loses a stretch of quotes while ETH keeps the source alive. The order BTC has pending
    is cancelled by ``source_stale`` the moment the evidence proves the limit was exceeded while the order could still be
    executed: from the event flow (the first event later than that instant) or, when nothing flows, from the ingestor's proof of
    the observation alone. Both declare the same loss at the same instant, so the continuous run (one step to the end), the one
    that waits in the silence and the ones that die at any point of the declaration leave the same journal, orders and money."""

    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        if cls.cache:
            return
        cls.cache["dir"] = root = tempfile.mkdtemp()
        strategies, _ = RS.load_frozen()
        cls.cache["strategies"] = strategies
        world = World(root, quote_holes=[HOLE], second_product_shift=-3)
        world.release_until(LOAD_START)
        session = new_session(world, os.path.join(root, "a"), strategies, products=(BTC, ETH))
        for now in TIMES[:ENTRY_STEP]:
            world.release_until(now)
            session.step(now)
        cls.cache["snap"] = Circuit.take_snapshot(root, "silent", session, world, ENTRY_STEP)
        cls.cache["world"] = world
        world.release_until(TIMES[ENTRY_STEP])                       # the continuous run: one step, every event in the flow
        session.step(TIMES[ENTRY_STEP])
        cls.cache["a"] = session
        cls.cache["record"] = record(session, TIMES[ENTRY_STEP])
        # D-174-01: ETH is mute from 2 s after BTC's last quote, so nothing flows between the instant and BTC's closing quote
        where = os.path.join(root, "mute")
        os.makedirs(where)
        mute = World(where, quote_holes=[HOLE], second_product_shift=-3, second_product_holes=[(ENTRY_QUOTE_MS + 2 * SEC, ENTRY_QUOTE_MS + 60 * SEC)])
        mute.release_until(LOAD_START)
        quiet = new_session(mute, os.path.join(where, "a"), strategies, products=(BTC, ETH))
        for now in TIMES[:ENTRY_STEP]:
            mute.release_until(now)
            quiet.step(now)
        cls.cache["mute"] = {"world": mute, "snap": Circuit.take_snapshot(where, "mute", quiet, mute, ENTRY_STEP)}
        mute.release_until(TIMES[ENTRY_STEP])
        quiet.step(TIMES[ENTRY_STEP])
        cls.cache["quiet"] = quiet

    @classmethod
    def tearDownClass(cls):
        if "quiet" in cls.cache:
            abandon(cls.cache.pop("quiet"))
        if "a" in cls.cache:
            abandon(cls.cache.pop("a"))
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    def fork(self, recovery_gap_ms=0):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        world = self.cache["world"].fork(root, self.cache["snap"]["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(self.cache["snap"]["session"], directory)
        return world, directory, self.recover_again(world, directory, recovery_gap_ms)

    def recover_again(self, world, directory, recovery_gap_ms=0):
        session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory) + recovery_gap_ms, products=(BTC, ETH))
        self.addCleanup(abandon, session)
        return session

    def losses(self, session, product=BTC):
        return [e["data"] for e in session.runner.journal.entries if e["kind"] == "source_loss" and e["data"]["product_id"] == product]

    def cancellations(self, session):
        return [(e["data"]["intent_id"], e["data"]["product_id"] if "product_id" in e["data"] else None, e["data"]["reason"])
                for e in session.runner.journal.entries if e["kind"] == "order_cancelled"]

    def orders_view(self, session):
        return [(o["intent_id"], o["product_id"], o["state"]) for o in session.runner.orders()]

    def money(self, session):
        snap = record(session, TIMES[ENTRY_STEP])
        return {k: snap[k] for k in ("portfolio", "closed", "open", "fees", "funding_usd", "accounting_orders", "orders")}

    def btc_order(self, session):
        return next(o for o in session.runner.orders() if o["product_id"] == BTC)

    def test_the_continuous_run_cancels_the_pending_order_of_the_silent_product_only(self):
        session = self.cache["a"]
        self.assertEqual(self.btc_order(session)["state"], "cancelled")
        self.assertEqual([c[2] for c in self.cancellations(session)], ["source_stale"])
        self.assertEqual([c[0] for c in self.cancellations(session)], [self.btc_order(session)["intent_id"]])       # ETH's order is untouched
        loss = self.losses(session)
        self.assertEqual(len(loss), 1)
        self.assertEqual((loss[0]["gap_from_ms"], loss[0]["gap_to_ms"], loss[0]["threshold_ms"]),
                         (ENTRY_QUOTE_MS - 20 * SEC, ENTRY_QUOTE_MS - 20 * SEC + MAX_QUOTE_GAP_MS + 1, MAX_QUOTE_GAP_MS))
        evidence = [r for r in session.audit.records() if r["kind"] == "source_stale_detected"]
        self.assertEqual([r["trigger"] for r in evidence], ["open_silence"])
        self.assertEqual(self.losses(session, ETH), [])

    def test_when_nothing_flows_the_proof_of_the_observation_declares_the_same_loss(self):
        world, directory, session = self.fork()
        world.release_until(UNTIL_ORDER)
        session.step(UNTIL_ORDER)                                     # nothing later than the instant is delivered: no event can carry it
        flow = self.cache["a"]
        self.assertEqual(self.btc_order(session)["state"], "cancelled")
        self.assertEqual(self.losses(session), self.losses(flow))
        self.assertEqual(self.cancellations(session), self.cancellations(flow))
        evidence = [r for r in session.audit.records() if r["kind"] == "source_stale_detected"]
        self.assertEqual([r["trigger"] for r in evidence], ["observed_silence"])
        self.assertEqual(session.runner.executor.last_quote_ms.get(BTC), ENTRY_QUOTE_MS - 20 * SEC)       # no quote was invented
        for step_ms in (UNTIL_ORDER + MIN, UNTIL_ORDER + 5 * MIN):    # the source says nothing more: nothing more is declared
            session.step(step_ms)
        self.assertEqual(len(self.losses(session)), 1)

    def test_without_proof_nothing_is_declared(self):
        world, directory, session = self.fork()
        world.release_until(ENTRY_QUOTE_MS + 5 * SEC)
        session.step(ENTRY_QUOTE_MS + 5 * SEC)                        # observed time still short of the instant (the source's own clock)
        self.assertEqual(self.losses(session), [])
        self.assertEqual(self.btc_order(session)["state"], "pending")
        session.ingestor.ticker_more = True                           # a read that did not reach its end proves nothing
        session.ingestor.observed_until_ms = ENTRY_QUOTE_MS + 5 * MIN
        self.assertIsNone(session.ingestor.proven_until())
        session._declare_from_observation()
        self.assertEqual(self.losses(session), [])
        self.assertEqual(self.btc_order(session)["state"], "pending")

    def test_waiting_in_the_silence_and_going_on_equals_the_continuous_run(self):
        world, directory, session = self.fork()
        world.release_until(UNTIL_ORDER)
        session.step(UNTIL_ORDER)
        session.step(UNTIL_ORDER + 2 * MIN)
        world.release_until(TIMES[ENTRY_STEP])
        session.step(TIMES[ENTRY_STEP])
        flow = self.cache["a"]
        self.assertEqual(self.orders_view(session), self.orders_view(flow))
        self.assertEqual(self.money(session), self.money(flow))
        self.assertEqual(self.losses(session), self.losses(flow))
        self.assertEqual(self.cancellations(session), self.cancellations(flow))
        self.assertEqual(len(self.losses(session)), 1)

    def test_a_death_around_the_declaration_cancels_once_and_changes_no_money(self):
        for point, via in (("after_poll", "observation"), ("after_open_declaration", "observation"), ("after_runner", "observation"),
                           ("after_audit", "observation"), ("after_checkpoint", "observation"),
                           ("after_open_declaration", "flow"), ("after_audit", "flow")):
            with self.subTest(point=point, via=via):
                world, directory, session = self.fork()
                fired = []

                def fault(name, info=None, point=point):
                    if name == point:
                        fired.append(name)
                        raise Killed()
                session.fault = fault
                first = UNTIL_ORDER if via == "observation" else TIMES[ENTRY_STEP]
                world.release_until(first)
                with self.assertRaises(Killed):
                    session.step(first)
                abandon(session)
                session = self.recover_again(world, directory)
                session.step(first)
                world.release_until(TIMES[ENTRY_STEP])
                session.step(TIMES[ENTRY_STEP])
                flow = self.cache["a"]
                self.assertEqual(len(self.losses(session)), 1)
                self.assertEqual(self.losses(session), self.losses(flow))
                self.assertEqual(self.cancellations(session), self.cancellations(flow))
                self.assertEqual(self.orders_view(session), self.orders_view(flow))
                self.assertEqual(self.money(session), self.money(flow))
                self.assertEqual(session.runner.integrity()["open_cycles"], [])
                ids = [stable_hash(r) for r in session.audit.records()]       # an audit write that got ahead of the checkpoint is not written twice
                self.assertEqual(len(ids), len(set(ids)))
                self.assertEqual(len([r for r in session.audit.records() if r["kind"] == "source_loss"]), 1)

    def test_polling_inside_the_silence_never_changes_what_is_declared(self):
        """D-174-01: with nothing else flowing between the instant the limit is exceeded and the product's own closing quote, the
        declaration is the same, in the journal and in the digests, whether or not the source was polled in between."""
        item = self.cache["mute"]
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        world = item["world"].fork(root, item["snap"]["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(item["snap"]["session"], directory)
        session = self.recover_again(world, directory)
        for now in (ENTRY_QUOTE_MS + 12 * SEC, ENTRY_QUOTE_MS + 22 * SEC):
            world.release_until(now)
            session.step(now)
        world.release_until(TIMES[ENTRY_STEP])
        session.step(TIMES[ENTRY_STEP])
        quiet = self.cache["quiet"]
        self.assertEqual(len(self.losses(quiet)), 1)
        self.assertEqual(self.losses(session), self.losses(quiet))
        self.assertEqual(self.cancellations(session), self.cancellations(quiet))
        self.assertEqual(session.digests(), quiet.digests())
        self.assertEqual(session.runner.portfolio.snapshot(), quiet.runner.portfolio.snapshot())
        self.assertEqual((self.losses(quiet)[0]["gap_from_ms"], self.losses(quiet)[0]["gap_to_ms"]),
                         (ENTRY_QUOTE_MS - 20 * SEC, ENTRY_QUOTE_MS - 20 * SEC + MAX_QUOTE_GAP_MS + 1))     # the instant, not the closing quote

    def test_a_restart_after_the_downtime_never_turns_the_silence_into_a_retroactive_cancellation(self):
        """The process died before the declaration and was restarted ten minutes later: the runner's clock went past the events it
        had not been given (they are rejected as late, as in every recovery with downtime), the stretch it was away for is an
        observation gap, and no ``source_stale`` is declared for it, whatever the order was waiting for."""
        world, directory, session = self.fork()
        session.fault = lambda name, info=None: (_ for _ in ()).throw(Killed()) if name == "after_poll" else None
        world.release_until(UNTIL_ORDER)
        with self.assertRaises(Killed):
            session.step(UNTIL_ORDER)
        abandon(session)
        session = self.recover_again(world, directory, recovery_gap_ms=10 * MIN)
        session.step(UNTIL_ORDER + 10 * MIN)
        world.release_until(TIMES[ENTRY_STEP])
        session.step(TIMES[ENTRY_STEP])
        self.assertEqual(self.losses(session), [])
        self.assertNotIn("source_stale", [c[2] for c in self.cancellations(session)])
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "source_stale_detected"], [])
        self.assertTrue(session.ingestor.observation_gaps)          # told as time nobody observed, never as a silence or a Kraken outage


LONG_HOLE = (ENTRY_QUOTE_MS - 5 * SEC, ENTRY_QUOTE_MS + 135 * SEC)      # BTC is silent from 2990 s to 3150 s (160 s): its order lives until 3122 s
ORDER_DEADLINE = FIRST_DECISION + 50 * MIN + 2 * SEC + 120 * SEC


class TestDeadlineAgainstTheThreshold(unittest.TestCase):
    """Fran 16:07Z and 17:48Z, in the complete circuit: the same silence with the limit just under, exactly at and just over the
    order's deadline (``deadline <= last quote + limit`` expires with the executor's own reason; later is cancelled by
    ``source_stale``), the audit keeps the cancelled and the expired apart with the threshold, the interval and the instant of the
    declaration, and a death between ``source_loss`` and ``source_loss_expiry`` or between the declaration and the checkpoint
    leaves the same orders, reasons and money as the continuous run."""

    cache = {}
    LIMITS = {"after": ORDER_DEADLINE - (ENTRY_QUOTE_MS - 20 * SEC) - 1, "equal": ORDER_DEADLINE - (ENTRY_QUOTE_MS - 20 * SEC),
              "before": ORDER_DEADLINE - (ENTRY_QUOTE_MS - 20 * SEC) + 1}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        if cls.cache:
            return
        cls.cache["dir"] = root = tempfile.mkdtemp()
        strategies, _ = RS.load_frozen()
        cls.cache["strategies"] = strategies
        for name, limit in cls.LIMITS.items():
            where = os.path.join(root, name)
            os.makedirs(where)
            world = World(where, quote_holes=[LONG_HOLE])
            world.release_until(LOAD_START)
            session = new_session(world, os.path.join(where, "a"), strategies, max_quote_gap_ms=limit)
            for now in TIMES[:ENTRY_STEP]:
                world.release_until(now)
                session.step(now)
            snap = Circuit.take_snapshot(where, "pre", session, world, ENTRY_STEP)
            world.release_until(TIMES[ENTRY_STEP])
            session.step(TIMES[ENTRY_STEP])
            cls.cache[name] = {"world": world, "session": session, "snap": snap, "limit": limit}

    @classmethod
    def tearDownClass(cls):
        for name in cls.LIMITS:
            if name in cls.cache:
                abandon(cls.cache[name]["session"])
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    def first(self, session):
        return first_order(session)

    def loss_audit(self, session):
        return [r for r in session.audit.records() if r["kind"] == "source_loss"]

    def test_the_limit_just_under_the_deadline_cancels_by_source_stale(self):
        item = self.cache["after"]
        session, limit = item["session"], item["limit"]
        order = self.first(session)
        self.assertEqual(order["state"], "cancelled")
        audit = self.loss_audit(session)
        self.assertEqual(len(audit), 1)
        self.assertEqual((audit[0]["cancelled"], audit[0]["expired"], audit[0]["expired_reasons"], audit[0]["threshold_ms"]),
                         ([order["intent_id"]], [], {}, limit))
        self.assertEqual(audit[0]["gap"], {"from_ms": ENTRY_QUOTE_MS - 20 * SEC, "to_ms": ENTRY_QUOTE_MS - 20 * SEC + limit + 1})
        self.assertIsNotNone(audit[0]["declared_ms"])

    def test_a_deadline_at_or_before_the_limit_expires_with_the_executors_reason_and_is_never_a_source_cancellation(self):
        for name in ("equal", "before"):
            with self.subTest(name=name):
                item = self.cache[name]
                session, limit = item["session"], item["limit"]
                order = self.first(session)
                self.assertEqual(order["state"], "expired")
                entries = session.runner.journal.entries
                self.assertEqual([e for e in entries if e["kind"] == "order_cancelled"], [])
                self.assertEqual(len([e for e in entries if e["kind"] == "source_loss_expiry"]), 1)
                audit = self.loss_audit(session)
                self.assertEqual(len(audit), 1)
                self.assertEqual((audit[0]["cancelled"], audit[0]["expired"], audit[0]["expired_reasons"], audit[0]["threshold_ms"]),
                                 ([], [order["intent_id"]], {order["intent_id"]: ["no_quote_in_window"]}, limit))
                self.assertIsNotNone(audit[0]["declared_ms"])
                detected = [r for r in session.audit.records() if r["kind"] == "source_stale_detected"]
                self.assertEqual([(r["pending_hit"], r["expiring"]) for r in detected], [([], [order["intent_id"]])])
                self.assertEqual(session.runner.integrity()["open_cycles"], [])

    def killed_between(self, name, point):
        item = self.cache[name]
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        world = item["world"].fork(root, item["snap"]["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(item["snap"]["session"], directory)
        session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory), max_quote_gap_ms=item["limit"])
        self.addCleanup(abandon, session)
        if point == "between_loss_and_expiry":
            def die(*args, **kw):
                raise Killed()
            session.runner._expire_for_source_loss = die
        else:
            def fault(name_, info=None):
                if name_ == point or (point == "after_declaration" and name_ in ("after_open_declaration", "after_closing_declaration")):
                    raise Killed()
            session.fault = fault
        world.release_until(TIMES[ENTRY_STEP])
        with self.assertRaises(Killed):
            session.step(TIMES[ENTRY_STEP])
        abandon(session)
        again = recover_session(world, directory, self.cache["strategies"], journal_clock(directory), max_quote_gap_ms=item["limit"])
        self.addCleanup(abandon, again)
        again.step(TIMES[ENTRY_STEP])
        return again

    def test_a_death_between_the_loss_and_its_expiry_or_the_checkpoint_changes_neither_orders_nor_money(self):
        for name in ("after", "equal", "before"):
            for point in ("between_loss_and_expiry", "after_declaration", "after_runner", "after_audit"):
                if name == "after" and point == "between_loss_and_expiry":
                    continue                                            # a cancellation has no expiry to die before
                with self.subTest(name=name, point=point):
                    session, flow = self.killed_between(name, point), self.cache[name]["session"]
                    self.assertEqual([(o["intent_id"], o["state"]) for o in session.runner.orders()],
                                     [(o["intent_id"], o["state"]) for o in flow.runner.orders()])
                    self.assertEqual(session.digests(), flow.digests())
                    self.assertEqual(session.runner.portfolio.snapshot(), flow.runner.portfolio.snapshot())
                    reasons = lambda sess: sorted((r["intent_id"], tuple(r["reasons"])) for r in sess.runner.executor.records     # noqa: E731
                                                  if r.get("status") == "rejected")
                    self.assertEqual(reasons(session), reasons(flow))
                    self.assertEqual([e["data"]["reason"] for e in session.runner.journal.entries if e["kind"] == "order_cancelled"],
                                     [e["data"]["reason"] for e in flow.runner.journal.entries if e["kind"] == "order_cancelled"])
                    mine, theirs = self.loss_audit(session), self.loss_audit(flow)
                    self.assertEqual([{k: v for k, v in r.items() if k != "declared_ms"} for r in mine],
                                     [{k: v for k, v in r.items() if k != "declared_ms"} for r in theirs])      # the declaration instant is the recovery's own if it died first
                    self.assertEqual(session.runner.integrity()["open_cycles"], [])


class TestOpenHolesOrder(unittest.TestCase):
    """What ``_open_holes`` declares and in which order (D-17-17), without a circuit: the pending orders and last quotes are given."""

    LIMIT = 15 * SEC

    def session(self, pending, last_quote):
        session = LI.LiveSession.__new__(LI.LiveSession)
        session.runner = SimpleNamespace(executor=SimpleNamespace(pending=pending))
        session.last_quote, session.max_quote_gap_ms = dict(last_quote), self.LIMIT
        session.calls = []
        session._declare = lambda product, gap, t_decl, trigger, pending: session.calls.append((product, gap["from_ms"], gap["to_ms"], t_decl, trigger))
        return session

    @staticmethod
    def order(product, deadline):
        return {"product_id": product, "side": "long", "timeline": {"deadline_ms": deadline, "earliest_fill_ms": 0}}

    def test_two_products_that_cross_in_one_step_are_declared_in_ascending_instant_then_product_order(self):
        pending = {"a": self.order(ETH, 10 ** 9), "b": self.order(BTC, 10 ** 9)}
        session = self.session(pending, {BTC: 30 * SEC, ETH: 20 * SEC})                      # ETH crosses first
        session._open_holes(90 * SEC)
        self.assertEqual(session.calls, [(ETH, 20 * SEC, 20 * SEC + self.LIMIT + 1, 20 * SEC + self.LIMIT + 1, "open_silence"),
                                         (BTC, 30 * SEC, 30 * SEC + self.LIMIT + 1, 30 * SEC + self.LIMIT + 1, "open_silence")])
        tie = self.session(pending, {BTC: 30 * SEC, ETH: 30 * SEC})
        tie._open_holes(90 * SEC)
        self.assertEqual([c[0] for c in tie.calls], sorted([BTC, ETH]))                      # same instant: by product id

    def test_events_that_do_not_pass_the_instant_declare_nothing_and_the_product_own_closing_quote_declares_first(self):
        pending = {"a": self.order(BTC, 10 ** 9)}
        session = self.session(pending, {BTC: 30 * SEC})
        session._open_holes(30 * SEC + self.LIMIT + 1)                                       # exactly at the instant: not later than it
        self.assertEqual(session.calls, [])
        session._open_holes(30 * SEC + self.LIMIT + 2)                                       # one millisecond later (a closing quote included): exceeded
        self.assertEqual([c[3] for c in session.calls], [30 * SEC + self.LIMIT + 1])         # declared at the instant, not at the event
        self.assertEqual(self.session({}, {BTC: 30 * SEC}).calls, [])

    def test_a_product_that_never_quoted_is_not_declared(self):
        session = self.session({"a": self.order(BTC, 10 ** 9)}, {})
        session._open_holes(10 ** 6)
        self.assertEqual(session.calls, [])


class TestTheLiteral26SecondCut(unittest.TestCase):
    """The regression as Fran named it: the quote that would fill the first order arrives 26 s after the previous one instead of
    20 s (the limit of the circuit is 25 s, the ingestor's own silence limit is 45 s)."""

    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        if cls.cache:
            return
        cls.cache["dir"] = root = tempfile.mkdtemp()
        strategies, _ = RS.load_frozen()
        for name, limit in (("cut", MAX_QUOTE_GAP_MS), ("loose", 10 ** 9)):
            where = os.path.join(root, name)
            os.makedirs(where)
            world = World(where, quote_moves=[(ENTRY_QUOTE_MS, ENTRY_QUOTE_MS + 6 * SEC)])        # 190 s -> 216 s: 26 s of silence
            world.release_until(LOAD_START)
            session = new_session(world, os.path.join(where, "s"), strategies, max_quote_gap_ms=limit)
            for now in TIMES[:ENTRY_STEP + 1]:
                world.release_until(now)
                session.step(now)
            cls.cache[name] = session
            cls.cache.setdefault("worlds", []).append(world)

    @classmethod
    def tearDownClass(cls):
        for name in ("cut", "loose"):
            if name in cls.cache:
                abandon(cls.cache.pop(name))
        for world in cls.cache.get("worlds", []):
            world.close()
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    def test_with_the_cancellation_the_order_is_cancelled_before_the_quote_and_never_fills(self):
        cut = self.cache["cut"]
        order = first_order(cut)
        end = ENTRY_QUOTE_MS + 6 * SEC
        self.assertEqual((order["state"], order["reasons"]), ("cancelled", ["source_stale"]))
        losses = [e for e in cut.runner.journal.entries if e["kind"] == "source_loss"]
        self.assertEqual([(l["data"]["gap_from_ms"], l["data"]["gap_to_ms"]) for l in losses], [(ENTRY_QUOTE_MS - 20 * SEC, ENTRY_QUOTE_MS - 20 * SEC + MAX_QUOTE_GAP_MS + 1)])
        quote_seq = next(e["seq"] for e in cut.runner.journal.entries if e["kind"] == "event_accepted" and e["data"]["event"]["kind"] == "quote"
                         and e["data"]["event"]["payload"]["time_ms"] == end)
        self.assertLess(losses[0]["seq"], quote_seq)
        self.assertEqual(cut.ingestor.outages, [])                                # 26 s is not a source outage for the ingestor

    def test_without_it_the_quote_after_the_26_seconds_fills_the_order(self):
        loose = self.cache["loose"]
        self.assertEqual(first_order(loose)["state"], "opened")
        self.assertEqual(first_order(loose)["timeline"]["entry_ms"], ENTRY_QUOTE_MS + 6 * SEC)


class TestSourceStaleTwoProductsInTheCircuit(unittest.TestCase):
    """The complete circuit (SourceReader -> Ingestor -> LiveEvaluator -> PaperRunner -> Journal) with two products: BTC loses a quote
    (the hole of the first class) while ETH keeps its own quotes. With ETH decided together with BTC (shift -3) its order is
    pending during the hole; with ETH decided five minutes earlier (shift 5) its position is already open, with its stop and
    target. The same world is run with the limit switched off as the reference: everything of ETH must be identical, and BTC is
    the only product whose order is cancelled."""

    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        if cls.cache:
            return
        cls.cache["dir"] = root = tempfile.mkdtemp()
        cls.cache["strategies"], _ = RS.load_frozen()
        for shift in (-3, 5):
            sessions = {}
            for name, limit in (("cut", MAX_QUOTE_GAP_MS), ("loose", 10 ** 9)):
                where = os.path.join(root, "w-{}-{}".format(shift, name))
                os.makedirs(where)
                world = World(where, quote_holes=[HOLE], second_product_shift=shift)
                world.release_until(LOAD_START)
                session = new_session(world, os.path.join(where, "s"), cls.cache["strategies"], max_quote_gap_ms=limit, products=(BTC, ETH))
                for now in TIMES[:ENTRY_STEP + 2]:
                    world.release_until(now)
                    session.step(now)
                sessions[name] = session
                cls.cache.setdefault("worlds", []).append(world)
            cls.cache[shift] = sessions

    @classmethod
    def tearDownClass(cls):
        for shift in (-3, 5):
            for session in cls.cache.pop(shift, {}).values():
                abandon(session)
        for world in cls.cache.get("worlds", []):
            world.close()
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    @staticmethod
    def orders(session, product, state=None):
        return [o for o in session.runner.orders() if o["product_id"] == product and (state is None or o["state"] == state)]

    @staticmethod
    def positions(session, product):
        return sorted((str(p.intent["side"]), str(p.intent["stop"]), str(p.intent["target"]), str(p.intent["intent_id"]))
                      for k, p in session.runner.portfolio.positions.items() if p.intent["product_id"] == product)

    def check(self, shift):
        cut, loose = self.cache[shift]["cut"], self.cache[shift]["loose"]
        # BTC: the order that waited in the hole is cancelled with the cause, and the position never opens
        self.assertEqual(self.orders(cut, BTC)[0]["state"], "cancelled")
        self.assertEqual(self.orders(cut, BTC)[0]["reasons"], ["source_stale"])
        waited = self.orders(cut, BTC)[0]["intent_id"]
        self.assertNotIn(waited, [p[3] for p in self.positions(cut, BTC)])           # a later signal may open one; this order never did
        self.assertIn(waited, [p[3] for p in self.positions(loose, BTC)])
        self.assertEqual(self.orders(loose, BTC)[0]["state"], "opened")           # the same hole, no limit: the quote fills it
        # ETH: nothing about it changes, in any order or position, nor in the journal (no loss declared for it)
        key = lambda o: {k: o[k] for k in ("state", "intent_id", "side", "reasons", "timeline")}          # noqa: E731
        self.assertEqual([key(o) for o in self.orders(cut, ETH)], [key(o) for o in self.orders(loose, ETH)])
        self.assertEqual(self.positions(cut, ETH), self.positions(loose, ETH))
        self.assertNotEqual(self.positions(cut, ETH), [])
        losses = [e["data"] for e in cut.runner.journal.entries if e["kind"] == "source_loss"]
        self.assertEqual([l["product_id"] for l in losses], [BTC])
        self.assertEqual([e["data"]["intent_id"] for e in cut.runner.journal.entries if e["kind"] == "order_cancelled"],
                         [self.orders(cut, BTC)[0]["intent_id"]])
        self.assertEqual([r["product_id"] for r in cut.audit.records() if r["kind"] == "source_loss"], [BTC])
        self.assertEqual(cut.runner.integrity()["open_cycles"], [])
        # the ingestor's evidence, as the session saw it: only BTC was silent, the source was alive (ETH kept quoting)
        detected = [r for r in cut.audit.records() if r["kind"] == "source_stale_detected"]
        self.assertEqual(len(detected), 1)
        self.assertEqual({k: detected[0]["ingestor"][k] for k in ("product_silence", "source_silence", "unexplained")},
                         {"product_silence": True, "source_silence": False, "unexplained": False})
        return cut

    def test_eth_pending_in_the_hole_of_btc_is_untouched(self):
        cut = self.check(-3)
        entry = self.orders(cut, ETH, "opened")[0]["timeline"]["entry_ms"]
        self.assertLess(entry, GAP_TO)                                     # ETH filled on its own quote, while BTC waited blind

    def test_eth_position_with_its_stop_is_untouched_by_the_hole_of_btc(self):
        cut = self.check(5)
        entry = self.orders(cut, ETH, "opened")[0]["timeline"]["entry_ms"]
        self.assertLess(entry, GAP_FROM)                                    # the position was open before the hole began


class TestSourceStaleInTheSessionWithTwoProducts(unittest.TestCase):
    """The same entry point (``LiveSession._deliver`` -> ``_continuity`` -> the runner's ``cancel_for_source_loss``) over a real
    ``PaperRunner`` that holds two products, one with a pending order and another with its own, and two open positions with
    their stops. The synthetic world of the circuit has one product, so these runner events are written by hand (the helpers of
    the runner's own recovery tests); what is under test is the session's wiring, not the strategies."""

    def scratch(self):
        path = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, path, True)
        return path

    def wired(self, events):
        """A session (so its real ``_deliver`` is used) whose runner is a fresh one fed with ``events`` first."""
        root = self.scratch()
        src = Source(os.path.join(root, "capture.sqlite"))
        src.db.executescript("CREATE TABLE synthetic_fundpct (product_id TEXT, start_ms INTEGER, rate REAL, arrival_ms INTEGER);"
                             "CREATE TABLE synthetic_accrual (product_id TEXT, start_ms INTEGER, end_ms INTEGER, rate TEXT, arrival_ms INTEGER);")
        src.commit()
        strategies, _ = RS.load_frozen()
        session = LI.LiveSession.create(os.path.join(root, "s"), src.path, strategies, (BTC,), runner_config(),
                                        decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW,
                                        max_quote_gap_ms=MAX_QUOTE_GAP_MS)
        session.runner.close()
        session.runner = PaperRunner.create(os.path.join(root, "hand"), RR.cfg(), RR.strategies())
        self.addCleanup(abandon, session)
        session.runner.run(events)
        return session

    def states(self, session):
        return {o["product_id"]: o["state"] for o in session.runner.orders()}

    def deliver_quote(self, session, product, t_ms, mid, offset):
        session._deliver("event", RR.quote(product, t_ms, mid, offset))

    def test_a_26_second_hole_cancels_only_the_product_that_waited_and_never_opens_the_position(self):
        session = self.wired([RR.cycle(RR.CYCLE + 2 * SEC, RR.BTC, 1), RR.cycle(RR.CYCLE + 3 * SEC, RR.ETH, 2)])
        self.assertEqual(self.states(session), {RR.BTC: "pending", RR.ETH: "pending"})
        session.last_quote[RR.BTC] = RR.CYCLE + 3 * SEC                       # the last quote of the product before the cut
        self.deliver_quote(session, RR.BTC, RR.CYCLE + 29 * SEC, "100010", 3)    # 26 s later
        self.assertEqual(self.states(session), {RR.BTC: "cancelled", RR.ETH: "pending"})       # the other product is intact
        self.assertEqual(len(session.runner.portfolio.positions), 0)                          # the position never opened
        session.flush_audit()
        cancelled = [o["intent_id"] for o in session.runner.orders() if o["product_id"] == RR.BTC]
        detected = [r for r in session.audit.records() if r["kind"] == "source_stale_detected"]
        self.assertEqual([(r["pending_hit"], r["product_id"]) for r in detected], [(cancelled, RR.BTC)])
        self.assertEqual([(r["cancelled"], r["product_id"]) for r in session.audit.records() if r["kind"] == "source_loss"], [(cancelled, RR.BTC)])
        self.assertEqual([o["reasons"] for o in session.runner.orders() if o["product_id"] == RR.BTC], [["source_stale"]])

    def test_the_same_hole_without_the_limit_lets_the_quote_fill_the_order(self):
        session = self.wired([RR.cycle(RR.CYCLE + 2 * SEC, RR.BTC, 1), RR.cycle(RR.CYCLE + 3 * SEC, RR.ETH, 2)])
        session.max_quote_gap_ms = 10 ** 9
        session.last_quote[RR.BTC] = RR.CYCLE + 3 * SEC
        self.deliver_quote(session, RR.BTC, RR.CYCLE + 29 * SEC, "100010", 3)
        self.assertEqual(self.states(session), {RR.BTC: "opened", RR.ETH: "pending"})
        self.assertEqual(len(session.runner.portfolio.positions), 1)

    def test_open_positions_and_their_stops_are_not_touched_by_a_hole(self):
        session = self.wired(RR.session()[:5])                                 # a long and a short, both open, with stops and targets
        runner = session.runner
        self.assertEqual(len(runner.portfolio.positions), 2)
        stops = lambda: sorted((k, str(p.intent["stop"]), str(p.intent["target"])) for k, p in runner.portfolio.positions.items())   # noqa: E731
        before, losses = stops(), len([e for e in runner.journal.entries if e["kind"] == "source_loss"])
        session.last_quote[RR.BTC] = RR.CYCLE + 5 * SEC
        self.deliver_quote(session, RR.BTC, RR.CYCLE + 40 * SEC, "100020", 20)          # a 35 s hole with positions only
        self.assertEqual(stops(), before)
        self.assertEqual(len(runner.portfolio.positions), 2)
        self.assertEqual(len([e for e in runner.journal.entries if e["kind"] == "source_loss"]), losses)     # nothing to cancel: no call
        self.assertEqual([r for r in session.audit.records() if r["kind"] in ("source_stale_detected", "source_stale_refused")], [])


if __name__ == "__main__":
    unittest.main()
