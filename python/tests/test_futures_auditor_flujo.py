"""Flujo de mercado por mirada del auditor (``flujo_mirada``): ventanas de 30 min / 1 h / 4 h de compras y ventas agresoras, liquidaciones
e interés abierto, sin mirar el futuro, con hueco marcado cuando falta el dato, idempotente y sin tocar las tablas viejas. La captura es
una base SQLite de juguete con el esquema real de ``paper_futures_analytics_points``; la API pública se reemplaza por un doble. Sin red."""
import contextlib
import io
import json
import os
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_auditor as aud
from balancita_engine import futures_auditor_flujo as flujo

MIN = 60_000
HOUR = 60 * MIN
PRODUCT = "PF_ETHUSD"
T = 1_790_000_000_000 - (1_790_000_000_000 % (15 * MIN))        # una mirada: múltiplo de 15 min
LAG = 8_000                                                      # la captura baja cada minuto 8 s después de cerrar

CAPTURE_DDL = """
CREATE TABLE paper_futures_analytics_points(
  product_id TEXT NOT NULL, metric TEXT NOT NULL, interval_ms INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL, revision_hash TEXT NOT NULL, known_at INTEGER NOT NULL,
  values_json TEXT NOT NULL, response_sha256 TEXT NOT NULL,
  PRIMARY KEY(product_id, metric, interval_ms, bucket_start, revision_hash));
"""


def capture(path, minutes=300, skip=(), product=PRODUCT, liq=True, oi=True, t_ms=T):
    """Una captura con ``minutes`` minutos cerrados antes de ``t_ms``: compra 1, venta 2, interés abierto 1000 + minuto, y una
    liquidación de 0,5 cada 10 minutos. ``skip``: minutos (desplazamiento respecto de ``t_ms``) sin balde."""
    db = sqlite3.connect(path)
    db.executescript(CAPTURE_DDL)
    for back in range(1, minutes + 1):
        if -back * MIN in skip:
            continue
        start = t_ms - back * MIN
        known = start + MIN + LAG
        put(db, product, "cvd", start, {"buy_volume": "1", "sell_volume": "2", "cvd": "0"}, known)
        if oi:
            put(db, product, "open-interest", start, {"open": "1", "high": "1", "low": "1", "close": str(1000 + (minutes - back))}, known)
        if liq and back % 10 == 0:
            put(db, product, "liquidation-volume", start, {"value": "0.5"}, known)
    db.commit()
    return db


def put(db, product, metric, start, values, known, revision=None):
    text = json.dumps(values, sort_keys=True)
    db.execute("INSERT INTO paper_futures_analytics_points VALUES(?,?,?,?,?,?,?,?)",
               (product, metric, MIN, start, revision or text, known, text, "x"))


class FlujoCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.market = os.path.join(self.tmp, "futures-market.sqlite")
        self.live = os.path.join(self.tmp, "live.sqlite")

    def build(self, **kwargs):
        with contextlib.closing(capture(self.market, **kwargs)):
            pass

    def row(self, **kwargs):
        kwargs.setdefault("env", {flujo.API_ENV: "0"})
        return flujo.calcular(PRODUCT, kwargs.pop("t_ms", T), market_db=self.market, now_ms=T + 10_000, **kwargs)


