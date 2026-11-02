"""Archivo Parquet (fase 2): tablas de puntajes de pronostico, posicionamiento y noticias (dia o mes), grupos de filas chicos que dejan saltar
bloques, y restaurar-prueba con relectura completa. Datos sinteticos. Se SALTA si pyarrow no esta instalado."""
import contextlib
import dataclasses
import io
import os
import random
import re
import shutil
import sqlite3
import tempfile
import time
import unittest
from unittest import mock

from archivo_parquet import cli, formato, respaldo, sintetico
from archivo_parquet.config import DAY_MS, GRUPO_PESADO, TABLAS
from archivo_parquet.exportar import exportar
from archivo_parquet.leer import buscar_archivo, consulta_duckdb
from archivo_parquet.util import dia_de, inicio_dia_ms, leer_manifiesto
from archivo_parquet.verificar import verificar
from test_archivo_parquet_respaldo import RemotoFalso

DIA0 = inicio_dia_ms(dia_de(1_700_000_000_000))  # 2023-11-14
NUEVAS = ("forecasts", "forecast_returns", "forecast_barriers", "forecast_excursions", "positioning", "premium", "news_items", "news_analysis")
MENSUALES = ("positioning", "premium", "news_items", "news_analysis")


class ConfigTests(unittest.TestCase):
    def test_tablas_nuevas_y_granularidad(self):
        for t in NUEVAS:
            self.assertIn(t, TABLAS)
            self.assertEqual(TABLAS[t].granularidad, "mes" if t in MENSUALES else "dia", t)
        self.assertEqual([t for t in TABLAS if TABLAS[t].filas_por_grupo], ["verdicts", "llm_decisions", "market_events", "news_items", "news_analysis"])
        self.assertTrue(all(TABLAS[t].filas_por_grupo == GRUPO_PESADO == 2000 for t in ("verdicts", "llm_decisions", "market_events")))
        with self.assertRaises(ValueError):
            dataclasses.replace(TABLAS["verdicts"], granularidad="semana")
        self.assertIsNone(TABLAS["news_items"].producto)

    def test_duckdb_mensual_sin_carpeta_dia(self):
        q = consulta_duckdb("/a", "b", "positioning", DIA0, DIA0 + DAY_MS)
        self.assertIn("anio=*/mes=*/part-*.parquet", q)
        self.assertNotIn("dia=", q)


