"""Mejoras de operación T2 (odd/tasks/operacion-mejoras.md, S2 y S3): la entrada se fecha con la hora de la MIRADA que la decidió (no con la
del llenado, unos segundos después) y, si la Terminal perdió miradas, hace UNA mirada de recuperación con los datos de ese momento y deja
cada mirada perdida en ``miradas_perdidas`` (auditor) sin operar hacia atrás. Proveedor falso, velas inventadas, bases temporales."""
import contextlib
import copy
import json
import os
import sqlite3
import tempfile
import unittest
from decimal import Decimal as D
from unittest import mock

from balancita_engine import futures_auditor as aud
from balancita_engine import futures_book_execution as book
from balancita_engine import futures_qwen_corta as corta
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt
from test_futures_book_execution import BASE, snapshot
from test_futures_qwen_live import BASE as LIVE_BASE, LIVE_CFG, MIN, Policy, make, walk

HOUR = qt.HOUR_MS
BAR = qt.BAR_MS


def formula_readings(veredicto=1, puntaje=0.0):
    return {"hechos": {}, "veredicto": veredicto, "puntaje": puntaje, "portero_si": False, "portero_p": 0.1, "portero_direccion": None,
            "portero_autonomo": None, "noticias_si": False, "noticias": None, "volatilidad": "NORMAL", "flojo": 0.2264}


