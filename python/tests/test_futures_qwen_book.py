import copy
import tempfile
import unittest
from decimal import Decimal as D

from balancita_engine import futures_book_execution as book
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt
from test_futures_book_execution import BASE, snapshot
from test_futures_qwen_live import BASE as LIVE_BASE, LIVE_CFG, make, walk


def make_book_env(test):
    folder = test.enterContext(tempfile.TemporaryDirectory())
    cfg = copy.deepcopy(LIVE_CFG)
    cfg.update(products=["PF_ETHUSD"], execution={"model": book.MODEL},
               funding_model=qt.exact_funding.EXACT_MODEL)
    env = make(test, cfg=cfg, db=folder, now=LIVE_BASE + qt.BAR_MS + 200)
    env.book_levels = {"bids": [["100", "10"]], "asks": [["101", "10"]]}
    env.book_error = None
    def quote(product):
        if env.book_error is not None:
            raise env.book_error
        return snapshot(**env.book_levels, at=env.now[0] - 100)
    env.feed.book_snapshot = quote
    env.op.start()
    env.op.gate.begin("live")
    return env


def open_book_trade(test):
    env = make_book_env(test)
    trader = env.op.traders["PF_ETHUSD"]
    signal = trader.t[-1] + qt.BAR_MS
    trader._open(signal, "LONG", 1, "formula")
    env.op._record("PF_ETHUSD", trader, signal, [], env.now[0])
    return env


def close_book_trade(env):
    trader = env.op.traders["PF_ETHUSD"]
    env.now[0] += qt.BAR_MS
    env.book_levels = {"bids": [["103", "10"]], "asks": [["104", "10"]]}
    trader.feed(walk(1, 1, trader.t[-1] + qt.BAR_MS)[0], trade=False)
    env.op.gate.begin("live")
    signal = trader.t[-1] + qt.BAR_MS
    events = trader._close(signal, 9999, "strategy_exit", "formula", "test")
    env.op._record("PF_ETHUSD", trader, signal, events, env.now[0])


