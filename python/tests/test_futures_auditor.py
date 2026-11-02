"""Auditor de decisiones: la foto de cada mirada, la clasificación de la acción, los veredictos a 12/24/36 h con precios conocidos,
el resumen, la reconstrucción desde la base viva y el enganche en vivo (que nunca cambia una decisión). Sin red, sin modelo."""
import contextlib
import copy
import hashlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from balancita_engine import futures_auditor as aud
from balancita_engine import futures_qwen_corta as corta
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt

from test_futures_qwen_live import Policy, make

MIN = qt.MINUTE_MS
HOUR = qt.HOUR_MS
BAR = qt.BAR_MS
PRODUCT = "PF_ETHUSD"
CFG = qt.load_config(qt.CONFIG_PATH_LIVE)
CFG["products"] = [PRODUCT]
T0 = qt.date_ms("2026-10-20") + 10 * HOUR            # 12:00 en Madrid (horario de verano), martes
WEAK = corta.formulas(CFG)[0]["umbrales"]["flojo"]
STRONG = corta.formulas(CFG)[0]["umbrales"]["fuerte"]
COST = 10.0
NO_VERDICT = object()


class FakeTrader:
    """Lo mínimo de un trader: la foto de mercado falla y queda en ``null`` sin romper nada."""

    cfg = CFG
    t, c, h, l, v = [], [], [], [], []
    positioning = None
    movement = None
    position = None
    last_mark_execution = None


def formula(maestro=2, puntaje=None, portero_si=True, portero_p=0.8, motivo="x", **extra):
    puntaje = (STRONG + 0.1) * (1 if maestro >= 0 else -1) if puntaje is None else puntaje
    return dict({"maestro": maestro, "puntaje": puntaje, "portero_si": portero_si, "portero_p": portero_p,
                 "noticias_si": False, "noticias": {"disponible": False, "n": 0, "sentimiento": 0.0, "max_relevancia": 0.0,
                                                    "a_favor": False},
                 "portero_autonomo": None, "volatilidad": "NORMAL", "motivo": motivo, "opinion_enabled": True}, **extra)


def event(t_ms=T0, kind="flat", action="ESPERAR", fml=None, position=None, net=None, trade_no=None, **extra):
    return dict({"type": "decision", "kind": kind, "t_ms": t_ms, "wake": ["cada_15_min"], "action": action,
                 "formula": fml if fml is not None else formula(), "position": position, "net_bp_now": net,
                 "trade_no": trade_no, "model_action": "ESPERAR", "opinion_agrees": 1}, **extra)


def position_of(side="LONG", entry_ms=T0 - 2 * HOUR, trade_no=1):
    return {"side": side, "entry_ms": entry_ms, "entry_px": "100", "qty": "1", "stop_px": None, "trade_no": trade_no}


def step_prices(points, start=T0 - HOUR, end=T0 + 40 * HOUR):
    """Cierres de 5 min: ``points`` = [(desplazamiento desde T0, precio)], el precio vale hasta el siguiente punto."""
    points = sorted(points)
    out = {}
    for at in range(start, end + 1, BAR):
        price = points[0][1]
        for offset, value in points:
            if at >= T0 + offset:
                price = value
        out[at] = price
    return out


class AuditorCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "live.sqlite")
        self.store = live.LiveStore(self.path)
        self.addCleanup(self.store.close)

    def sql(self, statement, *args):
        """Una escritura directa en ``auditor.sqlite`` (para preparar un caso)."""
        with contextlib.closing(sqlite3.connect(aud.auditor_path(self.path))) as con:
            with con:
                con.execute(statement, args)

    def audit_rows(self, where="1=1"):
        con = sqlite3.connect(os.path.join(self.tmp, "auditor.sqlite"))
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute("SELECT * FROM miradas WHERE {} ORDER BY t_ms".format(where))]
        finally:
            con.close()

    def snap(self, ev, trader=FakeTrader):
        return aud.snapshot(self.path, PRODUCT, trader, ev, ev["t_ms"] + MIN)

    def put_look(self, t_ms, fml, kind="flat", action="ESPERAR", position=None, net=None, trade_no=None):
        """Una mirada en ``decisions`` de la base viva (de ahí salen los puntajes que dan vuelta al maestro)."""
        with self.store.db:
            self.store.db.execute(
                "INSERT OR REPLACE INTO decisions(product, bucket_ms, t_ms, decided_at_ms, kind, action, state_text, formula_json, "
                "net_bp_now, position_json, trade_no, wake_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (PRODUCT, t_ms - aud.BUCKET_MS, t_ms, t_ms, kind, action, "S", json.dumps(fml), net,
                 None if position is None else json.dumps(position), trade_no, json.dumps(["cada_15_min"])))

    def put_scores(self, score, until_h, flip_at_h=None, flip_score=None):
        """Miradas cada 15 min desde T0 con el puntaje ``score``; desde ``flip_at_h`` horas, ``flip_score``."""
        for k in range(1, int(until_h * 4) + 1):
            t_ms = T0 + k * 15 * MIN
            flipped = flip_at_h is not None and t_ms >= T0 + flip_at_h * HOUR
            self.put_look(t_ms, formula(2 if score > 0 else -2, flip_score if flipped else score))

    def put_trade(self, number, **fields):
        with self.store.db:
            self.store.put_trade(PRODUCT, number, **fields)

    def resolve(self, closes, now_ms):
        return aud.resolve(self.path, PRODUCT, closes, CFG, now_ms, COST)


