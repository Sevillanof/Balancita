"""Auditor, dirección (S3 de odd/tasks/noticias-y-auditor.md): para cada mirada y cada operación, si la dirección fue correcta a 4, 12 y
24 h (signo del movimiento del precio contra el lado, solo con el horizonte ya cumplido) y el MAE/MFE de cada operación; la migración
aditiva de ``auditor.sqlite``; y que los veredictos de siempre no cambian. Sin red, sin modelo."""
import contextlib
import json
import os
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_auditor as aud
from balancita_engine import futures_qwen_corta as corta
from balancita_engine import positioning_data

from test_futures_auditor import (BAR, CFG, COST, HOUR, MIN, PRODUCT, STRONG, T0, WEAK, AuditorCase, FakeTrader, event, formula,
                                  position_of, step_prices)

OLD_COLUMNS = ("product", "bucket_ms", "t_ms", "estado", "accion", "maestro", "puntaje", "umbral_flojo", "umbral_fuerte", "portero_si",
               "portero_p", "portero_umbral", "noticias_si", "noticias_lado", "qwen", "qwen_coincide", "lado_posicion",
               "horas_en_posicion", "neto_ahora_pb", "trade_no", "condiciones_json", "despues_json", "veredicto_12h_json",
               "veredicto_24h_json", "veredicto_36h_json", "resuelto_ms", "version")


class DirectionCase(AuditorCase):
    def direction(self, where="1=1"):
        """``direccion_json`` de las miradas (ya cargado), por hora de mirada."""
        return {r["t_ms"]: (json.loads(r["direccion_json"]) if r["direccion_json"] else None) for r in self.audit_rows(where)}

    def operations(self):
        con = sqlite3.connect(aud.auditor_path(self.path))
        con.row_factory = sqlite3.Row
        try:
            return {r["trade_no"]: dict(r) for r in con.execute("SELECT * FROM operaciones ORDER BY trade_no")}
        finally:
            con.close()

    def wait_look(self, maestro=2, t_ms=T0, **kwargs):
        self.snap(event(t_ms, fml=formula(maestro, **kwargs)))


