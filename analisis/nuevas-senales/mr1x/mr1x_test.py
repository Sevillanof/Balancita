import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mr1x_run as x  # noqa: E402

D, H = x.DAY, x.HOUR
T = x.m.START + 60 * D


class Universe(unittest.TestCase):
    def data(self, last_offset=None):
        opn = {"PF_AAAUSD": {T - 28 * D + i * H: 100.0 for i in range(0, 28 * 24 + 24 * 8)}}
        vol = {"PF_AAAUSD": {d: 2_000_000.0 for d in range((T - 40 * D) // D, (T + 10 * D) // D)}}
        last = {"PF_AAAUSD": max(opn["PF_AAAUSD"])}
        return opn, last, vol

    def test_volume_filter_uses_only_past_days(self):
        opn, last, vol = self.data()
        for d in range(T // D, T // D + 10):
            vol["PF_AAAUSD"][d] = 1e12
        self.assertEqual(x.trailing_volume(vol, "PF_AAAUSD", T), 2_000_000.0)

    def test_delisted_product_exits_at_last_candle(self):
        opn, last, vol = self.data()
        opn["PF_AAAUSD"] = {t: v for t, v in opn["PF_AAAUSD"].items() if t <= T + 3 * D}
        last["PF_AAAUSD"] = max(opn["PF_AAAUSD"])
        self.assertEqual(x.exit_price(opn, last, "PF_AAAUSD", T + 2 * H, T + 7 * D + 2 * H), 100.0)

    def test_gap_with_later_candles_drops_the_week(self):
        opn, last, vol = self.data()
        exit_t = T + 7 * D + 2 * H
        opn["PF_AAAUSD"].pop(exit_t, None)
        opn["PF_AAAUSD"][exit_t + 5 * D] = 100.0
        last["PF_AAAUSD"] = exit_t + 5 * D
        self.assertIsNone(x.exit_price(opn, last, "PF_AAAUSD", T + 2 * H, exit_t))

    def test_k_rule(self):
        mk = lambda n: [{"p": "P%02d" % i, "mom": i, "lr": 0.0, "cost": 0.0} for i in range(n)]
        self.assertEqual([x.pick_expanded(mk(n))[2] for n in (8, 12, 20, 40)], [2, 3, 5, 5])

    def test_costs_tiers(self):
        self.assertAlmostEqual(x.cost_for("PF_NEWUSD", 6e6, 1.0), 17.1)
        self.assertAlmostEqual(x.cost_for("PF_NEWUSD", 2e6, 1.0), 24.2)


if __name__ == "__main__":
    unittest.main()
