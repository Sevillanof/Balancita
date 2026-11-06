"""``replay_formula`` con la configuración completa explícita (laboratorio de estrategias) y el camino por variables de entorno."""
import copy
import os
import tempfile
import unittest
from unittest import mock

from balancita_engine import futures_maker_exit as maker_exit
from balancita_engine import futures_qwen_analista as analista
from balancita_engine import futures_qwen_posiciones as posiciones
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as exam
from test_futures_qwen_live import BAR, LIVE_CFG, walk

START = qt.date_ms("2026-01-01")


def config():
    cfg = copy.deepcopy(LIVE_CFG)
    cfg.update(products=["PF_ETHUSD"], cuenta="entera", notional_usd="1000", decide_by="formula", opinion_enabled=False)
    cfg["exam"]["products"] = ["PF_ETHUSD"]
    cfg["exam"]["from"] = cfg["practice"]["from"] = "2026-01-01"
    cfg.pop("analista", None)
    return cfg


def lector(days=4):
    bars = walk(qt.MIN_BARS + days * 288, 1, START - qt.MIN_BARS * BAR, price=100)
    reader = mock.Mock()
    reader.bars.side_effect = lambda product, low, high, **kw: [b for b in bars if low <= b["bucket_start"] < high]
    reader.funding.return_value = [(at, 0) for at in range(START - qt.DAY_MS, START + 6 * qt.DAY_MS, qt.HOUR_MS)]
    return reader


def abre_si_esta_plana(trader, t_ms, reasons):
    if not trader.positions:
        trader._open(t_ms, "LONG", 1, "controlled_test")
    return []


class ReplayConfigTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(qt.Trader, "_decide", abre_si_esta_plana)
        patcher.start()
        self.addCleanup(patcher.stop)

    def replay(self, cfg=None, **kw):
        return exam.replay_formula(lector(), cfg or config(), START + 3 * qt.DAY_MS, **kw)

    def test_desde_ms_moves_the_start_of_the_replay_window(self):
        corto = self.replay(desde_ms=START + qt.DAY_MS)
        self.assertEqual(corto["desde_ms"], START + qt.DAY_MS)
        entradas = [c["entrada_ms"] for c in corto["curvas"]["formula"]]
        self.assertTrue(entradas)
        self.assertGreaterEqual(min(entradas), START + qt.DAY_MS)
        completo = [c["entrada_ms"] for c in self.replay()["curvas"]["formula"]]
        self.assertLess(min(completo), START + qt.DAY_MS)

    def test_desde_ms_never_moves_the_start_before_the_config_start(self):
        self.assertEqual(self.replay(desde_ms=START - 10 * qt.DAY_MS)["desde_ms"], START)

    def test_without_desde_ms_the_replay_is_what_it_was(self):
        self.assertEqual(self.replay(), self.replay(desde_ms=START))

    def test_the_explicit_config_is_the_only_source_of_the_knobs_and_is_not_mutated(self):
        cfg = config()
        antes = qt.config_hash(cfg)
        limpio = self.replay(cfg)
        entorno = {maker_exit.ENV: "fija", posiciones.ENV: "1", posiciones.ENV_REBOTES: "0", analista.ENV: "suave", "QWEN_CUENTA": "fija"}
        with mock.patch.dict(os.environ, entorno):
            con_entorno = self.replay(cfg)
        self.assertEqual(limpio, con_entorno)
        self.assertEqual(qt.config_hash(cfg), antes)
        self.assertEqual(cfg["cuenta"], "entera")

    def test_a_knob_in_the_explicit_config_changes_the_result(self):
        cfg = config()
        cfg["guardrails"]["max_hold_min"] = 600
        base = self.replay()["curvas"]["formula"]
        corta = self.replay(cfg)["curvas"]["formula"]
        self.assertEqual((corta[0]["salida_ms"] - corta[0]["entrada_ms"]) // qt.MINUTE_MS, 600)
        self.assertGreater(len(corta), len(base))


class EnvPathTests(unittest.TestCase):
    """Preservación: la prueba rápida («Solo la fórmula») sigue tomando las perillas del entorno antes de llamar a ``replay_formula``."""

    def run_formula(self, env):
        visto = {}
        def falso(history, cfg, holdout_ms, **kw):
            visto.update(cfg=cfg, holdout=holdout_ms, kw=kw)
            return None
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(os.environ, env), \
                mock.patch.object(exam, "replay_formula", falso):
            state = exam.run_formula(object(), config(), START, os.path.join(folder, "estado.json"), {"id": "formula"}, log=lambda *_: None)
        self.assertEqual(state["state"], "done", state)
        return visto

    def test_environment_knobs_still_reach_the_replay_config(self):
        base = self.run_formula({})
        self.assertEqual(posiciones.settings(base["cfg"]), posiciones.settings(config()))
        con = self.run_formula({posiciones.ENV: "1", posiciones.ENV_REBOTES: "0", "QWEN_CUENTA": "fija"})
        self.assertEqual(posiciones.settings(con["cfg"])["max"], 1)
        self.assertNotIn("rebotes", con["cfg"])
        self.assertEqual((con["cfg"]["cuenta"], con["cfg"]["notional_usd"]), ("fija", "100"))
        self.assertEqual(con["holdout"], START)


if __name__ == "__main__":
    unittest.main()
