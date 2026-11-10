"""Laboratorio S4: el replay de la Terminal oficial contra lo que decidió el vivo (``decisions`` / ``trades`` de ``live.sqlite``).

Datos sintéticos y una base viva falsa en un directorio temporal; nada de red. Es un chequeo de equivalencia de CÓDIGO, no una
evaluación de estrategia: no registra intentos y puede tocar fechas de la reserva."""
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

from balancita_engine import futures_estrategias as est
from balancita_engine import futures_estrategias_backtest as bt
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as exam
from test_futures_qwen_live import BAR, walk

MIN = qt.MINUTE_MS
SELLO = "20261105-033001"
DESDE, HASTA = "2026-10-10", "2026-10-12"
ACTIVADA_MS = qt.date_ms("2026-10-10") + 3 * qt.HOUR_MS + 14 * MIN + 54_000      # 03:14:54 UTC


def decision(t_ms, action, *, kind="flat", maestro=0, puntaje=0.1, portero=1, motivo="m"):
    return {"t_ms": t_ms, "kind": kind, "action": action, "maestro": maestro, "puntaje": puntaje, "portero": portero, "motivo": motivo}


def operacion(side, entrada_ms, salida_ms, neto_bp=10.0, estado="closed", motivo="maestro_vuelta", nocional=500.0, **importes):
    """Una operación como la leen ``comparar_operaciones`` (vivo o replay). Por defecto los importes son coherentes con ``neto_bp``."""
    cerrada = estado == "closed" and salida_ms is not None
    base = {"notional_usd": nocional, "qty": nocional / 2000.0, "entry_px": 2000.0,
            "net_usd": nocional * neto_bp / 1e4 if cerrada and neto_bp is not None else None,
            "fees_usd": nocional * 0.001 if cerrada else None, "funding_usd": nocional * 0.0003 if cerrada else None}
    base.update(importes)
    return dict({"side": side, "entry_ms": entrada_ms, "exit_ms": salida_ms, "net_bp": neto_bp, "status": estado, "closed_by": "formula",
                 "exit_reason": motivo}, **base)


class DecisionesTests(unittest.TestCase):
    def comparar(self, vivas, replay, **kw):
        kw.setdefault("cooldown_ms", 15 * MIN)
        return bt.comparar_decisiones(vivas, replay, **kw)

    def test_identical_decisions_agree_and_nothing_is_listed(self):
        filas = [decision(t * 15 * MIN, "ESPERAR") for t in range(1, 5)]
        r = self.comparar(filas, copy.deepcopy(filas))
        self.assertEqual((r["vivas"], r["replay"], r["coinciden"], r["difieren"], r["solo_vivo"], r["solo_replay"]), (4, 4, 4, 0, 0, 0))
        self.assertEqual((r["diferencias"], r["lista_solo_vivo"], r["lista_solo_replay"]), ([], [], []))
        self.assertEqual((r["senal_coincide"], r["puntaje_dif_max"]), (4, 0.0))

    def test_a_different_action_is_listed_with_both_sides_and_the_signal_still_matches(self):
        vivas = [decision(15 * MIN, "ESPERAR"), decision(30 * MIN, "LARGO", maestro=2)]
        replay = [decision(15 * MIN, "ESPERAR"), decision(30 * MIN, "ESPERAR", maestro=2, motivo="otro")]
        r = self.comparar(vivas, replay)
        self.assertEqual((r["coinciden"], r["difieren"]), (1, 1))
        [dif] = r["diferencias"]
        self.assertEqual((dif["t_ms"], dif["vivo"]["action"], dif["replay"]["action"]), (30 * MIN, "LARGO", "ESPERAR"))
        self.assertEqual(dif["replay"]["motivo"], "otro")
        self.assertTrue(dif["misma_senal"])

    def test_a_different_maestro_or_portero_breaks_the_signal_and_the_score_gap_is_measured(self):
        vivas = [decision(15 * MIN, "ESPERAR", maestro=2, puntaje=0.5, portero=1)]
        replay = [decision(15 * MIN, "ESPERAR", maestro=1, puntaje=0.4, portero=-1)]
        r = self.comparar(vivas, replay)
        self.assertEqual((r["coinciden"], r["senal_coincide"]), (1, 0))
        self.assertAlmostEqual(r["puntaje_dif_max"], 0.1)

    def test_decisions_only_on_one_side_are_listed_and_the_replay_ones_are_explained_when_possible(self):
        parado = 30 * MIN
        enfriamiento = 60 * MIN
        sin_razon = 90 * MIN
        vivas = [decision(15 * MIN, "ESPERAR"), decision(120 * MIN, "ESPERAR")]
        replay = [decision(t, "ESPERAR") for t in (15 * MIN, parado, enfriamiento, sin_razon)]
        r = self.comparar(vivas, replay, omitidos_vivos={parado: "proceso_detenido"}, salidas_vivas=[enfriamiento - 5 * MIN + 5_000])
        self.assertEqual((r["coinciden"], r["difieren"], r["solo_vivo"], r["solo_replay"]), (1, 0, 1, 3))
        self.assertEqual([x["t_ms"] for x in r["lista_solo_vivo"]], [120 * MIN])
        por_t = {x["t_ms"]: x["explicacion"] for x in r["lista_solo_replay"]}
        self.assertEqual(por_t[parado], "el vivo omitió esa mirada: proceso_detenido")
        self.assertIn("enfriamiento", por_t[enfriamiento])
        self.assertIsNone(por_t[sin_razon])
        self.assertEqual(r["solo_replay_sin_explicar"], 1)


