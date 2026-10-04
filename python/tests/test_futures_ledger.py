import unittest
from decimal import Decimal

from balancita_engine.futures_ledger import FuturesLedger


class FuturesLedgerTests(unittest.TestCase):
    def test_long_and_short_realized_examples(self):
        long = FuturesLedger("2000")
        long.open("long", "1", "1428.5714285714285714285714285714285714285714285714", "maker")
        long.close("1", "1438.5714285714285714285714285714285714285714285714", "taker")
        self.assertEqual(long.snapshot("1438.5714285714285714285714285714285714285714285714")["realized_net_complete"], "8.995")

        short = FuturesLedger("2000")
        short.open("short", "1", "1424.2857142857142857142857142857142857142857142857", "taker")
        short.close("1", "1414.2857142857142857142857142857142857142857142857", "maker")
        self.assertEqual(short.snapshot("1414.2857142857142857142857142857142857142857142857")["realized_net_complete"], "9.005")

    def test_partial_close_and_funding_intervals(self):
        ledger = FuturesLedger("1000")
        ledger.open("long", "2", "100", "maker", at_ms=0)
        ledger.observe_funding("rate-a", 0, 3_600_000, "0.5")
        ledger.accrue_funding(0, 1_800_000)
        ledger.close("1", "105", "maker", at_ms=1_800_000)
        ledger.accrue_funding(1_800_000, 3_600_000)
        ledger.close("1", "110", "taker", at_ms=3_600_000)
        state = ledger.snapshot("110")
        self.assertEqual(state["funding_paid"], "0.75")
        self.assertTrue(state["net_complete"])

    def test_reject_float_and_unknown_funding_is_incomplete(self):
        ledger = FuturesLedger("100")
        with self.assertRaises(ValueError):
            ledger.open("long", 1.0, "10", "maker")
        ledger.open("long", "1", "10", "maker", at_ms=0)
        self.assertIsNone(ledger.snapshot("10")["net_complete"])
        with self.assertRaises(ValueError):
            ledger.close("1", "10", "maker", at_ms=3_600_000)
        ledger.accrue_funding(0, 3_600_000)
        ledger.close("1", "10", "maker", at_ms=3_600_000)
        self.assertIsNone(ledger.snapshot("10")["realized_net_complete"])

    def test_rate_changes_negative_rate_and_conflicting_retries(self):
        ledger = FuturesLedger("1000")
        ledger.open("short", "1", "100", "maker", at_ms=0)
        ledger.observe_funding("first", 0, 1_800_000, "0.5")
        ledger.observe_funding("second", 1_800_000, 3_600_000, "-0.25")
        ledger.accrue_funding(0, 1_800_000)
        ledger.accrue_funding(1_800_000, 3_600_000)
        self.assertEqual(ledger.snapshot("100")["funding_paid"], "-0.125")
        with self.assertRaises(ValueError):
            ledger.observe_funding("second", 1_800_000, 3_600_000, "0.25")
        with self.assertRaises(ValueError):
            ledger.accrue_funding(1_800_000, 3_600_000)

    def test_partial_close_allocates_exact_residual_on_final_close(self):
        ledger = FuturesLedger("1000")
        ledger.open("long", "3", "100", "maker", at_ms=0)
        ledger.close("1", "101", "maker", at_ms=0)
        ledger.close("2", "101", "maker", at_ms=0)
        closes = [event for event in ledger.events if event["type"] == "close"]
        self.assertEqual(closes[0]["allocated_entry_fee"], "0.02")
        self.assertEqual(closes[1]["allocated_entry_fee"], "0.04")
        self.assertEqual(sum(Decimal(event["allocated_entry_fee"]) for event in closes), Decimal("0.06"))

    def test_snapshot_event_history_and_cost_configuration_are_immutable(self):
        ledger = FuturesLedger("1000")
        ledger.open("long", "1", "100", "maker")
        snapshot = ledger.snapshot("100")
        snapshot["events"][0]["qty"] = "999"
        self.assertEqual(ledger.snapshot("100")["events"][0]["qty"], "1")
        with self.assertRaises(TypeError):
            ledger.fee_rates["maker"] = Decimal("0.5")
        with self.assertRaises(AttributeError):
            ledger.precision = 99


if __name__ == "__main__":
    unittest.main()
