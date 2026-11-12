"""Laboratorio: API HTTP de la página Estrategias (listar, crear, comparar). Sin red ni bases; el comparador es un doble."""
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from balancita_engine import futures_estrategias as est
from balancita_engine import futures_estrategias_api as api
from balancita_engine import futures_estrategias_backtest as bt
from balancita_engine import futures_history as history
from balancita_engine import futures_qwen_trader as qt
from balancita_engine.futures_strategy_registry import StrategyRegistry, StrategyService, make_handler


def informe_falso(id, desde, hasta):
    return {"schema": bt.SCHEMA, "estrategia": {"id": id}, "ventana": {"desde": desde, "hasta": hasta, "reserva": {"incluida": False}},
            "oficial": {"metricas": {"operaciones": 3}}, "variante": {"metricas": {"operaciones": 4}}, "diferencia": {"operaciones": 1}}


class Comparador:
    """Doble de ``comparar``: recuerda cómo lo llamaron y puede quedarse esperando."""

    def __init__(self, espera=None, falla=None):
        self.llamadas, self.espera, self.falla = [], espera, falla

    def __call__(self, id, desde, hasta, **kw):
        self.llamadas.append(dict(kw, id=id, desde=desde, hasta=hasta))
        if self.espera:
            self.espera.wait(10)
        if self.falla:
            raise self.falla
        return informe_falso(id, desde, hasta)


