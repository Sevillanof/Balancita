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


def photo_db(path, photos, config_hash=None, mirrored=True):
    """``photos``: (t_ms, lean, move_240); the lean is the real-numbers lean, the mirror leans the other way."""
    pdb = qt.PracticeDB(path)
    pdb.db.executescript(ex._EXAM_SQL)
    pdb.set_meta("config_hash", config_hash or qt.config_hash(qt.load_config(qt.CONFIG_PATH_LIVE)))
    with pdb.db:
        for order, (t_ms, lean, move) in enumerate(photos):
            sid = ex.snap_id("PF_XBTUSD", t_ms)
            pdb.db.execute("INSERT INTO exam_snapshots VALUES(?,?,?,?,?,?,?,?,?)",
                           (sid, "PF_XBTUSD", t_ms, order, "[]", "s", "m", json.dumps({"240": move, "1440": 0}), 10.0))
            pdb.db.execute("INSERT INTO exam_answers VALUES(?,?,?,?,?,?)",
                           (sid, "ESPERAR", 0.9, "ESPERAR" if mirrored else None, 0.9 if mirrored else None, 0))
            for step, signed in (("action", lean), ("mirror", -lean)):
                if step == "mirror" and not mirrored:
                    continue
                for variant in (0, 1):
                    pdb.put_call({"key": sid, "t_ms": t_ms, "step": step, "variant": variant, "order": [0, 1, 2],
                                  "probabilities": {"LARGO": 0.5 + signed / 2, "CORTO": 0.5 - signed / 2, "ESPERAR": 0.0},
                                  "chosen": "ESPERAR", "confidence": 0.5, "source": "t", "latency_ms": 1,
                                  "prompt_hash": "h", "prompt_version": 1, "state_hash": "x", "model": "m",
                                  "asked_at_ms": 0})
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
        return models.QwenLiveTrades(self.live, self.exam, replay=lambda *a: [])

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

    def test_photos_follow_the_lean_extremes_even_when_qwen_always_waits(self):
        leans = [0.4, 0.1, -0.1, 0.05, -0.05, -0.4, 0.0, 0.02, -0.02, 0.01]
        photo_db(self.exam, [(T0 + 5 * HOUR * i, lean, 50.0 if lean > 0 else -50.0) for i, lean in enumerate(leans)])
        got = self.source().photo_trades("PF_XBTUSD", [])
        self.assertEqual([(t["side"], round(t["net_bp"], 6)) for t in got], [("LONG", 40.0), ("SHORT", 40.0)])
        self.assertEqual(got[0]["exit_time_ms"] - got[0]["entry_time_ms"], models.LIVE_HOLD_MS)
        self.assertEqual({t["funding_status"] for t in got}, {"unknown"})

    def test_photos_without_the_mirror_question_are_ordered_by_the_plain_lean(self):
        leans = [0.4, 0.1, -0.1, 0.05, -0.05, -0.4, 0.0, 0.02, -0.02, 0.01]
        photo_db(self.exam, [(T0 + 5 * HOUR * i, lean, 50.0 if lean > 0 else -50.0) for i, lean in enumerate(leans)],
                 mirrored=False)
        got = self.source().photo_trades("PF_XBTUSD", [])
        self.assertEqual([(t["side"], round(t["net_bp"], 6)) for t in got], [("LONG", 40.0), ("SHORT", 40.0)])

    def test_photos_asked_with_another_protocol_never_count(self):
        photo_db(self.exam, [(T0, 0.4, 50.0), (T0 + 6 * HOUR, -0.4, -30.0)], config_hash="otro-protocolo")
        got = self.source().photo_trades("PF_XBTUSD", [])
        self.assertEqual(got, [])

    def test_kronos_backtest_rows_are_never_evidence(self):
        path = os.path.join(self.dir.name, "kronos.sqlite")
        db = sqlite3.connect(path)
        db.execute("CREATE TABLE trade(product_id TEXT, decision_ms INTEGER, mode TEXT, payload TEXT)")
        for mode, net in (("forward", 7), ("backtest", 99)):
            db.execute("INSERT INTO trade VALUES('PF_XBTUSD', ?, ?, ?)", (T0 if mode == "forward" else T0 + HOUR, mode,
                       json.dumps({"side": "LONG", "entry_time_ms": T0, "exit_time_ms": T0 + HOUR, "net_bp": net})))
        db.commit()
        db.close()
        got, _ = models.RecordedTrades(path, "trade")(models.model_spec(models.KRONOS_ID), "PF_XBTUSD", None, [], [], [],
                                                       T0, T0 + 10 * HOUR, lambda f: None)
        self.assertEqual([t["net_bp"] for t in got], [7])

    def test_live_config_identity_comes_from_the_database(self):
        live_db(self.live, [])
        db = sqlite3.connect(self.live)
        db.execute("INSERT OR REPLACE INTO meta VALUES('config_hash', 'hash-de-la-base')")
        db.commit()
        db.close()
        self.assertEqual(models.live_config_hash(self.dir.name), "hash-de-la-base")
        self.assertNotEqual(models.model_spec(models.QWEN_LIVE_ID, self.dir.name), models.model_spec(models.QWEN_LIVE_ID))

    def test_photo_positions_do_not_overlap(self):
        photo_db(self.exam, [(T0, 0.4, 50.0), (T0 + HOUR, 0.39, 80.0), (T0 + 6 * HOUR, -0.4, -30.0),
                             (T0 + 12 * HOUR, 0.0, 0.0), (T0 + 18 * HOUR, 0.0, 0.0)])
        got = self.source().photo_trades("PF_XBTUSD", [])
        self.assertEqual([t["entry_time_ms"] for t in got], [T0, T0 + 6 * HOUR])

    def test_the_window_is_judged_by_the_replay_of_the_live_scheme_plus_the_live_trades(self):
        asked = []
        replay = lambda product, funding, start, end: asked.append((product, start, end)) or [
            {"side": "LONG", "entry_time_ms": T0, "exit_time_ms": T0 + HOUR, "net_bp": 5.0, "source": "formula"}]
        live_db(self.live, [("closed", LIVE_T0, LIVE_T0 + HOUR, 12.5)])
        got, _ = models.QwenLiveTrades(self.live, self.exam, replay=replay)(
            None, "PF_XBTUSD", None, [], [], [], T0, LIVE_T0 + 10 * HOUR, lambda f: None)
        self.assertEqual(asked, [("PF_XBTUSD", T0, LIVE_T0 + 10 * HOUR)])
        self.assertEqual([(t["source"], t["net_bp"]) for t in got], [("formula", 5.0), ("live", 12.5)])

    def test_missing_files_give_no_trades(self):
        got, _ = self.source()(None, "PF_XBTUSD", None, [], [], [], T0, T0 + HOUR, lambda f: None)
        self.assertEqual(got, [])


if __name__ == "__main__":
    unittest.main()
