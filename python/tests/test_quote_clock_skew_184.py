"""Issue #184 (D-289-03): a quote received a little BEFORE its Kraken time is usable; one received far before it is not.

Kraken stamps ``event_time`` with its clock, we stamp ``received_at``. In the real BTC sample 11,269 of 125,589 quotes (9 %) were received
up to 149 ms earlier. Rejecting them turned the longest stretch without a usable quote from 3.7 s to 8.0 s."""

import unittest

from balancita_engine.portfolio_watch import CLOCK_SKEW_TOLERANCE_MS, parse_quote
from real_world import quotes

BTC = "PF_XBTUSD"


def raw(time_ms, received_ms, bid="100000", ask="100001"):
    return {"product_id": BTC, "time_ms": time_ms, "received_ms": received_ms, "bid": bid, "ask": ask}


class TestTolerance(unittest.TestCase):
    def test_a_quote_received_within_the_tolerance_before_its_time_is_kept_at_its_kraken_time(self):
        q = parse_quote(raw(1_000_000, 1_000_000 - CLOCK_SKEW_TOLERANCE_MS))
        self.assertEqual((q["time_ms"], q["received_ms"]), (1_000_000, 1_000_000))

    def test_one_millisecond_beyond_the_tolerance_is_invalid(self):
        with self.assertRaises(ValueError):
            parse_quote(raw(1_000_000, 1_000_000 - CLOCK_SKEW_TOLERANCE_MS - 1))

    def test_a_quote_received_after_its_time_keeps_its_receipt(self):
        self.assertEqual(parse_quote(raw(1_000_000, 1_000_150))["received_ms"], 1_000_150)


class TestOnTheRealSample(unittest.TestCase):
    def test_every_real_quote_is_valid_and_the_longest_stretch_without_one_is_back_near_3_7_s(self):
        received, early = [], 0
        for _epoch, _seq, got, event_time, _persisted, bid, ask in quotes():
            q = parse_quote(raw(event_time, got, bid, ask))
            early += got < event_time
            received.append(q["received_ms"])
        self.assertEqual(len(received), 125_589)
        self.assertEqual(early, 11_269)
        self.assertLess(max(b - a for a, b in zip(received, received[1:])), 4_000)


if __name__ == "__main__":
    unittest.main()
