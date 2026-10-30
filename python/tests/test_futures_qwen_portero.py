"""El portero de la versión 8 (``futures_qwen_portero``): números orientados, simetría exacta en el espejo, la etiqueta de la
salida «se da vuelta o 48 h», el ajuste (solo con numpy) y el archivo del repo."""
import importlib.util
import json
import math
import os
import random
import tempfile
import unittest

from balancita_engine import futures_qwen_maestro as maestro
from balancita_engine import futures_qwen_portero as portero
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_maestro import facts, teacher

HAS_NUMPY = importlib.util.find_spec("numpy") is not None
MIN = qt.MINUTE_MS


def keeper(coef=None, threshold=0.55, intercept=0.0):
    return {"schema": portero.SCHEMA, "media": {f: 0.0 for f in portero.FEATURES}, "sd": {f: 1.0 for f in portero.FEATURES},
            "coeficientes": {f: 0.0 for f in portero.FEATURES} | (coef or {}), "intercepto": intercept, "umbral": threshold}


class FeatureTests(unittest.TestCase):
    def test_the_directional_numbers_are_oriented_by_the_side_and_the_sizes_are_not(self):
        row = maestro.flat_facts(facts())
        long_, short = portero.features(row, 1, 0.4), portero.features(row, -1, -0.4)
        self.assertEqual(set(long_), set(portero.FEATURES))
        self.assertEqual(long_["lado_x_z_24h"], -1.1)
        self.assertEqual(short["lado_x_z_24h"], 1.1)
        self.assertEqual((long_["vol24"], short["vol24"]), (0.9, 0.9))
        self.assertEqual((long_["claridad"], short["claridad"]), (0.4, 0.4))

    def test_extra_eth_features_are_oriented_by_side_and_keep_mirror_invariance(self):
        f = facts()
        f["strength_btc"], f["strength_btc_24h"] = 1.2, -0.8
        f["pos"] = {"long": 60.0, "top": 55.0, "premium": 4.0}
        f["funding_rate"] = 0.0001
        row = maestro.flat_facts(f, extra_eth=True)
        long_ = portero.features(row, 1, 0.5, extra_eth=True)
        short = portero.features(row, -1, -0.5, extra_eth=True)
        self.assertEqual(set(long_), set(portero.ALL_FEATURES))
        self.assertAlmostEqual(long_["lado_x_strength_btc"], 1.2)
        self.assertAlmostEqual(short["lado_x_strength_btc"], -1.2)
        k = {"schema": portero.SCHEMA, "media": {k_: 0.0 for k_ in portero.ALL_FEATURES},
             "sd": {k_: 1.0 for k_ in portero.ALL_FEATURES},
             "coeficientes": {k_: 0.1 for k_ in portero.ALL_FEATURES}, "intercepto": 0.2, "umbral": 0.55}
        self.assertAlmostEqual(
            portero.probability(k, row, 1, 0.5),
            portero.probability(k, maestro.mirror_facts(row), -1, -0.5),
            places=12,
        )

    def test_the_probability_is_exactly_the_same_in_the_mirror(self):
        rng = random.Random(5)
        k = keeper({f: rng.uniform(-1, 1) for f in portero.FEATURES}, intercept=0.3)
        for _ in range(50):
            row = {f: rng.uniform(-3, 3) for f in maestro.DIRECTIONAL} | {f: rng.uniform(0, 3) for f in maestro.SYMMETRIC}
            s = rng.uniform(-1, 1)
            side = -1 if s < 0 else 1
            p = portero.probability(k, row, side, s)
            self.assertAlmostEqual(p, portero.probability(k, maestro.mirror_facts(row), -side, -s), places=12)
            self.assertEqual(portero.verdict(k, row, s), portero.verdict(k, maestro.mirror_facts(row), -s))

    def test_the_verdict_follows_the_threshold_of_the_file(self):
        k = keeper({"claridad": 1.0}, threshold=0.6)
        self.assertEqual(portero.verdict(k, maestro.flat_facts(facts()), 0.0), (False, 0.5))
        yes, p = portero.verdict(k, maestro.flat_facts(facts()), 0.9)
        self.assertTrue(yes)
        self.assertAlmostEqual(p, 1 / (1 + math.exp(-0.9)))

    def test_load_checks_the_schema_and_the_hash_covers_only_what_decides(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "p.json")
            with open(path, "w") as handle:
                json.dump({"schema": "otra"}, handle)
            with self.assertRaises(qt.TraderError):
                portero.load(path)
            k = keeper()
            with open(path, "w") as handle:
                json.dump(k, handle)
            loaded = portero.load(path)
            self.assertEqual(portero.portero_hash(loaded), portero.portero_hash(dict(k, nota="otra nota", ajuste={"x": 1})))
            self.assertNotEqual(portero.portero_hash(loaded), portero.portero_hash(dict(k, umbral=0.6)))


