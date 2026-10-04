import unittest
from decimal import Decimal

from balancita_engine.futures_indicators import calculate_features


def candle(index, close, *, interval_ms=60_000, high=None, low=None, volume="1"):
    price = Decimal(close)
    return {
        "interval_ms": interval_ms,
        "bucket_start_ms": index * interval_ms,
        "close_at_ms": (index + 1) * interval_ms,
        "known_at_ms": (index + 1) * interval_ms,
        "received_at_ms": (index + 1) * interval_ms,
        "reception_order": index + 1,
        "closed": True,
        "coverage": "complete",
        "open": str(price),
        "high": high if high is not None else str(price + Decimal("1")),
        "low": low if low is not None else str(price - Decimal("1")),
        "close": str(price),
        "volume_btc": volume,
    }


class FuturesIndicatorTests(unittest.TestCase):
    def test_wilder_features_bollinger_population_and_donchian_excludes_candidate(self):
        candles = [candle(i, str(100 + i)) for i in range(60)]
        features = calculate_features(
            candles,
            interval_ms=60_000,
            decision_time_ms=3_600_000,
            candidate_index=59,
        )
        self.assertTrue(features["ready"])
        self.assertEqual(features["schema_version"], "c27-features.v1")
        self.assertEqual(features["sma50"], "134.5")
        self.assertEqual(features["donchian_high20"], "159")
        self.assertEqual(features["candidate_close"], "159")
        self.assertEqual(features["bollinger_ddof"], 0)
        self.assertEqual(features["smoothing"], "wilder")
        self.assertGreater(Decimal(features["atr14"]), 0)

    def test_open_unavailable_late_and_incomplete_bars_do_not_create_ready_features(self):
        candles = [candle(i, str(100 + i)) for i in range(60)]
        candles[-1]["closed"] = False
        candles[-2]["known_at_ms"] = 3_600_001
        candles[-3]["coverage"] = "gap"
        features = calculate_features(
            candles,
            interval_ms=60_000,
            decision_time_ms=3_600_000,
            candidate_index=59,
        )
        self.assertFalse(features["ready"])
        self.assertIsNone(features["candidate_close"])
        self.assertIn("candle_not_closed", features["reason_codes"])
        self.assertIn("candle_not_known_at_cutoff", features["reason_codes"])
        self.assertIn("incomplete_candle_coverage", features["reason_codes"])

    def test_future_candle_event_time_is_not_available_at_decision_cutoff(self):
        candles = [candle(i, str(100 + i)) for i in range(60)]
        candles[-1]["close_at_ms"] = 3_600_001
        features = calculate_features(
            candles,
            interval_ms=60_000,
            decision_time_ms=3_600_000,
            candidate_index=59,
        )
        self.assertFalse(features["ready"])
        self.assertIn("candle_event_time_after_cutoff", features["reason_codes"])

    def test_six_bars_and_zero_atr_are_not_trade_ready(self):
        short = [candle(i, str(100 + i)) for i in range(6)]
        warmup = calculate_features(
            short,
            interval_ms=60_000,
            decision_time_ms=360_000,
            candidate_index=5,
        )
        self.assertFalse(warmup["ready"])
        self.assertIn("insufficient_candle_warmup", warmup["reason_codes"])

        flat = [
            candle(i, "100", high="100", low="100")
            for i in range(60)
        ]
        no_range = calculate_features(
            flat,
            interval_ms=60_000,
            decision_time_ms=3_600_000,
            candidate_index=59,
        )
        self.assertFalse(no_range["ready"])
        self.assertEqual(no_range["atr14"], "0")
        self.assertIn("invalid_or_zero_atr", no_range["reason_codes"])


if __name__ == "__main__":
    unittest.main()
