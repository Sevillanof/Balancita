import math
import random
import unittest

from balancita_engine import futures_qwen_analista as an

HOUR = an.HOUR_MS
BAR = an.BAR_MS


def bars(hours, vol_of):
    """5m candles for ``hours`` hours with a random walk whose per-bar volatility is ``vol_of(hour)``."""
    rng, price, out = random.Random(1), 2000.0, []
    for hour in range(hours):
        for k in range(12):
            price *= math.exp(rng.gauss(0, vol_of(hour)))
            out.append({"bucket_start": hour * HOUR + k * BAR, "close": str(price)})
    return out


class AnalistaTest(unittest.TestCase):
    def test_default_changes_nothing(self):
        cfg = {"a": 1}
        self.assertIs(an.apply_env(cfg, {}), cfg)
        self.assertIsNone(an.sizes_of(cfg))
        self.assertEqual(an.extra_days(cfg), 0)
        self.assertEqual(an.apply_env(cfg, {an.ENV: "suave"})["analista"], {"modo": "suave"})
        with self.assertRaises(ValueError):
            an.mode("raro")

    def test_sizes_and_description(self):
        self.assertEqual(an.sizes_of({"analista": {"modo": "suave"}}), (1.25, 0.75))
        self.assertEqual(an.sizes_of({"analista": {"modo": "fuerte"}}), (1.5, 0.5))
        self.assertEqual(an.describe({})["modo"], "apagado")
        self.assertEqual(an.describe({"analista": {"modo": "fuerte"}})["tamano_en_calma"], 0.5)

    def test_movement_follows_volatility_against_its_90_day_median(self):
        # 60 calm days, 20 wild ones, then a quieter stretch than the first
        def vol(hour):
            return 0.001 if hour < 24 * 60 else (0.004 if hour < 24 * 80 else 0.0005)

        movement = an.Movement(bars(24 * 126, vol))
        self.assertIsNone(movement.active(20 * 24 * HOUR))                   # under 45 days of history: no data
        self.assertTrue(movement.active(75 * 24 * HOUR))                     # inside the wild days
        self.assertFalse(movement.active(125 * 24 * HOUR))                   # quieter than its own median

    def test_sized_weights_both_sides_and_keeps_the_raw_net(self):
        cfg = {"analista": {"modo": "suave"}}
        operation = {"maestro": 2, "largo": {"neto_bp": 100.0}, "corto": {"neto_bp": -40.0}}

        class Fixed:
            def __init__(self, value):
                self.value = value

            def active(self, _):
                return self.value

        up = an.sized(cfg, operation, Fixed(True), 0)
        self.assertEqual((up["tamano"], up["movimiento"], up["largo"]["neto_bp"], up["largo"]["neto_bp_propio"]),
                         (1.25, True, 125.0, 100.0))
        down = an.sized(cfg, operation, Fixed(False), 0)
        self.assertEqual((down["tamano"], down["corto"]["neto_bp"]), (0.75, -30.0))
        none = an.sized(cfg, operation, Fixed(None), 0)
        self.assertEqual((none["tamano"], none["movimiento"], none["largo"]["neto_bp"]), (1.0, None, 100.0))
        self.assertIs(an.sized({}, operation, Fixed(True), 0), operation)
        self.assertEqual(operation["largo"]["neto_bp"], 100.0)               # the original is untouched

    def test_split_counts_the_raw_net_by_movement(self):
        rows = [({"operacion": {"movimiento": True, "largo": {"neto_bp": 125.0, "neto_bp_propio": 100.0}}}, 1),
                ({"operacion": {"movimiento": False, "largo": {"neto_bp": -30.0, "neto_bp_propio": -40.0}}}, 1),
                ({"operacion": {"largo": {"neto_bp": 5.0}}}, 1)]
        got = an.split(rows, lambda r, s: r["operacion"]["largo"])
        self.assertEqual((got["con"]["n"], got["con"]["neto_propio_bp"]), (1, 100.0))
        self.assertEqual((got["calma"]["n"], got["calma"]["neto_propio_bp"]), (1, -40.0))
        self.assertEqual((got["sin_dato"]["n"], got["sin_dato"]["neto_propio_bp"]), (1, 5.0))

    def test_multiplier_returns_1_when_off_and_scales_live_trader_open_when_enabled(self):
        class Fixed:
            def __init__(self, value):
                self.value = value

            def active(self, _):
                return self.value

        self.assertEqual(an.multiplier({}, Fixed(True), 0), 1.0)
        self.assertEqual(an.multiplier({"analista": {"modo": "suave"}}, Fixed(True), 0), 1.25)
        self.assertEqual(an.multiplier({"analista": {"modo": "suave"}}, Fixed(False), 0), 0.75)
        self.assertEqual(an.multiplier({"analista": {"modo": "suave"}}, Fixed(None), 0), 1.0)

    def test_movement_updates_incrementally_as_new_bars_arrive_in_live_mode(self):
        def vol(hour):
            return 0.001 if hour < 24 * 60 else 0.004

        all_bars = bars(24 * 80, vol)
        cutoff = 24 * 60 * 12
        incremental = an.Movement(all_bars[:cutoff])
        for bar in all_bars[cutoff:]:
            incremental.add_bar(bar)
        batch = an.Movement(all_bars)
        self.assertEqual(incremental.active(75 * 24 * HOUR), batch.active(75 * 24 * HOUR))
        self.assertAlmostEqual(incremental.at(75 * 24 * HOUR), batch.at(75 * 24 * HOUR))


if __name__ == "__main__":
    unittest.main()
