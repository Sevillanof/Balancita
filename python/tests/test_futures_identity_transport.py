import io
import json
import unittest

from balancita_engine.futures_identity_transport import JobIdentityClient, IdentityTransportError


class IdentityTransportTests(unittest.TestCase):
    def setUp(self):
        self.binding = {"request_id": "r", "run_id": "run", "work_id": "w", "expected_state_version": 3, "checkpoint_hash": "a" * 64, "source_frontier": 9}

    def response(self, **updates):
        query = {"type": "identity_query", "protocol_version": 1, **self.binding, "query_sequence": 1, "operation": "lookup", "kind": "order", "keys": ["o1"], "from_ms": None, "to_ms": None, "knowledge_cutoff_ms": None}
        query.update(updates)
        return io.StringIO(json.dumps({**query, "type": "identity_reply", "status": "ok", "values": [None]}) + "\n")

    def test_returns_explicit_known_absence_and_emits_no_durable_update(self):
        output = io.StringIO()
        self.assertEqual(JobIdentityClient(self.response(), output, self.binding).query("order", ["o1"]), [None])
        self.assertEqual(json.loads(output.getvalue())["query_sequence"], 1)
        self.assertNotIn("update", output.getvalue())

    def test_rejects_foreign_job_and_replay_sequence(self):
        for changes in ({"work_id": "foreign"}, {"query_sequence": 0}):
            with self.subTest(changes=changes), self.assertRaises(IdentityTransportError):
                JobIdentityClient(self.response(**changes), io.StringIO(), self.binding).query("order", ["o1"])

    def test_unavailable_fails_closed(self):
        raw = json.loads(self.response().getvalue())
        raw["status"] = "unavailable"
        with self.assertRaises(IdentityTransportError):
            JobIdentityClient(io.StringIO(json.dumps(raw) + "\n"), io.StringIO(), self.binding).query("order", ["o1"])

    def test_funding_range_returns_bounded_typed_intervals(self):
        echo = {"type": "identity_reply", "protocol_version": 1, **self.binding, "query_sequence": 1,
                "knowledge_cutoff_ms": 20, "operation": "funding_range", "kind": "ledger_funding",
                "keys": [], "from_ms": 10, "to_ms": 20}
        raw = {**echo, "status": "ok", "values": [["funding-1", 10, 20, "0.001"]]}
        result = JobIdentityClient(io.StringIO(json.dumps(raw) + "\n"), io.StringIO(), self.binding).query(
            "ledger_funding", [], operation="funding_range", from_ms=10,
            to_ms=20, knowledge_cutoff_ms=20,
        )
        self.assertEqual(result, raw["values"])


if __name__ == "__main__":
    unittest.main()
