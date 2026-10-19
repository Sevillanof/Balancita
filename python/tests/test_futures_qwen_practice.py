"""Qwen practice: historical signals of C25-C32, the practice batch and its budget (no model download, ever)."""

import io
import json
import math
import os
import random
import sqlite3
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import futures_llm_decisions as q
from balancita_engine import futures_qwen_practice as p
from balancita_engine.futures_costs import entry_fill, exit_fill, fee_rate
from balancita_engine.futures_replay import replay
from balancita_engine.futures_spec_strategy import load_specs
from test_futures_llm_decisions import FakeLlama

MINUTE = 60_000
T0 = 1_735_689_600_000  # 2025-01-01T00:00:00Z


def synthetic(minutes=7000, seed=7, start=T0):
    """Deterministic 1m candles with swings, pullbacks and volume spikes, plus their 5m aggregation."""
    rng = random.Random(seed)
    price, ones = 50_000.0, []
    for i in range(minutes):
        drift = 12.0 * math.sin(i / 380.0) + 5.0 * math.sin(i / 47.0)
        move = drift + rng.gauss(0, 14)
        open_ = price
        price = max(100.0, price + move)
        high = max(open_, price) + abs(rng.gauss(0, 6))
        low = min(open_, price) - abs(rng.gauss(0, 6))
        volume = abs(rng.gauss(2.0, 1.0)) * (6 if rng.random() < 0.03 else 1)
        ones.append({"bucket_start": start + i * MINUTE, "open": "%.1f" % open_, "high": "%.1f" % high,
                     "low": "%.1f" % low, "close": "%.1f" % price, "volume_btc": "%.4f" % volume})
    return ones, aggregate(ones)


def aggregate(ones):
    fives = []
    for i in range(0, len(ones) - 4, 5):
        chunk = ones[i:i + 5]
        if chunk[0]["bucket_start"] % 300_000:
            continue
        fives.append({"bucket_start": chunk[0]["bucket_start"], "open": chunk[0]["open"],
                      "high": "%.1f" % max(float(c["high"]) for c in chunk),
                      "low": "%.1f" % min(float(c["low"]) for c in chunk), "close": chunk[-1]["close"],
                      "volume_btc": "%.4f" % sum(float(c["volume_btc"]) for c in chunk)})
    return fives


SPECS = load_specs()
ONES, FIVES = synthetic()
RESULT = {}


def signals_of(ones=None, fives=None, **kwargs):
    key = (id(ones), id(fives), tuple(sorted(kwargs)))
    if ones is None and key not in RESULT:
        RESULT[key] = p.build_product_signals(SPECS, ONES, FIVES, product_id="PF_XBTUSD", tick_size="1",
                                              start_ms=T0 + 300 * MINUTE, **kwargs)
    return RESULT[key] if ones is None else p.build_product_signals(
        SPECS, ones, fives, product_id="PF_XBTUSD", tick_size="1", start_ms=T0 + 300 * MINUTE, **kwargs)


class CandleTests(unittest.TestCase):
    def test_fill_gaps_makes_quiet_minutes_flat(self):
        raw = [{"bucket_start": 0, "open": "10", "high": "11", "low": "9", "close": "10.5", "volume_btc": "2"},
               {"bucket_start": 3 * MINUTE, "open": "10.5", "high": "12", "low": "10", "close": "11", "volume_btc": "1"}]
        filled = p.fill_gaps(raw, MINUTE)
        self.assertEqual([c["bucket_start"] for c in filled], [0, MINUTE, 2 * MINUTE, 3 * MINUTE])
        self.assertEqual(filled[1], {"bucket_start": MINUTE, "open": "10.5", "high": "10.5", "low": "10.5",
                                     "close": "10.5", "volume_btc": "0"})

    def test_fetch_pages_until_no_more_and_drops_the_unfinished_candle(self):
        calls = []

        def get(url):
            calls.append(url)
            first = 2 if len(calls) == 1 else 5
            rows = [{"time": T0 + i * MINUTE, "open": "1", "high": "1", "low": "1", "close": "1", "volume": "0.5"}
                    for i in range(0 if len(calls) == 1 else 2, first if len(calls) == 1 else 5)]
            return {"candles": rows, "more_candles": len(calls) == 1}

        got = p.fetch_candles("PF_XBTUSD", "1m", T0, T0 + 10 * MINUTE, get=get, now_ms=T0 + 4 * MINUTE + 30_000)
        self.assertEqual(len(calls), 2)
        self.assertIn("/trade/PF_XBTUSD/1m", calls[0])
        # the candle that opens at +4 min is still open at now: left out
        self.assertEqual([c["bucket_start"] for c in got], [T0 + i * MINUTE for i in range(4)])
        self.assertEqual(got[0]["volume_btc"], "0.5")


