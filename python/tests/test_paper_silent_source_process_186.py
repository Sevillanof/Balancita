"""Issue #186 (and #185): a source that goes silent for a long stretch, seen from the PROCESS (Supervisor), not from the runner. Invented data,
simulated clock, nothing real. The session has no limit named for silence here: what is asserted is what the process does today, so a change
that makes a silent source open entries, halt the session on its own, or touch an open position shows up as a failing test.

What the process does (and does not do) while the capture file is still the same file but nothing new is written to it:
* it keeps stepping on its clock, does not halt, and takes no decision on rows it never received;
* it opens no entry (nothing was decided) and does not touch what is open;
* when rows come back it takes decisions again from where the data really is;
* the orderly stop ends it with the report as for any other stop.
LIMITATION (recorded, not a defect of this test): the heartbeat carries no field that says the source is silent, so an operator reading only
the heartbeat sees a LIVE session whose steps advance. Showing it needs a decision (field and threshold) and is not done here."""

import collections
import os
import unittest

from balancita_engine import paper_live_process as LP
from test_paper_live_integration import TIMES
from test_paper_live_process_185 import START, Base

STEPS = 90                       # about the first third of the invented session: enough to see decisions before, during and after


def position_detail(supervisor):
    """Everything that identifies an open position and its protection, as the runner holds it (not a count)."""
    rows = []
    for product, book in sorted(supervisor.session.runner.portfolio.positions.items()):
        pos = book.position
        rows.append((product, book.intent["intent_id"], pos["side"], int(pos["entry_ms"]), str(pos["entry"]), str(pos["stop"]),
                     str(pos["target"]), str(pos["quantity"])))
    return rows


def kinds(supervisor):
    return collections.Counter(e["kind"] for e in supervisor.session.runner.journal.entries)


class Gate(object):
    """Lets rows through except in the window [first, last) of steps counted from START; remembers what the session had done at each edge."""

    def __init__(self, supervisor, first, last):
        self.supervisor, self.first, self.last = supervisor, first, last
        self.original, self.edges, self.details = supervisor.tick, {}, {}
        supervisor.tick = self.tick

    def tick(self, now):
        step = next((i for i, t in enumerate(TIMES) if t >= now), len(TIMES)) - START
        if step in (self.first, self.last) and step not in self.edges:
            self.edges[step] = (kinds(self.supervisor).get("decision", 0), len(self.supervisor.session.runner.orders()))
            self.details[step] = position_detail(self.supervisor)
        if not (self.first <= step < self.last):
            self.original(now)


