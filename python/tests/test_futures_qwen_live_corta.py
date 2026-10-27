"""Qwen en vivo versión 8: la FICHA CORTA (``futures_qwen_corta``). El estado de cuatro renglones, el espejo que da vuelta solo al
maestro, los datos incompletos que omiten el despertar sin preguntar, la posición sin stop con cierre a las 48 h, la identidad de las
fórmulas y el Examen de fotos con la config en vivo. Proveedor falso, velas inventadas, bases temporales."""
import copy
import os
import sqlite3
import tempfile
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
            self.assertIn("sin stop automático; cierre obligatorio a las 36 h", text)
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
            self.assertIn("Cierre obligatorio dentro de", text)         # version 9: 36 h safety net
            self.assertIn("Portero (solo cuenta para entrar)", text)
        trades = env.rows("SELECT * FROM trades WHERE status='open'")
        self.assertEqual(len(trades), 2)
        self.assertTrue(all(t["stop_px"] is None and t["max_hold_ms"] == 2160 * MIN for t in trades))


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
        self.assertEqual((LIVE_CFG["prompt"]["version"], v7["prompt"]["version"]), (8, 6))
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
        cfg = exam_cfg(horizons_min=[720])
        photos = ex.make_photos(MemHistory(), cfg, "PF_XBTUSD", HOLDOUT)
        self.assertTrue(photos)
        self.assertTrue(all("1. Maestro" in p["state_text"] and "1. Maestro" in p["mirror_text"] for p in photos))
        self.assertTrue(all(score_of(p["state_text"]) == -score_of(p["mirror_text"]) for p in photos))
        self.assertTrue(all(p["t_ms"] % (15 * MIN) == 0 for p in photos))
        self.assertNotIn("hechos", photos[0])                              # the LoRA's facts belong to the 8-factor sheet (v7)

    def test_the_photos_start_at_exam_from_and_never_before_practice_from(self):
        cfg = copy.deepcopy(LIVE_CFG)
        self.assertEqual(cfg["exam"]["from"], "2025-10-01")                  # after the day the two formulas were fitted with
        self.assertEqual(cfg["exam"]["products"], ["PF_XBTUSD", "PF_ETHUSD"])  # the two products the live operator runs
        cfg["practice"] = dict(cfg["practice"], **{"from": "2025-09-01"})
        self.assertEqual(ex.exam_start_ms(cfg), qt.date_ms("2025-10-01"))
        cfg["practice"] = dict(cfg["practice"], **{"from": "2025-10-16"})      # --exam-from later than exam.from wins
        self.assertEqual(ex.exam_start_ms(cfg), qt.date_ms("2025-10-16"))
        cfg["exam"].pop("from")
        self.assertEqual(ex.exam_start_ms(cfg), qt.date_ms("2025-10-16"))
        self.assertNotIn("from", qt.load_config(qt.CONFIG_PATH_LIVE_V7)["exam"])   # version 7 keeps its photos as they were


def exam_cfg(**exam):
    """The live config over the in-memory candles: photos from START_DAY, the in-memory series as context."""
    cfg = copy.deepcopy(LIVE_CFG)
    cfg["guardrails"]["max_hold_min"] = 2880      # the operation of version 8 (48 h limit): these tests measure that rule; version 9 has none
    cfg["practice"] = dict(cfg["practice"], **{"from": START_DAY})
    cfg["exam"] = dict(cfg["exam"], products=["PF_XBTUSD"], **exam)
    cfg["exam"].pop("from", None)
    cfg["state_context"] = sorted(MemHistory().series)
    return cfg


