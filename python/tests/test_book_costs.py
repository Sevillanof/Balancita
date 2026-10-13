import json
import os
import sqlite3
import tempfile
import unittest

from balancita_engine import book_costs as b


def snap(t, bid=100.0, ask=100.02, bid_qty=10.0, ask_qty=10.0, deep=5.0):
    """Book with 3 levels per side, 0.01 apart; the cumulative bands are filled from them plus ``deep`` beyond."""
    bids = tuple((round(bid - 0.01 * i, 4), bid_qty) for i in range(3))
    asks = tuple((round(ask + 0.01 * i, 4), ask_qty) for i in range(3))
    return b.Snapshot(t, bid, ask, bids, asks, {5: 30.0, 10: 30.0 + deep, 25: 100.0}, {5: 30.0, 10: 30.0 + deep, 25: 100.0})


def series(n=200, step=5_000, **over):
    return [snap(i * step, **over) for i in range(n)]


class TakerTests(unittest.TestCase):
    def test_walk_levels_average_and_exhaustion(self):
        self.assertAlmostEqual(b.walk_levels(((100.0, 1.0), (101.0, 1.0)), 150.0), 150.0 / (1.0 + 50.0 / 101.0))
        self.assertAlmostEqual(b.walk_levels(((100.0, 1.0),), 100.0), 100.0)
        self.assertIsNone(b.walk_levels(((100.0, 1.0),), 100.01))

    def test_small_order_pays_half_spread_plus_fee_and_no_impact(self):
        s = snap(0)
        c = b.taker_cost(s, "LONG", 100.0)
        self.assertEqual(c["kind"], "exact")
        self.assertAlmostEqual(c["half_spread_bp"], 0.01 / 100.01 * 1e4, places=6)
        self.assertAlmostEqual(c["impact_bp"], 0.0, places=6)
        self.assertAlmostEqual(c["total_bp"], c["half_spread_bp"] + 5.0, places=6)
        self.assertAlmostEqual(b.taker_cost(s, "SHORT", 100.0)["half_spread_bp"], 0.01 / 100.01 * 1e4, places=6)

    def test_walking_deeper_levels_adds_known_impact(self):
        s = snap(0, ask_qty=1.0)  # 100.02, 100.03, 100.04 with 1 unit each: 250 USD eats 2.5 levels
        expected = 250.0 / (1.0 + 1.0 + 50.0 / 100.04)
        # 250 USD = 100.02 + 100.03 + 49.95 (exactly): compute the average the same way
        qty = 1.0 + 1.0 + (250.0 - 100.02 - 100.03) / 100.04
        self.assertAlmostEqual(b.execution_price(s, "LONG", 250.0)[0], 250.0 / qty, places=6)
        self.assertGreater(b.taker_cost(s, "LONG", 250.0)["impact_bp"], 0)
        self.assertGreater(expected, 0)

    def test_shallow_levels_fall_back_to_band_bound_and_then_none(self):
        s = snap(0, ask_qty=0.5)  # levels hold ~150 USD; bands hold more
        price, kind = b.execution_price(s, "LONG", 2_000.0)
        self.assertEqual(kind, "bound")
        self.assertAlmostEqual(price, s.mid * (1 + 5 / 1e4))
        self.assertEqual(b.execution_price(s, "LONG", 1e9), (None, "none"))
        self.assertIsNone(b.taker_cost(s, "LONG", 1e9))

    def test_report_shares_add_up(self):
        out = b.taker_report(series(10), sizes_usd=(100.0, 1e9))
        self.assertEqual(out["100_LONG"]["exact_share"], 1.0)
        self.assertEqual(out["1e+09_LONG"]["uncovered_share"], 1.0)

    def test_spread_by_hour_and_liquidity(self):
        snaps = [snap(h * b.HOUR_MS) for h in range(3)] + [snap(25 * b.HOUR_MS, ask=100.12)]
        by_hour = b.spread_by_hour(snaps)
        self.assertEqual(sorted(by_hour), [0, 1, 2])
        self.assertEqual(by_hour[1]["n"], 2)
        liq = b.liquidity_report(snaps[:1])
        self.assertAlmostEqual(liq["bid_5bp"]["p50_usd"], 30.0 * snaps[0].mid)


