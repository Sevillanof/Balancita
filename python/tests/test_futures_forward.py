import json
import os
import sqlite3
import tempfile
import types
import unittest
from unittest import mock

from balancita_engine import futures_forward
from balancita_engine.futures_forward import LATE_KNOWN_MS, STALE_ENTRY_MS, make_entry_gate, effective_registration, load_registration, main, run_forward, write_summary
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


def _market(path, product="PF_XBTUSD", hole=None, filled=True, no_fives=None):
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
        if no_fives and c["interval_ms"] == 300_000 and no_fives[0] * MINUTE <= c["bucket_start"] - START <= no_fives[1] * MINUTE:
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


class BackfilledEntriesAreSimulatedTests(unittest.TestCase):
    """Owner decision: entries on backfilled candles are not refused; they are simulated and labelled recovered."""

    PRODUCTS = RecoveryTests.PRODUCTS
    setUp = RecoveryTests.setUp
    tearDown = RecoveryTests.tearDown

    def _forward(self, name, hole):
        market = os.path.join(self.dir.name, name + ".sqlite")
        _market(market, hole=hole)
        db = os.path.join(self.dir.name, name + "-forward.sqlite")
        seed = sqlite3.connect(db)  # the stale-data gate is on since the beginning of time
        seed.executescript("CREATE TABLE forward_policy(name TEXT NOT NULL PRIMARY KEY, value INTEGER NOT NULL) STRICT;"
                           "INSERT INTO forward_policy VALUES('stale_gate_from_ms', 0);")
        seed.commit()
        seed.close()
        run_forward(market, db, SPECS, self.registration, self.PRODUCTS)
        return db

    def test_the_gate_is_off_by_default(self):
        self.assertFalse(futures_forward.BLOCK_STALE_ENTRIES)

    def test_an_entry_on_a_backfilled_signal_candle_is_opened_blocked_nothing_and_marked_recovered(self):
        db = self._forward("entry", (2300, 2500))
        self.assertEqual(_trades(db), self.reference)
        summary = write_summary(db, SPECS, self.registration, os.path.join(self.dir.name, "s.json"))["strategies"][C30]
        self.assertEqual((summary["blocked_stale_entries"], summary["stale_cycles"]), (0, 0))
        self.assertEqual((summary["recovered_trades"], summary["live_trades"]), (1, 0))

    def test_the_summary_keeps_live_and_recovered_apart_and_says_only_live_counts(self):
        db = self._forward("apart", (2300, 2500))
        summary = write_summary(db, SPECS, self.registration, os.path.join(self.dir.name, "s.json"))["strategies"][C30]
        self.assertEqual(summary["counts_toward_min_trades"], "live")
        self.assertEqual((summary["summary_recovered"]["trades"], summary["summary_without_recovered"]["trades"]), (1, 0))
        self.assertEqual(summary["summary"]["trades"], 1)

    def test_the_gate_still_blocks_when_it_is_switched_on(self):
        with mock.patch.object(futures_forward, "BLOCK_STALE_ENTRIES", True):
            db = self._forward("blocked", (2300, 2500))
        self.assertNotIn(self.reference[0]["entry_bucket_ms"], [t["entry_bucket_ms"] for t in _trades(db)])


