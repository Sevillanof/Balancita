"""Qwen practice report: the math (random filter, logistic regression, CI) and the Spanish report."""

import contextlib
import io
import json
import os
import random
import tempfile
import unittest

from balancita_engine import futures_qwen_practice as p
from balancita_engine import futures_qwen_practice_report as r
from test_futures_qwen_practice import MINUTE, T0, make_signals_db


class MathTests(unittest.TestCase):
    def test_metrics(self):
        m = r.metrics([10.0, -5.0, 20.0, -5.0])
        self.assertEqual(m["n"], 4)
        self.assertEqual(m["hit_rate"], 0.5)
        self.assertAlmostEqual(m["mean_bp"], 5.0)
        self.assertAlmostEqual(m["profit_factor"], 3.0)
        self.assertIsNone(r.metrics([5.0, 6.0])["profit_factor"])  # no losses: undefined, not infinite
        self.assertEqual(r.metrics([])["n"], 0)
        self.assertIsNone(r.metrics([])["mean_bp"])

    def test_wilson_interval(self):
        low, high = r.wilson(50, 100)
        self.assertAlmostEqual(low, 0.4038, places=3)
        self.assertAlmostEqual(high, 0.5962, places=3)
        self.assertEqual(r.wilson(0, 0), (None, None))

    def test_bootstrap_ci_brackets_the_mean_and_is_deterministic(self):
        rng = random.Random(0)
        values = [rng.gauss(10, 30) for _ in range(300)]
        low, high = r.bootstrap_ci(values, seed=1)
        mean = sum(values) / len(values)
        self.assertLess(low, mean)
        self.assertGreater(high, mean)
        self.assertEqual((low, high), r.bootstrap_ci(values, seed=1))
        self.assertEqual(r.bootstrap_ci([1.0], seed=1), (None, None))

    def test_random_filter_percentile_of_a_perfect_filter_is_near_100(self):
        values = [float(i) for i in range(1, 41)]
        kept = values[20:]  # keeps the best half
        out = r.random_filter(values, kept_count=len(kept), observed_mean=sum(kept) / len(kept), draws=1000, seed=3)
        self.assertGreaterEqual(out["percentile"], 99.5)
        self.assertEqual(out["draws"], 1000)
        self.assertLess(out["p05"], out["p50"])
        self.assertLess(out["p50"], out["p95"])

    def test_random_filter_percentile_of_a_useless_filter_is_central(self):
        rng = random.Random(4)
        values = [rng.gauss(0, 10) for _ in range(200)]
        kept = random.Random(8).sample(values, 100)  # a subset chosen without looking at the values
        out = r.random_filter(values, len(kept), sum(kept) / len(kept), draws=1000, seed=3)
        self.assertGreater(out["percentile"], 5)
        self.assertLess(out["percentile"], 95)

    def test_random_filter_edges(self):
        out = r.random_filter([1.0, 2.0], kept_count=2, observed_mean=1.5, draws=50, seed=1)
        self.assertEqual(out["p05"], out["p95"])  # keeping everything: no variation

    def test_logistic_regression_learns_a_separable_toy_set(self):
        rng = random.Random(2)
        rows, labels = [], []
        for _ in range(300):
            x1, x2 = rng.gauss(0, 1), rng.gauss(0, 1)
            rows.append([x1, x2])
            labels.append(1 if 2.0 * x1 - 0.2 * x2 + rng.gauss(0, 0.3) > 0 else 0)
        model = r.fit_logistic(rows[:200], labels[:200])
        scores = [r.predict_logistic(model, row) for row in rows[200:]]
        correct = sum((s > 0.5) == bool(y) for s, y in zip(scores, labels[200:]))
        self.assertGreater(correct / 100, 0.9)
        self.assertGreater(model["weights"][0], 0.5)
        self.assertLess(abs(model["weights"][1]), abs(model["weights"][0]))

    def test_logistic_regression_with_one_class_returns_the_base_rate(self):
        model = r.fit_logistic([[0.0], [1.0], [2.0]], [1, 1, 1])
        self.assertGreater(r.predict_logistic(model, [5.0]), 0.9)
        none = r.fit_logistic([], [])
        self.assertEqual(r.predict_logistic(none, [1.0]), 0.5)

    def test_state_features_parse_what_the_model_saw(self):
        text = ("signal: strategy=C25-pullback side=SHORT stop_atr=1.50 target_atr=3.00 horizon_min=30\n"
                "regime: trend\nret_bp: 1m=-1.0 5m=2.5 15m=n/a 60m=-30.2\n"
                "dist_atr: ema9=0.10 ema21=-0.50 sma50=n/a\nrsi14: 61.5\nbollinger_pos: 0.80\natr_bp: 12.3\nvolume_rel: 1.40")
        names, values = r.state_features(text)
        got = dict(zip(names, values))
        self.assertEqual(got["side"], -1.0)
        self.assertEqual(got["rsi14"], 61.5)
        self.assertEqual(got["ret_5m"], 2.5)
        self.assertEqual(got["ret_15m"], 0.0)  # n/a -> 0 plus a missing flag
        self.assertEqual(got["ret_15m_missing"], 1.0)
        self.assertEqual(got["regime_trend"], 1.0)
        self.assertEqual(got["stop_atr"], 1.5)

    def test_brier_and_reliability(self):
        self.assertAlmostEqual(r.brier([1.0, 0.0], [1, 0]), 0.0)
        self.assertAlmostEqual(r.brier([0.5, 0.5], [1, 0]), 0.25)
        table = r.reliability_table([0.1, 0.15, 0.9, 0.95], [0, 0, 1, 1], bins=5)
        self.assertEqual(sum(row["n"] for row in table), 4)
        self.assertEqual(table[0]["observed"], 0.0)
        self.assertEqual(table[-1]["observed"], 1.0)

    def test_position_bias(self):
        pairs = [(0.9, 0.1), (0.8, 0.2), (0.7, 0.9)]  # p_approve in order 0 and in order 1
        bias = r.position_bias(pairs)
        self.assertAlmostEqual(bias["agreement"], 1 / 3)  # only the third pair agrees (both approve)
        self.assertAlmostEqual(bias["mean_shift"], (0.8 + 0.6 - 0.2) / 3)
        self.assertAlmostEqual(bias["letter_a_share"], 5 / 6)  # answers whose most likely option sat under letter A
        self.assertEqual(bias["n"], 3)


