import copy
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from balancita_engine import futures_maker_experiment as maker
from balancita_engine import book_costs
from test_futures_book_execution import BASE, snapshot


class MakerExperimentTests(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(tempfile.TemporaryDirectory())
        self.store = maker.MakerStore(os.path.join(self.folder, "maker.sqlite"))
        self.addCleanup(self.store.close)
        self.spec = maker.default_spec()
        self.identity = self.store.register(self.spec, registered_at_ms=BASE - 1000)

    def collect(self):
        now = [BASE]
        def sleep(seconds):
            now[0] += int(seconds * 1000)
        return self.store.collect(
            self.identity, 180, now_ms=lambda: now[0], sleep=sleep,
            snapshot_for=lambda product: snapshot(
                bids=[["100", "100"]], asks=[["101", "100"]], at=now[0] - 100),
        )

    def test_spec_is_sealed_before_capture_and_cannot_be_rewritten(self):
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store.db:
                self.store.db.execute("UPDATE maker_specs SET spec_json='{}'")
        invalid = copy.deepcopy(self.spec)
        invalid["hold_ms"] = invalid["ttl_ms"]
        with self.assertRaises(ValueError):
            self.store.register(invalid, registered_at_ms=BASE)

    def test_capture_and_results_are_isolated_from_the_trading_account(self):
        count = self.collect()
        self.assertGreater(count, 20)
        tables = {r[0] for r in self.store.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertNotIn("account", tables)
        self.assertNotIn("trades", tables)
        result = self.store.evaluate(self.identity)
        self.assertFalse(result["promotion_allowed"])
        self.assertIsNone(result["complete_net_pnl"])
        self.assertEqual(result["status"], "insufficient_data")
        self.assertEqual(result["classification"], "hypothetical_maker_scenarios")
        self.assertGreater(result["maker"]["orders"], 0)

    def test_current_fee_changes_do_not_reprice_the_registered_experiment(self):
        self.collect()
        with mock.patch.object(book_costs, "MAKER_FEE_BP", 100), \
                mock.patch.object(book_costs, "TAKER_FEE_BP", 200):
            result = self.store.evaluate(self.identity)
        self.assertEqual(result["parameters"]["maker_fee_bp"], 2)
        self.assertEqual(result["parameters"]["taker_fee_bp"], 5)
        self.assertEqual(self.store.evaluate(self.identity), result)

    def test_capture_failure_is_recorded_as_a_gap_not_an_unfilled_order(self):
        now = [BASE]
        def sleep(seconds):
            now[0] += int(seconds * 1000)
        from balancita_engine import futures_book_execution as book
        def unavailable(product):
            raise book.BookError("libro_no_disponible", "offline")
        self.assertEqual(self.store.collect(
            self.identity, 10, now_ms=lambda: now[0], sleep=sleep, snapshot_for=unavailable,
        ), 0)
        self.assertGreater(self.store.db.execute("SELECT count(*) FROM book_gap").fetchone()[0], 0)
        result = self.store.evaluate(self.identity)
        self.assertEqual(result["status"], "insufficient_data")
        self.assertEqual(result["maker"]["orders"], 0)

    def test_receipt_signal_mode_does_not_silently_fall_back_to_a_grid(self):
        spec = copy.deepcopy(self.spec)
        spec["signal_source"] = "receipts"
        identity = self.store.register(spec, registered_at_ms=BASE - 1000)
        with self.assertRaises(ValueError):
            self.store.evaluate(identity)
        with self.assertRaises(ValueError):
            self.store.evaluate(self.identity, execution_db=self.store.path)

    def test_captured_prices_cannot_be_rewritten_after_the_experiment(self):
        self.collect()
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store.db:
                self.store.db.execute("UPDATE book_depth SET best_bid='9999'")


if __name__ == "__main__":
    unittest.main()
