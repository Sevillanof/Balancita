"""Issue #186 (and #185): the disk fills while the PROCESS (Supervisor) is running, seen from the process and not from one writer at a time.
Invented data, simulated clock, nothing real. The runner, the session and each file already have their own disk-full tests (#189, #198,
#195, #204/#205, #234); what was not covered is the whole path: the journal refuses a write in the middle of a run, the process halts
durably, an unattended start is refused, and the operator's restart takes the session up again and ends with the same signals and the
same open positions as a run that never had the problem. Nothing is retried, repaired or deleted by the process."""

import collections
import errno
import json
import os
import tempfile
import unittest

from balancita_engine import paper_live_process as LP
from live_world import MIN, World
from test_paper_live_integration import FIRST_DECISION
from test_paper_live_process_185 import START, Base, Clock
from test_paper_silent_source_process_186 import position_detail

FULL = OSError(errno.ENOSPC, "No space left on device")
STEPS = 40
FAIL_FROM_STEP = 12                  # decisions and orders exist by then; the journal refuses every write from the next one on


def signal_ids(supervisor):
    return [e["data"]["signal"]["signal_id"] for e in supervisor.session.runner.log.signals() if e["data"]["origin"] == "original"]


def rejections(supervisor):
    return collections.Counter(e["data"].get("reason") for e in supervisor.session.runner.journal.entries if e["kind"] == "event_rejected")


class TestDiskFullSeenByTheProcess(Base):
    def reference(self):
        """The same invented run with a disk that never fills: what the final signals and open positions must be."""
        if "disk_full_reference" in self.cache:
            return self.cache["disk_full_reference"]
        root = tempfile.mkdtemp(dir=self.cache["dir"])
        world = World(root)
        self.addCleanup(world.close)
        world.release_until(FIRST_DECISION - MIN)
        directory = os.path.join(root, "session")
        continuous = self.supervisor(Clock(), world=world, directory=directory)
        continuous.start()
        continuous.run(max_steps=STEPS)
        with open(os.path.join(directory, LP.REPORT_FILE), encoding="utf-8") as handle:
            digests = json.load(handle)["digests"]
        self.cache["disk_full_reference"] = digests, position_detail(continuous), signal_ids(continuous)
        return self.cache["disk_full_reference"]

    def full_disk(self, supervisor):
        real = supervisor.session.runner.journal.add

        def add(*a, **k):
            if supervisor.session.stats["steps"] >= FAIL_FROM_STEP:
                raise FULL
            return real(*a, **k)
        supervisor.session.runner.journal.add = add

    def test_a_journal_that_refuses_in_the_middle_halts_durably_and_the_operator_restart_ends_as_if_nothing_had_happened(self):
        digests, positions, _ = self.reference()
        clock = Clock()
        first = self.supervisor(clock, publish_blocks=True)
        first.start()
        self.full_disk(first)
        self.assertEqual(first.run(max_steps=STEPS), LP.EXIT_HALTED)
        halt, report, beat = self.read(LP.HALT_FILE), self.read(LP.REPORT_FILE), self.read(LP.HEARTBEAT_FILE)
        self.assertIn("No space left", halt["reason"])
        self.assertEqual((report["ended_as"], beat["phase"]), (LP.HALTED, LP.HALTED))
        self.assertNotEqual(report["ended_as"], LP.STOPPED_PHASE)                          # a halted process never reports a clean stop
        done = clock.index - START                                              # the step that failed did not complete
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
        _, _, reference_signals = self.reference()
        clock = Clock()
        first = self.supervisor(clock, publish_blocks=True)
        first.start()
        self.full_disk(first)
        self.assertEqual(first.run(max_steps=STEPS), LP.EXIT_HALTED)
        done = clock.index - START
        second = self.supervisor(Clock(done), publish_blocks=True)
        second.start(restart=True)
        self.assertEqual(second.run(max_steps=STEPS - done), LP.EXIT_OK)
        got = signal_ids(second)
        self.assertTrue(set(got) < set(reference_signals))                                  # fewer, never different
        self.assertEqual([s for s in reference_signals if s in set(got)], got)             # in the same order
        self.assertGreater(len(reference_signals) - len(got), 0)
        self.assertGreater(rejections(second)["out_of_order_event"], 0)                     # why: the polled events came before the recovery

    def test_a_disk_that_stays_full_leaves_the_halt_and_nothing_else_changing(self):
        clock = Clock()
        first = self.supervisor(clock)
        first.start()
        self.full_disk(first)
        self.assertEqual(first.run(max_steps=STEPS), LP.EXIT_HALTED)
        before = {name: os.path.getsize(os.path.join(self.directory, name)) for name in sorted(os.listdir(self.directory))
                  if os.path.isfile(os.path.join(self.directory, name))}
        self.assertEqual(first.end(), LP.EXIT_HALTED)                                       # ending a halted process writes no clean stop
        self.assertEqual(self.read(LP.REPORT_FILE)["ended_as"], LP.HALTED)
        after = {name: os.path.getsize(os.path.join(self.directory, name)) for name in before}
        self.assertEqual(after, before)                                                    # nothing was repaired, retried or deleted


if __name__ == "__main__":
    unittest.main()