class Servidor(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.carpeta = os.path.join(self.dir, "estrategias")
        os.makedirs(self.carpeta)
        self.comparador = Comparador()
        self.registry = StrategyRegistry(os.path.join(self.dir, "strategies.sqlite"))
        self.addCleanup(self.registry.close)
        service = StrategyService(self.registry, None, {})
        self.api = api.EstrategiasApi(carpeta=self.carpeta, comparador=self.comparador)
        service.estrategias = self.api
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service))
        self.base = "http://127.0.0.1:{}/api-strategies".format(self.server.server_address[1])
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.hash = est.cargar_snapshot()["config_hash"]

    def call(self, path, body=None, method=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": "application/json"}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def crear(self, **kw):
        cuerpo = {"nombre": "Tope a 30 horas", "descripcion": "Cierra antes.", "cambios": {"guardrails": {"max_hold_min": 1800}}}
        cuerpo.update(kw)
        return self.call("/estrategias", cuerpo)

    def archivos(self):
        return sorted(os.listdir(self.carpeta))

    def esperar(self, id, job_id, estados=("listo", "error")):
        limite = time.time() + 10
        while time.time() < limite:
            status, job = self.call("/estrategias/{}/comparar/{}".format(id, job_id))
            if job["estado"] in estados:
                return job
            time.sleep(0.02)
        self.fail("el trabajo no terminó")


class ListarTests(Servidor):
    def test_empty_list_has_the_snapshot_the_honest_window_and_only_the_allowed_knobs(self):
        status, out = self.call("/estrategias")
        self.assertEqual(status, 200)
        self.assertEqual(out["estrategias"], [])
        self.assertEqual(out["snapshot"]["config_hash"], self.hash)
        self.assertEqual(out["ventana_honesta"], {"desde": bt.DESDE_HONESTA, "hasta": bt.HASTA_HONESTA})
        self.assertEqual({p["clave"] for p in out["perillas"]}, set(est.PERILLAS_PERMITIDAS))
        por_clave = {p["clave"]: p for p in out["perillas"]}
        self.assertEqual(por_clave["guardrails.max_hold_min"]["valor_actual"], 2160)
        self.assertEqual((por_clave["guardrails.max_hold_min"]["minimo"], por_clave["guardrails.max_hold_min"]["maximo"]), (60, 10080))
        self.assertEqual(por_clave["guardrails.max_hold_min"]["tipo"], "entero")
        self.assertEqual(por_clave["wake.flat_every_min"]["paso"], 5)
        self.assertIsNone(por_clave["guardrails.stop_sigma_24h"]["valor_actual"])
        self.assertTrue(por_clave["guardrails.stop_sigma_24h"]["admite_null"])
        self.assertFalse([clave for clave in por_clave if clave.startswith(("posiciones.", "analista."))])   # el tamaño es fijo, como la Terminal
        self.assertNotIn("incluir_reserva", json.dumps(out))

    def test_lists_the_overlay_files_with_their_knob_changes(self):
        shutil.copy(os.path.join(est.ESTRATEGIAS_DIR, "ejemplo-salida-30h.json"), self.carpeta)
        status, out = self.call("/estrategias")
        (fila,) = out["estrategias"]
        self.assertEqual((fila["id"], fila["nombre"]), ("ejemplo-salida-30h", "Ejemplo: tope a 30 h"))
        self.assertEqual(fila["cambios"], {"guardrails": {"max_hold_min": 1800}})
        self.assertEqual(fila["base_config_hash"], self.hash)
        self.assertEqual(fila["overlay_sha256"], est.sha256_overlay("ejemplo-salida-30h", self.carpeta))
        self.assertIsNone(fila["error"])

    def test_a_broken_file_is_listed_with_its_error_and_does_not_break_the_list(self):
        shutil.copy(os.path.join(est.ESTRATEGIAS_DIR, "ejemplo-salida-30h.json"), self.carpeta)
        with open(os.path.join(self.carpeta, "mala.json"), "w") as handle:
            handle.write("{no es json")
        with open(os.path.join(self.carpeta, "vieja.json"), "w") as handle:
            json.dump({"id": "vieja", "nombre": "Vieja", "descripcion": "x", "base_config_hash": "0" * 64,
                       "cambios": {"guardrails": {"max_hold_min": 1800}}}, handle)
        status, out = self.call("/estrategias")
        self.assertEqual(status, 200)
        filas = {f["id"]: f for f in out["estrategias"]}
        self.assertEqual(set(filas), {"ejemplo-salida-30h", "mala", "vieja"})
        self.assertIsNone(filas["ejemplo-salida-30h"]["error"])
        self.assertIn("ilegible", filas["mala"]["error"])
        self.assertIn("base_config_hash", filas["vieja"]["error"])
        self.assertEqual(filas["vieja"]["cambios"], {"guardrails": {"max_hold_min": 1800}})


class CrearTests(Servidor):
    def test_creates_the_overlay_file_with_the_snapshot_hash(self):
        status, out = self.crear()
        self.assertEqual(status, 200)
        self.assertEqual(out["id"], "tope-a-30-horas")
        self.assertEqual(self.archivos(), ["tope-a-30-horas.json"])
        with open(os.path.join(self.carpeta, "tope-a-30-horas.json"), encoding="utf-8") as handle:
            doc = json.load(handle)
        self.assertEqual(doc, {"id": "tope-a-30-horas", "nombre": "Tope a 30 horas", "descripcion": "Cierra antes.",
                               "base_config_hash": self.hash, "cambios": {"guardrails": {"max_hold_min": 1800}}})
        config = est.cargar_estrategia("tope-a-30-horas", self.carpeta)           # el mismo cargador del backtest lo acepta
        self.assertEqual(config["guardrails"]["max_hold_min"], 1800)
        status, listado = self.call("/estrategias")
        self.assertEqual([f["id"] for f in listado["estrategias"]], ["tope-a-30-horas"])

    def test_explicit_id_is_used_and_must_be_slug_safe(self):
        status, out = self.crear(id="mi-variante-2")
        self.assertEqual((status, out["id"]), (200, "mi-variante-2"))
        for malo in ("Mayúsculas", "../escapa", "con espacio", "-empieza", "a" * 65, "", "a/b"):
            status, out = self.crear(id=malo)
            self.assertEqual(status, 400, malo)
            self.assertIn("id", out["detail"])
        self.assertEqual(self.archivos(), ["mi-variante-2.json"])

    def test_an_existing_id_is_never_overwritten(self):
        self.crear()
        with open(os.path.join(self.carpeta, "tope-a-30-horas.json"), "rb") as handle:
            antes = handle.read()
        status, out = self.crear(descripcion="Otra cosa.", cambios={"guardrails": {"max_hold_min": 900}})
        self.assertEqual(status, 409)
        self.assertEqual(out["error"], "estrategia_existe")
        self.assertIn("tope-a-30-horas", out["detail"])
        with open(os.path.join(self.carpeta, "tope-a-30-horas.json"), "rb") as handle:
            self.assertEqual(handle.read(), antes)
        self.assertEqual(self.archivos(), ["tope-a-30-horas.json"])

    def test_no_route_edits_or_deletes_an_existing_strategy(self):
        self.crear()
        with open(os.path.join(self.carpeta, "tope-a-30-horas.json"), "rb") as handle:
            antes = handle.read()
        for metodo in ("POST", "PUT", "DELETE", "PATCH"):
            request = urllib.request.Request(self.base + "/estrategias/tope-a-30-horas", method=metodo, headers={"Content-Type": "application/json"},
                                             data=json.dumps({"cambios": {"guardrails": {"max_hold_min": 900}}}).encode())
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request, timeout=30)
            self.assertIn(caught.exception.code, (404, 501), metodo)               # 404 de la ruta o 501 del servidor: nunca 2xx
        with open(os.path.join(self.carpeta, "tope-a-30-horas.json"), "rb") as handle:
            self.assertEqual(handle.read(), antes)

    def test_forbidden_knobs_are_refused_naming_the_key_and_nothing_is_written(self):
        casos = [({"corta": {"maestro": "x.json"}}, "corta.maestro"), ({"notional_usd": 5000}, "notional_usd"),
                 ({"products": ["PF_XBTUSD"]}, "products"), ({"corta": {"portero_autonomo": "y.json"}}, "corta.portero_autonomo"),
                 ({"execution": {"model": "x"}}, "execution.model"), ({"guardrails": {"max_hold_min": 1800, "otra": 1}}, "guardrails.otra")]
        for cambios, clave in casos:
            status, out = self.crear(cambios=cambios)
            self.assertEqual(status, 400, cambios)
            self.assertEqual(out["error"], "estrategia_invalida")
            self.assertIn(clave, out["detail"])
        self.assertEqual(self.archivos(), [])

    def test_invalid_values_are_refused_and_nothing_is_written(self):
        for cambios in ({"guardrails": {"max_hold_min": 5}}, {"guardrails": {"max_hold_min": "36"}}, {"guardrails": {"max_hold_min": True}},
                        {"guardrails": {"exhaust_hold_min": 3000}}, {"wake": {"flat_every_min": 7}}, {"rebotes": {"caida_pct": 150}},
                        {"posiciones": {"max": 2}}, {"posiciones": {"fraccion": 0.5}}, {"analista": {"modo": "suave"}}, {}, [], "x"):
            status, out = self.crear(cambios=cambios)
            self.assertEqual(status, 400, cambios)
            self.assertEqual(out["error"], "estrategia_invalida")
        self.assertEqual(self.archivos(), [])

    def test_name_and_description_are_required_and_unknown_fields_refused(self):
        for campo in ("nombre", "descripcion"):
            for valor in ("", "   ", None, 5):
                status, out = self.crear(**{campo: valor})
                self.assertEqual(status, 400, (campo, valor))
                self.assertIn(campo, out["detail"])
        status, out = self.crear(base_config_hash="0" * 64)
        self.assertEqual((status, out["error"]), (400, "campos_desconocidos"))
        self.assertIn("base_config_hash", out["detail"])
        self.assertEqual(self.archivos(), [])

    def test_a_name_that_gives_no_slug_needs_an_explicit_id(self):
        status, out = self.crear(nombre="¡¡¡")
        self.assertEqual(status, 400)
        self.assertIn("id", out["detail"])
        self.assertEqual(self.archivos(), [])


