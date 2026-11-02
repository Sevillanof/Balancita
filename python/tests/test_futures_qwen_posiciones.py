"""Varias posiciones compartidas (maestro + experto rebotes): la regla de cupos, el tamaño del 33 %, el episodio de la señal, el rebote desde
el máximo de la hora, el descanso, la recuperación tras reiniciar y que con una sola posición nada cambia. Velas inventadas, sin red."""
import copy
import os
import sqlite3
import tempfile
import unittest
from decimal import Decimal
from unittest import mock

from balancita_engine import futures_qwen_corta as corta
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_posiciones as pos
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as exam

BAR, MIN, HOUR = qt.BAR_MS, qt.MINUTE_MS, qt.HOUR_MS
T0 = qt.date_ms("2025-03-03")
LIVE = qt.load_config(qt.CONFIG_PATH_LIVE)


def candle(k, close, start=T0):
    return {"bucket_start": start + k * BAR, "open": repr(close), "high": repr(close), "low": repr(close), "close": repr(close),
            "volume_btc": "5"}


def config(places=3, rebotes=False, **extra):
    cfg = pos.with_positions(copy.deepcopy(LIVE), places, rebotes)
    cfg["funding_model"] = qt.exact_funding.LEGACY_MODEL
    cfg.pop("execution", None)
    cfg.get("runtime", {}).pop("pending_config", None)
    cfg.update(extra)
    return cfg


def readings(verdict=0, keeper=True):
    return {"veredicto": verdict, "puntaje": float(verdict), "portero_si": keeper, "portero_p": 0.7, "portero_direccion": None,
            "portero_autonomo": None, "noticias_si": False, "noticias": {}, "volatilidad": "NORMAL", "hechos": {}}


class Market:
    """A trader fed with scripted candles; the maestro's reading is whatever the test says at each look."""

    def __init__(self, cfg, price=100.0):
        self.trader = qt.Trader(cfg, "PF_ETHUSD", None, None, key="t", entry_threshold=0.5)
        self.k, self.price, self.verdict, self.keeper = 0, price, 0, True
        for _ in range(qt.MIN_BARS):
            self.trader.feed(candle(self.k, price), trade=False)
            self.k += 1
        while (T0 + self.k * BAR + BAR) % (15 * MIN):            # start on a 15 min look
            self.trader.feed(candle(self.k, price), trade=False)
            self.k += 1
        self.events = []

    def step(self, close=None, verdict=None, keeper=None):
        self.price = self.price if close is None else close
        self.verdict = self.verdict if verdict is None else verdict
        self.keeper = self.keeper if keeper is None else keeper
        with mock.patch.object(corta, "readings", lambda *a, **k: readings(self.verdict, self.keeper)), \
                mock.patch.object(corta, "check", lambda *a, **k: None), \
                mock.patch.object(qt.Trader, "state_text", lambda *a, **k: "ficha"):
            out = self.trader.feed(candle(self.k, self.price))
        self.k += 1
        self.events += out
        return out

    def looks(self, count, **kw):
        """``count`` 15 min looks (three candles each); the maestro's reading applies to all of them."""
        out = []
        for _ in range(count):
            for _ in range(3):
                out += self.step(**kw)
                kw = {}
        return out


def decisions(events):
    return [e for e in events if e["type"] == "decision"]


def opened(events):
    return [e["trade_no"] for e in decisions(events) if e.get("trade_no") and e["action"] in ("LARGO", "CORTO")]


