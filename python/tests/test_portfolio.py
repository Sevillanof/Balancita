"""Shared paper portfolio: dynamic risk sizing, 30 % rule, aggregate limits, idempotency, validation before
contradictions, provisional vs definitive capital, temporal order, LONG/SHORT accounting, extreme scenarios."""

import unittest
from decimal import Decimal
from unittest import mock

from balancita_engine import futures_simulator
from balancita_engine.futures_costs import exit_fill, fee_rate
from balancita_engine.multi_signals import BUY, SELL, WAIT, make_signal
from balancita_engine.portfolio import (
    LONG, SHORT, Portfolio, PortfolioError, PortfolioPolicy, intent_from_signal, make_intent,
)

D = Decimal
T0 = 1_700_000_040_000  # a minute boundary
MIN = 60_000
HOUR = 3_600_000
FULL_FUNDING = {p: [(T0 - 2 * HOUR, T0 + 48 * HOUR, "0")] for p in
                ("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD", "PF_ADAUSD", "PF_HYPEUSD")}


def roomy(**kw):
    """Policy where only the per-trade risk rule binds (the aggregate limits are tested on their own)."""
    base = dict(max_product_exposure_pct="10", max_gross_exposure_pct="10", max_net_exposure_pct="10",
                max_open_risk_pct="10")
    return PortfolioPolicy(**dict(base, **kw))


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


def opened(decisions):
    return [d for d in decisions if d["status"] == "opened"]


class DynamicSizing(unittest.TestCase):
    def test_different_stop_distances_give_different_sizes(self):
        sizes = {}
        for pct in ("0.01", "0.02", "0.04", "0.08"):
            [d] = Portfolio(roomy()).decide([intent(stop_pct=pct, target_pct="0.12")], T0 + MIN)
            sizes[pct] = D(d["notional_usd"])
        self.assertTrue(sizes["0.01"] > sizes["0.02"] > sizes["0.04"] > sizes["0.08"], sizes)
        # About budget / (stop + costs): 10 / 0.0212 ~ 472; 10 / 0.0812 ~ 123.
        self.assertTrue(D(450) < sizes["0.02"] < D(490), sizes)
        self.assertTrue(D(115) < sizes["0.08"] < D(130), sizes)

    def test_higher_volatility_shrinks_size_at_the_same_risk_budget(self):
        out = {}
        for atr in ("0.5", "1", "2", "3"):
            sig = make_signal(strategy_id="mx", strategy_version=1, product_id="PF_XBTUSD", bucket_ms=T0, action=BUY,
                              strength="0.7", horizon_minutes=120, evidence={})
            i = intent_from_signal(sig, price="100", atr=atr)
            [d] = Portfolio(roomy()).decide([i], T0 + MIN)
            out[atr] = d
        sizes = [D(out[a]["notional_usd"]) for a in ("0.5", "1", "2", "3")]
        self.assertEqual(sizes, sorted(sizes, reverse=True))
        self.assertEqual(len({d["risk_budget_used_usd"] for d in out.values()}), 1)
        for d in out.values():   # the planned loss is the budget, whatever the volatility
            self.assertAlmostEqual(float(d["planned_loss_usd"]), 10.0, delta=0.02)

    def test_risk_budget_follows_equity(self):
        small, big = Portfolio(roomy(initial_equity_usd="500")), Portfolio(roomy(initial_equity_usd="2000"))
        [a] = small.decide([intent()], T0 + MIN)
        [b] = big.decide([intent()], T0 + MIN)
        self.assertEqual((a["risk_budget_used_usd"], b["risk_budget_used_usd"]), ("5.00", "20.00"))
        self.assertAlmostEqual(float(D(b["notional_usd"]) / D(a["notional_usd"])), 4.0, places=1)

    def test_planned_loss_never_exceeds_one_percent_of_capital(self):
        for product in ("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_ADAUSD"):
            for side in (LONG, SHORT):
                for pct in ("0.002", "0.005", "0.01", "0.03", "0.1", "0.2"):
                    p = Portfolio(roomy(), funding=FULL_FUNDING)
                    [d] = p.decide([intent(product, side=side, stop_pct=pct, target_pct="0.3")], T0 + MIN)
                    self.assertEqual(d["status"], "opened", (product, side, pct, d))
                    self.assertLessEqual(D(d["planned_loss_usd"]), D("10.00"))
                    # And the simulator agrees: the stop executing costs what the model said (no more).
                    low, high = (D(100) * (1 - D(pct)), D(100)) if side == LONG else (D(100), D(100) * (1 + D(pct)))
                    [t] = p.on_candle(product, T0 + MIN, candle("100", high=high, low=low))
                    self.assertEqual(t["exit_reason"], "stop")
                    self.assertLessEqual(-D(str(t["pnl_usd"])), D("10.00") + D("0.001"), (product, side, pct))

    def test_loss_over_thirty_percent_of_notional_is_rejected_not_widened(self):
        p = Portfolio(roomy())
        far = intent(stop_pct="0.32", target_pct="0.5")
        [d] = p.decide([far], T0 + MIN)
        self.assertEqual(reasons(d), ["stop_loss_exceeds_notional_limit"])
        self.assertGreater(D(d["loss_fraction"]), D("0.30"))
        self.assertEqual(p.snapshot()["open_positions"], 0)
        [ok] = p.decide([intent("PF_ETHUSD", stop_pct="0.25", target_pct="0.5")], T0 + MIN)
        self.assertEqual(ok["status"], "opened")
        self.assertLessEqual(D(ok["loss_fraction"]), D("0.30"))

    def test_thirty_percent_is_not_the_stop_distance(self):
        # A 1 % stop is sized to lose 1 % of capital, nowhere near 30 % of the notional.
        [d] = Portfolio(roomy()).decide([intent(stop_pct="0.01", target_pct="0.02")], T0 + MIN)
        self.assertLess(D(d["loss_fraction"]), D("0.02"))
        self.assertGreater(D(d["notional_usd"]), D(800))

    def test_example_matches_the_documented_formula(self):
        i = intent("PF_XBTUSD", stop_pct="0.02")
        p = Portfolio(roomy())
        plan = p.plan(i)
        entry = plan["entry"]
        self.assertEqual(plan["stop_exit"], exit_fill(D(i["stop"]), LONG, "PF_XBTUSD", "stop"))
        expected = (entry - plan["stop_exit"]) / entry + fee_rate("taker") * (entry + plan["stop_exit"]) / entry
        self.assertEqual(plan["loss_fraction"], expected)


