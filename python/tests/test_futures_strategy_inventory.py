import copy
import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from balancita_engine.futures_spec_strategy import load_specs
from balancita_engine.futures_strategy_inventory import DEFAULT_CONFIG_DIR, build_inventory
from balancita_engine.futures_strategy_registry import StrategyRegistry, StrategyService, make_handler


def _row(inventory, strategy_id):
    return next(r for r in inventory["strategies"] if r["id"] == strategy_id)


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.registry = StrategyRegistry(os.path.join(self.dir, "s.db"))
        self.registry.seed(load_specs())
        self.registry.apply_closed()
        self.addCleanup(self.registry.close)
        self.service = StrategyService(self.registry, None, {})

    def inventory(self):
        return self.service.inventory()

    def test_operational_and_research_are_separate_axes(self):
        inv = self.inventory()
        c25 = _row(inv, "c25-pullback-perp-v1")
        self.assertEqual(c25["operational"]["state"], "closed")
        self.assertEqual(c25["research"]["state"], "negative_edge")
        c29 = _row(inv, "c29-momentum-perp-v1")
        self.assertEqual((c29["operational"]["state"], c29["research"]["state"]), ("active", "no_edge"))
        self.assertFalse(c29["research"]["evidence_of_edge"])

    def test_edge_evidence_only_for_candidate_or_better(self):
        inv = self.inventory()
        edge = [r["id"] for r in inv["strategies"] if r["research"]["evidence_of_edge"]]
        self.assertEqual(edge, ["c30-momentum-12h-perp-v1"])
        self.assertFalse(_row(inv, "c30-momentum-12h-perp-v1")["research"]["reliable"])

    def test_closed_come_back_from_config_and_keep_their_numbers(self):
        inv = self.inventory()
        closed = [r["id"] for r in inv["strategies"] if r["operational"]["state"] == "closed"]
        self.assertEqual(sorted(closed), ["c25-pullback-perp-v1", "c26-reversion-perp-v1",
                                          "c27-breakout-perp-v1", "c28-adapter-perp-v1"])
        self.assertEqual(_row(inv, "c25-pullback-perp-v1")["research"]["backtest"]["trades"], 223652)
        self.assertEqual(inv["counts"]["closed"], 4)

    def test_forward_results_are_never_invented(self):
        inv = self.inventory()
        for row in inv["strategies"]:
            self.assertIsNone(row["forward"]["trades"])
            self.assertFalse(row["forward"]["available"])
            self.assertTrue(row["forward"]["missing"])  # never a bare "unknown": the reason is said
        self.assertTrue(any(line.startswith("B5") for line in inv["missing"]))

    def test_models_without_backtest_have_no_numbers_and_kronos_is_unverified(self):
        inv = self.inventory()
        c31 = _row(inv, "c31-qwen-exit-perp-v1")
        self.assertEqual(c31["research"]["state"], "unmeasured")
        self.assertIsNone(c31["research"]["backtest"])
        self.assertEqual(c31["operational"]["basis"], "config")
        self.assertEqual(c31["operational"]["state"], "off")
        self.assertEqual(inv["counts"]["active"], 3)
        self.assertEqual(_row(inv, "kronos-small-1h-h4-v1")["operational"]["state"], "unverified")
        self.assertTrue(_row(inv, "c32-funding-contrarian-24h-perp-v1")["no_backtest"])

    def test_c31_is_listed_as_off_with_its_reason_and_returns_when_the_block_is_removed(self):
        c31 = _row(self.inventory(), "c31-qwen-exit-perp-v1")
        self.assertEqual(c31["operational"]["state"], "off")
        self.assertEqual(c31["operational"]["since_ms"], 1792281600000)  # 2026-10-18 UTC
        self.assertIn("funding", c31["operational"]["reason"])
        self.assertTrue(c31["forward"]["missing"].startswith("apagada: "))
        self.assertFalse(c31["research"]["investigating"])
        config = os.path.join(self.dir, "config")
        shutil.copytree(DEFAULT_CONFIG_DIR, config)
        path = os.path.join(config, "qwen-exit.json")
        with open(path, encoding="utf-8") as handle:
            body = json.load(handle)
        del body["off"]
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(body, handle)
        self.service.config_dir = config
        back = _row(self.inventory(), "c31-qwen-exit-perp-v1")
        self.assertEqual(back["operational"]["state"], "unverified")
        self.assertTrue(back["research"]["investigating"])

    def test_an_invalid_off_block_is_a_loud_config_error_and_stays_off(self):
        config = os.path.join(self.dir, "config")
        shutil.copytree(DEFAULT_CONFIG_DIR, config)
        path = os.path.join(config, "qwen-exit.json")
        with open(path, encoding="utf-8") as handle:
            body = json.load(handle)
        self.service.config_dir = config
        for bad in ({}, None, True, "x", {"since": "2026-10-18", "reason": ""}, {"since": "2026-10-18", "reason": "  "},
                    {"since": "2026-10-18"}, {"reason": "x"}, {"since": "ayer", "reason": "x"}):
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(dict(body, off=bad), handle)
            c31 = _row(self.inventory(), "c31-qwen-exit-perp-v1")
            self.assertEqual(c31["operational"]["state"], "off", bad)
            self.assertIn("inválido", c31["operational"]["reason"], bad)
            self.assertFalse(c31["research"]["investigating"], bad)

    def test_qwen_exit_off_rule(self):
        from balancita_engine.futures_strategy_inventory import qwen_exit_off
        self.assertIsNone(qwen_exit_off({"schema": "s"}))
        self.assertEqual(qwen_exit_off({"off": {"since": "2026-10-18", "reason": "x"}}),
                         {"since": "2026-10-18", "reason": "x", "invalid": False})
        self.assertTrue(qwen_exit_off({"off": {}})["invalid"])

    def test_carry_is_unverified_without_state_files(self):
        carry = _row(self.inventory(), "carry-funding-c-v1")
        self.assertEqual(carry["operational"]["state"], "unverified")
        self.assertEqual(carry["research"]["state"], "registry_note")
        self.assertIn("criterio", carry["research"]["text"])

    def test_a_changed_spec_is_unmeasured(self):
        spec = copy.deepcopy(load_specs()["c29-momentum-perp-v1"])
        spec["params"]["z_min"] = "3"
        entry = {"id": spec["id"], "version": 1, "name": spec["name"], "state": "active", "state_reason": "x",
                 "state_known_at": 5, "spec_hash": "h"}
        inv = build_inventory([entry], {spec["id"]: spec}, carry=None)
        self.assertEqual(_row(inv, "c29-momentum-perp-v1")["research"]["state"], "unmeasured")

    def test_missing_config_files_degrade_to_empty(self):
        empty = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, empty, True)
        inv = build_inventory([], {}, config_dir=empty)
        self.assertEqual(inv["strategies"], [])
        self.assertIsNone(inv["cost_model"])

    def test_inventory_writes_nothing(self):
        before = self.registry.db.execute("SELECT COUNT(*) FROM strategy_events").fetchone()[0]
        self.inventory()
        self.assertEqual(self.registry.db.execute("SELECT COUNT(*) FROM strategy_events").fetchone()[0], before)

    def test_http_route_is_get_only(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.service))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = "http://127.0.0.1:{}/api-strategies/inventory".format(server.server_address[1])
        with urllib.request.urlopen(url, timeout=30) as response:
            body = json.loads(response.read())
        self.assertEqual(body["schema"], "futures-strategy-inventory.v1")
        self.assertEqual(body["cost_model"]["version"], "kraken-futures-costs.v2")
        post = urllib.request.Request(url, data=b"{}", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(post, timeout=30)
        self.assertEqual(caught.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
