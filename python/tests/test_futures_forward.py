import json
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from balancita_engine.futures_forward import LATE_KNOWN_MS, effective_registration, load_registration, main, run_forward, write_summary
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


def _market(path, product="PF_XBTUSD", hole=None, filled=True):
    """Official candles of the surge. ``hole`` = (first, last) minute index the capture was down for: its candles
    are either learned a day and a half later (``filled``: recovered from the public API) or missing."""
    db = sqlite3.connect(path)
    db.executescript(DDL)
    first, last = hole if hole else (None, None)
    late = START + (last + 1) * MINUTE + 40 * 3_600_000 if hole else None
    for c in ONES + FIVES:
        inside = hole is not None and first * MINUTE <= c["bucket_start"] - START <= last * MINUTE
        if inside and not filled:
            continue
        c = dict(c, known_at=late) if inside else c
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


def _trades(db_path):
    return [json.loads(payload) for (payload,) in sqlite3.connect(db_path).execute(
        "SELECT payload FROM forward_trade ORDER BY entry_bucket_ms")]


class RecoveryTests(unittest.TestCase):
    """A capture hole filled afterwards from the public API must not change what the strategy did."""

    PRODUCTS = [("PF_XBTUSD", "0.0001")]

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.registration = {"strategies": {C30: {"start_ms": START + 2000 * MINUTE}}, "min_forward_trades": 100}
        clean = os.path.join(self.dir.name, "clean.sqlite")
        _market(clean)
        self.reference_db = os.path.join(self.dir.name, "clean-forward.sqlite")
        run_forward(clean, self.reference_db, SPECS, self.registration, self.PRODUCTS)
        self.reference = _trades(self.reference_db)
        self.assertEqual(len(self.reference), 1)  # entry at minute 2349, time stop at 3789

    def tearDown(self):
        self.dir.cleanup()

    def _run(self, name, hole, filled=True):
        market = os.path.join(self.dir.name, name + ".sqlite")
        _market(market, hole=hole, filled=filled)
        db = os.path.join(self.dir.name, name + "-forward.sqlite")
        run_forward(market, db, SPECS, self.registration, self.PRODUCTS)
        return market, db

    def test_a_filled_hole_over_the_entry_gives_the_same_trades_labelled_recovered(self):
        _, db = self._run("entry", (2300, 2500))
        self.assertEqual(_trades(db), self.reference)
        summary = write_summary(db, SPECS, self.registration, os.path.join(self.dir.name, "s.json"))["strategies"][C30]
        self.assertEqual((summary["summary"]["trades"], summary["recovered_trades"]), (1, 1))
        self.assertEqual(summary["summary_without_recovered"]["trades"], 0)
        self.assertEqual((summary["missing_candles_1m"], summary["diverged_trades"]), (0, 0))

    def test_a_filled_hole_over_the_exit_closes_the_position_the_same_way(self):
        _, db = self._run("exit", (3700, 3900))
        self.assertEqual(_trades(db), self.reference)
        self.assertEqual(self.reference[0]["exit_reason"], "time_stop")
        summary = write_summary(db, SPECS, self.registration, os.path.join(self.dir.name, "s.json"))["strategies"][C30]
        self.assertEqual(summary["recovered_trades"], 1)

    def test_a_hole_that_does_not_touch_the_trade_leaves_it_unlabelled(self):
        _, db = self._run("elsewhere", (2050, 2100))
        self.assertEqual(_trades(db), self.reference)
        summary = write_summary(db, SPECS, self.registration, os.path.join(self.dir.name, "s.json"))["strategies"][C30]
        self.assertEqual((summary["summary"]["trades"], summary["recovered_trades"]), (1, 0))

    def test_candles_still_missing_are_reported_not_hidden(self):
        _, db = self._run("open", (3700, 3900), filled=False)
        summary = write_summary(db, SPECS, self.registration, os.path.join(self.dir.name, "s.json"))["strategies"][C30]
        self.assertEqual(summary["missing_candles_1m"], 201)

    def test_trades_stored_across_a_hole_are_flagged_once_it_is_filled_and_rebuild_fixes_them(self):
        market, db = self._run("later", (3700, 3900), filled=False)
        self.assertNotEqual(_trades(db), self.reference)  # the time stop could not happen on missing candles
        filled = os.path.join(self.dir.name, "later-filled.sqlite")
        _market(filled, hole=(3700, 3900))
        run_forward(filled, db, SPECS, self.registration, self.PRODUCTS)
        summary = write_summary(db, SPECS, self.registration, os.path.join(self.dir.name, "s.json"))["strategies"][C30]
        self.assertGreaterEqual(summary["diverged_trades"], 1)
        registration = os.path.join(self.dir.name, "registration.json")
        with open(registration, "w", encoding="utf-8") as handle:
            json.dump(dict(self.registration, schema="futures-forward-strategies.v1"), handle)
        out = os.path.join(self.dir.name, "out")
        os.makedirs(out)
        os.replace(db, os.path.join(out, "forward.sqlite"))
        with mock.patch("balancita_engine.futures_forward.resolve_products", return_value=self.PRODUCTS):
            main(["--market-db", filled, "--out", out, "--registration", registration, "--rebuild"])
        self.assertEqual(_trades(os.path.join(out, "forward.sqlite")), self.reference)
        self.assertEqual(len([f for f in os.listdir(out) if ".before-rebuild-" in f]), 1)
        with open(os.path.join(out, "forward-reliability.json"), encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["strategies"][C30]["diverged_trades"], 0)

    def test_a_candle_learned_within_the_normal_poll_delay_is_not_recovered(self):
        self.assertGreater(LATE_KNOWN_MS, 60_000)
        self.assertLessEqual(1_000, LATE_KNOWN_MS)


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


