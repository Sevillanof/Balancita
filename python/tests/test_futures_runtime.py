import json
import unittest
from decimal import Decimal, localcontext

from balancita_engine.futures_runtime import FuturesRuntime
from futures_runtime_fixtures import (
    CONFIG,
    INSTRUMENT,
    add_known_funding,
    valid_flat_market,
    warmed_market,
)


def runtime(checkpoint=None, instrument=INSTRUMENT):
    return FuturesRuntime(
        run_id="mock-run",
        config=CONFIG,
        instrument=instrument,
        checkpoint=checkpoint,
    )


def close_command(command_id):
    return {"type": "paper.close", "command_id": command_id}


def funding_observation_event(start_ms, known_at_ms, observation_id):
    return {
        "type": "funding_observation",
        "received_at_ms": known_at_ms,
        "known_at_ms": known_at_ms,
        "reception_order": 10_000,
        "observation": {
            "source": "versioned-local-mock.v1",
            "provider": "kraken",
            "product": "PF_XBTUSD",
            "field": "funding_rate",
            "raw_rate": "0",
            "unit": "usd_per_btc_per_hour",
            "effective_start_ms": start_ms,
            "effective_end_ms": start_ms + 3_600_000,
            "known_at_ms": known_at_ms,
            "received_seq": 10_000,
            "observation_id": observation_id,
            "sha256": "0" * 64,
            "semantic_version": "kraken-funding-normalization.v1",
            "predicted": False,
        },
    }


