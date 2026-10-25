"""C33 Área de valor: el perfil de volumen, el evento de salida/aceptación/rechazo y la spec que lo usa."""
import copy
import math
import os
import random
import unittest
from decimal import Decimal

from balancita_engine import indicator_catalog as catalog
from balancita_engine.futures_simulator import IncrementalFeatures, merge_periods, DEFAULT_PERIODS
from balancita_engine.futures_spec_strategy import (
    DEFAULT_SPEC_DIR,
    SpecError,
    declared_indicators,
    load_spec,
    propose_spec,
    validate_spec,
)

D = Decimal
SPEC_PATH = os.path.join(DEFAULT_SPEC_DIR, "c33-area-de-valor-perp-v1.json")


def _ts_value_area(candles, bins=48, share=0.7):
    """Port literal de ``valueArea`` de src/features/trading-view/domain/chart-indicators.ts (float, con ``step``)."""
    low = min(c[1] for c in candles)
    high = max(c[0] for c in candles)
    if not high > low:
        return None
    step = (high - low) / bins
    volume = [0.0] * bins

    def bin_of(price):
        return min(bins - 1, max(0, math.floor((price - low) / step)))

    for hi_, lo_, vol in candles:
        if not vol > 0:
            continue
        first, last = bin_of(lo_), bin_of(hi_)
        for index in range(first, last + 1):
            volume[index] += vol / (last - first + 1)
    total = sum(volume)
    if total <= 0:
        return None
    poc = 0
    for index in range(1, bins):
        if volume[index] > volume[poc]:
            poc = index
    lo = hi = poc
    held = volume[poc]
    while held < total * share and (lo > 0 or hi < bins - 1):
        below = volume[lo - 1] if lo > 0 else -1
        above = volume[hi + 1] if hi < bins - 1 else -1
        if above >= below:
            hi += 1
            held += volume[hi]
        else:
            lo -= 1
            held += volume[lo]
    return low + (poc + 0.5) * step, low + (hi + 1) * step, low + lo * step


def _candle(index, high, low, close, volume):
    return {"bucket_start": 1_700_000_000_000 + index * 300_000, "open": str(close), "high": str(high),
            "low": str(low), "close": str(close), "volume_btc": str(volume)}


class ProfileTest(unittest.TestCase):
    def test_profile_matches_the_terminal_indicator_on_random_windows(self):
        rng = random.Random(5)
        for _ in range(60):
            price, bars = 100.0, []
            for _ in range(rng.randint(30, 300)):
                price += rng.gauss(0, 0.6)
                top, bottom = price + abs(rng.gauss(0, 0.4)), price - abs(rng.gauss(0, 0.4))
                bars.append((top, bottom, rng.lognormvariate(0, 0.7)))
            expected = _ts_value_area(bars)
            got = catalog._profile([(D(repr(a)), D(repr(b)), D(repr(c))) for a, b, c in bars], 70, 48)
            for mine, theirs in zip(got, expected):
                self.assertAlmostEqual(float(mine), theirs, delta=1e-9 * abs(theirs))

    def test_no_range_or_no_volume_has_no_profile(self):
        flat = [(D(100), D(100), D(5))] * 10
        self.assertIsNone(catalog._profile(flat, 70, 48))
        silent = [(D(101), D(99), D(0))] * 10
        self.assertIsNone(catalog._profile(silent, 70, 48))

    def test_area_is_the_poc_bin_alone_when_it_already_holds_the_share(self):
        bars = [(D(101), D(100), D(1))] + [(D("100.5"), D("100.4"), D(50))] * 5 + [(D(110), D(109), D(1))]
        poc, vah, val = catalog._profile(bars, 70, 10)
        self.assertEqual((poc, vah, val), (D("100.5"), D(101), D(100)))

    def test_area_grows_toward_the_heavier_neighbour_and_up_on_a_tie(self):
        # 4 bins of 1: volume 1 (bin 0), 3 (bin 1), 3 (bin 2), 1 (bin 3); 70 % of 8 = 5.6: POC is bin 1 (first of the tie),
        # then bin 2 (3 > 1) reaches 6.
        bars = [(D(1), D(0), D(1)), (D("1.9"), D("1.1"), D(3)), (D("2.9"), D("2.1"), D(3)), (D(4), D(3), D(1))]
        poc, vah, val = catalog._profile(bars, 70, 4)
        self.assertEqual((poc, vah, val), (D("1.5"), D(3), D(1)))


