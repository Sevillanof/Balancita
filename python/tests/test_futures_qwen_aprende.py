"""Que Qwen aprenda junto al maestro (versión 9): las etiquetas por resultado neto, el puntaje de una opinión, el dataset con la
pregunta real y las dos órdenes de letras, y la etiqueta de las miradas guardadas en vivo. Sin modelo, velas inventadas."""
import json
import os
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_aprende as ap
from balancita_engine import futures_qwen_corta as corta
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt
from unittest import mock

from test_futures_qwen_live import Policy, make

CFG = qt.load_config(qt.CONFIG_PATH_LIVE)
MIN = qt.MINUTE_MS


def flat_row(label, month="2025-11", largo=10.0, corto=-10.0, formula="ESPERAR", t_ms=0):
    return {"kind": "flat", "product": "PF_XBTUSD", "t_ms": t_ms, "month": month, "state_text": "S real", "mirror_text": "S espejo",
            "label": label, "largo_bp": largo, "corto_bp": corto, "formula": formula}


def pos_row(trade, t_ms, now, final, label):
    return {"kind": "position", "product": "PF_XBTUSD", "t_ms": t_ms, "month": "2025-11", "state_text": "P", "trade": trade,
            "net_now_bp": now, "final_bp": final, "label": label, "formula": "MANTENER"}


class LabelTests(unittest.TestCase):
    def test_flat_label_is_the_side_that_pays_after_costs_or_wait(self):
        self.assertEqual(ap.flat_label(80.0, -60.0), "LARGO")
        self.assertEqual(ap.flat_label(-60.0, 80.0), "CORTO")
        self.assertEqual(ap.flat_label(10.0, -90.0), "ESPERAR")         # positive but under what is worth the risk
        self.assertEqual(ap.flat_label(-5.0, -9.0), "ESPERAR")

    def test_position_label_closes_when_closing_now_keeps_at_least_the_final_result(self):
        self.assertEqual(ap.position_label(120.0, 40.0), "CERRAR")
        self.assertEqual(ap.position_label(-30.0, 40.0), "MANTENER")
        self.assertEqual(ap.position_label(40.0, 40.0), "CERRAR")

    def test_formula_flat_needs_a_strong_maestro_and_the_portero(self):
        self.assertEqual(ap.formula_flat(2, True), "LARGO")
        self.assertEqual(ap.formula_flat(-2, True), "CORTO")
        self.assertEqual(ap.formula_flat(2, False), "ESPERAR")
        self.assertEqual(ap.formula_flat(1, True), "ESPERAR")

    def test_the_formula_action_of_the_trader_is_the_same_rule_with_and_without_a_position(self):
        r = {"veredicto": 2, "portero_si": True}
        self.assertEqual(corta.formula_action(r, None)[0], "LARGO")
        self.assertEqual(corta.formula_action(dict(r, veredicto=-2), None)[0], "CORTO")
        self.assertEqual(corta.formula_action(dict(r, portero_si=False), None)[0], "ESPERAR")
        self.assertEqual(corta.formula_action(dict(r, veredicto=-1), 1)[0], "CERRAR")      # a weak turn against a long closes
        self.assertEqual(corta.formula_action(dict(r, veredicto=0), 1)[0], "MANTENER")
        self.assertEqual(corta.formula_action(r, -1)[0], "CERRAR")                         # strong up against a short
        for v in (-2, -1, 0, 1, 2):
            for ok in (False, True):
                self.assertEqual(corta.formula_action({"veredicto": v, "portero_si": ok}, None)[0] in ("LARGO", "CORTO"),
                                 ap.formula_flat(v, ok) in ("LARGO", "CORTO"))


