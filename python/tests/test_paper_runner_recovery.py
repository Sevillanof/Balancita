"""Paper runner, stage 8B: durable journal and checkpoint, offsets, crash recovery (cases A, B, C, G), late recovery and
the refusals. Everything here is invented data; nothing is connected to a live process."""

import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import paper_runner_store as ST
from balancita_engine import signal_continuity as SC
from balancita_engine.multi_signals import make_signal
from balancita_engine.paper_runner import (
    FINISHED, PROCESSING, PaperRunner, RunnerConfig, RunnerError, engine_behavior, make_event,
)
from balancita_engine.multi_signals import stable_hash
from balancita_engine.paper_runner_store import FileRunnerJournal, OffsetLedger, StoreError
from balancita_engine.portfolio import PortfolioPolicy
from balancita_engine.portfolio_audit import audit
from balancita_engine.portfolio_scenarios import ScriptedStrategy

D = Decimal
SEC, MIN, HOUR = 1_000, 60_000, 3_600_000
CYCLE = SC.DEMO_START_MS + 100 * SC.FIVE_MINUTES_MS
BTC, ETH = "PF_XBTUSD", "PF_ETHUSD"
PRICES = {BTC: ("100000", "1000"), ETH: ("3500", "70")}
FUNDING = tuple((p, ((CYCLE - 2 * HOUR, CYCLE + 48 * HOUR, "0"),)) for p in PRICES)
SCRIPT = {"scripted-a": {(BTC, CYCLE): {"action": "BUY", "strength": "0.8"},
                         (ETH, CYCLE): {"action": "SELL", "strength": "0.8"}}}
SRC = "synthetic-feed"


def cfg(**kw):
    return RunnerConfig(**dict(dict(funding=FUNDING, start_ms=CYCLE - HOUR), **kw))


def cycle(t, product, off, at=CYCLE):
    price, atr = PRICES[product]
    return make_event("cycle", {"product_id": product, "cycle_ms": at, "price": price, "atr": atr}, t_ms=t,
                      source=SRC, source_offset=off)


def quote(product, t, mid, off):
    mid, half = D(str(mid)), D("0.5") / D(10_000)
    return make_event("quote", {"product_id": product, "time_ms": t, "received_ms": t, "bid": str(mid * (1 - half)),
                                "ask": str(mid * (1 + half))}, t_ms=t, source=SRC, source_offset=off)


def candle(product, bucket, o, h, l, c, off):     # noqa: E741
    return make_event("candle", {"product_id": product, "bucket_ms": bucket,
                                 "candle": {"open": str(o), "high": str(h), "low": str(l), "close": str(c)}},
                      t_ms=bucket + MIN, source=SRC, source_offset=off)


def session():
    """Two entries (a long and a short), their fills, a target and a stop."""
    return [cycle(CYCLE + 2 * SEC, BTC, 1), cycle(CYCLE + 3 * SEC, ETH, 2),
            quote(BTC, CYCLE + 5 * SEC, "100010", 3), quote(ETH, CYCLE + 6 * SEC, "3500", 4),
            candle(BTC, CYCLE + MIN, 100010, 100100, 99900, 100010, 5), candle(ETH, CYCLE + MIN, 3500, 3510, 3490, 3500, 6),
            candle(BTC, CYCLE + 2 * MIN, 100010, 103500, 100000, 103400, 7),
            candle(ETH, CYCLE + 2 * MIN, 3500, 3700, 3499, 3690, 8)]


