import unittest
from copy import deepcopy

from balancita_engine.futures_runtime import FuturesRuntime
from futures_runtime_fixtures import CONFIG, INSTRUMENT, valid_flat_market, warmed_market

BASE_TIME = 21_600_000


def runtime_config(*, cadence=True, latency=100):
    config = dict(CONFIG)
    config.update(
        version="futures-runtime-risk.v1",
        daily_loss_fraction="0.01",
        execution_latency_ms=latency,
    )
    if cadence:
        config.update(
            strategy_selection_policy_version="strategy-selection-cadence.v1",
            strategy_selection_interval_ms=5000,
        )
    return config


def active_market(time_ms, *, sequence, bid, ask, mark, quantity="0.005", breakout=False):
    market = warmed_market(
        time_ms,
        breakout="long" if breakout else None,
        book_size=quantity,
        base_price=str(mark),
    )
    book = next(event for event in market["events"] if event["type"] == "book_snapshot")
    book.update(
        epoch="feed-1",
        sequence=sequence,
        snapshot_id="book-{}".format(sequence),
        revision=str(sequence),
        bids=[{"price_usd": str(bid), "quantity_btc": quantity}],
        asks=[{"price_usd": str(ask), "quantity_btc": quantity}],
    )
    ticker = next(event for event in market["events"] if event["type"] == "ticker")
    ticker["mark_usd"] = str(mark)
    return market


