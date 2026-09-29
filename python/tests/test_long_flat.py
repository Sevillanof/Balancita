import json
import math
import unittest
from pathlib import Path

from balancita_simulation import simulate_long_flat


FIXTURES = [
    Path(__file__).parents[1] / "fixtures" / "long-flat-parity.json",
    Path(__file__).parents[1] / "fixtures" / "long-flat-default-costs.json",
]


class LongFlatParityTests(unittest.TestCase):
    def assert_close(self, actual, expected):
        if expected is None:
            self.assertIsNone(actual)
        else:
            self.assertTrue(math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-10))

    def test_matches_typescript_oracle(self):
        for path in FIXTURES:
            with self.subTest(fixture=path.name):
                fixture = json.loads(path.read_text(encoding="utf-8"))
                result = simulate_long_flat(fixture["input"])
                expected = fixture["expected"]
                self.assertEqual(len(result["fills"]), len(expected["fills"]))
                for actual, oracle in zip(result["fills"], expected["fills"]):
                    self.assertEqual(actual["time"], oracle["time"])
                    self.assertEqual(actual["side"], oracle["side"])
                    for key in ("price", "qty", "commission"):
                        self.assert_close(actual[key], oracle[key])
                self.assertEqual(len(result["equityCurve"]), len(expected["equityCurve"]))
                for actual, oracle in zip(result["equityCurve"], expected["equityCurve"]):
                    self.assertEqual(actual["time"], oracle["time"])
                    self.assert_close(actual["equity"], oracle["equity"])
                for key, value in expected["metrics"].items():
                    self.assert_close(result["metrics"][key], value)

    def test_empty_window_preserves_cash_and_null_exposure(self):
        result = simulate_long_flat({"bars": [], "signals": [], "startingCash": 250})
        self.assertEqual(result["fills"], [])
        self.assertEqual(result["equityCurve"], [])
        self.assertEqual(result["metrics"]["finalEquity"], 250)
        self.assertIsNone(result["metrics"]["exposurePct"])
        self.assertIsNone(result["metrics"]["winRate"])

    def test_rejects_non_finite_market_values(self):
        with self.assertRaises(ValueError):
            simulate_long_flat({"bars": [{"time": 1, "open": float("nan"), "close": 1}], "signals": []})

    def test_rejects_unrepresentable_numeric_values(self):
        with self.assertRaisesRegex(ValueError, "finite"):
            simulate_long_flat({"bars": [], "signals": [], "startingCash": 10**400})

    def test_rejects_timestamps_outside_exact_typescript_integer_range(self):
        for field in ("bars", "signals"):
            with self.subTest(field=field):
                options = {"bars": [], "signals": []}
                if field == "bars":
                    options[field] = [{"time": 2**53, "open": 1, "close": 1}]
                else:
                    options[field] = [{
                        "time": 2**53, "probabilityUp": 0.5,
                        "probabilityDown": 0.5, "abstained": False,
                    }]
                with self.assertRaisesRegex(ValueError, "millisecond"):
                    simulate_long_flat(options)

    def test_does_not_mutate_caller_input(self):
        import copy

        options = {"bars": [], "signals": [{
            "time": 1, "probabilityUp": 0.5, "probabilityDown": 0.5, "abstained": False
        }]}
        original = copy.deepcopy(options)
        simulate_long_flat(options)
        self.assertEqual(options, original)

    def test_abstention_closes_long_at_next_open(self):
        result = simulate_long_flat({
            "bars": [
                {"time": 1, "open": 100, "close": 100},
                {"time": 2, "open": 110, "close": 112},
                {"time": 3, "open": 90, "close": 90},
            ],
            "signals": [
                {"time": 1, "probabilityUp": 0.8, "probabilityDown": 0.1, "abstained": False},
                {"time": 2, "probabilityUp": 0.5, "probabilityDown": 0.5, "abstained": True},
            ],
            "costs": {"commissionRate": 0, "slippageRate": 0},
        })
        self.assertEqual(result["fills"][-1]["time"], 3)
        self.assertEqual(result["fills"][-1]["side"], "sell")
        self.assertEqual(result["fills"][-1]["price"], 90)

    def test_direct_short_locks_collateral_and_restricts_sale_proceeds(self):
        result = simulate_long_flat({
            "startingCash": 1000,
            "bars": [
                {"time": 1, "open": 100, "close": 100},
                {"time": 2, "open": 100, "close": 80},
            ],
            "signals": [
                {"time": 1, "probabilityUp": 0.5, "probabilityDown": 0.5, "abstained": False, "directTarget": "short"},
            ],
            "costs": {"commissionRate": 0, "slippageRate": 0},
        })
        self.assertEqual(result["fills"][0]["side"], "sell_short")
        self.assertAlmostEqual(result["fills"][0]["qty"], 10)
        self.assertAlmostEqual(result["equityCurve"][0]["equity"], 1000)
        self.assertAlmostEqual(result["equityCurve"][1]["equity"], 1200)
        self.assertEqual(result["equityCurve"][1]["position"], "short")
        self.assertAlmostEqual(result["equityCurve"][1]["restrictedProceeds"], 1000)
        self.assertAlmostEqual(result["equityCurve"][1]["lockedCollateral"], 1000)

    def test_short_cover_closes_trade_and_terminal_short_is_marked(self):
        result = simulate_long_flat({
            "startingCash": 1000,
            "bars": [
                {"time": 1, "open": 100, "close": 100},
                {"time": 2, "open": 80, "close": 80},
                {"time": 3, "open": 70, "close": 75},
            ],
            "signals": [
                {"time": 1, "probabilityUp": 0.5, "probabilityDown": 0.5, "abstained": False, "directTarget": "short"},
                {"time": 2, "probabilityUp": 0.5, "probabilityDown": 0.5, "abstained": False, "directTarget": "flat"},
            ],
            "costs": {"commissionRate": 0, "slippageRate": 0},
        })
        self.assertEqual(result["fills"][-1]["side"], "buy_to_cover")
        self.assertEqual(result["fills"][-1]["price"], 70)
        self.assertEqual(result["metrics"]["tradeCount"], 1)
        self.assertEqual(result["metrics"]["winRate"], 1)

    def test_short_rejects_unsupported_direct_target(self):
        with self.assertRaisesRegex(ValueError, "directTarget"):
            simulate_long_flat({"bars": [], "signals": [{
                "time": 1, "probabilityUp": 0.5, "probabilityDown": 0.5,
                "abstained": False, "directTarget": "hedged",
            }]})

    def test_short_insufficient_collateral_is_reported_not_liquidated(self):
        with self.assertRaisesRegex(ValueError, "insufficient collateral.*cannot be valued"):
            simulate_long_flat({
                "startingCash": 1000,
                "bars": [
                    {"time": 1, "open": 100, "close": 100},
                    {"time": 2, "open": 100, "close": 250},
                ],
                "signals": [{
                    "time": 1, "probabilityUp": 0.5, "probabilityDown": 0.5,
                    "abstained": False, "directTarget": "short",
                }],
                "costs": {"commissionRate": 0, "slippageRate": 0},
            })

    def test_probability_down_enters_short_at_next_open(self):
        result = simulate_long_flat({
            "startingCash": 1000,
            "bars": [
                {"time": 1, "open": 100, "close": 100},
                {"time": 2, "open": 110, "close": 105},
            ],
            "signals": [{
                "time": 1, "probabilityUp": 0.1, "probabilityDown": 0.8,
                "abstained": False,
            }],
            "entryThreshold": 0.55,
            "costs": {"commissionRate": 0, "slippageRate": 0},
        })
        self.assertEqual(result["fills"][0]["side"], "sell_short")
        self.assertEqual(result["fills"][0]["time"], 2)
        self.assertEqual(result["fills"][0]["price"], 110)
        self.assertEqual(result["equityCurve"][1]["position"], "short")

    def test_probability_short_abstention_covers_at_next_open(self):
        result = simulate_long_flat({
            "startingCash": 1000,
            "bars": [
                {"time": 1, "open": 100, "close": 100},
                {"time": 2, "open": 110, "close": 105},
                {"time": 3, "open": 95, "close": 95},
            ],
            "signals": [
                {"time": 1, "probabilityUp": 0.1, "probabilityDown": 0.8, "abstained": False},
                {"time": 2, "probabilityUp": 0.2, "probabilityDown": 0.8, "abstained": True},
            ],
            "costs": {"commissionRate": 0, "slippageRate": 0},
        })
        self.assertEqual(result["fills"][-1]["side"], "buy_to_cover")
        self.assertEqual(result["fills"][-1]["time"], 3)
        self.assertEqual(result["fills"][-1]["price"], 95)

    def test_opposite_direction_threshold_exits_short_at_next_open(self):
        result = simulate_long_flat({
            "startingCash": 1000,
            "bars": [
                {"time": 1, "open": 100, "close": 100},
                {"time": 2, "open": 100, "close": 100},
                {"time": 3, "open": 105, "close": 105},
            ],
            "signals": [
                {"time": 1, "probabilityUp": 0.1, "probabilityDown": 0.8, "abstained": False},
                {"time": 2, "probabilityUp": 0.6, "probabilityDown": 0.2, "abstained": False},
            ],
            "costs": {"commissionRate": 0, "slippageRate": 0},
        })
        self.assertEqual(result["fills"][-1]["side"], "buy_to_cover")
        self.assertEqual(result["fills"][-1]["time"], 3)
        self.assertEqual(result["fills"][-1]["price"], 105)

    def test_conflicting_entry_probabilities_remain_flat(self):
        result = simulate_long_flat({
            "startingCash": 1000,
            "bars": [
                {"time": 1, "open": 100, "close": 100},
                {"time": 2, "open": 100, "close": 100},
            ],
            "signals": [{
                "time": 1, "probabilityUp": 0.7, "probabilityDown": 0.7,
                "abstained": False,
            }],
            "costs": {"commissionRate": 0, "slippageRate": 0},
        })
        self.assertEqual(result["fills"], [])
        self.assertEqual(result["equityCurve"][1]["equity"], 1000)

    def test_short_commissions_and_slippage_are_charged_on_both_legs(self):
        result = simulate_long_flat({
            "startingCash": 1000,
            "bars": [
                {"time": 1, "open": 100, "close": 100},
                {"time": 2, "open": 100, "close": 90},
                {"time": 3, "open": 80, "close": 80},
            ],
            "signals": [
                {"time": 1, "probabilityUp": 0.5, "probabilityDown": 0.5, "abstained": False, "directTarget": "short"},
                {"time": 2, "probabilityUp": 0.5, "probabilityDown": 0.5, "abstained": False, "directTarget": "flat"},
            ],
            "costs": {"commissionRate": 0.01, "slippageRate": 0.02},
        })
        self.assertEqual([fill["side"] for fill in result["fills"]], ["sell_short", "buy_to_cover"])
        self.assertGreater(result["fills"][0]["price"], 0)
        self.assertGreater(result["fills"][0]["commission"], 0)
        self.assertGreater(result["fills"][1]["commission"], 0)
        self.assertAlmostEqual(
            result["fills"][0]["commission"],
            result["fills"][0]["qty"] * result["fills"][0]["price"] * 0.01,
        )
        self.assertAlmostEqual(
            result["fills"][1]["commission"],
            result["fills"][1]["qty"] * result["fills"][1]["price"] * 0.01,
        )
        self.assertEqual(result["metrics"]["tradeCount"], 1)


if __name__ == "__main__":
    unittest.main()
