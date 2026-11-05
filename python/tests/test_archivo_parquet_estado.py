"""Estado del archivo para la alerta del VPS: la ultima corrida real de nocturno tiene que ser reciente y completa."""
import contextlib
import io
import json
import os
import tempfile
import unittest

from archivo_parquet import cli, estado

AHORA_S = 1_793_857_200  # 2026-11-05T05:40:00Z
HORA = 3600


def linea(inicio_s, codigo, **extra):
    import datetime as dt
    r = {"inicio": dt.datetime.fromtimestamp(inicio_s, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "codigo": codigo,
         "dry_run": False, "bases": {}}
    r.update(extra)
    return r


class EstadoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.destino = self.tmp.name

    def escribir(self, *lineas):
        with open(os.path.join(self.destino, "nocturno.jsonl"), "w", encoding="utf-8") as fh:
            for l in lineas:
                fh.write((l if isinstance(l, str) else json.dumps(l)) + "\n")

    def test_sin_log_es_problema(self):
        self.assertEqual(estado.problema(self.destino, AHORA_S), "parquet: no hay nocturno.jsonl")

    def test_ultima_corrida_ok_y_reciente_no_es_problema(self):
        self.escribir(linea(AHORA_S - 30 * HORA, 1), linea(AHORA_S - 2 * HORA, 0))
        self.assertIsNone(estado.problema(self.destino, AHORA_S))

    def test_ultima_corrida_con_codigo_1_dice_que_quedo_incompleto(self):
        self.escribir(linea(AHORA_S - 2 * HORA, 1, sin_confirmar=3, bases_sin_cubrir=["qwen-live__live"], bases={
            "futures-news": {"estado": "omitida", "motivo": "ninguna_copia_valida: x: muy nueva"},
            "futures-market": {"estado": "ok"}, "positioning": {"estado": "con_huecos", "tablas_sin_cubrir": ["collector_run"]}}))
        self.assertEqual(estado.problema(self.destino, AHORA_S),
                         "parquet incompleto (2026-11-05T03:40:00Z, 3 sin confirmar): futures-news omitida, positioning con_huecos, "
                         "bases sin cubrir: qwen-live__live")

    def test_corrida_vieja_es_problema_aunque_haya_salido_bien(self):
        self.escribir(linea(AHORA_S - 27 * HORA, 0))
        self.assertEqual(estado.problema(self.destino, AHORA_S), "parquet: ultima corrida hace 27 h (maximo 26 h)")

    def test_pospuestas_dry_run_y_lineas_rotas_no_cuentan_como_corrida(self):
        self.escribir(linea(AHORA_S - 2 * HORA, 0), "{roto", linea(AHORA_S - HORA, 3), dict(linea(AHORA_S - 600, 1), dry_run=True))
        self.assertIsNone(estado.problema(self.destino, AHORA_S))
        self.escribir(linea(AHORA_S - 600, 3))
        self.assertEqual(estado.problema(self.destino, AHORA_S), "parquet: ninguna corrida real en nocturno.jsonl")

    def test_error_inesperado_muestra_su_motivo(self):
        self.escribir(linea(AHORA_S - HORA, 1, estado="error", motivo="RuntimeError: disco lleno"))
        self.assertEqual(estado.problema(self.destino, AHORA_S),
                         "parquet incompleto (2026-11-05T04:40:00Z): RuntimeError: disco lleno")

    def test_cli_estado_imprime_el_problema_y_sale_1_o_nada_y_0(self):
        self.escribir(linea(AHORA_S - HORA, 0))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["estado", "--destino", self.destino, "--ahora", str(AHORA_S)]), 0)
        self.assertEqual(out.getvalue(), "")
        self.escribir(linea(AHORA_S - 30 * HORA, 0))
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["estado", "--destino", self.destino, "--ahora", str(AHORA_S)]), 1)
        self.assertEqual(out.getvalue(), "parquet: ultima corrida hace 30 h (maximo 26 h)\n")


if __name__ == "__main__":
    unittest.main()
