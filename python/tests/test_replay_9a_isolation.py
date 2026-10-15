"""Stage 9A funding isolation: adversarial cases on the bytes delivered to the incremental reader and the periods decoded.
Invented data in temporary databases; no real database and no reserved period is read."""

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from unittest import mock

from balancita_engine import replay_data as RD
from balancita_engine import replay_driver as RP

try:
    from .test_replay_9a import BTC, HOUR, make_db
except ImportError:                                   # run as a top-level module
    from test_replay_9a import BTC, HOUR, make_db

CAP = RD.HI_EXCL_MS
LIMIT = CAP - RD.FUNDING_MARGIN_MS


def stamp(ms):
    return "{}.000Z".format(RP.iso(ms)[:-1])


def rate(ms):
    return {"timestamp": stamp(ms), "fundingRate": "0.5", "relativeFundingRate": "0.0000{}".format((ms // HOUR) % 10 + 1)}


class Isolation(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def db(self, raw):
        """A database whose stored funding response is exactly ``raw`` (text)."""
        path = os.path.join(self.dir, "m.sqlite")
        if os.path.exists(path):
            os.remove(path)
        make_db(path, start_ms=LIMIT - 30 * HOUR, end_ms=LIMIT - 29 * HOUR)
        con = sqlite3.connect(path)
        con.execute("UPDATE paper_futures_funding_responses SET raw_response=?", (raw,))
        con.commit()
        con.close()
        return path

    def read(self, raw, lo=LIMIT - 30 * HOUR, hi=LIMIT, backend=None):
        path = self.db(raw)
        gate = RD.ReplayDataGate(path, lo, hi)
        gate.blob_backend = backend
        try:
            got = gate.relative_funding(BTC)
            return got, [s for s in gate.statements if s["name"] == "funding_stream"][0], path
        finally:
            gate.close()

    @staticmethod
    def doc(starts, tail=""):
        text = json.dumps({"rates": [rate(s) for s in starts]})
        return text[:-2] + tail + "]}" if tail else text

    def delivered(self, path, trail):
        con = sqlite3.connect(path)
        raw = con.execute("SELECT raw_response FROM paper_futures_funding_responses").fetchone()[0].encode()
        con.close()
        return raw[:trail["max_offset_excl"]].decode("utf-8", "replace")

    def delivered_bytes(self, path, trail):
        con = sqlite3.connect(path)
        raw = con.execute("SELECT raw_response FROM paper_futures_funding_responses").fetchone()[0].encode()
        con.close()
        return raw[:trail["max_offset_excl"]]

    def assert_clean(self, path, entry):
        trail = entry["responses"][0]
        self.assertTrue(trail["contiguous_from_zero"])
        self.assertEqual(trail["requested_bytes"], trail["received_bytes"])
        self.assertFalse(trail["read_whole_value"])
        self.assertTrue(entry["reader"].startswith(("sqlite3_blob", "blobopen")))
        prefix = self.delivered(path, trail)
        reserved = [h for h in range(0, 400) if stamp(CAP + h * HOUR) in prefix]
        self.assertEqual(reserved, [], "a reserved period was delivered to the reader")
        self.assertLess(trail["max_decoded_period_ms"], CAP)
        delivered = self.delivered_bytes(path, trail)
        self.assertEqual(hashlib.sha256(delivered).hexdigest(), trail["delivered_sha256"])
        self.assertLess(trail["max_timestamp_in_delivered_bytes"], "2026-08-02T00:00:00")

    # ---- the cases ----------------------------------------------------------------------------------------------------
    def test_consecutive_hours_and_the_first_forbidden_one_right_after_the_last_allowed(self):
        starts = [LIMIT - 30 * HOUR + i * HOUR for i in range(30 + 400)]
        got, entry, path = self.read(self.doc(starts))
        self.assertEqual(got[-1][0], LIMIT - HOUR)
        trail = entry["responses"][0]
        self.assertEqual((trail["stopped_at_ms"], trail["stop_reason"]), (LIMIT, "first_period_at_or_after_local_limit"))
        self.assertEqual(trail["local_limit_ms"], LIMIT)
        self.assert_clean(path, entry)

    def test_missing_hours_are_not_filled_and_the_stop_is_the_same(self):
        starts = [s for s in (LIMIT - 30 * HOUR + i * HOUR for i in range(30 + 400)) if s not in (LIMIT - 5 * HOUR, LIMIT - 4 * HOUR)]
        got, entry, path = self.read(self.doc(starts))
        self.assertNotIn(LIMIT - 5 * HOUR, [s for s, _ in got])
        self.assertEqual(entry["responses"][0]["stopped_at_ms"], LIMIT)
        self.assert_clean(path, entry)

    def test_a_long_jump_over_the_limit_stops_at_the_first_period_after_it(self):
        starts = [LIMIT - 30 * HOUR + i * HOUR for i in range(25)] + [LIMIT + 5 * HOUR] + [LIMIT + 40 * HOUR + i * HOUR for i in range(50)]
        got, entry, path = self.read(self.doc(starts))
        self.assertEqual(entry["responses"][0]["stopped_at_ms"], LIMIT + 5 * HOUR)
        self.assertEqual(got[-1][0], LIMIT - 6 * HOUR)
        self.assert_clean(path, entry)

    def test_a_jump_whose_next_period_is_reserved_and_arrives_in_the_same_block_fails_explicitly(self):
        starts = [LIMIT - 30 * HOUR + i * HOUR for i in range(25)] + [LIMIT + 5 * HOUR] + [LIMIT + 600 * HOUR + i * HOUR for i in range(50)]
        with self.assertRaises(RD.DataError) as caught:
            self.read(self.doc(starts))
        self.assertIn("isolation guarantee", str(caught.exception))

    def test_a_reserved_timestamp_cut_at_the_edge_of_the_last_block_is_never_let_through(self):
        # D-9A-26: for every alignment of the block edge, the run either aborts or the delivered bytes hold no reserved prefix
        outcomes = {"aborted": 0, "passed": 0}
        for pad in range(0, 560, 5):
            first = rate(LIMIT - 30 * HOUR)
            first["fundingRate"] = "0." + "5" * pad
            records = [first] + [rate(LIMIT - 29 * HOUR + i * HOUR) for i in range(29)] + [rate(LIMIT), rate(CAP + 5 * HOUR)]
            raw = json.dumps({"rates": records})
            try:
                got, entry, path = self.read(raw)
            except RD.DataError:
                outcomes["aborted"] += 1
                continue
            outcomes["passed"] += 1
            self.assertNotIn("2026-08", self.delivered(path, entry["responses"][0]), pad)
        self.assertGreater(outcomes["aborted"], 0)

    def test_a_period_whose_first_key_is_not_the_timestamp_is_refused(self):
        records = [rate(LIMIT - 30 * HOUR + i * HOUR) for i in range(30)] + [rate(LIMIT + i * HOUR) for i in range(40)]
        records[3] = {"relativeFundingRate": "0.00001", "timestamp": records[3]["timestamp"]}
        with self.assertRaises(RD.DataError):
            self.read(json.dumps({"rates": records}))

    def test_a_jump_straight_into_the_reserved_period_fails_explicitly(self):
        starts = [LIMIT - 30 * HOUR + i * HOUR for i in range(25)] + [CAP + 3 * HOUR, CAP + 4 * HOUR]
        with self.assertRaises(RD.DataError) as caught:
            self.read(self.doc(starts))
        self.assertIn("isolation guarantee", str(caught.exception))

    def test_a_truncated_response_after_the_cut_is_read_the_same(self):
        starts = [LIMIT - 30 * HOUR + i * HOUR for i in range(30 + 400)]
        full = self.doc(starts)
        cut = full[:full.index(stamp(LIMIT + 50 * HOUR))]                 # ends in the middle of the array, long after the limit
        expected, _, _ = self.read(full)
        got, entry, path = self.read(cut)
        self.assertEqual(got, expected)
        self.assertEqual(entry["responses"][0]["stopped_at_ms"], LIMIT)
        self.assert_clean(path, entry)

    def test_a_response_truncated_before_the_limit_fails_explicitly(self):
        starts = [LIMIT - 30 * HOUR + i * HOUR for i in range(30)]
        full = self.doc(starts)
        with self.assertRaises(RD.DataError):
            self.read(full[:full.index(stamp(LIMIT - 3 * HOUR))])

    def test_malformed_json_after_the_cut_is_never_read(self):
        starts = [LIMIT - 30 * HOUR + i * HOUR for i in range(30)] + [LIMIT + i * HOUR for i in range(5)]
        base = self.doc(starts)
        garbage = base[:-2] + ", THIS IS NOT JSON {{{{ " + "é" * 2000 + "]}"
        expected, _, _ = self.read(base)
        got, entry, path = self.read(garbage)
        self.assertEqual(got, expected)
        self.assert_clean(path, entry)

    def test_a_response_out_of_order_before_the_cut_fails_after_the_cut_it_is_not_seen(self):
        before = [LIMIT - 30 * HOUR + i * HOUR for i in range(30)]
        with self.assertRaises(RD.DataError):
            self.read(self.doc(before[:10] + [before[8]] + before[10:]))
        after = before + [LIMIT + 10 * HOUR, LIMIT + 2 * HOUR, LIMIT + 1 * HOUR] + [LIMIT + 20 * HOUR + i * HOUR for i in range(600)]   # disorder only past the stop
        got, entry, path = self.read(self.doc(after))
        self.assertEqual(entry["responses"][0]["stopped_at_ms"], LIMIT + 10 * HOUR)
        self.assert_clean(path, entry)

    def test_overflow_pages_after_the_cut_are_not_touched(self):
        starts = [LIMIT - 30 * HOUR + i * HOUR for i in range(30)] + [LIMIT + i * HOUR for i in range(3000)]
        got, entry, path = self.read(self.doc(starts))
        trail = entry["responses"][0]
        self.assertGreater(trail["bytes_stored"], 50 * trail["bytes_read"])        # a large BLOB read only at its start
        self.assert_clean(path, entry)

    def test_the_trace_is_auditable_and_reproducible(self):
        starts = [LIMIT - 30 * HOUR + i * HOUR for i in range(30 + 100)]
        _, one, _ = self.read(self.doc(starts))
        _, two, _ = self.read(self.doc(starts))
        trail = one["responses"][0]
        for key in ("source", "sha256", "bytes_read", "bytes_stored", "stopped_at_ms", "stop_reason", "local_limit_ms", "read_count",
                    "first_read", "last_read", "max_offset_excl", "requested_bytes", "received_bytes", "reads_sha256",
                    "periods_decoded", "max_decoded_period_ms"):
            self.assertIn(key, trail)
        self.assertEqual(trail["first_read"][0], 0)
        self.assertEqual(trail["reads_sha256"], two["responses"][0]["reads_sha256"])
        self.assertEqual(trail["delivered_sha256"], two["responses"][0]["delivered_sha256"])
        self.assertEqual(trail["read_count"] * RD.ReplayDataGate.CHUNK >= trail["bytes_read"], True)

    def test_without_incremental_io_it_fails_instead_of_reading_the_whole_value(self):
        path = self.db(self.doc([LIMIT - 30 * HOUR + i * HOUR for i in range(30)]))
        gate = RD.ReplayDataGate(path, LIMIT - 30 * HOUR, LIMIT)
        gate.blob_backend = "ctypes"
        with mock.patch("ctypes.util.find_library", return_value=None):
            with self.assertRaises(RD.DataError):
                gate.relative_funding(BTC)
        gate.close()

    def test_a_local_limit_past_the_margin_is_refused_before_the_file_is_read(self):
        path = self.db(self.doc([LIMIT - 30 * HOUR]))
        gate = RD.ReplayDataGate(path, LIMIT - 30 * HOUR, LIMIT + HOUR)
        with self.assertRaises(RD.RangeGateError):
            gate.relative_funding(BTC)
        gate.close()


if __name__ == "__main__":
    unittest.main()
