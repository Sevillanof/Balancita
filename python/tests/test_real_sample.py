import hashlib
import os
import re
import unittest

import real_sample

GAP_MS = 2000


class RealSampleTests(unittest.TestCase):
    def test_every_file_is_the_one_the_capture_session_delivered(self):
        with open(os.path.join(real_sample.DIR, "README.md"), encoding="utf-8") as handle:
            listed = re.findall(r"`(paper_futures_\w+\.jsonl)`:.*?sha256 `([0-9a-f]{64})`", handle.read())
        self.assertEqual(len(listed), 7)
        for name, digest in listed:
            with open(os.path.join(real_sample.DIR, name), "rb") as handle:
                self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), digest, name)

    def test_the_tickers_keep_the_real_gaps_the_data_rules_must_face(self):
        events = real_sample.rows("market_events")
        by_product = {}
        for event in events:
            by_product.setdefault(event["product_id"], []).append(event["received_at"])
        self.assertEqual(sorted(by_product), ["PF_ADAUSD", "PF_XBTUSD"])
        for product, times in by_product.items():
            gaps = [b - a for a, b in zip(sorted(times), sorted(times)[1:])]
            self.assertGreater(max(gaps), GAP_MS, product)

    def test_each_official_candle_follows_krakens_rule_and_has_its_raw_response(self):
        candles = real_sample.rows("official_candles")
        responses = {row["sha256"] for row in real_sample.rows("official_candle_responses")}
        self.assertEqual(len(candles), 60)
        for product in ("PF_ADAUSD", "PF_XBTUSD"):
            series = sorted((c for c in candles if c["product_id"] == product), key=lambda c: c["bucket_start"])
            self.assertEqual(len(series), 30)
            for previous, candle in zip(series, series[1:]):
                self.assertEqual(candle["bucket_start"] - previous["bucket_start"], 60000)
                self.assertEqual(candle["open_price"], previous["close_price"], (product, candle["bucket_start"]))
            for candle in series:
                self.assertIn(candle["response_sha256"], responses)
                self.assertLessEqual(float(candle["low_price"]), min(float(candle["open_price"]), float(candle["close_price"])))
                self.assertGreaterEqual(float(candle["high_price"]), max(float(candle["open_price"]), float(candle["close_price"])))

    def test_the_stored_hashes_match_the_stored_bodies(self):
        for response in real_sample.rows("official_candle_responses"):
            self.assertEqual(hashlib.sha256(response["raw_response"].encode("utf-8")).hexdigest(), response["sha256"])
        for event in real_sample.rows("market_events"):
            self.assertEqual(hashlib.sha256(event["normalized_json"].encode("utf-8")).hexdigest(), event["content_hash"])


class PartialSampleTests(unittest.TestCase):
    """The longer XBT stretch (17-oct 12:40Z to 18-oct 08:07Z) that the strategies' warm-up needs."""

    def test_every_file_is_the_one_the_capture_session_delivered(self):
        with open(os.path.join(real_sample.PARTIAL_DIR, "README.md"), encoding="utf-8") as handle:
            listed = re.findall(r"`(paper_futures_\w+\.jsonl)`:.*?sha256 `([0-9a-f]{64})`", handle.read())
        self.assertEqual(len(listed), 8)
        for name, digest in listed:
            with open(os.path.join(real_sample.PARTIAL_DIR, name), "rb") as handle:
                self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), digest, name)

    def test_the_candles_are_consecutive_follow_krakens_rule_and_have_their_raw_response(self):
        candles = real_sample.rows("official_candles", real_sample.PARTIAL_DIR)
        responses = {row["sha256"] for row in real_sample.rows("official_candle_responses", real_sample.PARTIAL_DIR)}
        self.assertEqual(len(candles), 1168)
        self.assertEqual({c["product_id"] for c in candles}, {"PF_XBTUSD"})
        for previous, candle in zip(candles, candles[1:]):
            self.assertEqual(candle["bucket_start"] - previous["bucket_start"], 60000)
            self.assertEqual(candle["open_price"], previous["close_price"], candle["bucket_start"])
        for candle in candles:
            self.assertIn(candle["response_sha256"], responses)
            self.assertLessEqual(float(candle["low_price"]), min(float(candle["open_price"]), float(candle["close_price"])))
            self.assertGreaterEqual(float(candle["high_price"]), max(float(candle["open_price"]), float(candle["close_price"])))

    def test_the_stored_hashes_match_the_stored_bodies(self):
        for response in real_sample.rows("official_candle_responses", real_sample.PARTIAL_DIR):
            self.assertEqual(hashlib.sha256(response["raw_response"].encode("utf-8")).hexdigest(), response["sha256"])
        for event in real_sample.rows("market_events", real_sample.PARTIAL_DIR):
            self.assertEqual(hashlib.sha256(event["normalized_json"].encode("utf-8")).hexdigest(), event["content_hash"])


if __name__ == "__main__":
    unittest.main()
