import unittest
from decimal import Decimal

from balancita_engine.futures_indicators import calculate_features
from balancita_engine.futures_strategies import (
    C25_ID,
    C26_ID,
    C27_ID,
    C28_ID,
    select_proposal,
    update_regime,
    propose,
)


class FuturesStrategyTests(unittest.TestCase):
    def test_selector_rejects_conflicting_directions(self):
        selected = select_proposal(
            [
                {"strategy_id": C25_ID, "action": "LONG", "target_distance": "10", "stop_distance": "2"},
                {"strategy_id": C27_ID, "action": "SHORT", "target_distance": "12", "stop_distance": "2"},
            ],
            owner_strategy_id=None,
        )
        self.assertEqual(selected["action"], "ABSTAIN")
        self.assertEqual(selected["reason_code"], "conflicting_signals")

    def test_adapter_proposal_is_deduplicated_with_its_delegate(self):
        selected = select_proposal(
            [
                {"strategy_id": C25_ID, "action": "LONG", "target_distance": "10", "stop_distance": "2"},
                {"strategy_id": C28_ID, "action": "LONG", "delegated_strategy_id": C25_ID, "target_distance": "10", "stop_distance": "2"},
            ],
            owner_strategy_id=None,
        )
        self.assertEqual(selected["strategy_id"], C25_ID)

    def test_regime_uses_hysteresis_and_abstains_without_positive_atr(self):
        self.assertEqual(update_regime("unknown", "110", "100", "10"), "trend")
        self.assertEqual(update_regime("trend", "103", "100", "10"), "trend")
        self.assertEqual(update_regime("trend", "101", "100", "10"), "range")
        self.assertEqual(update_regime("unknown", "103", "100", "10"), "unknown")
        self.assertEqual(update_regime("trend", "110", "100", "0"), "unknown")

    def test_registry_exposes_versioned_four_strategy_identity(self):
        self.assertEqual(len({C25_ID, C26_ID, C27_ID, C28_ID}), 4)
        self.assertTrue(all(value.endswith("-perp-v1") for value in (C25_ID, C26_ID, C27_ID, C28_ID)))

    def test_c25_long_and_short_require_pullback_and_close_cross(self):
        previous = {
            "candidate_close": "99", "candidate_low": "99", "candidate_high": "102",
            "ema9": "100", "ema21": "99", "rsi14": "50",
        }
        trend = {"ready": True, "ema9": "102", "ema21": "100", "candidate_close": "105", "sma50": "103"}
        long = propose(C25_ID, {"ready": True, "candidate_close": "101", "ema9": "100", "rsi14": "55", "atr14": "2"}, previous=previous, trend=trend)
        self.assertEqual(long["action"], "LONG")
        self.assertEqual(long["reason_code"], "c25_long_pullback")
        self.assertEqual(long["proposed_stop"], "98")
        self.assertEqual(long["proposed_target"], "107")
        bearish_previous = dict(previous, candidate_close="100", candidate_high="101", ema9="100", ema21="101")
        short = propose(C25_ID, {"ready": True, "candidate_close": "99", "ema9": "100", "rsi14": "45", "atr14": "2"}, previous=bearish_previous,
                        trend={"ready": True, "ema9": "98", "ema21": "100", "candidate_close": "95", "sma50": "97"})
        self.assertEqual(short["action"], "SHORT")

    def test_c26_reversion_uses_band_cross_and_frozen_mid_target(self):
        previous = {"candidate_close": "90", "bollinger_lower20": "95", "bollinger_upper20": "110", "rsi14": "25"}
        current = {"ready": True, "candidate_close": "96", "atr14": "2", "bollinger_lower20": "95", "bollinger_mid20": "102", "bollinger_upper20": "110", "rsi14": "32"}
        proposal = propose(C26_ID, current, previous=previous, regime="range")
        self.assertEqual(proposal["action"], "LONG")
        self.assertEqual(proposal["proposed_target"], "102")
        self.assertEqual(propose(C26_ID, current, previous=previous, regime="trend")["action"], "WAIT")

    def test_c27_emits_short_breakout_once_per_candidate_bar(self):
        features = {"ready": True, "candidate_close": "89", "donchian_high20": "120", "donchian_low20": "90",
                    "donchian_mid20": "105", "candidate_volume": "13", "prior_volume_mean20": "10",
                    "candidate_bucket_start_ms": 60000, "atr14": "2"}
        proposal = propose(C27_ID, features)
        self.assertEqual(proposal["action"], "SHORT")
        self.assertEqual(proposal["signal_key"], C27_ID + ":SHORT:60000")

    def test_c27_entry_invalidation_carries_the_numeric_donchian_mid(self):
        features = {"ready": True, "candidate_close": "121", "donchian_high20": "120", "donchian_low20": "90",
                    "donchian_mid20": "105", "candidate_volume": "13", "prior_volume_mean20": "10",
                    "candidate_bucket_start_ms": 60000, "atr14": "2"}
        self.assertEqual(propose(C27_ID, features)["invalidation"], "opposite_donchian_mid_cross@105")
        self.assertEqual(propose(C27_ID, dict(features, candidate_close="89"))["invalidation"],
                         "opposite_donchian_mid_cross@105")

    def test_c27_exit_uses_the_frozen_mid_with_engine_features(self):
        exit_features = {"ready": True, "candidate_close": "104"}
        long_exit = propose(C27_ID, exit_features, position_side="LONG", frozen_invalidation="105")
        self.assertEqual(long_exit["action"], "FLAT")
        self.assertEqual(propose(C27_ID, dict(exit_features, candidate_close="106"), position_side="LONG",
                                 frozen_invalidation="105")["action"], "WAIT")
        self.assertEqual(propose(C27_ID, dict(exit_features, candidate_close="106"), position_side="SHORT",
                                 frozen_invalidation="105")["action"], "FLAT")

    def test_selector_uses_ratio_then_stable_id_and_preserves_owner(self):
        proposals = [
            {"strategy_id": C27_ID, "action": "LONG", "target_distance": "10", "stop_distance": "2"},
            {"strategy_id": C25_ID, "action": "LONG", "target_distance": "15", "stop_distance": "2"},
        ]
        self.assertEqual(select_proposal(proposals, owner_strategy_id=None)["strategy_id"], C25_ID)
        self.assertEqual(
            select_proposal(proposals, owner_strategy_id=C27_ID)["strategy_id"],
            C27_ID,
        )
        self.assertEqual(
            select_proposal([dict(proposals[0], signal_key="same")], owner_strategy_id=None,
                            consumed_signal_keys={"same"})["reason_code"],
            "signal_already_evaluated",
        )

    def test_engine_indicators_feed_strategy_without_fixture_feature_substitution(self):
        candles = []
        for index in range(60):
            close = Decimal("100") + Decimal(index) / Decimal("10")
            candles.append({
                "interval_ms": 60000,
                "bucket_start_ms": index * 60000,
                "close_at_ms": (index + 1) * 60000,
                "received_at_ms": (index + 1) * 60000,
                "known_at_ms": (index + 1) * 60000,
                "closed": True,
                "coverage": "complete",
                "open": str(close), "high": str(close + Decimal("1")),
                "low": str(close - Decimal("1")), "close": str(close),
                "volume_btc": "10",
            })
        features = calculate_features(candles, interval_ms=60000, decision_time_ms=4_000_000)
        proposal = propose(C27_ID, features)
        self.assertEqual(features["ready"], True)
        self.assertIn(proposal["action"], ("WAIT", "LONG", "SHORT"))
        self.assertIn("donchian_mid20", features)

    def test_c28_keeps_open_delegate_after_regime_changes_and_reports_warmup(self):
        current = {"ready": True, "candidate_close": "101", "ema9": "100", "atr14": "2", "rsi14": "55"}
        trend = {"ready": True, "ema9": "102", "ema21": "100", "candidate_close": "105", "sma50": "103"}
        prior = {"candidate_close": "99", "candidate_low": "99", "candidate_high": "102", "ema9": "100", "ema21": "99"}
        proposal = propose(C28_ID, current, previous=prior, trend=trend, regime="range",
                           delegated_strategy_id=C25_ID, position_side="LONG")
        self.assertEqual(proposal["strategy_id"], C28_ID)
        self.assertEqual(proposal["delegated_strategy_id"], C25_ID)
        self.assertEqual(proposal["action"], "WAIT")
        warming = propose(C25_ID, {"ready": False, "reason_codes": ["insufficient_candle_warmup"]})
        self.assertEqual(warming["status"], "warming_up")


if __name__ == "__main__":
    unittest.main()
