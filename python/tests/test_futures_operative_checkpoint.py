import json
import unittest
from decimal import Decimal

from balancita_engine.futures_execution import PaperExecutionAdapter
from balancita_engine.futures_ledger import FuturesLedger
from balancita_engine.futures_operative_state import ExactIdentityPort


class FuturesOperativeCheckpointGrowthTests(unittest.TestCase):
    def test_operative_restore_requires_port_and_aborted_updates_are_not_committed(self):
        run_id = "operative-abort"
        instrument_id = "kraken-futures:PF_XBTUSD"
        committed = {}
        staged = {}
        port = ExactIdentityPort(
            lambda kind, key: committed.get((kind, key)),
            lambda kind, key, value: staged.__setitem__((kind, key), value),
        )
        adapter = PaperExecutionAdapter(
            {"run_id": run_id, "instrument_id": instrument_id},
            {"latency_ms": 0}, identity_port=port,
        )
        intent = {
            "order_id": "aborted-order", "run_id": run_id,
            "instrument_id": instrument_id, "decision_at_ms": 1,
            "side": "buy", "order_type": "market_ioc", "quantity_btc": "0.0001",
        }
        adapter.submit(intent)
        checkpoint = adapter.operative_checkpoint()
        self.assertNotIn(("order", "aborted-order"), committed)
        with self.assertRaises(ValueError):
            PaperExecutionAdapter.restore_operative(checkpoint, identity_port=None)
        retry = PaperExecutionAdapter.restore_operative(checkpoint, identity_port=port)
        self.assertEqual(retry.submit(intent)["type"], "order_accepted")
        with self.assertRaises(ValueError):
            retry.checkpoint()
        self.assertEqual(committed, {})
        with self.assertRaises(ValueError):
            port.lookup("unknown-kind", "key")
        with self.assertRaises(ValueError):
            port.lookup("order", "")
        with self.assertRaises(ValueError):
            port.lookup("book_budget", "not-json")

    def test_old_book_budget_is_restored_exactly_in_a_fresh_job(self):
        run_id = "operative-budget"
        instrument_id = "kraken-futures:PF_XBTUSD"
        committed = {}
        pending = {}
        checkpoint = None
        port_factory = lambda: ExactIdentityPort(
            lambda kind, key: committed.get((kind, key)),
            lambda kind, key, value: pending.__setitem__((kind, key), value),
        )

        def job(call, *, live_books=()):
            nonlocal checkpoint
            pending.clear()
            adapter = (
                PaperExecutionAdapter.restore_operative(checkpoint, identity_port=port_factory())
                if checkpoint is not None
                else PaperExecutionAdapter(
                    {"run_id": run_id, "instrument_id": instrument_id},
                    {"latency_ms": 0}, identity_port=port_factory(),
                )
            )
            result = call(adapter)
            adapter.drain_identity_updates()
            committed.update(pending)
            pending.clear()
            checkpoint = adapter.operative_checkpoint(live_book_identities=live_books)
            return result

        book = {
            "provider": "kraken-futures", "product_id": "PF_XBTUSD", "epoch": "e1",
            "snapshot_id": "one", "revision": "one", "event_time_ms": 1,
            "known_at_ms": 1, "valid": True, "asks": [["100001", "0.0001"]],
            "bids": [["100000", "0.0001"]],
        }
        identity = ("kraken-futures", "PF_XBTUSD", "e1", "one", "one")
        for order_id in ("first", "second"):
            job(lambda adapter: adapter.submit({
                "order_id": order_id, "run_id": run_id, "instrument_id": instrument_id,
                "decision_at_ms": 1, "side": "buy", "order_type": "market_ioc",
                "quantity_btc": "0.0001",
            }))
            events = job(lambda adapter: adapter.advance(1, book), live_books=(identity,))
            fills = [event for event in events if event["type"] == "fill"]
            self.assertEqual(len(fills), 1 if order_id == "first" else 0)
        self.assertEqual(committed[("book_budget", '["kraken-futures","PF_XBTUSD","e1","one","one"]')]["asks"]["100001"], "0")

    def test_old_trade_and_per_order_trade_identity_survive_fresh_restore(self):
        run_id = "operative-trade"
        instrument_id = "kraken-futures:PF_XBTUSD"
        committed, pending, checkpoint = {}, {}, None
        port_factory = lambda: ExactIdentityPort(
            lambda kind, key: committed.get((kind, key)),
            lambda kind, key, value: pending.__setitem__((kind, key), value),
        )

        def job(call, *, live_books=()):
            nonlocal checkpoint
            pending.clear()
            adapter = (
                PaperExecutionAdapter.restore_operative(checkpoint, identity_port=port_factory())
                if checkpoint is not None
                else PaperExecutionAdapter(
                    {"run_id": run_id, "instrument_id": instrument_id},
                    {"latency_ms": 0}, identity_port=port_factory(),
                )
            )
            result = call(adapter)
            adapter.drain_identity_updates()
            committed.update(pending)
            pending.clear()
            checkpoint = adapter.operative_checkpoint(live_book_identities=live_books)
            return result

        def limit(order_id, at):
            return job(lambda adapter: adapter.submit({
                "order_id": order_id, "run_id": run_id, "instrument_id": instrument_id,
                "decision_at_ms": at, "side": "buy", "order_type": "limit",
                "quantity_btc": "0.0001", "limit_price_usd": "100000",
            }))

        def market(at, snapshot):
            return {
                "provider": "kraken-futures", "product_id": "PF_XBTUSD", "epoch": "e1",
                "snapshot_id": snapshot, "revision": snapshot, "event_time_ms": at,
                "known_at_ms": at, "valid": True,
                "asks": [["100001", "0.0001"]], "bids": [["100000", "0.0001"]],
            }

        first_book = ("kraken-futures", "PF_XBTUSD", "e1", "rest-1", "rest-1")
        limit("maker-1", 1)
        job(lambda adapter: adapter.advance(1, market(1, "rest-1")), live_books=(first_book,))
        trade = {
            "uid": "trade-old", "provider": "kraken-futures", "product_id": "PF_XBTUSD",
            "epoch": "e1", "event_time_ms": 2, "known_at_ms": 2,
            "price_usd": "100000", "quantity_btc": "0.0002", "aggressor_side": "sell",
        }
        fill_events = job(lambda adapter: adapter.advance(2, market(2, "trade-1"), [trade]))
        self.assertEqual([event["type"] for event in fill_events], ["fill"])
        self.assertEqual(committed[("trade_budget", "trade-old")], "0")
        second_book = ("kraken-futures", "PF_XBTUSD", "e1", "rest-2", "rest-2")
        limit("maker-2", 3)
        job(lambda adapter: adapter.advance(3, market(3, "rest-2")), live_books=(second_book,))
        replay = {**trade, "event_time_ms": 3, "known_at_ms": 3}
        replay_events = job(lambda adapter: adapter.advance(3, market(3, "trade-2"), [replay]), live_books=(second_book,))
        self.assertFalse(any(event["type"] == "fill" for event in replay_events))
        self.assertIsInstance(json.dumps(checkpoint), str)
        self.assertIn(("order_trade", '["maker-1","trade-old"]'), committed)
        self.assertIn(("order_trade", '["maker-2","trade-old"]'), committed)

    def test_actual_financial_roundtrips_expose_legacy_checkpoint_history_growth(self):
        run_id = "checkpoint-growth"
        instrument_id = "kraken-futures:PF_XBTUSD"
        adapter = PaperExecutionAdapter(
            {"run_id": run_id, "instrument_id": instrument_id},
            {"latency_ms": 0, "tick_size": "1", "lot_size": "0.0001"},
        )
        committed = {}
        pending = {}
        operative_checkpoint = None
        last_identity_updates = []

        def port():
            return ExactIdentityPort(
                lambda kind, key: committed.get((kind, key)),
                lambda kind, key, value: pending.__setitem__((kind, key), value),
            )

        def operative_call(call):
            nonlocal operative_checkpoint, last_identity_updates
            pending.clear()
            current = (
                PaperExecutionAdapter.restore_operative(operative_checkpoint, identity_port=port())
                if operative_checkpoint is not None
                else PaperExecutionAdapter(
                    {"run_id": run_id, "instrument_id": instrument_id},
                    {"latency_ms": 0, "tick_size": "1", "lot_size": "0.0001"},
                    identity_port=port(),
                )
            )
            result = call(current)
            last_identity_updates = current.drain_identity_updates()
            committed.update(pending)
            pending.clear()
            operative_checkpoint = current.operative_checkpoint()
            return result

        ledger = FuturesLedger("10000")
        ledger.observe_funding("funding-window", 0, 10_000_000, "0.0001", 0)
        snapshots = {}
        sizes = {}
        field_sizes = {}

        def book(at, suffix):
            return {
                "provider": "kraken-futures", "product_id": "PF_XBTUSD",
                "epoch": "e1", "snapshot_id": str(suffix), "revision": str(suffix),
                "event_time_ms": at, "known_at_ms": at, "valid": True,
                "asks": [["100001", "1"]], "bids": [["100000", "1"]],
            }

        def apply(events):
            for event in events:
                if event["type"] != "fill":
                    continue
                at = event["event_time_ms"]
                if event["side"] == "buy":
                    ledger.open("long", event["quantity_btc"], event["price_usd"], event["liquidity"], at)
                else:
                    ledger.close(event["quantity_btc"], event["price_usd"], event["liquidity"], at)

        for index in range(40):
            open_at = index * 1000 + 100
            close_at = open_at + 100
            order_id = "open-{:02d}".format(index)
            adapter.set_position({"side": None, "quantity_btc": "0"})
            operative_call(lambda current: current.set_position({"side": None, "quantity_btc": "0"}))
            accepted = adapter.submit({
                "order_id": order_id, "run_id": run_id, "instrument_id": instrument_id,
                "decision_at_ms": open_at, "side": "buy", "order_type": "market_ioc",
                "quantity_btc": "0.005",
            })
            self.assertEqual(accepted["type"], "order_accepted")
            compact_accepted = operative_call(lambda current: current.submit({
                "order_id": order_id, "run_id": run_id, "instrument_id": instrument_id,
                "decision_at_ms": open_at, "side": "buy", "order_type": "market_ioc",
                "quantity_btc": "0.005",
            }))
            self.assertEqual(compact_accepted, accepted)
            opened = adapter.advance(open_at, book(open_at, "open-" + str(index)))
            compact_opened = operative_call(lambda current: current.advance(open_at, book(open_at, "open-" + str(index))))
            self.assertEqual(compact_opened, opened)
            apply([dict(event, side="buy") for event in opened])
            ledger.accrue_funding(open_at, close_at)

            close_id = "close-{:02d}".format(index)
            adapter.set_position({"side": "long", "quantity_btc": "0.005"})
            operative_call(lambda current: current.set_position({"side": "long", "quantity_btc": "0.005"}))
            accepted = adapter.submit({
                "order_id": close_id, "run_id": run_id, "instrument_id": instrument_id,
                "decision_at_ms": close_at, "side": "sell", "order_type": "reduce_only",
                "quantity_btc": "0.005",
            })
            self.assertEqual(accepted["type"], "order_accepted")
            compact_accepted = operative_call(lambda current: current.submit({
                "order_id": close_id, "run_id": run_id, "instrument_id": instrument_id,
                "decision_at_ms": close_at, "side": "sell", "order_type": "reduce_only",
                "quantity_btc": "0.005",
            }))
            self.assertEqual(compact_accepted, accepted)
            closed = adapter.advance(close_at, book(close_at, "close-" + str(index)))
            compact_closed = operative_call(lambda current: current.advance(close_at, book(close_at, "close-" + str(index))))
            self.assertEqual(compact_closed, closed)
            apply([dict(event, side="sell") for event in closed])
            command_id = "cancel-{:02d}".format(index)
            cancellation = adapter.cancel(close_id, command_id, close_at)
            compact_cancel = operative_call(lambda current: current.cancel(close_id, command_id, close_at))
            self.assertEqual(compact_cancel, cancellation)
            self.assertEqual(adapter.cancel(close_id, command_id, close_at), cancellation)
            with self.assertRaises(ValueError):
                adapter.cancel(close_id, command_id, close_at + 1)
            self.assertIsNone(ledger.position)
            self.assertEqual(ledger.snapshot("100000")["cash_usd"], "10000")
            self.assertEqual(ledger.snapshot("100000")["quantity_btc"], "0")
            if index + 1 in (10, 20, 40):
                checkpoint = adapter.checkpoint()
                encoded = json.dumps(checkpoint, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                sizes[index + 1] = len(encoded)
                field_sizes[index + 1] = {
                    key: len(json.dumps(checkpoint[key], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
                    for key in ("events", "orders", "command_receipts", "book_budgets", "trade_budgets", "trade_ids")
                }
                snapshots[index + 1] = ledger.snapshot("100000")
                restored = PaperExecutionAdapter.restore(json.loads(encoded))
                self.assertEqual(restored.checkpoint(), checkpoint)
                self.assertEqual(snapshots[index + 1], ledger.snapshot("100000"))
                operative_bytes = len(json.dumps(operative_checkpoint, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
                sizes.setdefault("operative", {})[2 * (index + 1)] = operative_bytes

        self.assertEqual(len(adapter.orders), 80)
        self.assertEqual(len({event["event_id"] for event in adapter.events}), len(adapter.events))
        first_intent = adapter.orders["open-00"]["intent"]
        self.assertEqual(adapter.submit(first_intent), adapter.orders["open-00"]["receipt"])
        replayed_receipt = operative_call(lambda current: current.submit(first_intent))
        self.assertEqual(replayed_receipt, adapter.orders["open-00"]["receipt"])
        self.assertTrue(all(update["provenance"] for update in last_identity_updates))
        prior_cancel = adapter.command_receipts["cancel-00"][1]
        replayed_cancel = operative_call(lambda current: current.cancel("close-00", "cancel-00", 200))
        self.assertEqual(replayed_cancel, prior_cancel)
        conflicting = operative_call(lambda current: current.submit({**first_intent, "quantity_btc": "0.0001"}))
        self.assertEqual(conflicting["type"], "rejected")
        self.assertEqual(ledger.realized_gross, Decimal("-0.200"))
        self.assertEqual(ledger.fees, Decimal("20.0001"))
        self.assertGreater(ledger.funding_paid, Decimal("0"))
        final = ledger.snapshot("100000")
        self.assertEqual(final["equity_usd"], "9979.7998999994444444444444444444444444444444444444")
        self.assertTrue(final["funding_complete"])
        self.assertEqual(final["net_complete"], "-20.200100000555555555555555555555555555555555555556")
        self.assertGreater(sizes[40], sizes[10])
        self.assertGreater(sizes[20], sizes[10])
        self.assertEqual((sizes[10], sizes[20], sizes[40]), (38229, 76302, 152502))
        # Legacy full history remains the growth control; operative state is opt-in.
        self.assertLess(sizes["operative"][40], sizes["operative"][20] + 2048, sizes)
        self.assertLess(sizes["operative"][80], sizes["operative"][40] + 2048, sizes)
        self.assertLessEqual(max(sizes["operative"].values()) - min(sizes["operative"].values()), 2)
        self.assertEqual(tuple(sizes["operative"][count] for count in (20, 40, 80)), (498, 500, 500))


if __name__ == "__main__":
    unittest.main()
