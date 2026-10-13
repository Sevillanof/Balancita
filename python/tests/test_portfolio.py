"""Shared paper portfolio: capital, risk sizing, exposure limits, simultaneous and contradictory intents,
LONG/SHORT accounting with fees and funding, rejection log and determinism."""

import unittest
from decimal import Decimal

from balancita_engine.futures_costs import fee_rate
from balancita_engine.multi_signals import BUY, SELL, WAIT, make_signal
from balancita_engine.portfolio import (
    LONG, SHORT, Portfolio, PortfolioPolicy, intent_from_signal, make_intent,
)

D = Decimal
T0 = 1_700_000_040_000  # a minute boundary
MIN = 60_000
HOUR = 3_600_000


def intent(product="PF_XBTUSD", side=LONG, strength="0.8", price="100", stop_pct="0.02", target_pct="0.03",
           strategy="s1", t=T0, horizon=240, **kw):
    price = D(price)
    sign = 1 if side == LONG else -1
    return make_intent(strategy_id=strategy, product_id=product, side=side, strength=strength, bucket_ms=t,
                       price=price, stop=price * (1 - sign * D(stop_pct)), target=price * (1 + sign * D(target_pct)),
                       horizon_minutes=horizon, **kw)


def candle(close, high=None, low=None):
    return {"close": str(close), "high": str(high if high is not None else close),
            "low": str(low if low is not None else close)}


def reasons(decision):
    return decision["reasons"]


class Sizing(unittest.TestCase):
    def test_risk_sizing_and_cap(self):
        p = Portfolio()
        # 1 % of 1 000 USD = 10 USD at risk. A 2 % stop (+ costs ~ 0.13 %) would size ~470 USD: capped at 100.
        [d] = p.decide([intent(stop_pct="0.02")], T0 + MIN)
        self.assertEqual(d["status"], "opened")
        self.assertEqual(d["notional_usd"], "100")
        self.assertIn("position_cap", d["limits_applied"])
        self.assertGreater(D(d["risk_notional_usd"]), D(400))

    def test_wide_stop_shrinks_the_position_below_the_cap(self):
        p = Portfolio()
        # 20 % stop: 10 / ~0.2013 = ~49.7 USD, under the 100 USD cap, so risk sizing decides.
        [d] = p.decide([intent(stop_pct="0.2", target_pct="0.3")], T0 + MIN)
        self.assertEqual(d["limits_applied"], [])
        self.assertTrue(D("49") < D(d["notional_usd"]) < D("50.5"), d["notional_usd"])
        # If the stop is hit, the loss (costs included) is about the 10 USD of risk, never more.
        p.on_candle("PF_XBTUSD", T0 + MIN, candle("79", high="100", low="79"))
        [t] = p.trades
        self.assertEqual(t["exit_reason"], "stop")
        self.assertTrue(D("-10.2") < D(str(t["pnl_usd"])) < D("-9.6"), t["pnl_usd"])

    def test_reserved_available_and_equity(self):
        p = Portfolio()
        p.decide([intent("PF_XBTUSD"), intent("PF_ETHUSD", side=SHORT)], T0 + MIN)
        snap = p.snapshot()
        self.assertEqual(snap["reserved_usd"], "200")
        self.assertEqual(snap["available_usd"], "800")
        self.assertEqual(snap["equity_usd"], "1000")
        self.assertEqual((snap["long_exposure_usd"], snap["short_exposure_usd"], snap["net_exposure_usd"]),
                         ("100", "100", "0"))

    def test_leverage_reduces_reserved_margin(self):
        p = Portfolio(PortfolioPolicy(leverage="5"))
        p.decide([intent()], T0 + MIN)
        self.assertEqual(p.snapshot()["reserved_usd"], "20")


