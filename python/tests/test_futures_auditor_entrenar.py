"""Auditor para entrenar más adelante (S8 de odd/tasks/noticias-y-auditor.md, T15): (1) los hechos del maestro por mirada, (2) todas las
propuestas de entrada, también las bloqueadas, con su resultado contrafactual calculado aparte (``resolve``) con las reglas oficiales,
(3) el estado de cada posición abierta en cada mirada, (4) la identidad del proponente, (5) el resultado real de cada operación y
(6) un registro solo-agregar de reentrenos. Todo SOLO agrega (tablas y columnas nuevas); un fallo del registro nuevo nunca cambia una
decisión ni una fila que el auditor ya escribía. Sin red, sin modelo."""
import contextlib
import copy
import io
import json
import os
import sqlite3
import tempfile
import time
import unittest
from decimal import Decimal
from unittest import mock

from balancita_engine import futures_auditor as aud
from balancita_engine import futures_costs
from balancita_engine import futures_qwen_corta as corta
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_maestro as maestro
from balancita_engine import futures_qwen_portero as portero
from balancita_engine import futures_qwen_trader as qt

from test_futures_auditor import (BAR, CFG, COST, HOUR, MIN, PRODUCT, STRONG, T0, WEAK, AuditorCase, event, formula, step_prices)
from test_futures_qwen_live import Policy, make

DAY = qt.DAY_MS
NEW_TABLES = ("hechos_mirada", "propuestas", "mirada_operaciones", "resultados_operacion", "reentrenos")


def facts(seed=0.1):
    """Los hechos aplanados del maestro (``flat_facts``): una clave por número, los 15 direccionales y los 5 tamaños."""
    keys = maestro.DIRECTIONAL + maestro.SYMMETRIC
    return {key: round(seed * (i + 1) * (1 if i % 2 else -1), 6) for i, key in enumerate(keys)}


def readings(veredicto=2, puntaje=None, portero_si=True, portero_p=0.8, hechos=None):
    """Lo que ``corta.readings`` da, con las fórmulas del repo aplicadas a los hechos cuando no se dice otra cosa."""
    hechos = hechos or facts()
    puntaje = ((STRONG + 0.1) * (1 if veredicto >= 0 else -1)) if puntaje is None else puntaje
    return {"hechos": hechos, "puntaje": puntaje, "flojo": WEAK, "veredicto": veredicto, "portero_p": portero_p, "portero_si": portero_si,
            "portero_direccion": None, "portero_autonomo": None, "noticias_si": False, "noticias": {"disponible": False, "n": 0},
            "vol_ratio": 1.0, "volatilidad": "NORMAL", "sigma24": 0.02, "range24": 0.03, "range7": 0.03}


class Pos:
    """Una posición abierta del trader de juguete."""

    def __init__(self, trade_no, side="LONG", entry_ms=T0 - 2 * HOUR, entry_px="100", entry_reason="formula"):
        self.trade_no, self.side, self.entry_ms, self.entry_px, self.entry_reason = trade_no, side, entry_ms, Decimal(entry_px), entry_reason
        self.notional_usd = Decimal("100")


class LookTrader:
    """Lo mínimo del trader que el registro nuevo lee: velas, posiciones, la nota de la mirada (``look_audit``) y el borde del episodio."""

    cfg = CFG
    product = PRODUCT
    positioning = None
    movement = None
    last_mark_execution = None

    def __init__(self, t_ms=T0, price=100.0):
        self.t, self.c, self.h, self.l, self.v = [t_ms - BAR], [price], [price], [price], [1.0]
        self.positions, self.prev_entry_side, self.cooldown_until, self.max_positions = [], 0, 0, 3
        self.look_audit = None

    @property
    def position(self):
        return self.positions[0] if self.positions else None

    def wake_reasons(self, t_ms):
        return ["cada_15_min"]


class TrainingCase(AuditorCase):
    def table(self, name, where="1=1", order="1"):
        con = sqlite3.connect(aud.auditor_path(self.path))
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute("SELECT * FROM {} WHERE {} ORDER BY {}".format(name, where, order))]
        finally:
            con.close()

    def record(self, look=None, *, t_ms=T0, events=(), marks=None, trader=None, warnings=False, **fields):
        """Una mirada anotada con el registro nuevo. ``look`` = la nota del trader (``look_audit``); ``readings`` por defecto."""
        trader = trader or LookTrader(t_ms)
        note = {"t_ms": t_ms, "readings": readings(**fields) if "veredicto" in fields or look is None else None}
        note.update(look or {})
        trader.look_audit = note
        out = aud.record_look(self.path, PRODUCT, trader, list(events), t_ms + MIN, marks)
        if not warnings:
            self.assertEqual(out["avisos"], [])                                              # lo normal no deja avisos
        return out

    def proposal(self, t_ms=T0):
        rows = self.table("propuestas", "t_ms={}".format(t_ms))
        return rows[0] if rows else None

    def series(self, from_ms, points, step=15 * MIN):
        """Una mirada cada 15 min desde ``from_ms`` con (veredicto, puntaje) de ``points`` (la lista da el valor de cada mirada)."""
        for k, (v, s) in enumerate(points):
            self.record(t_ms=from_ms + k * step, veredicto=v, puntaje=s, portero_si=False)       # sin señal de entrada: no es otra propuesta


STRONG_UP, WEAK_DOWN = STRONG + 0.1, -(WEAK + 0.1)


# --------------------------------------------------------------------------- G1 + G4


