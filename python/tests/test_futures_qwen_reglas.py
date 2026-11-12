"""Las dos reglas de entrada del maestro (12-nov-2026): A «no vender si ETH subió 10 % en 30 días» y B «sumar el 2.º y 3.er lugar si la
señal sigue fuerte 60 min». Apagadas, todo igual que hoy. Velas inventadas, sin red."""
import copy
import unittest

from balancita_engine import futures_qwen_analista as analista
from balancita_engine import futures_qwen_reglas as reglas
from balancita_engine import futures_qwen_trader as qt
from test_futures_qwen_posiciones import BAR, MIN, Market, config, decisions, opened

DAY = qt.DAY_MS


def reglas_config(a="apagado", b="apagado", places=3):
    cfg = config(places)
    cfg["analista"] = {"modo": "fuerte"}
    cfg["reglas_maestro"] = {"no_vender_subida_30d": a, "sumar_lugares_60min": b}
    return cfg


def market(cfg, past=None):
    """Un mercado cuyo ``Movement`` recuerda el cierre ``past`` de hace 30 días (``None``: sin esa historia)."""
    m = Market(cfg)
    m.trader.movement = analista.Movement()
    if past is not None:
        m.trader.movement.closes = {}
        m.past = past
        real = m.trader.movement.close_at
        m.trader.movement.close_at = lambda end_ms: past if end_ms in m.wanted() else real(end_ms)
    m.wanted = lambda: {m.trader.t[-1] + BAR - reglas.SUBIDA_DIAS * DAY}
    return m


class SettingsTests(unittest.TestCase):
    def test_off_by_default_and_validation(self):
        self.assertEqual(reglas.settings({}), {"A": False, "B": False})
        self.assertEqual(reglas.settings({"reglas_maestro": {"sumar_lugares_60min": "prendido"}}), {"A": False, "B": True})
        for bad in ({"raro": "prendido"}, {"no_vender_subida_30d": True}, {"no_vender_subida_30d": "si"}):
            with self.assertRaises(ValueError):
                reglas.settings({"reglas_maestro": bad})

    def test_the_rise_threshold(self):
        self.assertFalse(reglas.vende_bloqueada(None))
        self.assertFalse(reglas.vende_bloqueada(reglas.subida_30d(109.9, 100.0)))
        self.assertTrue(reglas.vende_bloqueada(reglas.subida_30d(110.0, 100.0)))
        self.assertIsNone(reglas.subida_30d(110.0, None))

    def test_the_config_keeps_its_identity_without_the_key(self):
        base = config(3)
        self.assertEqual(qt.config_hash(base), qt.config_hash(copy.deepcopy(base)))
        self.assertNotEqual(qt.config_hash(reglas_config("prendido")), qt.config_hash(base))

    def test_the_rules_need_several_places_and_rule_a_the_analyst(self):
        with self.assertRaises(qt.TraderError):
            qt.Trader(reglas_config("prendido", places=1), "PF_ETHUSD", None, entry_threshold=0.5)
        cfg = reglas_config("prendido")
        cfg["analista"] = {"modo": "apagado"}
        with self.assertRaises(qt.TraderError):
            qt.Trader(cfg, "PF_ETHUSD", None, entry_threshold=0.5)


class RuleATests(unittest.TestCase):
    def test_a_sale_is_blocked_when_eth_rose_ten_percent_in_30_days(self):
        m = market(reglas_config("prendido"), past=90.0)             # 100 / 90 = +11 %
        out = m.looks(1, verdict=-2)
        self.assertEqual(m.trader.positions, [])
        self.assertEqual(decisions(out)[0]["override"], "subida_30d")

    def test_below_ten_percent_and_without_history_the_sale_enters(self):
        for past in (95.0, None):
            m = market(reglas_config("prendido"), past=past)
            m.looks(1, verdict=-2)
            self.assertEqual(len(m.trader.positions), 1, past)

    def test_buys_are_never_blocked_and_off_means_as_today(self):
        m = market(reglas_config("prendido"), past=50.0)
        m.looks(1, verdict=2)
        self.assertEqual(len(m.trader.positions), 1)
        m = market(reglas_config("apagado"), past=50.0)
        m.looks(1, verdict=-2)
        self.assertEqual(len(m.trader.positions), 1)

    def test_a_blocked_sale_does_not_close_an_open_sale(self):
        m = market(reglas_config("apagado"), past=90.0)
        m.looks(1, verdict=-2)
        m.trader.reglas["A"] = True
        out = m.looks(1, verdict=1)                                   # the maestro turns: the open sale leaves as always
        self.assertEqual(len([e for e in out if e["type"] == "trade"]), 1)


