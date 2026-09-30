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
        legacy_fill = result["ledger"]["fills"][0]
        self.assertEqual(legacy_fill["side"], "buy")
        self.assertAlmostEqual(legacy_fill["price"], 110.055)
        self.assertAlmostEqual(legacy_fill["qty"], 10_000 / (110.055 * 1.001))
        self.assertAlmostEqual(
            legacy_fill["commission"], legacy_fill["qty"] * 110.055 * 0.001
        )
        self.assertEqual(result["strategyId"], "fixture-long-flat-v1")
        self.assertEqual(result["costIdentity"]["commissionRate"], 0.001)
        self.assertEqual(result["inputWindow"]["cutoffMs"], 10_800_000)
        self.assertEqual(
            result["executionAudit"]["version"], "python-replay-execution.v1"
        )
        self.assertEqual(result["executionAudit"]["fills"], [{
            "fillIndex": 0, "fillSide": "buy", "legacyLedgerTimeMs": 7_200_000,
            "timingStatus": "modeled_next_open",
            "decisionCandleCloseMs": 3_600_000,
            "decisionSignalTimeMs": 3_600_000,
            "decisionAvailableAtMs": 3_600_000,
            "executionAtMs": 3_600_000,
        }])
        self.assertEqual(result["executionAudit"]["comparability"], "modeled_only")
        self.assertEqual(
            result["executionAudit"]["availabilityBasis"],
            "decision_candle_close_not_measured_arrival",
        )

    def test_execution_audit_keeps_legacy_times_and_marks_gap_fill_ambiguous(self):
        options = dict(self.options)
        options["bars"] = [self.bars[0], self.bars[2]]
        result = run_replay(options)
        self.assertEqual(result["ledger"]["fills"][0]["time"], 10_800_000)
        self.assertEqual(result["executionAudit"]["fills"], [{
            "fillIndex": 0, "fillSide": "buy", "legacyLedgerTimeMs": 10_800_000,
            "timingStatus": "ambiguous_gap_or_irregular_interval",
            "decisionCandleCloseMs": 3_600_000,
            "decisionSignalTimeMs": 3_600_000,
            "decisionAvailableAtMs": 3_600_000,
            "executionAtMs": None,
        }])
        self.assertEqual(
            result["executionAudit"]["comparability"],
            "unavailable_for_ambiguous_fills",
        )

    def test_execution_audit_does_not_invent_terminal_or_cutoff_fill(self):
        terminal = run_replay(dict(self.options, bars=self.bars[:1],
                                   cutoffMs=3_600_000, scanTimeMs=3_600_000))
        self.assertEqual(terminal["ledger"]["fills"], [])
        self.assertEqual(terminal["executionAudit"]["fills"], [])
        before_fill = run_replay(dict(self.options, cutoffMs=3_600_000,
                                      scanTimeMs=3_600_000))
        self.assertEqual(before_fill["ledger"]["fills"], [])
        self.assertEqual(before_fill["executionAudit"]["fills"], [])

    def test_execution_audit_is_deterministic_and_preserves_seconds_legacy_fill(self):
        options = dict(
            self.options,
            timestampUnit="seconds",
            sourceIntervalMs=3_600_000,
            cutoffMs=10_800_000,
            scanTimeMs=10_800_000,
            bars=[dict(bar, time=bar["time"] // 1000) for bar in self.bars],
            signals=[
                dict(signal, time=signal["time"] // 1000)
                for signal in self.signals
            ],
        )
        first = run_replay(options)
        second = run_replay(options)
        self.assertEqual(first["executionAudit"], second["executionAudit"])
        self.assertEqual(first["ledger"]["fills"], second["ledger"]["fills"])
        self.assertEqual(first["ledger"]["fills"][0]["time"], 7_200_000)

    def test_execution_audit_schema_is_consistent_without_a_ledger(self):
        stale = run_replay(dict(self.options, scanTimeMs=18_000_000))
        no_closed_data = run_replay(dict(
            self.options, cutoffMs=3_599_999, scanTimeMs=3_599_999
        ))
        valid_no_fills = run_replay(dict(self.options, signals=[]))

        for result in (stale, no_closed_data):
            audit = result["executionAudit"]
            self.assertEqual(audit["availabilityBasis"],
                             "decision_candle_close_not_measured_arrival")
            self.assertEqual(audit["executionBasis"], "next_bar_open_model_only")
            self.assertEqual(audit["comparability"], "unavailable_no_ledger")
            self.assertEqual(audit["fills"], [])
        self.assertEqual(valid_no_fills["executionAudit"]["comparability"],
                         "modeled_only")
        self.assertEqual(valid_no_fills["executionAudit"]["fills"], [])

    def test_abstention_exit_and_same_bar_reversal_audit_actual_fill_order(self):
        options = dict(self.options, bars=self.bars[:3], cutoffMs=10_800_000,
                       signals=[
                           {"time": 3_600_000, "probabilityUp": 0.8,
                            "probabilityDown": 0.1, "abstained": False},
                           {"time": 7_200_000, "probabilityUp": 0.5,
                            "probabilityDown": 0.5, "abstained": True},
                       ])
        result = run_replay(options)
        self.assertEqual([fill["side"] for fill in result["ledger"]["fills"]],
                         ["buy", "sell"])
        self.assertEqual(result["executionAudit"]["fills"], [
            {"fillIndex": 0, "fillSide": "buy", "legacyLedgerTimeMs": 7_200_000,
             "timingStatus": "modeled_next_open", "decisionCandleCloseMs": 3_600_000,
             "decisionSignalTimeMs": 3_600_000, "decisionAvailableAtMs": 3_600_000,
             "executionAtMs": 3_600_000},
            {"fillIndex": 1, "fillSide": "sell", "legacyLedgerTimeMs": 10_800_000,
             "timingStatus": "modeled_next_open", "decisionCandleCloseMs": 7_200_000,
             "decisionSignalTimeMs": 7_200_000, "decisionAvailableAtMs": 7_200_000,
             "executionAtMs": 7_200_000},
        ])

    def test_same_bar_reversal_has_two_audit_rows_for_actual_order(self):
        options = dict(self.options, bars=self.bars[:3], cutoffMs=10_800_000,
                       signals=[
                           {"time": 3_600_000, "probabilityUp": 0.8,
                            "probabilityDown": 0.1, "abstained": False},
                           {"time": 7_200_000, "probabilityUp": 0.5,
                            "probabilityDown": 0.5, "abstained": False,
                            "directTarget": "short"},
                       ])
        result = run_replay(options)
        self.assertEqual([fill["side"] for fill in result["ledger"]["fills"]],
                         ["buy", "sell", "sell_short"])
        reversal = result["executionAudit"]["fills"][1:]
        self.assertEqual([row["fillSide"] for row in reversal], ["sell", "sell_short"])
        self.assertEqual([row["executionAtMs"] for row in reversal],
                         [7_200_000, 7_200_000])

    def test_no_new_closed_bar_is_idempotent_and_stale_is_distinct(self):
        first = run_replay(self.options)
        no_new = dict(self.options, scanTimeMs=11_700_000)
        second = run_replay(no_new)
        self.assertEqual(second["status"], "no_new_closed_bar")
        self.assertEqual(second["ledger"], first["ledger"])
        self.assertEqual(second["executionAudit"], first["executionAudit"])
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

    def test_captured_fastreplay_trace_matches_python_execution_event_times(self):
        fixture = json.loads((Path(__file__).parents[1] / "fixtures" / "fast-replay-execution-trace.json").read_text())
        provenance = fixture["provenance"]
        recipe = fixture["nativeBarRecipe"]
        source_minutes = []
        native_bars = []
        for index in range(recipe["barCount"]):
            values = dict(recipe["tail"] if index >= recipe["tailStartIndex"] else recipe["default"])
            values.update(recipe["overrides"].get(str(index), {}))
            start = provenance["firstBarTimestampSeconds"] + index * provenance["nativeIntervalSeconds"]
            native_bars.append(dict(
                time=start + 900, open=values["open"], high=values["high"],
                low=values["low"], close=values["close"],
            ))
            for minute in range(provenance["minuteCountPerNativeBar"]):
                source_minutes.append([
                    start + minute * 60, values["open"], values["high"],
                    values["low"], values["close"],
                    values["volume"] / provenance["minuteCountPerNativeBar"],
                ])

        # Test-only adapter uses the exact shared 1m recipe and complete [start,end) windows.
        aggregated = []
        for offset in range(0, len(source_minutes), 15):
            rows = source_minutes[offset:offset + 15]
            self.assertEqual(len(rows), 15)
            start = rows[0][0]
            self.assertEqual(start % 900, 0)
            self.assertEqual([row[0] for row in rows], list(range(start, start + 900, 60)))
            aggregated.append({
                "time": start + 900, "open": rows[0][1],
                "high": max(row[2] for row in rows),
                "low": min(row[3] for row in rows), "close": rows[-1][4],
            })
        self.assertEqual(aggregated, native_bars)

        signals = []
        native_fill_events = []
        for event in fixture["expectedTrace"]:
            decision_close_seconds = event["timestamp"] + provenance["nativeIntervalSeconds"]
            signals.append({
                "time": decision_close_seconds,
                "directTarget": event["effectiveTarget"],
                "probabilityUp": 0.5,
                "probabilityDown": 0.5,
                "abstained": False,
            })
            if event["fill"]["performed"]:
                native_fill_events.append({
                    "side": event["fill"]["side"],
                    "timeMs": event["fill"]["timestamp"] * 1000,
                    "decisionCloseMs": decision_close_seconds * 1000,
                })

        last_close_ms = aggregated[-1]["time"] * 1000
        replay = run_replay({
            "bars": aggregated, "signals": signals, "timestampUnit": "seconds",
            "sourceIntervalMs": 900_000, "cutoffMs": last_close_ms,
            "scanTimeMs": last_close_ms, "maxAgeMs": 900_000,
            "strategyId": "captured-fastreplay-trace", "configId": "execution-only",
            "costs": fixture["provenance"]["pythonCostIdentity"],
        })
        audit = replay["executionAudit"]
        self.assertEqual(replay["comparator"]["status"], "not_comparable")
        self.assertEqual(replay["costIdentity"], fixture["provenance"]["pythonCostIdentity"])
        self.assertEqual([item["unit"] for item in replay["sourceTimestamps"]], ["seconds"] * len(aggregated))
        self.assertEqual([item["value"] for item in replay["sourceTimestamps"]],
                         [bar["time"] for bar in aggregated])
        self.assertEqual(replay["inputWindow"]["barTimesMs"],
                         [bar["time"] * 1000 for bar in aggregated])
        self.assertEqual([item["time"] for item in replay["decisionInputs"]],
                         [signal["time"] * 1000 for signal in signals])
        self.assertEqual([event["side"] for event in native_fill_events], ["buy", "sell"])
        self.assertEqual([fill["fillSide"] for fill in audit["fills"]],
                         [event["side"] for event in native_fill_events])
        self.assertEqual([fill["executionAtMs"] for fill in audit["fills"]],
                         [event["timeMs"] for event in native_fill_events])
        self.assertEqual([fill["decisionCandleCloseMs"] for fill in audit["fills"]],
                         [event["decisionCloseMs"] for event in native_fill_events])
        self.assertTrue(all(fill["executionAtMs"] >= fill["decisionCandleCloseMs"]
                            for fill in audit["fills"]))
        self.assertEqual(audit["fills"][-1]["timingStatus"], "modeled_next_open")
        self.assertEqual(replay["ledger"]["fills"][-1]["time"], native_fill_events[-1]["timeMs"] + 900_000)
        self.assertEqual(fixture["expectedTrace"][-1]["entryGate"], "rejected")
        self.assertFalse(fixture["expectedTrace"][-1]["fill"]["performed"])
        self.assertEqual(fixture["expectedTrace"][-1]["effectiveTarget"], "flat")
        self.assertIn("not forecasts", fixture["provenance"]["pythonSignalAdapter"])
        self.assertEqual(len(replay["ledger"]["fills"]), 2)

        terminal = fixture["terminalTrace"][0]
        terminal_close_seconds = terminal["timestamp"] + 900
        terminal_replay = run_replay({
            "bars": aggregated[:50], "timestampUnit": "seconds",
            "signals": [{
                "time": terminal_close_seconds, "directTarget": terminal["effectiveTarget"],
                "probabilityUp": 0.5, "probabilityDown": 0.5, "abstained": False,
            }],
            "sourceIntervalMs": 900_000,
            "cutoffMs": terminal_close_seconds * 1000,
            "scanTimeMs": terminal_close_seconds * 1000,
            "maxAgeMs": 900_000, "strategyId": "captured-fastreplay-terminal",
            "configId": "terminal-no-next-open",
            "costs": fixture["provenance"]["pythonCostIdentity"],
        })
        self.assertEqual(terminal["rawTarget"], "long")
        self.assertEqual(terminal["entryGate"], "accepted")
        self.assertEqual(terminal["effectiveTarget"], "flat")
        self.assertEqual(terminal["fill"]["timestamp"], None)
        self.assertEqual(terminal_replay["ledger"]["fills"], [])
        self.assertEqual(terminal_replay["executionAudit"]["fills"], [])


if __name__ == "__main__":
    unittest.main()