class FundingStateAndRecoveryTests(unittest.TestCase):
    """The summary says, per product, why funding is (not) usable; entries resting on backfilled funding are recovered."""

    PRODUCTS = RecoveryTests.PRODUCTS
    setUp = RecoveryTests.setUp
    tearDown = RecoveryTests.tearDown

    def test_the_summary_gives_the_funding_reason_per_product(self):
        _, db = RecoveryTests._run(self, "state", None)
        summary = write_summary(db, SPECS, self.registration, os.path.join(self.dir.name, "s.json"))["strategies"][C30]
        state = summary["funding_state"]["PF_XBTUSD"]
        self.assertEqual((state["usable"], state["code"]), (False, "no_history"))  # the fixture holds no funding at all
        self.assertIn("sin historia de funding", state["reason"])

    def test_a_trade_decided_on_funding_learned_afterwards_is_recovered_and_one_decided_live_is_not(self):
        trade = {"entry_bucket_ms": 10 * 60 * MINUTE}
        entry = trade["entry_bucket_ms"]
        self.assertTrue(futures_forward.funding_recovered(trade, [entry + MINUTE]))
        self.assertTrue(futures_forward.funding_recovered(trade, [entry - 3 * MINUTE]))
        self.assertFalse(futures_forward.funding_recovered(trade, [entry - 4 * MINUTE]))  # the frame before the last one
        self.assertFalse(futures_forward.funding_recovered(trade, [entry + MINUTE + 1]))
        self.assertFalse(futures_forward.funding_recovered(trade, []))

    def test_a_forward_run_marks_the_trade_recovered_when_the_funding_it_used_was_backfilled(self):
        late = types.SimpleNamespace(late_at={self.reference[0]["entry_bucket_ms"] + MINUTE}, percentile=lambda at: None)
        market = os.path.join(self.dir.name, "fund.sqlite")
        _market(market)
        db = os.path.join(self.dir.name, "fund-forward.sqlite")
        with mock.patch.object(futures_forward, "funding_for", return_value=None):
            run_forward(market, db, SPECS, self.registration, self.PRODUCTS)
        live = write_summary(db, SPECS, self.registration, os.path.join(self.dir.name, "s.json"))["strategies"][C30]
        self.assertEqual(live["recovered_trades"], 0)
        db2 = os.path.join(self.dir.name, "fund2-forward.sqlite")
        with mock.patch.object(futures_forward, "funding_for", return_value=late), \
                mock.patch.object(futures_forward, "funding_periods", return_value=[]), \
                mock.patch.object(futures_forward, "funding_state", return_value=None):
            run_forward(market, db2, SPECS, self.registration, self.PRODUCTS)
        marked = write_summary(db2, SPECS, self.registration, os.path.join(self.dir.name, "s2.json"))["strategies"][C30]
        self.assertEqual((marked["recovered_trades"], marked["live_trades"]), (1, 0))


