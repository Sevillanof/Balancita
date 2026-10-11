import unittest

from balancita_engine import futures_flow_impulse as fi


def element(uid, ts, qty, direction):
    return {"event": {"Execution": {"execution": {"uid": uid, "timestamp": ts, "quantity": qty,
                                                  "takerOrder": {"direction": direction}}}}}


class AggregateDayTests(unittest.TestCase):
    def test_bins_by_taker_side_and_dedups(self):
        body = {"elements": [element("a", 1000, "2", "Buy"), element("a", 1000, "2", "Buy"),
                             element("b", 2000, "1", "Sell"), element("c", fi.BIN_MS + 5, "3", "Buy"),
                             element("d", 10 * fi.BIN_MS, "9", "Buy")]}
        bins, fills = fi.aggregate_day("PF_XBTUSD", 0, 5 * fi.BIN_MS, fetch=lambda url: body)
        self.assertEqual(bins, {0: [2.0, 1.0, 2], fi.BIN_MS: [3.0, 0.0, 1]})
        self.assertEqual(fills, 3)


class SimulateTests(unittest.TestCase):
    def series(self, bars):
        return [{"t": k * fi.BIN_MS, "o": o, "h": h, "l": l, "c": c, "v": 1, "buy": 0, "sell": 0, "n": 0, "covered": True}
                for k, (o, h, l, c) in enumerate(bars)]

    def test_target_hit_long(self):
        s = self.series([(100, 101, 99, 100.6), (100.6, 102, 100.5, 101.5), (101.5, 106, 101, 105)])
        trade = fi.simulate_trade(s, "PF_XBTUSD", 0, "LONG", 2.0)
        self.assertEqual(trade["reason"], "target")
        self.assertGreater(trade["net_bp"], 0)

    def test_stop_first_when_both_in_same_candle(self):
        s = self.series([(100, 101, 99, 100.6), (100.6, 110, 90, 100)])
        trade = fi.simulate_trade(s, "PF_XBTUSD", 0, "LONG", 2.0)
        self.assertEqual(trade["reason"], "stop")


if __name__ == "__main__":
    unittest.main()
