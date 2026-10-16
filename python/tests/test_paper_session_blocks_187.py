"""Issue #187: the committed JSON the TypeScript tests read is exactly what the real publisher emits now."""

import json
import unittest

import session_blocks_187 as GEN
import session_status_blocks_187 as STATUS


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


class TestCommittedStatusBlocks(unittest.TestCase):
    def test_the_committed_file_is_what_the_publisher_emits(self):
        with open(STATUS.TARGET, encoding="utf-8") as handle:
            committed = handle.read()
        self.assertEqual(committed, STATUS.dumps(STATUS.build()),
                         "stale fixture: run python3 python/tests/session_status_blocks_187.py and commit the result")

    def test_the_fixture_covers_the_cases_the_typescript_tests_rely_on(self):
        blocks = json.loads(STATUS.dumps(STATUS.build()))
        self.assertEqual({k: (b["phase"], b["liveness"]) for k, b in blocks.items()}, {
            "warming_up": ("WARMING_UP", "unknown"),
            "live_threshold_hypothesis": ("LIVE", "unknown"),
            "live_alive_threshold_approved": ("LIVE", "alive"),
            "live_heartbeat_stale": ("unverified", "stale"),
            "stopped_orderly": ("STOPPED", "final"),
            "halted_funding_diverged": ("HALTED", "final"),
            "unavailable": ("unavailable", "unknown"),
        })
        self.assertTrue(all(not b["funding"]["pnl_verified"] for b in blocks.values()))


if __name__ == "__main__":
    unittest.main()
