import copy
import random
import unittest
from decimal import Decimal

from balancita_engine.futures_spec_strategy import (
    SpecError,
    load_specs,
    propose_spec,
    spec_hash,
    validate_spec,
)
from balancita_engine.futures_strategies import C25_ID, C26_ID, C27_ID, C28_ID, STRATEGY_IDS, propose
from balancita_engine.futures_verdicts import VERDICT_CONFIG, evaluate_verdict, product_config

MINUTE = 60_000
FIVE = 300_000
START = 1_791_000_000_000 - (1_791_000_000_000 % FIVE)
FIELDS = ("candidate_close", "candidate_low", "candidate_high", "ema9", "ema21", "sma50", "rsi14", "atr14",
          "bollinger_lower20", "bollinger_mid20", "bollinger_upper20", "donchian_high20", "donchian_low20",
          "donchian_mid20", "prior_volume_mean20", "candidate_volume")
SPECS = load_specs()


def _random_features(rng, ready=True):
    if not ready:
        return {"ready": False, "reason_codes": rng.choice([[], ["insufficient_candle_warmup"]])}
    base = Decimal(rng.randint(90, 110))
    features = {"ready": True, "candidate_bucket_start_ms": START + rng.randint(0, 50) * MINUTE}
    for field in FIELDS:
        if rng.random() < 0.05:
            features[field] = None
        elif field == "rsi14":
            features[field] = str(rng.choice([25, 29, 30, 31, 35, 44, 45, 50, 55, 56, 65, 66, 69, 70, 71, 75]))
        elif field == "atr14":
            features[field] = str(rng.choice([Decimal("0.5"), Decimal("2"), Decimal("3.7")]))
        elif "volume" in field:
            features[field] = str(Decimal(rng.randint(1, 20)) / 4)
        else:
            features[field] = str(base + Decimal(rng.randint(-8, 8)) / 2)
    return features


def _official(interval, bucket, close, volume):
    spread = Decimal("6")
    return {
        "interval_ms": interval, "bucket_start": bucket, "close_at": bucket + interval,
        "known_at": bucket + interval + 1_000, "open": str(close), "high": str(close + spread),
        "low": str(close - spread), "close": str(close), "volume_btc": str(volume),
        "revision_hash": "h-{}-{}".format(interval, bucket),
    }


