"""Gate instrumentation: a traced run books exactly what a plain run books, and explains it.

No network: the candles are the synthetic ones of ``test_strategy_gate``.
"""

import gzip
import json
import os
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import gate_trace as t
from balancita_engine import strategy_gate as g
from balancita_engine.futures_costs import fee_rate
from balancita_engine.futures_funding_context import FundingContext, funding_periods
from balancita_engine.futures_simulator import DEFAULT_PERIODS, Book, frames, merge_periods
from balancita_engine.futures_spec_strategy import declared_indicators
from test_strategy_gate import FROM, HOLDOUT, ONES, FIVES, SPECS, Provider, run, CFG

SPEC_IDS = ("c25-pullback-perp-v1", "c27-breakout-perp-v1")


def _manifest(folder):
    with open(os.path.join(folder, "manifest.json"), encoding="utf-8") as handle:
        return json.load(handle)


def feed(spec_id, book_class):
    spec = SPECS[spec_id]
    periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
    book = book_class(spec, product_id="PF_XBTUSD", tick_size="0.5")
    for frame in frames(ONES, FIVES, periods, None):
        if frame[0] >= FROM:
            book.on_frame(*frame)
    return book


class EquivalenceTests(unittest.TestCase):
    def test_a_traced_book_books_the_same_trades_fills_and_decisions(self):
        for spec_id in SPEC_IDS:
            plain, traced = feed(spec_id, Book), feed(spec_id, t.TracedBook)
            self.assertGreater(len(plain.trades), 3, spec_id)
            self.assertEqual(plain.trades, traced.trades)
            self.assertEqual(plain.fills, traced.fills)
            self.assertEqual(plain.decisions, traced.decisions)
            self.assertEqual(plain.skipped, traced.skipped)
            self.assertEqual(plain.blocked, traced.blocked)
            self.assertEqual(plain.position, traced.position)

    def test_book_trades_with_trace_returns_the_same_trades(self):
        spec = SPECS[SPEC_IDS[0]]
        args = (spec, "PF_XBTUSD", "0.5", ONES, FIVES, [], FROM, HOLDOUT, lambda f: None)
        plain, open_plain = g.book_trades(*args)
        traced, open_traced, report = g.book_trades(*args, trace=True)
        self.assertEqual((plain, open_plain), (traced, open_traced))
        self.assertEqual(len(report["trades"]), len(plain))


class SignalTests(unittest.TestCase):
    def test_every_proposal_has_one_outcome_and_matches_the_book(self):
        for spec_id in SPEC_IDS:
            book = feed(spec_id, t.TracedBook)
            outcomes = [s["outcome"] for s in book.signals]
            accepted = outcomes.count("accepted")
            self.assertEqual(accepted, len(book.trades) + int(book.position is not None))
            self.assertEqual(sum(1 for o in outcomes if o.startswith("rejected_")), len(book.skipped))
            self.assertEqual(accepted + len(book.skipped), len(book.decisions))
            self.assertNotIn("rejected_unknown", outcomes)
            self.assertTrue(all(s["side"] in ("LONG", "SHORT") for s in book.signals))
            # WAIT is counted, never a row
            self.assertTrue(any(k.startswith("WAIT:") for k in book.counts))

    def test_signals_while_a_position_is_open_are_labelled(self):
        book = feed(SPEC_IDS[0], t.TracedBook)
        busy = [s for s in book.signals if s["outcome"] == "position_open"]
        for s in busy:
            self.assertTrue(any(tr["entry_time_ms"] <= s["bucket_ms"] + 60_000 <= tr["exit_time_ms"] for tr in book.trades))
        self.assertEqual(book.counts["frames:position_open"] + book.counts["frames:flat_ready"]
                         + book.counts["frames:not_ready"], sum(1 for f in frames(
                             ONES, FIVES, merge_periods(DEFAULT_PERIODS, declared_indicators(SPECS[SPEC_IDS[0]])), None)
                             if f[0] >= FROM))


