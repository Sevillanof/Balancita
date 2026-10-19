"""Issue #184: the same silence of the source with the limit just under, exactly at and just over the order's deadline, in the complete
circuit, on the real BTC market (Fran 16:07Z and 17:48Z).

The first forced order is decided 3.4 s after the bucket closes and lives 120 s. The real quotes of the next 135 s are left out, so the
source is silent past the deadline. ``deadline <= last quote + limit`` expires the order with the executor's own reason; later it is
cancelled by ``source_stale``. The audit keeps the cancelled and the expired apart, with the threshold, the interval and the instant of
the declaration, and a death between ``source_loss`` and ``source_loss_expiry`` or between the declaration and the checkpoint leaves the
same orders, reasons and money as the continuous run. Replaces ``TestDeadlineAgainstTheThreshold`` of the invented-world file."""

import os
import shutil
import tempfile
import unittest

from balancita_engine import signal_continuity as SC
from real_session import BUY_AT, DECIDE_FROM, STEP, abandon, journal_clock, new_session, recover_session, strategies
from real_world import MIN, SEC, RealWorld, candles, quotes
from test_paper_safe_stop_186_session import ENTRY_STEP, NOW

DECIDED_AT = next(c["known_at"] for c in candles() if c["bucket_start"] == BUY_AT[0] - MIN)      # the minute candle that decides the order
ORDER_DEADLINE = DECIDED_AT + 120 * SEC
HOLE = (BUY_AT[0] + 3_500, BUY_AT[0] + 3_500 + 135 * SEC)                                          # the source is silent past the deadline
GAP_FROM = max(q[2] for q in quotes() if q[2] <= HOLE[0])                                         # the last quote the session got before it
LIMITS = {"after": ORDER_DEADLINE - GAP_FROM - 1, "equal": ORDER_DEADLINE - GAP_FROM, "before": ORDER_DEADLINE - GAP_FROM + 1}


class Killed(Exception):
    """The process dies right here (the session is abandoned as it is: nothing is flushed)."""


def first_order(session):
    return session.runner.orders()[0]


def loss_audit(session):
    return [r for r in session.audit.records() if r["kind"] == "source_loss"]


class TestDeadlineAgainstTheThreshold(unittest.TestCase):
    cache = None

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        cls.cache = {"dir": tempfile.mkdtemp(), "strategies": strategies()}
        for name, limit in LIMITS.items():
            where = os.path.join(cls.cache["dir"], name)
            os.makedirs(where)
            world = RealWorld(where, quote_holes=[HOLE])
            world.release_until(DECIDE_FROM - MIN)
            session = new_session(world, os.path.join(where, "a"), cls.cache["strategies"], max_quote_gap_ms=limit)
            for index in range(ENTRY_STEP):
                now = DECIDE_FROM + index * STEP
                world.release_until(now)
                session.step(now)
            target = os.path.join(where, "snap")
            os.makedirs(target)
            shutil.copytree(session.directory, os.path.join(target, "session"))
            snap = {"session": os.path.join(target, "session"), "world": world.snapshot(target)}
            world.release_until(NOW)
            session.step(NOW)
            cls.cache[name] = {"world": world, "session": session, "snap": snap, "limit": limit}

    @classmethod
    def tearDownClass(cls):
        for name in LIMITS:
            abandon(cls.cache[name]["session"])
            cls.cache[name]["world"].close()
        shutil.rmtree(cls.cache["dir"], True)
        cls.cache = None

    def test_the_order_decided_by_the_real_candle_lives_120_seconds(self):
        order = first_order(self.cache["after"]["session"])
        self.assertEqual((order["timeline"]["decided_ms"], order["timeline"]["deadline_ms"]), (DECIDED_AT, ORDER_DEADLINE))

    def test_the_limit_just_under_the_deadline_cancels_by_source_stale(self):
        item = self.cache["after"]
        session, limit = item["session"], item["limit"]
        order = first_order(session)
        self.assertEqual(order["state"], "cancelled")
        audit = loss_audit(session)
        self.assertEqual(len(audit), 1)
        self.assertEqual((audit[0]["cancelled"], audit[0]["expired"], audit[0]["expired_reasons"], audit[0]["threshold_ms"]),
                         ([order["intent_id"]], [], {}, limit))
        self.assertEqual(audit[0]["gap"], {"from_ms": GAP_FROM, "to_ms": GAP_FROM + limit + 1})
        self.assertIsNotNone(audit[0]["declared_ms"])

    def test_a_deadline_at_or_before_the_limit_expires_with_the_executors_reason_and_is_never_a_source_cancellation(self):
        for name in ("equal", "before"):
            with self.subTest(name=name):
                item = self.cache[name]
                session, limit = item["session"], item["limit"]
                order = first_order(session)
                self.assertEqual(order["state"], "expired")
                entries = session.runner.journal.entries
                self.assertEqual([e for e in entries if e["kind"] == "order_cancelled"], [])
                self.assertEqual(len([e for e in entries if e["kind"] == "source_loss_expiry"]), 1)
                audit = loss_audit(session)
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
        world.release_until(NOW)
        with self.assertRaises(Killed):
            session.step(NOW)
        abandon(session)
        again = recover_session(world, directory, self.cache["strategies"], journal_clock(directory), max_quote_gap_ms=item["limit"])
        self.addCleanup(abandon, again)
        again.step(NOW)
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
                    mine, theirs = loss_audit(session), loss_audit(flow)
                    self.assertEqual([{k: v for k, v in r.items() if k != "declared_ms"} for r in mine],
                                     [{k: v for k, v in r.items() if k != "declared_ms"} for r in theirs])      # the declaration instant is the recovery's own if it died first
                    self.assertEqual(session.runner.integrity()["open_cycles"], [])


if __name__ == "__main__":
    unittest.main()
