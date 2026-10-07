import copy
import json
import os
import random
import shutil
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from balancita_engine.futures_spec_strategy import load_specs, spec_hash
from balancita_engine.futures_strategies import C25_ID, C26_ID, C27_ID, STRATEGY_IDS
from balancita_engine.futures_strategy_backtest import deflated_sharpe, run_backtest
from balancita_engine.futures_strategy_registry import (
    RegistryError,
    StrategyRegistry,
    StrategyService,
    make_handler,
)
from balancita_engine.futures_verdicts import VERDICT_CONFIG, VerdictStore, evaluate_verdict, product_config

from test_futures_spec_strategy import _random_walk

SPECS = load_specs()
BTC = "PF_XBTUSD"


def _verdicts(minutes=900, seed=7):
    ones, fives = _random_walk(random.Random(seed), minutes)
    config = product_config(VERDICT_CONFIG, BTC, "1")
    regime, verdicts = "unknown", []
    for candidate in ones[260:]:
        verdict = evaluate_verdict(ones, fives, previous_regime=regime, config=config,
                                   candidate_bucket=candidate["bucket_start"])
        regime = verdict["regime"]
        verdicts.append(verdict)
    return verdicts


VERDICTS = _verdicts()


class Clock:
    def __init__(self):
        self.now = 1_000

    def __call__(self):
        self.now += 1
        return self.now


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.registry = StrategyRegistry(os.path.join(self.dir, "strategies.sqlite"), clock=Clock())
        self.registry.seed(SPECS)

    def tearDown(self):
        self.registry.close()
        shutil.rmtree(self.dir)

    def test_seed_registers_c25_to_c28_as_active_once(self):
        self.registry.seed(SPECS)
        entries = {e["id"]: e for e in self.registry.list()}
        self.assertEqual(set(entries), set(STRATEGY_IDS))
        self.assertTrue(all(e["state"] == "active" and e["version"] == 1 for e in entries.values()))
        self.assertEqual(set(self.registry.active_specs(0)), set(STRATEGY_IDS))

    def test_modify_appends_a_version_and_keeps_the_previous_one_active(self):
        spec = copy.deepcopy(SPECS[C25_ID])
        spec["params"]["rsi_long_min"] = "40"
        saved = self.registry.save(spec, "modify")
        self.assertEqual((saved["id"], saved["version"], saved["state"]), (C25_ID, 2, "draft"))
        self.assertEqual(saved["active_version"], 1)
        self.assertEqual(self.registry.version(C25_ID, 1)["spec"], SPECS[C25_ID])
        self.assertEqual(self.registry.active_specs(10**15)[C25_ID]["version"], 1)

    def test_new_leaves_the_original_and_gets_a_c29_id(self):
        spec = copy.deepcopy(SPECS[C25_ID])
        spec["params"]["rsi_long_min"] = "40"
        saved = self.registry.save(spec, "new", new_name="Pullback suave")
        self.assertTrue(saved["id"].startswith("c29-"))
        self.assertEqual(saved["parent"], {"id": C25_ID, "version": 1})
        self.assertEqual(len(self.registry.detail(C25_ID)["versions"]), 1)

    def test_identical_spec_and_invalid_spec_are_refused(self):
        with self.assertRaises(RegistryError) as duplicate:
            self.registry.import_spec(copy.deepcopy(SPECS[C26_ID]))
        self.assertEqual(duplicate.exception.code, "duplicate_spec")
        broken = copy.deepcopy(SPECS[C26_ID])
        broken["rules"]["exit"]["LONG"] = {"eval": "x"}
        with self.assertRaises(RegistryError) as invalid:
            self.registry.save(broken, "modify")
        self.assertEqual(invalid.exception.code, "invalid_spec")

    def test_variants_create_one_draft_per_value(self):
        created = self.registry.variants(C25_ID, None, "rsi_long_min", ["35", "40", "45"])
        self.assertEqual([c["name"] for c in created],
                         ["C25 Pullback en tendencia · rsi_long_min 35", "C25 Pullback en tendencia · rsi_long_min 40"])
        self.assertTrue(all(c["state"] == "draft" for c in created))

    def test_rows_are_append_only(self):
        with self.assertRaises(sqlite3.IntegrityError):
            with self.registry.db:
                self.registry.db.execute("UPDATE strategy_versions SET origin='x'")

    def test_promotion_is_gated_by_backtest_and_out_of_sample_evidence(self):
        spec = copy.deepcopy(SPECS[C27_ID])
        spec["params"]["volume_multiplier"] = "1.1"
        saved = self.registry.save(spec, "modify")
        with self.assertRaises(RegistryError) as no_backtest:
            self.registry.set_state(C27_ID, saved["version"], "shadow")
        self.assertEqual(no_backtest.exception.code, "gate_failed")
        service = StrategyService(self.registry, None, {BTC: "1"})
        service._verdicts = lambda product, days: VERDICTS
        service.backtest(self.registry.version(C27_ID, saved["version"])["spec"], BTC, 30,
                         strategy_id=C27_ID, version=saved["version"])
        self.assertEqual(self.registry.set_state(C27_ID, saved["version"], "shadow")["state"], "shadow")
        with self.assertRaises(RegistryError) as weak:
            self.registry.set_state(C27_ID, saved["version"], "active")
        failed = [g["code"] for g in weak.exception.extra["gates"] if not g["passed"]]
        self.assertIn("oos_trades", failed)
        # Retiring needs no evidence; the shipped version stays active meanwhile.
        self.registry.set_state(C27_ID, saved["version"], "retired")
        self.assertEqual(self.registry.active_specs(10**15)[C27_ID]["version"], 1)