class CostTests(unittest.TestCase):
    def test_breakdown_reconciles_and_unknown_funding_is_not_zero(self):
        book = feed(SPEC_IDS[0], t.TracedBook)
        self.assertEqual(len(book.evidence), len(book.trades))
        for trade, ev in zip(book.trades, book.evidence):
            costs = ev["costs"]
            self.assertTrue(costs["reconciles"], (trade, costs))
            self.assertIsNone(costs["funding_usd"])
            self.assertEqual(costs["funding_status"], "unknown")
            expected_fees = (Decimal(trade["entry_price"]) + Decimal(trade["exit_price"])) * Decimal(trade["quantity"]) * fee_rate("taker")
            self.assertEqual(Decimal(costs["fees_usd"]), expected_fees)
            if trade["exit_reason"] == "target":
                self.assertEqual(Decimal(costs["exit_execution_usd"]), 0)

    def test_known_funding_is_part_of_the_sum(self):
        spec = SPECS[SPEC_IDS[0]]
        rows = [(s, "0.00001") for s in range(ONES[0]["bucket_start"] - 3_600_000, HOLDOUT + 3_600_000, 3_600_000)]
        context = FundingContext(rows)
        periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
        book = t.TracedBook(spec, product_id="PF_XBTUSD", tick_size="0.5", funding=funding_periods(context))
        for frame in frames(ONES, FIVES, periods, context):
            if frame[0] >= FROM:
                book.on_frame(*frame)
        self.assertTrue(book.trades)
        self.assertTrue(all(e["costs"]["reconciles"] for e in book.evidence))
        self.assertTrue(any(e["costs"]["funding_usd"] is not None for e in book.evidence))


class ExitEvidenceTests(unittest.TestCase):
    def test_strategy_exit_keeps_the_values_the_simulator_evaluated(self):
        book = feed("c25-pullback-perp-v1", t.TracedBook)
        exits = [e for e in book.evidence if e["exit_reason"] == "strategy_exit"]
        others = [e for e in book.evidence if e["exit_reason"] != "strategy_exit"]
        self.assertTrue(exits and others)
        for e in exits:
            self.assertTrue(e["exit_conditions"])
            self.assertTrue(all({"code", "value", "operator", "threshold", "passed"} <= set(c) for c in e["exit_conditions"]))
            self.assertTrue(all(c["passed"] for c in e["exit_conditions"]))
        self.assertTrue(all(e["exit_conditions"] is None for e in others))
        self.assertTrue(all(e["entry_conditions"] for e in book.evidence))


class ArtifactAndReplayTests(unittest.TestCase):
    def test_practice_run_stores_a_trace_and_a_replay_reproduces_its_trades(self):
        with tempfile.TemporaryDirectory() as directory:
            out = run("c27-breakout-perp-v1", directory)
            folder = os.path.join(directory, g.ARTIFACTS_DIR, str(out["run_id"]))
            manifest = _manifest(folder)
            self.assertEqual(manifest["decision_evidence"], "captured")
            self.assertEqual(manifest["trace_schema"], t.TRACE_SCHEMA)
            lines = t.read_trace(os.path.join(folder, t.TRACE_FILE))
            self.assertEqual({l["run_id"] for l in lines}, {out["run_id"]})
            self.assertEqual({l["spec_hash"] for l in lines}, {manifest["spec_hash"]})
            self.assertEqual(sum(1 for l in lines if l["type"] == "trade"), manifest["trades_count"])
            summary = [l for l in lines if l["type"] == "summary"]
            self.assertEqual([(s["product_id"], s["from_ms"], s["to_ms"]) for s in summary],
                             [("PF_XBTUSD", manifest["range_start_ms"], manifest["range_end_ms_exclusive"])])
            replayed = t.replay(directory, out["run_id"], directory, os.path.join(directory, "traces"),
                                provider=Provider())
            self.assertEqual(replayed["differences"], [])
            self.assertEqual(replayed["products"]["PF_XBTUSD"]["stored"], manifest["trades_count"])
            again = t.read_trace(os.path.join(directory, "traces", str(out["run_id"]), t.TRACE_FILE))
            self.assertEqual(lines, again)

    def test_a_run_with_its_own_trade_source_has_no_trace(self):
        from test_strategy_gate import losing_source
        with tempfile.TemporaryDirectory() as directory:
            out = run("c25-pullback-perp-v1", directory, trade_source=losing_source)
            folder = os.path.join(directory, g.ARTIFACTS_DIR, str(out["run_id"]))
            manifest = _manifest(folder)
            self.assertEqual(manifest["decision_evidence"], "not_captured")
            self.assertFalse(os.path.exists(os.path.join(folder, t.TRACE_FILE)))


if __name__ == "__main__":
    unittest.main()