class MakerFillTests(unittest.TestCase):
    def test_book_only_long_fills_when_the_ask_comes_down_to_the_limit(self):
        snaps = series(20)
        snaps[3] = snap(15_000, bid=99.9, ask=100.0)  # ask reaches our bid of 100.0
        r = b.simulate_limit(snaps, [s.t for s in snaps], 0, "LONG", 100.0)
        self.assertEqual((r["status"], r["limit"], r["conservative"], r["optimistic"]), ("ok", 100.0, 15_000, 15_000))

    def test_book_only_level_vanishing_is_optimistic_only(self):
        snaps = series(20)
        snaps[3] = snap(15_000, bid=99.98, ask=100.0 + 0.04)  # bid dropped below our limit; ask did not reach it
        r = b.simulate_limit(snaps, [s.t for s in snaps], 0, "LONG", 100.0)
        self.assertEqual((r["optimistic"], r["conservative"]), (15_000, None))

    def test_unfilled_when_the_market_does_not_come(self):
        snaps = series(20)
        r = b.simulate_limit(snaps, [s.t for s in snaps], 0, "SHORT", 100.0)
        self.assertEqual((r["status"], r["optimistic"], r["conservative"]), ("ok", None, None))

    def test_short_mirrors_the_long(self):
        snaps = series(20)
        snaps[2] = snap(10_000, bid=100.02, ask=100.1)  # bid reaches our ask of 100.02
        r = b.simulate_limit(snaps, [s.t for s in snaps], 0, "SHORT", 100.0)
        self.assertEqual((r["limit"], r["conservative"]), (100.02, 10_000))

    def test_gap_inside_the_window_excludes_the_order(self):
        snaps = [snap(0), snap(5_000), snap(40_000), snap(45_000), snap(60_000), snap(70_000)]
        r = b.simulate_limit(snaps, [s.t for s in snaps], 0, "LONG", 100.0)
        self.assertEqual(r["status"], "no_data")

    def test_data_ending_before_the_ttl_excludes_the_order(self):
        snaps = series(5)
        self.assertEqual(b.simulate_limit(snaps, [s.t for s in snaps], 0, "LONG", 100.0)["status"], "no_data")

    def test_tape_strictly_through_vs_touch_and_queue(self):
        snaps = series(20)
        times = [s.t for s in snaps]
        touch_only = b.TradeTape([(1_000, 100.0, "sell", 5.0)], 0, 200_000)
        r = b.simulate_limit(snaps, times, 0, "LONG", 100.0, tape=touch_only)
        self.assertEqual((r["optimistic"], r["conservative"]), (1_000, None))  # queue ahead is 10, only 5 traded
        enough = b.TradeTape([(1_000, 100.0, "sell", 5.0), (2_000, 100.0, "sell", 6.0)], 0, 200_000)
        r = b.simulate_limit(snaps, times, 0, "LONG", 100.0, tape=enough)  # 11 >= 10 queue + 1 own
        self.assertEqual(r["conservative"], 2_000)
        through = b.TradeTape([(3_000, 99.99, "sell", None)], 0, 200_000)
        r = b.simulate_limit(snaps, times, 0, "LONG", 100.0, tape=through)
        self.assertEqual((r["optimistic"], r["conservative"]), (3_000, 3_000))
        no_qty = b.TradeTape([(1_000, 100.0, "sell", None), (2_000, 100.0, "sell", None)], 0, 200_000)
        self.assertIsNone(b.simulate_limit(snaps, times, 0, "LONG", 100.0, tape=no_qty)["conservative"])

    def test_wrong_side_trades_and_uncovered_tape(self):
        snaps = series(20)
        times = [s.t for s in snaps]
        buys = b.TradeTape([(1_000, 99.0, "buy", 5.0)], 0, 200_000)
        self.assertIsNone(b.simulate_limit(snaps, times, 0, "LONG", 100.0, tape=buys)["optimistic"])
        short_tape = b.TradeTape([], 0, 10_000)
        self.assertEqual(b.simulate_limit(snaps, times, 0, "LONG", 100.0, tape=short_tape)["status"], "no_data")