class FuturesStrategyCadenceTests(unittest.TestCase):
    def test_opted_in_selection_waits_for_five_second_boundary(self):
        config = runtime_config()
        engine = FuturesRuntime(
            run_id="cadence-run", config=config, instrument=INSTRUMENT
        )

        engine.process(valid_flat_market(BASE_TIME))
        self.assertEqual(
            engine.get_diagnostics(),
            {"strategy_selection_cycles": 1, "strategy_evaluations": 4},
        )
        intermediate = engine.process(valid_flat_market(BASE_TIME + 100))
        self.assertEqual(
            engine.get_diagnostics(),
            {"strategy_selection_cycles": 0, "strategy_evaluations": 0},
        )
        self.assertEqual(intermediate["analysis"]["as_of_ms"], BASE_TIME)
        engine.process(valid_flat_market(BASE_TIME + 5000))
        self.assertEqual(
            engine.get_diagnostics(),
            {"strategy_selection_cycles": 1, "strategy_evaluations": 4},
        )

    def test_active_partial_fill_stop_and_restart_preserve_financial_path(self):
        config = runtime_config()
        continuous = FuturesRuntime(
            run_id="active-cadence-run", config=config, instrument=INSTRUMENT
        )
        initial = continuous.process(
            active_market(
                BASE_TIME, sequence=1, bid=100000, ask=100001, mark=100000,
                breakout=True,
            )
        )
        self.assertEqual(initial["risk"]["status"], "accepted")
        self.assertEqual(initial["orders"][0]["type"], "order_accepted")
        self.assertEqual(initial["analysis"]["selector"]["strategy_id"], "c27-breakout-perp-v1")
        self.assertEqual(
            continuous.get_diagnostics(),
            {"strategy_selection_cycles": 1, "strategy_evaluations": 4},
        )

        partial_market = active_market(
            BASE_TIME + 100, sequence=2, bid=100000, ask=100001, mark=100000
        )
        partial = continuous.process(partial_market)
        self.assertEqual(partial["fills"][0]["quantity_btc"], "0.005")
        self.assertEqual(partial["orders"][0]["type"], "cancelled")
        self.assertEqual(partial["position"]["quantity_btc"], "0.005")
        self.assertEqual(partial["analysis"]["as_of_ms"], BASE_TIME)
        self.assertEqual(
            continuous.get_diagnostics(),
            {"strategy_selection_cycles": 0, "strategy_evaluations": 0},
        )
        checkpoint = deepcopy(continuous.checkpoint())
        self.assertEqual(checkpoint["owner_strategy_id"], "c27-breakout-perp-v1")
        self.assertEqual(checkpoint["position_protection"]["stop"], "99949")
        self.assertEqual(
            checkpoint["strategy_selection_checkpoint"],
            {
                "policy_version": "strategy-selection-cadence.v1",
                "interval_ms": 5000,
                "run_id": "active-cadence-run",
                "instrument_id": INSTRUMENT["instrument_id"],
                "last_selection_ms": BASE_TIME,
                "next_selection_due_ms": BASE_TIME + 5000,
                "context": {
                    **checkpoint["strategy_selection_checkpoint"]["context"],
                    "as_of_ms": BASE_TIME,
                },
            },
        )
        restored = FuturesRuntime(
            run_id="active-cadence-run", config=config, instrument=INSTRUMENT,
            checkpoint=checkpoint,
        )
        self.assertEqual(restored.checkpoint(), checkpoint)

        stop_result = None
        for time_ms, sequence, bid, ask, mark in (
            (BASE_TIME + 101, 3, 99900, 99901, 99900),
            (BASE_TIME + 102, 4, 100000, 100001, 100000),
            (BASE_TIME + 5000, 5, 100000, 100001, 100000),
        ):
            market = active_market(
                time_ms, sequence=sequence, bid=bid, ask=ask, mark=mark
            )
            continuous_result = continuous.process(market)
            restored_result = restored.process(deepcopy(market))
            self.assertEqual(restored_result, continuous_result)
            self.assertEqual(restored.checkpoint(), continuous.checkpoint())
            self.assertEqual(restored.get_diagnostics(), continuous.get_diagnostics())
            if time_ms < BASE_TIME + 5000:
                self.assertEqual(
                    restored.get_diagnostics(),
                    {"strategy_selection_cycles": 0, "strategy_evaluations": 0},
                )
            if time_ms == BASE_TIME + 101:
                stop_result = continuous_result
                self.assertEqual(stop_result["position"]["quantity_btc"], "0.005")
                self.assertEqual(stop_result["position"]["mark_usd_per_btc"], "99900")
                self.assertEqual(stop_result["orders"][0]["order_type"], "reduce_only")
                self.assertEqual(stop_result["orders"][0]["decision_at_ms"], BASE_TIME + 101)
            if time_ms == BASE_TIME + 102:
                self.assertEqual(continuous_result["position"]["quantity_btc"], "0.005")
                self.assertEqual(continuous_result["position"]["mark_usd_per_btc"], "100000")
                self.assertEqual(continuous_result["orders"], [])
        stop_order = next(
            order for order in stop_result["orders"]
            if order.get("order_type") == "reduce_only"
        )
        self.assertEqual(stop_order["decision_at_ms"], BASE_TIME + 101)
        self.assertEqual(continuous_result["fills"][0]["quantity_btc"], "0.005")
        self.assertEqual(continuous_result["fills"][0]["price_usd_per_btc"], "100000")
        self.assertEqual(continuous_result["position"]["quantity_btc"], "0")
        self.assertEqual(continuous_result["ledger"]["fees_usd"], "0.5000025")
        self.assertEqual(continuous_result["ledger"]["realized_gross_usd"], "-0.005")
        self.assertEqual(
            continuous.get_diagnostics(),
            {"strategy_selection_cycles": 1, "strategy_evaluations": 4},
        )

    def test_legacy_config_still_selects_on_each_financial_call(self):
        engine = FuturesRuntime(
            run_id="legacy-cadence-run", config=runtime_config(cadence=False),
            instrument=INSTRUMENT,
        )
        engine.process(valid_flat_market(BASE_TIME))
        result = engine.process(valid_flat_market(BASE_TIME + 100))
        self.assertEqual(
            engine.get_diagnostics(),
            {"strategy_selection_cycles": 1, "strategy_evaluations": 4},
        )
        self.assertNotIn("as_of_ms", result["analysis"])

    def test_cadence_checkpoint_rejects_missing_or_incoherent_policy_cache(self):
        config = runtime_config()
        engine = FuturesRuntime(run_id="invalid-cadence", config=config, instrument=INSTRUMENT)
        engine.process(valid_flat_market(BASE_TIME))
        checkpoint = engine.checkpoint()
        for corrupt in ("missing", "clock", "cache", "forged-selector"):
            malformed = deepcopy(checkpoint)
            if corrupt == "missing":
                del malformed["strategy_selection_checkpoint"]
            elif corrupt == "clock":
                malformed["strategy_selection_checkpoint"]["next_selection_due_ms"] += 1
            elif corrupt == "cache":
                malformed["strategy_selection_checkpoint"]["context"]["as_of_ms"] += 1
            else:
                malformed["strategy_selection_checkpoint"]["context"]["selector"] = {
                    "action": "LONG",
                    "strategy_id": "c27-breakout-perp-v1",
                    "signal_key": "forged-signal",
                }
            with self.subTest(corrupt=corrupt), self.assertRaises(ValueError):
                FuturesRuntime(
                    run_id="invalid-cadence", config=config, instrument=INSTRUMENT,
                    checkpoint=malformed,
                )


if __name__ == "__main__":
    unittest.main()