class LookDirectionTests(DirectionCase):
    PRICES = [(0, 100.0), (3 * HOUR, 101.0), (10 * HOUR, 102.0), (20 * HOUR, 99.0)]

    def test_each_look_gets_the_direction_at_4_12_and_24_hours(self):
        self.wait_look(2, portero_si=False)
        self.resolve(step_prices(self.PRICES), T0 + 25 * HOUR)
        done = self.direction()[T0]
        self.assertEqual(sorted(done), ["12h", "24h", "4h", "lado"])
        self.assertEqual(done["lado"], 1)
        self.assertAlmostEqual(done["4h"]["mov_pb"], 100.0)
        self.assertAlmostEqual(done["12h"]["mov_pb"], 200.0)
        self.assertAlmostEqual(done["24h"]["mov_pb"], -100.0)
        self.assertEqual([done[h]["acerto"] for h in ("4h", "12h", "24h")], [True, True, False])
        self.assertAlmostEqual(done["24h"]["a_favor_pb"], -100.0)
        self.assertIsNotNone(self.audit_rows()[0]["direccion_ms"])

    def test_the_sign_of_the_move_is_judged_against_the_side_of_the_look(self):
        self.wait_look(-2, portero_si=False)                                     # the maestro says down
        self.resolve(step_prices(self.PRICES), T0 + 25 * HOUR)
        done = self.direction()[T0]
        self.assertEqual(done["lado"], -1)
        self.assertEqual([done[h]["acerto"] for h in ("4h", "12h", "24h")], [False, False, True])
        self.assertAlmostEqual(done["4h"]["mov_pb"], 100.0)                       # the price move keeps its own sign
        self.assertAlmostEqual(done["4h"]["a_favor_pb"], -100.0)                  # what the move did for the side
        self.assertAlmostEqual(done["24h"]["a_favor_pb"], 100.0)

    def test_a_held_position_is_judged_with_the_side_of_the_position(self):
        pos = position_of("SHORT", T0 - HOUR, 1)
        self.snap(event(kind="position", action="MANTENER", position=pos, trade_no=1, fml=formula(2)))   # the maestro disagrees
        self.resolve(step_prices(self.PRICES), T0 + 25 * HOUR)
        done = self.direction()[T0]
        self.assertEqual(done["lado"], -1)
        self.assertEqual([done[h]["acerto"] for h in ("4h", "12h", "24h")], [False, False, True])

    def test_a_move_of_exactly_zero_is_neither_right_nor_wrong(self):
        self.wait_look(2, portero_si=False)
        self.resolve(step_prices([(0, 100.0)]), T0 + 25 * HOUR)
        done = self.direction()[T0]
        self.assertEqual(done["4h"]["mov_pb"], 0.0)
        self.assertIsNone(done["4h"]["acerto"])

    def test_a_look_without_a_side_has_no_direction_to_judge(self):
        self.wait_look(0, puntaje=0.0, portero_si=False)
        self.resolve(step_prices(self.PRICES), T0 + 25 * HOUR)
        done = self.direction()[T0]
        self.assertEqual(done, {"lado": None, "4h": None, "12h": None, "24h": None})
        self.assertIsNotNone(self.audit_rows()[0]["direccion_ms"])               # nothing more to wait for

    def test_a_horizon_that_has_not_fully_elapsed_stays_null_even_if_candles_exist_after_it(self):
        self.wait_look(2, portero_si=False)
        closes = step_prices(self.PRICES, end=T0 + 60 * HOUR)                     # the cache already holds the future
        self.resolve(closes, T0 + 4 * HOUR - 1)
        self.assertIsNone(self.audit_rows()[0]["direccion_json"])                 # nothing yet: no write at all
        self.resolve(closes, T0 + 4 * HOUR)
        row = self.audit_rows()[0]
        done = json.loads(row["direccion_json"])
        self.assertIsNotNone(done["4h"])
        self.assertIsNone(done["12h"])
        self.assertIsNone(done["24h"])
        self.assertIsNone(row["direccion_ms"])                                    # still waiting for 12 h and 24 h
        self.resolve(closes, T0 + 12 * HOUR - 1)
        self.assertIsNone(json.loads(self.audit_rows()[0]["direccion_json"])["12h"])
        self.resolve(closes, T0 + 12 * HOUR)
        self.assertIsNotNone(json.loads(self.audit_rows()[0]["direccion_json"])["12h"])
        self.resolve(closes, T0 + 24 * HOUR)
        row = self.audit_rows()[0]
        self.assertIsNotNone(json.loads(row["direccion_json"])["24h"])
        self.assertEqual(row["direccion_ms"], T0 + 24 * HOUR)

    def test_a_finished_direction_is_not_touched_again(self):
        self.wait_look(2, portero_si=False)
        self.resolve(step_prices(self.PRICES), T0 + 25 * HOUR)
        before = self.audit_rows()[0]
        self.assertEqual(self.resolve(step_prices(self.PRICES), T0 + 60 * HOUR)["direcciones"], 0)
        self.assertEqual(self.audit_rows()[0]["direccion_json"], before["direccion_json"])
        self.assertEqual(self.audit_rows()[0]["direccion_ms"], before["direccion_ms"])

    def test_old_rows_already_resolved_get_their_direction_without_changing_a_verdict(self):
        self.wait_look(2, portero_si=False)
        self.put_scores(STRONG + 0.1, 40, flip_at_h=3, flip_score=-(WEAK + 0.1))
        closes = step_prices(self.PRICES)
        self.resolve(closes, T0 + 40 * HOUR)
        self.sql("UPDATE miradas SET direccion_json=NULL, direccion_ms=NULL")       # a row written before this change
        kept = {k: v for k, v in self.audit_rows()[0].items() if k in OLD_COLUMNS}
        self.assertEqual(kept["resuelto_ms"], T0 + 40 * HOUR)
        self.resolve(closes, T0 + 50 * HOUR)
        row = self.audit_rows()[0]
        self.assertEqual({k: v for k, v in row.items() if k in OLD_COLUMNS}, kept)
        self.assertEqual(json.loads(row["direccion_json"])["24h"]["acerto"], False)