class EvaluationTests(unittest.TestCase):
    def test_no_fill_chase_pays_taker_fee_and_skip_is_zero(self):
        snaps = series(400)  # flat market, nothing fills, 5 s apart (2 000 s)
        rows = b.evaluate_orders(snaps, [(0, "LONG")], 100.0, hold_ms=600_000)
        r = rows[0]
        self.assertFalse(r["excluded"])
        for reading in ("optimistic", "conservative"):
            self.assertFalse(r[reading]["filled"])
            self.assertEqual(r[reading]["skip_bp"], 0.0)
            self.assertAlmostEqual(r[reading]["chase_bp"], r["taker_bp"], places=6)  # same prices, flat book

    def test_filled_order_saves_the_spread_and_the_fee_difference(self):
        snaps = series(400)
        snaps[3] = snap(15_000, bid=99.9, ask=100.0)
        for i in range(4, 400):
            snaps[i] = snap(i * 5_000)
        r = b.evaluate_orders(snaps, [(0, "LONG")], 100.0, hold_ms=600_000)[0]
        c = r["conservative"]
        self.assertTrue(c["filled"])
        saving = c["maker_bp"] - r["taker_bp"]
        spread_bp = 0.02 / 100.01 * 1e4
        self.assertAlmostEqual(saving, spread_bp + (b.TAKER_FEE_BP - b.MAKER_FEE_BP), places=3)  # the maker pays the bid, the taker the ask
        self.assertAlmostEqual(c["entry_cost_bp"], -spread_bp / 2 + b.MAKER_FEE_BP, places=4)

    def test_adverse_markout_is_negative_when_price_runs_away(self):
        snaps = series(400)
        snaps[3] = snap(15_000, bid=99.9, ask=100.0)
        for i in range(4, 400):
            snaps[i] = snap(i * 5_000, bid=99.0, ask=99.02)  # price falls 1 % after the fill: bad for a long
        r = b.evaluate_orders(snaps, [(0, "LONG")], 100.0, hold_ms=600_000)[0]
        self.assertLess(r["conservative"]["markout_bp"][10_000], -50)

    def test_orders_near_the_end_or_in_gaps_are_excluded(self):
        snaps = series(400)
        rows = b.evaluate_orders(snaps, [(390, "LONG")], 100.0, hold_ms=600_000)
        self.assertTrue(rows[0]["excluded"])


class StatsAndVerdictTests(unittest.TestCase):
    def test_clustered_se_exceeds_naive_when_clusters_are_correlated(self):
        values = [1.0] * 10 + [-1.0] * 10
        mean, se, n, k = b.clustered_mean(values, [0] * 10 + [1] * 10)
        self.assertEqual((mean, n, k), (0.0, 20, 2))
        naive = (sum(v * v for v in values) / 19) ** 0.5 / 20 ** 0.5
        self.assertGreater(se, naive)
        self.assertIsNone(b.clustered_mean([1.0, 2.0], [0, 0])[1])
        self.assertEqual(b.clustered_mean([], []), (None, None, 0, 0))

    def test_verdict_needs_clusters_and_two_standard_errors(self):
        self.assertEqual(b.verdict({"mean": 5, "se": 1, "n": 100, "clusters": 5}), "insufficient_data")
        self.assertEqual(b.verdict({"mean": 5, "se": 1, "n": 100, "clusters": 40}), "maker_helps")
        self.assertEqual(b.verdict({"mean": -5, "se": 1, "n": 100, "clusters": 40}), "maker_hurts")
        self.assertEqual(b.verdict({"mean": 1, "se": 1, "n": 100, "clusters": 40}), "inconclusive")

    def test_summary_on_flat_unfilled_market_is_a_wash_not_a_win(self):
        snaps = series(2000)
        orders = b.grid_orders(snaps, 60_000)
        s = b.summarize_orders(b.evaluate_orders(snaps, orders, 100.0, hold_ms=300_000))
        self.assertEqual(s["conservative"]["hypothetical_fill_rate"], 0.0)
        self.assertAlmostEqual(s["conservative"]["chase_minus_taker_bp"]["mean"], 0.0, places=6)
        self.assertNotEqual(s["conservative"]["verdict"], "maker_helps")


