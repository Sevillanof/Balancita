"""Kronos' stages are tramos of its own recorded operation: five practice ones and, newest, the exam."""
import json
import os
import shutil
import sqlite3
import tempfile
import unittest

import test_strategy_gate as tg
from balancita_engine import strategy_gate_models as models

DAY = 86_400_000
HOUR = 3_600_000


def kronos_db(directory, entries, backtest=()):
    db = sqlite3.connect(os.path.join(directory, "kronos.sqlite"))
    db.execute("CREATE TABLE trade(product_id TEXT, decision_ms INTEGER, mode TEXT, payload TEXT)")
    for mode, rows in (("forward", entries), ("backtest", backtest)):
        for entry in rows:
            db.execute("INSERT INTO trade VALUES('PF_XBTUSD',?,?,?)", (entry, mode, json.dumps(
                {"side": "LONG", "entry_time_ms": entry, "exit_time_ms": entry + HOUR, "net_bp": 10.0})))
    db.commit()
    db.close()


class KronosStagesTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_trades_are_cut_into_five_practice_tramos_and_a_newest_exam(self):
        start = tg.HOLDOUT + 2 * HOUR
        kronos_db(self.dir, [start + i * 3 * HOUR for i in range(56)], backtest=[tg.T0 + HOUR])
        stages = models.kronos_stages(os.path.join(self.dir, "kronos.sqlite"), tg.NOW)
        practice, exam = stages["practice"], stages["exam"]
        self.assertEqual(len(practice), 5)
        self.assertIsNone(exam["to"])
        chain = [s["from"] for s in practice] + [exam["from"]]
        self.assertEqual(chain, sorted(set(chain)))
        self.assertEqual([s["to"] for s in practice], chain[1:])  # consecutive, no overlap
        self.assertEqual(practice[0]["from"], "2025-01-21")        # the backtest row before it is ignored

    def test_no_trades_means_no_stages(self):
        kronos_db(self.dir, [])
        self.assertEqual(models.kronos_stages(os.path.join(self.dir, "kronos.sqlite"), tg.NOW),
                         {"practice": [], "exam": None})
        self.assertEqual(models.kronos_stages(os.path.join(self.dir, "nope.sqlite"), tg.NOW)["exam"], None)

    def test_practice_and_exam_run_over_those_tramos_and_repeat(self):
        start = tg.HOLDOUT + 2 * HOUR
        kronos_db(self.dir, [start + i * 3 * HOUR for i in range(56)])
        stages = models.kronos_stages(os.path.join(self.dir, "kronos.sqlite"), tg.NOW)
        data = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, data, True)
        first = stages["practice"][0]
        practice = tg.run(models.KRONOS_ID, data, kronos_dir=self.dir, from_date=first["from"], to_date=first["to"])
        self.assertEqual(practice["status"], "done")
        exam = stages["exam"]
        for _ in range(2):
            result = tg.run(models.KRONOS_ID, data, kronos_dir=self.dir, kind="exam", from_date=exam["from"])
            self.assertEqual(result["status"], "done")


if __name__ == "__main__":
    unittest.main()