class ThresholdTests(unittest.TestCase):
    def test_the_threshold_is_chosen_on_calibration_only(self):
        calibration = [(0.2, -30.0), (0.3, -20.0), (0.4, -10.0), (0.6, 10.0), (0.7, 20.0), (0.8, 30.0)] * 10
        validation = [(0.2, 500.0), (0.8, -500.0)] * 10  # would pick the opposite filter
        chosen = r.choose_threshold(calibration, min_kept=0.3)
        self.assertGreaterEqual(chosen, 0.5)
        self.assertEqual(chosen, r.choose_threshold(calibration, min_kept=0.3))
        kept = [net for score, net in validation if score >= chosen]
        self.assertTrue(all(v < 0 for v in kept))  # validation did not influence the choice

    def test_no_threshold_keeps_too_few(self):
        self.assertEqual(r.choose_threshold([(0.9, 1.0)] * 3, min_kept=0.3), 0.5)


def practice_with(signals_path, tmp, rule):
    """A practice DB with scripted p_approve per signal: ``rule(signal) -> (p_order0, p_order1)``."""
    import sqlite3
    path = os.path.join(tmp, "practice.sqlite")
    db = sqlite3.connect(path)
    db.executescript(p.PRACTICE_SCHEMA)
    for s in p.read_signals(signals_path):
        a, b = rule(s)
        for variant, pa in ((0, a), (1, b)):
            order = ["approve", "reject"] if variant == 0 else ["reject", "approve"]
            db.execute("INSERT INTO decisions(signal_id, variant, option_order, p_approve, probabilities, chosen, "
                       "confidence, source, latency_ms, model_ref, model_props, question_id, question_version, "
                       "prompt_version, prompt_hash, asked_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (s["signal_id"], variant, json.dumps(order), pa, json.dumps({"approve": pa, "reject": 1 - pa}),
                        "approve" if pa >= 0.5 else "reject", 0.5, "raw_logprobs", 10, "fake", "{}", "signal_filter", 1, 2, "h", 0))
    db.commit()
    db.close()
    return path


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.signals, self.rows = make_signals_db(self.tmp.name, count_per_stratum=150)

    def test_a_filter_that_knows_the_outcome_is_reported_as_adding_value(self):
        """Scripted 'oracle' scores (outcome-aware, only possible in a test) must come out as value added."""
        outcome = {s["signal_id"]: s["own_net_bp"] for s in self.rows}
        practice = practice_with(self.signals, self.tmp.name,
                                 lambda s: (0.9, 0.9) if outcome[s["signal_id"]] > 0 else (0.1, 0.1))
        text = r.build_report(self.signals, practice)
        self.assertIn("**Qwen agrega valor", text)
        self.assertIn("Veredicto", text)

    def test_a_coin_flip_filter_is_not_valuable_and_the_bias_is_flagged(self):
        practice = practice_with(self.signals, self.tmp.name, lambda s: (0.8, 0.2))  # always letter A
        text = r.build_report(self.signals, practice)
        self.assertNotIn("Qwen agrega valor", text)
        self.assertIn("sesgo de posición", text)

    def test_report_has_all_sections_in_spanish(self):
        rng = random.Random(9)
        practice = practice_with(self.signals, self.tmp.name, lambda s: (lambda x: (x, x))(rng.random()))
        text = r.build_report(self.signals, practice)
        for heading in ("# Informe", "## Veredicto", "## Resumen", "## Por estrategia", "## Calibración de Qwen",
                        "## Sesgo de posición", "## Por periodo y pliegue", "## Línea base"):
            self.assertIn(heading, text)
        for word in ("percentil", "Brier", "regresión logística", "validación", "calibración", "pre_cutoff"):
            self.assertIn(word, text)
        self.assertTrue(any(line.startswith(("**Qwen agrega valor", "**Qwen necesita configuración", "**Qwen no agrega valor"))
                            for line in text.splitlines()))

    def test_small_samples_are_called_inconclusive(self):
        small, _ = make_signals_db(self.tmp.name, count_per_stratum=3)
        practice = practice_with(small, self.tmp.name, lambda s: (0.6, 0.6))
        text = r.build_report(small, practice)
        self.assertIn("Qwen necesita configuración", text)
        self.assertIn("muestra insuficiente", text)

    def test_report_cli_writes_the_file(self):
        practice = practice_with(self.signals, self.tmp.name, lambda s: (0.7, 0.7))
        out = os.path.join(self.tmp.name, "informe.md")
        with contextlib.redirect_stdout(io.StringIO()):
            code = p.main(["report", "--signals", self.signals, "--practice", practice, "--out", out])
        self.assertEqual(code, 0)
        with open(out, encoding="utf-8") as handle:
            self.assertIn("# Informe", handle.read())


if __name__ == "__main__":
    unittest.main()