class EffectiveRegistrationTests(unittest.TestCase):
    def _registration(self):
        return load_registration()

    def _candidate(self, strategy_id, state="active", since=0, version=1):
        return {"spec": SPECS[strategy_id], "version": version, "state": state, "active_since_ms": since}

    def test_without_a_registry_nothing_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            registration = self._registration()
            got, specs = effective_registration(os.path.join(directory, "f.sqlite"), registration, SPECS, None, 5)
            self.assertEqual(got, registration)

    def test_active_strategies_start_when_activated_and_c30_keeps_its_start(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "f.sqlite")
            registration = self._registration()
            candidates = {
                C30: self._candidate(C30),
                "c25-pullback-perp-v1": self._candidate("c25-pullback-perp-v1"),
                "c29-momentum-perp-v1": self._candidate("c29-momentum-perp-v1"),
                "c26-reversion-perp-v1": self._candidate("c26-reversion-perp-v1", since=900),
            }
            got, _ = effective_registration(path, registration, SPECS, candidates, 1_000)
            self.assertEqual(got["strategies"][C30], registration["strategies"][C30])
            self.assertNotIn("c25-pullback-perp-v1", got["strategies"])  # D's own books
            self.assertEqual(got["strategies"]["c29-momentum-perp-v1"]["start_ms"], 1_000)
            # First sight is written down once and never moves.
            again, _ = effective_registration(path, registration, SPECS, candidates, 9_999)
            self.assertEqual(again["strategies"]["c29-momentum-perp-v1"]["start_ms"], 1_000)

    def test_switching_off_stops_new_trades_but_keeps_the_history(self):
        with tempfile.TemporaryDirectory() as directory:
            registration = self._registration()
            got, _ = effective_registration(os.path.join(directory, "f.sqlite"), registration, SPECS,
                                            {C30: self._candidate(C30, state="retired")}, 1_000)
            self.assertNotIn(C30, got["strategies"])
            self.assertIn(C30, registration["strategies"])
