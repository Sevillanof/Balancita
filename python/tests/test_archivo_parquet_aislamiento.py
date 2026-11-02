"""Archivo Parquet (fase 1): solo ``archivo_parquet/formato.py`` importa pyarrow, nadie importa duckdb, y el motor y la captura no importan el
paquete. Sin dependencias: solo lee el codigo fuente."""
import os
import unittest

from test_cruda_aislamiento import ROOT, imports, python_files

PAQUETE = os.path.join(ROOT, "python", "archivo_parquet")
FORMATO = os.path.join(PAQUETE, "formato.py")


class AislamientoTests(unittest.TestCase):
    def test_solo_formato_importa_pyarrow(self):
        ofensores = []
        for ruta in python_files():
            if ruta.startswith(os.path.join(ROOT, "python", "experimentos")) or ruta == FORMATO:
                continue
            for modulo, linea in imports(ruta):
                if modulo in ("pyarrow", "duckdb"):
                    ofensores.append("%s:%d importa %s" % (os.path.relpath(ruta, ROOT), linea, modulo))
        self.assertEqual(ofensores, [])

    def test_el_paquete_nunca_importa_duckdb(self):
        for nombre in os.listdir(PAQUETE):
            if nombre.endswith(".py"):
                self.assertNotIn("duckdb", {m for m, _ in imports(os.path.join(PAQUETE, nombre))}, nombre)

    def test_motor_y_captura_no_importan_el_archivo(self):
        ofensores = []
        for ruta in python_files():
            rel = os.path.relpath(ruta, ROOT)
            if rel.startswith(os.path.join("python", "balancita_engine")) or rel.startswith("server"):
                ofensores += ["%s:%d" % (rel, n) for m, n in imports(ruta) if m == "archivo_parquet"]
        self.assertEqual(ofensores, [])

    def test_ningun_archivo_de_dependencias_lo_lista(self):
        for nombre in ("pyproject.toml", "requirements.txt", "package.json", "pnpm-lock.yaml"):
            ruta = os.path.join(ROOT, nombre)
            if os.path.exists(ruta):
                with open(ruta, encoding="utf-8") as fh:
                    self.assertNotIn("pyarrow", fh.read().lower(), nombre)
        flujo = os.path.join(ROOT, ".github", "workflows")
        for nombre in os.listdir(flujo):
            with open(os.path.join(flujo, nombre), encoding="utf-8") as fh:
                self.assertNotIn("pyarrow", fh.read().lower(), nombre)


if __name__ == "__main__":
    unittest.main()
