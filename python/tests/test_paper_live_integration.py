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
from balancita_engine.paper_runner import PaperRunner, RunnerConfig, make_event
from balancita_engine.paper_runner_store import JOURNAL_FILE, FileRunnerJournal
from balancita_engine.portfolio import PortfolioPolicy
from balancita_engine.portfolio_watch import WatchPolicy

from .live_world import (ACCRUAL_RATE, BTC, FIRST_DECISION, HOUR, LAST_DECISION, LOAD_START, MIN, SEC, WORLD_END, World)
from .test_paper_live_ingest import Source

D = Decimal
INGEST_KW = {"clock_every_ms": 10 ** 12}                 # no clock events: the independent reference has none either
PREFIX_BEFORE = 30 * MIN                                 # the warm-up snapshot is taken this long before the first decision
DOWNTIME_MS = 5 * MIN


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


def new_session(world, directory, strategies):
    return LI.LiveSession.create(directory, world.path, strategies, (BTC,), runner_config(), decide_from_ms=FIRST_DECISION,
                                 decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW)


def recover_session(world, directory, strategies, recovery_ms, **kw):
    return LI.LiveSession.recover(directory, world.path, strategies, (BTC,), runner_config(), recovery_ms,
                                  decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW, **kw)


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
    shutil.rmtree(Circuit.cache.get("dir", ""), True)
    Circuit.cache.clear()


class Circuit(unittest.TestCase):
    """One continuous reference run, a second run from the warm-up snapshot (with snapshots before each instant), shared."""

    cache = {}

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
        session = new_session(world, os.path.join(root, "a"), cache["strategies"])
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
        session_b = recover_session(world_b, os.path.join(root, "b"), cache["strategies"], journal_clock(os.path.join(root, "b")))
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
        session = recover_session(world, directory, self.strategies, journal_clock(directory))
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
                session = recover_session(world, directory, self.strategies, journal_clock(directory) + downtime)
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
        session = recover_session(world, directory, self.strategies, journal_clock(directory))
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
                    session = recover_session(world, directory, self.strategies, journal_clock(directory))
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

    def quote(self, t_ms):
        return make_event("quote", {"product_id": BTC, "time_ms": t_ms, "received_ms": t_ms, "bid": "99999.9", "ask": "100000.1"},
                          t_ms=t_ms, source=ING.SOURCE, stream="ticker:" + BTC)

    def test_the_session_records_a_pending_order_hit_by_a_26_second_hole_as_evidence_that_was_not_applied(self):
        """Plumbing at the session level with a scripted pending order (the executor is not touched): a 26 s cut, shorter than
        the ingestor's 45 s, is written to the audit journal before the quote that ends it reaches the runner."""
        root = self.scratch()
        src = Source(os.path.join(root, "capture.sqlite"))
        src.db.executescript("CREATE TABLE synthetic_fundpct (product_id TEXT, start_ms INTEGER, rate REAL, arrival_ms INTEGER);"
                             "CREATE TABLE synthetic_accrual (product_id TEXT, start_ms INTEGER, end_ms INTEGER, rate TEXT, arrival_ms INTEGER);")
        src.commit()
        session = LI.LiveSession.create(os.path.join(root, "s"), src.path, self.strategies, (BTC,), runner_config(),
                                        decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW)
        self.addCleanup(abandon, session)
        base = FIRST_DECISION + HOUR
        pending = {"intent-1": self.order(start=base + 20 * SEC, deadline=base + 80 * SEC)}
        for offset in (0, 5, 10, 36, 41):
            session._continuity(self.quote(base + offset * SEC), pending)
        stale = [r for r in session.audit.records() if r["kind"] == "source_stale_pending_order"]
        self.assertEqual(len(stale), 1)
        self.assertEqual(stale[0]["order"]["gap"], {"from_ms": base + 10 * SEC, "to_ms": base + 36 * SEC})
        self.assertEqual((stale[0]["applied"], stale[0]["reason"]), (False, "runner_cancel_entry_point_missing"))
        self.assertEqual(session.ingestor.outages, [])                           # the ingestor never called it an outage
        for offset in (0, 5, 10, 36, 41):                                          # the same evidence derived again is not written twice
            session.last_quote.clear()
            session._continuity(self.quote(base + offset * SEC), pending)
        self.assertEqual(len([r for r in session.audit.records() if r["kind"] == "source_stale_pending_order"]), 1)
        self.assertEqual([o for o in session.runner.orders() if o["state"] == "cancelled"], [])      # nothing was cancelled

    def test_a_regular_cadence_and_an_unrelated_product_produce_no_evidence(self):
        root = self.scratch()
        src = Source(os.path.join(root, "capture.sqlite"))
        src.db.executescript("CREATE TABLE synthetic_fundpct (product_id TEXT, start_ms INTEGER, rate REAL, arrival_ms INTEGER);"
                             "CREATE TABLE synthetic_accrual (product_id TEXT, start_ms INTEGER, end_ms INTEGER, rate TEXT, arrival_ms INTEGER);")
        src.commit()
        session = LI.LiveSession.create(os.path.join(root, "s"), src.path, self.strategies, (BTC,), runner_config(),
                                        decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW)
        self.addCleanup(abandon, session)
        base = FIRST_DECISION + HOUR
        pending = {"intent-1": self.order(start=base, deadline=base + 80 * SEC), "intent-2": self.order(product="PF_ETHUSD", start=base,
                                                                                                          deadline=base + 80 * SEC)}
        for offset in (0, 5, 10, 15, 20, 25):
            session._continuity(self.quote(base + offset * SEC), pending)
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "source_stale_pending_order"], [])


if __name__ == "__main__":
    unittest.main()