class AggregateLimits(unittest.TestCase):
    PRODUCTS = ("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD", "PF_ADAUSD", "PF_HYPEUSD")

    def test_several_simultaneous_positions_respect_every_aggregate_limit(self):
        p = Portfolio(PortfolioPolicy())
        mixed = [intent(prod, side=SHORT if k % 2 else LONG, stop_pct=pct, target_pct="0.1", strength=str(0.9 - k / 10))
                 for k, (prod, pct) in enumerate(zip(self.PRODUCTS, ("0.01", "0.02", "0.03", "0.05", "0.08", "0.1")))]
        out = p.decide(mixed, T0 + MIN)
        snap = p.snapshot()
        capital = D(snap["capital_definitive_usd"])
        self.assertLessEqual(D(snap["open_risk_usd"]), capital * D("0.02"))
        self.assertLessEqual(D(snap["gross_exposure_usd"]), capital)
        self.assertLessEqual(abs(D(snap["net_exposure_usd"])), capital)
        self.assertGreaterEqual(D(snap["available_usd"]), 0)
        for d in opened(out):
            self.assertLessEqual(D(d["notional_usd"]), capital * D("0.5"))
            self.assertLessEqual(D(d["planned_loss_usd"]), capital * D("0.01"))
        self.assertTrue(any(d["status"] == "rejected" for d in out))   # the 2 % open-risk budget binds

    def test_open_risk_budget_is_shared_and_the_weakest_is_cut_or_rejected(self):
        p = Portfolio(roomy(max_open_risk_pct="0.025"))
        out = p.decide([intent(prod, stop_pct="0.05", target_pct="0.1", strength=s) for prod, s in
                        (("PF_XBTUSD", "0.9"), ("PF_ETHUSD", "0.8"), ("PF_SOLUSD", "0.7"))], T0 + MIN)
        by = {d["product_id"]: d for d in out}
        self.assertEqual(D(by["PF_XBTUSD"]["planned_loss_usd"]), D(by["PF_XBTUSD"]["notional_usd"]) * D(by["PF_XBTUSD"]["loss_fraction"]))
        self.assertLessEqual(D(by["PF_XBTUSD"]["planned_loss_usd"]), D(10))
        self.assertAlmostEqual(float(D(by["PF_ETHUSD"]["planned_loss_usd"])), 10.0, delta=0.05)
        self.assertEqual(by["PF_SOLUSD"]["status"], "opened")
        self.assertIn("open_risk_limit", by["PF_SOLUSD"]["limits_applied"])
        self.assertAlmostEqual(float(by["PF_SOLUSD"]["planned_loss_usd"]) + 20.0, 25.0, delta=0.1)
        self.assertLessEqual(D(p.snapshot()["open_risk_usd"]), D("25.00"))

    def test_open_risk_exhausted_rejects_with_reason(self):
        p = Portfolio(roomy(max_open_risk_pct="0.02"))
        out = p.decide([intent(prod, stop_pct="0.02", strength=s) for prod, s in
                        (("PF_XBTUSD", "0.9"), ("PF_ETHUSD", "0.8"), ("PF_SOLUSD", "0.7"))], T0 + MIN)
        self.assertEqual([(d["product_id"], reasons(d)) for d in out if d["status"] == "rejected"],
                         [("PF_SOLUSD", ["open_risk_limit"])])

    def test_gross_exposure_cannot_exceed_capital_at_1x(self):
        p = Portfolio(roomy(max_gross_exposure_pct="1", max_product_exposure_pct="0.6", max_open_risk_pct="10"))
        out = p.decide([intent(prod, stop_pct="0.005", target_pct="0.05", strength=s) for prod, s in
                        (("PF_XBTUSD", "0.9"), ("PF_ETHUSD", "0.8"), ("PF_SOLUSD", "0.7"))], T0 + MIN)
        self.assertEqual([d["notional_usd"] for d in opened(out)], ["600.00", "400.00"])
        self.assertIn("gross_limit", opened(out)[1]["limits_applied"])
        self.assertEqual(reasons([d for d in out if d["status"] == "rejected"][0]), ["insufficient_margin"])  # at 1x margin and gross bind together
        self.assertLessEqual(D(p.snapshot()["gross_exposure_usd"]), D(1000))

    def test_net_exposure_limit(self):
        p = Portfolio(roomy(max_net_exposure_pct="0.3", max_product_exposure_pct="0.2"))
        out = p.decide([intent("PF_XBTUSD", strength="0.9", stop_pct="0.005", target_pct="0.05"),
                        intent("PF_ETHUSD", strength="0.8", stop_pct="0.005", target_pct="0.05"),
                        intent("PF_SOLUSD", strength="0.7", side=SHORT, stop_pct="0.005", target_pct="0.05")], T0 + MIN)
        by = {d["product_id"]: d for d in out}
        self.assertEqual(by["PF_XBTUSD"]["notional_usd"], "200.00")
        self.assertEqual(by["PF_ETHUSD"]["notional_usd"], "100.00")      # long side cut to the 300 USD net limit
        self.assertIn("net_limit", by["PF_ETHUSD"]["limits_applied"])
        self.assertEqual(by["PF_SOLUSD"]["notional_usd"], "200.00")      # the short reduces net exposure

    def test_does_not_force_using_all_the_capital(self):
        p = Portfolio(PortfolioPolicy())
        [d] = p.decide([intent(stop_pct="0.1", target_pct="0.2")], T0 + MIN)
        self.assertLess(D(d["notional_usd"]), D(150))
        self.assertGreater(D(p.snapshot()["available_usd"]), D(850))

    def test_capital_and_risk_are_released_when_a_position_closes(self):
        p = Portfolio(roomy(max_open_risk_pct="0.01"), funding=FULL_FUNDING)
        p.decide([intent("PF_XBTUSD", stop_pct="0.02", target_pct="0.03")], T0 + MIN)
        [d] = p.decide([intent("PF_ETHUSD", t=T0 + MIN, stop_pct="0.02", target_pct="0.03")], T0 + 2 * MIN)
        self.assertEqual(reasons(d), ["open_risk_limit"])
        p.on_candle("PF_XBTUSD", T0 + MIN, candle("103.5", high="103.5", low="100"))
        self.assertEqual(p.snapshot()["open_positions"], 0)
        [d] = p.decide([intent("PF_ETHUSD", t=T0 + 2 * MIN, stop_pct="0.02", target_pct="0.03")], T0 + 3 * MIN)
        self.assertEqual(d["status"], "opened")

    def test_reserved_and_available_with_leverage(self):
        p = Portfolio(roomy(leverage="5"))
        [d] = p.decide([intent(stop_pct="0.02")], T0 + MIN)
        self.assertEqual(D(p.snapshot()["reserved_usd"]), D(d["notional_usd"]) / 5)

    def test_max_open_positions(self):
        p = Portfolio(roomy(max_open_positions=1))
        out = p.decide([intent("PF_XBTUSD", strength="0.9"), intent("PF_ETHUSD", strength="0.8")], T0 + MIN)
        self.assertEqual([(d["product_id"], d["status"]) for d in out], [("PF_XBTUSD", "opened"), ("PF_ETHUSD", "rejected")])
        self.assertEqual(reasons(out[1]), ["max_open_positions"])


