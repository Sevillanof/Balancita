"""Issue #186 (finding D-189-02): the disk refusing a write, seen from the SESSION. The runner's own journal is covered by
``test_paper_safe_stop_186``; here the same failure comes through ``LiveSession.step``: the runner journal (``journal_write_failed``),
the session's audit journal and the session checkpoint, at every write of the step that declares a ``source_stale`` loss, and
the recovery of the directory that is left. No pending decision is involved: the checkpoint failure keeps today's behaviour
(the exception goes up, the previous checkpoint stays); what the session does about it afterwards is decision D-186-2 and is not
changed here. Invented data only (the world of ``TestSilenceStillOpen``)."""

import errno
import gc
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from balancita_engine import paper_live_integration as LI
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC
from balancita_engine.paper_runner import REFUSED, RunnerError
from balancita_engine.paper_runner_store import DirectoryLock, StoreError
from live_world import LOAD_START, World
from test_paper_live_integration import (BTC, ENTRY_QUOTE_MS, ENTRY_STEP, ETH, HOLE, TIMES, Circuit, abandon, journal_clock, new_session,
                                         recover_session, record)

NOW = TIMES[ENTRY_STEP]
FULL = OSError(errno.ENOSPC, "No space left on device")


def kinds(session, *names):
    return [r for r in session.audit.records() if r["kind"] in names]