class BacktestTests(unittest.TestCase):
    def test_book_reports_trades_returns_and_split(self):
        result = run_backtest(SPECS[C27_ID], VERDICTS)
        total = result["all"]
        self.assertGreater(total["trades"], 0)
        self.assertEqual(total["trades"], result["in_sample"]["trades"] + result["out_of_sample"]["trades"])
        self.assertAlmostEqual(total["pnl_usd"], sum(t["pnl_usd"] for t in result["trades"]), places=2)
        self.assertIsNotNone(result["buy_and_hold_pct"])
        self.assertLessEqual(result["max_drawdown"]["pct"], 0)
        for trade in result["trades"]:
            self.assertLess(trade["entry_bucket_ms"], trade["exit_bucket_ms"])
            self.assertIn(trade["exit_reason"], ("stop", "target", "strategy_exit", "time_stop"))

    def test_backtest_is_deterministic(self):
        self.assertEqual(run_backtest(SPECS[C25_ID], VERDICTS), run_backtest(SPECS[C25_ID], VERDICTS))

    def test_more_trials_lower_the_deflated_sharpe(self):
        values = [12.0, -5.0, 8.0, 3.0, -2.0, 9.0, 4.0, -1.0, 7.0, 6.0] * 4
        alone = deflated_sharpe(values, [])
        crowded = deflated_sharpe(values, [0.1, 0.5, -0.3, 0.4, 0.2, -0.1, 0.6, 0.3])
        self.assertLess(crowded, alone)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        verdicts_db = os.path.join(cls.dir, "verdicts.sqlite")
        store = VerdictStore(verdicts_db, product_config(VERDICT_CONFIG, BTC, "1"))
        store.register_product(BTC, "1")
        for verdict in VERDICTS:
            store.append(verdict)
        store.close()
        cls.registry = StrategyRegistry(os.path.join(cls.dir, "strategies.sqlite"))
        cls.registry.seed(SPECS)
        service = StrategyService(cls.registry, verdicts_db, {BTC: "1"})
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service))
        cls.base = "http://127.0.0.1:{}/api-strategies".format(cls.server.server_address[1])
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.registry.close()
        shutil.rmtree(cls.dir)

    def call(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_ranking_backtest_evaluate_and_save(self):
        status, ranking = self.call("/ranking?product=PF_XBTUSD&days=7")
        self.assertEqual(status, 200)
        self.assertEqual({r["id"] for r in ranking["strategies"]}, set(STRATEGY_IDS))
        self.assertIsNotNone(ranking["buy_and_hold_pct"])
        status, backtest = self.call("/backtest", {"id": C27_ID, "product": BTC, "days": 7})
        self.assertEqual(status, 200)
        self.assertEqual(backtest["spec_hash"], spec_hash(SPECS[C27_ID]))
        status, evaluation = self.call("/evaluate", {"id": C25_ID, "product": BTC})
        self.assertEqual(status, 200)
        self.assertIn(evaluation["proposal"]["action"], ("WAIT", "ABSTAIN", "LONG", "SHORT"))
        spec = copy.deepcopy(SPECS[C26_ID])
        spec["params"]["rsi_oversold"] = "25"
        status, saved = self.call("/strategies", {"spec": spec, "mode": "new", "new_name": "Reversion 25"})
        self.assertEqual((status, saved["state"]), (200, "draft"))
        status, exported = self.call("/strategies/{}/export".format(saved["id"]))
        self.assertEqual(exported["params"]["rsi_oversold"], "25")
        status, refused = self.call("/strategies/{}/state".format(saved["id"]), {"state": "active"})
        self.assertEqual((status, refused["error"]), (409, "gate_failed"))
        status, schema = self.call("/schema")
        self.assertIn("1m.rsi14", [o["ref"] for o in schema["operands"]])


if __name__ == "__main__":
    unittest.main()