class IdempotencyAndValidation(unittest.TestCase):
    def test_repeated_intent_never_opens_two_positions(self):
        p = Portfolio(roomy(), funding=FULL_FUNDING)
        i = intent()
        self.assertEqual(p.decide([i], T0 + MIN)[0]["status"], "opened")
        again = p.decide([i], T0 + MIN)                                    # while open
        self.assertIn("duplicate_intent", reasons(again[0]))
        p.on_candle("PF_XBTUSD", T0 + MIN, candle("104", high="104", low="100"))   # target hit: closed
        self.assertEqual(p.snapshot()["open_positions"], 0)
        later = p.decide([i], T0 + 2 * MIN)                                # after it closed
        self.assertIn("duplicate_intent", reasons(later[0]))
        self.assertEqual(p.snapshot()["open_positions"], 0)
        self.assertEqual(len(p.trades), 1)

    def test_duplicate_inside_one_batch(self):
        p = Portfolio(roomy())
        i = intent()
        out = p.decide([i, dict(i)], T0 + MIN)
        self.assertEqual(sorted(d["status"] for d in out), ["opened", "rejected"])
        self.assertEqual(p.snapshot()["open_positions"], 1)

    def test_stale_signal_does_not_block_a_valid_one(self):
        p = Portfolio(roomy())
        stale_short = intent(side=SHORT, strategy="old", strength="0.99", t=T0 - 30 * MIN)
        fresh_long = intent(side=LONG, strategy="new", strength="0.5")
        out = p.decide([stale_short, fresh_long], T0 + MIN)
        by = {d["strategy_id"]: d for d in out}
        self.assertEqual(by["new"]["status"], "opened")
        self.assertIn("stale_data", reasons(by["old"]))
        self.assertNotIn("contradictory_signals", reasons(by["old"]))

    def test_invalid_future_and_out_of_range_are_rejected_before_contradictions(self):
        p = Portfolio(roomy())
        bad_strength = intent(side=SHORT, strategy="a", strength="1.7")
        future = intent(side=SHORT, strategy="b", t=T0 + 5 * MIN)
        garbage = dict(intent(side=SHORT, strategy="c"), price="nan")
        good = intent(side=LONG, strategy="good")
        out = p.decide([bad_strength, future, garbage, good], T0 + MIN)
        by = {d["strategy_id"]: d for d in out}
        self.assertEqual(by["good"]["status"], "opened")
        self.assertEqual(reasons(by["a"]), ["invalid_intent"])
        self.assertEqual(reasons(by["c"]), ["invalid_intent"])
        self.assertIn("future_data", reasons(by["b"]))

    def test_contradictory_valid_signals_open_nothing(self):
        p = Portfolio(roomy())
        out = p.decide([intent(side=LONG, strategy="a"), intent(side=SHORT, strategy="b", strength="0.99")], T0 + MIN)
        self.assertEqual([reasons(d) for d in out], [["contradictory_signals"]] * 2)
        self.assertEqual(p.snapshot()["open_positions"], 0)

    def test_same_side_duplicates_keep_the_strongest(self):
        p = Portfolio(roomy())
        out = p.decide([intent(strategy="weak", strength="0.4"), intent(strategy="strong", strength="0.9")], T0 + MIN)
        by = {d["strategy_id"]: d for d in out}
        self.assertEqual(by["strong"]["status"], "opened")
        self.assertEqual(reasons(by["weak"]), ["duplicate_same_side"])

    def test_size_does_not_depend_on_signal_strength(self):
        a = Portfolio(roomy()).decide([intent(strength="0.1")], T0 + MIN)[0]
        b = Portfolio(roomy()).decide([intent(strength="1")], T0 + MIN)[0]
        self.assertEqual(a["notional_usd"], b["notional_usd"])

    def test_order_of_intents_does_not_matter(self):
        intents = [intent("PF_XBTUSD", strength="0.6"), intent("PF_ETHUSD", strength="0.6"),
                   intent("PF_SOLUSD", side=SHORT, strength="0.9"), intent("PF_SOLUSD", strength="0.2", strategy="x"),
                   intent("PF_XRPUSD", strength="0.6")]
        a, b = Portfolio(), Portfolio()
        a.decide(intents, T0 + MIN)
        b.decide(list(reversed(intents)), T0 + MIN)
        self.assertEqual(a.ledger_hash(), b.ledger_hash())

    def test_open_position_blocks_same_and_opposite_entries(self):
        p = Portfolio(roomy())
        p.decide([intent()], T0 + MIN)
        same = p.decide([intent(t=T0 + MIN, strategy="b")], T0 + 2 * MIN)
        opposite = p.decide([intent(t=T0 + MIN, side=SHORT, strategy="c")], T0 + 2 * MIN)
        self.assertEqual(reasons(same[0]), ["position_already_open"])
        self.assertEqual(reasons(opposite[0]), ["opposite_position_open"])

    def test_every_failed_reason_is_listed(self):
        bad = intent("PF_UNKNOWNUSD", data_close_ms=T0 - 20 * MIN, target_pct="0.0001")
        [d] = Portfolio(roomy()).decide([bad], T0 + MIN)
        self.assertEqual(set(reasons(d)), {"stale_data", "cost_data_missing", "target_does_not_clear_cost"})

    def test_invalid_levels_are_rejected(self):
        bad = make_intent(strategy_id="s", product_id="PF_XBTUSD", side=LONG, strength="0.5", bucket_ms=T0,
                          price="100", stop="101", target="99", horizon_minutes=60)
        [d] = Portfolio(roomy()).decide([bad], T0 + MIN)
        self.assertIn("levels_unavailable", reasons(d))

    def test_signal_conversion_reuses_multi_risk_levels(self):
        signal = make_signal(strategy_id="mx-momentum-v1", strategy_version=1, product_id="PF_XBTUSD", bucket_ms=T0,
                             action=SELL, strength="0.7", horizon_minutes=120, evidence={"x": 1})
        i = intent_from_signal(signal, price="100", atr="1")
        self.assertEqual((i["side"], i["stop"], i["target"]), (SHORT, "102", "97.0"))
        wait = make_signal(strategy_id="m", strategy_version=1, product_id="PF_XBTUSD", bucket_ms=T0, action=WAIT,
                           strength="0", horizon_minutes=60, evidence={})
        self.assertIsNone(intent_from_signal(wait, price="100", atr="1"))
        self.assertIsNone(intent_from_signal(signal, price="100", atr="0"))

    def test_trace_record_has_status_size_limits_and_budget(self):
        p = Portfolio(PortfolioPolicy())
        [d] = p.decide([intent(stop_pct="0.01", target_pct="0.02")], T0 + MIN)
        for key in ("status", "notional_usd", "limits_applied", "risk_budget_used_usd", "planned_loss_usd",
                    "loss_fraction", "open_risk_before_usd", "open_risk_after_usd", "risk_notional_usd",
                    "capital_definitive_usd", "decision_id"):
            self.assertIn(key, d)
        self.assertIn("product_limit", d["limits_applied"])
        self.assertGreater(D(d["risk_notional_usd"]), D(d["notional_usd"]))
        [r] = p.decide([intent("PF_ETHUSD", stop_pct="0.4", target_pct="0.5")], T0 + MIN)
        self.assertEqual((r["status"], r["loss_fraction"] is not None), ("rejected", True))