class TradeDirectionTests(DirectionCase):
    def test_each_operation_has_its_own_row_with_the_direction_from_its_entry_whatever_its_exit(self):
        self.put_trade(1, status="closed", side="LONG", entry_ms=T0, exit_ms=T0 + 2 * HOUR, exit_px="100", net_bp=1.0,
                       closed_by="formula")
        result = self.resolve(step_prices(LookDirectionTests.PRICES), T0 + 25 * HOUR)
        self.assertEqual(result["operaciones"], 1)
        row = self.operations()[1]
        self.assertEqual((row["lado"], row["entry_ms"], row["exit_ms"]), (1, T0, T0 + 2 * HOUR))
        done = json.loads(row["direccion_json"])
        self.assertEqual(sorted(done), ["12h", "24h", "4h", "lado"])
        self.assertEqual([done[h]["acerto"] for h in ("4h", "12h", "24h")], [True, True, False])    # also after the exit
        self.assertAlmostEqual(done["12h"]["mov_pb"], 200.0)
        self.assertEqual(row["resuelto_ms"], T0 + 25 * HOUR)

    def test_a_short_is_right_when_the_price_falls(self):
        self.put_trade(2, status="open", side="SHORT", entry_ms=T0)
        self.resolve(step_prices(LookDirectionTests.PRICES), T0 + 25 * HOUR)
        done = json.loads(self.operations()[2]["direccion_json"])
        self.assertEqual(done["lado"], -1)
        self.assertEqual([done[h]["acerto"] for h in ("4h", "12h", "24h")], [False, False, True])

    def test_the_direction_waits_for_each_horizon_to_elapse(self):
        self.put_trade(1, status="open", side="LONG", entry_ms=T0)
        closes = step_prices(LookDirectionTests.PRICES, end=T0 + 60 * HOUR)
        self.resolve(closes, T0 + 4 * HOUR - 1)
        done = json.loads(self.operations()[1]["direccion_json"])
        self.assertEqual([done[h] for h in ("4h", "12h", "24h")], [None, None, None])
        self.resolve(closes, T0 + 5 * HOUR)
        done = json.loads(self.operations()[1]["direccion_json"])
        self.assertIsNotNone(done["4h"])
        self.assertIsNone(done["12h"])
        self.assertIsNone(done["24h"])

    def test_mfe_and_mae_of_a_closed_trade_stop_at_its_exit(self):
        self.put_trade(1, status="closed", side="LONG", entry_ms=T0, exit_ms=T0 + 6 * HOUR, exit_px="101", net_bp=80.0,
                       closed_by="formula")
        self.resolve(step_prices([(0, 100.0), (HOUR, 99.0), (2 * HOUR, 103.0), (6 * HOUR, 101.0), (7 * HOUR, 90.0),
                                  (8 * HOUR, 120.0)]), T0 + 30 * HOUR)
        row = self.operations()[1]
        self.assertAlmostEqual(row["mfe_pb"], 300.0)
        self.assertAlmostEqual(row["mae_pb"], -100.0)                         # the 90 and the 120 came after the exit
        self.assertEqual(row["hasta_ms"], T0 + 6 * HOUR)

    def test_mfe_and_mae_of_a_short_are_from_the_point_of_view_of_the_short(self):
        self.put_trade(2, status="closed", side="SHORT", entry_ms=T0, exit_ms=T0 + 6 * HOUR, exit_px="101", net_bp=-90.0,
                       closed_by="formula")
        self.resolve(step_prices([(0, 100.0), (HOUR, 99.0), (2 * HOUR, 103.0), (6 * HOUR, 101.0)]), T0 + 30 * HOUR)
        row = self.operations()[2]
        self.assertAlmostEqual(row["mfe_pb"], 100.0)                          # the price fell 1 % once
        self.assertAlmostEqual(row["mae_pb"], -300.0)                         # and rose 3 %

    def test_an_open_trade_runs_its_excursions_until_now_and_is_not_resolved(self):
        self.put_trade(1, status="open", side="LONG", entry_ms=T0)
        closes = step_prices([(0, 100.0), (HOUR, 98.0), (3 * HOUR, 104.0), (5 * HOUR, 90.0)], end=T0 + 60 * HOUR)
        self.resolve(closes, T0 + 4 * HOUR)
        row = self.operations()[1]
        self.assertAlmostEqual(row["mfe_pb"], 400.0)
        self.assertAlmostEqual(row["mae_pb"], -200.0)                         # the 90 of the future is not seen
        self.assertEqual(row["hasta_ms"], T0 + 4 * HOUR)
        self.assertIsNone(row["resuelto_ms"])
        self.put_trade(1, status="closed", side="LONG", entry_ms=T0, exit_ms=T0 + 26 * HOUR, exit_px="90", net_bp=-1000.0,
                       closed_by="formula")
        self.resolve(closes, T0 + 30 * HOUR)
        row = self.operations()[1]
        self.assertAlmostEqual(row["mae_pb"], -1000.0)
        self.assertEqual(row["resuelto_ms"], T0 + 30 * HOUR)
        self.assertEqual(self.resolve(closes, T0 + 40 * HOUR)["operaciones"], 0)       # resolved: not touched again

    def test_three_trades_open_at_once_each_get_a_row_although_the_look_names_only_the_first(self):
        for number, minutes in ((3, 0), (4, 60), (5, 120)):
            self.put_trade(number, status="open", side="LONG", entry_ms=T0 + minutes * MIN)
        self.snap(event(kind="position", action="MANTENER", position=position_of("LONG", T0, 3), trade_no=3, fml=formula(2)))
        self.resolve(step_prices([(0, 100.0), (2 * HOUR, 103.0)]), T0 + 5 * HOUR)
        rows = self.operations()
        self.assertEqual(sorted(rows), [3, 4, 5])
        self.assertAlmostEqual(rows[3]["mfe_pb"], 300.0)
        self.assertAlmostEqual(rows[5]["mfe_pb"], 0.0)                        # bought at the top: it never went up from there

    def test_a_trade_without_candles_at_its_entry_leaves_no_row_and_other_products_are_not_mixed(self):
        self.put_trade(1, status="open", side="LONG", entry_ms=T0 - 100 * HOUR)
        with self.store.db:
            self.store.put_trade("PF_XBTUSD", 9, status="open", side="LONG", entry_ms=T0)
        self.resolve(step_prices([(0, 100.0)]), T0 + 5 * HOUR)
        self.assertEqual(self.operations(), {})