class SchemaTests(AuditorCase):
    def test_the_database_lives_beside_the_live_one_with_the_agreed_columns(self):
        self.snap(event())
        self.assertEqual(aud.auditor_path(self.path), os.path.join(self.tmp, "auditor.sqlite"))
        con = sqlite3.connect(aud.auditor_path(self.path))
        self.addCleanup(con.close)
        columns = {r[1]: (r[2], r[3], r[5]) for r in con.execute("PRAGMA table_info(miradas)")}
        self.assertEqual(list(columns)[:5], ["product", "bucket_ms", "t_ms", "estado", "accion"])
        for name in ("maestro", "puntaje", "umbral_flojo", "umbral_fuerte", "portero_si", "portero_p", "portero_umbral",
                     "noticias_si", "noticias_lado", "qwen", "qwen_coincide", "horas_en_posicion", "neto_ahora_pb",
                     "trade_no", "despues_json", "veredicto_12h_json", "veredicto_24h_json", "veredicto_36h_json",
                     "resuelto_ms"):
            self.assertIn(name, columns)
        self.assertEqual(columns["lado_posicion"][0], "INTEGER")
        self.assertEqual(columns["condiciones_json"][1], 1)                     # NOT NULL
        self.assertEqual(columns["version"][1], 1)
        self.assertEqual(columns["product"][2], 1)                              # primary key (product, bucket_ms)
        self.assertEqual(columns["bucket_ms"][2], 2)
        self.assertEqual(con.execute("SELECT value FROM meta WHERE key='schema'").fetchone()[0], "balancita-auditor.v1")

    def test_the_bucket_is_the_one_the_live_decisions_use(self):
        self.assertEqual(aud.BUCKET_MS, live.BUCKET_MS)