@unittest.skipUnless(formato.disponible(), "pyarrow no esta instalado (entorno aparte, ver docs/archivo-parquet.md)")
class TablasNuevasTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        os.makedirs(os.path.join(self.tmp.name, "snapshots"))
        self.copia = os.path.join(self.tmp.name, "snapshots", "c.sqlite")
        self.destino = os.path.join(self.tmp.name, "archivo")

    def crea(self, dia0, dias):
        return sintetico.crear_copia_fase2(self.copia, dia0, dias, paso_ms=30 * 60_000)

    def exp(self, ahora, **kw):
        return exportar(self.copia, "futures-x", self.destino, ahora_ms=ahora, **kw)

    def test_cada_tabla_se_exporta_verifica_y_coincide_con_sqlite(self):
        filas = self.crea(DIA0, 3)
        r = self.exp(DIA0 + 40 * DAY_MS)
        self.assertEqual((r["no_confirmados"], sorted(r["tablas_ausentes"])), ([], ["llm_decisions", "market_events", "verdicts"]))
        self.assertEqual(verificar(self.destino)["problemas"], [])
        entradas = leer_manifiesto(self.destino)
        con = sqlite3.connect("file:%s?mode=ro" % self.copia, uri=True)
        for t in NUEVAS:
            cfg = TABLAS[t]
            es = [e for e in entradas if e["tabla"] == t]
            # 3 dias en un mes (14-16 nov): 3 archivos diarios o 1 mensual
            self.assertEqual(len(es), 1 if t in MENSUALES else 3, t)
            self.assertEqual(sum(e["filas"] for e in es), filas[t], t)
            self.assertTrue(all(e["granularidad"] == cfg.granularidad for e in es))
            if t in MENSUALES:
                self.assertRegex(es[0]["ruta"], r"^futures-x/%s/anio=2023/mes=11/part-[0-9a-f]{8}\.parquet$" % t)
                self.assertEqual(es[0]["dia"], "2023-11-01")
            else:
                self.assertRegex(es[0]["ruta"], r"/anio=2023/mes=11/dia=1\d/part-")
            cols = ", ".join(cfg.nombres)
            orden = ", ".join(cfg.clave)
            esperado = [tuple(f) for f in con.execute("SELECT %s FROM %s ORDER BY %s" % (cols, cfg.sqlite, orden))]
            tabla, _ = buscar_archivo(self.destino, "futures-x", t, 0, 1 << 62)
            obtenido = sorted((tuple(f[c] for c in cfg.nombres) for f in tabla.to_pylist()),
                              key=lambda f: tuple(f[cfg.nombres.index(c)] for c in cfg.clave))
            self.assertEqual(obtenido, esperado, t)
        con.close()

    def test_mensual_espera_mes_cerrado_mas_un_dia(self):
        self.crea(inicio_dia_ms(dia_de(1_701_302_400_000)) - DAY_MS, 3)  # 29 nov .. 1 dic 2023: noviembre y diciembre
        dic1 = inicio_dia_ms(dia_de(1_701_388_800_000))
        self.assertEqual(dia_de(dic1).isoformat(), "2023-12-01")
        casi = self.exp(dic1 + DAY_MS - 1, tablas=["positioning"])
        self.assertEqual((casi["exportados"], len(casi["pendientes_por_abrir"])), ([], 2))
        r = self.exp(dic1 + DAY_MS, tablas=["positioning"])
        self.assertEqual([e["dia"] for e in r["exportados"]], ["2023-11-01"])
        self.assertEqual([p["dia"] for p in r["pendientes_por_abrir"]], ["2023-12-01"])
        r = self.exp(dic1 + 32 * DAY_MS, tablas=["positioning"])  # enero 2024 ya paso el margen
        self.assertEqual([e["dia"] for e in r["exportados"]], ["2023-12-01"])
        self.assertEqual(self.exp(dic1 + 32 * DAY_MS, tablas=["positioning"])["exportados"], [])  # idempotente
        # el 1 dic cae en el mes de diciembre
        t, _ = buscar_archivo(self.destino, "futures-x", "positioning", dic1, dic1 + 1, producto="PF_XBTUSD")
        self.assertEqual(t.num_rows, 1)

    def test_nulos_se_conservan(self):
        self.crea(DIA0, 1)
        self.exp(DIA0 + 40 * DAY_MS, tablas=["news_items", "news_analysis", "positioning"])
        t, _ = buscar_archivo(self.destino, "futures-x", "news_items", 0, 1 << 62)
        self.assertIn(None, t.column("published_at").to_pylist())
        t, _ = buscar_archivo(self.destino, "futures-x", "news_analysis", 0, 1 << 62, donde={"status": "skipped_stale"})
        self.assertTrue(t.num_rows and set(t.column("chosen").to_pylist()) == {None})
        t, _ = buscar_archivo(self.destino, "futures-x", "positioning", 0, 1 << 62)
        self.assertIn(None, t.column("long_percent").to_pylist())

    def test_cli_exportar_tabla_mensual(self):
        self.crea(DIA0, 2)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["exportar", "--copia", self.copia, "--base", "futures-x", "--destino", self.destino, "--tablas", "news_items"]), 0)
            self.assertEqual(cli.main(["verificar", "--destino", self.destino]), 0)
        self.assertEqual([e["tabla"] for e in leer_manifiesto(self.destino)], ["news_items"])