class Ventanas(FlujoCase):
    def test_ventanas_terminan_en_el_ultimo_minuto_conocido(self):
        self.build()
        row = self.row()
        # el balde [T-1min, T) se conoce recién a T+8 s: no cuenta; la ventana termina en T-1min
        self.assertEqual(row["fin_ms"], T - MIN)
        self.assertEqual((row["comprador_30m"], row["vendedor_30m"], row["delta_30m"]), (30.0, 60.0, -30.0))
        self.assertEqual((row["comprador_1h"], row["vendedor_1h"]), (60.0, 120.0))
        self.assertEqual((row["comprador_4h"], row["vendedor_4h"], row["delta_4h"]), (240.0, 480.0, -240.0))
        self.assertEqual(row["hueco"], 0)
        self.assertIsNone(row["motivo_hueco"])
        self.assertEqual(row["fuente"], "captura")

    def test_liquidaciones_e_interes_abierto(self):
        self.build()
        row = self.row()
        # liquidaciones de 0,5 en los minutos T-10, T-20, ... : dentro de [T-31, T-1) caen T-10, T-20, T-30
        self.assertEqual(row["liquidaciones_30m"], 1.5)
        self.assertEqual(row["liquidaciones_1h"], 3.0)
        self.assertEqual(row["liquidaciones_4h"], 12.0)
        # interés abierto: nivel = cierre del último balde conocido (T-2 min, el de T-1 aún no se conoce a T); cambio contra la misma regla 30 min antes
        self.assertEqual(row["oi"], 1000 + 300 - 2)
        self.assertEqual(row["oi_cambio_30m"], 30.0)
        self.assertEqual(row["oi_cambio_4h"], 240.0)
        self.assertAlmostEqual(row["oi_pct_30m"], (1298 / 1268 - 1) * 100)

    def test_sin_liquidaciones_en_la_serie_no_se_inventa_cero(self):
        self.build(liq=False)
        row = self.row()
        self.assertIsNone(row["liquidaciones_30m"])
        self.assertIsNotNone(row["comprador_30m"])
        self.assertEqual(row["hueco"], 1)
        self.assertIn("liquidaciones_sin_datos", row["motivo_hueco"])


class SinFuturo(FlujoCase):
    def test_nada_del_futuro_ni_conocido_despues(self):
        self.build()
        base = self.row()
        with contextlib.closing(sqlite3.connect(self.market)) as db:
            # (1) un balde posterior a la mirada, (2) un balde cerrado pero conocido después de la mirada,
            # (3) una revisión nueva (conocida después) de un balde viejo con un valor enorme
            put(db, PRODUCT, "cvd", T, {"buy_volume": "9999", "sell_volume": "9999", "cvd": "0"}, T + MIN + LAG)
            put(db, PRODUCT, "cvd", T - MIN, {"buy_volume": "9999", "sell_volume": "9999", "cvd": "0"}, T + 1)
            put(db, PRODUCT, "cvd", T - 5 * MIN, {"buy_volume": "7777", "sell_volume": "7777", "cvd": "0"}, T + 1)
            put(db, PRODUCT, "open-interest", T - MIN, {"open": "1", "high": "1", "low": "1", "close": "99999"}, T + 1)
            put(db, PRODUCT, "liquidation-volume", T - 3 * MIN, {"value": "5000"}, T + 1)
            db.commit()
        again = self.row()
        for key in flujo.COLUMNS:
            self.assertEqual(again[key], base[key], key)

    def test_una_revision_conocida_a_tiempo_si_cuenta(self):
        self.build()
        with contextlib.closing(sqlite3.connect(self.market)) as db:
            put(db, PRODUCT, "cvd", T - 5 * MIN, {"buy_volume": "11", "sell_volume": "2", "cvd": "0"}, T - 1)    # revisión conocida antes de T
            db.commit()
        self.assertEqual(self.row()["comprador_30m"], 30.0 - 1 + 11)

    def test_otro_producto_no_se_mezcla(self):
        self.build()
        with contextlib.closing(sqlite3.connect(self.market)) as db:
            put(db, "PF_XBTUSD", "cvd", T - 3 * MIN, {"buy_volume": "5000", "sell_volume": "1", "cvd": "0"}, T - 1)
            db.commit()
        self.assertEqual(self.row()["comprador_30m"], 30.0)