class SnapshotTests(AuditorCase):
    def test_one_row_per_look_and_the_same_look_twice_is_ignored(self):
        first = event(T0)
        self.assertTrue(self.snap(first))
        self.assertFalse(self.snap(first))
        self.assertTrue(self.snap(event(T0 + 15 * MIN)))
        rows = self.audit_rows()
        self.assertEqual([r["t_ms"] for r in rows], [T0, T0 + 15 * MIN])
        self.assertEqual(rows[0]["bucket_ms"], T0 - 15 * MIN)
        self.assertEqual(rows[0]["version"], aud.VERSION)
        self.assertIsNone(rows[0]["despues_json"])
        self.assertTrue(all(rows[0][f"veredicto_{h}_json"] is None for h in ("12h", "24h", "36h")))
        self.assertIsNone(rows[0]["resuelto_ms"])

    def test_events_without_a_formula_or_of_other_types_leave_nothing(self):
        self.assertFalse(self.snap(dict(event(), formula=None)))
        self.assertFalse(aud.snapshot(self.path, PRODUCT, FakeTrader, {"type": "trade", "trade": {}}, T0))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "auditor.sqlite")) and self.audit_rows())

    def test_it_records_the_formulas_the_opinion_and_the_conditions_of_the_moment(self):
        ev = event(fml=formula(2, 0.9, portero_si=False, portero_p=0.31, motivo="el portero dice que no conviene"),
                   model_action="LARGO", opinion_agrees=0)
        self.snap(ev)
        row, = self.audit_rows()
        self.assertEqual((row["estado"], row["accion"], row["maestro"], row["puntaje"]), ("plana", "NO_ENTRAR_portero", 2, 0.9))
        self.assertEqual((row["portero_si"], row["portero_p"], row["noticias_si"]), (0, 0.31, 0))
        self.assertEqual((row["qwen"], row["qwen_coincide"], row["lado_posicion"]), ("LARGO", 0, 0))
        self.assertAlmostEqual(row["umbral_flojo"], WEAK)
        self.assertAlmostEqual(row["umbral_fuerte"], STRONG)
        gate = corta.formulas(CFG)[1]
        self.assertEqual(row["portero_umbral"], None if gate is None else gate["umbral"])
        conditions = json.loads(row["condiciones_json"])
        self.assertEqual(conditions["motivo"], "el portero dice que no conviene")
        self.assertEqual((conditions["hora_madrid"], conditions["dia"], conditions["fin_de_semana"]), (12, 1, False))
        self.assertEqual(conditions["despertar"], ["cada_15_min"])
        self.assertEqual(conditions["origen"], "vivo")
        self.assertIsNone(conditions["libro"])
        self.assertIsNone(conditions["mercado"])                      # el trader de juguete no tiene ficha: queda en null

    def test_madrid_hour_weekend_and_nan_numbers(self):
        saturday = qt.date_ms("2026-10-24") + 23 * HOUR + 30 * MIN       # 01:30 del domingo en Madrid (verano)
        self.snap(event(saturday, fml=formula(1, float("nan"), portero_p=float("inf"))))
        row, = self.audit_rows()
        self.assertIsNone(row["puntaje"])
        self.assertIsNone(row["portero_p"])
        conditions = json.loads(row["condiciones_json"])
        self.assertEqual((conditions["hora_madrid"], conditions["dia"], conditions["fin_de_semana"]), (1, 6, True))

    def test_a_position_look_keeps_hours_side_and_net(self):
        ev = event(kind="position", action="MANTENER", position=position_of("SHORT", T0 - 5 * HOUR), net=-12.5, trade_no=4,
                   fml=formula(-2, motivo="el maestro no se dio vuelta"))
        self.snap(ev)
        row, = self.audit_rows()
        self.assertEqual((row["estado"], row["accion"], row["lado_posicion"], row["trade_no"]), ("en_posicion", "MANTENER", -1, 4))
        self.assertAlmostEqual(row["horas_en_posicion"], 5.0)
        self.assertEqual(row["neto_ahora_pb"], -12.5)

    def test_it_classifies_every_kind_of_look(self):
        pos = position_of()
        cases = [
            ("ENTRAR", dict(action="LARGO", fml=formula(2)), 1),
            ("ENTRAR_noticias", dict(action="LARGO", fml=formula(2, portero_si=False, noticias_si=True)), 1),
            ("ENTRAR_noticias", dict(action="CORTO", fml=dict(formula(None, 0, None, None), authority="noticias",
                                                              noticias_si=True)), -1),
            ("NO_ENTRAR_portero", dict(fml=formula(2, portero_si=False)), 0),
            ("NO_ENTRAR_portero", dict(fml=formula(-2, portero_autonomo={"side": 1, "chosen": "LARGO"})), 0),
            ("NO_ENTRAR_maestro", dict(fml=formula(1)), 0),
            ("NO_ENTRAR_maestro", dict(fml=formula(0, 0.0)), 0),
            ("NO_ENTRAR_regla", dict(fml=dict(formula(None, 0, None, None), authority="noticias", motivo="noticias fuertes contradictorias")), 0),
            ("MANTENER", dict(kind="position", action="MANTENER", position=pos, net=3.0), 1),
            ("SALIR_vuelta", dict(kind="position", action="CERRAR", position=pos,
                                  fml=formula(-1, motivo="el maestro se dio vuelta en contra")), 1),
            ("SALIR_24h", dict(kind="position", action="CERRAR", position=pos,
                               fml=formula(0, motivo="pasaron 24 h y el maestro perdió fuerza a favor")), 1),
            ("SALIR_36h", dict(kind="position", action="CERRAR", position=pos,
                               fml=formula(0, motivo="pasaron 36 h y el maestro perdió fuerza a favor")), 1),
            ("SALIR_12h_noticias", dict(kind="position", action="CERRAR", position=pos,
                                        fml=formula(1, motivo=corta.NEWS_EXIT_WHY + " (primeras 12 h)")), 1),
            ("SALIR_otro", dict(kind="position", action="CERRAR", position=pos, fml=formula(1, motivo="algo raro")), 1),
        ]
        for k, (expected, kwargs, side) in enumerate(cases):
            with self.subTest(expected=expected, k=k):
                ev = event(T0 + k * 15 * MIN, **kwargs)
                self.snap(ev)
                row, = self.audit_rows("t_ms={}".format(ev["t_ms"]))
                self.assertEqual(row["accion"], expected)
                self.assertEqual(row["lado_posicion"], side)
                self.assertIn(row["accion"], aud.ACTIONS)

    def test_an_unknown_exit_reason_is_read_from_the_trade_and_the_time_guardrail_is_a_36_hour_exit(self):
        self.put_trade(1, status="closed", side="LONG", entry_ms=T0 - 36 * HOUR, exit_ms=T0, closed_by="tiempo", net_bp=10.0)
        self.put_trade(2, status="closed", side="LONG", entry_ms=T0 - HOUR, exit_ms=T0 + 15 * MIN, closed_by="formula",
                       exit_reason="maestro_agotado", net_bp=10.0)
        guardrail = {"type": "guardrail", "kind": "guardrail", "t_ms": T0, "guardrail": "tiempo", "action": "CERRAR",
                     "trade_no": 1, "position": position_of("LONG", T0 - 36 * HOUR, 1), "net_bp_now": 10.0}
        self.assertTrue(self.snap(guardrail))
        stop = dict(guardrail, t_ms=T0 + 30 * MIN, guardrail="stop", trade_no=3)
        self.snap(stop)
        unknown = event(T0 + 15 * MIN, kind="position", action="CERRAR", position=position_of(trade_no=2), trade_no=2,
                        fml=formula(1, motivo="¿?"))
        self.snap(unknown)
        by_time = {r["t_ms"]: r for r in self.audit_rows()}
        self.assertEqual(by_time[T0]["accion"], "SALIR_36h")
        self.assertEqual(by_time[T0 + 30 * MIN]["accion"], "SALIR_otro")
        self.assertEqual(by_time[T0 + 15 * MIN]["accion"], "SALIR_24h")
        self.assertAlmostEqual(by_time[T0]["horas_en_posicion"], 36.0)

    def test_taking_the_snapshot_never_writes_to_the_live_database(self):
        self.put_look(T0, formula())
        self.put_trade(1, status="open", side="LONG", entry_ms=T0 - HOUR)
        self.store.db.commit()
        def digest():
            with open(self.path, "rb") as handle:
                return hashlib.sha256(handle.read()).hexdigest()

        before = digest()
        self.snap(event(kind="position", action="CERRAR", position=position_of(), trade_no=1,
                        fml=formula(-1, motivo="el maestro se dio vuelta en contra")))
        self.resolve(step_prices([(0, 100.0)]), T0 + 50 * HOUR)
        self.assertEqual(digest(), before)


