import csv
import os
import shutil
import tempfile
import unittest

from balancita_engine.futures_candles_export import export_aligned, main
from test_futures_verdicts import BTC, ETH, SOL, MarketDb, OLD_OFFICIAL_DDL, official

MINUTE = 60_000
START = 1_791_000_000_000 - (1_791_000_000_000 % 300_000)


def read(path):
    with open(path, newline="") as handle:
        return list(csv.DictReader(handle))


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="balancita-export-")
        self.market = MarketDb(os.path.join(self.dir, "market.sqlite"))
        self.out = os.path.join(self.dir, "out")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def candles(self, product, first, last, close="100", skip=()):
        self.market.insert([
            official(MINUTE, START + index * MINUTE, START + (index + 1) * MINUTE + 3_000, close=close,
                     high=str(int(close) + 1), low=str(int(close) - 1))
            for index in range(first, last + 1) if index not in skip
        ], product)

    def test_writes_one_csv_per_product_on_the_common_bucket_grid(self):
        self.candles(BTC, 0, 9)
        self.candles(ETH, 2, 12, close="50", skip=(5,))
        self.candles(SOL, 1, 8, close="7")
        result = export_aligned(self.market.path, self.out, [BTC, ETH, SOL], 60_000)
        # Common range 2..8 without ETH's missing minute 5.
        expected = [START + index * MINUTE for index in (2, 3, 4, 6, 7, 8)]
        self.assertEqual(result["rows"], 6)
        self.assertEqual(result["dropped"], {BTC: 4, ETH: 4, SOL: 2})
        for product, close in ((BTC, "100"), (ETH, "50"), (SOL, "7")):
            rows = read(os.path.join(self.out, "{}_1m.csv".format(product)))
            self.assertEqual([int(row["bucket_start_ms"]) for row in rows], expected)
            self.assertEqual({row["close"] for row in rows}, {close})
            self.assertEqual(list(rows[0]), ["bucket_start_ms", "time_utc", "open", "high", "low", "close",
                                             "volume", "known_at_ms"])
        self.assertEqual(read(os.path.join(self.out, "{}_1m.csv".format(BTC)))[0]["time_utc"][-1], "Z")

    def test_uses_the_first_known_revision_and_the_as_of_cutoff(self):
        self.candles(BTC, 0, 3)
        self.market.insert([official(MINUTE, START, START + 10 * MINUTE, close="999", high="1000", low="990")], BTC)
        export_aligned(self.market.path, self.out, [BTC], 60_000)
        self.assertEqual(read(os.path.join(self.out, "PF_XBTUSD_1m.csv"))[0]["close"], "100")
        export_aligned(self.market.path, self.out, [BTC], 60_000, as_of_ms=START + 2 * MINUTE + 3_000)
        rows = read(os.path.join(self.out, "PF_XBTUSD_1m.csv"))
        self.assertEqual(len(rows), 2)

    def test_cli_and_errors(self):
        self.candles(BTC, 0, 3)
        self.candles(ETH, 0, 3)
        self.assertEqual(main(["--market-db", self.market.path, "--out-dir", self.out,
                               "--products", "PF_XBTUSD,PF_ETHUSD"]), 0)
        self.assertEqual(sorted(os.listdir(self.out)), ["PF_ETHUSD_1m.csv", "PF_XBTUSD_1m.csv"])
        # A product with no candles aborts rather than writing a misaligned set.
        with self.assertRaisesRegex(ValueError, "PF_SOLUSD"):
            export_aligned(self.market.path, self.out, [BTC, SOL], 60_000)
        old = MarketDb(os.path.join(self.dir, "old.sqlite"), ddl=OLD_OFFICIAL_DDL)
        with self.assertRaisesRegex(ValueError, "product_id"):
            export_aligned(old.path, self.out, [BTC], 60_000)
        with self.assertRaises(ValueError):
            export_aligned(self.market.path, self.out, [BTC], 900_000)


if __name__ == "__main__":
    unittest.main()
