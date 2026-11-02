"""The committed pending overlay must be applicable: its file matches the approved SHA and its changes are accepted."""
import copy
import hashlib
import json
import os
import unittest
from unittest import mock

from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt

CONFIG_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "config")


class PendingOverlayTest(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(CONFIG_DIR, "qwen-live.json"), encoding="utf-8") as handle:
            self.cfg = json.load(handle)
        self.spec = self.cfg["runtime"]["pending_config"]
        self.path = os.path.join(CONFIG_DIR, self.spec["path"])
        with open(self.path, "rb") as handle:
            self.raw = handle.read()
        self.overlay = json.loads(self.raw)

    def test_the_approved_sha_matches_the_file(self):
        self.assertEqual(hashlib.sha256(self.raw).hexdigest(), self.spec["sha256"])

    def test_the_overlay_turns_on_three_places_and_the_rebound_expert(self):
        changes = self.overlay["changes"]
        self.assertEqual(changes["posiciones"]["max"], 3)
        self.assertEqual(changes["posiciones"]["fraccion"], 0.33)
        self.assertEqual(changes["rebotes"]["caida_pct"], 5.0)

    def test_it_applies_on_its_base_and_leaves_no_request_pending(self):
        base = self.overlay["base_config_hash"]
        with mock.patch.object(qt, "config_hash", side_effect=lambda c: base if "posiciones" not in c else "otro"):
            target = live.pending_config(copy.deepcopy(self.cfg), self.spec)
        self.assertEqual(target["posiciones"]["max"], 3)
        self.assertIn("rebotes", target)
        self.assertNotIn("pending_config", target["runtime"])
        self.assertEqual(target["runtime"]["activation_request_sha256"], self.spec["sha256"])

    def test_the_old_overlay_stays_consumed_and_is_not_requested(self):
        self.assertNotEqual(self.spec["path"], "qwen-live-next.json")
        with open(os.path.join(CONFIG_DIR, "qwen-live-next.json"), encoding="utf-8") as handle:
            self.assertNotIn("posiciones", json.load(handle)["changes"])


if __name__ == "__main__":
    unittest.main()
