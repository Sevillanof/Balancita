import hashlib
import json
import os
import sqlite3
import tempfile
import unittest

from kronos_lab import funding, lab
from balancita_engine.futures_funding_reconcile import METHOD_VERSION

H = lab.HOUR_MS
T0 = 1_790_000_000_000 - 1_790_000_000_000 % H


def hourly(rates, first=T0):
    return [(first + i * H, first + (i + 1) * H, r) for i, r in enumerate(rates)]


def stored_trade(side, decision_ms, net_bp=-12.0):
    """A payload exactly as lab.settle writes it (taker fees, no funding, no notional)."""
    return {"side": side, "entry_time_ms": decision_ms, "entry_bucket_ms": decision_ms, "exit_time_ms": decision_ms + 4 * H,
            "entry": "100", "exit": "100", "net_bp": net_bp, "pnl_usd": net_bp / 100}


class Fixture:
    def __init__(self, folder):
        self.path = os.path.join(folder, "kronos.sqlite")
        db = sqlite3.connect(self.path)
        db.executescript(lab._SCHEMA)
        self.db = db

    def add(self, product, decision_ms, side, mode="forward", **kw):
        with self.db:
            self.db.execute("INSERT INTO trade VALUES(?,?,?,?)", (product, decision_ms, mode, json.dumps(stored_trade(side, decision_ms, **kw))))

    def close(self):
        self.db.close()