class MaestroFactsTests(TrainingCase):
    def test_each_look_keeps_the_maestros_flat_facts_and_what_the_keeper_needs_to_recompute_its_verdict(self):
        teacher, keeper = corta.formulas(CFG)
        hechos = facts()
        score = maestro.score(teacher, hechos)
        yes, p = portero.verdict(keeper, hechos, score)
        self.record(veredicto=maestro.verdict_of(teacher, score), puntaje=score, portero_si=yes, portero_p=p, hechos=hechos)
        row, = self.table("hechos_mirada")
        stored = json.loads(row["hechos_json"])
        self.assertEqual(stored, hechos)                                                  # todas las claves, no solo las del mercado
        self.assertTrue(set(maestro.DIRECTIONAL) <= set(stored))                          # los 15 hechos del maestro
        self.assertEqual((row["product"], row["t_ms"], row["bucket_ms"]), (PRODUCT, T0, T0 - aud.BUCKET_MS))
        self.assertAlmostEqual(row["puntaje"], score)
        self.assertEqual(row["veredicto"], maestro.verdict_of(teacher, score))
        gate = json.loads(row["portero_json"])
        self.assertEqual((gate["si"], gate["umbral"]), (yes, keeper["umbral"]))
        self.assertAlmostEqual(gate["p"], p)
        # con lo guardado se recalcula el veredicto del maestro y del portero sin la caché de velas
        again = maestro.score(teacher, stored)
        self.assertAlmostEqual(again, row["puntaje"])
        self.assertEqual(portero.verdict(keeper, stored, again), (gate["si"], gate["p"]))

    def test_the_autonomous_keeper_vote_is_kept_whole(self):
        vote = {"side": 1, "chosen": "LARGO", "support": {"LARGO": 0.6, "CORTO": 0.1, "ESPERAR": 0.3}, "model_sha256": "ab" * 32,
                "fit_until_ms": 1_700_000_000_000}
        base = readings()
        self.record(look={"readings": dict(base, portero_autonomo=vote, portero_direccion=1, portero_p=0.6)})
        gate = json.loads(self.table("hechos_mirada")[0]["portero_json"])
        self.assertEqual(gate["autonomo"], vote)
        self.assertEqual(gate["direccion"], 1)
        self.assertEqual(self.table("hechos_mirada")[0]["portero_hash"], "ab" * 8)       # el hash del modelo autónomo (16 caracteres)

    def test_the_identity_of_the_proposer_is_kept_apart_from_the_auditors_own_version(self):
        with self.store.db:
            self.store.db.execute("INSERT INTO config_versions(previous_hash,config_hash,activated_ms,config_json,cash_usd) VALUES(?,?,?,?,?)",
                                  (None, qt.config_hash(CFG), T0 - HOUR, "{}", "1000"))
        self.record(veredicto=2)
        row, = self.table("hechos_mirada")
        teacher, keeper = corta.formulas(CFG)
        self.assertEqual(row["maestro_hash"], maestro.teacher_hash(teacher)[:16])
        self.assertEqual(row["portero_hash"], portero.portero_hash(keeper)[:16])
        self.assertEqual(row["config_hash"], qt.config_hash(CFG))
        self.assertEqual(row["config_version"], 1)
        self.assertEqual(row["costos_id"], futures_costs.COST_MODEL_VERSION)
        self.assertEqual(row["version"], aud.VERSION)                                      # la versión del auditor sigue siendo la suya
        self.assertNotIn(row["version"], (row["maestro_hash"], row["config_hash"], row["costos_id"]))

    def test_without_a_config_version_in_the_live_database_the_id_is_null_and_the_look_is_still_kept(self):
        self.record(veredicto=2)
        self.assertIsNone(self.table("hechos_mirada")[0]["config_version"])

    def test_the_same_look_twice_is_ignored(self):
        self.record(veredicto=2)
        self.record(veredicto=-2)
        self.assertEqual(len(self.table("hechos_mirada")), 1)
        self.assertEqual(self.table("hechos_mirada")[0]["veredicto"], 2)

    def test_a_trader_without_a_note_for_this_look_records_nothing(self):
        trader = LookTrader()
        trader.look_audit = {"t_ms": T0 - 15 * MIN, "readings": readings()}               # la nota es de la mirada anterior
        out = aud.record_look(self.path, PRODUCT, trader, [], T0 + MIN)
        self.assertEqual(out["hechos"], False)
        self.assertFalse(os.path.exists(aud.auditor_path(self.path)) and self.table("hechos_mirada"))
        trader.look_audit = None
        self.assertEqual(aud.record_look(self.path, PRODUCT, trader, [], T0 + MIN)["hechos"], False)


# --------------------------------------------------------------------------- G2


class ProposalTests(TrainingCase):
    def test_a_strong_maestro_agreed_by_the_keeper_that_opens_is_an_open_proposal(self):
        decision = event(T0, action="LARGO", trade_no=5)
        self.record(veredicto=2, events=[decision], look={"prev_entry_side": 0, "blocked": None, "closed_here": False})
        row = self.proposal()
        self.assertEqual((row["lado"], row["estado"], row["trade_no"], row["inicio_episodio"]), (1, "abierta", 5, 1))
        self.assertIsNone(row["motivo_bloqueo"])
        self.assertAlmostEqual(row["puntaje"], STRONG_UP)
        self.assertEqual((row["maestro"], row["precio"], row["version"]), (2, 100.0, aud.VERSION))

    def test_every_block_reason_is_kept_with_its_own_name(self):
        cases = (("lugares_ocupados", {"blocked": "lugares_ocupados"}, "lugares_ocupados", None),
                 ("mismo_episodio", {"blocked": "mismo_episodio", "prev_entry_side": 1}, "mismo_episodio", None),
                 ("cierre en la mirada", {"closed_here": True}, "cierre_en_la_mirada", None),
                 ("cierre (regla de la entrada)", {"blocked": "cierre_en_la_mirada"}, "cierre_en_la_mirada", None),
                 ("enfriamiento", {"skip": "cooldown", "readings": None}, "enfriamiento", None),
                 ("otro", {"blocked": "saldo_insuficiente"}, "otro", "saldo_insuficiente"),
                 ("lado contrario", {"blocked": "lado_contrario"}, "otro", "lado_contrario"))
        for k, (name, look, motive, detail) in enumerate(cases):
            with self.subTest(name):
                t_ms = T0 + k * 15 * MIN
                trader = LookTrader(t_ms)
                note = dict({"t_ms": t_ms, "readings": readings(2), "prev_entry_side": 0, "blocked": None, "closed_here": False}, **look)
                trader.look_audit = note
                if note["readings"] is None:                                              # el trader no calculó nada: lo calcula el auditor
                    with mock.patch.object(corta, "readings", return_value=readings(2)):
                        aud.record_look(self.path, PRODUCT, trader, [], t_ms + MIN)
                else:
                    aud.record_look(self.path, PRODUCT, trader, [], t_ms + MIN)
                row = self.proposal(t_ms)
                self.assertEqual((row["estado"], row["motivo_bloqueo"], row["detalle_bloqueo"], row["trade_no"]), ("bloqueada", motive, detail, None))
        self.assertEqual(len(self.table("propuestas")), len(cases))

    def test_a_look_without_an_entry_signal_leaves_no_proposal(self):
        for k, (name, fields) in enumerate((("maestro flojo", {"veredicto": 1}), ("nada claro", {"veredicto": 0}),
                                            ("el portero no coincide", {"veredicto": 2, "portero_si": False}))):
            with self.subTest(name):
                self.record(t_ms=T0 + k * 15 * MIN, look={"prev_entry_side": 0, "blocked": None, "closed_here": False}, **fields)
        self.assertEqual(self.table("propuestas"), [])
        self.assertEqual(len(self.table("hechos_mirada")), 3)                              # los hechos sí quedan

    def test_the_episode_start_is_the_edge_of_the_signal_and_the_short_side_is_minus_one(self):
        self.record(t_ms=T0, veredicto=-2, look={"prev_entry_side": 0})
        self.record(t_ms=T0 + 15 * MIN, veredicto=-2, look={"prev_entry_side": -1, "blocked": "mismo_episodio"})
        self.record(t_ms=T0 + 30 * MIN, veredicto=-2, look={"prev_entry_side": 1, "blocked": "lugares_ocupados"})
        rows = self.table("propuestas", order="t_ms")
        self.assertEqual([(r["lado"], r["inicio_episodio"]) for r in rows], [(-1, 1), (-1, 0), (-1, 1)])

    def test_a_cooldown_look_is_kept_only_when_the_trader_would_have_woken_up(self):
        trader = LookTrader()
        trader.look_audit = {"t_ms": T0, "readings": None, "skip": "cooldown"}
        with mock.patch.object(corta, "readings", return_value=readings(2)), \
                mock.patch.object(LookTrader, "wake_reasons", return_value=[]):
            self.assertEqual(aud.record_look(self.path, PRODUCT, trader, [], T0 + MIN)["propuesta"], None)
        self.assertFalse(os.path.exists(aud.auditor_path(self.path)) and self.table("propuestas"))

    def test_the_proposal_has_no_label_when_it_is_recorded_only_resolve_gives_it(self):
        self.record(veredicto=2, look={"prev_entry_side": 0})
        row = self.proposal()
        self.assertEqual((row["contrafactual_json"], row["neto_pb"], row["motivo_salida"], row["horas"], row["resuelto_ms"]),
                         (None, None, None, None, None))


