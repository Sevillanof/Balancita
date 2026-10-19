"""Issue #184: the cancellation of the order that waits in a hole of the source, seen from the session, on the real BTC market.

Decision D-10C-3 wired through the runner's ``cancel_for_source_loss``: a hole of the quotes (shorter than the ingestor's own 45 s
silence, longer than the 25 s limit of the circuit) in which the first forced order waits cancels it before the quote that ends the hole is
delivered. The hole is made by leaving out real quotes (``test_paper_safe_stop_186_session``: 39.5 s after the order's decision) and the
literal 26 s cut of the regression leaves out the real quotes between one and the first one 26 s later. Same limit switched off: that quote
fills the order. Replaces the classes ``TestSourceStaleCancellation`` and ``TestTheLiteral26SecondCut`` of the invented-world file."""

import os
import shutil
import tempfile
import unittest

from balancita_engine import paper_live_ingest as ING
from balancita_engine import signal_continuity as SC
from balancita_engine.paper_runner import RunnerError, make_event
from real_session import BUY_AT, DECIDE_FROM, MAX_QUOTE_GAP_MS, STEP, abandon, new_session, strategies
from real_world import BTC, MIN, SEC, RealWorld, quotes
from test_paper_safe_stop_186_session import ENTRY_STEP, HOLE, NOW, Base

DECIDED = BUY_AT[0] + 3_500                       # the instant the forced order is decided (the candle is known 3.4 s after the bucket)


def first_order(session):
    return session.runner.orders()[0]


def cancel_trace(session):
    entries = session.runner.journal.entries
    return {"source_loss": [e["data"] for e in entries if e["kind"] == "source_loss"],
            "cancelled": [(e["data"]["intent_id"], e["data"]["reason"]) for e in entries if e["kind"] == "order_cancelled"]}


def accepted_quotes(session):
    """The received times of the quotes the runner accepted, with their journal position (the session dates a quote by the time the
    capture received it)."""
    return [(e["seq"], e["data"]["event"]["payload"]["received_ms"]) for e in session.runner.journal.entries
            if e["kind"] == "event_accepted" and e["data"]["event"]["kind"] == "quote"]


def quote_seq(session, received_ms):
    return next(seq for seq, received in accepted_quotes(session) if received == received_ms)


def quote_times():
    """The received times of the real tickers, in arrival order."""
    return [q[2] for q in quotes()]


def hole_of_26_seconds():
    """The real quotes between the last one received by the decision and the first one 26 s after it are left out: 26.x s of silence."""
    times = quote_times()
    before = max(r for r in times if r <= DECIDED)
    after = min(r for r in times if r >= before + 26 * SEC)
    return (before + 1, after), before, after


def chain(directory, world, limit):
    """A session stepped on the 5-minute clock up to the instant before the order is decided (``ENTRY_STEP`` - 1), then once more at NOW."""
    session = new_session(world, directory, strategies(), max_quote_gap_ms=limit)
    for index in range(ENTRY_STEP):
        now = DECIDE_FROM + index * STEP
        world.release_until(now)
        session.step(now)
    world.release_until(NOW)
    session.step(NOW)
    return session


class Built(unittest.TestCase):
    """Sessions built once per class: ``name -> session`` in ``cache``."""

    cache = None
    builds = ()

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        cls.cache = {"dir": tempfile.mkdtemp(), "worlds": []}
        for name, holes, limit in cls.builds:
            where = os.path.join(cls.cache["dir"], name)
            os.makedirs(where)
            world = RealWorld(where, quote_holes=[holes])
            world.release_until(DECIDE_FROM - MIN)
            cls.cache["worlds"].append(world)
            cls.cache[name] = chain(os.path.join(where, "s"), world, limit)

    @classmethod
    def tearDownClass(cls):
        for name, _holes, _limit in cls.builds:
            abandon(cls.cache[name])
        for world in cls.cache["worlds"]:
            world.close()
        shutil.rmtree(cls.cache["dir"], True)
        cls.cache = None


