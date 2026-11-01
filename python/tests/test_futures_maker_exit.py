import copy
import tempfile
import unittest
from decimal import Decimal as D

from balancita_engine import futures_book_execution as book
from balancita_engine import futures_maker_exit as mx
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt
from test_futures_book_execution import BASE, snapshot
from test_futures_qwen_live import BASE as LIVE_BASE, LIVE_CFG, make, walk

SETTINGS = {"modo": "sigue", "ttl_min": 45, "tope_pb": 40}


def plan_for(side="LONG", bid="100", ask="101", modo="sigue", ttl=45, tope=40, at=1_000_000):
    cfg = dict(SETTINGS, modo=modo, ttl_min=ttl, tope_pb=tope)
    return mx.start(side, at, D(bid), D(ask), cfg, closed_by="formula", exit_reason="x")


class MakerExitMachineTests(unittest.TestCase):
    def test_places_at_own_side_best_price_never_crossing(self):
        self.assertEqual(plan_for("LONG")["limit"], "101")
        self.assertEqual(plan_for("SHORT")["limit"], "100")
        with self.assertRaises(mx.MakerExitError):
            plan_for("LONG", bid="102", ask="101")

    def test_selling_fills_when_bid_reaches_the_limit_and_candles_need_to_go_past(self):
        plan = plan_for()
        _, action = mx.step(plan, plan["started_ms"] + 5000, D("100.5"), D("101.5"), D("101"), strict=False)
        self.assertEqual(action, {"kind": "fill", "price": D("101")})
        _, action = mx.step(plan, plan["started_ms"] + 5000, D("100.5"), D("101.5"), D("101"), strict=True)
        self.assertNotEqual(action["kind"], "fill")

    def test_buying_mirror_fills_when_ask_reaches_the_limit(self):
        plan = plan_for("SHORT")
        _, action = mx.step(plan, plan["started_ms"] + 5000, D("99.5"), D("100"), D("100"), strict=False)
        self.assertEqual(action, {"kind": "fill", "price": D("100")})

    def test_follows_the_best_price_when_the_market_runs_away_and_fixed_does_not(self):
        plan = plan_for()
        moved, action = mx.step(plan, plan["started_ms"] + 5000, D("100.2"), D("100.4"), D("100.2"), strict=False)
        self.assertEqual(action, {"kind": "reprice", "price": D("100.4")})
        self.assertEqual(moved["limit"], "100.4")
        self.assertEqual(len(moved["orders"]), 2)
        fixed = plan_for(modo="fija")
        kept, action = mx.step(fixed, fixed["started_ms"] + 5000, D("100.2"), D("100.4"), D("100.2"), strict=False)
        self.assertEqual(action["kind"], "hold")
        self.assertEqual(kept["limit"], "101")

    def test_never_chases_upwards_for_a_seller(self):
        plan = plan_for()
        _, action = mx.step(plan, plan["started_ms"] + 5000, D("100.4"), D("101.4"), D("100.4"), strict=False)
        self.assertEqual(action["kind"], "hold")

    def test_goes_to_market_after_the_time_limit_the_cap_and_a_book_outage(self):
        plan = plan_for()
        late = plan["started_ms"] + 45 * 60_000
        _, action = mx.step(dict(plan, last_ok_ms=late - 1000), late, D("100.9"), D("100.95"), D("100.9"), strict=False)
        self.assertEqual(action, {"kind": "market", "reason": "tiempo"})
        # 40 pb below the 100.5 mid at the start is 100.098
        _, action = mx.step(plan, plan["started_ms"] + 5000, D("100"), D("100.05"), D("100"), strict=False)
        self.assertEqual(action, {"kind": "market", "reason": "tope"})
        _, action = mx.step(plan, plan["started_ms"] + mx.BOOK_GAP_MS + 1, D("100.4"), D("101"), D("100.4"), strict=False)
        self.assertEqual(action, {"kind": "market", "reason": "libro"})

    def test_cap_for_a_short_is_an_upward_move(self):
        plan = plan_for("SHORT")
        _, action = mx.step(plan, plan["started_ms"] + 5000, D("100.95"), D("101.05"), D("101.05"), strict=False)
        self.assertEqual(action, {"kind": "market", "reason": "tope"})

    def test_settings_validation(self):
        self.assertIsNone(mx.settings({}))
        self.assertEqual(mx.settings({"execution": {"model": "m", "exit": SETTINGS}}), SETTINGS)
        self.assertEqual(mx.settings({"salida_maker": SETTINGS}), SETTINGS)
        for bad in ({"modo": "x", "ttl_min": 45, "tope_pb": 40}, {"modo": "fija", "ttl_min": 1, "tope_pb": 40},
                    {"modo": "fija", "ttl_min": 45}, {"modo": "fija", "ttl_min": 45, "tope_pb": 0}):
            with self.assertRaises(mx.MakerExitError):
                mx.settings({"salida_maker": bad})


