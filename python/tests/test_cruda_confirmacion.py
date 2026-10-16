"""Issue #248, BAL-REV-183-DURABILIDAD-09: the reference derivation consumes CONFIRMED records only; the pending-consuming path is contrasted
and its divergences labelled. Standard library only; real SIGKILL. SYNTHETIC data. Logical confirmation only: physical durability is NOT tested."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

PYTHON_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, PYTHON_DIR)

from experimentos.cruda_parquet import archivo_a as A
from experimentos.cruda_parquet.confirmacion import compare_paths
from experimentos.cruda_parquet.corpus import CorpusConfig, generate
from experimentos.cruda_parquet.derivacion import derive_minutes

CONFIG = CorpusConfig(seed=248, max_records=900, max_size=8192)


def as_records(messages, epoch=1):
    return [A.Record(epoch, i + 1, m.received_at, m.source, m.endpoint, m.product, m.provider_time, m.provider_seq, m.raw) for i, m in enumerate(messages)]


class ComparePathsTests(unittest.TestCase):
    def test_no_loss_means_reproducible_from_the_archive(self):
        records = as_records(generate(CONFIG))
        result = compare_paths(records, records)
        self.assertTrue(result["reproducible_from_archive"])
        self.assertEqual((result["lost_pending"], result["consumed"], result["confirmed"]), (0, 900, 900))
        self.assertEqual(result["label"], "no divergence in this run")
        self.assertIn("not demonstrated", result["physical_durability"])

    def test_lost_pending_records_are_labelled_and_never_called_reproducible(self):
        records = as_records(generate(CONFIG))
        result = compare_paths(records, records[:700])
        self.assertFalse(result["reproducible_from_archive"])
        self.assertEqual(result["lost_pending"], 200)
        self.assertEqual((result["first_lost"], result["last_lost"]), ([1, 701], [1, 900]))
        self.assertIn("diverges", result["label"])
        self.assertFalse(result["derivations_equal"])

    def test_a_loss_that_changes_nothing_in_the_derivation_is_still_not_reproducible(self):
        records = as_records(generate(CONFIG))
        quiet = [r._replace(endpoint="ticker") for r in records]  # the derivation ignores tickers entirely
        result = compare_paths(quiet, quiet[:700])
        self.assertTrue(result["derivations_equal"])
        self.assertFalse(result["reproducible_from_archive"], "records were lost even though this derivation did not notice")

    def test_the_confirmed_prefix_is_a_prefix_and_the_reference_uses_only_it(self):
        records = as_records(generate(CONFIG))
        result = compare_paths(records, records[:300])
        self.assertEqual(derive_minutes(records[:300]), derive_minutes([r for r in records if r.arrival_no <= 300]))
        self.assertGreater(result["differing_minutes_count"], 0)
        self.assertLessEqual(len(result["differing_minutes_first"]), 5)

    def test_records_confirmed_but_never_consumed_are_reported(self):
        records = as_records(generate(CONFIG))
        result = compare_paths(records[:100], records[:150])
        self.assertEqual(result["confirmed_not_consumed"], 50)
        self.assertFalse(result["reproducible_from_archive"])


class RealKillContrastTests(unittest.TestCase):
    def test_a_real_sigkill_loses_exactly_the_unsealed_suffix(self):
        directory = tempfile.mkdtemp(prefix="cruda-conf-")
        self.addCleanup(shutil.rmtree, directory, True)
        count, kill_at, block = 900, 650, 100
        proc = subprocess.run([sys.executable, "-m", "experimentos.cruda_parquet.escritor_trabajo", directory, "248", str(count), "append", str(kill_at), str(block)],
                              capture_output=True, text=True, env=dict(os.environ, PYTHONPATH=PYTHON_DIR))
        self.assertLess(proc.returncode, 0, proc.stderr)
        A.recover(directory)
        confirmed = list(A.ArchiveReader(directory).records())
        consumed = as_records(list(generate(CorpusConfig(seed=248, max_records=count, max_size=8192)))[:kill_at])
        result = compare_paths(consumed, confirmed)
        self.assertEqual(len(confirmed), 600, "six sealed blocks of 100; the 50 pending ones are gone")
        self.assertEqual(result["lost_pending"], 50)
        self.assertEqual(result["first_lost"], [1, 601])
        self.assertFalse(result["reproducible_from_archive"])
        self.assertEqual(derive_minutes(confirmed), derive_minutes(consumed[:600]), "the reference is exactly the confirmed prefix")

    def test_confirmation_latency_and_count_are_measured_by_the_writer(self):
        directory = tempfile.mkdtemp(prefix="cruda-conf-")
        self.addCleanup(shutil.rmtree, directory, True)
        writer = A.ArchiveWriter(directory, block_records=100)
        for m in list(generate(CONFIG))[:250]:
            writer.append(m.source, m.endpoint, m.product, m.raw, m.provider_time, m.provider_seq, m.received_at)
        self.assertEqual((writer.stats.confirmed_records, writer.pending, writer.confirmed_through), (200, 50, (writer.epoch, 200)))
        writer.close()
        self.assertEqual((writer.stats.confirmed_records, writer.pending), (250, 0))
        self.assertGreater(writer.stats.confirm_latency_max, 0)
        self.assertLessEqual(writer.stats.confirm_latency_sum / 250, writer.stats.confirm_latency_max)


if __name__ == "__main__":
    unittest.main()