class ScoreTests(unittest.TestCase):
    def setUp(self):
        self.flat = [flat_row("LARGO", largo=100.0, corto=-100.0, formula="LARGO"),
                     flat_row("CORTO", largo=-50.0, corto=60.0),
                     flat_row("ESPERAR", month="2025-12", largo=-5.0, corto=-8.0, formula="CORTO")]
        self.position = [pos_row("A", 1, 90.0, 20.0, "CERRAR"), pos_row("A", 2, 10.0, 20.0, "MANTENER"),
                         pos_row("B", 1, -40.0, 30.0, "MANTENER")]

    def test_following_the_oracle_beats_the_formula_and_waiting_always_never_trades(self):
        oracle = ap.score_opinions(self.flat, self.position, lambda r: r["label"])
        self.assertEqual(oracle["acierto_sin_posicion"], 1.0)
        self.assertEqual(oracle["entradas"]["n"], 2)
        self.assertAlmostEqual(oracle["entradas"]["neto_bp"], 80.0)
        self.assertEqual(oracle["cierres"]["n"], 2)
        self.assertAlmostEqual(oracle["cierres"]["total_bp"], 90.0 + 30.0)         # trade A closed at 90, B kept to its end (30)
        self.assertAlmostEqual(oracle["formula_cierres"]["total_bp"], 20.0 + 30.0)
        wait = ap.score_opinions(self.flat, self.position, lambda r: "ESPERAR" if r["kind"] == "flat" else "MANTENER")
        self.assertEqual(wait["entradas"]["n"], 0)
        self.assertIsNone(wait["entradas"]["neto_bp"])
        self.assertEqual(wait["formula_entradas"]["n"], 2)                        # the formula entered twice (LARGO and CORTO)
        self.assertAlmostEqual(wait["formula_entradas"]["total_bp"], 100.0 - 8.0)

    def test_by_month_and_winners(self):
        said = ap.score_opinions(self.flat, self.position, lambda r: "LARGO" if r["kind"] == "flat" else "MANTENER")
        self.assertEqual(said["entradas"]["n"], 3)
        self.assertEqual(said["por_mes"]["2025-11"]["n"], 2)
        self.assertAlmostEqual(said["entradas"]["ganadoras"], 1 / 3, places=3)

    def test_the_references_run_on_any_rows(self):
        refs = ap.baselines(self.flat, self.position)
        self.assertEqual(set(refs), {"formula", "oraculo", "azar", "esperar_siempre"})