class TemporalOrder(unittest.TestCase):
    def test_decisions_cannot_go_back_in_time(self):
        p = Portfolio(roomy())
        p.decide([intent("PF_ETHUSD")], T0 + 5 * MIN)
        [d] = p.decide([intent("PF_XBTUSD")], T0 + MIN)
        self.assertIn("retroactive_decision", reasons(d))
        self.assertNotIn("PF_XBTUSD", p.positions)

    def test_intent_older_than_the_last_processed_candle_is_refused(self):
        p = Portfolio(roomy())
        p.on_candle("PF_XBTUSD", T0 + 3 * MIN, candle("100"))
        [d] = p.decide([intent(t=T0)], T0 + 4 * MIN + MIN)
        self.assertIn("retroactive_intent", reasons(d))

    def test_a_candle_is_never_reused(self):
        p = Portfolio(roomy())
        p.decide([intent()], T0 + MIN)                                    # enters on the close of bucket T0
        with self.assertRaises(PortfolioError):
            p.on_candle("PF_XBTUSD", T0, candle("90", high="100", low="50"))   # the entry candle cannot stop it out
        self.assertEqual(p.snapshot()["open_positions"], 1)
        p.on_candle("PF_XBTUSD", T0 + MIN, candle("100"))
        with self.assertRaises(PortfolioError):
            p.on_candle("PF_XBTUSD", T0 + MIN, candle("100"))

    def test_data_closing_after_now_is_future_information(self):
        [d] = Portfolio(roomy()).decide([intent(t=T0)], T0)
        self.assertIn("future_data", reasons(d))


