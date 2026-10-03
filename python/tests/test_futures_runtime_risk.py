import unittest
from decimal import Decimal

from balancita_engine.futures_runtime import FuturesRuntime
from futures_runtime_fixtures import CONFIG, INSTRUMENT, warmed_market


def risk_runtime(checkpoint=None):
    config = dict(CONFIG)
    config.update(
        version="futures-runtime-risk.v1",
        execution_latency_ms=100,
        daily_loss_fraction="0.01",
    )
    return FuturesRuntime(
        run_id="risk-run",
        config=config,
        instrument=INSTRUMENT,
        checkpoint=checkpoint,
    )


def open_position(engine):
    pending = engine.process(warmed_market(21_600_000, breakout="long"))
    filled = engine.process(warmed_market(21_600_100, base_price="100000"))
    if filled["position"]["quantity_btc"] == "0":
        raise AssertionError((pending, filled))
    return filled


class FuturesRuntimeRiskTests(unittest.TestCase):
    def test_paper_live_unknown_funding_is_blocked_without_synthetic_zero_funding(self):
        engine = risk_runtime()
        market = warmed_market(21_600_000, breakout='long')
        market['mode'] = 'paper_live'

        result = engine.process(market)

        self.assertEqual(result['position']['quantity_btc'], '0')
        self.assertEqual(result['fills'], [])
        self.assertIn('funding_unresolved', result['risk']['reason_codes'])

    def test_close_estimate_is_incomplete_for_partial_depth_and_marks_adverse_cost(self):
        engine = risk_runtime()
        open_position(engine)
        engine.ledger.funding_complete = True

        insufficient = engine._estimate_close_net(
            {"bids": [{"price_usd": "99000", "quantity_btc": "0.001"}]}
        )
        self.assertIsNone(insufficient)

        adverse = Decimal(
            engine._estimate_close_net(
                {"bids": [{"price_usd": "99000", "quantity_btc": "1"}]}
            )
        )
        reference = Decimal(
            engine._estimate_close_net(
                {"bids": [{"price_usd": "100000", "quantity_btc": "1"}]}
            )
        )
        self.assertEqual(adverse, Decimal("-10.89495495"))
        self.assertLess(adverse, reference)

    def test_unknown_funding_blocks_new_risk_but_does_not_disable_protection(self):
        flat = risk_runtime()
        flat.ledger.funding_complete = False
        denied = flat.process(warmed_market(21_600_000, breakout="long"))
        self.assertTrue(denied["risk"]["system_paused"])
        self.assertTrue(denied["risk"]["entry_paused"])
        self.assertEqual(denied["position"]["quantity_btc"], "0")
        self.assertIn("funding_incomplete", denied["risk"]["reason_codes"])

        active = risk_runtime()
        opened = open_position(active)
        active.ledger.funding_complete = False
        stop = Decimal(opened["position"]["stop_price_usd_per_btc"])
        gap = warmed_market(21_600_200, base_price="100000")
        ticker = next(event for event in gap["events"] if event["type"] == "ticker")
        ticker["mark_usd"] = str(stop - 1000)
        next(event for event in gap["events"] if event["type"] == "book_snapshot").update(
            valid=False, contiguous=False
        )
        protected = active.process(gap)
        self.assertTrue(protected["risk"]["system_paused"])
        self.assertIsNotNone(protected["risk"]["reduction_intent_id"])
        self.assertEqual(protected["position"]["quantity_btc"], opened["position"]["quantity_btc"])

    def test_target_and_clock_exit_remain_active_during_user_pause_without_new_bars(self):
        engine = risk_runtime()
        opened = open_position(engine)
        target = Decimal(opened["position"]["target_price_usd_per_btc"])
        target_market = warmed_market(21_600_200, base_price=str(target + 1000))
        target_market["events"] = [
            event for event in target_market["events"] if event["type"] != "candle"
        ]
        next(event for event in target_market["events"] if event["type"] == "book_snapshot").update(
            valid=False, contiguous=False
        )
        ticker = next(event for event in target_market["events"] if event["type"] == "ticker")
        ticker["mark_usd"] = str(target)
        target_result = engine.process(target_market, control={"type": "paper.pause"})
        self.assertTrue(engine.risk_state["user_paused"])
        self.assertEqual(target_result["orders"][-1]["order_type"], "reduce_only")

        clock_engine = risk_runtime()
        clock_opened = open_position(clock_engine)
        clock = warmed_market(23_400_100, base_price="100000")
        clock["events"] = [event for event in clock["events"] if event["type"] != "candle"]
        timed = clock_engine.process(clock, control={"type": "paper.pause"})
        self.assertEqual(timed["position"]["quantity_btc"], "0.0099")
        self.assertEqual(timed["orders"][-1]["order_type"], "reduce_only")
        self.assertTrue(clock_engine.risk_state["user_paused"])
        self.assertEqual(clock_opened["position"]["side"], "long")

    def test_partial_ioc_entry_remainder_is_cancelled_and_cannot_flip_position(self):
        engine = risk_runtime()
        engine.process(warmed_market(21_600_000, breakout="long", book_size="0.005"))
        filled = engine.process(warmed_market(21_600_100, book_size="0.005"))
        self.assertEqual(filled["position"]["quantity_btc"], "0.005")
        entries = [
            order for order in engine.execution_adapter.orders.values()
            if engine.execution_metadata[order["intent"]["order_id"]]["purpose"] == "entry"
        ]
        self.assertEqual(entries[0]["state"], "cancelled")
        self.assertEqual(entries[0]["remaining"], "0.0049")

        opposite = engine.process(warmed_market(21_600_200, breakout="short"))
        self.assertEqual(opposite["position"]["side"], "long")
        self.assertEqual(opposite["position"]["quantity_btc"], "0.005")
        self.assertFalse(any(order.get("order_type") == "market_ioc" for order in opposite["orders"]))

    def test_pending_reduction_coalesces_exit_reasons_and_close_fill_cannot_flip(self):
        engine = risk_runtime()
        opened = open_position(engine)
        stop = Decimal(opened["position"]["stop_price_usd_per_btc"])
        trigger = warmed_market(21_600_200, base_price="100000")
        ticker = next(event for event in trigger["events"] if event["type"] == "ticker")
        ticker["mark_usd"] = str(stop - 1)
        next(event for event in trigger["events"] if event["type"] == "book_snapshot").update(
            valid=False, contiguous=False
        )
        first = engine.process(trigger)
        intent_id = first["risk"]["reduction_intent_id"]

        target = warmed_market(21_600_250, base_price="100000")
        ticker = next(event for event in target["events"] if event["type"] == "ticker")
        ticker["mark_usd"] = opened["position"]["target_price_usd_per_btc"]
        next(event for event in target["events"] if event["type"] == "book_snapshot").update(
            valid=False, contiguous=False
        )
        coalesced = engine.process(target)
        self.assertEqual(coalesced["risk"]["reduction_intent_id"], intent_id)
        pending_closes = [
            order for order_id, order in engine.execution_adapter.orders.items()
            if engine.execution_metadata[order_id]["purpose"] == "close"
            and order["state"] in ("accepted", "partially_filled")
        ]
        self.assertEqual(len(pending_closes), 1)

        recovered = engine.process(warmed_market(21_600_300, breakout="short"))
        self.assertEqual(recovered["position"]["quantity_btc"], "0")
        self.assertFalse(any(order.get("order_type") == "market_ioc" for order in recovered["orders"]))

    def test_owner_specific_invalidation_closes_c25_and_c26_while_paused(self):
        engine = risk_runtime()
        open_position(engine)
        engine.risk_state["user_paused"] = True
        engine.owner_strategy_id = "c25-pullback-perp-v1"
        engine.position_protection["strategy_invalidation"] = "close_below_ema21"
        self.assertEqual(
            engine._should_close(
                {"type": "paper.pause"},
                {"candidate_close": "99", "ema21": "100"},
                Decimal("100001"),
                21_600_100,
            ),
            (True, "owner_invalidation"),
        )
        self.assertEqual(
            engine._should_close(
                {"type": "paper.pause"},
                {"candidate_close": "99", "ema21": "100"},
                None,
                21_600_100,
            ),
            (True, "owner_invalidation"),
        )

        engine.owner_strategy_id = "c26-reversion-perp-v1"
        engine.position_protection["strategy_target"] = "100"
        engine.regime = "range"
        self.assertEqual(
            engine._should_close(
                {"type": "paper.pause"},
                {"candidate_close": "100"},
                Decimal("100001"),
                21_600_100,
            ),
            (True, "owner_invalidation"),
        )

    def test_stale_mark_cannot_trigger_protection_or_fabricate_a_reduction(self):
        engine = risk_runtime()
        opened = open_position(engine)
        stop = Decimal(opened["position"]["stop_price_usd_per_btc"])
        now = 21_600_200
        market = warmed_market(now, base_price=str(stop - 1000))
        market["events"] = [
            event for event in market["events"] if event["type"] != "candle"
        ]
        ticker = next(event for event in market["events"] if event["type"] == "ticker")
        ticker.update(
            mark_usd=str(stop - 1000),
            event_time_ms=now - 10_000,
            received_at_ms=now - 10_000,
            known_at_ms=now - 10_000,
        )
        result = engine.process(market)
        self.assertEqual(result["position"]["quantity_btc"], opened["position"]["quantity_btc"])
        self.assertIsNone(result["risk"]["reduction_intent_id"])
        self.assertEqual(result["risk"]["mark_quality"], "stale")

    def test_missing_mark_is_unknown_even_when_book_midpoint_is_available(self):
        engine = risk_runtime()
        opened = open_position(engine)
        market = warmed_market(21_600_200, base_price="100000")
        market["events"] = [event for event in market["events"] if event["type"] != "candle"]
        ticker = next(event for event in market["events"] if event["type"] == "ticker")
        ticker["mark_usd"] = None
        result = engine.process(market)
        self.assertEqual(result["risk"]["mark_quality"], "unknown")
        self.assertIsNone(result["risk"]["reduction_intent_id"])
        self.assertEqual(result["position"]["quantity_btc"], opened["position"]["quantity_btc"])

    def test_utc_rollover_preserves_pending_reduction_during_book_gap(self):
        engine = risk_runtime()
        open_position(engine)
        loss = warmed_market(21_600_200, base_price="88000")
        loss["events"] = [event for event in loss["events"] if event["type"] != "candle"]
        for event in loss["events"]:
            if event["type"] in ("ticker", "book_snapshot"):
                event.update(
                    event_time_ms=21_600_200,
                    received_at_ms=21_600_200,
                    known_at_ms=21_600_200,
                )
            if event["type"] == "ticker":
                event["mark_usd"] = "88000"
        engine.process(loss)
        reduction_id = engine.risk_state["reduction_intent_id"]
        self.assertIsNotNone(reduction_id)

        rollover = warmed_market(86_400_000, base_price="100000")
        rollover["events"] = [event for event in rollover["events"] if event["type"] != "candle"]
        next(event for event in rollover["events"] if event["type"] == "book_snapshot").update(
            valid=False, contiguous=False
        )
        result = engine.process(rollover)
        self.assertFalse(result["risk"]["daily_loss_latched"])
        self.assertEqual(result["position"]["quantity_btc"], "0.0099")
        self.assertEqual(result["risk"]["reduction_intent_id"], reduction_id)

    def test_versioned_risk_runtime_records_day_baseline_and_rejects_entry_after_loss(self):
        engine = risk_runtime()
        opened = open_position(engine)
        self.assertGreater(Decimal(opened["position"]["quantity_btc"]), 0)
        checkpoint = engine.checkpoint()
        self.assertEqual(checkpoint["risk_checkpoint"]["utc_day"], "1970-01-01")
        self.assertEqual(checkpoint["risk_checkpoint"]["daily_loss_latched"], False)
        self.assertEqual(checkpoint["risk_checkpoint"]["entry_paused"], False)

        loss = warmed_market(21_660_000, base_price="88000", breakout="long")
        loss["events"] = [
            event for event in loss["events"] if event["type"] != "candle"
        ]
        ticker = next(event for event in loss["events"] if event["type"] == "ticker")
        ticker["mark_usd"] = "88000"
        ticker.update(event_time_ms=21_660_000, received_at_ms=21_660_000, known_at_ms=21_660_000)
        book = next(event for event in loss["events"] if event["type"] == "book_snapshot")
        book.update(event_time_ms=21_660_000, received_at_ms=21_660_000, known_at_ms=21_660_000)
        result = engine.process(loss)
        self.assertEqual(result["risk"]["daily_loss_latched"], True)
        self.assertIn("daily_loss_limit", result["risk"]["reason_codes"])
        self.assertIsNotNone(result["position"])
        checkpoint = engine.checkpoint()
        self.assertEqual(checkpoint["risk_checkpoint"]["reduction_intent_id"], result["risk"]["reduction_intent_id"])
        restored = risk_runtime(checkpoint)
        same_day = warmed_market(21_660_200, base_price="88000")
        same_day["events"] = [event for event in same_day["events"] if event["type"] != "candle"]
        for event in same_day["events"]:
            event.update(event_time_ms=21_660_200, received_at_ms=21_660_200, known_at_ms=21_660_200)
        same_day_result = restored.process(
            same_day, control={"type": "paper.resume"}
        )
        self.assertTrue(same_day_result["risk"]["daily_loss_latched"])
        self.assertFalse(same_day_result["risk"]["user_paused"])
        self.assertTrue(same_day_result["risk"]["entry_paused"])
        next_day = warmed_market(86_400_000, base_price="100000")
        next_day["events"] = [event for event in next_day["events"] if event["type"] != "candle"]
        for event in next_day["events"]:
            event.update(event_time_ms=86_400_000, received_at_ms=86_400_000, known_at_ms=86_400_000)
        rolled = restored.process(next_day)
        self.assertEqual(rolled["risk"]["daily_loss_latched"], False)
        self.assertEqual(rolled["risk"]["utc_day"], "1970-01-02")

    def test_protective_mark_stop_is_triggered_during_pause_and_gap_queues_reduction(self):
        engine = risk_runtime()
        opened = open_position(engine)
        self.assertGreater(Decimal(opened["position"]["quantity_btc"]), 0)
        checkpoint = engine.checkpoint()
        restored = risk_runtime(checkpoint)
        stop = Decimal(opened["position"]["stop_price_usd_per_btc"])
        market = warmed_market(21_600_100, base_price=str(stop - 1000))
        next(event for event in market["events"] if event["type"] == "book_snapshot").update(
            valid=False, contiguous=False
        )
        result = restored.process(market, control={"type": "paper.pause"})
        self.assertEqual(result["position"]["quantity_btc"], opened["position"]["quantity_btc"])
        self.assertIsNotNone(result["risk"]["reduction_intent_id"])


if __name__ == "__main__":
    unittest.main()