class EventTest(unittest.TestCase):
    """Ventana 12, 70 %, 12 bins, confirmación 3: el área previa es 103.33 .. 105.83 (ver ``_scenario``)."""
    PERIOD = (12, 70, 12, 3)

    def _scenario(self, tail):
        bars = [_candle(0, 110, 100, 105, 1)] + [_candle(i, 106, 104, 105, 10) for i in range(1, 12)]
        return bars + [_candle(12 + i, c + 1, c - 1, c, 10) for i, c in enumerate(tail)]

    def _run(self, tail):
        features = IncrementalFeatures({"valuearea": [self.PERIOD]}, series="5m")
        return [features.update(c) for c in self._scenario(tail)]

    def test_area_of_the_scenario(self):
        out = self._run([105])
        self.assertEqual(out[11]["vah"], None)                  # the area of bar 11 needs 12 bars BEFORE it
        self.assertAlmostEqual(float(out[12]["vah"]), 100 + 10 * 7 / 12, places=9)
        self.assertAlmostEqual(float(out[12]["val"]), 100 + 10 * 4 / 12, places=9)

    def test_accepted_up_counts_the_closes_outside_in_the_window(self):
        out = self._run([107, 107, 107, 105])      # exit at bar 12; bars 13, 14, 15 are the window
        self.assertIsNone(out[14]["vaside"])
        self.assertEqual((out[15]["vaside"], out[15]["vaout"], out[15]["vain"]), ("1", "2", "1"))

    def test_fresh_exit_only_when_the_previous_close_was_inside(self):
        # bar 12 already outside (107), bar 13 outside again: not a new exit; bar 11 closed at 105 (inside) so bar 12 is
        out = self._run([107, 107, 107, 107, 107])
        self.assertEqual((out[15]["vaside"], out[15]["vaout"], out[15]["vain"]), ("1", "3", "0"))
        self.assertIsNone(out[16]["vaside"])       # bar 13 was not a fresh exit

    def test_down_exit_and_rejection(self):
        out = self._run([102, 104, 104, 104])      # below VAL 103.33 at bar 12, then back inside
        self.assertEqual((out[15]["vaside"], out[15]["vaout"], out[15]["vain"]), ("-1", "0", "1"))

    def test_no_event_while_inside_the_area(self):
        out = self._run([105, 105, 105, 105, 105])
        self.assertTrue(all(row["vaside"] is None for row in out))

    def test_future_bars_do_not_change_the_past(self):
        rng = random.Random(9)
        price, ones = 100.0, []
        for i in range(260):
            price += rng.gauss(0, 0.7)
            ones.append(_candle(i, round(price + 0.5, 4), round(price - 0.5, 4), round(price, 4), round(rng.uniform(1, 9), 4)))
        whole = IncrementalFeatures({"valuearea": [self.PERIOD]}, series="5m")
        full = [whole.update(c) for c in ones]
        for index in range(0, 260, 37):
            partial = IncrementalFeatures({"valuearea": [self.PERIOD]}, series="5m")
            rows = [partial.update(c) for c in ones[:index + 1]]
            self.assertEqual(rows[-1], full[index])
        self.assertTrue(any(row["vaside"] is not None for row in full))

    def test_one_minute_series_does_not_carry_the_profile(self):
        features = IncrementalFeatures({"valuearea": [self.PERIOD]}, series="1m")
        self.assertNotIn("vah", features.update(_candle(0, 101, 99, 100, 1)))

    def test_two_configurations_in_one_run_are_refused(self):
        with self.assertRaises(ValueError):
            merge_periods(DEFAULT_PERIODS, {"valuearea": [(12, 70, 12, 3)]}, {"valuearea": [(24, 70, 12, 3)]})