class TestSilentSourceSeenByTheProcess(Base):
    def run_with_silence(self, first, last, steps=STEPS, **over):
        supervisor = self.supervisor(self.clock(), publish_blocks=True, **over)
        supervisor.start()
        gate = Gate(supervisor, first, last)
        code = supervisor.run(max_steps=steps)
        return supervisor, gate, code

    def clock(self):
        from test_paper_live_process_185 import Clock
        return Clock()

    def test_a_source_silent_from_the_start_is_stepped_through_without_one_decision_and_stops_in_order(self):
        supervisor, _, code = self.run_with_silence(0, 10 ** 6)
        self.assertEqual(code, LP.EXIT_OK)
        self.assertNotIn("decision", kinds(supervisor))
        self.assertEqual(supervisor.session.runner.orders(), [])
        report, beat = self.read(LP.REPORT_FILE), self.read(LP.HEARTBEAT_FILE)
        self.assertEqual(report["steps"], STEPS)
        self.assertEqual((report["ended_as"], report["halted"]), (LP.STOPPED_PHASE, None))
        self.assertEqual(beat["open_positions"], 0)
        self.assertFalse(os.path.exists(os.path.join(self.directory, LP.HALT_FILE)))

    def test_a_silence_in_the_middle_takes_no_decision_inside_it_and_decisions_come_back_with_the_data(self):
        supervisor, gate, code = self.run_with_silence(30, 60)
        self.assertEqual(code, LP.EXIT_OK)
        before, after = gate.edges[30], gate.edges[60]
        self.assertGreater(before[0], 0, "the session was deciding before the silence")
        self.assertEqual(before, after, "no decision and no order while nothing arrived")
        self.assertGreater(kinds(supervisor)["decision"], after[0], "decisions resume when rows come back")
        self.assertEqual(self.read(LP.REPORT_FILE)["halted"], None)

    def test_an_open_position_is_left_exactly_as_it_was_by_the_silence_and_by_the_stop(self):
        supervisor, gate, code = self.run_with_silence(30, 10 ** 6, steps=60)          # the source never comes back; the process stops by itself
        self.assertEqual(code, LP.EXIT_OK)
        report = self.read(LP.REPORT_FILE)
        beat = self.read(LP.HEARTBEAT_FILE)
        self.assertEqual(beat["open_positions"], 1, "the position opened before the silence is still there")
        self.assertEqual(report["positions"]["open_at_end"], 1)                        # reported as left open, not closed or modified by the stop
        self.assertIn("nobody evaluates their stops", report["positions"]["note"])
        self.assertEqual(gate.edges[30][1], len(supervisor.session.runner.orders()))   # not one order was added after the last row
        # the position itself (side, quantity, entry, stop, target, intent) is the one the silence found, not only the same count
        before, after = gate.details[30], position_detail(supervisor)
        self.assertEqual(len(before), 1)
        self.assertEqual(before, after)
        product, intent_id, side, entry_ms, entry, stop, target, quantity = after[0]
        document = self.read(LP.BLOCKS_FILE)["positions"]["positions"]                  # and the published document describes that same position
        self.assertEqual([(r["product_id"], r["intent_id"], r["side"], r["entry_ms"], r["entry_price"], r["stop"], r["target"], r["quantity"])
                          for r in document], after)

    def test_the_published_positions_block_says_source_stale_exactly_while_the_source_is_silent(self):
        """The visibility that already exists, pinned (no new field, no new threshold): the ingestor's own state turns ``stale`` after its
        ``dead_after_ms`` (a hypothesis, not a calibrated value) and the published positions block carries ``source_stale`` among the
        verification reasons, which the view labels «Fuente desactualizada». It goes away when rows come back. The heartbeat says nothing:
        this is the only place, and it is the same block that already says the figures are not verified."""
        supervisor = self.supervisor(self.clock(), publish_blocks=True)
        supervisor.start()
        Gate(supervisor, 30, 60)
        seen, real = [], supervisor._beat

        def spy(now, state):
            real(now, state)
            if state is None:                                                              # the beats of the orderly end carry no poll
                return
            seen.append((state["source"], self.read(LP.BLOCKS_FILE)["positions"]["verification"]))
        supervisor._beat = spy
        self.assertEqual(supervisor.run(max_steps=STEPS), LP.EXIT_OK)
        stale = [i for i, (source, _) in enumerate(seen) if source == "stale"]
        self.assertTrue(stale)
        self.assertEqual(stale, list(range(stale[0], stale[-1] + 1)))                    # one contiguous stretch, inside the silence
        self.assertGreaterEqual(stale[0], 30)
        self.assertLess(stale[-1], 60)
        for i, (source, verification) in enumerate(seen):
            with self.subTest(step=i, source=source):
                self.assertEqual("source_stale" in verification["reasons"], source == "stale")
                self.assertFalse(verification["verified"])                              # never verified, silent or not (no approved threshold)
                self.assertEqual(verification["freshness"], "unknown")

    def test_the_silence_and_the_publication_together_never_present_the_session_as_confirmed_alive(self):
        supervisor, _, _ = self.run_with_silence(30, 10 ** 6, steps=60)
        document = self.read(LP.BLOCKS_FILE)
        self.assertIn(document["status"]["liveness"], ("unknown", "final"))               # the writer measures no age and claims no confirmation
        self.assertEqual(document["status"]["phase"], "STOPPED")
        self.assertIs(document["derived"], True)
        self.assertEqual(document["authority"], "none")


if __name__ == "__main__":
    unittest.main()
