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

    def test_the_estimate_is_only_an_estimate_and_skips_what_cannot_fit(self):
        block = 8 * 1024 * 1024
        self.assertTrue(medir.estimate_fits(256 * 1024 * 1024, block))
        self.assertFalse(medir.estimate_fits(1_000_000 * 64 * 1024, block), "1M records x 64 KiB (the worst case) cannot fit")
        self.assertFalse(medir.estimate_fits(1024 ** 3, block))
        self.assertTrue(medir.estimate_fits(medir.DEFAULT_CAP // 2 - block, block))

    def test_ru_maxrss_unit_depends_on_the_platform(self):
        self.assertEqual(medir.rss_mib(2048 * 1024, "linux"), 2048.0)  # KiB on Linux
        self.assertEqual(medir.rss_mib(2048 * 1048576, "darwin"), 2048.0)  # bytes on macOS
        self.assertNotEqual(medir.rss_mib(2048 * 1048576, "linux"), medir.rss_mib(2048 * 1048576, "darwin"))
        import resource
        import sys
        measured = medir.rss_mib(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, sys.platform)
        self.assertTrue(5 < measured < 4096, "this process uses a plausible number of MiB on %s: %s" % (sys.platform, measured))

    def test_round_trip_comparison_fails_on_truncation_or_missing_records(self):
        messages = list(generate(CorpusConfig(seed=4, max_records=120)))
        self.assertTrue(medir.compare_streams(iter(messages), iter(messages))["equal"])
        self.assertFalse(medir.compare_streams(iter(messages), iter(messages[:-1]))["equal"], "a truncated stream (prefix) must fail")
        self.assertFalse(medir.compare_streams(iter(messages[:-1]), iter(messages))["equal"])
        cut = list(messages)
        cut[60] = cut[60]._replace(raw=cut[60].raw[:-1])
        result = medir.compare_streams(iter(messages), iter(cut))
        self.assertFalse(result["equal"])
        self.assertEqual((result["count_left"], result["count_right"], result["mismatches"]), (120, 120, 1))
        self.assertFalse(medir.compare_streams(iter(messages), iter(messages[:60] + messages[61:]))["equal"])

    def test_corpus_file_has_a_hard_cap(self):
        directory = tempfile.mkdtemp(prefix="cruda-medir-")
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, "corpus.bin")
        messages = list(generate(CorpusConfig(seed=3, max_records=300)))
        for cap in (0, 1000, 50_000, 10 ** 9):
            info = medir.write_corpus(path, iter(messages), max_file_bytes=cap)
            self.assertLessEqual(os.path.getsize(path), cap)
            self.assertEqual(os.path.getsize(path), info["file_bytes"])
        self.assertTrue(medir.write_corpus(path, iter(messages), max_file_bytes=1000)["stopped_by_file_cap"])

    def test_archive_stops_before_exceeding_the_hard_total(self):
        from experimentos.cruda_parquet import archivo_a as A
        directory = tempfile.mkdtemp(prefix="cruda-medir-")
        self.addCleanup(shutil.rmtree, directory, True)
        messages = list(generate(CorpusConfig(seed=9, max_records=600)))
        limit = 400_000
        writer = A.ArchiveWriter(os.path.join(directory, "a"), block_records=50, max_dir_bytes=limit, external_bytes=20_000)
        with self.assertRaises(A.BudgetExceeded):
            for m in messages:
                writer.append(m.source, m.endpoint, m.product, m.raw, m.provider_time, m.provider_seq, m.received_at)
            writer.close()
        self.assertLessEqual(20_000 + A.tree_bytes(os.path.join(directory, "a")), limit, "the files never pass the limit")
        self.assertGreater(writer.stats.sealed_blocks, 0)
        self.assertEqual(A.ArchiveReader(os.path.join(directory, "a")).verify()["blocks"], writer.stats.sealed_blocks)

    def test_orchestrator_refuses_nonpositive_arguments_and_big_steps(self):
        args = medir.parser().parse_args(["orquestar", "--registros-lista", "0", "-5", "--max-bytes", "1000"])
        steps = medir.orchestrate(args)["escalones"]
        self.assertEqual([("omitido" in s) for s in steps], [True, True])

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
        tiny = medir.parser().parse_args(["orquestar", "--registros-lista", "2000", "--max-bytes", "5000000", "--tope-bytes", "3000000",
                                          "--bloque-bytes", "1000000", "--bloque", "100"])
        result = medir.orchestrate(tiny)["escalones"][0]
        self.assertLessEqual(result.get("disco", {}).get("total_bytes", 0), 3_000_000, "the hard limit holds even when the estimate let it run")
        json.dumps(report)


if __name__ == "__main__":
    unittest.main()
