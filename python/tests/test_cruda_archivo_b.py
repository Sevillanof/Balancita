"""Issue #248, candidate B (Parquet keeping the original payload). Needs pyarrow (pinned, offline-only virtualenv, see
docs/experimento-cruda-248.md): without it every test here is SKIPPED, loudly, and CI (which does not install it) does not run them. D repeats
them locally before GO. SYNTHETIC data only; Parquet is compared by payload bytes, counts and hashes, never by file bytes."""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

PYTHON_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, PYTHON_DIR)

from experimentos.cruda_parquet import archivo_a as A
from experimentos.cruda_parquet import archivo_b as B
from experimentos.cruda_parquet.confirmacion import compare_paths
from experimentos.cruda_parquet.corpus import CorpusConfig, generate
from experimentos.cruda_parquet.derivacion import derive_minutes, derivation_hash
from experimentos.cruda_parquet.medir import compare_streams

CONFIG = CorpusConfig(seed=248, max_records=1200, max_size=8192)


def write(directory, messages, **kw):
    writer = A.ArchiveWriter(directory, fmt=B.FORMAT_B, **kw)
    for m in messages:
        writer.append(m.source, m.endpoint, m.product, m.raw, m.provider_time, m.provider_seq, m.received_at)
    writer.close()
    return writer