class Limits(unittest.TestCase):
    def test_gross_limit_rejects_the_weakest(self):
        policy = PortfolioPolicy(max_gross_exposure_usd="250", max_net_exposure_usd="1000")
        p = Portfolio(policy)
        strengths = {"PF_XBTUSD": "0.9", "PF_ETHUSD": "0.7", "PF_SOLUSD": "0.5"}
        out = p.decide([intent(prod, strength=s) for prod, s in strengths.items()], T0 + MIN)
        opened = {d["product_id"]: d for d in out if d["status"] == "opened"}
        self.assertEqual(sorted(opened), ["PF_ETHUSD", "PF_SOLUSD", "PF_XBTUSD"])
        # 100 + 100 + 50: the third is cut to what the limit leaves, and says so.
        self.assertEqual(opened["PF_SOLUSD"]["notional_usd"], "50")
        self.assertIn("gross_limit", opened["PF_SOLUSD"]["limits_applied"])

    def test_gross_limit_rejects_when_under_minimum(self):
        policy = PortfolioPolicy(max_gross_exposure_usd="205", max_net_exposure_usd="1000")
        p = Portfolio(policy)
        out = p.decide([intent("PF_XBTUSD", strength="0.9"), intent("PF_ETHUSD", strength="0.8"),
                        intent("PF_SOLUSD", strength="0.1")], T0 + MIN)
        rejected = [d for d in out if d["status"] == "rejected"]
        self.assertEqual([(d["product_id"], reasons(d)) for d in rejected],
                         [("PF_SOLUSD", ["global_exposure_limit"])])

    def test_net_exposure_limit_applies_to_the_crowded_side_only(self):
        policy = PortfolioPolicy(max_net_exposure_usd="150", max_gross_exposure_usd="1000")
        p = Portfolio(policy)
        out = p.decide([intent("PF_XBTUSD", strength="0.9"), intent("PF_ETHUSD", strength="0.8"),
                        intent("PF_SOLUSD", strength="0.7", side=SHORT)], T0 + MIN)
        by = {d["product_id"]: d for d in out}
        self.assertEqual(by["PF_ETHUSD"]["notional_usd"], "50")     # long side capped by the net limit
        self.assertIn("net_limit", by["PF_ETHUSD"]["limits_applied"])
        self.assertEqual(by["PF_SOLUSD"]["notional_usd"], "100")    # the short reduces net exposure, no cap

    def test_margin_limit(self):
        p = Portfolio(PortfolioPolicy(initial_equity_usd="105", max_gross_exposure_usd="1000",
                                      max_net_exposure_usd="1000", risk_per_trade="0.5"))
        out = p.decide([intent("PF_XBTUSD", strength="0.9"), intent("PF_ETHUSD", strength="0.8")], T0 + MIN)
        by = {d["product_id"]: d for d in out}
        self.assertEqual(by["PF_XBTUSD"]["notional_usd"], "100")
        self.assertEqual(by["PF_ETHUSD"]["status"], "rejected")
        self.assertEqual(reasons(by["PF_ETHUSD"]), ["insufficient_margin"])

    def test_max_open_positions(self):
        p = Portfolio(PortfolioPolicy(max_open_positions=1, max_gross_exposure_usd="1000", max_net_exposure_usd="1000"))
        out = p.decide([intent("PF_XBTUSD", strength="0.9"), intent("PF_ETHUSD", strength="0.8")], T0 + MIN)
        self.assertEqual([(d["product_id"], d["status"]) for d in out],
                         [("PF_XBTUSD", "opened"), ("PF_ETHUSD", "rejected")])
        self.assertEqual(reasons(out[1]), ["max_open_positions"])

    def test_capital_is_released_when_a_position_closes(self):
        policy = PortfolioPolicy(max_gross_exposure_usd="100", max_net_exposure_usd="1000")
        p = Portfolio(policy)
        p.decide([intent("PF_XBTUSD")], T0 + MIN)
        [d] = p.decide([intent("PF_ETHUSD", t=T0 + MIN)], T0 + 2 * MIN)
        self.assertEqual(reasons(d), ["global_exposure_limit"])
        p.on_candle("PF_XBTUSD", T0 + MIN, candle("103.5", high="103.5", low="100"))   # target
        self.assertEqual(p.snapshot()["open_positions"], 0)
        [d] = p.decide([intent("PF_ETHUSD", t=T0 + 2 * MIN)], T0 + 3 * MIN)
        self.assertEqual(d["status"], "opened")


