"""PR 104: cold-start warm-up, served-model identity, the WAIT diagnosis tools and the duplicate counters."""

import os
import random
import sqlite3
import tempfile
import unittest

from balancita_engine.futures_llm_decisions import FakeProvider
from balancita_engine.multi_experiment import (
    Experiment, load_cold, load_incremental, required_warmup_ms, FIVE_MINUTES_MS,
)
from balancita_engine.multi_probe import probe, scenarios, summarize_stored
from balancita_engine.multi_select import QwenSelector, file_sha256, model_fingerprint, served_model
from balancita_engine.multi_signals import BUY, SELL, WAIT, default_strategies, merged_indicators
from balancita_engine.multi_store import DecisionStore

from test_futures_spec_strategy import START, _random_walk
from test_multi_strategy import FUNDING, PRODUCT, OPEN_STORES, qwen_says, tearDownModule  # noqa: F401

DDL = """
CREATE TABLE paper_futures_official_candles(
  product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL,
  revision_hash TEXT NOT NULL, known_at INTEGER NOT NULL, open_price TEXT NOT NULL,
  high_price TEXT NOT NULL, low_price TEXT NOT NULL, close_price TEXT NOT NULL,
  volume_btc TEXT NOT NULL, response_sha256 TEXT NOT NULL);
"""
MINUTES = 9000  # 1800 five-minute bars: the 96-bar log-volatility needs about 1150 bars of warm-up
LONG = _random_walk(random.Random(5), MINUTES)
CUT = START + 7000 * 60_000  # minute 7000 of the walk (a 5-minute boundary)


def market_db(folder, ones, fives, product=PRODUCT):
    path = os.path.join(folder, "market.sqlite")
    db = sqlite3.connect(path)
    db.executescript(DDL) if not os.path.getsize(path) else None
    for c in ones + fives:
        db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
            product, c["interval_ms"], c["bucket_start"], c["revision_hash"], c["known_at"],
            c["open"], c["high"], c["low"], c["close"], c["volume_btc"], "x"))
    db.commit()
    db.close()
    return path


def experiment(start, strategies=None, qwen=None, **kwargs):
    store = DecisionStore()
    OPEN_STORES.append(store)
    return Experiment(store, [PRODUCT], strategies=strategies or default_strategies(), qwen=qwen, experiment_id="w",
                      funding_periods_by_product=FUNDING, start_ms=start, **kwargs)


def digits(value, places=6):
    try:
        return format(float(value), ".{}g".format(places))
    except ValueError:
        return value


def signals_of(exp, since):
    """What a signal says: strategy, cycle, action, strength and the evidence to 6 significant digits. A recursive
    indicator seeded at another point differs only far below that, so ids (hashes of the full text) are not compared."""
    return sorted((s["product_id"], s["bucket_ms"], s["strategy_id"], s["action"], s["strength"],
                   tuple(sorted((k, digits(v)) for k, v in s["evidence"].items())))
                  for s in exp.store.signals() if s["bucket_ms"] >= since)


def trades_of(exp):
    return sorted((t["arm"], t["product_id"], t["side"], t["entry_time_ms"], t["exit_time_ms"], digits(t.get("entry_price"), 9),
                   digits(t.get("exit_price"), 9)) for t in exp.store.trades())


class WarmupTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = market_db(self.dir.name, *LONG)
        self.end = LONG[0][-1]["bucket_start"]

    def test_warmup_is_computed_from_the_declared_windows(self):
        periods = merged_indicators(default_strategies())
        need = required_warmup_ms(periods)
        self.assertGreaterEqual(need, 12 * 96 * FIVE_MINUTES_MS)  # logvol96: a recursive average of squared returns
        self.assertGreaterEqual(need, 288 * FIVE_MINUTES_MS)  # never less than a day
        self.assertGreaterEqual(required_warmup_ms({"ema": [200]}), 2400 * FIVE_MINUTES_MS)

    def test_cold_start_with_enough_history_gives_the_same_signals_as_a_running_process(self):
        continuous = experiment(CUT)
        continuous.run({PRODUCT: LONG})
        cold = experiment(CUT)
        cold.run(load_incremental(cold, self.db, [(PRODUCT, "1")], self.end))
        want = signals_of(continuous, CUT)
        self.assertTrue(want)
        self.assertEqual(signals_of(cold, CUT), want)
        self.assertEqual(trades_of(cold), trades_of(continuous))
        report = cold.report()
        self.assertTrue(report["warmup"]["products"][PRODUCT]["indicators_ready_at_first_cycle"])
        self.assertGreater(report["warmup"]["products"][PRODUCT]["bars_5m_before_start"], 0)

    def test_nothing_is_decided_during_the_warmup_and_the_first_cycle_is_the_start(self):
        cold = experiment(CUT)
        cold.run(load_incremental(cold, self.db, [(PRODUCT, "1")], self.end))
        cycles = sorted({s["bucket_ms"] for s in cold.store.signals()})
        self.assertEqual(cycles[0], CUT)  # the cycle that closes exactly at the start is decided, none before it
        self.assertTrue(cold.store.trades())
        self.assertTrue(all(t["entry_time_ms"] >= CUT for t in cold.store.trades()))

    def test_a_short_warmup_is_reported_as_not_ready(self):
        cold = experiment(START + 7000 * 60_000, warmup_ms=0)
        cold.run(load_incremental(cold, self.db, [(PRODUCT, "1")], self.end))
        self.assertFalse(cold.report()["warmup"]["products"][PRODUCT]["indicators_ready_at_first_cycle"])

    def test_incremental_reads_load_only_new_candles_and_match_a_continuous_run(self):
        half = [c for c in LONG[0] if c["bucket_start"] < CUT + 600 * 60_000]
        half5 = [c for c in LONG[1] if c["bucket_start"] < CUT + 600 * 60_000]
        folder = tempfile.mkdtemp(dir=self.dir.name)
        path = market_db(folder, half, half5)
        exp = experiment(CUT)
        exp.run(load_incremental(exp, path, [(PRODUCT, "1")], half[-1]["bucket_start"]))
        # the rest arrives later; the second read starts at the cursor, so nothing is read twice
        rest = [c for c in LONG[0] if c["bucket_start"] >= CUT + 600 * 60_000]
        rest5 = [c for c in LONG[1] if c["bucket_start"] >= CUT + 600 * 60_000]
        market_db_more(path, rest, rest5)
        candles = load_incremental(exp, path, [(PRODUCT, "1")], self.end)
        self.assertEqual(candles[PRODUCT][0][0]["bucket_start"], half[-1]["bucket_start"] + 60_000)
        self.assertGreater(len(candles[PRODUCT][0]), 0)
        exp.run(candles)
        self.assertEqual(exp.already_processed, 0)
        self.assertEqual(exp.duplicate_events, 0)
        self.assertEqual(exp.gaps, [])
        whole = experiment(CUT)
        whole.run({PRODUCT: LONG})
        self.assertEqual(trades_of(exp), trades_of(whole))
        self.assertEqual(signals_of(exp, CUT), signals_of(whole, CUT))

    def test_a_hole_between_reads_is_reported_not_bridged_silently(self):
        first = [c for c in LONG[0] if c["bucket_start"] < CUT + 600 * 60_000]
        first5 = [c for c in LONG[1] if c["bucket_start"] < CUT + 600 * 60_000]
        path = market_db(tempfile.mkdtemp(dir=self.dir.name), first, first5)
        exp = experiment(CUT)
        exp.run(load_incremental(exp, path, [(PRODUCT, "1")], first[-1]["bucket_start"]))
        later = [c for c in LONG[0] if c["bucket_start"] >= CUT + 700 * 60_000]
        later5 = [c for c in LONG[1] if c["bucket_start"] >= CUT + 700 * 60_000]
        market_db_more(path, later, later5)
        exp.run(load_incremental(exp, path, [(PRODUCT, "1")], self.end))
        self.assertEqual(len(exp.gaps), 1)
        self.assertEqual(exp.gaps[0]["from_ms"], first[-1]["bucket_start"] + 60_000)
        self.assertEqual(exp.gaps[0]["to_ms"], later[0]["bucket_start"])
        self.assertEqual(exp.report()["data_gaps"], exp.gaps)

    def test_counters_tell_a_reload_from_a_real_duplicate(self):
        exp = experiment(CUT)
        exp.run({PRODUCT: LONG})
        self.assertEqual((exp.already_processed, exp.duplicate_events), (0, 0))
        exp.run({PRODUCT: LONG})  # a reload: the feeder skips what it consumed
        self.assertEqual(exp.already_processed, len(LONG[0]))
        self.assertEqual(exp.duplicate_events, 0)
        before = exp.ledger_hash()
        frame = (LONG[0][-1]["bucket_start"], {"ready": True}, None, {"ready": True}, "unknown")
        exp.on_frame(PRODUCT, frame)  # the same closed candle delivered to the experiment again
        self.assertEqual(exp.duplicate_events, 1)
        self.assertEqual(exp.ledger_hash(), before)
        report = exp.report()
        self.assertEqual((report["already_processed_candles"], report["duplicate_events"]),
                         (len(LONG[0]), 1))
        self.assertNotIn("duplicates_ignored", report)


