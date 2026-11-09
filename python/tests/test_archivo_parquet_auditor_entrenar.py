"""Archivo Parquet de las tablas que el auditor guarda para entrenar (S8 de odd/tasks/noticias-y-auditor.md, T15): toda tabla de
``auditor.sqlite`` se archiva o se excluye a proposito (si no, el chequeo nocturno falla con ``tablas_sin_cubrir``), la configuracion
sigue columna por columna a la que crea el auditor, y las tablas que el auditor completa despues no se exportan hasta estar resueltas.
Las pruebas de la configuracion no necesitan pyarrow; el viaje de ida y vuelta se salta si no esta instalado."""
import contextlib
import os
import sqlite3
import tempfile
import unittest

from archivo_parquet import formato, nocturno
from archivo_parquet.config import DAY_MS, TABLAS
from archivo_parquet.exportar import exportar
from archivo_parquet.util import dia_de, inicio_dia_ms, leer_manifiesto
from archivo_parquet.verificar import verificar
from balancita_engine import futures_auditor as aud

DIA0 = inicio_dia_ms(dia_de(1_700_000_000_000))
HORA = 3_600_000
# tabla del archivo -> tabla de SQLite que crea el auditor
NUEVAS = {"auditor_operaciones": "operaciones", "auditor_hechos": "hechos_mirada", "auditor_propuestas": "propuestas",
          "auditor_mirada_operaciones": "mirada_operaciones", "auditor_resultados": "resultados_operacion", "auditor_reentrenos": "reentrenos",
          "auditor_sombra": "sombra_maker"}


def auditor_db(carpeta):
    """Un ``auditor.sqlite`` con el esquema REAL que crea el auditor (no una copia escrita a mano)."""
    with contextlib.closing(aud._open(os.path.join(carpeta, "live.sqlite"))):
        pass
    return aud.auditor_path(os.path.join(carpeta, "live.sqlite"))


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ruta = auditor_db(self.tmp.name)

    def test_cada_tabla_nueva_sigue_columna_por_columna_a_la_que_crea_el_auditor(self):
        with contextlib.closing(sqlite3.connect(self.ruta)) as con:
            for nombre, tabla in NUEVAS.items():
                real = [f[1] for f in con.execute('PRAGMA table_info("%s")' % tabla)]
                self.assertEqual(list(TABLAS[nombre].nombres), real, nombre)
                self.assertEqual(TABLAS[nombre].sqlite, tabla)

    def test_toda_tabla_del_auditor_se_archiva_o_se_excluye_con_motivo(self):
        with contextlib.closing(sqlite3.connect(self.ruta)) as con:
            self.assertEqual(nocturno._tablas_sin_cubrir(con, "qwen-live__auditor"), [])
        # y una tabla nueva sin decidir si seguiria siendo un hueco
        with contextlib.closing(sqlite3.connect(self.ruta)) as con:
            con.execute("CREATE TABLE tabla_nueva_sin_decidir(x INTEGER)")
            self.assertEqual(nocturno._tablas_sin_cubrir(con, "qwen-live__auditor"), ["tabla_nueva_sin_decidir"])

    def test_solo_lo_que_el_auditor_completa_despues_declara_cuando_una_fila_ya_no_cambia(self):
        self.assertEqual(TABLAS["auditor_operaciones"].inmutable_sql, '"resuelto_ms" IS NOT NULL')
        self.assertEqual(TABLAS["auditor_propuestas"].inmutable_sql, '"resuelto_ms" IS NOT NULL')
        self.assertEqual(TABLAS["auditor_resultados"].inmutable_sql, '"resultado_ms" IS NOT NULL')
        for nombre in ("auditor_hechos", "auditor_mirada_operaciones", "auditor_reentrenos", "auditor_sombra"):
            self.assertIsNone(TABLAS[nombre].inmutable_sql, nombre)            # sombra_maker: una fila se escribe una sola vez y ya no cambia

    def test_el_tiempo_de_cada_periodo_es_una_columna_que_ya_no_cambia(self):
        esperado = {"auditor_operaciones": ("entry_ms", "dia"), "auditor_hechos": ("t_ms", "dia"), "auditor_propuestas": ("t_ms", "dia"),
                    "auditor_mirada_operaciones": ("t_ms", "dia"), "auditor_resultados": ("exit_ms", "dia"),
                    "auditor_reentrenos": ("creado_ms", "mes"), "auditor_sombra": ("t_oficial_ms", "dia")}
        for nombre, (tiempo, granularidad) in esperado.items():
            self.assertEqual((TABLAS[nombre].tiempo, TABLAS[nombre].granularidad), (tiempo, granularidad), nombre)