class FuturesRuntimeTests(unittest.TestCase):
    def test_known_zero_funding_observed_while_flat_survives_runtime_restore(self):
        config = dict(CONFIG)
        config.update(
            version="futures-runtime-risk.v1",
            daily_loss_fraction="0.01",
            execution_latency_ms=100,
            funding_policy_version="funding-separation.v1",
        )
        at_flat = warmed_market(21_600_000)
        at_flat["events"].append(
            funding_observation_event(21_600_000, 21_600_000, "flat-known-zero")
        )
        engine = FuturesRuntime(
            run_id="flat-funding-restore",
            config=config,
            instrument=INSTRUMENT,
        )

        output = engine.process(at_flat)

        self.assertEqual(output["position"]["quantity_btc"], "0")
        self.assertEqual(output["ledger"]["cash_usd"], "10000")
        self.assertEqual(output["ledger"]["fees_usd"], "0")
        self.assertTrue(output["ledger"]["funding_complete"])
        self.assertEqual(len(engine.ledger.funding_rates), 1)
        saved = json.loads(json.dumps(engine.checkpoint()))
        restored = FuturesRuntime(
            run_id="flat-funding-restore",
            config=config,
            instrument=INSTRUMENT,
            checkpoint=saved,
        )
        self.assertEqual(len(restored.ledger.funding_rates), 1)
        self.assertEqual(restored.ledger.funding_rates[0][1:], (21_600_000, 25_200_000, Decimal("0")))
        self.assertTrue(restored.ledger.funding_complete)

    def test_late_zero_funding_cannot_heal_a_gap_already_accrued_on_exposure(self):
        config = dict(CONFIG)
        config.update(version="futures-runtime-execution.v1", execution_latency_ms=100)
        engine = FuturesRuntime(
            run_id="late-zero-funding-gap",
            config=config,
            instrument=INSTRUMENT,
        )
        accepted = engine.process(warmed_market(21_600_000, breakout="long"))
        self.assertEqual(accepted["fills"], [])
        filled_market = warmed_market(21_600_100, book_size="0.005")
        book = next(event for event in filled_market["events"] if event["type"] == "book_snapshot")
        book.update(epoch="funding-gap", sequence=2)
        filled = engine.process(filled_market)
        self.assertEqual(filled["position"]["quantity_btc"], "0.005")

        uncovered = engine.process(warmed_market(21_600_101))
        self.assertFalse(uncovered["ledger"]["funding_complete"])
        late_market = warmed_market(21_600_102)
        late_market["events"].append(
            funding_observation_event(21_600_000, 21_600_102, "late-known-zero")
        )

        after_late_observation = engine.process(late_market)

        self.assertFalse(after_late_observation["ledger"]["funding_complete"])
        self.assertIsNone(after_late_observation["ledger"]["realized_net_complete"])
        self.assertEqual(engine.ledger.funding_rates, [])

    def test_strategy_diagnostics_count_actual_selector_cycles_and_proposals(self):
        strategy_config = dict(CONFIG)
        strategy_config["version"] = "futures-runtime-strategies.v1"
        engine = FuturesRuntime(
            run_id="diagnostic-run", config=strategy_config, instrument=INSTRUMENT
        )
        engine.process(warmed_market(21_600_000, breakout="long"))
        self.assertEqual(
            engine.get_diagnostics(),
            {"strategy_selection_cycles": 1, "strategy_evaluations": 4},
        )

        engine.process(valid_flat_market(21_600_001))
        self.assertEqual(
            engine.get_diagnostics(),
            {"strategy_selection_cycles": 1, "strategy_evaluations": 4},
        )

    def test_strategy_diagnostics_are_zero_when_runtime_does_not_select_strategies(self):
        engine = runtime()
        engine.process(warmed_market(21_600_000, breakout="long"))
        self.assertEqual(
            engine.get_diagnostics(),
            {"strategy_selection_cycles": 0, "strategy_evaluations": 0},
        )

    def test_execution_runtime_routes_strategy_entry_through_causal_adapter_and_ledger(self):
        execution_config = dict(CONFIG)
        execution_config.update(
            version="futures-runtime-execution.v1", execution_latency_ms=100
        )
        engine = FuturesRuntime(
            run_id="execution-flow", config=execution_config, instrument=INSTRUMENT
        )
        at_zero = warmed_market(21_600_000, breakout="long")
        initial = engine.process(at_zero)
        self.assertEqual(initial["fills"], [])
        self.assertEqual(initial["position"]["quantity_btc"], "0")
        self.assertEqual([event["type"] for event in initial["orders"]], ["order_accepted"])
        eligible = initial["orders"][0]["eligible_at_ms"]
        checkpoint = json.loads(json.dumps(engine.checkpoint()))
        engine = FuturesRuntime(
            run_id="execution-flow", config=execution_config,
            instrument=INSTRUMENT, checkpoint=checkpoint,
        )

        at_99 = warmed_market(21_600_099)
        at_99["events"] = [
            event for event in at_zero["events"] if event["type"] not in ("book_snapshot", "ticker")
        ] + [
            event for event in at_zero["events"] if event["type"] in ("book_snapshot", "ticker")
        ]
        at_99["events"][-2]["known_at_ms"] = 21_600_099
        at_99["events"][-2]["received_at_ms"] = 21_600_099
        at_99["events"][-1]["known_at_ms"] = 21_600_099
        at_99["events"][-1]["received_at_ms"] = 21_600_099
        still_pending = engine.process(at_99)
        self.assertEqual(still_pending["fills"], [])
        self.assertEqual(engine.checkpoint()["execution_checkpoint"]["orders"][initial["orders"][0]["order_id"]]["eligible_at_ms"], eligible)

        at_100 = warmed_market(21_600_100)
        book = next(event for event in at_100["events"] if event["type"] == "book_snapshot")
        book.update(epoch="feed-1", sequence=2, snapshot_id="book-100", revision="2")
        filled = engine.process(at_100)
        self.assertEqual(len(filled["fills"]), 1)
        self.assertEqual(filled["fills"][0]["event_time_ms"], eligible)
        self.assertEqual(filled["position"]["quantity_btc"], filled["fills"][0]["quantity_btc"])
        self.assertEqual(filled["ledger"]["fees_usd"], filled["fills"][0]["fee_usd"])

        close_pending = engine.process(
            warmed_market(21_600_100, base_price="100100"),
            control=close_command("execution-close"),
        )
        self.assertEqual(close_pending["fills"], [])
        self.assertEqual(close_pending["position"]["quantity_btc"], filled["position"]["quantity_btc"])
        close_eligible = close_pending["orders"][-1]["eligible_at_ms"]
        close_checkpoint = json.loads(json.dumps(engine.checkpoint()))
        engine = FuturesRuntime(
            run_id="execution-flow", config=execution_config,
            instrument=INSTRUMENT, checkpoint=close_checkpoint,
        )
        close_market = warmed_market(close_eligible, base_price="100100")
        close_book = next(event for event in close_market["events"] if event["type"] == "book_snapshot")
        close_book.update(epoch="feed-1", sequence=3, snapshot_id="book-close", revision="3")
        closed = engine.process(close_market)
        self.assertEqual(closed["position"]["quantity_btc"], "0")
        self.assertEqual(closed["fills"][0]["action"], "sell")
        self.assertEqual(closed["owner_strategy_id"] if "owner_strategy_id" in closed else engine.checkpoint()["owner_strategy_id"], None)

    def test_execution_runtime_revision_owns_adapter_checkpoint_and_default_latency(self):
        execution_config = dict(CONFIG)
        execution_config.update(
            version="futures-runtime-execution.v1",
            execution_latency_ms=100,
        )
        engine = FuturesRuntime(
            run_id="execution-run", config=execution_config, instrument=INSTRUMENT
        )
        saved = engine.checkpoint()

        self.assertEqual(saved["schema_version"], 3)
        self.assertEqual(
            saved["execution_checkpoint"]["model_version"], "paper-execution.v1"
        )
        self.assertEqual(saved["execution_checkpoint"]["config"]["latency_ms"], 100)
        altered = json.loads(json.dumps(saved))
        altered["execution_checkpoint"]["config"]["latency_ms"] = 0
        with self.assertRaises(ValueError):
            FuturesRuntime(
                run_id="execution-run",
                config=execution_config,
                instrument=INSTRUMENT,
                checkpoint=altered,
            )
        restored = FuturesRuntime(
            run_id="execution-run",
            config=execution_config,
            instrument=INSTRUMENT,
            checkpoint=json.loads(json.dumps(saved)),
        )
        self.assertEqual(restored.checkpoint(), saved)

    def test_versioned_strategy_runtime_persists_registry_proposals_and_owner(self):
        strategy_config = dict(CONFIG)
        strategy_config["version"] = "futures-runtime-strategies.v1"
        engine = FuturesRuntime(
            run_id="strategy-run",
            config=strategy_config,
            instrument=INSTRUMENT,
        )
        market = warmed_market(21_600_000, breakout="long")

        opened = engine.process(market)

        self.assertEqual(
            [item["strategy_id"] for item in opened["analysis"]["proposals"]],
            [
                "c25-pullback-perp-v1",
                "c26-reversion-perp-v1",
                "c27-breakout-perp-v1",
                "c28-adapter-perp-v1",
            ],
        )
        self.assertEqual(opened["analysis"]["selector"]["action"], "LONG")
        self.assertEqual(opened["position"]["owner_strategy_id"], "c27-breakout-perp-v1")

        saved = engine.checkpoint()
        restored = FuturesRuntime(
            run_id="strategy-run",
            config=strategy_config,
            instrument=INSTRUMENT,
            checkpoint=json.loads(json.dumps(saved)),
        )
        regime_changed = warmed_market(21_660_000, base_price="100100")
        held = restored.process(regime_changed)
        self.assertEqual(held["position"]["owner_strategy_id"], "c27-breakout-perp-v1")
        self.assertEqual(held["analysis"]["selected_strategy_id"], "c27-breakout-perp-v1")
        self.assertEqual(restored.checkpoint()["regime"], saved["regime"])

        closed = restored.process(
            warmed_market(21_720_000, base_price="100100"),
            control=close_command("close-owned-strategy"),
        )
        self.assertEqual(closed["position"]["quantity_btc"], "0")
        self.assertIsNone(restored.checkpoint()["owner_strategy_id"])

    def test_actual_ohlc_c26_signal_reaches_selector_and_owns_proposed_levels(self):
        strategy_config = dict(CONFIG)
        strategy_config["version"] = "futures-runtime-strategies.v1"
        market = warmed_market(21_600_000)
        one_minute = [
            event
            for event in market["events"]
            if event["type"] == "candle" and event["interval_ms"] == 60_000
        ]
        closes = [101_000 + (index % 5) * 10 for index in range(58)]
        closes.extend([99_500, 100_300])
        for event, close in zip(one_minute, closes):
            event.update(
                open=str(close),
                high=str(close + 100),
                low=str(close - 100),
                close=str(close),
            )

        opened = FuturesRuntime(
            run_id="actual-c26-run",
            config=strategy_config,
            instrument=INSTRUMENT,
        ).process(market)

        c26 = opened["analysis"]["proposals"][1]
        self.assertEqual(c26["strategy_id"], "c26-reversion-perp-v1")
        self.assertEqual(c26["action"], "LONG")
        self.assertEqual(opened["analysis"]["selector"]["strategy_id"], c26["strategy_id"])
        self.assertEqual(opened["position"]["owner_strategy_id"], c26["strategy_id"])
        self.assertEqual(opened["position"]["stop_price_usd_per_btc"], c26["proposed_stop"])
        self.assertEqual(opened["position"]["target_price_usd_per_btc"], c26["proposed_target"])

        short_market = warmed_market(21_600_000)
        short_bars = [
            event
            for event in short_market["events"]
            if event["type"] == "candle" and event["interval_ms"] == 60_000
        ]
        for event, close in zip(short_bars, closes):
            mirror = 200_000 - close
            event.update(
                open=str(mirror),
                high=str(mirror + 100),
                low=str(mirror - 100),
                close=str(mirror),
            )
        short_opened = FuturesRuntime(
            run_id="actual-c26-short-run",
            config=strategy_config,
            instrument=INSTRUMENT,
        ).process(short_market)
        short_c26 = short_opened["analysis"]["proposals"][1]
        self.assertEqual(short_c26["action"], "SHORT")
        self.assertEqual(short_opened["analysis"]["selector"]["strategy_id"], short_c26["strategy_id"])
        self.assertEqual(short_opened["position"]["owner_strategy_id"], short_c26["strategy_id"])
        self.assertEqual(short_opened["position"]["stop_price_usd_per_btc"], short_c26["proposed_stop"])
        self.assertEqual(short_opened["position"]["target_price_usd_per_btc"], short_c26["proposed_target"])

    def test_actual_ohlc_c25_pullback_opens_with_engine_calculated_protection(self):
        strategy_config = dict(CONFIG)
        strategy_config["version"] = "futures-runtime-strategies.v1"
        market = warmed_market(21_600_000)
        closes = [
            99000, 99100, 99150, 99250, 99300, 99250, 99150, 99250, 99350, 99330,
            99280, 99230, 99210, 99260, 99280, 99230, 99130, 99150, 99250, 99230,
            99210, 99260, 99280, 99180, 99160, 99260, 99310, 99410, 99430, 99480,
            99460, 99480, 99380, 99280, 99230, 99250, 99230, 99180, 99200, 99100,
            99120, 99170, 99150, 99050, 99100, 99000, 98900, 99000, 98950, 99000,
            99050, 98950, 98900, 98850, 98900, 98880, 98830, 98810, 98710, 99010,
        ]
        one_minute = [
            event
            for event in market["events"]
            if event["type"] == "candle" and event["interval_ms"] == 60_000
        ]
        for event, value in zip(one_minute, closes):
            close = value + 1000
            event.update(
                open=str(close),
                high=str(close + 100),
                low=str(close - 100),
                close=str(close),
            )
        five_minute = [
            event
            for event in market["events"]
            if event["type"] == "candle" and event["interval_ms"] == 300_000
        ]
        for index, event in enumerate(five_minute):
            close = 99_000 + index * 50
            event.update(
                open=str(close),
                high=str(close + 100),
                low=str(close - 100),
                close=str(close),
            )

        opened = FuturesRuntime(
            run_id="actual-c25-run",
            config=strategy_config,
            instrument=INSTRUMENT,
        ).process(market)

        c25 = opened["analysis"]["proposals"][0]
        self.assertEqual(c25["action"], "LONG")
        self.assertEqual(c25["reason_code"], "c25_long_pullback")
        self.assertEqual(opened["analysis"]["selector"]["strategy_id"], c25["strategy_id"])
        self.assertEqual(opened["position"]["owner_strategy_id"], c25["strategy_id"])
        self.assertEqual(opened["position"]["stop_price_usd_per_btc"], c25["proposed_stop"])
        self.assertEqual(opened["position"]["target_price_usd_per_btc"], c25["proposed_target"])

        short_market = warmed_market(21_600_000)
        short_one_minute = [
            event
            for event in short_market["events"]
            if event["type"] == "candle" and event["interval_ms"] == 60_000
        ]
        for event, value in zip(short_one_minute, closes):
            close = 200_000 - (value + 1000)
            event.update(
                open=str(close),
                high=str(close + 100),
                low=str(close - 100),
                close=str(close),
            )
        short_five_minute = [
            event
            for event in short_market["events"]
            if event["type"] == "candle" and event["interval_ms"] == 300_000
        ]
        for index, event in enumerate(short_five_minute):
            close = 200_000 - (99_000 + index * 50)
            event.update(
                open=str(close),
                high=str(close + 100),
                low=str(close - 100),
                close=str(close),
            )
        short_opened = FuturesRuntime(
            run_id="actual-c25-short-run",
            config=strategy_config,
            instrument=INSTRUMENT,
        ).process(short_market)
        short_c25 = short_opened["analysis"]["proposals"][0]
        self.assertEqual(short_c25["action"], "SHORT")
        self.assertEqual(short_c25["reason_code"], "c25_short_pullback")
        self.assertEqual(short_opened["analysis"]["selector"]["strategy_id"], short_c25["strategy_id"])
        self.assertEqual(short_opened["position"]["owner_strategy_id"], short_c25["strategy_id"])
        self.assertEqual(short_opened["position"]["stop_price_usd_per_btc"], short_c25["proposed_stop"])
        self.assertEqual(short_opened["position"]["target_price_usd_per_btc"], short_c25["proposed_target"])

    def test_c27_long_and_short_market_to_fill_and_explicit_executable_close(self):
        for side, base, exit_base in (
            ("long", "100000", "100500"),
            ("short", "100000", "99500"),
        ):
            with self.subTest(side=side):
                cutoff = 21_600_000
                first_market = add_known_funding(
                    warmed_market(cutoff, breakout=side), rate="0"
                )
                engine = runtime()
                opened = engine.process(first_market)
                self.assertTrue(
                    opened["analysis"]["selected_strategy_id"].endswith("-perp-v1")
                )
                self.assertIn("c27", opened["analysis"]["selected_strategy_id"].lower())
                self.assertIn("breakout", opened["analysis"]["selected_strategy_id"].lower())
                self.assertEqual(opened["analysis"]["action"], side)
                self.assertEqual(opened["risk"]["status"], "accepted")
                self.assertTrue(opened["fills"])
                self.assertEqual(opened["position"]["owner_strategy_id"], opened["analysis"]["selected_strategy_id"])
                entry_fill = opened["fills"][0]
                expected_cost = (
                    Decimal(entry_fill["quantity_btc"])
                    * Decimal(entry_fill["price_usd_per_btc"])
                    * (Decimal("2") * Decimal(CONFIG["taker_rate"]) + Decimal("0.0002"))
                )
                self.assertEqual(
                    Decimal(opened["risk"]["estimated_round_trip_cost_usd"]),
                    expected_cost,
                )
                self.assertGreaterEqual(
                    Decimal(opened["position"]["quantity_btc"]), Decimal("0.0001")
                )

                close_market = add_known_funding(
                    warmed_market(cutoff + 60_000, base_price=exit_base),
                    rate="0",
                )
                closed = engine.process(
                    close_market,
                    control=close_command("close-" + side),
                )
                self.assertEqual(closed["position"]["quantity_btc"], "0")
                self.assertEqual(len(closed["fills"]), 1)

                entry = next(event for event in opened["fills"] if event["side"] == side)
                exit_fill = closed["fills"][0]
                quantity = Decimal(entry["quantity_btc"])
                entry_price = Decimal(entry["price_usd_per_btc"])
                exit_price = Decimal(exit_fill["price_usd_per_btc"])
                direction = Decimal("1") if side == "long" else Decimal("-1")
                gross = direction * quantity * (exit_price - entry_price)
                entry_fee = quantity * entry_price * Decimal("0.0005")
                exit_fee = quantity * exit_price * Decimal("0.0005")
                self.assertEqual(
                    Decimal(closed["ledger"]["realized_gross_usd"]), gross
                )
                self.assertEqual(
                    Decimal(closed["ledger"]["fees_usd"]), entry_fee + exit_fee
                )
                self.assertTrue(closed["ledger"]["funding_complete"])
                self.assertEqual(
                    Decimal(closed["ledger"]["realized_net_complete"]),
                    gross - entry_fee - exit_fee,
                )

    def test_wait_guards_flat_zero_atr_warmup_stale_gap_metadata_spread_and_late_data(self):
        cutoff = 21_600_000
        flat = valid_flat_market(cutoff)
        warmup = warmed_market(cutoff, breakout="long")
        one_minute_bars = [
            event
            for event in warmup["events"]
            if event["type"] == "candle" and event["interval_ms"] == 60_000
        ]
        warmup["events"] = [
            event
            for event in warmup["events"]
            if event not in one_minute_bars[:-6]
        ]
        stale = warmed_market(cutoff)
        for event in stale["events"]:
            if event["type"] in ("book_snapshot", "ticker"):
                event["event_time_ms"] = cutoff - CONFIG["max_book_age_ms"] - 1
                event["received_at_ms"] = event["event_time_ms"]
                event["known_at_ms"] = event["received_at_ms"]
        gap = warmed_market(cutoff)
        next(event for event in gap["events"] if event["type"] == "book_snapshot")["contiguous"] = False
        missing_metadata = warmed_market(cutoff)
        del missing_metadata["instrument"]
        excessive_spread = warmed_market(cutoff, spread="51")
        late = warmed_market(cutoff)
        late["events"].append(
            {
                **next(
                    event
                    for event in late["events"]
                    if event["type"] == "candle" and event["interval_ms"] == 60_000
                ),
                "known_at_ms": cutoff + 1,
                "received_at_ms": cutoff + 1,
                "close": "100100",
                "high": "100101",
                "reception_order": 10_000,
            }
        )
        future_book = warmed_market(cutoff, breakout="long")
        for event in future_book["events"]:
            if event["type"] in ("book_snapshot", "ticker"):
                event["event_time_ms"] = cutoff + 1
        invalid_ticker = warmed_market(cutoff, breakout="long")
        ticker = next(event for event in invalid_ticker["events"] if event["type"] == "ticker")
        del ticker["mark_usd"]
        cases = (
            (runtime(), flat, "flat zero-volatility bars abstain"),
            (runtime(), warmup, "six 1m bars are insufficient warmup"),
            (runtime(), stale, "stale book and ticker"),
            (runtime(), gap, "book sequence gap"),
            (runtime(instrument=None), missing_metadata, "missing instrument metadata"),
            (runtime(), excessive_spread, "spread exceeds the frozen 5 bps limit"),
            (runtime(), late, "post-cutoff candle correction is unavailable"),
            (runtime(), future_book, "future event-time book and ticker"),
            (runtime(), invalid_ticker, "ticker without observed mark"),
        )
        for engine, market, label in cases:
            with self.subTest(guard=label):
                outcome = engine.process(market)
                self.assertEqual(outcome["analysis"]["action"], "WAIT")
                self.assertEqual(outcome["orders"], [])
                self.assertEqual(outcome["fills"], [])

    def test_c27_volume_breakout_obeys_tick_lot_partial_depth_and_no_reuse(self):
        market = warmed_market(21_600_000, breakout="long", book_size="0.005")
        engine = runtime()
        first = engine.process(market)
        filled = sum(
            (Decimal(fill["quantity_btc"]) for fill in first["fills"]), Decimal("0")
        )
        self.assertEqual(filled, Decimal("0.005"))
        for fill in first["fills"]:
            self.assertEqual(
                Decimal(fill["quantity_btc"]) % Decimal(INSTRUMENT["quantity_step_btc"]),
                Decimal("0"),
            )
            self.assertEqual(
                Decimal(fill["price_usd_per_btc"]) % Decimal(INSTRUMENT["price_tick_usd"]),
                Decimal("0"),
            )
        replayed = engine.process(market)
        self.assertEqual(replayed["fills"], [])
        self.assertEqual(replayed["position"]["quantity_btc"], "0.005")

    def test_funding_known_zero_positive_negative_and_unknown_are_distinct(self):
        cutoff = 21_600_000
        cases = (
            ("long", "2", 1),
            ("short", "2", -1),
            ("long", "-2", 1),
            ("short", "-2", -1),
        )
        for side, rate, sign in cases:
            with self.subTest(side=side, rate=rate):
                engine = runtime()
                opened = engine.process(
                    add_known_funding(warmed_market(cutoff, breakout=side), rate=rate)
                )
                quantity = Decimal(opened["position"]["quantity_btc"])
                elapsed_ms = 60_000
                with localcontext() as context:
                    context.prec = 50
                    expected = (
                        Decimal(rate)
                        * quantity
                        * Decimal(elapsed_ms)
                        / Decimal(3_600_000)
                        * Decimal(sign)
                    )
                closed = engine.process(
                    add_known_funding(
                        warmed_market(cutoff + elapsed_ms, base_price="100500" if side == "long" else "99500"),
                        rate=rate,
                    ),
                    control=close_command("funding-" + side + rate),
                )
                with localcontext() as context:
                    context.prec = 60
                    self.assertEqual(
                        Decimal(closed["ledger"]["funding_paid"]).quantize(
                            Decimal("1e-45")
                        ),
                        expected.quantize(Decimal("1e-45")),
                    )
                self.assertTrue(closed["ledger"]["funding_complete"])

        zero_engine = runtime()
        zero_open = zero_engine.process(
            add_known_funding(warmed_market(cutoff, breakout="long"), rate="0")
        )
        zero_close = zero_engine.process(
            add_known_funding(warmed_market(cutoff + 60_000, base_price="100500"), rate="0"),
            control=close_command("known-zero"),
        )
        self.assertGreater(Decimal(zero_open["position"]["quantity_btc"]), 0)
        self.assertTrue(zero_close["ledger"]["funding_complete"])
        self.assertEqual(Decimal(zero_close["ledger"]["funding_paid"]), 0)

        unknown_engine = runtime()
        unknown_engine.process(warmed_market(cutoff, breakout="long"))
        unknown_close = unknown_engine.process(
            warmed_market(cutoff + 60_000, base_price="100500"),
            control=close_command("unknown-funding"),
        )
        self.assertFalse(unknown_close["ledger"]["funding_complete"])
        self.assertIsNone(unknown_close["ledger"]["realized_net_complete"])

    def test_checkpoint_restores_owner_funding_and_consumed_observation(self):
        market = add_known_funding(
            warmed_market(21_600_000, breakout="long", book_size="0.005"), rate="1"
        )
        original = runtime()
        before_restart = original.process(market)
        checkpoint = original.checkpoint()
        json.dumps(checkpoint, allow_nan=False)
        restored = runtime(checkpoint=checkpoint)
        repeated = restored.process(market)
        self.assertEqual(repeated["fills"], [])
        self.assertEqual(repeated["position"], before_restart["position"])
        self.assertEqual(
            restored.checkpoint()["funding_cursor_ms"],
            original.checkpoint()["funding_cursor_ms"],
        )
        self.assertEqual(
            restored.checkpoint()["consumed_depth"],
            original.checkpoint()["consumed_depth"],
        )

    def test_c27_signal_deduplication_is_scoped_to_breakout_candle(self):
        cutoff = 21_600_000
        engine = runtime()
        first = engine.process(warmed_market(cutoff, breakout="long"))
        repeated = engine.process(warmed_market(cutoff, breakout="long"))
        self.assertTrue(first["fills"])
        self.assertEqual(repeated["fills"], [])

        engine.process(
            warmed_market(cutoff + 60_000, base_price="100500"),
            control=close_command("close-first-breakout"),
        )
        next_candle = engine.process(
            warmed_market(cutoff + 120_000, breakout="long")
        )
        self.assertEqual(next_candle["analysis"]["action"], "long")
        self.assertTrue(next_candle["fills"])

    def test_checkpoint_rejects_runtime_configuration_or_instrument_drift(self):
        engine = runtime()
        engine.process(warmed_market(21_600_000, breakout="long"))
        checkpoint = engine.checkpoint()

        changed_config = dict(checkpoint)
        changed_config["runtime_config"] = dict(CONFIG)
        changed_config["runtime_config"]["risk_fraction"] = "0.5"
        with self.assertRaises(ValueError):
            runtime(checkpoint=changed_config)

        changed_instrument = dict(checkpoint)
        changed_instrument["instrument_spec"] = dict(INSTRUMENT)
        changed_instrument["instrument_spec"]["price_tick_usd"] = "0.5"
        with self.assertRaises(ValueError):
            runtime(checkpoint=changed_instrument)


if __name__ == "__main__":
    unittest.main()
