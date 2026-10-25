"""Qwen operador EN VIVO: todo con proveedor falso, velas inventadas y bases temporales. Sin red, sin modelo."""
import copy
import json
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


class Policy:
    """What the fake model answers: one option per kind of question, by option id."""

    def __init__(self, flat="ESPERAR", position="MANTENER", reason="sin_ventaja", forced="LARGO"):
        self.flat, self.position, self.reason, self.forced = flat, position, reason, forced

    def __call__(self, prompt, letters):
        if "no operás" in prompt:
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
                 provider=None, clock=None):
        self.cfg = copy.deepcopy(cfg or LIVE_CFG)
        self.cfg["mirror"] = mirror
        self.tmp = db or tempfile.mkdtemp()
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
        self.assertEqual(cfg["guardrails"], {"stop_sigma_24h": 1.5, "min_stop_pct": 0.005, "max_stop_pct": 0.03,
                                             "max_hold_min": 240, "cooldown_min": 15})
        self.assertTrue(cfg["mirror"])

    def test_the_prompt_tells_the_truth_about_the_rules(self):
        env = make(self, policy=Policy("LARGO"))
        env.op.start()
        env.advance(60)
        texts = [r["state_text"] for r in env.rows("SELECT state_text FROM decisions WHERE kind='position'")]
        self.assertTrue(texts)
        self.assertIn("stop automatico", texts[0])
        self.assertIn("Distancia al stop automatico", texts[0])
        self.assertNotIn("No hay stop", texts[0])
        question = LIVE_CFG["prompt"]["questions"]["position"]["instruction"]
        self.assertIn("stop automático", question)
        self.assertNotIn("No hay stop", question)


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

    def test_the_time_limit_closes_at_four_hours_and_the_stop_is_inside_its_bounds(self):
        env = make(self, policy=Policy(flat="LARGO"))
        env.op.start()
        env.advance(5 * 60)
        trades = env.rows("SELECT * FROM trades WHERE product='PF_XBTUSD' ORDER BY trade_no")
        self.assertEqual(trades[0]["status"], "closed")
        self.assertEqual(trades[0]["closed_by"], "tiempo")
        self.assertEqual(trades[0]["hold_min"], 240)
        entry = float(trades[0]["entry_px"])
        stop = trades[0]["stop_px"]
        if stop is not None:
            self.assertTrue(0.005 <= abs(stop / entry - 1) <= 0.0305, stop / entry)
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


