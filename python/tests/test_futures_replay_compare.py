import json
import os
import random
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_replay_compare as rc


class SignFlipTests(unittest.TestCase):
    def test_a_consistent_gain_over_many_days_is_significant_and_noise_is_not(self):
        self.assertLess(rc.sign_flip_p([4, 5, 3, 6, 4, 5, 4, 3, 5, 6]), 0.01)
        rng = random.Random(1)
        self.assertGreater(rc.sign_flip_p([rng.choice((-5, 5)) for _ in range(10)] + [0]), 0.2)

    def test_one_day_cannot_prove_anything(self):
        self.assertEqual(rc.sign_flip_p([50]), 1.0)

    def test_no_difference_is_p_one(self):
        self.assertEqual(rc.sign_flip_p([0, 0, 0]), 1.0)


class PointsAndCompareTests(unittest.TestCase):
    def test_points_follow_the_live_rule_and_only_the_shared_buckets_are_compared(self):
        step = 60_000
        closes = {i * step: "100" for i in range(120)}
        closes[30 * step] = "101"  # +100 bp: buy wins after costs
        closes[31 * step] = "99"   # -100 bp from bucket 1
        a = rc.points({0: "hold", step: "sell", 2 * step: "hold"}, closes, "PF_XBTUSD")
        b = rc.points({0: "buy", step: "sell"}, closes, "PF_XBTUSD")
        self.assertEqual(a[0], -1)  # hold, but buy was right
        self.assertEqual(b[0], 1)
        self.assertNotIn(2 * step, b)
        result = rc.compare("a", "b", a, b, closes, "PF_XBTUSD")
        self.assertEqual((result["shared"], result["mean_diff"]), (2, 1.0))

    def test_run_dbs_are_read_back(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "r.sqlite")
            db = sqlite3.connect(path)
            db.executescript("CREATE TABLE replay_run(key TEXT, value TEXT);"
                             "CREATE TABLE replay_qwen_decision(id INTEGER PRIMARY KEY, bucket_ms INTEGER, payload TEXT);")
            db.execute("INSERT INTO replay_run VALUES('product_id', '\"PF_XBTUSD\"')")
            db.execute("INSERT INTO replay_qwen_decision(bucket_ms, payload) VALUES(5, ?)",
                       (json.dumps({"bucket_start": 5, "chosen": "buy"}),))
            db.commit()
            db.close()
            meta, chosen = rc.read_run(path)
        self.assertEqual((meta["product_id"], chosen), ("PF_XBTUSD", {5: "buy"}))


if __name__ == "__main__":
    unittest.main()
