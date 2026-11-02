"""Archivo Parquet (fase 1): exportar, verificar, leer, buscar y medir sobre SQLite sintetica temporal. Se SALTA si pyarrow no esta instalado
(igual que #248: dependencia opcional fijada con hashes, entorno aparte)."""
import contextlib
import hashlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from archivo_parquet import cli, formato, sintetico
from archivo_parquet.config import DAY_MS, TABLAS
from archivo_parquet.exportar import exportar
from archivo_parquet.leer import buscar_archivo, leer_archivo
from archivo_parquet.medir import medir
from archivo_parquet.util import dia_de, inicio_dia_ms, leer_manifiesto
from archivo_parquet.verificar import verificar

DIA0 = inicio_dia_ms(dia_de(1_700_000_000_000))
AHORA_DIA0 = DIA0 + 3 * DAY_MS - 1  # solo el dia 0 esta cerrado con margen
AHORA_TODO = DIA0 + 10 * DAY_MS


def sha(ruta):
    with open(ruta, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


@unittest.skipUnless(formato.disponible(), "pyarrow no esta instalado (entorno aparte, ver docs/archivo-parquet.md)")
class ArchivoParquetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        os.makedirs(os.path.join(self.tmp.name, "snapshots"))
        self.copia = os.path.join(self.tmp.name, "snapshots", "c.sqlite")
        self.destino = os.path.join(self.tmp.name, "archivo")
        self.filas = sintetico.crear_copia(self.copia, DIA0, 2, ("PF_XBTUSD", "PF_ETHUSD"), 120_000,
                                           ("verdicts", "llm_decisions", "market_events"))

    def exp(self, ahora, **kw):
        return exportar(self.copia, "futures-verdicts", self.destino, ahora_ms=ahora, **kw)

    def test_exporta_solo_dias_cerrados_y_es_idempotente(self):
        antes = sha(self.copia)
        r1 = self.exp(AHORA_DIA0)
        self.assertEqual(r1["no_confirmados"], [])
        self.assertEqual(sorted(e["tabla"] for e in r1["exportados"]), ["llm_decisions", "market_events", "verdicts"])
        self.assertEqual({e["dia"] for e in r1["exportados"]}, {dia_de(DIA0).isoformat()})
        self.assertEqual(len(r1["pendientes_por_abrir"]), 3)
        r2 = self.exp(AHORA_DIA0)
        self.assertEqual(r2["exportados"], [])
        self.assertEqual(len(r2["ya_confirmados"]), 3)
        r3 = self.exp(AHORA_TODO)
        self.assertEqual(len(r3["exportados"]), 3)
        self.assertEqual(len(leer_manifiesto(self.destino)), 6)
        self.assertEqual(sha(self.copia), antes, "la copia no se toca")
        self.assertEqual(verificar(self.destino)["problemas"], [])

    def test_formato_y_manifiesto(self):
        self.exp(AHORA_TODO, tablas=["verdicts"])
        e = [x for x in leer_manifiesto(self.destino) if x["dia"] == dia_de(DIA0).isoformat()][0]
        self.assertRegex(e["ruta"], r"^futures-verdicts/verdicts/anio=2023/mes=11/dia=14/part-[0-9a-f]{8}\.parquet$")
        self.assertEqual(e["sha256"][:8], e["ruta"][-16:-8])
        self.assertEqual(e["filas"], 1440 // 2 * 2)
        self.assertEqual(e["clave_min"], ["PF_ETHUSD", DIA0])
        self.assertEqual((e["producto_min"], e["producto_max"]), ("PF_ETHUSD", "PF_XBTUSD"))
        self.assertEqual((e["tiempo_min"], e["tiempo_max"]), (DIA0, DIA0 + DAY_MS - 120_000))
        info = formato.metadatos(os.path.join(self.destino, e["ruta"]))
        self.assertEqual(info["schema"]["schema_version"], "1")
        self.assertEqual(info["compresion"], "zstd")
        self.assertTrue(info["estadisticas"])
        self.assertFalse([f for _, _, fs in os.walk(self.destino) for f in fs if f.endswith(".tmp")])

    def test_payload_json_sin_reinterpretar_y_orden(self):
        self.exp(AHORA_TODO, tablas=["verdicts"])
        con = sqlite3.connect("file:%s?mode=ro" % self.copia, uri=True)
        esperado = con.execute("SELECT * FROM paper_futures_verdicts WHERE bucket_start >= ? AND bucket_start < ? ORDER BY product_id, bucket_start",
                               (DIA0, DIA0 + DAY_MS)).fetchall()
        con.close()
        t = leer_archivo(self.destino, "futures-verdicts", "verdicts", DIA0, DIA0 + DAY_MS)
        got = [tuple(f[c] for c in TABLAS["verdicts"].nombres) for f in t.to_pylist()]
        self.assertEqual(got, esperado)

    def test_diferencia_no_promueve_y_sale_distinto_de_cero(self):
        original = formato.escribir

        def recorta(ruta, cfg, lotes, meta):
            def sin_ultima():
                previo = None
                for lote in lotes:
                    if previo is not None:
                        yield previo
                    previo = lote
                if previo:
                    yield previo[:-1]
            return original(ruta, cfg, sin_ultima(), meta)

        with mock.patch.object(formato, "escribir", recorta):
            r = self.exp(AHORA_DIA0, tablas=["verdicts"])
        self.assertEqual(len(r["no_confirmados"]), 1)
        self.assertEqual(r["exportados"], [])
        self.assertEqual(leer_manifiesto(self.destino), [])
        self.assertEqual([f for _, _, fs in os.walk(self.destino) for f in fs], [])
        # y se rehace limpio despues
        self.assertEqual(len(self.exp(AHORA_DIA0, tablas=["verdicts"])["exportados"]), 1)

    def test_cli_codigos_de_salida(self):
        base = ["exportar", "--copia", self.copia, "--base", "b", "--destino", self.destino, "--tablas", "verdicts"]
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(base + ["--dry-run"]), 0)
            self.assertFalse(os.path.exists(self.destino))
            self.assertEqual(cli.main(["exportar", "--copia", "/server/data/dev-live/x.sqlite", "--base", "b", "--destino", self.destino]), 2)
            self.assertEqual(cli.main(base), 0)  # con el reloj real, 2023 ya esta cerrado
            self.assertEqual(len(leer_manifiesto(self.destino)), 2)
            self.assertEqual(cli.main(["verificar", "--destino", self.destino]), 0)

    def test_verificar_detecta_cambios(self):
        self.exp(AHORA_TODO, tablas=["verdicts"])
        e = leer_manifiesto(self.destino)[0]
        ruta = os.path.join(self.destino, e["ruta"])
        with open(ruta, "rb") as fh:
            data = bytearray(fh.read())
        data[len(data) // 2] ^= 0xFF
        with open(ruta, "wb") as fh:
            fh.write(bytes(data))
        r = verificar(self.destino)
        self.assertEqual([p["ruta"] for p in r["problemas"]], [e["ruta"]])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["verificar", "--destino", self.destino]), 1)
        os.remove(ruta)
        self.assertIn("no existe", verificar(self.destino)["problemas"][0]["problema"])

    def test_buscar_usa_el_catalogo_y_salta_grupos(self):
        with mock.patch.object(formato, "FILAS_POR_GRUPO", 500):
            self.exp(AHORA_TODO, tablas=["verdicts"])
        total, dia0 = DIA0 + 2 * DAY_MS, DIA0
        _, rep = buscar_archivo(self.destino, "futures-verdicts", "verdicts", dia0, dia0 + DAY_MS)
        self.assertEqual((rep["archivos_en_catalogo"], rep["archivos_elegidos"]), (2, 1))
        t, rep = buscar_archivo(self.destino, "futures-verdicts", "verdicts", dia0 + 3_600_000, dia0 + 7_200_000, producto="PF_XBTUSD")
        self.assertEqual(t.num_rows, 30)
        self.assertEqual(set(t.column("product_id").to_pylist()), {"PF_XBTUSD"})
        self.assertLess(rep["grupos_leidos"], rep["grupos_total"])
        # producto fuera de todos los rangos: el catalogo no elige ningun archivo
        t, rep = buscar_archivo(self.destino, "futures-verdicts", "verdicts", dia0, total, producto="ZZZ")
        self.assertEqual((t.num_rows, rep["archivos_elegidos"]), (0, 0))
        # columna/valor, columnas y limite
        t, _ = buscar_archivo(self.destino, "futures-verdicts", "verdicts", dia0, total, donde={"action": "LONG"}, columnas=["action", "bucket_start"],
                              limite=5)
        self.assertEqual(t.column_names, ["action", "bucket_start"])
        self.assertEqual((t.num_rows, set(t.column("action").to_pylist())), (5, {"LONG"}))
        # una fila por clave
        t, _ = buscar_archivo(self.destino, "futures-verdicts", "verdicts", DIA0 + 120_000, DIA0 + 120_001, producto="PF_ETHUSD")
        self.assertEqual(t.num_rows, 1)

    def test_una_fila_no_exportada_aun_no_aparece(self):
        self.exp(AHORA_DIA0, tablas=["verdicts"])
        t = leer_archivo(self.destino, "futures-verdicts", "verdicts", DIA0, DIA0 + 2 * DAY_MS)
        self.assertEqual(t.num_rows, 1440)

    def test_cli_buscar_y_medir_sintetico(self):
        self.exp(AHORA_TODO, tablas=["verdicts"])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["buscar", "--destino", self.destino, "--base", "futures-verdicts", "--tabla", "verdicts", "--producto",
                                       "PF_ETHUSD", "--desde", "2023-11-14T01:00", "--hasta", "2023-11-14T02:00", "--donde", "action=LONG",
                                       "--columnas", "bucket_start,action"]), 0)
        datos = json.loads(out.getvalue())
        self.assertEqual(datos["informe"]["archivos_elegidos"], 1)
        self.assertTrue(all(f["action"] == "LONG" for f in datos["filas"]))
        res = medir("", "b", sintetico_dias=2, productos=2, paso_s=600, repeticiones=1)
        self.assertEqual(res["sintetico"]["no_confirmados"], [])
        b = res["busquedas"]["verdicts"]
        self.assertEqual(set(b) - {"producto_usado"}, {"producto_1_hora", "dia_completo", "semana_filtrando_columna", "una_fila_por_clave"})
        self.assertEqual(b["una_fila_por_clave"]["filas"], 1)
        self.assertGreater(res["tamanos"]["tablas"]["verdicts"]["razon"], 1)

    def test_tabla_ausente_y_copia_corrupta(self):
        otra = os.path.join(self.tmp.name, "snapshots", "v.sqlite")
        sintetico.crear_copia(otra, DIA0, 1, tablas=("verdicts",))
        r = exportar(otra, "b", self.destino, ahora_ms=AHORA_TODO)
        self.assertEqual(sorted(r["tablas_ausentes"]), ["llm_decisions", "market_events"])


if __name__ == "__main__":
    unittest.main()