class TraderBookTests(unittest.TestCase):
    def trader(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg["products"] = ["PF_ETHUSD"]
        cfg["execution"] = {"model": book.MODEL}
        cfg["funding_model"] = qt.exact_funding.EXACT_MODEL
        trader = qt.Trader(cfg, "PF_ETHUSD", None)
        for bar in walk(qt.MIN_BARS, 1, BASE - qt.MIN_BARS * qt.BAR_MS, price=10):
            trader.feed(bar, trade=False)
        self.now = [BASE + 200]
        self.snap = [snapshot()]
        trader.book_execution = book.BookExecution(lambda product: self.snap[0], lambda: self.now[0])
        return trader

    def test_entry_uses_book_price_and_actual_execution_time_not_candle(self):
        trader = self.trader()
        position = trader._open(BASE, "LONG", 1, "formula")
        self.assertGreaterEqual(position.entry_px, D("101"))
        self.assertEqual(position.entry_ms, BASE + 200)
        self.assertEqual(position.entry_execution["model"], book.MODEL)
        self.assertEqual(position.entry_execution["fee_kind"], "taker")
        self.assertLessEqual(position.notional_usd, D("100"))

    def test_close_consumes_position_quantity_and_uses_book_time(self):
        trader = self.trader()
        position = trader._open(BASE, "LONG", 1, "formula")
        self.now[0] = BASE + qt.BAR_MS + 300
        self.snap[0] = snapshot(bids=[["103", "10"]], asks=[["104", "10"]], at=self.now[0] - 100)
        events = trader._close(BASE + qt.BAR_MS, 9999, "strategy_exit", "formula", "maestro_vuelta")
        trade = next(event["trade"] for event in events if event["type"] == "trade")
        self.assertEqual(D(trade["exit_fill"]), D("103"))
        self.assertEqual(D(trade["qty"]), position.qty)
        self.assertEqual(trade["exit_ms"], self.now[0])
        self.assertEqual(D(trade["fees_usd"]), D(position.entry_execution["fee_usd"]) + D("103") * position.qty * D("0.0005"))
        self.assertEqual(trade["funding_status"], "unknown")
        self.assertIsNone(trade["net_complete_usd"])

    def test_missing_or_stale_execution_keeps_position_and_sequence_unchanged(self):
        trader = self.trader()
        trader.book_execution = None
        with self.assertRaises(qt.WakeSkipped):
            trader._open(BASE, "LONG", 1, "formula")
        self.assertEqual(trader.trade_seq, 0)
        self.assertIsNone(trader.position)
        trader = self.trader()
        trader._open(BASE, "LONG", 1, "formula")
        position = trader.position
        self.now[0] += 4000
        with self.assertRaises(qt.WakeSkipped):
            trader._close(BASE, 100, "strategy_exit", "formula", "test")
        self.assertIs(trader.position, position)

    def test_restart_preserves_book_basis_and_exact_entry(self):
        trader = self.trader()
        position = trader._open(BASE, "SHORT", 1, "formula")
        restored = live.position_from_json(live.position_to_json(position))
        self.assertEqual(restored.entry_execution, position.entry_execution)
        self.assertEqual(restored.qty, position.qty)
        self.assertEqual(restored.entry_px, position.entry_px)
        self.assertEqual(restored.entry_ms, position.entry_ms)

    def test_legacy_position_is_not_repriced_after_loading_new_code(self):
        trader = self.trader()
        trader.book_execution = None
        trader.position = qt.Position(
            side="LONG", entry_ms=BASE - qt.BAR_MS, entry_px=D("100"),
            qty=D("1"), notional_usd=D("100"), trade_no=1, mfe_bp=0, mae_bp=0,
        )
        events = trader._close(BASE, 110, "strategy_exit", "formula", "test")
        trade = events[-1]["trade"]
        self.assertEqual(D(trade["exit_fill"]), qt.exit_fill(D("110"), "LONG", "PF_ETHUSD"))

    def test_empty_execution_configuration_is_not_a_silent_static_fallback(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg["execution"] = {}
        with self.assertRaises(qt.TraderError):
            qt.Trader(cfg, "PF_ETHUSD", None)

    def live_env(self):
        return make_book_env(self)

    def test_live_owner_records_resumes_and_closes_without_resizing(self):
        env = self.live_env()
        trader = env.op.traders["PF_ETHUSD"]
        signal = trader.t[-1] + qt.BAR_MS
        position = trader._open(signal, "LONG", 1, "formula")
        env.op._record("PF_ETHUSD", trader, signal, [], env.now[0])
        before = env.rows("SELECT entry_px,entry_ms,qty,notional_usd FROM trades")[0]
        env.restart().start()
        self.addCleanup(env.store.close)
        trader = env.op.traders["PF_ETHUSD"]
        self.assertEqual(trader.position.entry_execution, position.entry_execution)
        self.assertEqual(env.rows("SELECT entry_px,entry_ms,qty,notional_usd FROM trades")[0], before)
        env.now[0] += qt.BAR_MS
        env.book_levels = {"bids": [["103", "10"]], "asks": [["104", "10"]]}
        trader.feed(walk(1, 1, trader.t[-1] + qt.BAR_MS)[0], trade=False)
        env.op.gate.begin("live")
        signal = trader.t[-1] + qt.BAR_MS
        events = trader._close(signal, 9999, "strategy_exit", "formula", "test")
        env.op._record("PF_ETHUSD", trader, signal, events, env.now[0])
        row = env.rows("SELECT exit_px,exit_ms,qty,status FROM trades")[0]
        self.assertEqual(D(row["exit_px"]), D("103"))
        self.assertEqual(row["exit_ms"], env.now[0])
        self.assertEqual(row["qty"], before["qty"])
        self.assertEqual(row["status"], "closed")

    def test_missing_mark_is_unknown_and_logged_not_a_candle_fallback(self):
        env = self.live_env()
        trader = env.op.traders["PF_ETHUSD"]
        signal = trader.t[-1] + qt.BAR_MS
        trader._open(signal, "LONG", 1, "formula")
        env.op._record("PF_ETHUSD", trader, signal, [], env.now[0])
        funding_status = env.rows("SELECT funding_status FROM trades")[0]["funding_status"]
        env.book_error = book.BookError("libro_no_disponible", "offline")
        env.op._record("PF_ETHUSD", trader, signal, [], env.now[0])
        row = env.rows("SELECT qty,net_now_usd,net_complete_usd,funding_status FROM trades")[0]
        self.assertIsNone(row["net_now_usd"])
        self.assertIsNone(row["net_complete_usd"])
        self.assertEqual(row["funding_status"], funding_status)
        self.assertTrue(env.rows("SELECT * FROM errors WHERE place='ejecucion'"))
        self.assertIsNotNone(trader.position)


if __name__ == "__main__":
    unittest.main()
