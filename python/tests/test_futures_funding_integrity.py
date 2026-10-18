import json
import os
import sqlite3
import tempfile
import unittest

from balancita_engine.futures_forward import run_forward, write_summary
from balancita_engine.futures_funding_reconcile import METHOD_VERSION, reconcile, reconcile_trade
from balancita_engine.futures_simulator import simulate_many
from balancita_engine.futures_spec_strategy import load_specs, spec_hash
from balancita_engine.futures_strategy_reliability import FORWARD_MIN_TRADES, summarize_trades

from test_futures_forward import C30, ONES, FIVES, SPECS, START, _market, _trades
from test_futures_spec_strategy import MINUTE

H = 3_600_000


def trade(side="LONG", entry=H // 2, exit_=H * 9 // 4, funding_usd=None, pnl=-0.10, complete=False):
    return {"side": side, "entry_time_ms": entry, "exit_time_ms": exit_, "notional_usd": "100", "pnl_usd": pnl,
            "funding_usd": funding_usd, "funding_complete": complete}


def hourly(rates, first=0):
    return [(first + i * H, first + (i + 1) * H, r) for i, r in enumerate(rates)]


class ReconcileTradeTests(unittest.TestCase):
    def test_a_long_crossing_three_periods_pays_each_part_and_a_short_receives_it(self):
        periods = hourly([1e-4, 2e-4, 4e-4])  # held 0.5 h, 1 h and 0.25 h of them
        long = reconcile_trade(trade("LONG"), periods)
        short = reconcile_trade(trade("SHORT"), periods)
        self.assertAlmostEqual(long["funding_usd"], 100 * (0.5e-4 + 2e-4 + 1e-4), places=6)
        self.assertAlmostEqual(short["funding_usd"], -long["funding_usd"], places=6)
        self.assertAlmostEqual(long["pnl_usd"], -0.10 - long["funding_usd"], places=4)
        self.assertAlmostEqual(long["net_bp"], long["pnl_usd"] / 100 * 10_000, places=3)

    def test_one_and_two_periods_and_exact_period_edges(self):
        self.assertAlmostEqual(reconcile_trade(trade(entry=0, exit_=H), hourly([3e-4]))["funding_usd"], 0.03, places=6)
        two = reconcile_trade(trade(entry=H // 2, exit_=H + H // 2), hourly([1e-4, 3e-4]))
        self.assertAlmostEqual(two["funding_usd"], 100 * (0.5e-4 + 1.5e-4), places=6)

    def test_missing_data_is_never_zero_whether_it_starts_in_the_middle_or_ends_the_trade(self):
        t = trade(entry=H // 2, exit_=H * 9 // 4)
        self.assertIsNone(reconcile_trade(t, hourly([1e-4, 2e-4, 4e-4])[1:]))  # hole at the start
        full = hourly([1e-4, 2e-4, 4e-4])
        self.assertIsNone(reconcile_trade(t, [full[0], full[2]]))  # hole in the middle
        self.assertIsNone(reconcile_trade(t, full[:2]))  # hole at the end
        self.assertIsNone(reconcile_trade(t, []))

    def test_an_observed_zero_is_a_complete_zero(self):
        got = reconcile_trade(trade(), hourly([0.0, 0.0, 0.0]))
        self.assertEqual(got["funding_usd"], 0.0)
        self.assertAlmostEqual(got["pnl_usd"], -0.10, places=6)

    def test_funding_already_inside_the_stored_net_is_not_counted_twice(self):
        got = reconcile_trade(trade(funding_usd=0.01, pnl=-0.11), hourly([1e-4, 2e-4, 4e-4]))
        self.assertAlmostEqual(got["pnl_usd"], -0.10 - got["funding_usd"], places=4)

    def test_the_periods_used_are_hashed_and_the_hash_follows_the_data(self):
        a = reconcile_trade(trade(), hourly([1e-4, 2e-4, 4e-4]))
        b = reconcile_trade(trade(), hourly([1e-4, 2e-4, 5e-4]))
        self.assertNotEqual(a["periods_sha256"], b["periods_sha256"])
        self.assertEqual(a["periods_sha256"], reconcile_trade(trade(), hourly([1e-4, 2e-4, 4e-4]))["periods_sha256"])


class BookFundingTests(unittest.TestCase):
    def setUp(self):
        self.books = simulate_many([SPECS[C30]], ONES, FIVES)
        self.trade = self.books[0].trades[0]
        self.first = (START // H) * H - 24 * H
        self.last = ONES[-1]["bucket_start"] + 24 * H

    def run_with(self, periods):
        return simulate_many([SPECS[C30]], ONES, FIVES, funding=periods)[0].trades[0]

    def full(self, rate):
        return [(t, t + H, rate) for t in range(self.first, self.last, H)]

    def test_without_funding_history_the_funding_is_unknown_not_zero(self):
        self.assertIsNone(self.trade["funding_usd"])
        self.assertFalse(self.trade["funding_complete"])
        self.assertEqual(self.trade["funding_status"], "unknown")

    def test_an_observed_zero_is_zero_and_complete(self):
        got = self.run_with(self.full("0"))
        self.assertEqual((got["funding_usd"], got["funding_complete"], got["funding_status"]), (0.0, True, "complete"))

    def test_a_long_held_a_day_pays_the_hourly_rate_for_the_whole_holding_time(self):
        got = self.run_with(self.full("0.0001"))
        held_h = (got["exit_time_ms"] - got["entry_time_ms"]) / H
        self.assertTrue(got["funding_complete"])
        self.assertEqual(got["funding_held_ms"], got["exit_time_ms"] - got["entry_time_ms"])
        self.assertAlmostEqual(got["funding_usd"], 0.0001 * held_h * float(got["notional_usd"]), delta=0.02)

    def test_holes_at_the_start_in_the_middle_and_at_the_end_make_it_partial_never_complete(self):
        entry, exit_ = self.trade["entry_time_ms"], self.trade["exit_time_ms"]
        mid = (entry + exit_) // 2
        for name, hole in (("start", entry), ("middle", mid), ("end", exit_ - 1)):
            with self.subTest(hole=name):
                periods = [p for p in self.full("0.0001") if not (p[0] <= hole < p[1])]
                got = self.run_with(periods)
                self.assertFalse(got["funding_complete"])
                self.assertEqual(got["funding_status"], "partial")
                self.assertLess(got["funding_covered_ms"], got["funding_held_ms"])

    def test_history_that_never_touches_the_trade_leaves_the_funding_unknown(self):
        got = self.run_with([(0, H, "0.0001")])
        self.assertEqual((got["funding_usd"], got["funding_status"]), (None, "unknown"))

    def test_longs_pay_and_shorts_receive_when_the_rate_is_positive(self):
        periods = self.full("0.0001")
        sides = {}
        for spec in SPECS.values():
            for t in simulate_many([spec], ONES, FIVES, funding=periods)[0].trades:
                if t["funding_complete"]:
                    sides.setdefault(t["side"], t["funding_usd"])
        self.assertGreater(sides["LONG"], 0)
        if "SHORT" in sides:
            self.assertLess(sides["SHORT"], 0)


class ForwardReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.market = os.path.join(self.dir.name, "market.sqlite")
        _market(self.market)
        self.db = os.path.join(self.dir.name, "forward.sqlite")
        self.registration = {"strategies": {C30: {"start_ms": START + 2000 * MINUTE}}, "min_forward_trades": FORWARD_MIN_TRADES}
        self.products = [("PF_XBTUSD", "0.0001")]

    def tearDown(self):
        self.dir.cleanup()

    def add_funding(self, rate=1e-4, skip=None):
        db = sqlite3.connect(self.market)
        db.executescript(
            "CREATE TABLE IF NOT EXISTS paper_futures_funding_responses(sha256 TEXT, received_at INTEGER, server_time TEXT, raw_response TEXT);"
            "CREATE TABLE IF NOT EXISTS paper_futures_funding_periods(response_sha256 TEXT, start_ms INTEGER, end_ms INTEGER,"
            " funding_rate TEXT, known_at INTEGER, unit TEXT, product_id TEXT);")
        from datetime import datetime, timezone
        rates = []
        for t in range((START // H) * H - 24 * H, ONES[-1]["bucket_start"] + 24 * H, H):
            if skip is not None and skip[0] <= t < skip[1]:
                continue
            stamp = datetime.fromtimestamp(t / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            rates.append({"timestamp": stamp, "fundingRate": 1, "relativeFundingRate": rate})
            # the capture saw each hour once it had closed: one period row per hour listed, as the store writes them
            db.execute("INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
                       ("a", t, t + H, "0", t + H + 1, "u", "PF_XBTUSD"))
        db.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)", ("a", 1, "t", json.dumps({"rates": rates})))
        db.commit()
        db.close()

    def reconciled(self):
        return sqlite3.connect(self.db).execute("SELECT COUNT(*) FROM forward_trade_funding").fetchone()[0]

    def summary(self):
        specs = {C30: SPECS[C30]}
        return write_summary(self.db, specs, self.registration, os.path.join(self.dir.name, "r.json"))["strategies"][C30]["summary"]

    def test_trades_stored_without_funding_are_incomplete_and_the_summary_says_the_net_is_not_definitive(self):
        run_forward(self.market, self.db, SPECS, self.registration, self.products)
        (stored,) = _trades(self.db)
        self.assertIsNone(stored["funding_usd"])
        self.assertFalse(stored["funding_complete"])
        summary = self.summary()
        self.assertFalse(summary["net_is_definitive"])
        self.assertEqual((summary["funding_complete_trades"], summary["funding_incomplete_trades"]), (0, 1))
        self.assertIsNone(summary["mean_net_bp_funding_complete"])

    def test_funding_that_arrives_later_is_added_beside_the_original_which_is_kept(self):
        run_forward(self.market, self.db, SPECS, self.registration, self.products)
        (before,) = _trades(self.db)
        self.add_funding()
        run_forward(self.market, self.db, SPECS, self.registration, self.products)
        (after,) = _trades(self.db)
        self.assertEqual(before, after)  # never rewritten
        self.assertEqual(self.reconciled(), 1)
        summary = self.summary()
        self.assertTrue(summary["net_is_definitive"])
        self.assertEqual(summary["funding_complete_trades"], 1)
        row = sqlite3.connect(self.db).execute("SELECT funding_usd, pnl_usd, method_version FROM forward_trade_funding").fetchone()
        self.assertEqual(row[2], METHOD_VERSION)
        self.assertAlmostEqual(row[1], before["pnl_usd"] - row[0], places=4)
        self.assertAlmostEqual(summary["mean_net_bp"], row[1] / float(before["notional_usd"]) * 10_000, places=2)

    def test_reprocessing_does_not_duplicate_or_omit_and_the_rows_cannot_be_edited(self):
        run_forward(self.market, self.db, SPECS, self.registration, self.products)
        self.add_funding()
        for _ in range(3):
            run_forward(self.market, self.db, SPECS, self.registration, self.products)
        self.assertEqual(self.reconciled(), 1)
        db = sqlite3.connect(self.db)
        with self.assertRaises(sqlite3.DatabaseError):
            db.execute("UPDATE forward_trade_funding SET funding_usd=0")
        with self.assertRaises(sqlite3.DatabaseError):
            db.execute("DELETE FROM forward_trade_funding")

    def test_a_trade_the_history_does_not_fully_cover_is_never_reconciled(self):
        run_forward(self.market, self.db, SPECS, self.registration, self.products)
        (stored,) = _trades(self.db)
        middle = (stored["entry_time_ms"] + stored["exit_time_ms"]) // 2
        self.add_funding(skip=(middle - middle % H, middle - middle % H + H))
        run_forward(self.market, self.db, SPECS, self.registration, self.products)
        self.assertEqual(self.reconciled(), 0)
        self.assertFalse(self.summary()["net_is_definitive"])

    def test_a_trade_stored_with_complete_funding_needs_no_reconciliation(self):
        self.add_funding()
        run_forward(self.market, self.db, SPECS, self.registration, self.products)
        (stored,) = _trades(self.db)
        self.assertTrue(stored["funding_complete"])
        run_forward(self.market, self.db, SPECS, self.registration, self.products)
        self.assertEqual(self.reconciled(), 0)
        self.assertTrue(self.summary()["net_is_definitive"])

    def test_completing_funding_is_not_reported_as_a_divergence_from_the_candles(self):
        run_forward(self.market, self.db, SPECS, self.registration, self.products)
        self.add_funding()
        run_forward(self.market, self.db, SPECS, self.registration, self.products)
        status = json.loads(sqlite3.connect(self.db).execute("SELECT payload FROM forward_status").fetchone()[0])
        self.assertEqual(status["diverged_trades"], 0)


class SummaryFlagTests(unittest.TestCase):
    def test_a_summary_with_any_incomplete_trade_is_not_definitive(self):
        trades = [{"net_bp": 5.0, "pnl_usd": 0.05, "entry_time_ms": 1, "funding_complete": True},
                  {"net_bp": -3.0, "pnl_usd": -0.03, "entry_time_ms": 2, "funding_complete": False}]
        got = summarize_trades(trades)
        self.assertFalse(got["net_is_definitive"])
        self.assertEqual(got["mean_net_bp_funding_complete"], 5.0)

    def test_trades_that_never_said_anything_about_funding_are_incomplete(self):
        got = summarize_trades([{"net_bp": 1.0, "pnl_usd": 0.01, "entry_time_ms": 1}])
        self.assertEqual((got["funding_complete_trades"], got["net_is_definitive"]), (0, False))


if __name__ == "__main__":
    unittest.main()