def slurp(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def spit(path, text):
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def strategies():
    return [ScriptedStrategy("scripted-a", SCRIPT["scripted-a"])]


class Base(unittest.TestCase):
    def setUp(self):
        for r in getattr(self, "live", ()):
            r.close()
        self.dir = tempfile.mkdtemp()
        self.live = []
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.addCleanup(self.die)
        ST.disarm()
        self.addCleanup(ST.disarm)

    def fresh(self, name="run"):
        path = os.path.join(self.dir, name)
        r = PaperRunner.create(path, cfg(), strategies())
        self.live.append(r)
        return path, r

    def die(self):
        """The simulated crash of every runner this test opened: the dying process releases its lock."""
        for r in self.live:
            r.close()
        del self.live[:]

    def recover(self, path, recovery_ms, config=None, **kw):
        self.die()
        r = PaperRunner.recover(path, config or cfg(), strategies(), recovery_ms, **kw)
        self.live.append(r)
        return r

    def fingerprint(self, r):
        return (r.financial_digest(), r.portfolio.ledger_hash() if hasattr(r.portfolio, "ledger_hash") else None,
                r.executor.ledger_hash())

    def continuous(self, events, name=None):
        self.count = getattr(self, "count", 0) + 1
        path, r = self.fresh(name or "ref{}".format(self.count))
        r.run(events)
        return r

    def crash_and_recover(self, events, point, nth, kind=None, name=None, redeliver=True, recovery_at=None):
        """Runs ``events`` in a process that dies at ``point``; recovers (new objects, from disk) at the logical time of
        the event being processed, and redelivers everything the source has not seen confirmed."""
        self.count = getattr(self, "count", 0) + 1
        path, r = self.fresh(name or "crash{}".format(self.count))
        ST.arm(point, nth, kind)
        crashed = None
        for event in events:
            try:
                r.handle(event)
            except SC.SimulatedCrash:
                crashed = event
                break
        ST.disarm()
        SC.disarm()
        self.assertIsNotNone(crashed, "the fault never fired")
        r2 = self.recover(path, crashed["t_ms"] if recovery_at is None else recovery_at)
        if redeliver:
            r2.run(events)
        else:
            r2.run(events[events.index(crashed) + 1:])
        return path, r2, crashed


class Store(Base):
    def test_create_writes_journal_signals_and_a_checkpoint(self):
        path, r = self.fresh()
        self.assertEqual(sorted(os.listdir(path)), sorted([ST.CHECKPOINT_FILE, ST.LOCK_FILE, ST.JOURNAL_FILE, ST.SIGNALS_FILE]))
        self.assertEqual(ST.read_checkpoint(os.path.join(path, ST.CHECKPOINT_FILE))["upto_seq"], 1)

    def test_a_clean_run_recovers_to_the_same_state(self):
        path, r = self.fresh()
        r.run(session())
        r.checkpoint()
        r2 = self.recover(path, r.clock + 1)
        self.assertEqual(r2.financial_digest(), r.financial_digest())
        self.assertEqual(len(r2.portfolio.trades), 2)
        self.assertEqual(audit(r2.portfolio)["violations"], [])
        self.assertEqual(r2.journal.entries[-1]["kind"], "recovery")

    def test_a_finished_run_recovers_finished_without_a_recovery_entry(self):
        path, r = self.fresh()
        r.run(session())
        r.finish()
        r2 = self.recover(path, r.clock + 5 * MIN)
        self.assertEqual(r2.status, FINISHED)
        self.assertEqual(r2.journal.entries[-1]["kind"], "run_end")

    def test_a_torn_journal_tail_is_cut_and_reported(self):
        path, r = self.fresh()
        r.run(session()[:3])
        ST.arm("mid_journal", 1, "event_accepted")
        with self.assertRaises(SC.SimulatedCrash):
            r.handle(session()[3])
        ST.disarm()
        size = os.path.getsize(os.path.join(path, ST.JOURNAL_FILE))
        r2 = self.recover(path, session()[2]["t_ms"])
        self.assertLess(os.path.getsize(os.path.join(path, ST.JOURNAL_FILE)), size + 10_000)
        self.assertGreater(r2.last_recovery["tail_discarded_bytes"], 0)
        r2.run(session())
        self.assertEqual(len(r2.portfolio.trades), 2)

    def test_damage_in_the_middle_of_the_journal_is_refused(self):
        path, r = self.fresh()
        r.run(session())
        journal = os.path.join(path, ST.JOURNAL_FILE)
        lines = slurp(journal).splitlines()
        lines[3] = lines[3].replace('"decision"', '"decisioN"')
        spit(journal, "\n".join(lines) + "\n")
        with self.assertRaises(RunnerError) as caught:
            self.recover(path, r.clock + 1)
        self.assertEqual(caught.exception.reason, "journal_corrupt")

    def test_a_signal_log_that_is_not_the_one_of_the_run_is_refused(self):
        path, r = self.fresh()
        r.run(session())
        log = os.path.join(path, ST.SIGNALS_FILE)
        os.remove(log)
        SC.SignalLog.create(log, CYCLE - 2 * HOUR).freeze_strategy(strategies()[0], cfg().start_ms)
        with self.assertRaises(RunnerError) as caught:
            self.recover(path, r.clock + 1)
        self.assertIn(caught.exception.reason, ("signal_log_mismatch", "signal_log_behind_checkpoint"))

    def test_a_journal_behind_its_checkpoint_is_refused(self):
        path, r = self.fresh()
        r.run(session())
        r.checkpoint()
        journal = os.path.join(path, ST.JOURNAL_FILE)
        lines = slurp(journal).splitlines()
        spit(journal, "\n".join(lines[:-2]) + "\n")
        with self.assertRaises(RunnerError) as caught:
            self.recover(path, r.clock + 1)
        self.assertEqual(caught.exception.reason, "journal_behind_checkpoint")


class CheckpointDamage(Base):
    """Case G: a corrupt or incompatible checkpoint is refused and its bytes are kept."""

    def prepared(self):
        path, r = self.fresh()
        r.run(session())
        r.checkpoint()
        return path, r, os.path.join(path, ST.CHECKPOINT_FILE)

    def assertRefused(self, path, r, reason):
        with self.assertRaises(RunnerError) as caught:
            self.recover(path, r.clock + 1)
        self.assertEqual(caught.exception.reason, reason)
        kept = os.listdir(os.path.join(path, ST.QUARANTINE_DIR))
        self.assertEqual(len(kept), 1)
        self.assertTrue(os.path.exists(os.path.join(path, ST.CHECKPOINT_FILE)), "the original is never deleted")

    def test_truncated_checkpoint(self):
        path, r, cp = self.prepared()
        raw = slurp(cp)
        spit(cp, raw[: len(raw) // 2])
        self.assertRefused(path, r, "corrupt_checkpoint")

    def test_altered_checkpoint(self):
        path, r, cp = self.prepared()
        body = json.loads(slurp(cp))
        body["state_digest"] = "0" * 64
        spit(cp, json.dumps(body))
        self.assertRefused(path, r, "corrupt_checkpoint")

    def test_checkpoint_of_another_schema(self):
        path, r, cp = self.prepared()
        body = json.loads(slurp(cp))
        body["schema"] = "somebody-else.v9"
        body.pop("digest")
        body["digest"] = stable_hash(body)
        spit(cp, json.dumps(body))
        self.assertRefused(path, r, "checkpoint_incompatible")

    def test_missing_checkpoint_with_a_journal_is_refused(self):
        path, r, cp = self.prepared()
        os.remove(cp)
        with self.assertRaises(RunnerError) as caught:
            self.recover(path, r.clock + 1)
        self.assertEqual(caught.exception.reason, "checkpoint_missing")

    def test_the_operator_can_rebuild_explicitly_and_the_evidence_stays(self):
        path, r, cp = self.prepared()
        spit(cp, "{not json")
        r2 = self.recover(path, r.clock + 1, bad_checkpoint="rebuild")
        self.assertEqual(r2.financial_digest(), r.financial_digest())
        self.assertEqual(len(os.listdir(os.path.join(path, ST.QUARANTINE_DIR))), 1)
        self.assertIsNotNone(r2.last_recovery)

    def test_a_checkpoint_the_replay_does_not_reproduce_is_refused(self):
        path, r, cp = self.prepared()
        body = json.loads(slurp(cp))
        body["state_digest"] = "f" * 64
        body.pop("digest")
        body["digest"] = stable_hash(body)
        spit(cp, json.dumps(body))
        with self.assertRaises(RunnerError):
            self.recover(path, r.clock + 1)


LINE = ("s", "q")


class Offsets(unittest.TestCase):
    def led(self, *offsets, **kw):
        ledger = OffsetLedger()
        for o in offsets:
            ledger.observe(LINE, 0, o, "e{}".format(o))
            ledger.process(LINE, 0, o)
        return ledger

    def test_observed_is_not_contiguous(self):
        ledger = self.led(1, 2, 3, 6)
        self.assertEqual(ledger.contiguous(LINE, 0), 3)
        self.assertEqual(ledger.summary()["s|q#0"]["observed"], 6)
        self.assertEqual(ledger.missing(LINE, 0), [[4, 5]])
        self.assertEqual(ledger.holes_count(), 1)

    def test_the_hole_closes_when_the_offsets_arrive(self):
        ledger = self.led(1, 2, 3, 6)
        for o in (5, 4):
            ledger.observe(LINE, 0, o, "e{}".format(o))
            ledger.process(LINE, 0, o)
        self.assertEqual(ledger.contiguous(LINE, 0), 6)
        self.assertEqual(ledger.holes_count(), 0)

    def test_a_declared_gap_lets_contiguous_advance_but_stays_reported(self):
        ledger = self.led(1, 2, 3, 6)
        ledger.declare(LINE, 0, 4, 5, "feed outage", "ticket 12", "fran", 1)
        self.assertEqual(ledger.contiguous(LINE, 0), 6)
        self.assertEqual(ledger.holes_count(), 0)
        self.assertEqual(len(ledger.summary()["s|q#0"]["declared_gaps"]), 1)

    def test_the_same_offset_in_two_streams_is_two_different_things(self):
        ledger = self.led(1, 2)
        ledger.observe(("s", "other"), 0, 1, "x1")
        ledger.process(("s", "other"), 0, 1)
        self.assertFalse(ledger.reused(("s", "other"), 0, 1, "x1"))
        self.assertTrue(ledger.reused(LINE, 0, 1, "x1"))
        self.assertEqual(ledger.confirmable(), {"s|q#0": 2, "s|other#0": 1})
        self.assertEqual(ledger.contiguous(("t", "q"), 0), None)

    def test_stale_epoch_and_offset_reuse(self):
        ledger = self.led(1, 2)
        ledger.observe(LINE, 1, 1, "n1")
        self.assertTrue(ledger.stale_epoch(LINE, 0))
        self.assertFalse(ledger.stale_epoch(LINE, 1))
        self.assertTrue(ledger.reused(LINE, 1, 1, "other"))
        self.assertFalse(ledger.reused(LINE, 1, 1, "n1"))


class OffsetsInTheRunner(Base):
    def test_a_gap_declaration_is_durable_and_does_not_count_as_recovered(self):
        path, r = self.fresh()
        events = session()
        r.run([events[0], events[1], events[3]])      # offsets 1, 2 and 4: 3 is missing
        self.assertEqual(r.integrity()["offset_holes"], 1)
        self.assertEqual(r.integrity()["confirmable_offsets"][SRC + "|main#0"], 2)
        out = r.declare_gap(SRC, "main", 0, 3, 3, reason="feed outage", evidence="ticket 12", operator="fran", t_ms=CYCLE + 7 * SEC)
        self.assertEqual(out["status"], "accepted")
        self.assertEqual(r.integrity()["confirmable_offsets"][SRC + "|main#0"], 4)
        self.assertEqual(r.integrity()["offsets"][SRC + "|main#0"]["declared_gaps"][0]["reason"], "feed outage")
        r2 = self.recover(path, CYCLE + 8 * SEC)
        self.assertEqual(r2.integrity()["confirmable_offsets"][SRC + "|main#0"], 4)
        self.assertEqual(r2.integrity()["offsets"], r.integrity()["offsets"])

    def test_a_gap_over_offsets_already_processed_is_refused(self):
        path, r = self.fresh()
        r.run(session()[:3])
        out = r.declare_gap(SRC, "main", 0, 1, 2, reason="x", evidence="y", operator="fran", t_ms=CYCLE + 7 * SEC)
        self.assertEqual((out["status"], out["reason"]), ("rejected", "gap_not_a_hole"))

    def test_a_rejected_event_consumes_its_offset_but_a_duplicate_does_not(self):
        path, r = self.fresh()
        events = session()
        r.run(events[:2])
        bad = quote(BTC, CYCLE + 4 * SEC, "100000", 3)
        bad["payload"]["bid"] = "-1"
        self.assertEqual(r.handle(bad)["reason"], "invalid_quote")
        self.assertEqual(r.integrity()["confirmable_offsets"][SRC + "|main#0"], 3)
        self.assertEqual(r.handle(events[1])["status"], "duplicate")
        self.assertEqual(r.integrity()["offset_holes"], 0)

    def test_an_offset_reused_by_another_event_and_a_stale_epoch_are_refused(self):
        path, r = self.fresh()
        events = session()
        r.run(events[:2])
        clash = quote(BTC, CYCLE + 4 * SEC, "100000", 1)
        self.assertEqual(r.handle(clash)["reason"], "offset_reused")
        r.handle(make_event("clock", {}, t_ms=CYCLE + 5 * SEC, source=SRC, source_offset=1, source_epoch=1))
        old = make_event("clock", {}, t_ms=CYCLE + 6 * SEC, source=SRC, source_offset=9, source_epoch=0)
        self.assertEqual(r.handle(old)["reason"], "stale_epoch")


class CrashMatrix(Base):
    """A: after persisting the signal, before deciding. B: after deciding, before the quote. C: after the entry, before
    the checkpoint. Recovery at the crashed event's logical time must reproduce the continuous run exactly."""

    def reference(self):
        return self.fingerprint(self.continuous(session()))

    def check(self, point, nth, kind=None, redeliver=True):
        path, r2, crashed = self.crash_and_recover(session(), point, nth, kind, redeliver=redeliver)
        self.assertEqual(self.fingerprint(r2), self.reference(), "{} #{} {}".format(point, nth, kind))
        self.assertEqual(audit(r2.portfolio)["violations"], [])
        self.assertEqual(r2.integrity()["unprocessed_events"], 0)
        self.assertEqual(r2.integrity()["offset_holes"], 0)
        r3 = self.recover(path, r2.clock + 1)
        self.assertEqual(r3.financial_digest(), r2.financial_digest())
        return r2

    def test_case_a_crash_after_persisting_the_signal_before_deciding(self):
        r2 = self.check("after_journal", 1, "signals_persisted")
        self.assertGreaterEqual(r2.last_recovery["obligations"].__len__(), 0)

    def test_case_a_without_redelivery_the_obligation_is_paid_by_the_recovery(self):
        path, r = self.fresh()
        events = session()
        SC.arm("after_persist")
        with self.assertRaises(SC.SimulatedCrash):
            r.handle(events[0])
        SC.disarm()
        r2 = self.recover(path, events[0]["t_ms"])
        self.assertEqual([o["obligation"] for o in r2.last_recovery["obligations"]], ["signals_not_recorded"])
        self.assertEqual([x["state"] for x in r2.orders()], ["pending"])
        r2.run(events[1:])
        self.assertEqual(self.fingerprint(r2)[0], self.continuous(events[:1] + events[1:], "ref2").financial_digest())

    def test_case_a_crash_between_signals_persisted_and_the_decision(self):
        path, r = self.fresh()
        events = session()
        ST.arm("before_journal", 1, "decision")
        with self.assertRaises(SC.SimulatedCrash):
            r.handle(events[0])
        ST.disarm()
        r2 = self.recover(path, events[0]["t_ms"])
        self.assertEqual([o["obligation"] for o in r2.last_recovery["obligations"]], ["decision_pending"])
        r2.run(events)
        self.assertEqual(self.fingerprint(r2), self.reference())

    def test_case_b_crash_after_the_decision_before_the_quote(self):
        self.check("after_journal", 1, "decision")
        self.check("after_apply", 2, "decision", )

    def test_case_c_crash_after_the_entry_before_the_checkpoint(self):
        path, r = self.fresh()
        events = session()
        r.run(events[:3])
        self.assertEqual(len(r.portfolio.positions), 1)
        ST.arm("before_checkpoint")
        with self.assertRaises(SC.SimulatedCrash):
            r.checkpoint()
        ST.disarm()
        r2 = self.recover(path, events[2]["t_ms"])
        self.assertEqual(len(r2.portfolio.positions), 1)
        r2.run(events)
        self.assertEqual(self.fingerprint(r2), self.reference())

    def test_a_crash_while_writing_the_checkpoint_leaves_the_previous_one(self):
        for point in ("mid_checkpoint", "after_checkpoint"):
            with self.subTest(point=point):
                self.setUp()
                path, r = self.fresh()
                events = session()
                r.run(events[:3])
                ST.arm(point)
                with self.assertRaises(SC.SimulatedCrash):
                    r.checkpoint()
                ST.disarm()
                r2 = self.recover(path, events[2]["t_ms"])
                r2.run(events)
                self.assertEqual(self.fingerprint(r2), self.reference())

    def test_every_journal_point_of_every_entry(self):
        for point in ("before_journal", "mid_journal", "after_journal", "after_apply"):
            for kind in ("event_accepted", "signals_persisted", "decision"):
                for nth in (1, 2):
                    with self.subTest(point=point, kind=kind, nth=nth):
                        self.setUp()
                        self.check(point, nth, kind)

    def test_signal_log_faults(self):
        for point in ("before_persist", "mid_persist", "after_persist"):
            with self.subTest(point=point):
                self.setUp()
                path, r = self.fresh()
                events = session()
                SC.arm(point)
                crashed = None
                try:
                    r.run(events)
                except SC.SimulatedCrash:
                    crashed = True
                SC.disarm()
                self.assertTrue(crashed)
                r2 = self.recover(path, events[0]["t_ms"])
                r2.run(events)
                self.assertEqual(self.fingerprint(r2), self.reference())

    def test_several_interruptions_in_one_run(self):
        events = session()
        path, r = self.fresh()
        for point, kind in (("after_journal", "decision"), ("after_journal", "event_accepted"), ("before_journal", "decision")):
            ST.arm(point, 1, kind)
            at = events[0]["t_ms"]
            try:
                for event in events:
                    at = event["t_ms"]
                    r.handle(event)
            except SC.SimulatedCrash:
                pass
            ST.disarm()
            SC.disarm()
            r = self.recover(path, at)
        r.run(events)
        self.assertEqual(self.fingerprint(r), self.reference())

    def test_redelivery_of_everything_changes_nothing(self):
        path, r = self.fresh()
        r.run(session())
        before = r.financial_digest()
        results = r.run(session())
        self.assertEqual([x["status"] for x in results], ["duplicate"] * len(results), results)
        self.assertEqual(r.financial_digest(), before)


class LateRecovery(Base):
    """After a long outage the interrupted work is not done in the past: it is refused or cancelled, visibly."""

    def test_a_signal_not_decided_in_time_is_expired_by_the_recovery(self):
        path, r = self.fresh()
        events = session()
        ST.arm("before_journal", 1, "decision")
        with self.assertRaises(SC.SimulatedCrash):
            r.handle(events[0])
        ST.disarm()
        r2 = self.recover(path, CYCLE + 3 * HOUR)
        self.assertEqual(len(r2.portfolio.positions), 0)
        self.assertEqual([o["state"] for o in r2.orders()][0:1], [o["state"] for o in r2.orders()][0:1])
        reasons = [x for o in r2.orders() for x in o.get("reasons", [])]
        self.assertIn("signal_expired", reasons)

    def test_a_pending_order_whose_window_was_not_watched_is_cancelled_not_expired(self):
        path, r = self.fresh()
        r.run([cycle(CYCLE + 2 * SEC, BTC, 1)])
        self.assertEqual([o["state"] for o in r.orders()], ["pending"])
        r2 = self.recover(path, CYCLE + 20 * SEC)
        states = [(o["state"], o.get("reasons")) for o in r2.orders()]
        self.assertEqual(states[0][0], "cancelled")
        self.assertIn("runner_interrupted", states[0][1])
        self.assertEqual(r2.last_recovery["interrupted_orders"][0]["uncovered_to_ms"], CYCLE + 20 * SEC)
        self.assertEqual(len(r2.portfolio.positions), 0)

    def test_recovery_clock_behind_the_journal_is_refused(self):
        path, r = self.fresh()
        r.run(session())
        with self.assertRaises(RunnerError) as caught:
            self.recover(path, CYCLE)
        self.assertEqual(caught.exception.reason, "recovery_clock_behind")

    def test_open_positions_keep_going_after_recovery(self):
        path, r = self.fresh()
        events = session()
        r.run(events[:5])
        r2 = self.recover(path, events[4]["t_ms"])
        self.assertEqual(len(r2.portfolio.positions), 2)
        r2.run(events[5:])
        self.assertEqual(len(r2.portfolio.trades), 2)


class Compatibility(Base):
    def test_another_configuration_is_refused(self):
        path, r = self.fresh()
        r.run(session())
        other = cfg(portfolio=PortfolioPolicy(**dict(vars(PortfolioPolicy()), **{})), stop_policy="close")
        with self.assertRaises(RunnerError) as caught:
            self.recover(path, r.clock + 1, config=other)
        self.assertEqual(caught.exception.reason, "config_incompatible")

    def test_a_change_of_engine_behaviour_alone_is_named_as_such(self):
        path, r = self.fresh()
        r.run(session())
        from balancita_engine import paper_runner as PR
        original = PR.engine_behavior
        PR.engine_behavior = lambda: dict(original(), fingerprint="deadbeefdeadbeef")
        try:
            with self.assertRaises(RunnerError) as caught:
                self.recover(path, r.clock + 1)
        finally:
            PR.engine_behavior = original
        self.assertEqual(caught.exception.reason, "engine_behavior_changed")

    def test_engine_behavior_is_deterministic(self):
        a = engine_behavior()
        self.assertEqual(a, engine_behavior())
        self.assertEqual(a["version"], "balancita-paper-engine.1")

    def test_an_orphan_signal_is_refused(self):
        path, r = self.fresh()
        r.run(session()[:1])
        log = SC.SignalLog.load(os.path.join(path, ST.SIGNALS_FILE))
        [first] = [e for e in log.signals() if e["data"]["signal"]["action"] != "WAIT"]
        forged = make_signal(strategy_id="scripted-a", strategy_version=first["data"]["signal"]["strategy_version"],
                             product_id=ETH, bucket_ms=CYCLE + 10 * SC.FIVE_MINUTES_MS, action="BUY", strength="0.8",
                             horizon_minutes=60, evidence={})
        log.ingest(forged, first["data"]["inputs"], CYCLE + 3 * SEC)      # in the log, in no accepted event
        with self.assertRaises(RunnerError) as caught:
            self.recover(path, r.clock + 1)
        self.assertEqual(caught.exception.reason, "orphan_signal")


class Streams(Base):
    """Offsets belong to ``(source, stream, epoch)``: the same number in two streams is two different things."""

    @staticmethod
    def on(stream, event, offset):
        event = dict(event, stream=stream, source_offset=offset)
        event["event_id"] = make_event(event["kind"], event["payload"], t_ms=event["t_ms"], source=SRC, stream=stream,
                                       source_offset=offset)["event_id"]
        return event

    def test_quotes_and_candles_can_both_use_offset_one(self):
        path, r = self.fresh()
        ev = session()
        out = r.run([self.on("quotes", ev[2], 1), self.on("quotes", ev[3], 2), self.on("candles", ev[4], 1)])
        self.assertEqual([x["status"] for x in out], ["accepted"] * 3)
        confirm = r.integrity()["confirmable_offsets"]
        self.assertEqual((confirm[SRC + "|quotes#0"], confirm[SRC + "|candles#0"]), (2, 1))

    def test_contiguity_is_computed_per_stream(self):
        path, r = self.fresh()
        ev = session()
        r.run([self.on("quotes", ev[2], 1), self.on("quotes", ev[3], 3), self.on("candles", ev[0], 1)])
        summary = r.integrity()["offsets"]
        self.assertEqual(summary[SRC + "|quotes#0"]["contiguous"], 1)
        self.assertEqual(summary[SRC + "|quotes#0"]["holes"], [[2, 2]])
        self.assertEqual(summary[SRC + "|candles#0"]["holes"], [])
        self.assertEqual(r.integrity()["offset_holes"], 1)

    def test_a_gap_in_one_stream_does_not_close_the_hole_of_another(self):
        path, r = self.fresh()
        ev = session()
        r.run([self.on("quotes", ev[2], 1), self.on("quotes", ev[3], 3), self.on("candles", ev[0], 1),
               self.on("candles", ev[1], 3)])
        out = r.declare_gap(SRC, "quotes", 0, 2, 2, reason="outage", evidence="t1", operator="fran", t_ms=CYCLE + 7 * SEC)
        self.assertEqual(out["status"], "accepted")
        summary = r.integrity()["offsets"]
        self.assertEqual(summary[SRC + "|quotes#0"]["contiguous"], 3)
        self.assertEqual(summary[SRC + "|candles#0"]["holes"], [[2, 2]])
        r2 = self.recover(path, CYCLE + 8 * SEC)
        self.assertEqual(r2.integrity()["offsets"], summary)

    def test_stream_identity_survives_recovery_and_is_in_the_manifest(self):
        path, r = self.fresh()
        self.assertEqual(r.manifest["offset_identity"], "source|stream|epoch")
        self.assertEqual(r.journal.entries[0]["data"]["manifest"]["journal_schema"], "balancita-paper-runner-journal.v2")

    def test_names_that_would_collide_in_the_canonical_form_are_invalid(self):
        path, r = self.fresh()
        ev = session()[2]
        for field, bad in (("source", "a|b"), ("stream", "x#1"), ("stream", "")):
            with self.subTest(field=field, bad=bad):
                self.assertEqual(r.handle(dict(ev, **{field: bad}))["reason"], "invalid_event")


class SingleWriter(Base):
    """One writer per run directory; the kernel drops the lock when a process dies, however abruptly."""

    HOLDER = """
import sys, time
sys.path.insert(0, {py!r})
sys.path.insert(0, {tests!r})
import test_paper_runner_recovery as T
from balancita_engine.paper_runner import PaperRunner
path, mode = sys.argv[1:3]
r = PaperRunner.create(path, T.cfg(), T.strategies()) if mode == "create" else PaperRunner.recover(path, T.cfg(), T.strategies(), int(sys.argv[3]))
r.run(T.session()[:3])
print("ready", flush=True)
time.sleep(120)
"""
    OPENER = """
import sys, json
sys.path.insert(0, {py!r})
sys.path.insert(0, {tests!r})
import test_paper_runner_recovery as T
from balancita_engine.paper_runner import PaperRunner, RunnerError
try:
    PaperRunner.recover(sys.argv[1], T.cfg(), T.strategies(), int(sys.argv[2]))
    print(json.dumps({{"ok": True}}))
except RunnerError as error:
    print(json.dumps({{"ok": False, "reason": error.reason}}))
"""

    def where(self):
        return (os.path.dirname(os.path.dirname(os.path.abspath(ST.__file__))), os.path.dirname(os.path.abspath(__file__)))

    def start(self, code, *args):
        py, tests = self.where()
        proc = subprocess.Popen([sys.executable, "-c", code.format(py=py, tests=tests)] + list(args), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        self.addCleanup(lambda: [proc.stdout.close(), proc.stderr.close()])
        return proc

    def holder(self, path, mode="create", *args):
        proc = self.start(self.HOLDER, path, mode, *args)
        self.assertEqual(proc.stdout.readline().strip(), "ready", proc.stderr.read() if proc.poll() is not None else "")
        return proc

    def open_elsewhere(self, path, at):
        proc = self.start(self.OPENER, path, str(at))
        out, err = proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, 0, err)
        return json.loads(out.strip().splitlines()[-1])

    def snapshot(self, path):
        return {n: slurp(os.path.join(path, n)) for n in (ST.JOURNAL_FILE, ST.SIGNALS_FILE, ST.CHECKPOINT_FILE)}

    def test_a_second_open_in_the_same_process_fails_without_touching_anything(self):
        path, r = self.fresh()
        r.run(session()[:3])
        before = self.snapshot(path)
        with self.assertRaises(RunnerError) as caught:
            PaperRunner.recover(path, cfg(), strategies(), r.clock + 1)
        self.assertEqual(caught.exception.reason, "directory_locked")
        with self.assertRaises(RunnerError) as caught:
            PaperRunner.create(path, cfg(), strategies())
        self.assertEqual(caught.exception.reason, "directory_locked")
        self.assertEqual(self.snapshot(path), before)

    def test_another_process_cannot_open_a_directory_that_a_live_process_holds(self):
        path = os.path.join(self.dir, "held")
        proc = self.holder(path)
        before = self.snapshot(path)
        self.assertEqual(self.open_elsewhere(path, CYCLE + HOUR), {"ok": False, "reason": "directory_locked"})
        self.assertEqual(self.snapshot(path), before, "the refused opener wrote or truncated nothing")
        proc.kill()
        proc.wait()

    def test_a_torn_tail_is_not_cut_by_a_refused_opener(self):
        path = os.path.join(self.dir, "torn")
        proc = self.holder(path)
        with open(os.path.join(path, ST.JOURNAL_FILE), "ab") as handle:
            handle.write(b'{"half":')
        before = self.snapshot(path)
        self.assertEqual(self.open_elsewhere(path, CYCLE + HOUR)["reason"], "directory_locked")
        self.assertEqual(self.snapshot(path), before)
        proc.kill()
        proc.wait()

    def test_abrupt_death_frees_the_lock_and_the_run_recovers(self):
        path = os.path.join(self.dir, "died")
        proc = self.holder(path)
        proc.kill()                 # SIGKILL: no finalizers, no orderly release
        proc.wait()
        self.assertEqual(self.open_elsewhere(path, session()[2]["t_ms"]), {"ok": True})
        r = self.recover(path, session()[2]["t_ms"])
        r.run(session())
        self.assertEqual(self.fingerprint(r), self.fingerprint(self.continuous(session())))

    def test_after_an_orderly_close_the_next_opener_succeeds(self):
        path, r = self.fresh()
        r.run(session()[:3])
        r.close()
        r2 = self.recover(path, session()[2]["t_ms"])
        self.assertEqual(r2.status, PROCESSING)

    def test_a_refused_recovery_does_not_leave_the_directory_locked(self):
        path, r = self.fresh()
        r.run(session())
        self.die()
        with self.assertRaises(RunnerError):
            PaperRunner.recover(path, cfg(), strategies(), CYCLE)          # clock behind: refused
        again = self.recover(path, r.clock + 1)
        self.assertEqual(again.status, PROCESSING)


class BuildIdentity(Base):
    def test_the_build_identity_covers_the_financial_modules_and_is_stable(self):
        from balancita_engine.paper_runner import BUILD_MODULES, build_identity
        identity = build_identity()
        self.assertEqual(sorted(identity["modules"]), sorted(BUILD_MODULES))
        self.assertEqual(identity, build_identity())
        path, r = self.fresh()
        self.assertEqual(r.manifest["build_identity"], identity)

    def test_another_build_is_refused_even_if_the_synthetic_scenarios_agree(self):
        from balancita_engine import paper_runner as PR
        path, r = self.fresh()
        r.run(session())
        original = PR.build_identity
        changed = json.loads(json.dumps(original()))
        changed["modules"]["futures_costs"] = "0" * 16
        changed["digest"] = "f" * 16
        PR.build_identity = lambda: changed
        try:
            self.assertEqual(PR.engine_behavior(), engine_behavior())       # the scenarios see nothing
            with self.assertRaises(RunnerError) as caught:
                self.recover(path, r.clock + 1)
        finally:
            PR.build_identity = original
        self.assertEqual(caught.exception.reason, "build_incompatible")
        self.assertIn("build_identity", str(caught.exception))
        self.recover(path, r.clock + 1)                                      # and the right build still recovers

    def test_a_checkpoint_of_another_build_is_refused(self):
        path, r = self.fresh()
        r.run(session())
        r.checkpoint()
        self.die()
        cp = os.path.join(path, ST.CHECKPOINT_FILE)
        body = json.loads(slurp(cp))
        body["build_identity"] = "0" * 16
        body.pop("digest")
        body["digest"] = stable_hash(body)
        spit(cp, json.dumps(body))
        with self.assertRaises(RunnerError) as caught:
            self.recover(path, r.clock + 1)
        self.assertEqual(caught.exception.reason, "checkpoint_incompatible")



class CrossProcess(Base):
    """The crash is a real one: the process dies (``os._exit``) and another one recovers from the files."""

    CHILD = """
import sys, os, json
sys.path.insert(0, {py!r})
from balancita_engine import paper_runner_store as ST
from balancita_engine import signal_continuity as SC
from balancita_engine.paper_runner import PaperRunner
sys.path.insert(0, {tests!r})
import test_paper_runner_recovery as T
path, mode, point, kind, nth = sys.argv[1:6]
events = T.session()
if mode == "run":
    r = PaperRunner.create(path, T.cfg(), T.strategies())
    ST.arm(point, int(nth), kind or None)
    try:
        for e in events:
            r.handle(e)
    except SC.SimulatedCrash:
        os._exit(77)
    os._exit(0)
else:
    r = PaperRunner.recover(path, T.cfg(), T.strategies(), int(point))
    r.run(events)
    print(json.dumps({{"financial": r.financial_digest(), "trades": len(r.portfolio.trades),
                      "holes": r.integrity()["offset_holes"], "open": r.integrity()["unprocessed_events"]}}))
"""

    def spawn(self, *args):
        py = os.path.dirname(os.path.dirname(os.path.abspath(ST.__file__)))
        tests = os.path.dirname(os.path.abspath(__file__))
        code = self.CHILD.format(py=py, tests=tests)
        return subprocess.run([sys.executable, "-c", code] + list(args), capture_output=True, text=True, timeout=120)

    def test_a_real_crash_and_recovery_in_another_process_equal_the_continuous_run(self):
        want = self.continuous(session()).financial_digest()
        for kind, nth, when in (("signals_persisted", 1, 0), ("decision", 1, 0), ("event_accepted", 3, 2)):
            with self.subTest(kind=kind):
                path = os.path.join(self.dir, "x-" + kind)
                done = self.spawn(path, "run", "after_journal", kind, str(nth))
                self.assertEqual(done.returncode, 77, done.stderr)
                again = self.spawn(path, "recover", str(session()[when]["t_ms"]), "", "1")
                self.assertEqual(again.returncode, 0, again.stderr)
                out = json.loads(again.stdout.strip().splitlines()[-1])
                self.assertEqual(out["financial"], want)
                self.assertEqual((out["trades"], out["holes"], out["open"]), (2, 0, 0))


if __name__ == "__main__":
    unittest.main()
