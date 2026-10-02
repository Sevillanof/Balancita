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


class FuturesRuntimeTests(unittest.TestCase):
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
