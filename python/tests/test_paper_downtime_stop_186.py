"""Issue #186, scenario A6 / S-K5 at the runner: a process is killed for real (SIGKILL) with both positions open, the
price crosses their stops while it is down, and the recovery has no quote from that time. The outage is a declared hole
of coverage, the stops are not executed with anything retroactive and the first observation after the recovery closes
them. Invented data only; nothing is connected to a live process."""

import json
import os
import signal
import subprocess
import sys
import unittest

from balancita_engine import paper_runner_store as ST
from balancita_engine.paper_runner import PaperRunner

import test_paper_runner_recovery as T

CHILD = """
import os, signal, sys
sys.path.insert(0, {py!r})
sys.path.insert(0, {tests!r})
import test_paper_runner_recovery as T
from balancita_engine.paper_runner import PaperRunner
r = PaperRunner.create(sys.argv[1], T.cfg(), T.strategies())
r.run(T.session()[:int(sys.argv[2])])
os.kill(os.getpid(), signal.SIGKILL)
"""


class StopCrossedDuringTheOutage(T.Base):
    def killed_with_open_positions(self):
        py = os.path.dirname(os.path.dirname(os.path.abspath(ST.__file__)))
        tests = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(self.dir, "killed")
        done = subprocess.run([sys.executable, "-c", CHILD.format(py=py, tests=tests), path, "6"], capture_output=True,
                              text=True, timeout=120)
        self.assertEqual(done.returncode, -signal.SIGKILL, done.stderr)
        return path

    def crossing(self, off):
        """The first observation after the recovery: both prices far beyond their stops (long 98000, short 3640)."""
        t = T.CYCLE + 40 * T.MIN
        return [T.candle(T.BTC, t, 100010, 100020, 80000, 80100, off), T.candle(T.ETH, t, 3500, 5000, 3499, 4990, off + 1)]

    def test_the_outage_is_a_declared_hole_and_the_stops_wait_for_the_first_observation(self):
        path = self.killed_with_open_positions()
        recovery_ms = T.CYCLE + 30 * T.MIN
        r = self.recover(path, recovery_ms)
        self.assertEqual(len(r.portfolio.positions), 2)
        self.assertEqual(len(r.portfolio.trades), 0)                    # nothing was closed by the recovery itself
        gaps = sorted(r.coverage["gaps"], key=lambda g: g["product_id"])    # ETH before XBT
        self.assertEqual([(g["product_id"], g["kind"], g["to_ms"]) for g in gaps],
                         [(T.ETH, "runner_interrupted", recovery_ms), (T.BTC, "runner_interrupted", recovery_ms)])
        for gap in gaps:
            self.assertLess(gap["from_ms"], recovery_ms)
        events = self.crossing(7)
        r.run(events)
        self.assertEqual(len(r.portfolio.positions), 0)
        self.assertEqual(sorted(t["exit_reason"] for t in r.portfolio.trades), ["stop", "stop"])
        for trade in r.portfolio.trades:                                # never before the recovery: no retroactive exit
            self.assertGreaterEqual(trade["exit_time_ms"], recovery_ms)
        self.assertEqual(r.integrity()["offset_holes"], 0)

    def test_a_second_recovery_of_the_same_files_declares_the_same_hole_once(self):
        path = self.killed_with_open_positions()
        first = self.recover(path, T.CYCLE + 30 * T.MIN)
        want = json.dumps(first.coverage["gaps"], sort_keys=True)
        again = self.recover(path, T.CYCLE + 30 * T.MIN)
        self.assertEqual(json.dumps(again.coverage["gaps"], sort_keys=True), want)
        self.assertEqual(len(again.coverage["gaps"]), 2)


if __name__ == "__main__":
    unittest.main()