class Huecos(FlujoCase):
    def test_falta_un_minuto_deja_null_solo_las_ventanas_que_lo_incluyen(self):
        self.build(skip=(-100 * MIN,))                                  # un minuto, hace 100 min: entra en 4 h, no en 30 m ni 1 h
        row = self.row()
        self.assertEqual(row["comprador_30m"], 30.0)
        self.assertEqual(row["comprador_1h"], 60.0)
        self.assertIsNone(row["comprador_4h"])
        self.assertIsNone(row["delta_4h"])
        self.assertEqual(row["hueco"], 1)
        self.assertIn("cvd_4h:239/240", row["motivo_hueco"])
        self.assertEqual(json.loads(row["cobertura_json"])["cvd_4h"], 239)

    def test_captura_vieja_es_hueco(self):
        self.build(t_ms=T - 30 * MIN)                                   # la captura se quedó atrás: no se usa el pasado como si fuera ahora
        row = self.row()
        self.assertIsNone(row["comprador_30m"])
        self.assertEqual(row["hueco"], 1)
        self.assertIn("cvd_viejo", row["motivo_hueco"])

    def test_sin_base_de_captura_la_fila_igual_se_escribe_con_hueco(self):
        self.market = os.path.join(self.tmp, "no-existe.sqlite")
        row = aud._flow_row(PRODUCT, T, T + 10_000, self.market)
        self.assertEqual(row["hueco"], 1)
        self.assertIn("captura_ausente", row["motivo_hueco"])
        self.assertTrue(all(row[c] is None for c in ("oi", "comprador_30m", "delta_4h", "liquidaciones_1h")))
        with contextlib.closing(aud._open(self.live)) as db:
            with db:
                self.assertTrue(aud._record_flow(db, row))
            saved = db.execute("SELECT hueco, bucket_ms, t_ms FROM flujo_mirada").fetchall()
        self.assertEqual([tuple(r) for r in saved], [(1, T - aud.BUCKET_MS, T)])

    def test_error_inesperado_no_levanta(self):
        with unittest_patch(flujo, "calcular", RuntimeError("roto")):
            row = aud._flow_row(PRODUCT, T, T + 10_000, self.market)
        self.assertEqual(row["hueco"], 1)
        self.assertEqual(row["motivo_hueco"], "error:RuntimeError")

    def test_tabla_inexistente_en_la_captura_es_hueco_no_error(self):
        sqlite3.connect(self.market).close()                            # base vacía, sin la tabla de analytics
        row = self.row()
        self.assertEqual(row["hueco"], 1)
        self.assertIn("captura_cvd:OperationalError", row["motivo_hueco"])