class CounterfactualTests(TrainingCase):
    PRICES = [(0, 100.0), (2 * HOUR, 101.0), (30 * HOUR, 99.0)]

    def propose(self, veredicto=2, block=None):
        look = {"prev_entry_side": 0, "blocked": block}
        self.record(veredicto=veredicto, look=look)

    def test_a_proposal_exits_where_the_official_rule_says_with_the_net_after_costs(self):
        self.propose()
        self.series(T0 + 15 * MIN, [(2, STRONG_UP)] * 11 + [(-1, WEAK_DOWN)])             # a las 3 h el maestro se da vuelta
        result = self.resolve(step_prices(self.PRICES), T0 + 4 * HOUR)
        self.assertEqual(result["propuestas"], 1)
        row = self.proposal()
        self.assertEqual(row["motivo_salida"], "maestro_vuelta")
        self.assertAlmostEqual(row["horas"], 3.0)
        self.assertAlmostEqual(row["neto_pb"], 100.0 - COST)
        self.assertEqual(row["salida_ms"], T0 + 3 * HOUR)
        self.assertEqual(row["resuelto_ms"], T0 + 4 * HOUR)
        label = json.loads(row["contrafactual_json"])
        self.assertEqual((label["entrada_px"], label["salida_px"], label["costo_pb"]), (100.0, 101.0, COST))

    def test_the_label_uses_the_real_exit_rule_not_a_copy(self):
        self.propose()
        self.series(T0 + 15 * MIN, [(2, STRONG_UP)] * 4 + [(-1, WEAK_DOWN)])
        self.assertIs(aud._official_action, corta.formula_action)                            # la función oficial, no una copia
        calls = []

        def spy(r, side, **kwargs):
            calls.append((side, kwargs["held_min"], kwargs["exhaust_min"]))
            return corta.formula_action(r, side, **kwargs)

        with mock.patch.object(aud, "_official_action", spy):
            self.resolve(step_prices(self.PRICES), T0 + 4 * HOUR)
        self.assertEqual(calls, [(1, 15, 1440), (1, 30, 1440), (1, 45, 1440), (1, 60, 1440), (1, 75, 1440)])   # sus argumentos: lado, horas y agotamiento de la config
        self.assertEqual(self.proposal()["motivo_salida"], "maestro_vuelta")
        self.assertAlmostEqual(self.proposal()["horas"], 1.25)

    def test_a_blocked_proposal_gets_the_same_label_as_an_open_one(self):
        self.propose(block="lugares_ocupados")
        self.series(T0 + 15 * MIN, [(2, STRONG_UP)] * 11 + [(-1, WEAK_DOWN)])
        self.resolve(step_prices(self.PRICES), T0 + 4 * HOUR)
        row = self.proposal()
        self.assertEqual((row["estado"], row["motivo_bloqueo"]), ("bloqueada", "lugares_ocupados"))
        self.assertAlmostEqual(row["neto_pb"], 100.0 - COST)

    def test_a_short_proposal_profits_when_the_price_falls(self):
        self.propose(veredicto=-2)
        self.series(T0 + 15 * MIN, [(-2, -STRONG_UP)] * 11 + [(1, WEAK + 0.1)])
        self.resolve(step_prices([(0, 100.0), (2 * HOUR, 99.0)]), T0 + 4 * HOUR)
        row = self.proposal()
        self.assertEqual(row["motivo_salida"], "maestro_vuelta")
        self.assertAlmostEqual(row["neto_pb"], 100.0 - COST)

    def test_the_exhaustion_rule_closes_after_24_hours_when_the_maestro_lost_its_strength(self):
        self.propose()
        self.series(T0 + 15 * MIN, [(2, STRONG_UP)] * 95 + [(0, 0.0)])                      # a las 24 h el puntaje deja de estar a favor
        self.resolve(step_prices(self.PRICES), T0 + 26 * HOUR)
        row = self.proposal()
        self.assertEqual(row["motivo_salida"], "maestro_agotado")
        self.assertAlmostEqual(row["horas"], 24.0)

    def test_the_time_limit_closes_it_when_the_maestro_never_turns(self):
        self.propose()
        self.series(T0 + 15 * MIN, [(2, STRONG_UP)] * (36 * 4))
        self.resolve(step_prices(self.PRICES, end=T0 + 40 * HOUR), T0 + 37 * HOUR)
        row = self.proposal()
        self.assertEqual(row["motivo_salida"], "tiempo")
        self.assertAlmostEqual(row["horas"], 36.0)
        self.assertAlmostEqual(row["neto_pb"], -100.0 - COST)                               # a las 36 h el precio estaba en 99

    def test_a_proposal_whose_exit_has_not_happened_yet_stays_open_to_resolve(self):
        self.propose()
        self.series(T0 + 15 * MIN, [(2, STRONG_UP)] * 8)
        self.assertEqual(self.resolve(step_prices(self.PRICES), T0 + 3 * HOUR)["propuestas"], 0)
        row = self.proposal()
        self.assertEqual((row["contrafactual_json"], row["neto_pb"], row["resuelto_ms"]), (None, None, None))

    def test_no_future_is_used_a_flip_after_now_does_not_exit_the_proposal(self):
        self.propose()
        self.series(T0 + 15 * MIN, [(2, STRONG_UP)] * 8 + [(-1, WEAK_DOWN)])               # el giro está a las 2 h 15
        self.assertEqual(self.resolve(step_prices(self.PRICES), T0 + 2 * HOUR)["propuestas"], 0)
        self.assertEqual(self.resolve(step_prices(self.PRICES), T0 + 3 * HOUR)["propuestas"], 1)

    def test_a_resolved_label_is_not_touched_again(self):
        self.propose()
        self.series(T0 + 15 * MIN, [(2, STRONG_UP)] * 11 + [(-1, WEAK_DOWN)])
        self.resolve(step_prices(self.PRICES), T0 + 4 * HOUR)
        before = self.proposal()
        self.assertEqual(self.resolve(step_prices(self.PRICES), T0 + 90 * HOUR)["propuestas"], 0)
        self.assertEqual(self.proposal(), before)

    def test_a_proposal_that_can_never_be_priced_is_closed_as_without_data_so_a_day_can_be_archived(self):
        self.propose()
        self.assertEqual(self.resolve({}, T0 + 10 * HOUR)["propuestas"], 0)
        self.assertIsNone(self.proposal()["resuelto_ms"])
        self.assertEqual(self.resolve({}, T0 + 60 * HOUR)["propuestas"], 1)
        row = self.proposal()
        self.assertEqual(json.loads(row["contrafactual_json"]), {"estado": "sin_datos"})
        self.assertEqual((row["neto_pb"], row["resuelto_ms"]), (None, T0 + 60 * HOUR))