class MigrationTests(DirectionCase):
    OLD_SQL = """
    CREATE TABLE miradas(
      product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, estado TEXT NOT NULL, accion TEXT NOT NULL,
      maestro INTEGER, puntaje REAL, umbral_flojo REAL, umbral_fuerte REAL, portero_si INTEGER, portero_p REAL, portero_umbral REAL,
      noticias_si INTEGER, noticias_lado INTEGER, qwen TEXT, qwen_coincide INTEGER, lado_posicion INTEGER NOT NULL DEFAULT 0,
      horas_en_posicion REAL, neto_ahora_pb REAL, trade_no INTEGER, condiciones_json TEXT NOT NULL, despues_json TEXT,
      veredicto_12h_json TEXT, veredicto_24h_json TEXT, veredicto_36h_json TEXT, resuelto_ms INTEGER, version TEXT NOT NULL,
      PRIMARY KEY(product, bucket_ms));
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES('schema', 'balancita-auditor.v1');
    """

    def old_database(self):
        con = sqlite3.connect(aud.auditor_path(self.path))
        con.executescript(self.OLD_SQL)
        con.execute("INSERT INTO miradas VALUES('PF_ETHUSD', ?, ?, 'plana', 'NO_ENTRAR_portero', 2, 0.9, 0.2, 0.4, 0, 0.3, NULL, 0, NULL, "
                    "NULL, NULL, 0, NULL, NULL, NULL, '{}', '{\"mov_1h\": 5.0}', '{\"acerto\": true}', '{\"acerto\": false}', "
                    "'{\"acerto\": false}', 123, 'auditor.v1')", (T0 - 15 * MIN, T0))
        con.commit()
        con.close()

    def columns(self, table="miradas"):
        with contextlib.closing(sqlite3.connect(aud.auditor_path(self.path))) as con:
            return [r[1] for r in con.execute("PRAGMA table_info({})".format(table))]

    def test_an_old_database_keeps_every_row_and_column_and_only_gains_new_ones(self):
        self.old_database()
        with contextlib.closing(aud._open(self.path)):
            pass
        columns = self.columns()
        self.assertEqual(columns[:len(OLD_COLUMNS)], list(OLD_COLUMNS))             # the old ones, same order, same place
        self.assertEqual(columns[len(OLD_COLUMNS):], ["direccion_json", "direccion_ms"])
        self.assertEqual(self.columns("operaciones")[:2], ["product", "trade_no"])
        row, = self.audit_rows()
        self.assertEqual((row["accion"], row["veredicto_12h_json"], row["veredicto_36h_json"], row["resuelto_ms"]),
                         ("NO_ENTRAR_portero", '{"acerto": true}', '{"acerto": false}', 123))
        self.assertEqual((row["direccion_json"], row["direccion_ms"]), (None, None))               # old rows: null until backfilled
        with contextlib.closing(sqlite3.connect(aud.auditor_path(self.path))) as con:
            self.assertEqual(con.execute("SELECT value FROM meta WHERE key='schema'").fetchone()[0], "balancita-auditor.v1")

    def test_opening_twice_is_harmless_and_a_new_database_has_the_same_shape(self):
        self.old_database()
        for _ in range(2):
            with contextlib.closing(aud._open(self.path)):
                pass
        migrated = self.columns()
        os.remove(aud.auditor_path(self.path))
        with contextlib.closing(aud._open(self.path)):
            pass
        self.assertEqual(self.columns(), migrated)

    def test_the_change_is_reversible_dropping_the_new_columns_and_table_leaves_the_old_data(self):
        self.old_database()
        with contextlib.closing(aud._open(self.path)):
            pass
        before = {k: v for k, v in self.audit_rows()[0].items() if k in OLD_COLUMNS}
        with contextlib.closing(sqlite3.connect(aud.auditor_path(self.path))) as con:
            con.execute("ALTER TABLE miradas DROP COLUMN direccion_json")
            con.execute("ALTER TABLE miradas DROP COLUMN direccion_ms")
            con.execute("DROP TABLE operaciones")
            con.commit()
        self.assertEqual(self.columns(), list(OLD_COLUMNS))
        self.assertEqual(self.audit_rows()[0], before)
        with contextlib.closing(aud._open(self.path)):                              # and it migrates again
            pass
        self.assertIn("direccion_json", self.columns())