class OperationPhotosTests(unittest.TestCase):
    """Every photo of the short sheet carries the version 8 operation: enter at the photo, out when the maestro turns at least
    flojo against it or at 48 h, on each side."""

    @classmethod
    def setUpClass(cls):
        cls.history = MemHistory()
        cls.cfg = exam_cfg()
        cls.photos = ex.make_photos(cls.history, cls.cfg, "PF_XBTUSD", HOLDOUT)

    def test_every_photo_has_the_formulas_and_the_operation_on_both_sides(self):
        self.assertGreater(len(self.photos), 100)
        hold = self.cfg["guardrails"]["max_hold_min"] * MIN
        for p in self.photos:
            op = p["operacion"]
            self.assertIn(op["maestro"], (-2, -1, 0, 1, 2))
            self.assertIsInstance(op["portero_si"], bool)
            self.assertIn(op["volatilidad"], ("ALTA", "NORMAL", "BAJA"))
            for side in ("largo", "corto"):
                leg = op[side]
                self.assertIn(leg["motivo"], (ex.OP_WHY_FLIP, ex.OP_WHY_TIME))
                self.assertTrue(0 < leg["salida_ms"] - p["t_ms"] <= hold)
                self.assertEqual((leg["salida_ms"] - p["t_ms"]) % (15 * MIN), 0)
                self.assertAlmostEqual(leg["horas"], (leg["salida_ms"] - p["t_ms"]) / qt.HOUR_MS)
                if leg["motivo"] == ex.OP_WHY_TIME:
                    self.assertEqual(leg["salida_ms"], p["t_ms"] + hold)
        kinds = {p["operacion"]["largo"]["motivo"] for p in self.photos} | {p["operacion"]["corto"]["motivo"] for p in self.photos}
        self.assertEqual(kinds, {ex.OP_WHY_FLIP, ex.OP_WHY_TIME})

    def test_the_net_is_the_move_to_the_exit_candle_minus_the_round_trip_cost(self):
        closes = {int(b["bucket_start"]) + qt.BAR_MS: float(b["close"]) for b in self.history.bars("PF_XBTUSD", 0, HOLDOUT)}
        for p in self.photos[::25]:
            for side, sign in (("largo", 1), ("corto", -1)):
                leg = p["operacion"][side]
                expected = sign * (closes[leg["salida_ms"]] / closes[p["t_ms"]] - 1) * 1e4 - p["cost_bp"]
                self.assertAlmostEqual(leg["neto_bp"], expected, places=6)
        same = [p for p in self.photos if p["operacion"]["largo"]["salida_ms"] == p["operacion"]["corto"]["salida_ms"]]
        for p in same:                                            # the same exit on both sides: one wins what the other loses
            self.assertAlmostEqual(p["operacion"]["largo"]["neto_bp"] + p["operacion"]["corto"]["neto_bp"], -2 * p["cost_bp"], places=6)

    def test_a_flip_exit_is_the_first_later_wake_where_the_maestro_says_at_least_flojo_against(self):
        teacher = corta.formulas(self.cfg)[0]
        weak = teacher["umbrales"]["flojo"]
        # the photos are every wake with complete data (the last ones, without a 48 h close, are not photos): their scores
        scores = {p["t_ms"]: p["operacion"]["puntaje"] for p in self.photos}
        checked = 0
        for p in self.photos[::10]:
            for side, sign in (("largo", 1), ("corto", -1)):
                leg = p["operacion"][side]
                between = [t for t in scores if p["t_ms"] < t < leg["salida_ms"]]
                self.assertTrue(all(sign * scores[t] > -weak for t in between), "an earlier wake already said against")
                if leg["motivo"] == ex.OP_WHY_FLIP and leg["salida_ms"] in scores:
                    self.assertLessEqual(sign * scores[leg["salida_ms"]], -weak)
                    checked += 1
        self.assertGreater(checked, 10)

    def test_a_wake_with_incomplete_data_is_no_photo(self):
        cfg = exam_cfg()
        cfg["state_context"] = []                                 # without the other assets the live operator is never asked
        self.assertEqual(ex.make_photos(MemHistory(), cfg, "PF_XBTUSD", HOLDOUT), [])

    def test_the_eight_factor_sheet_has_no_operation(self):
        cfg = qt.load_config(qt.CONFIG_PATH_LIVE_V7)
        cfg["practice"] = dict(cfg["practice"], **{"from": START_DAY})
        cfg["exam"] = dict(cfg["exam"], products=["PF_XBTUSD"], horizons_min=[240])
        cfg["state_context"] = sorted(MemHistory().series)
        photos = ex.make_photos(MemHistory(), cfg, "PF_XBTUSD", HOLDOUT)
        self.assertTrue(photos)
        self.assertTrue(all("operacion" not in p for p in photos))


def op_row(t_ms, action, mirror, maestro, portero, long_net, short_net, why="vuelta", p=0.9):
    leg = lambda net: {"salida_ms": t_ms + 4 * qt.HOUR_MS, "motivo": why, "horas": 4.0, "neto_bp": net}
    return {"snap_id": "exam:PF_XBTUSD:{}".format(t_ms), "product": "PF_XBTUSD", "t_ms": t_ms, "real_action": action, "real_p": p, "mirror_action": mirror,
            "mirror_p": p, "cost_bp": 10.0, "moves": {"720": 0.0, "1440": 0.0, "2880": 0.0},
            "operacion": {"maestro": maestro, "puntaje": 0.1 * maestro, "portero_si": portero, "portero_p": 0.7,
                          "volatilidad": "NORMAL", "largo": leg(long_net), "corto": leg(short_net)}}