# --------------------------------------------------------------------------- G3


class PositionStateTests(TrainingCase):
    def test_every_open_position_gets_a_row_in_every_look_with_what_the_exit_rule_says(self):
        long_, short = Pos(7, "LONG", T0 - 3 * HOUR, "100"), Pos(8, "SHORT", T0 - HOUR, "100")
        trader = LookTrader()
        trader.positions = [long_, short]
        marks = {7: {"net_bp": 42.5}, 8: {"net_bp": -12.0}}
        self.record(trader=trader, marks=marks, veredicto=2, look={"open_ids": [7, 8], "exits": {8: "el maestro se dio vuelta en contra"},
                                                                    "blocked": "lugares_ocupados", "prev_entry_side": 1})
        rows = self.table("mirada_operaciones", order="trade_no")
        self.assertEqual([(r["trade_no"], r["lado"], r["evento"]) for r in rows], [(7, 1, "mantiene"), (8, -1, "mantiene")])
        long_row, short_row = rows
        self.assertAlmostEqual(long_row["horas"], 3.0)
        self.assertAlmostEqual(long_row["neto_ahora_pb"], 42.5)
        self.assertAlmostEqual(long_row["puntaje"], STRONG_UP)
        self.assertAlmostEqual(long_row["puntaje_lado"], STRONG_UP)                         # puntaje del maestro contra el lado
        self.assertEqual((long_row["maestro"], long_row["maestro_lado"], long_row["salida_dice"]), (2, 2, "MANTENER"))
        self.assertAlmostEqual(short_row["puntaje_lado"], -STRONG_UP)
        self.assertEqual((short_row["maestro_lado"], short_row["salida_dice"]), (-2, "CERRAR"))
        self.assertEqual(short_row["salida_motivo"], "el maestro se dio vuelta en contra")
        self.assertIsNone(long_row["salida_motivo"])
        self.assertEqual((long_row["bucket_ms"], long_row["t_ms"], long_row["entry_ms"]), (T0 - aud.BUCKET_MS, T0, T0 - 3 * HOUR))

    def test_a_position_closed_in_this_look_and_one_opened_in_it_are_kept_too(self):
        opened = Pos(9, "LONG", T0, "100")
        trader = LookTrader()
        trader.positions = [opened]
        closed = {"type": "trade", "trade": {"trade_no": 4, "side": "SHORT", "entry_ms": T0 - 5 * HOUR, "entry_px": 100.0, "net_bp": -33.0,
                                             "entry_reason": "formula"}}
        decision = event(T0, action="LARGO", trade_no=9)
        self.record(trader=trader, events=[decision, closed], marks={9: {"net_bp": -1.0}}, veredicto=2,
                    look={"open_ids": [4], "exits": {4: "x"}})
        rows = {r["trade_no"]: r for r in self.table("mirada_operaciones")}
        self.assertEqual((rows[4]["evento"], rows[4]["neto_ahora_pb"], rows[4]["salida_dice"]), ("cierra", -33.0, "CERRAR"))
        self.assertEqual((rows[9]["evento"], rows[9]["salida_dice"], rows[9]["horas"]), ("abre", None, 0.0))

    def test_without_a_mark_the_net_now_is_null_not_invented(self):
        trader = LookTrader()
        trader.positions = [Pos(7)]
        self.record(trader=trader, veredicto=2, look={"open_ids": [7], "exits": {}})
        self.assertIsNone(self.table("mirada_operaciones")[0]["neto_ahora_pb"])

    def test_the_same_look_twice_does_not_duplicate_the_rows(self):
        trader = LookTrader()
        trader.positions = [Pos(7)]
        for _ in range(2):
            self.record(trader=trader, veredicto=2, look={"open_ids": [7], "exits": {}})
        self.assertEqual(len(self.table("mirada_operaciones")), 1)


# --------------------------------------------------------------------------- G5


