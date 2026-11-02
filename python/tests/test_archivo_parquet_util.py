"""Archivo Parquet (fase 1): partes sin pyarrow (guardas de la copia, dias, resumen, catalogo, texto DuckDB). Datos sinteticos."""
import os
import sqlite3
import tempfile
import unittest

from archivo_parquet import sintetico
from archivo_parquet.config import DAY_MS, TABLAS
from archivo_parquet.leer import consulta_duckdb
from archivo_parquet.util import (ErrorArchivo, Resumen, abrir_copia, agregar_al_manifiesto, dia_cerrado, dia_de, inicio_dia_ms,
                                  leer_manifiesto, parse_tiempo, seleccionar, validar_ruta_copia)

DIA0 = inicio_dia_ms(dia_de(1_700_000_000_000))


class GuardasTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _copia(self, *partes):
        carpeta = os.path.join(self.tmp.name, *partes)
        os.makedirs(carpeta, exist_ok=True)
        ruta = os.path.join(carpeta, "x.sqlite")
        sintetico.crear_copia(ruta, DIA0, 1, paso_ms=3_600_000)
        return ruta

    def test_rechaza_la_base_viva_incluso_con_confirmacion(self):
        ruta = self._copia("server", "data", "dev-live")
        for flag in (False, True):
            with self.assertRaises(ErrorArchivo):
                validar_ruta_copia(ruta, flag)

    def test_exige_snapshots_backups_o_confirmacion(self):
        suelta = self._copia("otra")
        with self.assertRaises(ErrorArchivo):
            validar_ruta_copia(suelta, False)
        validar_ruta_copia(suelta, True)
        validar_ruta_copia(self._copia("data", "snapshots"), False)
        validar_ruta_copia(self._copia("data", "backups"), False)

    def test_abre_en_solo_lectura(self):
        con = abrir_copia(self._copia("snapshots"))
        with self.assertRaises(sqlite3.OperationalError):
            con.execute("DELETE FROM paper_futures_verdicts")
        con.close()

    def test_quick_check_fallido_no_abre(self):
        ruta = self._copia("snapshots")
        with open(ruta, "r+b") as fh:
            fh.seek(0)
            fh.write(b"\x00" * 200)
        with self.assertRaises(ErrorArchivo):
            abrir_copia(ruta)


class DiasYResumenTests(unittest.TestCase):
    def test_dia_cerrado_con_un_dia_de_margen(self):
        dia = dia_de(DIA0)
        self.assertFalse(dia_cerrado(dia, DIA0 + 2 * DAY_MS - 1))
        self.assertTrue(dia_cerrado(dia, DIA0 + 2 * DAY_MS))

    def test_parse_tiempo(self):
        self.assertEqual(parse_tiempo("1000"), 1000)
        self.assertEqual(parse_tiempo("1970-01-02"), DAY_MS)
        self.assertEqual(parse_tiempo("1970-01-01T00:00:01+00:00"), 1000)
        with self.assertRaises(ErrorArchivo):
            parse_tiempo("ayer")

    def test_resumen_no_depende_del_orden_y_cuenta_duplicados(self):
        cfg = TABLAS["verdicts"]
        filas = [("A", 1, 60000, 1, "r", "LONG", "x", "h1", "{}", 2), ("A", 2, 60000, 1, "r", "HOLD", "x", "h2", "{}", 2)]
        a, b, c = Resumen(cfg), Resumen(cfg), Resumen(cfg)
        a.agregar(filas)
        b.agregar(filas[::-1])
        c.agregar(filas + filas[:1])
        self.assertEqual(a.como_dict()["checksum_contenido"], b.como_dict()["checksum_contenido"])
        self.assertNotEqual(a.como_dict()["checksum_contenido"], c.como_dict()["checksum_contenido"])
        self.assertFalse(b.ordenado)
        self.assertEqual((a.como_dict()["producto_min"], a.como_dict()["tiempo_max"]), ("A", 2))

    def test_sin_hash_usa_hash_canonico_de_filas(self):
        cfg = TABLAS["market_events"]
        self.assertIsNone(None if cfg.hash else 1)  # market_events trae content_hash
        r1, r2 = Resumen(cfg), Resumen(cfg)
        base = ("e1", "ticker", "P", 1, 1, 1, 5, 6, None, "{}", "{}", "h")
        r1.agregar([base])
        r2.agregar([base[:10] + ("{\"x\":1}",) + base[11:]])
        self.assertEqual(r1.como_dict()["checksum_contenido"], r2.como_dict()["checksum_contenido"])  # solo cuenta content_hash


class CatalogoTests(unittest.TestCase):
    def _e(self, dia, pmin, pmax, tmin, tmax, tabla="verdicts"):
        return {"base": "b", "tabla": tabla, "dia": dia, "ruta": "b/%s/%s.parquet" % (tabla, dia), "producto_min": pmin, "producto_max": pmax,
                "tiempo_min": tmin, "tiempo_max": tmax, "bytes": 1}

    def test_seleccion_por_tiempo_y_producto(self):
        es = [self._e("d1", "A", "C", 0, 99), self._e("d2", "A", "C", 100, 199), self._e("d3", "D", "F", 100, 199),
              self._e("d4", "A", "C", 100, 199, tabla="otra")]
        self.assertEqual([e["dia"] for e in seleccionar(es, "b", "verdicts", 0, 100)], ["d1"])  # hasta excluido
        self.assertEqual([e["dia"] for e in seleccionar(es, "b", "verdicts", 99, 101)], ["d1", "d2", "d3"])
        self.assertEqual([e["dia"] for e in seleccionar(es, "b", "verdicts", 0, 1000, "B")], ["d1", "d2"])
        self.assertEqual([e["dia"] for e in seleccionar(es, "b", "verdicts", 0, 1000, "E")], ["d3"])

    def test_manifiesto_agrega_y_lee_lineas(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(leer_manifiesto(tmp), [])
            agregar_al_manifiesto(tmp, {"a": 1})
            agregar_al_manifiesto(tmp, {"a": 2})
            self.assertEqual([e["a"] for e in leer_manifiesto(tmp)], [1, 2])

    def test_consulta_duckdb_equivalente(self):
        sql = consulta_duckdb("/d", "b", "verdicts", DIA0, DIA0 + DAY_MS, ["product_id", "action"], "PF_X'Y", {"action": "LONG"})
        self.assertIn("read_parquet('/d/b/verdicts/anio=*/mes=*/dia=*/part-*.parquet', hive_partitioning = true)", sql)
        self.assertIn("bucket_start >= %d" % DIA0, sql)
        self.assertIn("bucket_start < %d" % (DIA0 + DAY_MS), sql)
        self.assertIn("product_id = 'PF_X''Y'", sql)
        self.assertIn("action = 'LONG'", sql)
        self.assertIn("anio = 2023", sql)


if __name__ == "__main__":
    unittest.main()