class SpecTest(unittest.TestCase):
    def spec(self):
        return load_spec(SPEC_PATH)

    def test_params_drive_the_indicator(self):
        spec = self.spec()
        self.assertEqual(declared_indicators(spec)["valuearea"], ((288, 70, 48, 6),))
        spec["params"].update(profile_bars="144", area_pct="68", bins="24", confirm_bars="3")
        self.assertEqual(declared_indicators(spec)["valuearea"], ((144, 68, 24, 3),))
        for name in ("profile_bars", "area_pct", "bins", "confirm_bars", "accept_min", "stop_atr", "target_stop_ratio"):
            self.assertIn(name, spec["params"])

    def test_invalid_configurations_are_refused(self):
        for field, value in (("profile_bars", "5"), ("area_pct", "100"), ("area_pct", "70.5"), ("bins", "2"),
                             ("confirm_bars", "0"), ("confirm_bars", "x")):
            spec = self.spec()
            spec["params"][field] = value
            with self.assertRaises(SpecError, msg=(field, value)):
                validate_spec(spec)
        spec = self.spec()
        spec["indicators"]["valuearea"]["bins"] = "$missing"
        with self.assertRaises(SpecError):
            validate_spec(spec)
        spec = self.spec()
        del spec["indicators"]["valuearea"]["pct"]
        with self.assertRaises(SpecError):
            validate_spec(spec)

    def test_features_need_the_declaration_and_the_5m_series(self):
        spec = self.spec()
        del spec["indicators"]["valuearea"]
        with self.assertRaises(SpecError):
            validate_spec(spec)
        spec = self.spec()
        spec["rules"]["checks"][0]["node"]["all"][1]["any"][0]["all"][0]["operand"] = "1m.vaout"
        with self.assertRaises(SpecError):
            validate_spec(spec)

    def _proposal(self, side, out, inside, regime="range"):
        current = {"ready": True, "candidate_close": "100", "candidate_bucket_start_ms": 1_791_000_000_000, "atr14": "1"}
        trend = {"ready": True, "logvol288": "0.001"}
        if side is not None:
            trend.update(vaside=str(side), vaout=str(out), vain=str(inside))
        return propose_spec(self.spec(), current, trend=trend, regime=regime, tick_size="0.5")

    def test_accepted_goes_with_the_break_and_rejected_goes_against(self):
        self.assertEqual(self._proposal(1, 4, 0)["action"], "LONG")        # accepted above VAH
        self.assertEqual(self._proposal(1, 6, 1)["action"], "LONG")        # 4 of 6 outside counts even if the last is back in
        self.assertEqual(self._proposal(-1, 5, 0)["action"], "SHORT")      # accepted below VAL
        self.assertEqual(self._proposal(1, 3, 1)["action"], "SHORT")       # rejected above: failed break, short
        self.assertEqual(self._proposal(-1, 0, 1)["action"], "LONG")       # rejected below: failed break, long

    def test_neither_accepted_nor_back_inside_waits(self):
        self.assertEqual(self._proposal(1, 3, 0)["action"], "WAIT")        # under 4 outside but the last close is not inside
        self.assertEqual(self._proposal(-1, 2, 0)["action"], "WAIT")
        self.assertEqual(self._proposal(None, 0, 0)["action"], "WAIT")     # no exit event: inside the area, no trade

    def test_levels_are_proposed_for_both_directions(self):
        long_, short = self._proposal(1, 4, 0), self._proposal(-1, 4, 0)
        self.assertLess(Decimal(long_["proposed_stop"]), Decimal("100"))
        self.assertGreater(Decimal(short["proposed_stop"]), Decimal("100"))
        self.assertEqual(long_["horizon_minutes"], 360)

    def test_accept_min_is_a_param(self):
        spec = self.spec()
        spec["params"]["accept_min"] = "2"
        current = {"ready": True, "candidate_close": "100", "candidate_bucket_start_ms": 1, "atr14": "1"}
        trend = {"ready": True, "logvol288": "0.001", "vaside": "1", "vaout": "3", "vain": "1"}
        self.assertEqual(propose_spec(spec, current, trend=trend, tick_size="0.5")["action"], "LONG")
        self.assertEqual(copy.deepcopy(self.spec())["params"]["accept_min"], "4")


if __name__ == "__main__":
    unittest.main()
