import copy
import contextlib
import io
import json
import sqlite3
import unittest
from decimal import Decimal as D, localcontext
from unittest import mock

from balancita_engine import futures_book_execution as book
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_book import make_book_env, open_book_trade, close_book_trade
from test_futures_qwen_live import BASE


class ExecutionReceiptTests(unittest.TestCase):
    def test_entry_and_mark_receipts_are_persisted_and_idempotent(self):
        env = open_book_trade(self)
        row = env.rows("SELECT * FROM trades")[0]
        self.assertEqual(row["execution_model"], book.MODEL)
        self.assertTrue(row["entry_receipt_id"])
        self.assertTrue(row["mark_receipt_id"])
        entry = env.store.execution_evidence(row["entry_receipt_id"])
        count = len(env.rows("SELECT * FROM execution_receipts"))
        with env.store.db:
            receipt = env.store.put_execution("PF_ETHUSD", row["trade_no"], entry, env.now[0])
        self.assertEqual(receipt, row["entry_receipt_id"])
        self.assertEqual(len(env.rows("SELECT * FROM execution_receipts")), count)

    def test_receipts_cannot_be_rewritten_deleted_or_replaced(self):
        env = open_book_trade(self)
        for sql in (
            "UPDATE execution_receipts SET evidence_json='{}'",
            "DELETE FROM execution_receipts",
            "INSERT OR REPLACE INTO execution_receipts SELECT * FROM execution_receipts",
        ):
            with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                with env.store.db:
                    env.store.db.execute(sql)
        row = env.rows("SELECT * FROM trades")[0]
        entry = env.store.execution_evidence(row["entry_receipt_id"])
        changed = copy.deepcopy(entry)
        changed["price"] = "9999"
        with self.assertRaises(qt.TraderError):
            with env.store.db:
                env.store.put_execution("PF_ETHUSD", row["trade_no"], changed, env.now[0])

    def test_closed_trade_replays_without_network_or_current_costs(self):
        env = open_book_trade(self)
        close_book_trade(env)
        row = env.rows("SELECT * FROM trades")[0]
        self.assertTrue(row["exit_receipt_id"])
        with mock.patch.object(book, "fetch_snapshot", side_effect=AssertionError("network")), \
                mock.patch.object(book, "TAKER_RATE", "0.2"), \
                mock.patch.object(qt, "fee_rate", side_effect=AssertionError("current fees")):
            result = env.store.replay_trade("PF_ETHUSD", row["trade_no"])
        for key in ("net_usd", "gross_usd", "fees_usd", "funding_usd"):
            self.assertEqual(result[key], row[key])
        self.assertEqual(result["funding_status"], row["funding_status"])
        self.assertIsNone(result["net_complete_usd"])

    def test_receipt_failure_rolls_back_trade_and_state_together(self):
        env = make_book_env(self)
        trader = env.op.traders["PF_ETHUSD"]
        signal = trader.t[-1] + qt.BAR_MS
        trader._open(signal, "LONG", 1, "formula")
        state_before = env.rows("SELECT * FROM trader_state")
        cash = env.store.cash_balance_usd()
        with mock.patch.object(env.store, "put_execution", side_effect=qt.TraderError("receipt failure")):
            with self.assertRaises(qt.TraderError):
                env.op._record("PF_ETHUSD", trader, signal, [], env.now[0])
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertEqual(env.rows("SELECT * FROM trader_state"), state_before)
        self.assertEqual(env.store.cash_balance_usd(), cash)

    def test_receipt_checksum_failure_is_visible(self):
        env = open_book_trade(self)
        row = env.rows("SELECT * FROM trades")[0]
        with env.store.db:
            env.store.db.execute("DROP TRIGGER execution_receipts_no_update")
            env.store.db.execute("UPDATE execution_receipts SET evidence_json='{}' WHERE receipt_id=?",
                                 (row["entry_receipt_id"],))
        with self.assertRaises(qt.TraderError):
            env.store.execution_evidence(row["entry_receipt_id"])

    def test_late_funding_appends_evidence_without_changing_price_receipts(self):
        env = open_book_trade(self)
        close_book_trade(env)
        row = env.rows("SELECT * FROM trades")[0]
        original = env.store.execution_evidence(row["exit_receipt_id"])
        history = qt.exact_funding.from_public("PF_ETHUSD", {
            "result": "success",
            "rates": [{"timestamp": book.utc_text(BASE), "fundingRate": "1", "relativeFundingRate": "0.01"}],
        }, known_at_ms=env.now[0] + qt.HOUR_MS)
        env.op.traders["PF_ETHUSD"].funding = qt.FundingLine(history)
        env.now[0] += qt.HOUR_MS
        with localcontext() as ctx:
            ctx.prec = 10
            env.op._reconcile_funding("PF_ETHUSD")
        updated = env.rows("SELECT * FROM trades")[0]
        self.assertEqual(updated["funding_status"], "complete")
        self.assertTrue(updated["funding_receipt_id"])
        self.assertEqual(env.store.execution_evidence(row["exit_receipt_id"]), original)
        result = env.store.replay_trade("PF_ETHUSD", row["trade_no"])
        self.assertEqual(result["net_complete_usd"], updated["net_complete_usd"])
        self.assertEqual(result["funding_usd"], updated["funding_usd"])

    def test_restart_checks_entry_evidence_and_preserves_receipt_identity(self):
        env = open_book_trade(self)
        row = env.rows("SELECT * FROM trades")[0]
        env.restart().start()
        self.addCleanup(env.store.close)
        restored = env.op.traders["PF_ETHUSD"].position
        self.assertEqual(D(restored.entry_execution["quantity"]), restored.qty)
        self.assertEqual(env.rows("SELECT entry_receipt_id FROM trades")[0]["entry_receipt_id"],
                         row["entry_receipt_id"])

    def test_replay_rejects_receipts_borrowed_from_another_trade(self):
        env = open_book_trade(self)
        close_book_trade(env)
        row = env.rows("SELECT * FROM trades")[0]
        with env.store.db:
            env.store.put_trade("PF_ETHUSD", 2, **{key: row[key] for key in live._TRADE_COLUMNS})
        with self.assertRaises(qt.TraderError):
            env.store.replay_trade("PF_ETHUSD", 2)

    def test_cli_replay_is_read_only_and_returns_the_recorded_result(self):
        env = open_book_trade(self)
        close_book_trade(env)
        before = env.rows("SELECT * FROM trades")
        output = io.StringIO()
        with contextlib.redirect_stdout(output), \
                mock.patch.object(book, "fetch_snapshot", side_effect=AssertionError("network")):
            code = live.main(["--db", env.db_path, "--replay-trade", "1"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["net_usd"], before[0]["net_usd"])
        self.assertEqual(env.rows("SELECT * FROM trades"), before)


if __name__ == "__main__":
    unittest.main()