@unittest.skipUnless(formato.disponible(), "pyarrow no esta instalado (entorno aparte, ver docs/archivo-parquet.md)")
class GruposChicosTests(unittest.TestCase):
    """Con grupos de ~2000 filas pesadas, buscar un producto en 1 hora lee una fraccion de los bytes (las estadisticas saltan bloques)."""

    PRODUCTOS = 8
    POR_PRODUCTO = 1200  # 1 fila por minuto, 20 horas
    PAYLOAD = 1000

    def _escribe(self, carpeta, cfg):
        rng = random.Random(3)
        filas = []
        for i in range(self.PRODUCTOS):
            p = "PF_P%02d" % i
            for k in range(self.POR_PRODUCTO):
                b = DIA0 + k * 60_000
                payload = "".join(rng.choice("0123456789abcdef") for _ in range(self.PAYLOAD))  # incompresible a proposito
                filas.append((p, b, 60_000, b + 63_000, "range", "HOLD", "no_edge", "h-%s-%d" % (p, b), payload, b + 64_000))
        filas.sort()
        ruta = os.path.join(carpeta, "d.parquet")
        formato.escribir(ruta, cfg, iter([filas[i:i + 3000] for i in range(0, len(filas), 3000)]), {"schema_version": 1})
        return ruta

    def test_busqueda_de_una_hora_salta_grupos_y_bytes(self):
        base = TABLAS["verdicts"]
        self.assertEqual(formato.filas_por_grupo(base), 2000)
        grande = dataclasses.replace(base, filas_por_grupo=1_000_000)  # como la fase 1: todo el dia en 1 grupo
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "a")), os.makedirs(os.path.join(tmp, "b"))
            chico_r, grande_r = self._escribe(os.path.join(tmp, "a"), base), self._escribe(os.path.join(tmp, "b"), grande)
            self.assertEqual(formato.metadatos(chico_r)["grupos"], 5)  # 9600 filas / 2000
            self.assertEqual(formato.metadatos(grande_r)["grupos"], 1)
            h0 = DIA0 + 10 * 3_600_000
            res = {}
            for nombre, ruta in (("chico", chico_r), ("grande", grande_r)):
                tiempos = []
                for _ in range(3):
                    t0 = time.perf_counter()
                    tabla, inf = formato.buscar([ruta], base, h0, h0 + 3_600_000, producto="PF_P05")
                    tiempos.append(time.perf_counter() - t0)
                self.assertEqual(tabla.num_rows, 60)
                res[nombre] = (inf, min(tiempos))
            chico, grande_inf = res["chico"][0], res["grande"][0]
            self.assertEqual(grande_inf["grupos_leidos"], 1)
            self.assertLessEqual(chico["grupos_leidos"], 2)
            self.assertLess(chico["grupos_leidos"], chico["grupos_total"])
            self.assertLess(chico["bytes_leidos"], 0.5 * grande_inf["bytes_leidos"])
            # el tiempo no se afirma (depende de la maquina); se deja a la vista
            print("\n  1 hora de un producto: grupos %d de %d, %d bytes (1 grupo: %d bytes); %.1f ms contra %.1f ms"
                  % (chico["grupos_leidos"], chico["grupos_total"], chico["bytes_leidos"], grande_inf["bytes_leidos"],
                     res["chico"][1] * 1000, res["grande"][1] * 1000))

    def test_el_exportador_usa_el_tamano_de_grupo_de_la_tabla(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "snapshots"))
            copia = os.path.join(tmp, "snapshots", "c.sqlite")
            sintetico.crear_copia(copia, DIA0, 1, ("PF_XBTUSD", "PF_ETHUSD"), 15_000, ("verdicts",))  # 2 x 5760 = 11520 filas
            r = exportar(copia, "b", os.path.join(tmp, "a"), ahora_ms=DIA0 + 10 * DAY_MS)
            self.assertEqual(r["no_confirmados"], [])
            self.assertEqual(leer_manifiesto(os.path.join(tmp, "a"))[0]["grupos_filas"], 6)  # ceil(11520 / 2000)


@unittest.skipUnless(formato.disponible(), "pyarrow no esta instalado (entorno aparte, ver docs/archivo-parquet.md)")
class RestaurarConParquetTests(unittest.TestCase):
    def test_respaldar_y_restaurar_prueba_con_relectura_completa(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "snapshots"))
            copia = os.path.join(tmp, "snapshots", "c.sqlite")
            sintetico.crear_copia_fase2(copia, DIA0, 2, paso_ms=30 * 60_000)
            destino, remoto = os.path.join(tmp, "a"), os.path.join(tmp, "r")
            exportar(copia, "futures-x", destino, ahora_ms=DIA0 + 40 * DAY_MS)
            rem = RemotoFalso(remoto)
            rep = respaldo.respaldar(destino, "falso:archivo", runner=rem)
            self.assertEqual(respaldo.codigo_salida(rep), 0)
            for dia in ("2023-11-14", "2023-11-01"):
                r = respaldo.restaurar_prueba(destino, "falso:archivo", dia=dia, runner=rem)
                self.assertEqual((r["problemas"], r["relectura"]), ([], "completa"), dia)
                self.assertTrue(r["archivos"])
            # un Parquet danado en el remoto (mismo tamano) se detecta
            e = [x for x in leer_manifiesto(destino) if x["tabla"] == "positioning"][0]
            ruta = os.path.join(remoto, e["ruta"])
            with open(ruta, "r+b") as fh:
                fh.seek(e["bytes"] // 2)
                fh.write(b"\x00\x01\x02\x03")
            r = respaldo.restaurar_prueba(destino, "falso:archivo", dia="2023-11-01", tabla="positioning", runner=rem)
            self.assertTrue(r["problemas"])


if __name__ == "__main__":
    unittest.main()
