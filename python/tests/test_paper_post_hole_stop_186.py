"""Issue #186, BAL-DECISION-186-05: a stop the market had already gone through while the runner was not observing.

Only when a position is open, a hole of observation is declared and the FIRST valid candle after it opens beyond the stop,
that open is the reference of the exit (``stop_after_hole="gap_open"``, the default), with the existing cost model. It is a
SIMULATED reference: not a fill and not verified liquidity (``stop_exit.evidence`` says so). The exit time is never moved
into the hole, a candle with an invalid open is never used, and every other case (no hole, a later candle, an open before
the stop, quotes) behaves as before. Invented data only."""

import json
import os
import signal
import subprocess
import sys

from balancita_engine import paper_runner_store as ST
from balancita_engine.paper_runner import PaperRunner, RunnerError
from balancita_engine.portfolio_audit import audit, exit_basis

import test_paper_runner_recovery as T

RECOVERY_MS = T.CYCLE + 30 * T.MIN
AFTER_MS = T.CYCLE + 40 * T.MIN
LONG_STOP, SHORT_STOP = "98000", "3640"
# the existing cost model on the open of the candle (BTC 80100 / ETH 4990); the same numbers ``gap_open`` gives as a policy
OPEN_REFERENCE = {T.BTC: "80098.558200", T.ETH: "4990.284430"}
LEVEL_EXIT = {T.BTC: "97998.236000", T.ETH: "3640.207480"}


def both(bucket, off):
    """One candle per product that opens already beyond its stop (BTC 80100 under 98000, ETH 4990 over 3640)."""
    return [T.candle(T.BTC, bucket, 80100, 80200, 80000, 80100, off), T.candle(T.ETH, bucket, 4990, 5000, 4980, 4990, off + 1)]


