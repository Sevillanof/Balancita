import json
import os
import tempfile
import unittest

from balancita_engine import futures_qwen_quick_api as quick_api
from balancita_engine import futures_qwen_quick_variants as qv
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as ex
from balancita_engine import strategy_gate_models as models
from balancita_engine.futures_strategy_gate_api import GateApiError
from test_futures_qwen_exam import CFG3, cfg3, state_policy
from test_futures_qwen_trader import HOLDOUT, ClockedProvider, MemHistory


class VariantConfigTests(unittest.TestCase):
    def test_the_control_is_first_and_changes_nothing(self):
        variants = qv.load_variants()
        self.assertEqual(variants[0]["id"], qv.CONTROL)
        self.assertEqual(qt.config_hash(qv.apply_variant(CFG3, variants[0])), qt.config_hash(CFG3))

    def test_every_variant_is_its_own_version_and_never_edits_the_base_config(self):
        before = qt.config_hash(CFG3)
        hashes = {}
        for variant in qv.load_variants():
            applied = qv.apply_variant(CFG3, variant)
            hashes[variant["id"]] = qt.config_hash(applied)
            self.assertEqual(variant["kind"] == "prompt", applied["prompt"]["version"] != CFG3["prompt"]["version"])
            self.assertEqual((variant["kind"] == "model"), "model" in variant)
        self.assertEqual(qt.config_hash(CFG3), before)
        prompt_variants = [h for k, h in hashes.items() if k.startswith("p")]
        self.assertEqual(len(set(prompt_variants + [hashes[qv.CONTROL]])), len(prompt_variants) + 1)
        for variant in qv.load_variants():                            # model variants ask the same questions as the control
            if variant["kind"] == "model":
                self.assertEqual(hashes[variant["id"]], hashes[qv.CONTROL])

    def test_each_variant_has_its_own_files_the_control_keeps_the_old_ones(self):
        self.assertEqual(qv.db_name(qv.CONTROL), "exam-v3-rapida.sqlite")
        self.assertEqual(qv.state_name(qv.CONTROL), "rapida-v3.json")
        names = {qv.db_name(v["id"]) for v in qv.load_variants()} | {qv.state_name(v["id"]) for v in qv.load_variants()}
        self.assertEqual(len(names), 2 * len(qv.load_variants()))

    def test_every_prompt_option_set_is_answerable_with_a_letter_and_models_use_loopback_ports(self):
        for variant in qv.load_variants():
            flat = (variant.get("prompt") or {}).get("flat")
            if flat:
                self.assertIn("LARGO", [o["id"] for o in flat["options"]])
                self.assertIn("CORTO", [o["id"] for o in flat["options"]])
            if variant.get("model"):
                self.assertNotEqual(variant["model"]["port"], 8088)       # never the live operator's server

    def test_unknown_variant(self):
        with self.assertRaises(qv.VariantError):
            qv.get_variant("nope")

    def test_a_prompt_variant_runs_the_quick_test_on_the_same_photos(self):
        with tempfile.TemporaryDirectory() as tmp:
            seen = {}
            for variant in qv.load_variants()[:3]:
                clock = [0.0]
                db = os.path.join(tmp, qv.db_name(variant["id"]))
                state = ex.run_quick(MemHistory(), db, ClockedProvider(clock, entries=state_policy),
                                     qv.apply_variant(cfg3(), variant), HOLDOUT, snapshots=30, max_minutes=500,
                                     clock=lambda: clock[0], log=lambda *a: None,
                                     state_path=os.path.join(tmp, qv.state_name(variant["id"])), variant=variant)
                self.assertEqual((state["state"], state["variant"]), ("done", variant["id"]))
                pdb = qt.PracticeDB(db, readonly=True)
                try:
                    seen[variant["id"]] = sorted(r[0] for r in pdb.db.execute("SELECT snap_id FROM exam_snapshots"))
                finally:
                    pdb.close()
            first = next(iter(seen.values()))
            self.assertTrue(all(ids == first for ids in seen.values()))


