"""Issue #184 (PR 5b): the session counts the official candles that arrive incomplete, and reports the number.

A candle is incomplete when its first version was read before its minute was over (``known_at < bucket + 60 s``). The session uses that
first version as it came (Fran, 17-oct 13:42Z) and does not stop for it: the counter is only evidence, in the heartbeat (``ingest_state``)
and in the final report (``candles_incomplete``). The ingestor cases use a few hand-written rows; the real BTC sample is read as it was
captured (it has no incomplete candle, Captura's 24 h measurement), and one real candle is read early to show the number in the files."""

import os
import shutil
import tempfile
import unittest

from balancita_engine import paper_live_process as LP
from balancita_engine.paper_live_ingest import Ingestor, SourceReader
from real_session import DECIDE_FROM, STEP, Base, Clock
from real_world import RealWorld
from test_paper_live_ingest import BTC, MIN, SEC, Source

B0 = 1_700_000_000_000 - (1_700_000_000_000 % MIN)


class TestCountAtTheIngestor(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.src = Source(os.path.join(self.dir, "market.sqlite"))
        for k in range(0, 12 * 60, 5):
            self.src.ticker(BTC, B0 + k * SEC, "100000")
        self.reader = SourceReader(self.src.path)
        self.addCleanup(self.reader.close)

    def poll(self, ing, now):
        out = ing.poll(now)
        while out["state"]["more_to_read"]:
            out = ing.poll(now)
        return out

    def test_only_a_first_version_read_before_its_minute_ended_is_counted(self):
        self.src.candle(BTC, B0, 1, 2, 1, 2)                                              # known 2 s after its minute: complete
        self.src.candle(BTC, B0 + MIN, 1, 2, 1, 2, known_at=B0 + MIN + 30 * SEC)           # read halfway through its minute: incomplete
        self.src.candle(BTC, B0 + 2 * MIN, 1, 2, 1, 2, known_at=B0 + 3 * MIN)              # exactly at its end: complete
        self.src.candle(BTC, B0 + 3 * MIN, 1, 2, 1, 2, known_at=B0 + 3 * MIN + 59 * SEC)   # one second before its end: incomplete
        self.src.commit()
        ing = Ingestor(self.reader, expected_products=(BTC,))
        out = self.poll(ing, B0 + 10 * MIN)
        self.assertEqual(out["state"]["stats"]["candles_incomplete"], 2)

    def test_the_session_uses_the_incomplete_version_as_it_came_and_a_later_revision_does_not_count_again(self):
        self.src.candle(BTC, B0, 1, 2, 1, 2, known_at=B0 + 20 * SEC, revision="r1")                  # the partial minute
        self.src.candle(BTC, B0, 1, 3, 1, 3, known_at=B0 + MIN + 2 * SEC, revision="r2")             # the minute as it ended
        self.src.commit()
        ing = Ingestor(self.reader, expected_products=(BTC,))
        out = self.poll(ing, B0 + 10 * MIN)
        events = [e for e in out["events"] if e["kind"] == "candle"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["payload"]["candle"]["high"], "2")                                # the first version, not the revision
        self.assertEqual(out["state"]["stats"]["candles_incomplete"], 1)                             # once
        self.assertEqual(out["state"]["stats"]["candle_revisions_differing"], 1)

    def test_the_count_survives_a_checkpoint_and_an_old_checkpoint_without_it_starts_at_zero(self):
        self.src.candle(BTC, B0, 1, 2, 1, 2, known_at=B0 + 20 * SEC)
        self.src.commit()
        ing = Ingestor(self.reader, expected_products=(BTC,))
        self.poll(ing, B0 + 2 * MIN)
        state = ing.checkpoint()
        resumed = Ingestor.from_checkpoint(self.reader, state, expected_products=(BTC,))
        self.assertEqual(resumed.stats["candles_incomplete"], 1)
        del state["stats"]["candles_incomplete"]                                                     # a checkpoint written before this counter existed
        old = Ingestor.from_checkpoint(self.reader, state, expected_products=(BTC,))
        self.assertEqual(old.stats["candles_incomplete"], 0)


class TestOnTheRealMarket(Base):
    def read_all(self, world):
        reader = SourceReader(world.path)
        self.addCleanup(reader.close)
        ing = Ingestor(reader, expected_products=(BTC,), causal_until_clock=False)
        world.release_until(DECIDE_FROM + 200 * MIN)
        out = ing.poll(DECIDE_FROM + 200 * MIN)
        while out["state"]["more_to_read"]:
            out = ing.poll(DECIDE_FROM + 200 * MIN)
        return out["state"]["stats"]

    def test_the_real_candles_are_all_complete(self):
        stats = self.read_all(self.world)
        self.assertGreater(stats["emitted"], 0)
        self.assertEqual(stats["candles_incomplete"], 0)

    def test_the_heartbeat_and_the_report_carry_the_number(self):
        world = self.world
        rows = list(world.candle_rows)
        early = next(i for i, r in enumerate(rows) if r["bucket_start"] == DECIDE_FROM + 20 * MIN)
        rows[early] = dict(rows[early], known_at=rows[early]["bucket_start"] + 30 * SEC)         # one real candle, read halfway through its minute
        world.candle_rows = sorted(rows, key=lambda r: (r["known_at"], r["bucket_start"]))
        supervisor = self.supervisor(Clock())
        supervisor.start()
        beats = []
        original = supervisor._beat

        def spy(now, state):
            original(now, state)
            beats.append(self.read(LP.HEARTBEAT_FILE))
        supervisor._beat = spy
        self.assertEqual(supervisor.run(max_steps=9), LP.EXIT_OK)
        report = self.read(LP.REPORT_FILE)
        self.assertEqual(report["candles_incomplete"], 1)
        self.assertEqual(report["ended_as"], "STOPPED")                                              # an incomplete candle does not stop the session by itself
        counts = [b["ingest_state"]["stats"]["candles_incomplete"] for b in beats if b["ingest_state"]]
        self.assertEqual(counts[0], 0)                                                               # before the early candle was read
        self.assertEqual(counts[-1], 1)                                                              # and in the last heartbeat of the run


if __name__ == "__main__":
    unittest.main()