class TradeResultTests(TrainingCase):
    def closed_trade(self, number=1, side="LONG", **extra):
        fields = dict(status="closed", side=side, entry_ms=T0, exit_ms=T0 + 2 * HOUR, entry_px="100", exit_px="101", net_bp=80.0,
                      closed_by="formula", exit_reason="maestro_vuelta", entry_reason="formula", funding_status="complete",
                      net_usd="0.8", notional_usd="100")
        fields.update(extra)
        self.put_trade(number, **fields)

    @staticmethod
    def ranges(spike_high=103.0, spike_low=99.0):
        closes = step_prices([(0, 100.0), (2 * HOUR, 101.0)])
        out = {t: (c + 0.2, c - 0.2) for t, c in closes.items()}
        out[T0 + HOUR] = (spike_high, spike_low)
        return out

    def results(self):
        return {r["trade_no"]: r for r in self.table("resultados_operacion")}

    def operations(self):
        return {r["trade_no"]: r for r in self.table("operaciones")}

    def resolve_with(self, closes, now_ms, ranges=None):
        if ranges is False:
            return aud.resolve(self.path, PRODUCT, closes, CFG, now_ms, COST)
        return aud.resolve(self.path, PRODUCT, closes, CFG, now_ms, COST, ranges=self.ranges() if ranges is None else ranges)

    def test_the_real_result_exit_reason_prices_and_high_low_excursions_are_kept_per_trade(self):
        self.closed_trade()
        result = self.resolve_with(step_prices([(0, 100.0), (2 * HOUR, 101.0)]), T0 + 30 * HOUR)
        self.assertEqual(result["resultados"], 1)
        row = self.results()[1]
        self.assertEqual((row["lado"], row["entry_ms"], row["exit_ms"]), (1, T0, T0 + 2 * HOUR))
        self.assertAlmostEqual(row["neto_pb"], 80.0)
        self.assertAlmostEqual(row["neto_usd"], 0.8)
        self.assertAlmostEqual(row["notional_usd"], 100.0)
        self.assertEqual((row["motivo_entrada"], row["motivo_cierre"], row["motivo_salida"]), ("formula", "formula", "maestro_vuelta"))
        self.assertEqual((row["entry_px"], row["exit_px"]), (100.0, 101.0))
        self.assertAlmostEqual(row["mfe_hl_pb"], (103.0 / 100.0 - 1) * 1e4)                  # el máximo de las velas, no el cierre
        self.assertAlmostEqual(row["mae_hl_pb"], (99.0 / 100.0 - 1) * 1e4)
        self.assertEqual(row["hl_hasta_ms"], T0 + 2 * HOUR)
        self.assertEqual((row["resultado_ms"], row["version"]), (T0 + 30 * HOUR, aud.VERSION))

    def test_a_short_trade_takes_the_lows_as_its_best_and_the_highs_as_its_worst(self):
        self.closed_trade(1, "SHORT", exit_px="99")
        self.resolve_with(step_prices([(0, 100.0), (2 * HOUR, 99.0)]), T0 + 30 * HOUR, ranges=self.ranges(spike_high=103.0, spike_low=98.0))
        row = self.results()[1]
        self.assertAlmostEqual(row["mfe_hl_pb"], (1 - 98.0 / 100.0) * 1e4)
        self.assertAlmostEqual(row["mae_hl_pb"], (1 - 103.0 / 100.0) * 1e4)

    def test_the_operations_table_and_its_close_based_columns_do_not_change(self):
        self.closed_trade()
        closes = step_prices([(0, 100.0), (2 * HOUR, 101.0)])
        self.resolve_with(closes, T0 + 30 * HOUR, ranges=False)
        before = self.operations()
        self.assertEqual(self.results()[1]["resultado_ms"], None)                            # sin velas con extremos: el resultado sigue abierto
        self.resolve_with(closes, T0 + 31 * HOUR)
        self.assertEqual(self.operations(), before)                                          # mismas filas, mismas columnas
        self.assertGreaterEqual(self.results()[1]["mfe_hl_pb"], before[1]["mfe_pb"])
        self.assertLessEqual(self.results()[1]["mae_hl_pb"], before[1]["mae_pb"])

    def test_without_candle_ranges_the_receipts_are_kept_and_the_result_stays_open(self):
        self.closed_trade()
        self.resolve_with(step_prices([(0, 100.0)]), T0 + 30 * HOUR, ranges=False)
        row = self.results()[1]
        self.assertAlmostEqual(row["neto_pb"], 80.0)
        self.assertIsNone(row["mfe_hl_pb"])
        self.assertIsNone(row["resultado_ms"])

    def test_an_open_trade_has_no_result_and_a_trade_with_incomplete_funding_is_not_final(self):
        self.put_trade(1, status="open", side="LONG", entry_ms=T0, entry_px="100", entry_reason="formula")
        self.closed_trade(2, funding_status="partial")
        self.resolve_with(step_prices([(0, 100.0)]), T0 + 30 * HOUR)
        rows = self.results()
        self.assertNotIn(1, rows)
        self.assertAlmostEqual(rows[2]["neto_pb"], 80.0)
        self.assertIsNone(rows[2]["resultado_ms"])                                          # el funding todavía puede cambiar el neto
        with self.store.db:
            self.store.db.execute("UPDATE trades SET funding_status='complete', net_bp=75.0 WHERE trade_no=2")
        self.resolve_with(step_prices([(0, 100.0)]), T0 + 31 * HOUR)
        self.assertAlmostEqual(self.results()[2]["neto_pb"], 75.0)
        self.assertEqual(self.results()[2]["resultado_ms"], T0 + 31 * HOUR)

    def test_a_trade_closed_after_now_is_not_known_yet(self):
        self.closed_trade()
        self.assertEqual(self.resolve_with(step_prices([(0, 100.0)]), T0 + HOUR)["resultados"], 0)
        self.assertEqual(self.results(), {})

    def test_a_final_result_is_not_rewritten(self):
        self.closed_trade()
        closes = step_prices([(0, 100.0), (2 * HOUR, 101.0)])
        self.resolve_with(closes, T0 + 30 * HOUR)
        before = self.results()
        self.assertEqual(self.resolve_with(closes, T0 + 60 * HOUR)["resultados"], 0)
        self.assertEqual(self.results(), before)

    def test_old_trades_get_their_result_from_data_the_auditor_already_reads(self):
        self.closed_trade()                                                                  # una operación de antes de este cambio: la tabla no existía
        closes = step_prices([(0, 100.0), (2 * HOUR, 101.0)])
        self.resolve_with(closes, T0 + 30 * HOUR, ranges=False)
        self.sql("DROP TABLE resultados_operacion")
        old = self.operations()
        aud.summary(self.path)                                                               # la base se vuelve a abrir con el código nuevo
        self.resolve_with(closes, T0 + 40 * HOUR)
        self.assertAlmostEqual(self.results()[1]["neto_pb"], 80.0)
        self.assertIsNotNone(self.results()[1]["resultado_ms"])
        self.assertEqual(self.operations(), old)


# --------------------------------------------------------------------------- G8


