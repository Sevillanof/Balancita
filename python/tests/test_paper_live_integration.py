"""Stage 10D: what is left on the synthetic capture-shaped database (adapter and evidence, source-stale cancellation, silence, two
products). The circuit itself (financial, faults at every boundary, clock, real process death, identity) runs on the real BTC market in
``test_paper_live_circuit_184``.

    SQLite -> SourceReader -> Ingestor -> LiveEvaluator -> PaperRunner -> Portfolio -> journals -> recovery

Invented data only: the 9A fixture's minute candles, deterministic bid/ask around them and two separate funding tables. No real
database, no network, no wall clock, no persistent process. The frozen strategies C29/C30/C32 run through the shared 9A pipeline;
nothing financial is implemented here."""

import os
import shutil
import tempfile
import unittest
from decimal import Decimal
from types import SimpleNamespace

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

import test_paper_runner_recovery as RR
import live_world as LW
from live_world import (BTC, ETH, FIRST_DECISION, HOUR, LAST_DECISION, LOAD_START, MIN, SEC, WORLD_END, World)
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
    return LI.LiveSession.create(directory, world.path, strategies, products, runner_config(), decide_from_ms=FIRST_DECISION, source_id="synthetic", funding_mode="observed",
                                 decide_until_ms=LAST_DECISION, ingest_kw=ingest_kw, max_quote_gap_ms=max_quote_gap_ms)


def recover_session(world, directory, strategies, recovery_ms, ingest_kw=INGEST_KW, products=(BTC,), **kw):
    return LI.LiveSession.recover(directory, world.path, strategies, products, runner_config(), recovery_ms,
                                  decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION, ingest_kw=ingest_kw,
                                  **dict({"max_quote_gap_ms": MAX_QUOTE_GAP_MS, "source_id": "synthetic", "funding_mode": "observed"}, **kw))


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


def take_snapshot(root, name, session, world, next_index):
    target = os.path.join(root, "snap-" + name)
    os.makedirs(target)
    shutil.copytree(session.directory, os.path.join(target, "session"))
    return {"session": os.path.join(target, "session"), "world": world.snapshot(target), "index": next_index}


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
        self.src.db.executescript(LW.FUNDING_TABLES)
        self.src.commit()

    def session(self, **kw):
        return LI.LiveSession.create(os.path.join(self.dir, "s"), self.path, self.strategies, (BTC,), runner_config(),
                                     decide_from_ms=FIRST_DECISION, decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW,
                                     **dict({"source_id": "synthetic", "funding_mode": "observed"}, **kw))

    def recover(self, **kw):
        return LI.LiveSession.recover(os.path.join(self.dir, "s"), self.path, self.strategies, (BTC,), runner_config(),
                                      journal_clock(os.path.join(self.dir, "s")), decide_from_ms=FIRST_DECISION,
                                      decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW,
                                      **dict({"source_id": "synthetic", "funding_mode": "observed"}, **kw))

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
        cls.cache["snap"] = take_snapshot(root, "silent", session, world, ENTRY_STEP)
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
        cls.cache["mute"] = {"world": mute, "snap": take_snapshot(where, "mute", quiet, mute, ENTRY_STEP)}
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
        src.db.executescript(LW.FUNDING_TABLES)
        src.commit()
        strategies, _ = RS.load_frozen()
        session = LI.LiveSession.create(os.path.join(root, "s"), src.path, strategies, (BTC,), runner_config(),
                                        decide_from_ms=FIRST_DECISION, source_id="synthetic", funding_mode="observed", decide_until_ms=LAST_DECISION, ingest_kw=INGEST_KW,
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
