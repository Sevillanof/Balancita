"""PR 1 del catalogo de indicadores: IncrementalFeatures sobre el catalogo da exactamente las mismas salidas que antes."""
import hashlib
import json
import random
import unittest

from balancita_engine import indicator_catalog as catalog
from balancita_engine.futures_indicators import calculate_features
from balancita_engine.futures_simulator import IncrementalFeatures
from balancita_engine.futures_verdicts import ONE_MINUTE_MS, _feature_candle

from test_futures_forward_incremental import real_sample_candles
from test_futures_spec_strategy import _random_walk

WIDE = {"ema": (9, 21, 50), "sma": (50, 20), "rsi": (14, 7), "atr": (14, 7), "bollinger": (20, 10),
        "donchian": (20, 55), "logret": (5, 60), "logvol": (10, 288)}
SMALL = {"ema": (3,), "sma": (3,), "rsi": (3,), "atr": (3,), "bollinger": (3,), "donchian": (3,), "logret": (2,),
         "logvol": (3,)}


def _candle(index, o, h, l, c, v):
    return {"bucket_start": 1_700_000_000_000 + index * ONE_MINUTE_MS, "open": o, "high": h, "low": l, "close": c,
            "volume_btc": v}


# A mano: sube, vela plana (sin cambio), baja y sube: cubre ganancia/perdida nula y el rango verdadero con hueco.
HAND = [_candle(i, *row) for i, row in enumerate([
    ("100", "102", "99", "101", "2"), ("101", "103", "100", "102", "3"), ("102", "104", "101", "103", "1.5"),
    ("103", "103", "103", "103", "0"), ("103", "103", "103", "103", "0"), ("103", "106", "102", "105", "4"),
    ("105", "105", "98", "99", "9"), ("99", "100", "97", "97.5", "7"), ("97.5", "101", "97", "100.25", "5"),
    ("100.25", "101", "100", "100.5", "2"), ("100.5", "108", "100.5", "107", "12"), ("107", "107.5", "104", "105", "6"),
])]


def digest(periods, candles):
    features = IncrementalFeatures(periods)
    out = [features.update(c) for c in candles]
    return hashlib.sha256(json.dumps(out, sort_keys=False, separators=(",", ":")).encode()).hexdigest()


# Huellas calculadas con la implementacion anterior (antes del catalogo). Cualquier cambio de valor, de clave o de orden rompe.
GOLDEN = {
    "hand": "81e3a441dff73e127b0ea1fa7830194bd848bf74db046295edfe990b2b8d81c2",
    "walk": "99bd43d134e9ba1b7f3e137aae50ca4dbd35a8df8151c6fa1e57309bcbd9037a",
    "sample": "fdbd759fe3c09ac18ccbf02ccc805e049f58b6a1cc57143b85f56e826a3d0687"
              "75238d8903f84020cec1f1463cc343430b1a90f1cb8122f574c57e44a983a8ee",
}


class ParityWithPreviousImplementation(unittest.TestCase):
    def test_hand_written_candles(self):
        self.assertEqual(digest(SMALL, HAND), GOLDEN["hand"])

    def test_random_walk_wide_periods(self):
        ones, _ = _random_walk(random.Random(11), 1500)
        self.assertEqual(digest(WIDE, ones), GOLDEN["walk"])

    def test_real_sample(self):
        ones, fives = real_sample_candles()
        self.assertGreater(len(ones), 1000)
        self.assertEqual(digest(WIDE, ones) + digest(WIDE, fives), GOLDEN["sample"])

    def test_the_hand_written_flat_candles_have_the_documented_edge_values(self):
        # Valores simples que se verifican a ojo: 5 cierres 101, 102, 103, 103, 103.
        out = [IncrementalFeatures(SMALL).update(c) for c in HAND[:1]]
        self.assertEqual(out[0]["ema3"], None)
        features = IncrementalFeatures(SMALL)
        rows = [features.update(c) for c in HAND]
        self.assertEqual(rows[2]["ema3"], "102")          # media simple de la semilla
        self.assertEqual(rows[4]["rsi3"], "100")          # sin perdidas en las 3 ventanas
        self.assertEqual(rows[2]["sma3"], "102")
        self.assertFalse(rows[2]["ready"])


class FlatMarket(unittest.TestCase):
    def test_a_market_that_never_moves_has_rsi_50_and_an_invalid_atr(self):
        features = IncrementalFeatures(SMALL)
        for i in range(8):
            row = features.update(_candle(i, "100", "100", "100", "100", "1"))
        self.assertEqual(row["rsi3"], "50")
        self.assertEqual(row["atr3"], "0")
        self.assertIn("invalid_or_zero_atr", row["reason_codes"])
        self.assertFalse(row["ready"])


class CatalogShape(unittest.TestCase):
    def test_every_indicator_kind_the_simulator_accepts_is_registered(self):
        from balancita_engine.futures_simulator import PERIOD_KINDS
        self.assertEqual(set(catalog.CATALOG), set(PERIOD_KINDS))

    def test_declared_warmup_follows_the_design(self):
        self.assertEqual(catalog.warmup_bars("ema", 50), 600)       # 12 x periodo
        self.assertEqual(catalog.warmup_bars("rsi", 14), 336)       # Wilder: 24 x periodo
        self.assertEqual(catalog.warmup_bars("atr", 14), 336)
        self.assertEqual(catalog.warmup_bars("logvol", 288), 3456)
        self.assertEqual(catalog.warmup_bars("sma", 50), 51)        # ventana + 1
        self.assertEqual(catalog.consumer_warmup_bars([("ema", 9)]), 288)   # minimo de la histeresis
        self.assertEqual(catalog.consumer_warmup_bars([("logvol", 288)]), 3458)   # max de needs + 2

    def test_funding_vs24h_is_reserved(self):
        self.assertEqual(catalog.RESERVED["funding.vs24h"].status, "reserved")
        self.assertNotIn("funding.vs24h", catalog.CATALOG)
        self.assertTrue(all(d.status == "active" for d in catalog.CATALOG.values()))


class KnownDivergenceFromVerdictFeatures(unittest.TestCase):
    """DOCUMENTA que `calculate_features` (C/Q/E, ventana de 200 velas) todavia no coincide con el catalogo.

    Se resuelve en el PR 4 (C sobre el alimentador comun). Mientras tanto la diferencia esta declarada: este test pasa
    cuando AMBAS cosas siguen siendo ciertas (hay diferencia con la semilla de 200 velas y no la hay con historia exacta).
    Si el PR 4 las unifica, este test debe borrarse con su cambio.
    """

    def test_ema_differs_with_a_200_bar_seed_but_matches_on_exactly_that_window(self):
        ones, _ = _random_walk(random.Random(11), 1500)
        bars = [_feature_candle(c) for c in ones]
        window = bars[-200:]
        want = calculate_features(window, interval_ms=ONE_MINUTE_MS, decision_time_ms=window[-1]["known_at_ms"])
        full = IncrementalFeatures()
        for c in ones:
            got = full.update(c)
        self.assertNotEqual(got["ema21"], want["ema21"])        # semilla distinta: diferencia conocida
        short = IncrementalFeatures()
        for c in ones[-200:]:
            got_short = short.update(c)
        self.assertEqual(got_short["ema21"], want["ema21"])     # misma ventana: coincide
        self.assertEqual(got_short["rsi14"], want["rsi14"])


if __name__ == "__main__":
    unittest.main()
