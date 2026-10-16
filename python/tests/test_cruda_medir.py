"""Issue #248: the measurement helpers (not the large measurements, which never run in CI). Synthetic data only."""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from experimentos.cruda_parquet import medir
from experimentos.cruda_parquet.corpus import CorpusConfig, corpus_hash, generate


class MeasureHelpersTests(unittest.TestCase):
    def test_corpus_file_round_trip_keeps_every_field(self):
        directory = tempfile.mkdtemp(prefix="cruda-medir-")
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, "corpus.bin")
        messages = list(generate(CorpusConfig(seed=3, max_records=300)))
        info = medir.write_corpus(path, messages)
        self.assertEqual(info["records"], 300)
        self.assertEqual(list(medir.read_corpus(path)), messages)
        self.assertEqual(corpus_hash(medir.read_corpus(path)), corpus_hash(messages))

    def test_a_step_that_does_not_fit_in_two_gib_is_skipped(self):
        block = 8 * 1024 * 1024
        self.assertTrue(medir.fits(256 * 1024 * 1024, block))
        self.assertFalse(medir.fits(1_000_000 * 64 * 1024, block), "1M records x 64 KiB (the worst case) cannot fit")
        self.assertFalse(medir.fits(1024 ** 3, block))
        self.assertTrue(medir.fits(medir.DEFAULT_CAP // 2 - block, block))

    def test_orchestrator_runs_each_phase_in_its_own_process_and_skips_the_big_step(self):
        args = medir.parser().parse_args(["orquestar", "--registros-lista", "300", "--max-bytes", "400000", "--bloque", "100"])
        report = medir.orchestrate(args)
        step = report["escalones"][0]
        for phase in ("generar", "escribir", "consultar", "reconstruir"):
            self.assertEqual(step[phase]["returncode"], 0, step[phase])
            self.assertGreater(step[phase]["peak_rss_mib"], 0)
        self.assertTrue(step["reconstruir"]["detalle"]["byte_exact_round_trip"])
        self.assertTrue(step["reconstruir"]["detalle"]["equals_corpus"])
        big = medir.parser().parse_args(["orquestar", "--registros-lista", "1000000", "--max-bytes", "68719476736"])
        self.assertIn("omitido", medir.orchestrate(big)["escalones"][0])
        json.dumps(report)


if __name__ == "__main__":
    unittest.main()