class Base(unittest.TestCase):
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
        cls.cache["snap"] = Circuit.take_snapshot(root, "before", session, world, ENTRY_STEP)
        cls.cache["world"] = world
        abandon(session)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    def setUp(self):
        self.live = []

    def tearDown(self):
        self.release()

    def release(self):
        """Lets go of every session this test opened (a loop over many writes would otherwise keep all of them in memory)."""
        while self.live:
            abandon(self.live.pop())
        gc.collect()

    def fork(self):
        """A recovered session standing just before the step that declares the loss, and its world."""
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        world = self.cache["world"].fork(root, self.cache["snap"]["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(self.cache["snap"]["session"], directory)
        session = self.reopen(world, directory)
        world.release_until(NOW)
        return world, directory, session

    def reopen(self, world, directory):
        session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory), products=(BTC, ETH))
        self.live.append(session)
        return session

    def losses(self, session):
        return [e["data"] for e in session.runner.journal.entries if e["kind"] == "source_loss"]

    @staticmethod
    def sample(total):
        """The first, second, middle and last writes of the step (all of them would be minutes of CI for the same code path)."""
        return sorted({1, 2, max(1, total // 2), max(1, total - 1), total})

    def reference(self):
        """The same step with nothing failing, and how many writes of each kind it makes."""
        if "ref" not in self.cache:
            world, directory, session = self.fork()
            counts = {"journal": 0, "audit": 0}
            real_add, real_write = session.runner.journal.add, session.audit._write

            def count_add(*a, **k):
                counts["journal"] += 1
                return real_add(*a, **k)

            def count_write(*a, **k):
                counts["audit"] += 1
                return real_write(*a, **k)

            with mock.patch.object(session.runner.journal, "add", count_add), mock.patch.object(session.audit, "_write", count_write):
                session.step(NOW)
            self.cache["ref"] = {"record": record(session, NOW), "counts": counts, "losses": self.losses(session),
                                 "detected": kinds(session, "source_stale_detected"), "loss_records": kinds(session, "source_loss")}
        return self.cache["ref"]

    def assert_same_as_reference(self, session):
        ref = self.reference()
        self.assertEqual(record(session, NOW), ref["record"])
        self.assertEqual(self.losses(session), ref["losses"])                 # declared once, never twice
        self.assertEqual(kinds(session, "source_stale_detected"), ref["detected"])
        self.assertEqual(kinds(session, "source_loss"), ref["loss_records"])      # the evidence was not lost

    def recover_and_finish(self, world, directory):
        """The process is gone: the directory is recovered and the same step is made again."""
        session = self.reopen(world, directory)
        session.step(NOW)
        self.assert_same_as_reference(session)
        return session


class TestRunnerJournalFailsInTheSession(Base):
    """E1 at the level of the session: the runner refuses (``journal_write_failed``), the session stops with that error, and the
    directory it leaves recovers to the continuous result."""

    def failing_step(self, nth, after):
        world, directory, session = self.fork()
        count, real = {"n": 0}, session.runner.journal.add

        def add(*a, **k):
            count["n"] += 1
            if count["n"] == nth:
                if after:
                    real(*a, **k)                      # the entry reached the file, the fsync (or what came after) failed
                raise FULL
            return real(*a, **k)

        with mock.patch.object(session.runner.journal, "add", add):
            with self.assertRaises(RunnerError) as caught:
                session.step(NOW)
        return world, directory, session, caught.exception

    def test_every_journal_write_of_the_step_refuses_and_the_directory_recovers(self):
        total = self.reference()["counts"]["journal"]
        self.assertGreater(total, 3)
        for after in (False, True):
            for nth in self.sample(total):
                with self.subTest(write=nth, reached_the_file=after):
                    world, directory, session, error = self.failing_step(nth, after)
                    self.assertEqual(error.reason, "journal_write_failed")
                    self.assertEqual(session.runner.status, REFUSED)
                    abandon(session)
                    self.recover_and_finish(world, directory)
                    self.release()

    def test_a_refused_runner_leaves_the_session_without_more_writes(self):
        """The ingestor already moved past the events the refused runner did not journal: if the caller insists, a checkpoint
        written now would make the recovery skip them. The instance refuses to step and to checkpoint, and writes nothing."""
        world, directory, session, _ = self.failing_step(1, False)
        before = disk(directory)
        with self.assertRaises(LI.IntegrationError) as caught:
            session.step(NOW)                          # the caller insists
        self.assertEqual(caught.exception.reason, "session_halted")
        with self.assertRaises(LI.IntegrationError):
            session.save_checkpoint()
        self.assertEqual(disk(directory), before)
        abandon(session)
        self.recover_and_finish(world, directory)      # and the directory still recovers to the continuous result

    def test_the_audit_says_the_declaration_did_not_happen_and_it_is_declared_once_after_the_recovery(self):
        world, directory, session, _ = self.failing_step(self.reference()["counts"]["journal"] - 1, False)
        refused = kinds(session, "source_stale_refused")
        for record_ in refused:
            self.assertFalse(record_["applied"])
            self.assertEqual(record_["reason"], "journal_write_failed")
        abandon(session)
        self.recover_and_finish(world, directory)


class TestAuditWriteFails(Base):
    """The session's audit journal is refused by the disk at every one of its writes in the step."""

    def failing_disk(self, nth, torn):
        """The disk itself refuses (the real ``_write`` runs and its own file operation fails), so the session's handling is tested."""
        world, directory, session = self.fork()
        count, real_open = {"n": 0}, open
        audit_path = session.audit.path

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
                if torn:
                    self.h.write(data[: len(data) // 2])
                    self.h.flush()
                raise FULL

        def fake_open(file, mode="r", *a, **k):
            handle = real_open(file, mode, *a, **k)
            if str(file) == audit_path and "a" in mode:
                count["n"] += 1
                if count["n"] == nth:
                    return Short(handle)
            return handle

        raised = None
        with mock.patch.object(LI, "open", fake_open, create=True):
            try:
                session.step(NOW)
            except Exception as error:               # noqa: BLE001 - the type is what is under test
                raised = error
        return world, directory, session, raised

    def test_a_refused_write_stops_the_step_with_an_explicit_error_at_every_audit_write(self):
        total = self.reference()["counts"]["audit"]
        self.assertGreater(total, 1)
        for torn in (False, True):
            for nth in self.sample(total):
                with self.subTest(write=nth, torn=torn):
                    world, directory, session, error = self.failing_disk(nth, torn)
                    self.assertIsInstance(error, LI.IntegrationError)
                    self.assertEqual(error.reason, "audit_write_failed")
                    abandon(session)
                    self.recover_and_finish(world, directory)
                    self.release()

    def failing_fsync(self, nth):
        """The whole line reached the file and the ``fsync`` that follows it is what the disk refuses."""
        world, directory, session = self.fork()
        count, marked, real_open, real_fsync = {"n": 0}, {"fd": None}, open, os.fsync
        audit_path = session.audit.path

        class Marked(object):
            def __init__(self, handle):
                self.h = handle
                marked["fd"] = handle.fileno()

            def __getattr__(self, name):
                return getattr(self.h, name)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return self.h.__exit__(*a)

        def fake_open(file, mode="r", *a, **k):
            handle = real_open(file, mode, *a, **k)
            if str(file) == audit_path and "a" in mode:
                count["n"] += 1
                if count["n"] == nth:
                    return Marked(handle)
            return handle

        def fake_fsync(fd):
            if marked["fd"] is not None and fd == marked["fd"]:
                marked["fd"] = None
                raise FULL
            return real_fsync(fd)

        raised = None
        with mock.patch.object(LI, "open", fake_open, create=True), mock.patch.object(LI.os, "fsync", fake_fsync):
            try:
                session.step(NOW)
            except Exception as error:               # noqa: BLE001 - the type is what is under test
                raised = error
        return world, directory, session, raised

    def test_a_complete_line_whose_fsync_failed_is_not_written_twice_after_the_recovery(self):
        total = self.reference()["counts"]["audit"]
        for nth in self.sample(total):
            with self.subTest(write=nth):
                world, directory, session, error = self.failing_fsync(nth)
                self.assertIsInstance(error, LI.IntegrationError)
                self.assertEqual(error.reason, "audit_write_failed")
                abandon(session)
                self.recover_and_finish(world, directory)         # the line on the file is kept and the record is not added again
                self.release()

    def test_the_record_that_was_refused_is_not_remembered_as_written(self):
        world, directory, session, error = self.failing_disk(1, False)
        self.assertIsInstance(error, LI.IntegrationError)
        written = {e["data"]["record_id"] for e in session.audit.entries if e["kind"] == "audit"}
        self.assertEqual(session.audit.ids, written)             # nothing is "already there" without being on disk

    def test_an_audit_that_failed_appends_nothing_more_from_the_same_instance(self):
        world, directory, session, error = self.failing_disk(1, True)         # half a line is on the file
        before = open(session.audit.path, "rb").read()
        with self.assertRaises(LI.IntegrationError):
            session.audit.add({"source": "test", "kind": "late", "n": 1})
        self.assertEqual(open(session.audit.path, "rb").read(), before)      # nothing was appended after the torn tail

    def test_the_torn_tail_is_cut_when_the_directory_is_opened_again(self):
        world, directory, session, error = self.failing_disk(1, True)
        abandon(session)
        reopened = self.reopen(world, directory)
        self.assertEqual(reopened.audit.tail_discarded, 1)


class TestRefusedCancellationAndFullDisk(Base):
    """``source_stale_refused``: when the runner refuses the declaration and the disk refuses the evidence of the refusal too, the
    error that stops the session is the runner's, not a bare OSError from the audit."""

    def test_the_runners_refusal_is_not_hidden_by_a_failing_audit_write(self):
        world, directory, session = self.fork()
        refused, real_open, audit_path = {"yes": False}, open, session.audit.path

        def fake_open(file, mode="r", *a, **k):
            if refused["yes"] and str(file) == audit_path and "a" in mode:
                raise FULL                    # the disk is full by the time the evidence of the refusal is written
            return real_open(file, mode, *a, **k)

        def refuse(*a, **k):
            refused["yes"] = True
            raise RunnerError("cancel_refused", "test")

        with mock.patch.object(session.runner, "cancel_for_source_loss", refuse), mock.patch.object(LI, "open", fake_open, create=True):
            with self.assertRaises(RunnerError) as caught:
                session.step(NOW)
        self.assertEqual(caught.exception.reason, "cancel_refused")
        self.assertEqual(kinds(session, "source_stale_refused"), [])           # the disk could not keep it: it is not claimed

    def test_with_a_healthy_disk_the_refusal_is_written_and_the_session_stops(self):
        world, directory, session = self.fork()

        def refuse(*a, **k):
            raise RunnerError("cancel_refused", "test")

        with mock.patch.object(session.runner, "cancel_for_source_loss", refuse):
            with self.assertRaises(RunnerError):
                session.step(NOW)
        refused = kinds(session, "source_stale_refused")
        self.assertEqual([(r["applied"], r["reason"]) for r in refused], [(False, "cancel_refused")])


class TestSessionCheckpointFails(Base):
    """E2 at the level of the session, with decision D-186-2 (``Toda``): the checkpoint that cannot be written stops the whole
    session. The exception goes up, the previous session checkpoint stays as it was, this instance is halted (it processes and
    writes nothing more) and the journals are ahead of the checkpoint, which the recovery accepts. What is checked is that
    nothing is lost or doubled whichever way the replacement fails."""

    def checkpoint_bytes(self, directory):
        with open(os.path.join(directory, LI.CHECKPOINT_FILE), "rb") as handle:
            return handle.read()

    def fails_at(self, how):
        world, directory, session = self.fork()
        before = self.checkpoint_bytes(directory)
        real_open, real_replace = open, os.replace
        tmp = os.path.join(directory, LI.CHECKPOINT_FILE) + ".tmp"

        def fake_open(file, mode="r", *a, **k):
            if how == "write" and str(file) == tmp:
                raise FULL
            return real_open(file, mode, *a, **k)

        def fake_replace(src, dst):
            if how == "replace" and str(dst) == os.path.join(directory, LI.CHECKPOINT_FILE):
                raise FULL
            return real_replace(src, dst)

        with mock.patch.object(LI, "open", fake_open, create=True), mock.patch.object(LI.os, "replace", fake_replace):
            with self.assertRaises(OSError):
                session.step(NOW)
        self.assertEqual(self.checkpoint_bytes(directory), before)               # the previous checkpoint is untouched
        self.assertIn("No space left", session.halted)                           # the failure is declared as the reason to stop
        after = disk(directory)
        for call in (lambda: session.step(NOW), session.save_checkpoint):        # and nothing more is processed or written
            with self.assertRaises(LI.IntegrationError) as caught:
                call()
            self.assertEqual(caught.exception.reason, "session_halted")
        self.assertEqual(disk(directory), after)
        abandon(session)
        return world, directory

    def test_the_checkpoint_that_cannot_be_written_leaves_the_previous_one_and_the_directory_recovers(self):
        for how in ("write", "replace"):
            with self.subTest(fails=how):
                world, directory = self.fails_at(how)
                self.recover_and_finish(world, directory)
                self.release()


class TestAnyExceptionBeforeTheCheckpointHaltsTheInstance(Base):
    """Decision P3 (``Mantener``): any exception of the part of the step before its checkpoint, a transient read of the source
    included, halts that instance; it is not retried on it, and the recovery from the last checkpoint neither skips nor doubles
    an event."""

    def halted_after(self, make_poll):
        world, directory, session = self.fork()
        real = session.ingestor.poll
        with mock.patch.object(session.ingestor, "poll", make_poll(real)):
            with self.assertRaises(OSError):
                session.step(NOW)
        self.assertIsNotNone(session.halted)
        before = disk(directory)
        polled = {"n": 0}

        def counting(*a, **k):
            polled["n"] += 1
            return real(*a, **k)

        with mock.patch.object(session.ingestor, "poll", counting):
            with self.assertRaises(LI.IntegrationError) as caught:
                session.step(NOW)                                  # insisting on the same instance
        self.assertEqual((caught.exception.reason, polled["n"]), ("session_halted", 0))   # not retried: not even read again
        self.assertEqual(disk(directory), before)
        abandon(session)
        return world, directory

    def test_a_transient_read_error_before_anything_was_taken_halts_and_the_recovery_gives_the_reference(self):
        def failing(real):
            def poll(*a, **k):
                raise OSError(errno.EIO, "transient read error")
            return poll

        world, directory = self.halted_after(failing)
        self.recover_and_finish(world, directory)

    def test_a_read_error_after_the_ingestor_moved_halts_and_the_recovery_skips_and_doubles_nothing(self):
        def failing(real):
            def poll(*a, **k):
                real(*a, **k)                                      # the ingestor advanced past events nobody journaled
                raise OSError(errno.EIO, "transient read error")
            return poll

        world, directory = self.halted_after(failing)
        self.recover_and_finish(world, directory)


def disk(directory):
    """Every byte of the session directory except the lock files (which a second opener may legitimately create or touch)."""
    out = {}
    for root, _dirs, files in os.walk(directory):
        for name in sorted(files):
            if not name.endswith(".lock"):
                path = os.path.join(root, name)
                with open(path, "rb") as handle:
                    out[os.path.relpath(path, directory)] = handle.read()
    return out


class TestSecondProcessOnTheSession(Base):
    """S-U1 at the level of the session (D-189-04). A second process that opens a directory whose writer is alive is refused
    and changes nothing: not the runner (covered by #189), and not the evaluator log or the audit journal either, which the
    session repairs on opening. A half line there may be the live writer's own write in flight: cutting it is a write."""

    def second(self, world, directory):
        return recover_session(world, directory, self.cache["strategies"], journal_clock(directory), products=(BTC, ETH))

    def test_a_second_recovery_is_refused_and_writes_nothing(self):
        world, directory, live = self.fork()
        before = disk(directory)
        with self.assertRaises(Exception) as caught:
            self.second(world, directory)
        self.assertIn("directory_locked", str(caught.exception))
        self.assertEqual(disk(directory), before)

    def test_a_second_recovery_does_not_cut_a_half_line_the_live_writer_is_writing(self):
        world, directory, live = self.fork()
        for name in (LI.AUDIT_FILE, LI.EVALUATOR_FILE):
            with open(os.path.join(directory, name), "ab") as handle:
                handle.write(b'{"seq": 99, "kind": "au')                 # the live writer's write, still in flight
        before = disk(directory)
        with self.assertRaises(Exception) as caught:
            self.second(world, directory)
        self.assertIn("directory_locked", str(caught.exception))
        self.assertEqual(disk(directory), before)

    def test_creating_over_a_held_directory_is_refused_and_writes_nothing(self):
        world, directory, live = self.fork()
        before = disk(directory)
        with self.assertRaises(Exception):
            new_session(world, directory, self.cache["strategies"], products=(BTC, ETH))
        self.assertEqual(disk(directory), before)


CHILD = """
import os, sys, time
sys.path.insert(0, {py!r})
sys.path.insert(0, {tests!r})
import test_paper_live_integration as TI
from types import SimpleNamespace
from balancita_engine import paper_live_evaluator as LE
from balancita_engine import paper_live_integration as LI
from balancita_engine import replay_specs as RS
directory, capture, recovery_ms, sync, role = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]
real = LE.LiveEvaluator.recover.__func__
def seen(cls, *a, **k):                                   # the first thing the session opens: the evaluator log
    open(os.path.join(sync, "opened." + role), "w").close()
    return real(cls, *a, **k)
LE.LiveEvaluator.recover = classmethod(seen)
strategies, _ = RS.load_frozen()
open(os.path.join(sync, "ready." + role), "w").close()
while not all(os.path.exists(os.path.join(sync, "ready." + r)) for r in ("a", "b")):
    time.sleep(0.01)                                       # both start together
try:
    session = TI.recover_session(SimpleNamespace(path=capture), directory, strategies, recovery_ms, products=(TI.BTC, TI.ETH))
    print("won", flush=True)
    session.runner.close()
except Exception as error:
    print("rejected:" + getattr(error, "reason", type(error).__name__), flush=True)
"""


class TestLockIsOwnedBeforeAnythingIsOpened(Base):
    """BAL-REV-190-01 (B5): the session takes the runner's writer lock before it opens, creates or repairs a file, hands that same
    lock to the runner, and lets it go if it fails to start. Two processes that start together: one owns the directory, the
    other is refused before it opens anything."""

    def copy_of_the_snapshot(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        world = self.cache["world"].fork(root, self.cache["snap"]["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(self.cache["snap"]["session"], directory)
        return world, directory, os.path.join(directory, LI.RUNNER_DIR)

    def test_the_lock_is_already_held_when_the_evaluator_log_and_the_audit_are_opened(self):
        world, directory, runner_dir = self.copy_of_the_snapshot()
        held = {}
        real_eval, real_audit = LI.LE.LiveEvaluator.recover.__func__, LI.AuditJournal.open.__func__

        def probe(name):
            try:
                DirectoryLock(runner_dir).release()
                held[name] = False
            except StoreError:
                held[name] = True

        def eval_recover(cls, *a, **k):
            probe("evaluator")
            return real_eval(cls, *a, **k)

        def audit_open(cls, *a, **k):
            probe("audit")
            return real_audit(cls, *a, **k)

        with mock.patch.object(LI.LE.LiveEvaluator, "recover", classmethod(eval_recover)), \
                mock.patch.object(LI.AuditJournal, "open", classmethod(audit_open)):
            session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory), products=(BTC, ETH))
        self.live.append(session)
        self.assertEqual(held, {"evaluator": True, "audit": True})
        with self.assertRaises(StoreError):                     # and it is the runner that keeps it afterwards
            DirectoryLock(runner_dir)

    def test_the_runner_receives_the_very_lock_the_session_took_when_it_recovers(self):
        """D-190-01: not a second lock taken after the session let go of the first (a gap another process could use)."""
        world, directory, runner_dir = self.copy_of_the_snapshot()
        taken, real = [], LI._take_lock

        def spy(path):
            lock = real(path)
            taken.append(lock)
            return lock

        with mock.patch.object(LI, "_take_lock", spy):
            session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory), products=(BTC, ETH))
        self.live.append(session)
        self.assertEqual(len(taken), 1)
        self.assertIs(session.runner.lock, taken[0])

    def test_the_runner_keeps_that_same_lock_until_close(self):
        world, directory, runner_dir = self.copy_of_the_snapshot()
        session = recover_session(world, directory, self.cache["strategies"], journal_clock(directory), products=(BTC, ETH))
        self.live.append(session)
        with self.assertRaises(StoreError):
            DirectoryLock(runner_dir)
        session.runner.close()
        DirectoryLock(runner_dir).release()                      # closing the runner frees it

    def test_a_recovery_that_is_refused_leaves_the_directory_free(self):
        world, directory, runner_dir = self.copy_of_the_snapshot()
        before = disk(directory)
        with self.assertRaises(LI.IntegrationError):
            recover_session(world, directory, self.cache["strategies"], journal_clock(directory), products=(BTC,))   # another product set
        DirectoryLock(runner_dir).release()
        self.assertEqual(disk(directory), before)

    def test_a_session_that_fails_to_start_releases_its_lock_itself(self):
        world, directory, runner_dir = self.copy_of_the_snapshot()
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        fresh = os.path.join(root, "new")
        os.makedirs(fresh)
        with open(os.path.join(fresh, LI.AUDIT_FILE), "w") as handle:      # create() fails when it reaches the audit journal
            handle.write("")
        taken, released = [], []
        real_init, real_release = DirectoryLock.__init__, DirectoryLock.release

        def init(lock, *a, **k):
            real_init(lock, *a, **k)
            taken.append(lock)                                   # keeps it alive: the garbage collector cannot free it for us

        def release(lock, *a, **k):
            released.append(lock)
            return real_release(lock, *a, **k)

        with mock.patch.object(DirectoryLock, "__init__", init), mock.patch.object(DirectoryLock, "release", release):
            with self.assertRaises(LI.IntegrationError):
                new_session(world, fresh, self.cache["strategies"], products=(BTC, ETH))
            self.assertEqual(len(taken), 1)
            self.assertEqual([id(x) for x in released], [id(x) for x in taken])
            DirectoryLock(os.path.join(fresh, LI.RUNNER_DIR)).release()       # free while the first object is still alive

    def test_a_recovery_without_a_runner_directory_opens_and_cuts_nothing(self):
        world, directory, runner_dir = self.copy_of_the_snapshot()
        clock = journal_clock(directory)
        shutil.rmtree(runner_dir)
        with open(os.path.join(directory, LI.AUDIT_FILE), "ab") as handle:
            handle.write(b'{"half": ')                               # a half line that opening the audit would cut
        before = disk(directory)
        with self.assertRaises(LI.IntegrationError) as caught:
            recover_session(world, directory, self.cache["strategies"], clock, products=(BTC, ETH))
        self.assertEqual(caught.exception.reason, "runner_missing")
        self.assertEqual(disk(directory), before)

    def test_two_processes_that_start_together_leave_one_owner_and_the_other_opens_nothing(self):
        here = os.path.dirname(os.path.abspath(__file__))
        py = os.path.dirname(here)
        for round_ in range(3):
            world, directory, _ = self.copy_of_the_snapshot()
            sync = tempfile.mkdtemp()
            self.addCleanup(shutil.rmtree, sync, True)
            env = dict(os.environ, PYTHONPATH=py + os.pathsep + here)
            code = CHILD.format(py=py, tests=here)
            children = {role: subprocess.Popen([sys.executable, "-W", "ignore", "-c", code, directory, world.path,
                                                str(journal_clock(directory)), sync, role], env=env,
                                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for role in ("a", "b")}
            out = {role: proc.communicate(timeout=600)[0].strip().splitlines()[-1:] for role, proc in children.items()}
            results = sorted(v[0] if v else "no-output" for v in out.values())
            with self.subTest(round=round_):
                self.assertEqual(results, ["rejected:runner_directory_locked", "won"])
                opened = sorted(name for name in os.listdir(sync) if name.startswith("opened."))
                self.assertEqual(len(opened), 1)                  # only the owner ever opened the evaluator log


if __name__ == "__main__":
    unittest.main()
