import contextlib
import copy
import hashlib
import io
import json
import os
import random
import re
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_report as rep
from balancita_engine.futures_history import CandleCache

MIN = 60_000
BAR = qt.BAR_MS
DAY = qt.DAY_MS
T0 = qt.date_ms("2024-12-01")            # a day boundary
PRODUCTS = ("PF_XBTUSD", "PF_ETHUSD")
CFG = qt.load_config()
# One pinned hash of everything Qwen is told (system, answer line, the three questions). Changing any text without
# bumping config/qwen-trader.json prompt.version fails test_prompt_text_is_pinned; bump the version and update the pin.
PROMPT_PIN = "54ccfe5bd3a70222c64f306bf8291f078ba026ab4b1a5cfe3ff22bb380eff14b"


def walk(n, seed, start=T0, price=100.0, sigma=0.0012):
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


def cfg_with(**overrides):
    cfg = copy.deepcopy(CFG)
    for key, value in overrides.items():
        section, _, name = key.partition("__")
        if name:
            cfg[section][name] = value
        else:
            cfg[section] = value
    return cfg


def answer_for(question, probs):
    options = [o["id"] for o in question["options"]]
    probs = dict(probs)
    for o in options:
        probs.setdefault(o, 0.0)
    total = sum(probs.values())
    probs = {o: probs[o] / total for o in options}
    row = {"order": options, "probabilities": probs, "confidence": 0.5, "source": "raw_logprobs", "latency_ms": 0,
           "prompt_hash": "x"}
    merged = qt._merge(question, [row])
    return dict(merged, orders=[row], latency_ms=0, state_hash="h")


class Script:
    """A decider with no model: ``fn(t_ms, step, question) -> {option: probability}``."""

    def __init__(self, fn):
        self.fn = fn
        self.asked = []

    def ask(self, key, t_ms, step, question, state_text, single=False):
        self.asked.append((t_ms, step, question["id"], state_text))
        return answer_for(question, self.fn(t_ms, step, question))


def always(flat="ESPERAR", position="MANTENER", reason="otro"):
    def fn(t_ms, step, question):
        if step == "reason":
            return {reason: 1.0}
        return {flat: 1.0} if question["id"] == "trader_flat" else {position: 1.0}
    return fn


def trader(decider, bars_warm, product="PF_XBTUSD", funding=None, cfg=None, threshold=0.5):
    t = qt.Trader(cfg or CFG, product, decider, funding, key="test", entry_threshold=threshold)
    for bar in bars_warm:
        t.feed(bar, trade=False)
    return t


def warm_bars(extra=0, seed=1):
    """2017 warm-up bars so that the NEXT bar closes on an hour boundary."""
    n = qt.MIN_BARS
    n += (-(n + 0)) % 12 + 11 + extra * 12
    return walk(n, seed), T0 + n * BAR


def feed_all(t, bars):
    events = []
    for bar in bars:
        events += t.feed(bar)
    return events


def sig(events):
    return [(e["type"], e.get("t_ms") or e["trade"]["exit_ms"], e.get("action") or e.get("closed_by") or e["trade"]["closed_by"])
            for e in events]