class RuleBTests(unittest.TestCase):
    def test_off_the_signal_must_turn_off_and_on_again(self):
        m = market(reglas_config())
        m.looks(8, verdict=2)                                         # two hours of strong signal
        self.assertEqual(len(m.trader.positions), 1)

    def test_on_a_second_and_third_place_enter_after_60_minutes_of_strong_signal(self):
        m = market(reglas_config(b="prendido"))
        out = m.looks(1, verdict=2)
        self.assertEqual(len(m.trader.positions), 1)
        out = m.looks(1)                                              # 15 min later: too soon
        self.assertEqual(len(m.trader.positions), 1)
        self.assertEqual(decisions(out)[0]["override"], "separacion_60min")
        m.looks(3)                                                    # 60 min after the first
        self.assertEqual(len(m.trader.positions), 2)
        m.looks(4)                                                    # 60 min after the second
        self.assertEqual(len(m.trader.positions), 3)
        out = m.looks(4)                                              # no place left
        self.assertEqual(len(m.trader.positions), 3)
        self.assertEqual(decisions(out)[0]["override"], "lugares_ocupados")

    def test_entry_times_are_at_least_60_minutes_apart(self):
        m = market(reglas_config(b="prendido"))
        m.looks(12, verdict=2)
        times = sorted(p.entry_ms for p in m.trader.positions)
        self.assertEqual(len(times), 3)
        self.assertTrue(all(b - a >= 60 * MIN for a, b in zip(times, times[1:])))

    def test_the_operator_memory_still_round_trips(self):
        m = market(reglas_config("prendido", "prendido"), past=90.0)
        m.looks(2, verdict=2)
        memo = m.trader.memo()
        other = market(reglas_config("prendido", "prendido"), past=90.0)
        other.trader.load_memo(memo)
        self.assertEqual(other.trader.prev_entry_side, m.trader.prev_entry_side)


class RulesOffAreIdenticalToTodayTests(unittest.TestCase):
    def test_same_decisions_with_and_without_the_key(self):
        script = [2, 2, 0, 2, 2, -2, -2, 0, 2, 1, -1, -2, -2, 2, 2, 2]
        runs = []
        for cfg in (config(3), reglas_config()):
            if "reglas_maestro" in cfg:
                cfg["analista"] = config(3).get("analista", cfg["analista"])
            m = market(cfg) if "reglas_maestro" in cfg else Market(cfg)
            for verdict in script:
                m.looks(1, verdict=verdict)
            runs.append([(e["action"], e.get("override")) for e in decisions(m.events)])
        self.assertEqual(runs[0], runs[1])


class EstrategiasTests(unittest.TestCase):
    def test_the_committed_variants_load_and_turn_on_only_their_rules(self):
        from balancita_engine import futures_estrategias as est
        wanted = {"maestro-no-vender-en-subida": {"A": True, "B": False}, "maestro-sumar-lugares": {"A": False, "B": True},
                  "maestro-dos-reglas": {"A": True, "B": True}}
        for id, rules in wanted.items():
            cfg = est.cargar_estrategia(id)
            self.assertEqual(reglas.settings(cfg), rules, id)

    def test_the_knobs_reject_other_values_and_the_base_has_them_off(self):
        from balancita_engine import futures_estrategias as est
        base = est.cargar_snapshot()
        self.assertEqual(reglas.settings(base["config"]), {"A": False, "B": False})
        overlay = {"id": "x", "nombre": "x", "descripcion": "x", "base_config_hash": base["config_hash"],
                   "cambios": {"reglas_maestro": {"sumar_lugares_60min": "tal vez"}}}
        with self.assertRaises(est.EstrategiaError):
            est.config_desde_overlay(overlay, "x", base)


if __name__ == "__main__":
    unittest.main()
