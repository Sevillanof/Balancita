import os
import random
import sqlite3
import tempfile
import unittest

from balancita_engine.futures_replay import run
from balancita_engine.futures_simulator import simulate_many
from balancita_engine.futures_spec_strategy import load_specs

from test_futures_spec_strategy import _random_walk

SPECS = list(load_specs().values())
ONES, FIVES = _random_walk(random.Random(11), 1500)
DDL = """
CREATE TABLE paper_futures_official_candles(
  product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL,
  revision_hash TEXT NOT NULL, known_at INTEGER NOT NULL, open_price TEXT NOT NULL,
  high_price TEXT NOT NULL, low_price TEXT NOT NULL, close_price TEXT NOT NULL,
  volume_btc TEXT NOT NULL, response_sha256 TEXT NOT NULL);
"""


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.market = os.path.join(self.dir.name, "market.sqlite")
        db = sqlite3.connect(self.market)
        db.executescript(DDL)
        for c in ONES + FIVES:
            db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
                "PF_XBTUSD", c["interval_ms"], c["bucket_start"], c["revision_hash"], c["known_at"],
                c["open"], c["high"], c["low"], c["close"], c["volume_btc"], "x"))
        db.commit()
        db.close()

    def tearDown(self):
        self.dir.cleanup()

    def test_full_range_equals_the_single_simulator_and_writes_its_own_db(self):
        out = os.path.join(self.dir.name, "run.sqlite")
        start, end = ONES[0]["bucket_start"], ONES[-1]["bucket_start"] + 60_000
        summaries = run(self.market, out, "PF_XBTUSD", start, end, SPECS)
        want = [b.summary() for b in simulate_many(SPECS, ONES, FIVES)]
        self.assertEqual(summaries, want)
        db = sqlite3.connect(out)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM replay_summary").fetchone()[0], len(SPECS))
        self.assertEqual(db.execute("SELECT COUNT(*) FROM replay_trade").fetchone()[0], sum(s["trades"] for s in want))
        with self.assertRaises(FileExistsError):
            run(self.market, out, "PF_XBTUSD", start, end, SPECS)

    def test_a_sub_range_only_trades_inside_it(self):
        out = os.path.join(self.dir.name, "sub.sqlite")
        start = ONES[800]["bucket_start"]
        end = ONES[1200]["bucket_start"]
        run(self.market, out, "PF_XBTUSD", start, end, SPECS)
        db = sqlite3.connect(out)
        buckets = [r[0] for r in db.execute("SELECT bucket_ms FROM replay_decision")]
        self.assertTrue(buckets)
        self.assertTrue(all(start <= b < end for b in buckets))

    def test_empty_range_is_refused(self):
        with self.assertRaises(ValueError):
            run(self.market, os.path.join(self.dir.name, "e.sqlite"), "PF_XBTUSD", 5, 5, SPECS)


if __name__ == "__main__":
    unittest.main()
