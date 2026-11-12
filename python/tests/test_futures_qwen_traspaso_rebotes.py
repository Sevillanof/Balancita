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
        self.spec = {"path": "qwen-live-posiciones.json", "sha256": "f7f64f5c99974b8a0997133d74c27e349eaeb90781f0a35961b942ba7860d67e"}
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

    def test_the_rules_overlay_is_the_pending_request_and_turns_on_both_rules(self):
        """Mac (develop): the request in ``qwen-live.json`` is the maestro rules overlay; it applies on the active Terminal config."""
        spec = self.cfg["runtime"]["pending_config"]
        self.assertEqual(spec["path"], "qwen-live-reglas.json")
        with open(os.path.join(CONFIG_DIR, spec["path"]), "rb") as handle:
            raw = handle.read()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), spec["sha256"])
        with open(os.path.join(CONFIG_DIR, "terminal-activa.json"), encoding="utf-8") as handle:
            active = json.load(handle)
        self.assertEqual(json.loads(raw)["base_config_hash"], active["config_hash"])
        target = live.pending_config(copy.deepcopy(active["config"]), spec)
        self.assertEqual(target["reglas_maestro"], {"no_vender_subida_30d": "prendido", "sumar_lugares_60min": "prendido"})
        self.assertEqual(target["posiciones"], active["config"]["posiciones"])
        qt.Trader(target, "PF_ETHUSD", None, entry_threshold=0.5)          # the target config builds

    def test_the_old_overlay_stays_consumed_and_is_not_requested(self):
        self.assertNotEqual(self.spec["path"], "qwen-live-next.json")
        with open(os.path.join(CONFIG_DIR, "qwen-live-next.json"), encoding="utf-8") as handle:
            self.assertNotIn("posiciones", json.load(handle)["changes"])


if __name__ == "__main__":
    unittest.main()
