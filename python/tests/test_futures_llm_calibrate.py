import json
import os
import tempfile
import unittest

from balancita_engine import futures_llm_calibrate as k

ACTIONS = ("buy", "hold", "sell")


def make_rows(count, overconfident):
    """Decisions whose stated probabilities are too sharp (overconfident) or already honest."""
    rows = []
    for i in range(count):
        right = ACTIONS[i % 3]
        gross = {"buy": 25.0, "hold": 0.0, "sell": -25.0}[right]
        chosen = right if i % 3 != 0 or i % 2 else ACTIONS[(i + 1) % 3]  # a mix of hits and misses
        sharp = 0.96 if overconfident else 0.5
        rest = (1 - sharp) / 2
        probs = {a: (sharp if a == chosen else rest) for a in ACTIONS}
        rows.append({"status": "scored", "chosen": chosen, "gross_bp": gross, "probabilities": probs,
                     "temperature": 1.0})
    return rows


class CalibrateTests(unittest.TestCase):
    def test_rescale_to_the_same_temperature_is_the_identity(self):
        probs = {"buy": 0.2, "hold": 0.5, "sell": 0.3}
        self.assertEqual([round(p, 9) for p in k.rescale(probs, 1.0, 1.0)], [0.2, 0.5, 0.3])
        self.assertAlmostEqual(sum(k.rescale(probs, 1.0, 3.0)), 1.0)
        flat = k.rescale(probs, 1.0, 5.0)
        self.assertLess(max(flat) - min(flat), 0.3)

    def test_overconfident_stated_probabilities_get_a_higher_temperature(self):
        result = k.calibrate(make_rows(600, overconfident=True), 10.0)
        self.assertTrue(result["accepted"])
        self.assertGreater(result["temperature"], 1.0)
        self.assertGreater(result["validation_gain"], 0)

    def test_a_small_sample_never_changes_the_temperature(self):
        result = k.calibrate(make_rows(60, overconfident=True), 10.0)
        self.assertFalse(result["accepted"])
        self.assertEqual(result["temperature"], 1.0)
        self.assertIn("muestra", result["reason"])

    def test_the_fit_uses_only_the_older_part(self):
        rows = make_rows(400, overconfident=True)
        result = k.calibrate(rows, 10.0)
        self.assertEqual(result["fit_decisions"] + result["validation_decisions"], 400)
        self.assertLess(result["fit_decisions"], result["validation_decisions"] * 3)

    def test_the_grid_reaches_high_temperatures_and_always_includes_one(self):
        values = k.grid()
        self.assertEqual((values[0], values[-1]), (0.5, 50.0))
        self.assertIn(1.0, values)
        self.assertEqual(values, sorted(values))

    def test_a_very_sharp_model_needs_more_than_the_old_limit_of_five(self):
        sharp = {"buy": 0.998, "hold": 0.001, "sell": 0.001}
        rows = []
        for i in range(600):
            right = ACTIONS[i % 3]
            chosen = "buy"  # always says buy at 99.8 %, right a third of the time
            rows.append({"status": "scored", "chosen": chosen, "probabilities": sharp, "temperature": 1.0,
                         "gross_bp": {"buy": 25.0, "hold": 0.0, "sell": -25.0}[right]})
        result = k.calibrate(rows, 10.0)
        self.assertTrue(result["accepted"])
        self.assertGreater(result["temperature"], 5.0)

    def test_write_keeps_the_other_entries(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "c.json")
            with open(path, "w") as handle:
                json.dump({"version": "x", "temperatures": {"direction_1h@1": 1.0}}, handle)
            k.write_temperature(path, "trade_action", 3, 1.8)
            with open(path) as handle:
                data = json.load(handle)
        self.assertEqual(data["temperatures"], {"direction_1h@1": 1.0, "trade_action@3": 1.8})
        self.assertEqual(data["version"], "x")


if __name__ == "__main__":
    unittest.main()
