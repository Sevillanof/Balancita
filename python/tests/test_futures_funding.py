import unittest
from decimal import Decimal

from balancita_engine.futures_funding import normalize_observation, accrue_interval
from balancita_engine.futures_ledger import FuturesLedger
from balancita_engine.futures_runtime import FuturesRuntime


class FundingNormalizationTests(unittest.TestCase):
    def test_provider_absolute_rate_and_fixture_interval_normalize(self):
        observation = normalize_observation(
            {
                "source": "kraken-futures-ticker",
                "provider": "kraken",
                "product": "PF_XBTUSD",
                "field": "funding_rate",
                "raw_rate": "0.0001",
                "unit": "usd_per_btc_per_hour",
                "effective_start_ms": 0,
                "effective_end_ms": 3_600_000,
                "known_at_ms": 0,
                "received_seq": 1,
                "observation_id": "funding-1",
                "sha256": "a" * 64,
                "semantic_version": "kraken-funding-normalization.v1",
                "predicted": False,
            },
            100_000,
        )
        self.assertEqual(observation["rate_usd_per_btc_hour"], "0.0001")
        self.assertEqual(observation["status"], "known")

    def test_predicted_or_interval_ambiguous_is_unknown(self):
        source = {
            "source": "kraken-futures-ticker", "provider": "kraken",
            "product": "PF_XBTUSD", "field": "funding_rate",
            "raw_rate": "0.0001", "unit": "usd_per_btc_per_hour",
            "effective_start_ms": None, "effective_end_ms": None,
            "known_at_ms": 1, "received_seq": 2, "observation_id": "x",
            "sha256": "b" * 64,
            "semantic_version": "kraken-funding-normalization.v1",
            "predicted": False,
        }
        self.assertEqual(normalize_observation(source, 100_000)["status"], "unknown")
        source["predicted"] = True
        self.assertEqual(normalize_observation(source, 100_000)["status"], "unknown")

    def test_decimal_sign_and_half_hour_accrual(self):
        long = accrue_interval("long", "0.01", "0.0001", 0, 1_800_000)
        short = accrue_interval("short", "0.01", "0.0001", 0, 1_800_000)
        self.assertEqual(long, "-0.0000005")
        self.assertEqual(short, "0.0000005")

    def test_ledger_segments_rate_changes_and_partial_close_residual(self):
        ledger = FuturesLedger("10000")
        ledger.open("long", "0.01", "100000", "taker", at_ms=0)
        ledger.observe_funding("first", 0, 1_800_000, "0.0001", known_at_ms=0)
        ledger.observe_funding("second", 1_800_000, 3_600_000, "-0.0002", known_at_ms=1_800_000)
        self.assertEqual(ledger.accrue_funding(0, 1_800_000), Decimal("0.0000005"))
        self.assertEqual(ledger.accrue_funding(1_800_000, 3_600_000), Decimal("-0.000001"))
        ledger.close("0.004", "100000", "taker", at_ms=3_600_000)
        self.assertEqual(ledger.position["qty"], Decimal("0.006"))
        self.assertEqual(ledger.position["funding_remaining"], Decimal("-3E-7"))
        self.assertEqual(ledger.position["funding_remaining"], Decimal("-3E-7"))

    def test_missing_coverage_preserves_known_amount_but_net_is_unknown(self):
        ledger = FuturesLedger("10000")
        ledger.open("short", "0.01", "100000", "taker", at_ms=0)
        ledger.observe_funding("known-zero", 0, 1_800_000, "0", known_at_ms=0)
        amount = ledger.accrue_funding(0, 3_600_000)
        self.assertEqual(amount, Decimal("0"))
        self.assertFalse(ledger.funding_complete)
        self.assertIsNone(ledger.snapshot("100000")["realized_net_complete"])

    def test_runtime_consumes_only_cutoff_known_normalized_observation(self):
        runtime = FuturesRuntime.__new__(FuturesRuntime)
        runtime.ledger = FuturesLedger("10000")
        runtime.ledger.open("long", "0.01", "100000", "taker", at_ms=0)
        event = {
            "type": "funding_observation", "received_at_ms": 0,
            "known_at_ms": 0, "observation": {
                "source": "fixture", "provider": "kraken", "product": "PF_XBTUSD",
                "field": "funding_rate", "raw_rate": "0.0001",
                "unit": "usd_per_btc_per_hour", "effective_start_ms": 0,
                "effective_end_ms": 3_600_000, "known_at_ms": 0,
                "received_seq": 1, "observation_id": "fixture-1",
                "sha256": "a" * 64,
                "semantic_version": "kraken-funding-normalization.v1", "predicted": False,
            },
        }
        runtime._observe_funding([event], 1_800_000, 1_800_000)
        self.assertEqual(len(runtime.ledger.funding_rates), 1)

    def test_runtime_does_not_repair_position_boundary_with_late_known_rate(self):
        runtime = FuturesRuntime.__new__(FuturesRuntime)
        runtime.ledger = FuturesLedger("10000")
        runtime.ledger.open("long", "0.01", "100000", "taker", at_ms=0)
        observation = {
            "source": "fixture", "provider": "kraken", "product": "PF_XBTUSD",
            "field": "funding_rate", "raw_rate": "0.0001",
            "unit": "usd_per_btc_per_hour", "effective_start_ms": 0,
            "effective_end_ms": 3_600_000, "known_at_ms": 1,
            "received_seq": 1, "observation_id": "late-rate", "sha256": "c" * 64,
            "semantic_version": "kraken-funding-normalization.v1", "predicted": False,
        }
        event = {"type": "funding_observation", "received_at_ms": 1,
                 "known_at_ms": 1, "observation": observation}
        runtime._observe_funding([event], 1, 1)
        self.assertEqual(runtime.ledger.funding_rates, [])
        self.assertFalse(runtime.ledger.funding_complete)

    def test_runtime_deduplicates_same_effective_interval_across_observation_ids(self):
        runtime = FuturesRuntime.__new__(FuturesRuntime)
        runtime.ledger = FuturesLedger("10000")
        runtime.ledger.open("long", "0.01", "100000", "taker", at_ms=0)

        def event(identifier, digest):
            observation = {
                "source": "fixture", "provider": "kraken", "product": "PF_XBTUSD",
                "field": "funding_rate", "raw_rate": "0.0001",
                "unit": "usd_per_btc_per_hour", "effective_start_ms": 0,
                "effective_end_ms": 3_600_000, "known_at_ms": 0,
                "received_seq": 1, "observation_id": identifier, "sha256": digest,
                "semantic_version": "kraken-funding-normalization.v1", "predicted": False,
            }
            return {"type": "funding_observation", "received_at_ms": 0,
                    "known_at_ms": 0, "observation": observation}

        runtime._observe_funding([event("rate-a", "a" * 64)], 0, 0)
        runtime._observe_funding([event("rate-b", "b" * 64)], 0, 0)
        self.assertEqual(len(runtime.ledger.funding_rates), 1)
        self.assertTrue(runtime.ledger.funding_complete)


if __name__ == "__main__":
    unittest.main()