def market_db_more(path, ones, fives):
    db = sqlite3.connect(path)
    for c in ones + fives:
        db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
            PRODUCT, c["interval_ms"], c["bucket_start"], c["revision_hash"], c["known_at"],
            c["open"], c["high"], c["low"], c["close"], c["volume_btc"], "x"))
    db.commit()
    db.close()


class ModelIdentityTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def gguf(self, name, content):
        path = os.path.join(self.dir.name, name)
        with open(path, "wb") as handle:
            handle.write(content)
        return path

    def provider(self, path, alias="Qwen3-4B-Q8_0", build="b1"):
        info = {"model_ref": "unsloth/Qwen3.5-4B-GGUF:Q8_0",
                "props": {"model_path": path, "model_alias": alias, "build_info": build}}
        return FakeProvider(entries=qwen_says("sell"), info=info)

    def test_the_served_file_is_recorded_with_size_and_hash(self):
        path = self.gguf("Qwen3-4B-Q8_0.gguf", b"weights-a")
        found = served_model(self.provider(path))
        self.assertEqual(found["model_file"], "Qwen3-4B-Q8_0.gguf")
        self.assertEqual(found["size_bytes"], 9)
        self.assertEqual(found["sha256"], file_sha256(path))
        self.assertEqual(found["configured_ref"], "unsloth/Qwen3.5-4B-GGUF:Q8_0")  # the label is kept, not trusted
        self.assertTrue(model_fingerprint(found).startswith("sha256:"))

    def test_unreadable_file_still_gets_a_file_based_fingerprint_and_unknown_is_marked(self):
        remote = served_model(self.provider("/does/not/exist/Qwen3-4B-Q8_0.gguf"))
        self.assertIsNone(remote["sha256"])
        self.assertTrue(model_fingerprint(remote).startswith("file:"))
        self.assertTrue(model_fingerprint(served_model(FakeProvider())).startswith("unverified:"))

    def test_decision_ids_and_fingerprint_change_with_the_served_model(self):
        a = QwenSelector(self.provider(self.gguf("a.gguf", b"weights-a")))
        b = QwenSelector(self.provider(self.gguf("b.gguf", b"weights-b")))
        self.assertNotEqual(a.identity_key(), b.identity_key())
        ea, eb = experiment(START, qwen=a), experiment(START, qwen=b)
        self.assertNotEqual(ea.fingerprint(), eb.fingerprint())
        self.assertIn(a.model_fingerprint(), a.identity_key())

    def test_a_checkpoint_of_another_model_is_rejected_and_decisions_are_not_reused(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "multi.sqlite")
            first = Experiment(DecisionStore(path), [PRODUCT], strategies=default_strategies(),
                               qwen=QwenSelector(self.provider(self.gguf("a.gguf", b"weights-a"))),
                               experiment_id="w", funding_periods_by_product=FUNDING, start_ms=START)
            first.run({PRODUCT: LONG})
            first.save_checkpoint()
            first.store.close()
            other = Experiment(DecisionStore(path), [PRODUCT], strategies=default_strategies(),
                               qwen=QwenSelector(self.provider(self.gguf("b.gguf", b"weights-b"))),
                               experiment_id="w", funding_periods_by_product=FUNDING, start_ms=START)
            self.assertEqual(other.load_checkpoint(), "configuration_changed")
            other.store.close()

    def test_a_model_swapped_under_a_running_selector_waits(self):
        path = self.gguf("a.gguf", b"weights-a")
        provider = self.provider(path)
        selector = QwenSelector(provider)
        signals, _ = scenarios()["coherent_sell_3_of_3"]
        self.assertEqual(selector.select("PF_XBTUSD", 1, signals, {})["action"], SELL)
        provider.info["props"]["model_path"] = self.gguf("b.gguf", b"weights-b")
        answer = selector.select("PF_XBTUSD", 2, signals, {})
        self.assertEqual((answer["action"], answer["reason"]), (WAIT, "model_changed"))

    def test_the_decision_keeps_the_per_order_probabilities_and_the_served_model(self):
        selector = QwenSelector(self.provider(self.gguf("a.gguf", b"weights-a")))
        signals, _ = scenarios()["coherent_sell_3_of_3"]
        detail = selector.select("PF_XBTUSD", 1, signals, {})["detail"]
        self.assertEqual(len(detail["order_probabilities"]), 3)
        self.assertEqual(detail["model"]["model_file"], "a.gguf")
        self.assertEqual(detail["model"]["fingerprint"], selector.model_fingerprint())