class DatasetTests(unittest.TestCase):
    def test_a_flat_row_gives_the_real_question_in_both_orders_with_the_right_letter(self):
        row = dict(flat_row("LARGO"), state_text="ESTADO REAL", mirror_text="ESTADO ESPEJO")
        real = ap.chat_examples(CFG, row)
        self.assertEqual(len(real), len(CFG["prompt"]["orders"]["3"]))
        for example in real:
            user = example["messages"][1]["content"]
            self.assertIn("STATE: ESTADO REAL", user)
            letter = example["messages"][2]["content"]
            self.assertRegex(user, r"(?m)^{}\) LARGO\b".format(letter))
            self.assertTrue(user.startswith("QUESTION: ") or user.startswith("STATE: "))
        self.assertNotEqual(real[0]["messages"][2]["content"], real[1]["messages"][2]["content"])    # the letter follows the option
        mirror = ap.chat_examples(CFG, row, mirror=True)
        for example in mirror:
            self.assertIn("STATE: ESTADO ESPEJO", example["messages"][1]["content"])
            self.assertRegex(example["messages"][1]["content"], r"(?m)^{}\) CORTO\b".format(example["messages"][2]["content"]))

    def test_balance_split_and_files(self):
        months = ("2025-01", "2025-02", "2025-03", "2025-04")
        flat = [flat_row(label, month=m, t_ms=(k + 1) * 30 * 24 * 3600_000) for k, m in enumerate(months)
                for label in ["LARGO"] * 6 + ["CORTO"] * 3 + ["ESPERAR"] * 2]
        position = [pos_row("T{}".format(i), (i % 4 + 1) * 30 * 24 * 3600_000, 1.0, 2.0, "MANTENER" if i % 3 else "CERRAR") for i in range(30)]
        for i, row in enumerate(position):
            row["product"] = "PF_ETHUSD"
            row["month"] = months[i % 4]
        with tempfile.TemporaryDirectory() as tmp:
            meta = ap.build_dataset(CFG, flat, position, tmp, per_class=3, log=lambda *_: None)
            train = [json.loads(x) for x in open(os.path.join(tmp, "train.jsonl"), encoding="utf-8")]
            self.assertTrue(os.path.exists(os.path.join(tmp, "valid.jsonl")))
        self.assertEqual(meta["train"]["sin_posicion"], {"LARGO": 3, "CORTO": 3, "ESPERAR": 3})      # balanced, first months
        self.assertEqual(meta["valid"]["sin_posicion"]["LARGO"], 1)                                   # the last two months
        self.assertTrue(all(len(e["messages"]) == 3 for e in train))
        self.assertEqual(len(train), 9 * 2 * 2 + 6 * 2)                          # flat: x mirror x orders; position: x orders

    def test_the_embargo_drops_training_rows_whose_label_reaches_into_validation(self):
        hour = 3600_000
        rows = [dict(flat_row("LARGO", month="2025-01", t_ms=100 * hour - k * hour)) for k in (1, 30, 47, 49, 60)]
        rows += [dict(flat_row("LARGO", month="2025-02", t_ms=100 * hour + k)) for k in range(3)]
        train, valid = ap.split_valid(rows, 1)
        self.assertEqual(len(valid), 3)
        self.assertEqual(sorted((100 * hour - r["t_ms"]) // hour for r in train), [49, 60])      # 1, 30 and 47 h before: dropped


class ReportTests(unittest.TestCase):
    def result(self, neto, n, flips=0.95, reparto=None):
        stats = {"n": n, "neto_bp": neto, "ganadoras": 0.6, "total_bp": 0.0}
        return {"entradas": stats, "formula_entradas": {"n": 11, "neto_bp": 50.0, "ganadoras": 0.7, "total_bp": 1.0},
                "cierres": stats, "formula_cierres": stats, "acierto_sin_posicion": 0.4, "acierto_con_posicion": 0.7,
                "por_mes": {"2025-11": dict(stats, neto_bp=10.0), "2025-12": dict(stats, neto_bp=-5.0)},
                "reparto": reparto or {"LARGO": 10, "CORTO": 10, "ESPERAR": 10}, "espejo_da_vuelta": flips}

    def test_it_passes_only_when_it_beats_the_formula_and_the_untrained_model_without_a_habit(self):
        base, best = self.result(5.0, 40), self.result(80.0, 40)
        checks, ok = ap.verdict(base, best)
        self.assertTrue(ok, checks)
        self.assertFalse(ap.verdict(base, self.result(80.0, 5))[1])                         # too few entries
        self.assertFalse(ap.verdict(base, self.result(20.0, 40))[1])                        # under the formula alone
        self.assertFalse(ap.verdict(base, self.result(80.0, 40, flips=0.3))[1])             # the mirror does not turn: a habit
        self.assertFalse(ap.verdict(base, self.result(80.0, 40, reparto={"ESPERAR": 29, "LARGO": 1}))[1])
        self.assertFalse(ap.verdict(self.result(90.0, 40), best)[1])                        # the untrained one was better

    def test_the_markdown_has_the_verdict_the_tables_and_the_history(self):
        history = [{"paso": 500, "acierto": 0.4, "acierto_balanceado": 0.39, "costumbre_parte": 0.5}]
        text = ap.report_md(self.result(5.0, 40), dict(self.result(80.0, 40), paso=1000), history)
        for piece in ("**Veredicto: PASA**", "Qwen entrenado (paso 1000)", "| 500 | 40 % | 39 % | 50 % |", "2025-11: 40 entradas, +10.0 pb"):
            self.assertIn(piece, text)


class ExitTests(unittest.TestCase):
    def test_without_a_time_limit_the_trade_lasts_until_the_maestro_turns_and_never_turning_is_not_measurable(self):
        from balancita_engine import futures_qwen_trader_exam as ex
        self.assertEqual(CFG["guardrails"]["max_hold_min"], 2160)           # the live safety net: 36 h
        cfg = dict(CFG, guardrails=dict(CFG["guardrails"], max_hold_min=None))
        t0 = 1000 * 15 * MIN
        scores = [0.5] * 600 + [-0.5] * 5                                   # up for 150 hours, then it turns (a long leaves)
        readings = {t0 + k * 15 * MIN: {"puntaje": s} for k, s in enumerate(scores)}
        closes = {t0 + k * 15 * MIN: 100.0 + (k == 600) * 3.0 for k in range(len(scores))}
        out = ex._v8_exit(cfg, t0, 1, readings, closes, 10.0, 0.11)
        self.assertEqual((out["motivo"], out["horas"]), ("vuelta", 150.0))
        self.assertAlmostEqual(out["neto_bp"], 300.0 - 10.0, places=6)
        self.assertIsNone(ex._v8_exit(cfg, t0 + 601 * 15 * MIN, -1, readings, closes, 10.0, 0.11))    # the maestro never turned afterwards
        with_limit = dict(cfg, guardrails=dict(cfg["guardrails"], max_hold_min=2160))
        out = ex._v8_exit(with_limit, t0, 1, readings, closes, 10.0, 0.11)                             # the 36 h safety net
        self.assertEqual((out["motivo"], out["horas"]), ("tiempo", 36.0))


class PositionBalanceTests(unittest.TestCase):
    def test_half_of_the_close_class_comes_from_trades_that_hit_48_hours(self):
        rows = []
        for i in range(40):
            rows.append(dict(pos_row("L{}".format(i), i, 0, 0, "CERRAR"), por_tiempo=True))
        for i in range(200):
            rows.append(dict(pos_row("F{}".format(i), i, 0, 0, "CERRAR"), por_tiempo=False))
        for i in range(300):
            rows.append(dict(pos_row("K{}".format(i), i, 0, 0, "MANTENER"), por_tiempo=False))
        got = ap.balance_position(rows, 100, 1)
        closes = [r for r in got if r["label"] == "CERRAR"]
        self.assertEqual((len(closes), sum(1 for r in closes if r["por_tiempo"]), len(got) - len(closes)), (100, 40, 100))
        few = ap.balance_position(rows[:10] + rows[40:], 100, 1)                    # 10 late rows only: all go in, the rest completes
        self.assertEqual(sum(1 for r in few if r["label"] == "CERRAR"), 100)


class ContextLineTests(unittest.TestCase):
    def test_the_sheet_says_the_product_and_the_utc_hour_as_plain_facts(self):
        class T:
            product = "PF_ETHUSD"
        hour = 3600_000
        self.assertEqual(corta._context_line(T, 3 * hour + 15 * 60_000), "Contexto: ETH, 03:15 UTC (madrugada).")
        self.assertIn("sesión de EE. UU.", corta._context_line(T, 15 * hour))
        T.product = "PF_XBTUSD"
        self.assertEqual(corta._context_line(T, 23 * hour + 5 * 60_000), "Contexto: BTC, 23:05 UTC (noche).")


class LiveLabelTests(unittest.TestCase):
    def make_db(self):
        tmp = tempfile.mkdtemp()
        store = live.LiveStore(os.path.join(tmp, "live.sqlite"))
        self.addCleanup(store.close)
        return store

    def insert(self, store, bucket, t_ms, kind, score, net_now=None, trade_no=None, product="PF_XBTUSD"):
        formula = json.dumps({"maestro": 2, "puntaje": score, "portero_si": True, "portero_p": 0.8, "volatilidad": "NORMAL", "motivo": "x"})
        position = None if trade_no is None else json.dumps({"trade_no": trade_no})
        with store.db:
            store.db.execute(
                "INSERT INTO decisions(product, bucket_ms, t_ms, decided_at_ms, kind, action, state_text, formula_json, net_bp_now, position_json, trade_no) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)", (product, bucket, t_ms, t_ms, kind, "ESPERAR", "STATE", formula, net_now, position, trade_no))

    def test_a_flat_look_gets_its_label_when_both_exits_happened_from_the_candles_and_the_maestro_turn(self):
        store = self.make_db()
        cfg = dict(CFG, products=["PF_XBTUSD"])
        t0 = 1_000_000 * 15 * MIN
        step = 15 * MIN
        weak = corta.formulas(cfg)[0]["umbrales"]["flojo"]
        # the maestro stays up for 6 looks: the short leaves at the first one, the long has not left yet -> nothing to label
        for k in range(0, 7):
            self.insert(store, t0 + k * step - step, t0 + k * step, "flat", 0.5)
        closes = {t0: 100.0, t0 + step: 100.0, t0 + 7 * step: 101.0}
        cost = float(ap.round_trip_cost_bps("PF_XBTUSD"))
        self.assertEqual(ap.resolve_live(store.db, lambda p, a, b: closes, cfg, t0 + 10 * 60 * MIN), 0)
        # it turns clearly down: the long leaves there (+100 bp less costs) and now the look can be labelled
        self.insert(store, t0 + 7 * step - step, t0 + 7 * step, "flat", -(weak + 0.1))
        self.assertGreaterEqual(ap.resolve_live(store.db, lambda p, a, b: closes, cfg, t0 + 10 * 60 * MIN), 1)
        row = store.db.execute("SELECT * FROM examples WHERE t_ms=?", (t0,)).fetchone()
        detail = json.loads(row["label_json"])
        self.assertAlmostEqual(detail["largo_bp"], 100.0 - cost, places=6)
        self.assertEqual(row["label"], "LARGO")
        self.assertAlmostEqual(detail["corto_bp"], 0.0 - cost, places=6)             # out at the first look at the same price
        count = ap.export_live(store.db, cfg, os.path.join(tempfile.mkdtemp(), "x.jsonl"))
        self.assertGreaterEqual(count, 1)

    def test_a_look_with_a_position_waits_for_the_trade_to_close(self):
        store = self.make_db()
        cfg = dict(CFG, products=["PF_XBTUSD"])
        t0 = 2_000_000 * 15 * MIN
        self.insert(store, t0 - 900_000, t0, "position", 0.5, net_now=120.0, trade_no=1)
        with store.db:
            store.put_trade("PF_XBTUSD", 1, status="open", side="LONG", entry_ms=t0 - 3600_000)
        self.assertEqual(ap.resolve_live(store.db, lambda *a: {}, cfg, t0 + 1), 0)
        with store.db:
            store.put_trade("PF_XBTUSD", 1, status="closed", side="LONG", entry_ms=t0 - 3600_000, net_bp=50.0)
        self.assertEqual(ap.resolve_live(store.db, lambda *a: {}, cfg, t0 + 2), 1)
        row = store.db.execute("SELECT label FROM examples").fetchone()
        self.assertEqual(row["label"], "CERRAR")                                    # closing at +120 kept more than the final +50


class FormulaDecidesTests(unittest.TestCase):
    """Version 9: the formulas open and close; Qwen only gives an opinion that is saved next to the decision."""

    def test_qwen_wanting_to_enter_changes_nothing_when_the_formula_waits(self):
        env = make(self, policy=Policy(flat="LARGO"), formula=True)
        with mock.patch.object(corta, "formula_action", return_value=("ESPERAR", "el maestro no está fuerte")):
            env.op.start()
            env.advance(60)
        rows = env.rows("SELECT * FROM decisions WHERE kind='flat'")
        self.assertTrue(rows)
        self.assertTrue(all(r["action"] == "ESPERAR" and r["formula_action"] == "ESPERAR" and r["model_action"] == "LARGO"
                            and r["opinion_agrees"] == 0 and r["override"] is None for r in rows))
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertEqual(json.loads(rows[0]["formula_json"])["motivo"], "el maestro no está fuerte")

    def test_the_formula_opens_and_closes_whatever_qwen_says(self):
        env = make(self, policy=Policy(flat="ESPERAR", position="MANTENER"), formula=True)
        answers = iter([("LARGO", "maestro fuerte y portero a favor")] + [("MANTENER", "x")] * 3 + [("CERRAR", "el maestro se dio vuelta en contra")] + [("ESPERAR", "x")] * 500)
        with mock.patch.object(corta, "formula_action", side_effect=lambda r, side, *rest: next(answers)):
            env.op.start()
            env.advance(120)
        trades = env.rows("SELECT * FROM trades")
        self.assertEqual(len(trades), 1)
        self.assertEqual((trades[0]["side"], trades[0]["status"], trades[0]["closed_by"], trades[0]["entry_reason"]),
                         ("LONG", "closed", "formula", "formula"))
        entry = env.rows("SELECT * FROM decisions WHERE action='LARGO'")[0]
        self.assertEqual((entry["model_action"], entry["opinion_agrees"]), ("ESPERAR", 0))   # Qwen disagreed and the formula entered anyway
        close = env.rows("SELECT * FROM decisions WHERE action='CERRAR'")[0]
        self.assertEqual((close["model_action"], close["formula_action"]), ("MANTENER", "CERRAR"))

    def test_a_model_that_is_down_leaves_the_opinion_empty_and_the_formula_still_decides(self):
        env = make(self, formula=True, provider=llm.FakeProvider(entries=Policy(), healthy=False))
        with mock.patch.object(corta, "formula_action", return_value=("ESPERAR", "x")):
            env.op.start()
            env.advance(30)
        rows = env.rows("SELECT * FROM decisions")
        self.assertTrue(rows)
        self.assertTrue(all(r["model_action"] is None and r["opinion_error"] == "modelo_caido" and r["formula_action"] == "ESPERAR" for r in rows))
        self.assertEqual(env.rows("SELECT * FROM skipped"), [])


if __name__ == "__main__":
    unittest.main()