class ResolveTests(AuditorCase):
    def look(self, action, fml, **kwargs):
        ev = event(T0, action=action if action in ("LARGO", "CORTO", "ESPERAR") else "ESPERAR", fml=fml, **kwargs)
        self.snap(ev)

    def verdicts(self, row=None):
        row = row or self.audit_rows()[0]
        return {h: json.loads(row["veredicto_{}_json".format(h)]) if row["veredicto_{}_json".format(h)] else None
                for h in ("12h", "24h", "36h")}

    def test_twelve_hours_give_only_the_provisional_verdict_and_36_hours_the_final_one(self):
        self.look("ESPERAR", formula(2, portero_si=False))
        self.put_scores(STRONG + 0.1, 40, flip_at_h=3, flip_score=-(WEAK + 0.1))
        closes = step_prices([(0, 100.0), (3 * HOUR, 102.0)])
        self.resolve(closes, T0 + 20 * MIN)
        row, = self.audit_rows()
        self.assertIsNone(row["veredicto_12h_json"])
        self.assertIsNone(json.loads(row["despues_json"])["mov_30m"])
        self.resolve(closes, T0 + 13 * HOUR)
        row, = self.audit_rows()
        self.assertEqual(row["accion"], "NO_ENTRAR_portero")
        self.assertIsNotNone(row["veredicto_12h_json"])
        self.assertIsNone(row["veredicto_24h_json"])
        self.assertIsNone(row["veredicto_36h_json"])
        self.assertIsNone(row["resuelto_ms"])
        self.resolve(closes, T0 + 25 * HOUR)
        row, = self.audit_rows()
        self.assertIsNotNone(row["veredicto_24h_json"])
        self.assertIsNone(row["veredicto_36h_json"])
        self.assertIsNone(row["resuelto_ms"])
        self.resolve(closes, T0 + 37 * HOUR)
        row, = self.audit_rows()
        self.assertIsNotNone(row["veredicto_36h_json"])
        self.assertEqual(row["resuelto_ms"], T0 + 37 * HOUR)
        done = json.loads(row["despues_json"])
        self.assertAlmostEqual(done["mov_36h"], 200.0)
        stable = dict(row)
        self.assertEqual(self.resolve(closes, T0 + 60 * HOUR)["actualizadas"], 0)             # resuelta: no se toca más
        self.assertEqual(self.audit_rows()[0], stable)

    def test_after_numbers_moves_excursions_and_simulated_operations(self):
        self.look("ESPERAR", formula(2, portero_si=False))
        self.put_scores(STRONG + 0.1, 40, flip_at_h=3, flip_score=-(WEAK + 0.1))
        closes = step_prices([(0, 100.0), (HOUR, 99.0), (2 * HOUR, 101.0), (3 * HOUR, 102.0), (5 * HOUR, 103.0)])
        self.resolve(closes, T0 + 37 * HOUR)
        done = json.loads(self.audit_rows()[0]["despues_json"])
        self.assertEqual(done["lado_ref"], 1)
        self.assertAlmostEqual(done["mov_30m"], 0.0)
        self.assertAlmostEqual(done["mov_1h"], -100.0)
        self.assertAlmostEqual(done["mov_4h"], 200.0)
        self.assertAlmostEqual(done["mov_12h"], 300.0)
        self.assertAlmostEqual(done["mfe_36h"], 300.0)
        self.assertAlmostEqual(done["mae_36h"], -100.0)
        # the long leaves when the maestro turns (3 h): +200 bp less the round trip cost
        self.assertAlmostEqual(done["si_entraba_maestro_pb"], 200.0 - COST)
        # the short leaves at the first look (the maestro is strongly up): out at the same price less the cost
        self.assertAlmostEqual(done["si_entraba_contrario_pb"], -COST)
        self.assertIsNone(done["queda_hasta_salida_pb"])

    def test_entering_is_right_when_the_net_is_positive_and_the_cost_is_the_loss(self):
        self.look("LARGO", formula(2), trade_no=1)
        self.put_trade(1, status="closed", side="LONG", entry_ms=T0, exit_ms=T0 + 2 * HOUR, net_bp=50.0, closed_by="formula")
        self.resolve(step_prices([(0, 100.0)]), T0 + 13 * HOUR)
        won = self.verdicts()["12h"]
        self.assertTrue(won["acerto"])
        self.assertEqual(won["costo_error_pb"], 0.0)
        self.assertIn("+50 pb", won["texto"])
        self.put_trade(1, status="closed", side="LONG", entry_ms=T0, exit_ms=T0 + 2 * HOUR, net_bp=-30.0, closed_by="formula")
        self.sql("UPDATE miradas SET veredicto_12h_json=NULL")
        self.resolve(step_prices([(0, 100.0)]), T0 + 14 * HOUR)
        lost = self.verdicts()["12h"]
        self.assertFalse(lost["acerto"])
        self.assertEqual(lost["costo_error_pb"], 30.0)
        self.assertIn("−30 pb", lost["texto"])

    def test_an_entry_still_open_is_marked_at_the_price_of_the_horizon_less_the_cost(self):
        self.look("CORTO", formula(-2), trade_no=1)
        self.put_trade(1, status="open", side="SHORT", entry_ms=T0)
        self.resolve(step_prices([(0, 100.0), (12 * HOUR, 101.0)]), T0 + 13 * HOUR)
        verdict = self.verdicts()["12h"]
        self.assertFalse(verdict["acerto"])
        self.assertAlmostEqual(verdict["costo_error_pb"], 100.0 + COST)
        # a trade that closed AFTER the horizon is also marked at the horizon, not at its final net
        self.put_trade(1, status="closed", side="SHORT", entry_ms=T0, exit_ms=T0 + 20 * HOUR, net_bp=500.0, closed_by="formula")
        self.resolve(step_prices([(0, 100.0), (12 * HOUR, 101.0)]), T0 + 14 * HOUR)
        self.assertFalse(self.verdicts()["12h"]["acerto"])

    def test_not_entering_is_right_when_the_trade_not_opened_did_not_win(self):
        self.look("ESPERAR", formula(1, portero_si=False))
        self.put_scores(STRONG + 0.1, 40, flip_at_h=3, flip_score=-(WEAK + 0.1))
        self.resolve(step_prices([(0, 100.0), (3 * HOUR, 99.0)]), T0 + 13 * HOUR)
        row, = self.audit_rows()
        self.assertEqual(row["accion"], "NO_ENTRAR_maestro")
        right = self.verdicts(row)["12h"]
        self.assertTrue(right["acerto"])
        self.assertEqual(right["costo_error_pb"], 0.0)
        self.assertIn("si entraba: −110 pb", right["texto"])
        self.assertEqual(right["regla"], "no entrar acierta si la operación que no se abrió no ganaba")

    def test_not_entering_costs_what_the_trade_would_have_won_and_the_rule_off_says_apagado(self):
        self.look("ESPERAR", dict(formula(None, 0.0, None, None), authority="noticias", motivo="sin noticia"), )
        # without a maestro the side is unknown: not judged
        self.resolve(step_prices([(0, 100.0)]), T0 + 13 * HOUR)
        self.assertIsNone(self.verdicts()["12h"]["acerto"])
        self.audit_rows()
        # a news-led wait with a known side (the news said up) is judged with the rule "apagado"
        other = dict(formula(None, 0.0, None, None), authority="noticias", motivo="sin noticia",
                     noticias={"disponible": True, "signal": {"side": 1, "event_id": "e1"}})
        self.snap(event(T0 + 15 * MIN, fml=other))
        self.put_scores(STRONG + 0.1, 40, flip_at_h=3, flip_score=-(WEAK + 0.1))
        self.resolve(step_prices([(0, 100.0), (3 * HOUR, 101.0)]), T0 + 13 * HOUR)
        row = self.audit_rows("t_ms={}".format(T0 + 15 * MIN))[0]
        self.assertEqual((row["accion"], row["noticias_lado"]), ("NO_ENTRAR_regla", 1))
        verdict = self.verdicts(row)["12h"]
        self.assertEqual(verdict["regla"], "apagado")
        self.assertFalse(verdict["acerto"])
        self.assertAlmostEqual(verdict["costo_error_pb"], 100.0 - COST)

    def test_keeping_is_right_when_what_remained_until_the_real_exit_is_not_negative(self):
        pos = position_of("LONG", T0 - HOUR, 1)
        self.snap(event(kind="position", action="MANTENER", position=pos, trade_no=1, net=5.0, fml=formula(2)))
        self.put_trade(1, status="closed", side="LONG", entry_ms=T0 - HOUR, exit_ms=T0 + 5 * HOUR, exit_px="104", net_bp=380.0,
                       closed_by="formula")
        self.resolve(step_prices([(0, 100.0), (5 * HOUR, 104.0), (10 * HOUR, 90.0)]), T0 + 13 * HOUR)
        kept = self.verdicts()["12h"]
        self.assertTrue(kept["acerto"])                        # until the real exit at 5 h, not until 12 h
        self.assertIn("quedó: +400 pb", kept["texto"])
        done = json.loads(self.audit_rows()[0]["despues_json"])
        self.assertAlmostEqual(done["queda_hasta_salida_pb"], 400.0)
        self.assertIsNone(done["queda_hasta_36h_pb"])
        # the same look, but the position closed at a loss
        self.sql("UPDATE miradas SET veredicto_12h_json=NULL")
        self.put_trade(1, status="closed", side="LONG", entry_ms=T0 - HOUR, exit_ms=T0 + 5 * HOUR, exit_px="97", net_bp=-310.0,
                       closed_by="formula")
        self.resolve(step_prices([(0, 100.0), (5 * HOUR, 97.0)]), T0 + 14 * HOUR)
        lost = self.verdicts()["12h"]
        self.assertFalse(lost["acerto"])
        self.assertEqual(lost["costo_error_pb"], 300.0)
        # and still open at the horizon: marked at the price of the horizon
        self.sql("UPDATE miradas SET veredicto_12h_json=NULL")
        self.put_trade(1, status="open", side="LONG", entry_ms=T0 - HOUR, exit_ms=None, exit_px=None, net_bp=None)
        self.resolve(step_prices([(0, 100.0), (12 * HOUR, 101.0)]), T0 + 15 * HOUR)
        self.assertAlmostEqual(self.verdicts()["12h"]["valor_pb"], 100.0)

    def test_leaving_is_right_when_holding_did_not_add_and_the_cost_is_what_it_added(self):
        pos = position_of("LONG", T0 - HOUR, 1)
        self.snap(event(kind="position", action="CERRAR", position=pos, trade_no=1, net=40.0,
                        fml=formula(-1, motivo="el maestro se dio vuelta en contra")))
        self.put_trade(1, status="closed", side="LONG", entry_ms=T0 - HOUR, exit_ms=T0 + 15 * MIN, exit_px="100", net_bp=30.0,
                       closed_by="formula", exit_reason="maestro_vuelta")
        self.resolve(step_prices([(0, 100.0), (12 * HOUR, 103.0)]), T0 + 13 * HOUR)
        row, = self.audit_rows()
        self.assertEqual(row["accion"], "SALIR_vuelta")
        wrong = self.verdicts(row)["12h"]
        self.assertFalse(wrong["acerto"])
        self.assertEqual(wrong["costo_error_pb"], 300.0)
        self.assertIn("quedaba: +300 pb", wrong["texto"])
        self.sql("UPDATE miradas SET veredicto_12h_json=NULL")
        self.resolve(step_prices([(0, 100.0), (12 * HOUR, 98.0)]), T0 + 14 * HOUR)
        right = self.verdicts()["12h"]
        self.assertTrue(right["acerto"])
        self.assertEqual(right["costo_error_pb"], 0.0)
        # position closed by the look: the price from the look to the real exit, and the price 36 h after the ENTRY
        done = json.loads(self.audit_rows()[0]["despues_json"])
        self.assertAlmostEqual(done["queda_hasta_salida_pb"], 0.0)
        self.resolve(step_prices([(0, 100.0), (35 * HOUR, 110.0)]), T0 + 40 * HOUR)
        self.assertAlmostEqual(json.loads(self.audit_rows()[0]["despues_json"])["queda_hasta_36h_pb"], 1000.0)

    def test_short_positions_and_the_other_two_exits_use_the_side_of_the_position(self):
        pos = position_of("SHORT", T0 - HOUR, 1)
        for k, motivo in enumerate(("pasaron 24 h y el maestro perdió fuerza a favor", corta.NEWS_EXIT_WHY + " (primeras 12 h)")):
            self.snap(event(T0 + k * 15 * MIN, kind="position", action="CERRAR", position=pos, trade_no=1,
                            fml=formula(1, motivo=motivo)))
        self.resolve(step_prices([(0, 100.0), (12 * HOUR, 97.0)]), T0 + 13 * HOUR)
        rows = self.audit_rows()
        self.assertEqual([r["accion"] for r in rows], ["SALIR_24h", "SALIR_12h_noticias"])
        for row in rows:
            verdict = self.verdicts(row)["12h"]
            self.assertFalse(verdict["acerto"])                      # the short would have won 300 bp holding
            self.assertAlmostEqual(verdict["costo_error_pb"], 300.0)

    def test_fixed_exits_are_not_judged(self):
        pos = position_of("LONG", T0 - 36 * HOUR, 1)
        self.snap({"type": "guardrail", "kind": "guardrail", "t_ms": T0, "guardrail": "tiempo", "action": "CERRAR", "trade_no": 1,
                   "position": pos, "net_bp_now": 3.0})
        self.snap(event(T0 + 15 * MIN, kind="position", action="CERRAR", position=pos, trade_no=1, fml=formula(1, motivo="?")))
        self.resolve(step_prices([(0, 100.0)]), T0 + 13 * HOUR)
        for row in self.audit_rows():
            self.assertIn(row["accion"], ("SALIR_36h", "SALIR_otro"))
            verdict = self.verdicts(row)["12h"]
            self.assertEqual(verdict["acerto"], None)
            self.assertEqual(verdict["regla"], "regla fija")
            self.assertEqual(verdict["costo_error_pb"], 0.0)
        self.assertIsNone(self.audit_rows()[0]["veredicto_36h_json"])
        self.resolve(step_prices([(0, 100.0)]), T0 + 37 * HOUR)
        self.assertTrue(all(r["resuelto_ms"] == T0 + 37 * HOUR for r in self.audit_rows()))

    def test_a_look_without_candles_stays_pending(self):
        self.look("ESPERAR", formula(2, portero_si=False))
        result = self.resolve({}, T0 + 50 * HOUR)
        self.assertEqual((result["miradas"], result["pendientes"]), (0, 1))
        self.assertIsNone(self.audit_rows()[0]["despues_json"])


