import os
import tempfile
import unittest

from balancita_engine import futures_carry as carry

H = carry.HOUR_MS
MONDAY = 1791763200000  # 2026-10-12 00:00 UTC, a Monday
CONFIG = carry.load_config()


def series(start, hours, value):
    return {start + i * H: value for i in range(hours)}


class CarryTest(unittest.TestCase):
    def test_config_costs(self):
        cost = carry.cycle_cost_fraction(CONFIG, "PF_XBTUSD")
        self.assertAlmostEqual(cost, (2 * 5.05 + 2 * 40.05) / 1e4)

    def test_positive_funding_enters_on_monday_and_accrues(self):
        start = MONDAY - 800 * H
        spot = series(start - H, 1000, 100.0)
        mark = series(start - H, 1000, 100.0)
        funding = series(start, 1000, 0.01)  # 1 bp per hour of price
        cycles, pnl, unknown = carry.simulate(CONFIG, "PF_XBTUSD", funding, mark, spot, MONDAY, MONDAY + 24 * H)
        self.assertEqual(len(cycles), 1)
        self.assertEqual(cycles[0]["entry_ms"], MONDAY)
        self.assertEqual(len(pnl), 24)
        self.assertAlmostEqual(sum(p for _, p, _ in pnl), 24 * 0.0001)
        self.assertEqual(unknown, 0)

    def test_negative_funding_stays_flat(self):
        start = MONDAY - 800 * H
        spot = series(start - H, 1000, 100.0)
        funding = series(start, 1000, -0.01)
        cycles, pnl, _ = carry.simulate(CONFIG, "PF_XBTUSD", funding, dict(spot), spot, MONDAY, MONDAY + 24 * H)
        self.assertEqual((cycles, pnl), ([], []))

    def test_missing_hour_is_unknown_not_zero(self):
        start = MONDAY - 800 * H
        spot = series(start - H, 1000, 100.0)
        funding = series(start, 1000, 0.01)
        del funding[MONDAY + 5 * H]
        cycles, pnl, unknown = carry.simulate(CONFIG, "PF_XBTUSD", funding, dict(spot), spot, MONDAY, MONDAY + 24 * H)
        self.assertEqual(unknown, 1)
        self.assertEqual(len(pnl), 23)

    def test_run_writes_summary_and_disable_freezes(self):
        with tempfile.TemporaryDirectory() as tmp:
            state, out = os.path.join(tmp, "state.json"), os.path.join(tmp, "out.json")
            start = MONDAY - 800 * H
            data = (series(start, 1000, 0.01), series(start - H, 1000, 100.0), series(start - H, 1000, 100.0))
            now = MONDAY + 30 * H
            carry.save_json(state, {"id": CONFIG["id"], "enabled": True, "start_ms": MONDAY, "disabled_ms": None})
            summary = carry.run(state, out, now, fetch=lambda *_: data)
            self.assertEqual(summary["closed_or_open_cycles"], 8)
            self.assertGreater(summary["totals"]["funding_usd"], 0)
            self.assertLess(summary["totals"]["net_usd"], summary["totals"]["funding_usd"])
            carry.save_json(state, {"id": CONFIG["id"], "enabled": False, "start_ms": MONDAY, "disabled_ms": now // H * H})
            frozen = carry.run(state, out, now + 100 * H, fetch=lambda *_: data)
            self.assertEqual(frozen["end_ms"], now // H * H)

    def test_toggle_freezes_then_restarts_from_next_hour(self):
        with tempfile.TemporaryDirectory() as tmp:
            state, out = os.path.join(tmp, "s.json"), os.path.join(tmp, "o.json")
            carry.save_json(state, {"id": CONFIG["id"], "enabled": True, "start_ms": MONDAY, "disabled_ms": None})
            off = carry.set_enabled(state, False, MONDAY + 5 * H + 7)
            self.assertEqual((off["enabled"], off["disabled_ms"]), (False, MONDAY + 5 * H))
            on = carry.set_enabled(state, True, MONDAY + 9 * H + 7)
            self.assertEqual((on["enabled"], on["start_ms"]), (True, MONDAY + 10 * H))
            self.assertEqual(on["previous"], [{"start_ms": MONDAY, "end_ms": MONDAY + 5 * H}])
            self.assertFalse(carry.read_summary(out, state)["products"])


if __name__ == "__main__":
    unittest.main()