class OperationNumbersTests(unittest.TestCase):
    def setUp(self):
        day = qt.DAY_MS
        self.cfg = exam_cfg()
        self.cfg["exam_rules"] = dict(self.cfg["exam_rules"], random_draws=200)
        self.rows = [
            op_row(1 * day, "LARGO", "CORTO", 2, True, 30.0, -50.0),            # enters long with the formulas: +30
            op_row(2 * day, "CORTO", "LARGO", -1, False, 20.0, -40.0),          # enters short against the portero: -40
            op_row(3 * day, "LARGO", "LARGO", 2, True, 60.0, -80.0),            # blocked by the mirror: no entry (formula +60)
            op_row(4 * day, "ESPERAR", None, -2, True, 15.0, -35.0),            # waits (formula short: -35)
            op_row(5 * day, "CORTO", "LARGO", 1, True, -70.0, 50.0, why="tiempo"),   # enters short, closed at 48 h: +50
            op_row(6 * day, "LARGO", "CORTO", 0, False, 10.0, -30.0, p=0.2),    # under the threshold: no entry
        ]

    def test_the_entries_are_what_the_live_operator_would_take_and_the_formulas_are_measured_on_the_same_photos(self):
        op = ex.analyse_operation(self.rows, self.cfg)
        q = op["qwen"]
        self.assertEqual((op["fotos"], q["n"], op["espejo_bloqueo"], op["espera"]), (6, 3, 1, 1))
        self.assertAlmostEqual(q["neto_bp"], (30.0 - 40.0 + 50.0) / 3)
        self.assertAlmostEqual(q["ganadoras"], 2 / 3)
        self.assertAlmostEqual(q["total_bp"], 40.0)
        self.assertEqual((q["por_vuelta"], q["por_tiempo"]), (2, 1))
        self.assertAlmostEqual(q["con_maestro"], 2 / 3)                      # the last entry (short, maestro +1) goes against
        self.assertAlmostEqual(q["con_portero"], 2 / 3)
        self.assertEqual(op["qwen_todas"]["n"], 5)
        self.assertEqual(op["formula"]["n"], 3)                               # photos 1, 3 and 4: strong maestro with portero
        self.assertAlmostEqual(op["formula"]["neto_bp"], (30.0 + 60.0 - 35.0) / 3)
        self.assertEqual(op["maestro_fuerte"]["n"], 3)
        self.assertAlmostEqual(op["siempre_largo"]["neto_bp"], (30.0 + 20.0 - 70.0) / 3)
        self.assertAlmostEqual(op["siempre_corto"]["neto_bp"], (-50.0 - 40.0 + 50.0) / 3)
        self.assertEqual(op["signals"]["gana"], True)
        self.assertEqual(op["signals"]["mejor_que_formula"], False)
        self.assertIsNotNone(q["vs_azar_pct"])
        self.assertEqual(op["max_horas"], 48.0)
        self.assertIn("48 h", op["salida"])

    def test_the_operation_carries_its_trades_by_time_for_the_screen(self):
        op = ex.analyse_operation(self.rows, self.cfg)
        self.assertEqual([t["neto_bp"] for t in op["curvas"]["qwen"]], [30.0, -40.0, 50.0])
        self.assertEqual([t["lado"] for t in op["curvas"]["qwen"]], [1, -1, -1])
        self.assertEqual(op["curvas"]["qwen"][2]["motivo"], "tiempo")
        self.assertEqual((op["curvas"]["qwen"][0]["maestro"], op["curvas"]["qwen"][0]["portero"]), (2, True))
        self.assertEqual(len(op["curvas"]["formula"]), 3)
        self.assertEqual(op["nocional_usd"], float(self.cfg["notional_usd"]))

    def test_the_formula_alone_opens_one_position_per_product(self):
        # the second photo comes while the first (4 h long) is still open: it is not an entry
        rows = [op_row(1 * qt.DAY_MS, "ESPERAR", None, 2, True, 30.0, -50.0),
                op_row(1 * qt.DAY_MS + qt.HOUR_MS, "ESPERAR", None, 2, True, 99.0, -99.0),
                op_row(2 * qt.DAY_MS, "ESPERAR", None, -2, True, 10.0, 25.0),
                op_row(3 * qt.DAY_MS, "ESPERAR", None, 2, False, 5.0, -5.0)]          # the portero says no
        out = ex.analyse_formula(rows, self.cfg)
        self.assertEqual(out["formula"]["n"], 2)
        self.assertAlmostEqual(out["formula"]["total_bp"], 30.0 + 25.0)
        self.assertEqual(out["maestro_fuerte"]["n"], 3)
        self.assertEqual([t["neto_bp"] for t in out["curvas"]["formula"]], [30.0, 25.0])
        self.assertEqual([t["neto_bp"] for t in out["curvas"]["siempre_largo"]], [30.0, 10.0])
        self.assertIsNone(ex.analyse_formula([dict(r, operacion=None) for r in rows], self.cfg))

    def test_without_operations_in_the_photos_there_is_no_block_and_no_section(self):
        rows = [dict(r, operacion=None) for r in self.rows]
        self.assertIsNone(ex.analyse_operation(rows, self.cfg))
        self.assertEqual(ex.operation_lines(rows, self.cfg), [])

    def test_the_report_section_says_the_entries_the_exits_and_the_table(self):
        text = "\n".join(ex.operation_lines(self.rows, self.cfg))
        self.assertIn("## Por operación (como opera la versión 8)", text)
        self.assertIn("**Qwen entró en 3 de 6 fotos**", text)
        self.assertIn("2 porque el maestro se dio vuelta, 1 por tiempo", text)
        self.assertIn("| La fórmula sola: maestro fuerte con portero a favor | 3 |", text)
        no_entry = ex.operation_lines([op_row(qt.DAY_MS, "ESPERAR", None, 2, True, 1.0, -2.0)], self.cfg)
        self.assertIn("Qwen no hizo ninguna entrada", "\n".join(no_entry))


