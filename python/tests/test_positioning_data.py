import os
import sqlite3
import tempfile
import unittest

from balancita_engine import positioning_data as pos

H = pos.HOUR_MS


class PositioningDataTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "p.sqlite")
        db = sqlite3.connect(self.path)
        db.executescript(
            "CREATE TABLE positioning(product_id TEXT, bucket_ms INTEGER, long_percent REAL, long_count INTEGER,"
            " short_count INTEGER, top_long_percent REAL, top_long_count INTEGER, top_short_count INTEGER,"
            " top_open_interest REAL);"
            "CREATE TABLE premium(product_id TEXT, interval_ms INTEGER, bucket_ms INTEGER, mark REAL, spot REAL,"
            " premium_bp REAL);"
        )
        for i in range(3):
            db.execute(
                "INSERT INTO positioning VALUES('PF_XBTUSD',?,?,0,0,?,0,0,5.0)", (i * H, 50.0 + i, 60.0 + i)
            )
            db.execute("INSERT INTO premium VALUES('PF_XBTUSD',?,?,101,100,?)", (H, i * H, 10.0 * i))
        db.commit()
        db.close()

    def tearDown(self):
        self.dir.cleanup()

    def test_load_filters_product_and_range(self):
        rows = pos.load_positioning(self.path, "PF_XBTUSD", from_ms=H)
        self.assertEqual([r[0] for r in rows], [H, 2 * H])
        self.assertEqual(pos.load_positioning(self.path, "PF_ETHUSD"), [])
        self.assertEqual(pos.load_premium(self.path, "PF_XBTUSD")[-1], (2 * H, 20.0))

    def test_as_of_never_sees_an_open_bucket(self):
        rows = pos.load_positioning(self.path, "PF_XBTUSD")
        self.assertIsNone(pos.as_of(rows, H - 1))
        self.assertEqual(pos.as_of(rows, H)[0], 0)
        self.assertEqual(pos.as_of(rows, 2 * H + 5)[0], H)

    def test_database_is_read_only(self):
        with self.assertRaises(sqlite3.OperationalError):
            sqlite3.connect("file:{}?mode=ro".format(self.path), uri=True).execute("DELETE FROM premium")

    def test_catalog_availability_follows_active_cards(self):
        path = os.path.join(self.dir.name, "indicators.json")
        with open(path, "w") as handle:
            handle.write(
                '{"indicators":['
                '{"id":"a","series":"premium","resolution":"1h","products":"pinned","state":"active"},'
                '{"id":"b","series":"positioning","resolution":"1h","products":["PF_XBTUSD"],"state":"archived"}]}'
            )
        self.assertTrue(pos.is_available(path, "premium", "1h", "PF_ETHUSD"))
        self.assertFalse(pos.is_available(path, "positioning", "1h", "PF_XBTUSD"))
        self.assertFalse(pos.is_available(path, "premium", "1m", "PF_ETHUSD"))

    def test_rejects_unknown_interval(self):
        with self.assertRaises(ValueError):
            pos.load_premium(self.path, "PF_XBTUSD", interval_ms=5)


if __name__ == "__main__":
    unittest.main()
