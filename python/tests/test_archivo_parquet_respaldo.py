"""Archivo Parquet (fase 2): respaldo con rclone y restaurar-prueba, con un runner falso que simula el remoto en una carpeta local.
No necesita rclone ni pyarrow (los archivos son bytes de prueba con su linea de manifiesto); la relectura Parquet se prueba aparte."""
import contextlib
import hashlib
import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from archivo_parquet import cli, formato, respaldo
from archivo_parquet.util import ErrorArchivo, NOMBRE_MANIFIESTO

REMOTO = "falso:archivo"


class RemotoFalso:
    """Imita rclone sobre una carpeta: lsjson, copyto y check. Registra cada llamada. Fallos inyectables."""

    def __init__(self, raiz, con_hash=True):
        self.raiz, self.con_hash = raiz, con_hash
        self.llamadas = []
        self.falla_al_subir = set()  # rutas cuyo copyto devuelve error
        self.corrompe_al_subir = set()  # rutas que quedan danadas en silencio tras subir

    def _ruta(self, texto):
        assert texto.startswith("falso:archivo"), texto
        return os.path.join(self.raiz, texto[len("falso:archivo"):].lstrip("/"))

    def __call__(self, args):
        self.llamadas.append(list(args))
        if args[0] == "lsjson":
            base = self._ruta(args[-1])
            if not os.path.isdir(base):
                return 3, "", "directory not found"
            filas = []
            for carpeta, _, archivos in os.walk(base):
                for f in archivos:
                    p = os.path.join(carpeta, f)
                    fila = {"Path": os.path.relpath(p, base).replace(os.sep, "/"), "Size": os.path.getsize(p), "IsDir": False}
                    if self.con_hash:
                        fila["Hashes"] = {"sha256": hashlib.sha256(leer(p)).hexdigest(), "md5": "x"}
                    filas.append(fila)
            return 0, json.dumps(filas), ""
        if args[0] == "copyto":
            src, dst = args[-2], args[-1]
            if src.startswith("falso:"):  # bajar
                s = self._ruta(src)
                if not os.path.isfile(s):
                    return 1, "", "error: object not found en %s" % src
                shutil.copyfile(s, dst)
                return 0, "", ""
            rel = dst[len("falso:archivo/"):]
            if rel in self.falla_al_subir:
                return 1, "", "Failed to copyto a %s: boom" % dst
            d = self._ruta(dst)
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copyfile(src, d)
            if rel in self.corrompe_al_subir:
                with open(d, "r+b") as fh:
                    fh.write(b"\xff")
            return 0, "", ""
        if args[0] == "check":
            raiz, remoto = args[1], self._ruta(args[2])
            lista = [l.strip() for l in leer(args[args.index("--files-from-raw") + 1], "r").splitlines() if l.strip()]
            bien = all(os.path.isfile(os.path.join(remoto, r)) and leer(os.path.join(raiz, r)) == leer(os.path.join(remoto, r))
                       for r in lista)
            return (0 if bien else 1), "", ""
        return 99, "", "no soportado"


def leer(ruta, modo="rb"):
    with open(ruta, modo) as fh:
        return fh.read()


def sha(b):
    return hashlib.sha256(b).hexdigest()


class RespaldoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # los "parquet" de estas pruebas son bytes sueltos: sin relectura Parquet (esa se prueba en test_archivo_parquet_fase2)
        parche = mock.patch.object(formato, "disponible", return_value=False)
        parche.start()
        self.addCleanup(parche.stop)
        self.destino = os.path.join(self.tmp.name, "archivo")
        self.remoto_dir = os.path.join(self.tmp.name, "remoto")
        self.rem = RemotoFalso(self.remoto_dir)
        self.rutas = []
        for i, dia in enumerate(("2026-10-01", "2026-10-02", "2026-10-03")):
            self.agrega("b/verdicts/anio=2026/mes=10/dia=%02d/part-%08d.parquet" % (i + 1, i), ("contenido %d " % i).encode() * 50, dia)

    def agrega(self, rel, datos, dia):
        ruta = os.path.join(self.destino, rel)
        os.makedirs(os.path.dirname(ruta), exist_ok=True)
        with open(ruta, "wb") as fh:
            fh.write(datos)
        e = {"base": "b", "tabla": "verdicts", "dia": dia, "ruta": rel, "bytes": len(datos), "sha256": sha(datos), "filas": 3}
        with open(os.path.join(self.destino, NOMBRE_MANIFIESTO), "ab") as fh:
            fh.write((json.dumps(e, sort_keys=True) + "\n").encode())
        self.rutas.append(rel)

    def run_(self, **kw):
        return respaldo.respaldar(self.destino, REMOTO, runner=self.rem, **kw)

    def en_remoto(self):
        return sorted(os.path.relpath(os.path.join(c, f), self.remoto_dir).replace(os.sep, "/")
                      for c, _, fs in os.walk(self.remoto_dir) for f in fs)

    def test_sube_solo_lo_que_falta_manifiesto_al_final_y_confirma(self):
        r = self.run_()
        self.assertEqual((r["fallidos"], r["no_confirmados"], r["problemas_locales"]), ([], [], []))
        self.assertEqual(sorted(r["subidos"]), sorted(self.rutas))
        self.assertEqual(self.en_remoto(), sorted(self.rutas + [NOMBRE_MANIFIESTO]))
        copias = [a[-1] for a in self.rem.llamadas if a[0] == "copyto"]
        self.assertEqual(copias[-1], "falso:archivo/" + NOMBRE_MANIFIESTO, "el manifiesto va al final")
        self.assertTrue(all("--checksum" in a for a in self.rem.llamadas if a[0] == "copyto"))
        self.assertEqual(respaldo.confirmados_fuera(self.destino), set(self.rutas + [NOMBRE_MANIFIESTO]))
        self.assertEqual(respaldo.codigo_salida(r), 0)
        # segunda corrida: no sube nada y no agrega lineas de estado
        n_estado = len(leer(os.path.join(self.destino, respaldo.NOMBRE_ESTADO), "r").splitlines())
        antes = len(self.rem.llamadas)
        r2 = self.run_()
        self.assertEqual((r2["subidos"], r2["ya_en_remoto"], r2["manifiesto_subido"]), ([], 3, False))
        self.assertFalse([a for a in self.rem.llamadas[antes:] if a[0] == "copyto"])
        self.assertEqual(len(leer(os.path.join(self.destino, respaldo.NOMBRE_ESTADO), "r").splitlines()), n_estado)
        # un archivo nuevo: sube solo ese (+ manifiesto)
        self.agrega("b/verdicts/anio=2026/mes=10/dia=04/part-00000009.parquet", b"nuevo" * 40, "2026-10-04")
        r3 = self.run_()
        self.assertEqual(r3["subidos"], [self.rutas[-1]])
        self.assertTrue(r3["manifiesto_subido"])

    def test_estado_tiene_archivo_fecha_y_confirmado(self):
        from datetime import datetime, timezone
        self.run_(ahora=datetime(2026, 11, 2, 3, 0, tzinfo=timezone.utc))
        lineas = [json.loads(l) for l in leer(os.path.join(self.destino, respaldo.NOMBRE_ESTADO), "r").splitlines()]
        self.assertEqual(len(lineas), 4)
        for l in lineas:
            self.assertEqual((l["fecha"], l["confirmado_fuera"]), ("2026-11-02T03:00:00Z", True))
        self.assertEqual({l["archivo"] for l in lineas}, set(self.rutas + [NOMBRE_MANIFIESTO]))

    def test_dry_run_no_sube_ni_escribe(self):
        r = self.run_(dry_run=True)
        self.assertEqual(sorted(r["por_subir"]), sorted(self.rutas))
        self.assertFalse([a for a in self.rem.llamadas if a[0] == "copyto"])
        self.assertFalse(os.path.exists(os.path.join(self.destino, respaldo.NOMBRE_ESTADO)))
        self.assertFalse(os.path.exists(self.remoto_dir))

    def test_fallo_parcial_no_sube_manifiesto_con_lo_que_falta_y_se_recupera(self):
        self.rem.falla_al_subir = {self.rutas[1]}
        r = self.run_()
        self.assertEqual([f["ruta"] for f in r["fallidos"]], [self.rutas[1]])
        self.assertEqual(respaldo.codigo_salida(r), 1)
        self.assertEqual(self.en_remoto(), sorted([self.rutas[0], self.rutas[2], NOMBRE_MANIFIESTO]))
        man_remoto = leer(os.path.join(self.remoto_dir, NOMBRE_MANIFIESTO), "r")
        self.assertNotIn(self.rutas[1], man_remoto, "el manifiesto remoto solo lista lo confirmado")
        self.assertIn(self.rutas[0], man_remoto)
        estado = respaldo.leer_estado(self.destino)
        self.assertFalse(estado[self.rutas[1]]["confirmado_fuera"])
        self.assertTrue(estado[self.rutas[0]]["confirmado_fuera"])
        # el fallo se arregla: la proxima corrida sube solo lo que falto
        self.rem.falla_al_subir = set()
        r2 = self.run_()
        self.assertEqual(r2["subidos"], [self.rutas[1]])
        self.assertEqual(respaldo.codigo_salida(r2), 0)
        self.assertEqual(respaldo.confirmados_fuera(self.destino), set(self.rutas + [NOMBRE_MANIFIESTO]))

    def test_archivo_corrupto_en_el_remoto_se_detecta_y_se_repara_sin_borrar(self):
        self.run_()
        malo = os.path.join(self.remoto_dir, self.rutas[0])
        with open(malo, "r+b") as fh:
            fh.write(b"XXXX")  # mismo tamano, otro contenido
        r = self.run_()
        self.assertEqual(r["subidos"], [self.rutas[0]])
        self.assertEqual(leer(malo), leer(os.path.join(self.destino, self.rutas[0])))
        self.assertEqual(respaldo.codigo_salida(r), 0)
        # tamano distinto tambien
        with open(malo, "ab") as fh:
            fh.write(b"extra")
        self.assertEqual(self.run_()["subidos"], [self.rutas[0]])

    def test_corrupcion_silenciosa_al_subir_queda_sin_confirmar(self):
        self.rem.corrompe_al_subir = {self.rutas[2]}
        r = self.run_()
        self.assertEqual([n["ruta"] for n in r["no_confirmados"]], [self.rutas[2]])
        self.assertEqual(respaldo.codigo_salida(r), 1)
        self.assertNotIn(self.rutas[2], respaldo.confirmados_fuera(self.destino))
        self.assertNotIn(self.rutas[2], leer(os.path.join(self.remoto_dir, NOMBRE_MANIFIESTO), "r"))

    def test_archivo_local_alterado_no_se_sube(self):
        with open(os.path.join(self.destino, self.rutas[0]), "r+b") as fh:
            fh.write(b"ZZ")
        r = self.run_()
        self.assertEqual([p["ruta"] for p in r["problemas_locales"]], [self.rutas[0]])
        self.assertNotIn(self.rutas[0], self.en_remoto())
        self.assertEqual(respaldo.codigo_salida(r), 1)

    def test_remoto_sin_sha256_usa_check_y_no_rebaja_lo_ya_confirmado(self):
        self.rem.con_hash = False
        r = self.run_()
        self.assertEqual(respaldo.codigo_salida(r), 0)
        self.assertTrue([a for a in self.rem.llamadas if a[0] == "check"])
        antes = len(self.rem.llamadas)
        self.run_()  # nada nuevo: ya confirmado antes, no vuelve a bajar todo
        self.assertFalse([a for a in self.rem.llamadas[antes:] if a[0] in ("check", "copyto")])
        # y si el contenido del remoto difiere con el mismo tamano, check lo atrapa en un archivo nuevo
        self.agrega("b/verdicts/anio=2026/mes=10/dia=05/part-0000000a.parquet", b"otro" * 30, "2026-10-05")
        self.rem.corrompe_al_subir = {self.rutas[-1]}
        r = self.run_()
        self.assertEqual([n["ruta"] for n in r["no_confirmados"]], [self.rutas[-1]])

    def test_nunca_borra_ni_usa_subcomandos_peligrosos(self):
        self.rem.falla_al_subir = {self.rutas[0]}
        self.run_()
        self.rem.falla_al_subir = set()
        self.run_()
        self.run_(dry_run=True)
        usados = {a[0] for a in self.rem.llamadas}
        self.assertLessEqual(usados, {"lsjson", "copyto", "check"})
        antes = {r: leer(os.path.join(self.destino, r)) for r in self.rutas}
        self.assertEqual(sorted(os.path.relpath(os.path.join(c, f), self.destino).replace(os.sep, "/")
                                for c, _, fs in os.walk(self.destino) for f in fs if f.startswith("part-")), sorted(self.rutas))
        self.assertTrue(all(leer(os.path.join(self.destino, r)) == antes[r] for r in self.rutas))
        r = respaldo.Rclone(self.rem, REMOTO)
        for malo in ("sync", "delete", "deletefile", "move", "moveto", "purge", "rmdirs", "cleanup"):
            with self.assertRaises(ErrorArchivo):
                r._correr([malo, "x"])
        # el codigo no menciona esos subcomandos como llamada
        fuente = leer(respaldo.__file__, "r")
        for malo in ('"sync"', '"delete"', '"move"', '"purge"', '"deletefile"'):
            self.assertNotIn(malo, fuente)

    def test_remoto_solo_nombre_ruta_y_sin_credenciales_en_salidas(self):
        for malo in (":sftp,host=x,pass=secreto:/r", "sin-dos-puntos", "a,pass=1:r", ""):
            with self.assertRaises(ErrorArchivo):
                respaldo.validar_remoto(malo)
        respaldo.validar_remoto("mi-remoto:carpeta/sub")
        self.rem.falla_al_subir = {self.rutas[0]}
        r = respaldo.respaldar(self.destino, "falso:archivo", runner=self.rem)
        texto = json.dumps(r) + leer(os.path.join(self.destino, respaldo.NOMBRE_ESTADO), "r")
        self.assertNotIn("falso:archivo", texto)

    def test_rclone_ausente_falla_con_mensaje_claro(self):
        with mock.patch("shutil.which", return_value=None):
            with self.assertRaises(ErrorArchivo) as cm:
                respaldo.runner_rclone()
        self.assertIn("rclone", str(cm.exception))
        with mock.patch("shutil.which", return_value=None), contextlib.redirect_stderr(io.StringIO()) as err, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["respaldar", "--destino", self.destino, "--remoto", REMOTO]), 2)
        self.assertIn("rclone", err.getvalue())

    def test_sin_manifiesto_no_hace_nada(self):
        os.remove(os.path.join(self.destino, NOMBRE_MANIFIESTO))
        with self.assertRaises(ErrorArchivo):
            self.run_()

    def test_restaurar_prueba_dia_indicado_y_al_azar(self):
        self.run_()
        r = respaldo.restaurar_prueba(self.destino, REMOTO, dia="2026-10-02", runner=self.rem)
        self.assertEqual((r["dia"], r["problemas"], [a["ruta"] for a in r["archivos"]]), ("2026-10-02", [], [self.rutas[1]]))
        a = respaldo.restaurar_prueba(self.destino, REMOTO, semilla=5, runner=self.rem)
        b = respaldo.restaurar_prueba(self.destino, REMOTO, semilla=5, runner=self.rem)
        self.assertEqual(a["dia"], b["dia"])
        self.assertEqual(a["problemas"], [])
        with self.assertRaises(ErrorArchivo):
            respaldo.restaurar_prueba(self.destino, REMOTO, dia="1999-01-01", runner=self.rem)
        # no deja nada en el archivo ni cambia nada en el remoto
        self.assertEqual(self.en_remoto(), sorted(self.rutas + [NOMBRE_MANIFIESTO]))

    def test_restaurar_prueba_detecta_corrupto_y_faltante(self):
        self.run_()
        with open(os.path.join(self.remoto_dir, self.rutas[0]), "r+b") as fh:
            fh.write(b"QQ")
        r = respaldo.restaurar_prueba(self.destino, REMOTO, dia="2026-10-01", runner=self.rem)
        self.assertEqual(len(r["problemas"]), 1)
        self.assertIn("sha256", r["problemas"][0]["problema"])
        os.remove(os.path.join(self.remoto_dir, self.rutas[1]))
        r = respaldo.restaurar_prueba(self.destino, REMOTO, dia="2026-10-02", runner=self.rem)
        self.assertEqual(len(r["problemas"]), 1)
        with mock.patch.object(respaldo, "restaurar_prueba", wraps=respaldo.restaurar_prueba), contextlib.redirect_stdout(io.StringIO()), \
                mock.patch("archivo_parquet.respaldo.runner_rclone", return_value=self.rem):
            self.assertEqual(cli.main(["restaurar-prueba", "--destino", self.destino, "--remoto", REMOTO, "--dia", "2026-10-02"]), 1)
            self.assertEqual(cli.main(["restaurar-prueba", "--destino", self.destino, "--remoto", REMOTO, "--dia", "2026-10-03"]), 0)

    def test_cli_respaldar(self):
        with mock.patch("archivo_parquet.respaldo.runner_rclone", return_value=self.rem), contextlib.redirect_stdout(io.StringIO()) as out, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["respaldar", "--destino", self.destino, "--remoto", REMOTO, "--dry-run"]), 0)
            self.assertEqual(cli.main(["respaldar", "--destino", self.destino, "--remoto", REMOTO]), 0)
        self.assertIn("subidos", out.getvalue())


if __name__ == "__main__":
    unittest.main()