def _random_walk(rng, minutes):
    """1 m and 5 m official candles alternating trend and range stretches."""
    price = Decimal("100000")
    ones = []
    for index in range(minutes):
        drift = Decimal(18) if (index // 90) % 3 == 0 else Decimal(-18) if (index // 90) % 3 == 1 else Decimal(0)
        price += drift + Decimal(rng.randint(-60, 60))
        volume = Decimal(rng.randint(1, 8)) if rng.random() < 0.9 else Decimal(rng.randint(10, 30))
        ones.append(_official(MINUTE, START + index * MINUTE, price, volume))
    fives = []
    for start in range(0, minutes - 4, 5):
        chunk = ones[start:start + 5]
        candle = _official(FIVE, chunk[0]["bucket_start"], Decimal(chunk[-1]["close"]),
                           sum(Decimal(c["volume_btc"]) for c in chunk))
        candle["high"] = str(max(Decimal(c["high"]) for c in chunk))
        candle["low"] = str(min(Decimal(c["low"]) for c in chunk))
        fives.append(candle)
    return ones, fives


class SpecValidationTests(unittest.TestCase):
    def test_c25_to_c29_ship_as_valid_specs(self):
        # C29 is a spec only: it needs 24 h of 5m history that live verdicts (200 bars) do not carry.
        self.assertEqual(set(SPECS), set(STRATEGY_IDS) | {"c29-momentum-perp-v1"})
        for spec in SPECS.values():
            validate_spec(spec)
            self.assertEqual(len(spec_hash(spec)), 64)

    def test_changing_a_parameter_changes_the_hash(self):
        changed = copy.deepcopy(SPECS[C25_ID])
        changed["params"]["rsi_long_min"] = "40"
        self.assertNotEqual(spec_hash(changed), spec_hash(SPECS[C25_ID]))

    def test_rejects_code_unknown_operands_and_bad_comparators(self):
        cases = [
            ("op", lambda s: s["rules"]["exit"]["LONG"].update(op="==")),
            ("parameter", lambda s: s["rules"]["exit"]["LONG"].update(right="$missing")),
            ("scope", lambda s: s["rules"]["exit"]["LONG"].update(right="15m.ema21")),
            ("constant", lambda s: s["rules"]["exit"]["LONG"].update(right="__import__('os')")),
            ("node", lambda s: s["rules"]["checks"].append({"node": {"eval": "1"}})),
            ("requires", lambda s: s["rules"]["sides"]["LONG"].update(requires=["nope"])),
            ("schema", lambda s: s.update(schema="other")),
        ]
        for label, mutate in cases:
            spec = copy.deepcopy(SPECS[C25_ID])
            mutate(spec)
            with self.assertRaises(SpecError, msg=label):
                validate_spec(spec)


class SpecParityTests(unittest.TestCase):
    """The interpreter with the shipped specs reproduces ``propose`` exactly."""

    def assert_parity(self, strategy_id, *args, **kwargs):
        expected = propose(strategy_id, *args, **kwargs)
        actual = propose_spec(SPECS[strategy_id], *args, **kwargs)
        self.assertEqual(actual, expected)
        return expected

    def test_fuzzed_entries_and_exits_match_propose(self):
        rng = random.Random(20261007)
        actions = set()
        for _ in range(6000):
            current = _random_features(rng, ready=rng.random() > 0.03)
            previous = _random_features(rng) if rng.random() > 0.05 else None
            trend = _random_features(rng, ready=rng.random() > 0.05) if rng.random() > 0.05 else None
            kwargs = {
                "previous": previous, "trend": trend, "regime": rng.choice(["unknown", "trend", "range"]),
                "age_ms": rng.choice([None, 1000]), "tick_size": rng.choice(["1", "0.1", "0.5"]),
                "cost_config": rng.choice([None, {"maker_rate": "0.0002", "taker_rate": "0.0005"}]),
            }
            if rng.random() < 0.3:
                kwargs.update(position_side=rng.choice(["LONG", "SHORT"]),
                              frozen_target=rng.choice([None, current.get("bollinger_mid20")]),
                              frozen_invalidation=rng.choice([None, current.get("donchian_mid20")]),
                              delegated_strategy_id=rng.choice([None, C25_ID, C26_ID]))
            for strategy_id in STRATEGY_IDS:
                actions.add(self.assert_parity(strategy_id, current, **kwargs)["action"])
        self.assertEqual(actions, {"WAIT", "ABSTAIN", "LONG", "SHORT", "FLAT"})

    def test_replayed_verdicts_match_propose_on_a_synthetic_history(self):
        rng = random.Random(7)
        ones, fives = _random_walk(rng, 900)
        config = product_config(VERDICT_CONFIG, "PF_XBTUSD", "1")
        regime = "unknown"
        directional = {strategy_id: 0 for strategy_id in STRATEGY_IDS}
        for candidate in ones[260:]:
            verdict = evaluate_verdict(ones, fives, previous_regime=regime, config=config,
                                       candidate_bucket=candidate["bucket_start"])
            regime = verdict["regime"]
            features = verdict["features"]
            common = {"previous": features["1m_previous"], "trend": features["5m"], "regime": regime,
                      "age_ms": verdict["knowledge_lag_ms"], "tick_size": "1",
                      "cost_config": {"maker_rate": "0.0002", "taker_rate": "0.0005"}}
            for strategy_id, expected in zip(STRATEGY_IDS, verdict["proposals"]):
                actual = propose_spec(SPECS[strategy_id], features["1m"], **common)
                self.assertEqual(actual, expected)
                if expected["action"] in ("LONG", "SHORT"):
                    directional[strategy_id] += 1
                    exit_args = dict(common, position_side=expected["action"],
                                     delegated_strategy_id=expected["delegated_strategy_id"],
                                     frozen_target=expected["proposed_target"],
                                     frozen_invalidation=features["1m"].get("donchian_mid20"))
                    self.assert_parity(strategy_id, features["1m"], **exit_args)
        # The history must exercise real entries, not only warm-up and waits.
        self.assertGreater(sum(directional.values()), 0, directional)

    def test_a_changed_parameter_changes_the_decision(self):
        current = {"ready": True, "candidate_close": "101", "ema9": "100", "rsi14": "44", "atr14": "2",
                   "candidate_bucket_start_ms": START}
        previous = {"ready": True, "candidate_low": "99", "ema21": "99.5", "candidate_close": "99.8", "ema9": "100"}
        trend = {"ready": True, "ema9": "102", "ema21": "100", "candidate_close": "103", "sma50": "98"}
        self.assertEqual(propose_spec(SPECS[C25_ID], current, previous=previous, trend=trend)["action"], "WAIT")
        looser = copy.deepcopy(SPECS[C25_ID])
        looser["params"]["rsi_long_min"] = "40"
        self.assertEqual(propose_spec(looser, current, previous=previous, trend=trend)["action"], "LONG")

    def test_adapter_keeps_its_own_identity_and_delegates_by_regime(self):
        current = {"ready": True, "candidate_close": "100", "rsi14": "50", "atr14": "2"}
        abstain = self.assert_parity(C28_ID, current, regime="unknown")
        self.assertEqual((abstain["strategy_id"], abstain["reason_code"]), (C28_ID, "regime_unavailable"))
        waiting = self.assert_parity(C28_ID, current, previous={"ready": True}, regime="range")
        self.assertEqual((waiting["strategy_id"], waiting["delegated_strategy_id"]), (C28_ID, C26_ID))
        self.assert_parity(C27_ID, current)
        self.assert_parity(C26_ID, current)


if __name__ == "__main__":
    unittest.main()
