"""Issue #185: the live capture stores more products than a session trades (btc-3 halted on a PF_ETHUSD row on 21-oct). The market is the real
one, with a second product mirrored beside it the way the capture stores it; the session lists only PF_XBTUSD and must read past the other."""

import json
import tempfile
import unittest

from balancita_engine import paper_live_process as LP
from real_session import DECIDE_FROM, Base, Clock
from real_world import BTC, MIN, RealWorld

ETH = "PF_ETHUSD"


class WorldWithAnotherProduct(RealWorld):
    """``release_until`` also writes, for every real PF_XBTUSD ticker and candle it writes, the same row for PF_ETHUSD (mirrored rows, not new data)."""

    def release_until(self, t_ms):
        before_tickers = self.db.execute("SELECT COALESCE(MAX(rowid),0) FROM paper_futures_market_events").fetchone()[0]
        before_candles = self.db.execute("SELECT COALESCE(MAX(rowid),0) FROM paper_futures_official_candles").fetchone()[0]
        super().release_until(t_ms)
        for row in self.db.execute("SELECT * FROM paper_futures_market_events WHERE rowid>?", (before_tickers,)).fetchall():
            body = json.loads(row[10])
            body["productId"] = ETH
            text = json.dumps(body, sort_keys=True)
            self.db.execute("INSERT INTO paper_futures_market_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                            (row[0].replace(BTC, ETH), row[1], ETH, row[3], row[4], row[5], row[6], row[7], row[8], row[9], text, row[11] + "-eth"))
        for row in self.db.execute("SELECT * FROM paper_futures_official_candles WHERE rowid>?", (before_candles,)).fetchall():
            self.db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)", (ETH,) + tuple(row[1:]))
        self.db.commit()


class TestAnotherProductInTheCapture(Base):
    def test_the_session_reads_past_a_product_it_does_not_list_and_goes_on(self):
        self.world.close()
        self.world = WorldWithAnotherProduct(tempfile.mkdtemp(dir=self.root))
        self.world.release_until(DECIDE_FROM - MIN)
        eth = self.world.db.execute("SELECT COUNT(*) FROM paper_futures_market_events WHERE product_id=?", (ETH,)).fetchone()[0]
        self.assertGreater(eth, 0)                                             # the other product is really in the file
        clock = Clock()
        supervisor = self.supervisor(clock)
        supervisor.start()
        self.assertEqual(supervisor.run(max_steps=6), LP.EXIT_OK)
        self.assertNotEqual(supervisor.phase, LP.HALTED)
        stats = supervisor.session.ingestor.stats
        self.assertGreater(stats["foreign_product_rows"], 0)                   # counted, not queued
        self.assertNotIn(ETH, supervisor.session.ingestor.last_ticker_ms)


if __name__ == "__main__":
    unittest.main()
