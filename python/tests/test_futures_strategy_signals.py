import copy
import math
import random
import unittest

from balancita_engine.futures_spec_strategy import propose_spec
from balancita_engine.futures_strategies import C25_ID, C26_ID, C27_ID, C28_ID, STRATEGY_IDS
from balancita_engine.futures_strategy_signals import consensus, strategy_signal, verdict_signals

from test_futures_spec_strategy import SPECS, _random_features

EXPECTED = {"LONG": "buy", "SHORT": "sell"}


def _fuzz(rng, strategy_id):
    regime = rng.choice(["unknown", "trend", "range"])
    current = _random_features(rng, ready=rng.random() > 0.05)
    previous = _random_features(rng) if rng.random() > 0.05 else None
    trend = _random_features(rng) if rng.random() > 0.05 else None
    proposal = propose_spec(SPECS[strategy_id], current, previous=previous, trend=trend, regime=regime)
    return proposal, regime


class SignalShapeTests(unittest.TestCase):
    def test_every_shipped_strategy_votes_like_its_proposal(self):
        rng = random.Random(8)
        seen = set()
        for _ in range(6000):
            strategy_id = rng.choice(sorted(SPECS))
            proposal, regime = _fuzz(rng, strategy_id)
            signal = strategy_signal(SPECS[strategy_id], proposal, regime)
            self.assertAlmostEqual(signal["buy"] + signal["hold"] + signal["sell"], 1.0, places=12)
            for name in ("buy", "hold", "sell"):
                self.assertGreaterEqual(signal[name], 0.0)
            expected = EXPECTED.get(proposal["action"], "hold")
            self.assertEqual(signal["chosen"], expected, (strategy_id, proposal["action"], signal))
            self.assertEqual(max(("hold", "buy", "sell"), key=lambda n: signal[n]), expected)
            seen.add((strategy_id, expected))
        # The fuzz reaches entries on both sides for every strategy, not only hold.
        # C29 reads log features the fuzz does not generate; test_c29_votes_buy_when_it_fires covers it.
        for strategy_id in STRATEGY_IDS:
            for vote in ("buy", "sell"):
                self.assertIn((strategy_id, vote), seen)

    def test_c29_votes_buy_when_it_fires(self):
        features = {"ready": True, "candidate_close": "100", "atr14": "1", "candidate_bucket_start_ms": 1}
        trend = {"ready": True, "logret72": "0.03", "logvol288": "0.0005"}
        proposal = propose_spec(SPECS["c29-momentum-perp-v1"], features, previous=features, trend=trend, tick_size="0.01")
        self.assertEqual(proposal["action"], "LONG")
        self.assertEqual(strategy_signal(SPECS["c29-momentum-perp-v1"], proposal, "range")["chosen"], "buy")

    def test_signals_are_deterministic(self):
        rng = random.Random(3)
        for _ in range(200):
            strategy_id = rng.choice(sorted(SPECS))
            proposal, regime = _fuzz(rng, strategy_id)
            self.assertEqual(strategy_signal(SPECS[strategy_id], proposal, regime),
                             strategy_signal(SPECS[strategy_id], copy.deepcopy(proposal), regime))


def _cond(code, passed):
    return {"code": code, "value": None, "operator": ">", "threshold": None, "passed": passed}


def _wait(strategy_id, conditions, **extra):
    return dict({"strategy_id": strategy_id, "action": "WAIT", "status": "ready",
                 "reason_code": "entry_conditions_not_met", "conditions": conditions,
                 "delegated_strategy_id": None}, **extra)


C25_LONG = ["trend_ema9_above_ema21", "trend_close_above_sma50", "previous_low_touches_ema21",
            "previous_close_at_or_below_ema9", "current_close_crosses_above_ema9",
            "rsi_in_long_band", "rsi_at_most_65"]