class OperacionesTests(unittest.TestCase):
    def test_trades_are_paired_by_side_and_entry_candle_and_the_net_gap_is_shown(self):
        vivas = [operacion("LONG", 100 * MIN + 4_000, 400 * MIN + 3_000, 100.0)]
        replay = [operacion("LONG", 100 * MIN, 400 * MIN, 98.0)]
        r = bt.comparar_operaciones(vivas, replay)
        self.assertEqual((r["vivo"], r["replay"], r["emparejadas"], r["solo_vivo"], r["solo_replay"]), (1, 1, 1, 0, 0))
        [par] = r["pares"]
        self.assertTrue(par["salida_igual"])
        self.assertAlmostEqual(par["neto_bp_diferencia"], -2.0)

    def test_unmatched_trades_on_each_side_and_different_sides_do_not_pair(self):
        vivas = [operacion("LONG", 100 * MIN, 200 * MIN), operacion("SHORT", 300 * MIN, 400 * MIN)]
        replay = [operacion("SHORT", 100 * MIN, 200 * MIN), operacion("SHORT", 300 * MIN, 410 * MIN)]
        r = bt.comparar_operaciones(vivas, replay)
        self.assertEqual((r["emparejadas"], r["solo_vivo"], r["solo_replay"]), (1, 1, 1))
        [par] = r["pares"]
        self.assertFalse(par["salida_igual"])                                      # 10 min de diferencia: otra vela de salida
        self.assertEqual(r["lista_solo_vivo"][0]["side"], "LONG")
        self.assertEqual(r["lista_solo_replay"][0]["side"], "SHORT")

    def test_a_trade_still_open_in_the_live_copy_is_paired_without_judging_its_exit(self):
        r = bt.comparar_operaciones([operacion("SHORT", 100 * MIN, None, None, estado="open")],
                                    [operacion("SHORT", 100 * MIN, 900 * MIN, -50.0, motivo="fin_examen")])
        [par] = r["pares"]
        self.assertIsNone(par["salida_igual"])
        self.assertIsNone(par["neto_bp_diferencia"])
        self.assertEqual(r["abiertas_en_vivo"], 1)


