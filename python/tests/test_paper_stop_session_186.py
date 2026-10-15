"""Issue #186, decision D-186-1 (BAL-DECISION-186-01: Cancelar), seen from the SESSION: ``LiveSession.stop`` calls the runner's
``stop_orderly`` (covered by ``test_paper_stop_orderly_186``), audits it, makes it durable with a checkpoint and closes the door
to further steps. Invented data only (the world of ``TestSilenceStillOpen``). The checkpoint failure policy (D-186-2, ``Toda``) is
covered in ``test_paper_safe_stop_186_session``."""

import errno
import os
import unittest
from unittest import mock

from balancita_engine import paper_live_integration as LI
from balancita_engine.paper_runner import REFUSED, STOPPED, RunnerError
from test_paper_safe_stop_186_session import Base, FULL, NOW, kinds
from test_paper_live_integration import journal_clock, recover_session, BTC, ETH


class Interrupted(BaseException):
    """Stops the step where the source loss is about to be declared: the order the fixture places is still pending there (a
    BaseException, like the simulated deaths of the other tests: the session does not take it for a failure of its own)."""


class TestStopOrderlyInTheSession(Base):

    @staticmethod
    def money(session):
        portfolio = session.runner.portfolio
        return (repr(sorted(portfolio.positions.items())), len(portfolio.trades), repr(getattr(portfolio, "cash", None)))

    def stopped(self):
        world, directory, session = self.fork()

        def interrupt(*a, **k):
            raise Interrupted()

        with mock.patch.object(session.runner, "cancel_for_source_loss", interrupt):
            with self.assertRaises(Interrupted):
                session.step(NOW)
        self.assertIsNone(session.halted)
        self.assertTrue(session.runner.executor.pending, "the fixture must have pending orders for this to mean anything")
        return world, directory, session

    def test_the_pending_orders_are_cancelled_with_operator_stop_and_the_audit_says_so(self):
        world, directory, session = self.stopped()
        pending = sorted(session.runner.executor.pending)
        money = self.money(session)
        result = session.stop(NOW)
        self.assertEqual(sorted(result["cancelled"]) + sorted(result["expired"]), pending)
        self.assertFalse(session.runner.executor.pending)
        reasons = {e["data"]["intent_id"]: e["data"]["reason"] for e in session.runner.journal.entries if e["kind"] == "order_cancelled"
                   and e["data"]["intent_id"] in result["cancelled"]}
        self.assertEqual(set(reasons.values()), {"operator_stop"} if result["cancelled"] else set())
        self.assertEqual(self.money(session), money)                           # money and positions untouched
        entry = kinds(session, "operator_stop")
        self.assertEqual(len(entry), 1)
        self.assertEqual(entry[0]["cancelled"], result["cancelled"])
        self.assertEqual(entry[0]["declared_ms"], result["declared_ms"])

    def test_the_stop_is_durable_and_the_directory_recovers_with_nothing_left_to_finish(self):
        world, directory, session = self.stopped()
        session.stop(NOW)
        before = session.comparable_state()
        written = kinds(session, "operator_stop")
        self.release()
        again = self.reopen(world, directory)
        self.assertEqual(kinds(again, "operator_stop"), written)               # not written a second time by the recovery
        self.assertFalse(again.runner.executor.pending)
        self.assertEqual(again.comparable_state(), before)
        self.assertEqual(len(kinds(again, "operator_stop")), 1)
        self.assertEqual(again.runner.status, STOPPED)                  # terminal, also after the recovery
        with self.assertRaises(LI.IntegrationError) as caught:
            again.step(NOW)
        self.assertEqual(caught.exception.reason, "session_stopped")

    def test_a_stopped_session_does_not_step_and_asking_again_changes_nothing(self):
        world, directory, session = self.stopped()
        first = session.stop(NOW)
        entries = len(session.runner.journal.entries)
        self.assertEqual(session.stop(NOW + 5000), first)
        self.assertEqual(len(session.runner.journal.entries), entries)
        with self.assertRaises(LI.IntegrationError) as caught:
            session.step(NOW)
        self.assertEqual(caught.exception.reason, "session_stopped")

    def test_a_runner_that_refuses_the_stop_halts_the_session_and_nothing_is_reported_done(self):
        world, directory, session = self.stopped()
        real = session.runner.journal.add
        calls = {"n": 0}

        def failing(*a, **k):
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError(errno.ENOSPC, "No space left on device")
            return real(*a, **k)

        with mock.patch.object(session.runner.journal, "add", failing):
            with self.assertRaises(RunnerError):
                session.stop(NOW)
        self.assertEqual(session.runner.status, REFUSED)
        self.assertIsNone(session.stopped)
        with self.assertRaises(LI.IntegrationError) as caught:
            session.step(NOW)
        self.assertEqual(caught.exception.reason, "session_halted")
        self.assertEqual(kinds(session, "operator_stop"), [])
        # the directory is recoverable from its last checkpoint, with the orders still pending (nothing was announced)
        self.release()
        again = self.reopen(world, directory)
        self.assertTrue(again.runner.executor.pending)

    def test_a_checkpoint_that_fails_after_the_stop_halts_the_session_and_the_stop_stays_journaled(self):
        world, directory, session = self.stopped()
        with mock.patch("balancita_engine.paper_live_integration.os.replace", side_effect=FULL):
            with self.assertRaises(OSError):
                session.stop(NOW)
        self.assertIsNotNone(session.stopped)                   # the runner journaled it: that is what the answer reports
        self.assertIsNotNone(session.halted)                    # D-186-2 (Toda): the checkpoint failure stops the whole session
        with self.assertRaises(LI.IntegrationError) as caught:
            session.stop(NOW)                                   # and a halted session reports no stop
        self.assertEqual(caught.exception.reason, "session_halted")
        self.release()
        again = self.reopen(world, directory)
        self.assertFalse(again.runner.executor.pending)         # the recovery finishes the announced stop, exactly once
        self.assertEqual(len([e for e in again.runner.journal.entries if e["kind"] == "operator_stop"]), 1)

    def test_a_halted_session_never_reports_a_stop(self):
        """D-195-01: the audit refuses after the runner journaled the stop; the session is halted and asking again must not
        answer 'stopped' with nothing in the audit."""
        world, directory, session = self.stopped()
        with mock.patch.object(session.audit, "add", side_effect=LI.IntegrationError("audit_write_failed", "disk")):
            with self.assertRaises(LI.IntegrationError):
                session.stop(NOW)
        self.assertIsNotNone(session.halted)
        with self.assertRaises(LI.IntegrationError) as caught:
            session.stop(NOW)
        self.assertEqual(caught.exception.reason, "session_halted")
        self.assertEqual(kinds(session, "operator_stop"), [])

    def test_a_process_that_died_between_the_journal_and_the_audit_leaves_the_stop_in_the_audit_after_the_recovery(self):
        """D-195-02: the runner's journal says 'stopped'; the audit must say it too once the directory is recovered, with the
        same record the live stop writes."""
        world, directory, session = self.stopped()
        reference_world, reference_dir, reference = self.stopped()
        reference.stop(NOW)
        expected = kinds(reference, "operator_stop")
        self.assertEqual(len(expected), 1)
        with mock.patch.object(session, "_audit_operator_stop", side_effect=Interrupted()):
            with self.assertRaises(Interrupted):
                session.stop(NOW)
        self.assertEqual(kinds(session, "operator_stop"), [])                   # the process died before the audit write
        self.release()
        again = self.reopen(world, directory)
        self.assertEqual(again.runner.status, STOPPED)
        self.assertEqual(kinds(again, "operator_stop"), expected)
        with self.assertRaises(LI.IntegrationError) as caught:
            again.step(NOW)
        self.assertEqual(caught.exception.reason, "session_stopped")

    def test_stopping_a_session_recovered_from_a_stopped_run_answers_the_same_and_writes_nothing(self):
        """D-195-03: no second 'operator_stop' record, no declared_ms None."""
        world, directory, session = self.stopped()
        first = session.stop(NOW)
        self.release()
        again = self.reopen(world, directory)
        entries, records = len(again.runner.journal.entries), kinds(again, "operator_stop")
        self.assertEqual(again.stop(NOW + 9_000), first)
        self.assertIsNotNone(first["declared_ms"])
        self.assertEqual(len(again.runner.journal.entries), entries)
        self.assertEqual(kinds(again, "operator_stop"), records)
        self.assertEqual(len(records), 1)


if __name__ == "__main__":
    unittest.main()
