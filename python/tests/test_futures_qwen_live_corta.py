"""Qwen en vivo versión 8: la FICHA CORTA (``futures_qwen_corta``). El estado de cuatro renglones, el espejo que da vuelta solo al
maestro, los datos incompletos que omiten el despertar sin preguntar, la posición sin stop con cierre a las 48 h, la identidad de las
fórmulas y el Examen de fotos con la config en vivo. Proveedor falso, velas inventadas, bases temporales."""
import copy
import re
import unittest

from balancita_engine import futures_qwen_corta as corta
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_maestro as maestro
from balancita_engine import futures_qwen_portero as portero
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as ex
from test_futures_qwen_live import BAR, LIVE_CFG, MIN, Policy, make
from test_futures_qwen_trader import HOLDOUT, MemHistory, START_DAY

LINES = ("1. Maestro de dirección", "2. Portero", "3. Volatilidad", "4. Posición")


def score_of(text):
    """The maestro's score written in the sheet («puntaje +0,41»)."""
    return float(re.search(r"puntaje ([+-]?\d+,\d+)", text).group(1).replace(",", "."))


class SheetTests(unittest.TestCase):
    def test_the_state_is_the_short_sheet_with_the_rules_and_nothing_of_the_eight_lines(self):
        env = make(self)
        env.op.start()
        env.advance(30)
        texts = [r["state_text"] for r in env.rows("SELECT state_text FROM decisions")]
        self.assertTrue(texts)
        for text in texts:
            for line in LINES:
                self.assertIn(line, text)
            self.assertIn("Posición: ninguna.", text)
            self.assertIn("CONVIENE ENTRAR", text)                    # «CONVIENE ENTRAR» or «NO CONVIENE ENTRAR»
            self.assertRegex(text, r"Volatilidad: (ALTA|NORMAL|BAJA)")
            self.assertRegex(text, r"Maestro[^\n]*: (SUBE FUERTE|SUBE FLOJO|NADA CLARO|BAJA FLOJO|BAJA FUERTE) \(puntaje")
            self.assertIn("sin stop automático; cierre obligatorio a las 48 h", text)
            self.assertIn("Costo de entrar y salir", text)
            self.assertNotIn("F1 ", text)
            self.assertNotIn("Ficha de 8", text)
            self.assertNotIn("Funding", text)
        self.assertEqual(env.rows("SELECT * FROM skipped"), [])
        # the config says what the sheet shows: the thresholds of the maestro and the portero come from their files
        t, k = corta.formulas(LIVE_CFG)
        self.assertIn("fuerte desde {}".format(qt.es(t["umbrales"]["fuerte"], 2)), texts[0])
        self.assertIn("conviene desde {}".format(qt.es(k["umbral"], 2)), texts[0])

    def test_the_mirror_turns_the_maestro_and_leaves_the_portero_and_the_volatility(self):
        env = make(self)
        env.op.start()
        env.advance(15)
        trader = env.op.traders["PF_XBTUSD"]
        t_ms = trader.t[-1] + BAR
        real = trader.state_text(t_ms, ["cada_15_min"]).split("\n")
        mirror = trader.state_text(t_ms, ["cada_15_min"], mirror=True).split("\n")
        self.assertEqual(len(real), len(mirror))
        self.assertAlmostEqual(score_of(real[1]), -score_of(mirror[1]), places=6)
        r = corta.readings(trader, t_ms)
        self.assertIn(corta.WORDS[r["veredicto"]], real[1])
        self.assertIn(corta.WORDS[-r["veredicto"]], mirror[1])
        self.assertEqual(real[2:], mirror[2:])                         # portero, volatility, position, cost, rules: the same
        # the readings are the formulas of the repo applied to the sheet's facts
        self.assertAlmostEqual(r["puntaje"], maestro.score(corta.formulas(LIVE_CFG)[0], r["hechos"]))
        self.assertEqual(r["portero_si"], portero.verdict(corta.formulas(LIVE_CFG)[1], r["hechos"], r["puntaje"])[0])

    def test_the_mirror_test_still_blocks_a_side_that_does_not_come_from_the_maestro(self):
        env = make(self, policy=Policy(flat="LARGO"), mirror=True)
        env.op.start()
        env.advance(60)
        rows = env.rows("SELECT action, model_action, override FROM decisions")
        self.assertTrue(rows)
        self.assertTrue(all(r["model_action"] == "LARGO" and r["action"] == "ESPERAR" and r["override"] == "espejo" for r in rows))

    def test_the_position_line_says_the_result_the_time_left_and_what_the_maestro_says_now(self):
        env = make(self, policy=Policy(flat="LARGO"))
        env.op.start()
        env.advance(60)
        texts = [r["state_text"] for r in env.rows("SELECT state_text FROM decisions WHERE kind='position'")]
        self.assertTrue(texts)
        for text in texts:
            self.assertRegex(text, r"4\. Posición: LARGO abierta hace \d+ min|4\. Posición: LARGO abierta hace \d+ h")
            self.assertIn("Resultado si cerrás ahora, ya con todos los costos:", text)
            self.assertRegex(text, r"El maestro ahora (va a favor de la posición|va EN CONTRA de la posición \((flojo|fuerte)\)|no dice nada claro)\.")
            self.assertIn("Cierre obligatorio dentro de 47 h", text)
            self.assertIn("Portero (solo cuenta para entrar)", text)
        trades = env.rows("SELECT * FROM trades WHERE status='open'")
        self.assertEqual(len(trades), 2)
        self.assertTrue(all(t["stop_px"] is None and t["max_hold_ms"] == 2880 * MIN for t in trades))