class RetrainRegistryTests(TrainingCase):
    SPEC = {"modelo": "logistica", "variables": ["margen", "lado"], "c": 0.1, "descarta": 0.3}
    METRICS = {"auc": 0.538, "n": 1700}

    def register(self, **over):
        args = dict(corte_ms=T0, dataset_hash="ab" * 32, spec=self.SPEC, metricas=self.METRICS, creado_ms=T0 + DAY)
        args.update(over)
        return aud.registrar_reentreno(self.path, **args)

    def test_a_retrain_is_registered_with_its_cut_dataset_spec_and_out_of_sample_metrics(self):
        first, second = self.register(), self.register(corte_ms=T0 + DAY, dataset_hash="cd" * 32)
        self.assertEqual((first, second), (1, 2))
        row = self.table("reentrenos")[0]
        self.assertEqual((row["corte_ms"], row["dataset_hash"], row["creado_ms"]), (T0, "ab" * 32, T0 + DAY))
        self.assertEqual(json.loads(row["spec_json"]), self.SPEC)
        self.assertEqual(json.loads(row["metricas_fuera_de_muestra_json"]), self.METRICS)

    def test_the_registry_is_append_only(self):
        self.register()
        con = sqlite3.connect(aud.auditor_path(self.path))
        self.addCleanup(con.close)
        for statement in ("UPDATE reentrenos SET dataset_hash='x'", "DELETE FROM reentrenos"):
            with self.subTest(statement), self.assertRaises(sqlite3.DatabaseError):
                con.execute(statement)
        con.rollback()
        self.assertEqual(len(self.table("reentrenos")), 1)

    def test_a_retrain_without_its_evidence_is_refused_and_leaves_nothing(self):
        for name, over in (("sin hash", {"dataset_hash": ""}), ("corte inválido", {"corte_ms": 0}), ("sin spec", {"spec": {}}),
                           ("spec no es un dict", {"spec": "x"}), ("sin métricas", {"metricas": None}),
                           ("métrica no finita", {"metricas": {"auc": float("nan")}})):
            with self.subTest(name), self.assertRaises(ValueError):
                self.register(**over)
        self.assertFalse(os.path.exists(aud.auditor_path(self.path)))                       # ni siquiera se abrió la base

    def test_the_command_line_registers_a_retrain_from_a_json_file(self):
        body = {"corte_ms": T0, "dataset_hash": "ef" * 32, "spec": self.SPEC, "metricas": self.METRICS, "creado_ms": T0 + 5}
        file = os.path.join(self.tmp, "reentreno.json")
        with open(file, "w", encoding="utf-8") as handle:
            json.dump(body, handle)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(aud.main(["--db", self.path, "--registrar-reentreno", file]), 0)
        row = self.table("reentrenos")[0]
        self.assertEqual((row["corte_ms"], row["dataset_hash"], row["creado_ms"]), (T0, "ef" * 32, T0 + 5))


# --------------------------------------------------------------------------- migration


OLD_DDL = """
CREATE TABLE miradas(
  product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, estado TEXT NOT NULL, accion TEXT NOT NULL,
  maestro INTEGER, puntaje REAL, umbral_flojo REAL, umbral_fuerte REAL, portero_si INTEGER, portero_p REAL, portero_umbral REAL,
  noticias_si INTEGER, noticias_lado INTEGER, qwen TEXT, qwen_coincide INTEGER, lado_posicion INTEGER NOT NULL DEFAULT 0,
  horas_en_posicion REAL, neto_ahora_pb REAL, trade_no INTEGER, condiciones_json TEXT NOT NULL, despues_json TEXT,
  veredicto_12h_json TEXT, veredicto_24h_json TEXT, veredicto_36h_json TEXT, resuelto_ms INTEGER, version TEXT NOT NULL,
  direccion_json TEXT, direccion_ms INTEGER, PRIMARY KEY(product, bucket_ms));
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE operaciones(
  product TEXT NOT NULL, trade_no INTEGER NOT NULL, lado INTEGER NOT NULL, entry_ms INTEGER NOT NULL, exit_ms INTEGER,
  direccion_json TEXT, mfe_pb REAL, mae_pb REAL, hasta_ms INTEGER, resuelto_ms INTEGER, version TEXT NOT NULL,
  PRIMARY KEY(product, trade_no));
"""


