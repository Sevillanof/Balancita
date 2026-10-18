"""Recuperación del funding tras apagar el Mac (docs/captura-recuperacion.md): la base se arma como la escribe el almacén."""
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone

from balancita_engine import futures_funding_context as fc

H = fc.HOUR_MS
LAG = 30_000
BACK = 810 * H + 35 * 60_000          # el Mac se apagó a las 800 h 30 min y vuelve 10 h después
SCHEMA = open(os.path.join(os.path.dirname(__file__), "real_futures_schema.sql"), encoding="utf-8").read()


def stamp(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rel(i):
    return 1e-5 + i * 1e-8


class FundingRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "m.sqlite")
        self.db = sqlite3.connect(self.path)
        self.db.executescript(SCHEMA)

    def tearDown(self):
        self.db.close()
        self.dir.cleanup()

    def poll(self, received, listed, sighted, new_periods):
        """Un sondeo: ``listed`` horas que lista Kraken, ``sighted`` las que el almacén avista, ``new_periods`` las filas nuevas de periods."""
        sha = "r%d" % received
        body = json.dumps({"rates": [{"timestamp": stamp(i * H), "fundingRate": 1, "relativeFundingRate": rel(i)}
                                     for i in listed]})
        self.db.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)", (sha, received, "t", body))
        for i in new_periods:
            self.db.execute("INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
                            (sha, i * H, (i + 1) * H, "1", received, "u", "PF_XBTUSD"))
        lines = ["serverTime=t"]
        for i in sighted:
            self.db.execute("INSERT INTO paper_futures_funding_sightings VALUES(?,?,?,?,?,?,?)",
                            ("PF_XBTUSD", i * H, received, "1", (i + 1) * H, "t", sha))
            lines.append(json.dumps({"timestamp": stamp(i * H), "fundingRate": 1, "relativeFundingRate": rel(i)}))
        self.db.execute("INSERT INTO paper_futures_funding_polls VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                        ("PF_XBTUSD", received, "startup", received, received, "ok", None, None, sha,
                         "\n".join(lines), "x", len(lines) - 1))
        self.db.commit()

    def capture_until_shutdown(self):
        """Sondeo horario justo tras cada apertura: avista la hora recién cerrada y lista la nueva abierta (fila de periods)."""
        for i in range(801):
            self.poll(i * H + LAG, [i - 1, i], [i - 1] if i else [], [i])

    def test_after_ten_hours_off_every_hour_is_known_at_the_restart_and_the_window_is_complete(self):
        self.capture_until_shutdown()
        # Al volver: periods solo para horas nuevas (la 800 ya estaba con la misma tasa), avistamiento de todas las cerradas.
        self.poll(BACK, range(790, 811), range(800, 810), range(801, 811))
        periods, info = fc.load_periods_detailed(self.path, "PF_XBTUSD")
        known = {s: k for s, _, k in periods}
        for i in range(800, 810):
            self.assertEqual(known[i * H], BACK, i)
        self.assertEqual(info["approximate"], set())
        found, code, reason = fc.funding_for(self.path, "PF_XBTUSD").assess(BACK + 5 * 60_000)
        self.assertEqual(code, "ok", reason)

    def test_with_the_old_two_hour_rule_the_same_scenario_has_gaps(self):
        self.capture_until_shutdown()
        self.poll(BACK, range(790, 811), range(808, 810), range(801, 811))
        found, code, _ = fc.funding_for(self.path, "PF_XBTUSD").assess(BACK + 5 * 60_000)
        self.assertEqual(code, "window_gaps")

    def test_hourly_polls_after_the_restart_resight_only_two_hours_and_keep_the_first_known_at(self):
        self.capture_until_shutdown()
        self.poll(BACK, range(790, 811), range(800, 810), range(801, 811))
        later = BACK + H
        self.poll(later, range(790, 812), range(809, 811), [811])  # cursor 809 + re-sight de 2 h, no las anteriores
        rows = self.db.execute("SELECT COUNT(*) FROM paper_futures_funding_sightings WHERE received_at=?", (later,)).fetchone()[0]
        self.assertEqual(rows, 2)
        periods, info = fc.load_periods_detailed(self.path, "PF_XBTUSD")
        known = {s: k for s, _, k in periods}
        for i in range(800, 809):
            self.assertEqual(known[i * H], BACK, i)
        self.assertEqual(info["approximate"], set())


if __name__ == "__main__":
    unittest.main()