class SettingsTests(unittest.TestCase):
    def test_defaults_and_validation(self):
        self.assertEqual(pos.settings({}), {"max": 1, "fraccion": 1.0, "espera_min": 0})
        self.assertEqual(pos.settings({"posiciones": {"max": 3, "fraccion": 0.33}})["max"], 3)
        self.assertEqual(pos.settings({"posiciones": {"max": 1}}), {"max": 1, "fraccion": 1.0, "espera_min": 0})
        for bad in ({"max": 4}, {"max": 0}, {"max": 3, "fraccion": 0.5}, {"max": 3, "raro": 1}, {"max": True}):
            with self.assertRaises(ValueError):
                pos.settings({"posiciones": bad})
        self.assertIsNone(pos.rebotes_of({}))
        self.assertEqual(pos.rebotes_of({"rebotes": {}}), pos.DEFAULT_REBOTES)
        with self.assertRaises(ValueError):
            pos.rebotes_of({"rebotes": {"caida_pct": 0}})

    def test_one_place_keeps_the_identity_of_the_config(self):
        base = copy.deepcopy(LIVE)
        self.assertEqual(qt.config_hash(pos.with_positions(base, 1)), qt.config_hash(base))
        self.assertNotEqual(qt.config_hash(pos.with_positions(base, 3)), qt.config_hash(base))
        self.assertNotEqual(qt.config_hash(pos.with_positions(base, 3, True)), qt.config_hash(pos.with_positions(base, 3)))

    def test_the_environment_of_a_test_replaces_the_config(self):
        env = pos.env_for(3, "encendido")
        cfg = pos.apply_env(copy.deepcopy(LIVE), env)
        self.assertEqual(pos.settings(cfg)["max"], 3)
        self.assertIsNotNone(pos.rebotes_of(cfg))
        self.assertIs(pos.apply_env(LIVE, {}), LIVE)
        self.assertIsNone(pos.describe(pos.apply_env(copy.deepcopy(LIVE), pos.env_for(1, "apagado"))))
        with self.assertRaises(ValueError):
            pos.env_for(4)

    def test_the_rebound_expert_needs_more_than_one_place_and_formula_decisions(self):
        with self.assertRaises(qt.TraderError):
            qt.Trader(dict(copy.deepcopy(LIVE), rebotes=dict(pos.DEFAULT_REBOTES)), "PF_ETHUSD", None)
        with self.assertRaises(qt.TraderError):
            qt.Trader(dict(config(3), decide_by="qwen"), "PF_ETHUSD", None, entry_threshold=0.5)


class MaestroPlacesTests(unittest.TestCase):
    def test_a_new_position_per_signal_episode_up_to_three_with_a_third_of_the_balance_each(self):
        m = Market(config(3))
        m.looks(2, verdict=2)
        self.assertEqual(len(m.trader.positions), 1)                         # the signal stays on: one entry, same episode
        first = m.trader.position
        self.assertEqual(first.notional_usd, Decimal("1000") * Decimal("0.33"))
        m.looks(1, verdict=0)                                                # the signal turns off ... (the open long is held)
        self.assertEqual(len(m.trader.positions), 1)
        m.looks(1, verdict=2)                                                # ... and on again: a second episode
        self.assertEqual(len(m.trader.positions), 2)
        m.looks(1, verdict=0)
        m.looks(1, verdict=2)
        self.assertEqual(len(m.trader.positions), 3)
        m.looks(1, verdict=0)
        out = m.looks(1, verdict=2)                                          # a fourth episode: no place left
        self.assertEqual(len(m.trader.positions), 3)
        self.assertEqual(decisions(out)[0]["override"], "lugares_ocupados")
        self.assertLessEqual(sum(p.notional_usd for p in m.trader.positions), m.trader.notional)    # never more than the balance

    def test_never_two_entries_in_the_same_look_and_never_the_opposite_side(self):
        m = Market(config(3))
        m.looks(1, verdict=2)
        trader = m.trader
        self.assertIsNone(trader.entry_block(m.k * BAR, "LONG"))
        trader.opened_this_look = True
        self.assertEqual(trader.entry_block(m.k * BAR, "LONG")[1], "una_entrada_por_mirada")
        trader.opened_this_look = False
        self.assertEqual(trader.entry_block(m.k * BAR, "SHORT")[1], "lado_contrario")
        self.assertIsNone(trader.entry_block(m.k * BAR, "LONG", origin="rebotes"))

    def test_a_maestro_that_turns_closes_each_position_by_its_own_rule(self):
        m = Market(config(3))
        m.looks(1, verdict=2)
        m.looks(1, verdict=0)
        m.looks(1, verdict=2)
        self.assertEqual(len(m.trader.positions), 2)
        out = m.looks(1, verdict=-1)                                          # turned against: both leave in that look
        self.assertEqual(len([e for e in out if e["type"] == "trade"]), 2)
        self.assertEqual(m.trader.positions, [])
        self.assertEqual({e["trade"]["closed_by"] for e in out if e["type"] == "trade"}, {"formula"})

    def test_a_flat_account_enters_as_today_even_if_the_signal_never_turned_off(self):
        m = Market(config(3))
        m.looks(1, verdict=2)
        m.looks(1, verdict=-1)                                                # closes
        self.assertEqual(m.trader.positions, [])
        m.looks(4, verdict=2, keeper=True)                                    # signal on again with nothing open: enters
        self.assertEqual(len(m.trader.positions), 1)

    def test_one_place_behaves_exactly_as_before(self):
        a, b = Market(config(1)), Market(config(1))
        for market in (a, b):
            market.looks(3, verdict=2)
            market.looks(2, verdict=0)
            market.looks(2, verdict=2)
        self.assertEqual(len(a.trader.positions), 1)
        self.assertEqual([e.get("action") for e in decisions(a.events)], [e.get("action") for e in decisions(b.events)])
        self.assertEqual(a.trader.position.notional_usd, Decimal("1000") / (1 + qt.fee_rate("taker")))   # the whole balance, fee reserved


