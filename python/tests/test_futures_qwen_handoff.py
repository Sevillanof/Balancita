import copy
import hashlib
import json
import os
import unittest
from decimal import Decimal
from unittest import mock

from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_live import LIVE_CFG, Policy, make


class HandoffTests(unittest.TestCase):
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