class ImportesTests(unittest.TestCase):
    """S4 ampliado: además de la hora y los bp, cada operación emparejada compara TAMAÑO, importes en US$ y horas (el chequeo anterior
    no miraba el tamaño: un replay con otro saldo daba las mismas decisiones y bp con otros dólares)."""

    def par(self, vivo, replay):
        r = bt.comparar_operaciones([vivo], [replay])
        [par] = r["pares"]
        return r, par

    def test_every_amount_of_a_paired_trade_is_shown_with_both_sides_the_difference_and_the_verdict(self):
        vivo = operacion("LONG", 100 * MIN + 4_000, 700 * MIN + 3_000, 100.0, nocional=494.34)
        replay = operacion("LONG", 100 * MIN, 700 * MIN, 99.0, nocional=495.0)
        r, par = self.par(vivo, replay)
        imp = par["importes"]
        self.assertEqual(sorted(imp), ["comisiones_usd", "funding_usd", "horas", "neto_usd", "nocional_usd", "qty"])
        self.assertEqual((imp["nocional_usd"]["vivo"], imp["nocional_usd"]["replay"]), (494.34, 495.0))
        self.assertAlmostEqual(imp["nocional_usd"]["diferencia"], 0.66)
        self.assertAlmostEqual(imp["neto_usd"]["diferencia"], 495.0 * 99e-4 - 494.34 * 100e-4)
        self.assertAlmostEqual(imp["horas"]["vivo"], 600 / 60 + 3 / 3600 - 4 / 3600)
        for campo, dato in imp.items():
            self.assertTrue(dato["dentro"], campo)
        self.assertEqual((r["importes"]["nocional_usd"]["comparadas"], r["importes"]["nocional_usd"]["fuera"]), (1, 0))
        self.assertAlmostEqual(r["importes"]["nocional_usd"]["dif_max"], 0.66)
        self.assertEqual(r["fuera_de_tolerancia"], [])

    def test_a_different_size_is_flagged_listed_and_does_not_hide_behind_equal_bp(self):
        vivo = operacion("LONG", 100 * MIN, 700 * MIN, 100.0, nocional=494.0)
        replay = operacion("LONG", 100 * MIN, 700 * MIN, 100.0, nocional=330.0)
        r, par = self.par(vivo, replay)
        self.assertFalse(par["importes"]["nocional_usd"]["dentro"])
        self.assertFalse(par["importes"]["qty"]["dentro"])
        self.assertTrue(par["importes"]["neto_usd"]["dentro"])               # a igual tamaño el neto coincide: lo que difiere es el tamaño
        self.assertEqual(r["importes"]["nocional_usd"]["fuera"], 1)
        campos = {x["campo"] for x in r["fuera_de_tolerancia"]}
        self.assertEqual(campos, {"nocional_usd", "qty"})
        item = next(x for x in r["fuera_de_tolerancia"] if x["campo"] == "nocional_usd")
        self.assertEqual((item["vivo"], item["replay"], item["side"]), (494.0, 330.0, "LONG"))
        self.assertAlmostEqual(item["diferencia"], -164.0)
        self.assertIn("entrada", item)

    def test_a_different_net_fee_funding_or_hold_is_flagged_by_field(self):
        base = operacion("LONG", 100 * MIN, 700 * MIN, 100.0, nocional=500.0)
        casos = {"neto_usd": dict(net_usd=500.0 * 110 / 1e4),                  # 10 bp más: fuera de los 2 bp
                 "comisiones_usd": dict(fees_usd=500.0 * 0.0016),               # 6 bp más de comisión
                 "funding_usd": dict(funding_usd=500.0 * 0.0003 + 500.0 * 0.0003)}  # 3 bp más de funding
        for campo, cambio in casos.items():
            with self.subTest(campo=campo):
                r, par = self.par(base, operacion("LONG", 100 * MIN, 700 * MIN, 100.0, nocional=500.0, **cambio))
                self.assertFalse(par["importes"][campo]["dentro"])
                self.assertEqual([x["campo"] for x in r["fuera_de_tolerancia"]], [campo])
        r, par = self.par(base, operacion("LONG", 100 * MIN, 720 * MIN, 100.0, nocional=500.0))      # sale 20 min tarde (4 velas)
        self.assertFalse(par["importes"]["horas"]["dentro"])
        self.assertAlmostEqual(par["importes"]["horas"]["diferencia"], 20 / 60)

    def test_amounts_are_compared_at_equal_size_so_a_size_gap_is_reported_once_not_in_every_dollar_field(self):
        vivo = operacion("LONG", 100 * MIN, 700 * MIN, 100.0, nocional=500.0)
        replay = operacion("LONG", 100 * MIN, 700 * MIN, 100.0, nocional=400.0)       # 20 % menos, todo proporcional
        r, par = self.par(vivo, replay)
        self.assertFalse(par["importes"]["nocional_usd"]["dentro"])
        for campo in ("neto_usd", "comisiones_usd", "funding_usd"):
            self.assertTrue(par["importes"][campo]["dentro"], campo)
            self.assertLess(par["importes"][campo]["diferencia"], 0)                  # la diferencia cruda sí se muestra (en US$)

    def test_the_small_third_slot_tolerates_a_dollar_of_balance_drift_and_not_more(self):
        vivo = operacion("LONG", 100 * MIN, 700 * MIN, 100.0, nocional=9.98)
        cerca = self.par(vivo, operacion("LONG", 100 * MIN, 700 * MIN, 100.0, nocional=9.995))[1]
        lejos = self.par(vivo, operacion("LONG", 100 * MIN, 700 * MIN, 100.0, nocional=12.5))[1]
        self.assertTrue(cerca["importes"]["nocional_usd"]["dentro"])
        self.assertFalse(lejos["importes"]["nocional_usd"]["dentro"])

    def test_an_open_live_trade_compares_size_but_not_the_amounts_that_need_a_close(self):
        vivo = operacion("SHORT", 100 * MIN, None, None, estado="open", nocional=511.0)
        replay = operacion("SHORT", 100 * MIN, 900 * MIN, -500.0, motivo="fin_examen", nocional=512.0)
        r, par = self.par(vivo, replay)
        self.assertTrue(par["importes"]["nocional_usd"]["dentro"])
        for campo in ("neto_usd", "comisiones_usd", "funding_usd", "horas"):
            self.assertIsNone(par["importes"][campo]["dentro"], campo)
            self.assertIsNone(par["importes"][campo]["diferencia"], campo)
        self.assertEqual(r["importes"]["neto_usd"]["comparadas"], 0)
        self.assertEqual(r["fuera_de_tolerancia"], [])

    def test_the_tolerances_are_published_in_the_report(self):
        r = bt.comparar_operaciones([], [])
        for clave in ("nocional_rel", "nocional_abs_usd", "neto_bp", "comisiones_bp", "funding_bp", "horas_ms"):
            self.assertIn(clave, r["tolerancias"])
        self.assertEqual(r["tolerancias"]["horas_ms"], bt.TOLERANCIA_OPERACION_MS)
        self.assertEqual(r["tolerancias"], bt.TOLERANCIAS_IMPORTES)