class PreservationTests(DirectionCase):
    """Los veredictos y el ``despues_json`` de siempre salen idénticos: el escenario se corrió con el código anterior al cambio y estos
    son sus valores (``accion``, ``veredicto_12h/24h/36h_json``, ``despues_json``, ``resuelto_ms``)."""

    def scenario(self):
        pos = position_of("LONG", T0 - HOUR, 1)
        self.snap(event(T0, action="LARGO", fml=formula(2), trade_no=1))
        self.put_trade(1, status="closed", side="LONG", entry_ms=T0, exit_ms=T0 + 5 * HOUR, exit_px="103", net_bp=280.0,
                       closed_by="formula", exit_reason="maestro_vuelta")
        self.snap(event(T0 + 15 * MIN, fml=formula(2, portero_si=False)))
        self.snap(event(T0 + 30 * MIN, fml=formula(1)))
        self.snap(event(T0 + 45 * MIN, kind="position", action="MANTENER", position=pos, trade_no=1, net=5.0, fml=formula(2)))
        self.snap(event(T0 + 60 * MIN, kind="position", action="CERRAR", position=pos, trade_no=1, net=5.0,
                        fml=formula(-1, motivo="el maestro se dio vuelta en contra")))
        self.snap(event(T0 + 75 * MIN, kind="position", action="CERRAR", position=position_of("SHORT", T0 - HOUR, 2), trade_no=2,
                        fml=formula(1, motivo=corta.NEWS_EXIT_WHY + " (primeras 12 h)")))
        self.put_scores(STRONG + 0.1, 40, flip_at_h=6, flip_score=-(WEAK + 0.1))
        closes = step_prices([(0, 100.0), (HOUR, 99.0), (3 * HOUR, 102.0), (5 * HOUR, 103.0), (14 * HOUR, 101.0), (30 * HOUR, 104.0)])
        self.resolve(closes, T0 + 20 * HOUR)
        self.resolve(closes, T0 + 60 * HOUR)
        keys = ("accion", "veredicto_12h_json", "veredicto_24h_json", "veredicto_36h_json", "despues_json", "resuelto_ms")
        return [{k: (json.loads(r[k]) if k.endswith("_json") and r[k] else r[k]) for k in keys} for r in self.audit_rows()]

    def test_verdicts_and_after_numbers_are_the_ones_the_auditor_always_gave(self):
        rows = self.scenario()
        self.assertEqual(rows, GOLDEN)


