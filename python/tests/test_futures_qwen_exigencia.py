import json
import os
import tempfile
import unittest

from balancita_engine import futures_qwen_corta as corta
from balancita_engine import futures_qwen_exigencia as ex
from balancita_engine import futures_qwen_maestro as maestro
from balancita_engine import futures_qwen_portero as portero
from balancita_engine import futures_qwen_quick_api as quick_api
from balancita_engine import futures_qwen_trader_exam as exam
from balancita_engine import strategy_gate_models as models
from balancita_engine.futures_strategy_gate_api import GateApi, GateApiError

# the attempts log of the tests lives in a temporary file, never in the machine's own
os.environ["BALANCITA_WF_INTENTOS"] = os.path.join(tempfile.mkdtemp(), "intentos.jsonl")

CONFIG = os.path.join(os.path.dirname(__file__), "..", "..", "config")


class ExigenciaTest(unittest.TestCase):
    def setUp(self):
        self.teacher = maestro.load(os.path.join(CONFIG, "qwen-lora-maestro.json"))
        self.keeper = portero.load(os.path.join(CONFIG, "qwen-portero.json"))

    def test_level_five_is_what_paper_operates(self):
        self.assertAlmostEqual(ex.maestro_fuerte(self.teacher, 5), self.teacher["umbrales"]["fuerte"])
        self.assertAlmostEqual(ex.portero_umbral(self.keeper, 5), self.keeper["umbral"])
        teacher, keeper = ex.apply(self.teacher, self.keeper, ex.levels())
        self.assertEqual(maestro.teacher_hash(teacher), maestro.teacher_hash(self.teacher))
        self.assertEqual(portero.portero_hash(keeper), portero.portero_hash(self.keeper))

    def test_thresholds_only_rise_with_the_level(self):
        m = [ex.maestro_fuerte(self.teacher, n) for n in range(11)]
        p = [ex.portero_umbral(self.keeper, n) for n in range(11)]
        self.assertEqual(m, sorted(m))
        self.assertEqual(p, sorted(p))
        self.assertEqual(p[0], 0.0)
        self.assertGreaterEqual(m[0], self.teacher["umbrales"]["flojo"])
        self.assertLess(p[10], 1.0)

    def test_apply_does_not_touch_the_originals(self):
        before = json.dumps([self.teacher, self.keeper], sort_keys=True)
        teacher, keeper = ex.apply(self.teacher, self.keeper, {"maestro": 10, "portero": 0})
        self.assertGreater(teacher["umbrales"]["fuerte"], self.teacher["umbrales"]["fuerte"])
        self.assertEqual(keeper["umbral"], 0.0)
        self.assertEqual(json.dumps([self.teacher, self.keeper], sort_keys=True), before)

    def test_levels_are_integers_from_0_to_10(self):
        for bad in (-1, 11, "x", 2.5):
            with self.assertRaises(ValueError):
                ex.levels(bad, 5)
        self.assertEqual(ex.levels("7", None), {"maestro": 7, "portero": 5})

    def test_env_default_changes_nothing(self):
        cfg = {"a": 1}
        self.assertIs(ex.apply_env(cfg, {}), cfg)
        self.assertEqual(ex.apply_env(cfg, {ex.ENV_PORTERO: "3"})["exigencia"], {"maestro": 5, "portero": 3})

    def test_formulas_use_the_levels_only_when_the_config_asks(self):
        with open(os.path.join(CONFIG, "qwen-live.json"), encoding="utf-8") as handle:
            base = json.load(handle)
        paper = corta.formulas(base)
        self.assertEqual(paper[0]["umbrales"], self.teacher["umbrales"])
        loose = corta.formulas(dict(base, exigencia={"maestro": 0, "portero": 0}))
        self.assertLess(loose[0]["umbrales"]["fuerte"], paper[0]["umbrales"]["fuerte"])
        self.assertEqual(corta.formulas(base)[1]["umbral"], self.keeper["umbral"])   # the cache stays clean


class ExigenciaWiringTest(unittest.TestCase):
    def test_quick_launch_hands_the_levels_to_the_process_and_defaults_to_paper(self):
        with tempfile.TemporaryDirectory() as folder:
            spawned = []
            api = quick_api.QuickTestApi(os.path.join(folder, "exam-v3.sqlite"), python="py",
                                         spawn=lambda *a: spawned.append(a), news_only=False)
            api.launch(models.QWEN_LIVE_ID, "formula", {"maestro": 8, "portero": "2"})
            env = spawned[0][1]
            self.assertEqual((env[ex.ENV_MAESTRO], env[ex.ENV_PORTERO]), ("8", "2"))
            os.remove(api.state_path) if os.path.exists(api.state_path) else None
            with self.assertRaises(GateApiError):
                api.launch(models.QWEN_LIVE_ID, "formula", {"maestro": 11})
            with self.assertRaises(GateApiError):
                api.launch(models.QWEN_LIVE_ID, "formula", {"otro": 1})

    def test_gate_levels_only_for_qwen_live(self):
        env = GateApi.exigencia_env({"exigencia": {"maestro": 3}}, models.QWEN_LIVE_ID)
        self.assertEqual(
            env,
            {ex.ENV_MAESTRO: "3", ex.ENV_PORTERO: "5", "QWEN_ANALISTA": "apagado", "QWEN_MEDICION": "honesta", "QWEN_ENTRADA": "formula",
         "QWEN_SALIDA": "sigue"},
        )
        self.assertEqual(GateApi.exigencia_env({}, models.QWEN_LIVE_ID), {})
        with self.assertRaises(GateApiError):
            GateApi.exigencia_env({"exigencia": {"maestro": 3}}, "c25-pullback-perp-v1")
        with self.assertRaises(GateApiError):
            GateApi.exigencia_env({"exigencia": {"maestro": 99}}, models.QWEN_LIVE_ID)

    def test_trades_per_week_over_the_span_of_the_photos(self):
        day = 86_400_000
        rows = [{"t_ms": 0}, {"t_ms": 14 * day}]
        self.assertAlmostEqual(exam._per_week({"n": 4}, rows)["por_semana"], 2.0)
        self.assertIsNone(exam._per_week({"n": 4}, [{"t_ms": 0}, {"t_ms": day}])["por_semana"])


if __name__ == "__main__":
    unittest.main()