class DiagnosisTests(unittest.TestCase):
    def test_the_selector_can_choose_buy_and_sell_on_coherent_strong_signals(self):
        for action, name in (("sell", "coherent_sell_3_of_3"), ("buy", "coherent_buy_3_of_3"),
                             ("sell", "single_strong_sell")):
            selector = QwenSelector(FakeProvider(entries=qwen_says(action)))
            signals, _ = scenarios()[name]
            chosen = selector.select("PF_XBTUSD", 1, signals, {"regime": "range"})
            self.assertEqual(chosen["action"], action.upper(), name)
            self.assertIsNotNone(chosen["signal_id"])

    def test_it_cannot_trade_a_side_no_strategy_backs(self):
        selector = QwenSelector(FakeProvider(entries=qwen_says("buy")))
        signals, _ = scenarios()["coherent_sell_3_of_3"]
        chosen = selector.select("PF_XBTUSD", 1, signals, {})
        self.assertEqual((chosen["action"], chosen["reason"]), (WAIT, "no_backing_signal"))

    def test_probe_reports_every_scenario_with_per_order_probabilities(self):
        rows = probe(QwenSelector(FakeProvider(entries=qwen_says("sell"))))
        self.assertEqual({r["scenario"] for r in rows}, set(scenarios()))
        asked = [r for r in rows if r["probabilities"]]
        self.assertTrue(asked)
        self.assertTrue(all(len(r["by_order"]) == 3 for r in asked))

    def test_stored_selections_are_summarized_with_signals_and_probabilities(self):
        exp = experiment(START + 300 * 60_000, qwen=QwenSelector(FakeProvider(entries=qwen_says("wait"))))
        exp.run({PRODUCT: LONG})
        summary = summarize_stored(exp.store)
        self.assertEqual(summary["totals"]["selections"], len(summary["selections"]))
        for row in summary["selections"]:
            self.assertEqual(row["action"], WAIT)
            self.assertEqual(len(row["by_order"]), 3)
            self.assertTrue(row["signals"])


if __name__ == "__main__":
    unittest.main()
