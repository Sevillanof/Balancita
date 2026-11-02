"""Cada intento del experto rebotes deja una fila en la base (comprado, sin cupo, reintento): una caída que no compró no es invisible."""
import os
import tempfile
import unittest

from balancita_engine import futures_qwen_live as live


class ReboundRecordTests(unittest.TestCase):
    def test_every_attempt_leaves_a_row_and_a_retry_is_replaced_by_the_buy_of_the_same_candle_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = live.LiveStore(os.path.join(tmp, "live.sqlite"))
            base = {"type": "rebote", "caida_pct": 5.1, "umbral_pct": 5.0}
            with store.db:
                store.put_rebote("PF_ETHUSD", dict(base, t_ms=1000, episodio_ms=1000, action="reintento", motivo="ejecucion_tarde",
                                                   detalle="vela tardía"), 1500)
                store.put_rebote("PF_ETHUSD", dict(base, t_ms=1300, episodio_ms=1000, action="abierta", trade_no=7), 1800)
                store.put_rebote("PF_ETHUSD", dict(base, t_ms=9000, episodio_ms=9000, action="sin_cupo", motivo="lugares_ocupados",
                                                   detalle="ocupados"), 9100)
            rows = store.db.execute("SELECT t_ms, episodio_ms, action, motivo, trade_no FROM rebotes ORDER BY t_ms").fetchall()
            self.assertEqual([tuple(r) for r in rows], [
                (1000, 1000, "reintento", "ejecucion_tarde", None), (1300, 1000, "abierta", None, 7),
                (9000, 9000, "sin_cupo", "lugares_ocupados", None)])


if __name__ == "__main__":
    unittest.main()
