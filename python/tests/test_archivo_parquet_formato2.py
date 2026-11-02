"""Archivo Parquet, formato 2: las tres tablas pesadas (verdicts, funding_responses, candle_revisions), verificacion de NO perdida fila a fila,
tipos por typeof() en bases no STRICT, reemplazo seguro del formato viejo, market_events recortado por la retencion y premium de 1 minuto por dia.
Se SALTA si pyarrow no esta instalado (dependencia opcional, entorno aparte); las pruebas puras (sin pyarrow) corren siempre."""
import dataclasses
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest import mock

from archivo_parquet import formato, sintetico
from archivo_parquet.config import DAY_MS, FORMATO_VERSION, TABLAS, Columna, TablaConfig
from archivo_parquet.exportar import exportar
from archivo_parquet.leer import buscar_archivo
from archivo_parquet.util import (ErrorArchivo, Resumen, a_archivo, desde_archivo, dia_de, inicio_dia_ms, leer_manifiesto, sha256_archivo)
from archivo_parquet.verificar import verificar

DIA0 = inicio_dia_ms(dia_de(1_700_000_000_000))
AHORA = DIA0 + 70 * DAY_MS  # todo cerrado, incluso los meses
SIN_PYARROW = "pyarrow no esta instalado (entorno aparte, ver docs/archivo-parquet.md)"


class PurasTests(unittest.TestCase):
    """No necesitan pyarrow."""

    def test_columnas_mixtas_van_y_vuelven_exactas(self):
        cfg = _cfg_mixto()
        for v in (None, 0, 7, "7", "", "a\x00b", b"\x00\xff", 0.0, -0.0, 5e-324, 1e308, float("inf"), 2 ** 63 - 1, -(2 ** 63), 7.25):
            fila = (1, 5, 1.5, "t", v, b"x")
            vuelta = desde_archivo(cfg, a_archivo(cfg, fila))
            r1, r2 = Resumen(cfg), Resumen(cfg)
            r1.agregar([fila])
            r2.agregar([vuelta])
            self.assertEqual(bytes(r1.hashes), bytes(r2.hashes), repr(v))  # mismo typeof y mismos bits
            self.assertIs(type(vuelta[4]), type(v))

    def test_derivadas_del_json(self):
        cfg = TABLAS["verdicts"]
        pl = json.dumps({"selected": {"strategy_id": "breakout"}, "knowledge_lag_ms": 3000, "previous_regime": None, "config_hash": "c",
                         "schema_version": "futures-verdict.v1", "proposals": [{}, {}, {}]})
        fila = ("P", 1, 60000, 1, "range", "LONG", "x", "h", pl, 2)
        j = dict(zip([d.nombre for d in cfg.derivadas], a_archivo(cfg, fila)[len(cfg.nombres):]))
        self.assertEqual(j, {"j_selected_strategy_id": "breakout", "j_knowledge_lag_ms": 3000, "j_previous_regime": None, "j_config_hash": "c",
                             "j_schema_version": "futures-verdict.v1", "j_proposals_n": 3})
        # JSON roto, ruta ausente o de otro tipo: NULL, nunca un error (el JSON original se conserva igual)
        for malo in ("no es json", "{}", '{"knowledge_lag_ms": "3"}', '{"proposals": 3}', None):
            self.assertEqual(set(a_archivo(cfg, fila[:8] + (malo,) + fila[9:])[len(cfg.nombres):]), {None}, malo)

    def test_configuracion_valida(self):
        with self.assertRaises(ValueError):
            dataclasses.replace(TABLAS["verdicts"], grupo_por=("no_existe",))
        with self.assertRaises(ValueError):
            TablaConfig("t", "t", "x", ("x",), (Columna("x", "decimal"),))
        self.assertEqual(TABLAS["verdicts"].nombres_archivo[-6:], tuple(d.nombre for d in TABLAS["verdicts"].derivadas))
        self.assertGreaterEqual(FORMATO_VERSION, 2)  # = MIN_FORMAT_VERSION de la puerta de TypeScript (archive-tables.ts)