class StaleGateTests(unittest.TestCase):
    """With the gate on, a candle learned long after it closed opens nothing; open positions are still managed."""

    PRODUCTS = RecoveryTests.PRODUCTS
    setUp = RecoveryTests.setUp
    tearDown = RecoveryTests.tearDown

    def _run(self, name, hole, filled=True):
        market = os.path.join(self.dir.name, name + ".sqlite")
        _market(market, hole=hole, filled=filled)
        db = os.path.join(self.dir.name, name + "-forward.sqlite")
        seed = sqlite3.connect(db)
        seed.executescript("CREATE TABLE forward_policy(name TEXT NOT NULL PRIMARY KEY, value INTEGER NOT NULL) STRICT;"
                           "INSERT INTO forward_policy VALUES('stale_gate_from_ms', 0);")
        seed.commit()
        seed.close()
        with mock.patch.object(futures_forward, "BLOCK_STALE_ENTRIES", True):
            run_forward(market, db, SPECS, self.registration, self.PRODUCTS)
        return market, db

    def test_a_stale_signal_candle_opens_no_entry_and_is_counted(self):
        _, db = self._run("stale", (2300, 2500))
        self.assertNotIn(self.reference[0]["entry_bucket_ms"], [t["entry_bucket_ms"] for t in _trades(db)])
        summary = write_summary(db, SPECS, self.registration, os.path.join(self.dir.name, "s.json"))["strategies"][C30]
        self.assertGreater(summary["blocked_stale_entries"], 0)
        blocked = sqlite3.connect(db).execute("SELECT COUNT(*) FROM forward_blocked").fetchone()[0]
        self.assertEqual(blocked, summary["blocked_stale_entries"])

    def test_an_open_position_is_still_closed_when_the_exit_candles_arrive_late(self):
        _, db = self._run("exit-late", (3700, 3900))
        self.assertEqual(_trades(db), self.reference)

    def test_a_missing_5m_candle_blocks_entries_even_while_1m_candles_are_fresh(self):
        ones = [{"bucket_start": i * MINUTE, "close_at": (i + 1) * MINUTE, "known_at": (i + 1) * MINUTE + 1_000}
                for i in range(60)]
        fives = [{"bucket_start": i * 5 * MINUTE, "close_at": (i + 1) * 5 * MINUTE,
                  "known_at": (i + 1) * 5 * MINUTE + 1_000} for i in range(-1, 12) if i not in (4, 5)]
        gate = make_entry_gate(ones, fives, 0)
        # The 1m series is complete and on time; only the 5m candles at 20-24 and 25-29 never arrived, so every
        # frame that would still use the indicators of the 5m candle before them is closed.
        self.assertEqual([i for i in range(60) if gate(i * MINUTE)], list(range(24, 34)))

    def test_a_shut_gate_turns_a_would_be_entry_into_a_blocked_signal_and_opens_nothing(self):
        from balancita_engine.futures_simulator import Book
        book = Book(SPECS[C30], product_id="PF_XBTUSD", tick_size="0.0001")
        book.entry_gate = lambda bucket: True
        book._entry_proposal = lambda current, common: {"action": "LONG"}
        book.on_frame(5 * MINUTE, {"ready": True, "candidate_close": "100"}, None, None, "unknown")
        book._entry_proposal = lambda current, common: {"action": "WAIT"}
        book.on_frame(6 * MINUTE, {"ready": True, "candidate_close": "100"}, None, None, "unknown")
        self.assertEqual((book.stale_cycles, book.blocked, book.position, book.decisions), (2, [5 * MINUTE], None, []))

    def test_stale_cycles_are_counted_apart_from_the_entries_actually_blocked(self):
        # Late candles far from any signal: the gate is shut for many cycles but no entry was refused.
        _, db = self._run("quiet", (2050, 2100))
        summary = write_summary(db, SPECS, self.registration, os.path.join(self.dir.name, "s.json"))["strategies"][C30]
        self.assertGreater(summary["stale_cycles"], 0)
        self.assertEqual(summary["blocked_stale_entries"], 0)
        self.assertEqual(_trades(db), self.reference)

    def test_the_gate_blocks_only_stale_candles_and_admits_entries_again_once_data_is_fresh(self):
        ones = [{"bucket_start": i * MINUTE, "close_at": (i + 1) * MINUTE,
                 "known_at": (i + 1) * MINUTE + (10 * MINUTE if 10 <= i < 20 else 1_000)} for i in range(40)]
        fives = [{"bucket_start": i * 5 * MINUTE, "close_at": (i + 1) * 5 * MINUTE,
                  "known_at": (i + 1) * 5 * MINUTE + 1_000} for i in range(-1, 8)]
        gate = make_entry_gate(ones, fives, 0)
        self.assertEqual([i for i in range(40) if gate(i * MINUTE)], list(range(10, 20)))
        self.assertGreater(10 * MINUTE, STALE_ENTRY_MS)
        # Before the moment the gate was first switched on, nothing is blocked.
        self.assertFalse(any(make_entry_gate(ones, fives, 40 * MINUTE)(i * MINUTE) for i in range(40)))

    def test_running_again_neither_duplicates_trades_nor_changes_what_was_blocked(self):
        market, db = self._run("twice", (2300, 2500))
        first = (_trades(db), sqlite3.connect(db).execute("SELECT COUNT(*) FROM forward_blocked").fetchone()[0])
        with mock.patch.object(futures_forward, "BLOCK_STALE_ENTRIES", True):
            run_forward(market, db, SPECS, self.registration, self.PRODUCTS)
        second = (_trades(db), sqlite3.connect(db).execute("SELECT COUNT(*) FROM forward_blocked").fetchone()[0])
        self.assertEqual(first, second)

    def test_a_gate_set_before_the_signal_never_applies_to_earlier_candles(self):
        # The default gate starts at the first run (now), so it leaves every stored candle alone.
        market = os.path.join(self.dir.name, "default.sqlite")
        _market(market, hole=(2300, 2500))
        db = os.path.join(self.dir.name, "default-forward.sqlite")
        run_forward(market, db, SPECS, self.registration, self.PRODUCTS)
        self.assertEqual(_trades(db), self.reference)


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

    def test_recovered_trades_never_count_toward_the_minimum(self):
        forward = _forward(FORWARD_MIN_TRADES + 20, "reliable_edge")  # 120 in all, but only 99 of them live
        forward["strategies"][C30]["summary_without_recovered"] = {
            "trades": FORWARD_MIN_TRADES - 1, "verdict": "negative_edge", "hit_rate": 0.3, "mean_net_bp": -5.0}
        entry = effective_reliability(_table(), forward, SPECS[C30])
        self.assertEqual((entry["source"], entry["verdict"], entry["forward_trades"]),
                         ("backtest", "candidate_edge", FORWARD_MIN_TRADES - 1))
        forward["strategies"][C30]["summary_without_recovered"]["trades"] = FORWARD_MIN_TRADES
        entry = effective_reliability(_table(), forward, SPECS[C30])
        self.assertEqual((entry["source"], entry["verdict"], entry["trades"]), ("forward", "negative_edge", FORWARD_MIN_TRADES))

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
            self.assertIn("c25-pullback-perp-v1", got["strategies"])  # no old engine any more
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


