import copy
import hashlib
import json
import os
import tempfile
import unittest
from decimal import Decimal
from unittest import mock

from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_live import LIVE_CFG, Policy, make


class HandoffTests(unittest.TestCase):
    def test_approved_absolute_funding_target_preserves_legacy_trade_and_account(self):
        source = qt.load_config(qt.CONFIG_PATH_LIVE)
        target = live.pending_config(source, source["runtime"]["pending_config"])
        live.validate_activation(target, now_ms=qt.date_ms("2026-11-01"))
        self.assertEqual(target["funding_model"], qt.exact_funding.EXACT_MODEL)
        with tempfile.TemporaryDirectory() as folder:
            store = live.LiveStore(os.path.join(folder, "live.sqlite"))
            try:
                store.check_identity(source)
                with store.db:
                    store.put_trade(
                        "PF_ETHUSD", 7, status="open", side="SHORT", entry_ms=100,
                        entry_px="2241.6574077", qty="0.45", notional_usd="1000",
                        funding_model=qt.exact_funding.LEGACY_MODEL,
                    )
                before = [dict(r) for r in store.db.execute("SELECT * FROM trades")]
                with self.assertRaises(qt.TraderError):
                    store.activate_flat_config(target, now_ms=200)
                self.assertEqual([dict(r) for r in store.db.execute("SELECT * FROM trades")], before)
                with store.db:
                    store.update_trade("PF_ETHUSD", 7, status="closed", exit_ms=200, net_usd="0.125")
                closed = [dict(r) for r in store.db.execute("SELECT * FROM trades")]
                cash = store.cash_balance_usd()
                store.activate_flat_config(target, now_ms=300)
                self.assertEqual(store.cash_balance_usd(), cash)
                self.assertEqual([dict(r) for r in store.db.execute("SELECT * FROM trades")], closed)
                self.assertEqual(closed[0]["funding_model"], qt.exact_funding.LEGACY_MODEL)
                self.assertEqual(store.meta()["config_hash"], qt.config_hash(target))
                resumed = live.active_config(store, source)
                self.assertEqual(resumed["funding_model"], qt.exact_funding.EXACT_MODEL)
            finally:
                store.close()

    def request(self, env, *, wrong_hash=False):
        path = os.path.join(env.tmp, "pending.json")
        overlay = {
            "schema": "balancita-qwen-flow-transition.v1",
            "base_config_hash": qt.config_hash(env.cfg),
            "changes": {"note": "approved new flow", "opinion_enabled": False},
        }
        raw = json.dumps(overlay).encode()
        with open(path, "wb") as handle:
            handle.write(raw)
        env.op.cfg.setdefault("runtime", {})["pending_config"] = {
            "path": path, "sha256": "0" * 64 if wrong_hash else hashlib.sha256(raw).hexdigest(),
        }

    def test_open_trade_and_cash_are_untouched_while_waiting(self):
        env = make(self, policy=Policy(flat="LARGO"))
        env.op.start()
        env.advance(15)
        before = env.rows("SELECT side,entry_ms,entry_px,qty,notional_usd FROM trades WHERE status='open'")
        self.assertTrue(before)
        cash = env.store.cash_balance_usd()
        self.request(env)
        with mock.patch.object(live, "validate_activation"):
            env.op._try_pending_config()
        self.assertEqual(env.rows("SELECT side,entry_ms,entry_px,qty,notional_usd FROM trades WHERE status='open'"), before)
        self.assertEqual(env.store.cash_balance_usd(), cash)
        self.assertIsNone(env.op.next_config)
        self.assertEqual(env.store.meta()["pending_config"]["state"], "waiting")

    def test_flat_activation_persists_the_new_version_not_a_new_account(self):
        env = make(self, policy=Policy(flat="ESPERAR"))
        env.op.start()
        cash, versions = env.store.cash_balance_usd(), env.rows("SELECT id FROM config_versions")
        self.request(env)
        with mock.patch.object(live, "validate_activation"):
            env.op._try_pending_config()
        self.assertEqual(env.store.cash_balance_usd(), cash)
        self.assertEqual(len(env.rows("SELECT id FROM config_versions")), len(versions) + 1)
        self.assertEqual(env.op.next_config["note"], "approved new flow")
        resumed = live.active_config(env.store, env.cfg)
        self.assertEqual(qt.config_hash(resumed), env.store.meta()["config_hash"])
        self.assertEqual(resumed["note"], "approved new flow")

    def test_invalid_pending_target_is_visible_and_blocks_new_entries_not_safety_exits(self):
        env = make(self, policy=Policy(flat="ESPERAR"))
        env.op.start()
        self.request(env, wrong_hash=True)
        env.op._try_pending_config()
        self.assertEqual(env.store.meta()["pending_config"]["state"], "error")
        trader = env.op.traders["PF_ETHUSD"]
        with self.assertRaises(qt.WakeSkipped):
            trader._open(env.now[0], "LONG", 1, "test")
        self.assertEqual(env.store.cash_balance_usd(), Decimal("1000"))


if __name__ == "__main__":
    unittest.main()
