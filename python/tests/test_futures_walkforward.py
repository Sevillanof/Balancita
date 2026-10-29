import json
import os
import shutil
import tempfile
import unittest

from balancita_engine import futures_qwen_corta as corta
from balancita_engine import futures_qwen_maestro as maestro
from balancita_engine import futures_qwen_portero as portero
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_walkforward as wf

CONFIG = os.path.join(os.path.dirname(__file__), "..", "..", "config")
H = qt.HOUR_MS


def ms(day):
    return qt.date_ms(day)


def trade(day_in, hours, net, product="PF_ETHUSD"):
    t_in = ms(day_in)
    return {"product": product, "t_in": t_in, "t_out": t_in + hours * H, "side": 1, "net": net, "motivo": "vuelta", "tamano": 1.0}


class PairsTableTest(unittest.TestCase):
    """The table of quarterly formulas: each quarter loads its own pair, checked against its hash."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        teacher = maestro.load(os.path.join(CONFIG, "qwen-lora-maestro.json"))
        keeper = portero.load(os.path.join(CONFIG, "qwen-portero.json"))
        table = {"schema": corta.PARES_SCHEMA, "trimestres": {}}
        for name, factor in (("2024Q1", 1.0), ("2024Q2", 2.0)):
            t = json.loads(json.dumps({k: v for k, v in teacher.items() if k != "_path"}))
            t["umbrales"] = {"flojo": t["umbrales"]["flojo"] * factor, "fuerte": t["umbrales"]["fuerte"] * factor}
            with open(os.path.join(self.tmp, "m-" + name + ".json"), "w", encoding="utf-8") as handle:
                json.dump(t, handle)
            with open(os.path.join(self.tmp, "p-" + name + ".json"), "w", encoding="utf-8") as handle:
                json.dump({k: v for k, v in keeper.items() if k != "_path"}, handle)
            table["trimestres"][name] = {"maestro": "m-" + name + ".json", "maestro_hash": maestro.teacher_hash(t),
                                         "portero": "p-" + name + ".json", "portero_hash": portero.portero_hash(keeper)[:12],
                                         "ajustado_hasta": "2023-12-30", "fotos": 10}
        self.path = os.path.join(self.tmp, "pares.json")
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(table, handle)
        self.cfg = {"corta": {"pares": self.path}}

    def test_each_time_gets_the_pair_of_its_quarter(self):
        first = corta.formulas(self.cfg, ms("2024-02-10"))[0]["umbrales"]["flojo"]
        second = corta.formulas(self.cfg, ms("2024-05-10"))[0]["umbrales"]["flojo"]
        self.assertAlmostEqual(second, 2 * first)

    def test_before_the_first_quarter_and_after_the_last_use_the_edge_pairs(self):
        flojo = lambda day: corta.formulas(self.cfg, ms(day))[0]["umbrales"]["flojo"]
        self.assertEqual(flojo("2023-06-01"), flojo("2024-01-02"))
        self.assertEqual(flojo("2026-01-01"), flojo("2024-06-30"))
        self.assertEqual(corta.formulas(self.cfg)[0]["umbrales"]["flojo"], flojo("2024-06-30"))

    def test_a_file_that_is_not_the_declared_formula_is_refused(self):
        with open(self.path, encoding="utf-8") as handle:
            table = json.load(handle)
        table["trimestres"]["2024Q1"]["maestro_hash"] = "000000000000"
        bad = os.path.join(self.tmp, "mala.json")
        with open(bad, "w", encoding="utf-8") as handle:
            json.dump(table, handle)
        feb_ms = ms("2024-02-10")
        with self.assertRaises(qt.TraderError):
            corta.formulas({"corta": {"pares": bad}}, feb_ms)

    def test_without_a_table_nothing_changes(self):
        cfg = {"corta": {"maestro": "qwen-lora-maestro.json", "maestro_hash": "3e1f64d478a5",
                         "portero": "qwen-portero.json", "portero_hash": "49ca5db3aea7"}}
        self.assertEqual(corta.formulas(cfg, ms("2024-02-10"))[0]["umbrales"], corta.formulas(cfg)[0]["umbrales"])

    def test_exigency_applies_on_top_of_the_quarter_pair(self):
        cfg = dict(self.cfg, exigencia={"maestro": 9, "portero": 5})
        paper = corta.formulas(self.cfg, ms("2024-05-10"))[0]["umbrales"]
        hard = corta.formulas(cfg, ms("2024-05-10"))[0]["umbrales"]
        self.assertGreater(hard["fuerte"], paper["fuerte"])
        self.assertEqual(hard["flojo"], paper["flojo"])

    def test_variant_over_photos_uses_the_quarter_pair_size_and_one_position_at_a_time(self):
        s = corta.formulas(self.cfg, ms("2024-02-10"))[0]["umbrales"]["fuerte"] * 1.01
        side = lambda hours: {"salida_ms": 0, "motivo": "vuelta", "neto_bp": 10.0, "horas": hours}
        photos = []
        for k in range(3):                                                # three consecutive photos with a strong maestro
            op = {"maestro": 2, "puntaje": s, "portero_si": True, "portero_p": 0.99,
                  "largo": dict(side(1), salida_ms=ms("2024-02-10") + (k + 2) * H), "corto": dict(side(1), salida_ms=ms("2024-02-10") + (k + 2) * H)}
            photos.append({"product": "PF_ETHUSD", "t_ms": ms("2024-02-10") + k * 900_000, "mov": True, "operacion": op})
        trades = wf.trades_for(photos, "PF_ETHUSD", wf.variant(size="fuerte"), self.path)
        self.assertEqual(len(trades), 1)                                  # the other two photos fall inside the open position
        self.assertEqual(trades[0]["tamano"], 1.5)
        self.assertAlmostEqual(trades[0]["net"], 15.0)
        # the same photos in the quarter whose maestro asks for twice the strength: the score is no longer strong
        late = [dict(p, t_ms=p["t_ms"] + 90 * 86_400_000) for p in photos]
        self.assertEqual(wf.trades_for(late, "PF_ETHUSD", wf.variant(), self.path), [])
        # a higher exigency drops an entry that the paper level takes
        near = [dict(p, operacion=dict(p["operacion"], puntaje=s * 1.1)) for p in photos]
        self.assertEqual(len(wf.trades_for(near, "PF_ETHUSD", wf.variant(levels=(5, 5)), self.path)), 1)
        self.assertEqual(wf.trades_for(near, "PF_ETHUSD", wf.variant(levels=(9, 5)), self.path), [])
        # when portero says no (low portero_p) but noticias_si is True, the entry is still taken and sized
        with_news = [dict(photos[0], operacion=dict(photos[0]["operacion"], portero_si=False, portero_p=0.10, noticias_si=True))]
        news_trades = wf.trades_for(with_news, "PF_ETHUSD", wf.variant(size="fuerte"), self.path)
        self.assertEqual(len(news_trades), 1)
        self.assertEqual(news_trades[0]["tamano"], 1.5)
        self.assertAlmostEqual(news_trades[0]["net"], 15.0)


class RepoTableTest(unittest.TestCase):
    """The table that ships in config/walkforward: every quarter has its pair, each file is the formula its hash declares."""

    def test_every_quarter_loads_its_pair_with_the_declared_hash(self):
        table = wf.load_pairs()["trimestres"]
        self.assertEqual(sorted(table), ["{}Q{}".format(y, q) for y, q in wf.quarters(qt.load_holdout_ms())])
        cfg = {"corta": {"pares": wf.PARES_PATH}}
        last_cutoff = 0
        for name, pair in sorted(table.items()):
            year, q = int(name[:4]), int(name[5])
            start = qt.date_ms("{}-{:02d}-01".format(year, 3 * (q - 1) + 1))
            teacher, keeper = corta.formulas(cfg, start)
            self.assertTrue(maestro.teacher_hash(teacher).startswith(pair["maestro_hash"]))
            self.assertTrue(portero.portero_hash(keeper).startswith(pair["portero_hash"]))
            # fitted only with what came before the quarter (48 h earlier), and each one with more history than the last
            self.assertLessEqual(qt.date_ms(pair["ajustado_hasta"]), start - 47 * H)
            self.assertGreater(qt.date_ms(pair["ajustado_hasta"]), last_cutoff)
            last_cutoff = qt.date_ms(pair["ajustado_hasta"])

    def test_the_log_of_attempts_in_the_repo_starts_from_the_audit_count(self):
        self.assertGreaterEqual(wf.trials(os.path.join(tempfile.mkdtemp(), "nada.jsonl")), wf.PRIOR_TRIALS + len(wf.grid()))


class ChoiceWithThePastTest(unittest.TestCase):
    def quarters(self):
        return [(2024, 1), (2024, 2)]

    def test_without_enough_past_the_default_is_used(self):
        by = {"a": [trade("2023-12-01", 5, 100.0)] * 5, "b": [trade("2023-12-01", 5, -100.0)] * 5}
        chosen, picks = wf.choose_walk_forward(by, self.quarters(), "b", min_trades=30)
        self.assertEqual([p["variante"] for p in picks], ["b", "b"])
        self.assertFalse(picks[0]["con_pasado"])

    def test_picks_the_best_variant_of_the_past_and_never_looks_at_the_quarter_itself(self):
        past = [trade("2023-11-%02d" % d, 5, 10.0) for d in range(1, 29)] * 2
        by = {"a": past + [trade("2024-02-01", 5, -500.0)], "b": [trade("2023-11-%02d" % d, 5, -1.0) for d in range(1, 29)] * 2
              + [trade("2024-02-01", 5, 9999.0)]}
        chosen, picks = wf.choose_walk_forward(by, self.quarters(), "b", min_trades=30)
        self.assertEqual(picks[0]["variante"], "a")                      # the +9999 of b in 2024Q1 is the future of that choice
        self.assertEqual([t["net"] for t in chosen if t["t_in"] < ms("2024-04-01")], [-500.0])

    def test_a_trade_still_open_when_the_quarter_starts_is_not_past(self):
        by = {"a": [trade("2023-12-31", 5, 1000.0)] * 40, "b": [trade("2023-11-01", 5, 1.0)] * 40}
        _, picks = wf.choose_walk_forward(by, [(2024, 1)], "b", min_trades=30)
        self.assertEqual(picks[0]["variante"], "a")                      # closes at 05:00 of 31-dec: before 1-jan
        by["a"] = [trade("2023-12-31", 30, 1000.0)] * 40                 # closes on 1-jan 06:00: after the start
        _, picks = wf.choose_walk_forward(by, [(2024, 1)], "b", min_trades=30)
        self.assertEqual(picks[0]["variante"], "b")


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.local = os.path.join(self.tmp, "local.jsonl")
        self.base = os.path.join(self.tmp, "base.json")

    def test_the_same_variant_counts_once_and_the_count_starts_at_the_audit_figure(self):
        self.assertEqual(wf.trials(self.local, self.base), wf.PRIOR_TRIALS)
        a = wf.register(wf.variant(), medicion="honesta", local_path=self.local)
        again = wf.register(wf.variant(), medicion="honesta", local_path=self.local)
        self.assertEqual(a, again)
        self.assertEqual(wf.trials(self.local, self.base), wf.PRIOR_TRIALS + 1)
        wf.register(wf.variant(size="fuerte"), medicion="honesta", local_path=self.local)
        wf.register(wf.variant(), medicion="vigente", local_path=self.local)           # another way to measure is another attempt
        self.assertEqual(wf.trials(self.local, self.base), wf.PRIOR_TRIALS + 3)

    def test_the_repo_log_and_the_local_log_are_added_without_double_counting(self):
        wf.register(wf.variant(), medicion="honesta", base=True, base_path=self.base)
        wf.register(wf.variant(), medicion="honesta", local_path=self.local)
        wf.register(wf.variant(cap_min=None), medicion="honesta", local_path=self.local)
        self.assertEqual(wf.trials(self.local, self.base), wf.PRIOR_TRIALS + 2)

    def test_a_test_is_the_hypothesis_not_the_stage(self):
        cfg = {"products": ["PF_ETHUSD"], "guardrails": {"max_hold_min": 2160}}
        self.assertEqual(wf.test_spec(cfg, {}), wf.BASELINE)
        self.assertEqual(wf.test_spec(cfg, {"QWEN_ANALISTA": "fuerte"})["tamano"], "fuerte")


class MeterTest(unittest.TestCase):
    def trades(self, start, n=60, net=30.0, spread=1.0):
        t0 = ms(start)
        return [{"t_in": t0 + k * 2 * 86_400_000, "t_out": t0 + k * 2 * 86_400_000 + 5 * H, "net": net + ((k % 7) - 3) * spread}
                for k in range(n)]

    def test_honest_and_many_attempts_is_not_green(self):
        got = wf.meter(self.trades("2024-01-01", net=3.0, spread=20.0), medicion="honesta", trial_count=1700)
        self.assertIn(got["semaforo"], ("amarillo", "rojo"))
        self.assertEqual(got["fuera_del_ajuste_pct"], 100.0)
        self.assertTrue(got["holdout_intacto"])
        self.assertIn("1.700 intentos", got["motivo"])

    def test_green_needs_everything_outside_no_practice_and_survive_the_discount(self):
        got = wf.meter(self.trades("2024-01-01", n=80, net=200.0), medicion="honesta", trial_count=3)
        self.assertEqual(got["semaforo"], "verde")

    def test_the_practice_window_makes_a_good_result_yellow(self):
        got = wf.meter(self.trades("2025-11-01", n=60, net=200.0), medicion="honesta", trial_count=3)
        self.assertEqual(got["semaforo"], "amarillo")
        self.assertTrue(got["incluye_practica"])
        self.assertTrue(got["practica_usada"])

    def test_the_formula_in_force_measured_inside_its_own_fit_is_red(self):
        got = wf.meter(self.trades("2024-01-01", n=60, net=200.0), medicion="vigente", trial_count=3)
        self.assertEqual(got["semaforo"], "rojo")
        self.assertEqual(got["fuera_del_ajuste_pct"], 0.0)

    def test_touching_the_holdout_is_red_and_few_trades_are_not_judged(self):
        late = [{"t_in": qt.load_holdout_ms() + 1, "t_out": qt.load_holdout_ms() + H, "net": 5.0}] * 5
        self.assertEqual(wf.meter(late, medicion="honesta", trial_count=1)["semaforo"], "rojo")
        self.assertEqual(wf.meter(self.trades("2024-01-01", n=2), medicion="honesta", trial_count=1)["semaforo"], "amarillo")


class SummaryTest(unittest.TestCase):
    def test_years_quarters_and_practice(self):
        rows = [trade("2023-02-01", 4, 10.0), trade("2023-05-01", 4, -4.0), trade("2024-02-01", 4, 7.0), trade("2025-11-01", 4, 3.0)]
        s = wf.summarize(rows, trials=10)
        self.assertEqual(s["operaciones"], 4)
        self.assertEqual(s["neto_pb"], 16)
        self.assertEqual(s["por_anio"]["2023"], {"operaciones": 2, "neto_pb": 6})
        self.assertEqual(s["por_trimestre"]["2023Q2"], -4)
        self.assertEqual(s["practica"], {"operaciones": 1, "neto_pb": 3})
        self.assertEqual(wf.summarize(rows, since_ms=ms("2024-01-01"))["operaciones"], 2)

    def test_quarters_stop_before_the_holdout(self):
        q = wf.quarters(ms("2026-04-19"))
        self.assertEqual(q[0], (2023, 1))
        self.assertEqual(q[-1], (2026, 2))
        self.assertEqual(len(q), 14)

    def test_the_mode_of_measuring_defaults_to_honest(self):
        self.assertEqual(wf.medicion_from_env({}), "honesta")
        self.assertEqual(wf.medicion_from_env({wf.ENV: "vigente"}), "vigente")
        with self.assertRaises(ValueError):
            wf.medicion("otra")


if __name__ == "__main__":
    unittest.main()
