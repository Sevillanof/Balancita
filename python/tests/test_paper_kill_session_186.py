"""Issue #186 (BAL-CIERRE-186-01, scenarios S-K1 and S-K2 of the matrix): a REAL process (SIGKILL, no unwinding) dies around the
journal writes of the step that declares a ``source_stale`` loss, seen from the SESSION. The child process half-writes a journal
line (S-K1) or stops between two entries of the declaration (S-K2: ``source_loss`` and ``order_cancelled``); this process recovers
the directory and makes the same step again: the result must be the one of the step that never failed (same orders with the same
``decided_at`` and the same money), declared once. The market is the real one of ``test_paper_safe_stop_186_session``; only the
S-K5 scenarios (a stop crossed while the process is down) still run on an invented world, until a real market that crosses a stop is found."""

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal as D

from balancita_engine import paper_live_integration as LI
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC
from balancita_engine.paper_runner_store import FileRunnerJournal, JOURNAL_FILE
import test_paper_live_integration as TI
from live_world import LOAD_START, World
from real_session import abandon, journal_clock, record
from test_paper_safe_stop_186_session import NOW, Base, kinds
from test_paper_live_integration import BTC, ETH, HOLE, TIMES, Circuit

HERE = os.path.dirname(os.path.abspath(__file__))


def run_child(test, directory, world, fault, kind, nth=1, in_recovery=False, step=NOW, invented=False):
    """Runs one step in another process that dies (SIGKILL) at the ``nth`` time ``fault`` is reached for ``kind``. Returns the path of
    the marker the worker writes when its recovery has returned (absent if the process died inside the recovery)."""
    stage = directory + ".stage"
    if os.path.exists(stage):
        os.remove(stage)
    env = dict(os.environ, PYTHONPATH=os.pathsep.join((os.path.dirname(HERE), HERE)), KILL_IN_RECOVERY="1" if in_recovery else "0",
               KILL_STAGE_FILE=stage, KILL_INVENTED="1" if invented else "0")
    done = subprocess.run([sys.executable, "-W", "ignore", os.path.join(HERE, "live_kill_store_worker.py"), directory, world.path,
                           str(journal_clock(directory)), fault, kind or "-", str(nth), str(step)],
                          env=env, capture_output=True, text=True, timeout=900)
    test.assertEqual(done.returncode, -signal.SIGKILL, "{} {} #{} was not reached\n{}".format(fault, kind, nth, done.stderr[-2000:]))
    return stage


def raw_journal(directory):
    with open(os.path.join(directory, LI.RUNNER_DIR, JOURNAL_FILE), "rb") as handle:
        return handle.read()


class KillBase(Base):
    def child(self, directory, world, fault, kind, nth=1, in_recovery=False):
        return run_child(self, directory, world, fault, kind, nth, in_recovery)

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
        self.assert_disk_equals_memory(session, directory)
        return session

    def assert_disk_equals_memory(self, session, directory):
        """D-202-01: what the process holds in memory is what the files hold. A half line that was not cut leaves the next entry
        glued to it: the memory looks right and the next start would find a corrupt journal. Both journals are read again from disk."""
        runner_path = os.path.join(directory, LI.RUNNER_DIR, JOURNAL_FILE)
        self.assertTrue(raw_journal(directory).endswith(b"\n"))
        reloaded = FileRunnerJournal.load(runner_path)
        self.assertEqual(reloaded.tail_discarded, 0)
        self.assertEqual([e["hash"] for e in reloaded.entries], [e["hash"] for e in session.runner.journal.entries])
        audit = LI.AuditJournal.open(os.path.join(directory, LI.AUDIT_FILE))
        self.assertEqual(audit.tail_discarded, 0)
        self.assertEqual((len(audit.entries), audit.head), (len(session.audit.entries), session.audit.head))


