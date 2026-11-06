"""Laboratorio: comparar la Terminal oficial contra una variante sobre la MISMA ventana y los MISMOS datos. Datos sintéticos, sin red."""
import contextlib
import copy
import hashlib
import io
import json
import os
import tempfile
import unittest
from unittest import mock

from balancita_engine import futures_estrategias as est
from balancita_engine import futures_estrategias_backtest as bt
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_live import BAR, walk

DAY = qt.DAY_MS


class Datos:
    """Lo que ``replay_formula`` pide a la historia: ``bars`` y ``funding``. Cuenta y recuerda lo que se le pidió."""

    def __init__(self, bars, funding=()):
        self._bars, self._funding = bars, list(funding)
        self.pedidos = []

    def bars(self, product, low, high, **_kw):
        self.pedidos.append(high)
        return [b for b in self._bars if low <= b["bucket_start"] < high]

    def funding(self, product):
        return list(self._funding)


def sintetico(desde, hasta, seed=1, extra_despues=0):
    """Velas 5 m desde 7 días (+10 velas) antes de ``desde`` hasta ``hasta`` (+ ``extra_despues`` días que nadie debe leer)."""
    low = qt.date_ms(desde) - (qt.MIN_BARS + 10) * BAR
    end = qt.date_ms(hasta) + extra_despues * DAY
    bars = walk((end - low) // BAR, seed, low, price=100)
    funding = [(at, 0) for at in range(low - DAY, end + DAY, qt.HOUR_MS)]
    return Datos(bars, funding)


def abre_si_esta_plana(trader, t_ms, reasons):
    """Decisión controlada: abre LARGO cuando no hay nada abierto; los cierres los hace la protección de tiempo del trader."""
    if not trader.positions:
        trader._open(t_ms, "LONG", 1, "controlled_test")
    return []


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = self.tmp.name
        real = est.cargar_snapshot()
        cfg = copy.deepcopy(real["config"])
        cfg["noticias"] = {"version": 1}                 # sin expertos ni noticias reales: la decisión está simulada
        for clave in ("analista", "funding_model", "execution"):
            cfg.pop(clave, None)
        cfg["exam"]["from"] = cfg["practice"]["from"] = "2026-01-01"
        doc = dict(real, config=cfg, config_hash=qt.config_hash(cfg))
        ruta = os.path.join(self.folder, "terminal-activa.json")
        with open(ruta, "w", encoding="utf-8") as handle:
            json.dump(doc, handle)
        self.snapshot = est.cargar_snapshot(ruta)
        patcher = mock.patch.object(qt.Trader, "_decide", abre_si_esta_plana)
        patcher.start()
        self.addCleanup(patcher.stop)

    def overlay(self, cambios, id="variante"):
        doc = {"id": id, "nombre": "Prueba", "descripcion": "Variante de prueba.",
               "base_config_hash": self.snapshot["config_hash"], "cambios": cambios}
        ruta = os.path.join(self.folder, id + ".json")
        with open(ruta, "w", encoding="utf-8") as handle:
            json.dump(doc, handle)
        return id, ruta

    def comparar(self, cambios, desde="2026-01-08", hasta="2026-01-13", datos=None, **kw):
        id, _ = self.overlay(cambios)
        datos = datos or sintetico(desde, hasta)
        return bt.comparar(id, desde, hasta, datos, carpeta=self.folder, snapshot=self.snapshot, **kw)


class MetricasTests(unittest.TestCase):
    def curva(self, entrada_h, salida_h, pnl, bp, motivo="tiempo", nocional=None, razon=None):
        """``nocional`` por defecto es el coherente con ``bp``: pnl / bp (así el neto en bp de cada operación es el que dice)."""
        if nocional is None:
            nocional = abs(float(pnl)) / abs(bp) * 1e4 if bp else 1000
        return {"entrada_ms": entrada_h * qt.HOUR_MS, "salida_ms": salida_h * qt.HOUR_MS, "pnl_usd": str(pnl), "neto_bp": bp,
                "motivo": motivo, "razon": razon, "lado": 1, "producto": "PF_ETHUSD", "notional_usd": str(nocional)}

    def test_metrics_math(self):
        curvas = [self.curva(0, 10, "10", 100), self.curva(10, 12, "-30", -300, "maestro_vuelta"),
                  self.curva(12, 14, "5", 50), self.curva(14, 20, "20", 200)]
        m = bt.metricas(curvas, "1000")
        self.assertEqual(m["operaciones"], 4)
        self.assertAlmostEqual(m["neto_usd"], 5.0)
        self.assertAlmostEqual(m["neto_bp_cuenta"], 50.0)               # 5 USD sobre 1000 USD de capital
        self.assertAlmostEqual(m["neto_bp_por_operacion"], 5 / 4000 * 1e4)        # ponderado por tamaño: Σ neto / Σ nocional
        self.assertAlmostEqual(m["neto_bp_promedio_simple"], 12.5)               # el promedio de los bp de cada operación, sin ponderar
        self.assertAlmostEqual(m["acierto"], 0.75)
        self.assertAlmostEqual(m["max_drawdown_usd"], 30.0)             # saldo 1010 -> 980
        self.assertAlmostEqual(m["max_drawdown_bp"], 30 / 1010 * 1e4, places=1)
        self.assertAlmostEqual(m["horas_promedio"], (10 + 2 + 2 + 6) / 4)
        self.assertEqual(m["horas_max"], 10.0)
        self.assertEqual(m["por_motivo"], {"tiempo": 3, "maestro_vuelta": 1})

    def test_net_bp_per_trade_is_weighted_by_size_so_a_tiny_position_cannot_flip_the_sign(self):
        """El defecto de la página: tres posiciones de 500 US$ ganan 1 % y una de 10 US$ pierde 30 %. Sin ponderar daba −7,5 bp pese a
        +14,7 US$ de neto; ponderado por el tamaño es lo que de verdad ganó cada dólar puesto."""
        curvas = [self.curva(0, 5, "5", 100, nocional=500), self.curva(5, 10, "5", 100, nocional=500),
                  self.curva(10, 15, "5", 100, nocional=500), self.curva(15, 20, "-3", -3000, nocional=10)]
        m = bt.metricas(curvas, "1000")
        self.assertAlmostEqual(m["neto_usd"], 12.0)
        self.assertAlmostEqual(m["neto_bp_promedio_simple"], -675.0)
        self.assertAlmostEqual(m["neto_bp_por_operacion"], 12 / 1510 * 1e4)
        self.assertGreater(m["neto_bp_por_operacion"], 0)                        # mismo signo que el neto en US$
        self.assertEqual((m["nocional_min_usd"], m["nocional_max_usd"]), (10.0, 500.0))
        self.assertAlmostEqual(m["nocional_promedio_usd"], 1510 / 4)

    def test_exit_reasons_use_the_exit_reason_when_there_is_one_and_the_closer_otherwise(self):
        curvas = [self.curva(0, 5, "5", 100, motivo="formula", razon="maestro_vuelta"),
                  self.curva(5, 10, "5", 100, motivo="formula", razon="maestro_agotado"),
                  self.curva(10, 15, "5", 100, motivo="tiempo"), self.curva(15, 20, "5", 100, motivo="formula", razon="maestro_vuelta")]
        self.assertEqual(bt.metricas(curvas, "1000")["por_motivo"], {"maestro_vuelta": 2, "maestro_agotado": 1, "tiempo": 1})

    def test_drawdown_follows_the_realized_balance_in_exit_order(self):
        curvas = [self.curva(0, 30, "-10", -100), self.curva(1, 5, "20", 200), self.curva(6, 8, "-5", -50)]
        m = bt.metricas(curvas, "1000")                                  # por salida: +20, -5, -10 -> pico 1020, piso 1005
        self.assertAlmostEqual(m["max_drawdown_usd"], 15.0)

    def test_no_trades_gives_zero_and_unknowns(self):
        m = bt.metricas([], "1000")
        self.assertEqual((m["operaciones"], m["neto_usd"], m["max_drawdown_usd"]), (0, 0.0, 0.0))
        for clave in ("acierto", "horas_promedio", "horas_max", "neto_bp_por_operacion", "neto_bp_promedio_simple", "nocional_promedio_usd",
                      "nocional_min_usd", "nocional_max_usd"):
            self.assertIsNone(m[clave], clave)

    def test_difference_is_variant_minus_official_and_unknown_when_one_side_is_unknown(self):
        ofi = bt.metricas([self.curva(0, 10, "10", 100)], "1000")
        var = bt.metricas([self.curva(0, 5, "30", 300), self.curva(5, 6, "-10", -100)], "1000")
        dif = bt.diferencia(ofi, var)
        self.assertEqual(dif["operaciones"], 1)
        self.assertAlmostEqual(dif["neto_usd"], 10.0)
        self.assertAlmostEqual(dif["horas_promedio"], 3 - 10)
        self.assertAlmostEqual(dif["horas_max"], 5 - 10)
        self.assertIsNone(bt.diferencia(bt.metricas([], "1000"), var)["acierto"])


class ComparacionTests(Base):
    def test_same_config_twice_gives_zero_difference(self):
        informe = self.comparar({"guardrails": {"max_hold_min": 2160}})      # el valor que ya tiene el snapshot
        self.assertEqual(informe["oficial"]["config_hash"], informe["variante"]["config_hash"])
        self.assertGreater(informe["oficial"]["metricas"]["operaciones"], 0)
        self.assertEqual(informe["oficial"]["metricas"], informe["variante"]["metricas"])
        self.assertTrue(all(v in (0, 0.0) for v in informe["diferencia"].values()), informe["diferencia"])

    def test_each_listed_trade_carries_its_size_and_exit_reason_and_the_metrics_use_them(self):
        informe = self.comparar({"guardrails": {"max_hold_min": 1440}})
        ops = informe["oficial"]["operaciones"]
        self.assertGreater(len(ops), 0)
        for o in ops:
            self.assertGreater(o["nocional_usd"], 0)
            self.assertIn("razon", o)
        m = informe["oficial"]["metricas"]
        self.assertAlmostEqual(m["neto_bp_por_operacion"], sum(o["neto_usd"] for o in ops) / sum(o["nocional_usd"] for o in ops) * 1e4)
        self.assertEqual((m["nocional_min_usd"], m["nocional_max_usd"]), (min(o["nocional_usd"] for o in ops), max(o["nocional_usd"] for o in ops)))
        incompletas = informe["oficial"]["funding_operaciones_incompletas"]
        self.assertIsInstance(incompletas, int)
        self.assertLessEqual(incompletas, 1)         # solo la que se cierra al final de la ventana: ahí el funding no se lee (sin look-ahead)
        self.assertEqual(informe["oficial"]["funding_completo"], incompletas == 0)

    def test_the_30h_style_cap_is_respected_by_every_trade_of_the_variant(self):
        informe = self.comparar({"guardrails": {"max_hold_min": 1440}}, hasta="2026-01-14")
        self.assertLessEqual(informe["variante"]["metricas"]["horas_max"], 24.0 + 1e-9)
        self.assertGreater(informe["oficial"]["metricas"]["horas_max"], 24.0)            # el oficial (36 h) sí deja pasar de 24 h

    def test_a_shorter_max_hold_closes_earlier_and_the_report_shows_it(self):
        informe = self.comparar({"guardrails": {"max_hold_min": 1440}}, hasta="2026-01-14")
        ofi, var, dif = (informe[k] if k == "diferencia" else informe[k]["metricas"] for k in ("oficial", "variante", "diferencia"))
        self.assertNotEqual(informe["oficial"]["config_hash"], informe["variante"]["config_hash"])
        self.assertAlmostEqual(ofi["horas_promedio"], 36.0, delta=0.5)
        self.assertAlmostEqual(var["horas_promedio"], 24.0, delta=0.5)
        self.assertLess(dif["horas_promedio"], -10)
        self.assertGreater(dif["operaciones"], 0)
        self.assertGreater(var["por_motivo"].get("tiempo", 0), ofi["por_motivo"].get("tiempo", 0))
        primera = informe["variante"]["operaciones"][0]
        self.assertEqual((primera["salida_ms"] - primera["entrada_ms"]) // qt.MINUTE_MS, 1440)

    def test_report_carries_the_provenance(self):
        id, ruta = self.overlay({"guardrails": {"max_hold_min": 1440}})
        datos = sintetico("2026-01-08", "2026-01-13")
        informe = bt.comparar(id, "2026-01-08", "2026-01-13", datos, carpeta=self.folder, snapshot=self.snapshot)
        with open(ruta, "rb") as handle:
            sha = hashlib.sha256(handle.read()).hexdigest()
        self.assertEqual(informe["schema"], bt.SCHEMA)
        self.assertEqual(informe["snapshot"]["config_hash"], self.snapshot["config_hash"])
        self.assertEqual(informe["estrategia"]["id"], "variante")
        self.assertEqual(informe["estrategia"]["overlay_sha256"], sha)
        self.assertEqual(informe["estrategia"]["cambios"], {"guardrails": {"max_hold_min": 1440}})
        self.assertEqual(informe["oficial"]["config_hash"], self.snapshot["config_hash"])
        self.assertEqual(informe["variante"]["config_hash"], est.hash_config(est.cargar_estrategia(id, self.folder, self.snapshot)))
        self.assertEqual((informe["ventana"]["desde"], informe["ventana"]["hasta"]), ("2026-01-08", "2026-01-13"))
        self.assertEqual(informe["ventana"]["desde_efectivo"], "2026-01-08")
        self.assertEqual(informe["ventana"]["reserva"]["incluida"], False)
        self.assertIn("fuente", informe["datos"])
        self.assertIn("sin noticias", " ".join(informe["limites"]))
        json.dumps(informe)                                               # serializable tal cual

    def test_both_configs_read_the_same_data_and_nothing_at_or_after_the_end(self):
        datos = sintetico("2026-01-08", "2026-01-13", extra_despues=3)
        limpio = sintetico("2026-01-08", "2026-01-13")
        a = self.comparar({"guardrails": {"max_hold_min": 1440}}, datos=datos)
        b = self.comparar({"guardrails": {"max_hold_min": 1440}}, datos=limpio)
        self.assertLessEqual(max(datos.pedidos), qt.date_ms("2026-01-13"))
        self.assertEqual(a["oficial"], b["oficial"])
        self.assertEqual(a["variante"], b["variante"])

    def test_the_window_refuses_any_request_past_its_end(self):
        datos = sintetico("2026-01-08", "2026-01-13")
        ventana = bt._Ventana(datos, qt.date_ms("2026-01-13"))
        ventana.bars("PF_ETHUSD", qt.date_ms("2026-01-08"), qt.date_ms("2026-01-13"))
        with self.assertRaises(qt.HoldoutError):
            ventana.bars("PF_ETHUSD", qt.date_ms("2026-01-08"), qt.date_ms("2026-01-13") + 1)
        corte = qt.date_ms("2026-01-13")
        self.assertTrue(all(s + qt.HOUR_MS <= corte for s, _ in ventana.funding("PF_ETHUSD")))

    def test_window_into_the_holdout_is_refused_before_touching_data(self):
        class Prohibido(Datos):
            def bars(self, *a, **k):
                raise AssertionError("no se leen datos")
        for desde, hasta in (("2026-04-10", "2026-04-20"), ("2026-04-25", "2026-04-30")):
            with self.assertRaises(bt.ComparacionError) as caught:
                self.comparar({"guardrails": {"max_hold_min": 1440}}, desde=desde, hasta=hasta, datos=Prohibido([]))
            self.assertIn("--incluir-reserva", str(caught.exception))
            self.assertIn("2026-04-19", str(caught.exception))

    def test_window_ending_exactly_at_the_holdout_is_allowed(self):
        informe = self.comparar({"guardrails": {"max_hold_min": 1440}}, desde="2026-04-14", hasta="2026-04-19")
        self.assertFalse(informe["ventana"]["reserva"]["incluida"])

    def test_holdout_window_with_explicit_flag_runs_and_is_marked(self):
        informe = self.comparar({"guardrails": {"max_hold_min": 1440}}, desde="2026-04-16", hasta="2026-04-21", incluir_reserva=True)
        reserva = informe["ventana"]["reserva"]
        self.assertTrue(reserva["incluida"])
        self.assertEqual(reserva["desde"], "2026-04-19")
        self.assertIn("reserva", reserva["aviso"].lower())

    def test_bad_windows_and_dates_are_refused(self):
        for desde, hasta in (("2026-01-13", "2026-01-08"), ("2026-01-08", "2026-01-08"), ("2026-1-8", "2026-01-13"), ("ayer", "2026-01-13")):
            with self.assertRaises(bt.ComparacionError):
                self.comparar({"guardrails": {"max_hold_min": 1440}}, desde=desde, hasta=hasta,
                              datos=sintetico("2026-01-08", "2026-01-13"))

    def test_unknown_strategy_is_refused_with_the_strategy_error(self):
        with self.assertRaises(est.EstrategiaError):
            bt.comparar("no-existe", "2026-01-08", "2026-01-13", sintetico("2026-01-08", "2026-01-13"),
                        carpeta=self.folder, snapshot=self.snapshot)

    def test_caller_configs_are_not_mutated(self):
        antes = copy.deepcopy(self.snapshot)
        self.comparar({"guardrails": {"max_hold_min": 1440}})
        self.assertEqual(self.snapshot, antes)
        self.assertEqual(qt.config_hash(self.snapshot["config"]), self.snapshot["config_hash"])

    def test_default_window_is_the_honest_one(self):
        self.assertEqual((bt.DESDE_HONESTA, bt.HASTA_HONESTA), ("2026-02-01", "2026-04-19"))
        visto = {}
        def falso(id, desde, hasta, *a, **k):
            visto.update(desde=desde, hasta=hasta)
            return {"schema": bt.SCHEMA}
        salida = io.StringIO()
        with mock.patch.object(bt, "comparar", falso), contextlib.redirect_stdout(salida):
            self.assertEqual(bt.main(["--estrategia", "x", "--json"]), 0)
        self.assertEqual(visto, {"desde": "2026-02-01", "hasta": "2026-04-19"})
        self.assertEqual(json.loads(salida.getvalue()), {"schema": bt.SCHEMA})


class PerillasLleganAlReplayTests(Base):
    """Auditoría: una variante cuyo hash cambia pero cuya conducta no cambia sería una prueba vacía. Cada perilla permitida tiene que
    llegar al ``Trader`` del replay y cambiar lo que hace (no solo el hash de la config). Aquí la decisión está simulada, así que no se
    prueban ``exhaust_hold_min`` ni ``rebotes.*`` (viven dentro de la decisión de la fórmula); esos se verificaron con datos reales:
    ``odd/tasks/estrategias-laboratorio-auditoria.md``."""

    def firma(self, cambios):
        ofi = self.snapshot["config"] if cambios is None else est.config_desde_overlay(
            {"id": "v", "nombre": "v", "descripcion": "v", "base_config_hash": self.snapshot["config_hash"], "cambios": cambios}, "v",
            self.snapshot)
        miradas = []

        def contar(trader, t_ms, reasons):
            miradas.append(t_ms)
            return abre_si_esta_plana(trader, t_ms, reasons)
        datos = sintetico("2026-01-08", "2026-01-16")
        with mock.patch.object(qt.Trader, "_decide", contar):
            r = bt.exam.replay_formula(bt._Ventana(datos, qt.date_ms("2026-01-16")), ofi, qt.date_ms("2026-01-16"),
                                       desde_ms=qt.date_ms("2026-01-08"))
        return {"miradas": len(miradas), "operaciones": [(c["entrada_ms"], c["salida_ms"], c["notional_usd"]) for c in r["curvas"]["formula"]]}

    def test_each_allowed_knob_changes_what_the_replay_does(self):
        base = self.firma(None)
        self.assertGreater(len(base["operaciones"]), 0)
        for clave, cambios in {"guardrails.max_hold_min": {"guardrails": {"max_hold_min": 720, "exhaust_hold_min": 600}},
                               "guardrails.cooldown_min": {"guardrails": {"cooldown_min": 600}},
                               "guardrails.stop_sigma_24h": {"guardrails": {"stop_sigma_24h": 0.2}},
                               "wake.flat_every_min": {"wake": {"flat_every_min": 60}},
                               "wake.position_every_min": {"wake": {"position_every_min": 120}}}.items():
            with self.subTest(clave=clave):
                self.assertNotEqual(self.firma(cambios), base)

    def test_the_variant_invests_exactly_like_the_official_one(self):
        """Las reglas de inversión no son perillas: el primer cupo de las dos toma el 33 % del saldo de 1000 US$ (sin analista en este snapshot)."""
        ofi = self.firma(None)["operaciones"]
        var = self.firma({"guardrails": {"max_hold_min": 1440}})["operaciones"]
        self.assertEqual((ofi[0][2], var[0][2]), ("330.00", "330.00"))


class CliTests(Base):
    def test_cli_refuses_the_holdout_with_exit_2_and_a_clear_message(self):
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            code = bt.main(["--estrategia", "ejemplo-salida-30h", "--desde", "2026-04-01", "--hasta", "2026-05-01"])
        self.assertEqual(code, 2)
        self.assertIn("--incluir-reserva", err.getvalue())
        self.assertEqual(out.getvalue(), "")

    def test_cli_passes_the_flags_and_prints_a_readable_report(self):
        informe = self.comparar({"guardrails": {"max_hold_min": 1440}})
        visto = {}
        def falso(id, desde, hasta, datos=None, **kw):
            visto.update(id=id, desde=desde, hasta=hasta, **kw)
            return informe
        out = io.StringIO()
        with mock.patch.object(bt, "comparar", falso), contextlib.redirect_stdout(out):
            code = bt.main(["--estrategia", "variante", "--desde", "2026-01-08", "--hasta", "2026-01-13", "--incluir-reserva"])
        self.assertEqual(code, 0)
        self.assertEqual((visto["id"], visto["desde"], visto["hasta"], visto["incluir_reserva"]), ("variante", "2026-01-08", "2026-01-13", True))
        texto = out.getvalue()
        for pedazo in ("variante", informe["snapshot"]["config_hash"][:12], "Oficial", "Variante", "Diferencia", "Operaciones"):
            self.assertIn(pedazo, texto)


if __name__ == "__main__":
    unittest.main()