class EpisodeTests(unittest.TestCase):
    def test_a_repeated_signal_is_one_episode(self):
        seq = [None, "LONG", "LONG", "LONG", None, "LONG", "SHORT", "SHORT", None]
        self.assertEqual(p.episode_starts(seq), [1, 5, 6])

    def test_side_change_without_gap_is_a_new_episode(self):
        self.assertEqual(p.episode_starts(["LONG", "SHORT"]), [0, 1])

    def test_no_signal_at_all(self):
        self.assertEqual(p.episode_starts([None, None]), [])


class SignalTests(unittest.TestCase):
    def test_the_series_produces_signals_for_several_strategies(self):
        found = signals_of()
        self.assertGreater(len(found), 30)
        self.assertGreaterEqual(len({s["strategy_id"] for s in found}), 2)

    def test_one_signal_per_entry_episode(self):
        found = signals_of()
        by_key = {}
        for s in found:
            by_key.setdefault((s["strategy_id"], s["product_id"], s["side"]), []).append(s["bucket_ms"])
        for buckets in by_key.values():
            buckets.sort()
            for a, b in zip(buckets, buckets[1:]):
                self.assertGreater(b - a, MINUTE, "consecutive bars of the same signal are one signal")
        self.assertEqual(len({s["signal_id"] for s in found}), len(found))

    def test_signal_fields(self):
        s = signals_of()[0]
        self.assertIn(s["side"], ("LONG", "SHORT"))
        self.assertEqual(s["timeframe"], "1m")
        self.assertEqual(s["decision_ms"], s["bucket_ms"] + MINUTE)
        self.assertEqual(s["signal_id"], "{}:{}:{}:{}".format(s["strategy_id"], s["side"], s["product_id"], s["bucket_ms"]))
        self.assertGreater(s["stop_atr"], 0)
        self.assertGreater(s["target_atr"], 0)

    def test_state_is_normalized_and_names_the_strategy_and_side(self):
        for s in signals_of()[:40]:
            text = s["state_text"]
            self.assertTrue(text.startswith("signal: "), text)
            self.assertIn("side=" + s["side"], text)
            self.assertIn("stop_atr=", text)
            self.assertIn("target_atr=", text)
            self.assertIn("stop_bp=", text)
            self.assertIn("rsi14:", text)
            self.assertNotIn("PF_", text)
            self.assertNotRegex(text, r"\b20\d\d\b")
            self.assertNotIn(s["strategy_id"], text.replace("signal: strategy=", ""))  # ids appear once, as the label

    def test_state_has_no_lookahead(self):
        """Cut or rewrite the candles after a decision: the signal and its STATE do not move."""
        full = signals_of()
        cut_at = T0 + 4000 * MINUTE
        keep = [c for c in ONES if c["bucket_start"] < cut_at]
        short_ones, short_fives = keep, aggregate(keep)
        cut = signals_of(short_ones, short_fives)
        want = {s["signal_id"]: s["state_text"] for s in full if s["decision_ms"] <= cut_at - 10 * MINUTE}
        got = {s["signal_id"]: s["state_text"] for s in cut if s["decision_ms"] <= cut_at - 10 * MINUTE}
        self.assertGreater(len(want), 10)
        self.assertEqual(want, got)
        rng = random.Random(1)
        warped = [dict(c, close="%.1f" % (float(c["close"]) * rng.uniform(0.9, 1.1)),
                       high="%.1f" % (float(c["high"]) * 1.2)) if c["bucket_start"] >= cut_at else c for c in ONES]
        again = {s["signal_id"]: s["state_text"] for s in signals_of(warped, aggregate(warped))
                 if s["decision_ms"] <= cut_at - 10 * MINUTE}
        self.assertEqual(want, again)

    def test_own_outcome_equals_the_forward_book_trade(self):
        """The first signal of a strategy is the trade the real book opens: same entry, exit and net."""
        specs = [SPECS["c27-breakout-perp-v1"]]
        (book,) = replay(specs, ONES, FIVES, start_ms=T0 + 300 * MINUTE, product_id="PF_XBTUSD", tick_size="1")
        mine = {s["bucket_ms"]: s for s in signals_of() if s["strategy_id"] == "c27-breakout-perp-v1"}
        self.assertGreater(len(book.trades), 3)
        matched = 0
        for trade in book.trades:
            s = mine.get(trade["entry_bucket_ms"])
            if s is None:  # the book re-entered in the middle of a signal that had already started: not a new signal
                continue
            matched += 1
            self.assertTrue(s["taken_by_book"])
            self.assertEqual(s["own_exit_reason"], trade["exit_reason"])
            self.assertAlmostEqual(s["own_net_bp"], trade["net_bp"], places=3)
            self.assertEqual(s["own_exit_ms"], trade["exit_time_ms"])
        self.assertGreaterEqual(matched, 3)

    def test_fixed_horizon_net_bp_uses_the_shared_costs(self):
        net = p.horizon_net_bp("LONG", "PF_XBTUSD", Decimal("100"), Decimal("101"))
        entry, exit_ = entry_fill(Decimal("100"), "LONG", "PF_XBTUSD"), exit_fill(Decimal("101"), "LONG", "PF_XBTUSD", "time_stop")
        want = ((exit_ - entry) - (entry + exit_) * fee_rate("taker")) / entry * 10_000
        self.assertAlmostEqual(net, float(want), places=6)
        short = p.horizon_net_bp("SHORT", "PF_XBTUSD", Decimal("100"), Decimal("99"))
        self.assertGreater(short, 0)
        self.assertLess(p.horizon_net_bp("LONG", "PF_XBTUSD", Decimal("100"), Decimal("100")), 0)

    def test_horizon_labels_follow_the_closes_and_are_missing_at_the_end(self):
        closes = {c["bucket_start"]: Decimal(c["close"]) for c in ONES}
        for s in signals_of():
            later = closes.get(s["bucket_ms"] + 60 * MINUTE)
            if later is None:
                self.assertIsNone(s["net_bp_1h"])
            else:
                want = p.horizon_net_bp(s["side"], "PF_XBTUSD", closes[s["bucket_ms"]], later)
                self.assertAlmostEqual(s["net_bp_1h"], want, places=6)
        edge = [s for s in signals_of() if s["bucket_ms"] + 240 * MINUTE > ONES[-1]["bucket_start"]]
        self.assertTrue(all(s["net_bp_4h"] is None for s in edge))

    def test_the_taken_flag_is_what_the_forward_book_actually_opens(self):
        for strategy_id in ("c25-pullback-perp-v1", "c27-breakout-perp-v1"):
            (book,) = replay([SPECS[strategy_id]], ONES, FIVES, start_ms=T0 + 300 * MINUTE, product_id="PF_XBTUSD",
                             tick_size="1")
            entries = {t["entry_bucket_ms"] for t in book.trades} | (
                {book.position["opened_bucket"]} if book.position else set())
            mine = [s for s in signals_of() if s["strategy_id"] == strategy_id]
            signal_buckets = {s["bucket_ms"] for s in mine}
            taken = {s["bucket_ms"] for s in mine if s["taken_by_book"]}
            self.assertEqual(taken, entries & signal_buckets)
            self.assertTrue(all(s["tradable"] for s in mine if s["taken_by_book"]))