class CapitalDefinitiveVsProvisional(unittest.TestCase):
    def _close(self, p, product="PF_XBTUSD", close="104", low="100", high=None):
        return p.on_candle(product, T0 + MIN, candle(close, high=high or close, low=low))

    def test_gain_with_incomplete_funding_does_not_raise_the_budget(self):
        p = Portfolio(roomy())                      # no funding history at all
        p.decide([intent()], T0 + MIN)
        budget_before = p.risk_budget_usd()
        [t] = self._close(p)
        self.assertFalse(t["net_complete"])
        self.assertIsNone(t["net_usd"])
        self.assertGreater(t["partial_usd"], 0)
        snap = p.snapshot()
        self.assertEqual(p.risk_budget_usd(), budget_before)
        self.assertEqual(snap["capital_definitive_usd"], "1000")
        self.assertGreater(D(snap["provisional_gains_usd"]), 0)
        self.assertGreater(D(snap["equity_usd"]), D(1000))              # reported, not spendable
        self.assertEqual(snap["realized_complete_usd"], "0")
        # And it does not enlarge the next position either.
        [d] = p.decide([intent("PF_ETHUSD", t=T0 + MIN)], T0 + 2 * MIN)
        self.assertEqual(d["risk_budget_used_usd"], "10.00")

    def test_loss_with_incomplete_funding_does_reduce_capital(self):
        p = Portfolio(roomy())
        p.decide([intent(stop_pct="0.1", target_pct="0.2")], T0 + MIN)
        self._close(p, close="90", low="89", high="100")
        self.assertLess(p.capital_usd(), D(1000))
        self.assertLess(p.risk_budget_usd(), D(10))

    def test_verified_gain_does_raise_the_budget(self):
        p = Portfolio(roomy(), funding=FULL_FUNDING)
        p.decide([intent()], T0 + MIN)
        [t] = self._close(p)
        self.assertTrue(t["net_complete"])
        self.assertGreater(p.capital_usd(), D(1000))
        self.assertGreater(p.risk_budget_usd(), D(10))

    def test_incomplete_funding_leaves_the_final_result_unknown(self):
        p = Portfolio(roomy(), funding={"PF_XBTUSD": [(T0, T0 + 30 * MIN, "0.0001")]})   # covers half the holding time
        p.decide([intent(horizon=60)], T0 + MIN)
        closed = []
        for k in range(1, 64):
            closed += p.on_candle("PF_XBTUSD", T0 + k * MIN, candle("100", high="100.1", low="99.9"))
        [t] = closed
        self.assertFalse(t["net_complete"])
        self.assertIsNone(t["net_usd"])
        self.assertIsNotNone(t["partial_usd"])
        self.assertEqual(p.snapshot()["complete_trades"], 0)

    def test_unrealized_pnl_is_reported_but_not_spendable(self):
        p = Portfolio(roomy())
        p.decide([intent()], T0 + MIN)
        p.on_candle("PF_XBTUSD", T0 + MIN, candle("102", high="102", low="100"))
        snap = p.snapshot()
        self.assertGreater(D(snap["unrealized_usd"]), D(1))
        self.assertEqual(snap["capital_definitive_usd"], "1000")