class MigrationTests(TrainingCase):
    def schema(self, con):
        out = {}
        for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            out[name] = [tuple(r[1:3]) for r in con.execute("PRAGMA table_info({})".format(name))]
        return out

    def old_database(self):
        path = aud.auditor_path(self.path)
        con = sqlite3.connect(path)
        con.executescript(OLD_DDL)
        con.execute("INSERT INTO meta VALUES('schema','balancita-auditor.v1')")
        con.execute("INSERT INTO meta VALUES('direccion','v1')")
        con.execute("INSERT INTO miradas(product,bucket_ms,t_ms,estado,accion,maestro,puntaje,lado_posicion,condiciones_json,version,"
                    "resuelto_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (PRODUCT, T0 - 900_000, T0, "plana", "NO_ENTRAR_maestro", 1, 0.2, 0, "{}", "auditor.v1", T0 + 99))
        con.execute("INSERT INTO operaciones VALUES(?,?,?,?,?,?,?,?,?,?,?)", (PRODUCT, 3, 1, T0, T0 + HOUR, "{}", 10.0, -5.0, T0 + HOUR, T0 + 2 * HOUR, "auditor.v1"))
        con.commit()
        return con

    def test_an_old_database_gets_only_new_tables_and_keeps_every_old_row(self):
        con = self.old_database()
        self.addCleanup(con.close)
        old_schema = self.schema(con)
        old_rows = {t: con.execute("SELECT * FROM {}".format(t)).fetchall() for t in ("miradas", "operaciones", "meta")}
        aud.summary(self.path)                                                               # abre con el código nuevo
        aud.resolve(self.path, PRODUCT, {}, CFG, T0 + HOUR, COST)
        new_schema = self.schema(con)
        for name, columns in old_schema.items():
            self.assertEqual(new_schema[name][:len(columns)], columns, name)                # las columnas viejas, iguales y en su sitio
        self.assertTrue(set(NEW_TABLES) <= set(new_schema))
        self.assertEqual(new_schema["operaciones"], old_schema["operaciones"])                # las tablas viejas no ganan ninguna columna
        self.assertEqual(new_schema["miradas"], old_schema["miradas"])
        for table in ("miradas", "operaciones"):
            now = [tuple(r)[:len(old_schema[table])] for r in con.execute("SELECT * FROM {}".format(table))]
            self.assertEqual(now, [tuple(r) for r in old_rows[table]], table)
        self.assertEqual(con.execute("SELECT * FROM meta ORDER BY key").fetchall(), sorted(old_rows["meta"]))     # ``meta`` no cambia

    def test_the_migration_is_reversible_drop_the_new_tables_and_the_old_schema_is_back(self):
        con = self.old_database()
        self.addCleanup(con.close)
        old_schema = self.schema(con)
        old_rows = con.execute("SELECT * FROM miradas").fetchall(), con.execute("SELECT * FROM operaciones").fetchall()
        aud.summary(self.path)
        self.assertNotEqual(self.schema(con), old_schema)
        for table in NEW_TABLES:
            con.execute("DROP TABLE {}".format(table))
        con.commit()
        self.assertEqual(self.schema(con), old_schema)
        self.assertEqual((con.execute("SELECT * FROM miradas").fetchall(), con.execute("SELECT * FROM operaciones").fetchall()), old_rows)

    def test_a_database_that_was_already_migrated_opens_again_without_errors(self):
        aud.summary(self.path)
        self.snap(event())
        self.snap(event())                                                                  # abre dos veces: nada que sumar
        con = sqlite3.connect(aud.auditor_path(self.path))
        self.addCleanup(con.close)
        self.assertTrue(set(NEW_TABLES) <= set(self.schema(con)))


# --------------------------------------------------------------------------- safety


class SafetyTests(TrainingCase):
    def test_a_failing_proposal_recorder_is_reported_and_the_facts_of_the_look_are_still_kept(self):
        with mock.patch.object(aud, "_record_proposal", side_effect=RuntimeError("roto")):
            out = self.record(veredicto=2, look={"prev_entry_side": 0}, warnings=True)
        self.assertEqual(out["hechos"], True)
        self.assertEqual(out["propuesta"], None)
        self.assertEqual(len(out["avisos"]), 1)
        self.assertIn("RuntimeError", out["avisos"][0])
        self.assertEqual(len(self.table("hechos_mirada")), 1)
        self.assertEqual(self.table("propuestas"), [])

    def test_a_failing_recorder_never_raises_whatever_it_is(self):
        for name in ("_record_facts", "_record_proposal", "_record_positions"):
            with self.subTest(name), mock.patch.object(aud, name, side_effect=ValueError(name)):
                out = self.record(veredicto=2, look={"prev_entry_side": 0}, t_ms=T0 + len(name) * MIN, warnings=True)
                self.assertTrue(any(name in a or "ValueError" in a for a in out["avisos"]))

    def test_a_failing_new_step_of_resolve_leaves_the_old_results_and_rows_identical(self):
        self.snap(event(T0, fml=formula(2, portero_si=False)))
        self.put_scores(STRONG_UP, 40, flip_at_h=3, flip_score=WEAK_DOWN)
        closes = step_prices([(0, 100.0), (3 * HOUR, 101.0), (20 * HOUR, 99.0)])
        clean = self.resolve(closes, T0 + 40 * HOUR)
        rows = self.audit_rows(), self.table("operaciones")
        self.sql("UPDATE miradas SET resuelto_ms=NULL, veredicto_12h_json=NULL, veredicto_24h_json=NULL, veredicto_36h_json=NULL, "
                 "despues_json=NULL")
        with mock.patch.object(aud, "_resolve_proposals", side_effect=RuntimeError("roto")), \
                mock.patch.object(aud, "_resolve_trade_results", side_effect=OSError("disco")):
            broken = self.resolve(closes, T0 + 40 * HOUR)
        same = ("miradas", "actualizadas", "veredictos", "pendientes", "operaciones")
        self.assertEqual({k: broken[k] for k in same}, {k: clean[k] for k in same})
        self.assertEqual(self.audit_rows(), rows[0])
        self.assertEqual(self.table("operaciones"), rows[1])
        self.assertEqual(len(broken["avisos"]), 2)
        self.assertTrue(any("RuntimeError" in a for a in broken["avisos"]) and any("OSError" in a for a in broken["avisos"]))

    def test_a_busy_database_makes_the_new_recorders_fail_fast_with_a_warning_instead_of_stalling_the_loop(self):
        self.snap(event())                                                                 # la base ya existe
        blocker = sqlite3.connect(aud.auditor_path(self.path), isolation_level=None)
        self.addCleanup(blocker.close)
        blocker.execute("BEGIN EXCLUSIVE")                                                 # otro proceso la tiene tomada
        with mock.patch.object(aud, "TRAINING_LOCK_TIMEOUT_S", 0.05):
            started = time.monotonic()
            out = self.record(veredicto=2, look={"prev_entry_side": 0}, warnings=True)
            labels = aud._resolve_training(self.path, PRODUCT, aud._Prices({}), None, CFG, T0, COST)
            self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(out["hechos"], False)
        self.assertTrue(out["avisos"] and "locked" in out["avisos"][0])
        self.assertTrue(labels["avisos"] and "locked" in labels["avisos"][0])
        blocker.execute("ROLLBACK")
        self.assertEqual(len(self.audit_rows()), 1)                                        # lo de antes, intacto

    def test_a_clean_resolve_reports_no_warnings(self):
        self.assertEqual(self.resolve(step_prices([(0, 100.0)]), T0 + HOUR)["avisos"], [])

    def test_the_new_recorders_do_not_change_what_snapshot_wrote(self):
        ev = event(T0, fml=formula(2, portero_si=False))
        other = tempfile.mkdtemp()
        with contextlib.closing(live.LiveStore(os.path.join(other, "live.sqlite"))):
            self.assertTrue(aud.snapshot(os.path.join(other, "live.sqlite"), PRODUCT, LookTrader(), ev, T0 + MIN))
        self.snap(ev, trader=LookTrader())
        self.record(veredicto=2, look={"prev_entry_side": 0})
        self.assertEqual(self.audit_rows(), self.read_miradas(other))

    @staticmethod
    def read_miradas(folder):
        con = sqlite3.connect(os.path.join(folder, "auditor.sqlite"))
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute("SELECT * FROM miradas ORDER BY t_ms")]
        finally:
            con.close()


# --------------------------------------------------------------------------- the live process


