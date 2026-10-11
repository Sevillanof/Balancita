import unittest
from decimal import Decimal

from balancita_engine import futures_maker as m


def tape(*rows):
    return m.Tape(list(rows))


def trade(**over):
    base = {"side": "LONG", "entry_time_ms": 1_000, "exit_time_ms": 100_000, "entry_price": "100.05",
            "exit_price": "101", "stop_price": "99", "notional_usd": "100", "funding_usd": 0, "product_id": "PF_X",
            "net_bp": 0.0, "pnl_usd": 0.0}
    base.update(over)
    return base


class SimulateEntryTests(unittest.TestCase):
    def test_long_rests_at_last_seller_price_and_fills_only_when_a_sell_goes_through(self):
        t = tape((500, "100", "sell"), (900, "100.1", "buy"), (2_000, "100", "sell"), (3_000, "99.9", "sell"))
        r = m.simulate_entry("LONG", 1_000, "99", t)
        self.assertEqual((r["limit"], r["filled"], r["fill_ms"]), (Decimal("100"), True, 3_000))

    def test_trade_exactly_at_the_limit_is_not_a_fill_unless_touch(self):
        t = tape((500, "100", "sell"), (2_000, "100", "sell"), (200_000, "100", "sell"))
        self.assertFalse(m.simulate_entry("LONG", 1_000, "99", t)["filled"])
        self.assertTrue(m.simulate_entry("LONG", 1_000, "99", t, touch=True)["filled"])

    def test_short_rests_at_last_buyer_price_and_fills_on_a_buy_through(self):
        t = tape((500, "100", "buy"), (2_000, "100.2", "buy"))
        r = m.simulate_entry("SHORT", 1_000, "101", t)
        self.assertEqual((r["limit"], r["filled"]), (Decimal("100"), True))

    def test_stop_touched_first_cancels_the_order(self):
        t = tape((500, "100", "sell"), (2_000, "98.5", "sell"))
        r = m.simulate_entry("LONG", 1_000, "99", t)
        self.assertEqual((r["filled"], r["reason"]), (False, "stop_first"))

    def test_expires_after_ttl_and_never_fills_late(self):
        t = tape((500, "100", "sell"), (200_000, "99.9", "sell"))
        r = m.simulate_entry("LONG", 1_000, "99", t, ttl_ms=60_000)
        self.assertEqual((r["filled"], r["reason"]), (False, "expired"))

    def test_no_reference_when_the_passive_side_never_traded(self):
        r = m.simulate_entry("LONG", 1_000, "99", tape((500, "100", "buy")))
        self.assertEqual(r["reason"], "no_reference")


class RepriceTests(unittest.TestCase):
    def test_reproduces_the_recorded_net_when_priced_like_the_taker_entry(self):
        # Taker economics: entry 100.05, exit 101, 5 bp fee each side, 2 USD funding.
        notional = Decimal(100)
        qty = notional / Decimal("100.05")
        pnl = (Decimal(101) - Decimal("100.05")) * qty - (Decimal("100.05") + 101) * qty * Decimal("0.0005") - 2
        tr = trade(funding_usd=2, pnl_usd=float(pnl))
        got = m.maker_trade_net_bp(tr, "100.05", entry_kind="taker")
        self.assertAlmostEqual(float(got), float(pnl / notional * 10_000), places=6)

    def test_a_better_limit_and_the_maker_fee_always_help_a_long(self):
        tr = trade()
        taker = m.maker_trade_net_bp(tr, "100.05", entry_kind="taker")
        maker = m.maker_trade_net_bp(tr, "100.00")
        self.assertGreater(maker, taker + Decimal("3"))  # 3 bp fee gap plus 5 bp of price


class StudyTests(unittest.TestCase):
    def test_missed_winners_eat_the_saving(self):
        # Two longs. The first fills (a seller trades through) and loses; the second never fills and would have won.
        loser = trade(entry_time_ms=1_000, exit_time_ms=20_000, net_bp=-12.0, pnl_usd=-0.12, exit_price="99.5")
        winner = trade(entry_time_ms=130_000, exit_time_ms=150_000, net_bp=30.0, pnl_usd=0.30, exit_price="101")
        t = tape((500, "100", "sell"), (2_000, "99.9", "sell"), (100_000, "100", "sell"),
                 (131_000, "100.2", "buy"), (140_000, "100.6", "buy"), (200_000, "101", "buy"))
        out = m.study([loser, winner], {"PF_X": t})
        self.assertEqual((out["signals"], out["filled"]), (2, 1))
        self.assertLess(out["selection_bp"], 0)  # filled trades were the worse ones
        self.assertLess(out["skip_total_usd"], out["taker_total_usd"])
        self.assertTrue(out["verdict"].startswith("insufficient_data"))

    def test_signals_outside_the_tape_are_not_counted(self):
        out = m.study([trade(entry_time_ms=10_000_000, exit_time_ms=10_100_000)],
                      {"PF_X": tape((500, "100", "sell"), (900, "100", "buy"))})
        self.assertEqual((out["signals"], out["no_tape"]), (0, 1))


if __name__ == "__main__":
    unittest.main()