class ModelServerTests(unittest.TestCase):
    MODEL = {"file": "Fake-4B-Q8_0.gguf", "hf": "org/Fake-4B-GGUF:Q8_0", "approx_gb": 4.0, "port": 8090}

    def test_finds_the_file_in_the_known_places_and_ignores_empty_ones(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertIsNone(qv.find_model_file(self.MODEL, env={}, home=home))
            os.makedirs(os.path.join(home, "models", "x"))
            path = os.path.join(home, "models", "x", self.MODEL["file"])
            open(path, "w").close()
            self.assertIsNone(qv.find_model_file(self.MODEL, env={}, home=home))
            with open(path, "w") as handle:
                handle.write("gguf")
            self.assertEqual(qv.find_model_file(self.MODEL, env={}, home=home), path)

    def test_a_missing_model_says_so_and_downloads_nothing(self):
        launched = []
        with tempfile.TemporaryDirectory() as home:
            server = qv.ModelServer(self.MODEL, env={"HOME": home}, popen=lambda *a, **k: launched.append(a),
                                    health=lambda: False)
            old = os.environ.get("HOME")
            os.environ["HOME"] = home
            try:
                with self.assertRaises(qv.VariantError) as caught:
                    server.__enter__()
            finally:
                os.environ["HOME"] = old
        self.assertIn("falta el modelo", str(caught.exception))
        self.assertEqual(launched, [])

    def test_it_refuses_a_busy_port_and_a_non_loopback_url(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, "models"))
            with open(os.path.join(home, "models", self.MODEL["file"]), "w") as handle:
                handle.write("gguf")
            os.environ["QUICK_MODELS_DIR"] = os.path.join(home, "models")
            try:
                with self.assertRaises(qv.VariantError):
                    qv.ModelServer(self.MODEL, popen=None, health=lambda: True).__enter__()
            finally:
                del os.environ["QUICK_MODELS_DIR"]


class VariantApiTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.spawned = []
        self.api = quick_api.QuickTestApi(os.path.join(self.dir.name, "exam-v3.sqlite"), python="py",
                                          spawn=lambda *a: self.spawned.append(a))

    def test_status_lists_the_variants_and_launch_names_the_one_chosen(self):
        status = self.api.status(models.QWEN_LIVE_ID)
        self.assertEqual(status["state"], "none")
        self.assertEqual([v["id"] for v in status["variants"]], [v["id"] for v in qv.load_variants()])
        self.assertEqual(self.api.launch(models.QWEN_LIVE_ID, "p1-direccion")["variant"], "p1-direccion")
        args = self.spawned[0][0]
        self.assertEqual(args[args.index("--variant") + 1], "p1-direccion")

    def test_no_variant_means_the_control(self):
        self.assertEqual(self.api.launch(models.QWEN_LIVE_ID)["variant"], qv.CONTROL)

    def test_unknown_variant_is_a_404_and_one_test_at_a_time_across_variants(self):
        with self.assertRaises(GateApiError) as caught:
            self.api.launch(models.QWEN_LIVE_ID, "nope")
        self.assertEqual(caught.exception.status, 404)
        with open(os.path.join(self.dir.name, qv.state_name("p2-horizonte")), "w", encoding="utf-8") as handle:
            json.dump({"state": "running", "pid": os.getpid(), "started_ms": 5}, handle)
        with self.assertRaises(GateApiError) as busy:
            self.api.launch(models.QWEN_LIVE_ID, "m1-qwen3-8b")
        self.assertEqual(busy.exception.status, 409)
        self.assertEqual(self.api.status(models.QWEN_LIVE_ID)["variant"], "p2-horizonte")   # the last one started

    def test_finished_variants_carry_their_summary_for_the_comparison(self):
        summary = {"photos": 150, "extremes_net_bp": -5.3}
        with open(os.path.join(self.dir.name, qv.state_name("p1-direccion")), "w", encoding="utf-8") as handle:
            json.dump({"state": "done", "started_ms": 9, "summary": summary}, handle)
        row = next(v for v in self.api.status(models.QWEN_LIVE_ID)["variants"] if v["id"] == "p1-direccion")
        self.assertEqual((row["state"], row["summary"]), ("done", summary))


if __name__ == "__main__":
    unittest.main()