class LiveTrainingTests(unittest.TestCase):
    """The live operator with several places and a scripted maestro: the new rows appear, and nothing the recorder does or fails to do
    changes a decision, a trade or an old auditor row."""

    SCRIPT = {1: 2, 2: 2, 3: 0, 4: 2, 5: 2, 6: -2, 7: -2, 8: -2}          # veredicto por mirada (k = 15 min desde BASE)

    def run_live(self, *, recorder_fails=False, resolve_fails=False, slow=False, notes=None):
        cfg = copy.deepcopy(CFG)
        cfg["products"] = [PRODUCT]
        cfg["runtime"].pop("pending_config", None)
        cfg["posiciones"] = {"max": 2, "fraccion": 0.5, "espera_entre_entradas_min": 0}
        cfg["guardrails"]["cooldown_min"] = 30
        env = make(self, cfg=cfg, policy=Policy(flat="ESPERAR", position="MANTENER"), formula=True)
        real = corta.readings
        base = qt.date_ms("2026-10-20")

        def scripted(trader, t_ms, f=None):
            out = real(trader, t_ms, f)
            v = self.SCRIPT.get((t_ms - base) // (15 * MIN), 0)
            return dict(out, veredicto=v, puntaje=v * 2.0, portero_si=bool(v), portero_direccion=None, portero_autonomo=None)

        patches = [mock.patch.object(corta, "readings", scripted)]
        if recorder_fails:
            patches.append(mock.patch.object(live.auditor, "record_look", side_effect=RuntimeError("registro roto")))
        if resolve_fails:
            patches.append(mock.patch.object(aud, "_resolve_proposals", side_effect=RuntimeError("etiqueta rota")))
        if slow:
            patches.append(mock.patch.object(live, "AUDIT_TRAINING_SLOW_MS", -1))
        if notes is not None:
            real_record = aud.record_look

            def spy(path, product, trader, events, now_ms, marks=None, **kwargs):
                notes.append(sorted(trader.look_audit or ()))
                return real_record(path, product, trader, events, now_ms, marks, **kwargs)

            patches.append(mock.patch.object(live.auditor, "record_look", spy))
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            env.op.start()
            env.advance(120)
        return env

    @staticmethod
    def rows(env, sql):
        con = sqlite3.connect(os.path.join(env.tmp, "auditor.sqlite"))
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql)]
        except sqlite3.OperationalError:
            return None
        finally:
            con.close()

    @staticmethod
    def decisions(env):
        return env.rows("SELECT product, bucket_ms, t_ms, kind, action, formula_action, formula_json, trade_no, net_bp_now, override "
                        "FROM decisions ORDER BY t_ms")

    def test_every_look_leaves_its_facts_and_every_entry_proposal_with_its_block_reason(self):
        env = self.run_live()
        facts_ = self.rows(env, "SELECT * FROM hechos_mirada ORDER BY t_ms")
        self.assertEqual(len(facts_), 8)                                                    # 7 decisiones y la mirada del enfriamiento
        self.assertTrue(set(maestro.DIRECTIONAL) <= set(json.loads(facts_[0]["hechos_json"])))
        self.assertEqual({r["config_version"] for r in facts_}, {1})
        proposals = {(r["t_ms"] - qt.date_ms("2026-10-20")) // (15 * MIN): (r["estado"], r["motivo_bloqueo"], r["inicio_episodio"])
                     for r in self.rows(env, "SELECT * FROM propuestas")}
        self.assertEqual(proposals, {1: ("abierta", None, 1), 2: ("bloqueada", "mismo_episodio", 0), 4: ("abierta", None, 1),
                                     5: ("bloqueada", "lugares_ocupados", 0), 6: ("bloqueada", "cierre_en_la_mirada", 1),
                                     7: ("bloqueada", "enfriamiento", 0), 8: ("abierta", None, 0)})
        states = self.rows(env, "SELECT * FROM mirada_operaciones ORDER BY t_ms, trade_no")
        self.assertTrue(states)
        self.assertEqual({(r["trade_no"], r["evento"]) for r in states if r["t_ms"] == states[-1]["t_ms"]}, {(3, "abre")})
        self.assertTrue(all(r["salida_dice"] in ("MANTENER", "CERRAR", None) for r in states))
        self.assertTrue(any(r["salida_dice"] == "CERRAR" and r["evento"] == "cierra" for r in states))
        self.assertEqual(self.rows(env, "SELECT * FROM reentrenos"), [])
        self.assertEqual(env.rows("SELECT * FROM errors"), [])

    def test_a_failing_recorder_leaves_decisions_trades_and_old_auditor_rows_identical(self):
        clean = self.run_live()
        broken = self.run_live(recorder_fails=True)
        self.assertEqual(self.decisions(broken), self.decisions(clean))
        self.assertTrue(len(self.decisions(clean)) >= 7)
        self.assertEqual(broken.rows("SELECT * FROM trades ORDER BY trade_no"), clean.rows("SELECT * FROM trades ORDER BY trade_no"))
        self.assertEqual(self.rows(broken, "SELECT * FROM miradas ORDER BY t_ms"), self.rows(clean, "SELECT * FROM miradas ORDER BY t_ms"))
        errors = broken.rows("SELECT place, kind FROM errors")
        self.assertTrue(errors and all(e == {"place": "auditor_entrenar", "kind": "RuntimeError"} for e in errors))
        self.assertFalse(broken.op.failed_cycle)                                           # no frena el sondeo
        self.assertFalse(self.rows(broken, "SELECT * FROM hechos_mirada"))

    def test_a_failing_label_step_leaves_the_rest_identical_and_is_a_warning(self):
        clean = self.run_live()
        broken = self.run_live(resolve_fails=True)
        self.assertEqual(self.decisions(broken), self.decisions(clean))
        self.assertEqual(self.rows(broken, "SELECT * FROM miradas ORDER BY t_ms"), self.rows(clean, "SELECT * FROM miradas ORDER BY t_ms"))
        label = ("contrafactual_json", "neto_pb", "motivo_salida", "horas", "salida_ms", "resuelto_ms")
        proposals = lambda env: self.rows(env, "SELECT * FROM propuestas ORDER BY t_ms")
        self.assertEqual([{k: v for k, v in r.items() if k not in label} for r in proposals(broken)],
                         [{k: v for k, v in r.items() if k not in label} for r in proposals(clean)])
        self.assertTrue(all(r[k] is None for r in proposals(broken) for k in label))            # sin etiqueta: el paso falló
        self.assertTrue(any(r["resuelto_ms"] is not None for r in proposals(clean)))
        self.assertTrue(broken.rows("SELECT * FROM errors"))
        self.assertTrue(all(e["place"] == "auditor_entrenar" for e in broken.rows("SELECT place FROM errors")))
        self.assertFalse(broken.op.failed_cycle)

    def test_a_slow_recorder_is_logged_as_a_warning_and_changes_nothing(self):
        clean = self.run_live()
        slow = self.run_live(slow=True)
        self.assertEqual(self.decisions(slow), self.decisions(clean))
        self.assertEqual(self.rows(slow, "SELECT * FROM propuestas ORDER BY t_ms"), self.rows(clean, "SELECT * FROM propuestas ORDER BY t_ms"))
        errors = slow.rows("SELECT place, kind FROM errors")
        self.assertTrue(errors and all(e["place"] == "auditor_entrenar_lento" for e in errors))
        self.assertFalse(slow.op.failed_cycle)
        self.assertTrue(any("lento" in line for line in slow.logs))

    def test_the_trader_note_is_plain_read_only_data_with_the_same_keys_in_every_look(self):
        notes = []
        self.run_live(notes=notes)
        full = ["blocked", "closed_here", "exits", "open_ids", "prev_entry_side", "readings", "t_ms"]
        self.assertEqual(notes.count(full), 7)                                              # las 7 miradas con decisión
        self.assertTrue(notes and all(n in (full, ["skip", "t_ms"]) for n in notes))        # el resto, solo la marca del enfriamiento
        self.assertIn(["skip", "t_ms"], notes)


if __name__ == "__main__":
    unittest.main()
