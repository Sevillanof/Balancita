"""Agreement of the rules engine with reference labels (S10, T18): informative only, development and test split apart."""
import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest

from balancita_engine import futures_news_reglas_eval as ev


def row(received_at, ref_type, ref_strength, ref_direction, title="t"):
    return {"title": title, "summary": "", "source_id": "", "received_at": received_at,
            "etiqueta": {"event_type": ref_type, "strength": ref_strength, "direction": ref_direction}}


def fixed(event_type, strength, direction):
    return lambda title, summary, source_id: {"event_type": event_type, "strength": strength, "direction": direction}


class AgreementTests(unittest.TestCase):
    def test_strength_is_compared_exact_and_in_the_groups_0_1_and_2_3(self):
        rows = [row(1, "hack", 2, "bearish"), row(1, "hack", 3, "bearish"), row(1, "other", 0, "neutral"),
                row(1, "other", 1, "neutral")]
        report = ev.agreement(rows, fixed("hack", 2, "bearish"))
        self.assertEqual(report["n"], 4)
        self.assertEqual(report["strength_exact_pct"], 25.0)
        self.assertEqual(report["strength_bucket_pct"], 50.0)  # the 2 and the 3 are the same group
        self.assertEqual(report["direction_pct"], 50.0)
        self.assertEqual(report["type_pct"], 50.0)
        self.assertEqual(report["direction_always_neutral_pct"], 50.0)
        self.assertEqual(report["recall_2_3"], [2, 2])
        self.assertEqual(report["precision_2_3"], [2, 4])
        self.assertEqual(report["bearish_recall"], [2, 2])
        self.assertEqual(report["confusion_reference_to_rules"], {"0>2": 1, "1>2": 1, "2>2": 2})

    def test_an_empty_split_has_no_percentages_not_a_division_by_zero(self):
        report = ev.agreement([], fixed("other", 0, "neutral"))
        self.assertEqual((report["n"], report["strength_bucket_pct"], report["direction_pct"]), (0, None, None))

    def test_the_default_classifier_is_the_rules_engine(self):
        report = ev.agreement([row(1, "hack", 3, "bearish", "Binance hit by record $6.3 billion hack")])
        self.assertEqual((report["strength_exact_pct"], report["type_pct"]), (100.0, 100.0))

    def test_the_split_keeps_the_cut_in_the_test_side(self):
        rows = [row(ev.CORTE_MS - 1, "a", 0, "neutral"), row(ev.CORTE_MS, "a", 0, "neutral")]
        development, test = ev.split(rows)
        self.assertEqual((len(development), len(test)), (1, 1))
        self.assertEqual(ev.CORTE_MS, 1_794_009_600_000)  # 2026-11-07 00:00:00 UTC


class CliTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix=".reglas-eval-", dir=".")
        self.addCleanup(shutil.rmtree, self.dir)
        self.path = os.path.join(self.dir, "labels.jsonl")
        with open(self.path, "w") as handle:
            for item in (row(1, "hack", 3, "bearish", "Binance hit by record $6.3 billion hack"),
                         row(ev.CORTE_MS, "other", 0, "neutral", "Coinbase adds a dark mode toggle"),
                         {"title": "no label", "received_at": 1}):
                handle.write(json.dumps(item) + "\n")

    def run_main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = ev.main([self.path, *argv])
        return code, out.getvalue()

    def test_it_prints_both_splits_and_ignores_unlabelled_rows(self):
        code, out = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("lexicon noticias-reglas.v", out)
        self.assertIn("desarrollo: n=1", out)
        self.assertIn("prueba: n=1", out)

    def test_while_tuning_only_the_development_split_is_printed(self):
        code, out = self.run_main("--solo-desarrollo")
        self.assertEqual(code, 0)
        self.assertIn("desarrollo:", out)
        self.assertNotIn("prueba", out)

    def test_json_output_is_machine_readable(self):
        code, out = self.run_main("--json")
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual((data["desarrollo"]["n"], data["prueba"]["n"]), (1, 1))


if __name__ == "__main__":
    unittest.main()
