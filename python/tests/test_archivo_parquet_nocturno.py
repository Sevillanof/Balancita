"""Archivo Parquet (fase 3, parte A): exportacion nocturna. La eleccion de copia, el candado, el despertar y el dry-run no necesitan pyarrow;
la corrida completa (exportar + verificar) se salta si no esta instalado."""
import contextlib
import io
import json
import os
import tempfile
import unittest
from unittest import mock

from archivo_parquet import cli, formato, nocturno, sintetico
from archivo_parquet.config import DAY_MS
from archivo_parquet.util import dia_de, inicio_dia_ms

DIA0 = inicio_dia_ms(dia_de(1_700_000_000_000))
AHORA_S = (DIA0 + 10 * DAY_MS) / 1000
SIN_DESPERTAR = lambda: None  # noqa: E731


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.resp = os.path.join(self.tmp.name, "backups")
        self.destino = os.path.join(self.tmp.name, "archivo")
        os.makedirs(self.resp)

    def copia(self, base="futures-verdicts", sello="20261102-040000", dias=2, edad_s=3600, tablas=("verdicts",)):
        ruta = os.path.join(self.resp, "%s-%s.sqlite" % (base, sello))
        sintetico.crear_copia(ruta, DIA0, dias, ("PF_XBTUSD",), 600_000, tablas)
        os.utime(ruta, (AHORA_S - edad_s, AHORA_S - edad_s))
        return ruta

    def correr(self, **kw):
        kw.setdefault("despertar", SIN_DESPERTAR)
        kw.setdefault("ahora_s", AHORA_S)
        kw.setdefault("aplicar_nice", False)
        kw.setdefault("bases", ("futures-verdicts",))
        return nocturno.correr(self.destino, self.resp, **kw)


class EleccionDeCopia(Base):
    def test_elige_la_mas_reciente_que_pasa_quick_check(self):
        buena = self.copia(sello="20261101-040000")
        mala = os.path.join(self.resp, "futures-verdicts-20261102-040000.sqlite")
        with open(mala, "wb") as fh:
            fh.write(b"esto no es una base")
        os.utime(mala, (AHORA_S - 3600, AHORA_S - 3600))
        con, ruta, motivo = nocturno.elegir_copia(self.resp, "futures-verdicts", AHORA_S)
        self.assertEqual(ruta, buena)
        con.close()

    def test_ignora_tmp_y_otras_bases_y_espera_si_hay_tmp_reciente(self):
        self.copia(base="positioning", tablas=("verdicts",))
        self.assertEqual(nocturno.elegir_copia(self.resp, "futures-verdicts", AHORA_S)[2], "sin_copias")
        self.copia()
        tmp = os.path.join(self.resp, "futures-verdicts-20261103-040000.sqlite.tmp")
        open(tmp, "w").close()
        os.utime(tmp, (AHORA_S - 60, AHORA_S - 60))
        self.assertEqual(nocturno.elegir_copia(self.resp, "futures-verdicts", AHORA_S)[2], "copia_en_curso")
        os.utime(tmp, (AHORA_S - 5 * 3600, AHORA_S - 5 * 3600))  # un .tmp viejo es un resto de un fallo, no una copia en curso
        con, ruta, _ = nocturno.elegir_copia(self.resp, "futures-verdicts", AHORA_S)
        self.assertIsNotNone(con)
        con.close()

    def test_copia_demasiado_nueva_no_se_usa(self):
        self.copia(edad_s=30)
        con, _, motivo = nocturno.elegir_copia(self.resp, "futures-verdicts", AHORA_S)
        self.assertIsNone(con)
        self.assertIn("muy nueva", motivo)

    def test_nunca_toca_una_base_viva(self):
        # la carpeta de copias no puede ser dev-live
        viva = os.path.join(self.tmp.name, "dev-live")
        os.makedirs(viva)
        ruta = os.path.join(viva, "futures-verdicts-20261102-040000.sqlite")
        sintetico.crear_copia(ruta, DIA0, 1, ("PF_XBTUSD",), 600_000)
        os.utime(ruta, (AHORA_S - 3600, AHORA_S - 3600))
        con, _, motivo = nocturno.elegir_copia(viva, "futures-verdicts", AHORA_S)
        self.assertIsNone(con)
        self.assertIn("dev-live", motivo)