class CompararTests(Servidor):
    def setUp(self):
        super().setUp()
        self.crear()
        self.ruta = "/estrategias/tope-a-30-horas/comparar"

    def test_runs_in_a_job_with_the_honest_window_by_default_and_never_the_reserve(self):
        status, job = self.call(self.ruta, {})
        self.assertEqual(status, 200)
        self.assertEqual(job["estrategia_id"], "tope-a-30-horas")
        final = self.esperar("tope-a-30-horas", job["job_id"])
        self.assertEqual(final["estado"], "listo")
        self.assertEqual((final["desde"], final["hasta"]), (bt.DESDE_HONESTA, bt.HASTA_HONESTA))
        self.assertEqual(final["informe"]["variante"]["metricas"]["operaciones"], 4)
        (llamada,) = self.comparador.llamadas
        self.assertEqual((llamada["id"], llamada["desde"], llamada["hasta"]), ("tope-a-30-horas", bt.DESDE_HONESTA, bt.HASTA_HONESTA))
        self.assertIs(llamada["incluir_reserva"], False)
        self.assertEqual(llamada["carpeta"], self.carpeta)

    def test_a_custom_honest_window_is_passed_through(self):
        status, job = self.call(self.ruta, {"desde": "2026-02-10", "hasta": "2026-03-01"})
        final = self.esperar("tope-a-30-horas", job["job_id"])
        self.assertEqual((final["desde"], final["hasta"]), ("2026-02-10", "2026-03-01"))

    def test_the_reserve_can_never_be_used_from_the_api(self):
        reserva = qt.stamp(qt.load_holdout_ms())
        for cuerpo in ({"hasta": "2026-04-20"}, {"desde": "2026-04-10", "hasta": "2026-06-01"}, {"desde": reserva, "hasta": "2026-06-01"}):
            status, out = self.call(self.ruta, cuerpo)
            self.assertEqual(status, 400, cuerpo)
            self.assertEqual(out["error"], "ventana_invalida")
            self.assertIn("reserva", out["detail"])
            self.assertIn(reserva, out["detail"])
        for cuerpo in ({"incluir_reserva": True}, {"incluir_reserva": False}, {"incluir_reserva": 1, "hasta": "2026-06-01"}):
            status, out = self.call(self.ruta, cuerpo)
            self.assertEqual(status, 400, cuerpo)
            self.assertEqual(out["error"], "campos_desconocidos")
            self.assertIn("incluir_reserva", out["detail"])
        self.assertEqual(self.comparador.llamadas, [])

    def test_a_bad_window_is_refused_before_starting(self):
        for cuerpo in ({"desde": "2026-03-01", "hasta": "2026-02-01"}, {"desde": "ayer"}, {"hasta": "2026-02-30"}, {"desde": 5}):
            status, out = self.call(self.ruta, cuerpo)
            self.assertEqual((status, out["error"]), (400, "ventana_invalida"), cuerpo)
        self.assertEqual(self.comparador.llamadas, [])

    def test_unknown_strategy_is_404_and_a_stale_one_is_refused(self):
        status, out = self.call("/estrategias/no-existe/comparar", {})
        self.assertEqual((status, out["error"]), (404, "estrategia_no_existe"))
        status, out = self.call("/estrategias/Mal_Id/comparar", {})
        self.assertEqual(status, 400)
        with open(os.path.join(self.carpeta, "vieja.json"), "w") as handle:
            json.dump({"id": "vieja", "nombre": "V", "descripcion": "x", "base_config_hash": "0" * 64,
                       "cambios": {"guardrails": {"max_hold_min": 1800}}}, handle)
        status, out = self.call("/estrategias/vieja/comparar", {})
        self.assertEqual((status, out["error"]), (400, "estrategia_invalida"))
        self.assertEqual(self.comparador.llamadas, [])

    def test_the_job_is_visible_while_running_and_only_one_runs_at_a_time(self):
        self.comparador.espera = threading.Event()
        status, job = self.call(self.ruta, {})
        estado = self.esperar("tope-a-30-horas", job["job_id"], ("corriendo",))
        self.assertEqual(estado["estado"], "corriendo")
        self.assertIsNone(estado["informe"])
        status, ultimo = self.call(self.ruta)
        self.assertEqual((status, ultimo["job_id"]), (200, job["job_id"]))
        status, otro = self.call(self.ruta, {})
        self.assertEqual((status, otro["error"]), (409, "comparacion_en_curso"))
        self.comparador.espera.set()
        self.assertEqual(self.esperar("tope-a-30-horas", job["job_id"])["estado"], "listo")
        status, nuevo = self.call(self.ruta, {})
        self.assertEqual(status, 200)
        self.assertNotEqual(nuevo["job_id"], job["job_id"])
        self.esperar("tope-a-30-horas", nuevo["job_id"])

    def test_a_failure_in_the_comparison_is_reported_in_the_job(self):
        self.comparador.falla = bt.ComparacionError("La config no deja medir nada.")
        status, job = self.call(self.ruta, {})
        final = self.esperar("tope-a-30-horas", job["job_id"])
        self.assertEqual(final["estado"], "error")
        self.assertIn("La config no deja medir nada.", final["error"])
        self.assertIsNone(final["informe"])
        self.comparador.falla = None                                        # tras un error se puede volver a intentar
        status, job = self.call(self.ruta, {})
        self.assertEqual(self.esperar("tope-a-30-horas", job["job_id"])["estado"], "listo")

    def test_job_lookups(self):
        status, out = self.call(self.ruta)
        self.assertEqual((status, out["error"]), (404, "sin_comparacion"))
        status, out = self.call(self.ruta + "/inexistente")
        self.assertEqual((status, out["error"]), (404, "trabajo_no_existe"))
        status, job = self.call(self.ruta, {})
        self.esperar("tope-a-30-horas", job["job_id"])
        self.crear(id="otra", nombre="Otra")
        status, out = self.call("/estrategias/otra/comparar/{}".format(job["job_id"]))
        self.assertEqual((status, out["error"]), (404, "trabajo_no_existe"))


