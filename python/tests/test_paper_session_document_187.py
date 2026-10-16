"""Issue #187 (BAL-DECISION-187-05): the document of blocks a session leaves for its readers. The committed JSON the TypeScript tests read is
what the real publisher emits now, and the document never claims what only a reader can measure (an age) or what only the session can do."""

import copy
import json
import unittest

from balancita_engine import paper_live_publish as PUB

import session_document_187 as GEN
import test_paper_runner as T


class TestCommittedDocuments(unittest.TestCase):
    def test_the_committed_file_is_what_the_publisher_emits(self):
        with open(GEN.TARGET, encoding="utf-8") as handle:
            committed = handle.read()
        self.assertEqual(committed, GEN.dumps(GEN.build()),
                         "stale fixture: run python3 python/tests/session_document_187.py and commit the result")

    def test_building_twice_gives_the_same_bytes(self):
        self.assertEqual(GEN.dumps(GEN.build()), GEN.dumps(GEN.build()))


class TestIntervalsCarryTheirOwnTime(unittest.TestCase):
    """The ``intervals`` array is not chronological (decided rows first, then signals without a decision): ``at_ms`` is the key a reader orders by."""

    def test_every_row_has_the_time_of_its_decision_or_of_its_signal(self):
        document = GEN.build()["operating_threshold_hypothesis"]
        rows = document["intervals"]["intervals"]
        self.assertGreaterEqual(len(rows), 2)
        for row in rows:
            self.assertIsNotNone(row["at_ms"])
            if row["decided_ms"] is not None:
                self.assertEqual(row["at_ms"], row["decided_ms"])
        self.assertTrue(any(r["decided_ms"] is None for r in rows), "a signal without decision is part of the case")


    def test_a_wait_before_a_decision_is_listed_after_it_but_its_time_is_earlier(self):
        rows = GEN.build()["intervals_wait_before_decision"]["intervals"]["intervals"]
        self.assertEqual([r["stages"]["signal"]["action"] for r in rows], ["BUY", "WAIT"])          # publisher order: decided rows first
        self.assertLess(rows[1]["at_ms"], rows[0]["at_ms"])                                          # but the WAIT happened first


class TestTheWriterClaimsNoAge(unittest.TestCase):
    """A document written by the process that holds the runner can say nothing about its own age: 0 by construction proves nothing."""

    def setUp(self):
        self.documents = GEN.build()

    def test_every_document_is_derived_and_without_authority(self):
        for name, doc in self.documents.items():
            with self.subTest(name):
                self.assertEqual(doc["schema"], PUB.BLOCKS_SCHEMA)
                self.assertIs(doc["derived"], True)
                self.assertEqual(doc["authority"], "none")

    def test_no_document_is_fresh_or_alive_and_none_is_verified(self):
        for name, doc in self.documents.items():
            with self.subTest(name):
                verification = doc["positions"]["verification"]
                self.assertEqual(verification["freshness"], "unknown")
                self.assertIn("report_age_unknown", verification["reasons"])
                self.assertFalse(verification["verified"])
                self.assertNotEqual(doc["status"]["liveness"], "alive")
                self.assertFalse(doc["status"]["funding"]["pnl_verified"])

    def test_a_running_session_waits_for_a_reader_to_measure_its_heartbeat(self):
        for name in ("operating_threshold_hypothesis", "operating_no_threshold"):
            with self.subTest(name):
                status = self.documents[name]["status"]
                self.assertEqual((status["phase"], status["liveness"]), ("LIVE", "unknown"))
                self.assertIn("heartbeat_age_unknown", status["reasons"])

    def test_the_limit_is_the_callers_and_is_never_approved(self):
        self.assertEqual(self.documents["operating_threshold_hypothesis"]["status"]["thresholds"],
                         {"heartbeat_max_age_ms": GEN.MAX_AGE_MS, "status": "hypothesis"})
        self.assertEqual(self.documents["operating_threshold_hypothesis"]["positions"]["verification"]["thresholds"],
                         {"report_max_age_ms": GEN.MAX_AGE_MS, "status": "hypothesis"})
        self.assertEqual(self.documents["operating_no_threshold"]["status"]["thresholds"],
                         {"heartbeat_max_age_ms": None, "status": "not_approved"})

    def test_a_session_that_ended_says_so_and_a_missing_heartbeat_is_unavailable(self):
        self.assertEqual(self.documents["stopped_orderly"]["status"]["phase"], "STOPPED")
        self.assertEqual(self.documents["halted_funding_diverged"]["status"]["phase"], "HALTED")
        self.assertIn("funding_book_diverged", self.documents["halted_funding_diverged"]["status"]["halt_reason"])
        self.assertEqual(self.documents["without_status"]["status"]["phase"], "unavailable")
        self.assertIsNone(self.documents["without_status"]["session_id"])

    def test_the_positions_and_the_intervals_are_the_publishers_own(self):
        doc = self.documents["operating_no_threshold"]
        self.assertEqual(doc["positions"]["schema"], PUB.POSITIONS_SCHEMA)
        self.assertEqual(doc["intervals"]["schema"], PUB.INTERVALS_SCHEMA)
        self.assertEqual([p["product_id"] for p in doc["positions"]["positions"]], [T.BTC])


class TestBuildingNeverChangesTheSession(unittest.TestCase):
    def test_the_document_carries_the_mark_of_the_run_that_wrote_it(self):
        documents = GEN.build()
        for name in ("operating_threshold_hypothesis", "operating_no_threshold", "stopped_orderly", "halted_funding_diverged"):
            self.assertEqual(documents[name]["run"], {"pid": GEN.RUN_PID, "id": GEN.RUN_ID}, name)
            self.assertTrue(documents[name]["session_id"] and documents[name]["config_digest"], name)
        self.assertEqual(documents["without_status"]["run"], {"pid": None, "id": None})      # no heartbeat, no run: the reader refuses it

    def test_the_runner_is_the_same_after_a_document_is_built(self):
        case = GEN._Case()
        case.setUp()
        try:
            runner = GEN._runner(case)
            before = (copy.deepcopy(runner.journal.entries), copy.deepcopy(runner.portfolio.snapshot()), runner.clock, runner.status)
            PUB.session_blocks(runner, None, max_age_ms=GEN.MAX_AGE_MS)
            after = (runner.journal.entries, runner.portfolio.snapshot(), runner.clock, runner.status)
            self.assertEqual(json.dumps(before, sort_keys=True, default=str), json.dumps(after, sort_keys=True, default=str))
        finally:
            case.doCleanups()


if __name__ == "__main__":
    unittest.main()
