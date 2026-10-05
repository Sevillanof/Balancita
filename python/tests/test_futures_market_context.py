import json
import unittest

from balancita_engine.futures_runtime import FuturesRuntime
from futures_runtime_fixtures import CONFIG, INSTRUMENT


class FuturesMarketContextContractTests(unittest.TestCase):
    def test_accepted_control_can_reuse_context_without_advancing_frontier(self):
        config = dict(CONFIG)
        config.update(
            version="futures-runtime-risk.v1",
            daily_loss_fraction="0.01",
            market_context_policy_version="market-context-transport.v1",
        )
        runtime = FuturesRuntime(
            run_id="market-context-control",
            config=config,
            instrument=INSTRUMENT,
        )
        identity = "b" * 64
        first_event = {
            "type": "context_probe",
            "source_receipt_sequence": 1,
            "received_at_ms": 1000,
            "known_at_ms": 1000,
        }
        initial = {
            "schema_version": "market-context-transport.v1",
            "source_identity": identity,
            "instrument_id": INSTRUMENT["instrument_id"],
            "previous_frontier": 0,
            "current_frontier": 1,
            "knowledge_cutoff_ms": 1000,
            "bootstrap_events": [],
            "delta_events": [first_event],
        }
        runtime.process({
            "mode": "paper_live", "instrument": INSTRUMENT,
            "decision_time_ms": 1000, "cutoff_received_at_ms": 1000,
            "events": [first_event], "market_context": initial,
        })
        unchanged = {**initial, "previous_frontier": 1, "delta_events": [],
                     "knowledge_cutoff_ms": 2000}
        runtime.process({
            "mode": "paper_live", "instrument": INSTRUMENT,
            "decision_time_ms": 2000, "cutoff_received_at_ms": 2000,
            "events": [], "market_context": unchanged,
        }, control={"type": "paper.pause", "command_id": "pause-1"})
        self.assertEqual(runtime.checkpoint()["market_context_checkpoint"]["frontier"], 1)
        self.assertTrue(runtime.risk_state["user_paused"])

    def test_opt_in_policy_is_bound_into_checkpoint_and_rejects_unmarked_restore(self):
        config = dict(CONFIG)
        config.update(
            version="futures-runtime-risk.v1",
            daily_loss_fraction="0.01",
            market_context_policy_version="market-context-transport.v1",
        )
        runtime = FuturesRuntime(
            run_id="market-context-contract",
            config=config,
            instrument=INSTRUMENT,
        )

        event = {
            "type": "context_probe",
            "source_receipt_sequence": 1,
            "received_at_ms": 1000,
            "known_at_ms": 1000,
        }
        transport = {
            "schema_version": "market-context-transport.v1",
            "source_identity": "a" * 64,
            "instrument_id": INSTRUMENT["instrument_id"],
            "previous_frontier": 0,
            "current_frontier": 1,
            "knowledge_cutoff_ms": 1000,
            "bootstrap_events": [],
            "delta_events": [event],
        }
        market = {
            "mode": "mock",
            "instrument": INSTRUMENT,
            "decision_time_ms": 1000,
            "cutoff_received_at_ms": 1000,
            "events": [event],
            "market_context": transport,
        }
        runtime.process(market)

        checkpoint = json.loads(json.dumps(runtime.checkpoint()))
        self.assertEqual(
            set(transport),
            {
                "schema_version",
                "source_identity",
                "instrument_id",
                "previous_frontier",
                "current_frontier",
                "knowledge_cutoff_ms",
                "bootstrap_events",
                "delta_events",
            },
        )
        self.assertEqual(
            set(checkpoint["market_context_checkpoint"]),
            {
                "policy_version",
                "source_identity",
                "instrument_id",
                "frontier",
                "knowledge_cutoff_ms",
                "anchors",
            },
        )
        self.assertEqual(
            checkpoint["market_context_checkpoint"]["policy_version"],
            "market-context-transport.v1",
        )
        self.assertEqual(
            checkpoint["market_context_checkpoint"]["frontier"], 1
        )

        restored = FuturesRuntime(
            run_id="market-context-contract",
            config=config,
            instrument=INSTRUMENT,
            checkpoint=checkpoint,
        )
        self.assertEqual(restored._market_context_checkpoint["frontier"], 1)

        with self.assertRaisesRegex(ValueError, "configuration does not match"):
            FuturesRuntime(
                run_id="market-context-contract",
                config={key: value for key, value in config.items() if key != "market_context_policy_version"},
                instrument=INSTRUMENT,
                checkpoint=checkpoint,
            )

        unmarked_checkpoint = dict(checkpoint)
        unmarked_checkpoint.pop("market_context_checkpoint")
        with self.assertRaisesRegex(ValueError, "market context checkpoint policy"):
            FuturesRuntime(
                run_id="market-context-contract",
                config=config,
                instrument=INSTRUMENT,
                checkpoint=unmarked_checkpoint,
            )


if __name__ == "__main__":
    unittest.main()
