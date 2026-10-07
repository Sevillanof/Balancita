import json
import os
import sqlite3
import tempfile
import unittest

from balancita_engine.futures_forward import load_registration, run_forward, write_summary
from balancita_engine.futures_replay import replay
from balancita_engine.futures_simulator import simulate_many
from balancita_engine.futures_spec_strategy import load_specs, spec_hash
from balancita_engine.futures_strategy_reliability import (
    FORWARD_MIN_TRADES,
    FORWARD_SCHEMA,
    RELIABILITY_SCHEMA,
    effective_reliability,
    load_forward,
)
from balancita_engine import futures_llm_decisions as q

from test_futures_log_strategies import _calm_then_surge, _candles
from test_futures_replay import DDL
from test_futures_spec_strategy import MINUTE, START

C30 = "c30-momentum-12h-perp-v1"
SPECS = load_specs()
ONES, FIVES = _candles(_calm_then_surge())


def _market(path, product="PF_XBTUSD"):
    db = sqlite3.connect(path)
    db.executescript(DDL)
    for c in ONES + FIVES:
        db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
            product, c["interval_ms"], c["bucket_start"], c["revision_hash"], c["known_at"],
            c["open"], c["high"], c["low"], c["close"], c["volume_btc"], "x"))
    db.commit()
    db.close()


class ReplayLogFeatureTests(unittest.TestCase):
    def test_the_replay_computes_the_periods_a_spec_declares(self):
        # Before this the replay computed only the default periods, so C29 and C30 never fired in it.
        (book,) = replay([SPECS[C30]], ONES, FIVES, start_ms=START + 2000 * MINUTE, product_id="PF_XBTUSD")
        self.assertGreaterEqual(len(book.trades) + (1 if book.position else 0), 1)
        (want,) = simulate_many([SPECS[C30]], ONES, FIVES)
        self.assertEqual([t["entry_bucket_ms"] for t in book.trades], [t["entry_bucket_ms"] for t in want.trades])


class ForwardTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.market = os.path.join(self.dir.name, "market.sqlite")
        _market(self.market)
        self.db = os.path.join(self.dir.name, "forward.sqlite")
        self.registration = {"strategies": {C30: {"start_ms": START + 2000 * MINUTE}}, "min_forward_trades": 100}

    def tearDown(self):
        self.dir.cleanup()

    def test_only_trades_after_the_start_are_kept_and_rerunning_adds_nothing(self):
        products = [("PF_XBTUSD", "0.0001")]
        first = run_forward(self.market, self.db, SPECS, self.registration, products)
        self.assertGreaterEqual(first[(C30, "PF_XBTUSD")], 1)
        rows = sqlite3.connect(self.db).execute("SELECT entry_bucket_ms, spec_hash FROM forward_trade").fetchall()
        self.assertTrue(all(bucket >= self.registration["strategies"][C30]["start_ms"] for bucket, _ in rows))
        self.assertTrue(all(digest == spec_hash(SPECS[C30]) for _, digest in rows))
        again = run_forward(self.market, self.db, SPECS, self.registration, products)
        self.assertEqual(again[(C30, "PF_XBTUSD")], 0)

    def test_a_start_after_the_move_has_no_trades(self):
        late = {"strategies": {C30: {"start_ms": START + 4000 * MINUTE}}, "min_forward_trades": 100}
        run_forward(self.market, self.db, SPECS, late, [("PF_XBTUSD", "0.0001")])
        self.assertEqual(sqlite3.connect(self.db).execute("SELECT COUNT(*) FROM forward_trade").fetchone()[0], 0)

    def test_forward_trades_cannot_be_rewritten(self):
        run_forward(self.market, self.db, SPECS, self.registration, [("PF_XBTUSD", "0.0001")])
        db = sqlite3.connect(self.db)
        with self.assertRaises(sqlite3.DatabaseError):
            db.execute("UPDATE forward_trade SET payload='{}'")
        with self.assertRaises(sqlite3.DatabaseError):
            db.execute("DELETE FROM forward_trade")

    def test_the_summary_is_what_the_reliability_lookup_reads(self):
        run_forward(self.market, self.db, SPECS, self.registration, [("PF_XBTUSD", "0.0001")])
        out = os.path.join(self.dir.name, "forward-reliability.json")
        body = write_summary(self.db, SPECS, self.registration, out)
        self.assertEqual(body["schema"], FORWARD_SCHEMA)
        self.assertEqual(load_forward(out)["strategies"][C30]["spec_hash"], spec_hash(SPECS[C30]))
        self.assertGreaterEqual(body["strategies"][C30]["summary"]["trades"], 1)
        self.assertIsNone(load_forward(out + ".missing"))