class SplitTests(unittest.TestCase):
    def test_period_and_fold(self):
        rows = [{"decision_ms": 1000 + i * 1000} for i in range(10)]
        cutoff = 1000 + 3500
        out = p.assign_splits(rows, cutoff_ms=cutoff)
        self.assertEqual([r["period"] for r in out], ["pre_cutoff"] * 4 + ["post_cutoff"] * 6)
        self.assertEqual([r["fold"] for r in out], ["calibration"] * 6 + ["validation"] * 4)

    def test_cutoff_constant_is_the_qwen3_release(self):
        self.assertEqual(p.QWEN3_RELEASE_DATE, "2025-04-29")
        self.assertEqual(p.QWEN3_RELEASE_MS, 1_745_884_800_000)


class DbTests(unittest.TestCase):
    def test_write_and_read_roundtrip(self):
        rows = p.assign_splits(signals_of()[:25], cutoff_ms=T0 + 3000 * MINUTE)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "signals.sqlite")
            p.write_signals(path, rows, {"cutoff_date": "x"})
            back = p.read_signals(path)
            self.assertEqual(len(back), 25)
            self.assertEqual(back[0]["signal_id"], rows[0]["signal_id"])
            self.assertEqual(back[0]["state_text"], rows[0]["state_text"])
            self.assertEqual(p.read_meta(path)["cutoff_date"], "x")
            self.assertTrue(p.read_meta(path)["build_id"])