def book_trader(test, modo="sigue"):
    cfg = copy.deepcopy(LIVE_CFG)
    cfg.update(products=["PF_ETHUSD"], execution={"model": book.MODEL, "exit": dict(SETTINGS, modo=modo)},
               funding_model=qt.exact_funding.EXACT_MODEL)
    trader = qt.Trader(cfg, "PF_ETHUSD", None)
    for bar in walk(qt.MIN_BARS, 1, BASE - qt.MIN_BARS * qt.BAR_MS, price=10):
        trader.feed(bar, trade=False)
    test.now = [BASE + 200]
    test.snap = [snapshot()]
    trader.book_execution = book.BookExecution(lambda product: test.snap[0], lambda: test.now[0])
    return trader


def at(test, offset_ms, bids, asks):
    test.now[0] = BASE + offset_ms
    test.snap[0] = snapshot(bids=bids, asks=asks, at=test.now[0] - 100)


class MakerExitTraderTests(unittest.TestCase):
    def open_and_decide_close(self, side="LONG", modo="sigue"):
        trader = book_trader(self, modo)
        trader._open(BASE, side, 1, "formula")
        at(self, 60_000, [["103", "10"]], [["104", "10"]])
        events = trader._close(BASE + 60_000, 9999, "strategy_exit", "formula", "maestro_vuelta")
        return trader, events

    def test_decision_leaves_a_waiting_order_not_a_trade(self):
        trader, events = self.open_and_decide_close()
        self.assertEqual([event["type"] for event in events], ["exit_plan"])
        self.assertIsNotNone(trader.position)
        self.assertEqual(trader.position.exit_plan["limit"], "104")
        self.assertEqual(trader._close(BASE + 61_000, 1, "strategy_exit", "formula", "otra"), [])

    def test_fill_is_maker_priced_at_the_limit_and_the_receipt_replays(self):
        trader, _ = self.open_and_decide_close()
        position = trader.position
        at(self, 120_000, [["104", "10"]], [["104.5", "10"]])
        events = trader.service_exit(self.now[0])
        trade = next(event["trade"] for event in events if event["type"] == "trade")
        self.assertEqual(D(trade["exit_fill"]), D("104"))
        self.assertEqual(trade["closed_by"], "formula")
        self.assertEqual(trade["exit_plan"]["outcome"], "maker")
        receipt = trade["exit_execution"]
        self.assertEqual(receipt["fee_kind"], "maker")
        self.assertEqual(D(receipt["fee_usd"]), D("104") * position.qty * D("0.0002"))
        self.assertEqual(D(trade["fees_usd"]), D(position.entry_execution["fee_usd"]) + D(receipt["fee_usd"]))
        replayed = book.replay_fill(receipt)
        self.assertEqual((replayed.price, replayed.fee_kind), (D("104"), "maker"))
        self.assertEqual(trade["exit_ms"], self.now[0])

    def test_tampered_maker_receipt_does_not_replay(self):
        trader, _ = self.open_and_decide_close()
        at(self, 120_000, [["104", "10"]], [["104.5", "10"]])
        receipt = next(e["trade"] for e in trader.service_exit(self.now[0]) if e["type"] == "trade")["exit_execution"]
        for key, value in (("price", "103"), ("fee_usd", "0"), ("maker_rate", "0.0001")):
            bad = copy.deepcopy(receipt)
            bad[key] = value
            with self.assertRaises(book.BookError):
                book.replay_fill(bad)
        bad = copy.deepcopy(receipt)
        bad["quote"]["bids"] = [["103", "10"]]
        with self.assertRaises(book.BookError):
            book.replay_fill(bad)

    def test_no_fill_without_the_book_reaching_the_price(self):
        trader, _ = self.open_and_decide_close()
        at(self, 70_000, [["103.5", "10"]], [["104", "10"]])
        self.assertEqual(trader.service_exit(self.now[0]), [])
        self.assertIsNotNone(trader.position)

    def test_follows_down_then_falls_to_market_on_the_cap(self):
        trader, _ = self.open_and_decide_close()
        at(self, 70_000, [["103.2", "10"]], [["103.6", "10"]])
        events = trader.service_exit(self.now[0])
        self.assertEqual((events[0]["type"], events[0]["action"], events[0]["price"]), ("exit_plan", "movida", "103.6"))
        self.assertEqual(trader.position.exit_plan["limit"], "103.6")
        at(self, 80_000, [["102.9", "10"]], [["103.1", "10"]])      # 103 vs 103.5 start mid is -48 pb
        events = trader.service_exit(self.now[0])
        trade = next(event["trade"] for event in events if event["type"] == "trade")
        self.assertEqual(trade["exit_plan"]["outcome"], "mercado:tope")
        self.assertEqual(trade["exit_execution"]["fee_kind"], "taker")
        self.assertEqual(trade["exit_execution"]["exit_plan"]["reprices"], 1)
        self.assertEqual(D(trade["exit_fill"]), D("102.9"))

    def test_time_limit_sends_it_to_market(self):
        trader, _ = self.open_and_decide_close()
        at(self, 60_000 + 45 * 60_000, [["103.4", "10"]], [["103.9", "10"]])
        trader.position.exit_plan = dict(trader.position.exit_plan, last_ok_ms=self.now[0] - 1000)
        trade = next(e["trade"] for e in trader.service_exit(self.now[0]) if e["type"] == "trade")
        self.assertEqual(trade["exit_plan"]["outcome"], "mercado:tiempo")

    def test_emergencies_leave_at_market_immediately(self):
        for reason in ("stop", "noticias", "fin_de_bloque"):
            trader, _ = self.open_and_decide_close()
            at(self, 70_000, [["103.5", "10"]], [["104", "10"]])
            events = trader._close(BASE + 70_000, 9999, "strategy_exit", reason, "x")
            trade = next(event["trade"] for event in events if event["type"] == "trade")
            self.assertEqual(trade["exit_plan"]["outcome"], "mercado:emergencia_" + reason)
            self.assertEqual(D(trade["exit_fill"]), D("103.5"))
            self.assertIsNone(trader.position)

    def test_emergency_closes_do_not_wait_even_with_no_plan_pending(self):
        trader = book_trader(self)
        trader._open(BASE, "LONG", 1, "formula")
        at(self, 60_000, [["103", "10"]], [["104", "10"]])
        events = trader._close(BASE + 60_000, 9999, "stop", "stop", None)
        self.assertEqual(events[-1]["trade"]["exit_execution"]["fee_kind"], "taker")

    def test_restart_keeps_the_waiting_order(self):
        trader, _ = self.open_and_decide_close()
        restored = live.position_from_json(live.position_to_json(trader.position))
        self.assertEqual(restored.exit_plan, trader.position.exit_plan)
        broken = live.position_to_json(trader.position).replace('"position_side": "LONG"', '"position_side": "SHORT"')
        with self.assertRaises(qt.TraderError):
            live.position_from_json(broken)

    def test_book_outage_holds_until_the_book_returns_then_goes_to_market(self):
        trader, _ = self.open_and_decide_close()
        self.now[0] = BASE + 60_000 + mx.BOOK_GAP_MS + 5000
        self.snap[0] = snapshot(bids=[["103.4", "10"]], asks=[["103.9", "10"]], at=self.now[0] - 100)
        trade = next(e["trade"] for e in trader.service_exit(self.now[0]) if e["type"] == "trade")
        self.assertEqual(trade["exit_plan"]["outcome"], "mercado:libro")

    def test_without_settings_exits_stay_at_market(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg.update(products=["PF_ETHUSD"], execution={"model": book.MODEL}, funding_model=qt.exact_funding.EXACT_MODEL)
        trader = qt.Trader(cfg, "PF_ETHUSD", None)
        for bar in walk(qt.MIN_BARS, 1, BASE - qt.MIN_BARS * qt.BAR_MS, price=10):
            trader.feed(bar, trade=False)
        self.now, self.snap = [BASE + 200], [snapshot()]
        trader.book_execution = book.BookExecution(lambda product: self.snap[0], lambda: self.now[0])
        trader._open(BASE, "LONG", 1, "formula")
        at(self, 60_000, [["103", "10"]], [["104", "10"]])
        events = trader._close(BASE + 60_000, 9999, "strategy_exit", "formula", "x")
        self.assertEqual(events[-1]["type"], "trade")
        self.assertIsNone(events[-1]["trade"]["exit_plan"])


class MakerExitLiveTests(unittest.TestCase):
    def env(self):
        folder = self.enterContext(tempfile.TemporaryDirectory())
        cfg = copy.deepcopy(LIVE_CFG)
        cfg.update(products=["PF_ETHUSD"], execution={"model": book.MODEL, "exit": SETTINGS},
                   funding_model=qt.exact_funding.EXACT_MODEL)
        env = make(self, cfg=cfg, db=folder, now=LIVE_BASE + qt.BAR_MS + 200)
        env.levels = {"bids": [["100", "10"]], "asks": [["101", "10"]]}
        env.feed.book_snapshot = lambda product: snapshot(**env.levels, at=env.now[0] - 100)
        env.op.start()
        env.op.gate.begin("live")
        return env

    def test_waiting_order_is_persisted_followed_filled_and_replayable(self):
        env = self.env()
        trader = env.op.traders["PF_ETHUSD"]
        signal = trader.t[-1] + qt.BAR_MS
        trader._open(signal, "LONG", 1, "formula")
        env.op._record("PF_ETHUSD", trader, signal, [], env.now[0])
        env.now[0] += qt.BAR_MS
        env.levels = {"bids": [["103", "10"]], "asks": [["104", "10"]]}
        trader.feed(walk(1, 1, trader.t[-1] + qt.BAR_MS)[0], trade=False)
        env.op.gate.begin("live")
        events = trader._close(trader.t[-1] + qt.BAR_MS, 9999, "strategy_exit", "formula", "maestro_vuelta")
        env.op._record("PF_ETHUSD", trader, trader.t[-1] + qt.BAR_MS, events, env.now[0])
        row = env.rows("SELECT status,exit_plan_json FROM trades")[0]
        self.assertEqual(row["status"], "open")
        self.assertIn('"limit": "104"', row["exit_plan_json"])
        env.restart().start()
        self.addCleanup(env.store.close)
        trader = env.op.traders["PF_ETHUSD"]
        self.assertEqual(trader.position.exit_plan["limit"], "104")
        env.now[0] += 5000
        env.levels = {"bids": [["103.5", "10"]], "asks": [["103.8", "10"]]}
        env.op._service_exit("PF_ETHUSD", env.now[0])
        self.assertIn('"limit": "103.8"', env.rows("SELECT exit_plan_json FROM trades")[0]["exit_plan_json"])
        env.now[0] += 5000
        env.levels = {"bids": [["103.8", "10"]], "asks": [["104", "10"]]}
        env.op._service_exit("PF_ETHUSD", env.now[0])
        row = env.rows("SELECT status,exit_px,closed_by,exit_receipt_id FROM trades")[0]
        self.assertEqual((row["status"], D(row["exit_px"]), row["closed_by"]), ("closed", D("103.8"), "formula"))
        self.assertIsNone(trader.position)
        env.store.replay_trade("PF_ETHUSD", 1)
        evidence = env.store.execution_evidence(row["exit_receipt_id"], purpose="exit")
        self.assertEqual(evidence["fee_kind"], "maker")

    def test_book_failure_while_waiting_is_logged_and_the_order_survives(self):
        env = self.env()
        trader = env.op.traders["PF_ETHUSD"]
        signal = trader.t[-1] + qt.BAR_MS
        trader._open(signal, "LONG", 1, "formula")
        trader._close(signal, 9999, "strategy_exit", "formula", "x")
        def broken(product):
            raise book.BookError("libro_no_disponible", "offline")
        env.feed.book_snapshot = broken
        trader.book_execution.snapshot_for = broken
        env.op._service_exit("PF_ETHUSD", env.now[0] + 5000)
        self.assertTrue(env.rows("SELECT * FROM errors WHERE place='ejecucion'"))
        self.assertIsNotNone(trader.position.exit_plan)


class MakerExitCandleTests(unittest.TestCase):
    """Estrategias: the same trader fed with candles, no book."""

    def trader(self, modo="sigue"):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg["salida_maker"] = dict(SETTINGS, modo=modo)
        trader = qt.Trader(cfg, "PF_ETHUSD", None)
        for bar in walk(qt.MIN_BARS, 1, BASE - qt.MIN_BARS * qt.BAR_MS, price=100):
            trader.feed(bar, trade=False)
        return trader

    def bar(self, trader, close, high, low):
        start = trader.t[-1] + qt.BAR_MS
        return {"bucket_start": start, "open": repr(close), "high": repr(high), "low": repr(low), "close": repr(close),
                "volume_btc": "5"}

    def test_waits_for_a_candle_that_goes_past_the_limit_and_charges_maker(self):
        trader = self.trader()
        position = trader._open(BASE, "LONG", 1, "formula")
        decision = trader.t[-1] + qt.BAR_MS
        events = trader._close(decision, 100.0, "strategy_exit", "formula", "x")
        self.assertEqual(events[0]["type"], "exit_plan")
        events = trader.feed(self.bar(trader, 100.0, 100.0, 99.9))          # touches, does not pass
        self.assertFalse([e for e in events if e["type"] == "trade"])
        events = trader.feed(self.bar(trader, 100.05, 100.2, 100.0))
        trade = next(event["trade"] for event in events if event["type"] == "trade")
        self.assertEqual(D(trade["exit_fill"]), D("100.0"))
        self.assertEqual(trade["exit_plan"]["outcome"], "maker")
        expected = position.entry_px * position.qty * D("0.0005") + D("100.0") * position.qty * D("0.0002")
        self.assertEqual(D(trade["fees_usd"]), expected)

    def test_candle_sim_follows_the_close_down_then_cap_goes_to_market_with_impact(self):
        trader = self.trader()
        trader._open(BASE, "LONG", 1, "formula")
        decision = trader.t[-1] + qt.BAR_MS
        trader._close(decision, 100.0, "strategy_exit", "formula", "x")
        events = trader.feed(self.bar(trader, 99.8, 99.9, 99.7))
        self.assertEqual(trader.position.exit_plan["limit"], "99.8")
        events = trader.feed(self.bar(trader, 99.5, 99.6, 99.4))             # -50 pb from 100
        trade = next(event["trade"] for event in events if event["type"] == "trade")
        self.assertEqual(trade["exit_plan"]["outcome"], "mercado:tope")
        self.assertLess(D(trade["exit_fill"]), D("99.5"))

    def test_force_close_at_end_of_exam_does_not_wait(self):
        trader = self.trader()
        trader._open(BASE, "LONG", 1, "formula")
        trader._close(trader.t[-1] + qt.BAR_MS, 100.0, "strategy_exit", "formula", "x")
        events = trader.force_close("fin_examen")
        self.assertEqual(events[-1]["trade"]["exit_plan"]["outcome"], "mercado:emergencia_fin_examen")


if __name__ == "__main__":
    unittest.main()


class MakerExitEnvTests(unittest.TestCase):
    def test_env_values_and_defaults(self):
        self.assertEqual(mx.env_for(), {"QWEN_SALIDA": "sigue"})
        self.assertEqual(mx.env_for("mercado"), {"QWEN_SALIDA": "mercado"})
        with self.assertRaises(ValueError):
            mx.env_for("rapida")

    def test_apply_env_only_when_asked_and_mercado_removes_it(self):
        cfg = {"a": 1}
        self.assertIs(mx.apply_env(cfg, {}), cfg)
        self.assertEqual(mx.apply_env(cfg, {"QWEN_SALIDA": "fija"})["salida_maker"]["modo"], "fija")
        self.assertNotIn("salida_maker", mx.apply_env({"salida_maker": SETTINGS}, {"QWEN_SALIDA": "mercado"}))

    def test_describe_counts_every_way_out(self):
        trades = [{"exit_plan": None, "qty": "1"},
                  {"exit_plan": {"outcome": "maker", "fill_price": "100"}, "qty": "2"},
                  {"exit_plan": {"outcome": "mercado:tope"}, "qty": "1"},
                  {"exit_plan": {"outcome": "mercado:tiempo"}, "qty": "1"},
                  {"exit_plan": {"outcome": "mercado:emergencia_stop"}, "qty": "1"}]
        out = mx.describe({"salida_maker": SETTINGS}, trades)
        self.assertEqual((out["maker"], out["mercado"], out["mercado_tope"], out["mercado_tiempo"],
                          out["mercado_emergencia"]), (1, 1, 1, 1, 1))
        self.assertEqual(out["comision_ahorrada_usd"], "0.06")
        self.assertEqual(mx.describe({}, [])["modo"], "mercado")
