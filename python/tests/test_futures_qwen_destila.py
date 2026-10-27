"""Destilación de la fórmula en Qwen: la etiqueta se lee de la ficha, el espejo, el cupo por trimestre, la medición y las reglas de la noche."""
import random
import unittest

from balancita_engine import futures_qwen_destila as dst


def sheet(word, answer, extra=""):
    return ("1. Maestro de dirección (fórmula fija sobre las velas): {} (puntaje +0,50; flojo desde 0,10, fuerte desde 0,19).\n"
            "2. Portero (fórmula fija): {} (probabilidad de ganar tras costos 0,70; conviene desde 0,68).\n{}").format(word, answer, extra)


class ReadableLabelTests(unittest.TestCase):
    def test_flat_label_comes_from_the_sheet(self):
        self.assertEqual(dst.formula_from_text(sheet("SUBE FUERTE", "CONVIENE ENTRAR")), "LARGO")
        self.assertEqual(dst.formula_from_text(sheet("BAJA FUERTE", "CONVIENE ENTRAR")), "CORTO")
        self.assertEqual(dst.formula_from_text(sheet("SUBE FUERTE", "NO CONVIENE ENTRAR")), "ESPERAR")
        self.assertEqual(dst.formula_from_text(sheet("SUBE FLOJO", "CONVIENE ENTRAR")), "ESPERAR")
        self.assertEqual(dst.formula_from_text(sheet("NADA CLARO", "NO CONVIENE ENTRAR")), "ESPERAR")

    def test_position_label_comes_from_the_maestro_against_the_position(self):
        self.assertEqual(dst.formula_from_text("4. Posición: LARGO abierta. El maestro ahora va EN CONTRA de la posición (flojo).", True), "CERRAR")
        self.assertEqual(dst.formula_from_text("4. Posición: LARGO abierta. El maestro ahora va a favor de la posición.", True), "MANTENER")

    def test_check_readable_flags_a_sheet_that_says_something_else(self):
        good = {"kind": "flat", "t_ms": 1, "formula": "LARGO", "state_text": sheet("SUBE FUERTE", "CONVIENE ENTRAR"),
                "mirror_text": sheet("BAJA FUERTE", "CONVIENE ENTRAR")}
        self.assertEqual(dst.check_readable([good]), [])
        bad = dict(good, mirror_text=sheet("SUBE FUERTE", "CONVIENE ENTRAR"))
        self.assertEqual(dst.check_readable([bad])[0][0], "espejo")


class PickTests(unittest.TestCase):
    def rows(self):
        return [{"month": "2023-0{}".format(m), "held_min": 60 * h} for m in (1, 4, 7) for h in range(40)]

    def test_no_quarter_gives_more_than_its_cap(self):
        got = dst.pick(self.rows(), 30, random.Random(1), cap=0.4)
        self.assertEqual(len(got), 30)
        self.assertTrue(all(c <= 12 for c in __import__("collections").Counter(r["month"] for r in got).values()))

    def test_fewer_rows_than_asked_returns_what_there_is(self):
        self.assertEqual(len(dst.pick(self.rows()[:5], 30, random.Random(1))), 5)

    def test_half_long_positions(self):
        got = dst.pick(self.rows(), 20, random.Random(2), cap=1.0, half_long=True)
        self.assertEqual(sum(1 for r in got if r["held_min"] > 720), 10)


def rec(kind, grupo, espejo, orden, gold, answer, largo=50.0, corto=-30.0):
    return {"info": {"kind": kind, "grupo": grupo, "espejo": espejo, "orden": orden, "largo_bp": largo, "corto_bp": corto}, "gold": gold, "answer": answer}


class ReportTests(unittest.TestCase):
    def test_a_mirror_that_flips_and_an_agreeing_opinion(self):
        records = [rec("flat", "a", False, 0, "LARGO", "LARGO"), rec("flat", "a", True, 0, "CORTO", "CORTO"),
                   rec("flat", "b", False, 0, "ESPERAR", "ESPERAR"), rec("flat", "b", True, 0, "ESPERAR", "ESPERAR")]
        r = dst.valid_report(records)
        self.assertEqual(r["acuerdo"], 1.0)
        self.assertEqual(r["espejo_da_vuelta"], 1.0)
        self.assertEqual(r["entradas"], 1)
        self.assertEqual(r["neto_por_entrada_bp"], 50.0)
        self.assertTrue(dst.verdict(dict(r, costumbre_parte=0.5))[1])

    def test_a_habit_does_not_flip(self):
        records = [rec("flat", "a", False, 0, "LARGO", "LARGO"), rec("flat", "a", True, 0, "CORTO", "LARGO")]
        r = dst.valid_report(records)
        self.assertEqual(r["espejo_da_vuelta"], 0.0)
        self.assertFalse(dst.verdict(r)[1])

    def test_sample_groups_keeps_whole_groups(self):
        infos = [{"kind": "flat", "grupo": str(g), "espejo": m, "orden": o} for g in range(30) for m in (False, True) for o in (0, 1)]
        infos += [{"kind": "position", "grupo": "p{}".format(g), "espejo": False, "orden": o} for g in range(10) for o in (0, 1)]
        picked = dst.sample_groups(infos, 40)
        self.assertLessEqual(len(picked), 40)
        flat = [infos[i]["grupo"] for i in picked if infos[i]["kind"] == "flat"]
        self.assertTrue(all(flat.count(g) == 4 for g in set(flat)))


def h(paso, acuerdo, espejo, costumbre=0.4):
    return {"paso": paso, "acuerdo": acuerdo, "espejo_da_vuelta": espejo, "costumbre_parte": costumbre}


class NightRulesTests(unittest.TestCase):
    def test_pilot_fails_when_the_mirror_does_not_move(self):
        self.assertEqual(dst.decide([h(250, 0.5, 0.3)])[0], "piloto_falla")
        self.assertEqual(dst.decide([h(250, 0.5, None)])[0], "piloto_falla")
        self.assertEqual(dst.decide([h(250, 0.6, 0.6)])[0], "sigue")

    def test_done_and_stalled(self):
        self.assertEqual(dst.decide([h(250, 0.6, 0.6), h(500, 0.92, 0.95)])[0], "listo")
        self.assertEqual(dst.decide([h(250, 0.6, 0.6), h(500, 0.9, 0.7), h(750, 0.9, 0.7), h(1000, 0.89, 0.7)])[0], "sin_mejora")
        self.assertEqual(dst.decide([h(250, 0.6, 0.6), h(500, 0.7, 0.7), h(750, 0.8, 0.7)])[0], "sigue")

    def test_best_step_skips_habits_and_prefers_a_mirror(self):
        history = [h(250, 0.7, 0.6), h(500, 0.8, 0.95), h(750, 0.9, 0.95, costumbre=0.8), h(1000, 0.85, 0.5)]
        self.assertEqual(dst.best_step(history), 500)
        self.assertEqual(dst.best_step([h(250, 0.7, 0.6), h(500, 0.8, 0.5)]), 500)

    def test_report_says_pass_or_not(self):
        history = [h(250, 0.9, 0.95)]
        history[0].update(neto_por_entrada_bp=10.0, formula_neto_por_entrada_bp=12.0)
        self.assertIn("PASA", dst.night_report(None, history, 250, None))
        history[0]["acuerdo"] = 0.5
        self.assertIn("NO pasa", dst.night_report(None, history, 250, None))


if __name__ == "__main__":
    unittest.main()