class VivoBase(unittest.TestCase):
    """Un snapshot de prueba (expertos reales, sin analista ni funding exacto), velas sintéticas y una base viva falsa."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.carpeta = self.tmp.name
        real = est.cargar_snapshot()
        cfg = copy.deepcopy(real["config"])
        for clave in ("analista", "funding_model"):
            cfg.pop(clave, None)
        self.assertEqual(cfg["execution"], {"model": "kraken-futures-book.v1"})     # la Terminal declara el libro: el replay no lo tiene
        self.snapshot_ruta = os.path.join(self.carpeta, "terminal-activa.json")
        with open(self.snapshot_ruta, "w", encoding="utf-8") as handle:
            json.dump(dict(real, config=cfg, config_hash=qt.config_hash(cfg)), handle)
        self.snapshot = est.cargar_snapshot(self.snapshot_ruta)
        self.cfg = self.snapshot["config"]
        low = qt.date_ms(DESDE) - 9 * qt.DAY_MS
        end = qt.date_ms(HASTA)
        self.barras = {producto: walk((end - low) // BAR, seed, low, price=100 + seed)
                       for seed, producto in enumerate(("PF_ETHUSD", "PF_SOLUSD", "PF_XBTUSD"), 1)}
        self.crear_velas()

    # ---- la copia del respaldo: <carpeta>/qwen-live_cache__candles-<producto>-<sello>.sqlite
    def crear_velas(self, productos=None):
        for producto, barras in self.barras.items():
            if productos is not None and producto not in productos:
                continue
            ruta = os.path.join(self.carpeta, "qwen-live_cache__candles-{}-{}.sqlite".format(producto, SELLO))
            db = sqlite3.connect(ruta)
            db.execute("CREATE TABLE candles(res TEXT NOT NULL, t INTEGER NOT NULL, o TEXT NOT NULL, h TEXT NOT NULL, l TEXT NOT NULL, "
                       "c TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY(res, t))")
            db.executemany("INSERT INTO candles VALUES('5m',?,?,?,?,?,?)",
                           [(b["bucket_start"], b["open"], b["high"], b["low"], b["close"], b["volume_btc"]) for b in barras])
            db.commit()
            db.close()

    def replay_directo(self, capital="1000"):
        """Lo que el replay hace con los mismos datos: sus eventos, para fabricar la base viva a partir de ellos."""
        class Lector:
            def __init__(self, barras):
                self.barras = barras

            def bars(self, product, low, high, **kw):
                return qt.fill_gaps([b for b in self.barras[product] if low <= b["bucket_start"] < high], qt.BAR_MS,
                                    annotate=kw.get("annotate", False)) if kw.get("fill", True) else \
                    [b for b in self.barras[product] if low <= b["bucket_start"] < high]

            def funding(self, product):
                return [(at, 0) for at in range(qt.date_ms("2026-09-01"), qt.date_ms("2026-10-30"), qt.HOUR_MS)]
        eventos = []
        hasta = qt.date_ms(HASTA)
        desde = -(-ACTIVADA_MS // qt.BAR_MS) * qt.BAR_MS
        exam.replay_formula(Lector(self.barras), self.cfg, hasta, desde_ms=desde, on_event=eventos.append, capital_usd=capital)
        return eventos

    def crear_vivo(self, eventos, nombre="qwen-live__live-{}.sqlite".format(SELLO), activada_ms=ACTIVADA_MS, cambiar=None, omitidos=(),
                   saldo="1000", tamano=1.0, entrada_en_la_mirada=False):
        """``saldo``: el ``cash_usd`` de la activación; ``tamano``: factor del nocional/qty/importes que registra el vivo (1 = el mismo).
        ``entrada_en_la_mirada``: como desde operacion-mejoras T2 la entrada se fecha con la mirada (la hora de la vela); por defecto el vivo
        antiguo, que la fechaba con el llenado, 4 s después. La salida siempre se fecha con el llenado (3 s después)."""
        retraso_entrada = 0 if entrada_en_la_mirada else 4_000
        ruta = os.path.join(self.carpeta, nombre)
        db = sqlite3.connect(ruta)
        db.executescript("""
