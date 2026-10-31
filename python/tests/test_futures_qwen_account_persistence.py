import copy
import contextlib
from decimal import Decimal as D
import io
import json
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_live import LIVE_CFG


class PermanentAccountTests(unittest.TestCase):
    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.path = os.path.join(self.tmp, "live.sqlite")
        self.store = live.LiveStore(self.path)
        self.addCleanup(self.store.close)
        self.cfg = copy.deepcopy(LIVE_CFG)
        self.cfg.update(cuenta="entera", notional_usd="1000", products=["PF_ETHUSD"])

    def closed(self, no=1, net="25.125"):
        with self.store.db:
            self.store.put_trade(
                "PF_ETHUSD", no, status="closed", side="LONG", entry_ms=no,
                exit_ms=no + 1, net_usd=net, funding_status="complete",
                notional_usd="1000", entry_px="100", qty="10",
            )

    def test_obsolete_archive_guard_rejects_unknown_keywords_before_reading_a_book(self):
        missing = os.path.join(self.tmp, "missing.sqlite")
        with self.assertRaises(TypeError):
            live.archive_other_config(missing, self.cfg, reset_account=True)

    def test_initial_cash_is_saved_once_and_is_not_the_strategy_size(self):
        cfg = dict(self.cfg, notional_usd="9000")
        self.store.check_identity(cfg)
        self.assertEqual(self.store.initial_balance_usd(), D("1000"))
        self.store.check_identity(cfg, account_start_usd="50000")
        self.assertEqual(self.store.initial_balance_usd(), D("1000"))

    def test_legacy_migration_keeps_realized_money_and_the_exact_open_position(self):
        for key, value in live.identity_of(self.cfg).items():
            self.store.set_meta(key, value)
        self.closed(net="-17.375")
        with self.store.db:
            self.store.put_trade("PF_ETHUSD", 2, status="open", side="SHORT", entry_ms=10,
                                 entry_px="100", qty="15", notional_usd="1500", margin_usd="1500", net_now_usd="-3")
        before = [dict(r) for r in self.store.db.execute("SELECT * FROM trades ORDER BY trade_no")]
        self.store.check_identity(self.cfg, account_start_usd="50000")
        self.assertEqual(self.store.cash_balance_usd(), D("982.625"))
        self.assertEqual([dict(r) for r in self.store.db.execute("SELECT * FROM trades ORDER BY trade_no")], before)

    def test_flat_configuration_transition_preserves_money_history_and_trade_sequence(self):
        self.store.check_identity(self.cfg)
        self.closed()
        with self.store.db:
            self.store.db.execute(
                "INSERT INTO trader_state(product,last_fed_ms,trade_seq,cooldown_until,updated_ms) VALUES('PF_ETHUSD',100,7,0,100)")
        before = [dict(r) for r in self.store.db.execute("SELECT * FROM trades")]
        changed = copy.deepcopy(self.cfg)
        changed.update(notional_usd="50000", leverage="2")
        changed["prompt"]["version"] += 1
        self.store.activate_flat_config(changed, now_ms=200)
        self.assertEqual(self.store.cash_balance_usd(), D("1025.125"))
        self.assertEqual(self.store.available_balance_usd(excluding_product="PF_ETHUSD"), D("1025.125"))
        self.assertEqual([dict(r) for r in self.store.db.execute("SELECT * FROM trades")], before)
        state = self.store.load_state("PF_ETHUSD")
        if state is None:
            self.fail("La transición perdió el estado de la cuenta.")
        self.assertEqual(state["trade_seq"], 7)
        self.assertEqual(self.store.meta()["config_hash"], qt.config_hash(changed))
        versions = [dict(r) for r in self.store.db.execute("SELECT * FROM config_versions ORDER BY id")]
        self.assertEqual(versions[-1]["previous_hash"], qt.config_hash(self.cfg))
        self.assertEqual(versions[-1]["config_hash"], qt.config_hash(changed))
        self.assertEqual(D(versions[-1]["cash_usd"]), D("1025.125"))
        self.store.check_identity(changed, account_start_usd="7")
        self.assertEqual(self.store.cash_balance_usd(), D("1025.125"))

    def test_unmigrated_legacy_account_cannot_switch_to_a_new_configuration(self):
        for key, value in live.identity_of(self.cfg).items():
            self.store.set_meta(key, value)
        with self.assertRaises(qt.TraderError):
            self.store.activate_flat_config(dict(self.cfg, notional_usd="50000"), account_start_usd="50000")
        self.assertEqual(self.store.meta()["config_hash"], qt.config_hash(self.cfg))
        self.assertIsNone(self.store.db.execute("SELECT 1 FROM account").fetchone())

    def test_only_trade_results_change_cash_including_funding_reconciliation(self):
        self.store.check_identity(self.cfg)
        self.closed(net="0.1")
        self.closed(no=2, net="0.2")
        self.closed(no=3, net="-0.3")
        self.assertEqual(self.store.cash_balance_usd(), D("1000"))
        self.store.set_meta("heartbeat_ms", 123)
        self.assertEqual(self.store.cash_balance_usd(), D("1000"))
        with self.store.db:
            self.store.update_trade("PF_ETHUSD", 1, net_usd="0.075", funding_status="complete")
        self.assertEqual(self.store.cash_balance_usd(), D("999.975"))

    def test_transition_is_blocked_by_open_trade_or_serialized_position(self):
        for state_only in (False, True):
            with self.subTest(state_only=state_only):
                path = os.path.join(self.tmp, str(state_only) + ".sqlite")
                store = live.LiveStore(path)
                self.addCleanup(store.close)
                store.check_identity(self.cfg)
                with store.db:
                    if state_only:
                        store.db.execute(
                            "INSERT INTO trader_state(product,last_fed_ms,trade_seq,cooldown_until,position_json,updated_ms) "
                            "VALUES('PF_ETHUSD',0,1,0,'{\"trade_no\":1}',0)")
                    else:
                        store.put_trade("PF_ETHUSD", 1, status="open", side="LONG", entry_ms=0)
                with self.assertRaises(qt.TraderError):
                    store.activate_flat_config(dict(self.cfg, notional_usd="2"), now_ms=200)
                self.assertEqual(store.meta()["config_hash"], qt.config_hash(self.cfg))
                self.assertEqual(store.cash_balance_usd(), D("1000"))

    def test_genesis_and_version_receipts_cannot_be_rewritten_or_deleted(self):
        self.store.check_identity(self.cfg)
        for sql in (
            "UPDATE account SET initial_usd='5000'",
            "DELETE FROM account",
            "INSERT OR REPLACE INTO account(id,initial_usd,created_ms) VALUES(1,'5000',0)",
            "UPDATE config_versions SET cash_usd='5000'",
            "DELETE FROM config_versions",
        ):
            with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                with self.store.db:
                    self.store.db.execute(sql)
        self.assertEqual(self.store.cash_balance_usd(), D("1000"))

    def test_failed_activation_rolls_back_identity_and_version_without_touching_cash(self):
        self.store.check_identity(self.cfg)
        self.closed()
        versions = self.store.db.execute("SELECT COUNT(*) FROM config_versions").fetchone()[0]
        self.store.db.execute(
            "CREATE TRIGGER fail_config BEFORE INSERT ON meta "
            "WHEN NEW.key='products' BEGIN SELECT RAISE(ABORT,'synthetic failure after identity change'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.activate_flat_config(dict(self.cfg, notional_usd="42"), now_ms=200)
        self.assertEqual(self.store.meta()["config_hash"], qt.config_hash(self.cfg))
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM config_versions").fetchone()[0], versions)
        self.assertEqual(self.store.cash_balance_usd(), D("1025.125"))

    def test_moving_a_version_to_another_file_cannot_reset_the_account(self):
        self.store.check_identity(self.cfg)
        self.closed()
        with self.assertRaises(qt.TraderError):
            live.archive_other_config(self.path, dict(self.cfg, notional_usd="9"))
        self.assertTrue(os.path.isfile(self.path))
        self.assertEqual(self.store.cash_balance_usd(), D("1025.125"))

    def test_new_flow_requires_trained_candidates_before_activation(self):
        self.store.check_identity(self.cfg)
        changed = copy.deepcopy(self.cfg)
        changed["noticias"]["policy"] = "priority_v2"
        changed["opinion_enabled"] = False
        now = qt.date_ms("2026-10-30")
        with self.assertRaises(qt.TraderError):
            live.validate_activation(changed, now_ms=now)
        self.assertEqual(self.store.meta()["config_hash"], qt.config_hash(self.cfg))
        self.assertEqual(self.store.cash_balance_usd(), D("1000"))
        self.assertTrue(live._parser().parse_args(["--activate-flat-config"]).activate_flat_config)

    def test_mark_updates_do_not_rewrite_the_actual_opening_time(self):
        with self.store.db:
            self.store.put_trade("PF_ETHUSD", 1, status="open", side="LONG", entry_ms=0, opened_at_ms=10)
            self.store.put_trade("PF_ETHUSD", 1, status="open", side="LONG", entry_ms=0, opened_at_ms=20)
        self.assertEqual(self.store.db.execute("SELECT opened_at_ms FROM trades").fetchone()[0], 10)

    def test_account_is_available_before_any_model_health_request(self):
        for key, value in live.identity_of(self.cfg).items():
            self.store.set_meta(key, value)
        path = os.path.join(self.tmp, "config.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(self.cfg, handle)
        provider = mock.Mock()
        provider.base_url = "http://127.0.0.1:8088"

        def stop_after_check():
            self.assertIsNotNone(self.store.db.execute("SELECT initial_usd FROM account WHERE id=1").fetchone())
            self.assertEqual(self.store.initial_balance_usd(), D("1000"))
            raise qt.TraderError("synthetic stop before running any model")

        provider.health.side_effect = stop_after_check
        with mock.patch.object(qt, "_provider", return_value=provider), mock.patch.dict(os.environ, {}, clear=True):
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(live.main(["--db", self.path, "--config", path]), 2)
        provider.health.assert_called_once()


if __name__ == "__main__":
    unittest.main()