def _table(verdict="candidate_edge"):
    return {"schema": RELIABILITY_SCHEMA, "strategies": {C30: {
        "spec_hash": spec_hash(SPECS[C30]), "trades": 288, "verdict": verdict, "hit_rate": 0.49, "mean_net_bp": 58.2}}}


def _forward(trades, verdict, digest=None):
    return {"schema": FORWARD_SCHEMA, "strategies": {C30: {
        "spec_hash": digest or spec_hash(SPECS[C30]),
        "summary": {"trades": trades, "verdict": verdict, "hit_rate": 0.55, "mean_net_bp": 40.0}}}}


class EffectiveReliabilityTests(unittest.TestCase):
    def test_the_backtest_verdict_stands_until_there_are_enough_forward_trades(self):
        entry = effective_reliability(_table(), _forward(FORWARD_MIN_TRADES - 1, "reliable_edge"), SPECS[C30])
        self.assertEqual((entry["source"], entry["verdict"], entry["forward_trades"]),
                         ("backtest", "candidate_edge", FORWARD_MIN_TRADES - 1))

    def test_with_enough_forward_trades_they_alone_decide_in_both_directions(self):
        up = effective_reliability(_table(), _forward(FORWARD_MIN_TRADES, "tentative_edge"), SPECS[C30])
        self.assertEqual((up["source"], up["verdict"]), ("forward", "tentative_edge"))
        down = effective_reliability(_table(), _forward(FORWARD_MIN_TRADES + 50, "negative_edge"), SPECS[C30])
        self.assertEqual((down["source"], down["verdict"]), ("forward", "negative_edge"))

    def test_a_forward_record_of_another_spec_version_is_ignored(self):
        entry = effective_reliability(_table(), _forward(500, "reliable_edge", digest="old"), SPECS[C30])
        self.assertEqual((entry["source"], entry["verdict"], entry["forward_trades"]), ("backtest", "candidate_edge", None))

    def test_unmeasured_strategies_stay_unmeasured(self):
        self.assertIsNone(effective_reliability({"schema": RELIABILITY_SCHEMA, "strategies": {}}, None, SPECS[C30]))

    def test_the_qwen_field_shows_forward_progress_then_the_forward_verdict(self):
        verdict = {"proposals": [{"strategy_id": C30}]}
        early = q.STATE_FIELDS["strategy_reliability"](
            {"verdict": verdict, "specs": SPECS, "reliability": _table(), "forward": _forward(12, "no_edge")})
        self.assertEqual(early, "strategy_reliability: {} candidate_edge hit=0.49 net_bp=58.2 trades=288 fwd=12/100".format(C30))
        late = q.STATE_FIELDS["strategy_reliability"](
            {"verdict": verdict, "specs": SPECS, "reliability": _table(), "forward": _forward(100, "negative_edge")})
        self.assertEqual(late, "strategy_reliability: {} negative_edge hit=0.55 net_bp=40.0 trades=100".format(C30))

    def test_the_shipped_registration_names_a_shipped_spec_and_the_documented_threshold(self):
        registration = load_registration()
        self.assertEqual(registration["min_forward_trades"], FORWARD_MIN_TRADES)
        for strategy_id in registration["strategies"]:
            self.assertIn(strategy_id, SPECS)


if __name__ == "__main__":
    unittest.main()