class WakeRuleTests(unittest.TestCase):
    def test_flat_wakes_on_every_closed_hour_and_not_between(self):
        warm, nxt = warm_bars()
        script = Script(always())
        t = trader(script, warm)
        events = feed_all(t, walk(48, 2, start=nxt, price=float(warm[-1]["close"]), sigma=0.0002))
        times = [e["t_ms"] for e in events if e["type"] == "decision"]
        self.assertEqual(len(times), 4)
        self.assertTrue(all(x % (60 * MIN) == 0 for x in times))
        self.assertEqual([e["wake"] for e in events], [["hora_cerrada"]] * 4)

    def test_strong_move_wakes_off_the_hour_and_extra_wakes_are_spaced(self):
        warm, nxt = warm_bars()
        t = trader(Script(always()), warm)
        calm = walk(20, 3, start=nxt, price=float(warm[-1]["close"]), sigma=0.0005)
        price = float(calm[-1]["close"])
        spike = []
        for i in range(8):
            price *= 1.012
            spike.append({"bucket_start": calm[-1]["bucket_start"] + (i + 1) * BAR, "open": repr(price / 1.012),
                          "high": repr(price), "low": repr(price / 1.012), "close": repr(price), "volume_btc": "9"})
        events = feed_all(t, calm + spike)
        strong = [e for e in events if "movimiento_fuerte" in e["wake"]]
        self.assertTrue(strong)
        gaps = [b["t_ms"] - a["t_ms"] for a, b in zip(strong, strong[1:]) if "hora_cerrada" not in b["wake"]]
        self.assertTrue(all(g >= 10 * MIN for g in gaps), gaps)

    def test_in_position_wakes_every_15_minutes(self):
        warm, nxt = warm_bars()
        script = Script(lambda t_ms, step, q: {"LARGO": 1.0} if q["id"] == "trader_flat" else {"MANTENER": 1.0})
        t = trader(script, warm)
        events = feed_all(t, walk(24, 4, start=nxt, price=float(warm[-1]["close"]), sigma=0.0002))
        kinds = [(e["kind"], e["t_ms"]) for e in events if e["type"] == "decision"]
        self.assertEqual(kinds[0][0], "flat")
        in_pos = [ms for kind, ms in kinds if kind == "position"]
        self.assertGreaterEqual(len(in_pos), 6)
        self.assertTrue(all(ms % (15 * MIN) == 0 for ms in in_pos))

    def test_near_stop_wakes_a_position_between_boundaries(self):
        warm, nxt = warm_bars()
        script = Script(lambda t_ms, step, q: {"LARGO": 1.0} if q["id"] == "trader_flat" else {"MANTENER": 1.0})
        t = trader(script, warm, cfg=cfg_with(wake=dict(CFG["wake"], strong_move_sigmas=1e9)))
        events = feed_all(t, walk(1, 5, start=nxt, price=float(warm[-1]["close"]), sigma=0.0001))
        position = t.position
        self.assertIsNotNone(position)
        # one calm bar, then the price sits at 80 % of the stop distance (no strong move) 10 min after the entry call
        bucket = nxt + BAR
        t.feed(walk(1, 5, start=bucket, price=position.entry_ref, sigma=0.0001)[0])
        price = position.entry_ref * (1 - position.stop_pct * 0.8)
        got = t.feed({"bucket_start": bucket + BAR, "open": repr(price), "high": repr(price), "low": repr(price),
                      "close": repr(price), "volume_btc": "1"})
        found = [e for e in got if e["type"] == "decision" and "cerca_del_stop" in e["wake"]]
        self.assertEqual(len(found), 1)
        self.assertNotEqual(found[0]["t_ms"] % (15 * MIN), 0)

    def test_funding_publication_wake_is_extreme_or_a_jump(self):
        warm, nxt = warm_bars()
        hour = (nxt // (60 * MIN) + 1) * 60 * MIN
        funding = qt.FundingLine([(hour - 2 * 60 * MIN, 1e-6), (hour - 60 * MIN, 9e-5)])
        t = trader(Script(always()), warm, funding=funding)
        events = feed_all(t, walk(30, 6, start=nxt, price=float(warm[-1]["close"]), sigma=0.0002))
        self.assertTrue(any("funding" in e["wake"] for e in events))
        calm = qt.FundingLine([(hour - 2 * 60 * MIN, 1e-6), (hour - 60 * MIN, 2e-6)])
        t2 = trader(Script(always()), warm, funding=calm)
        events2 = feed_all(t2, walk(30, 6, start=nxt, price=float(warm[-1]["close"]), sigma=0.0002))
        self.assertFalse(any("funding" in e["wake"] for e in events2))

    def test_funding_line_only_knows_ended_periods(self):
        line = qt.FundingLine([(0, 1e-5), (qt.HOUR_MS, 2e-5)])
        self.assertIsNone(line.latest(qt.HOUR_MS - 1))
        self.assertEqual(line.latest(qt.HOUR_MS), (0, 1e-5))
        self.assertEqual(line.latest(2 * qt.HOUR_MS), (qt.HOUR_MS, 2e-5))

    def test_no_lookahead_poisoned_future_changes_nothing_before_it(self):
        """The same candles up to bar k and wild candles / funding after it: every event up to k is identical."""
        def policy(prompt, letters):
            options = dict(re.findall(r"^([A-Z])\) (\w+)", prompt, re.M))
            names = list(options.values())
            want = int(hashlib.sha1(prompt.split("QUESTION:")[0].encode()).hexdigest(), 16) % 6
            if "LARGO" in names:
                pick = ("LARGO", "CORTO", "ESPERAR", "ESPERAR", "ESPERAR", "ESPERAR")[want]
            elif "MANTENER" in names:
                pick = "CERRAR" if want == 0 else "MANTENER"
            else:
                pick = names[want % len(names)]
            return [{"token": letter, "logprob": -0.05 if options[letter] == pick else -4.0} for letter in letters]

        warm, nxt = warm_bars()
        clean = walk(300, 7, start=nxt, price=float(warm[-1]["close"]))
        cut = 150
        poisoned = clean[:cut] + [dict(b, close=repr(float(b["close"]) * (1 + 0.5 * ((i % 3) - 1))),
                                       high=repr(float(b["high"]) * 3), low=repr(float(b["low"]) * 0.2))
                                  for i, b in enumerate(clean[cut:])]
        results = []
        for bars, rate in ((clean, 1e-6), (poisoned, 5e-3)):
            funding = qt.FundingLine([(nxt + i * qt.HOUR_MS, 1e-6 if i * qt.HOUR_MS < cut * BAR else rate)
                                      for i in range(-3, 40)])
            decider = qt.LlmDecider(llm.FakeProvider(entries=policy), CFG, clock=lambda: 0.0)
            t = trader(decider, warm, funding=funding, threshold=0.5)
            results.append(feed_all(t, bars))
        limit = nxt + cut * BAR
        before = [[e for e in ev if (e.get("t_ms") or e["trade"]["exit_ms"]) <= limit] for ev in results]
        self.assertGreater(len(before[0]), 5)
        self.assertEqual(json.dumps(before[0], sort_keys=True), json.dumps(before[1], sort_keys=True))
        self.assertNotEqual(json.dumps(results[0], sort_keys=True), json.dumps(results[1], sort_keys=True))


class GuardrailTests(unittest.TestCase):
    def enter_long(self, **overrides):
        warm, nxt = warm_bars()
        script = Script(lambda t_ms, step, q: {"LARGO": 1.0} if q["id"] == "trader_flat" else {"MANTENER": 1.0})
        t = trader(script, warm, cfg=cfg_with(**overrides) if overrides else None)
        events = t.feed(walk(1, 8, start=nxt, price=float(warm[-1]["close"]), sigma=0.0001)[0])
        self.assertIsNotNone(t.position, events)
        return t, nxt + BAR, script

    def test_hard_stop_closes_even_if_qwen_wants_to_hold_then_cooldown_blocks_entries(self):
        t, bucket, script = self.enter_long()
        stop = t.position.stop_px
        crash = {"bucket_start": bucket, "open": repr(stop * 1.001), "high": repr(stop * 1.001), "low": repr(stop * 0.9),
                 "close": repr(stop * 0.95), "volume_btc": "50"}
        events = t.feed(crash)
        trades = [e["trade"] for e in events if e["type"] == "trade"]
        self.assertEqual([x["closed_by"] for x in trades], ["stop"])
        self.assertEqual(events[0]["guardrail"], "stop")
        self.assertLess(trades[0]["net_bp"], -50)
        self.assertIsNone(t.position)
        # 15 min cooldown: the next three bars cannot ask, even across a strong move
        later = []
        for i in range(1, 3):
            later += t.feed({"bucket_start": bucket + i * BAR, "open": "50", "high": "50", "low": "50", "close": "50",
                             "volume_btc": "1"})
        self.assertEqual(later, [])
        exit_ms = trades[0]["exit_ms"]
        self.assertEqual(t.cooldown_until, exit_ms + 15 * MIN)

    def test_gap_beyond_the_stop_fills_at_the_open_not_at_the_stop(self):
        t, bucket, _ = self.enter_long()
        stop = t.position.stop_px
        gap = {"bucket_start": bucket, "open": repr(stop * 0.9), "high": repr(stop * 0.91), "low": repr(stop * 0.88),
               "close": repr(stop * 0.9), "volume_btc": "50"}
        trade = [e["trade"] for e in t.feed(gap) if e["type"] == "trade"][0]
        self.assertLess(trade["exit_px"], stop * 0.9)          # open minus the stop's impact, never the better stop level

    def test_max_holding_forces_the_close(self):
        t, bucket, script = self.enter_long(guardrails=dict(CFG["guardrails"], max_hold_min=60, stop_sigma_24h=50.0,
                                                            max_stop_pct=0.9, min_stop_pct=0.9))
        events = []
        price = t.c[-1]
        for i in range(14):
            events += t.feed({"bucket_start": bucket + i * BAR, "open": repr(price), "high": repr(price * 1.0001),
                              "low": repr(price * 0.9999), "close": repr(price), "volume_btc": "1"})
        trade = [e["trade"] for e in events if e["type"] == "trade"][0]
        self.assertEqual(trade["closed_by"], "tiempo")
        self.assertEqual(trade["hold_min"], 60)

    def test_no_limit_of_trades_per_day(self):
        warm, nxt = warm_bars()
        t = trader(Script(lambda t_ms, step, q: {"LARGO": 1.0} if q["id"] == "trader_flat" else {"CERRAR": 1.0}), warm,
                   cfg=cfg_with(wake=dict(CFG["wake"], strong_move_sigmas=1e9)))
        events = feed_all(t, walk(288, 9, start=nxt, price=float(warm[-1]["close"]), sigma=0.0003))
        trades = [e for e in events if e["type"] == "trade"]
        self.assertGreaterEqual(len(trades), 20)
        self.assertTrue(all(e["trade"]["closed_by"] == "qwen" for e in trades))

    def test_one_position_at_a_time_and_fixed_size(self):
        t, bucket, script = self.enter_long()
        self.assertEqual(float(t.position.entry_px * t.position.qty), 100.0)
        events = feed_all(t, walk(40, 10, start=bucket, price=t.c[-1], sigma=0.0002))
        self.assertTrue(all(e["kind"] == "position" for e in events if e["type"] == "decision"))

    def test_threshold_blocks_a_weak_entry_and_no_reason_is_asked(self):
        warm, nxt = warm_bars()
        script = Script(lambda t_ms, step, q: {"LARGO": 0.45, "ESPERAR": 0.35, "CORTO": 0.2})
        t = trader(script, warm, threshold=0.6)
        events = t.feed(walk(1, 11, start=nxt, price=float(warm[-1]["close"]), sigma=0.0001)[0])
        self.assertEqual(events[0]["override"], "bajo_umbral")
        self.assertEqual(events[0]["action"], "ESPERAR")
        self.assertIsNone(t.position)
        self.assertEqual([s for _, s, _, _ in script.asked], ["action"])

    def test_entry_threshold_must_exist(self):
        decider = Script(always())
        with self.assertRaises(qt.TraderError):
            qt.Trader(CFG, "PF_XBTUSD", decider)


class AccountingTests(unittest.TestCase):
    def test_settle_matches_the_shared_cost_model(self):
        from decimal import Decimal as D
        from balancita_engine.futures_costs import entry_fill, exit_fill, fee_rate
        entry = entry_fill(D("100"), "LONG", "PF_XBTUSD")
        pos = qt.Position(side="LONG", entry_ms=0, entry_px=entry, qty=D(100) / entry)
        got = qt.settle("PF_XBTUSD", pos, 101.0, "strategy_exit", 3_600_000, None)
        px = exit_fill(D("101"), "LONG", "PF_XBTUSD", "strategy_exit")
        expected = ((px - entry) * pos.qty - (entry + px) * pos.qty * fee_rate("taker")) / 100 * 10_000
        self.assertAlmostEqual(got["net_bp"], float(expected), places=6)
        self.assertEqual(got["funding_status"], "unknown")

    def test_funding_is_charged_to_longs_and_paid_to_shorts(self):
        from decimal import Decimal as D
        line = qt.FundingLine([(0, 1e-4), (qt.HOUR_MS, 1e-4)])
        long_ = qt.Position(side="LONG", entry_ms=0, entry_px=D(100), qty=D(1))
        short = qt.Position(side="SHORT", entry_ms=0, entry_px=D(100), qty=D(1))
        a = qt.settle("PF_XBTUSD", long_, 100.0, "strategy_exit", 2 * qt.HOUR_MS, line)
        b = qt.settle("PF_XBTUSD", short, 100.0, "strategy_exit", 2 * qt.HOUR_MS, line)
        self.assertAlmostEqual(a["funding_bp"], 2.0, places=6)
        self.assertAlmostEqual(b["funding_bp"], -2.0, places=6)
        self.assertEqual(a["funding_status"], "complete")


class PromptTests(unittest.TestCase):
    def test_prompt_text_is_pinned(self):
        body = json.dumps({"p": CFG["prompt"]["system"], "a": CFG["prompt"]["answer_line"],
                           "q": CFG["prompt"]["questions"], "v": CFG["prompt"]["version"], "o": CFG["prompt"]["orders"]},
                          sort_keys=True)
        digest = hashlib.sha256(body.encode()).hexdigest()
        self.assertEqual(digest, PROMPT_PIN, "prompt changed: bump prompt.version and update PROMPT_PIN")

    def test_state_has_no_dates_prices_or_product_names_and_states_the_cost(self):
        warm, nxt = warm_bars()
        script = Script(lambda t_ms, step, q: {"LARGO": 1.0} if q["id"] == "trader_flat" else {"MANTENER": 1.0})
        t = trader(script, warm)
        t.feed(walk(1, 12, start=nxt, price=float(warm[-1]["close"]))[0])
        t.feed(walk(1, 12, start=nxt + BAR, price=float(warm[-1]["close"]))[0])
        flat_state, pos_state = script.asked[0][3], t.state_text(nxt + 3 * BAR, ["cada_15_min"])
        for text in (flat_state, pos_state):
            self.assertNotIn("PF_", text)
            self.assertNotRegex(text, r"20\d\d")
            self.assertIn("~0,10 %", text)
        self.assertIn("Posicion: ninguna", flat_state)
        self.assertIn("Resultado si cerras ahora", pos_state)
        self.assertNotIn("desempe", pos_state)
        question = qt.questions_for(CFG, "PF_XBTUSD")["flat"]
        self.assertIn("~0,10 %", question["instruction"])
        self.assertIn("claramente mayor", question["instruction"])

    def test_both_orders_are_asked_and_a_letter_bias_cannot_open_a_position(self):
        warm, nxt = warm_bars()
        provider = llm.FakeProvider(entries=lambda prompt, letters: [{"token": "A", "logprob": -0.01},
                                                                     {"token": "B", "logprob": -6.0},
                                                                     {"token": "C", "logprob": -6.0}][:len(letters)])
        decider = qt.LlmDecider(provider, CFG)
        t = trader(decider, warm, threshold=0.6)
        events = t.feed(walk(1, 13, start=nxt, price=float(warm[-1]["close"]))[0])
        self.assertEqual(len(provider.prompts), 2)
        first = re.findall(r"^A\) (\w+)", provider.prompts[0], re.M)[0]
        second = re.findall(r"^A\) (\w+)", provider.prompts[1], re.M)[0]
        self.assertNotEqual(first, second)
        self.assertEqual([o["order"][0] for o in events[0]["answer"]["orders"]], [first, second])
        self.assertAlmostEqual(sum(events[0]["answer"]["probabilities"].values()), 1.0)
        self.assertIsNone(t.position)                                # always-A averages to ~0.5 on each option: below 0.6

    def test_reason_is_asked_once_and_only_for_moves(self):
        warm, nxt = warm_bars()
        provider = llm.FakeProvider(entries=lambda prompt, letters: [
            {"token": letter, "logprob": -0.05 if re.search(r"^{}\) (LARGO|MANTENER)".format(letter), prompt, re.M) or
             (not re.search(r"LARGO|MANTENER", prompt) and letter == "A") else -5.0} for letter in letters])
        decider = qt.LlmDecider(provider, CFG)
        t = trader(decider, warm, threshold=0.5)
        events = t.feed(walk(1, 14, start=nxt, price=float(warm[-1]["close"]))[0])
        reason_prompts = [p for p in provider.prompts if "motivo principal" in p]
        self.assertEqual(len(provider.prompts), 3)                    # 2 orders + 1 reason
        self.assertEqual(len(reason_prompts), 1)
        self.assertIn("Elegiste LARGO", reason_prompts[0])
        self.assertEqual(events[0]["reason"], "movimiento_exagerado")  # letter A of the reason list
        # now holding: MANTENER never asks a reason
        before = len(provider.prompts)
        for i in range(1, 4):
            t.feed(walk(1, 15 + i, start=nxt + i * BAR, price=t.c[-1])[0])
        self.assertTrue(all("motivo principal" not in p for p in provider.prompts[before:]))


# --------------------------------------------------------------------------- practice


START_DAY = "2025-01-01"
HOLDOUT = qt.date_ms("2025-02-20")
SERIES = {p: walk(((HOLDOUT + 3 * DAY) - (qt.date_ms(START_DAY) - 9 * DAY)) // BAR, 20 + i,
                  start=qt.date_ms(START_DAY) - 9 * DAY, price=100.0 + 50 * i) for i, p in enumerate(PRODUCTS)}


class MemHistory(qt.History):
    """In-memory candles (the series run past the holdout on purpose: they must never be read)."""

    def __init__(self, series=SERIES, holdout=HOLDOUT):
        super().__init__("/nonexistent", holdout, offline=True)
        self.series = series
        self.requests = []

    def bars(self, product, from_ms, to_ms, *, fill=True, annotate=False):
        self._check(to_ms)
        self.requests.append((product, from_ms, to_ms))
        return [b for b in self.series[product] if from_ms <= b["bucket_start"] < to_ms]

    def funding(self, product):
        start = qt.date_ms(START_DAY) - 3 * DAY
        return [(s, 2e-6) for s in range(start, HOLDOUT + 2 * DAY, qt.HOUR_MS) if s + qt.HOUR_MS <= HOLDOUT]


def small_cfg():
    return cfg_with(practice=dict(CFG["practice"], block_days=1, time_bins=3, target_blocks=4, **{"from": START_DAY}),
                    practice_entry_threshold=0.5)


def hashed_policy(prompt, letters):
    options = dict(re.findall(r"^([A-Z])\) (\w+)", prompt, re.M))
    names = list(options.values())
    h = int(hashlib.sha1(prompt.split("QUESTION:")[0].encode()).hexdigest(), 16)
    if "LARGO" in names:
        pick = ("LARGO", "CORTO", "ESPERAR", "ESPERAR", "ESPERAR", "ESPERAR")[h % 6]
    elif "MANTENER" in names:
        pick = "CERRAR" if h % 9 == 0 else "MANTENER"
    else:
        pick = names[h % len(names)]
    return [{"token": letter, "logprob": -0.05 if options[letter] == pick else -5.0} for letter in letters]


class ClockedProvider(llm.FakeProvider):
    def __init__(self, clock, **kwargs):
        super().__init__(**kwargs)
        self.clock = clock

    def complete(self, *args, **kwargs):
        self.clock[0] += 1.0
        return super().complete(*args, **kwargs)


def run(db, cfg=None, *, minutes=55, history=None, provider=None, clock=None, blocks=4):
    clock = clock or [0.0]
    provider = provider or ClockedProvider(clock, entries=hashed_policy)
    return qt.run_practice(history or MemHistory(), db, provider, cfg or small_cfg(), HOLDOUT, max_minutes=minutes,
                           blocks=blocks, clock=lambda: clock[0], log=lambda *a: None), provider


def rows(db, sql):
    con = sqlite3.connect(db)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


class PlanTests(unittest.TestCase):
    def test_plan_is_seeded_stratified_inside_the_period_with_a_60_40_split(self):
        plan, cut = qt.block_plan(CFG, qt.load_holdout_ms(), blocks=60)
        again, _ = qt.block_plan(CFG, qt.load_holdout_ms(), blocks=60)
        self.assertEqual(plan, again)
        self.assertNotEqual(plan, qt.block_plan(CFG, qt.load_holdout_ms(), blocks=60, seed=1)[0])
        self.assertEqual(len(plan), 60)
        holdout = qt.load_holdout_ms()
        self.assertTrue(all(qt.date_ms("2025-01-01") <= b["start_ms"] and b["end_ms"] <= holdout for b in plan))
        self.assertEqual(len({b["block_id"] for b in plan}), 60)
        self.assertEqual({sum(1 for b in plan if b["product"] == p) for p in PRODUCTS}, {30})
        for prefix in (10, 20, 40):
            part = plan[:prefix]
            self.assertLessEqual(abs(sum(1 for b in part if b["product"] == PRODUCTS[0]) - prefix / 2), 1)
            self.assertGreaterEqual(len({b["bin"] for b in part}), min(prefix // 2, 10))
        cal = sum(1 for b in plan if b["fold"] == "calibration")
        self.assertTrue(30 <= cal <= 42, cal)
        self.assertTrue(all((b["fold"] == "calibration") == (b["start_ms"] < cut) for b in plan))

    def test_config_hash_ignores_the_selected_threshold_but_not_the_prompt(self):
        self.assertEqual(qt.config_hash(CFG), qt.config_hash(cfg_with(entry_threshold=0.7)))
        self.assertEqual(qt.config_hash(CFG), qt.config_hash(cfg_with(practice=dict(CFG["practice"], target_blocks=99))))
        changed = copy.deepcopy(CFG)
        changed["prompt"]["system"] += " x"
        self.assertNotEqual(qt.config_hash(CFG), qt.config_hash(changed))


class PracticeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "practice.sqlite")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_full_run_records_every_call_and_decision(self):
        result, provider = run(self.db)
        self.assertEqual(result["stop_reason"], "done")
        self.assertEqual(result["blocks_done"], 4)
        calls = rows(self.db, "SELECT COUNT(*), COUNT(DISTINCT prompt_hash), MIN(prompt_version), MIN(state_hash), "
                              "MIN(model) FROM calls")[0]
        self.assertEqual(calls[0], provider.calls)
        self.assertEqual(calls[2], 1)
        self.assertEqual(calls[4], "fake-model")
        flat = rows(self.db, "SELECT orders_json, probs_json, action, state_text FROM decisions WHERE kind='flat'")
        self.assertTrue(flat)
        orders = json.loads(flat[0][0])
        self.assertEqual(len(orders), 2)
        self.assertNotEqual(orders[0]["order"], orders[1]["order"])
        meta = dict(rows(self.db, "SELECT key, value FROM meta"))
        self.assertEqual(json.loads(meta["holdout_ms"]), HOLDOUT)
        self.assertIn("threshold_selection", meta)
        trades = rows(self.db, "SELECT COUNT(*) FROM trades")[0][0]
        self.assertGreater(trades, 0)

    def test_blocks_start_flat_and_never_leave_a_position_open(self):
        run(self.db)
        for block_id, start, end in rows(self.db, "SELECT block_id, start_ms, end_ms FROM blocks"):
            for entry, exit_ in rows(self.db, "SELECT entry_ms, exit_ms FROM trades WHERE block_id='{}'".format(block_id)):
                self.assertTrue(start < entry <= exit_ <= end)
            first = rows(self.db, "SELECT kind FROM decisions WHERE block_id='{}' ORDER BY seq LIMIT 1".format(block_id))
            self.assertEqual(first[0][0], "flat")

    def test_resume_after_the_time_budget_gives_the_same_result_with_no_repeated_call(self):
        one = os.path.join(self.tmp, "one.sqlite")
        run(one)
        cut, provider1 = run(self.db, minutes=0.5)            # 30 simulated seconds: stops inside the first block
        self.assertEqual(cut["stop_reason"], "budget")
        self.assertEqual(cut["blocks_done"], 0)
        stored = rows(self.db, "SELECT COUNT(*) FROM calls")[0][0]
        self.assertGreater(stored, 0)
        done, provider2 = run(self.db)
        self.assertEqual(done["stop_reason"], "done")
        total = rows(one, "SELECT COUNT(*) FROM calls")[0][0]
        self.assertEqual(provider1.calls + provider2.calls, total)   # nothing asked twice
        sql = "SELECT block_id, seq, t_ms, kind, action, p_action, override, reason FROM decisions ORDER BY 1, 2"
        self.assertEqual(rows(one, sql), rows(self.db, sql))
        sql = "SELECT block_id, trade_no, net_bp, closed_by FROM trades ORDER BY 1, 2"
        self.assertEqual(rows(one, sql), rows(self.db, sql))
        again, provider3 = run(self.db)
        self.assertEqual(provider3.calls, 0)
        self.assertEqual(again["blocks_done"], 4)

    def test_a_database_from_another_seed_is_refused(self):
        run(self.db)
        history = MemHistory()
        provider = ClockedProvider([0.0], entries=hashed_policy)
        cfg = small_cfg()
        with self.assertRaises(qt.TraderError):
            qt.run_practice(history, self.db, provider, cfg, HOLDOUT, seed=5, blocks=4, log=lambda *a: None)

    def test_model_down_stops_cleanly_and_keeps_what_was_done(self):
        provider = ClockedProvider([0.0], entries=hashed_policy)
        provider.fail_with = llm.ModelUnavailable("down")
        result, _ = run(self.db, provider=provider)
        self.assertEqual(result["stop_reason"], "model_down")
        self.assertEqual(rows(self.db, "SELECT COUNT(*) FROM blocks WHERE status='done'")[0][0], 0)

    def test_the_holdout_is_never_requested(self):
        history = MemHistory()
        run(self.db, history=history)
        self.assertTrue(history.requests)
        self.assertTrue(all(to <= HOLDOUT for _, _, to in history.requests))
        self.assertLessEqual(history.max_requested_ms, HOLDOUT)
        for _, _, end in rows(self.db, "SELECT block_id, start_ms, end_ms FROM blocks"):
            self.assertLessEqual(end, HOLDOUT)
        with self.assertRaises(qt.HoldoutError):
            history.bars("PF_XBTUSD", HOLDOUT - DAY, HOLDOUT + 1)

    def test_real_history_layer_refuses_the_holdout_and_filters_funding(self):
        cache_dir = os.path.join(self.tmp, "cache")
        cache = CandleCache(os.path.join(cache_dir, "candles-PF_XBTUSD.sqlite"))
        bars = SERIES["PF_XBTUSD"]
        with cache.db:
            cache.db.executemany("INSERT INTO candles VALUES(?,?,?,?,?,?,?)", [
                ("5m", b["bucket_start"], b["open"], b["high"], b["low"], b["close"], b["volume_btc"]) for b in bars])
        cache.close()
        history = qt.History(cache_dir, HOLDOUT, offline=True)
        got = history.bars("PF_XBTUSD", HOLDOUT - DAY, HOLDOUT)
        self.assertEqual(len(got), 288)
        self.assertLess(got[-1]["bucket_start"] + BAR, HOLDOUT + 1)
        with self.assertRaises(qt.HoldoutError):
            history.bars("PF_XBTUSD", HOLDOUT - DAY, HOLDOUT + BAR)
        with self.assertRaises(qt.HoldoutError):
            history.prefetch("PF_XBTUSD", HOLDOUT - DAY, HOLDOUT + DAY)
        os.makedirs(cache_dir, exist_ok=True)
        with open(os.path.join(cache_dir, "funding-PF_XBTUSD.json"), "w") as handle:
            json.dump([[HOLDOUT - 3 * qt.HOUR_MS, 1e-5], [HOLDOUT - qt.HOUR_MS, 1e-5], [HOLDOUT, 1e-5]], handle)
        self.assertEqual([s for s, _ in history.funding("PF_XBTUSD")], [HOLDOUT - 3 * qt.HOUR_MS, HOLDOUT - qt.HOUR_MS])


class LoopbackTests(unittest.TestCase):
    def test_only_loopback_urls_are_accepted(self):
        for url in ("http://127.0.0.1:8088", "http://localhost:8088"):
            self.assertEqual(qt._provider(url).base_url, url)
        for url in ("http://example.com:8088", "http://192.168.1.5:8088", "https://127.0.0.1:8088"):
            with self.assertRaises(ValueError):
                qt._provider(url)

    def test_the_practice_command_refuses_a_remote_url(self):
        tmp = tempfile.mkdtemp()
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = qt.main(["practice", "--offline", "--db", os.path.join(tmp, "p.sqlite"), "--cache-dir", tmp,
                            "--llama-url", "http://example.com:8088"])
        self.assertEqual(code, 2)
        self.assertIn("loopback", err.getvalue())


# --------------------------------------------------------------------------- report and export


def fake_trade(i, product, net, *, fold="validation", hold=250, bin_=0, block="b", side="LONG", closed="qwen", funding=0.0):
    return {"block_id": "{}{}".format(block, i % 3), "trade_no": i, "product": product, "side": side, "fold": fold,
            "time_bin": bin_, "entry_ms": i * 10_000_000, "exit_ms": i * 10_000_000 + hold * MIN, "net_bp": net,
            "gross_bp": net + 10, "funding_bp": funding, "funding_status": "complete", "closed_by": closed,
            "hold_min": hold, "entry_p": 0.8, "entry_reason": "tendencia", "exit_reason": "sin_ventaja"}


def wave_blocks(n_blocks=3):
    """Closes that oscillate: random entries average ~0 gross, a trader entering at troughs wins big."""
    import math
    closes = [100.0 * (1 + 0.02 * math.sin(2 * math.pi * i / 100)) for i in range(900)]
    return {"b{}".format(i): {"block_id": "b{}".format(i), "product": PRODUCTS[i % 2], "closes": closes,
                              "fold": "validation"} for i in range(n_blocks)}


class VerdictTests(unittest.TestCase):
    RULES = CFG["rules"]

    def judge(self, trades, blocks=None):
        return rep.judge(trades, blocks or wave_blocks(), dict(self.RULES, random_draws=200, bootstrap_draws=300),
                         list(PRODUCTS), seed=1)

    def test_enough_good_trades_that_beat_random_pass(self):
        trades = [fake_trade(i, PRODUCTS[i % 2], 150.0 + (i % 7), bin_=i % 4, hold=250, side="LONG") for i in range(120)]
        # entries at troughs of the wave: gross of +4 % over the half period, far beyond what random entries do
        result = self.judge(trades)
        self.assertEqual(result["verdict"], "PASA", [c for c in result["rules"] if not c["ok"]])
        self.assertGreaterEqual(result["percentile"], 95)

    def test_few_trades_with_everything_else_good_is_inconclusive(self):
        trades = [fake_trade(i, PRODUCTS[i % 2], 150.0 + i, bin_=i % 4, hold=250) for i in range(30)]
        result = self.judge(trades)
        self.assertEqual(result["verdict"], "INCONCLUSO")

    def test_few_trades_and_another_rule_failing_is_no_pasa_with_the_note(self):
        trades = [fake_trade(i, PRODUCTS[i % 2], -40.0 + (i % 3), bin_=i % 4) for i in range(30)]
        result = self.judge(trades)
        self.assertEqual(result["verdict"], "NO PASA")
        self.assertEqual(result["verdict_note"], "(pocas operaciones)")

    def test_many_trades_that_lose_do_not_pass(self):
        trades = [fake_trade(i, PRODUCTS[i % 2], -25.0 + (i % 5) * 3, bin_=i % 4) for i in range(150)]
        result = self.judge(trades)
        self.assertEqual(result["verdict"], "NO PASA")
        self.assertIsNone(result["verdict_note"])
        self.assertFalse({c["id"]: c for c in result["rules"]}["mean_net_positive"]["ok"])

    def test_a_single_lucky_group_or_product_is_not_enough(self):
        trades = [fake_trade(i, PRODUCTS[0], 120.0 if i < 100 else -300.0, bin_=0 if i < 100 else 1 + i % 3)
                  for i in range(130)]
        by_id = {c["id"]: c for c in self.judge(trades)["rules"]}
        self.assertFalse(by_id["positive_groups"]["ok"])
        self.assertTrue(by_id["positive_products"]["ok"])          # one of the two products is exactly 50 %

    def test_cost_stress_can_flip_a_thin_edge(self):
        trades = [fake_trade(i, PRODUCTS[i % 2], 3.0, bin_=i % 4) for i in range(120)]
        result = self.judge(trades)
        self.assertLess(result["stress_mean_bp"], 3.0)
        self.assertFalse({c["id"]: c for c in result["rules"]}["cost_stress"]["ok"])

    def test_threshold_is_chosen_on_calibration_only(self):
        calibration = [dict(fake_trade(i, "PF_XBTUSD", 40.0, fold="calibration"), entry_p=0.85) for i in range(40)] + \
                      [dict(fake_trade(100 + i, "PF_XBTUSD", -30.0, fold="calibration"), entry_p=0.55) for i in range(40)]
        chosen = qt.select_threshold(calibration, CFG)
        self.assertEqual(chosen["threshold"], 0.8)
        weak = qt.select_threshold(calibration[:5], CFG)
        self.assertEqual(weak["threshold"], max(CFG["entry_threshold_grid"]))
        self.assertIn("exigente", weak["reason"])


class ReportAndExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.db = os.path.join(cls.tmp, "practice.sqlite")
        cls.provider = ClockedProvider([0.0], entries=hashed_policy)
        qt.run_practice(MemHistory(), cls.db, cls.provider, small_cfg(), HOLDOUT, blocks=4, log=lambda *a: None,
                        clock=lambda: 0.0)
        cls.cfg = small_cfg()

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_report_is_plain_spanish_markdown_with_the_gate_sections(self):
        text = rep.build_report(self.db, self.cfg)
        for needle in ("# Qwen operador", "### En pocas palabras", "## Qué revisamos", "## Glosario", "## Detalles técnicos",
                       "Comparación con otras opciones", "Calibración", "Sesgo por el orden", "Motivos que dio Qwen",
                       "Cobertura", "Kronos", "No operar", "días", "Cerró Qwen", "Cerró el stop"):
            self.assertIn(needle, text)
        self.assertTrue(("✅ PASA" in text) or ("❌ NO PASA" in text) or ("⚠️ INCONCLUSO" in text))
        self.assertIn("| PF_XBTUSD", text)
        self.assertIn("| PF_ETHUSD", text)
        self.assertIsNone(re.search(r"\bnan\b", text.lower()))
        self.assertLess(text.index("## Glosario"), text.index("## Detalles técnicos"))

    def test_report_of_an_empty_database_does_not_crash(self):
        empty = os.path.join(self.tmp, "empty.sqlite")
        qt.PracticeDB(empty).close()
        text = rep.build_report(empty, self.cfg)
        self.assertIn("pocas operaciones", text)

    def test_export_has_one_line_per_decision_with_state_outcome_and_fold(self):
        out = os.path.join(self.tmp, "dataset.jsonl")
        count = qt.export_dataset(self.db, out, self.cfg)
        with open(out, encoding="utf-8") as handle:
            lines = [json.loads(line) for line in handle]
        self.assertEqual(count, len(lines))
        self.assertEqual(count, rows(self.db, "SELECT COUNT(*) FROM decisions")[0][0])
        kinds = {line["kind"] for line in lines}
        self.assertLessEqual({"flat", "position"}, kinds)
        for line in lines:
            self.assertEqual(line["schema"], qt.DATASET_SCHEMA)
            self.assertEqual(line["source"], "practice")
            self.assertIn(line["fold"], ("calibration", "validation"))
            self.assertIn("guardrail", line)
        flat = [x for x in lines if x["kind"] == "flat"]
        self.assertTrue(all(x["probabilities"] and x["orders"] and len(x["orders"]) == 2 for x in flat))
        prompted = "\n".join(self.provider.prompts)
        self.assertTrue(all(x["state_text"] in prompted for x in flat[:50]))      # exactly what was prompted
        entries = [x for x in flat if x["action"] in ("LARGO", "CORTO")]
        self.assertTrue(entries)
        self.assertTrue(all(x["outcome"]["type"] == "entry" and x["trade"] and x["reason"] for x in entries))
        waits = [x for x in flat if x["action"] == "ESPERAR" and x["outcome"]]
        self.assertTrue(waits and all("long_net_bp" in x["outcome"] for x in waits))
        held = [x for x in lines if x["kind"] == "position" and x["outcome"]]
        self.assertTrue(held and all("hold_better_bp" in x["outcome"] for x in held))
        self.assertTrue(all(x["guardrail"]["forced"] for x in lines if x["kind"] == "guardrail"))
        again = os.path.join(self.tmp, "dataset2.jsonl")
        qt.export_dataset(self.db, again, self.cfg)
        with open(out, encoding="utf-8") as a, open(again, encoding="utf-8") as b:
            self.assertEqual(a.read(), b.read())

    def test_outcomes_never_enter_the_state_text(self):
        for (state,) in rows(self.db, "SELECT state_text FROM decisions WHERE state_text IS NOT NULL LIMIT 200"):
            self.assertNotIn("outcome", state)
            self.assertNotIn("net_bp", state)

    def test_stats_rows_split_who_closed_the_trade(self):
        trades = [fake_trade(1, "PF_XBTUSD", 10.0), fake_trade(2, "PF_XBTUSD", -20.0, closed="stop"),
                  fake_trade(3, "PF_XBTUSD", 5.0, closed="tiempo"), fake_trade(4, "PF_XBTUSD", 5.0, closed="fin_de_bloque")]
        row = rep.stats_row(trades, 2.0)
        self.assertEqual(row["per_day"], 2.0)
        self.assertEqual(row["closed"], {"qwen": 0.25, "stop": 0.25, "tiempo": 0.25, "fin_de_bloque": 0.25})


# --------------------------------------------------------------------------- counterfactual exits, entry quality, diagnostics


class SynthHistory(qt.History):
    """In-memory candles that keep the holdout guard of the real History and log every read."""

    def __init__(self, bars, holdout, funding=()):
        super().__init__("/nonexistent", holdout, offline=True)
        self.all, self.rows, self.requests = bars, list(funding), []

    def bars(self, product, from_ms, to_ms):
        self._check(to_ms)
        self.requests.append((from_ms, to_ms))
        return [b for b in self.all if from_ms <= b["bucket_start"] < to_ms]

    def funding(self, product):
        return self.rows


def drift_bars(start, n, price, step=0.0002, crash_at=None):
    """Smooth path: price * (1 + step) per bar, optionally a -50 % crash at bar ``crash_at``."""
    out = []
    for i in range(n):
        new = price * (1 + step)
        if crash_at is not None and i == crash_at:
            new = price * 0.5
        high, low = max(price, new) * 1.00005, min(price, new) * 0.99995
        out.append({"bucket_start": start + i * BAR, "open": repr(price), "high": repr(high), "low": repr(low),
                    "close": repr(new), "volume_btc": "5"})
        price = new
    return out


def qwen_trade(entry_ms, net=-30.0, side="LONG", block="b0", fold="validation", hold=60):
    return {"block_id": block, "trade_no": 1, "product": "PF_XBTUSD", "side": side, "fold": fold, "time_bin": 0,
            "entry_ms": entry_ms, "exit_ms": entry_ms + hold * MIN, "net_bp": net, "gross_bp": net + 10,
            "funding_bp": 0.0, "funding_status": "complete", "closed_by": "qwen", "hold_min": hold, "entry_p": 0.8,
            "entry_reason": "tendencia", "exit_reason": "sin_ventaja"}


class CounterfactualTests(unittest.TestCase):
    HOUR = qt.HOUR_MS

    def setUp(self):
        self.warm, self.entry = warm_bars()
        self.last = float(self.warm[-1]["close"])

    def data(self, trades, block_end, holdout):
        blocks = {"b0": {"block_id": "b0", "product": "PF_XBTUSD", "start_ms": self.entry - 3 * DAY, "end_ms": block_end,
                         "fold": "validation", "closes": [], "seconds": 1.0}}
        return {"meta": {"holdout_ms": holdout}, "blocks": blocks, "trades": trades, "decisions": [],
                "calls": {"n": 0, "mean_ms": None}, "runs": []}

    def history(self, post, holdout):
        return SynthHistory(self.warm + post, holdout)

    def test_hold_until_the_close_Qwen_chose_reproduces_the_real_trade_exactly(self):
        script = Script(lambda t_ms, step, q: {"LARGO": 1.0} if q["id"] == "trader_flat" else {"CERRAR": 1.0})
        t = trader(script, self.warm)
        post = walk(30, 9, start=self.entry, price=self.last, sigma=0.0004)
        events = feed_all(t, post)
        real = [e["trade"] for e in events if e["type"] == "trade"][0]
        self.assertEqual(real["closed_by"], "qwen")
        bars = qt.fill_gaps(self.warm + post, BAR)
        got = rep.hold_outcome(CFG, real, bars, qt.FundingLine(), horizon_ms=real["exit_ms"] - real["entry_ms"],
                               limit_ms=real["exit_ms"])
        self.assertAlmostEqual(got["net_bp"], real["net_bp"], places=6)
        self.assertAlmostEqual(got["gross_bp"], real["gross_bp"], places=6)

    def test_holding_on_in_a_rally_beats_closing_and_the_numbers_add_up(self):
        post = drift_bars(self.entry, 700, self.last)
        block_end, holdout = self.entry + 12 * self.HOUR, self.entry + 30 * self.HOUR
        trade = qwen_trade(self.entry)
        rows = rep.counterfactuals(self.data([trade], block_end, holdout), CFG, self.history(post, holdout))
        self.assertEqual(len(rows), 1)
        sc = rows[0]["scenarios"]
        self.assertTrue(all(sc[k] is not None for k in ("guardrails", "h4", "h8", "h24")), sc)
        self.assertEqual(sc["guardrails"]["closed_by"], "fin_de_bloque")
        self.assertEqual(sc["guardrails"]["exit_ms"], block_end)
        self.assertEqual(sc["h4"]["exit_ms"], self.entry + 4 * self.HOUR)
        self.assertEqual(sc["h24"]["exit_ms"], self.entry + 24 * self.HOUR)       # past the block end, still before the holdout
        self.assertLess(sc["h4"]["net_bp"], sc["h8"]["net_bp"])
        self.assertLess(sc["h8"]["net_bp"], sc["h24"]["net_bp"])
        s = rep.counterfactual_summary(rows, "h4")
        self.assertEqual((s["n"], s["better"], s["worse"]), (1, 0, 1))
        self.assertAlmostEqual(s["diff_bp"], sc["h4"]["net_bp"] - trade["net_bp"])
        self.assertIn("Cerrar antes le costó", rep.counterfactual_sentence(rows))

    def test_a_short_earns_a_crash_and_a_long_hits_the_stop(self):
        post = drift_bars(self.entry, 700, self.last, crash_at=60)               # -50 % at hour 5
        block_end, holdout = self.entry + 12 * self.HOUR, self.entry + 30 * self.HOUR
        rows = rep.counterfactuals(self.data([qwen_trade(self.entry, side="SHORT", net=-20.0)], block_end, holdout),
                                   CFG, self.history(post, holdout))
        self.assertGreater(rows[0]["scenarios"]["h8"]["net_bp"], 1000)
        long_rows = rep.counterfactuals(self.data([qwen_trade(self.entry, side="LONG")], block_end, holdout), CFG,
                                        self.history(post, holdout))
        lsc = long_rows[0]["scenarios"]
        self.assertEqual(lsc["h8"]["closed_by"], "stop")
        self.assertEqual(lsc["guardrails"]["closed_by"], "stop")
        self.assertEqual(lsc["h4"]["closed_by"], "tiempo")

    def test_rule_a_never_reads_past_the_end_of_the_block(self):
        block_end, holdout = self.entry + 6 * self.HOUR, self.entry + 30 * self.HOUR
        calm = drift_bars(self.entry, 700, self.last)
        poisoned = drift_bars(self.entry, 700, self.last, crash_at=84)           # crash at hour 7, after the block
        a = rep.counterfactuals(self.data([qwen_trade(self.entry)], block_end, holdout), CFG, self.history(calm, holdout))
        b = rep.counterfactuals(self.data([qwen_trade(self.entry)], block_end, holdout), CFG, self.history(poisoned, holdout))
        self.assertEqual(a[0]["scenarios"]["guardrails"], b[0]["scenarios"]["guardrails"])
        self.assertEqual(a[0]["scenarios"]["h4"], b[0]["scenarios"]["h4"])        # ends before the crash
        self.assertEqual(b[0]["scenarios"]["guardrails"]["closed_by"], "fin_de_bloque")
        self.assertEqual(b[0]["scenarios"]["h8"]["closed_by"], "stop")            # fixed horizons may cross the block end
        self.assertNotEqual(a[0]["scenarios"]["h8"]["net_bp"], b[0]["scenarios"]["h8"]["net_bp"])

    def test_holdout_guard_a_horizon_that_would_end_after_the_cut_is_not_computed_and_not_read(self):
        post = drift_bars(self.entry, 700, self.last)
        block_end, holdout = self.entry + 6 * self.HOUR, self.entry + 10 * self.HOUR
        history = self.history(post, holdout)
        data = self.data([qwen_trade(self.entry)], block_end, holdout)
        rows = rep.counterfactuals(data, CFG, history)
        sc = rows[0]["scenarios"]
        self.assertIsNotNone(sc["h8"])
        self.assertIsNone(sc["h24"])
        self.assertTrue(history.requests)
        self.assertLessEqual(max(hi for _, hi in history.requests), holdout)
        summary = rep.counterfactual_summary(rows, "h24")
        self.assertEqual((summary["n"], summary["total"]), (0, 1))
        entry = rep.entry_moves(data, history)
        self.assertIsNotNone(entry[0]["moves"]["h4"])
        self.assertIsNone(entry[0]["moves"]["h24"])
        self.assertLessEqual(max(hi for _, hi in history.requests), holdout)
        with self.assertRaises(qt.HoldoutError):
            history.bars("PF_XBTUSD", self.entry, holdout + BAR)

    def test_missing_candles_give_nd_not_a_guess(self):
        block_end, holdout = self.entry + 6 * self.HOUR, self.entry + 30 * self.HOUR
        rows = rep.counterfactuals(self.data([qwen_trade(self.entry)], block_end, holdout), CFG,
                                   SynthHistory([], holdout))
        self.assertTrue(all(v is None for v in rows[0]["scenarios"].values()))
        self.assertIn("No se pudo calcular", rep.counterfactual_sentence(rows))
        hole = [b for b in drift_bars(self.entry, 200, self.last) if not 20 <= (b["bucket_start"] - self.entry) // BAR < 30]
        got = rep.hold_outcome(CFG, qwen_trade(self.entry), self.warm + hole, qt.FundingLine(), horizon_ms=4 * self.HOUR,
                               limit_ms=self.entry + 4 * self.HOUR)
        self.assertIsNone(got)        # the history layer fills quiet gaps; a raw hole is never bridged here

    def test_only_trades_closed_by_qwen_are_compared(self):
        block_end, holdout = self.entry + 6 * self.HOUR, self.entry + 30 * self.HOUR
        other = dict(qwen_trade(self.entry), closed_by="stop")
        rows = rep.counterfactuals(self.data([other], block_end, holdout), CFG,
                                   self.history(drift_bars(self.entry, 700, self.last), holdout))
        self.assertEqual(rows, [])
        self.assertIn("ninguna operación", rep.counterfactual_sentence(rows))

    def test_entry_quality_splits_gross_move_from_cost(self):
        post = drift_bars(self.entry, 700, self.last)
        block_end, holdout = self.entry + 6 * self.HOUR, self.entry + 30 * self.HOUR
        data = self.data([qwen_trade(self.entry), qwen_trade(self.entry, side="SHORT")], block_end, holdout)
        moves = rep.entry_moves(data, self.history(post, holdout))
        long_move, short_move = moves[0]["moves"]["h4"], moves[1]["moves"]["h4"]
        self.assertGreater(long_move, 0)
        self.assertAlmostEqual(long_move, -short_move)
        self.assertAlmostEqual(long_move, ((1.0002 ** 48) - 1) * 1e4, delta=1.0)
        self.assertGreater(moves[0]["cost_bp"], 0)
        text = "\n".join(rep.entry_quality_lines(moves, list(PRODUCTS)))
        self.assertIn("antes de costos", text)
        self.assertIn("Costo ida y vuelta", text)


class DiagnosticsTests(unittest.TestCase):
    def decision(self, kind, action, reason):
        letters = ["movimiento_exagerado", "tendencia", "funding_extremo", "sin_ventaja", "proteger_ganancia",
                   "cortar_perdida", "otro"]
        names = ["LARGO", "CORTO", "ESPERAR"] if kind == "flat" else ["MANTENER", "CERRAR"]
        orders = [{"order": names, "probabilities": {n: (0.9 if n == names[0] else 0.05) for n in names}},
                  {"order": names[::-1], "probabilities": {n: (0.9 if n == names[-1] else 0.05) for n in names}}]
        return {"kind": kind, "action": action, "reason": reason, "orders_json": json.dumps(orders),
                "reason_json": json.dumps({"orders": [{"order": letters}]}) if reason else None}

    def test_the_same_reason_every_time_is_flagged_as_degenerate(self):
        ds = [self.decision("flat", "LARGO", "tendencia") for _ in range(20)] + \
             [self.decision("position", "CERRAR", "sin_ventaja") for _ in range(19)] + \
             [self.decision("position", "CERRAR", "cortar_perdida")]
        div = rep.reason_diversity(ds)
        self.assertEqual(dict(div["reasons"]["Entrada"]), {"tendencia": 20})
        self.assertEqual(dict(div["letters"]["Entrada"]), {"B": 20})
        self.assertEqual(div["letters"]["Cierre de Qwen"]["D"], 19)
        text = "\n".join(rep.reason_diversity_lines(ds))
        self.assertIn("**motivo degenerado**", text)
        self.assertIn("Misma letra en los dos órdenes", text)

    def test_varied_reasons_are_not_flagged_and_few_data_is_not_flagged(self):
        names = ["movimiento_exagerado", "tendencia", "funding_extremo", "otro"]
        varied = [self.decision("flat", "LARGO", names[i % 4]) for i in range(24)]
        self.assertNotIn("**motivo degenerado**", "\n".join(rep.reason_diversity_lines(varied)))
        few = [self.decision("flat", "LARGO", "tendencia") for _ in range(4)]
        text = "\n".join(rep.reason_diversity_lines(few))
        self.assertNotIn("**motivo degenerado**", text)
        self.assertIn("pocos datos", text)

    def test_letter_bias_is_visible_when_the_option_changes_with_the_order_but_the_letter_does_not(self):
        # first listed option wins in the first order, last listed in the second -> different options, letters A and C
        div = rep.reason_diversity([self.decision("flat", "ESPERAR", None) for _ in range(10)])
        row = div["action"]["flat"]
        self.assertEqual((row["n"], row["same_option"]), (10, 0))
        div = rep.reason_diversity([dict(self.decision("flat", "ESPERAR", None), orders_json=json.dumps(
            [{"order": ["LARGO", "CORTO", "ESPERAR"], "probabilities": {"LARGO": 0.8, "CORTO": 0.1, "ESPERAR": 0.1}},
             {"order": ["CORTO", "LARGO", "ESPERAR"], "probabilities": {"LARGO": 0.1, "CORTO": 0.8, "ESPERAR": 0.1}}]))] * 10)
        row = div["action"]["flat"]
        self.assertEqual((row["same_letter"], row["same_option"]), (10, 0))

    def test_throughput_estimates_remaining_batches_from_the_measured_latency(self):
        blocks = {"b{}".format(i): {"seconds": 400.0} for i in range(10)}
        data = {"meta": {"target_blocks": 60}, "blocks": blocks, "calls": {"n": 1000, "mean_ms": 900.0},
                "runs": [{"args": json.dumps({"max_minutes": 55})}]}
        t = rep.throughput(data, CFG)
        self.assertEqual((t["remaining"], t["calls_per_block"]), (50, 100.0))
        self.assertAlmostEqual(t["remaining_minutes"], 75.0)
        self.assertEqual(t["batches"], 2)
        text = "\n".join(rep.throughput_lines(data, CFG))
        self.assertIn("900 ms por llamada", text)
        self.assertIn("2 tandas", text)
        empty = dict(data, blocks={}, calls={"n": 0, "mean_ms": None})
        self.assertIn("Todavía no hay llamadas", "\n".join(rep.throughput_lines(empty, CFG)))


class ReportOnlyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.db = os.path.join(cls.tmp, "practice.sqlite")
        qt.run_practice(MemHistory(), cls.db, ClockedProvider([0.0], entries=hashed_policy), small_cfg(), HOLDOUT, blocks=4,
                        log=lambda *a: None, clock=lambda: 0.0)

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def digest(self):
        with open(self.db, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()

    def test_the_report_has_the_new_sections_reads_the_cache_and_changes_nothing(self):
        before, cfg_hash = self.digest(), qt.config_hash(small_cfg())
        history = MemHistory()
        history.requests = []
        text = rep.build_report(self.db, small_cfg(), history=history)
        for needle in ("## ¿Qué habría pasado si no cerraba?", "## Calidad de las entradas", "## ¿Elige motivos distintos",
                       "## Velocidad de la práctica", "Diferencia", "Promedio si seguía", "Latencia medida"):
            self.assertIn(needle, text)
        self.assertIsNone(re.search(r"\bnan\b", text.lower()))
        self.assertEqual(self.digest(), before)                             # the practice database is untouched
        self.assertEqual(qt.config_hash(small_cfg()), cfg_hash)
        self.assertTrue(history.requests and all(hi <= HOLDOUT for _, _, hi in history.requests))
        self.assertEqual(rep.build_report(self.db, small_cfg(), history=MemHistory()), text)       # deterministic

    def test_without_a_candle_cache_the_report_still_works_and_creates_no_file(self):
        cache = os.path.join(self.tmp, "no-cache")
        text = rep.build_report(self.db, small_cfg(), cache_dir=cache)
        self.assertIn("## ¿Qué habría pasado si no cerraba?", text)
        self.assertFalse(os.path.exists(cache))

    def test_a_report_over_a_real_cache_directory_matches_the_in_memory_history(self):
        cache = os.path.join(self.tmp, "cache")
        for product in PRODUCTS:
            store = CandleCache(os.path.join(cache, "candles-{}.sqlite".format(product)))
            try:
                store.ensure(product, "5m", SERIES[product][0]["bucket_start"], HOLDOUT,
                             fetch=lambda p, r, lo, hi, product=product: [b for b in SERIES[product] if lo <= b["bucket_start"] < hi])
            finally:
                store.close()
            with open(os.path.join(cache, "funding-{}.json".format(product)), "w") as handle:
                json.dump([list(r) for r in MemHistory().funding(product)], handle)
        self.assertEqual(rep.build_report(self.db, small_cfg(), cache_dir=cache),
                         rep.build_report(self.db, small_cfg(), history=MemHistory()))


# --------------------------------------------------------------------------- trader v2 (no stop, no time limit)

CFG2 = qt.load_config(qt.CONFIG_PATH_V2)
V1_CONFIG_HASH = "3a6c1587820cee8942a8f356fe977d22faaa7d29340c25ac3b5d00b3305d8041"     # v1 stays reproducible


def small_cfg2():
    cfg = copy.deepcopy(CFG2)
    cfg["practice"] = dict(CFG2["practice"], block_days=1, time_bins=3, target_blocks=4, **{"from": START_DAY})
    cfg["practice_entry_threshold"] = 0.5
    return cfg


def small_cfg_v1_same_plan():
    return small_cfg()


class V2IdentityTests(unittest.TestCase):
    def test_v1_is_untouched_and_v2_is_a_different_run_with_its_own_files(self):
        self.assertEqual(qt.config_hash(CFG), V1_CONFIG_HASH)
        self.assertNotEqual(qt.config_hash(CFG2), qt.config_hash(CFG))
        self.assertEqual((CFG["version"], CFG["prompt"]["version"]), (1, 1))
        self.assertEqual((CFG2["version"], CFG2["prompt"]["version"]), (2, 2))
        self.assertEqual(CFG2["practice"], CFG["practice"])                      # same seed, period and blocks
        self.assertEqual(qt.block_plan(CFG2, HOLDOUT)[0], qt.block_plan(CFG, HOLDOUT)[0])
        self.assertNotEqual(qt.version_paths(1)[1], qt.version_paths(2)[1])
        self.assertEqual(qt.version_paths(1)[1], qt.DEFAULT_DB)
        self.assertIsNone(CFG2["guardrails"]["stop_sigma_24h"])
        self.assertIsNone(CFG2["guardrails"]["max_hold_min"])
        self.assertEqual(CFG2["guardrails"]["cooldown_min"], 15)
        self.assertEqual(CFG2["notional_usd"], "100")


class V2EngineTests(unittest.TestCase):
    def enter(self):
        warm, nxt = warm_bars()
        script = Script(lambda t_ms, step, q: {"LARGO": 1.0} if q["id"] == "trader_flat" else {"MANTENER": 1.0})
        t = trader(script, warm, cfg=CFG2)
        t.feed(walk(1, 8, start=nxt, price=float(warm[-1]["close"]), sigma=0.0001)[0])
        self.assertIsNotNone(t.position)
        return t, nxt + BAR, script

    def test_no_stop_and_no_time_limit_only_the_block_end_closes_a_position_nobody_closes(self):
        t, bucket, _ = self.enter()
        self.assertIsNone(t.position.stop_px)
        self.assertIsNone(t.position.max_hold_ms)
        price = t.c[-1]
        events = t.feed({"bucket_start": bucket, "open": repr(price), "high": repr(price), "low": repr(price * 0.5),
                         "close": repr(price * 0.6), "volume_btc": "50"})
        self.assertFalse([e for e in events if e["type"] in ("trade", "guardrail")])      # a -40 % bar: no stop
        price *= 0.6
        for i in range(1, 600):                                                  # 50 hours: no 24 h limit
            events = t.feed({"bucket_start": bucket + i * BAR, "open": repr(price), "high": repr(price * 1.0001),
                             "low": repr(price * 0.9999), "close": repr(price), "volume_btc": "1"})
            self.assertFalse([e for e in events if e["type"] in ("trade", "guardrail")])
        self.assertIsNotNone(t.position)
        trade = [e["trade"] for e in t.force_close() if e["type"] == "trade"][0]
        self.assertEqual(trade["closed_by"], "fin_de_bloque")
        self.assertLess(trade["net_bp"], -3000)
        self.assertEqual(t.cooldown_until, trade["exit_ms"] + 15 * MIN)          # the cooldown after a close stays

    def test_v2_position_state_has_after_cost_result_fee_note_time_and_move_sizes_without_hints(self):
        t, bucket, _ = self.enter()
        for i in range(0, 6):
            t.feed(walk(1, 30 + i, start=bucket + i * BAR, price=t.c[-1], sigma=0.0003)[0])
        text = t.state_text(bucket + 6 * BAR, ["cada_15_min"])
        for needle in ("Posicion: LARGO abierta hace", "Resultado si cerras ahora, ya con todos los costos:", "USD)",
                       "comision de entrada ya esta pagada", "cerrar solo agrega la de salida", "proxima 1h +-",
                       "proximas 4h +-", "Movimiento a favor de la posicion desde que abriste",
                       "No hay stop ni limite de tiempo"):
            self.assertIn(needle, text)
        for banned in ("stop automatico", "cierre obligatorio", "Distancia al stop", "deberias", "te conviene", "conviene"):
            self.assertNotIn(banned, text)
        self.assertNotRegex(text, r"20\d\d")
        self.assertNotIn("PF_", text)
        instruction = qt.questions_for(CFG2, "PF_XBTUSD")["position"]["instruction"]
        self.assertIn("el de entrada ya está pagado", instruction)
        self.assertNotIn("Hay un stop automático", instruction)

    def test_v1_state_text_is_unchanged(self):
        t = trader(Script(lambda *a: {"ESPERAR": 1.0}), warm_bars()[0], cfg=CFG)
        text = t.state_text(T0 + 3000 * BAR, ["hora_cerrada"])
        self.assertIn("stop automatico", text)
        self.assertIn("cierre obligatorio", text)

    def test_a_big_move_wakes_a_position_between_boundaries_but_forces_nothing(self):
        t, bucket, script = self.enter()
        price = t.c[-1]
        wakes = []
        # one bar that moves the price by far more than a daily volatility, landing OFF a 15-minute boundary
        for i in range(0, 4):
            bar = {"bucket_start": bucket + i * BAR, "open": repr(price), "high": repr(price * 1.05 if i == 0 else price * 1.0001),
                   "low": repr(price * 0.9999), "close": repr(price * 1.05 if i == 0 else price * 1.05), "volume_btc": "5"}
            price = price * 1.05 if i == 0 else price
            events = t.feed(bar)
            wakes += [e["wake"] for e in events if e["type"] == "decision"]
        self.assertTrue(any("movimiento_grande_en_posicion" in w for w in wakes), wakes)
        self.assertIsNotNone(t.position)                                          # Qwen said MANTENER: nothing forced
        self.assertNotIn("cerca_del_stop", [x for w in wakes for x in w])

    def test_the_reason_is_asked_in_two_option_orders_in_v2_and_in_one_in_v1(self):
        def policy(prompt, letters):
            return [{"token": l, "logprob": -0.05 if re.search(r"^{}\) (LARGO)".format(l), prompt, re.M) or
                     (not re.search(r"LARGO|MANTENER", prompt) and l == "A") else -5.0} for l in letters]
        asking = dict(CFG2, runtime=dict(CFG2["runtime"], skip_entry_reason=False))     # entry reason on (v2 default skips it)
        for cfg, reason_prompts in ((asking, 2), (CFG, 1)):
            warm, nxt = warm_bars()
            provider = llm.FakeProvider(entries=policy)
            t = trader(qt.LlmDecider(provider, cfg), warm, cfg=cfg, threshold=0.5)
            events = t.feed(walk(1, 14, start=nxt, price=float(warm[-1]["close"]))[0])
            asked = [p for p in provider.prompts if "motivo principal" in p]
            self.assertEqual(len(asked), reason_prompts)
            if reason_prompts == 2:
                firsts = [re.findall(r"^A\) (\w+)", p, re.M)[0] for p in asked]
                self.assertNotEqual(firsts[0], firsts[1])
                letters = [dict(re.findall(r"^([A-G])\) (\w+)", p, re.M)) for p in asked]
                self.assertTrue(all(letters[0][k] != letters[1][k] for k in "ABCDEFG"))      # no option keeps its letter
                self.assertEqual(len(events[0]["reason_answer"]["orders"]), 2)


class V2PracticeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.db1, cls.db2 = os.path.join(cls.tmp, "practice.sqlite"), os.path.join(cls.tmp, "practice-v2.sqlite")
        qt.run_practice(MemHistory(), cls.db1, ClockedProvider([0.0], entries=hashed_policy), small_cfg(), HOLDOUT, blocks=4,
                        log=lambda *a: None, clock=lambda: 0.0)
        with open(cls.db1, "rb") as handle:
            cls.v1_digest = hashlib.sha256(handle.read()).hexdigest()
        cls.provider2 = ClockedProvider([0.0], entries=hashed_policy)
        qt.run_practice(MemHistory(), cls.db2, cls.provider2, small_cfg2(), HOLDOUT, blocks=4, log=lambda *a: None,
                        clock=lambda: 0.0)

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_v2_runs_the_same_blocks_in_its_own_database_and_leaves_v1_alone(self):
        ids = lambda db: rows(db, "SELECT block_id, fold FROM blocks ORDER BY block_id")
        self.assertEqual(ids(self.db1), ids(self.db2))
        with open(self.db1, "rb") as handle:
            self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), self.v1_digest)
        meta1, meta2 = (dict(rows(db, "SELECT key, value FROM meta")) for db in (self.db1, self.db2))
        self.assertNotEqual(meta1["config_hash"], meta2["config_hash"])
        self.assertEqual(rows(self.db2, "SELECT DISTINCT prompt_version FROM decisions"), [(2,)])
        history = MemHistory()
        provider = ClockedProvider([0.0], entries=hashed_policy)
        cfg2 = small_cfg2()
        with self.assertRaises(qt.TraderError):                                  # a v2 run cannot be mixed into the v1 base
            qt.run_practice(history, self.db1, provider, cfg2, HOLDOUT,
                            blocks=4, log=lambda *a: None, clock=lambda: 0.0)

    def test_v2_trades_close_only_by_qwen_or_the_block_end(self):
        closed = {r[0] for r in rows(self.db2, "SELECT DISTINCT closed_by FROM trades")}
        self.assertTrue(closed)
        self.assertLessEqual(closed, {"qwen", "fin_de_bloque"}, closed)
        self.assertEqual(rows(self.db2, "SELECT COUNT(*) FROM decisions WHERE override='stop' OR override='tiempo'")[0][0], 0)
        reasons = rows(self.db2, "SELECT reason_json FROM decisions WHERE reason IS NOT NULL LIMIT 5")
        self.assertTrue(reasons and all(len(json.loads(r[0])["orders"]) == 2 for r in reasons))

    def test_report_shows_v1_against_v2_on_the_same_blocks_plus_the_counterfactual_of_v2(self):
        text = rep.build_report(self.db2, small_cfg2(), history=MemHistory(), baseline=(self.db1, small_cfg()))
        self.assertIn("## Versión 1 contra versión 2 (mismos bloques)", text)
        self.assertIn("v1 · todo", text)
        self.assertIn("v2 · validación", text)
        self.assertIn("a) Mantener hasta el fin del bloque (v2 no tiene stop", text)
        self.assertIn("Esta versión no tiene stop.", text)
        self.assertIsNone(re.search(r"\bnan\b", text.lower()))
        alone = rep.build_report(self.db2, small_cfg2(), history=MemHistory())
        self.assertNotIn("Versión 1 contra", alone)

    def test_export_labels_every_exit_decision_with_the_other_choice(self):
        out = os.path.join(self.tmp, "d2.jsonl")
        qt.export_dataset(self.db2, out, small_cfg2())
        with open(out, encoding="utf-8") as handle:
            lines = [json.loads(x) for x in handle]
        pos = [x for x in lines if x["kind"] == "position"]
        self.assertTrue(pos)
        self.assertTrue(all(x["exit_labels"] is not None for x in pos))
        flat = [x for x in lines if x["kind"] == "flat"]
        self.assertTrue(all(x["exit_labels"] is None for x in flat))
        for x in pos:
            lab = x["exit_labels"]
            self.assertAlmostEqual(lab["close_now_net_bp"], x["net_bp_now"], places=1)
            self.assertIsNotNone(lab["hold_block_end_net_bp"])
            for h in ("1h", "4h", "block_end"):
                if lab["hold_{}_net_bp".format(h)] is not None:
                    self.assertAlmostEqual(lab["hold_better_{}_bp".format(h)],
                                           lab["hold_{}_net_bp".format(h)] - lab["close_now_net_bp"], delta=0.02)
                    self.assertEqual(lab["best_" + h], "MANTENER" if lab["hold_better_{}_bp".format(h)] >= 0 else "CERRAR")

    def test_exit_label_marks_the_hold_from_the_stored_candles_and_uses_a_forced_close_that_came_first(self):
        start = T0
        closes = [100.0 + i * 0.01 for i in range(288)]                        # a day of rising closes
        block = {"start_ms": start, "end_ms": start + DAY, "closes": closes}
        entry_px = qt.D("100.05")
        snap = {"side": "LONG", "entry_ms": start + 12 * BAR, "entry_px": str(entry_px), "qty": str(qt.D(100) / entry_px),
                "trade_no": 1}
        t_ms = start + 24 * BAR
        net_now = qt.settle("PF_XBTUSD", qt.Position(side="LONG", entry_ms=snap["entry_ms"], entry_px=entry_px,
                                                      qty=qt.D(100) / entry_px), closes[23], "strategy_exit", t_ms, None,
                            qt.D(100))["net_bp"]
        lab = qt.exit_labels("PF_XBTUSD", snap, t_ms, net_now, block, None, qt.FundingLine(), qt.D(100))
        self.assertGreater(lab["hold_1h_net_bp"], lab["close_now_net_bp"])
        self.assertEqual(lab["best_1h"], "MANTENER")
        hour = (t_ms + qt.HOUR_MS - start) // BAR - 1
        want = qt.settle("PF_XBTUSD", qt.Position(side="LONG", entry_ms=snap["entry_ms"], entry_px=entry_px,
                                                   qty=qt.D(100) / entry_px), closes[hour], "strategy_exit",
                         t_ms + qt.HOUR_MS, None, qt.D(100))["net_bp"]
        self.assertAlmostEqual(lab["hold_1h_net_bp"], want, places=1)
        late = qt.exit_labels("PF_XBTUSD", snap, start + 280 * BAR, net_now, block, None, qt.FundingLine(), qt.D(100))
        self.assertIsNone(late["hold_1h_net_bp"])                              # past the block end: no label
        self.assertIsNotNone(late["hold_block_end_net_bp"])
        forced = qt.exit_labels("PF_XBTUSD", snap, t_ms, net_now, block, {"closed_by": "stop", "exit_ms": t_ms + 2 * BAR,
                                                                          "net_bp": -123.0}, qt.FundingLine(), qt.D(100))
        self.assertEqual((forced["hold_1h_net_bp"], forced["hold_1h_how"]), (-123.0, "closed_stop"))
        self.assertEqual(forced["best_block_end"], "CERRAR")

    def test_cli_defaults_to_v2_prints_which_version_runs_and_reports_both(self):
        for flag, expect in (([], "versión 2"), (["--version", "1"], "versión 1")):
            out = io.StringIO()
            with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(out):
                code = qt.main(["practice", "--offline", "--cache-dir", self.tmp, "--db", os.path.join(self.tmp, "x.sqlite"),
                                "--llama-url", "http://example.com:8088"] + flag)
            self.assertEqual(code, 2)
            self.assertIn(expect, out.getvalue())
        o1, o2 = os.path.join(self.tmp, "i1.md"), os.path.join(self.tmp, "i2.md")
        real = (qt.DEFAULT_DB, qt.DEFAULT_DB_V2)
        try:
            qt.DEFAULT_DB, qt.DEFAULT_DB_V2 = self.db1, self.db2
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = qt.main(["report", "--cache-dir", os.path.join(self.tmp, "nocache"), "--out", o1, "--out-v2", o2])
        finally:
            qt.DEFAULT_DB, qt.DEFAULT_DB_V2 = real
        self.assertEqual(code, 0, out.getvalue())
        with open(o2, encoding="utf-8") as handle:
            self.assertIn("Versión 1 contra versión 2", handle.read())
        with open(o1, encoding="utf-8") as handle:
            self.assertNotIn("Versión 1 contra", handle.read())


if __name__ == "__main__":
    unittest.main()