class TotalCostTests(unittest.TestCase):
    def test_funding_sign(self):
        self.assertEqual(b.funding_cost_bp("LONG", 0.5, 4), 2.0)
        self.assertEqual(b.funding_cost_bp("SHORT", 0.5, 4), -2.0)

    def test_round_trip_adds_every_component_and_keeps_unknown_funding_unknown(self):
        s = snap(0)
        taker = b.round_trip_cost_bp("LONG", 100.0, s, s)
        half = 0.01 / 100.01 * 1e4
        self.assertAlmostEqual(taker["total_bp"], 2 * half + 10.0, places=4)
        self.assertIsNone(taker["funding_bp"])
        with_funding = b.round_trip_cost_bp("LONG", 100.0, s, s, rate_bp_per_hour=0.1, hours=10)
        self.assertAlmostEqual(with_funding["total_bp"] - taker["total_bp"], 1.0, places=6)
        maker = b.round_trip_cost_bp("LONG", 100.0, s, s, entry="maker", limit=100.0)
        self.assertAlmostEqual(maker["total_bp"], -half + 2.0 + half + 5.0, places=4)

    def test_cost_table_check_uses_the_static_model(self):
        out = b.compare_with_cost_table("PF_XBTUSD", series(5), 100.0)
        self.assertEqual(out["table_side_impact_bp"], 0.06)
        self.assertTrue(out["product_measured_in_table"])
        self.assertIsNone(b.compare_with_cost_table("PF_XBTUSD", [], 100.0))


class StoreRoundTripTests(unittest.TestCase):
    def make_db(self, path, snaps):
        db = sqlite3.connect(path)
        db.executescript("""
CREATE TABLE book_depth(product_id TEXT NOT NULL, received_at INTEGER NOT NULL, seq INTEGER NOT NULL,
  best_bid REAL NOT NULL, best_ask REAL NOT NULL, spread_bp REAL NOT NULL,
  bid_depth_json TEXT NOT NULL, ask_depth_json TEXT NOT NULL, top_bids_json TEXT NOT NULL, top_asks_json TEXT NOT NULL,
  bid_levels INTEGER NOT NULL, ask_levels INTEGER NOT NULL, PRIMARY KEY(product_id, received_at));
CREATE TABLE book_gap(gap_id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT, from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL, reason TEXT NOT NULL, logged_ms INTEGER NOT NULL);""")
        for s in snaps:
            db.execute("INSERT INTO book_depth VALUES('PF_XBTUSD',?,1,?,?,?,?,?,?,?,3,3)",
                       (s.t, s.bid, s.ask, s.spread_bp, json.dumps(s.bid_depth), json.dumps(s.ask_depth),
                        json.dumps(s.bids), json.dumps(s.asks)))
        db.execute("INSERT INTO book_depth VALUES('PF_XBTUSD',?,1,100,99,0,'{}','{}','[]','[]',0,0)", (10 ** 9,))  # crossed
        db.execute("INSERT INTO book_gap(product_id,from_ms,to_ms,reason,logged_ms) VALUES(NULL,5,6,'x',0)")
        db.commit()
        db.close()

    def test_loader_is_read_only_and_drops_unusable_rows(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "book.sqlite")
            self.make_db(path, series(30))
            before = os.path.getmtime(path)
            snaps, bad = b.load_snapshots(path, "PF_XBTUSD")
            self.assertEqual((len(snaps), bad), (30, 1))
            self.assertEqual(snaps[0].bids[0], (100.0, 10.0))
            self.assertEqual(snaps[0].bid_depth[5], 30.0)
            self.assertEqual(len(b.load_gaps(path, "PF_XBTUSD")), 1)
            self.assertEqual(os.path.getmtime(path), before)

    def test_build_report_end_to_end_and_markdown(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "book.sqlite")
            self.make_db(path, series(1500))
            rep = b.build_report(path, "PF_XBTUSD", step_ms=60_000, hold_ms=300_000)
            self.assertEqual(rep["parameters"]["fills"], "book_only_snapshots")
            self.assertGreater(rep["coverage"]["coverage"], 0.9)
            json.dumps(rep, sort_keys=True)  # serializable
            md = b.render_markdown(rep)
            self.assertIn("escenarios hipotéticos", md)
            self.assertIn("Taker simulado", md)
            out = os.path.join(d, "out")
            self.assertEqual(b.main(["--book-db", path, "--out", out, "--step-s", "60", "--hold-min", "5"]), 0)
            self.assertTrue(os.path.exists(os.path.join(out, "report.json")))

    def test_empty_range_reports_no_snapshots(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "book.sqlite")
            self.make_db(path, [])
            self.assertEqual(b.build_report(path, "PF_XBTUSD")["snapshots"], 0)
            self.assertIn("Sin snapshots", b.render_markdown(b.build_report(path, "PF_XBTUSD")))


