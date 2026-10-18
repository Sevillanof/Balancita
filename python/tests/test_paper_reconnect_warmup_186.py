"""Issue #186 (criterion "Reconexion: verificar continuidad/calentamiento antes de reanudar"): the source comes back after losing candles and the
session takes no decision, and so opens no entry, until the continuity and the warm-up are satisfied. Simulated clock, seen from the SESSION
(evaluator + runner), not from one writer. The market is the real one of BTC (``real_world``); the entries are the two that ``Forcing`` makes
(``real_session``), and the only hand-made piece is the outage: the real candles and quotes of ten minutes between them are left out.

What is asserted is what the session does today, with no new rule and no threshold of its own:
* the outage is recorded as a gap and the features are rebuilt from scratch (nothing is decided on features that span the hole);
* the decisions taken before the outage stand and, with the real warm-up that follows a hole (``required_warmup_ms``: 12 days for the frozen
  strategies), the session decides nothing afterwards, so no order is created (no order was pending in the hole, so there is no ``source_loss`` to declare).
The gates that open again (24 h of rebuilt candles, then the shortened warm-up) need more real history than the 19 hours of the sample: the
evaluator-level test of ``gap_warmup`` (``test_paper_live_evaluator``) keeps covering how the session resumes at the instant it names."""

import os
import shutil
import tempfile
import unittest

from balancita_engine import signal_continuity as SC
from real_session import BUY_AT, DECIDE_FROM, STEP, abandon, new_session, strategies
from real_world import MIN, RealWorld

OUTAGE = 10 * MIN
HOLE = BUY_AT[0] + 60 * MIN                  # 18:40Z: after the first forced entry (17:40Z), before the second (19:40Z)
LAST_STEP = (BUY_AT[1] + 60 * MIN - DECIDE_FROM) // STEP


def decisions(session):
    return [e["t_ms"] for e in session.runner.journal.entries if e["kind"] == "decision"]


def run(root, outage_from=None):
    """One session over the real sample up to an hour after the second forced entry. ``outage_from``: the capture loses candles AND quotes
    for ten minutes from then on."""
    holes = [] if outage_from is None else [(outage_from, outage_from + OUTAGE)]
    world = RealWorld(root, quote_holes=holes)
    if outage_from is not None:
        world.candle_rows = [c for c in world.candle_rows if not outage_from <= c["bucket_start"] < outage_from + OUTAGE]
    world.release_until(DECIDE_FROM - MIN)
    session = new_session(world, os.path.join(root, "session"), strategies())
    for index in range(LAST_STEP + 1):
        now = DECIDE_FROM + index * STEP
        world.release_until(now)
        session.step(now)
    report = session.evaluator.report()
    out = {"decisions": decisions(session), "orders": session.runner.orders(), "gaps": report["gaps"], "suppressed": report["suppressed"],
           "kinds": {e["kind"] for e in session.runner.journal.entries}}
    abandon(session)
    world.close()
    return out


class TestReconnectBeforeResuming(unittest.TestCase):
    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        cls.dir = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, True)
        cls.cache.clear()

    def scenario(self, name, **kw):
        if name not in self.cache:
            root = os.path.join(self.dir, name)
            os.makedirs(root)
            self.cache[name] = run(root, **kw)
        return self.cache[name]

    def control(self):
        return self.scenario("control")

    def test_the_control_without_an_outage_decides_both_forced_entries(self):
        control = self.control()
        self.assertEqual((control["gaps"], control["suppressed"]), ([], []))
        self.assertEqual(len(control["decisions"]), 2)
        self.assertEqual(len(control["orders"]), 2)

    def test_an_outage_between_the_entries_keeps_what_was_decided_and_decides_nothing_after(self):
        got = self.scenario("middle", outage_from=HOLE)
        control = self.control()
        self.assertEqual([(g["from_ms"], g["to_ms"]) for g in got["gaps"]], [(HOLE, HOLE + OUTAGE)])
        before = [t for t in control["decisions"] if t < HOLE]
        self.assertEqual(len(before), 1)
        self.assertEqual([t for t in got["decisions"] if t < HOLE], before)                      # what was decided before the hole stands
        self.assertEqual([t for t in got["decisions"] if t >= HOLE], [])                         # the second entry is not taken: nothing after
        self.assertEqual(len(got["orders"]), len(got["decisions"]))                              # no order without a decision behind it
        self.assertNotIn("source_loss", got["kinds"])                                            # no order was pending in the hole: nothing to cancel


if __name__ == "__main__":
    unittest.main()