class BookTraderCase(unittest.TestCase):
    """Un ``Trader`` de ETH con ejecución de libro: la mirada es ``BASE``, el llenado llega 200 ms después."""

    def trader(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg["products"] = ["PF_ETHUSD"]
        cfg["execution"] = {"model": book.MODEL}
        cfg["funding_model"] = qt.exact_funding.EXACT_MODEL
        cfg["runtime"]["opinion_enabled"] = False                                    # sin proveedor: decide la fórmula sola
        trader = qt.Trader(cfg, "PF_ETHUSD", None)
        for bar in walk(qt.MIN_BARS, 1, BASE - qt.MIN_BARS * BAR, price=10):
            trader.feed(bar, trade=False)
        self.now = [BASE + 200]
        self.snap = [snapshot()]
        trader.book_execution = book.BookExecution(lambda product: self.snap[0], lambda: self.now[0])
        return trader

    def at(self, ms, bids=None, asks=None):
        """El reloj y el libro público a ``ms`` (el libro tiene 100 ms)."""
        self.now[0] = ms
        self.snap[0] = snapshot(bids=bids, asks=asks, at=ms - 100)

    def feed_to(self, trader, end_ms):
        """Velas de 5 min (sin operar) hasta la que termina en ``end_ms``."""
        while trader.t[-1] + BAR < end_ms:
            trader.feed(walk(1, trader.t[-1] % 97, trader.t[-1] + BAR, price=10)[0], trade=False)


# --------------------------------------------------------------------------- S3: la fecha de la entrada


class EntryDatingTests(BookTraderCase):
    def test_the_entry_is_dated_with_the_look_and_the_fill_time_is_kept_apart(self):
        trader = self.trader()
        position = trader._open(BASE, "LONG", 1, "formula")
        self.assertEqual(position.entry_ms, BASE)                                  # la mirada que lo decidió
        self.assertEqual(position.fill_ms, BASE + 200)                              # el llenado, aparte
        self.assertEqual(position.entry_execution["executed_at_ms"], BASE + 200)    # la evidencia no cambia
        self.assertEqual(position.entry_execution["signal_at_ms"], BASE)
        self.assertEqual(trader.last_open_ms, BASE)

    def test_the_24h_look_sees_exactly_1440_minutes_and_agotado_can_fire(self):
        trader = self.trader()
        trader._open(BASE, "LONG", 1, "formula")
        look = BASE + 24 * HOUR
        self.at(look + 300)
        self.assertEqual(trader.cfg["guardrails"]["exhaust_hold_min"], 1440)
        event = trader._init_decision_event(look, ["cada_15_min"], "x", True)
        with mock.patch.object(corta, "readings", return_value=formula_readings(veredicto=1, puntaje=0.0)):
            events = trader._decide_formula(look, event, "x", trader.questions["position"])
        self.assertEqual(event["formula_action"], "CERRAR")
        self.assertIn("pasaron 24 h", event["formula"]["motivo"])
        trade = next(e["trade"] for e in events if e["type"] == "trade")
        self.assertEqual((trade["closed_by"], trade["exit_reason"]), ("formula", "maestro_agotado"))
        self.assertEqual(trade["hold_min"], 1440)                                   # no 1439

    def test_the_36h_cap_is_counted_from_the_look(self):
        trader = self.trader()
        position = trader._open(BASE, "LONG", 1, "formula")
        look = BASE + 36 * HOUR
        self.at(look + 300)
        events = trader._guard_one(position, look)
        self.assertEqual([e["trade"]["closed_by"] for e in events if e["type"] == "trade"], ["tiempo"])

    def test_the_cooldown_counts_from_the_look_so_it_blocks_only_the_next_look(self):
        trader = self.trader()
        trader._open(BASE, "LONG", 1, "formula")
        close_at = BASE + 15 * MIN
        self.feed_to(trader, close_at)
        self.at(close_at + 4_000, bids=[["103", "10"]], asks=[["104", "10"]])        # el cierre se llena 4 s después de la mirada
        events = trader._close(close_at, 9999, "strategy_exit", "formula", "maestro_vuelta")
        self.assertEqual(next(e["trade"] for e in events if e["type"] == "trade")["exit_ms"], close_at + 4_000)   # la evidencia del cierre no cambia
        self.assertEqual(trader.cooldown_until, close_at + 15 * MIN)
        asked = []
        trader._decide = lambda t_ms, reasons: asked.append(t_ms) or []
        self.feed_to(trader, close_at + 5 * MIN)
        trader.feed(walk(1, 5, trader.t[-1] + BAR, price=10)[0])                      # la vela de +10 min no es una mirada (no es de :00/:15/:30/:45)
        self.assertEqual(asked, [])
        trader.feed(walk(1, 6, trader.t[-1] + BAR, price=10)[0])                      # la mirada de +15 min SÍ se hace (antes caía dentro del enfriamiento: 30 min)
        self.assertEqual(asked, [close_at + 15 * MIN])

    def test_funding_and_the_receipt_still_start_at_the_fill_not_at_the_look(self):
        trader = self.trader()
        trader._open(BASE, "LONG", 1, "formula")
        self.at(BASE + 15 * MIN + 300, bids=[["103", "10"]], asks=[["104", "10"]])
        trade = trader._close(BASE + 15 * MIN, 9999, "strategy_exit", "formula", "x")[-1]["trade"]
        self.assertEqual(trade["exit_execution"]["settlement"]["entry_at_ms"], BASE + 200)
        self.assertEqual(trade["fill_ms"], BASE + 200)
        self.assertEqual(trade["entry_ms"], BASE)
        self.assertEqual(trade["hold_min"], 15)

    def test_the_saved_position_keeps_both_times_and_an_older_one_without_the_fill_still_loads(self):
        trader = self.trader()
        position = trader._open(BASE, "SHORT", 1, "formula")
        restored = live.position_from_json(live.position_to_json(position))
        self.assertEqual((restored.entry_ms, restored.fill_ms), (BASE, BASE + 200))
        old = json.loads(live.position_to_json(position))                           # como la guardaba la versión anterior: entry_ms = llenado
        old["entry_ms"] = BASE + 200
        old.pop("fill_ms", None)
        loaded = live.position_from_json(json.dumps(old))
        self.assertEqual((loaded.entry_ms, qt.fill_ms_of(loaded)), (BASE + 200, BASE + 200))
        old["entry_ms"] = BASE + 999                                                # contradice su recibo: sigue rechazado
        with self.assertRaises(qt.TraderError):
            live.position_from_json(json.dumps(old))

    def test_without_book_execution_the_look_time_is_the_entry_as_always(self):
        cfg = copy.deepcopy(LIVE_CFG)
        trader = qt.Trader(cfg, "PF_ETHUSD", None)
        for bar in walk(qt.MIN_BARS, 1, BASE - qt.MIN_BARS * BAR, price=10):
            trader.feed(bar, trade=False)
        position = trader._open(BASE, "LONG", 1, "formula")
        self.assertEqual((position.entry_ms, position.fill_ms), (BASE, None))
        self.assertEqual(qt.fill_ms_of(position), BASE)
        trader._close(BASE + 15 * MIN, 100.0, "strategy_exit", "formula", "x")
        self.assertEqual(trader.cooldown_until, BASE + 30 * MIN)


class LiveEntryDatingTests(unittest.TestCase):
    def env(self, policy=None):
        folder = self.enterContext(tempfile.TemporaryDirectory())
        cfg = copy.deepcopy(LIVE_CFG)
        cfg.update(products=["PF_ETHUSD"], execution={"model": book.MODEL}, funding_model=qt.exact_funding.EXACT_MODEL)
        env = make(self, cfg=cfg, db=folder, now=LIVE_BASE + BAR + 200, policy=policy)
        env.book_levels = {"bids": [["100", "10"]], "asks": [["101", "10"]]}
        env.feed.book_snapshot = lambda product: snapshot(**env.book_levels, at=env.now[0] - 100)
        env.op.start()
        return env

    def test_the_stored_trade_is_dated_at_the_look_replays_from_its_receipts_and_an_old_one_dated_at_the_fill_still_does(self):
        env = self.env()
        trader = env.op.traders["PF_ETHUSD"]
        env.op.gate.begin("live")
        look = trader.t[-1] + BAR
        trader._open(look, "LONG", 1, "formula")
        env.op._record("PF_ETHUSD", trader, look, [], env.now[0])
        row = env.rows("SELECT entry_ms, status FROM trades")[0]
        self.assertEqual(row["entry_ms"], look)
        receipt = env.rows("SELECT evidence_json FROM execution_receipts WHERE purpose='entry'")[0]
        self.assertEqual(json.loads(receipt["evidence_json"])["executed_at_ms"], look + 200)
        env.restart().start()
        self.addCleanup(env.store.close)
        trader = env.op.traders["PF_ETHUSD"]
        self.assertEqual((trader.position.entry_ms, trader.position.fill_ms), (look, look + 200))
        env.now[0] += BAR
        env.book_levels = {"bids": [["103", "10"]], "asks": [["104", "10"]]}
        trader.feed(walk(1, 1, trader.t[-1] + BAR)[0], trade=False)
        env.op.gate.begin("live")
        signal = trader.t[-1] + BAR
        events = trader._close(signal, 9999, "strategy_exit", "formula", "test")
        env.op._record("PF_ETHUSD", trader, signal, events, env.now[0])
        self.assertEqual(env.rows("SELECT status, hold_min FROM trades")[0], {"status": "closed", "hold_min": 5})
        self.assertIsInstance(env.store.replay_trade("PF_ETHUSD", 1), dict)         # el recibo de entrada, el de salida y el funding cuadran

    def test_a_position_stored_by_the_previous_version_dated_at_its_fill_keeps_working(self):
        env = self.env()
        trader = env.op.traders["PF_ETHUSD"]
        env.op.gate.begin("live")
        look = trader.t[-1] + BAR
        position = trader._open(look, "LONG", 1, "formula")
        position.entry_ms, position.fill_ms = look + 200, None                       # lo que la versión anterior guardaba
        env.op._record("PF_ETHUSD", trader, look, [], env.now[0])
        self.assertEqual(env.rows("SELECT entry_ms FROM trades")[0]["entry_ms"], look + 200)
        env.restart().start()
        self.addCleanup(env.store.close)
        trader = env.op.traders["PF_ETHUSD"]
        env.now[0] += BAR
        env.book_levels = {"bids": [["103", "10"]], "asks": [["104", "10"]]}
        trader.feed(walk(1, 1, trader.t[-1] + BAR)[0], trade=False)
        env.op.gate.begin("live")
        signal = trader.t[-1] + BAR
        events = trader._close(signal, 9999, "strategy_exit", "formula", "test")
        env.op._record("PF_ETHUSD", trader, signal, events, env.now[0])
        self.assertEqual(env.rows("SELECT status FROM trades")[0]["status"], "closed")
        self.assertIsInstance(env.store.replay_trade("PF_ETHUSD", 1), dict)


# --------------------------------------------------------------------------- S2: la mirada de recuperación y las perdidas


def auditor_rows(env, sql):
    """Filas del auditor; sin base o sin la tabla (una corrida que nunca perdió una mirada no la crea), ninguna."""
    path = os.path.join(env.tmp, "auditor.sqlite")
    if not os.path.exists(path):
        return []
    with contextlib.closing(sqlite3.connect(path)) as con:
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql)]
        except sqlite3.OperationalError:
            return []


