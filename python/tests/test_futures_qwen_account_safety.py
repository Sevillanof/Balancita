import copy
from decimal import Decimal as D
import os
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import contextlib
import io
import json

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_analista as movement
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_live import LIVE_CFG


class AccountSafetyTests(unittest.TestCase):
    def setUp(self):
        self.cfg = copy.deepcopy(LIVE_CFG)
        self.cfg.update(notional_usd="1000", cuenta="entera", products=["PF_ETHUSD"])
        self.cfg["analista"] = {"modo": "fuerte"}
        self.tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.store = live.LiveStore(os.path.join(self.tmp, "live.sqlite"))
        self.addCleanup(self.store.close)
        self.store.check_identity(self.cfg)

    def trader(self, active=True, balance="1000"):
        trader = qt.Trader(self.cfg, "PF_ETHUSD", None)
        trader.c = [100.0]
        trader.notional = D(balance)
        trader.movement = SimpleNamespace(active=lambda _: active)
        return trader

    def test_strong_movement_never_spends_more_than_balance_including_entry_fee(self):
        trader = self.trader()
        trader._open(0, "LONG", 0.8, "test")
        used = trader.position.notional_usd
        self.assertGreater(used, D("999"))
        self.assertLessEqual(used * (1 + qt.fee_rate("taker")), D("1000"))
        actual = trader.position.qty * trader.position.entry_px
        self.assertLessEqual(actual, used)
        self.assertLess(used - actual, D("1e-22"))

    def test_calm_uses_half_account_and_no_history_does_not_exceed_balance(self):
        calm = self.trader(active=False)
        calm._open(0, "SHORT", 0.8, "test")
        self.assertEqual(calm.position.notional_usd, D("500"))
        unknown = self.trader(active=None)
        unknown._open(0, "LONG", 0.8, "test")
        self.assertLessEqual(unknown.position.notional_usd * (1 + qt.fee_rate()), D("1000"))

    def test_empty_or_negative_account_rejects_entry_explicitly(self):
        for balance in ("0", "-1"):
            trader = self.trader(balance=balance)
            with self.subTest(balance=balance), self.assertRaises(qt.WakeSkipped) as caught:
                trader._open(0, "LONG", 0.8, "test")
            self.assertEqual(caught.exception.kind, "saldo_insuficiente")
            self.assertIsNone(trader.position)

    def test_other_open_positions_reserve_their_margin(self):
        with self.store.db:
            self.store.put_trade(
                "PF_XBTUSD", 1, status="open", side="LONG", entry_ms=0,
                notional_usd="400", leverage="1", margin_usd="400", net_now_usd="-2",
            )
        self.assertEqual(self.store.available_balance_usd(excluding_product="PF_ETHUSD"), D("598"))

    def test_invalid_realized_net_is_not_silently_ignored(self):
        with self.store.db:
            self.store.put_trade(
                "PF_ETHUSD", 1, status="closed", side="LONG", entry_ms=0,
                net_usd="NaN",
            )
        with self.assertRaises(qt.TraderError):
            self.store.available_balance_usd()

    def test_funding_reconciliation_keeps_percentages_on_each_positions_notional(self):
        with self.store.db:
            self.store.put_trade(
                "PF_ETHUSD", 1, status="closed", side="LONG", entry_ms=0, exit_ms=qt.HOUR_MS,
                entry_px="100", qty="15", notional_usd="1500", gross_usd="15", fees_usd="1",
                funding_usd="0", net_usd="14", net_bp=float(D(14) / D(1500) * 10_000),
                funding_status="partial",
            )
        operator = live.LiveOperator(self.cfg, self.store, None, llm.FakeProvider())
        operator.traders["PF_ETHUSD"] = SimpleNamespace(funding=qt.FundingLine([(0, 0)]))
        operator._reconcile_funding("PF_ETHUSD")
        row = dict(self.store.db.execute("SELECT * FROM trades").fetchone())
        self.assertEqual(D(row["net_usd"]), D(14))
        self.assertAlmostEqual(row["net_bp"], 14 / 1500 * 10_000)

    def test_size_cap_never_resizes_an_existing_position(self):
        trader = self.trader()
        trader._open(0, "LONG", 0.8, "test")
        before = live.position_to_json(trader.position)
        trader.notional = D("700")
        self.assertEqual(live.position_to_json(trader.position), before)

    def test_config_change_cannot_close_or_archive_an_open_position(self):
        self.store.check_identity(self.cfg)
        with self.store.db:
            self.store.put_trade(
                "PF_ETHUSD", 1, status="open", side="LONG", entry_ms=0,
                notional_usd="100", entry_px="100", qty="1",
            )
        before = dict(self.store.db.execute("SELECT * FROM trades").fetchone())
        changed = copy.deepcopy(self.cfg)
        changed["prompt"]["version"] += 1
        with self.assertRaises(qt.TraderError):
            live.archive_other_config(self.store.path, changed, log=lambda _: None)
        self.assertEqual(dict(self.store.db.execute("SELECT * FROM trades").fetchone()), before)
        self.assertEqual(self.store.meta()["config_hash"], qt.config_hash(self.cfg))

    def test_startup_never_archives_another_configuration_without_explicit_opt_in(self):
        self.store.check_identity(self.cfg)
        changed = copy.deepcopy(self.cfg)
        changed["prompt"]["version"] += 1
        path = os.path.join(self.tmp, "new-config.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(changed, handle)
        provider = llm.FakeProvider()
        provider.base_url = "http://127.0.0.1:8088"
        with mock.patch.dict(os.environ, {}, clear=True), contextlib.redirect_stderr(io.StringIO()), \
                contextlib.redirect_stdout(io.StringIO()):
            with mock.patch.object(qt, "_provider", return_value=provider), mock.patch.object(live.signal, "signal"):
                with mock.patch.object(live, "archive_other_config", side_effect=AssertionError("automatic archive")):
                    result = live.main(["--db", self.store.path, "--config", path])
        self.assertEqual(result, 2)
        self.assertEqual(self.store.meta()["config_hash"], qt.config_hash(self.cfg))
        self.assertTrue(os.path.isfile(self.store.path))
        self.assertFalse(live._parser().parse_args([]).archive_flat_book)
        self.assertTrue(live._parser().parse_args(["--archive-flat-book"]).archive_flat_book)


class MovementOverrideTests(unittest.TestCase):
    def test_explicit_off_removes_enabled_base_mode_without_mutating_base(self):
        base = {"analista": {"modo": "fuerte"}}
        off = movement.apply_env(base, {movement.ENV: "apagado"})
        self.assertIsNone(movement.sizes_of(off))
        self.assertEqual(base, {"analista": {"modo": "fuerte"}})
        self.assertIs(movement.apply_env(base, {}), base)


if __name__ == "__main__":
    unittest.main()