def _cfg_mixto() -> TablaConfig:
    """Tabla de una base NO STRICT (como qwen-live): una columna sin tipo declarado puede traer cualquier tipo."""
    return TablaConfig(
        nombre="qwen_trades", sqlite="trades", tiempo="ts", clave=("id",), producto=None, granularidad="mes",
        columnas=(Columna("id", "int"), Columna("ts", "int"), Columna("qty", "real", True), Columna("texto", "text", True),
                  Columna("nota", "mixto", True), Columna("dato", "blob", True)))


DDL_MIXTO = "CREATE TABLE trades(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, qty REAL, texto TEXT, nota, dato BLOB)"
FILAS_MIXTO = [
    (1, DIA0, 1.5, "a", 7, b"\x00\xff"),
    (2, DIA0 + 1, float("inf"), "", "7", None),  # '' != NULL; el texto '7' != el entero 7
    (3, DIA0 + 2, 5e-324, None, 7.25, b""),
    (4, DIA0 + 3, 1e308, "é \x00 fin", None, b"\x00"),
    (5, DIA0 + 4, 0.0, "x", b"\x01\x02", None),
    (6, DIA0 + 5, -0.0, "y", "", b"z"),
]


@unittest.skipUnless(formato.disponible(), SIN_PYARROW)
class Formato2Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        os.makedirs(os.path.join(self.tmp.name, "snapshots"))
        self.copia = os.path.join(self.tmp.name, "snapshots", "c.sqlite")
        self.destino = os.path.join(self.tmp.name, "archivo")

    def exp(self, tablas=None, ahora=AHORA, base="futures-x", **kw):
        return exportar(self.copia, base, self.destino, tablas, ahora_ms=ahora, **kw)

    # ---------- verdicts ----------
    def test_verdicts_formato_completo(self):
        sintetico.crear_copia_veredictos(self.copia, DIA0, 2, ("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"), 120_000)
        r = self.exp(["verdicts"])
        self.assertEqual((r["no_confirmados"], len(r["exportados"])), ([], 2))
        e = leer_manifiesto(self.destino)[0]
        self.assertEqual((e["formato_version"], e["verificacion_ida_vuelta"], e["filas"]), (2, True, 3 * 720))
        self.assertEqual(e["grupos_filas"], 3)  # un grupo por producto
        self.assertEqual(e["derivadas"], [d.nombre for d in TABLAS["verdicts"].derivadas])
        self.assertEqual(len(e["hash_filas_sha256"]), 64)
        ruta = os.path.join(self.destino, e["ruta"])
        lateral = os.path.join(self.destino, e["ruta_hashes"])
        self.assertEqual(os.path.getsize(lateral), 32 * e["filas"])
        with open(lateral, "rb") as fh:
            self.assertEqual(hashlib.sha256(fh.read()).hexdigest(), e["hash_filas_sha256"])
        info = formato.metadatos(ruta)
        self.assertEqual(info["compresion"], "zstd")
        self.assertTrue(info["indice_paginas"])
        self.assertEqual(info["sorting_columns"], [(0, False), (1, False)])
        con = sqlite3.connect(self.copia)
        ddl = con.execute("SELECT sql FROM sqlite_master WHERE name='paper_futures_verdicts'").fetchone()[0]
        self.assertEqual(info["schema"]["sqlite_ddl"], ddl)
        self.assertEqual(info["schema"]["formato_version"], "2")
        self.assertEqual(hashlib.sha256(ddl.encode()).hexdigest(), e["ddl_sha256"])
        # un grupo = un producto: las estadisticas de cada grupo tienen un solo producto
        pf = formato.pq.ParquetFile(ruta)
        for g in range(pf.metadata.num_row_groups):
            st = pf.metadata.row_group(g).column(0).statistics
            self.assertEqual(st.min, st.max)
        # sin diccionario en hashes ni JSON; con diccionario en producto/accion; estadisticas apagadas solo en payload_json
        nombres = pf.schema_arrow.names
        rg = pf.metadata.row_group(0)
        for col, dicc, stats in (("product_id", True, True), ("action", True, True), ("verdict_hash", False, True), ("payload_json", False, False),
                                 ("j_selected_strategy_id", True, True)):
            c = rg.column(nombres.index(col))
            self.assertEqual("RLE_DICTIONARY" in c.encodings or "PLAIN_DICTIONARY" in c.encodings, dicc, col)
            self.assertEqual(c.statistics is not None and c.statistics.has_min_max, stats, col)
        self.assertTrue(all(n.startswith("j_") for n in nombres[10:]))
        self.assertEqual(verificar(self.destino), {"archivos": 2, "problemas": [], "huerfanos_sin_confirmar": [], "formato_viejo": []})
        # el JSON vuelve byte a byte y las derivadas coinciden con lo que dice el JSON
        orig = con.execute("SELECT * FROM paper_futures_verdicts WHERE bucket_start >= ? AND bucket_start < ? ORDER BY product_id, bucket_start",
                           (DIA0, DIA0 + DAY_MS)).fetchall()
        t, _ = buscar_archivo(self.destino, "futures-x", "verdicts", DIA0, DIA0 + DAY_MS)
        filas = t.to_pylist()
        self.assertEqual([tuple(f[c] for c in TABLAS["verdicts"].nombres) for f in filas], orig)
        for f in filas[:50]:
            p = json.loads(f["payload_json"])
            self.assertEqual((f["j_selected_strategy_id"], f["j_proposals_n"], f["j_config_hash"]), (p["selected"]["strategy_id"], len(p["proposals"]), p["config_hash"]))
        # buscar por una columna derivada, sin abrir el JSON
        t, _ = buscar_archivo(self.destino, "futures-x", "verdicts", DIA0, DIA0 + DAY_MS, donde={"j_selected_strategy_id": "breakout"},
                              columnas=["product_id", "bucket_start", "j_selected_strategy_id"])
        self.assertTrue(t.num_rows > 0 and set(t.column("j_selected_strategy_id").to_pylist()) == {"breakout"})

    def test_payload_corrupto_con_el_mismo_verdict_hash_ya_no_pasa(self):
        """Punto debil del formato 1: con columna hash solo se comparaba ese hash. Si el escritor altera payload_json, ahora no se confirma."""
        sintetico.crear_copia_veredictos(self.copia, DIA0, 1, ("PF_XBTUSD",), 600_000)
        original = formato.escribir
        i_payload = TABLAS["verdicts"].nombres.index("payload_json")

        def corrompe(ruta, cfg, lotes, meta):
            def alterados():
                for lote in lotes:
                    yield [f[:i_payload] + (f[i_payload][:-1] + " ",) + f[i_payload + 1:] for f in lote]  # cambia 1 caracter del JSON, mismo verdict_hash
            return original(ruta, cfg, alterados(), meta)

        with mock.patch.object(formato, "escribir", corrompe):
            r = self.exp(["verdicts"])
        self.assertEqual((len(r["no_confirmados"]), r["exportados"]), (1, []))
        self.assertIn("posicion", r["no_confirmados"][0]["motivo"])
        self.assertEqual(leer_manifiesto(self.destino), [])
        self.assertEqual([f for _, _, fs in os.walk(self.destino) for f in fs], [])

    def test_filas_intercambiadas_se_detectan_por_posicion(self):
        sintetico.crear_copia_veredictos(self.copia, DIA0, 1, ("PF_XBTUSD",), 600_000)
        original = formato.escribir

        def intercambia(ruta, cfg, lotes, meta):
            def cambiados():
                for lote in lotes:
                    lote = list(lote)
                    lote[0], lote[1] = lote[1], lote[0]
                    yield lote
            return original(ruta, cfg, cambiados(), meta)

        with mock.patch.object(formato, "escribir", intercambia):
            r = self.exp(["verdicts"])
        self.assertEqual(len(r["no_confirmados"]), 1)  # la suma de hashes coincidiria; el orden y la posicion no

    def test_derivada_incorrecta_no_pasa(self):
        sintetico.crear_copia_veredictos(self.copia, DIA0, 1, ("PF_XBTUSD",), 600_000)
        original = formato.escribir
        n = len(TABLAS["verdicts"].nombres)

        def mala(ruta, cfg, lotes, meta):
            return original(ruta, cfg, ([f[:n] + ("otra",) + f[n + 1:] for f in lote] for lote in lotes), meta)

        with mock.patch.object(formato, "escribir", mala):
            r = self.exp(["verdicts"])
        self.assertIn("derivadas", r["no_confirmados"][0]["motivo"])

    def test_verificar_detecta_el_archivo_y_la_lista_de_hashes_alterados(self):
        sintetico.crear_copia_veredictos(self.copia, DIA0, 1, ("PF_XBTUSD",), 600_000)
        self.exp(["verdicts"])
        e = leer_manifiesto(self.destino)[0]
        lateral = os.path.join(self.destino, e["ruta_hashes"])
        with open(lateral, "rb") as fh:
            datos = bytearray(fh.read())
        datos[5] ^= 1
        with open(lateral, "wb") as fh:
            fh.write(bytes(datos))
        p = verificar(self.destino)["problemas"]
        self.assertEqual(len(p), 1)
        self.assertIn("posicion 0", p[0]["problema"])
        os.remove(lateral)  # sin la lista lateral vale el hash del manifiesto
        self.assertEqual(verificar(self.destino)["problemas"], [])

    # ---------- funding_responses ----------
    def test_funding_responses_mensual_zstd19_cuerpos_enteros(self):
        n = sintetico.crear_copia_funding(self.copia, DIA0, 3, por_dia=4, periodos=300)
        r = self.exp(["funding_responses"])
        self.assertEqual((r["no_confirmados"], len(r["exportados"])), ([], 1))
        e = leer_manifiesto(self.destino)[0]
        self.assertEqual((e["granularidad"], e["filas"], e["filas"] == n, e["dia"]), ("mes", 12, True, "2023-11-01"))
        self.assertRegex(e["ruta"], r"/funding_responses/anio=2023/mes=11/part-[0-9a-f]{8}\.parquet$")
        con = sqlite3.connect(self.copia)
        orig = con.execute("SELECT sha256, received_at, server_time, raw_response FROM paper_futures_funding_responses ORDER BY received_at, sha256").fetchall()
        t, _ = buscar_archivo(self.destino, "futures-x", "funding_responses", DIA0, DIA0 + 31 * DAY_MS)
        self.assertEqual([tuple(f.values()) for f in t.to_pylist()], orig)  # cuerpo JSON byte a byte
        info = formato.metadatos(os.path.join(self.destino, e["ruta"]))
        self.assertEqual(info["compresion"], "zstd")
        pf = formato.pq.ParquetFile(os.path.join(self.destino, e["ruta"]))
        cuerpo = pf.metadata.row_group(0).column(3)
        self.assertFalse(cuerpo.statistics is not None and cuerpo.statistics.has_min_max)
        self.assertNotIn("RLE_DICTIONARY", cuerpo.encodings)
        self.assertLess(e["bytes"], 0.1 * sum(len(f[3]) for f in orig))  # los cuerpos casi iguales casi no pesan

    # ---------- candle_revisions ----------
    def test_candle_revisions_todas_las_revisiones_por_mes(self):
        n = sintetico.crear_copia_velas(self.copia, DIA0, 2, ("PF_XBTUSD",), revisiones=40)
        r = self.exp(["candle_revisions"])
        self.assertEqual((r["no_confirmados"], len(r["exportados"])), ([], 1))
        e = leer_manifiesto(self.destino)[0]
        self.assertEqual((e["filas"], e["filas"] == n), (2 * 1440 * 40, True))  # TODAS las revisiones: no se descarta ninguna intermedia
        con = sqlite3.connect(self.copia)
        orig = con.execute("SELECT * FROM paper_futures_candle_revisions ORDER BY interval_ms, bucket_start, candle_id, revision").fetchall()
        t, _ = buscar_archivo(self.destino, "futures-x", "candle_revisions", DIA0, DIA0 + 31 * DAY_MS)
        self.assertEqual([tuple(f.values()) for f in t.to_pylist()], orig)
        # buscar una hora: las estadisticas de bucket_start dejan saltar grupos
        t, rep = buscar_archivo(self.destino, "futures-x", "candle_revisions", DIA0 + 3_600_000, DIA0 + 7_200_000)
        self.assertEqual(t.num_rows, 60 * 40)
        self.assertLess(rep["grupos_leidos"], rep["grupos_total"])

    # ---------- tipos por typeof() (base no STRICT) ----------
    def _copia_mixta(self, filas=FILAS_MIXTO):
        con = sqlite3.connect(self.copia)
        con.execute(DDL_MIXTO)
        con.executemany("INSERT INTO trades VALUES(?,?,?,?,?,?)", filas)
        con.commit()
        con.close()

    def test_base_no_strict_ida_y_vuelta_y_restauracion_con_el_ddl_del_archivo(self):
        self._copia_mixta()
        cfg = _cfg_mixto()
        with mock.patch.dict(TABLAS, {"qwen_trades": cfg}):
            r = self.exp(["qwen_trades"])
            self.assertEqual((r["no_confirmados"], len(r["exportados"])), ([], 1))
            self.assertEqual(verificar(self.destino)["problemas"], [])
        e = leer_manifiesto(self.destino)[0]
        ruta = os.path.join(self.destino, e["ruta"])
        # prueba 7.4: restaurar en una base nueva con el DDL de los metadatos y comparar typeof() y valor celda a celda con la copia original
        ddl = formato.metadatos(ruta)["schema"]["sqlite_ddl"]
        self.assertEqual(ddl, DDL_MIXTO)
        nueva = sqlite3.connect(":memory:")
        nueva.execute(ddl)
        for lote in formato.leer_filas(ruta, cfg):
            nueva.executemany("INSERT INTO trades VALUES(?,?,?,?,?,?)", [desde_archivo(cfg, f) for f in lote])
        orig = sqlite3.connect(self.copia)
        for col in cfg.nombres:
            sel = 'SELECT typeof("%s"), "%s" FROM trades ORDER BY id' % (col, col)
            a, b = orig.execute(sel).fetchall(), nueva.execute(sel).fetchall()
            self.assertEqual([(t, repr(v)) for t, v in a], [(t, repr(v)) for t, v in b], col)  # repr: distingue 0.0 de -0.0 y b'' de ''
        # en el archivo, la columna mixta es texto y su typeof va aparte
        pf = formato.pq.ParquetFile(ruta)
        self.assertIn("tipo_nota", pf.schema_arrow.names)
        self.assertEqual([x for x in pf.read().column("tipo_nota").to_pylist()], ["integer", "text", "real", "null", "blob", "text"])

    def test_celda_con_otro_tipo_falla_con_fila_y_columna(self):
        self._copia_mixta(FILAS_MIXTO[:2] + [(3, DIA0 + 2, "no es un numero", "a", 1, None)])  # texto en una columna REAL (no STRICT lo permite)
        with mock.patch.dict(TABLAS, {"qwen_trades": _cfg_mixto()}):
            r = self.exp(["qwen_trades"])
        self.assertEqual(r["exportados"], [])
        m = r["no_confirmados"][0]["motivo"]
        self.assertIn("columna qty", m)
        self.assertIn("fila 3", m)
        self.assertEqual(leer_manifiesto(self.destino), [])

    def test_null_en_columna_not_null_se_guarda_y_se_avisa(self):
        con = sqlite3.connect(self.copia)
        con.execute("CREATE TABLE trades(id INTEGER PRIMARY KEY, ts INTEGER, qty REAL, texto TEXT, nota, dato BLOB)")  # sin NOT NULL: puede venir NULL
        con.executemany("INSERT INTO trades VALUES(?,?,?,?,?,?)", [(1, DIA0, 1.5, "a", 1, None), (2, DIA0 + 1, 2.5, "b", 2, None)])
        con.execute("UPDATE trades SET ts = ts WHERE id = 1")
        con.commit()
        con.close()
        cfg = dataclasses.replace(_cfg_mixto(), columnas=(Columna("id", "int"), Columna("ts", "int"), Columna("qty", "real"), Columna("texto", "text"),
                                                          Columna("nota", "mixto"), Columna("dato", "blob")))
        with mock.patch.dict(TABLAS, {"qwen_trades": cfg}):
            r = self.exp(["qwen_trades"])
        self.assertEqual(r["no_confirmados"], [])  # el archivo es nullable: un NULL inesperado NO tira el periodo
        self.assertEqual(leer_manifiesto(self.destino)[0]["avisos"], {"nulos_en_columnas_not_null": {"dato": 2}})

    # ---------- reemplazo del formato viejo ----------
    def _archivo_formato_viejo(self, base="futures-x", tabla="verdicts"):
        """Escribe a mano un archivo y una linea de manifiesto como los de las fases 1 y 2 (sin formato_version ni verificacion_ida_vuelta)."""
        cfg = TABLAS[tabla]
        con = sqlite3.connect(self.copia)
        d0, d1 = DIA0, DIA0 + DAY_MS
        cols = ", ".join(cfg.nombres)
        filas = con.execute("SELECT %s FROM %s WHERE %s >= ? AND %s < ? ORDER BY %s" % (cols, cfg.sqlite, cfg.tiempo, cfg.tiempo, ", ".join(cfg.clave)),
                            (d0, d1)).fetchall()
        carpeta = os.path.join(self.destino, base, tabla, "anio=2023", "mes=11", "dia=14")
        os.makedirs(carpeta)
        pa, pq = formato.pa, formato.pq
        tipos = {"int": pa.int64(), "text": pa.string(), "real": pa.float64()}
        esquema = pa.schema([pa.field(c.nombre, tipos[c.tipo], nullable=c.nullable) for c in cfg.columnas]).with_metadata({"schema_version": "1"})
        cols_ = list(zip(*filas))
        pq.write_table(pa.table({c.nombre: pa.array(cols_[i], tipos[c.tipo]) for i, c in enumerate(cfg.columnas)}, schema=esquema),
                       os.path.join(carpeta, "tmp.parquet"), compression="zstd", write_statistics=True, write_page_checksum=True)
        sha = sha256_archivo(os.path.join(carpeta, "tmp.parquet"))
        nombre = "part-%s.parquet" % sha[:8]
        os.rename(os.path.join(carpeta, "tmp.parquet"), os.path.join(carpeta, nombre))
        r = Resumen(cfg, legado=True)
        r.agregar(filas)
        linea = {"base": base, "tabla": tabla, "dia": "2023-11-14", "granularidad": "dia", "ruta": "%s/%s/anio=2023/mes=11/dia=14/%s" % (base, tabla, nombre),
                 "filas": len(filas), "grupos_filas": 1, "bytes": os.path.getsize(os.path.join(carpeta, nombre)), "sha256": sha, "schema_version": 1,
                 "checksum_tipo": "verdict_hash", "exportado_en": "2026-11-02T00:00:00Z"}
        linea.update(r.como_dict())
        with open(os.path.join(self.destino, "manifiesto.jsonl"), "w") as fh:
            fh.write(json.dumps(linea, sort_keys=True) + "\n")
        return linea

    def test_el_formato_viejo_sigue_verificandose_pero_queda_marcado_y_se_reemplaza_de_forma_segura(self):
        sintetico.crear_copia_veredictos(self.copia, DIA0, 2, ("PF_XBTUSD", "PF_ETHUSD"), 300_000)
        vieja = self._archivo_formato_viejo()
        self.assertNotIn("formato_version", vieja)  # la puerta de TypeScript lo bloquea: exige formato_version y verificacion_ida_vuelta
        v = verificar(self.destino)
        self.assertEqual((v["problemas"], v["formato_viejo"]), ([], [vieja["ruta"]]))  # el lector/verificador de siempre lo sigue leyendo
        t, _ = buscar_archivo(self.destino, "futures-x", "verdicts", DIA0, DIA0 + DAY_MS)  # y el buscador tambien (sin columnas j_)
        self.assertEqual(t.num_rows, vieja["filas"])
        self.assertEqual(set(t.column("j_proposals_n").to_pylist()), {None})
        r = self.exp(["verdicts"])
        self.assertEqual((r["no_confirmados"], len(r["reemplazados"]), len(r["exportados"])), ([], 1, 1))  # el dia 14 se reemplaza; el 15 es nuevo
        lineas = leer_manifiesto(self.destino)
        self.assertEqual(len(lineas), 2)  # una sola linea por periodo (la puerta bloquea periodos repetidos)
        nueva = [x for x in lineas if x["dia"] == "2023-11-14"][0]
        self.assertEqual((nueva["formato_version"], nueva["verificacion_ida_vuelta"], nueva["reemplaza"]), (2, True, vieja["ruta"]))
        self.assertNotEqual(nueva["ruta"], vieja["ruta"])  # part-<sha8> distinto
        self.assertFalse(os.path.exists(os.path.join(self.destino, vieja["ruta"])))  # el huerfano se descarta
        with open(os.path.join(self.destino, "manifiesto-reemplazadas.jsonl")) as fh:
            self.assertEqual(fh.read().count("\n"), 1)  # y la linea vieja queda auditada
        self.assertEqual(verificar(self.destino), {"archivos": 2, "problemas": [], "huerfanos_sin_confirmar": [], "formato_viejo": []})
        # idempotente: ya esta en formato 2
        r2 = self.exp(["verdicts"])
        self.assertEqual((r2["exportados"], r2["reemplazados"], len(r2["ya_confirmados"])), ([], [], 2))

    def test_no_se_reemplaza_si_la_copia_tiene_menos_filas_que_el_archivo_viejo(self):
        sintetico.crear_copia_veredictos(self.copia, DIA0, 1, ("PF_XBTUSD",), 300_000)
        vieja = self._archivo_formato_viejo()
        con = sqlite3.connect(self.copia)
        con.execute("DROP TABLE paper_futures_verdicts")  # la base viva ya no tiene el dia completo (p. ej. ya se borro parte)
        con.execute(sintetico.DDL["verdicts"])
        con.execute("INSERT INTO paper_futures_verdicts VALUES('PF_XBTUSD', ?, 60000, 1, 'range', 'HOLD', 'x', 'h', '{}', 2)", (DIA0,))
        con.commit()
        con.close()
        r = self.exp(["verdicts"])
        self.assertEqual((r["no_confirmados"], r["reemplazados"], len(r["reemplazos_omitidos"])), ([], [], 1))
        self.assertEqual([x["ruta"] for x in leer_manifiesto(self.destino)], [vieja["ruta"]])
        self.assertTrue(os.path.exists(os.path.join(self.destino, vieja["ruta"])))
        self.assertEqual([f for _, _, fs in os.walk(self.destino) for f in fs if f.startswith("part-") and f != os.path.basename(vieja["ruta"])], [])

    # ---------- market_events y premium_1m ----------
    def test_market_events_con_inicio_recortado_no_se_certifica_como_dia_completo(self):
        sintetico.crear_copia(self.copia, DIA0, 2, ("PF_XBTUSD",), 600_000, ("market_events",))
        con = sqlite3.connect(self.copia)
        con.execute("DELETE FROM paper_futures_market_events WHERE received_at < ?", (DIA0 + 6 * 3_600_000,))  # la retencion borro las primeras 6 h
        con.commit()
        con.close()
        r = self.exp(["market_events"])
        self.assertEqual(r["no_confirmados"], [])  # no es un fallo: es lo que la retencion de la captura ya perdio
        self.assertEqual([(o["tabla"], o["dia"]) for o in r["omitidos_por_retencion"]], [("market_events", "2023-11-14")])
        self.assertIn("retencion", r["omitidos_por_retencion"][0]["motivo"])
        self.assertEqual([e["dia"] for e in leer_manifiesto(self.destino)], ["2023-11-15"])  # el dia siguiente conserva su inicio

    def test_premium_de_1_minuto_se_archiva_por_dia_al_dia_siguiente(self):
        con = sqlite3.connect(self.copia)
        con.execute(sintetico.DDL["premium"])
        for d in range(2):
            for k in range(0, 1440):
                con.execute("INSERT INTO premium VALUES('PF_XBTUSD', 60000, ?, 100.5, 100.0, ?)", (DIA0 + d * DAY_MS + k * 60_000, 0.1 * k))
        con.execute("INSERT INTO premium VALUES('PF_XBTUSD', 3600000, ?, 100.5, 100.0, 1.5)", (DIA0,))
        con.commit()
        con.close()
        r = self.exp(["premium_1m"], ahora=DIA0 + DAY_MS + 10)  # el dia 0 termino hace 10 ms: margen 0
        self.assertEqual([(e["dia"], e["filas"]) for e in r["exportados"]], [("2023-11-14", 1440)])  # solo la serie de 1 minuto; el de 1 h no
        self.assertEqual(r["pendientes_por_abrir"], [{"tabla": "premium_1m", "dia": "2023-11-15"}])
        r = self.exp(["premium_1m", "premium"], ahora=AHORA)
        self.assertEqual(sorted((e["tabla"], e["dia"], e["filas"]) for e in r["exportados"]),
                         [("premium", "2023-11-01", 2 * 1440 + 1), ("premium_1m", "2023-11-15", 1440)])  # el mensual sigue sin filtro
        e = [x for x in leer_manifiesto(self.destino) if x["tabla"] == "premium_1m"][0]
        pf = formato.pq.ParquetFile(os.path.join(self.destino, e["ruta"]))
        self.assertIn("BYTE_STREAM_SPLIT", pf.metadata.row_group(0).column(pf.schema_arrow.names.index("premium_bp")).encodings)

    def test_columnas_nuevas_en_sqlite_avisan_y_no_fallan(self):
        sintetico.crear_copia_veredictos(self.copia, DIA0, 1, ("PF_XBTUSD",), 600_000)
        con = sqlite3.connect(self.copia)
        con.execute("ALTER TABLE paper_futures_verdicts ADD COLUMN nueva TEXT")
        con.commit()
        con.close()
        avisos = []
        r = self.exp(["verdicts"], log=avisos.append)
        self.assertEqual((r["no_confirmados"], len(r["exportados"])), ([], 1))
        self.assertEqual(r["avisos"], [{"tabla": "verdicts", "columnas_sin_configurar": ["nueva"]}])
        self.assertTrue(any("nueva" in a for a in avisos))
        with self.assertRaises(ErrorArchivo):  # pero si FALTA una columna, no se exporta
            con = sqlite3.connect(self.copia)
            con.execute("ALTER TABLE paper_futures_verdicts RENAME COLUMN reason_code TO motivo")
            con.commit()
            con.close()
            self.exp(["verdicts"], ahora=AHORA + DAY_MS)


RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GATE_MTS = """
import { evaluateArchiveGate } from '%(raiz)s/server/src/features/archive-prune/archive-gate.ts'
import { POSITIONING_TABLES } from '%(raiz)s/server/src/features/archive-prune/archive-tables.ts'
const r = await evaluateArchiveGate({ archiveDir: process.argv[2], specs: POSITIONING_TABLES, now: Date.parse('2027-06-01T00:00:00Z'), countRows: () => 10 })
console.log(JSON.stringify({ ok: r.ok, deletable: r.deletable.map((d) => d.table), blocked: r.blocked.map((b) => b.reason) }))
"""


@unittest.skipUnless(formato.disponible() and shutil.which("node"), SIN_PYARROW + "; o no hay node para correr la puerta real de TypeScript")
class PuertaTypeScriptTests(unittest.TestCase):
    """La puerta REAL (archive-gate.ts) acepta lo que certifica el exportador nuevo y bloquea el formato viejo. No sube MIN_FORMAT_VERSION."""

    def corre(self, tmp, destino):
        mts = os.path.join(tmp, "gate.mts")
        with open(mts, "w") as fh:
            fh.write(GATE_MTS % {"raiz": RAIZ})
        out = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", mts, destino], capture_output=True, text=True, timeout=120)
        if out.returncode != 0:
            self.skipTest("este node no corre TypeScript directo: " + out.stderr[-200:])
        return json.loads(out.stdout.strip().splitlines()[-1])

    def test_nuevo_pasa_y_viejo_queda_bloqueado(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "snapshots"))
            copia, destino = os.path.join(tmp, "snapshots", "p.sqlite"), os.path.join(tmp, "archivo")
            sintetico.crear_copia_fase2(copia, DIA0, 3, tablas=("positioning", "premium"), paso_ms=30 * 60_000)
            r = exportar(copia, "positioning", destino, ["positioning", "premium"], ahora_ms=AHORA)
            self.assertEqual(r["no_confirmados"], [])
            self.assertEqual(self.corre(tmp, destino), {"ok": True, "deletable": ["positioning", "premium"], "blocked": []})
            ruta = os.path.join(destino, "manifiesto.jsonl")
            with open(ruta) as fh:
                lineas = [json.loads(x) for x in fh if x.strip()]
            for e in lineas:  # como una linea de las fases 1 y 2: sin formato_version ni verificacion_ida_vuelta
                del e["formato_version"], e["verificacion_ida_vuelta"]
            with open(ruta, "w") as fh:
                fh.write("".join(json.dumps(e) + "\n" for e in lineas))
            r = self.corre(tmp, destino)
            self.assertEqual(r["deletable"], [])
            self.assertEqual(set(r["blocked"]), {"sin verificacion_ida_vuelta=true en el manifiesto"})


if __name__ == "__main__":
    unittest.main()