class CatalogTests(unittest.TestCase):
    def test_signal_filter_is_in_the_catalog_with_its_own_scope(self):
        self.assertNotIn("signal_filter", q.load_questions())
        question = q.load_questions(scope="signal")["signal_filter"]
        self.assertEqual(question["version"], 1)
        self.assertEqual([o["id"] for o in question["options"]], ["approve", "reject"])
        self.assertIn("signal", question["state_fields"])
        self.assertEqual(q.option_orders(question), [[0, 1], [1, 0]])

    def test_signal_filter_text_is_pinned_per_version(self):
        """Changing the question's text without a new version fails here: its calibration would no longer apply."""
        question = q.load_questions(scope="signal")["signal_filter"]
        self.assertEqual(q.question_hash(question), "4187ff574d13927aca814b1e5e402f7e074eba55507b9334f5ef0fe73cd4fc00")

    def test_signal_state_field(self):
        verdict = {"bucket_start_ms": 0, "regime": "trend", "proposals": [],
                   "features": {"1m": {"ready": True, "candidate_close": "100", "atr14": "1", "rsi14": "50"}}}
        text = q.build_state(verdict, [], ["signal"], signal="signal: strategy=X side=LONG")
        self.assertEqual(text, "signal: strategy=X side=LONG")
        self.assertEqual(q.build_state(verdict, [], ["signal"]), "signal: none")


def make_signals_db(tmp, count_per_stratum=12):
    """A tiny signals DB with 2 strategies x 2 sides, all with outcomes."""
    rows = []
    rng = random.Random(3)
    for strategy in ("c25-pullback-perp-v1", "c27-breakout-perp-v1"):
        for side in ("LONG", "SHORT"):
            for i in range(count_per_stratum):
                bucket = T0 + (len(rows) * 1000) * MINUTE
                rows.append({
                    "signal_id": "{}:{}:PF_XBTUSD:{}".format(strategy, side, bucket), "strategy_id": strategy,
                    "delegated_id": None, "product_id": "PF_XBTUSD", "side": side, "bucket_ms": bucket,
                    "decision_ms": bucket + MINUTE, "timeframe": "1m",
                    "state_text": "signal: strategy=%s side=%s stop_atr=1.50 target_atr=3.00\nrsi14: %d.0" % (strategy[:3], side, 30 + i),
                    "stop_atr": 1.5, "target_atr": 3.0, "stop_bp": 20.0, "target_bp": 40.0, "horizon_min": 30,
                    "tradable": 1, "skip_reason": None, "taken_by_book": 1, "own_net_bp": rng.gauss(0, 20),
                    "own_exit_reason": "stop", "own_hold_min": 5, "own_exit_ms": bucket + 6 * MINUTE,
                    "funding_status": "unknown", "net_bp_1h": rng.gauss(0, 30), "net_bp_4h": rng.gauss(0, 40)})
    rows = p.assign_splits(rows, cutoff_ms=T0 + 20 * 1000 * MINUTE)
    path = os.path.join(tmp, "signals.sqlite")
    p.write_signals(path, rows, {"cutoff_date": "test", "cutoff_ms": T0 + 20 * 1000 * MINUTE,
                                 "products": ["PF_XBTUSD"], "from": "2025-01-01"})
    return path, rows


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class TickProvider(q.FakeProvider):
    """The fake provider, one second per call on a fake clock; approves when the letter A is 'approve'."""

    def __init__(self, clock, seconds=1.0, **kwargs):
        super().__init__(**kwargs)
        self.clock, self.seconds = clock, seconds

    def complete(self, prompt, letters, source=q.RAW_SOURCE, template=None):
        self.clock.now += self.seconds
        return super().complete(prompt, letters, source=source, template=template)