class ReboundTests(unittest.TestCase):
    def drop_market(self, places=3):
        m = Market(config(places, rebotes=True))
        for _ in range(12):
            m.step(close=100.0)
        return m

    def test_a_fall_of_five_percent_from_the_high_of_the_hour_buys_long_at_market(self):
        m = self.drop_market()
        out = m.step(close=94.9)
        events = [e for e in out if e["type"] == "rebote"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["action"], "abierta")
        self.assertEqual(events[0]["caida_pct"], 5.1)
        position = m.trader.position
        self.assertEqual((position.side, position.entry_reason, position.max_hold_ms), ("LONG", "rebote", 240 * MIN))
        self.assertEqual(position.notional_usd, Decimal("1000") * Decimal("0.33"))
        self.assertIsNone(position.stop_px)

    def test_four_point_nine_does_not_fire_and_it_fires_once_per_episode(self):
        m = self.drop_market()
        self.assertEqual([e for e in m.step(close=95.1) if e["type"] == "rebote"], [])
        self.assertEqual(len([e for e in m.step(close=94.0) if e["type"] == "rebote"]), 1)
        self.assertEqual([e for e in m.step(close=93.0) if e["type"] == "rebote"], [])       # still down: same episode
        self.assertEqual(len(m.trader.positions), 1)

    def test_leaves_after_four_hours_without_stop_or_target_and_rests_four_hours(self):
        m = self.drop_market()
        m.step(close=94.0)
        entry_ms = m.trader.position.entry_ms
        for _ in range(12 * 4 - 1):
            m.step(close=94.0)                                              # still down: no stop, no target
        self.assertEqual(len(m.trader.positions), 1)
        out = m.step(close=94.0)
        trades = [e["trade"] for e in out if e["type"] == "trade"]
        self.assertEqual(len(trades), 1)
        self.assertEqual((trades[0]["closed_by"], trades[0]["hold_min"], trades[0]["entry_reason"]), ("tiempo", 240, "rebote"))
        self.assertEqual(trades[0]["entry_ms"], entry_ms)

    def test_a_second_episode_inside_the_rest_is_ignored(self):
        m = self.drop_market()
        m.step(close=94.0)
        for _ in range(14):
            m.step(close=100.0 if _ > 11 else 94.0)
        for k in range(14):
            out = m.step(close=100.0)
        out = m.step(close=94.0)
        self.assertEqual([e for e in out if e["type"] == "rebote"], [])       # < 4 h since the first episode
        self.assertEqual(len(m.trader.positions), 1)

    def test_a_failed_buy_does_not_spend_the_episode_and_is_retried_while_the_drop_lasts(self):
        m = self.drop_market()
        real_open = m.trader._open
        def late(*args, **kwargs):
            raise qt.WakeSkipped("ejecucion_tarde", "vela tardía")
        m.trader._open = late
        events = [e for e in m.step(close=94.0) if e["type"] == "rebote"]
        self.assertEqual((events[0]["action"], events[0]["motivo"]), ("reintento", "ejecucion_tarde"))
        self.assertIsNone(m.trader.rebote_last_ms)                          # the 4 h rest was NOT started
        m.trader._open = real_open
        events = [e for e in m.step(close=93.5) if e["type"] == "rebote"]   # next candle, still down (not an edge any more)
        self.assertEqual(events[0]["action"], "abierta")
        self.assertEqual(events[0]["episodio_ms"], m.trader.rebote_last_ms - 5 * MIN)
        self.assertEqual(len(m.trader.positions), 1)
        self.assertEqual([e for e in m.step(close=93.0) if e["type"] == "rebote"], [])   # now it is rested

    def test_the_retry_stops_when_the_drop_is_gone_or_after_half_an_hour(self):
        m = self.drop_market()
        def late(*args, **kwargs):
            raise qt.WakeSkipped("libro_no_disponible", "")
        m.trader._open = late
        m.step(close=94.0)
        self.assertIsNotNone(m.trader.rebote_retry_ms)
        m.step(close=100.0)                                                 # recovered: the episode is dropped
        self.assertIsNone(m.trader.rebote_retry_ms)
        self.assertEqual([e for e in m.step(close=94.0) if e["type"] == "rebote"][0]["action"], "reintento")  # a new edge
        for _ in range(7):
            m.step(close=94.0)                                              # > 30 min later: no more retries
        self.assertIsNone(m.trader.rebote_retry_ms)

    def test_the_memo_keeps_a_pending_retry_across_a_restart(self):
        m = self.drop_market()
        def late(*args, **kwargs):
            raise qt.WakeSkipped("ejecucion_tarde", "")
        m.trader._open = late
        m.step(close=94.0)
        memo = m.trader.memo()
        self.assertEqual(memo["rebote_retry_ms"], m.trader.rebote_retry_ms)
        self.assertIsNotNone(memo["rebote_retry_ms"])

    def test_shares_the_three_places_with_the_maestro(self):
        m = Market(config(3, rebotes=True))
        for _ in range(3):
            m.looks(1, verdict=2)
            m.looks(1, verdict=0)
        m.looks(1, verdict=2)
        self.assertEqual(len(m.trader.positions), 3)
        for _ in range(12):
            m.step(close=100.0)
        out = m.step(close=90.0)
        event = [e for e in out if e["type"] == "rebote"][0]
        self.assertEqual((event["action"], event["motivo"]), ("sin_cupo", "lugares_ocupados"))
        self.assertEqual(len(m.trader.positions), 3)

    def test_a_rebound_long_and_a_maestro_short_may_coexist_but_the_maestro_side_blocks_its_own_origin(self):
        m = Market(config(3, rebotes=True))
        for _ in range(12):
            m.step(close=100.0)
        m.step(close=94.0)
        self.assertEqual(len(m.trader.positions), 1)                          # the rebound long
        m.looks(1, verdict=-2)                                                # the maestro may open a short: the long is not its own origin
        self.assertEqual(sorted(p.side for p in m.trader.positions), ["LONG", "SHORT"])
        m.trader.opened_this_look = False
        self.assertEqual(m.trader.entry_block(m.k * BAR, "LONG")[1], "lado_contrario")     # a maestro long now: blocked by its own short

    def test_the_decision_shows_the_rebound_reading_for_the_terminal(self):
        m = self.drop_market()
        out = m.looks(1, verdict=2, close=96.0)
        reading = decisions(out)[0]["formula"]["rebote"]
        self.assertEqual((reading["umbral_pct"], reading["nivel"], reading["salida_min"]), (5.0, 0, 240))
        self.assertGreater(reading["caida_pct"], 3.9)
        self.assertEqual(decisions(out)[0]["formula"]["posiciones"]["max"], 3)


