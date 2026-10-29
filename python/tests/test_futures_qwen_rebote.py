import json
import os
import tempfile
import unittest

from balancita_engine import futures_qwen_rebote as rb
from balancita_engine import futures_qwen_trader as qt

BAR, MIN, HOUR = rb.BAR_MS, rb.MIN_MS, rb.HOUR_MS
T0 = qt.date_ms("2024-03-01")
HOLDOUT = qt.date_ms("2024-04-15")


def series(closes, start=T0):
    """Velas de 5 min con esos cierres (apertura y extremos iguales: solo importa el cierre)."""
    return [{"bucket_start": start + k * BAR, "close": str(c)} for k, c in enumerate(closes)]


def flat_with_drop(n, at, drop_pct, base=2000.0):
    """``n`` cierres planos; en la vela ``at`` el cierre es ``drop_pct`` % más bajo que el de 12 velas antes."""
    closes = [base] * n
    for k in range(at, n):
        closes[k] = base * (1 + drop_pct / 100)
    return closes


class FakeMinutes:
    """Cierres de 1 min: el precio de las velas de 5 min vale para los minutos de cada vela."""

    def __init__(self, eth):
        self.eth, self.asked = {int(b["bucket_start"]): float(b["close"]) for b in eth}, []

    def close_at(self, t_ms):
        self.asked.append(t_ms)
        return self.eth[t_ms - t_ms % BAR]

    def save(self):
        pass


class FakeHistory:
    offline = True
    cache_dir = "."

    def __init__(self, eth, btc):
        self.data = {rb.PRODUCT: eth, rb.BTC: btc}

    def bars(self, product, from_ms, to_ms):
        return [b for b in self.data[product] if from_ms <= int(b["bucket_start"]) < to_ms]


class FindDropsTest(unittest.TestCase):
    principal, filtro = rb.VARIANTS

    def test_a_drop_of_5_percent_in_an_hour_fires_and_4_9_does_not(self):
        n = 12 * 24 * 3
        fires = rb.find_drops(series(flat_with_drop(n, 12 * 30, -5.0)), None, self.principal, T0, T0 + n * BAR)
        self.assertEqual(len(fires), 1)
        self.assertEqual(fires[0]["t_ms"], T0 + (12 * 30 + 1) * BAR - BAR + BAR)    # decide al cierre de la vela que cae
        self.assertEqual(fires[0]["pct"], -5.0)
        self.assertEqual(fires[0]["desde_ms"], fires[0]["t_ms"] - HOUR)
        self.assertEqual(rb.find_drops(series(flat_with_drop(n, 12 * 30, -4.9)), None, self.principal, T0, T0 + n * BAR), [])

    def test_a_drop_that_stays_down_fires_once_and_the_next_look_does_not_repeat_it(self):
        n = 12 * 24 * 3
        got = rb.find_drops(series(flat_with_drop(n, 12 * 30, -6.0)), None, self.principal, T0, T0 + n * BAR)
        self.assertEqual(len(got), 1)                        # las 11 velas siguientes siguen 5 % abajo, pero ya hay posición

    def test_one_position_at_a_time_with_an_hour_of_rest(self):
        n = 12 * 24 * 6
        closes = flat_with_drop(n, 12 * 30, -6.0)
        eth = series(closes)
        # fuerzo una segunda caída justo después de salir de la primera operación
        first = rb.find_drops(eth, None, self.principal, T0, T0 + n * BAR)[0]
        drops = rb.find_drops(eth, None, self.principal, T0, T0 + n * BAR)
        self.assertEqual(drops[0], first)
        # nada dentro de las 24 h + 60 min de la primera
        free = first["t_ms"] + (1440 + 60) * MIN
        self.assertTrue(all(d["t_ms"] - MIN >= free for d in drops[1:]))

    def test_filter_needs_eth_to_fall_two_points_more_than_btc(self):
        n = 12 * 24 * 3
        eth = series(flat_with_drop(n, 12 * 30, -6.0))
        same = series(flat_with_drop(n, 12 * 30, -5.0, base=60000.0))       # BTC cayó 5 %: ETH solo 1 punto peor
        worse = series(flat_with_drop(n, 12 * 30, -3.0, base=60000.0))      # BTC cayó 3 %: ETH 3 puntos peor
        self.assertEqual(rb.find_drops(eth, same, self.filtro, T0, T0 + n * BAR), [])
        got = rb.find_drops(eth, worse, self.filtro, T0, T0 + n * BAR)
        self.assertTrue(got)
        self.assertEqual(got[0]["btc_pct"], -3.0)
        self.assertEqual(rb.find_drops(eth, None, self.filtro, T0, T0 + n * BAR), [])      # sin BTC no se puede juzgar

    def test_gaps_in_the_series_do_not_make_a_drop(self):
        eth = series([2000.0] * 40)
        eth += [{"bucket_start": T0 + 80 * BAR + k * BAR, "close": "1800"} for k in range(20)]    # salto por un hueco de 40 velas
        self.assertEqual(rb.find_drops(eth, None, self.principal, T0, T0 + 200 * BAR), [])