class LabelTests(unittest.TestCase):
    """Fotos cada 15 min de un producto; el maestro mira solo z_24h."""

    def rows(self, zs, t0=qt.date_ms("2025-01-01")):
        out = []
        for i, z in enumerate(zs):
            row = maestro.flat_facts(facts())
            row["z_24h"] = z
            row["t_ms"], row["product"], row["cost_bp"] = t0 + i * 15 * MIN, "PF_XBTUSD", 10.0
            out.append(row)
        return out

    def test_the_trade_exits_when_the_maestro_turns_weak_against_it_or_at_48_hours(self):
        t = teacher({**{f: 0.0 for f in maestro.DIRECTIONAL}, "z_24h": 1.0}, weak=0.5, strong=1.0)
        rows = self.rows([2.0, 1.0, 0.2, -0.3, -0.6, -2.0, -2.0])          # long at 0; the maestro says BAJA FLOJO at photo 4
        t0 = rows[0]["t_ms"]
        closes = {t0 + k * 15 * MIN: 100.0 + k for k in range(len(rows))}
        for k in range(len(rows)):
            closes[t0 + k * 15 * MIN + 2880 * MIN] = 150.0                 # the 48 h close of every photo
        nets = portero.trade_results(rows, t, closes, 10.0)
        self.assertAlmostEqual(nets[0], (104.0 / 100.0 - 1) * 1e4 - 10.0)   # exits at photo 4 (close 104)
        self.assertAlmostEqual(nets[1], (104.0 / 101.0 - 1) * 1e4 - 10.0)
        # the short opened at photo 5 never sees the maestro turn: it holds 48 h (close known) and the shorts gain when it falls
        self.assertAlmostEqual(nets[5], -1 * (150.0 / 105.0 - 1) * 1e4 - 10.0)
        self.assertAlmostEqual(nets[6], -1 * (150.0 / 106.0 - 1) * 1e4 - 10.0)

    def test_a_gap_in_the_photos_or_a_missing_close_gives_no_label(self):
        t = teacher({**{f: 0.0 for f in maestro.DIRECTIONAL}, "z_24h": 1.0}, weak=0.5, strong=1.0)
        rows = self.rows([2.0, 2.0, -2.0])
        rows[2]["t_ms"] += 15 * MIN                                        # a hole: photo 2 is 30 min after photo 1
        t0 = rows[0]["t_ms"]
        closes = {t0: 100.0, t0 + 15 * MIN: 101.0, t0 + 45 * MIN: 102.0}
        nets = portero.trade_results(rows, t, closes, 10.0)
        self.assertEqual(nets, [None, None, None])                         # the 48 h close is unknown everywhere


@unittest.skipUnless(HAS_NUMPY, "numpy")
class FitTests(unittest.TestCase):
    def test_fit_learns_that_aligned_trends_win_and_sets_the_threshold_on_the_strong_photos(self):
        rng = random.Random(9)
        t = teacher({**{f: 0.0 for f in maestro.DIRECTIONAL}, "z_24h": 1.0}, weak=0.3, strong=0.8)
        items = []
        for i in range(3000):
            row = {
                **{f: rng.gauss(0, 1) for f in maestro.DIRECTIONAL},
                **{f: abs(rng.gauss(1, 0.3)) for f in maestro.SYMMETRIC},
                "t_ms": qt.date_ms("2025-01-01") + i * 15 * MIN,
                "product": "PF_XBTUSD",
            }
            s = maestro.score(t, row)
            side = -1 if s < 0 else 1
            net = 30.0 * side * row["z_7d"] + rng.gauss(0, 20)              # the trade wins when the week's trend goes with it
            items.append((row, s, net))
        k = portero.fit(items, t)
        self.assertEqual(k["schema"], portero.SCHEMA)
        self.assertGreater(k["coeficientes"]["lado_x_z_7d"], 0.5)
        self.assertLess(abs(k["coeficientes"]["vol24"]), 0.2)
        strong = [(r, s, n) for r, s, n in items if abs(s) >= 0.8]
        taken = [1 for r, s, n in strong if portero.verdict(k, r, s)[0]]
        self.assertAlmostEqual(len(taken) / len(strong), 0.2, delta=0.03)
        report = portero.measure(k, items, t)
        self.assertTrue(report["espejo_identico"])
        self.assertGreater(report["con_portero_neto_pb"], report["fuertes_neto_pb"])

    def test_fit_refuses_too_few_rows(self):
        t = teacher()
        with self.assertRaises(qt.TraderError):
            portero.fit([], t)


class RepoFileTests(unittest.TestCase):
    def test_the_portero_in_the_repo_loads_and_is_the_one_the_live_config_declares(self):
        k = portero.load()
        cfg = qt.load_config(qt.CONFIG_PATH_LIVE)
        self.assertTrue(portero.portero_hash(k).startswith(cfg["corta"]["portero_hash"]))
        self.assertEqual(k["maestro_hash"], maestro.teacher_hash(maestro.load()))
        self.assertTrue(0.0 < k["umbral"] < 1.0)
        self.assertEqual(set(k["coeficientes"]), set(portero.FEATURES))
        row = maestro.flat_facts(facts())
        yes, p = portero.verdict(k, row, 0.5)
        self.assertTrue(0.0 <= p <= 1.0)
        self.assertEqual((yes, round(p, 12)), (portero.verdict(k, maestro.mirror_facts(row), -0.5)[0], round(portero.verdict(k, maestro.mirror_facts(row), -0.5)[1], 12)))


if __name__ == "__main__":
    unittest.main()
