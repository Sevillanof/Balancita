"""Archivo Parquet: ``reproducir`` reconstruye desde el Parquet los conjuntos de entradas/salidas y los compara con una copia de SQLite.
Copias sinteticas (nunca bases reales). Se SALTA si pyarrow no esta instalado."""
import contextlib
import io
import json
import os
import sqlite3
import tempfile
import unittest

from archivo_parquet import cli, formato, nocturno, sintetico
from archivo_parquet.config import DAY_MS
from archivo_parquet.exportar import exportar
from archivo_parquet.reproducir import CONJUNTOS, reproducir
from archivo_parquet.util import ErrorArchivo, dia_de, inicio_dia_ms, leer_manifiesto

DIA0 = inicio_dia_ms(dia_de(1_700_000_000_000))
AHORA = DIA0 + 40 * DAY_MS  # los tres dias y los meses ya cerrados
QWEN = "qwen-live__live"


@unittest.skipUnless(formato.disponible(), "pyarrow no esta instalado (entorno aparte, ver docs/archivo-parquet.md)")
class ReproducirTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        os.makedirs(os.path.join(self.tmp.name, "snapshots"))
        self.copia = os.path.join(self.tmp.name, "snapshots", "c.sqlite")
        self.destino = os.path.join(self.tmp.name, "archivo")

    def qwen(self):
        sintetico.crear_copia_qwen_live(self.copia, DIA0)
        r = exportar(self.copia, QWEN, self.destino, ahora_ms=AHORA)
        self.assertEqual(r["no_confirmados"], [])

    def mercado(self):
        sintetico.crear_copia_mercado_util(self.copia, DIA0)
        r = exportar(self.copia, "futures-market", self.destino, ["official_candles", "funding_periods", "analytics_points"], ahora_ms=AHORA)
        self.assertEqual(r["no_confirmados"], [])

    def repro(self, base=QWEN, **kw):
        return reproducir(self.copia, base, self.destino, ahora_ms=AHORA, **kw)

    def sql(self, sentencia, params=()):
        con = sqlite3.connect(self.copia)
        con.execute(sentencia, params)
        con.commit()
        con.close()

    def premium(self):
        sintetico.crear_copia_fase2(self.copia, DIA0, 3, paso_ms=60_000, tablas=("positioning", "premium"))
        r = exportar(self.copia, "positioning", self.destino, ["positioning", "premium", "premium_1m"], ahora_ms=AHORA)
        self.assertEqual(r["no_confirmados"], [])

    def test_premium_recortado_por_retencion_no_es_diferencia(self):
        self.premium()
        # la retencion de SQLite (7 dias) borra los minutos viejos; el Parquet los conserva a proposito
        self.sql("DELETE FROM premium WHERE interval_ms = 60000 AND bucket_ms < ?", (DIA0 + 2 * DAY_MS,))
        rep = self.repro("positioning", conjuntos=["posicionamiento"])
        self.assertTrue(rep["ok"], json.dumps(rep, indent=1)[:2000])
        t = rep["conjuntos"]["posicionamiento"]["tablas"]["premium"]
        self.assertGreater(t["filas_recortadas_por_retencion"], 0)
        self.assertEqual(t["filas_distintas"], 0)

    def test_premium_fila_borrada_dentro_del_rango_retenido_falla(self):
        self.premium()
        self.sql("DELETE FROM premium WHERE interval_ms = 60000 AND bucket_ms < ?", (DIA0 + 2 * DAY_MS,))
        self.sql("UPDATE premium SET premium_bp = premium_bp + 1 WHERE interval_ms = 60000 AND bucket_ms = "
                 "(SELECT MAX(bucket_ms) FROM premium)")
        rep = self.repro("positioning", conjuntos=["posicionamiento"])
        self.assertFalse(rep["ok"])

    def test_caso_feliz_todo_igual(self):
        self.qwen()
        rep = self.repro()
        self.assertEqual((rep["ok"], rep["codigo"]), (True, 0), json.dumps(rep, indent=1)[:2000])
        c = rep["conjuntos"]
        self.assertEqual({k: c[k]["estado"] for k in ("decisiones_maestro", "operaciones", "noticias", "rebotes_skipped")},
                         {"decisiones_maestro": "OK", "operaciones": "OK", "noticias": "OK", "rebotes_skipped": "OK"})
        self.assertEqual(c["velas_oficiales"]["estado"], "no_aplica")  # la copia no tiene esas tablas
        d = c["decisiones_maestro"]["tablas"]["qwen_decisions"]
        self.assertEqual((d["filas_sqlite"], d["filas_parquet"], d["filas_distintas"], d["dias_faltantes"]), (12, 12, 0, []))
        r = c["rebotes_skipped"]
        self.assertEqual((r["filas_sqlite"], r["filas_parquet"], r["filas_distintas"]), (9, 9, 0))  # 3 skipped + 6 rebotes
        # la operacion cerrada del dia 1 con funding pendiente NO es un hueco: queda pendiente (SQLite todavia la cambia)
        t = c["operaciones"]["tablas"]["qwen_trades"]
        self.assertEqual((t["filas_sqlite"], t["filas_parquet"], t["dias_faltantes"]), (2, 2, []))
        self.assertEqual(len(t["dias_pendientes"]), 1)

    def test_mercado_serie_final_de_velas_as_of_known_at(self):
        self.mercado()
        rep = self.repro("futures-market")
        self.assertEqual(rep["codigo"], 0, json.dumps(rep, indent=1)[:2000])
        v = rep["conjuntos"]["velas_oficiales"]
        self.assertEqual((v["filas_sqlite"], v["filas_parquet"], v["filas_distintas"]), (18, 18, 0))  # 2 productos x 3 dias x 3 velas; la revision tardia no suma
        self.assertEqual(rep["conjuntos"]["funding"]["estado"], "OK")
        self.assertEqual(rep["conjuntos"]["mercado"]["estado"], "OK")

    def test_una_fila_de_sqlite_alterada_despues_de_exportar_falla(self):
        self.qwen()
        self.sql("UPDATE decisions SET formula_json = '{\"puntaje\": 0.9}' WHERE bucket_ms = (SELECT MIN(bucket_ms) FROM decisions)")
        rep = self.repro()
        self.assertEqual((rep["ok"], rep["codigo"]), (False, 1))
        d = rep["conjuntos"]["decisiones_maestro"]
        self.assertEqual((d["estado"], d["filas_distintas"]), ("FALLA", 1))
        self.assertEqual(rep["conjuntos"]["operaciones"]["estado"], "OK")

    def test_la_serie_final_de_una_vela_alterada_falla(self):
        self.mercado()
        self.sql("UPDATE paper_futures_official_candles SET close_price = '1' WHERE revision_hash = 'tarde'")
        rep = self.repro("futures-market")
        self.assertEqual(rep["codigo"], 1)
        self.assertEqual(rep["conjuntos"]["velas_oficiales"]["filas_distintas"], 1)

    def test_un_dia_borrado_del_parquet_es_hueco(self):
        self.qwen()
        manifiesto = os.path.join(self.destino, "manifiesto.jsonl")
        dia1 = dia_de(DIA0 + DAY_MS).isoformat()
        entradas = leer_manifiesto(self.destino)
        quitada = next(e for e in entradas if e["tabla"] == "qwen_decisions" and e["dia"] == dia1)
        os.remove(os.path.join(self.destino, quitada["ruta"]))
        with open(manifiesto, "w") as fh:
            for e in entradas:
                if e is not quitada:
                    fh.write(json.dumps(e) + "\n")
        rep = self.repro()
        self.assertEqual(rep["codigo"], 1)
        d = rep["conjuntos"]["decisiones_maestro"]
        self.assertEqual(d["estado"], "FALLA")
        self.assertEqual(d["dias_faltantes"], ["qwen_decisions:" + dia1])
        self.assertEqual(rep["conjuntos"]["operaciones"]["estado"], "OK")

    def test_archivo_del_manifiesto_ausente_falla(self):
        self.qwen()
        e = next(e for e in leer_manifiesto(self.destino) if e["tabla"] == "qwen_skipped")
        os.remove(os.path.join(self.destino, e["ruta"]))
        rep = self.repro(conjuntos=["rebotes_skipped"])
        self.assertEqual(rep["codigo"], 1)
        self.assertTrue(rep["conjuntos"]["rebotes_skipped"]["problemas"])

    def test_periodo_perdido_aceptado_no_es_hueco(self):
        self.qwen()
        dia1 = dia_de(DIA0 + DAY_MS).isoformat()
        entradas = [e for e in leer_manifiesto(self.destino) if not (e["tabla"] == "qwen_skipped" and e["dia"] == dia1)]
        with open(os.path.join(self.destino, "manifiesto.jsonl"), "w") as fh:
            for e in entradas:
                fh.write(json.dumps(e) + "\n")
        sin = self.repro(conjuntos=["rebotes_skipped"])
        self.assertEqual(sin["codigo"], 1)
        nocturno.PERIODOS_PERDIDOS_ACEPTADOS[(QWEN, "qwen_skipped", dia1)] = "prueba"
        try:
            rep = self.repro(conjuntos=["rebotes_skipped"])
        finally:
            del nocturno.PERIODOS_PERDIDOS_ACEPTADOS[(QWEN, "qwen_skipped", dia1)]
        self.assertEqual(rep["codigo"], 0, rep)
        self.assertEqual(len(rep["conjuntos"]["rebotes_skipped"]["tablas"]["qwen_skipped"]["perdidos_aceptados"]), 1)

    def test_rebotes_y_skipped_estan_cubiertas_por_nocturno(self):
        import shutil
        resp = os.path.join(self.tmp.name, "backups")
        os.makedirs(resp)
        ruta = os.path.join(resp, "%s-20261102-040000.sqlite" % QWEN)
        sintetico.crear_copia_qwen_live(ruta, DIA0, con_excluidas=True)
        ahora_s = (DIA0 + 10 * DAY_MS) / 1000
        os.utime(ruta, (ahora_s - 3600, ahora_s - 3600))
        res = nocturno.correr(self.destino, resp, dry_run=True, bases=(QWEN,), despertar=lambda: None, ahora_s=ahora_s, aplicar_nice=False)
        self.assertNotIn("tablas_sin_cubrir", res["bases"][QWEN], res)
        self.assertEqual((res["codigo"], len(res["bases"][QWEN]["dry_run"])), (0, 16))  # 16 periodos con rebotes y skipped (el mes de config_versions sigue abierto a 10 dias)
        shutil.rmtree(resp)

    def test_cli_codigos_de_salida(self):
        self.qwen()
        base = ["reproducir", "--copia", self.copia, "--base", QWEN, "--destino", self.destino]

        def correr(args):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                codigo = cli.main(args)
            return codigo, out.getvalue()

        codigo, salida = correr(base + ["--conjuntos", "rebotes_skipped,decisiones_maestro"])
        self.assertEqual(codigo, 0)
        self.assertEqual(json.loads(salida)["conjuntos"]["rebotes_skipped"]["estado"], "OK")
        self.assertEqual(correr(base + ["--conjuntos", "no_existe"])[0], 2)
        self.sql("UPDATE skipped SET reason = 'otro'")
        self.assertEqual(correr(base)[0], 1)

    def test_conjuntos_conocidos(self):
        self.assertIn("rebotes_skipped", CONJUNTOS)
        with self.assertRaises(ErrorArchivo):
            sintetico.crear_copia_qwen_live(self.copia, DIA0)
            reproducir(self.copia, QWEN, self.destino, ["xx"])


if __name__ == "__main__":
    unittest.main()
