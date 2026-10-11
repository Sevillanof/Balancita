import os
import tempfile
import unittest

from balancita_engine import futures_maker as m
from balancita_engine import futures_tape as t


def element(uid, time_ms, price="100", direction="Sell"):
    return {"uid": "e" + uid, "timestamp": time_ms, "event": {"Execution": {"execution": {
        "uid": uid, "timestamp": time_ms, "price": price, "quantity": "1",
        "takerOrder": {"direction": direction}, "makerOrder": {"direction": "Buy"}}}}}


class ParseTests(unittest.TestCase):
    def test_taker_direction_is_the_aggressor_side(self):
        self.assertEqual(t.parse_execution(element("a", 5, "99.5", "Buy")), ("a", 5, "99.5", "buy"))
        self.assertIsNone(t.parse_execution({"event": {"Other": {}}}))
        self.assertIsNone(t.parse_execution(element("a", 5, "x")))


class FetchTests(unittest.TestCase):
    def test_pages_until_the_window_is_complete_and_trims_to_it(self):
        pages = [
            {"elements": [element(str(i), 1_000 + i) for i in range(t.PAGE)], "continuationToken": "k1"},
            {"elements": [element("x1", 5_000), element("x2", 9_000)], "continuationToken": "k2"},
        ]
        seen = []

        def fetch(url):
            seen.append(url)
            return pages[len(seen) - 1]

        fills = t.fetch_fills("PF_X", 1_000, 6_000, fetch=fetch, sleep=lambda s: None)
        self.assertEqual(len(seen), 2)
        self.assertIn("continuationToken=k1", seen[1])
        self.assertEqual([f[0] for f in fills][-1], "x1")  # x2 is after the window
        self.assertEqual(len(fills), t.PAGE + 1)


class CacheTests(unittest.TestCase):
    def test_a_window_is_fetched_once_and_covers_exactly_its_range(self):
        calls = []

        def fetch(product, lo, hi):
            calls.append((product, lo, hi))
            return [("u1", 1_500, "100", "sell"), ("u2", 1_800, "101", "buy")]

        with tempfile.TemporaryDirectory() as tmp:
            cache = t.TapeCache(os.path.join(tmp, "c.sqlite"), fetch=fetch)
            tape = cache.window("PF_X", 1_000, 2_000)
            again = cache.window("PF_X", 1_200, 1_900)  # inside a fetched window: no request
            cache.close()
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(tape), 2)
        self.assertTrue(tape.covers(1_000) and tape.covers(2_000) and not tape.covers(2_001))
        self.assertEqual(len(again), 2)


class SamplingTests(unittest.TestCase):
    def test_sampling_is_per_product_deterministic_and_keeps_small_pools(self):
        trades = [{"product_id": "PF_A", "strategy_id": "s", "entry_time_ms": i} for i in range(100)]
        trades += [{"product_id": "PF_B", "strategy_id": "s", "entry_time_ms": i} for i in range(3)]
        first = m.sample_trades(trades, 10)
        self.assertEqual(first, m.sample_trades(trades, 10))
        self.assertEqual(sum(1 for x in first if x["product_id"] == "PF_A"), 10)
        self.assertEqual(sum(1 for x in first if x["product_id"] == "PF_B"), 3)

    def test_window_runs_from_a_lookback_to_the_end_of_the_order_plus_markout(self):
        trade = {"entry_time_ms": 1_000_000, "exit_time_ms": 1_030_000}
        lo, hi = m.window_for(trade, ttl_ms=60_000, latency_ms=100)
        self.assertEqual((lo, hi), (1_000_000 - m.TAPE_LOOKBACK_MS, 1_030_000 + m.MARKOUT_MS))

    def test_study_accepts_a_per_trade_tape(self):
        tape = m.Tape([(500, "100", "sell"), (2_000, "99.9", "sell")], lo=0, hi=200_000)
        trade = {"side": "LONG", "entry_time_ms": 1_000, "exit_time_ms": 100_000, "entry_price": "100.05",
                 "exit_price": "101", "stop_price": "99", "notional_usd": "100", "funding_usd": 0,
                 "product_id": "PF_X", "net_bp": -10.0, "pnl_usd": -0.1}
        out = m.study([trade], lambda tr: tape)
        self.assertEqual((out["signals"], out["filled"]), (1, 1))


if __name__ == "__main__":
    unittest.main()
