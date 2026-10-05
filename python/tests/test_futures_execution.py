import json
import unittest
from decimal import Decimal

from balancita_engine.futures_execution import PaperExecutionAdapter


class PaperExecutionAdapterTests(unittest.TestCase):
    def setUp(self):
        self.adapter = PaperExecutionAdapter(
            {"run_id": "run-1", "instrument_id": "kraken-futures:PF_XBTUSD"},
            {"latency_ms": 100, "tick_size": "1", "lot_size": "0.0001"},
        )

    def book(self, at, asks=None, bids=None, received=None, **quality):
        return {"provider": "kraken-futures", "product_id": "PF_XBTUSD",
                "epoch": "e1", "snapshot_id": str(at), "revision": str(at),
                "event_time_ms": at, "known_at_ms": at if received is None else received,
                "valid": True, "asks": asks or [["100001", "0.0005"]],
                "bids": bids or [["100000", "0.0005"]], **quality}

    def submit(self, order_id="o1", **kwargs):
        return self.adapter.submit({"order_id": order_id, "run_id": "run-1",
            "instrument_id": "kraken-futures:PF_XBTUSD", "decision_at_ms": 0,
            "side": "buy", "order_type": "market_ioc", "quantity_btc": "0.0004", **kwargs})

    def test_latency_depth_walk_and_exact_taker_fees(self):
        self.submit()
        self.assertEqual(self.adapter.advance(99, self.book(99)), [])
        result = self.adapter.advance(100, self.book(100, asks=[["100001", "0.0002"], ["100002", "0.0002"]]))
        fills = [event for event in result if event["type"] == "fill"]
        self.assertEqual([(e["quantity_btc"], e["price_usd"], e["fee_usd"]) for e in fills],
                         [("0.0002", "100001", "0.0100001"), ("0.0002", "100002", "0.0100002")])

    def test_ioc_partial_cancels_remainder_and_book_budget_cannot_replay(self):
        self.submit()
        result = self.adapter.advance(100, self.book(100, asks=[["100001", "0.0002"]]))
        self.assertEqual([e["type"] for e in result], ["fill", "cancelled"])
        self.assertEqual(result[0]["quantity_btc"], "0.0002")
        self.assertEqual(self.adapter.advance(101, self.book(100, asks=[["100001", "0.0002"]])), [])

    def test_due_execution_clock_uses_preserved_quote_once_without_changing_legacy(self):
        self.submit(decision_at_ms=1000, quantity_btc="0.0099")
        quote = self.book(1000, asks=[["100001", "0.005"]])
        self.assertEqual(self.adapter.advance(1000, quote), [])

        result = self.adapter.advance(
            1100, quote, execution_clock_ms=1100
        )
        self.assertEqual([event["type"] for event in result], ["fill", "cancelled"])
        fill = result[0]
        self.assertEqual(
            (
                fill["quantity_btc"],
                fill["event_time_ms"],
                fill["source_event_time_ms"],
            ),
            ("0.005", 1100, 1000),
        )
        self.assertEqual(quote["event_time_ms"], 1000)
        self.assertEqual(
            self.adapter.advance(1200, quote, execution_clock_ms=1200), []
        )

        self.adapter.submit({
            "order_id": "o2",
            "run_id": "run-1",
            "instrument_id": "kraken-futures:PF_XBTUSD",
            "decision_at_ms": 1100,
            "side": "buy",
            "order_type": "market_ioc",
            "quantity_btc": "0.0001",
        })
        repeated = self.adapter.advance(
            1200, quote, execution_clock_ms=1200
        )
        self.assertEqual([event["type"] for event in repeated], ["cancelled"])
        self.assertEqual(repeated[0]["filled_quantity_btc"], "0")

        stale_adapter = PaperExecutionAdapter(
            {"run_id": "stale", "instrument_id": "kraken-futures:PF_XBTUSD"},
            {"latency_ms": 100, "max_book_age_ms": 3000},
        )
        stale_adapter.submit({
            "order_id": "stale-order",
            "run_id": "stale",
            "instrument_id": "kraken-futures:PF_XBTUSD",
            "decision_at_ms": 1000,
            "side": "buy",
            "order_type": "market_ioc",
            "quantity_btc": "0.0001",
        })
        stale_adapter.advance(1000, quote)
        stale = stale_adapter.advance(
            5000, quote, execution_clock_ms=5000
        )
        self.assertEqual([event["type"] for event in stale], ["market_uncertainty"])
        self.assertEqual(stale_adapter.state["stale-order"]["state"], "accepted")

        legacy = PaperExecutionAdapter(
            {"run_id": "legacy", "instrument_id": "kraken-futures:PF_XBTUSD"},
            {"latency_ms": 100},
        )
        legacy.submit({
            "order_id": "legacy-order",
            "run_id": "legacy",
            "instrument_id": "kraken-futures:PF_XBTUSD",
            "decision_at_ms": 1000,
            "side": "buy",
            "order_type": "market_ioc",
            "quantity_btc": "0.0001",
        })
        self.assertEqual(legacy.advance(1100, quote), [])

    def test_post_only_is_checked_on_arrival_while_crossing_limit_takes(self):
        base = {"run_id": "run-1", "instrument_id": "kraken-futures:PF_XBTUSD", "decision_at_ms": 0,
                "side": "buy", "quantity_btc": "0.0001", "limit_price_usd": "100001"}
        self.adapter.submit({**base, "order_id": "p", "order_type": "post_only"})
        self.assertEqual(self.adapter.advance(100, self.book(100))[0]["reason"], "post_only_would_take")
        self.adapter.submit({**base, "order_id": "l", "decision_at_ms": 100, "order_type": "limit"})
        self.assertEqual(self.adapter.advance(200, self.book(200))[0]["liquidity"], "taker")

    def test_resting_maker_requires_later_verified_aggressor_trade(self):
        self.adapter.submit({"order_id": "m", "run_id": "run-1", "instrument_id": "kraken-futures:PF_XBTUSD",
            "decision_at_ms": 0, "side": "buy", "order_type": "post_only", "quantity_btc": "0.0001", "limit_price_usd": "99999"})
        book = self.book(100)
        self.adapter.advance(100, book)
        self.assertEqual(self.adapter.advance(101, {**book, "event_time_ms": 101, "known_at_ms": 101, "snapshot_id": "101"}), [])
        trade = {"provider": "kraken-futures", "product_id": "PF_XBTUSD", "epoch": "e1", "uid": "t1",
            "event_time_ms": 102, "known_at_ms": 102, "price_usd": "99999", "quantity_btc": "0.0002", "aggressor_side": "sell"}
        fill = self.adapter.advance(102, {**book, "event_time_ms": 102, "known_at_ms": 102, "snapshot_id": "102"}, trades=[trade])[0]
        self.assertEqual((fill["liquidity"], fill["fee_usd"]), ("maker", "0.00199998"))

    def test_non_crossing_limit_rests_and_fills_only_from_later_trade(self):
        self.adapter.submit({"order_id": "l-rest", "run_id": "run-1", "instrument_id": "kraken-futures:PF_XBTUSD",
            "decision_at_ms": 0, "side": "buy", "order_type": "limit", "quantity_btc": "0.0001", "limit_price_usd": "99999"})
        book = self.book(100)
        self.assertFalse(any(event["type"] == "fill" for event in self.adapter.advance(100, book)))
        trade = {"provider": "kraken-futures", "product_id": "PF_XBTUSD", "epoch": "e1", "uid": "limit-trade",
            "event_time_ms": 101, "known_at_ms": 101, "price_usd": "99999", "quantity_btc": "0.0001", "aggressor_side": "sell"}
        result = self.adapter.advance(101, {**book, "event_time_ms": 101, "known_at_ms": 101, "snapshot_id": "101"}, trades=[trade])
        self.assertEqual((result[0]["liquidity"], result[0]["fee_usd"]), ("maker", "0.00199998"))

    def test_stop_market_uses_mark_trigger_and_worse_book_fill(self):
        self.adapter.submit({"order_id": "s", "run_id": "run-1", "instrument_id": "kraken-futures:PF_XBTUSD",
            "decision_at_ms": 0, "side": "sell", "order_type": "stop_market", "quantity_btc": "0.0001", "stop_price_usd": "99000"})
        self.adapter.advance(100, self.book(100, asks=[["99002", "0.0002"]], bids=[["99001", "0.0002"]], mark_price_usd="98999"))
        fill = next(e for e in self.adapter.events if e["type"] == "fill")
        self.assertEqual((fill["price_usd"], fill["fee_usd"]), ("99001", "0.00495005"))

    def test_reduce_only_clamps_supplied_position_and_cannot_flip(self):
        self.adapter.set_position({"side": "long", "quantity_btc": "0.0002"})
        self.adapter.submit({"order_id": "r", "run_id": "run-1", "instrument_id": "kraken-futures:PF_XBTUSD",
            "decision_at_ms": 0, "side": "sell", "order_type": "reduce_only", "quantity_btc": "0.0004"})
        fill = self.adapter.advance(100, self.book(100))[0]
        self.assertEqual(fill["quantity_btc"], "0.0002")
        self.assertEqual(self.adapter.position["quantity_btc"], "0.0002")
        self.adapter.submit({"order_id": "r2", "run_id": "run-1", "instrument_id": "kraken-futures:PF_XBTUSD",
            "decision_at_ms": 100, "side": "sell", "order_type": "reduce_only", "quantity_btc": "0.0001"})
        self.assertEqual(self.adapter.advance(200, self.book(200))[0]["type"], "cancelled")

    def test_checkpoint_restores_pending_order_and_prevents_depth_replay(self):
        self.submit()
        restored = PaperExecutionAdapter.restore(json.loads(json.dumps(self.adapter.checkpoint())))
        self.assertEqual(restored.advance(99, self.book(99)), [])
        self.assertEqual(restored.advance(100, self.book(100))[0]["quantity_btc"], "0.0004")
        self.assertEqual(restored.advance(101, self.book(100)), [])
        conflict = restored.submit({"order_id": "o1", "run_id": "run-1", "instrument_id": "kraken-futures:PF_XBTUSD",
            "decision_at_ms": 0, "side": "sell", "order_type": "market_ioc", "quantity_btc": "0.0004"})
        self.assertEqual(conflict["type"], "rejected")

    def test_checkpoint_roundtrips_full_depth_without_price_keyed_budget_objects(self):
        asks = [[str(100001 + 2 * index), "0.0001"] for index in range(101)]
        bids = [[str(100000 - 2 * index), "0.0001"] for index in range(101)]
        self.submit(quantity_btc="0.005")
        first_fills = [
            event
            for event in self.adapter.advance(100, self.book(100, asks=asks, bids=bids))
            if event["type"] == "fill"
        ]
        self.assertEqual(len(first_fills), 50)
        self.assertEqual(first_fills[0]["price_usd"], "100001")
        self.assertEqual(first_fills[-1]["price_usd"], "100099")
        first_quantity = sum(
            (Decimal(event["quantity_btc"]) for event in first_fills), Decimal("0")
        )
        first_notional = sum(
            (
                Decimal(event["quantity_btc"]) * Decimal(event["price_usd"])
                for event in first_fills
            ),
            Decimal("0"),
        )
        self.assertEqual(first_notional / first_quantity, Decimal("100050"))

        checkpoint = json.loads(json.dumps(self.adapter.checkpoint()))
        budget = checkpoint["book_budgets"][0][1]

        self.assertEqual(checkpoint["checkpoint_version"], "paper-execution-checkpoint.v2")
        self.assertEqual(len(budget["asks"]), 101)
        self.assertEqual(len(budget["bids"]), 101)
        self.assertTrue(all(len(level) == 2 for level in budget["asks"]))
        restored = PaperExecutionAdapter.restore(checkpoint)
        self.assertEqual(restored.checkpoint(), self.adapter.checkpoint())
        restored.submit({
            "order_id": "o2",
            "run_id": "run-1",
            "instrument_id": "kraken-futures:PF_XBTUSD",
            "decision_at_ms": 100,
            "side": "buy",
            "order_type": "market_ioc",
            "quantity_btc": "0.005",
        })
        next_book = self.book(200, asks=asks, bids=bids, snapshot_id="100", revision="100")
        next_fills = [
            event
            for event in restored.advance(200, next_book)
            if event["type"] == "fill"
        ]
        self.assertEqual(
            sum(
                (Decimal(event["quantity_btc"]) for event in next_fills),
                Decimal("0"),
            ),
            Decimal("0.005"),
        )
        self.assertEqual(next_fills[0]["price_usd"], "100101")
        next_quantity = sum(
            (Decimal(event["quantity_btc"]) for event in next_fills), Decimal("0")
        )
        next_notional = sum(
            (
                Decimal(event["quantity_btc"]) * Decimal(event["price_usd"])
                for event in next_fills
            ),
            Decimal("0"),
        )
        self.assertEqual(next_notional / next_quantity, Decimal("100150"))

    def test_checkpoint_v2_restores_legacy_v1_price_maps(self):
        self.adapter.advance(
            100,
            self.book(100, asks=[["100001", "0.0005"]], bids=[["100000", "0.0005"]]),
        )
        legacy = self.adapter.checkpoint()
        legacy["checkpoint_version"] = "paper-execution-checkpoint.v1"
        legacy["book_budgets"] = [
            (
                key,
                {
                    side: {price: quantity for price, quantity in levels}
                    for side, levels in budget.items()
                },
            )
            for key, budget in legacy["book_budgets"]
        ]

        restored = PaperExecutionAdapter.restore(json.loads(json.dumps(legacy)))

        self.assertEqual(restored.book_budgets, self.adapter.book_budgets)
        self.assertEqual(
            restored.advance(101, self.book(100)),
            self.adapter.advance(101, self.book(100)),
        )

    def test_checkpoint_restores_partial_resting_order_without_replaying_old_depth(self):
        self.submit(order_type="limit", limit_price_usd="100001")
        first = self.adapter.advance(100, self.book(100, asks=[["100001", "0.0002"]]))
        self.assertEqual(first[0]["quantity_btc"], "0.0002")
        restored = PaperExecutionAdapter.restore(json.loads(json.dumps(self.adapter.checkpoint())))
        self.assertEqual(restored.advance(101, self.book(100, asks=[["100001", "0.0002"]])), [])
        trade = {"provider": "kraken-futures", "product_id": "PF_XBTUSD", "epoch": "e1", "uid": "restored-trade",
            "event_time_ms": 102, "known_at_ms": 102, "price_usd": "100001", "quantity_btc": "0.0002", "aggressor_side": "sell"}
        second = restored.advance(102, self.book(102, asks=[["100001", "0.0002"]]), trades=[trade])
        self.assertEqual((second[0]["quantity_btc"], second[0]["fee_usd"], second[0]["liquidity"]),
                         ("0.0002", "0.00400004", "maker"))

    def test_fractional_tick_and_lot_reject(self):
        self.assertEqual(self.submit(quantity_btc="0.00015")["type"], "rejected")
        rejected = self.adapter.submit({"order_id": "bad", "run_id": "run-1", "instrument_id": "kraken-futures:PF_XBTUSD",
            "decision_at_ms": 0, "side": "buy", "order_type": "limit", "quantity_btc": "0.0001", "limit_price_usd": "100000.5"})
        self.assertEqual(rejected["type"], "rejected")

    def test_invalid_quality_expiry_clock_skew_and_causal_cancel(self):
        self.submit(expire_at_ms=50)
        expired = self.adapter.advance(100, self.book(100, valid=False))
        self.assertEqual([event["type"] for event in expired], ["expired", "market_uncertainty"])
        self.assertEqual(self.adapter.advance(101, self.book(101)), [])
        self.submit("skew", decision_at_ms=200)
        self.assertEqual(self.adapter.advance(200, self.book(150)), [])
        self.assertTrue(any(e["type"] == "market_uncertainty" for e in self.adapter.events))

    def test_clock_is_monotonic_and_book_age_is_measured_at_cutoff(self):
        self.submit()
        self.assertEqual(self.adapter.advance(99, self.book(99)), [])
        with self.assertRaises(ValueError):
            self.adapter.advance(98, self.book(98))
        stale = self.adapter.advance(3100, self.book(99))
        self.assertEqual(stale[0]["type"], "market_uncertainty")

    def test_partial_cancel_keeps_fill_and_exact_command_retry(self):
        self.submit(order_type="limit", limit_price_usd="100001")
        self.adapter.advance(100, self.book(100, asks=[["100001", "0.0002"]]))
        result = self.adapter.cancel("o1", "c1", 101)
        self.assertEqual((result[0]["type"], result[0]["filled_quantity_btc"]), ("cancelled", "0.0002"))
        self.assertEqual(self.adapter.cancel("o1", "c1", 101), result)

    def test_caller_mutation_cannot_change_frozen_config_or_emitted_records(self):
        self.submit()
        records = self.adapter.events
        records[0]["type"] = "real_order"
        config = self.adapter.config
        config["latency_ms"] = 0
        self.assertEqual(self.adapter.events[1]["type"], "order_accepted")
        self.assertEqual(self.adapter.advance(99, self.book(99)), [])


if __name__ == "__main__":
    unittest.main()
