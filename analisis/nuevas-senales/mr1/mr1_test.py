import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mr1_run as m  # noqa: E402

DAY, H = m.DAY, m.HOUR


class Weekly(unittest.TestCase):
    def prices(self, growth):
        t0 = m.START
        opn = {}
        for i in range(0, 60 * 24):
            t = t0 + i * H
            opn[t] = 100.0 * (1 + growth) ** (i / 24)
        return opn

    def test_signal_uses_only_past(self):
        a = {"PF_XBTUSD": self.prices(0.01)}
        t = m.START + 40 * DAY
        before = m.legs_for(t, a, ["PF_XBTUSD"])
        for k in list(a["PF_XBTUSD"]):
            if k > t:
                a["PF_XBTUSD"][k] *= 9
        after = m.legs_for(t, a, ["PF_XBTUSD"])
        self.assertAlmostEqual(before[0]["mom"], after[0]["mom"])

    def test_pick_long_top_short_bottom(self):
        legs = [{"p": "P%d" % i, "mom": i, "lr": 0.0, "cost": 0.0} for i in range(8)]
        lo, sh, k = m.pick(legs)
        self.assertEqual((k, [d["p"] for d in lo], [d["p"] for d in sh]), (2, ["P7", "P6"], ["P1", "P0"]))

    def test_entry_two_hours_after_rebalance(self):
        opn = {m.START + 40 * DAY - 28 * DAY: 100.0, m.START + 40 * DAY: 110.0,
               m.START + 40 * DAY + 2 * H: 120.0, m.START + 47 * DAY + 2 * H: 132.0}
        d = m.legs_for(m.START + 40 * DAY, {"PF_XBTUSD": opn}, ["PF_XBTUSD"])[0]
        self.assertAlmostEqual(d["lr"], 1e4 * __import__("math").log(132.0 / 120.0), 6)

    def test_new_product_enters_only_with_full_window(self):
        opn = {m.START + 10 * DAY + i * H: 100.0 for i in range(24 * 40)}
        self.assertEqual(m.legs_for(m.START + 20 * DAY, {"PF_HYPEUSD": opn}, ["PF_HYPEUSD"]), [])


if __name__ == "__main__":
    unittest.main()
