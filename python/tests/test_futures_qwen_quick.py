import json
import os
import tempfile
import unittest

from balancita_engine import futures_qwen_quick_api as quick_api
from balancita_engine import futures_qwen_trader_exam as ex
from balancita_engine import strategy_gate_models as models
from balancita_engine.futures_strategy_gate_api import GateApiError
from test_futures_qwen_exam import CFG3, cfg3, state_policy
from test_futures_qwen_trader import HOLDOUT, ClockedProvider, MemHistory


class QuickTestTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = os.path.join(self.dir.name, "exam-v3-rapida.sqlite")
        self.state = os.path.join(self.dir.name, ex.QUICK_STATE)

    def test_the_sample_is_a_smaller_stratified_exam_config(self):
        quick = ex.quick_cfg(CFG3)
        self.assertEqual(quick["exam"]["snapshots"], 150)
        self.assertEqual(CFG3["exam"]["snapshots"], 2000)                 # the full exam's config is untouched
        self.assertEqual(ex.quick_cfg(CFG3, 155)["exam"]["snapshots"], 150)  # whole photos per time bin

    def test_it_leaves_its_state_and_never_touches_the_full_exam_database(self):
        full = os.path.join(self.dir.name, "exam-v3.sqlite")
        open(full, "w").close()
        clock = [0.0]
        state = ex.run_quick(MemHistory(), self.db, ClockedProvider(clock, entries=state_policy), cfg3(), HOLDOUT,
                             snapshots=30, max_minutes=500, clock=lambda: clock[0], log=lambda *a: None)
        self.assertEqual(state["state"], "done")
        self.assertEqual((state["answered"], state["total"]), (30, 30))
        self.assertEqual(os.path.getsize(full), 0)
        with open(self.state, encoding="utf-8") as handle:
            saved = json.load(handle)
        self.assertEqual(saved["state"], "done")
        self.assertIn("orientativa", saved["summary"]["note"])
        self.assertEqual(saved["summary"]["photos"], 30)

    def test_each_run_starts_from_scratch_and_keeps_the_previous_sample_aside(self):
        clock = [0.0]
        for _ in range(2):
            ex.run_quick(MemHistory(), self.db, ClockedProvider(clock, entries=state_policy), cfg3(), HOLDOUT,
                         snapshots=30, max_minutes=500, clock=lambda: clock[0], log=lambda *a: None)
        self.assertTrue(os.path.exists(self.db + ".anterior"))

    def test_a_failure_reaches_the_screen_instead_of_raising(self):
        class Down:
            def health(self):
                return False

        state = ex.run_quick(MemHistory(), self.db, Down(), cfg3(), HOLDOUT, snapshots=30, log=lambda *a: None)
        self.assertEqual(state["state"], "failed")
        self.assertIn("llama-server", state["error"])


class QuickApiTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.spawned = []
        self.api = quick_api.QuickTestApi(os.path.join(self.dir.name, "exam-v3.sqlite"), python="py",
                                          spawn=lambda *a: self.spawned.append(a), news_only=False)

    def test_only_qwen_live_has_a_quick_test(self):
        with self.assertRaises(GateApiError):
            self.api.status("c25-pullback-perp-v1")

    def test_status_none_launch_then_running_refuses_a_second(self):
        self.assertEqual(self.api.status(models.QWEN_LIVE_ID)["state"], "none")
        self.api.launch(models.QWEN_LIVE_ID)
        args = self.spawned[0][0]
        self.assertIn("--quick", args)
        with open(self.api.state_path, "w", encoding="utf-8") as handle:
            json.dump({"state": "running", "pid": os.getpid()}, handle)
        self.assertEqual(self.api.status(models.QWEN_LIVE_ID)["state"], "running")
        with self.assertRaises(GateApiError):
            self.api.launch(models.QWEN_LIVE_ID)

    def test_a_dead_process_is_reported_as_failed(self):
        with open(self.api.state_path, "w", encoding="utf-8") as handle:
            json.dump({"state": "running", "pid": 2 ** 22 + 12345}, handle)
        self.assertEqual(self.api.status(models.QWEN_LIVE_ID)["state"], "failed")

    def test_formula_eth_entry_launches_formula_variant_with_env(self):
        res = self.api.launch(models.QWEN_LIVE_ID, variant="formula", exigencia_levels={
            "maestro": 5, "portero": 5, "analista": "apagado", "medicion": "honesta", "entrada": "formula_eth"
        })
        self.assertEqual(res, {"started": True, "variant": "formula"})
        args, env, _, _ = self.spawned[-1]
        self.assertIn("formula", args)
        self.assertEqual(env.get("QWEN_ENTRADA"), "formula_eth")


if __name__ == "__main__":
    unittest.main()