def digest(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


class KronosFundingTests(unittest.TestCase):
    def test_long_and_short_crossing_four_periods_and_the_original_is_untouched(self):
        with tempfile.TemporaryDirectory() as d:
            fx = Fixture(d)
            fx.add("PF_XBTUSD", T0 + H // 2, "LONG")  # held T0+0.5h .. T0+4.5h: 5 periods touched
            fx.add("PF_ETHUSD", T0 + H // 2, "SHORT")
            fx.db.commit()
            fx.close()
            before = digest(fx.path)
            rates = [1e-4, 2e-4, 3e-4, 4e-4, 5e-4]
            expected = 100 * (0.5 * 1e-4 + 2e-4 + 3e-4 + 4e-4 + 0.5 * 5e-4)
            trades = funding.read_trades(fx.path)
            side = sqlite3.connect(os.path.join(d, "f.sqlite"))
            added = funding.reconcile(trades, side, {p: hourly(rates) for p in ("PF_XBTUSD", "PF_ETHUSD")})
            self.assertEqual(added, 2)
            got = {t["product_id"]: t for t in funding.corrected(trades, side)}
            self.assertAlmostEqual(got["PF_XBTUSD"]["funding_usd"], expected, places=6)
            self.assertAlmostEqual(got["PF_ETHUSD"]["funding_usd"], -expected, places=6)  # the short receives it
            self.assertAlmostEqual(got["PF_XBTUSD"]["pnl_usd"], -0.12 - expected, places=4)
            self.assertAlmostEqual(got["PF_ETHUSD"]["net_bp"], -12.0 + expected / 100 * 10_000, places=3)
            self.assertTrue(got["PF_XBTUSD"]["funding_complete"])
            self.assertEqual(digest(fx.path), before)  # kronos.sqlite is byte-identical
            side.close()

    def test_a_hole_in_the_periods_is_never_zero_and_a_later_run_fills_it_once(self):
        with tempfile.TemporaryDirectory() as d:
            fx = Fixture(d)
            fx.add("PF_XBTUSD", T0, "LONG")  # needs T0 .. T0+4h
            fx.db.commit()
            fx.close()
            trades = funding.read_trades(fx.path)
            side = sqlite3.connect(os.path.join(d, "f.sqlite"))
            partial = hourly([1e-4, 1e-4, 1e-4])  # the last hour is not published yet
            self.assertEqual(funding.reconcile(trades, side, {"PF_XBTUSD": partial}), 0)
            self.assertEqual(funding.reconcile(trades, side, {}), 0)
            pending = funding.summarize(funding.corrected(trades, side))
            self.assertFalse(pending["forward"]["net_is_definitive"])
            self.assertEqual(pending["funding_pending"], [["PF_XBTUSD", T0]])
            self.assertEqual(pending["forward"]["mean_net_bp"], -12.0)  # funding-free net, flagged not definitive
            full = hourly([1e-4] * 4)
            self.assertEqual(funding.reconcile(trades, side, {"PF_XBTUSD": full}, now_ms=1), 1)
            self.assertEqual(funding.reconcile(trades, side, {"PF_XBTUSD": full}, now_ms=2), 0)  # idempotent
            done = funding.summarize(funding.corrected(trades, side))
            self.assertTrue(done["forward"]["net_is_definitive"])
            self.assertEqual(done["funding_pending"], [])
            self.assertAlmostEqual(done["forward"]["mean_net_bp"], -12.0 - 4.0, places=2)  # 4 h x 1e-4 = 4 bp
            side.close()

    def test_corrections_are_append_only_and_versioned(self):
        with tempfile.TemporaryDirectory() as d:
            fx = Fixture(d)
            fx.add("PF_XBTUSD", T0, "LONG")
            fx.db.commit()
            fx.close()
            side = sqlite3.connect(os.path.join(d, "f.sqlite"))
            funding.reconcile(funding.read_trades(fx.path), side, {"PF_XBTUSD": hourly([1e-4] * 4)})
            with self.assertRaises(sqlite3.DatabaseError):
                side.execute("UPDATE trade_funding SET funding_usd=0")
            with self.assertRaises(sqlite3.DatabaseError):
                side.execute("DELETE FROM trade_funding")
            self.assertEqual(side.execute("SELECT method_version FROM trade_funding").fetchone()[0], METHOD_VERSION)
            side.close()

    def test_kronos_database_is_opened_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            fx = Fixture(d)
            fx.add("PF_XBTUSD", T0, "LONG")
            fx.db.commit()
            fx.close()
            ro = sqlite3.connect("file:{}?mode=ro".format(fx.path), uri=True)
            with self.assertRaises(sqlite3.OperationalError):
                ro.execute("CREATE TABLE trade_funding(x)")
            ro.close()

    def test_positions_held_through_an_interruption_and_backtest_rows_are_reported_apart(self):
        with tempfile.TemporaryDirectory() as d:
            fx = Fixture(d)
            fx.add("PF_XBTUSD", T0, "LONG")                        # settled before the outage
            fx.add("PF_ETHUSD", T0 + 20 * H, "LONG")               # decided before it, held through it
            fx.add("PF_XBTUSD", T0 + 40 * H, "SHORT")              # after the resume
            fx.add("PF_XBTUSD", T0 + 50 * H, "LONG", mode="backtest")
            with fx.db:
                fx.db.execute("INSERT INTO segment(start_ms, kind, note, created_ms) VALUES(?,?,?,?)", (T0, "original", "", 1))
                fx.db.execute("INSERT INTO segment(start_ms, kind, note, created_ms) VALUES(?,?,?,?)", (T0 + 30 * H, "resume", "", 2))
                fx.db.execute("INSERT INTO interruption(from_ms, to_ms, reason, recorded_ms) VALUES(?,?,?,?)",
                              (T0 + 21 * H, T0 + 29 * H, "down", 2))
            fx.close()
            trades = funding.read_trades(fx.path)
            by = {(t["product_id"], t["decision_ms"]): t for t in trades}
            self.assertTrue(by[("PF_ETHUSD", T0 + 20 * H)]["crosses_interruption"])
            self.assertFalse(by[("PF_XBTUSD", T0)]["crosses_interruption"])
            self.assertEqual(by[("PF_XBTUSD", T0 + 40 * H)]["segment"], "resume")
            side = sqlite3.connect(os.path.join(d, "f.sqlite"))
            rates = hourly([1e-4] * 60)
            funding.reconcile(trades, side, {p: rates for p in ("PF_XBTUSD", "PF_ETHUSD")})
            out = funding.summarize(funding.corrected(trades, side))
            self.assertEqual(out["forward"]["trades"], 3)  # the backtest row is not evidence
            self.assertEqual(out["interruption_crossers"]["keys"], [["PF_ETHUSD", T0 + 20 * H]])
            self.assertEqual(out["forward_without_interruption_crossers"]["trades"], 2)
            side.close()

    def test_main_writes_only_the_sidecar_files(self):
        with tempfile.TemporaryDirectory() as d:
            fx = Fixture(d)
            fx.add("PF_XBTUSD", T0, "LONG")
            fx.db.commit()
            fx.close()
            before = digest(fx.path)
            market = os.path.join(d, "market.sqlite")  # without funding tables: nothing can be verified
            sqlite3.connect(market).close()
            funding.main(["--out", d, "--market-db", market])
            self.assertEqual(digest(fx.path), before)
            self.assertEqual(sorted(os.listdir(d)), ["kronos-funding-summary.json", "kronos-funding.sqlite", "kronos.sqlite", "market.sqlite"])
            with open(os.path.join(d, "kronos-funding-summary.json")) as handle:
                body = json.load(handle)
            self.assertEqual(body["corrections_added"], 0)
            self.assertFalse(body["forward"]["net_is_definitive"])


if __name__ == "__main__":
    unittest.main()