class OperationExamTests(unittest.TestCase):
    """The exam of the live config stores the operation with the photos and the quick test reports it."""

    def test_the_quick_test_and_the_report_carry_the_operation(self):
        from test_futures_qwen_exam import state_policy
        from test_futures_qwen_trader import ClockedProvider
        cfg = ex.quick_cfg(exam_cfg(), 30)
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "e.sqlite")
            clock = [0.0]
            result = ex.run_exam(MemHistory(), db, ClockedProvider(clock, entries=state_policy), cfg, HOLDOUT, max_minutes=500,
                                 clock=lambda: clock[0], log=lambda *a: None)
            self.assertEqual(result["stop_reason"], "done")
            rows, _ = ex.load_answers(db)
            self.assertEqual(len(rows), 30)
            self.assertTrue(all(r["operacion"] and "largo" in r["operacion"] for r in rows))
            summary = ex.quick_summary(db, cfg)
            self.assertEqual(summary["operacion"]["fotos"], 30)
            self.assertEqual(summary["operacion"]["qwen"]["n"] + summary["operacion"]["espera"] + summary["operacion"]["espejo_bloqueo"]
                             + sum(1 for r in rows if r["real_action"] in ("LARGO", "CORTO") and r["real_p"] < cfg["practice_entry_threshold"]
                                   and qt.mirror_passes(r["real_action"], r["mirror_action"])), 30)
            self.assertIn("## Por operación (como opera la versión 8)", ex.build_exam_report(db, cfg))
            # a database written before the operation existed: the report still reads
            con = sqlite3.connect(db)
            with con:
                con.execute("DROP TABLE exam_operacion")
            con.close()
            rows, _ = ex.load_answers(db)
            self.assertTrue(all(r["operacion"] is None for r in rows))
            self.assertNotIn("operacion", ex.quick_summary(db, cfg))


if __name__ == "__main__":
    unittest.main()


class FormulaOnlyTests(unittest.TestCase):
    def test_the_formula_test_needs_no_model_and_leaves_its_summary_in_the_state_file(self):
        import json
        cfg = exam_cfg()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "rapida.json")
            state = ex.run_formula(MemHistory(), cfg, HOLDOUT, path, {"id": "formula"}, log=lambda *a: None)
            with open(path, encoding="utf-8") as handle:
                saved = json.load(handle)
        self.assertEqual((state["state"], saved["state"]), ("done", "done"))
        self.assertEqual(saved["variant"], "formula")
        op = saved["summary"]["formula"]
        self.assertGreater(op["fotos"], 0)
        self.assertEqual(op["formula"]["n"], len(op["curvas"]["formula"]))
        market = op["mercado"]["PF_XBTUSD"]
        self.assertTrue(market)
        self.assertTrue(all(t % qt.HOUR_MS == 0 and c > 0 for t, c in market))
        self.assertTrue(all(not p for p in [saved["summary"]["spearman"]]))
