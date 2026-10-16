"""Issue #248, candidate A (blocks compressed with the standard library). SYNTHETIC data only; small on purpose (< 10 000 records) so CI stays
fast. The large measurements live in python/experimentos/cruda_parquet/medir.py, not here.

Covers: byte-exact round trip, duplicates / invalid kept and marked (never dropped), identity (epoch, arrival_no) after restarts, queries,
a real SIGKILL of a writer process at seeded points, partial blocks never promoted, and the causality of recovered data."""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, PYTHON_DIR)

from experimentos.cruda_parquet import archivo_a as A
from experimentos.cruda_parquet.corpus import CorpusConfig, Rng, generate
from experimentos.cruda_parquet.derivacion import derivation_hash, derive_minutes, state_as_of

CONFIG = CorpusConfig(seed=248, max_records=1500, max_size=8192)


def read(path):
    with open(path, "rb") as handle:
        return handle.read()


def put(path, data):
    with open(path, "wb") as handle:
        handle.write(data)


def write(directory, messages, **kw):
    writer = A.ArchiveWriter(directory, **kw)
    for m in messages:
        writer.append(m.source, m.endpoint, m.product, m.raw, m.provider_time, m.provider_seq, m.received_at)
    writer.close()
    return writer


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="cruda-a-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.messages = list(generate(CONFIG))

    def test_round_trip_is_byte_exact_for_both_codecs(self):
        for codec in ("zlib", "lzma"):
            directory = os.path.join(self.dir, codec)
            write(directory, self.messages, block_records=400, codec=codec)
            reader = A.ArchiveReader(directory)
            got = list(reader.records())
            self.assertEqual([r.raw for r in got], [m.raw for m in self.messages])
            self.assertEqual([(r.source, r.endpoint, r.product, r.provider_time, r.provider_seq, r.received_at) for r in got],
                             [(m.source, m.endpoint, m.product, m.provider_time, m.provider_seq, m.received_at) for m in self.messages])
            self.assertEqual(reader.verify(), {"blocks": len(reader.entries), "records": len(self.messages)})

    def test_nothing_is_dropped_duplicates_and_invalid_are_marked(self):
        write(self.dir, self.messages, block_records=500)
        reader = A.ArchiveReader(self.dir)
        marks = {}
        for _, _, kind in A.annotate(reader.records()):
            marks[kind] = marks.get(kind, 0) + 1
        for kind in ("duplicate_raw", "empty", "invalid_utf8", "invalid_json", "seq_regression"):
            self.assertGreater(marks.get(kind, 0), 0, kind)
        self.assertEqual(sum(1 for _ in reader.records()), len(self.messages))
        digests = [hashlib.sha256(r.raw).hexdigest() for r in reader.records()]
        self.assertGreater(len(digests) - len(set(digests)), 0, "duplicates stay in the archive")

    def test_identity_is_unique_across_restarts(self):
        first, second, third = self.messages[:300], self.messages[300:600], self.messages[600:900]
        for part in (first, second, third):
            write(self.dir, part, block_records=128)
        ids = [(r.epoch, r.arrival_no) for r in A.ArchiveReader(self.dir).records()]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(sorted({e for e, _ in ids}), [1, 2, 3])
        self.assertEqual(ids, sorted(ids), "arrival order is preserved across epochs")

    def test_queries_open_only_the_needed_blocks(self):
        write(self.dir, self.messages, block_records=100)
        reader = A.ArchiveReader(self.dir)
        opened = []
        original = reader._block
        reader._block = lambda entry: (opened.append(entry["block"]), original(entry))[1]
        low, high = self.messages[500].received_at, self.messages[560].received_at
        expected = [m.raw for m in self.messages if low <= m.received_at < high]
        self.assertEqual([r.raw for r in reader.query(low, high)], expected)
        self.assertLess(len(opened), len(reader.entries))
        target = reader.get(1, 777)
        self.assertEqual(target.raw, self.messages[776].raw)
        self.assertIsNone(reader.get(9, 1))
        product = [r for r in reader.query(0, 1 << 62, "PF_XBTUSD")]
        self.assertTrue(product and all(r.product == "PF_XBTUSD" for r in product))

    def test_tampered_confirmed_block_is_detected_and_reported(self):
        write(self.dir, self.messages[:300], block_records=100)
        victim = os.path.join(self.dir, "000002.blk")
        data = bytearray(read(victim))
        data[len(data) // 2] ^= 0x01
        put(victim, bytes(data))
        with self.assertRaises(ValueError):
            A.ArchiveReader(self.dir).verify()
        self.assertEqual(A.recover(self.dir)["confirmed_damaged"], ["000002.blk"])

    def test_missing_manifest_adopts_only_complete_blocks(self):
        write(self.dir, self.messages[:300], block_records=100)
        os.remove(os.path.join(self.dir, "manifest.jsonl"))
        truncated = os.path.join(self.dir, "000003.blk")
        data = read(truncated)
        put(truncated, data[: len(data) // 2])
        report = A.recover(self.dir)
        self.assertEqual(report["adopted"], ["000001.blk", "000002.blk"])
        self.assertEqual(report["partial"], ["000003.blk"])
        self.assertTrue(os.path.exists(truncated + ".partial"), "the partial block is kept as evidence")
        self.assertEqual(A.ArchiveReader(self.dir).verify()["records"], 200)
        self.assertTrue(all(e.get("adopted_after_crash") for e in A.ArchiveReader(self.dir).entries))

    def test_hand_truncated_tmp_is_never_read_as_valid(self):
        write(self.dir, self.messages[:200], block_records=100)
        data = A.build_block([A.Record(9, 1, 1, "ws", "trade", "", "", "", b"x")], "zlib")
        put(os.path.join(self.dir, "000003.blk.tmp"), data[:-5])
        self.assertEqual(A.ArchiveReader(self.dir).verify()["records"], 200)
        report = A.recover(self.dir)
        self.assertEqual(report["partial"], ["000003.blk.tmp"])
        self.assertEqual(A.ArchiveReader(self.dir).verify()["records"], 200)

    def test_parse_block_rejects_every_truncation(self):
        block = A.build_block([A.Record(1, i, 5, "ws", "trade", "P", "1", "2", bytes([i]) * 20) for i in range(1, 6)], "zlib")
        self.assertEqual(len(A.parse_block(block)), 5)
        for cut in range(0, len(block), max(1, len(block) // 25)):
            with self.assertRaises(ValueError):
                A.parse_block(block[:cut])

    def test_recovered_data_never_becomes_known_earlier(self):
        write(self.dir, self.messages, block_records=250)
        reader = A.ArchiveReader(self.dir)
        from_archive = derive_minutes(reader.records())
        from_corpus = derive_minutes(self.messages)
        self.assertEqual(derivation_hash(from_archive), derivation_hash(from_corpus))
        self.assertTrue(from_archive["recovered"], "the corpus holds recovered trades")
        for minute, value in from_archive["recovered"].items():
            self.assertGreaterEqual(value["known_first"], int(minute), "known_at is a local receipt time, after the event")
        late = [m for m in from_archive["recovered"] if from_archive["recovered"][m]["known_first"] >= int(m) + 60_000]
        self.assertTrue(late, "some recovered minutes arrive after they closed and stay marked with their late known_at")
        again = derive_minutes(A.ArchiveReader(self.dir).records())
        self.assertEqual(derivation_hash(again), derivation_hash(from_archive), "deterministic reconstruction")

    def test_replay_as_of_each_cut_matches_between_corpus_and_archive(self):
        """Bounded claim: at 25 cuts of ``received_at`` (arrival order) the state rebuilt from the archive equals the one from the corpus,
        and nothing received after a cut is visible in it. It does not enumerate every decision point."""
        write(self.dir, self.messages, block_records=250)
        archived = list(A.ArchiveReader(self.dir).records())
        received = [r.received_at for r in archived]
        self.assertEqual(received, sorted(received), "arrival order advances received_at")
        step = max(1, len(self.messages) // 25)
        for index in range(0, len(self.messages), step):
            cut = self.messages[index].received_at
            from_corpus, from_archive = state_as_of(self.messages, cut), state_as_of(archived, cut)
            self.assertEqual(derivation_hash(from_archive), derivation_hash(from_corpus), "cut %d" % cut)
            for series in ("live", "recovered"):
                for value in from_archive[series].values():
                    self.assertLessEqual(value["known_last"], cut, "nothing received after the cut is visible")
        self.assertEqual(derivation_hash(state_as_of(archived, received[-1])), derivation_hash(derive_minutes(archived)))
        first_recovered = next(r for r in archived if r.endpoint == "trade_snapshot")
        before = state_as_of(archived, first_recovered.received_at - 1)
        after = state_as_of(archived, first_recovered.received_at)
        self.assertLess(sum(v["count"] for v in before["recovered"].values()), sum(v["count"] for v in after["recovered"].values()))


class RealKillTests(unittest.TestCase):
    """A real SIGKILL of a writer process (D condition T1). What this does NOT prove: power loss, what the disk does on fsync."""

    POINTS = ("epoch_claim_start", "epoch_claim_created", "epoch_claim_durable", "append", "seal_half_written", "seal_tmp_written", "seal_renamed", "manifest_half_written", "manifest_confirmed")

    def run_worker(self, directory, seed, records, point, occurrence):
        env = dict(os.environ, PYTHONPATH=PYTHON_DIR)
        return subprocess.run([sys.executable, "-m", "experimentos.cruda_parquet.escritor_trabajo", directory, str(seed), str(records),
                               point, str(occurrence), "50"], env=env, capture_output=True, timeout=120).returncode

    def test_sigkill_at_seeded_points_never_promotes_a_partial_block(self):
        rng = Rng(248)
        seed, records = 11, 400
        full = list(generate(CorpusConfig(seed=seed, max_records=records, max_size=8192)))
        for point in self.POINTS:
            occurrence = 1 if point.startswith("epoch_claim") else 1 + rng.below(3 if point != "append" else 300)
            with self.subTest(point=point, occurrence=occurrence):
                directory = tempfile.mkdtemp(prefix="cruda-kill-")
                self.addCleanup(shutil.rmtree, directory, True)
                self.assertEqual(self.run_worker(directory, seed, records, point, occurrence), -9, "the worker must die by SIGKILL")
                report = A.recover(directory)
                self.assertEqual(report["confirmed_damaged"], [])
                reader = A.ArchiveReader(directory)
                got = list(reader.records())
                self.assertEqual(reader.verify()["records"], len(got))
                # what survived is exactly a prefix of the corpus, in arrival order, byte for byte
                self.assertEqual([r.raw for r in got], [m.raw for m in full[: len(got)]])
                self.assertEqual([r.arrival_no for r in got], list(range(1, len(got) + 1)))
                self.assertTrue(all(len(read(os.path.join(directory, n))) > 0 for n in os.listdir(directory) if n.endswith(".blk")))
                if point == "append":
                    self.assertLessEqual(len(got), occurrence - 1, "pending records are lost, never invented")
                # a restart takes a NEW epoch: numbers of the lost pending records are not reused
                writer = A.ArchiveWriter(directory, block_records=50)
                # a kill before the claim leaves no epoch claimed AND no record accepted, so epoch 1 is still free; otherwise epoch 2
                self.assertEqual(writer.epoch, 1 if point == "epoch_claim_start" else 2)
                writer.append("ws", "trade", "", b"after", "", "", 1)
                writer.close()
                ids = [(r.epoch, r.arrival_no) for r in A.ArchiveReader(directory).records()]
                self.assertEqual(len(ids), len(set(ids)))
                self.assertEqual(ids[-1], (writer.epoch, 1))

    def test_sigkill_while_claiming_the_epoch_never_reuses_an_identity_even_without_confirmed_blocks(self):
        for point in ("epoch_claim_start", "epoch_claim_created", "epoch_claim_durable"):
            with self.subTest(point=point):
                directory = tempfile.mkdtemp(prefix="cruda-kill-")
                self.addCleanup(shutil.rmtree, directory, True)
                # run A accepts records that are only pending (block of 50 never fills) and dies: epoch 1 was claimed, nothing confirmed
                self.assertEqual(self.run_worker(directory, 21, 400, "append", 7), -9)
                self.assertEqual(A.read_manifest(directory), [])
                self.assertEqual(A.last_epoch(directory), 1)
                # run B dies INSIDE the epoch claim; it accepted nothing
                self.assertEqual(self.run_worker(directory, 22, 400, point, 1), -9)
                self.assertEqual(A.read_manifest(directory), [])
                # run C: must not use epoch 1 (A's lost pending records had identities (1, 1..7))
                writer = write(directory, list(generate(CorpusConfig(seed=23, max_records=120, max_size=8192))), block_records=50)
                self.assertGreaterEqual(writer.epoch, 2)
                ids = [(r.epoch, r.arrival_no) for r in A.ArchiveReader(directory).records()]
                self.assertEqual(len(ids), len(set(ids)))
                self.assertTrue(all(e >= 2 for e, _ in ids), "no confirmed record carries the epoch of the dead writer A")
                self.assertTrue(os.path.exists(os.path.join(directory, "epoch-000001")))

    def test_a_killed_seal_is_adopted_only_when_the_block_is_complete(self):
        directory = tempfile.mkdtemp(prefix="cruda-kill-")
        self.addCleanup(shutil.rmtree, directory, True)
        self.assertEqual(self.run_worker(directory, 5, 400, "seal_renamed", 2), -9)
        before = A.read_manifest(directory)
        report = A.recover(directory)
        self.assertEqual(len(report["adopted"]), 1, "complete block, manifest line missing: adopted and marked")
        self.assertEqual(len(A.read_manifest(directory)), len(before) + 1)
        self.assertTrue(A.read_manifest(directory)[-1]["adopted_after_crash"])
        directory2 = tempfile.mkdtemp(prefix="cruda-kill-")
        self.addCleanup(shutil.rmtree, directory2, True)
        self.assertEqual(self.run_worker(directory2, 5, 400, "seal_half_written", 2), -9)
        report2 = A.recover(directory2)
        self.assertEqual((report2["adopted"], len(report2["partial"])), ([], 1), "a half-written block is evidence, not data")


if __name__ == "__main__":
    unittest.main()