class TestRealKillAroundTheDeclaration(KillBase):
    """S-K2 (matrix A3, A7, C6): death between ``source_loss`` and ``order_cancelled``, and around each of the two writes."""

    def test_death_at_each_boundary_of_the_two_entries_ends_the_obligation_once(self):
        for kind in ("source_loss", "order_cancelled"):
            for fault in ("before_journal", "mid_journal", "after_journal"):
                with self.subTest(kind=kind, fault=fault):
                    world, directory = self.fork_dir()
                    self.child(directory, world, fault, kind)
                    raw = raw_journal(directory)
                    if fault == "mid_journal":
                        self.assertFalse(raw.endswith(b"\n"), "a torn tail was expected")        # the process left half a line
                    self.finish(world, directory)
                    self.release()

    def test_death_exactly_between_the_loss_and_its_cancellation_leaves_the_loss_without_the_cancellation(self):
        world, directory = self.fork_dir()
        self.child(directory, world, "after_journal", "source_loss")
        journal = FileRunnerJournal.load(os.path.join(directory, LI.RUNNER_DIR, JOURNAL_FILE))
        self.assertEqual(journal.entries[-1]["kind"], "source_loss")                          # the loss is on disk, the cancellation is not
        session = self.reopen(world, directory)
        self.assert_cancelled_by_the_recovery(session)
        abandon(self.live.pop())
        session = self.finish(world, directory)
        self.assertEqual(len(self.losses(session)), 1)
        self.assertEqual(len([e for e in session.runner.journal.entries if e["kind"] == "order_cancelled"]),
                         len([e for e in self.reference_entries() if e["kind"] == "order_cancelled"]))

    def assert_cancelled_by_the_recovery(self, session):
        """D-202-03: right after ``recover`` and BEFORE any step, the order is already cancelled and the cancellation carries the
        recovery's clock: the recovery finished the obligation, not the step that is made again afterwards."""
        cancelled = [e for e in session.runner.journal.entries if e["kind"] == "order_cancelled"]
        self.assertEqual(len(cancelled), 1)
        self.assertIn("recovery_ms", cancelled[0]["data"])
        self.assertEqual(cancelled[0]["data"]["reason"], "source_stale")
        self.assertEqual([o["state"] for o in session.runner.orders() if o["intent_id"] == cancelled[0]["data"]["intent_id"]], ["cancelled"])

    def reference_entries(self):
        world, directory, session = self.fork()
        session.step(NOW)
        return list(session.runner.journal.entries)

    def test_two_deaths_in_a_row_with_the_silence_open_make_one_silence_and_one_cancellation(self):
        world, directory = self.fork_dir()
        first = self.child(directory, world, "after_journal", "source_loss")                   # first death: the loss is journaled
        self.assertTrue(os.path.exists(first), "the first death was meant to happen in the step, after the recovery")
        second = self.child(directory, world, "before_journal", "order_cancelled", in_recovery=True)    # second: inside the recovery
        # D-202-04: the second process died while recovering (it never got to the point where the worker marks "recovered"), and the
        # fault is disarmed once the recovery returns, so a death in the step cannot stand for it
        self.assertFalse(os.path.exists(second), "the second death happened after the recovery returned")
        journal = FileRunnerJournal.load(os.path.join(directory, LI.RUNNER_DIR, JOURNAL_FILE))
        self.assertEqual(journal.entries[-1]["kind"], "source_loss")                        # the cancellation it died writing is not there
        self.assertNotIn("order_cancelled", [e["kind"] for e in journal.entries])
        self.finish(world, directory)


class TestRealKillInTheMiddleOfALine(KillBase):
    """S-K1 (matrix A2): the process dies with a partial line on disk, for several kinds of entry and positions."""

    def test_a_half_written_line_is_cut_and_the_step_comes_out_as_if_nothing_happened(self):
        for kind, nth in (("event_accepted", 1), ("event_accepted", 40), ("decision", 1), ("signals_persisted", 1), ("source_loss", 1)):
            with self.subTest(kind=kind, nth=nth):
                world, directory = self.fork_dir()
                self.child(directory, world, "mid_journal", kind, nth)
                raw = raw_journal(directory)
                self.assertFalse(raw.endswith(b"\n"))                                          # half a line is on disk
                journal = FileRunnerJournal.load(os.path.join(directory, LI.RUNNER_DIR, JOURNAL_FILE))
                self.assertGreater(journal.tail_discarded, 0)                                  # and it is cut, not trusted
                self.finish(world, directory)
                self.release()


