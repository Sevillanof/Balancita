"""Issue #186, decision D-186-1: an orderly stop cancels the pending orders with ``operator_stop`` and touches nothing else.
Runner level only; the session that calls it is another file. Invented data."""

import os
import unittest

import test_paper_runner_recovery as T
from balancita_engine import paper_runner_store as ST
from balancita_engine import signal_continuity as SC
from balancita_engine.paper_runner import REFUSED, PROCESSING, PaperRunner, RunnerError

AT = T.CYCLE + 30 * T.SEC          # inside both order windows (60 s)
LATE = T.CYCLE + 10 * T.MIN        # after both deadlines


def kinds(r):
    return [e["kind"] for e in r.journal.entries]


def cancelled(r):
    return [(e["data"]["intent_id"], e["data"]["reason"]) for e in r.journal.entries if e["kind"] == "order_cancelled"]


class StopOrderly(T.Base):
    def two_pending(self, name="stop"):
        path, r = self.fresh(name)
        r.run(T.session()[:2])
        self.assertEqual(len(r.executor.pending), 2)
        return path, r

    def test_pending_orders_are_cancelled_with_operator_stop_after_the_entry_that_announces_them(self):
        path, r = self.two_pending()
        out = r.stop_orderly(AT)
        self.assertEqual(len(out["cancelled"]), 2)
        self.assertEqual(out["expired"], [])
        self.assertEqual(r.executor.pending, {})
        self.assertEqual({reason for _, reason in cancelled(r)}, {"operator_stop"})
        tail = kinds(r)[-3:]
        self.assertEqual(tail, ["operator_stop", "order_cancelled", "order_cancelled"])      # the announcement first

    def test_an_order_whose_window_was_over_expires_with_its_own_reason_not_operator_stop(self):
        path, r = self.two_pending()
        out = r.stop_orderly(LATE)
        self.assertEqual(out["cancelled"], [])
        self.assertEqual(len(out["expired"]), 2)
        self.assertEqual(cancelled(r), [])
        self.assertEqual([rec["reasons"] for rec in r.executor.records], [["no_quote_in_window"]] * 2)

    def test_open_positions_and_money_are_not_touched(self):
        path, r = self.fresh("positions")
        r.run(T.session()[:4])                                      # both orders filled: two open positions
        positions = sorted(r.portfolio.positions)
        self.assertEqual(len(positions), 2)
        before = (r.financial_digest(), len(r.portfolio.trades))
        out = r.stop_orderly(AT + T.MIN)
        self.assertEqual(out["cancelled"] + out["expired"], [])
        self.assertEqual(sorted(r.portfolio.positions), positions)
        self.assertEqual((r.financial_digest(), len(r.portfolio.trades)), before)
        self.assertEqual(r.status, PROCESSING)

    def test_a_stop_with_nothing_pending_still_leaves_its_entry(self):
        path, r = self.fresh("empty")
        out = r.stop_orderly(T.CYCLE)
        self.assertEqual((out["cancelled"], out["expired"]), ([], []))
        self.assertEqual(kinds(r)[-1], "operator_stop")

    def test_a_failure_writing_the_announcement_means_the_stop_is_not_done(self):
        path, r = self.two_pending()
        with self.mock_write_failure():
            with self.assertRaises(RunnerError) as caught:
                r.stop_orderly(AT)
        self.assertEqual(caught.exception.reason, "journal_write_failed")
        self.assertEqual(r.status, REFUSED)

    def test_a_failure_writing_a_cancellation_also_means_the_stop_is_not_done(self):
        path, r = self.two_pending()
        with self.mock_write_failure(skip=1):                      # the announcement is written, the first cancellation is not
            with self.assertRaises(RunnerError):
                r.stop_orderly(AT)
        self.assertEqual(r.status, REFUSED)
        self.die()
        rec = self.recover(path, AT)                               # a new process finishes what was announced
        self.assertEqual({reason for _, reason in cancelled(rec)}, {"operator_stop"})
        self.assertEqual(rec.executor.pending, {})

    def mock_write_failure(self, skip=0):
        import errno
        from unittest import mock
        real, count = os.fsync, {"n": 0}

        def bad(fd):
            count["n"] += 1
            if count["n"] > skip:
                raise OSError(errno.ENOSPC, "No space left on device")
            return real(fd)

        return mock.patch.object(ST.os, "fsync", bad)

    def test_a_death_between_the_announcement_and_the_cancellations_is_finished_once_by_the_recovery(self):
        path, r = self.two_pending("dies")
        ST.arm("after_journal", 1, "operator_stop")
        with self.assertRaises(SC.SimulatedCrash):
            r.stop_orderly(AT)
        ST.disarm()
        self.assertEqual(cancelled(r), [])
        rec = self.recover(path, AT)
        self.assertEqual({reason for _, reason in cancelled(rec)}, {"operator_stop"})
        self.assertEqual(len(cancelled(rec)), 2)
        self.assertEqual(rec.executor.pending, {})
        again = self.recover(path, AT + T.SEC)                      # recovering again adds nothing
        self.assertEqual(len(cancelled(again)), 2)

    def test_a_death_after_the_first_cancellation_leaves_exactly_the_other_one_for_the_recovery(self):
        path, r = self.two_pending("half")
        ST.arm("after_journal", 1, "order_cancelled")
        with self.assertRaises(SC.SimulatedCrash):
            r.stop_orderly(AT)
        ST.disarm()
        self.assertEqual(len(cancelled(r)), 1)
        rec = self.recover(path, AT)
        self.assertEqual(sorted(reason for _, reason in cancelled(rec)), ["operator_stop", "operator_stop"])
        self.assertEqual(len({i for i, _ in cancelled(rec)}), 2)

    def test_the_recovered_stop_equals_the_uninterrupted_one(self):
        _, ref = self.two_pending("ref")
        ref.stop_orderly(AT)
        path, r = self.two_pending("crash")
        ST.arm("after_journal", 1, "operator_stop")
        with self.assertRaises(SC.SimulatedCrash):
            r.stop_orderly(AT)
        ST.disarm()
        rec = self.recover(path, AT)
        self.assertEqual(rec.financial_digest(), ref.financial_digest())

    def test_a_stopped_run_recovers_from_disk_without_cancelling_again(self):
        path, r = self.two_pending("again")
        r.stop_orderly(AT)
        r.checkpoint()
        self.die()
        rec = self.recover(path, AT + T.MIN)
        self.assertEqual(len(cancelled(rec)), 2)
        self.assertEqual(rec.financial_digest(), r.financial_digest())


if __name__ == "__main__":
    unittest.main()