HORA, DIA = 3_600_000, 86_400_000
CINCO = 5 * 60_000


def sembrar_velas(cache_dir, producto, tramos):
    """Escribe velas de 5 m en la caché como lo hace el trader. Vela i del tramo: open 100+i, high open+5, low open-5, close open+1, volumen 1."""
    cache = history.CandleCache(os.path.join(cache_dir, "candles-{}.sqlite".format(producto)))
    try:
        filas = []
        for desde, hasta in tramos:
            for i, t in enumerate(range(desde, hasta, CINCO)):
                abre = 100 + i
                filas.append(("5m", t, str(abre), str(abre + 5), str(abre - 5), str(abre + 1), "1"))
        with cache.db:
            cache.db.executemany("INSERT OR REPLACE INTO candles VALUES(?,?,?,?,?,?,?)", filas)
    finally:
        cache.close()


class VelasTests(Servidor):
    """``GET estrategias/velas/<producto>/<intervalo>/<desde_ms>/<hasta_ms>/<antes_ms>/<limite>``.

    ``[desde_ms, hasta_ms)`` es la ventana PROBADA de la comparación (la del informe): nada fuera de ella se sirve, y ``hasta_ms`` nunca pasa
    de la reserva. ``antes_ms`` es el cursor de paginación (velas anteriores a él); ``limite`` cuenta las más nuevas. Velas de la caché que
    leyó el backtest."""

    def setUp(self):
        super().setUp()
        self.cache = os.path.join(self.dir, "cache")
        self.desde = qt.date_ms(bt.DESDE_HONESTA)
        self.reserva = qt.load_holdout_ms()
        sembrar_velas(self.cache, "PF_ETHUSD", [(self.desde - 2 * DIA, self.desde + 2 * DIA), (self.reserva - 2 * DIA, self.reserva + 2 * DIA)])
        self.api.cache_dir = self.cache

    def velas(self, intervalo="1h", desde=None, hasta=None, antes=None, limite=100, producto="PF_ETHUSD"):
        desde = self.desde if desde is None else desde
        hasta = self.reserva if hasta is None else hasta
        antes = hasta if antes is None else antes
        return self.call("/estrategias/velas/{}/{}/{}/{}/{}/{}".format(producto, intervalo, desde, hasta, antes, limite))

    def test_one_hour_candle_aggregates_twelve_5m_candles(self):
        status, out = self.velas("1h", limite=2)
        self.assertEqual(status, 200)
        self.assertEqual((out["producto"], out["intervalo"]), ("PF_ETHUSD", "1h"))
        self.assertEqual([v["t"] for v in out["velas"]], [self.reserva - 2 * HORA, self.reserva - HORA])
        # la última hora antes de la reserva son las 12 últimas velas del segundo tramo (i = 564..575)
        self.assertEqual(out["velas"][-1], {"t": self.reserva - HORA, "o": 100.0 + 564, "h": 100.0 + 575 + 5, "l": 100.0 + 564 - 5,
                                            "c": 100.0 + 575 + 1, "v": 12.0})

    def test_every_interval_buckets_on_utc_boundaries(self):
        for intervalo, paso in (("5m", 5 * 60_000), ("15m", 15 * 60_000), ("1h", HORA), ("4h", 4 * HORA), ("1d", DIA)):
            status, out = self.velas(intervalo, limite=2)
            self.assertEqual(status, 200, intervalo)
            self.assertEqual(len(out["velas"]), 2, intervalo)
            self.assertTrue(all(v["t"] % paso == 0 for v in out["velas"]), intervalo)
            self.assertEqual(out["velas"][-1]["t"], self.reserva - paso, intervalo)
            self.assertEqual(out["velas"][-1]["v"], paso / CINCO, intervalo)

    def test_the_reserve_is_refused_as_the_end_of_the_window_and_never_served(self):
        for hasta in (self.reserva + 1, self.reserva + 3 * DIA, self.reserva + 10**13):
            status, out = self.velas("1h", hasta=hasta, limite=5000)
            self.assertEqual((status, out["error"]), (400, "ventana_invalida"))
            self.assertIn("reserva", out["detail"])
            self.assertNotIn("velas", out)
        status, out = self.velas("1h", hasta=self.reserva, antes=self.reserva + 3 * DIA, limite=5000)     # el cursor se recorta al fin
        self.assertEqual(status, 200)
        self.assertEqual(out["hasta_ms"], self.reserva)
        self.assertTrue(all(v["t"] + HORA <= self.reserva for v in out["velas"]))

    def test_the_last_candle_of_the_window_is_the_one_that_closes_at_its_end(self):
        fin = self.reserva - 3 * HORA
        for intervalo, paso in (("1h", HORA), ("15m", 15 * 60_000)):
            _, out = self.velas(intervalo, hasta=fin, limite=5000)
            self.assertEqual(out["velas"][-1]["t"], fin - paso, intervalo)
            self.assertTrue(all(v["t"] + paso <= fin for v in out["velas"]), intervalo)

    def test_nothing_before_the_start_of_the_tested_window_is_served(self):
        inicio = self.reserva - 2 * DIA + 90 * 60_000                  # 01:30: ni 1 h ni 1 d empiezan ahí
        _, una_hora = self.velas("1h", desde=inicio, limite=5000)
        self.assertEqual(una_hora["desde_ms"], self.reserva - 2 * DIA + 2 * HORA)
        self.assertEqual(una_hora["velas"][0]["t"], self.reserva - 2 * DIA + 2 * HORA)
        self.assertFalse(una_hora["hay_mas"])
        _, un_dia = self.velas("1d", desde=inicio, limite=5000)
        self.assertEqual([v["t"] for v in un_dia["velas"]], [self.reserva - DIA])
        _, cuatro_horas = self.velas("4h", desde=inicio, limite=5000)
        self.assertEqual(cuatro_horas["velas"][0]["t"], self.reserva - 2 * DIA + 4 * HORA)
        _, quince = self.velas("15m", desde=inicio, limite=5000)
        self.assertEqual(quince["velas"][0]["t"], self.reserva - 2 * DIA + 90 * 60_000)

    def test_the_start_of_the_window_wins_over_the_cache_that_has_older_candles(self):
        # la caché tiene velas desde dos días antes de la ventana honesta: no salen
        status, out = self.velas("1h", hasta=self.desde + DIA, limite=5000)
        self.assertEqual(status, 200)
        self.assertEqual(out["velas"][0]["t"], self.desde)
        self.assertEqual(len(out["velas"]), 24)
        self.assertFalse(out["hay_mas"])
        status, out = self.velas("1h", hasta=self.desde + DIA, antes=self.desde, limite=5000)     # cursor en el inicio: nada más atrás
        self.assertEqual((status, out["velas"], out["hay_mas"]), (200, [], False))

    def test_limit_keeps_the_newest_candles_and_paging_back_is_contiguous(self):
        _, primera = self.velas("1h", limite=3)
        self.assertEqual(len(primera["velas"]), 3)
        self.assertTrue(primera["hay_mas"])
        _, previa = self.velas("1h", antes=primera["velas"][0]["t"], limite=3)
        self.assertEqual([v["t"] for v in previa["velas"]] + [v["t"] for v in primera["velas"]],
                         [self.reserva - k * HORA for k in range(6, 0, -1)])

    def test_an_unaligned_end_only_serves_complete_candles(self):
        status, out = self.velas("1h", hasta=self.reserva - HORA // 2, limite=2)
        self.assertEqual(status, 200)
        self.assertEqual(out["velas"][-1]["t"], self.reserva - 2 * HORA)
        self.assertEqual(out["hasta_ms"], self.reserva - HORA)

    def test_a_cursor_outside_the_window_answers_empty_not_an_error(self):
        status, out = self.velas("1h", antes=self.desde - DIA, limite=10)
        self.assertEqual((status, out["velas"], out["hay_mas"]), (200, [], False))

    def test_bad_parameters_are_400_with_a_clear_message(self):
        casos = (
            (self.velas("2h"), "intervalo_invalido", "15m"),
            (self.velas("1h", limite=0), "limite_invalido", "5000"),
            (self.velas("1h", limite=5001), "limite_invalido", "5000"),
            (self.velas("1h", limite="mucho"), "limite_invalido", "entero"),
            (self.velas("1h", desde="ayer"), "desde_invalido", "milisegundos"),
            (self.velas("1h", hasta="ayer"), "hasta_invalido", "milisegundos"),
            (self.velas("1h", hasta=-5), "hasta_invalido", "milisegundos"),
            (self.velas("1h", antes="x"), "antes_invalido", "milisegundos"),
            (self.velas("1h", desde=self.reserva - DIA, hasta=self.reserva - DIA), "ventana_invalida", "anterior"),
            (self.velas("1h", desde=self.reserva - DIA, hasta=self.reserva - 2 * DIA), "ventana_invalida", "anterior"),
            (self.velas("1h", producto="..%2Fx"), "producto_invalido", "PF_"),
            (self.velas("1h", producto="ETH"), "producto_invalido", "PF_"),
        )
        for (status, out), codigo, pista in casos:
            self.assertEqual((status, out["error"]), (400, codigo))
            self.assertIn(pista, out["detail"])
        self.assertEqual(self.call("/estrategias/velas/PF_ETHUSD/1h")[0], 404)

    def test_a_product_without_candles_is_404_and_nothing_is_created(self):
        antes = sorted(os.listdir(self.cache))
        status, out = self.velas("1h", producto="PF_SOLUSD")
        self.assertEqual((status, out["error"]), (404, "sin_velas"))
        self.assertEqual(sorted(os.listdir(self.cache)), antes)

    def test_the_other_estrategias_routes_are_unchanged(self):
        self.assertEqual(self.call("/estrategias")[0], 200)
        self.assertEqual(self.call("/estrategias/no-existe/comparar")[0], 404)


class VentanaTests(unittest.TestCase):
    def test_a_window_ending_exactly_at_the_reserve_is_allowed_and_one_day_more_is_not(self):
        reserva = qt.load_holdout_ms()
        self.assertEqual(bt.validar_ventana("2026-04-10", qt.stamp(reserva)), (qt.date_ms("2026-04-10"), reserva))
        with self.assertRaises(bt.ComparacionError) as caught:
            bt.validar_ventana("2026-04-10", qt.stamp(reserva + qt.DAY_MS))
        self.assertNotIn("--incluir-reserva", str(caught.exception))


class ConservaTests(Servidor):
    def test_the_old_registry_routes_keep_answering(self):
        status, out = self.call("/health")
        self.assertEqual((status, out["status"]), (200, "ok"))
        status, out = self.call("/strategies")
        self.assertEqual(status, 200)
        self.assertIn("strategies", out)
        status, out = self.call("/no-existe")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