class TestTheHoleOfThe39SecondsCancelsTheOrder(Built):
    builds = (("cut", HOLE, MAX_QUOTE_GAP_MS), ("loose", HOLE, 10 ** 9))

    def last_quote_before_the_hole(self, session):
        return max(received for _seq, received in accepted_quotes(session) if received <= HOLE[0])

    def test_the_hole_cancels_the_pending_order_before_the_quote_that_ends_it(self):
        session = self.cache["cut"]
        order = first_order(session)
        self.assertEqual((order["state"], order["reasons"]), ("cancelled", ["source_stale"]))
        entries = session.runner.journal.entries
        losses = [e for e in entries if e["kind"] == "source_loss"]
        cancels = [e for e in entries if e["kind"] == "order_cancelled" and e["data"]["reason"] == "source_stale"]
        self.assertEqual(len(losses), 1)
        self.assertEqual([c["data"]["intent_id"] for c in cancels], [order["intent_id"]])
        gap_from = self.last_quote_before_the_hole(session)
        self.assertEqual({k: losses[0]["data"][k] for k in ("product_id", "gap_from_ms", "gap_to_ms")},
                         {"product_id": BTC, "gap_from_ms": gap_from, "gap_to_ms": gap_from + MAX_QUOTE_GAP_MS + 1})       # D-174-01
        after = min(received for _seq, received in accepted_quotes(session) if received > gap_from)
        self.assertLess(cancels[0]["seq"], quote_seq(session, after))                    # before the quote that ends the hole was delivered
        self.assertLess(losses[0]["seq"], cancels[0]["seq"])
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "source_loss"][0]["cancelled"], [order["intent_id"]])

    def test_the_evidence_says_the_source_was_silent_and_the_ingestor_never_called_it_an_outage(self):
        session = self.cache["cut"]
        evidence = [r for r in session.audit.records() if r["kind"] == "source_stale_detected"]
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["pending_hit"], [first_order(session)["intent_id"]])
        self.assertEqual(sorted(evidence[0]["ingestor"]), ["data_gaps", "epoch_changes", "product_silence", "sample_capped",
                                                           "source_silence", "unexplained"])
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "source_stale_refused"], [])
        self.assertEqual({k: evidence[0]["ingestor"][k] for k in ("source_silence", "product_silence", "unexplained")},
                         {"source_silence": True, "product_silence": False, "unexplained": False})      # one product: the source itself was silent
        self.assertEqual(session.ingestor.outages, [])
        self.assertEqual(session.runner.integrity()["open_cycles"], [])

    def test_without_the_limit_the_first_quote_after_the_hole_fills_the_order(self):
        """The regression: the same hole, the limit switched off, and the order that waited blind is filled on the first quote after it."""
        loose = self.cache["loose"]
        order = first_order(loose)
        self.assertEqual(order["state"], "opened")
        self.assertEqual([e for e in loose.runner.journal.entries if e["kind"] == "source_loss"], [])
        self.assertEqual([r for r in loose.audit.records() if r["kind"] in ("source_stale_detected", "source_loss")], [])

    def test_nothing_else_changes_only_the_pending_order_of_the_hole_is_cancelled(self):
        session = self.cache["cut"]
        cancelled = [o for o in session.runner.orders() if o["state"] == "cancelled"]
        self.assertEqual([o["intent_id"] for o in cancelled], [first_order(session)["intent_id"]])
        self.assertEqual(len(session.runner.portfolio.positions), 0)

    def test_repeating_the_same_interval_cancels_nothing_more(self):
        session = self.cache["cut"]
        loss = cancel_trace(session)["source_loss"][0]
        before = (len(session.runner.journal.entries), cancel_trace(session), session.runner.state_digest())
        again = session.runner.cancel_for_source_loss(BTC, loss["gap_from_ms"], loss["gap_to_ms"], session.runner.clock, MAX_QUOTE_GAP_MS)
        self.assertEqual(again, [first_order(session)["intent_id"]])                        # declared already: any clock, no writes
        session.last_quote.clear()
        session.last_quote[BTC] = loss["gap_from_ms"]
        session._continuity(make_event("quote", {"product_id": BTC, "time_ms": loss["gap_to_ms"] + SEC, "received_ms": loss["gap_to_ms"] + SEC,
                                                 "bid": "1", "ask": "2"}, t_ms=loss["gap_to_ms"] + SEC, source=ING.SOURCE, stream="ticker:" + BTC),
                            session.runner.executor.pending)
        self.assertEqual((len(session.runner.journal.entries), cancel_trace(session), session.runner.state_digest()), before)


class TestTheLiteral26SecondCut(Built):
    """The regression as Fran named it: the quote that would fill the first order arrives 26 s after the previous one (the limit of the
    circuit is 25 s, the ingestor's own silence limit is 45 s)."""

    builds = (("cut", hole_of_26_seconds()[0], MAX_QUOTE_GAP_MS), ("loose", hole_of_26_seconds()[0], 10 ** 9))

    def test_with_the_cancellation_the_order_is_cancelled_before_the_quote_and_never_fills(self):
        cut = self.cache["cut"]
        _hole, before, after = hole_of_26_seconds()
        order = first_order(cut)
        self.assertEqual((order["state"], order["reasons"]), ("cancelled", ["source_stale"]))
        losses = [e for e in cut.runner.journal.entries if e["kind"] == "source_loss"]
        self.assertEqual(len(losses), 1)
        self.assertEqual(losses[0]["data"]["gap_to_ms"] - losses[0]["data"]["gap_from_ms"], MAX_QUOTE_GAP_MS + 1)
        self.assertLess(losses[0]["seq"], quote_seq(cut, after))
        self.assertEqual(cut.ingestor.outages, [])                                # 26 s is not a source outage for the ingestor

    def test_without_it_the_quote_after_the_26_seconds_fills_the_order(self):
        _hole, _before, after = hole_of_26_seconds()
        loose = first_order(self.cache["loose"])
        self.assertEqual(loose["state"], "opened")
        self.assertEqual(loose["timeline"]["entry_ms"], after)


class TestARecoveredSessionTakesTheLastQuoteFromTheRunner(Base):
    def test_the_hole_is_seen_from_the_runners_last_quote_not_from_what_the_dead_process_remembered(self):
        _world, _directory, session = self.fork()
        self.assertEqual(session.last_quote[BTC], max(received for _seq, received in accepted_quotes(session)))


class TestARefusedCancellationIsNeverRecordedAsApplied(Base):
    def test_the_runner_refuses_and_the_session_stops_without_recording_the_cancellation(self):
        world, _directory, session = self.fork()
        refused = []

        def refuse(*args):
            refused.append(args)
            raise RunnerError("source_loss_after_quote", "test")
        session.runner.cancel_for_source_loss = refuse
        with self.assertRaises(RunnerError):
            session.step(NOW)
        self.assertEqual(len(refused), 1)
        records = [r for r in session.audit.records() if r["kind"] == "source_stale_refused"]
        self.assertEqual([(r["applied"], r["reason"]) for r in records], [(False, "source_loss_after_quote")])
        self.assertEqual([r for r in session.audit.records() if r["kind"] == "source_loss"], [])
        self.assertEqual([e for e in session.runner.journal.entries if e["kind"] == "source_loss"], [])
        self.assertNotEqual(first_order(session)["state"], "opened")        # the quote that would have filled it was not delivered


if __name__ == "__main__":
    unittest.main()
