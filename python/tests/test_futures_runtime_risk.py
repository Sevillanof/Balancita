import unittest
from decimal import Decimal

from balancita_engine.futures_runtime import FuturesRuntime
from futures_runtime_fixtures import CONFIG, INSTRUMENT, warmed_market


def risk_runtime(checkpoint=None, funding_policy=False):
    config = dict(CONFIG)
    config.update(
        version="futures-runtime-risk.v1",
        execution_latency_ms=100,
        daily_loss_fraction="0.01",
    )
    if funding_policy:
        config["funding_policy_version"] = "funding-separation.v1"
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


def with_known_funding(market):
    now = market["decision_time_ms"]
    market["events"].append({
        "type": "funding_observation", "received_at_ms": now,
        "known_at_ms": now, "observation": {
            "source": "fixture", "provider": "kraken", "product": "PF_XBTUSD",
            "field": "funding_rate", "raw_rate": "0", "unit": "usd_per_btc_per_hour",
            "effective_start_ms": max(0, now - 3_600_000),
            "effective_end_ms": now + 3_600_000, "known_at_ms": now,
            "received_seq": 1, "observation_id": "funding-{}".format(now),
            "sha256": "a" * 64, "semantic_version": "kraken-funding-normalization.v1",
            "predicted": False,
        },
    })
    return market


class FuturesRuntimeRiskTests(unittest.TestCase):
    def test_opt_in_funding_separation_keeps_flat_ledger_complete_and_blocks_unknown_entries(self):
        known = risk_runtime(funding_policy=True)
        known.ledger.funding_complete = True
        known_market = with_known_funding(warmed_market(21_600_000, breakout="long"))
        result = known.process(known_market)
        self.assertTrue(result["ledger"]["funding_complete"])
        self.assertFalse(result["risk"]["system_paused"])
        self.assertFalse(result["risk"]["entry_paused"])
        self.assertTrue(any(
            item["kind"] == "active_order"
            for item in result["funding_policy"]["pending_financial_obligations"]
        ))
        policy_checkpoint = known.checkpoint()["funding_policy_checkpoint"]
        self.assertEqual(policy_checkpoint["contract_version"], "funding-separation.v1")
        self.assertEqual(policy_checkpoint["version"], "funding-separation.v1")

        unknown = risk_runtime(funding_policy=True)
        blocked = unknown.process(warmed_market(21_600_000, breakout="long"))
        self.assertTrue(blocked["ledger"]["funding_complete"])
        self.assertEqual(blocked["position"]["quantity_btc"], "0")
        self.assertIn("funding_unavailable", blocked["risk"]["reason_codes"])
        self.assertEqual(blocked["risk"]["entry_block_causes"], ["funding_unavailable"])
        self.assertTrue(blocked["risk"]["entry_paused"])
        self.assertFalse(blocked["risk"]["system_paused"])
        self.assertFalse(any(order.get("type") == "order_accepted" for order in blocked["orders"]))

        recovered = unknown.process(known_market)
        self.assertEqual(recovered["funding_policy"]["availability"], "known")
        self.assertFalse(recovered["risk"]["entry_paused"])
        self.assertNotIn("funding_unavailable", recovered["risk"]["entry_block_causes"])

        legacy = risk_runtime()
        old = warmed_market(21_600_000, breakout="long")
        old["mode"] = "paper_live"
        legacy_result = legacy.process(old)
        self.assertFalse(legacy_result["ledger"]["funding_complete"])

        historical = risk_runtime(funding_policy=True)
        historical.ledger.funding_complete = False
        historical.risk_state["system_paused"] = True
        restored = risk_runtime(checkpoint=historical.checkpoint(), funding_policy=True)
        repaired = restored.process(known_market)
        self.assertFalse(repaired["ledger"]["funding_complete"])
        self.assertTrue(repaired["risk"]["system_paused"])
        self.assertIn("funding_accounting_incomplete", repaired["risk"]["entry_block_causes"])
        self.assertIsNone(repaired["ledger"]["realized_net_complete"])

        incomplete = risk_runtime(funding_policy=True)
        incomplete.ledger.funding_complete = False
        incomplete_result = incomplete.process(known_market)
        self.assertEqual(incomplete_result["funding_policy"]["availability"], "known")
        self.assertFalse(incomplete_result["risk"]["system_paused"])
        self.assertTrue(incomplete_result["risk"]["entry_paused"])
        self.assertIn("funding_accounting_incomplete", incomplete_result["risk"]["entry_block_causes"])
        self.assertFalse(any(order.get("type") == "order_accepted" for order in incomplete_result["orders"]))

        expired = with_known_funding(warmed_market(25_200_000, breakout="long"))
        expired_observation = next(event["observation"] for event in expired["events"] if event["type"] == "funding_observation")
        expired_observation["effective_end_ms"] = 25_200_000
        expired_engine = risk_runtime(funding_policy=True)
        self.assertEqual(expired_engine.process(expired)["funding_policy"]["availability"], "unknown")

        user_paused = risk_runtime(funding_policy=True)
        user_result = user_paused.process(
            with_known_funding(warmed_market(21_600_000, breakout="long")),
            control={"type": "paper.pause"},
        )
        self.assertTrue(user_result["risk"]["user_paused"])
        self.assertTrue(user_result["risk"]["entry_paused"])
        self.assertIn("user_paused", user_result["risk"]["entry_block_causes"])
        self.assertFalse(any(order.get("type") == "order_accepted" for order in user_result["orders"]))

        daily_paused = risk_runtime(funding_policy=True)
        daily_paused.risk_state["daily_loss_latched"] = True
        daily_result = daily_paused.process(
            with_known_funding(warmed_market(21_600_000, breakout="long"))
        )
        self.assertTrue(daily_result["risk"]["entry_paused"])
        self.assertIn("daily_loss_latched", daily_result["risk"]["entry_block_causes"])
        self.assertFalse(any(order.get("type") == "order_accepted" for order in daily_result["orders"]))

        active = risk_runtime(funding_policy=True)
        active.process(with_known_funding(warmed_market(21_600_000, breakout="long")))
        active_result = active.process(with_known_funding(warmed_market(21_600_100, base_price="100000")))
        self.assertNotEqual(active_result["position"]["quantity_btc"], "0")
        obligations = active_result["funding_policy"]["pending_financial_obligations"]
        self.assertTrue(any(item["kind"] == "open_position" for item in obligations))
        self.assertTrue(any(item["kind"] == "position_protection" for item in obligations))

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
