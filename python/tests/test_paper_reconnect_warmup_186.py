"""Issue #186 (criterion "Reconexion: verificar continuidad/calentamiento antes de reanudar"): the source comes back after losing candles and the
session takes no decision, and so opens no entry, until the continuity and the warm-up are satisfied; then it decides again. Invented data,
simulated clock, nothing real. Seen from the SESSION (evaluator + runner), not from one writer.

What is asserted is what the session does today, with no new rule and no threshold of its own:
* the outage is recorded as a gap and the features are rebuilt from scratch (nothing is decided on features that span the hole);
* two gates keep the session from deciding: the rebuilt indicators must be ready (measured below: 24 h of candles after the hole for the frozen
  strategies) and the evaluator's own warm-up after a hole (``required_warmup_ms``: 12 days for the frozen strategies, patched here only to make
  the second gate reachable inside the invented day, in the tests that say so);
* a cycle held back by the warm-up is written down as ``gap_warmup`` with the instant it waits for, and the session resumes at that instant,
  not before and not later;
* the same outage in the middle of the decision day, with the real warm-up, leaves the decisions taken before it untouched and decides
  nothing afterwards, so no order is created.
The shortened warm-up is test-only: it proves the gate, not the 12 days."""

import os
import shutil
import tempfile
import unittest
from unittest import mock

from balancita_engine import paper_live_evaluator as LE
from balancita_engine import replay_specs as RS
from live_world import HOUR, LOAD_START, MIN, SEC, World
from test_paper_live_integration import FIRST_DECISION, TIMES, new_session

OUTAGE = 10 * MIN
CANDLE_LAG_MS = 2 * SEC                      # the synthetic capture writes a candle two seconds after it closes
READY_AFTER_HOLE_MS = 24 * HOUR              # measured: the longest indicator of the frozen strategies needs this much rebuilt history


def decisions(session):
    return [e["t_ms"] for e in session.runner.journal.entries if e["kind"] == "decision"]


def run(root, outage_from=None, warmup_ms=None):
    """One invented session over the whole day. ``outage_from``: the capture loses candles AND quotes for ten minutes from then on."""
    holes = [] if outage_from is None else [(outage_from, outage_from + OUTAGE)]
    world = World(root, quote_holes=holes)
    if outage_from is not None:
        world.ones = [c for c in world.ones if not outage_from <= c["bucket_start"] < outage_from + OUTAGE]
    world.release_until(LOAD_START)
    strategies, _ = RS.load_frozen()
    patch = mock.patch.object(LE, "required_warmup_ms", lambda periods: warmup_ms) if warmup_ms is not None else mock.MagicMock()
    with patch:
        session = new_session(world, os.path.join(root, "session"), strategies)
        for now in TIMES:
            world.release_until(now)
            session.step(now)
    report = session.evaluator.report()
    out = {"decisions": decisions(session), "orders": session.runner.orders(), "gaps": report["gaps"], "suppressed": report["suppressed"],
           "kinds": {e["kind"] for e in session.runner.journal.entries}}
    session.runner.close()
    session.reader.close()
    session.funding.close()
    world.close()
    return out


class TestReconnectBeforeResuming(unittest.TestCase):
    cache = {}

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, True)

    def scenario(self, name, **kw):
        if name not in self.cache:
            root = os.path.join(self.dir, name)
            os.makedirs(root)
            self.cache[name] = run(root, **kw)
        return self.cache[name]

    def control(self):
        return self.scenario("control")

    def test_the_control_without_an_outage_decides_from_the_first_decision_on(self):
        control = self.control()
        self.assertEqual((control["gaps"], control["suppressed"]), ([], []))
        self.assertGreater(len(control["decisions"]), 0)
        self.assertLess(control["decisions"][0], FIRST_DECISION + HOUR)

    def test_rebuilt_indicators_not_ready_decide_nothing_until_they_are(self):
        hole = FIRST_DECISION - 20 * HOUR
        got = self.scenario("ready_gate", outage_from=hole, warmup_ms=6 * HOUR)
        end = hole + OUTAGE
        self.assertEqual([(g["from_ms"], g["to_ms"]) for g in got["gaps"]], [(hole, end)])      # the reconnect is on record
        self.assertEqual(got["suppressed"], [])                                                 # it is not the warm-up that holds it here
        first = got["decisions"][0]
        self.assertGreater(first, self.control()["decisions"][0])                               # the control already decided by then
        self.assertGreaterEqual(first, end + READY_AFTER_HOLE_MS)                               # not before the rebuilt indicators are ready
        self.assertLess(first, end + READY_AFTER_HOLE_MS + 10 * MIN)                            # and as soon as they are
        self.assertEqual(len(got["orders"]), len(got["decisions"]))                             # no order without a decision behind it

    def test_the_warmup_after_the_hole_holds_every_cycle_back_and_the_session_resumes_at_the_instant_it_names(self):
        hole = FIRST_DECISION - 20 * HOUR
        warmup = 30 * HOUR
        got = self.scenario("warmup_gate", outage_from=hole, warmup_ms=warmup)
        end = hole + OUTAGE
        until = end + warmup
        self.assertEqual([(g["from_ms"], g["to_ms"]) for g in got["gaps"]], [(hole, end)])
        self.assertGreater(len(got["suppressed"]), 0)
        self.assertEqual({s["reason"] for s in got["suppressed"]}, {"gap_warmup"})
        self.assertEqual({s["until_ms"] for s in got["suppressed"]}, {until})                   # the instant it waits for, written down
        self.assertTrue(all(s["cycle_ms"] < until for s in got["suppressed"]))
        before = [t for t in got["decisions"] if t < until]
        after = [t for t in got["decisions"] if t >= until]
        self.assertEqual(before, [])                                                            # no decision, so no entry, before it
        self.assertGreater(len(after), 0)                                                       # and it decides again after it
        self.assertLess(after[0], until + 10 * MIN)                                             # at the first cycle that is allowed
        self.assertEqual(len(got["orders"]), len(got["decisions"]))
        self.assertTrue(all(o["timeline"]["decided_ms"] >= until for o in got["orders"]))       # no order was decided before it either

    def test_an_outage_in_the_middle_of_the_day_with_the_real_warmup_keeps_what_was_decided_and_decides_nothing_after(self):
        hole = FIRST_DECISION + 2 * HOUR
        got = self.scenario("middle", outage_from=hole)
        control = self.control()
        self.assertEqual([(g["from_ms"], g["to_ms"]) for g in got["gaps"]], [(hole, hole + OUTAGE)])
        cut = hole + CANDLE_LAG_MS                  # the last cycle before the hole closes at its start and is decided a moment later
        before = [t for t in control["decisions"] if t <= cut]
        self.assertGreater(len(before), 0)
        self.assertEqual([t for t in got["decisions"] if t <= cut], before)                     # what was decided before the hole stands
        self.assertEqual([t for t in got["decisions"] if t > cut], [])                          # nothing after, up to the end of the day
        self.assertEqual(len(got["orders"]), len(got["decisions"]))
        self.assertIn("source_loss", got["kinds"])                                              # the outage was declared by the session too


if __name__ == "__main__":
    unittest.main()
