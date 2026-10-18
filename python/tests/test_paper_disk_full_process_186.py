"""Issue #186 (and #185): the disk fills while the PROCESS (Supervisor) is running, seen from the process and not from one writer at a time.
Real BTC candles and quotes (``real_world``), simulated clock. The runner, the session and each file already have their own disk-full tests (#189, #198,
#195, #204/#205, #234); what was not covered is the whole path: the journal refuses a write in the middle of a run, the process halts
durably, an unattended start is refused, and the operator's restart takes the session up again and ends with the same signals and the
same open positions as a run that never had the problem. Nothing is retried, repaired or deleted by the process."""

import collections
import errno
import hashlib
import json
import os
import tempfile
import unittest

from balancita_engine import paper_live_process as LP
from real_session import Base, Clock, DECIDE_FROM, position_detail
from real_world import MIN, RealWorld

FULL = OSError(errno.ENOSPC, "No space left on device")
STEPS = 40
FAIL_FROM_STEP = 12                  # decisions and orders exist by then; the journal refuses every write from the next one on


def signal_ids(supervisor):
    return [e["data"]["signal"]["signal_id"] for e in supervisor.session.runner.log.signals() if e["data"]["origin"] == "original"]


def rejections(supervisor):
    return collections.Counter(e["data"].get("reason") for e in supervisor.session.runner.journal.entries if e["kind"] == "event_rejected")


class TestDiskFullSeenByTheProcess(Base):
    def reference(self):
        """The same run with a disk that never fills: what the final signals and open positions must be."""
        if "disk_full_reference" in self.cache:
            return self.cache["disk_full_reference"]
        root = tempfile.mkdtemp(dir=self.cache["dir"])
        world = RealWorld(root)
        self.addCleanup(world.close)
        world.release_until(DECIDE_FROM - MIN)
        directory = os.path.join(root, "session")
        continuous = self.supervisor(Clock(), world=world, directory=directory)
        continuous.start()
        continuous.run(max_steps=STEPS)
        with open(os.path.join(directory, LP.REPORT_FILE), encoding="utf-8") as handle:
            digests = json.load(handle)["digests"]
        self.cache["disk_full_reference"] = digests, position_detail(continuous), signal_ids(continuous)
        return self.cache["disk_full_reference"]

    def snapshot(self):
        """sha256 of every file of the session directory: what the process wrote, byte by byte."""
        out = {}
        for name in sorted(os.listdir(self.directory)):
            path = os.path.join(self.directory, name)
            if os.path.isfile(path):
                with open(path, "rb") as handle:
                    out[name] = hashlib.sha256(handle.read()).hexdigest()
        return out

    def full_disk(self, supervisor):
        real = supervisor.session.runner.journal.add

        def add(*a, **k):
            if supervisor.session.stats["steps"] >= FAIL_FROM_STEP:
                raise FULL
            return real(*a, **k)
        supervisor.session.runner.journal.add = add

    def test_a_journal_that_refuses_in_the_middle_halts_durably_and_the_operator_restart_ends_as_if_nothing_had_happened(self):
        digests, positions, _ = self.reference()
        self.assertTrue(positions)                                           # the comparison is not between two empty books
        clock = Clock()
        first = self.supervisor(clock, publish_blocks=True)
        first.start()
        self.full_disk(first)
        self.assertEqual(first.run(max_steps=STEPS), LP.EXIT_HALTED)
        halt, report, beat = self.read(LP.HALT_FILE), self.read(LP.REPORT_FILE), self.read(LP.HEARTBEAT_FILE)
        self.assertIn("No space left", halt["reason"])
        self.assertEqual((report["ended_as"], beat["phase"]), (LP.HALTED, LP.HALTED))
        self.assertNotEqual(report["ended_as"], LP.STOPPED_PHASE)                          # a halted process never reports a clean stop
        done = clock.index                                              # the step that failed did not complete
        self.assertGreater(done, 0)
        self.assertLess(done, STEPS)

        unasked = self.supervisor(Clock(done), publish_blocks=True)
        with self.assertRaises(LP.ProcessError) as caught:                                 # the process does not take it up on its own
            unasked.start()
        self.assertEqual(caught.exception.reason, "restart_requires_operator")

        second_clock = Clock(done - 1)                                                     # the instant of the last completed step: no downtime
        second = self.supervisor(second_clock, publish_blocks=True)
        second.start(restart=True)                                                         # the operator, with room on the disk again
        self.assertEqual(second.run(max_steps=STEPS - done + 1), LP.EXIT_OK)
        self.assertEqual(self.read(LP.REPORT_FILE)["digests"]["signals"], digests["signals"])
        self.assertEqual(position_detail(second), positions)

    def test_a_restart_one_step_later_is_an_outage_of_that_step_and_invents_nothing(self):
        """Documents what happens today, it does not judge it: the events the failed step had polled are not journaled, and when the
        restart is at the instant of that step the recovery is one step ahead of them, so the runner refuses them as out of order and the
        signals they would have made are never generated (same rule as any outage). Nothing is invented and nothing already journaled is lost."""
        _, positions, reference_signals = self.reference()
        clock = Clock()
        first = self.supervisor(clock, publish_blocks=True)
        first.start()
        self.full_disk(first)
        self.assertEqual(first.run(max_steps=STEPS), LP.EXIT_HALTED)
        done = clock.index
        before_halt = signal_ids(first)
        second = self.supervisor(Clock(done), publish_blocks=True)
        second.start(restart=True)
        self.assertEqual(second.run(max_steps=STEPS - done), LP.EXIT_OK)
        got = signal_ids(second)
        lost = len(reference_signals) - len(got)
        self.assertGreater(lost, 0)
        self.assertEqual(got[:len(before_halt)], before_halt)                              # what was journaled before the halt is an exact prefix
        self.assertEqual(reference_signals[:len(before_halt)], before_halt)                # ... of the continuous run too
        self.assertEqual(got, before_halt + reference_signals[len(before_halt) + lost:])   # exactly one contiguous block is lost, right after the halt
        self.assertEqual(position_detail(second), positions)                               # the open position is the continuous run's, field by field
        self.assertGreater(rejections(second)["out_of_order_event"], 0)                     # why: the polled events came before the recovery

    def test_a_journal_that_stays_full_leaves_the_halt_and_nothing_else_changing(self):
        clock = Clock()
        first = self.supervisor(clock)
        first.start()
        self.full_disk(first)
        self.assertEqual(first.run(max_steps=STEPS), LP.EXIT_HALTED)
        before = self.snapshot()
        self.assertEqual(first.end(), LP.EXIT_HALTED)                                       # ending a halted process writes no clean stop
        self.assertEqual(self.read(LP.REPORT_FILE)["ended_as"], LP.HALTED)
        self.assertEqual(self.snapshot(), before)                                           # nothing was repaired, retried or deleted


if __name__ == "__main__":
    unittest.main()