class Resolution(unittest.TestCase):
    def test_contradictory_signals_open_nothing(self):
        p = Portfolio()
        out = p.decide([intent(side=LONG, strategy="a"), intent(side=SHORT, strategy="b", strength="0.99")], T0 + MIN)
        self.assertEqual({d["status"] for d in out}, {"rejected"})
        self.assertEqual([reasons(d) for d in out], [["contradictory_signals"]] * 2)
        self.assertEqual(p.snapshot()["open_positions"], 0)

    def test_same_side_duplicates_keep_the_strongest(self):
        p = Portfolio()
        out = p.decide([intent(strategy="weak", strength="0.4"), intent(strategy="strong", strength="0.9")], T0 + MIN)
        by = {d["strategy_id"]: d for d in out}
        self.assertEqual(by["strong"]["status"], "opened")
        self.assertEqual(reasons(by["weak"]), ["duplicate_same_side"])
        self.assertEqual(p.snapshot()["open_positions"], 1)

    def test_order_of_intents_does_not_matter(self):
        intents = [intent("PF_XBTUSD", strength="0.6"), intent("PF_ETHUSD", strength="0.6"),
                   intent("PF_SOLUSD", side=SHORT, strength="0.9"), intent("PF_SOLUSD", strength="0.2", strategy="x"),
                   intent("PF_XRPUSD", strength="0.6")]
        policy = PortfolioPolicy(max_gross_exposure_usd="250", max_net_exposure_usd="1000")
        a, b = Portfolio(policy), Portfolio(policy)
        a.decide(intents, T0 + MIN)
        b.decide(list(reversed(intents)), T0 + MIN)
        self.assertEqual(a.ledger_hash(), b.ledger_hash())

    def test_open_position_blocks_same_and_opposite_entries(self):
        p = Portfolio()
        p.decide([intent()], T0 + MIN)
        same = p.decide([intent(t=T0 + MIN, strategy="b")], T0 + 2 * MIN)
        opposite = p.decide([intent(t=T0 + MIN, side=SHORT, strategy="c")], T0 + 2 * MIN)
        self.assertEqual(reasons(same[0]), ["position_already_open"])
        self.assertEqual(reasons(opposite[0]), ["opposite_position_open"])

    def test_every_failed_reason_is_listed(self):
        p = Portfolio()
        bad = intent("PF_UNKNOWNUSD", data_close_ms=T0 - 20 * MIN, target_pct="0.0001")
        [d] = p.decide([bad], T0 + MIN)
        self.assertEqual(d["status"], "rejected")
        self.assertEqual(set(reasons(d)), {"stale_data", "cost_data_missing", "target_does_not_clear_cost"})

    def test_invalid_levels_are_rejected(self):
        p = Portfolio()
        bad = make_intent(strategy_id="s", product_id="PF_XBTUSD", side=LONG, strength="0.5", bucket_ms=T0,
                          price="100", stop="101", target="99", horizon_minutes=60)
        [d] = p.decide([bad], T0 + MIN)
        self.assertIn("levels_unavailable", reasons(d))

    def test_signal_conversion(self):
        signal = make_signal(strategy_id="mx-momentum-v1", strategy_version=1, product_id="PF_XBTUSD", bucket_ms=T0,
                             action=SELL, strength="0.7", horizon_minutes=120, evidence={"x": 1})
        i = intent_from_signal(signal, price="100", atr="1")
        self.assertEqual((i["side"], i["stop"], i["target"]), (SHORT, "102", "97.0"))
        wait = make_signal(strategy_id="m", strategy_version=1, product_id="PF_XBTUSD", bucket_ms=T0, action=WAIT,
                           strength="0", horizon_minutes=60, evidence={})
        self.assertIsNone(intent_from_signal(wait, price="100", atr="1"))
        self.assertIsNone(intent_from_signal(signal, price="100", atr="0"))
        buy = make_signal(strategy_id="m", strategy_version=1, product_id="PF_XBTUSD", bucket_ms=T0, action=BUY,
                          strength="0.5", horizon_minutes=60, evidence={})
        self.assertEqual(intent_from_signal(buy, price="100", atr="1")["side"], LONG)


