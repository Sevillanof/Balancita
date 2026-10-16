"""Issue #248: the synthetic corpus is deterministic (same seed -> same bytes) on every Python version, bounded in bytes and covers every kind
of message the experiment needs. Synthetic data only."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from experimentos.cruda_parquet.corpus import CorpusConfig, Rng, corpus_hash, extract_meta, generate, iso_text, size_summary

CONFIG = CorpusConfig(seed=248, max_records=2000)
# Pinned: it must be identical on Python 3.9, 3.12 and 3.13 (checked with ``uv run --python``).
PINNED = ("b3084dd64c074dfc998f89b44ad47821f31a9ff8f833a728a74beefed9af861a", 2000)


class CorpusTests(unittest.TestCase):
    def test_same_seed_same_bytes_and_other_seed_differs(self):
        first, second = list(generate(CONFIG)), list(generate(CONFIG))
        self.assertEqual(first, second)
        self.assertEqual(corpus_hash(first), corpus_hash(second))
        self.assertNotEqual(corpus_hash(first)[0], corpus_hash(generate(CONFIG._replace(seed=249)))[0])

    def test_hash_is_pinned_for_every_python_version(self):
        digest, count, _ = corpus_hash(generate(CONFIG))
        self.assertEqual(count, PINNED[1])
        self.assertEqual(digest, PINNED[0])

    def test_rng_is_splitmix64(self):
        self.assertEqual(Rng(0).u64(), 0xE220A8397B1DCDAF)
        one, two = Rng(7), Rng(7)
        self.assertEqual([one.below(10) for _ in range(20)], [two.below(10) for _ in range(20)])

    def test_every_kind_is_present(self):
        messages = list(generate(CONFIG))
        endpoints = {m.endpoint for m in messages}
        for kind in ("trade", "ticker", "trade_snapshot", "tickers", "historical-funding-rates", "invalid", "heartbeat"):
            self.assertIn(kind, endpoints)
        raws = [m.raw for m in messages]
        self.assertTrue(any(raw == b"" for raw in raws), "empty message")
        self.assertTrue(any(not _utf8(raw) for raw in raws), "non-UTF-8 message")
        self.assertTrue(any(raws.count(raw) > 1 for raw in raws if raw), "exact duplicate")
        self.assertTrue(any(m.source == "rest" for m in messages))
        self.assertTrue(any(len(m.raw) > CONFIG.max_size for m in messages), "oversized message ABOVE max_size")

    def test_trade_sequence_is_not_monotonic(self):
        seqs = [int(m.provider_seq) for m in generate(CONFIG) if m.endpoint == "trade" and m.provider_seq.isdigit()]
        self.assertTrue(any(b <= a for a, b in zip(seqs, seqs[1:])), "out-of-order sequence numbers expected")

    def test_timestamp_forms_cover_fraction_widths(self):
        rng = Rng(1)
        texts = [iso_text(1_791_000_000_000, form, rng) for form in range(6)]
        widths = set()
        for text in texts:
            core = text.split("+")[0].rstrip("Z")
            widths.add(len(core.split(".")[1]) if "." in core else 0)
        self.assertEqual(widths, {0, 2, 3, 6, 9})
        self.assertTrue(texts[0].startswith("2026-10-"))
        self.assertTrue(texts[5].endswith("+00:00"))

    def test_corpus_is_bounded_in_bytes_not_only_in_records(self):
        capped = list(generate(CONFIG._replace(max_records=100_000, max_corpus_bytes=200_000)))
        self.assertLessEqual(sum(len(m.raw) for m in capped), 200_000)
        self.assertGreater(len(capped), 10)

    def test_size_distribution_is_declared(self):
        summary = size_summary(generate(CONFIG))
        self.assertEqual(summary["n"], 2000)
        self.assertGreater(summary["max"], CONFIG.max_size)
        self.assertLessEqual(summary["max"], CONFIG.max_size + 1024)
        self.assertGreater(summary["p99"], summary["p50"])

    def test_extract_meta_never_raises(self):
        for raw in [b"", b"\xff\xfe", b"[", b"null", b"[1]", b'{"seq": {}}', b'{"seq": true}', b'{"time": 1.5}', b"\x00" * 10]:
            self.assertEqual(len(extract_meta(raw)), 3)
        for m in generate(CONFIG):
            extract_meta(m.raw)
        self.assertEqual(extract_meta(b'{"product_id":"PF_XBTUSD","seq":12,"time":99}'), ("PF_XBTUSD", "99", "12"))

    def test_no_real_or_secret_looking_content(self):
        for m in generate(CONFIG._replace(max_records=300)):
            low = m.raw.lower()
            self.assertNotIn(b"api_key", low)
            self.assertNotIn(b"secret", low)


def _utf8(raw):
    try:
        raw.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


if __name__ == "__main__":
    unittest.main()
