import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import re1_run as r  # noqa: E402

H = r.HOUR


class Causal(unittest.TestCase):
    def test_threshold_ignores_future_and_current(self):
        grid = [i * H for i in range(2000)]
        r4 = {t: 0.001 * ((i * 7) % 10) for i, t in enumerate(grid)}
        r4[grid[1900]] = 1.0
        base = r.extremes(r4, grid)
        self.assertIn(grid[1900], base)
        changed = dict(r4)
        for t in grid[1901:]:
            changed[t] = 5.0
        again = r.extremes(changed, grid)
        self.assertEqual([t for t in base if t <= grid[1900]], [t for t in again if t <= grid[1900]])

    def test_direction_is_contrary(self):
        opn = {i * H: 100.0 for i in range(10)}
        opn[4 * H] = 110.0
        self.assertGreater(r.f.price_move(opn, 3 * H), 0)


if __name__ == "__main__":
    unittest.main()