class Accounting(unittest.TestCase):
    def test_long_win_net_of_fees_and_costs(self):
        p = Portfolio()
        p.decide([intent("PF_XBTUSD")], T0 + MIN)
        [t] = p.on_candle("PF_XBTUSD", T0 + MIN, candle("103", high="103", low="100"))
        self.assertEqual((t["exit_reason"], t["side"]), ("target", "LONG"))
        gross = (D(t["exit_price"]) - D(t["entry_price"])) * D(t["quantity"])
        fees = (D(t["entry_price"]) + D(t["exit_price"])) * D(t["quantity"]) * fee_rate("taker")
        self.assertAlmostEqual(float(gross - fees), t["pnl_usd"], places=4)
        self.assertAlmostEqual(t["fees_usd"], float(fees), places=4)
        self.assertGreater(t["pnl_usd"], 2.3)
        self.assertEqual(p.snapshot()["equity_usd"][:5], str(D(1000) + D(str(t["pnl_usd"])))[:5])

    def test_short_loss_at_stop(self):
        p = Portfolio()
        p.decide([intent("PF_ETHUSD", side=SHORT)], T0 + MIN)
        [t] = p.on_candle("PF_ETHUSD", T0 + MIN, candle("101", high="102.5", low="100"))
        self.assertEqual((t["exit_reason"], t["side"]), ("stop", "SHORT"))
        self.assertLess(t["pnl_usd"], -2.0)

    def test_time_stop(self):
        p = Portfolio()
        p.decide([intent(horizon=3)], T0 + MIN)
        closed = []
        for k in range(1, 6):
            closed += p.on_candle("PF_XBTUSD", T0 + k * MIN, candle("100.1", high="100.2", low="100"))
        self.assertEqual([t["exit_reason"] for t in closed], ["time_stop"])

    def test_funding_paid_by_longs_and_received_by_shorts(self):
        # +0.01 % per hour for the whole holding period (2 h).
        funding = {"PF_XBTUSD": [(T0, T0 + 3 * HOUR, "0.0001")]}
        results = {}
        for side in (LONG, SHORT):
            p = Portfolio(funding=funding)
            p.decide([intent(side=side, horizon=120)], T0 + MIN)
            closed = []
            for k in range(1, 125):
                closed += p.on_candle("PF_XBTUSD", T0 + k * MIN, candle("100", high="100.1", low="99.9"))
            [t] = closed
            results[side] = t
            self.assertTrue(t["net_complete"])
        self.assertAlmostEqual(results[LONG]["funding_usd"], 0.02, places=3)    # 100 USD x 1e-4 x 2 h
        self.assertAlmostEqual(results[SHORT]["funding_usd"], -0.02, places=3)
        self.assertLess(results[LONG]["pnl_usd"], results[SHORT]["pnl_usd"])

    def test_position_crossing_a_funding_period_boundary(self):
        funding = {"PF_XBTUSD": [(T0 - HOUR, T0 + HOUR, "0.0001"), (T0 + HOUR, T0 + 3 * HOUR, "-0.0002")]}
        p = Portfolio(funding=funding)
        p.decide([intent(horizon=120)], T0 + MIN)
        closed = []
        for k in range(1, 125):
            closed += p.on_candle("PF_XBTUSD", T0 + k * MIN, candle("100", high="100.1", low="99.9"))
        [t] = closed
        # entered at T0+1m: 59 min at +1e-4/h, then 61 min at -2e-4/h, on 100 USD.
        expected = 100 * (1e-4 * 59 / 60 - 2e-4 * 61 / 60)
        self.assertAlmostEqual(t["funding_usd"], expected, places=3)
        self.assertTrue(t["net_complete"])

    def test_unknown_funding_is_not_zero(self):
        p = Portfolio(funding={"PF_XBTUSD": [(T0, T0 + 30 * MIN, "0.0001")]})   # covers only the first half hour
        p.decide([intent(horizon=60)], T0 + MIN)
        closed = []
        for k in range(1, 64):
            closed += p.on_candle("PF_XBTUSD", T0 + k * MIN, candle("100", high="100.1", low="99.9"))
        [t] = closed
        self.assertFalse(t["net_complete"])
        self.assertIsNone(t["net_usd"])
        self.assertIsNotNone(t["partial_usd"])
        snap = p.snapshot()
        self.assertEqual(snap["complete_trades"], 0)
        self.assertEqual(snap["realized_complete_usd"], "0")
        self.assertNotEqual(snap["realized_partial_usd"], "0")

    def test_no_funding_history_at_all_is_incomplete(self):
        p = Portfolio()
        p.decide([intent(horizon=5)], T0 + MIN)
        closed = []
        for k in range(1, 8):
            closed += p.on_candle("PF_XBTUSD", T0 + k * MIN, candle("100", high="100.1", low="99.9"))
        self.assertFalse(closed[0]["net_complete"])
        self.assertIsNone(closed[0]["funding_usd"])

    def test_unrealized_pnl_is_reported_but_not_spendable(self):
        p = Portfolio()
        p.decide([intent()], T0 + MIN)
        p.on_candle("PF_XBTUSD", T0 + MIN, candle("102", high="102", low="100"))
        snap = p.snapshot()
        self.assertGreater(D(snap["unrealized_usd"]), D(1))
        self.assertEqual(snap["equity_usd"], "1000")
        self.assertEqual(snap["available_usd"], "900")