def flat_with_events(n, events):
    """Flat 5 s series; ``events`` maps index -> snapshot override."""
    out = series(n)
    for i, snapshot in events.items():
        out[i] = snapshot
    return out


class ReviewFixTests(unittest.TestCase):
    def test_logged_gap_without_a_snapshot_hole_excludes_the_order(self):
        snaps = series(400)  # continuous 5 s spacing: the 15 s check alone would pass
        order = [(0, "LONG")]
        ok = b.evaluate_orders(snaps, order, 100.0, hold_ms=600_000)
        self.assertFalse(ok[0]["excluded"])
        for gap in [(100_000, 100_001, "reset"), (590_000, 595_000, "late"), (0, 1, "at start")]:
            rows = b.evaluate_orders(snaps, order, 100.0, gaps=[gap], hold_ms=600_000)
            self.assertEqual((rows[0]["excluded"], rows[0]["excluded_reason"]), (True, "logged_gap"), gap)
        far = b.evaluate_orders(snaps, order, 100.0, gaps=[(1_500_000, 1_600_000, "after")], hold_ms=600_000)
        self.assertFalse(far[0]["excluded"])  # a gap after the whole window does not matter

    def test_gap_in_the_hold_after_the_ttl_still_excludes(self):
        snaps = series(400)
        rows = b.evaluate_orders(snaps, [(0, "LONG")], 100.0, gaps=[(300_000, 310_000, "x")], ttl_ms=60_000, hold_ms=600_000)
        self.assertEqual(rows[0]["excluded_reason"], "logged_gap")
        self.assertEqual(b.summarize_orders(rows)["excluded_reasons"], {"logged_gap": 1})

    def test_snapshot_hole_during_the_hold_excludes_even_if_the_ttl_was_clean(self):
        snaps = [s for s in series(400) if not 200_000 < s.t < 260_000]
        rows = b.evaluate_orders(snaps, [(0, "LONG")], 100.0, hold_ms=600_000)
        self.assertEqual(rows[0]["excluded_reason"], "snapshot_gap")

    def test_signal_reference_is_the_snapshot_before_and_execution_the_one_after(self):
        snaps = flat_with_events(400, {1: snap(5_000, bid=100.0, ask=100.02)})
        snaps[2] = snap(10_000, bid=100.5, ask=100.52)  # market jumps +50 bp between the signal and the next snapshot
        orders, bad = b.signal_orders(snaps, [{"time_ms": 7_000, "side": "LONG"}])
        o = orders[0]
        self.assertEqual((o.ref, o.exec, bad), (1, 2, {"no_reference": 0, "no_execution_snapshot": 0}))
        row = b.evaluate_orders(snaps, orders, 100.0, hold_ms=600_000)[0]
        # the taker pays the post-jump ask against the pre-signal mid: the 50 bp wait is a cost, not hidden
        self.assertGreater(row["wait_bp"], 40)
        self.assertGreater(row["taker_entry_cost_bp"], 45)

    def test_signal_without_recent_reference_or_execution_snapshot_is_counted_not_guessed(self):
        snaps = series(100)
        orders, bad = b.signal_orders(snaps, [{"time_ms": -5_000, "side": "LONG"}, {"time_ms": 100_000, "side": "LONG"}, {"time_ms": 495_000, "side": "LONG"},
                                              {"time_ms": 10 ** 7, "side": "SHORT"}])
        self.assertEqual(len(orders), 1)
        self.assertEqual(bad, {"no_reference": 2, "no_execution_snapshot": 1})
        stale = [snap(0), snap(60_000), snap(65_000)]
        self.assertEqual(b.signal_orders(stale, [{"time_ms": 50_000, "side": "LONG"}])[1]["no_reference"], 1)

    def test_cancellations_alone_are_an_optimistic_scenario_not_a_conservative_one(self):
        snaps = flat_with_events(400, {3: snap(15_000, bid=99.98, ask=100.04)})  # bid level gone, ask never reached 100.0
        row = b.evaluate_orders(snaps, [(0, "LONG")], 100.0, hold_ms=600_000)[0]
        self.assertTrue(row["optimistic"]["filled"])
        self.assertFalse(row["conservative"]["filled"])
        summary = b.summarize_orders([row])
        self.assertIn("hypothetical", " ".join(summary["optimistic"]))
        self.assertIn("neither is a demonstrated fill", summary["scenario_note"])

    def test_four_hours_of_five_minute_grid_is_48_orders_per_side_but_four_clusters(self):
        # 4 h at 5 s; the price drifts hard in the maker's favour so the paired difference would "win" if allowed
        snaps = [snap(i * 5_000, bid=100.0 - i * 0.001, ask=100.02 - i * 0.001) for i in range(2880)]
        orders = b.grid_orders(snaps, 300_000, sides=("LONG",))
        rows = b.evaluate_orders(snaps, orders, 100.0, hold_ms=300_000)
        s = b.summarize_orders(rows)
        for reading in ("optimistic", "conservative"):
            paired = s[reading]["chase_minus_taker_bp"]
            self.assertLessEqual(paired["clusters"], 4)
            self.assertGreater(paired["n"], 40)
            self.assertEqual(s[reading]["verdict"], "insufficient_data")
            self.assertNotIn(s[reading]["verdict"], ("maker_helps", "maker_hurts"))

    def test_arbitrary_notionals_and_monotone_cost(self):
        snaps = series(20, ask_qty=1.0, bid_qty=1.0)
        curve = b.taker_curve(snaps, (175.0, 340.0, 620.0, 1e9))
        self.assertLessEqual(curve[175.0]["LONG"], curve[340.0]["LONG"])
        self.assertLessEqual(curve[340.0]["LONG"], curve[620.0]["LONG"])
        self.assertIsNone(curve[1e9]["SHORT"])
        out = b.taker_report(snaps, (175.0, 340.0))
        self.assertIn("175_LONG", out)
        self.assertIn("340_SHORT", out)

    def test_cli_accepts_custom_sizes(self):
        with tempfile.TemporaryDirectory() as d:
            helper = StoreRoundTripTests()
            path = os.path.join(d, "book.sqlite")
            helper.make_db(path, series(1500))
            self.assertEqual(b.main(["--book-db", path, "--out", d, "--sizes", "175,340,620", "--step-s", "60", "--hold-min", "5"]), 0)
            with open(os.path.join(d, "report.json")) as handle:
                rep = json.load(handle)
            self.assertEqual(sorted(rep["taker_curve_bp"]), ["175.0", "340.0", "620.0"])

    def test_report_uses_book_gaps_from_the_database(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "book.sqlite")
            StoreRoundTripTests().make_db(path, series(1500))
            db = sqlite3.connect(path)
            db.execute("DELETE FROM book_gap")
            db.execute("INSERT INTO book_gap(product_id,from_ms,to_ms,reason,logged_ms) VALUES('PF_XBTUSD',3600000,3600001,'seq',0)")
            db.commit()
            db.close()
            rep = b.build_report(path, "PF_XBTUSD", step_ms=60_000, hold_ms=300_000)
            self.assertGreater(rep["estimated_maker"]["excluded_reasons"].get("logged_gap", 0), 0)


if __name__ == "__main__":
    unittest.main()
