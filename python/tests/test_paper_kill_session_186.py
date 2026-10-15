"""Issue #186 (BAL-CIERRE-186-01, scenarios S-K1 and S-K2 of the matrix): a REAL process (SIGKILL, no unwinding) dies around the
journal writes of the step that declares a ``source_stale`` loss, seen from the SESSION. The child process half-writes a journal
line (S-K1) or stops between two entries of the declaration (S-K2: ``source_loss`` and ``order_cancelled``); this process recovers
the directory and makes the same step again: the result must be the one of the step that never failed (same orders with the same
``decided_at`` and the same money), declared once. Invented data only (the world of ``test_paper_safe_stop_186_session``)."""

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

from balancita_engine import paper_live_integration as LI
from balancita_engine.paper_runner_store import FileRunnerJournal, JOURNAL_FILE
from test_paper_safe_stop_186_session import NOW, Base, kinds
from test_paper_live_integration import ENTRY_STEP, journal_clock, record

HERE = os.path.dirname(os.path.abspath(__file__))


class KillBase(Base):
    def child(self, directory, world, fault, kind, nth=1, in_recovery=False):
        """Runs the step ``NOW`` in another process that dies (SIGKILL) at the ``nth`` time ``fault`` is reached for ``kind``."""
        env = dict(os.environ, PYTHONPATH=os.pathsep.join((os.path.dirname(HERE), HERE)), KILL_IN_RECOVERY="1" if in_recovery else "0")
        done = subprocess.run([sys.executable, "-W", "ignore", os.path.join(HERE, "live_kill_store_worker.py"), directory, world.path,
                               str(journal_clock(directory)), fault, kind or "-", str(nth), str(ENTRY_STEP)],
                              env=env, capture_output=True, text=True, timeout=900)
        self.assertEqual(done.returncode, -signal.SIGKILL, "{} {} #{} was not reached\n{}".format(fault, kind, nth, done.stderr[-2000:]))

    def fork_dir(self):
        """A world and a session directory standing just before the step, with NO session open on it."""
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        world = self.cache["world"].fork(root, self.cache["snap"]["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(self.cache["snap"]["session"], directory)
        world.release_until(NOW)
        return world, directory

    def finish(self, world, directory):
        """Recovers the directory and makes the step again. The comparison is the one the matrix defines (orders with their state,
        reason and ``decided_at``, positions, money, signals, losses declared once). The runner's ``financial`` digest is left out on
        purpose: a cancellation that the RECOVERY finishes carries one more field (``recovery_ms``) than the one made in the step, so
        that digest differs although every order, price and cent is the same."""
        ref = self.reference()
        session = self.reopen(world, directory)
        session.step(NOW)
        now = record(session, NOW)
        self.assertEqual({k: v for k, v in now.items() if k != "financial"}, {k: v for k, v in ref["record"].items() if k != "financial"})
        self.assertEqual(self.losses(session), ref["losses"])
        self.assertEqual(kinds(session, "source_stale_detected"), ref["detected"])
        self.assertEqual(kinds(session, "source_loss"), ref["loss_records"])
        cancelled = [(e["data"]["intent_id"], e["data"]["reason"], e["t_ms"]) for e in session.runner.journal.entries if e["kind"] == "order_cancelled"]
        self.assertEqual(len(cancelled), len(set(c[0] for c in cancelled)))                    # never cancelled twice
        return session

    def raw_journal(self, directory):
        with open(os.path.join(directory, LI.RUNNER_DIR, JOURNAL_FILE), "rb") as handle:
            return handle.read()


class TestRealKillAroundTheDeclaration(KillBase):
    """S-K2 (matrix A3, A7, C6): death between ``source_loss`` and ``order_cancelled``, and around each of the two writes."""

    def test_death_at_each_boundary_of_the_two_entries_ends_the_obligation_once(self):
        for kind in ("source_loss", "order_cancelled"):
            for fault in ("before_journal", "mid_journal", "after_journal"):
                with self.subTest(kind=kind, fault=fault):
                    world, directory = self.fork_dir()
                    self.child(directory, world, fault, kind)
                    raw = self.raw_journal(directory)
                    if fault == "mid_journal":
                        self.assertFalse(raw.endswith(b"\n"), "a torn tail was expected")        # the process left half a line
                    self.finish(world, directory)
                    self.release()

    def test_death_exactly_between_the_loss_and_its_cancellation_leaves_the_loss_without_the_cancellation(self):
        world, directory = self.fork_dir()
        self.child(directory, world, "after_journal", "source_loss")
        journal = FileRunnerJournal.load(os.path.join(directory, LI.RUNNER_DIR, JOURNAL_FILE))
        self.assertEqual(journal.entries[-1]["kind"], "source_loss")                          # the loss is on disk, the cancellation is not
        session = self.finish(world, directory)
        self.assertEqual(len(self.losses(session)), 1)
        self.assertEqual(len([e for e in session.runner.journal.entries if e["kind"] == "order_cancelled"]),
                         len([e for e in self.reference_entries() if e["kind"] == "order_cancelled"]))

    def reference_entries(self):
        world, directory, session = self.fork()
        session.step(NOW)
        return list(session.runner.journal.entries)

    def test_two_deaths_in_a_row_with_the_silence_open_make_one_silence_and_one_cancellation(self):
        world, directory = self.fork_dir()
        self.child(directory, world, "after_journal", "source_loss")                           # first death: the loss is journaled
        self.child(directory, world, "before_journal", "order_cancelled", in_recovery=True)    # second death: inside the recovery itself
        self.finish(world, directory)


class TestRealKillInTheMiddleOfALine(KillBase):
    """S-K1 (matrix A2): the process dies with a partial line on disk, for several kinds of entry and positions."""

    def test_a_half_written_line_is_cut_and_the_step_comes_out_as_if_nothing_happened(self):
        for kind, nth in (("event_accepted", 1), ("event_accepted", 40), ("decision", 1), ("signals_persisted", 1), ("source_loss", 1)):
            with self.subTest(kind=kind, nth=nth):
                world, directory = self.fork_dir()
                self.child(directory, world, "mid_journal", kind, nth)
                raw = self.raw_journal(directory)
                self.assertFalse(raw.endswith(b"\n"))                                          # half a line is on disk
                journal = FileRunnerJournal.load(os.path.join(directory, LI.RUNNER_DIR, JOURNAL_FILE))
                self.assertGreater(journal.tail_discarded, 0)                                  # and it is cut, not trusted
                self.finish(world, directory)
                self.release()


if __name__ == "__main__":
    unittest.main()