class Respaldo(FlujoCase):
    def fake_api(self, calls, fail=()):
        def api(product, metric, from_ms, t_ms, now_ms):
            calls.append(metric)
            if metric in fail:
                raise OSError("sin red")
            start = t_ms - 300 * MIN
            return {b: ({"buy_volume": "1", "sell_volume": "2"} if metric == "cvd" else
                        {"close": "2000"} if metric == "open-interest" else {"value": "1"})
                    for b in range(start, t_ms - MIN + 1, MIN) if b + MIN <= t_ms}
        return api

    def call(self, api, **kwargs):
        # ``clock`` cerca de la mirada: es una mirada en vivo
        return flujo.calcular(PRODUCT, T, market_db=self.market, now_ms=T + 10_000, env=kwargs.get("env", {}), api=api,
                              clock=lambda: (T + 10_000) / 1000)

    def test_captura_completa_no_llama_a_la_api(self):
        self.build()
        calls = []
        row = self.call(self.fake_api(calls))
        self.assertEqual(calls, [])
        self.assertEqual(row["fuente"], "captura")

    def test_sin_captura_usa_la_api_y_lo_anota(self):
        calls = []
        row = self.call(self.fake_api(calls))
        self.assertCountEqual(calls, list(flujo.METRICS))
        self.assertEqual(row["fuente"], "api")
        self.assertEqual(row["comprador_4h"], 240.0)
        self.assertEqual(row["hueco"], 0)

    def test_solo_pide_lo_que_falta(self):
        self.build(liq=False)
        calls = []
        row = self.call(self.fake_api(calls))
        self.assertEqual(calls, ["liquidation-volume"])
        self.assertEqual(row["fuente"], "api+captura")

    def test_api_caida_deja_hueco_y_no_levanta(self):
        calls = []
        row = self.call(self.fake_api(calls, fail=flujo.METRICS))
        self.assertEqual(row["hueco"], 1)
        self.assertIsNone(row["fuente"])
        self.assertIn("api_cvd:OSError", row["motivo_hueco"])

    def test_api_apagada_por_entorno(self):
        calls = []
        row = self.call(self.fake_api(calls), env={flujo.API_ENV: "0"})
        self.assertEqual(calls, [])
        self.assertEqual(row["hueco"], 1)

    def test_mirada_vieja_no_sale_a_la_red(self):
        calls = []
        row = flujo.calcular(PRODUCT, T, market_db=self.market, now_ms=T + 10_000, env={}, api=self.fake_api(calls),
                             clock=lambda: (T + 10 * HOUR) / 1000)
        self.assertEqual(calls, [])
        self.assertEqual(row["hueco"], 1)

    def test_leer_api_descarta_el_futuro_y_lo_no_asentado(self):
        stamps = [(T - 3 * MIN) // 1000, (T - 2 * MIN) // 1000, (T - MIN) // 1000, T // 1000, (T + MIN) // 1000]
        body = {"result": {"timestamp": stamps, "data": {"buy_volume": ["1"] * 5, "sell_volume": ["2"] * 5, "cvd": ["0"] * 5}}, "errors": []}

        class Response(io.BytesIO):
            pass

        def opener(request, timeout):
            self.assertIn("/PF_ETHUSD/cvd?since=", request.full_url)
            self.assertLessEqual(timeout, flujo.API_TIMEOUT_S)
            return Response(json.dumps(body).encode())

        # now = T + 3 s: el balde que cierra en T aún no está asentado (falta el margen de 5 s) y los de T y T+1 min son futuro
        got = flujo.leer_api(PRODUCT, "cvd", T - 10 * MIN, T, T + 3_000, opener=opener)
        self.assertEqual(sorted(got), [T - 3 * MIN, T - 2 * MIN])
        got = flujo.leer_api(PRODUCT, "cvd", T - 10 * MIN, T, T + 6_000, opener=opener)
        self.assertEqual(sorted(got), [T - 3 * MIN, T - 2 * MIN, T - MIN])


class Tabla(FlujoCase):
    def make_look_row(self, **kwargs):
        self.build(**kwargs)
        return aud._flow_row(PRODUCT, T, T + 10_000, self.market)

    def test_idempotente_y_conserva_la_primera_fila(self):
        row = self.make_look_row()
        with contextlib.closing(aud._open(self.live)) as db:
            with db:
                self.assertTrue(aud._record_flow(db, row))
            changed = dict(row, comprador_30m=-1.0, hueco=1)
            with db:
                self.assertFalse(aud._record_flow(db, changed))
            rows = db.execute("SELECT comprador_30m, hueco, version, bucket_ms FROM flujo_mirada").fetchall()
        self.assertEqual([tuple(r) for r in rows], [(30.0, 0, flujo.FLUJO_VERSION, T - aud.BUCKET_MS)])

    def test_las_tablas_viejas_no_cambian(self):
        # una base "de antes": el esquema y las tablas de entrenar SIN flujo_mirada, con una mirada guardada
        old_training = aud._TRAINING_SQL.split("-- Flujo de mercado")[0] + '"'
        path = aud.auditor_path(self.live)
        db = sqlite3.connect(path)
        db.executescript(aud._SCHEMA_SQL)
        db.executescript(old_training.rstrip('"'))
        db.execute("INSERT INTO meta VALUES('schema', ?)", (aud.SCHEMA_NAME,))
        db.commit()
        before = dict(db.execute("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall())
        self.assertNotIn("flujo_mirada", before)
        db.close()
        with contextlib.closing(aud._open(self.live)) as db:
            after = dict(db.execute("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall())
            columns = [r[1] for r in db.execute("PRAGMA table_info(flujo_mirada)")]
        self.assertEqual(set(after) - set(before), {"flujo_mirada"})
        for name, sql in before.items():
            if name == "miradas":
                continue                                               # ``_migrate`` ya sumaba ahí sus columnas de antes (direccion_*), no las de ahora
            self.assertEqual(after[name], sql, name)
        self.assertEqual(columns[:3], ["product", "bucket_ms", "t_ms"])
        self.assertEqual(sorted(columns), sorted(flujo.COLUMNS))
        # abrir de nuevo no cambia nada
        with contextlib.closing(aud._open(self.live)) as db:
            again = dict(db.execute("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall())
        self.assertEqual(again, after)


class EnLaMirada(FlujoCase):
    """El enganche en ``record_look``: el flujo se guarda junto a lo demás de la mirada y, falle lo que falle, la mirada sigue."""

    def setUp(self):
        super().setUp()
        from test_futures_auditor_entrenar import LookTrader, readings
        from test_futures_auditor import T0
        self.t0 = T0 - (T0 % (15 * MIN))
        self.live = os.path.join(self.tmp, "live.sqlite")
        self.trader = LookTrader(self.t0)
        self.trader.look_audit = {"t_ms": self.t0, "readings": readings(veredicto=2)}

    def record(self, market_db):
        return aud.record_look(self.live, PRODUCT, self.trader, [], self.t0 + MIN, market_db=market_db)

    def table(self, name):
        with contextlib.closing(sqlite3.connect(aud.auditor_path(self.live))) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute("SELECT * FROM {}".format(name))]

    def test_la_mirada_guarda_el_flujo_con_su_balde(self):
        self.build(t_ms=self.t0)
        out = self.record(self.market)
        self.assertEqual(out["avisos"], [])
        self.assertTrue(out["flujo"])
        (row,) = self.table("flujo_mirada")
        self.assertEqual((row["product"], row["bucket_ms"], row["t_ms"], row["hueco"]), (PRODUCT, self.t0 - aud.BUCKET_MS, self.t0, 0))
        self.assertEqual(row["comprador_30m"], 30.0)
        self.assertEqual(len(self.table("hechos_mirada")), 1)

    def test_repetir_la_mirada_no_duplica(self):
        self.build(t_ms=self.t0)
        self.record(self.market)
        self.record(self.market)
        self.assertEqual(len(self.table("flujo_mirada")), 1)

    def test_sin_captura_la_mirada_sigue_y_el_flujo_queda_con_hueco(self):
        out = self.record(os.path.join(self.tmp, "no-existe.sqlite"))
        self.assertEqual(out["avisos"], [])
        self.assertTrue(out["hechos"])
        (row,) = self.table("flujo_mirada")
        self.assertEqual(row["hueco"], 1)
        self.assertIsNone(row["comprador_4h"])

    def test_si_el_flujo_revienta_el_resto_de_la_mirada_se_guarda(self):
        with unittest_patch(flujo, "calcular", RuntimeError("roto")):
            out = self.record(self.market)
        self.assertTrue(out["hechos"])
        self.assertEqual(len(self.table("hechos_mirada")), 1)
        self.assertEqual(self.table("flujo_mirada")[0]["motivo_hueco"], "error:RuntimeError")

    def test_si_la_escritura_del_flujo_falla_el_resto_tambien_se_guarda(self):
        self.build(t_ms=self.t0)
        original = aud._record_flow

        def broken(db, row):
            raise sqlite3.OperationalError("disco lleno")
        aud._record_flow = broken
        try:
            out = self.record(self.market)
        finally:
            aud._record_flow = original
        self.assertTrue(out["hechos"])
        self.assertEqual(len(self.table("hechos_mirada")), 1)
        self.assertEqual(self.table("flujo_mirada"), [])
        self.assertTrue(any(a.startswith("flujo:") for a in out["avisos"]))


@contextlib.contextmanager
def unittest_patch(module, name, error):
    original = getattr(module, name)

    def boom(*args, **kwargs):
        raise error
    setattr(module, name, boom)
    try:
        yield
    finally:
        setattr(module, name, original)


if __name__ == "__main__":
    unittest.main()
