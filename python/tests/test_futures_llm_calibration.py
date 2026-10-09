import math
import unittest

from balancita_engine import futures_llm_calibration as c

RT = 10.0


def row(chosen, probs, gross, status="scored"):
    return {"status": status, "chosen": chosen, "gross_bp": gross,
            "probabilities": dict(zip(("buy", "hold", "sell"), probs))}


class CalibrationTests(unittest.TestCase):
    def test_right_action_follows_the_round_trip_rule(self):
        rows = [row("buy", (1, 0, 0), 25), row("sell", (0, 0, 1), -25), row("hold", (0, 1, 0), 4),
                row("buy", (1, 0, 0), 1, status="pending")]
        self.assertEqual([r for _, r in c.right_actions(rows, RT)], ["buy", "sell", "hold"])

    def test_uniform_probabilities_score_the_chance_level(self):
        rows = [row("hold", (1 / 3,) * 3, g) for g in (25, -25, 4)]
        cal = c.calibration_report(rows, RT)
        self.assertAlmostEqual(cal["brier"], 2 / 3, places=3)
        self.assertAlmostEqual(cal["log_loss"], math.log(3), places=3)
        self.assertAlmostEqual(cal["brier_skill"], 0.0, places=3)

    def test_a_confident_wrong_answer_is_counted_in_high_confidence(self):
        rows = [row("buy", (0.95, 0.03, 0.02), -25), row("buy", (0.95, 0.03, 0.02), 25)]
        cal = c.calibration_report(rows, RT)
        self.assertEqual(cal["high_confidence"]["decisions"], 2)
        self.assertEqual(cal["high_confidence"]["wrong"], 1)
        self.assertEqual(cal["high_confidence"]["wrong_rate"], 0.5)
        self.assertFalse(cal["reliable_sample"])
        band = cal["reliability"][-1]
        self.assertEqual((band["decisions"], band["observed"]), (2, 0.5))
        self.assertAlmostEqual(cal["ece"], 0.45, places=2)

    def test_halves_split_in_time_order_and_empty_input_is_safe(self):
        rows = [row("hold", (0.2, 0.6, 0.2), 4)] * 2 + [row("buy", (0.6, 0.2, 0.2), -25)] * 2
        cal = c.calibration_report(rows, RT)
        self.assertEqual(cal["halves"]["older"]["accuracy"], 1.0)
        self.assertEqual(cal["halves"]["newer"]["accuracy"], 0.0)
        self.assertEqual(c.calibration_report([], RT)["decisions"], 0)


class TwoOptionTests(unittest.TestCase):
    def test_hold_close_uses_the_same_measures_with_a_two_option_chance_level(self):
        def r(chosen, p_hold):
            return {"chosen": chosen, "probabilities": {"hold": p_hold, "close": 1 - p_hold}}
        pairs = [(r("hold", 0.5), "hold"), (r("hold", 0.5), "close"), (r("close", 0.95), "hold")]
        cal = c.calibration_from_pairs(pairs, ("hold", "close"))
        self.assertAlmostEqual(cal["brier_uniform"], 0.5)
        self.assertAlmostEqual(cal["log_loss_uniform"], math.log(2), places=3)
        self.assertEqual(cal["high_confidence"]["wrong"], 1)
        self.assertEqual(set(cal["right_action_rates"]), {"hold", "close"})


if __name__ == "__main__":
    unittest.main()
