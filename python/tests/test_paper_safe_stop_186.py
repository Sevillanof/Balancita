"""Issue #186: tests that depend on no pending decision. The disk refusing a journal write, a checkpoint that cannot be
replaced, a second process on a run that is held, and a process killed while it recovers. Invented data only."""

import errno
import json
import os
import shutil
import signal
import subprocess
import sys
import unittest
from unittest import mock

import test_paper_runner_recovery as T
from balancita_engine import paper_runner_store as ST
from balancita_engine.paper_runner import REFUSED, PaperRunner, RunnerError


def snapshot(path):
    out = {}
    for name in sorted(os.listdir(path)):
        if not name.endswith(".lock"):
            with open(os.path.join(path, name), "rb") as handle:
                out[name] = handle.read()
    return out


def lines(path):
    with open(os.path.join(path, ST.JOURNAL_FILE), "rb") as handle:
        return handle.read().splitlines()


class JournalWriteFails(T.Base):
    """OSError out of the journal write (fsync, then a partial write) at every entry index of a run."""

    def reference(self):
        return self.continuous(T.session(), "ref")

    def failing_run(self, nth, how):
        """Runs the session with the ``nth`` fsync failing; returns the event that was being handled when it failed."""
        path, r = self.fresh("w{}{}".format(how, nth))
        events, count = T.session(), {"n": 0}
        real_fsync = os.fsync

        def bad_fsync(fd):
            count["n"] += 1
            if count["n"] == nth:
                raise OSError(errno.ENOSPC, "No space left on device")
            return real_fsync(fd)

        error, failed = None, None
        with mock.patch.object(ST.os, "fsync", bad_fsync):
            for event in events:
                try:
                    r.handle(event)
                except RunnerError as caught:
                    error, failed = caught, event
                    break
        return path, r, events, error, failed

    def test_fsync_failure_refuses_and_nothing_goes_on(self):
        for nth in range(1, 200):
            path, r, events, error, failed = self.failing_run(nth, "f")
            if error is None:
                self.assertGreater(nth, 10)
                break
            with self.subTest(fsync=nth):
                self.assertIn(error.reason, ("journal_write_failed", "signal_log_write_failed"))
                self.assertEqual(r.status, REFUSED)
                before = lines(path)
                with self.assertRaises(RunnerError):
                    r.handle(events[-1])                       # a refused runner writes nothing more
                self.assertEqual(lines(path), before)

    def test_after_fsync_failure_the_run_recovers_to_the_continuous_result(self):
        ref = self.reference()
        for nth in range(1, 200):
            path, r, events, error, failed = self.failing_run(nth, "r")
            if error is None:
                break
            with self.subTest(fsync=nth):
                self.die()
                rec = self.recover(path, failed["t_ms"])               # no journal_corrupt, whatever reached the disk
                for event in events:                                    # the source redelivers; duplicates are harmless
                    rec.handle(event)
                self.assertEqual(rec.financial_digest(), ref.financial_digest())

    def test_partial_write_is_a_torn_tail_and_recovers(self):
        for nth in range(1, 200):
            path, r = self.fresh("p{}".format(nth))
            events, count = T.session(), {"n": 0}
            real_open = open

            class Short(object):
                def __init__(self, handle):
                    self.h = handle

                def __getattr__(self, name):
                    return getattr(self.h, name)

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return self.h.__exit__(*a)

                def write(self, data):
                    self.h.write(data[: len(data) // 2])
                    self.h.flush()
                    raise OSError(errno.ENOSPC, "No space left on device")

            def fake_open(file, mode="r", *a, **k):
                handle = real_open(file, mode, *a, **k)
                if str(file).endswith(ST.JOURNAL_FILE) and "a" in mode:
                    count["n"] += 1
                    if count["n"] == nth:
                        return Short(handle)
                return handle

            error, failed = None, None
            with mock.patch.object(ST, "open", fake_open, create=True):
                for event in events:
                    try:
                        r.handle(event)
                    except RunnerError as caught:
                        error, failed = caught, event
                        break
            if error is None:
                self.assertGreater(nth, 10)
                break
            with self.subTest(write=nth):
                self.assertIn(error.reason, ("journal_write_failed", "signal_log_write_failed"))
                self.die()
                rec = self.recover(path, failed["t_ms"])
                for event in events:
                    rec.handle(event)
                # a refused write must leave the same disk as the power cut at that very write (8B's crash matrix)
                _, power_cut, cut_at = self.crash_and_recover(events, "mid_journal", nth, name="pc{}".format(nth))
                self.assertEqual(cut_at, failed)
                self.assertEqual(rec.financial_digest(), power_cut.financial_digest())
                self.assertEqual(rec.journal.entries[-1]["hash"], power_cut.journal.entries[-1]["hash"])


class CheckpointCannotBeReplaced(T.Base):
    def test_the_previous_checkpoint_stands(self):
        path, r = self.fresh("ck")
        events = T.session()
        r.run(events[:4])
        first = r.checkpoint()
        r.run(events[4:6])
        with mock.patch.object(ST.os, "replace", side_effect=OSError(errno.EIO, "I/O error")):
            with self.assertRaises(OSError):
                r.checkpoint()
        body = ST.read_checkpoint(os.path.join(path, ST.CHECKPOINT_FILE))
        self.assertEqual(body["upto_seq"], first["upto_seq"])
        self.die()
        rec = self.recover(path, events[5]["t_ms"])
        for event in events:
            rec.handle(event)
        self.assertEqual(rec.financial_digest(), self.continuous(events, "ref").financial_digest())


class Procs(T.Base):
    """Subprocess helpers of 8B's ``SingleWriter`` without inheriting (and re-running) its tests."""
    HOLDER, OPENER = T.SingleWriter.HOLDER, T.SingleWriter.OPENER
    where, start, holder = T.SingleWriter.where, T.SingleWriter.start, T.SingleWriter.holder


class SecondProcess(Procs):
    def test_second_process_changes_nothing_on_disk(self):
        path = os.path.join(self.dir, "held")
        holder = self.holder(path)
        before = snapshot(path)
        proc = self.start(self.OPENER, path, str(T.CYCLE + 10 * T.MIN))
        out, _ = proc.communicate(timeout=60)
        self.assertEqual(json.loads(out.strip().splitlines()[-1]), {"ok": False, "reason": "directory_locked"})
        after = snapshot(path)
        self.assertEqual(before, after)
        holder.kill()
        holder.wait()
        holder.stdout.close()
        holder.stderr.close()


class KilledWhileRecovering(Procs):
    """SIGKILL at several moments inside recovery, then a clean recovery equals the continuous run."""

    RECOVER = """
import sys, os, signal
sys.path.insert(0, {py!r})
sys.path.insert(0, {tests!r})
import test_paper_runner_recovery as T
from balancita_engine import paper_runner_store as ST
from balancita_engine.paper_runner import PaperRunner
point, nth = sys.argv[3], int(sys.argv[4])
count = [0]
real = getattr(ST, "hit")
def kill(p, kind=None):
    if p == point:
        count[0] += 1
        if count[0] == nth:
            os.kill(os.getpid(), signal.SIGKILL)
    return real(p, kind) if kind is not None else real(p)
import balancita_engine.paper_runner as PR
PR.hit = kill
ST.hit = kill
PaperRunner.recover(sys.argv[1], T.cfg(), T.strategies(), int(sys.argv[2]))
print("finished", flush=True)
"""

    def test_recovery_killed_between_the_recovery_entry_and_the_interruptions(self):
        """Two orders pending, a long downtime: recovery writes ``recovery`` and then cancels both as
        ``runner_interrupted``. Killing it at each of those writes must really kill it, and the next recovery must end
        where an uninterrupted one does."""
        events = T.session()[:2]                                   # two cycles: two orders, no quote yet
        at = T.CYCLE + 20 * T.MIN
        path, r = self.fresh("pending")
        r.run(events)
        self.die()
        reference = self.copy(path, "ref-dir")
        ref = self.recover(reference, at)
        kinds = [e["kind"] for e in ref.journal.entries]
        self.assertEqual(kinds.count("order_cancelled"), 2)        # the scenario does reach the interruptions
        written = len(kinds) - len(r.journal.entries)
        for point in ("before_journal", "after_journal", "after_apply"):
            for nth in range(1, written + 1):
                victim = self.copy(path, "k-{}-{}".format(point, nth))
                proc = self.start(self.RECOVER, victim, str(at), point, str(nth))
                proc.communicate(timeout=60)
                with self.subTest(point=point, nth=nth):
                    self.assertEqual(proc.returncode, -signal.SIGKILL)
                    rec = self.recover(victim, at)
                    self.assertEqual(rec.financial_digest(), ref.financial_digest())
                    self.assertEqual(self.fingerprint(rec), self.fingerprint(ref))
                    cancelled = [e["data"] for e in rec.journal.entries if e["kind"] == "order_cancelled"]
                    self.assertEqual(sorted(c["intent_id"] for c in cancelled),
                                     sorted(c["data"]["intent_id"] for c in ref.journal.entries if c["kind"] == "order_cancelled"))

    def test_two_recoveries_killed_in_a_row_still_cancel_what_the_first_one_owed(self):
        events = T.session()[:2]
        at = T.CYCLE + 20 * T.MIN
        path, r = self.fresh("twice")
        r.run(events)
        self.die()
        reference = self.copy(path, "ref-twice")
        ref = self.recover(reference, at)
        victim = self.copy(path, "victim-twice")
        for point, nth in (("after_journal", 1), ("after_journal", 1)):    # each dies right after its ``recovery`` entry
            proc = self.start(self.RECOVER, victim, str(at), point, str(nth))
            proc.communicate(timeout=60)
            self.assertEqual(proc.returncode, -signal.SIGKILL)
        rec = self.recover(victim, at)
        self.assertEqual(self.fingerprint(rec), self.fingerprint(ref))
        self.assertEqual(rec.owed_interruptions, {})

    def test_the_second_recovery_may_run_at_a_later_clock(self):
        events = T.session()[:2]
        at, later = T.CYCLE + 20 * T.MIN, T.CYCLE + 30 * T.MIN
        path, r = self.fresh("later")
        r.run(events)
        self.die()
        ref = self.recover(self.copy(path, "ref-later"), at)
        victim = self.copy(path, "victim-later")
        proc = self.start(self.RECOVER, victim, str(at), "after_journal", "1")
        proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, -signal.SIGKILL)
        rec = self.recover(victim, later)
        # the cancellations carry the later clock, so the order ledger differs by design; the money and the book do not
        self.assertEqual(len(rec.portfolio.trades), len(ref.portfolio.trades))
        self.assertEqual(rec.executor.pending, ref.executor.pending)
        self.assertEqual(sorted(rec.portfolio.positions), sorted(ref.portfolio.positions))
        self.assertEqual(rec.owed_interruptions, {})
        cancelled = [e["data"] for e in rec.journal.entries if e["kind"] == "order_cancelled"]
        self.assertEqual(len(cancelled), 2)
        self.assertEqual({c["reason"] for c in cancelled}, {"runner_interrupted"})
        windows = lambda r: sorted((c["data"]["intent_id"], c["data"]["uncovered_from_ms"], c["data"]["uncovered_to_ms"])
                                   for c in r.journal.entries if c["kind"] == "order_cancelled")
        self.assertEqual(windows(rec), windows(ref))                          # the unobserved window is the original one

    def copy(self, path, name):
        target = os.path.join(self.dir, name)
        shutil.copytree(path, target, ignore=shutil.ignore_patterns("*.lock"))
        return target


if __name__ == "__main__":
    unittest.main()