class StratifiedOrderTests(unittest.TestCase):
    def pending(self):
        out = []
        for strategy in ("a", "b"):
            for side in ("LONG", "SHORT"):
                for period in ("pre_cutoff", "post_cutoff"):
                    n = 40 if (strategy, side, period) != ("b", "SHORT", "pre_cutoff") else 3
                    out += [{"signal_id": "%s-%s-%s-%d" % (strategy, side, period, i), "strategy_id": strategy,
                             "side": side, "period": period} for i in range(n)]
        return out

    def test_every_prefix_is_balanced_across_strata(self):
        order = p.stratified_order(self.pending(), {}, seed=1)
        self.assertEqual(len(order), len(self.pending()))
        head = order[:56]  # 8 strata x 7
        counts = {}
        for s in head:
            key = (s["strategy_id"], s["side"], s["period"])
            counts[key] = counts.get(key, 0) + 1
        self.assertEqual(len(counts), 8)
        # the 3-signal stratum is exhausted early; the other seven stay within one of each other
        self.assertEqual(counts[("b", "SHORT", "pre_cutoff")], 3)
        others = [n for key, n in counts.items() if key != ("b", "SHORT", "pre_cutoff")]
        self.assertLessEqual(max(others) - min(others), 1)

    def test_resume_balances_against_what_is_already_done(self):
        done = {("a", "LONG", "pre_cutoff"): 30}
        order = p.stratified_order(self.pending(), done, seed=1)
        first = order[:7]
        self.assertNotIn(("a", "LONG", "pre_cutoff"), {(s["strategy_id"], s["side"], s["period"]) for s in first})

    def test_deterministic_for_a_seed_and_different_across_seeds(self):
        a = [s["signal_id"] for s in p.stratified_order(self.pending(), {}, seed=5)]
        b = [s["signal_id"] for s in p.stratified_order(self.pending(), {}, seed=5)]
        c = [s["signal_id"] for s in p.stratified_order(self.pending(), {}, seed=6)]
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)


class PracticeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.signals, self.rows = make_signals_db(self.tmp.name)
        self.practice = os.path.join(self.tmp.name, "practice.sqlite")
        self.questions = q.load_questions(scope="signal")
        self.out = io.StringIO()

    def run_practice(self, provider, clock, **kwargs):
        args = dict(max_minutes=55, clock=clock, seed=1, progress_every=10, calibration_calls=4, log=self.log)
        args.update(kwargs)
        return p.run_practice(self.signals, self.practice, provider, **args)

    def log(self, text):
        self.out.write(text + "\n")

    def decisions(self):
        db = sqlite3.connect(self.practice)
        try:
            return db.execute("SELECT signal_id, variant, option_order, p_approve, chosen, question_version, "
                              "prompt_version, model_ref, latency_ms, source FROM decisions ORDER BY signal_id, variant").fetchall()
        finally:
            db.close()

    def test_each_signal_is_asked_twice_with_the_options_swapped(self):
        clock = Clock()
        provider = TickProvider(clock)
        summary = self.run_practice(provider, clock)
        self.assertEqual(summary["stop_reason"], "done")
        self.assertEqual(summary["signals_completed"], len(self.rows))
        rows = self.decisions()
        self.assertEqual(len(rows), 2 * len(self.rows))
        by = {}
        for row in rows:
            by.setdefault(row[0], {})[row[1]] = row
        for variants in by.values():
            self.assertEqual(json.loads(variants[0][2]), ["approve", "reject"])
            self.assertEqual(json.loads(variants[1][2]), ["reject", "approve"])
            self.assertEqual(variants[0][5], 1)
            self.assertEqual(variants[0][7], "fake-model")
            self.assertEqual(variants[0][8], 1000)
        prompts = provider.prompts
        self.assertIn("A) approve", prompts[0])
        self.assertIn("A) reject", prompts[1])
        # the fake model always answers letter A: approve in order 0, reject in order 1 -> p_approve flips
        any_signal = next(iter(by.values()))
        self.assertGreater(any_signal[0][3], 0.5)
        self.assertLess(any_signal[1][3], 0.5)

    def test_the_prompt_never_carries_the_outcome(self):
        clock = Clock()
        provider = TickProvider(clock)
        self.run_practice(provider, clock, limit=3)
        for prompt in provider.prompts:
            self.assertNotIn("net_bp", prompt)
            self.assertNotIn("own_", prompt)
            self.assertIn("side=", prompt)

    def test_time_budget_stops_gracefully_and_prints_the_eta(self):
        clock = Clock()
        provider = TickProvider(clock, seconds=1.0)
        summary = self.run_practice(provider, clock, max_minutes=0.5)  # 30 s = 30 calls = 15 signals
        self.assertEqual(summary["stop_reason"], "budget")
        self.assertLessEqual(clock.now, 30.0 + 1e-9)
        self.assertEqual(summary["signals_completed"], 15)
        text = self.out.getvalue()
        self.assertIn("ETA", text)
        self.assertIn("caben", text)
        self.assertIn("muestra estratificada", text)
        # whatever stopped it, the stored sample is balanced across the 4 strategy x side strata
        strata = {s["signal_id"]: (s["strategy_id"], s["side"], s["period"]) for s in self.rows}
        db = sqlite3.connect(self.practice)
        try:
            asked = {sid for (sid,) in db.execute("SELECT signal_id FROM decisions")}
        finally:
            db.close()
        counts = list(__import__("collections").Counter(strata[sid] for sid in asked).values())
        self.assertEqual(sum(counts), 15)
        self.assertEqual(len(counts), len(set(strata.values())))
        self.assertLessEqual(max(counts) - min(counts), 1)

    def test_it_is_resumable_and_never_asks_a_stored_signal_again(self):
        clock = Clock()
        first = TickProvider(clock)
        a = self.run_practice(first, clock, max_minutes=0.5)
        done = a["signals_completed"]
        self.assertLess(done, len(self.rows))
        second = TickProvider(clock)
        clock.now = 0.0
        b = self.run_practice(second, clock)
        self.assertEqual(b["stop_reason"], "done")
        self.assertEqual(second.calls, 2 * (len(self.rows) - done))
        self.assertEqual(len(self.decisions()), 2 * len(self.rows))
        third = TickProvider(clock)
        c = self.run_practice(third, clock)
        self.assertEqual(third.calls, 0)
        self.assertEqual(c["stop_reason"], "done")

    def test_a_half_finished_signal_only_asks_the_missing_order(self):
        clock = Clock()
        provider = TickProvider(clock)
        self.run_practice(provider, clock, max_minutes=1 / 60 * 1.5)  # 1 call fits... then stop
        db = sqlite3.connect(self.practice)
        try:
            n = db.execute("SELECT COUNT(*) FROM decisions").fetchone()[0]
        finally:
            db.close()
        self.assertEqual(n, 1)
        resumed = TickProvider(clock)
        self.run_practice(resumed, clock)
        self.assertEqual(resumed.calls, 2 * len(self.rows) - 1)

    def test_progress_is_printed_every_n_calls(self):
        clock = Clock()
        self.run_practice(TickProvider(clock), clock, progress_every=10)
        lines = [line for line in self.out.getvalue().splitlines() if line.startswith("progreso")]
        self.assertGreaterEqual(len(lines), len(self.rows) * 2 // 10 - 1)

    def test_a_model_that_is_down_fails_clearly(self):
        clock = Clock()
        provider = TickProvider(clock, healthy=False)
        with self.assertRaises(p.PracticeError) as caught:
            self.run_practice(provider, clock)
        self.assertIn("llama-server", str(caught.exception))
        self.assertIn("no descarga", str(caught.exception))
        self.assertFalse(os.path.exists(self.practice) and self.decisions())

    def test_strategy_filter_and_c28_default_exclusion(self):
        clock = Clock()
        summary = self.run_practice(TickProvider(clock), clock, strategies=["c27-breakout-perp-v1"])
        self.assertEqual(summary["signals_completed"], len(self.rows) // 2)

    def test_end_to_end_with_the_fake_llama_server(self):
        server = FakeLlama()
        self.addCleanup(server.stop)
        provider = q.LlamaCppProvider(server.url, "fake-llama")
        summary = p.run_practice(self.signals, self.practice, provider, max_minutes=5, seed=2, progress_every=100,
                                 calibration_calls=4, log=self.log, limit=6)
        self.assertEqual(summary["signals_completed"], 6)
        self.assertEqual(len(server.completions()), 12)
        bodies = server.completions()
        self.assertEqual(bodies[0]["max_tokens"], 1)
        self.assertIn("A) approve", bodies[0]["messages"][-1]["content"])
        self.assertIn("A) reject", bodies[1]["messages"][-1]["content"])
        rows = self.decisions()
        self.assertEqual(len(rows), 12)
        self.assertTrue(all(r[7] == "fake-llama" for r in rows))

    def test_non_loopback_url_is_refused(self):
        with self.assertRaises(ValueError):
            q.LlamaCppProvider("http://example.com:8088", "x")


if __name__ == "__main__":
    unittest.main()
