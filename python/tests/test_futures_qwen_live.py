"""Qwen operador EN VIVO: todo con proveedor falso, velas inventadas y bases temporales. Sin red, sin modelo."""
import copy
import json
import math
import os
import random
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt

MIN = 60_000
BAR = qt.BAR_MS
DAY = qt.DAY_MS
D = Decimal
BASE = qt.date_ms("2026-10-20")                  # a day boundary: also a 15 minute boundary
LIVE_CFG = qt.load_config(qt.CONFIG_PATH_LIVE)
PRODUCTS = tuple(LIVE_CFG["products"])
START = BASE + 7 * MIN                           # the candle that ended at BASE + 5 min is 2 minutes old


def walk(n, seed, start, price=100.0, sigma=0.0002):
    rng = random.Random(seed)
    out = []
    for i in range(n):
        open_ = price
        price = max(1.0, price * (1 + rng.gauss(0, sigma)))
        high = max(open_, price) * (1 + abs(rng.gauss(0, sigma / 3)))
        low = min(open_, price) * (1 - abs(rng.gauss(0, sigma / 3)))
        out.append({"bucket_start": start + i * BAR, "open": repr(open_), "high": repr(high), "low": repr(low),
                    "close": repr(price), "volume_btc": repr(abs(rng.gauss(5, 2)) + 0.1)})
    return out


def legacy_letters(cfg):
    """The live config without the sheet and the factors question: the window asks the two-option question of letters
    (``live.force_question``), the way version 4 did. Same window logic, so its tests keep running on letters."""
    cfg.pop("factors", None)
    cfg["state_ficha"], cfg["state_context"] = False, []
    return cfg


class Policy:
    """What the fake model answers: one option per kind of question, by option id."""

    def __init__(self, flat="ESPERAR", position="MANTENER", reason="sin_ventaja", forced="LARGO"):
        self.flat, self.position, self.reason, self.forced = flat, position, reason, forced

    def __call__(self, prompt, letters):
        if "elegir un lado" in prompt:
            wanted = self.forced
        elif "No tenés ninguna posición" in prompt:
            wanted = self.flat
        elif "Tenés una posición abierta" in prompt:
            wanted = self.position
        else:
            wanted = self.reason
        letter = re.search(r"^([A-Z])\) {}\b".format(wanted), prompt, re.M).group(1)
        return [{"token": x, "logprob": -0.05 if x == letter else -6.0} for x in letters]


class FakeFeed:
    def __init__(self, candles, funding=()):
        self.candles, self.funding_rows = candles, list(funding)

    def bars(self, product, from_ms, to_ms):
        return [c for c in self.candles[product] if from_ms <= c["bucket_start"] and c["bucket_start"] + BAR <= to_ms]

    def funding(self, product):
        return list(self.funding_rows)


class Env:
    """A live operator on a temporary database, a fake public feed and a clock that only moves when told."""

    def __init__(self, test, cfg=None, policy=None, sigma=0.0002, db=None, funding=(), mirror=False, now=START,
                 provider=None, clock=None, formula=False):
        self.cfg = copy.deepcopy(cfg or LIVE_CFG)
        if not formula:
            self.cfg.pop("decide_by", None)                  # version 9 decides by formula: most tests exercise the model deciding
        if cfg is None:
            self.cfg["live"]["force_window_h"] = 0           # the window is opt-in in tests: the rest exercises the normal flat question
        self.cfg["mirror"] = mirror
        self.tmp = db or tempfile.mkdtemp()
        # the sheet reads the collector's database: a test never reads the real one of this machine
        self.cfg.setdefault("positioning_db", os.path.join(self.tmp, "sin-posicionamiento.sqlite"))
        self.db_path = os.path.join(self.tmp, "live.sqlite")
        self.policy = policy or Policy()
        self.provider = provider or llm.FakeProvider(entries=self.policy)
        self.candles = {p: walk(11 * 288, 7 + i, BASE - 9 * DAY, sigma=sigma) for i, p in enumerate(PRODUCTS)}
        self.now = [now]
        self.feed = FakeFeed(self.candles, funding)
        self.clock = clock or (lambda: 0.0)
        self.logs = []
        self.store = live.LiveStore(self.db_path)
        self.op = self.build()

    def build(self):
        return live.LiveOperator(self.cfg, self.store, self.feed, self.provider, now_ms=lambda: self.now[0],
                                 clock=self.clock, log=self.logs.append)

    def restart(self):
        """A new process on the same database: everything in memory is gone."""
        self.store.close()
        self.store = live.LiveStore(self.db_path)
        self.op = self.build()
        return self.op

    def advance(self, minutes):
        for _ in range(minutes // 5):
            self.now[0] += 5 * MIN
            self.op.poll()

    def rows(self, sql, *args):
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql, args)]
        finally:
            con.close()


def make(test, **kwargs):
    env = Env(test, **kwargs)
    test.addCleanup(env.store.close)
    return env


class VersionTests(unittest.TestCase):
    def test_live_is_registered_without_touching_the_others(self):
        self.assertEqual(qt.version_paths("live")[0], qt.CONFIG_PATH_LIVE)
        self.assertIn("live", qt.VERSIONS)
        self.assertNotIn("live", qt.PRACTICE_VERSIONS)
        self.assertEqual(qt.version_paths("3")[0], qt.CONFIG_PATH_V3)
        self.assertNotEqual(qt.version_paths("live")[1], qt.version_paths("3")[1])
        self.assertNotEqual(qt.config_hash(LIVE_CFG), qt.config_hash(qt.load_config(qt.CONFIG_PATH_V3)))

    def test_older_configs_keep_their_identity(self):
        # Pinned: a change to these hashes would invalidate their practice databases.
        pins = {qt.CONFIG_PATH: "3a6c1587", qt.CONFIG_PATH_V2: "1e7cfac1", qt.CONFIG_PATH_V21: "c05bfd06",
                qt.CONFIG_PATH_V3: "c342bf2c"}
        for path, prefix in pins.items():
            self.assertTrue(qt.config_hash(qt.load_config(path)).startswith(prefix), path)
        v3 = qt.load_config(qt.CONFIG_PATH_V3)
        self.assertNotIn("extra_wakes", v3["wake"])          # the old configs keep every extra wake
        self.assertNotIn("live", v3)

    def test_the_config_says_what_was_approved(self):
        cfg = LIVE_CFG
        self.assertEqual(cfg["products"], ["PF_XBTUSD", "PF_ETHUSD"])
        self.assertEqual((cfg["wake"]["flat_every_min"], cfg["wake"]["position_every_min"]), (15, 15))
        self.assertIs(cfg["wake"]["extra_wakes"], False)
        # version 9: no stop (stops turn noise into losses) and NO time limit (Fran, 27-oct: the exit is decided at every look)
        self.assertEqual(cfg["guardrails"], {"stop_sigma_24h": None, "min_stop_pct": 0.005, "max_stop_pct": 0.03,
                                             "max_hold_min": None, "cooldown_min": 15})
        self.assertTrue(cfg["mirror"])
        self.assertTrue(cfg["state_corta"])
        self.assertNotIn("lora", cfg)                       # the adapter learnt the 8-factor sheet: not applied to the short one
        self.assertNotIn("factors", cfg)
        self.assertEqual(cfg["live"]["force_window_h"], 0)  # no opportunity window: Qwen decides on the short sheet

    def test_the_prompt_tells_the_truth_about_the_rules(self):
        env = make(self, policy=Policy("LARGO"))
        env.op.start()
        env.advance(60)
        texts = [r["state_text"] for r in env.rows("SELECT state_text FROM decisions WHERE kind='position'")]
        self.assertTrue(texts)
        self.assertIn("sin stop automático", texts[0])
        self.assertIn("sin límite de tiempo", texts[0])
        self.assertNotIn("Cierre obligatorio", texts[0])
        self.assertNotIn("48 h", texts[0])
        self.assertNotIn("Distancia al stop", texts[0])
        question = LIVE_CFG["prompt"]["questions"]["position"]["instruction"]
        self.assertIn("No hay stop", question)
        self.assertIn("ni límite de tiempo", question)