GOLDEN = [
    {"accion": "ENTRAR", "despues_json": {"hasta_ms": 1792620000000, "lado_ref": 1, "mae_36h": -100.00000000000009, "mfe_36h": 400.00000000000034, "mov_12h": 300.0000000000003, "mov_1h": -100.00000000000009, "mov_24h": 100.00000000000009, "mov_30m": 0.0, "mov_36h": 400.00000000000034, "mov_4h": 200.00000000000017, "queda_hasta_36h_pb": None, "queda_hasta_salida_pb": None, "si_entraba_contrario_pb": -10.0, "si_entraba_maestro_pb": 290.0000000000003}, "resuelto_ms": 1792706400000, "veredicto_12h_json": {"acerto": True, "costo_error_pb": 0.0, "regla": "entrar acierta si el neto es positivo", "texto": "ganó +280 pb", "valor_pb": 280.0}, "veredicto_24h_json": {"acerto": True, "costo_error_pb": 0.0, "regla": "entrar acierta si el neto es positivo", "texto": "ganó +280 pb", "valor_pb": 280.0}, "veredicto_36h_json": {"acerto": True, "costo_error_pb": 0.0, "regla": "entrar acierta si el neto es positivo", "texto": "ganó +280 pb", "valor_pb": 280.0}},
    {"accion": "NO_ENTRAR_portero", "despues_json": {"hasta_ms": 1792620900000, "lado_ref": 1, "mae_36h": -100.00000000000009, "mfe_36h": 400.00000000000034, "mov_12h": 300.0000000000003, "mov_1h": -100.00000000000009, "mov_24h": 100.00000000000009, "mov_30m": 0.0, "mov_36h": 400.00000000000034, "mov_4h": 200.00000000000017, "queda_hasta_36h_pb": None, "queda_hasta_salida_pb": None, "si_entraba_contrario_pb": -10.0, "si_entraba_maestro_pb": 290.0000000000003}, "resuelto_ms": 1792706400000, "veredicto_12h_json": {"acerto": False, "costo_error_pb": 290.0, "regla": "no entrar acierta si la operación que no se abrió no ganaba", "texto": "si entraba: +290 pb", "valor_pb": 290.0}, "veredicto_24h_json": {"acerto": False, "costo_error_pb": 290.0, "regla": "no entrar acierta si la operación que no se abrió no ganaba", "texto": "si entraba: +290 pb", "valor_pb": 290.0}, "veredicto_36h_json": {"acerto": False, "costo_error_pb": 290.0, "regla": "no entrar acierta si la operación que no se abrió no ganaba", "texto": "si entraba: +290 pb", "valor_pb": 290.0}},
    {"accion": "NO_ENTRAR_maestro", "despues_json": {"hasta_ms": 1792621800000, "lado_ref": 1, "mae_36h": -100.00000000000009, "mfe_36h": 400.00000000000034, "mov_12h": 300.0000000000003, "mov_1h": -100.00000000000009, "mov_24h": 100.00000000000009, "mov_30m": -100.00000000000009, "mov_36h": 400.00000000000034, "mov_4h": 200.00000000000017, "queda_hasta_36h_pb": None, "queda_hasta_salida_pb": None, "si_entraba_contrario_pb": -10.0, "si_entraba_maestro_pb": 290.0000000000003}, "resuelto_ms": 1792706400000, "veredicto_12h_json": {"acerto": False, "costo_error_pb": 290.0, "regla": "no entrar acierta si la operación que no se abrió no ganaba", "texto": "si entraba: +290 pb", "valor_pb": 290.0}, "veredicto_24h_json": {"acerto": False, "costo_error_pb": 290.0, "regla": "no entrar acierta si la operación que no se abrió no ganaba", "texto": "si entraba: +290 pb", "valor_pb": 290.0}, "veredicto_36h_json": {"acerto": False, "costo_error_pb": 290.0, "regla": "no entrar acierta si la operación que no se abrió no ganaba", "texto": "si entraba: +290 pb", "valor_pb": 290.0}},
    {"accion": "MANTENER", "despues_json": {"hasta_ms": 1792622700000, "lado_ref": 1, "mae_36h": -100.00000000000009, "mfe_36h": 400.00000000000034, "mov_12h": 300.0000000000003, "mov_1h": -100.00000000000009, "mov_24h": 100.00000000000009, "mov_30m": -100.00000000000009, "mov_36h": 400.00000000000034, "mov_4h": 200.00000000000017, "queda_hasta_36h_pb": 400.00000000000034, "queda_hasta_salida_pb": 300.0000000000003, "si_entraba_contrario_pb": 90.00000000000009, "si_entraba_maestro_pb": 290.0000000000003}, "resuelto_ms": 1792706400000, "veredicto_12h_json": {"acerto": True, "costo_error_pb": 0.0, "regla": "mantener acierta si lo que quedó es >= 0", "texto": "quedó: +300 pb", "valor_pb": 300.0}, "veredicto_24h_json": {"acerto": True, "costo_error_pb": 0.0, "regla": "mantener acierta si lo que quedó es >= 0", "texto": "quedó: +300 pb", "valor_pb": 300.0}, "veredicto_36h_json": {"acerto": True, "costo_error_pb": 0.0, "regla": "mantener acierta si lo que quedó es >= 0", "texto": "quedó: +300 pb", "valor_pb": 300.0}},
    {"accion": "SALIR_vuelta", "despues_json": {"hasta_ms": 1792623600000, "lado_ref": 1, "mae_36h": 0.0, "mfe_36h": 505.0505050505061, "mov_12h": 404.04040404040444, "mov_1h": 0.0, "mov_24h": 202.0202020202011, "mov_30m": 0.0, "mov_36h": 505.0505050505061, "mov_4h": 404.04040404040444, "queda_hasta_36h_pb": 505.0505050505061, "queda_hasta_salida_pb": 404.04040404040444, "si_entraba_contrario_pb": -10.0, "si_entraba_maestro_pb": 394.04040404040444}, "resuelto_ms": 1792706400000, "veredicto_12h_json": {"acerto": False, "costo_error_pb": 404.04, "regla": "salir acierta si aguantar no sumaba", "texto": "quedaba: +404 pb", "valor_pb": 404.04}, "veredicto_24h_json": {"acerto": False, "costo_error_pb": 202.02, "regla": "salir acierta si aguantar no sumaba", "texto": "quedaba: +202 pb", "valor_pb": 202.02}, "veredicto_36h_json": {"acerto": False, "costo_error_pb": 505.05, "regla": "salir acierta si aguantar no sumaba", "texto": "quedaba: +505 pb", "valor_pb": 505.05}},
    {"accion": "SALIR_12h_noticias", "despues_json": {"hasta_ms": 1792624500000, "lado_ref": -1, "mae_36h": -505.0505050505061, "mfe_36h": 0.0, "mov_12h": 404.04040404040444, "mov_1h": 0.0, "mov_24h": 202.0202020202011, "mov_30m": 0.0, "mov_36h": 505.0505050505061, "mov_4h": 404.04040404040444, "queda_hasta_36h_pb": None, "queda_hasta_salida_pb": None, "si_entraba_contrario_pb": 394.04040404040444, "si_entraba_maestro_pb": -10.0}, "resuelto_ms": 1792706400000, "veredicto_12h_json": {"acerto": True, "costo_error_pb": 0.0, "regla": "salir acierta si aguantar no sumaba", "texto": "quedaba: −404 pb", "valor_pb": -404.04}, "veredicto_24h_json": {"acerto": True, "costo_error_pb": 0.0, "regla": "salir acierta si aguantar no sumaba", "texto": "quedaba: −202 pb", "valor_pb": -202.02}, "veredicto_36h_json": {"acerto": True, "costo_error_pb": 0.0, "regla": "salir acierta si aguantar no sumaba", "texto": "quedaba: −505 pb", "valor_pb": -505.05}},
]


