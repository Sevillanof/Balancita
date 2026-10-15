"""Issue #186, scenario A6 / S-K5 at the runner: a process is killed for real (SIGKILL) with both positions open and
the market goes through their stops while it is down. The first observation after the recovery already opens beyond the
stops (long stop 98000, short stop 3640; the candle opens at 80100 / 4990), so the stop was crossed during the outage,
not inside that candle. The outage is a declared hole of coverage that starts at the last evidence before the kill, the
stops are not executed retroactively in time, and the first observation closes them at the price each ``stop_policy``
defines. Invented data only; nothing is connected to a live process.

What applies after an outage is Fran's decision BAL-DECISION-186-05 (``stop_after_hole``, #206): by default the first
valid candle after a real interruption gives its open as a SIMULATED reference (80098.56 / 4990.28) even with
``stop_policy="level"``; ``stop_after_hole="level"`` keeps the earlier behaviour (the stop level, 97998.24 / 3640.21, a price
never observed after the recovery). ``gap_open`` and ``gap_worst`` do not depend on it."""

import os
import signal
import subprocess
import sys
import unittest

from balancita_engine import paper_runner_store as ST

import test_paper_runner_recovery as T

CHILD = """
import os, signal, sys
sys.path.insert(0, {py!r})
sys.path.insert(0, {tests!r})
import test_paper_runner_recovery as T
from balancita_engine.paper_runner import PaperRunner
r = PaperRunner.create(sys.argv[1], T.cfg(stop_policy=sys.argv[3], stop_after_hole=sys.argv[4]), T.strategies())
r.run(T.session()[:int(sys.argv[2])])
os.kill(os.getpid(), signal.SIGKILL)
"""

RECOVERY_MS = T.CYCLE + 30 * T.MIN
FIRST_OBSERVATION_MS = T.CYCLE + 40 * T.MIN
# last quote of each product before the kill (events 3 and 4 of ``T.session()``): where the unobserved time starts
LAST_EVIDENCE = {T.BTC: T.CYCLE + 5 * T.SEC, T.ETH: T.CYCLE + 6 * T.SEC}
# (stop_policy, stop_after_hole) -> exit price
EXIT = {("level", "level"): {T.BTC: "97998.236000", T.ETH: "3640.207480"},
        ("level", "gap_open"): {T.BTC: "80098.558200", T.ETH: "4990.284430"},
        ("gap_open", "gap_open"): {T.BTC: "80098.558200", T.ETH: "4990.284430"},
        ("gap_worst", "gap_open"): {T.BTC: "79998.560000", T.ETH: "5000.285000"}}


class StopCrossedDuringTheOutage(T.Base):
    def killed_with_open_positions(self, policy, name, after_hole="gap_open"):
        py = os.path.dirname(os.path.dirname(os.path.abspath(ST.__file__)))
        tests = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(self.dir, name)
        done = subprocess.run([sys.executable, "-c", CHILD.format(py=py, tests=tests), path, "6", policy, after_hole],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, -signal.SIGKILL, done.stderr)
        return path

    def first_observation(self, off):
        """Both products already beyond their stops when it opens, and still beyond when it closes."""
        t = FIRST_OBSERVATION_MS
        return [T.candle(T.BTC, t, 80100, 80200, 80000, 80100, off), T.candle(T.ETH, t, 4990, 5000, 4980, 4990, off + 1)]

    def outage_gaps(self, runner):
        return {g["product_id"]: g for g in runner.coverage["gaps"] if g["kind"] == "runner_interrupted"}

    def test_the_outage_is_a_hole_from_the_last_evidence_and_nothing_is_closed_by_the_recovery(self):
        path = self.killed_with_open_positions("level", "killed")
        r = self.recover(path, RECOVERY_MS)
        self.assertEqual(len(r.portfolio.positions), 2)
        self.assertEqual(len(r.portfolio.trades), 0)
        gaps = self.outage_gaps(r)
        self.assertEqual(sorted(gaps), sorted(LAST_EVIDENCE))
        for product, gap in gaps.items():
            self.assertEqual((gap["from_ms"], gap["to_ms"]), (LAST_EVIDENCE[product], RECOVERY_MS), product)

    def test_the_first_observation_beyond_the_stops_closes_them_at_the_price_of_each_policy(self):
        for (policy, after_hole), expected in EXIT.items():
            with self.subTest(stop_policy=policy, stop_after_hole=after_hole):
                path = self.killed_with_open_positions(policy, "killed-%s-%s" % (policy, after_hole), after_hole)
                r = self.recover(path, RECOVERY_MS, config=T.cfg(stop_policy=policy, stop_after_hole=after_hole))
                r.run(self.first_observation(7))
                self.assertEqual(len(r.portfolio.positions), 0)
                got = {t["product_id"]: t for t in r.portfolio.trades}
                self.assertEqual(sorted(got), sorted(expected))
                for product, trade in got.items():
                    self.assertEqual(trade["exit_reason"], "stop")
                    self.assertEqual(str(trade["exit_price"]), expected[product], product)
                    self.assertGreaterEqual(trade["exit_time_ms"], RECOVERY_MS)     # never inside the outage
                self.assertEqual(r.integrity()["offset_holes"], 0)

    def test_a_second_recovery_of_the_same_files_declares_the_same_hole(self):
        path = self.killed_with_open_positions("level", "twice")
        first = self.outage_gaps(self.recover(path, RECOVERY_MS))
        again = self.outage_gaps(self.recover(path, RECOVERY_MS))
        self.assertEqual(again, first)
        self.assertEqual(len(again), 2)


if __name__ == "__main__":
    unittest.main()
