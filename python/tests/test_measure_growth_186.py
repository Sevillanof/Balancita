"""Smoke test of the S-M1 measurement tool (#186, matrix B8/E7): it runs on invented data, the synthetic journals grow with the days asked
and verify as a chain. It asserts no time or size limit: there is no approved threshold (the numbers are reported by
``measure_growth_186.py``, run by hand)."""

import unittest

import measure_growth_186 as M


class TestMeasureGrowth(unittest.TestCase):
    def test_the_synthetic_journals_grow_with_the_days_and_load_as_a_chain(self):
        lines = []
        report = M.measure([1, 2], steps=12, out=lines.append)
        one, two = report["synthetic"][1], report["synthetic"][2]
        self.assertGreater(one["entries"], 0)
        self.assertAlmostEqual(two["entries"] / one["entries"], 2, delta=0.01)
        self.assertAlmostEqual(two["journal_mb"] / one["journal_mb"], 2, delta=0.1)
        self.assertGreater(report["bytes"], 0)
        self.assertEqual(len(lines), 5)


if __name__ == "__main__":
    unittest.main()
