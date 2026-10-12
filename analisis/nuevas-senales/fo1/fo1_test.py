import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fo1_run as r  # noqa: E402

H = r.HOUR


class Timing(unittest.TestCase):
    def series(self):
        oi = {i * H: 100.0 + i for i in range(100)}
        liq = {i * H: 1.0 for i in range(100)}
        return oi, liq

    def test_features_ignore_the_future(self):
        oi, liq = self.series()
        t = 50 * H
        before = r.features(oi, liq, t)
        for k in range(51, 100):
            oi[k * H] = 1e9
            liq[k * H] = 1e9
        self.assertEqual(before, r.features(oi, liq, t))

    def test_entry_is_two_hours_after_bucket_start(self):
        opn = {i * H: 100.0 + i for i in range(100)}
        tr = r.make_trade("PF_XBTUSD", opn, 10 * H, 1, 4)
        self.assertEqual(tr["entry_t"], 12 * H)
        self.assertAlmostEqual(tr["gross_bp"], 1e4 * __import__("math").log(116.0 / 112.0), 6)

    def test_onsets_collapse_repeats(self):
        self.assertEqual(r.onsets([0, H, 2 * H, 30 * H, 31 * H]), [0, 30 * H])

    def test_clusters_chain_nearby_entries(self):
        tr = [{"entry_t": t * H} for t in (0, 10, 20, 100)]
        self.assertEqual([len(g) for g in r.clusters(tr)], [3, 1])


if __name__ == "__main__":
    unittest.main()
