import unittest
from decimal import Decimal

from balancita_engine import futures_costs as c


class CostModelTests(unittest.TestCase):
    def test_round_trip_is_taker_fees_plus_two_impacts(self):
        self.assertEqual(c.round_trip_cost_bps("PF_XBTUSD"), Decimal("10.12"))
        self.assertEqual(c.round_trip_cost_bps("PF_NEARUSD"), Decimal("17.1"))

    def test_a_resting_limit_leg_pays_the_maker_fee_and_no_impact(self):
        # una orden límite llena en su nivel: comisión maker 2 pb y nada de impacto (el impacto es de quien cruza el libro)
        self.assertEqual(c.round_trip_cost_bps("PF_XBTUSD", exit_kind="maker"), Decimal("7.06"))      # 5 + 2 + 0,06 (solo la entrada)
        self.assertEqual(c.round_trip_cost_bps("PF_ETHUSD", exit_kind="maker"), Decimal("7.19"))
        self.assertEqual(c.round_trip_cost_bps("PF_ETHUSD", entry_kind="maker"), Decimal("7.19"))     # simétrico: entrada maker, salida taker
        self.assertEqual(c.round_trip_cost_bps("PF_ETHUSD", entry_kind="maker", exit_kind="maker"), Decimal("4.00"))

    def test_taker_taker_stays_exactly_what_it_was(self):
        self.assertEqual(c.round_trip_cost_bps("PF_ETHUSD"), Decimal("10.38"))
        self.assertEqual(c.round_trip_cost_bps("PF_ETHUSD", entry_kind="taker", exit_kind="taker"), Decimal("10.38"))
        self.assertEqual(c.round_trip_rate("PF_ETHUSD"), Decimal("0.001038"))

    def test_round_trip_cost_agrees_with_what_settle_charges_for_every_exit_kind(self):
        from balancita_engine import futures_qwen_trader as qt
        for product in ("PF_XBTUSD", "PF_ETHUSD", "PF_NEARUSD"):
            for kind, maker in (("taker", False), ("maker", True)):
                with self.subTest(product=product, exit=kind):
                    ref = Decimal(100)
                    entry = c.entry_fill(ref, "LONG", product)
                    pos = qt.Position(side="LONG", entry_ms=0, entry_px=entry, qty=Decimal(100) / entry)
                    got = qt.settle(product, pos, ref, "strategy_exit", 0, None, Decimal(100), maker_exit=maker)
                    # el precio no se movió: todo lo que pierde la operación es costo (entrada al impacto, salida y comisiones)
                    self.assertAlmostEqual(-got["net_bp"], float(c.round_trip_cost_bps(product, exit_kind=kind)), delta=0.02)

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