class Corrida(Base):
    def test_despertar_reciente_pospone_con_codigo_3(self):
        self.copia()
        res = self.correr(despertar=lambda: AHORA_S - 60, dry_run=True)  # en dry-run no espera
        self.assertEqual((res["estado"], res["codigo"]), ("pospuesta_por_despertar", 3))
        res = self.correr(despertar=lambda: AHORA_S - 3600, dry_run=True)
        self.assertNotEqual(res["codigo"], 3)

    def reloj_falso(self, despertares=()):
        """(reloj, dormir, dormidos, despertar): el tiempo solo avanza al 'dormir'; ``despertares`` = [(instante, nuevo_despertar)]."""
        est = {"t": AHORA_S, "w": AHORA_S - 60}
        dormidos = []

        def dormir(s):
            dormidos.append(s)
            est["t"] += s
            for t, w in despertares:
                if est["t"] >= t:
                    est["w"] = w
        return (lambda: est["t"]), dormir, dormidos, (lambda: est["w"])

    @unittest.skipUnless(formato.disponible(), "pyarrow no esta instalado")
    def test_despertar_reciente_espera_y_luego_exporta(self):
        self.copia()
        reloj, dormir, dormidos, despertar = self.reloj_falso()
        res = self.correr(despertar=despertar, dormir=dormir, reloj=reloj)
        self.assertEqual(res["codigo"], 0, res)
        self.assertTrue(dormidos and all(d <= nocturno.TRAMO_ESPERA_S for d in dormidos))
        self.assertGreaterEqual(sum(dormidos), nocturno.PAUSA_DESPERTAR_S - 60)
        self.assertLessEqual(sum(dormidos), nocturno.PAUSA_DESPERTAR_S - 60 + nocturno.TRAMO_ESPERA_S)
        self.assertEqual(res["esperado_s"], int(sum(dormidos)))

    @unittest.skipUnless(formato.disponible(), "pyarrow no esta instalado")
    def test_nuevo_despertar_durante_la_espera_recalcula(self):
        self.copia()
        reloj, dormir, dormidos, despertar = self.reloj_falso([(AHORA_S + 120, AHORA_S + 120)])
        res = self.correr(despertar=despertar, dormir=dormir, reloj=reloj)
        self.assertEqual(res["codigo"], 0, res)
        self.assertGreaterEqual(sum(dormidos), 120 + nocturno.PAUSA_DESPERTAR_S)

    def test_tope_de_espera_sale_con_codigo_3(self):
        self.copia()
        reloj, dormir, dormidos, despertar = self.reloj_falso([(AHORA_S + 30 * k, AHORA_S + 30 * k) for k in range(1, 200)])
        res = self.correr(despertar=despertar, dormir=dormir, reloj=reloj)
        self.assertEqual((res["estado"], res["codigo"]), ("pospuesta_por_despertar", 3))
        self.assertGreaterEqual(sum(dormidos), nocturno.TOPE_ESPERA_S)
        self.assertLess(sum(dormidos), nocturno.TOPE_ESPERA_S + nocturno.TRAMO_ESPERA_S + 1)
        self.assertFalse(os.path.exists(os.path.join(self.destino, "manifiesto.jsonl")))

    def test_dry_run_no_escribe_nada(self):
        self.copia()
        res = self.correr(dry_run=True)
        self.assertEqual(res["codigo"], 0)
        self.assertTrue(res["bases"]["futures-verdicts"]["dry_run"])
        self.assertFalse(os.path.exists(self.destino))

    def test_base_sin_copias_no_es_fallo_pero_copia_invalida_si(self):
        res = self.correr(dry_run=True)
        self.assertEqual(res["codigo"], 0)
        self.assertEqual(res["bases"]["futures-verdicts"]["estado"], "omitida")
        mala = os.path.join(self.resp, "futures-verdicts-20261102-040000.sqlite")
        with open(mala, "wb") as fh:
            fh.write(b"basura")
        os.utime(mala, (AHORA_S - 3600, AHORA_S - 3600))
        self.assertEqual(self.correr(dry_run=True)["codigo"], 1)

    def test_candado_un_solo_proceso_a_la_vez(self):
        os.makedirs(self.destino)
        with nocturno.Candado(os.path.join(self.destino, nocturno.NOMBRE_LOCK)):
            with self.assertRaises(nocturno.OtraCorridaEnCurso):
                with nocturno.Candado(os.path.join(self.destino, nocturno.NOMBRE_LOCK)):
                    pass
            res = self.correr()
            self.assertEqual((res["estado"], res["codigo"]), ("otra_corrida_en_curso", 3))
        # liberado al salir
        with nocturno.Candado(os.path.join(self.destino, nocturno.NOMBRE_LOCK)):
            pass

    def test_cli_nocturno_dry_run_y_variables_de_entorno(self):
        self.copia()
        env = {nocturno.VARIABLE_DESTINO: self.destino, nocturno.VARIABLE_RESPALDOS: self.resp}
        out = io.StringIO()
        from unittest import mock
        with mock.patch.dict(os.environ, env), mock.patch.object(nocturno, "ultimo_despertar_s", return_value=None), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = cli.main(["nocturno", "--dry-run", "--bases", "futures-verdicts"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["destino"], self.destino)


@unittest.skipUnless(formato.disponible(), "pyarrow no esta instalado (entorno aparte, ver docs/archivo-parquet.md)")
class CorridaCompleta(Base):
    def test_exporta_verifica_deja_log_y_es_idempotente(self):
        self.copia()
        res = self.correr()
        self.assertEqual(res["codigo"], 0, res)
        self.assertGreater(res["bases"]["futures-verdicts"]["exportados"], 0)
        self.assertEqual(res["verificacion"]["problemas"], [])
        res2 = self.correr()
        self.assertEqual(res2["codigo"], 0)
        self.assertEqual(res2["bases"]["futures-verdicts"]["estado"], "sin_novedad")  # misma copia ya exportada hoy: sin quick_check
        self.assertEqual(res2["verificacion"]["problemas"], [])  # verificar sigue corriendo (detecta archivos danados)
        with mock.patch.object(nocturno, "abrir_copia", side_effect=AssertionError("no debe abrir la copia")):
            self.assertEqual(self.correr()["codigo"], 0)
        with open(os.path.join(self.destino, nocturno.NOMBRE_LOG)) as fh:
            lineas = [json.loads(l) for l in fh if l.strip()]
        self.assertEqual(len(lineas), 3)
        self.assertEqual(lineas[0]["estado"], "ok")

    def test_algo_sin_confirmar_sale_con_codigo_1(self):
        self.copia()
        self.assertEqual(self.correr()["codigo"], 0)
        # se danan los bytes de un archivo ya confirmado: verificar lo detecta
        for carpeta, _, archivos in os.walk(self.destino):
            for f in archivos:
                if f.endswith(".parquet"):
                    with open(os.path.join(carpeta, f), "ab") as fh:
                        fh.write(b"x")
                    break
        res = self.correr()
        self.assertEqual(res["codigo"], 1)
        self.assertTrue(res["verificacion"]["problemas"])


if __name__ == "__main__":
    unittest.main()