class SummaryTests(AuditorCase):
    def put_row(self, t_ms, accion, hit, cost=0.0, **overrides):
        """Una mirada ya resuelta (con su veredicto de 36 h) escrita directo; ``hit=NO_VERDICT`` la deja sin veredicto."""
        row = {"product": PRODUCT, "bucket_ms": t_ms - aud.BUCKET_MS, "t_ms": t_ms, "estado": "plana", "accion": accion,
               "maestro": 2, "puntaje": STRONG * 1.1, "umbral_flojo": WEAK, "umbral_fuerte": STRONG, "portero_si": 1,
               "portero_p": 0.74, "portero_umbral": 0.70, "noticias_si": 0, "noticias_lado": None, "qwen": None,
               "qwen_coincide": None, "lado_posicion": 0, "horas_en_posicion": None, "neto_ahora_pb": None, "trade_no": None,
               "condiciones_json": json.dumps({"hora_madrid": 5, "dia": 2, "mercado": {"turbulencia": 1}}), "version": aud.VERSION}
        row.update(overrides)
        with contextlib.closing(aud._open(self.path)) as db:
            with db:
                aud._insert(db, row)
                if hit is NO_VERDICT:
                    return
                db.execute("UPDATE miradas SET veredicto_36h_json=?, resuelto_ms=? WHERE product=? AND bucket_ms=?",
                           (json.dumps({"acerto": hit, "costo_error_pb": cost, "regla": "r", "texto": "t"}), t_ms + 40 * HOUR,
                            PRODUCT, row["bucket_ms"]))

    def test_it_groups_by_action_and_by_condition_and_flags_small_groups(self):
        for k in range(40):
            self.put_row(T0 + k * 15 * MIN, "NO_ENTRAR_portero", k % 4 != 0, cost=10.0 if k % 4 == 0 else 0.0)
        self.put_row(T0 + 50 * HOUR, "ENTRAR", True)
        self.put_row(T0 + 51 * HOUR, "ENTRAR", False, cost=30.0, condiciones_json=json.dumps({"hora_madrid": 14, "dia": 6}),
                     puntaje=STRONG * 1.3, portero_p=0.69, horas_en_posicion=5.0, neto_ahora_pb=-150.0)
        self.put_row(T0 + 52 * HOUR, "ENTRAR", NO_VERDICT)                              # sin veredicto todavía
        report = aud.summary(self.path)
        self.assertEqual(report["schema"], "balancita-auditor.v1")
        self.assertEqual(report["miradas"], 43)
        self.assertEqual(report["pendientes"], {"sin_veredicto": 1, "provisorias": 0})
        skipped = report["por_accion"]["NO_ENTRAR_portero"]
        self.assertEqual((skipped["miradas"], skipped["juzgadas"], skipped["aciertos"]), (40, 40, 30))
        self.assertEqual(skipped["acierto_pct"], 75.0)
        self.assertEqual((skipped["costo_total_pb"], skipped["costo_medio_pb"], skipped["costo_medio_por_error_pb"]),
                         (100.0, 2.5, 10.0))
        self.assertFalse(skipped["pocos_datos"])
        entered = report["por_accion"]["ENTRAR"]
        self.assertEqual((entered["miradas"], entered["juzgadas"], entered["acierto_pct"]), (3, 2, 50.0))
        self.assertTrue(entered["pocos_datos"])
        self.assertEqual(entered["costo_total_pb"], 30.0)
        groups = report["por_condicion"]
        self.assertEqual(groups["franja_horaria_madrid"]["04-08"]["total"]["miradas"], 42)
        self.assertEqual(groups["franja_horaria_madrid"]["12-16"]["por_accion"]["ENTRAR"]["miradas"], 1)
        self.assertEqual(groups["dia_semana"]["miércoles"]["total"]["miradas"], 42)
        self.assertEqual(groups["dia_semana"]["domingo"]["total"]["miradas"], 1)
        self.assertEqual(groups["turbulencia"]["turbulento"]["total"]["miradas"], 42)
        self.assertEqual(groups["turbulencia"]["sin dato"]["total"]["miradas"], 1)
        self.assertEqual(groups["puntaje_sobre_umbral_fuerte"]["1-1,25"]["total"]["miradas"], 42)
        self.assertEqual(groups["puntaje_sobre_umbral_fuerte"]["1,25-1,5"]["total"]["miradas"], 1)
        self.assertEqual(groups["portero_p_menos_umbral"]["0,02-0,05"]["total"]["miradas"], 42)
        self.assertEqual(groups["portero_p_menos_umbral"]["neg 0-0,02"]["total"]["miradas"], 1)
        self.assertEqual(groups["horas_en_posicion"]["4-12"]["total"]["miradas"], 1)
        self.assertEqual(groups["neto_al_momento"]["−100..0" if False else "<−100"]["total"]["miradas"], 1)
        self.assertTrue(groups["horas_en_posicion"]["4-12"]["total"]["pocos_datos"])
        self.assertFalse(groups["franja_horaria_madrid"]["04-08"]["total"]["pocos_datos"])

    def test_band_edges(self):
        row = lambda **k: dict({"puntaje": STRONG, "umbral_fuerte": STRONG, "portero_p": 0.7, "portero_umbral": 0.7,
                                "horas_en_posicion": None, "neto_ahora_pb": None}, **k)
        dims = lambda r: aud._dimensions(r, {})
        self.assertEqual(dims(row())["puntaje_sobre_umbral_fuerte"], "1-1,25")
        self.assertEqual(dims(row(puntaje=STRONG * 2))["puntaje_sobre_umbral_fuerte"], "≥2")
        self.assertEqual(dims(row(puntaje=-STRONG * 1.6))["puntaje_sobre_umbral_fuerte"], "1,5-2")
        self.assertEqual(dims(row())["portero_p_menos_umbral"], "0-0,02")
        self.assertEqual(dims(row(portero_p=0.85))["portero_p_menos_umbral"], "≥0,10")
        self.assertEqual(dims(row(portero_p=0.58))["portero_p_menos_umbral"], "neg ≥0,10")
        self.assertEqual(dims(row(horas_en_posicion=24))["horas_en_posicion"], "≥24")
        self.assertEqual(dims(row(horas_en_posicion=3.9))["horas_en_posicion"], "<4")
        self.assertEqual(dims(row(neto_ahora_pb=100))["neto_al_momento"], "≥100")
        self.assertEqual(dims(row(neto_ahora_pb=-100))["neto_al_momento"], "−100..0")
        self.assertEqual(dims(row(neto_ahora_pb=0))["neto_al_momento"], "0..100")
        self.assertEqual(dims(row())["turbulencia"], "sin dato")

    def test_an_empty_database_gives_an_empty_summary(self):
        report = aud.summary(self.path)
        self.assertEqual((report["miradas"], report["por_accion"], report["por_condicion"]), (0, {}, {}))

    def test_the_provisional_verdict_is_used_while_the_final_one_does_not_exist(self):
        self.snap(event(fml=formula(2, portero_si=False)))
        self.sql("UPDATE miradas SET veredicto_12h_json=?", json.dumps({"acerto": True, "costo_error_pb": 0.0}))
        report = aud.summary(self.path, product=PRODUCT)
        self.assertEqual(report["pendientes"], {"sin_veredicto": 0, "provisorias": 1})
        self.assertEqual(report["por_accion"]["NO_ENTRAR_portero"]["acierto_pct"], 100.0)