class Accounting(unittest.TestCase):
    def test_long_win_net_of_fees_and_costs(self):
        p = Portfolio(roomy(), funding=FULL_FUNDING)
        p.decide([intent("PF_XBTUSD")], T0 + MIN)
        [t] = p.on_candle("PF_XBTUSD", T0 + MIN, candle("103", high="103", low="100"))
        self.assertEqual((t["exit_reason"], t["side"]), ("target", "LONG"))
        gross = (D(t["exit_price"]) - D(t["entry_price"])) * D(t["quantity"])
        fees = (D(t["entry_price"]) + D(t["exit_price"])) * D(t["quantity"]) * fee_rate("taker")
        self.assertAlmostEqual(float(gross - fees), t["pnl_usd"], places=3)
        self.assertAlmostEqual(t["fees_usd"], float(fees), places=4)

    def test_short_loss_at_stop_equals_the_planned_loss(self):
        p = Portfolio(roomy())
        [d] = p.decide([intent("PF_ETHUSD", side=SHORT, stop_pct="0.03", target_pct="0.06")], T0 + MIN)
        [t] = p.on_candle("PF_ETHUSD", T0 + MIN, candle("103", high="103.5", low="100"))
        self.assertEqual((t["exit_reason"], t["side"]), ("stop", "SHORT"))
        self.assertAlmostEqual(-t["pnl_usd"], float(d["planned_loss_usd"]), places=2)
        self.assertAlmostEqual(t["planned_loss_usd"], float(d["planned_loss_usd"]), places=4)

    def test_time_stop(self):
        p = Portfolio(roomy())
        p.decide([intent(horizon=3)], T0 + MIN)
        closed = []
        for k in range(1, 6):
            closed += p.on_candle("PF_XBTUSD", T0 + k * MIN, candle("100.1", high="100.2", low="100"))
        self.assertEqual([t["exit_reason"] for t in closed], ["time_stop"])

    def test_funding_paid_by_longs_and_received_by_shorts(self):
        funding = {"PF_XBTUSD": [(T0, T0 + 3 * HOUR, "0.0001")]}
        results = {}
        for side in (LONG, SHORT):
            p = Portfolio(roomy(), funding=funding)
            [d] = p.decide([intent(side=side, horizon=120, stop_pct="0.1", target_pct="0.2")], T0 + MIN)
            closed = []
            for k in range(1, 125):
                closed += p.on_candle("PF_XBTUSD", T0 + k * MIN, candle("100", high="100.1", low="99.9"))
            [t] = closed
            results[side] = (t, D(d["notional_usd"]))
            self.assertTrue(t["net_complete"])
        for side, sign in ((LONG, 1), (SHORT, -1)):
            t, notional = results[side]
            self.assertAlmostEqual(t["funding_usd"], sign * float(notional) * 1e-4 * 2, delta=0.05 * float(notional) * 1e-4)

    def test_position_crossing_a_funding_period_boundary(self):
        funding = {"PF_XBTUSD": [(T0 - HOUR, T0 + HOUR, "0.0001"), (T0 + HOUR, T0 + 3 * HOUR, "-0.0002")]}
        p = Portfolio(roomy(), funding=funding)
        [d] = p.decide([intent(horizon=120, stop_pct="0.1", target_pct="0.2")], T0 + MIN)
        closed = []
        for k in range(1, 125):
            closed += p.on_candle("PF_XBTUSD", T0 + k * MIN, candle("100", high="100.1", low="99.9"))
        [t] = closed
        expected = float(D(d["notional_usd"])) * (1e-4 * 59 / 60 - 2e-4 * 61 / 60)
        self.assertAlmostEqual(t["funding_usd"], expected, delta=0.002)
        self.assertTrue(t["net_complete"])