class PositioningContextTests(DirectionCase):
    """S4: cuando el trader tiene el colector de posicionamiento, la foto de la mirada lo trae (el contexto nulo de noviembre viene de
    que el operador en vivo no se lo pasa al trader, ver el informe)."""

    def test_the_photo_carries_open_interest_and_its_changes_when_the_trader_has_the_feed(self):
        path = os.path.join(self.tmp, "positioning.sqlite")
        con = sqlite3.connect(path)
        con.executescript("CREATE TABLE positioning(product_id TEXT, bucket_ms INTEGER, long_percent REAL, top_long_percent REAL, "
                          "top_open_interest REAL); CREATE TABLE premium(product_id TEXT, interval_ms INTEGER, bucket_ms INTEGER, "
                          "premium_bp REAL);")
        for k in range(30):
            con.execute("INSERT INTO positioning VALUES(?,?,?,?,?)", (PRODUCT, T0 - 30 * HOUR + k * HOUR, 60.0, 70.0, 1000.0 + k))
        con.commit()
        con.close()

        class WithFeed(FakeTrader):
            positioning = positioning_data.PositioningFeed(path, PRODUCT)

        photo = aud.conditions(WithFeed, event(), formula(), T0)["posicionamiento"]
        self.assertAlmostEqual(photo["oi"], 1029.0)                       # the bucket that closes at T0
        self.assertAlmostEqual(photo["oi_4h_pct"], (1029.0 / 1025.0 - 1) * 100)
        self.assertAlmostEqual(photo["oi_24h_pct"], (1029.0 / 1005.0 - 1) * 100)
        self.assertIsNone(aud.conditions(FakeTrader, event(), formula(), T0)["posicionamiento"])


if __name__ == "__main__":
    unittest.main()