STOP_STEP = 106                                  # the step after which ETH has an open LONG (stop 3476.49) and BTC another one
CROSSING = D("3400.0")                           # from this instant on ETH quotes far below that stop, and stays there


class StopCrossedWhileDownBase(object):
    """S-K5 (matrix A6): the process dies with a position open and, while it is down, the market goes below the stop and stays
    there. The recovered run must NOT execute anything with a quote of the downtime (no retroactive execution): the recovery
    declares the uncovered stretch and the position leaves afterwards. Invented data only (the rest of this file runs on the real market). ``COHERENT`` says whether the candles of
    the product tell the same story as its quotes (D-202-05): they do in one scenario and they do not in the other, because the
    two worlds exercise two different doors of the runner."""

    COHERENT = False
    cache = None

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        cls.cache = {}
        cls.cache["dir"] = root = tempfile.mkdtemp()
        strategies, _ = RS.load_frozen()
        cls.cache["strategies"] = strategies
        world = World(root, quote_holes=[HOLE], second_product_shift=5)
        cross_from = TIMES[STOP_STEP] + 60_000
        world.second["quotes"] = [(t, CROSSING if t > cross_from else p) for t, p in world.second["quotes"]]
        if cls.COHERENT:
            for candle in world.second["ones"]:
                if candle["bucket_start"] + 60_000 > cross_from:
                    candle.update(open=str(CROSSING), high=str(CROSSING), low=str(CROSSING), close=str(CROSSING))
        world.release_until(LOAD_START)
        session = TI.new_session(world, os.path.join(root, "a"), strategies, products=(BTC, ETH))
        for now in TIMES[:STOP_STEP + 1]:
            world.release_until(now)
            session.step(now)
        cls.cache["snap"] = Circuit.take_snapshot(root, "k5", session, world, STOP_STEP + 1)
        cls.cache["world"] = world
        for now in TIMES[STOP_STEP + 1:STOP_STEP + 3]:                       # the same two steps without any death
            world.release_until(now)
            session.step(now)
        cls.cache["continuous"] = cls.eth_trades(session)
        abandon(session)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache = None

    @staticmethod
    def eth_trades(session):
        return [t for t in session.runner.portfolio.trades if t["product_id"] == ETH]

    def recovered_and_stepped_twice(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        snap = self.cache["snap"]
        world = self.cache["world"].fork(root, snap["world"])
        directory = os.path.join(root, "s")
        shutil.copytree(snap["session"], directory)
        world.release_until(TIMES[STOP_STEP + 1])
        run_child(self, directory, world, "before_journal", None, step=STOP_STEP + 1, invented=True)        # it dies before its first write of the step
        self.assertTrue(raw_journal(directory).endswith(b"\n"))
        self.assertEqual(self.cache["continuous"][0]["exit_reason"], "stop")                 # the continuous run left through the stop
        self.assertLess(self.cache["continuous"][0]["exit_time_ms"], TIMES[STOP_STEP + 1])  # while the process was down
        recovery_ms = TIMES[STOP_STEP + 1]
        session = TI.recover_session(world, directory, self.cache["strategies"], recovery_ms, products=(BTC, ETH))
        self.addCleanup(abandon, session)
        recovery = [e for e in session.runner.journal.entries if e["kind"] == "recovery"][-1]["data"]
        self.assertIn(ETH, recovery["open_positions"])                          # the open position is declared by the recovery
        self.assertGreater(recovery["uncovered_ms"], 0)                         # and so is the stretch nobody watched
        session.step(recovery_ms)
        self.assertEqual(self.eth_trades(session), [], "the stop was executed with something of the downtime")
        world.release_until(TIMES[STOP_STEP + 2])
        session.step(TIMES[STOP_STEP + 2])
        trades = self.eth_trades(session)
        self.assertEqual(len(trades), 1)
        self.assertEqual(trades[0]["exit_reason"], "stop")
        self.assertEqual(session.runner.integrity()["open_cycles"], [])
        return session, trades[0], recovery_ms


class TestRealKillStopCrossedWhileDownQuotesOnly(StopCrossedWhileDownBase, unittest.TestCase):
    """The door of the quotes: the candles of the product keep their original prices (above the stop), so only its quotes cross the
    stop. The position leaves with the FIRST quote observed after the recovery, at that quote's price, not at the stop's level."""

    def test_the_position_leaves_with_the_first_quote_after_the_recovery_at_its_price(self):
        _, trade, recovery_ms = self.recovered_and_stepped_twice()
        first_after = min(t for t, _ in self.cache["world"].second["quotes"] if t > recovery_ms)
        self.assertEqual(trade["exit_time_ms"], first_after)
        self.assertEqual(D(str(trade["exit_price"])), D("3399.8062"))              # that quote's 3400.0 less the modeled cost, not the stop's level
        self.assertLess(D(str(trade["exit_price"])), CROSSING)


class TestRealKillStopCrossedWhileDownCoherentCandles(StopCrossedWhileDownBase, unittest.TestCase):
    """The door of the candles (D-202-05): the candles tell the same story as the quotes. BAL-DECISION-186-05/06 (#206, in main):
    after a real interruption of the runner the first valid candle that closes at the end of the hole is evaluated against the
    simulated OPENING of that candle (``stop_after_hole = gap_open``, the default), not against the stop's level. The position leaves
    at that open (less the modeled cost), the same price the quotes door gives; it is a SIMULATED reference, not a fill."""

    COHERENT = True

    def test_the_position_leaves_at_the_simulated_open_after_the_hole_not_at_the_stop_level(self):
        _, trade, recovery_ms = self.recovered_and_stepped_twice()
        self.assertEqual(trade["exit_reason"], "stop")
        self.assertEqual(D(str(trade["exit_price"])), D("3399.8062"))              # the candle's open (3400.0) less the modeled cost
        self.assertLess(D(str(trade["exit_price"])), D(str(trade["stop_price"])))  # and not the stop's level (above it, 3476.49)
        self.assertLess(D(str(trade["exit_price"])), CROSSING)
        self.assertGreaterEqual(trade["exit_time_ms"], recovery_ms)                # nothing is executed back in time


def backsteps(times):
    """Where a journal's time goes back. The real history is read after the session starts, so the first events are older than the
    run start; what a jumping clock must not add is any other step back (the normal run has these too)."""
    return [(a, b) for a, b in zip(times, times[1:]) if b < a]


class TestWallClockJumpsDuringAnOpenSilence(Base):
    """S-U4 (matrix E6): the instant the session is given (``observed_now_ms``) jumps backwards or far forwards around the step that
    declares a silence of the source. Nothing may break, nothing may be declared twice, the cancelled order, the money and the signals
    must be the ones of the run whose clock was normal, and the journal's own time never goes back. """

    JUMPS = {"back_before": (-1_800_000, 0), "forward_before": (10 * 86_400_000, 0), "forward_only": (10 * 86_400_000,),
             "back_after": (0, -1_800_000, 60_000), "forward_then_back": (3_600_000, 0, 60_000)}

    def test_a_clock_that_jumps_changes_neither_the_declaration_nor_the_money(self):
        ref = self.reference()
        for name, offsets in self.JUMPS.items():
            with self.subTest(jump=name):
                world, directory, session = self.fork()
                for offset in offsets:
                    now = NOW + offset
                    world.release_until(NOW)                                       # the market itself did not move
                    session.step(now)
                state = record(session, NOW)
                self.assertEqual({k: v for k, v in state.items() if k != "now"}, {k: v for k, v in ref["record"].items() if k != "now"})
                self.assertEqual(self.losses(session), ref["losses"])                              # declared once
                self.assertEqual(kinds(session, "source_stale_detected"), ref["detected"])
                times = [e["t_ms"] for e in session.runner.journal.entries[1:]]       # the first entry is the run start
                self.assertEqual(backsteps(times), backsteps(ref["times"]), "the journal's time went back")
                self.assertEqual(session.runner.integrity()["open_cycles"], [])
                self.release()


# S-U4 / D-202-02 (the branch where the CLOCK carries the declaration, ``observed_silence``) is not here any more: it needs the order to be pending
# while the source is silent and the decision undelivered, which a single real product cannot give (the quote that releases the
# decision also fills the order). It stays covered in ``test_paper_live_integration`` until a second product has real data.


if __name__ == "__main__":
    unittest.main()
