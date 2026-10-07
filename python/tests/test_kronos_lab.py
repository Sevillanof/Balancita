import os
import random
import sqlite3
import tempfile
import unittest

from kronos_lab import lab
from test_futures_replay import DDL

START = 1_790_000_000_000 - 1_790_000_000_000 % lab.HOUR_MS


class Oracle:
    """Fake model: predicts the true next-4h move from the series itself (perfect foresight, for plumbing)."""
    name = "oracle"

    def __init__(self, series):
        self.series = series

    def expected_log_return(self, candles, horizon):
        start = candles[-1]["bucket_start"] + lab.HOUR_MS
        last = start + (horizon - 1) * lab.HOUR_MS
        return 0.0 if last not in self.series else self.series[last] / float(candles[-1]["close"]) - 1


def _hours(count):
    rng, price, out, series = random.Random(5), 100.0, [], {}
    for h in range(count):
        t0 = START + h * lab.HOUR_MS
        for m in range(60):
            nxt = price * (1 + rng.gauss(0, 0.0008))
            out.append({"bucket_start": t0 + m * 60_000, "open": price, "high": max(price, nxt), "low": min(price, nxt),
                        "close": nxt, "volume_btc": 1.0})
            price = nxt
        series[t0] = price
    return out, series


class KronosLabTests(unittest.TestCase):
    def test_hourly_drops_incomplete_hours(self):
        ones, _ = _hours(3)
        self.assertEqual(len(lab.hourly(ones)), 3)
        self.assertEqual(len(lab.hourly(ones[:-1])), 2)

    def test_decisions_are_causal_append_only_and_non_overlapping(self):
        ones, series = _hours(400)
        candles = lab.hourly(ones)
        with tempfile.TemporaryDirectory() as d:
            db = sqlite3.connect(os.path.join(d, "k.sqlite"))
            db.executescript(lab._SCHEMA)
            first = candles[lab.MIN_CONTEXT]["bucket_start"]
            seen = []

            class Spy:
                def expected_log_return(self, cs, horizon):
                    seen.append(cs[-1]["bucket_start"])
                    return 0.0

            added = lab.run_product(db, Spy(), "PF_XBTUSD", candles, mode="forward", first_decision_ms=first)
            self.assertEqual(added, 0)  # flat predictions never trade
            self.assertTrue(db.execute("SELECT COUNT(*) FROM decision").fetchone()[0] > 100)
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE decision SET side='LONG'")
            self.assertTrue(all(s >= candles[lab.MIN_CONTEXT - 1]["bucket_start"] for s in seen))

            db.close()
            db = sqlite3.connect(os.path.join(d, "k2.sqlite"))
            db.executescript(lab._SCHEMA)
            added = lab.run_product(db, Oracle(series), "PF_XBTUSD", candles, mode="backtest",
                                    first_decision_ms=first + 50 * lab.HOUR_MS)
            self.assertGreater(added, 0)
            rows = db.execute("SELECT decision_ms FROM decision WHERE side IS NOT NULL AND mode='backtest' ORDER BY 1").fetchall()
            gaps = [b[0] - a[0] for a, b in zip(rows, rows[1:])]
            self.assertTrue(all(g >= lab.HORIZON * lab.HOUR_MS for g in gaps))
            again = lab.run_product(db, Oracle(series), "PF_XBTUSD", candles, mode="backtest",
                                    first_decision_ms=first + 50 * lab.HOUR_MS)
            self.assertEqual(again, 0)  # nothing is decided or settled twice
            db.close()

    def test_official_hours_keeps_only_closed_hours_in_lab_shape(self):
        now = START + 3 * lab.HOUR_MS + 600_000  # 10 minutes into the 4th hour
        calls = []

        def fetch(url):
            calls.append(url)
            return [{"time": START + h * lab.HOUR_MS, "open": "1", "high": "2", "low": "0.5", "close": "1.5",
                     "volume": "3"} for h in range(4)]

        hours = lab.official_hours("PF_ETHUSD", START, now, fetch=fetch)
        self.assertEqual([h["bucket_start"] for h in hours], [START + h * lab.HOUR_MS for h in range(3)])
        self.assertEqual(hours[0], {"bucket_start": START, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5,
                                    "volume_btc": 3.0})
        self.assertIn("/PF_ETHUSD/1h?", calls[0])

    def test_settle_charges_costs(self):
        ones, _ = _hours(10)
        c = lab.hourly(ones)
        t = lab.settle("PF_XBTUSD", "LONG", c, 2)
        gross = (c[2 + lab.HORIZON - 1]["close"] / c[2]["open"] - 1) * 10_000
        self.assertLess(t["net_bp"], gross - 9.9)  # at least the 2 x 0.05 % taker fees come off
        self.assertEqual(t["exit_time_ms"], c[2 + lab.HORIZON - 1]["bucket_start"] + lab.HOUR_MS)


if __name__ == "__main__":
    unittest.main()
