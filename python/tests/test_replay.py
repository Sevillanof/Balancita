import unittest

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


if __name__ == "__main__":
    unittest.main()