class TradeKeyMigrationTests(unittest.TestCase):
    OLD = ("CREATE TABLE forward_trade(strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER "
           "NOT NULL, spec_hash TEXT NOT NULL, payload TEXT NOT NULL, "
           "PRIMARY KEY(strategy_id, product_id, entry_bucket_ms)) STRICT;"
           "CREATE TRIGGER forward_trade_no_update BEFORE UPDATE ON forward_trade "
           "BEGIN SELECT RAISE(ABORT, 'forward trades are append-only'); END;")

    def setUp(self):
        from balancita_engine.futures_forward import _SCHEMA, migrate_trade_key
        self.migrate, self.schema = migrate_trade_key, _SCHEMA
        self.db = sqlite3.connect(":memory:")

    def test_rows_survive_and_a_second_spec_at_the_same_bucket_is_kept(self):
        self.db.executescript(self.OLD)
        self.db.execute("INSERT INTO forward_trade VALUES('s','PF_XBTUSD',1000,'old','{\"a\":1}')")
        self.assertEqual(self.migrate(self.db), 1)
        self.db.executescript(self.schema)
        self.db.execute("INSERT INTO forward_trade VALUES('s','PF_XBTUSD',1000,'new','{\"a\":2}')")
        self.assertEqual(self.db.execute("SELECT spec_hash, payload FROM forward_trade ORDER BY spec_hash").fetchall(),
                         [("new", '{"a":2}'), ("old", '{"a":1}')])
        self.assertEqual(self.db.execute("SELECT rows_carried FROM forward_migration").fetchone()[0], 1)

    def test_append_only_triggers_come_back_and_the_migration_runs_once(self):
        self.db.executescript(self.OLD)
        self.migrate(self.db)
        self.db.executescript(self.schema)
        self.assertIsNone(self.migrate(self.db))
        self.db.execute("INSERT INTO forward_trade VALUES('s','p',1,'h','{}')")
        with self.assertRaises(sqlite3.DatabaseError):
            self.db.execute("UPDATE forward_trade SET payload='x'")
        with self.assertRaises(sqlite3.DatabaseError):
            self.db.execute("DELETE FROM forward_trade")

    def test_a_fresh_database_needs_no_migration(self):
        self.assertIsNone(self.migrate(self.db))
        self.db.executescript(self.schema)
        self.assertIsNone(self.migrate(self.db))


class ForwardAuditTests(unittest.TestCase):
    def test_audit_tells_not_measured_from_measured_without_signals(self):
        from balancita_engine.futures_forward import _SCHEMA
        from balancita_engine.futures_forward_audit import audit
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "forward.sqlite")
            db = sqlite3.connect(path)
            db.executescript(_SCHEMA)
            db.execute("INSERT INTO forward_status VALUES('a','PF_XBTUSD',?)", (json.dumps(
                {"checked_ms": 5, "missing_1m": 2, "late_1m": 7, "diverged_trades": 0}),))
            db.commit()
            db.close()
            specs = {"a": SPECS[C30], "b": SPECS[C30]}
            registration = {"strategies": {"a": {"start_ms": 1}}}
            candidates = {"b": {"state": "active", "spec": SPECS[C30], "version": 1, "active_since_ms": 1}}
            report = audit(path, registration, specs, candidates, now_ms=10)["strategies"]
            self.assertTrue(report["a"]["measured"])
            self.assertEqual(report["a"]["trades"], 0)
            self.assertIn("no entry was forced", report["a"]["note"])
            self.assertEqual(report["a"]["late_1m_by_product"], {"PF_XBTUSD": 7})
            self.assertFalse(report["b"]["measured"])
            self.assertFalse(report["b"]["in_forward_file"])
            self.assertIn("--strategies-db", report["b"]["note"])


class CandleLagTests(unittest.TestCase):
    def test_a_stopped_capture_shows_as_lag_not_as_missing_candles(self):
        PRODUCTS = [("PF_XBTUSD", "0.0001")]
        with tempfile.TemporaryDirectory() as folder:
            market = os.path.join(folder, "m.sqlite")
            _market(market)
            registration = {"strategies": {C30: {"start_ms": START + 2000 * MINUTE}}, "min_forward_trades": 100}
            run_forward(market, os.path.join(folder, "f.sqlite"), SPECS, registration, PRODUCTS)
            (payload,) = sqlite3.connect(os.path.join(folder, "f.sqlite")).execute(
                "SELECT payload FROM forward_status").fetchone()
            status = json.loads(payload)
            self.assertEqual(status["missing_1m"], 0)
            self.assertGreater(status["candle_lag_ms"], 60 * MINUTE)
