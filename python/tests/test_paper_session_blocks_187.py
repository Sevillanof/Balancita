"""Issue #187: the committed JSON the TypeScript tests read is exactly what the real publisher emits now."""

import json
import unittest

import session_blocks_187 as GEN


class TestCommittedBlocks(unittest.TestCase):
    def test_the_committed_file_is_what_the_publisher_emits(self):
        with open(GEN.TARGET, encoding="utf-8") as handle:
            committed = handle.read()
        self.assertEqual(committed, GEN.dumps(GEN.build()),
                         "stale fixture: run python3 python/tests/session_blocks_187.py and commit the result")

    def test_building_twice_gives_the_same_bytes(self):
        self.assertEqual(GEN.dumps(GEN.build()), GEN.dumps(GEN.build()))

    def test_the_fixture_covers_the_cases_the_typescript_tests_rely_on(self):
        blocks = json.loads(GEN.dumps(GEN.build()))
        rows = {r["product_id"]: r for r in blocks["intervals"]["intervals"]}
        self.assertEqual([rows[p]["stages"]["signal"]["state"] for p in sorted(rows)], ["recorded", "recorded"])
        self.assertEqual(sorted(r["stages"]["decision"]["state"] for r in rows.values()), ["none", "recorded"])
        self.assertFalse(blocks["intervals_with_unverified_reference"]["contract"]["complete"])
        self.assertEqual(blocks["positions"]["verification"]["freshness"], "unknown")
        self.assertEqual(blocks["positions_threshold_approved"]["verification"]["freshness"], "fresh")


if __name__ == "__main__":
    unittest.main()
