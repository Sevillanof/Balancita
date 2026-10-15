"""Issue #186: tests that depend on no pending decision. The disk refusing a journal write, a checkpoint that cannot be
replaced, a second process on a run that is held, and a process killed while it recovers. Invented data only."""

import errno
import json
import os
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


class SecondProcess(T.SingleWriter):
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


class KilledWhileRecovering(T.SingleWriter):
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

    def test_recovery_killed_at_each_write_point(self):
        events = T.session()
        ref = self.continuous(events, "ref")
        for point in ("before_journal", "after_journal", "after_apply", "before_checkpoint", "after_checkpoint"):
            for nth in (1, 2):
                path, r = self.fresh("k-{}-{}".format(point, nth))
                r.run(events[:5])
                self.die()
                at = events[4]["t_ms"]
                proc = self.start(self.RECOVER, path, str(at), point, str(nth))
                proc.communicate(timeout=60)
                with self.subTest(point=point, nth=nth):
                    self.assertIn(proc.returncode, (0, -signal.SIGKILL))
                    rec = self.recover(path, at)
                    for event in events:
                        rec.handle(event)
                    self.assertEqual(rec.financial_digest(), ref.financial_digest())


if __name__ == "__main__":
    unittest.main()