CREATE TABLE decisions(product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
  config_hash TEXT, formula_json TEXT, trade_no INTEGER);
CREATE TABLE trades(product TEXT NOT NULL, trade_no INTEGER NOT NULL, status TEXT NOT NULL, side TEXT NOT NULL, entry_ms INTEGER NOT NULL,
  exit_ms INTEGER, net_bp REAL, closed_by TEXT, exit_reason TEXT, entry_reason TEXT, config_hash TEXT, entry_px TEXT, qty TEXT,
  notional_usd TEXT, fees_usd TEXT, funding_usd TEXT, net_usd TEXT);
CREATE TABLE skipped(product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, at_ms INTEGER NOT NULL, reason TEXT NOT NULL,
  detail TEXT, wake_json TEXT);
CREATE TABLE config_versions(id INTEGER PRIMARY KEY AUTOINCREMENT, previous_hash TEXT, config_hash TEXT NOT NULL, activated_ms INTEGER NOT NULL,
  config_json TEXT NOT NULL, cash_usd TEXT NOT NULL);
""")
        db.execute("INSERT INTO config_versions(previous_hash, config_hash, activated_ms, config_json, cash_usd) VALUES(NULL,?,?,'{}',?)",
                   (self.snapshot["config_hash"], activada_ms, saldo))
        cambiar = cambiar or {}
        n = 0
        for e in eventos:
            if e["type"] == "decision":
                f = e["formula"]
                if e["t_ms"] in omitidos:
                    continue
                accion = cambiar.get(e["t_ms"], e["action"])
                vivo = {"maestro": f["maestro"], "puntaje": f["puntaje"], "portero_autonomo": f.get("portero_autonomo"), "motivo": f["motivo"]}
                db.execute("INSERT INTO decisions VALUES('PF_ETHUSD',?,?,?,?,?,?,?)",
                           (e["t_ms"] - 15 * MIN, e["t_ms"], e["kind"], accion, self.snapshot["config_hash"], json.dumps(vivo), e.get("trade_no")))
            elif e["type"] == "trade":
                n += 1
                t = e["trade"]
                if t["closed_by"] == "fin_examen":               # el replay la cierra al final de los datos; en vivo sigue abierta
                    db.execute("INSERT INTO trades VALUES('PF_ETHUSD',?,'open',?,?,NULL,NULL,NULL,NULL,'formula',?,?,?,?,NULL,NULL,NULL)",
                               (n, t["side"], t["entry_ms"] + retraso_entrada, self.snapshot["config_hash"], t["entry_px"],
                                str(float(t["qty"]) * tamano), str(float(t["notional_usd"]) * tamano)))
                    continue
                nocional = float(t["notional_usd"]) * tamano
                db.execute("INSERT INTO trades VALUES('PF_ETHUSD',?,'closed',?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                           (n, t["side"], t["entry_ms"] + retraso_entrada, t["exit_ms"] + 3_000, t["net_bp"] + 1.5, t["closed_by"], t["exit_reason"],
                            "formula", self.snapshot["config_hash"], t["entry_px"], str(float(t["qty"]) * tamano), str(nocional),
                            str(float(t["fees_usd"]) * tamano), str(float(t["funding_usd"]) * tamano),
                            str(float(t["net_usd"]) * tamano + 1.5 / 1e4 * nocional)))
        for t in omitidos:
            db.execute("INSERT INTO skipped VALUES('PF_ETHUSD',?,?,?,'proceso_detenido','x','[]')", (t - 15 * MIN, t, t))
        db.commit()
        db.close()
        return ruta

    def comparar(self, ruta, **kw):
        return bt.comparar_con_vivo(DESDE, HASTA, live_db=ruta, snapshot=self.snapshot, **kw)

    @staticmethod
    def huella(ruta):
        with open(ruta, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()


class CompararConVivoTests(VivoBase):
    def test_replay_of_the_official_config_reproduces_every_live_decision_and_trade(self):
        eventos = self.replay_directo()
        decisiones = [e for e in eventos if e["type"] == "decision"]
        self.assertGreater(len(decisiones), 100)             # el replay SÍ decide (con el libro declarado en la config)
        ruta = self.crear_vivo(eventos)
        informe = self.comparar(ruta)
        d = informe["decisiones"]
        self.assertEqual((d["vivas"], d["replay"], d["coinciden"], d["difieren"], d["solo_vivo"], d["solo_replay"]),
                         (len(decisiones), len(decisiones), len(decisiones), 0, 0, 0))
        self.assertEqual((d["senal_coincide"], d["puntaje_dif_max"]), (len(decisiones), 0.0))
        o = informe["operaciones"]
        self.assertEqual((o["solo_vivo"], o["solo_replay"]), (0, 0))
        self.assertEqual(o["emparejadas"], o["vivo"])
        self.assertEqual(o["abiertas_en_vivo"], sum(1 for e in eventos if e["type"] == "trade" and e["trade"]["closed_by"] == "fin_examen"))
        self.assertTrue(all(p["salida_igual"] for p in o["pares"] if p["salida_igual"] is not None))
        self.assertEqual(informe["schema"], bt.SCHEMA_VIVO)
        self.assertEqual(informe["snapshot"]["config_hash"], self.snapshot["config_hash"])

    def test_every_paired_trade_is_also_compared_in_size_net_fees_funding_and_hours(self):
        informe = self.comparar(self.crear_vivo(self.replay_directo()))
        o = informe["operaciones"]
        self.assertGreater(o["emparejadas"], 0)
        self.assertEqual(o["fuera_de_tolerancia"], [])
        self.assertEqual(o["importes"]["nocional_usd"], {"comparadas": o["emparejadas"], "fuera": 0, "dif_max": 0.0})
        cerradas = o["emparejadas"] - o["abiertas_en_vivo"]
        for campo in ("neto_usd", "comisiones_usd", "funding_usd", "horas"):
            self.assertEqual((o["importes"][campo]["comparadas"], o["importes"][campo]["fuera"]), (cerradas, 0), campo)
        par = next(p for p in o["pares"] if p["salida_igual"])
        self.assertAlmostEqual(par["importes"]["neto_usd"]["diferencia"], -1.5 / 1e4 * par["importes"]["nocional_usd"]["vivo"], places=6)
        self.assertEqual(o["tolerancias"], bt.TOLERANCIAS_IMPORTES)

    def test_the_replay_starts_with_the_balance_the_live_terminal_had_when_the_config_was_activated(self):
        informe = self.comparar(self.crear_vivo(self.replay_directo(capital="950"), saldo="950"))
        self.assertEqual(informe["vivo"]["saldo_inicial_usd"], 950.0)
        o = informe["operaciones"]
        self.assertGreater(o["emparejadas"], 0)
        self.assertEqual(o["importes"]["nocional_usd"]["fuera"], 0)
        self.assertEqual(o["fuera_de_tolerancia"], [])

    def test_a_live_trade_sized_differently_from_the_replay_is_listed_with_both_sizes(self):
        informe = self.comparar(self.crear_vivo(self.replay_directo(), tamano=0.5))
        o = informe["operaciones"]
        self.assertEqual(o["importes"]["nocional_usd"]["fuera"], o["emparejadas"])
        item = o["fuera_de_tolerancia"][0]
        self.assertEqual(item["campo"], "nocional_usd")
        self.assertAlmostEqual(item["replay"], 2 * item["vivo"], places=6)
        self.assertEqual(informe["decisiones"]["difieren"], 0)               # las decisiones son las mismas: lo que cambia es el tamaño

    def test_the_text_report_shows_the_size_and_amount_checks(self):
        informe = self.comparar(self.crear_vivo(self.replay_directo(), tamano=0.5))
        texto = bt.texto_vivo(informe)
        for pedazo in ("Tamaño e importes", "nocional_usd", "fuera de tolerancia", "tolerancia"):
            self.assertIn(pedazo, texto)

    def test_the_window_starts_when_the_live_config_started_and_decisions_before_it_are_not_compared(self):
        eventos = self.replay_directo()
        informe = self.comparar(self.crear_vivo(eventos))
        self.assertEqual(informe["ventana"]["desde_efectivo_ms"], -(-ACTIVADA_MS // qt.BAR_MS) * qt.BAR_MS)
        self.assertGreater(informe["ventana"]["desde_efectivo_ms"], informe["ventana"]["desde_ms"])
        self.assertEqual(informe["vivo"]["activada_ms"], ACTIVADA_MS)

    def test_a_changed_live_action_shows_up_as_exactly_one_difference(self):
        eventos = self.replay_directo()
        t = [e["t_ms"] for e in eventos if e["type"] == "decision"][40]
        informe = self.comparar(self.crear_vivo(eventos, cambiar={t: "LARGO"}))
        d = informe["decisiones"]
        self.assertEqual((d["difieren"], d["coinciden"] + 1), (1, d["vivas"]))
        self.assertEqual((d["diferencias"][0]["t_ms"], d["diferencias"][0]["vivo"]["action"]), (t, "LARGO"))

    def cierre_y_mirada_del_enfriamiento(self, eventos):
        """Un cierre del replay cuyo enfriamiento termina justo en una mirada con decisión (y ningún otro cierre lo cubre): ``(cierre, t)``."""
        cooldown = self.cfg["guardrails"]["cooldown_min"] * MIN
        miradas = {e["t_ms"] for e in eventos if e["type"] == "decision"}
        cierres = [e["trade"] for e in eventos if e["type"] == "trade" and e["trade"]["closed_by"] != "fin_examen"]
        for cierre in cierres:
            t = cierre["exit_ms"] + cooldown
            if t in miradas and not any(0 <= t - otro["exit_ms"] < cooldown and otro is not cierre
                                         and otro["exit_ms"] != cierre["exit_ms"] for otro in cierres):
                return cierre, t
        self.fail("los datos de prueba no tienen un cierre con una mirada justo al terminar su enfriamiento")

    def vivo_sin_la_mirada(self, eventos, t, **kw):
        ruta = self.crear_vivo(eventos, **kw)
        db = sqlite3.connect(ruta)
        db.execute("DELETE FROM decisions WHERE t_ms=?", (t,))                  # el vivo no la hizo y tampoco la omitió
        db.commit()
        db.close()
        return ruta

    def test_with_the_entry_dated_at_the_look_the_cooldown_counts_from_the_look_of_the_close_so_the_first_free_look_is_not_explained(self):
        eventos = self.replay_directo()
        cierre, t = self.cierre_y_mirada_del_enfriamiento(eventos)
        informe = self.comparar(self.vivo_sin_la_mirada(eventos, t, entrada_en_la_mirada=True))
        d = informe["decisiones"]
        fila = next(x for x in d["lista_solo_replay"] if x["t_ms"] == t)
        # El vivo cierra a las X:00:03 (llenado) pero cuenta los 15 min desde la mirada de las X:00:00: a la hora t ya estaba libre.
        self.assertIsNone(fila["explicacion"])
        self.assertEqual(d["solo_replay_sin_explicar"], 1)

    def test_with_the_entry_dated_at_the_fill_the_cooldown_still_counts_from_the_fill_of_the_close(self):
        eventos = self.replay_directo()
        cierre, t = self.cierre_y_mirada_del_enfriamiento(eventos)
        informe = self.comparar(self.vivo_sin_la_mirada(eventos, t))
        fila = next(x for x in informe["decisiones"]["lista_solo_replay"] if x["t_ms"] == t)
        self.assertIn("enfriamiento", fila["explicacion"])

    def test_a_look_the_live_skipped_is_a_replay_only_decision_explained_by_the_live_skip(self):
        eventos = self.replay_directo()
        t = [e["t_ms"] for e in eventos if e["type"] == "decision"][30]
        informe = self.comparar(self.crear_vivo(eventos, omitidos=(t,)))
        d = informe["decisiones"]
        self.assertEqual((d["solo_replay"], d["solo_vivo"], d["difieren"]), (1, 0, 0))
        self.assertEqual(d["lista_solo_replay"][0]["explicacion"], "el vivo omitió esa mirada: proceso_detenido")
        self.assertEqual(d["solo_replay_sin_explicar"], 0)

    def test_it_is_only_a_code_equivalence_check_nothing_is_registered_and_the_live_copy_is_untouched(self):
        eventos = self.replay_directo()
        ruta = self.crear_vivo(eventos)
        antes = {n: self.huella(os.path.join(self.carpeta, n)) for n in os.listdir(self.carpeta)}
        from balancita_engine import futures_walkforward as walkforward
        with mock.patch.object(walkforward, "register", side_effect=AssertionError("no se registran intentos")), \
                mock.patch.object(exam, "_honesty", side_effect=AssertionError("no hay medidor de honestidad")):
            informe = self.comparar(ruta)
        self.assertEqual(sorted(antes), sorted(os.listdir(self.carpeta)))               # ni -wal, ni -journal, ni archivos nuevos
        self.assertEqual(antes, {n: self.huella(os.path.join(self.carpeta, n)) for n in os.listdir(self.carpeta)})
        self.assertIn("equivalencia de código", informe["nota"])
        self.assertIn("no es una evaluación", informe["nota"])
        self.assertTrue(informe["ventana"]["reserva"]["incluida"])                       # el período vivo es posterior a la reserva
        self.assertIn("no sirve para elegir", informe["ventana"]["reserva"]["aviso"])

    def test_the_report_names_what_the_replay_cannot_reproduce(self):
        informe = self.comparar(self.crear_vivo(self.replay_directo()))
        limites = " ".join(informe["limites"])
        for palabra in ("libro", "noticias", "enfriamiento"):
            self.assertIn(palabra, limites)

    def test_missing_live_database_and_a_database_without_this_config_are_refused_clearly(self):
        with self.assertRaises(bt.ComparacionError) as error:
            self.comparar(os.path.join(self.carpeta, "no-existe.sqlite"))
        self.assertIn("no-existe.sqlite", str(error.exception))
        ruta = self.crear_vivo([])
        with self.assertRaises(bt.ComparacionError) as error:
            self.comparar(ruta)
        self.assertIn(self.snapshot["config_hash"][:12], str(error.exception))
        self.assertIn("decisiones", str(error.exception))

    def test_missing_candles_are_reported_as_a_precise_data_gap(self):
        ruta = self.crear_vivo(self.replay_directo())
        os.remove(os.path.join(self.carpeta, "qwen-live_cache__candles-PF_SOLUSD-{}.sqlite".format(SELLO)))
        with self.assertRaises(bt.ComparacionError) as error:
            self.comparar(ruta)
        self.assertIn("PF_SOLUSD", str(error.exception))
        self.assertIn("velas", str(error.exception))

    def test_candles_that_start_after_the_warm_up_are_flagged_in_the_coverage(self):
        ruta = self.crear_vivo(self.replay_directo())
        informe = self.comparar(ruta)
        cobertura = informe["datos"]["cobertura"]["PF_ETHUSD"]
        self.assertTrue(cobertura["completa"])
        self.assertEqual(cobertura["hasta_ms"], qt.date_ms(HASTA) - qt.BAR_MS)
        self.barras["PF_ETHUSD"] = [b for b in self.barras["PF_ETHUSD"] if b["bucket_start"] >= qt.date_ms(DESDE) + 6 * qt.HOUR_MS]
        os.remove(os.path.join(self.carpeta, "qwen-live_cache__candles-PF_ETHUSD-{}.sqlite".format(SELLO)))
        self.crear_velas(("PF_ETHUSD",))
        corto = self.comparar(ruta)
        self.assertFalse(corto["datos"]["cobertura"]["PF_ETHUSD"]["completa"])
        self.assertIn("velas", " ".join(corto["datos"]["avisos"]))


class CliVivoTests(VivoBase):
    def test_cli_vs_vivo_prints_the_report_and_needs_no_strategy(self):
        ruta = self.crear_vivo(self.replay_directo())
        salida = io.StringIO()
        with mock.patch.object(est, "cargar_snapshot", return_value=self.snapshot), contextlib.redirect_stdout(salida):
            codigo = bt.main(["--vs-vivo", "--live-db", ruta, "--desde", DESDE, "--hasta", HASTA])
        self.assertEqual(codigo, 0)
        texto = salida.getvalue()
        self.assertIn("Replay contra el vivo", texto)
        self.assertIn("equivalencia de código", texto)
        self.assertIn("Decisiones", texto)

    def test_cli_vs_vivo_json_is_the_report(self):
        ruta = self.crear_vivo(self.replay_directo())
        salida = io.StringIO()
        with mock.patch.object(est, "cargar_snapshot", return_value=self.snapshot), contextlib.redirect_stdout(salida):
            self.assertEqual(bt.main(["--vs-vivo", "--live-db", ruta, "--desde", DESDE, "--hasta", HASTA, "--json"]), 0)
        self.assertEqual(json.loads(salida.getvalue())["schema"], bt.SCHEMA_VIVO)

    def test_cli_vs_vivo_without_a_database_is_a_usage_error_and_a_data_error_exits_2(self):
        errores = io.StringIO()
        with contextlib.redirect_stderr(errores), self.assertRaises(SystemExit) as salio:
            bt.main(["--vs-vivo"])
        self.assertEqual(salio.exception.code, 2)
        self.assertIn("--live-db", errores.getvalue())
        errores = io.StringIO()
        with contextlib.redirect_stderr(errores):
            codigo = bt.main(["--vs-vivo", "--live-db", os.path.join(self.carpeta, "no-existe.sqlite")])
        self.assertEqual(codigo, 2)
        self.assertIn("Error:", errores.getvalue())

    def test_cli_without_vs_vivo_still_requires_a_strategy(self):
        errores = io.StringIO()
        with contextlib.redirect_stderr(errores), self.assertRaises(SystemExit) as salio:
            bt.main([])
        self.assertEqual(salio.exception.code, 2)
        self.assertIn("--estrategia", errores.getvalue())


if __name__ == "__main__":
    unittest.main()
