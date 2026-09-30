import unittest
import json
from pathlib import Path

from balancita_replay import run_replay


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.bars = [
            {"time": 3_600_000, "open": 100, "close": 101},
            {"time": 7_200_000, "open": 110, "close": 112},
            {"time": 10_800_000, "open": 120, "close": 121},
        ]
        self.signals = [
            {"time": 3_600_000, "probabilityUp": 0.8,
             "probabilityDown": 0.1, "abstained": False}
        ]
        self.options = {
            "bars": self.bars,
            "signals": self.signals,
            "sourceIntervalMs": 3_600_000,
            "cutoffMs": 10_800_000,
            "scanTimeMs": 10_800_000,
            "maxAgeMs": 3_600_000,
            "strategyId": "fixture-long-flat-v1",
            "configId": "fixture-config-v1",
        }

    def test_closed_bar_decision_fills_next_open_and_audits_identity(self):
        result = run_replay(self.options)
        self.assertEqual(result["status"], "replayed")
        self.assertEqual(result["ledger"]["fills"][0]["time"], 7_200_000)
        self.assertAlmostEqual(result["ledger"]["fills"][0]["price"], 110.055)
        self.assertEqual(result["strategyId"], "fixture-long-flat-v1")
        self.assertEqual(result["costIdentity"]["commissionRate"], 0.001)
        self.assertEqual(result["inputWindow"]["cutoffMs"], 10_800_000)

    def test_no_new_closed_bar_is_idempotent_and_stale_is_distinct(self):
        first = run_replay(self.options)
        no_new = dict(self.options, scanTimeMs=11_700_000)
        second = run_replay(no_new)
        self.assertEqual(second["status"], "no_new_closed_bar")
        self.assertEqual(second["ledger"], first["ledger"])
        stale = dict(self.options, scanTimeMs=18_000_000)
        self.assertEqual(run_replay(stale)["status"], "stale")

    def test_cutoff_excludes_unclosed_bar_and_reports_gaps(self):
        options = dict(self.options, cutoffMs=10_800_000, scanTimeMs=10_800_000)
        options["bars"] = [
            self.bars[0],
            self.bars[2],
            {"time": 14_400_000, "open": 130, "close": 131},
        ]
        options["signals"] = self.signals + [{
            "time": 14_400_000,
            "probabilityUp": 0.99,
            "probabilityDown": 0.01,
            "abstained": False,
            "directTarget": "long",
        }]
        result = run_replay(options)
        self.assertEqual(result["status"], "replayed")
        self.assertEqual(result["inputWindow"]["barCount"], 2)
        self.assertEqual(result["inputWindow"]["barTimesMs"], [3_600_000, 10_800_000])
        self.assertNotIn(14_400_000, [item["value"] for item in result["sourceTimestamps"]])
        self.assertNotIn(14_400_000, [item["value"] for item in result["signalTimestampProvenance"]])
        self.assertNotIn(14_400_000, [item["time"] for item in result["decisionInputs"]])
        self.assertNotIn(14_400_000, [item["time"] for item in result["ledger"]["equityCurve"]])
        self.assertEqual(result["gaps"], [7_200_000])

    def test_fastreplay_seconds_conversion_occurs_once_and_keeps_provenance(self):
        options = dict(self.options, bars=[
            {"time": 3600, "open": 100, "close": 101},
            {"time": 7200, "open": 110, "close": 112},
        ], signals=[], timestampUnit="seconds", cutoffMs=7_200_000,
            scanTimeMs=7_200_000)
        result = run_replay(options)
        self.assertEqual(result["sourceTimestamps"][0], {"value": 3600, "unit": "seconds"})
        self.assertEqual(result["inputWindow"]["barTimesMs"], [3_600_000, 7_200_000])
        self.assertEqual(result["comparator"]["status"], "not_comparable")

    def test_shared_frozen_candles_map_closed_intervals_to_python_close_labels(self):
        fixture = json.loads((Path(__file__).parents[1] / "fixtures" / "shared-time-contract.json").read_text())
        source = fixture["candles"]
        expected = fixture["expected"]

        def aggregate(rows, interval):
            start, end = interval["startSeconds"], interval["endSeconds"]
            if start % 900 != 0 or end - start != 900:
                raise ValueError("canonical interval must be UTC-aligned and exactly 900 seconds")
            if cutoff_seconds is not None and cutoff_seconds < end:
                return None
            members = [(index, row) for index, row in enumerate(rows) if start <= row[0] < end]
            values = [row for _, row in members]
            expected_times = list(range(start, end, 60))
            if [row[0] for row in values] != expected_times:
                raise ValueError("source minutes must exactly cover the canonical [start,end) interval")
            return {"start": start, "end": end, "members": [index for index, _ in members],
                    "open": values[0][1], "high": max(row[2] for row in values),
                    "low": min(row[3] for row in values), "close": values[-1][4],
                    "volume": sum(row[5] for row in values)}

        cutoff_seconds = None
        independently_aggregated = [aggregate(source, interval) for interval in expected]
        for actual, interval in zip(independently_aggregated, expected):
            self.assertIsNotNone(actual)
            self.assertEqual(actual, {"start": interval["startSeconds"], "end": interval["endSeconds"],
                "members": interval["memberIndices"], "open": interval["open"], "high": interval["high"],
                "low": interval["low"], "close": interval["close"], "volume": interval["volume"]})
        with self.assertRaises(ValueError):
            aggregate(source[:14], expected[0])
        with self.assertRaises(ValueError):
            aggregate([row for index, row in enumerate(source) if index != 20], expected[1])
        shifted_source = [row[:] for row in source]
        shifted_source[5][0] += 60
        with self.assertRaises(ValueError):
            aggregate(shifted_source, expected[0])
        self.assertEqual(source[5][0], fixture["candles"][5][0])
        expected_minutes = list(range(expected[0]["startSeconds"], expected[0]["endSeconds"], 60))
        shifted_minutes = [row[0] for row in shifted_source
                           if expected[0]["startSeconds"] <= row[0] < expected[0]["endSeconds"]]
        self.assertNotEqual(shifted_minutes, expected_minutes)
        cutoff_seconds = expected[0]["endSeconds"] - 1
        self.assertIsNone(aggregate(source, expected[0]))

        bars = [{"time": interval["endSeconds"], "open": item["open"], "close": item["close"]}
                for interval, item in zip(expected, independently_aggregated)]
        signals = [{"time": interval["endSeconds"], "directTarget": "flat",
                    "probabilityUp": 0.5, "probabilityDown": 0.5, "abstained": True}
                   for interval in expected]
        close_labels = [interval["endSeconds"] * 1000 for interval in expected]
        replay = run_replay({
            "bars": bars,
            "signals": signals,
            "timestampUnit": "seconds", "sourceIntervalMs": 900_000,
            "cutoffMs": close_labels[-1], "scanTimeMs": close_labels[-1], "maxAgeMs": 900_000,
            "strategyId": "shared-time-contract", "configId": "flat-adapter",
        })
        self.assertEqual(replay["inputWindow"]["barTimesMs"], close_labels)
        self.assertEqual(replay["sourceTimestamps"], [
            {"value": interval["endSeconds"], "unit": "seconds"} for interval in expected
        ])
        self.assertEqual([time - 900_000 for time in replay["inputWindow"]["barTimesMs"]],
                         [interval["startSeconds"] * 1000 for interval in expected])
        before_first_close = run_replay({
            "bars": bars,
            "signals": signals, "timestampUnit": "seconds", "sourceIntervalMs": 900_000,
            "cutoffMs": close_labels[0] - 1, "scanTimeMs": close_labels[0] - 1,
            "maxAgeMs": 900_000, "strategyId": "shared-time-contract", "configId": "cutoff-check",
        })
        self.assertEqual(before_first_close["inputWindow"]["barTimesMs"], [])
        self.assertEqual(before_first_close["sourceTimestamps"], [])
        self.assertEqual(before_first_close["decisionInputs"], [])
        self.assertIsNone(before_first_close["ledger"])

        at_first_close = run_replay({
            "bars": bars, "signals": signals, "timestampUnit": "seconds",
            "sourceIntervalMs": 900_000, "cutoffMs": close_labels[0],
            "scanTimeMs": close_labels[0], "maxAgeMs": 900_000,
            "strategyId": "shared-time-contract", "configId": "exact-close-check",
        })
        self.assertEqual(at_first_close["inputWindow"]["barTimesMs"], [close_labels[0]])
        self.assertEqual(at_first_close["sourceTimestamps"], [
            {"value": expected[0]["endSeconds"], "unit": "seconds"}
        ])
        self.assertEqual(at_first_close["decisionInputs"], [{
            **signals[0], "time": close_labels[0]
        }])
        self.assertEqual(at_first_close["ledger"]["fills"], [])
        self.assertEqual(replay["comparator"]["status"], "not_comparable")


if __name__ == "__main__":
    unittest.main()
