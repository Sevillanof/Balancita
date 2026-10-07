import unittest
from decimal import Decimal

from balancita_engine import futures_costs as c


class CostModelTests(unittest.TestCase):
    def test_round_trip_is_taker_fees_plus_two_impacts(self):
        self.assertEqual(c.round_trip_cost_bps("PF_XBTUSD"), Decimal("10.12"))
        self.assertEqual(c.round_trip_cost_bps("PF_NEARUSD"), Decimal("17.1"))
        self.assertEqual(c.round_trip_cost_bps("PF_XBTUSD", exit_kind="maker"), Decimal("7.12"))

    def test_unknown_product_is_priced_like_the_worst(self):
        self.assertEqual(c.round_trip_cost_bps("PF_NEWUSD"), c.round_trip_cost_bps("PF_NEARUSD"))

    def test_fills_are_always_worse_for_the_trader(self):
        p = Decimal(100)
        self.assertGreater(c.entry_fill(p, "LONG", "PF_ADAUSD"), p)
        self.assertLess(c.entry_fill(p, "SHORT", "PF_ADAUSD"), p)
        self.assertLess(c.exit_fill(p, "LONG", "PF_ADAUSD", "stop"), c.exit_fill(p, "LONG", "PF_ADAUSD", "time_stop"))
        self.assertGreater(c.exit_fill(p, "SHORT", "PF_ADAUSD", "stop"), p)
        self.assertEqual(c.exit_fill(p, "LONG", "PF_ADAUSD", "target"), p)

    def test_measured_spread_is_the_median(self):
        points = [{"bid.bestPrice": "99.99", "ask.bestPrice": "100.01"}, {"bid.bestPrice": "100", "ask.bestPrice": "100"},
                  {"bid.bestPrice": "x"}]
        self.assertEqual(c.measured_spread_bps(points), Decimal("1.0"))
        self.assertIsNone(c.measured_spread_bps([]))

    def test_hash_is_stable(self):
        self.assertEqual(c.cost_model_hash(), c.cost_model_hash())


if __name__ == "__main__":
    unittest.main()