class Suspension(unittest.TestCase):
    def _lose(self, p, product, k):
        p.decide([intent(product, t=T0 + k * 10 * MIN, stop_pct="0.1", target_pct="0.2")], T0 + k * 10 * MIN + MIN)
        p.on_candle(product, T0 + k * 10 * MIN + MIN, candle("85", high="100", low="85"))

    def test_daily_loss_limit_suspends_new_entries(self):
        p = Portfolio(PortfolioPolicy(daily_loss_limit_usd="8", max_drawdown_usd="1000", risk_per_trade="0.1"))
        self._lose(p, "PF_XBTUSD", 0)
        self.assertLessEqual(p.realized_today_usd(T0 + 11 * MIN), D(-8))
        [d] = p.decide([intent("PF_ETHUSD", t=T0 + 30 * MIN)], T0 + 31 * MIN)
        self.assertEqual(reasons(d), ["suspended_daily_loss"])

    def test_drawdown_suspends_even_on_a_new_day(self):
        p = Portfolio(PortfolioPolicy(daily_loss_limit_usd="1000", max_drawdown_usd="10", risk_per_trade="0.1"))
        self._lose(p, "PF_XBTUSD", 0)
        later = T0 + 2 * 86_400_000
        [d] = p.decide([intent("PF_ETHUSD", t=later - MIN)], later)
        self.assertEqual(reasons(d), ["suspended_drawdown"])

    def test_losses_shrink_the_risk_budget(self):
        p = Portfolio(PortfolioPolicy(max_drawdown_usd="1000", daily_loss_limit_usd="1000"))
        before = p.risk_notional(intent(stop_pct="0.2"))
        p.decide([intent(stop_pct="0.1", target_pct="0.2")], T0 + MIN)
        p.on_candle("PF_XBTUSD", T0 + MIN, candle("85", high="100", low="85"))
        self.assertLess(p.risk_notional(intent(stop_pct="0.2")), before)


class Determinism(unittest.TestCase):
    def _run(self):
        p = Portfolio(PortfolioPolicy(max_gross_exposure_usd="250", max_net_exposure_usd="1000"),
                      funding={"PF_XBTUSD": [(T0, T0 + 10 * HOUR, "0.00005")]})
        p.decide([intent("PF_XBTUSD", strength="0.9"), intent("PF_ETHUSD", side=SHORT, strength="0.8"),
                  intent("PF_SOLUSD", strength="0.7"), intent("PF_SOLUSD", side=SHORT, strength="0.6", strategy="z")],
                 T0 + MIN)
        for k in range(1, 400):
            price = D(100) + D(k % 17) * D("0.3")
            for product in ("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"):
                p.on_candle(product, T0 + k * MIN, candle(price, high=price + D("0.8"), low=price - D("0.8")))
        return p

    def test_same_inputs_same_ledger(self):
        a, b = self._run(), self._run()
        self.assertEqual(a.ledger_hash(), b.ledger_hash())
        self.assertEqual(a.snapshot(), b.snapshot())

    def test_policy_hash_changes_with_policy(self):
        self.assertNotEqual(PortfolioPolicy().policy_hash(), PortfolioPolicy(max_gross_exposure_usd="500").policy_hash())


if __name__ == "__main__":
    unittest.main()