class RebuildAndCommandLineTests(AuditorCase):
    def make_history(self):
        flip = -(WEAK + 0.1)
        for k in range(0, 16 * 4):
            t_ms = T0 + k * 15 * MIN
            self.put_look(t_ms, formula(2, flip if t_ms >= T0 + 3 * HOUR else STRONG + 0.1, portero_si=False))
        self.put_look(T0 + 16 * HOUR, formula(2), action="LARGO", trade_no=1)
        self.put_trade(1, status="closed", side="LONG", entry_ms=T0 + 16 * HOUR, exit_ms=T0 + 17 * HOUR, net_bp=12.0,
                       closed_by="tiempo", max_hold_ms=HOUR)
        self.store.db.commit()
        cache = os.path.join(self.tmp, "cache")
        os.makedirs(cache)
        con = sqlite3.connect(os.path.join(cache, "candles-{}.sqlite".format(PRODUCT)))
        con.execute("CREATE TABLE candles(res TEXT NOT NULL, t INTEGER NOT NULL, o TEXT NOT NULL, h TEXT NOT NULL, l TEXT NOT NULL, "
                    "c TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY(res, t))")
        for end, price in step_prices([(0, 100.0), (3 * HOUR, 102.0)], start=T0 - HOUR, end=T0 + 60 * HOUR).items():
            con.execute("INSERT INTO candles VALUES('5m',?,?,?,?,?,?)", (end - BAR, price, price, price, price, "1"))
        con.commit()
        con.close()

    def run_cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = aud.main(["--db", self.path, *args])
        self.assertEqual(code, 0)
        return json.loads(out.getvalue())

    def test_rebuild_creates_the_missing_rows_marks_the_origin_and_is_idempotent(self):
        self.make_history()
        first = self.run_cli("--rebuild")
        self.assertEqual(first["rebuild"]["creadas"], 16 * 4 + 1 + 1)           # looks + the entry + the 'tiempo' exit
        rows = self.audit_rows()
        self.assertTrue(all(json.loads(r["condiciones_json"])["origen"] == "rebuild" for r in rows))
        self.assertEqual({r["accion"] for r in rows}, {"NO_ENTRAR_portero", "ENTRAR", "SALIR_36h"})
        snapshot = self.audit_rows()
        self.assertEqual(self.run_cli("--rebuild")["rebuild"]["creadas"], 0)
        self.assertEqual(self.audit_rows(), snapshot)

    def test_a_row_taken_live_is_kept_by_a_later_rebuild(self):
        self.make_history()
        self.snap(event(T0, fml=formula(2, portero_si=False)))
        self.run_cli("--rebuild")
        self.assertEqual(json.loads(self.audit_rows("t_ms={}".format(T0))[0]["condiciones_json"])["origen"], "vivo")

    def test_resolve_reads_the_candle_cache_of_the_live_process_and_the_summary_prints_json(self):
        self.make_history()
        now = T0 + 70 * HOUR
        out = self.run_cli("--rebuild", "--resolve", "--summary", "--now-ms", str(now))
        self.assertEqual(out["resolve"][PRODUCT]["pendientes"], 0)
        row = self.audit_rows("t_ms={}".format(T0))[0]
        self.assertEqual(row["resuelto_ms"], now)
        self.assertAlmostEqual(json.loads(row["despues_json"])["si_entraba_maestro_pb"],
                               200.0 - float(aud.round_trip_cost_bps(PRODUCT)))
        self.assertEqual(out["summary"]["miradas"], 16 * 4 + 2)
        self.assertIn("NO_ENTRAR_portero", out["summary"]["por_accion"])
        before = self.audit_rows()
        again = self.run_cli("--rebuild", "--resolve", "--now-ms", str(now + HOUR))
        self.assertEqual(again["resolve"][PRODUCT]["actualizadas"], 0)
        self.assertEqual(self.audit_rows(), before)

    def test_it_refuses_a_missing_database(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(aud.main(["--db", os.path.join(self.tmp, "no-existe.sqlite"), "--summary"]), 2)


class LiveHookTests(unittest.TestCase):
    """The live operator takes a snapshot of every look and resolves; nothing the auditor does changes a decision."""

    def run_live(self, auditor_fails=False, opinions=True):
        cfg = copy.deepcopy(CFG)
        cfg["products"] = ["PF_ETHUSD"]
        cfg["opinion_enabled"] = opinions
        cfg["runtime"]["opinion_enabled"] = opinions
        cfg["runtime"].pop("pending_config", None)
        env = make(self, cfg=cfg, policy=Policy(flat="ESPERAR", position="MANTENER"), formula=True)
        answers = iter([("LARGO", "maestro fuerte y portero a favor")] + [("MANTENER", "x")] * 3
                       + [("CERRAR", "el maestro se dio vuelta en contra")] + [("ESPERAR", "el maestro no está fuerte")] * 500)
        patches = [mock.patch.object(corta, "formula_action", side_effect=lambda r, side, **kwargs: next(answers))]
        if auditor_fails:
            patches.append(mock.patch.object(live.auditor, "snapshot", side_effect=RuntimeError("auditor roto")))
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            env.op.start()
            env.advance(120)
        return env

    @staticmethod
    def decisions(env):
        return env.rows("SELECT product, bucket_ms, t_ms, kind, action, formula_action, formula_json, trade_no, net_bp_now "
                        "FROM decisions ORDER BY t_ms")

    def audit(self, env):
        con = sqlite3.connect(os.path.join(env.tmp, "auditor.sqlite"))
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute("SELECT * FROM miradas ORDER BY t_ms")]
        finally:
            con.close()

    def test_every_look_with_a_decision_is_audited_and_the_live_database_gets_no_audit_tables(self):
        env = self.run_live()
        decisions = [d for d in self.decisions(env) if d["formula_json"]]
        rows = self.audit(env)
        self.assertGreaterEqual(len(decisions), 4)
        self.assertEqual([r["t_ms"] for r in rows], [d["t_ms"] for d in decisions])
        self.assertEqual({r["accion"] for r in rows} >= {"ENTRAR", "MANTENER", "SALIR_vuelta"}, True)
        tables = {r["name"] for r in env.rows("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertFalse(tables & {"miradas", "auditor"})
        self.assertEqual(env.rows("SELECT * FROM errors"), [])
        entry = next(r for r in rows if r["accion"] == "ENTRAR")
        conditions = json.loads(entry["condiciones_json"])
        self.assertEqual(conditions["origen"], "vivo")
        self.assertIsNotNone(conditions["precio"])
        self.assertIsNotNone(conditions["mercado"]["ret_24h"])
        self.assertIn(conditions["mercado"]["turbulencia"], (None, 0, 1))
        self.assertIsNotNone(entry["umbral_fuerte"])
        self.assertEqual(entry["lado_posicion"], 1)

    def test_it_also_runs_when_qwen_gives_no_opinion(self):
        env = self.run_live(opinions=False)
        self.assertTrue(self.audit(env))

    def test_a_failing_auditor_changes_no_decision_and_is_only_a_warning(self):
        clean = self.run_live()
        broken = self.run_live(auditor_fails=True)
        self.assertEqual(self.decisions(broken), self.decisions(clean))
        self.assertEqual(broken.rows("SELECT * FROM trades ORDER BY trade_no"), clean.rows("SELECT * FROM trades ORDER BY trade_no"))
        errors = broken.rows("SELECT place, kind FROM errors")
        self.assertTrue(errors and all(e["place"] == "auditor" and e["kind"] == "RuntimeError" for e in errors))
        self.assertFalse(broken.op.failed_cycle)                      # no frena el sondeo
        self.assertFalse(os.path.exists(os.path.join(broken.tmp, "auditor.sqlite")) and self.audit(broken))


if __name__ == "__main__":
    unittest.main()
