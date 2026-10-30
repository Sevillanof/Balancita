"""El maestro de operación del LoRA (``futures_qwen_maestro``): hechos aplanados, antisimetría, veredictos, ajuste y el archivo del repo."""
import importlib.util
import json
import math
import os
import random
import tempfile
import unittest

from balancita_engine import futures_qwen_maestro as maestro
from balancita_engine import futures_qwen_trader as qt
from balancita_engine.futures_qwen_ficha import FACTORS, VOTING


def facts(sign=1.0):
    """Hechos como los de ``futures_qwen_ficha.facts`` (orientación real), con dirección ``sign``."""
    return {"ret": {"1h": 0.001 * sign, "4h": 0.004 * sign, "24h": -0.01 * sign, "7d": 0.02 * sign},
            "z": {"1h": 0.3 * sign, "4h": 0.8 * sign, "24h": -1.1 * sign, "7d": 0.5 * sign},
            "move15": 0.0006 * sign, "norm15": 0.002, "pos24": 0.4 * sign, "pos7": -0.2 * sign,
            "since_hi": 3.0 if sign > 0 else 9.0, "since_lo": 9.0 if sign > 0 else 3.0,
            "vol1h": 1.2, "vol24": 0.9, "realized": 1.5, "range24": 0.03, "range7": 0.04,
            "area": {"signed": 0.7 * sign, "above": 10 if sign > 0 else 2, "below": 2 if sign > 0 else 10, "place": "x"},
            "pos": {"long": None}, "strength": 0.9 * sign}


def teacher(coef=None, weak=0.5, strong=1.0):
    return {"schema": "balancita-qwen-lora-maestro.v1", "plazo_min": 720, "umbrales": {"flojo": weak, "fuerte": strong},
            "sd": {f: 1.0 for f in maestro.DIRECTIONAL}, "coeficientes": coef or {f: 0.0 for f in maestro.DIRECTIONAL}}


class FactsTests(unittest.TestCase):
    def test_flat_facts_has_every_directional_and_symmetric_number(self):
        row = maestro.flat_facts(facts())
        self.assertEqual(set(row), set(maestro.DIRECTIONAL) | set(maestro.SYMMETRIC))
        self.assertAlmostEqual(row["move15_n"], 0.3)
        self.assertEqual(row["since_diff"], 6.0)
        self.assertEqual((row["area_signed"], row["area_out"]), (0.7, 8))
        self.assertEqual(row["realized"], 1.5)

    def test_missing_area_and_strength_are_zero_and_the_mirror_negates_only_the_directional_numbers(self):
        f = facts()
        f["area"] = None
        f["strength"] = None
        row = maestro.flat_facts(f)
        self.assertEqual((row["area_signed"], row["area_out"], row["strength"]), (0.0, 0.0, 0.0))
        m = maestro.mirror_facts(maestro.flat_facts(facts()))
        self.assertEqual(m["z_24h"], 1.1)
        self.assertEqual(m["since_diff"], -6.0)
        self.assertEqual(m["vol24"], 0.9)
        # the sheet of the opposite market gives exactly the mirror
        self.assertEqual(maestro.flat_facts(facts(-1.0)), {k: (-v if k in maestro.DIRECTIONAL else v) for k, v in maestro.flat_facts(facts()).items()})

    def test_extra_eth_facts_include_eth_btc_strength_and_f6_derivatives_and_flip_in_mirror(self):
        f = facts()
        f["strength_btc"] = 1.4
        f["strength_btc_24h"] = -2.1
        f["pos"] = {"long": 58.0, "top": 44.0, "premium": 3.5}
        f["funding_rate"] = 0.00012
        row = maestro.flat_facts(f, extra_eth=True)
        self.assertEqual(set(row), set(maestro.ALL_DIRECTIONAL) | set(maestro.SYMMETRIC))
        self.assertAlmostEqual(row["strength_btc"], 1.4)
        self.assertAlmostEqual(row["strength_btc_24h"], -2.1)
        self.assertAlmostEqual(row["premium_bp"], 3.5)
        self.assertAlmostEqual(row["long_bias"], 8.0)
        self.assertAlmostEqual(row["top_long_bias"], -6.0)
        self.assertAlmostEqual(row["funding_bp"], 1.2)
        m = maestro.mirror_facts(row)
        for k in maestro.ETH_EXTRA_DIRECTIONAL:
            self.assertAlmostEqual(m[k], -row[k])
        for k in maestro.SYMMETRIC:
            self.assertEqual(m[k], row[k])


class VerdictTests(unittest.TestCase):
    def test_the_score_is_antisymmetric_and_the_verdict_follows_the_thresholds(self):
        t = teacher({**{f: 0.0 for f in maestro.DIRECTIONAL}, "z_24h": -1.0, "pos7": -0.5})
        row = maestro.flat_facts(facts())
        self.assertAlmostEqual(maestro.score(t, row), 1.1 + 0.1)
        self.assertAlmostEqual(maestro.score(t, maestro.mirror_facts(row)), -1.2)
        self.assertEqual(maestro.verdict(t, row), 2)
        self.assertEqual(maestro.verdict(t, maestro.mirror_facts(row)), -2)
        self.assertEqual([maestro.verdict_of(t, s) for s in (0.0, 0.49, 0.5, -0.7, 0.99, 1.0, -3.0)], [0, 0, 1, -1, 1, 2, -2])

    def test_label_values_put_the_verdict_on_the_voting_lines_only(self):
        t = teacher({**{f: 0.0 for f in maestro.DIRECTIONAL}, "z_24h": -1.0})
        values = maestro.label_values(t, maestro.flat_facts(facts()))
        self.assertEqual(values, [2 if f in VOTING else 0 for f in FACTORS])
        self.assertEqual(maestro.label_values(t, maestro.flat_facts(facts(-1.0))), [-v for v in values])
        self.assertEqual(maestro.label_values(teacher(), maestro.flat_facts(facts())), [0] * 8)