class PostHoleStop(T.Base):
    def with_open_positions(self, name="run", **config):
        path = os.path.join(self.dir, name)
        r = PaperRunner.create(path, T.cfg(**config), T.strategies())
        self.live.append(r)
        r.run(T.session()[:6])
        self.assertEqual(len(r.portfolio.positions), 2)
        return path, r

    def recovered(self, name="run", **config):
        path, _ = self.with_open_positions(name, **config)
        return path, self.recover(path, RECOVERY_MS, config=T.cfg(**config))

    def trades(self, r):
        return {t["product_id"]: t for t in r.portfolio.trades}

    def test_the_open_beyond_the_stop_after_a_hole_is_the_simulated_reference(self):
        path, r = self.recovered()
        r.run(both(AFTER_MS, 7))
        got = self.trades(r)
        self.assertEqual({p: t["exit_price"] for p, t in got.items()}, OPEN_REFERENCE)
        for product, trade in got.items():
            self.assertEqual(trade["exit_reason"], "stop")
            self.assertEqual(trade["stop_exit"]["evidence"], "ohlc_open_gap_after_hole_simulated")
            self.assertTrue(trade["stop_exit"]["estimated"])
            self.assertFalse(trade["stop_exit"]["quote_backed"])         # never presented as a real fill
            self.assertGreaterEqual(trade["exit_time_ms"], RECOVERY_MS)  # the time is not taken back into the hole
            self.assertEqual(exit_basis(trade), "estimated_from_candles")
        self.assertEqual(audit(r.portfolio)["violations"], [])

    def test_the_reference_is_the_open_not_the_stop_level(self):
        path, r = self.recovered()
        r.run(both(AFTER_MS, 7))
        got = self.trades(r)
        self.assertEqual(got[T.BTC]["stop_exit"]["reference_price"], "80100")
        self.assertEqual(got[T.ETH]["stop_exit"]["reference_price"], "4990")
        self.assertEqual(got[T.BTC]["stop_exit"]["stop_level"], LONG_STOP)
        self.assertEqual(got[T.ETH]["stop_exit"]["stop_level"], SHORT_STOP)

    def test_without_a_hole_the_same_candle_still_exits_at_the_level(self):
        path, r = self.with_open_positions()
        r.run(both(T.CYCLE + 2 * T.MIN, 7))
        got = self.trades(r)
        self.assertEqual({p: t["exit_price"] for p, t in got.items()}, LEVEL_EXIT)
        for trade in got.values():
            self.assertNotIn("stop_exit", trade)

    def test_an_open_before_the_stop_is_the_ordinary_case_even_after_a_hole(self):
        path, r = self.recovered()
        r.run([T.candle(T.BTC, AFTER_MS, 100010, 100020, 80000, 80100, 7), T.candle(T.ETH, AFTER_MS, 3500, 5000, 3499, 4990, 8)])
        self.assertEqual({p: t["exit_price"] for p, t in self.trades(r).items()}, LEVEL_EXIT)
        for trade in self.trades(r).values():
            self.assertNotIn("stop_exit", trade)

    def test_only_the_first_candle_after_the_hole_counts(self):
        path, r = self.recovered()
        quiet = [T.candle(T.BTC, AFTER_MS, 100010, 100100, 99900, 100010, 7), T.candle(T.ETH, AFTER_MS, 3500, 3510, 3490, 3500, 8)]
        r.run(quiet)
        self.assertEqual(len(r.portfolio.positions), 2)
        r.run(both(AFTER_MS + T.MIN, 9))               # a gap later in a continuous stretch: the normal rule
        self.assertEqual({p: t["exit_price"] for p, t in self.trades(r).items()}, LEVEL_EXIT)

    def test_a_candle_with_an_invalid_open_is_rejected_and_the_next_valid_one_is_the_first(self):
        path, r = self.recovered()
        bad = T.candle(T.BTC, AFTER_MS, 90000, 80200, 80000, 80100, 7)          # open above the high: never valid
        r.handle(bad)
        self.assertEqual(len(r.portfolio.positions), 2)
        r.run([T.candle(T.BTC, AFTER_MS + T.MIN, 80100, 80200, 80000, 80100, 8)])
        self.assertEqual(self.trades(r)[T.BTC]["stop_exit"]["evidence"], "ohlc_open_gap_after_hole_simulated")

    def test_a_candle_that_closes_at_the_recovery_is_the_first_one_after_the_hole(self):
        # D-206-01: its minute lies inside the unobserved time, but it is the first thing the runner sees after the
        # hole; the stop level there is the unobserved level the policy avoids, so it takes the simulated open.
        path, r = self.recovered()
        r.run(both(RECOVERY_MS - T.MIN, 7))
        got = self.trades(r)
        for trade in got.values():
            self.assertEqual(trade["stop_exit"]["evidence"], "ohlc_open_gap_after_hole_simulated")
            self.assertGreaterEqual(trade["exit_time_ms"], RECOVERY_MS)

    def test_a_quote_gap_without_any_crash_keeps_the_level(self):
        # BAL-DECISION-186-06 (Fran: No): a silence of quotes longer than coverage_gap_ms, without an interruption, is
        # still declared as a quote_gap but does not activate the simulated open
        path, r = self.with_open_positions()
        r.run([T.quote(T.BTC, T.CYCLE + 4 * T.MIN, "100000", 7), T.quote(T.ETH, T.CYCLE + 4 * T.MIN, "3500", 8)])
        self.assertEqual(sorted(g["kind"] for g in r.coverage["gaps"]), ["quote_gap", "quote_gap"])
        r.run(both(T.CYCLE + 4 * T.MIN, 9))
        got = self.trades(r)
        self.assertEqual({p: t["exit_price"] for p, t in got.items()}, LEVEL_EXIT)
        for trade in got.values():
            self.assertNotIn("stop_exit", trade)

    def test_without_that_gap_the_same_candle_exits_at_the_level(self):
        path, r = self.with_open_positions()
        r.run([T.quote(T.BTC, T.CYCLE + 90 * T.SEC, "100000", 7), T.quote(T.ETH, T.CYCLE + 90 * T.SEC, "3500", 8)])
        self.assertEqual([g for g in r.coverage["gaps"] if g["kind"] == "quote_gap"], [])
        r.run(both(T.CYCLE + 2 * T.MIN, 9))
        self.assertEqual({p: t["exit_price"] for p, t in self.trades(r).items()}, LEVEL_EXIT)

    def test_quotes_after_a_hole_are_treated_as_before_the_policy(self):
        # BAL-DECISION-186-05: "el tratamiento de cotizaciones permanece igual"
        crossing = [T.quote(T.BTC, AFTER_MS, "90000", 7), T.quote(T.ETH, AFTER_MS, "4500", 8)]
        results = []
        for name, policy in (("new", "gap_open"), ("old", "level")):
            path, r = self.recovered(name, stop_after_hole=policy)
            r.run(crossing)
            results.append(sorted((p, t["exit_price"], t["exit_reason"], t["exit_time_ms"], "stop_exit" in t)
                                  for p, t in self.trades(r).items()))
        self.assertEqual(len(results[0]), 2)
        self.assertEqual(results[0], results[1])

    def test_the_book_without_a_valid_open_keeps_the_level_and_declares_it(self):
        path, r = self.recovered()
        book = r.portfolio.positions[T.BTC]
        book.post_hole_stop_reference = True
        try:
            price = book._stop_reference(book.position, {}, T.D("80000"), T.D("80200"))
        finally:
            book.post_hole_stop_reference = False
        self.assertEqual(price, book.position["stop"])
        self.assertEqual(book._pending_evidence, "post_hole_open_unavailable_stop_level")
        self.assertEqual(exit_basis({"exit_reason": "stop", "stop_exit": {"quote_backed": False,
                                                                           "evidence": book._pending_evidence}}),
                         "modelled_at_stop_level")

    def test_recovery_after_the_exit_equals_the_continuous_run(self):
        path, r = self.recovered("a")
        r.run(both(AFTER_MS, 7))
        want = (r.financial_digest(), sorted((p, t["exit_price"]) for p, t in self.trades(r).items()))
        again = self.recover(path, AFTER_MS + T.MIN)
        self.assertEqual((again.financial_digest(), sorted((p, t["exit_price"]) for p, t in self.trades(again).items())), want)
        self.assertEqual(len(again.portfolio.trades), 2)                  # nothing is booked twice

    def test_the_old_behaviour_is_a_named_option_and_a_different_configuration(self):
        path, r = self.recovered("old", stop_after_hole="level")
        r.run(both(AFTER_MS, 7))
        self.assertEqual({p: t["exit_price"] for p, t in self.trades(r).items()}, LEVEL_EXIT)
        with self.assertRaises(RunnerError) as caught:
            self.recover(path, AFTER_MS + T.MIN, config=T.cfg())          # the default policy cannot reinterpret that journal
        self.assertEqual(caught.exception.reason, "config_incompatible")

    def test_the_gap_open_policy_itself_is_not_changed(self):
        path, r = self.recovered("p", stop_policy="gap_open")
        r.run(both(AFTER_MS, 7))
        self.assertEqual({p: t["exit_price"] for p, t in self.trades(r).items()}, OPEN_REFERENCE)
        for trade in self.trades(r).values():
            self.assertEqual(trade["stop_exit"]["evidence"], "ohlc_open_gap")