class SignalValueTests(unittest.TestCase):
    def test_a_setup_close_to_firing_tilts_hold_towards_its_side(self):
        conditions = [_cond(code, True) for code in C25_LONG[:5]] + [_cond("rsi_in_long_band", False)]
        signal = strategy_signal(SPECS[C25_ID], _wait(C25_ID, conditions))
        self.assertEqual(signal["chosen"], "hold")
        self.assertGreater(signal["buy"], 0.2)
        self.assertEqual(signal["sell"], 0.0)

    def test_nothing_passed_is_pure_hold(self):
        signal = strategy_signal(SPECS[C27_ID], _wait(C27_ID, []))
        self.assertEqual((signal["buy"], signal["hold"], signal["sell"]), (0.0, 1.0, 0.0))

    def test_a_fired_entry_is_buy_with_little_hold(self):
        conditions = [_cond("close_breaks_prior_high", True), _cond("close_breaks_prior_low", False),
                      _cond("volume_above_1_25_prior_mean", True)]
        proposal = dict(_wait(C27_ID, conditions), action="LONG", reason_code="c27_long_breakout")
        signal = strategy_signal(SPECS[C27_ID], proposal)
        self.assertEqual(signal["chosen"], "buy")
        self.assertEqual(signal["hold"], 0.0)
        # The shared volume check half-satisfies the short side.
        self.assertAlmostEqual(signal["sell"], (0.25 / 3) / (1 + 0.25 / 3), places=12)

    def test_c26_counts_the_range_regime(self):
        conditions = [_cond("previous_close_below_lower_band", True),
                      _cond("current_close_back_inside_lower_band", True)]
        in_range = strategy_signal(SPECS[C26_ID], _wait(C26_ID, conditions), "range")
        in_trend = strategy_signal(SPECS[C26_ID], _wait(C26_ID, conditions), "trend")
        self.assertGreater(in_range["buy"], in_trend["buy"])

    def test_c28_reads_the_branch_it_delegated_to(self):
        conditions = [_cond("close_breaks_prior_high", True)]
        trend_branch = SPECS[C28_ID]["branches"]["trend"]["id"]
        proposal = _wait(C28_ID, [_cond(code, True) for code in C25_LONG[:4]], delegated_strategy_id=trend_branch)
        self.assertGreater(strategy_signal(SPECS[C28_ID], proposal)["buy"], 0.0)
        unknown = _wait(C28_ID, conditions, action="ABSTAIN", status="invalid", reason_code="regime_unavailable")
        self.assertEqual(strategy_signal(SPECS[C28_ID], unknown)["hold"], 1.0)

    def test_untradable_proposals_are_pure_hold(self):
        for proposal in (
            dict(_wait(C25_ID, []), status="warming_up", reason_code="warming_up"),
            _wait(C25_ID, [], reason_code="previous_bar_unavailable"),
            dict(_wait(C26_ID, []), action="ABSTAIN", status="invalid", reason_code="frozen_target_unavailable"),
            dict(_wait(C27_ID, []), action="FLAT", reason_code="owner_exit_condition_met"),
        ):
            signal = strategy_signal(SPECS[proposal["strategy_id"]], proposal)
            self.assertEqual((signal["hold"], signal["chosen"]), (1.0, "hold"), proposal)

    def test_a_strategy_without_a_spec_is_pure_hold(self):
        signal = strategy_signal(None, _wait("c99-unknown", []))
        self.assertEqual((signal["hold"], signal["reason"]), (1.0, "no_spec"))

    def test_verdict_signals_keep_the_order_and_the_consensus_is_the_mean(self):
        verdict = {"regime": "trend", "proposals": [
            _wait(C25_ID, [_cond(code, True) for code in C25_LONG[:5]]),
            _wait(C27_ID, []),
        ]}
        signals = verdict_signals(verdict, SPECS)
        self.assertEqual([s["strategy_id"] for s in signals], [C25_ID, C27_ID])
        mean = consensus(signals)
        for name in ("buy", "hold", "sell"):
            self.assertTrue(math.isclose(mean[name], (signals[0][name] + signals[1][name]) / 2))
        self.assertIsNone(consensus([]))


if __name__ == "__main__":
    unittest.main()