class LiveStateTests(unittest.TestCase):
    def test_several_positions_and_the_memo_survive_a_restart(self):
        m = Market(config(3, rebotes=True))
        m.looks(1, verdict=2)
        m.looks(1, verdict=0)
        m.looks(1, verdict=2)
        trader = m.trader
        self.assertEqual(len(trader.positions), 2)
        with tempfile.TemporaryDirectory() as tmp:
            store = live.LiveStore(os.path.join(tmp, "live.sqlite"))
            with store.db:
                store.save_state("PF_ETHUSD", trader, trader.t[-1], 1)
            row = store.load_state("PF_ETHUSD")
            self.assertEqual(len(__import__("json").loads(row["positions_json"])), 1)
            first = live.position_from_json(row["position_json"])
            second = [live.position_from_json(text) for text in __import__("json").loads(row["positions_json"])]
            self.assertEqual([first.trade_no] + [p.trade_no for p in second], [p.trade_no for p in trader.positions])
            self.assertEqual(second[0].notional_usd, trader.positions[1].notional_usd)
            restored = qt.Trader(trader.cfg, "PF_ETHUSD", None, None, key="t", entry_threshold=0.5)
            restored.load_memo(__import__("json").loads(row["memo_json"]))
            self.assertEqual(restored.prev_entry_side, trader.prev_entry_side)
            self.assertEqual(restored.memo(), trader.memo())
            store.close()

    def test_old_databases_get_the_new_columns_and_one_place_writes_nothing_extra(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "old.sqlite")
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE trader_state(product TEXT PRIMARY KEY, last_fed_ms INTEGER, trade_seq INTEGER NOT NULL, "
                       "cooldown_until INTEGER NOT NULL, last_call_ms INTEGER, position_json TEXT, updated_ms INTEGER NOT NULL, window_json TEXT)")
            db.commit()
            db.close()
            store = live.LiveStore(path)
            columns = {r[1] for r in store.db.execute("PRAGMA table_info(trader_state)")}
            self.assertTrue({"positions_json", "memo_json"} <= columns)
            trader = qt.Trader(copy.deepcopy(LIVE), "PF_ETHUSD", None, None, key="t", entry_threshold=0.5)
            with store.db:
                store.save_state("PF_ETHUSD", trader, 0, 1)
            row = store.load_state("PF_ETHUSD")
            self.assertEqual((row["positions_json"], row["memo_json"]), (None, None))
            store.close()


class PhotoPathTests(unittest.TestCase):
    def photo(self, t_ms, net=100.0, out_h=10):
        side = {"salida_ms": t_ms + out_h * HOUR, "neto_bp": net, "motivo": "x"}
        return {"product": "PF_ETHUSD", "t_ms": t_ms, "operacion": {"maestro": 2, "largo": dict(side), "corto": dict(side)}}

    def test_one_per_episode_up_to_three_each_weighing_a_third(self):
        step = 15 * MIN
        looks = [self.photo(T0 + k * step) for k in (0, 1, 2, 5, 9, 13)]          # an episode of three looks, then three single ones
        one = exam._one_at_a_time([(r, 1) for r in looks])
        self.assertEqual([r["t_ms"] for r, _ in one], [T0])
        many = exam._one_at_a_time([(r, 1) for r in looks], 3, 0.33)
        self.assertEqual([r["t_ms"] for r, _ in many], [T0, T0 + 5 * step, T0 + 9 * step])
        self.assertTrue(all(abs(r["operacion"]["largo"]["neto_bp"] - 33.0) < 1e-9 for r, _ in many))


if __name__ == "__main__":
    unittest.main()