class TradeTest(unittest.TestCase):
    def test_enters_at_the_next_minute_and_exits_24_hours_later_with_costs(self):
        n = 12 * 24 * 4
        closes = flat_with_drop(n, 12 * 30, -6.0)
        for k in range(12 * 30 + 12 * 24 + 1, n):
            closes[k] = closes[12 * 30] * 1.04
        eth = series(closes)
        drop = rb.find_drops(eth, None, rb.VARIANTS[0], T0, T0 + n * BAR)[0]
        minutes = FakeMinutes(eth)
        trade = rb.trade_of(drop, rb.VARIANTS[0], minutes, {int(b["bucket_start"]): b for b in eth})
        self.assertEqual(trade["entrada_ms"], drop["t_ms"] + MIN)
        self.assertEqual(trade["salida_ms"], drop["t_ms"] + 1440 * MIN + MIN)
        self.assertEqual(minutes.asked, [drop["t_ms"], drop["t_ms"] + 1440 * MIN])
        self.assertEqual(trade["lado"], 1)
        expected = (trade["salida_px"] / trade["entrada_px"] - 1) * 1e4 - 2 * rb.TAKER_BP
        self.assertAlmostEqual(trade["neto_bp"], expected, places=2)
        self.assertEqual(trade["caida"]["pct"], -6.0)
        self.assertTrue(trade["velas"])
        self.assertTrue(all(trade["entrada_ms"] - rb.BEFORE_MS <= t <= trade["salida_ms"] + rb.AFTER_MS for t, _ in trade["velas"]))


class AccountTest(unittest.TestCase):
    def trades(self, nets):
        return [{"neto_bp": n, "salida_ms": T0 + (k + 1) * HOUR, "entrada_ms": T0 + k * HOUR, "motivo": rb.REASON}
                for k, n in enumerate(nets)]

    def test_compound_uses_the_whole_account_and_fixed_uses_100(self):
        trades = self.trades([1000.0, -500.0])                  # +10 % y -5 %
        big = rb.account(trades, "compuesto")
        small = rb.account(trades, "fijo")
        self.assertEqual(trades[0]["cuenta"]["compuesto"]["nocional_usd"], 1000.0)
        self.assertEqual(trades[0]["cuenta"]["compuesto"]["cuenta_usd"], 1100.0)
        self.assertEqual(trades[1]["cuenta"]["compuesto"]["nocional_usd"], 1100.0)     # 1.000 + lo ganado
        self.assertEqual(big["final_usd"], 1045.0)
        self.assertEqual(big["caida_maxima_pct"], 5.0)
        self.assertEqual(trades[1]["cuenta"]["fijo"]["nocional_usd"], 100.0)
        self.assertEqual(small["final_usd"], 1005.0)
        self.assertEqual([p[1] for p in big["curva"]], [1100.0, 1045.0])

    def test_a_loss_reduces_the_next_size(self):
        trades = self.trades([-1000.0, 1000.0])
        rb.account(trades, "compuesto")
        self.assertEqual(trades[1]["cuenta"]["compuesto"]["nocional_usd"], 900.0)


class BuildTest(unittest.TestCase):
    def test_build_and_run_leave_both_variants_with_accounts_and_a_red_meter(self):
        day = 12 * 24
        n = day * 40
        closes = [2000.0] * n
        for k, start in enumerate(range(day * 3, day * 36, day * 6)):     # una caída de 6 % cada 6 días, con rebote a las 24 h
            for i in range(start, min(n, start + day * 3)):
                closes[i] = 2000.0 * (0.94 if i < start + day else 1.02 + 0.01 * k)
        eth = series(closes)
        btc = series([60000.0] * n)
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["BALANCITA_WF_INTENTOS"] = os.path.join(tmp, "intentos.jsonl")
            self.addCleanup(os.environ.pop, "BALANCITA_WF_INTENTOS", None)
            out = rb.build(FakeHistory(eth, btc), HOLDOUT, FakeMinutes(eth), start_ms=T0, log=lambda *a: None)
        self.assertEqual([v["id"] for v in out["variantes"]], ["principal", "filtro_btc"])
        main, filtered = out["variantes"]
        self.assertEqual(main["caidas"], len(main["operaciones"]))
        self.assertGreaterEqual(main["caidas"], 3)
        self.assertEqual(main["cuentas"]["compuesto"]["inicial_usd"], 1000.0)
        self.assertGreater(main["cuentas"]["compuesto"]["final_usd"], 1000.0)
        self.assertEqual(main["honestidad"]["fuera_del_ajuste_pct"], 0.0)       # la regla se eligió con este mismo período
        self.assertEqual(main["honestidad"]["semaforo"], "rojo")
        self.assertTrue(main["honestidad"]["holdout_intacto"])
        self.assertEqual(filtered["caidas"], main["caidas"])                     # BTC quieto: ETH cayó 6 puntos más que BTC
        self.assertEqual(filtered["salida_horas"], 4.0)
        json.dumps(out)                                                          # todo se puede guardar

    def test_the_run_writes_done_or_the_reason_it_failed(self):
        class Down(FakeHistory):
            def bars(self, *a):
                raise rb.ReboteError("sin velas")

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "rapida-v3-rebote.json")
            state = rb.run_rebote(Down([], []), HOLDOUT, path, {"id": "rebote"}, minutes=FakeMinutes([]), log=lambda *a: None)
            self.assertEqual(state["state"], "failed")
            self.assertIn("sin velas", state["error"])
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(json.load(handle)["state"], "failed")


if __name__ == "__main__":
    unittest.main()