@unittest.skipUnless(importlib.util.find_spec("numpy"), "el ajuste necesita numpy (la CI no lo instala; leer el maestro no lo necesita)")
class FitTests(unittest.TestCase):
    def rows(self, n=3000, seed=1):
        """Fotos sintéticas: el movimiento a 12 h sigue a z_24h (invertido) y a pos7, con ruido; las demás no dicen nada."""
        rng = random.Random(seed)
        out = []
        for i in range(n):
            row = {f: rng.gauss(0, 1) for f in maestro.DIRECTIONAL}
            row.update({f: abs(rng.gauss(1, 0.3)) for f in maestro.SYMMETRIC})
            signal = -row["z_24h"] + 0.5 * row["pos7"]
            row.update({"product": "PF_XBTUSD" if i % 2 else "PF_ETHUSD", "t_ms": qt.date_ms("2025-01-01") + i * 900000,
                        "move_720": 30.0 * signal + rng.gauss(0, 40), "move_240": rng.gauss(0, 20)})
            out.append(row)
        return out

    def test_fit_recovers_the_direction_of_the_signal_and_sets_the_quantile_thresholds(self):
        t = maestro.fit(self.rows(), 720)
        self.assertEqual(t["schema"], "balancita-qwen-lora-maestro.v1")
        coef = t["coeficientes"]
        self.assertLess(coef["z_24h"], -0.3)
        self.assertGreater(coef["pos7"], 0.1)
        self.assertTrue(all(abs(coef[f]) < 0.1 for f in maestro.DIRECTIONAL if f not in ("z_24h", "pos7")))
        self.assertGreater(t["ajuste"]["acierto_signo"], 0.6)
        rows = self.rows()
        verdicts = [maestro.verdict(t, r) for r in rows]
        self.assertAlmostEqual(sum(1 for v in verdicts if abs(v) == 2) / len(rows), 0.2, delta=0.02)
        self.assertAlmostEqual(sum(1 for v in verdicts if v == 0) / len(rows), 0.5, delta=0.02)
        self.assertTrue(all(maestro.verdict(t, maestro.mirror_facts(r)) == -v for r, v in zip(rows[:300], verdicts)))
        measured = maestro.measure(t, self.rows(seed=2))
        self.assertGreater(measured["acierto_fuerte"], measured["acierto_signo"])
        self.assertTrue(measured["espejo_opuesto_exacto"])

    def test_the_logistic_fit_matches_a_closed_form_check_and_refuses_too_few_rows(self):
        # one feature, perfectly balanced: with a strong L2 the solution is small and has the sign of the correlation
        import numpy as np

        Z = np.array([[1.0], [-1.0]] * 500)
        y = np.array([1.0, 0.0] * 500)
        w = maestro.logistic_no_intercept(Z, y, l2=1000.0)
        self.assertGreater(w[0], 0.0)
        self.assertLess(w[0], 1.0)
        few = self.rows(n=50)
        with self.assertRaises(qt.TraderError):
            maestro.fit(few, 720)

    def test_the_cli_fits_measures_and_the_file_round_trips(self):
        rows = self.rows()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "facts.jsonl")
            with open(path, "w", encoding="utf-8") as handle:
                for r in rows:
                    handle.write(json.dumps(r) + "\n")
            out = os.path.join(tmp, "maestro.json")
            maestro.main(["fit", "--facts", path, "--plazo", "720", "--out", out, "--to", "2025-01-20"])
            t = maestro.load(out)
            self.assertEqual(t["_path"], out)
            self.assertLessEqual(t["ajuste"]["hasta"][:10], "2025-01-19")
            self.assertEqual(len(maestro.teacher_hash(t)), 12)
            maestro.main(["medir", "--facts", path, "--maestro", out])
            eth_out = os.path.join(tmp, "maestro-eth.json")
            maestro.main(["fit", "--facts", path, "--plazo", "720", "--products", "PF_ETHUSD", "--eth-features", "--out", eth_out])
            t_eth = maestro.load(eth_out)
            self.assertEqual(t_eth["ajuste"]["productos"], ["PF_ETHUSD"])
            self.assertEqual(set(t_eth["coeficientes"]), set(maestro.ALL_DIRECTIONAL))
            with open(out, "w", encoding="utf-8") as handle:
                json.dump({"schema": "otro"}, handle)
            with self.assertRaises(qt.TraderError):
                maestro.load(out)


class RepoFileTests(unittest.TestCase):
    def test_the_teacher_in_the_repo_loads_is_antisymmetric_and_has_the_agreed_shares(self):
        t = maestro.load()
        self.assertEqual(t["plazo_min"], 720)
        self.assertEqual((t["ajuste"]["fuerte_share"], t["ajuste"]["flojo_share"]), (0.2, 0.5))
        self.assertLess(t["umbrales"]["flojo"], t["umbrales"]["fuerte"])
        row = maestro.flat_facts(facts())
        self.assertAlmostEqual(maestro.score(t, row), -maestro.score(t, maestro.mirror_facts(row)))
        self.assertTrue(all(math.isfinite(v) and v > 0 for v in t["sd"].values()))
        # the weight is on the 24 h trend (F1) and the place in the range (F3), as measured on 27-oct
        heavy = sorted(t["coeficientes"], key=lambda f: -abs(t["coeficientes"][f]))[:3]
        self.assertTrue({"z_24h", "ret_24h"} & set(heavy))


if __name__ == "__main__":
    unittest.main()