class ExtremeScenarios(unittest.TestCase):
    def test_very_tight_stop_is_capped_by_exposure_not_by_the_formula(self):
        p = Portfolio(PortfolioPolicy())
        [d] = p.decide([intent(stop_pct="0.0001", target_pct="0.05")], T0 + MIN)
        self.assertEqual(d["status"], "opened")
        self.assertEqual(d["notional_usd"], "500.00")                    # 50 % product cap
        self.assertIn("product_limit", d["limits_applied"])
        self.assertLess(D(d["planned_loss_usd"]), D(10))                 # smaller than the budget, never larger

    def test_high_volatility_stop_beyond_thirty_percent_is_rejected(self):
        [d] = Portfolio(PortfolioPolicy()).decide([intent(stop_pct="0.45", target_pct="0.6")], T0 + MIN)
        self.assertEqual(reasons(d), ["stop_loss_exceeds_notional_limit"])

    def test_wide_but_allowed_stop_gives_a_small_position(self):
        [d] = Portfolio(PortfolioPolicy()).decide([intent(stop_pct="0.25", target_pct="0.4")], T0 + MIN)
        self.assertEqual(d["status"], "opened")
        self.assertTrue(D(35) < D(d["notional_usd"]) < D(40), d["notional_usd"])

    def test_insufficient_capital(self):
        p = Portfolio(PortfolioPolicy(initial_equity_usd="30"))
        [d] = p.decide([intent(stop_pct="0.1", target_pct="0.2")], T0 + MIN)
        self.assertEqual(reasons(d), ["size_below_minimum"])        # 0.30 USD of risk budget -> ~2.8 USD notional
        p0 = Portfolio(PortfolioPolicy(initial_equity_usd="0"))
        [z] = p0.decide([intent()], T0 + MIN)
        self.assertEqual(z["status"], "rejected")

    def test_margin_binds_when_leveraged_capital_is_taken(self):
        p = Portfolio(roomy(initial_equity_usd="105"))
        out = p.decide([intent("PF_XBTUSD", stop_pct="0.0005", target_pct="0.05", strength="0.9"),
                        intent("PF_ETHUSD", stop_pct="0.0005", target_pct="0.05", strength="0.8")], T0 + MIN)
        by = {d["product_id"]: d for d in out}
        self.assertEqual(by["PF_XBTUSD"]["notional_usd"], "105.00")
        self.assertEqual(reasons(by["PF_ETHUSD"]), ["insufficient_margin"])

    def test_consecutive_losses_shrink_size_and_then_suspend(self):
        p = Portfolio(PortfolioPolicy(max_open_risk_pct="1", max_product_exposure_pct="1"))
        sizes = []
        for k in range(4):
            t = T0 + k * 10 * MIN
            [d] = p.decide([intent(t=t, stop_pct="0.02", target_pct="0.04", strategy="s%d" % k)], t + MIN)
            if d["status"] != "opened":
                self.assertEqual(reasons(d), ["suspended_daily_loss"])
                break
            sizes.append(D(d["notional_usd"]))
            p.on_candle("PF_XBTUSD", t + MIN, candle("97", high="100", low="97"))
        self.assertEqual(len(sizes), 3)                                  # 3 x ~10 USD > the 20 USD daily limit
        self.assertTrue(sizes[0] > sizes[1] > sizes[2], sizes)
        self.assertLess(p.capital_usd(), D(980))

    def test_drawdown_suspends_even_on_a_new_day(self):
        p = Portfolio(PortfolioPolicy(daily_loss_limit_usd="1000", max_drawdown_usd="9", max_product_exposure_pct="1"))
        p.decide([intent(stop_pct="0.02")], T0 + MIN)
        p.on_candle("PF_XBTUSD", T0 + MIN, candle("97", high="100", low="97"))
        later = T0 + 2 * 86_400_000
        [d] = p.decide([intent("PF_ETHUSD", t=later - MIN)], later)
        self.assertEqual(reasons(d), ["suspended_drawdown"])

    def test_stop_slippage_above_the_estimate_exceeds_the_plan_unless_buffered(self):
        real_exit = exit_fill

        def worse_stop(price, side, product, reason="strategy_exit"):
            filled = real_exit(price, side, product, reason)
            extra = D("0.0030")                                          # 30 bp worse than the cost model
            return filled * (1 - extra) if side == LONG else filled * (1 + extra)

        overs = {}
        for buffer in ("0", "30"):
            p = Portfolio(roomy(slippage_buffer_bps=buffer))
            [d] = p.decide([intent(stop_pct="0.01", target_pct="0.03")], T0 + MIN)
            with mock.patch.object(futures_simulator, "exit_fill", worse_stop):
                [t] = p.on_candle("PF_XBTUSD", T0 + MIN, candle("99", high="100", low="98.9"))
            overs[buffer] = (-D(str(t["pnl_usd"])), D(d["planned_loss_usd"]))
        loss0, plan0 = overs["0"]
        loss30, plan30 = overs["30"]
        self.assertGreater(loss0, plan0 + D("1.0"))                       # the model is not a guarantee
        self.assertLess(loss0, plan0 * D("1.5"))                          # ... but the error is the slippage, no more
        self.assertLessEqual(loss30, D("10.00") + D("0.001"))             # an explicit buffer covers it
        self.assertLess(plan30, plan0)                                    # at the price of a smaller position


class Determinism(unittest.TestCase):
    def _run(self):
        p = Portfolio(PortfolioPolicy(), funding={"PF_XBTUSD": [(T0, T0 + 10 * HOUR, "0.00005")]})
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
        self.assertNotEqual(PortfolioPolicy().policy_hash(), PortfolioPolicy(max_open_risk_pct="0.03").policy_hash())


if __name__ == "__main__":
    unittest.main()