class IncompleteDataTests(unittest.TestCase):
    def test_without_the_other_assets_the_wake_is_omitted_and_qwen_is_not_asked(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg["state_context"] = []                                          # no other assets: the relative strength is n/d
        env = make(self, cfg=cfg, policy=Policy(flat="LARGO"))
        env.op.start()
        env.advance(60)
        skipped = env.rows("SELECT * FROM skipped ORDER BY t_ms")
        self.assertEqual(len(skipped), 8)                                  # 2 products x 4 wakes
        self.assertTrue(all(r["reason"] == "datos_incompletos" and "otros activos" in r["detail"] for r in skipped))
        self.assertEqual(env.rows("SELECT * FROM decisions"), [])
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertEqual(env.provider.calls, 0)
        self.assertTrue(any("datos_incompletos" in line or "incompleta" in line for line in env.logs))

    def test_in_position_the_same_omits_the_question_and_the_position_stays_until_the_data_is_back(self):
        env = make(self, policy=Policy(flat="LARGO", position="CERRAR"))
        env.op.start()
        env.advance(15)                                                    # opens on the first wake
        self.assertEqual(len(env.rows("SELECT * FROM trades WHERE status='open'")), 2)
        saved = {p: trader.context for p, trader in env.op.traders.items()}
        for trader in env.op.traders.values():
            trader.context = {}
        env.advance(30)
        self.assertEqual({r["reason"] for r in env.rows("SELECT reason FROM skipped")}, {"datos_incompletos"})
        self.assertEqual(len(env.rows("SELECT * FROM trades WHERE status='open'")), 2)     # nothing closed blindly
        for p, trader in env.op.traders.items():
            trader.context = saved[p]
        env.advance(15)
        self.assertEqual(len(env.rows("SELECT * FROM trades WHERE status='closed'")), 2)   # asked again: Qwen closes

    def test_missing_says_what_is_missing(self):
        self.assertEqual(corta.missing({"strength": None, "area": None, "realized": 1.0}), ["otros activos", "área de valor"])
        self.assertEqual(corta.missing({"strength": 0.1, "area": {}, "realized": None}), ["volatilidad de la semana"])
        self.assertEqual(corta.missing({"strength": 0.1, "area": {}, "realized": 1.0}), [])


class IdentityTests(unittest.TestCase):
    def test_the_formulas_are_the_files_the_config_declares_and_another_formula_is_refused(self):
        t, k = corta.formulas(LIVE_CFG)
        self.assertTrue(maestro.teacher_hash(t).startswith(LIVE_CFG["corta"]["maestro_hash"]))
        self.assertTrue(portero.portero_hash(k).startswith(LIVE_CFG["corta"]["portero_hash"]))
        other = copy.deepcopy(LIVE_CFG)
        other["corta"]["portero_hash"] = "000000000000"
        with self.assertRaises(qt.TraderError):
            corta.formulas(other)
        incomplete = copy.deepcopy(LIVE_CFG)
        del incomplete["corta"]["maestro"]
        with self.assertRaises(qt.TraderError):
            corta.formulas(incomplete)

    def test_version_8_is_another_identity_than_version_7_and_version_7_is_frozen(self):
        v7 = qt.load_config(qt.CONFIG_PATH_LIVE_V7)
        self.assertNotEqual(qt.config_hash(LIVE_CFG), qt.config_hash(v7))
        self.assertNotEqual(live.identity_of(LIVE_CFG), live.identity_of(v7))
        self.assertEqual((LIVE_CFG["prompt"]["version"], v7["prompt"]["version"]), (7, 6))
        self.assertTrue(v7["state_ficha"] and v7["factors"]["question"] and v7["lora"]["request"])
        self.assertEqual(v7["guardrails"]["max_hold_min"], 240)
        self.assertNotIn("state_corta", v7)
        self.assertIsNone(qt.lora_of(LIVE_CFG))                             # no adapter in the live requests of v8
        # changing a formula hash changes the identity (a new database)
        changed = copy.deepcopy(LIVE_CFG)
        changed["corta"]["portero_hash"] = "otro"
        self.assertNotEqual(qt.config_hash(LIVE_CFG), qt.config_hash(changed))


class ExamTests(unittest.TestCase):
    def test_the_photos_of_the_live_config_carry_the_short_sheet_and_its_mirror(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg["practice"] = dict(cfg["practice"], **{"from": START_DAY})
        cfg["exam"] = dict(cfg["exam"], horizons_min=[720])
        history = MemHistory()
        cfg["state_context"] = sorted(history.series)                      # the in-memory series (no SOL here)
        photos = ex.make_photos(history, cfg, "PF_XBTUSD", HOLDOUT)
        self.assertTrue(photos)
        self.assertTrue(all("1. Maestro" in p["state_text"] and "1. Maestro" in p["mirror_text"] for p in photos))
        self.assertTrue(all(score_of(p["state_text"]) == -score_of(p["mirror_text"]) for p in photos))
        self.assertTrue(all(p["t_ms"] % (15 * MIN) == 0 for p in photos))
        self.assertNotIn("hechos", photos[0])                              # the LoRA's facts belong to the 8-factor sheet (v7)


if __name__ == "__main__":
    unittest.main()
