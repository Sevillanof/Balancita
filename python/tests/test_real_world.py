"""The real market the session tests replay (``real_world``): the rows are Kraken's own, in the order and at the time they arrived."""

import hashlib
import os
import shutil
import sqlite3
import tempfile
import unittest

import real_world as RW


class RealWorldTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)

    def count(self, world, table):
        return sqlite3.connect(world.path).execute("SELECT COUNT(*) FROM " + table).fetchone()[0]

    def test_the_quote_file_is_the_one_in_the_readme(self):
        with open(RW.QUOTES_FILE, "rb") as handle:
            self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), "5668412ca64cbb824ee141dd59fd417cc4c48ba20967e5b073735fd621035b26")
        quotes = RW.quotes()
        self.assertEqual(len(quotes), 125589)
        self.assertEqual([q[2] for q in quotes], sorted(q[2] for q in quotes))
        self.assertTrue(all(RW.T0 <= q[2] < RW.T_END for q in quotes))
        self.assertTrue(all(float(q[5]) <= float(q[6]) for q in quotes))                      # bid never above ask: the exchange's own

    def test_nothing_is_there_before_it_arrived_and_all_of_it_is_there_after(self):
        world = RW.RealWorld(self.root)
        self.addCleanup(world.close)
        world.release_until(RW.T0)
        self.assertEqual((self.count(world, "paper_futures_official_candles"), self.count(world, "paper_futures_market_events")), (0, 0))
        world.release_until(RW.T0 + 10 * RW.MIN)
        candles = self.count(world, "paper_futures_official_candles")
        self.assertTrue(8 <= candles <= 10, candles)                                              # each real candle is known about 3 s after it closes
        world.release_until(RW.T_END + RW.HOUR)
        self.assertEqual((self.count(world, "paper_futures_official_candles"), self.count(world, "paper_futures_market_events")), (1168, 125589))

    def test_a_row_is_written_when_it_arrived_not_when_Kraken_stamped_it(self):
        late = next(q for q in RW.quotes() if q[2] - q[3] > 50 and q[2] > RW.T0 + RW.MIN)                  # stamped at least 50 ms before it arrived
        world = RW.RealWorld(self.root)
        self.addCleanup(world.close)
        world.release_until(late[2] - 1)
        rows = sqlite3.connect(world.path).execute("SELECT COUNT(*) FROM paper_futures_market_events WHERE seq=? AND epoch=?",
                                                   (late[1], late[0])).fetchone()[0]
        self.assertEqual(rows, 0)
        world.release_until(late[2])
        self.assertEqual(sqlite3.connect(world.path).execute("SELECT COUNT(*) FROM paper_futures_market_events WHERE seq=? AND epoch=?",
                                                             (late[1], late[0])).fetchone()[0], 1)

    def test_a_hole_leaves_real_quotes_out_and_nothing_else(self):
        world = RW.RealWorld(self.root, quote_holes=[(RW.T0 + RW.HOUR, RW.T0 + RW.HOUR + 130 * RW.SEC)])
        self.addCleanup(world.close)
        world.release_until(RW.T_END + RW.HOUR)
        inside = [q for q in RW.quotes() if RW.T0 + RW.HOUR <= q[2] < RW.T0 + RW.HOUR + 130 * RW.SEC]
        self.assertGreater(len(inside), 0)
        self.assertEqual(self.count(world, "paper_futures_market_events"), 125589 - len(inside))
        self.assertEqual(self.count(world, "paper_futures_official_candles"), 1168)

    def test_the_file_says_it_is_a_replay_and_has_no_funding_of_its_own(self):
        world = RW.RealWorld(self.root)
        self.addCleanup(world.close)
        self.assertEqual(self.count(world, "balancita_synthetic_fixture"), 1)
        self.assertEqual((self.count(world, "paper_futures_funding_responses"), self.count(world, "paper_futures_funding_periods")), (0, 0))


if __name__ == "__main__":
    unittest.main()