class CadenceTests(unittest.TestCase):
    def test_flat_wakes_only_every_15_minutes_and_never_between(self):
        env = make(self)
        env.op.start()
        env.advance(6 * 60)
        rows = env.rows("SELECT product, t_ms, bucket_ms, wake_json FROM decisions ORDER BY product, t_ms")
        for product in PRODUCTS:
            times = [r["t_ms"] for r in rows if r["product"] == product]
            self.assertEqual(len(times), 24, product)                        # 6 h x 4
            self.assertTrue(all(t % (15 * MIN) == 0 for t in times))
            self.assertEqual(len(set(times)), len(times))
        self.assertTrue(all(json.loads(r["wake_json"]) == ["cada_15_min"] for r in rows))
        self.assertTrue(all(r["bucket_ms"] == r["t_ms"] - 15 * MIN for r in rows))
        self.assertEqual(env.rows("SELECT * FROM skipped"), [])

    def test_a_violent_candle_does_not_add_a_wake_flat_or_in_position(self):
        for flat in ("ESPERAR", "LARGO"):
            env = make(self, policy=Policy(flat=flat))
            for product in PRODUCTS:                                   # +4 % in one candle, off the boundary
                bar = env.candles[product][9 * 288 + 13]               # bucket BASE + 65 min: ends at BASE + 70
                for key in ("open", "high", "low", "close"):
                    bar[key] = repr(float(bar[key]) * 1.04)
                for later in env.candles[product][9 * 288 + 14:]:
                    for key in ("open", "high", "low", "close"):
                        later[key] = repr(float(later[key]) * 1.04)
            env.op.start()
            env.advance(3 * 60)
            times = {r["t_ms"] for r in env.rows("SELECT t_ms FROM decisions")}
            self.assertTrue(times)
            self.assertTrue(all(t % (15 * MIN) == 0 for t in times), flat)
            self.assertTrue(all("cada_15_min" == json.loads(r["wake_json"])[0] and len(json.loads(r["wake_json"])) == 1
                                for r in env.rows("SELECT wake_json FROM decisions")))

    def test_in_position_also_every_15_minutes_and_one_call_pair_per_wake(self):
        env = make(self, policy=Policy(flat="LARGO"))
        env.op.start()
        env.advance(2 * 60)
        for product in PRODUCTS:
            rows = env.rows("SELECT t_ms, kind FROM decisions WHERE product=? ORDER BY t_ms", product)
            self.assertEqual(rows[0]["kind"], "flat")
            self.assertTrue(all(r["kind"] == "position" for r in rows[1:]))
            self.assertTrue(all(b["t_ms"] - a["t_ms"] == 15 * MIN for a, b in zip(rows, rows[1:])))
        # 2 option orders per question; the entry reason is not asked; no mirror in this config
        self.assertEqual(len(env.provider.prompts), 2 * len(env.rows("SELECT * FROM decisions")))

    def test_the_time_limit_closes_at_48_hours_and_there_is_no_stop(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg["guardrails"]["max_hold_min"] = 2880                     # version 9 has no time limit; the operator still honours one when the config sets it
        env = make(self, cfg=cfg, policy=Policy(flat="LARGO"))
        for i, product in enumerate(PRODUCTS):                       # three more days of candles: the limit is 48 h here
            last = env.candles[product][-1]
            env.candles[product] += walk(3 * 288, 70 + i, last["bucket_start"] + BAR, price=float(last["close"]))
        env.op.start()
        env.advance(49 * 60)
        trades = env.rows("SELECT * FROM trades WHERE product='PF_XBTUSD' ORDER BY trade_no")
        self.assertEqual(trades[0]["status"], "closed")
        self.assertEqual(trades[0]["closed_by"], "tiempo")
        self.assertEqual(trades[0]["hold_min"], 2880)
        self.assertIsNone(trades[0]["stop_px"])
        self.assertEqual([r["closed_by"] for r in trades if r["closed_by"] == "stop"], [])
        # the cooldown: no decision in the 15 minutes after the close
        close_ms = trades[0]["exit_ms"]
        times = [r["t_ms"] for r in env.rows("SELECT t_ms FROM decisions WHERE product='PF_XBTUSD' AND kind='flat'")]
        self.assertFalse(any(close_ms < t < close_ms + 15 * MIN for t in times))

    def test_the_mirror_still_blocks_an_entry_that_does_not_come_from_the_numbers(self):
        env = make(self, policy=Policy(flat="LARGO"), mirror=True)          # LARGO on the real AND the mirrored numbers
        env.op.start()
        env.advance(60)
        rows = env.rows("SELECT action, model_action, override FROM decisions")
        self.assertTrue(rows)
        self.assertTrue(all(r["model_action"] == "LARGO" and r["action"] == "ESPERAR" and r["override"] == "espejo"
                            for r in rows))
        self.assertEqual(env.rows("SELECT * FROM trades"), [])


class ModelFailureTests(unittest.TestCase):
    def test_model_down_is_an_omitted_wake_without_a_decision_or_a_trade_and_is_not_retried(self):
        provider = llm.FakeProvider(entries=Policy(flat="LARGO"), healthy=False)
        env = make(self, provider=provider)
        env.op.start()
        env.advance(60)
        skipped = env.rows("SELECT * FROM skipped WHERE product='PF_XBTUSD' ORDER BY t_ms")
        self.assertEqual(len(skipped), 4)
        self.assertTrue(all(r["reason"] == "modelo_caido" and r["detail"] for r in skipped))
        self.assertEqual(env.rows("SELECT * FROM decisions"), [])
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertEqual(provider.calls, 0)                                  # nothing was asked, nothing was invented
        provider.healthy = True                                              # it comes back: only NEW wakes are asked
        before = len(skipped)
        env.advance(5)                                                       # not a boundary: still nothing
        self.assertEqual(len(env.rows("SELECT * FROM skipped WHERE product='PF_XBTUSD'")), before)
        self.assertEqual(provider.calls, 0)
        env.advance(15)
        decisions = env.rows("SELECT t_ms FROM decisions WHERE product='PF_XBTUSD'")
        self.assertEqual(len(decisions), 1)
        self.assertTrue(all(d["t_ms"] > skipped[-1]["t_ms"] for d in decisions))

    def test_a_model_that_fails_every_call_is_down_too(self):
        provider = llm.FakeProvider(entries=Policy(flat="LARGO"))
        provider.fail_with = llm.ModelUnavailable("connection refused")
        env = make(self, provider=provider)
        env.op.start()
        env.advance(30)
        self.assertEqual({r["reason"] for r in env.rows("SELECT reason FROM skipped")}, {"modelo_caido"})
        self.assertEqual(env.rows("SELECT * FROM decisions"), [])
        self.assertEqual(env.rows("SELECT * FROM trades"), [])

    def test_a_slow_model_leaves_the_position_alone_and_says_why(self):
        clock = [0.0]

        slow = [False]

        class Slow(llm.FakeProvider):
            def complete(self, *args, **kwargs):
                if slow[0]:
                    clock[0] += 500.0                                        # each call takes longer than the whole budget
                return super().complete(*args, **kwargs)

        policy = Policy(flat="LARGO")
        env = make(self, provider=Slow(entries=policy), policy=policy, clock=lambda: clock[0])
        env.op.start()
        env.advance(15)                                                      # opens a position (one question)
        self.assertEqual(len(env.rows("SELECT * FROM trades WHERE status='open'")), 2)
        policy.position = "CERRAR"                                           # the close needs a second question: too late
        slow[0] = True
        env.advance(15)
        skipped = env.rows("SELECT * FROM skipped")
        self.assertTrue(skipped)
        self.assertEqual({r["reason"] for r in skipped}, {"modelo_lento"})
        self.assertEqual(len(env.rows("SELECT * FROM trades WHERE status='open'")), 2)     # nothing was closed
        self.assertEqual(env.rows("SELECT * FROM trades WHERE status='closed'"), [])

    def test_an_unreadable_answer_is_omitted_not_decided(self):
        provider = llm.FakeProvider(entries=lambda prompt, letters: [{"token": "Z", "logprob": -0.1}])
        env = make(self, provider=provider)
        env.op.start()
        env.advance(30)
        self.assertEqual(env.rows("SELECT * FROM decisions"), [])
        self.assertEqual({r["reason"] for r in env.rows("SELECT reason FROM skipped")}, {"sin_respuesta"})


class RestartTests(unittest.TestCase):
    def test_the_first_start_decides_nothing_about_the_past(self):
        env = make(self)
        env.op.start()
        self.assertEqual(env.rows("SELECT * FROM decisions"), [])
        self.assertEqual(env.rows("SELECT * FROM skipped"), [])
        self.assertEqual(env.provider.calls, 0)
        self.assertGreaterEqual(len(env.op.traders["PF_XBTUSD"].c), qt.MIN_BARS)

    def test_restart_restores_the_open_position_and_does_not_duplicate_anything(self):
        env = make(self, policy=Policy(flat="LARGO"))
        env.op.start()
        env.advance(60)
        before = {name: env.rows("SELECT * FROM {}".format(name)) for name in ("decisions", "trades", "skipped")}
        self.assertEqual(len(before["trades"]), 2)
        pos_before = {p: env.op.traders[p].position.snapshot() for p in PRODUCTS}
        calls = env.provider.calls
        op = env.restart()
        op.start()                                                           # same moment, new process
        for product in PRODUCTS:
            self.assertEqual(op.traders[product].position.snapshot(), pos_before[product])
            self.assertEqual(op.traders[product].trade_seq, 1)
        self.assertEqual(env.provider.calls, calls)                          # nothing asked again
        for name in ("decisions", "trades", "skipped"):
            self.assertEqual(env.rows("SELECT * FROM {}".format(name)), before[name], name)
        op.poll()                                                            # polling the same candles changes nothing
        self.assertEqual(env.provider.calls, calls)
        env.advance(30)                                                      # and it keeps going from where it was
        rows = env.rows("SELECT t_ms FROM decisions WHERE product='PF_XBTUSD' ORDER BY t_ms")
        self.assertEqual(len(rows), len(before["decisions"]) // 2 + 2)
        self.assertEqual(len({r["t_ms"] for r in rows}), len(rows))
        self.assertEqual(len(env.rows("SELECT * FROM trades WHERE product='PF_XBTUSD'")), 1)

    def test_a_bucket_already_decided_is_never_asked_again(self):
        env = make(self)
        env.op.start()
        env.advance(25)                                                      # the last candle fed ends at BASE + 30 min
        calls = env.provider.calls
        decided = env.rows("SELECT * FROM decisions")
        self.assertEqual(len(decided), 4)                                    # BASE + 15 and + 30, two products
        trader = env.op.traders["PF_XBTUSD"]
        # the same candle arrives again (e.g. the state row was lost in a crash): the wake is not repeated
        again = env.candles["PF_XBTUSD"][9 * 288 + 5]
        self.assertEqual(again["bucket_start"], trader.t[-1])
        trader.t.pop()
        for series in (trader.o, trader.h, trader.l, trader.c, trader.v, trader.lc):
            series.pop()
        env.op._process("PF_XBTUSD", again)
        self.assertEqual(env.provider.calls, calls)
        self.assertEqual(env.rows("SELECT * FROM decisions"), decided)

    def test_after_a_long_stop_missed_wakes_are_omitted_with_the_reason_and_nothing_is_asked(self):
        env = make(self)
        env.op.start()
        env.advance(30)
        calls = env.provider.calls
        op = env.restart()
        env.now[0] += 2 * 60 * MIN                                           # the process was off for two hours
        op.start()
        self.assertEqual(env.provider.calls, calls)
        skipped = env.rows("SELECT * FROM skipped WHERE product='PF_XBTUSD' ORDER BY t_ms")
        self.assertTrue(skipped)
        self.assertEqual({r["reason"] for r in skipped}, {"proceso_detenido"})
        decided = {r["t_ms"] for r in env.rows("SELECT t_ms FROM decisions WHERE product='PF_XBTUSD'")}
        self.assertFalse(decided & {r["t_ms"] for r in skipped})

    def test_a_database_of_another_config_is_refused(self):
        env = make(self)
        env.op.start()
        other = copy.deepcopy(LIVE_CFG)
        other["prompt"]["system"] += " Otra cosa."
        store = live.LiveStore(env.db_path)
        self.addCleanup(store.close)
        with self.assertRaises(qt.TraderError) as caught:
            store.check_identity(other)
        self.assertIn("otra configuración", str(caught.exception))


class SizeLeverageProductsTests(unittest.TestCase):
    def test_defaults_are_100_usd_1x_btc_and_eth(self):
        cfg = live.apply_overrides(LIVE_CFG, {})
        self.assertEqual((cfg["notional_usd"], cfg["leverage"], cfg["products"]), ("100", "1", ["PF_XBTUSD", "PF_ETHUSD"]))

    def test_environment_changes_them_with_no_caps(self):
        cfg = live.apply_overrides(LIVE_CFG, {"QWEN_LIVE_NOTIONAL_USD": "250000", "QWEN_LIVE_LEVERAGE": "50",
                                              "QWEN_LIVE_PRODUCTS": "PF_ETHUSD"})
        self.assertEqual((cfg["notional_usd"], cfg["leverage"], cfg["products"]), ("250000", "50", ["PF_ETHUSD"]))
        self.assertNotEqual(qt.config_hash(cfg), qt.config_hash(LIVE_CFG))      # another database is needed
        self.assertEqual(LIVE_CFG["notional_usd"], "100")                        # the loaded config is not touched

    def test_only_positive_numbers_and_known_products_are_accepted(self):
        for env in ({"QWEN_LIVE_NOTIONAL_USD": "0"}, {"QWEN_LIVE_NOTIONAL_USD": "-5"}, {"QWEN_LIVE_LEVERAGE": "abc"},
                    {"QWEN_LIVE_LEVERAGE": "nan"}, {"QWEN_LIVE_PRODUCTS": "btc"}, {"QWEN_LIVE_PRODUCTS": "PF_XBTUSD,PF_XBTUSD"}):
            with self.assertRaises(qt.TraderError, msg=env):
                live.apply_overrides(LIVE_CFG, env)

    def test_accounting_uses_the_notional_and_the_margin_is_notional_over_leverage(self):
        cfg = live.apply_overrides(LIVE_CFG, {"QWEN_LIVE_NOTIONAL_USD": "1000", "QWEN_LIVE_LEVERAGE": "5",
                                              "QWEN_LIVE_PRODUCTS": "PF_XBTUSD"})
        cfg["live"]["force_window_h"] = 0
        rows = [(BASE - 10 * DAY + i * qt.HOUR_MS, 3e-5) for i in range(0, 10 * 24 + 40)]
        env = make(self, cfg=cfg, policy=Policy(flat="LARGO"), funding=rows)
        env.op.start()
        env.advance(30)
        open_row = env.rows("SELECT * FROM trades")[0]
        self.assertEqual((open_row["notional_usd"], open_row["leverage"], open_row["margin_usd"]), ("1000", "5", "200"))
        self.assertAlmostEqual(float(D(open_row["qty"]) * D(open_row["entry_px"])), 1000.0, places=6)
        env.policy.position = "CERRAR"
        env.advance(30)
        row = env.rows("SELECT * FROM trades WHERE status='closed'")[0]
        self.assertEqual(len(env.rows("SELECT DISTINCT product FROM decisions")), 1)
        position = qt.Position(side=row["side"], entry_ms=row["entry_ms"], entry_px=D(row["entry_px"]), qty=D(row["qty"]))
        close = next(float(c["close"]) for c in env.candles["PF_XBTUSD"] if c["bucket_start"] + BAR == row["exit_ms"])
        want = qt.settle("PF_XBTUSD", position, close, "strategy_exit", row["exit_ms"], qt.FundingLine(rows), D(1000))
        self.assertEqual(D(row["net_usd"]), want["net_usd"])
        self.assertEqual(D(row["fees_usd"]), want["fees_usd"])
        self.assertEqual(D(row["funding_usd"]), want["funding_usd"])
        self.assertEqual(D(row["fees_usd"]), (D(row["entry_px"]) + want["exit_px"]) * D(row["qty"]) * D("0.0005"))
        self.assertIn("tamaño fijo de 1000 USD", env.rows("SELECT state_text FROM decisions")[0]["state_text"])


class ResilienceTests(unittest.TestCase):
    def test_the_model_falls_and_comes_back_the_process_stays_alive_and_resumes(self):
        clock = [0.0]
        provider = llm.FakeProvider(entries=Policy(), healthy=True)
        env = make(self, provider=provider, clock=lambda: clock[0])
        env.op.start()
        env.advance(30)
        before = len(env.rows("SELECT * FROM decisions WHERE product='PF_XBTUSD'"))
        self.assertGreater(before, 0)
        provider.healthy = False
        for _ in range(8):                                                   # llama-server restarting: 40 minutes
            clock[0] += 300
            env.advance(5)
        env.advance(5)
        self.assertFalse(env.store.meta()["model_ok"])
        self.assertGreater(env.store.meta()["heartbeat_ms"], 0)               # still alive while the model is out
        skipped = env.rows("SELECT reason FROM skipped WHERE product='PF_XBTUSD'")
        self.assertTrue(skipped and {r["reason"] for r in skipped} == {"modelo_caido"})
        down_lines = [m for m in env.logs if "el modelo local no responde" in m]
        self.assertEqual(len(down_lines), 1)                                  # one line per change, not one per poll
        provider.healthy = True
        clock[0] += 300
        env.advance(30)
        self.assertTrue(env.store.meta()["model_ok"])
        self.assertEqual(len([m for m in env.logs if "volvió a responder" in m]), 1)
        after = len(env.rows("SELECT * FROM decisions WHERE product='PF_XBTUSD'"))
        self.assertGreater(after, before)                                     # decisions resume
        keys = env.rows("SELECT product, bucket_ms FROM decisions")
        self.assertEqual(len(keys), len({(k["product"], k["bucket_ms"]) for k in keys}))   # nothing duplicated
        self.assertEqual(env.rows("SELECT * FROM errors"), [])                # a model outage is not an unexpected error

    def test_an_exception_in_a_cycle_is_recorded_and_the_loop_goes_on(self):
        env = make(self)
        env.op.start()
        env.advance(15)
        real_bars = env.feed.bars
        state = {"boom": 2}

        def flaky(product, from_ms, to_ms):
            if state["boom"] > 0:
                state["boom"] -= 1
                raise RuntimeError("Kraken se cayó a mitad de camino")
            return real_bars(product, from_ms, to_ms)
        env.feed.bars = flaky
        env.advance(30)                                                        # polls that explode do not raise
        errors = env.rows("SELECT * FROM errors")
        self.assertTrue(errors)
        self.assertEqual(errors[0]["place"], "ciclo")
        self.assertIn("Kraken se cayó", errors[0]["detail"])
        self.assertGreater(env.store.meta()["last_error_ms"], 0)
        self.assertEqual(len([m for m in env.logs if "Kraken se cayó" in m]), 2)   # one per product, not one per poll
        env.advance(30)                                                        # it came back by itself
        self.assertTrue(any("volvió a andar" in m for m in env.logs))
        keys = env.rows("SELECT product, bucket_ms FROM decisions")
        self.assertEqual(len(keys), len({(k["product"], k["bucket_ms"]) for k in keys}))
        self.assertEqual(max(r["t_ms"] for r in env.rows("SELECT t_ms FROM decisions")), env.now[0] - (env.now[0] % live.BUCKET_MS))

    def test_a_write_that_fails_rebuilds_the_product_from_the_database_without_duplicates_or_lost_trades(self):
        env = make(self, policy=Policy(flat="LARGO"))
        env.op.start()
        real_put = env.store.put_decision
        state = {"boom": True}

        def busy(*args, **kwargs):
            if state["boom"]:
                state["boom"] = False
                raise sqlite3.OperationalError("database is locked")
            return real_put(*args, **kwargs)
        env.store.put_decision = busy
        env.advance(60)
        self.assertEqual(env.rows("SELECT place, kind FROM errors")[0]["kind"], "OperationalError")
        trades = env.rows("SELECT product, trade_no, status FROM trades")
        self.assertEqual(len(trades), len({(t["product"], t["trade_no"]) for t in trades}))
        for product in PRODUCTS:
            decisions = env.rows("SELECT bucket_ms FROM decisions WHERE product=?", product)
            self.assertEqual(len(decisions), len({d["bucket_ms"] for d in decisions}))
        self.assertTrue(env.rows("SELECT * FROM decisions"))                   # it kept deciding afterwards

    def test_a_public_feed_that_is_down_at_start_does_not_end_the_process(self):
        env = make(self)
        real_bars = env.feed.bars
        env.feed.bars = lambda *a: (_ for _ in ()).throw(OSError("sin red"))
        env.op.start()                                                          # does not raise
        self.assertEqual(env.op.traders, {})
        self.assertTrue(env.rows("SELECT * FROM errors"))
        env.feed.bars = real_bars
        env.advance(15)
        self.assertEqual(set(env.op.traders), set(env.cfg["products"]))
        self.assertTrue(any("volvió a andar" in m for m in env.logs))

    def test_run_survives_failing_cycles_with_a_bounded_backoff_and_ends_only_by_signal(self):
        env = make(self)
        calls, sleeps = [], []

        def poll():
            calls.append(1)
            raise RuntimeError("explota siempre")
        env.op.poll = poll
        live.run(env.op, sleep=sleeps.append, max_polls=9)
        self.assertEqual(len(calls), 9)
        self.assertTrue(all(s <= 60 for s in sleeps))
        self.assertEqual(sleeps[0], min(60.0, env.op.poll_s * 2))
        self.assertEqual(sleeps, sorted(sleeps))                               # grows, then stays at the cap
        stopper = []
        env2 = make(self)
        live.run(env2.op, stop=lambda: bool(stopper) or stopper.append(1), sleep=lambda s: None)   # stops by signal
        self.assertTrue(env2.op.ready)

    def test_a_database_of_another_config_still_ends_the_process(self):
        env = make(self)
        env.store.set_meta("config_hash", "otra")
        with self.assertRaises(qt.TraderError):
            live.run(env.op, sleep=lambda s: None, max_polls=1)


V7_CFG = qt.load_config(qt.CONFIG_PATH_LIVE_V7)      # the window lived in versions 4 to 7; version 8 turns it off (``force_window_h`` 0)


class OpportunityWindowTests(unittest.TestCase):
    """Fran's rule: at least one trade a day, but choosing the moment. After ``force_side_after_h`` without opening, a window
    opens: every 15 min wake asks LARGO / CORTO on the real numbers and on the mirror and enters only on a record candidate.
    Tested on the frozen version 7 config (the live version 8 has no window)."""

    def window_env(self, plan, delay=0, window_h=12, min_looks=6, db=None, min_score=0.0, neutral=0.05, tol=0.0):
        """One product (the prompts of the fake model are counted in order). ``plan(look, mirrored)`` is p(LARGO) of that
        question; both option orders get the same answer, so the mean is that number. Looks are 0-based."""
        cfg = live.apply_overrides(V7_CFG, {"QWEN_LIVE_FORCE_SIDE_AFTER_H": str(delay), "QWEN_LIVE_PRODUCTS": "PF_XBTUSD"})
        legacy_letters(cfg)
        cfg["live"]["force_window_h"], cfg["live"]["force_min_looks"] = window_h, min_looks
        cfg["live"]["force_min_score"], cfg["live"]["force_neutral_lean"] = min_score, neutral
        cfg["live"]["force_record_tol"] = tol
        cfg["runtime"]["concurrent_orders"] = False                 # deterministic prompt order
        state = {"n": 0}

        def entries(prompt, letters):
            if "elegir un lado" not in prompt:
                return Policy("ESPERAR")(prompt, letters)
            look, mirrored = divmod(state["n"] // 2, 2)               # real x2 orders, mirror x2 orders, per look
            if state["n"] % 4 == 0:
                state["look"] = state["n"] // 4
            state["n"] += 1
            p = plan(state["n"] // 4 if False else (state["n"] - 1) // 4, bool(mirrored))
            letter = re.search(r"^([A-Z])\) LARGO", prompt, re.M).group(1)
            other = [x for x in letters if x != letter][0]
            return [{"token": letter, "logprob": math.log(p)}, {"token": other, "logprob": math.log(1 - p)}]

        return make(self, cfg=cfg, provider=llm.FakeProvider(entries=entries), db=db)

    def looks(self, env):
        return env.rows("SELECT * FROM decisions WHERE override IN ('ventana_mirando','entrada_ventana') ORDER BY t_ms")

    @staticmethod
    def candidate(score):
        """p(real), p(mirror) of a candidate with this score: lean = score, lean_m = -score."""
        return (1 + score) / 2, (1 - score) / 2

    def test_it_is_off_for_the_practice_and_the_old_configs(self):
        for path in (qt.CONFIG_PATH_V3, qt.CONFIG_PATH_V2):
            self.assertNotIn("force_question", qt.load_config(path).get("live", {}))
        live_cfg = LIVE_CFG["live"]
        self.assertEqual((live_cfg["force_side_after_h"], live_cfg["force_window_h"], live_cfg["force_min_looks"]), (0, 0, 6))   # v8: off
        self.assertEqual([o["id"] for o in live_cfg["force_question"]["options"]], ["LARGO", "CORTO"])

    def test_it_does_not_enter_before_the_minimum_looks_even_with_a_perfect_candidate(self):
        def plan(look, mirrored):
            real, mirror = self.candidate(min(0.9, 0.3 + 0.05 * look))   # every look is a new record
            return mirror if mirrored else real
        env = self.window_env(plan, min_looks=6)
        env.op.start()
        self.assertEqual(self.looks(env), [])                          # nothing is asked before the first 15 min wake
        env.advance(6 * 15)                                            # 6 looks: the window starts at the very first wake
        looks = self.looks(env)
        self.assertEqual([r["look_n"] for r in looks], [1, 2, 3, 4, 5, 6])
        self.assertEqual({r["override"] for r in looks}, {"ventana_mirando"})
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertTrue(all(r["action"] == "ESPERAR" and r["mirror_ok"] == 1 for r in looks))
        env.advance(15)                                                # look 7: at least 6 looks came before and it is a record
        entry = self.looks(env)[-1]
        self.assertEqual((entry["look_n"], entry["override"], entry["reason"]), (7, "entrada_ventana", "entrada_ventana"))
        self.assertEqual(entry["action"], "LARGO")
        self.assertAlmostEqual(entry["score"], entry["best_score"])
        trade = env.rows("SELECT * FROM trades")[0]
        self.assertEqual((trade["entry_reason"], trade["side"], trade["status"]), ("ventana", "LONG", "open"))
        self.assertGreater(entry["lean"], 0)
        self.assertLess(entry["lean_m"], 0)
        self.assertAlmostEqual(entry["lean_num"], (entry["lean"] - entry["lean_m"]) / 2)
        # with a position open the window is closed: only position questions from here
        env.advance(60)
        self.assertEqual(len(self.looks(env)), 7)

    def test_it_waits_for_a_record_and_says_how_it_stands(self):
        scores = [0.50, 0.10, 0.10, 0.10, 0.10, 0.10, 0.30, 0.60]      # the early 0.50 (a candidate) is the record to beat; 0.10 and 0.30 are candidates but no record

        def plan(look, mirrored):
            real, mirror = self.candidate(scores[min(look, len(scores) - 1)])
            return mirror if mirrored else real
        env = self.window_env(plan, min_looks=3)
        env.op.start()
        env.advance(8 * 15)
        looks = self.looks(env)
        self.assertEqual([r["override"] for r in looks[:7]], ["ventana_mirando"] * 7)
        self.assertEqual((looks[7]["look_n"], looks[7]["override"]), (8, "entrada_ventana"))
        weak = looks[6]
        self.assertAlmostEqual(weak["score"], 0.30)
        self.assertAlmostEqual(weak["best_score"], 0.50)                # "mejor hasta ahora"
        self.assertEqual(weak["mirror_ok"], 1)                          # a candidate, but not a record: waits
        self.assertEqual(len(env.rows("SELECT * FROM trades")), 1)

    def test_a_neutral_real_lean_with_a_sure_mirror_is_a_short_candidate(self):
        """Datos reales de la base: con el estado real 50/50 (lean +0,001 / +0,003 / ruido negativo) y con el espejado LARGO casi seguro."""
        reals = [0.5005, 0.5015, 0.4990, 0.5010, 0.4995, 0.5008, 0.5012, 0.5003]   # lean = 2p - 1: +0,001, +0,003, -0,002...
        mirrors = [0.945, 0.97, 0.995, 1.0 - 1e-9, 0.99, 0.95, 0.98, 0.945]          # lean_m 0,89 a 1,0

        def plan(look, mirrored):
            return mirrors[min(look, 7)] if mirrored else reals[min(look, 7)]
        env = self.window_env(plan, min_looks=3, min_score=0.15)
        env.op.start()
        env.advance(4 * 15)
        looks = self.looks(env)
        self.assertGreaterEqual(len(looks), 4)
        for r in looks:
            self.assertEqual(r["mirror_ok"], 1)                           # candidates although the real lean is noise
            self.assertLess(r["lean_num"], 0)                              # side CORTO
            self.assertGreater(r["score"], 0.4)
        entry = looks[-1]
        self.assertEqual((entry["override"], entry["look_n"]), ("entrada_ventana", 4))
        self.assertEqual(env.rows("SELECT side FROM trades")[0]["side"], "SHORT")

    def test_a_neutral_mirror_with_an_extreme_real_is_a_long_candidate_that_enters_after_the_minimum_looks(self):
        """Datos reales: real LARGO casi seguro (lean ~1,0) y espejo neutro (lean_m +0,003 a +0,045)."""
        mirrors = [0.5075, 0.5015, 0.5225, 0.5075, 0.5, 0.5125, 0.5075, 0.5075]    # lean_m = 2p - 1: +0,015, +0,003, +0,045...

        def plan(look, mirrored):
            return mirrors[min(look, 7)] if mirrored else 1.0 - 1e-9
        env = self.window_env(plan, min_looks=6, min_score=0.15, tol=0.03)
        env.op.start()
        env.advance(7 * 15)
        looks = self.looks(env)
        self.assertEqual([r["mirror_ok"] for r in looks[:6]], [1] * 6)       # candidates although lean * lean_m > 0 by noise
        self.assertTrue(all(r["lean_num"] > 0.45 for r in looks))              # side LARGO, score near 0,5
        self.assertEqual([r["override"] for r in looks[:6]], ["ventana_mirando"] * 6)   # not before 6 looks
        self.assertEqual((looks[6]["override"], looks[6]["look_n"]), ("entrada_ventana", 7))
        self.assertEqual(env.rows("SELECT side FROM trades")[0]["side"], "LONG")

    def test_two_extreme_leans_of_the_same_side_are_a_habit_not_a_candidate(self):
        env = self.window_env(lambda look, mirrored: 1.0 - 1e-9, min_looks=1, min_score=0.0, tol=0.03)
        env.op.start()
        env.advance(4 * 15)
        looks = self.looks(env)
        self.assertEqual({r["mirror_ok"] for r in looks}, {0})
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        env = self.window_env(lambda look, mirrored: 0.5, min_looks=1, min_score=0.15, tol=0.03)   # both neutral: no score
        env.op.start()
        env.advance(3 * 15)
        self.assertEqual({r["mirror_ok"] for r in self.looks(env)}, {0})

    def test_a_tie_or_a_score_within_the_tolerance_of_the_best_enters(self):
        scores = [0.465, 0.30, 0.30, 0.465, 0.45]            # the 4th look ties the best, the others are far or inside the tolerance

        def plan(look, mirrored):
            real, mirror = self.candidate(scores[min(look, 4)])
            return mirror if mirrored else real
        env = self.window_env(plan, min_looks=3, tol=0.03)
        env.op.start()
        env.advance(4 * 15)
        looks = self.looks(env)
        self.assertEqual([r["override"] for r in looks], ["ventana_mirando"] * 3 + ["entrada_ventana"])
        env = self.window_env(plan, min_looks=3, tol=0.0)     # with no tolerance the tie also enters (>=), a lower score does not
        env.op.start()
        env.advance(5 * 15)
        self.assertEqual(self.looks(env)[3]["override"], "entrada_ventana")
        lower = self.window_env(lambda look, m: (self.candidate([0.5, 0.3, 0.3, 0.3, 0.3][min(look, 4)])[1 if m else 0]),
                                min_looks=3, tol=0.03)
        lower.op.start()
        lower.advance(5 * 15)
        self.assertEqual({r["override"] for r in self.looks(lower)}, {"ventana_mirando"})
        cfg = live.apply_overrides(LIVE_CFG, {"QWEN_LIVE_FORCE_RECORD_TOL": "0.1"})
        self.assertEqual(cfg["live"]["force_record_tol"], 0.1)
        self.assertEqual(LIVE_CFG["live"]["force_record_tol"], 0.03)
        with self.assertRaises(qt.TraderError):
            live.apply_overrides(LIVE_CFG, {"QWEN_LIVE_FORCE_RECORD_TOL": "-0.1"})

    def test_the_real_lean_counts_as_a_side_only_from_the_neutral_threshold(self):
        def plan_for(p_real):
            return lambda look, mirrored: 0.95 if mirrored else p_real
        for p_real, ok in ((0.52, 1), (0.53, 0)):                          # lean 0,04 neutral; lean 0,06 repeats the mirror's side
            env = self.window_env(plan_for(p_real), min_looks=1, min_score=0.15)
            env.op.start()
            env.advance(15)
            self.assertEqual([r["mirror_ok"] for r in self.looks(env)], [ok], p_real)

    def test_a_candidate_needs_the_minimum_score(self):
        def plan(look, mirrored):
            real, mirror = self.candidate(0.10)                            # contradicts, but a score of only 0,10
            return mirror if mirrored else real
        env = self.window_env(plan, min_looks=1, min_score=0.15)
        env.op.start()
        env.advance(4 * 15)
        looks = self.looks(env)
        self.assertEqual({r["mirror_ok"] for r in looks}, {0})
        self.assertEqual({r["override"] for r in looks}, {"ventana_mirando"})
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        cfg = live.apply_overrides(LIVE_CFG, {"QWEN_LIVE_FORCE_NEUTRAL_LEAN": "0.1", "QWEN_LIVE_FORCE_MIN_SCORE": "0.3"})
        self.assertEqual((cfg["live"]["force_neutral_lean"], cfg["live"]["force_min_score"]), (0.1, 0.3))
        self.assertEqual((LIVE_CFG["live"]["force_neutral_lean"], LIVE_CFG["live"]["force_min_score"]), (0.05, 0.15))
        for name in ("QWEN_LIVE_FORCE_NEUTRAL_LEAN", "QWEN_LIVE_FORCE_MIN_SCORE"):
            with self.assertRaises(qt.TraderError):
                live.apply_overrides(LIVE_CFG, {name: "-1"})

    def test_a_non_candidate_score_is_recorded_but_does_not_raise_the_bar(self):
        scores = [None, 0.10, 0.12, 0.14]                 # look 1: high score but the mirror does not contradict

        def plan(look, mirrored):
            if scores[min(look, 3)] is None:
                return 0.7 if mirrored else 0.95          # real LARGO, mirror also LARGO: not a candidate
            real, mirror = self.candidate(scores[min(look, 3)])
            return mirror if mirrored else real
        env = self.window_env(plan, min_looks=3)
        env.op.start()
        env.advance(4 * 15)
        looks = self.looks(env)
        self.assertEqual(looks[0]["mirror_ok"], 0)
        self.assertGreater(looks[0]["score"], 0.14)       # recorded...
        self.assertAlmostEqual(looks[0]["best_score"], 0.0)   # ...but it does not count as the best
        self.assertAlmostEqual(looks[1]["best_score"], 0.10)
        self.assertEqual((looks[3]["look_n"], looks[3]["override"]), (4, "entrada_ventana"))   # 0.14 is the record among candidates

    def test_a_contradicting_mirror_never_enters_even_as_a_record_and_even_after_the_window(self):
        def plan(look, mirrored):
            return 0.7 if mirrored else 0.95              # real LARGO, mirror ALSO LARGO: the answer is not from the numbers

        env = self.window_env(plan, window_h=2, min_looks=2)
        env.op.start()
        env.advance(5 * 60)                           # 5 h into the window, far past window_h
        looks = self.looks(env)
        self.assertGreater(len(looks), 12)
        self.assertEqual({r["override"] for r in looks}, {"ventana_mirando"})
        self.assertEqual({r["mirror_ok"] for r in looks}, {0})
        self.assertGreater(looks[0]["score"], 0)           # its score is high: only the mirror stops it
        self.assertEqual(env.rows("SELECT * FROM trades"), [])

    def test_after_the_window_hours_it_enters_at_the_first_candidate_without_a_record(self):
        def plan(look, mirrored):
            if look == 0:
                real, mirror = self.candidate(0.8)                         # a record, but too early
            elif look == 8:
                real, mirror = self.candidate(0.1)                         # weak candidate, window of 2 h is over
            else:
                real, mirror = 0.7, 0.7                                    # no candidate
            return mirror if mirrored else real
        env = self.window_env(plan, window_h=2, min_looks=100)
        env.op.start()
        env.advance(9 * 15)
        looks = self.looks(env)
        self.assertEqual([r["override"] for r in looks[:8]], ["ventana_mirando"] * 8)
        self.assertEqual((looks[8]["look_n"], looks[8]["override"]), (9, "entrada_ventana"))
        self.assertAlmostEqual(looks[8]["score"], 0.1)
        self.assertAlmostEqual(looks[8]["best_score"], 0.8)                # not a record, entered anyway

    def test_a_short_when_the_numbers_say_down(self):
        def plan(look, mirrored):
            real, mirror = self.candidate(0.4)
            return (real if mirrored else mirror)                          # real: CORTO, mirror: LARGO
        env = self.window_env(plan, min_looks=0)
        env.op.start()
        env.advance(30)
        entry = next(r for r in self.looks(env) if r["override"] == "entrada_ventana")
        self.assertEqual(entry["action"], "CORTO")
        self.assertLess(entry["lean_num"], 0)
        self.assertEqual(env.rows("SELECT side FROM trades")[0]["side"], "SHORT")

    def test_opening_a_position_closes_the_window_and_the_next_one_starts_from_zero(self):
        def plan(look, mirrored):
            real, mirror = self.candidate(0.2 + 0.01 * look)
            return mirror if mirrored else real
        env = self.window_env(plan, min_looks=2)
        env.op.start()
        env.advance(3 * 15)                                           # window 1: three looks, enters at the third
        first = [r for r in self.looks(env)]
        self.assertEqual(first[-1]["override"], "entrada_ventana")
        env.advance(4 * 60 + 15 * 5)                                       # closes by time at 4 h, cooldown, window 2
        looks = self.looks(env)
        second = [r for r in looks if r["t_ms"] > first[-1]["t_ms"]]
        self.assertTrue(second)
        self.assertEqual(second[0]["look_n"], 1)                          # the counter restarted
        self.assertAlmostEqual(second[0]["best_score"], second[0]["score"])   # and so did the best score
        self.assertGreaterEqual(second[0]["t_ms"] - env.rows("SELECT exit_ms FROM trades")[0]["exit_ms"], 15 * MIN)

    def test_the_window_is_always_on_and_the_flat_question_with_wait_is_gone(self):
        env = self.window_env(lambda look, mirrored: 0.5 + (0.01 if not mirrored else -0.01), min_looks=100)
        env.op.start()
        env.advance(45)
        rows = env.rows("SELECT action, override, probs_json FROM decisions ORDER BY t_ms")
        self.assertEqual([r["override"] for r in rows], ["ventana_mirando"] * 3)
        self.assertTrue(all(set(json.loads(r["probs_json"])) == {"LARGO", "CORTO"} for r in rows))   # no ESPERAR option
        self.assertFalse(any("No tenés ninguna posición" in p for p in env.provider.prompts))

    def test_the_start_delay_is_optional(self):
        env = self.window_env(lambda look, mirrored: 0.5, delay=1)
        env.op.start()
        env.advance(60)
        self.assertEqual(self.looks(env), [])                          # the first hour: the normal flat question
        self.assertTrue(any("No tenés ninguna posición" in p for p in env.provider.prompts))
        env.advance(30)
        self.assertTrue(self.looks(env))

    def test_zero_window_turns_it_off(self):
        env = self.window_env(lambda look, mirrored: 0.9, window_h=0)
        env.op.start()
        env.advance(10 * 60)
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertEqual(self.looks(env), [])
        self.assertFalse(any("elegir un lado" in p for p in env.provider.prompts))
        for bad in ("-1", "mucho"):
            for name in ("QWEN_LIVE_FORCE_SIDE_AFTER_H", "QWEN_LIVE_FORCE_WINDOW_H", "QWEN_LIVE_FORCE_MIN_LOOKS"):
                with self.assertRaises(qt.TraderError):
                    live.apply_overrides(LIVE_CFG, {name: bad})
        cfg = live.apply_overrides(LIVE_CFG, {"QWEN_LIVE_FORCE_WINDOW_H": "6", "QWEN_LIVE_FORCE_MIN_LOOKS": "3"})
        self.assertEqual((cfg["live"]["force_window_h"], cfg["live"]["force_min_looks"]), (6, 3))

    def test_the_window_survives_a_restart(self):
        def plan(look, mirrored):
            real, mirror = self.candidate(0.3)
            return mirror if mirrored else real
        env = self.window_env(plan, min_looks=10)
        env.op.start()
        env.advance(3 * 15)
        before = self.looks(env)[-1]
        self.assertEqual(before["look_n"], 3)
        op = env.restart()
        op.start()
        self.assertEqual(op.traders["PF_XBTUSD"].window["looks"], 3)
        env.advance(15)
        self.assertEqual(self.looks(env)[-1]["look_n"], 4)

    def test_a_base_written_before_the_window_is_still_valid_and_gets_the_new_columns(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "live.sqlite")
        old = sqlite3.connect(path)
        old.executescript("""
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE decisions(product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL,
          decided_at_ms INTEGER NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL, model_action TEXT, p_action REAL,
          confidence REAL, probs_json TEXT, orders_json TEXT, override TEXT, reason TEXT, reason_json TEXT,
          mirror_action TEXT, mirror_p REAL, wake_json TEXT, state_text TEXT, state_hash TEXT, latency_ms INTEGER,
          threshold REAL, prompt_version TEXT, prompt_hash TEXT, model TEXT, config_hash TEXT, position_json TEXT,
          net_bp_now REAL, trade_no INTEGER, PRIMARY KEY(product, bucket_ms));
        CREATE TABLE trader_state(product TEXT PRIMARY KEY, last_fed_ms INTEGER, trade_seq INTEGER NOT NULL,
          cooldown_until INTEGER NOT NULL, last_call_ms INTEGER, position_json TEXT, updated_ms INTEGER NOT NULL);
        INSERT INTO decisions VALUES('PF_XBTUSD', 0, 900000, 1, 'flat', 'ESPERAR', 'ESPERAR', 0.99, 0.9, '{}', '[{}]', NULL,
          NULL, NULL, NULL, NULL, '[]', 'x', 'h', 5, 0.5, '4', 'ph', 'm', 'c', NULL, NULL, NULL);
        INSERT INTO trader_state VALUES('PF_XBTUSD', 300000, 1, 0, NULL, NULL, 1);
        """)
        old.commit()
        old.close()
        store = live.LiveStore(path)                         # opens for writing: columns appended, nothing lost
        self.addCleanup(store.close)
        columns = {r[1] for r in store.db.execute("PRAGMA table_info(decisions)")}
        self.assertTrue({"lean", "lean_m", "lean_num", "score", "best_score", "look_n", "mirror_ok"} <= columns)
        self.assertIn("window_json", {r[1] for r in store.db.execute("PRAGMA table_info(trader_state)")})
        self.assertEqual(store.db.execute("SELECT action, lean FROM decisions").fetchone()[:], ("ESPERAR", None))
        self.assertEqual(store.load_state("PF_XBTUSD")["window_json"], None)
        live.LiveStore(path).close()                          # a second open is harmless
        # the section lives outside config_hash; the pinned hash moved on purpose with version 6 (question without example, F5 out)
        # and again with version 7 (the LoRA adapter, ``lora``, is part of the identity: the version 6 base archives itself)
        cfg = copy.deepcopy(LIVE_CFG)
        for key in ("force_window_h", "force_min_looks", "force_side_after_h", "force_question"):
            cfg["live"].pop(key)
        self.assertEqual(qt.config_hash(cfg), qt.config_hash(LIVE_CFG))
        self.assertEqual(qt.config_hash(V7_CFG), "fab41b5d5b6475553e7cd2e1e14766d00281b0abe80d3c6f1a07b0db0e8b821d")   # v7, frozen


class LockTests(unittest.TestCase):
    def test_a_second_process_on_the_same_base_is_refused_with_a_clear_message(self):
        tmp = tempfile.mkdtemp()
        db = os.path.join(tmp, "live.sqlite")
        with live.ProcessLock(db):
            with self.assertRaises(live.LockError) as caught:
                live.ProcessLock(db).acquire()
            message = str(caught.exception)
            self.assertIn("ya está escribiendo", message)
            self.assertIn("QWEN_LIVE_DB", message)
            self.assertIn(str(os.getpid()), message)
            # a real second process: exits with 2 and prints the same thing, before touching the model or the base
            env = dict(os.environ, PYTHONPATH=os.pathsep.join(
                [os.path.join(qt.ROOT, "python"), os.environ.get("PYTHONPATH", "")]))
            done = subprocess.run([sys.executable, "-m", "balancita_engine.futures_qwen_live", "--db", db],
                                  capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
            self.assertIn("ya está escribiendo", done.stderr)
        self.assertFalse(os.path.exists(db))                      # the refused process created no database
        with live.ProcessLock(db):                                # released: a new one can take it
            pass

    def test_the_lock_is_per_base(self):
        tmp = tempfile.mkdtemp()
        with live.ProcessLock(os.path.join(tmp, "a.sqlite")), live.ProcessLock(os.path.join(tmp, "b.sqlite")):
            pass


class AccountingTests(unittest.TestCase):
    def funding_rows(self, rate=2e-5):
        return [(BASE - 10 * DAY + i * qt.HOUR_MS, rate) for i in range(0, 10 * 24 + 40)]

    def closed(self, env, product="PF_XBTUSD"):
        env.op.start()
        env.advance(30)                                    # opens
        env.policy.position = "CERRAR"
        env.advance(30)                                    # closes
        rows = env.rows("SELECT * FROM trades WHERE product=? AND status='closed'", product)
        self.assertEqual(len(rows), 1)
        return rows[0]

    def settle_again(self, env, row, funding):
        position = qt.Position(side=row["side"], entry_ms=row["entry_ms"], entry_px=D(row["entry_px"]), qty=D(row["qty"]))
        close = next(float(c["close"]) for c in env.candles["PF_XBTUSD"] if c["bucket_start"] + BAR == row["exit_ms"])
        return qt.settle("PF_XBTUSD", position, close, "strategy_exit", row["exit_ms"], funding, D(100))

    def test_costs_funding_and_net_are_exactly_what_settle_says(self):
        rows = self.funding_rows()
        env = make(self, policy=Policy(flat="LARGO"), funding=rows)
        row = self.closed(env)
        self.assertEqual(row["closed_by"], "qwen")
        self.assertEqual(row["funding_status"], "complete")
        want = self.settle_again(env, row, qt.FundingLine(rows))
        self.assertEqual(D(row["net_usd"]), want["net_usd"])
        self.assertEqual(D(row["gross_usd"]), want["gross_usd"])
        self.assertEqual(D(row["fees_usd"]), want["fees_usd"])
        self.assertEqual(D(row["funding_usd"]), want["funding_usd"])
        self.assertEqual(row["net_bp"], want["net_bp"])
        self.assertEqual(D(row["exit_px"]), D(repr(float(want["exit_px"]))))
        # the pieces add up, with Kraken's taker fee on both legs (0,05 %)
        self.assertEqual(D(row["net_usd"]), D(row["gross_usd"]) - D(row["fees_usd"]) - D(row["funding_usd"]))
        fee = (D(row["entry_px"]) + want["exit_px"]) * D(row["qty"]) * D("0.0005")
        self.assertEqual(D(row["fees_usd"]), fee)
        self.assertNotEqual(D(row["funding_usd"]), 0)

    def test_a_short_pays_the_opposite_funding(self):
        rows = self.funding_rows()
        env = make(self, policy=Policy(flat="CORTO"), funding=rows)
        row = self.closed(env)
        self.assertEqual(row["side"], "SHORT")
        want = self.settle_again(env, row, qt.FundingLine(rows))
        self.assertEqual(D(row["net_usd"]), want["net_usd"])
        self.assertLess(D(row["funding_usd"]), 0)               # positive rate: the short receives

    def test_funding_published_later_settles_the_trade_again_with_the_same_formula(self):
        env = make(self, policy=Policy(flat="LARGO"), funding=())
        row = self.closed(env)
        self.assertEqual(row["funding_status"], "unknown")      # not zero: unknown, and said so
        self.assertEqual(D(row["funding_usd"]), 0)
        rows = self.funding_rows(5e-5)
        env.feed.funding_rows = rows
        env.now[0] += 31 * MIN                                   # the refresh interval passed
        env.op.poll()
        done = env.rows("SELECT * FROM trades WHERE trade_no=? AND product='PF_XBTUSD'", row["trade_no"])[0]
        self.assertEqual(done["funding_status"], "complete")
        want = self.settle_again(env, done, qt.FundingLine(rows))
        self.assertEqual(D(done["net_usd"]), want["net_usd"])
        self.assertEqual(D(done["funding_usd"]), want["funding_usd"])
        self.assertNotEqual(done["net_usd"], row["net_usd"])

    def test_the_open_position_shows_its_result_if_closed_now(self):
        env = make(self, policy=Policy(flat="LARGO"))
        env.op.start()
        env.advance(30)
        trader = env.op.traders["PF_XBTUSD"]
        row = env.rows("SELECT * FROM trades WHERE product='PF_XBTUSD'")[0]
        want = qt.settle("PF_XBTUSD", trader.position, trader.c[-1], "strategy_exit", row["mark_ms"], trader.funding, D(100))
        self.assertEqual(row["status"], "open")
        self.assertEqual(D(row["net_now_usd"]), want["net_usd"])
        self.assertEqual(row["mark_px"], trader.c[-1])
        self.assertIsNone(row["exit_ms"])


class LearningDataTests(unittest.TestCase):
    def test_every_decision_is_exported_in_the_practice_format(self):
        cfg = copy.deepcopy(LIVE_CFG)
        cfg["guardrails"]["max_hold_min"] = 240               # a 4 h limit here, so the trade closes inside the test's 5 h
        env = make(self, cfg=cfg, policy=Policy(flat="LARGO"))
        env.op.start()
        env.advance(5 * 60)
        out = os.path.join(env.tmp, "datos.jsonl")
        count = live.export_dataset(env.db_path, out)
        lines = [json.loads(x) for x in open(out, encoding="utf-8")]
        self.assertEqual(count, len(lines))
        self.assertEqual(count, len(env.rows("SELECT * FROM decisions")))
        practice_keys = {"schema", "source", "fold", "block_id", "seq", "product", "t_ms", "kind", "state_text",
                         "state_hash", "wake", "orders", "probabilities", "confidence", "model_action", "action",
                         "p_action", "entry_threshold", "guardrail", "reason", "reason_probabilities", "position",
                         "net_bp_now", "exit_labels", "outcome", "trade", "prompt_version", "prompt_hash", "model",
                         "config_hash", "latency_ms"}
        self.assertTrue(practice_keys <= set(lines[0]))
        self.assertTrue(all(x["schema"] == qt.DATASET_SCHEMA and x["source"] == "live" for x in lines))
        self.assertTrue(all(x["state_text"] and x["probabilities"] and x["orders"] for x in lines))
        entry = next(x for x in lines if x["kind"] == "flat" and x["action"] == "LARGO")
        self.assertEqual(entry["trade"]["closed_by"], "tiempo")
        self.assertEqual(entry["outcome"]["type"], "entry")


class StoreTests(unittest.TestCase):
    def test_decisions_keep_what_the_terminal_and_the_retraining_need(self):
        env = make(self, policy=Policy(flat="LARGO"))
        env.op.start()
        env.advance(30)
        row = env.rows("SELECT * FROM decisions WHERE product='PF_XBTUSD' ORDER BY t_ms")[0]
        for column in ("product", "bucket_ms", "action", "model_action", "p_action", "confidence", "probs_json", "reason",
                       "latency_ms", "state_text", "wake_json", "prompt_hash", "model", "config_hash"):
            self.assertIn(column, row)
        self.assertEqual(row["action"], "LARGO")
        self.assertAlmostEqual(sum(json.loads(row["probs_json"]).values()), 1.0)
        self.assertEqual(row["model"], "fake-model")
        self.assertTrue(env.rows("SELECT position_json FROM trader_state WHERE product='PF_XBTUSD'")[0]["position_json"])


if __name__ == "__main__":
    unittest.main()