@unittest.skipUnless(B.available(), "pyarrow is not installed: candidate B tests skipped (run them from the pinned virtualenv)")
class ParquetArchiveTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="cruda-b-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.messages = list(generate(CONFIG))

    def test_round_trip_keeps_every_payload_and_field_for_every_codec(self):
        for codec in B.CODECS:
            directory = os.path.join(self.dir, codec)
            write(directory, self.messages, block_records=300, codec=codec)
            reader = A.ArchiveReader(directory, B.FORMAT_B)
            result = compare_streams(reader.records(), iter(self.messages))
            self.assertTrue(result["equal"], (codec, result))
            self.assertEqual(result["count_left"], len(self.messages))
            self.assertEqual(reader.verify(), {"blocks": len(reader.entries), "records": len(self.messages)})
            self.assertEqual({e["codec"] for e in reader.entries}, {codec})

    def test_a_and_b_hold_the_same_records_and_derive_the_same_minutes(self):
        write(os.path.join(self.dir, "b"), self.messages, block_records=300)
        wa = A.ArchiveWriter(os.path.join(self.dir, "a"), block_records=300)
        for m in self.messages:
            wa.append(m.source, m.endpoint, m.product, m.raw, m.provider_time, m.provider_seq, m.received_at)
        wa.close()
        ra, rb = list(A.ArchiveReader(os.path.join(self.dir, "a")).records()), list(A.ArchiveReader(os.path.join(self.dir, "b"), B.FORMAT_B).records())
        self.assertEqual(ra, rb, "identity, metadata and payload are identical between formats")
        self.assertEqual(derivation_hash(derive_minutes(ra)), derivation_hash(derive_minutes(rb)))

    def test_empty_oversized_and_invalid_payloads_survive(self):
        weird = [m for m in self.messages if not m.raw or len(m.raw) > 8000][:5] or self.messages[:5]
        extra = self.messages[:3]
        extra = [extra[0]._replace(raw=b""), extra[1]._replace(raw=b"\xff\xfe\x00{"), extra[2]._replace(raw=b"x" * 70000)]
        write(os.path.join(self.dir, "w"), weird + extra, block_records=4)
        got = list(A.ArchiveReader(os.path.join(self.dir, "w"), B.FORMAT_B).records())
        self.assertEqual([r.raw for r in got], [m.raw for m in weird + extra])

    def test_a_flipped_byte_or_a_truncation_is_never_read_as_valid(self):
        directory = os.path.join(self.dir, "t")
        write(directory, self.messages[:200], block_records=100)
        path = os.path.join(directory, "000001.blk")
        with open(path, "rb") as handle:
            data = handle.read()
        for cut in (0, 4, len(data) // 2, len(data) - 1):
            with self.assertRaises(Exception):
                B.parse_block(data[:cut])
        # the manifest hash catches ANY changed byte, including ones Parquet would decode
        flipped = bytearray(data)
        flipped[len(flipped) // 3] ^= 0x01
        with open(path, "wb") as handle:
            handle.write(bytes(flipped))
        with self.assertRaises(ValueError):
            A.ArchiveReader(directory, B.FORMAT_B).verify()
        with self.assertRaises(A.ArchiveDamaged):
            A.ArchiveWriter(directory, fmt=B.FORMAT_B)

    def test_recovery_adopts_a_complete_parquet_orphan_and_parks_a_partial_one(self):
        directory = os.path.join(self.dir, "r")
        write(directory, self.messages[:200], block_records=100)
        os.remove(os.path.join(directory, "manifest.jsonl"))
        report = A.recover(directory, B.FORMAT_B)
        self.assertEqual(sorted(report["adopted"]), ["000001.blk", "000002.blk"])
        self.assertTrue(all(e.get("adopted_after_crash") for e in A.read_manifest(directory)))
        with open(os.path.join(directory, "000002.blk"), "rb") as handle:
            data = handle.read()
        os.remove(os.path.join(directory, "manifest.jsonl"))
        with open(os.path.join(directory, "000002.blk"), "wb") as handle:
            handle.write(data[: len(data) // 2])
        report = A.recover(directory, B.FORMAT_B)
        self.assertEqual((report["adopted"], report["partial"]), (["000001.blk"], ["000002.blk"]))
        self.assertTrue(os.path.exists(os.path.join(directory, "000002.blk.partial")))

    def test_real_sigkill_at_every_point_never_promotes_a_partial_block(self):
        for point in ("append", "seal_half_written", "seal_tmp_written", "seal_renamed", "manifest_half_written", "manifest_confirmed"):
            directory = os.path.join(self.dir, "k-" + point)
            proc = subprocess.run([sys.executable, "-m", "experimentos.cruda_parquet.escritor_trabajo", directory, "248", "600", point, "2", "100", "B", "zstd"],
                                  capture_output=True, text=True, env=dict(os.environ, PYTHONPATH=PYTHON_DIR))
            self.assertLess(proc.returncode, 0, (point, proc.stderr))
            report = A.recover(directory, B.FORMAT_B)
            reader = A.ArchiveReader(directory, B.FORMAT_B)
            ids = [(r.epoch, r.arrival_no) for r in reader.records()]
            self.assertEqual(ids, sorted(set(ids)), point)
            self.assertEqual(report["confirmed_damaged"], [], point)
            reader.verify()
            again = A.ArchiveWriter(directory, block_records=100, fmt=B.FORMAT_B)
            self.assertGreater(again.epoch, 1, "a restart takes a NEW epoch")

    def test_pending_consumption_is_contrasted_with_the_confirmed_reference_for_b_too(self):
        directory = os.path.join(self.dir, "c")
        proc = subprocess.run([sys.executable, "-m", "experimentos.cruda_parquet.escritor_trabajo", directory, "248", "900", "append", "650", "100", "B", "zstd"],
                              capture_output=True, text=True, env=dict(os.environ, PYTHONPATH=PYTHON_DIR))
        self.assertLess(proc.returncode, 0, proc.stderr)
        A.recover(directory, B.FORMAT_B)
        confirmed = list(A.ArchiveReader(directory, B.FORMAT_B).records())
        consumed = [A.Record(1, i + 1, m.received_at, m.source, m.endpoint, m.product, m.provider_time, m.provider_seq, m.raw)
                    for i, m in enumerate(list(generate(CorpusConfig(seed=248, max_records=900, max_size=8192)))[:650])]
        result = compare_paths(consumed, confirmed)
        self.assertEqual((len(confirmed), result["lost_pending"], result["reproducible_from_archive"]), (600, 50, False))

    def test_the_page_hash_column_matches_the_payload(self):
        directory = os.path.join(self.dir, "h")
        write(directory, self.messages[:50], block_records=50)
        import io
        with open(os.path.join(directory, "000001.blk"), "rb") as handle:
            table = B.pq.read_table(io.BytesIO(handle.read()))
        for raw, digest in zip(table.column("raw_bytes").to_pylist(), table.column("raw_sha256").to_pylist()):
            self.assertEqual(hashlib.sha256(raw).hexdigest(), digest)


class WithoutPyarrowTests(unittest.TestCase):
    def test_module_imports_and_fails_clearly_without_the_dependency(self):
        if B.available():
            self.skipTest("pyarrow is installed here")
        with self.assertRaises(B.ParquetUnavailable):
            B.build_block([], "zstd")


if __name__ == "__main__":
    unittest.main()