@unittest.skipUnless(formato.disponible(), "pyarrow no esta instalado (entorno aparte, ver docs/archivo-parquet.md)")
class IdaYVueltaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        os.makedirs(os.path.join(self.tmp.name, "snapshots"))
        self.ruta = auditor_db(os.path.join(self.tmp.name, "snapshots"))
        self.destino = os.path.join(self.tmp.name, "archivo")

    def poblar(self):
        """Dia 0 todo resuelto; dia 1 con UNA propuesta, UNA operacion y UN resultado sin resolver (el auditor todavia los completa)."""
        with contextlib.closing(sqlite3.connect(self.ruta)) as con:
            for d in range(2):
                t = DIA0 + d * DAY_MS + 5 * HORA
                abierta = d == 1
                con.execute("INSERT INTO hechos_mirada VALUES('PF_ETHUSD',?,?,?,0.4,2,?,?,?,?,1,'costos.v1','auditor.v1')",
                            (t - 900_000, t, '{"ret_1h":0.01}', '{"si":true}', "m" * 16, "p" * 16, "c" * 64))
                con.execute("INSERT INTO propuestas VALUES('PF_ETHUSD',?,?,1,1,'bloqueada','lugares_ocupados',NULL,NULL,2,0.4,0.8,100.0,?,?,?,?,?,?,'auditor.v1')",
                            (t - 900_000, t, None if abierta else '{"neto_pb":5.0}', None if abierta else 5.0, None if abierta else "maestro_vuelta",
                             None if abierta else 3.0, None if abierta else t + 3 * HORA, None if abierta else t + 40 * HORA))
                con.execute("INSERT INTO mirada_operaciones VALUES('PF_ETHUSD',?,7,?,1,'mantiene','formula',?,100.0,2.0,10.0,0.4,2,0.4,2,'MANTENER',NULL,'auditor.v1')",
                            (t - 900_000, t, t - 2 * HORA))
                con.execute("INSERT INTO operaciones VALUES('PF_ETHUSD',?,1,?,?,'{}',10.0,-5.0,?,?,'auditor.v1')",
                            (d + 1, t, t + HORA, t + HORA, None if abierta else t + 40 * HORA))
                con.execute("INSERT INTO sombra_maker VALUES('PF_ETHUSD',?,?,?,1,'compra',?,2250.1,0.225,'taker',0.2,450.02,?,2250.0,'maker',NULL,?,2250.0,NULL,?,0.09,'maker',0.15,3.4,"
                            "'sombra-maker.v1','kraken-futures-costs.v2',?,'auditor.v1')",
                            (d + 1, "entry", None, t, t - 5_000, t + 30_000, 30_000, t + HORA))
                con.execute("INSERT INTO sombra_maker VALUES('PF_ETHUSD',?,?,?,1,'venta',?,2300.0,0.23,'taker',0.2,460.0,NULL,NULL,'sin_datos','sin_libro',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,"
                            "'sombra-maker.v1','kraken-futures-costs.v2',?,'auditor.v1')",
                            (d + 1, "exit", "vuelta", t + 2 * HORA, t + 3 * HORA))
                con.execute("INSERT INTO resultados_operacion VALUES('PF_ETHUSD',?,1,?,?,80.0,0.8,100.0,'formula','formula','maestro_vuelta',100.0,101.0,300.0,-100.0,?,?,'auditor.v1')",
                            (d + 1, t, t + HORA, t + HORA, None if abierta else t + 40 * HORA))
            con.commit()
        aud.registrar_reentreno(os.path.join(self.tmp.name, "snapshots", "live.sqlite"), corte_ms=DIA0, dataset_hash="ab" * 32,
                                spec={"modelo": "logistica"}, metricas={"auc": 0.54}, creado_ms=DIA0 + HORA)

    def test_las_tablas_nuevas_se_exportan_verifican_y_lo_no_resuelto_espera(self):
        self.poblar()
        reporte = exportar(self.ruta, "qwen-live__auditor", self.destino, ahora_ms=DIA0 + 60 * DAY_MS, copia_confirmada=True)
        self.assertEqual(reporte["no_confirmados"], [])
        # ninguna columna de SQLite de las tablas nuevas queda fuera de la configuracion (``miradas.direccion_*`` viene de antes: ver el informe)
        self.assertEqual([a for a in reporte.get("avisos", []) if a["tabla"] in NUEVAS], [])
        self.assertEqual(verificar(self.destino)["problemas"], [])
        hechos = {(e["tabla"], e["dia"]): e["filas"] for e in leer_manifiesto(self.destino)}
        dia0, dia1 = dia_de(DIA0).isoformat(), dia_de(DIA0 + DAY_MS).isoformat()
        for nombre in ("auditor_hechos", "auditor_mirada_operaciones", "auditor_sombra"):    # solo-agregar: los dos dias
            self.assertEqual({d: hechos[(nombre, d)] for d in (dia0, dia1)}, {dia0: 2 if nombre == "auditor_sombra" else 1,
                                                                            dia1: 2 if nombre == "auditor_sombra" else 1}, nombre)
        for nombre in ("auditor_propuestas", "auditor_operaciones", "auditor_resultados"):    # se completan despues: solo el dia resuelto
            self.assertEqual(hechos.get((nombre, dia0)), 1, nombre)
            self.assertNotIn((nombre, dia1), hechos)
        pendientes = {p["tabla"] for p in reporte["pendientes_por_abrir"] if p["dia"] == dia1}
        self.assertEqual(pendientes, {"auditor_propuestas", "auditor_operaciones", "auditor_resultados"})
        self.assertEqual([e["filas"] for e in leer_manifiesto(self.destino) if e["tabla"] == "auditor_reentrenos"], [1])

    def test_la_corrida_nocturna_no_deja_tablas_sin_cubrir_en_la_base_del_auditor(self):
        self.poblar()
        with contextlib.closing(sqlite3.connect(self.ruta)) as con:
            self.assertEqual(nocturno._tablas_sin_cubrir(con, "qwen-live__auditor"), [])
            self.assertEqual(sorted(nocturno._tablas_presentes(con)), sorted(["auditor_miradas"] + list(NUEVAS)))


if __name__ == "__main__":
    unittest.main()
