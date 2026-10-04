import json
import unittest
from pathlib import Path

from balancita_engine.canonical import canonical_json, canonical_hash, normalize_decimal


class CanonicalTests(unittest.TestCase):
    def test_shared_vectors(self):
        vectors = json.loads(Path("python/fixtures/futures-canonical-vectors.json").read_text())
        for vector in vectors:
            self.assertEqual(canonical_json(vector["value"]), vector["canonical"])
            self.assertEqual(canonical_hash(vector["value"]), vector["sha256"])

    def test_decimal_normalization_and_rejection(self):
        self.assertEqual(normalize_decimal("-0.000"), "0")
        self.assertEqual(normalize_decimal("1E+3"), "1000")
        with self.assertRaises(ValueError):
            normalize_decimal(1.0)

    def test_unpaired_surrogates_reject_and_valid_supplementary_text_hashes(self):
        invalid = json.loads(Path("python/fixtures/futures-canonical-invalid.json").read_text())
        with self.assertRaises(ValueError):
            canonical_json(invalid["unpaired"])
        vectors = json.loads(Path("python/fixtures/futures-canonical-vectors.json").read_text())
        supplementary = next(item for item in vectors if item["name"] == "unicode-order-and-supplementary")
        self.assertEqual(canonical_json(supplementary["value"]), supplementary["canonical"])
        self.assertEqual(canonical_hash(supplementary["value"]), supplementary["sha256"])

    def test_decimal_normalization_bounds_input_and_exponent(self):
        with self.assertRaises(ValueError):
            normalize_decimal("1" * 5000)
        with self.assertRaises(ValueError):
            normalize_decimal("1e10001")


if __name__ == "__main__":
    unittest.main()