def only_eth(cfg):
    cfg = copy.deepcopy(cfg)
    cfg["products"] = ["PF_ETHUSD"]
    return cfg


class CatchUpTests(unittest.TestCase):
    GAP = 120

    def stopped(self, policy=None, restart_policy=None, extra_minutes=0, **kwargs):
        """Qwen abre una posición en la mirada de +15 min y el proceso se apaga a +37 min; vuelve ``GAP`` minutos después."""
        env = make(self, policy=policy or Policy(flat="LARGO"), cfg=only_eth(LIVE_CFG), **kwargs)
        env.op.start()
        env.advance(30)
        self.assertEqual(len(env.rows("SELECT * FROM trades WHERE status='open'")), 1)
        before = {name: env.rows("SELECT * FROM {}".format(name)) for name in ("decisions", "trades", "skipped")}
        op = env.restart()
        if restart_policy is not None:
            env.policy.position = restart_policy
        env.now[0] += (self.GAP + extra_minutes) * MIN
        return env, op, before

    def test_after_two_hours_down_with_an_open_position_the_restart_makes_one_catch_up_look_that_evaluates_the_exit(self):
        env, op, before = self.stopped(restart_policy="CERRAR")
        calls = env.provider.calls
        op.start()
        restart_at = env.now[0]
        look = (restart_at // BAR) * BAR                                             # la última vela cerrada: no es de :00/:15/:30/:45
        self.assertNotEqual(look % (15 * MIN), 0)
        decisions = env.rows("SELECT * FROM decisions WHERE t_ms > ? ORDER BY t_ms", before["decisions"][-1]["t_ms"])
        self.assertEqual([d["t_ms"] for d in decisions], [look])                      # UNA sola mirada
        self.assertEqual((decisions[0]["action"], json.loads(decisions[0]["wake_json"])), ("CERRAR", ["recuperacion"]))
        self.assertGreater(env.provider.calls, calls)
        trades = env.rows("SELECT * FROM trades ORDER BY trade_no")
        self.assertEqual([(t["status"], t["closed_by"]) for t in trades], [("closed", "qwen")])
        self.assertEqual(trades[0]["exit_ms"], look)

    def test_every_missed_look_is_recorded_with_its_time_and_reason_and_nothing_trades_backwards(self):
        env, op, before = self.stopped(policy=Policy(flat="LARGO"), restart_policy="MANTENER")
        op.start()
        last_before = before["decisions"][-1]["t_ms"]
        missed = [t for t in range((last_before // (15 * MIN) + 1) * (15 * MIN), (env.now[0] // BAR) * BAR, 15 * MIN)]
        self.assertGreaterEqual(len(missed), 7)
        rows = auditor_rows(env, "SELECT * FROM miradas_perdidas WHERE product='PF_ETHUSD' ORDER BY t_ms")
        self.assertEqual([r["t_ms"] for r in rows], missed)
        self.assertTrue(all(r["motivo"] == "proceso_detenido" and r["estado"] == "en_posicion" and r["bucket_ms"] == r["t_ms"] - 15 * MIN
                            for r in rows))
        self.assertEqual({r["t_ms"] for r in env.rows("SELECT t_ms FROM skipped WHERE reason='proceso_detenido'")}, set(missed))   # lo de antes sigue
        trades = env.rows("SELECT * FROM trades")                                    # ninguna operación nueva, ninguna cerrada hacia atrás
        self.assertEqual([(t["trade_no"], t["status"]) for t in trades], [(1, "open")])
        self.assertEqual(env.rows("SELECT COUNT(*) AS n FROM decisions WHERE t_ms > ?", last_before)[0]["n"], 1)

    def test_a_flat_restart_after_the_gap_may_enter_once_with_the_catch_up_look_and_never_at_a_missed_one(self):
        env = make(self, policy=Policy(flat="ESPERAR"), cfg=only_eth(LIVE_CFG))
        env.op.start()
        env.advance(30)
        op = env.restart()
        env.policy.flat = "LARGO"
        env.now[0] += self.GAP * MIN
        op.start()
        trades = env.rows("SELECT * FROM trades")
        self.assertEqual(len(trades), 1)
        self.assertEqual(trades[0]["entry_ms"], (env.now[0] // BAR) * BAR)           # fechada con la mirada de recuperación
        self.assertEqual(len(auditor_rows(env, "SELECT * FROM miradas_perdidas")), len(env.rows("SELECT * FROM skipped")))

    def test_a_run_without_gaps_makes_no_catch_up_and_records_nothing_lost(self):
        env = make(self, policy=Policy(flat="LARGO"), cfg=only_eth(LIVE_CFG))
        env.op.start()
        env.advance(60)
        decisions = env.rows("SELECT * FROM decisions")
        self.assertTrue(decisions)
        self.assertTrue(all("recuperacion" not in json.loads(d["wake_json"]) and d["t_ms"] % (15 * MIN) == 0 for d in decisions))
        self.assertEqual(auditor_rows(env, "SELECT * FROM miradas_perdidas"), [])
        op = env.restart()
        op.start()                                                                   # reiniciar enseguida: nada que recuperar
        self.assertEqual(env.rows("SELECT * FROM decisions"), decisions)
        self.assertEqual(auditor_rows(env, "SELECT * FROM miradas_perdidas"), [])

    def test_the_lost_look_keeps_what_the_formula_would_have_said(self):
        cfg = only_eth(LIVE_CFG)
        env = make(self, policy=Policy(flat="ESPERAR", position="MANTENER"), cfg=cfg, formula=True)
        real = corta.readings
        base = LIVE_BASE

        def scripted(trader, t_ms, f=None):
            out = real(trader, t_ms, f)
            v = 2 if t_ms == base + 15 * MIN else -2                                  # entra a +15 min; después el maestro se da vuelta
            return dict(out, veredicto=v, puntaje=v * 2.0, portero_si=v > 0, portero_direccion=None, portero_autonomo=None)

        with mock.patch.object(corta, "readings", scripted):
            env.op.start()
            env.advance(20)
            self.assertEqual(len(env.rows("SELECT * FROM trades WHERE status='open'")), 1)
            op = env.restart()
            env.now[0] += self.GAP * MIN
            op.start()
        rows = auditor_rows(env, "SELECT * FROM miradas_perdidas ORDER BY t_ms")
        self.assertTrue(rows)
        first = rows[0]
        self.assertEqual((first["estado"], first["salida_dice"], first["maestro"], first["puntaje"]), ("en_posicion", "CERRAR", -2, -4.0))
        detail = json.loads(first["formula_json"])
        self.assertIn("el maestro se dio vuelta en contra", json.dumps(detail, ensure_ascii=False))
        self.assertEqual(detail["posiciones"][0]["trade_no"], 1)
        self.assertEqual(env.rows("SELECT status FROM trades")[0]["status"], "closed")   # la mirada de recuperación SÍ cierra, con los datos de ahora

    def test_a_feed_that_is_itself_stale_gets_no_catch_up(self):
        env, op, before = self.stopped(restart_policy="CERRAR")
        env.candles["PF_ETHUSD"] = [c for c in env.candles["PF_ETHUSD"] if c["bucket_start"] + BAR <= env.now[0] - 30 * MIN]
        op.start()
        self.assertEqual(env.rows("SELECT * FROM decisions"), before["decisions"])
        self.assertEqual(env.rows("SELECT status FROM trades")[0]["status"], "open")
        self.assertTrue(auditor_rows(env, "SELECT * FROM miradas_perdidas"))          # lo perdido igual queda anotado

    def test_with_the_public_book_the_catch_up_executes_with_the_look_of_now_not_a_stale_signal(self):
        folder = self.enterContext(tempfile.TemporaryDirectory())
        cfg = copy.deepcopy(LIVE_CFG)
        cfg.update(products=["PF_ETHUSD"], execution={"model": book.MODEL}, funding_model=qt.exact_funding.EXACT_MODEL)
        env = make(self, cfg=cfg, db=folder, now=LIVE_BASE + BAR + 200, policy=Policy(flat="LARGO"))
        env.feed.book_snapshot = lambda product: snapshot(bids=[["100", "10"]], asks=[["101", "10"]], at=env.now[0] - 100)
        env.op.start()
        env.advance(15)
        self.assertEqual(len(env.rows("SELECT * FROM trades WHERE status='open'")), 1)
        op = env.restart()
        env.policy.position = "CERRAR"
        env.now[0] += self.GAP * MIN + 150_000                                       # vuelve 2,5 min después de cerrar una vela: la decisión no es de la vela, es de ahora
        op.start()
        trade = env.rows("SELECT * FROM trades")[0]
        self.assertEqual(trade["status"], "closed")
        self.assertEqual(env.rows("SELECT COUNT(*) AS n FROM errors")[0]["n"], 0)
        receipt = json.loads(env.rows("SELECT evidence_json FROM execution_receipts WHERE purpose='exit'")[0]["evidence_json"])
        self.assertEqual(receipt["signal_at_ms"], env.now[0])
        trader = env.op.traders["PF_ETHUSD"]
        self.assertEqual((trader.catching_up, trader.exec_ms), (False, None))        # solo esa mirada: las órdenes que esperan entre velas usan su reloj
        self.assertIsInstance(env.store.replay_trade("PF_ETHUSD", 1), dict)


if __name__ == "__main__":
    unittest.main()