class AfterARealKill(T.Base):
    CHILD = """
import os, signal, sys
sys.path.insert(0, {py!r})
sys.path.insert(0, {tests!r})
import test_paper_runner_recovery as T
from balancita_engine.paper_runner import PaperRunner
r = PaperRunner.create(sys.argv[1], T.cfg(), T.strategies())
r.run(T.session()[:6])
os.kill(os.getpid(), signal.SIGKILL)
"""

    def test_a_killed_process_then_a_first_candle_beyond_the_stops(self):
        py = os.path.dirname(os.path.dirname(os.path.abspath(ST.__file__)))
        tests = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(self.dir, "killed")
        done = subprocess.run([sys.executable, "-c", self.CHILD.format(py=py, tests=tests), path], capture_output=True,
                              text=True, timeout=120)
        self.assertEqual(done.returncode, -signal.SIGKILL, done.stderr)
        r = self.recover(path, RECOVERY_MS)
        r.run(both(AFTER_MS, 7))
        self.assertEqual({t["product_id"]: t["exit_price"] for t in r.portfolio.trades}, OPEN_REFERENCE)
        gaps = {g["product_id"]: g for g in r.coverage["gaps"] if g["kind"] == "runner_interrupted"}
        self.assertEqual(sorted(gaps), sorted([T.BTC, T.ETH]))           # the hole is still declared next to the price


if __name__ == "__main__":
    import unittest
    unittest.main()
