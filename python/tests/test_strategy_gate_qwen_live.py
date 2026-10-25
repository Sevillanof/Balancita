import json
import os
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as ex
from balancita_engine import strategy_gate_models as models

HOUR = 3_600_000
T0 = 1_760_000_000_000 // HOUR * HOUR          # well before the holdout cut
LIVE_T0 = 1_792_000_000_000 // HOUR * HOUR     # after it


def photo_db(path, photos):
    pdb = qt.PracticeDB(path)
    pdb.db.executescript(ex._EXAM_SQL)
    with pdb.db:
        for order, (t_ms, action, mirror, move) in enumerate(photos):
            sid = ex.snap_id("PF_XBTUSD", t_ms)
            pdb.db.execute("INSERT INTO exam_snapshots VALUES(?,?,?,?,?,?,?,?,?)",
                           (sid, "PF_XBTUSD", t_ms, order, "[]", "s", "m", json.dumps({"240": move, "1440": 0}), 10.0))
            pdb.db.execute("INSERT INTO exam_answers VALUES(?,?,?,?,?,?)", (sid, action, 0.9, mirror, 0.9, 0))
    pdb.close()


def live_db(path, rows):
    db = sqlite3.connect(path)
    db.executescript(live._SCHEMA_SQL)
    with db:
        for no, (status, entry, exit_, net_bp) in enumerate(rows, 1):
            db.execute("INSERT INTO trades(product, trade_no, status, side, entry_ms, exit_ms, net_bp, funding_status, "
                       "closed_by, net_usd, notional_usd, funding_usd) VALUES('PF_XBTUSD',?,?,?,?,?,?,?,?,?,?,?)",
                       (no, status, "LONG", entry, exit_, net_bp, "complete", "qwen", "0.5", "100", "0.01"))
    db.close()


class QwenLiveTradesTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.exam = os.path.join(self.dir.name, "exam.sqlite")
        self.live = os.path.join(self.dir.name, "live.sqlite")

    def source(self):
        return models.QwenLiveTrades(self.live, self.exam)

    def test_is_a_model_subject_with_a_stable_spec(self):
        self.assertTrue(models.is_model(models.QWEN_LIVE_ID))
        spec = models.model_spec(models.QWEN_LIVE_ID)
        self.assertEqual(spec["id"], models.QWEN_LIVE_ID)
        self.assertEqual(spec, models.model_spec(models.QWEN_LIVE_ID))

    def test_live_closed_trades_only_inside_the_window(self):
        live_db(self.live, [("closed", LIVE_T0, LIVE_T0 + HOUR, 12.5), ("open", LIVE_T0 + 2 * HOUR, None, None)])
        got, open_at_end = self.source()(None, "PF_XBTUSD", None, [], [], [], LIVE_T0, LIVE_T0 + 10 * HOUR, lambda f: None)
        self.assertEqual([t["net_bp"] for t in got], [12.5])
        self.assertEqual(got[0]["source"], "live")
        self.assertEqual(open_at_end, 0)
        none, _ = self.source()(None, "PF_XBTUSD", None, [], [], [], T0, T0 + HOUR, lambda f: None)
        self.assertEqual(none, [])

    def test_photos_become_one_position_at_a_time_after_costs(self):
        photo_db(self.exam, [(T0, "LARGO", "CORTO", 50.0),
                             (T0 + HOUR, "LARGO", "CORTO", 80.0),          # still inside the 4 h of the first one
                             (T0 + 5 * HOUR, "CORTO", "LARGO", 30.0),
                             (T0 + 9 * HOUR, "LARGO", "LARGO", 99.0),      # the mirror blocks it
                             (T0 + 12 * HOUR, "ESPERAR", "ESPERAR", 99.0)])
        got, _ = self.source()(None, "PF_XBTUSD", None, [], [], [], T0, T0 + 30 * HOUR, lambda f: None)
        self.assertEqual([(t["side"], round(t["net_bp"], 6)) for t in got], [("LONG", 40.0), ("SHORT", -40.0)])
        self.assertEqual(got[0]["exit_time_ms"] - got[0]["entry_time_ms"], models.LIVE_HOLD_MS)
        self.assertEqual({t["funding_status"] for t in got}, {"unknown"})

    def test_missing_files_give_no_trades(self):
        got, _ = self.source()(None, "PF_XBTUSD", None, [], [], [], T0, T0 + HOUR, lambda f: None)
        self.assertEqual(got, [])


if __name__ == "__main__":
    unittest.main()