class ForcedEntryTests(unittest.TestCase):
    """Fran's rule: at least one closed trade a day. After ``force_side_after_h`` without opening, the 15 minute wake asks a
    question with only LARGO and CORTO."""

    def forced_env(self, hours=8, **kwargs):
        cfg = live.apply_overrides(LIVE_CFG, {"QWEN_LIVE_FORCE_SIDE_AFTER_H": str(hours)})
        return make(self, cfg=cfg, **kwargs)

    def test_it_is_off_for_the_practice_and_the_old_configs(self):
        for path in (qt.CONFIG_PATH_V3, qt.CONFIG_PATH_V2):
            self.assertNotIn("force_question", qt.load_config(path).get("live", {}))
        self.assertEqual(LIVE_CFG["live"]["force_side_after_h"], 8)
        self.assertEqual([o["id"] for o in LIVE_CFG["live"]["force_question"]["options"]], ["LARGO", "CORTO"])

    def test_with_a_constant_wait_it_enters_forced_only_after_the_hours_and_once_per_position(self):
        env = self.forced_env(8, policy=Policy(flat="ESPERAR"))
        env.op.start()
        env.advance(8 * 60 - 15)                                  # 7 h 45 min after the start: not yet
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertEqual({r["action"] for r in env.rows("SELECT action FROM decisions")}, {"ESPERAR"})
        self.assertTrue(all(json.loads(r["probs_json"]).keys() == {"LARGO", "CORTO", "ESPERAR"}
                            for r in env.rows("SELECT probs_json FROM decisions")))
        env.advance(30)                                           # past the 8 h
        trades = env.rows("SELECT * FROM trades ORDER BY product")
        self.assertEqual(len(trades), 2)                          # one per product
        forced = env.rows("SELECT * FROM decisions WHERE override='entrada_forzada' AND product='PF_XBTUSD'")
        self.assertEqual(len(forced), 1)
        row = forced[0]
        self.assertEqual((row["reason"], row["kind"]), ("entrada_forzada", "flat"))
        self.assertEqual(set(json.loads(row["probs_json"])), {"LARGO", "CORTO"})      # no ESPERAR option
        self.assertGreater(row["t_ms"] - START, 8 * 3_600_000)
        self.assertTrue(all(t["entry_reason"] == "forzada" and t["status"] == "open" for t in trades))
        self.assertIsNone(row["mirror_action"])                                        # the mirror is skipped
        self.assertIn("Hace 8,", env.provider.prompts[-1] if "Hace" in env.provider.prompts[-1] else
                      next(p for p in env.provider.prompts if "Hace" in p))
        # a position is open: the next wakes are position questions, never another forced entry
        env.advance(60)
        self.assertEqual(len(env.rows("SELECT * FROM decisions WHERE override='entrada_forzada'")), 2)
        self.assertEqual(len(env.rows("SELECT * FROM trades")), 2)

    def test_the_text_is_honest_and_has_only_two_options(self):
        env = self.forced_env(1, policy=Policy(flat="ESPERAR"))
        env.op.start()
        env.advance(90)
        prompt = next(p for p in env.provider.prompts if "no operás" in p)
        self.assertIn("Tenés que elegir un lado para esta exploración en papel; elegí el que creas más probable.", prompt)
        self.assertNotIn("ESPERAR", prompt)
        self.assertEqual(len(re.findall(r"^[A-Z]\) ", prompt, re.M)), 2)

    def test_it_opens_on_the_more_probable_side_by_the_mean_of_both_orders_without_threshold_or_mirror(self):
        def lean(prompt, letters):
            if "no operás" in prompt:
                letter = re.search(r"^([A-Z])\) CORTO", prompt, re.M).group(1)
                other = [x for x in letters if x != letter][0]
                # barely above one half for CORTO: far below the 0.5 + threshold idea, still the side that wins
                return [{"token": letter, "logprob": -0.62}, {"token": other, "logprob": -0.77}]
            return Policy("ESPERAR")(prompt, letters)

        env = self.forced_env(1, provider=llm.FakeProvider(entries=lean), mirror=True)      # mirror ON in the config
        env.op.start()
        env.advance(90)
        trades = env.rows("SELECT * FROM trades")
        self.assertTrue(trades)
        self.assertTrue(all(t["side"] == "SHORT" and t["entry_reason"] == "forzada" for t in trades))
        decision = env.rows("SELECT * FROM decisions WHERE override='entrada_forzada'")[0]
        self.assertEqual(decision["action"], "CORTO")
        self.assertLess(decision["p_action"], 0.7)
        self.assertIsNone(decision["mirror_action"])
        asked = [p for p in env.provider.prompts if "no operás" in p]
        self.assertEqual(len(asked) % 2, 0)                      # two orders, no mirror question

    def test_zero_turns_it_off(self):
        env = self.forced_env(0, policy=Policy(flat="ESPERAR"))
        env.op.start()
        env.advance(10 * 60)
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertEqual(env.rows("SELECT * FROM decisions WHERE override='entrada_forzada'"), [])
        self.assertFalse(any("no operás" in p for p in env.provider.prompts))
        with self.assertRaises(qt.TraderError):
            live.apply_overrides(LIVE_CFG, {"QWEN_LIVE_FORCE_SIDE_AFTER_H": "-1"})
        with self.assertRaises(qt.TraderError):
            live.apply_overrides(LIVE_CFG, {"QWEN_LIVE_FORCE_SIDE_AFTER_H": "mucho"})

    def test_the_cooldown_and_the_open_position_are_respected(self):
        env = self.forced_env(1, policy=Policy(flat="ESPERAR"))
        env.op.start()
        env.advance(7 * 60)
        for product in PRODUCTS:
            trades = env.rows("SELECT * FROM trades WHERE product=? ORDER BY trade_no", product)
            self.assertGreaterEqual(len(trades), 2)
            self.assertEqual(trades[0]["closed_by"], "tiempo")                    # closed by itself at 4 h
            for a, b in zip(trades, trades[1:]):
                self.assertGreaterEqual(b["entry_ms"] - a["exit_ms"], 15 * MIN)  # cooldown
                self.assertGreater(b["entry_ms"], a["exit_ms"])                  # never while a position is open
        # at least one closed trade per product within 7 hours
        self.assertTrue(all(env.rows("SELECT * FROM trades WHERE product=? AND status='closed'", p) for p in PRODUCTS))

    def test_the_idle_time_counts_from_the_last_opening_on_record_and_survives_a_restart(self):
        env = self.forced_env(2, policy=Policy(flat="ESPERAR"))
        env.op.start()
        env.advance(150)
        first = env.rows("SELECT entry_ms FROM trades WHERE product='PF_XBTUSD' ORDER BY trade_no")
        self.assertEqual(len(first), 1)
        op = env.restart()
        op.start()                                                  # a new process: the reference is the opening in the base
        self.assertEqual(op.traders["PF_XBTUSD"].last_open_ms, first[0]["entry_ms"])
        env.advance(60)
        self.assertEqual(len(env.rows("SELECT * FROM trades WHERE product='PF_XBTUSD'")), 1)   # still open or cooling down

    def test_the_existing_live_base_is_still_accepted(self):
        env = make(self, mirror=True)
        env.op.start()
        cfg = copy.deepcopy(LIVE_CFG)
        old = copy.deepcopy(LIVE_CFG)
        for key in ("force_side_after_h", "force_question"):
            old["live"].pop(key)
        self.assertEqual(qt.config_hash(old), qt.config_hash(cfg))
        self.assertEqual(qt.config_hash(cfg), "32a13314d45f58ca206728bc81f070129fb90ab8b4a17d0a2ad59f52d510ce58")
        store = live.LiveStore(env.db_path)
        self.addCleanup(store.close)
        store.check_identity(old)                                   # the base was written under the old config
        store.check_identity(live.apply_overrides(LIVE_CFG, {"QWEN_LIVE_FORCE_SIDE_AFTER_H": "3"}))


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
        env = make(self, policy=Policy(flat="LARGO"))
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
