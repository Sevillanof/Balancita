"""Issue #185, BAL-DECISION-185-DIMENSIONAMIENTO-03: the size of one operation (100 USD of notional, provisional and easy to change) is separate
from the shared 1000 USD balance. It is a notional, not a loss limit and not capital: the operation is rejected, never shrunk, when the free
capital or a limit leaves less, and the costs are counted once. Invented data, nothing real."""

import json
import unittest
from decimal import Decimal

from balancita_engine.paper_runner import RunnerConfig
from balancita_engine.paper_runner_report import decisions
from balancita_engine.portfolio import FIXED_NOTIONAL, RISK_FIELDS_INFORMATIONAL, Portfolio, PortfolioError, PortfolioPolicy
import test_paper_runner_financial as FIN
from test_portfolio import D, FULL_FUNDING, MIN, T0, candle, intent, roomy


def fixed(value="100", **kw):
    return roomy(sizing_mode=FIXED_NOTIONAL, notional_per_trade_usd=value, **kw)


def first(p, product="PF_XBTUSD", t=T0 + MIN, **kw):
    [decision] = p.decide([intent(product, t=T0, **kw)], t)
    return decision


class TestTheSizeIsASeparateSetting(unittest.TestCase):
    def test_an_operation_opens_with_exactly_the_configured_notional(self):
        for value in ("100", "50", "250.50"):
            with self.subTest(value=value):
                d = first(Portfolio(fixed(value), funding=FULL_FUNDING))
                self.assertEqual(d["status"], "opened")
                self.assertEqual(D(d["notional_usd"]), D(value))
                self.assertEqual(d["sizing_mode"], FIXED_NOTIONAL)

    def test_the_default_policy_and_its_hash_are_the_old_risk_sizing(self):
        self.assertEqual(PortfolioPolicy().sizing_mode, "risk")
        self.assertEqual(PortfolioPolicy().policy_hash(), PortfolioPolicy(sizing_mode="risk", notional_per_trade_usd="999").policy_hash())
        self.assertNotEqual(PortfolioPolicy().policy_hash(), fixed().policy_hash())
        self.assertNotEqual(fixed("100").policy_hash(), fixed("150").policy_hash())
        d = first(Portfolio(roomy(), funding=FULL_FUNDING))
        self.assertNotIn("sizing_mode", d)
        self.assertEqual(D(d["risk_budget_used_usd"]), D("10"))     # 1 % of 1000, as before

    def test_a_bad_size_is_refused(self):
        for bad in ("abc", "NaN", "Infinity", "5", "100.123", ""):
            with self.subTest(bad=bad), self.assertRaises(PortfolioError):
                PortfolioPolicy(sizing_mode=FIXED_NOTIONAL, notional_per_trade_usd=bad)
        with self.assertRaises(PortfolioError):
            PortfolioPolicy(sizing_mode="kelly")

    def test_the_size_is_not_the_balance_and_not_the_loss_limit(self):
        p = Portfolio(fixed(), funding=FULL_FUNDING)
        d = first(p)
        snap = p.snapshot()
        self.assertEqual(snap["initial_equity_usd"], "1000")
        self.assertEqual(D(snap["reserved_usd"]), D("100"))              # 1x leverage: the notional is what is committed
        self.assertEqual(D(snap["available_usd"]), D("900"))
        self.assertLess(D(d["planned_loss_usd"]), D("100"))              # the planned loss is a fraction of the notional, never the notional

    def test_it_does_not_promise_ten_operations(self):
        p = Portfolio(fixed(max_open_positions=20), funding=FULL_FUNDING)
        products = ("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD", "PF_ADAUSD", "PF_HYPEUSD")
        opened = []
        for i, product in enumerate(products):
            opened.append(first(p, product, t=T0 + (i + 1) * MIN)["status"])
        self.assertEqual(opened, ["opened"] * 6)
        self.assertEqual(D(p.snapshot()["available_usd"]), D("400"))


class TestAdmissionStillRules(unittest.TestCase):
    def test_not_enough_free_capital_rejects_the_operation_it_does_not_shrink_it(self):
        p = Portfolio(fixed("100", initial_equity_usd="150"), funding=FULL_FUNDING)
        self.assertEqual(first(p)["status"], "opened")
        second = first(p, "PF_ETHUSD", t=T0 + 2 * MIN)
        self.assertEqual(second["status"], "rejected")
        self.assertEqual(len(p.positions), 1)
        self.assertEqual(D(p.snapshot()["available_usd"]), D("50"))      # the 50 free USD were not used for a smaller operation

    def test_a_limit_below_the_standard_size_rejects_it(self):
        p = Portfolio(fixed("100", max_product_exposure_pct="0.05"), funding=FULL_FUNDING)   # 5 % of 1000 = 50 < 100
        d = first(p)
        self.assertEqual(d["status"], "rejected")
        self.assertEqual(p.positions, {})

    def test_the_costs_are_counted_once_and_move_the_shared_balance(self):
        p = Portfolio(fixed(), funding=FULL_FUNDING)
        first(p)
        [trade] = p.on_candle("PF_XBTUSD", T0 + MIN, candle("103", high="103", low="100"))
        self.assertGreater(D(str(trade["fees_usd"])), 0)
        self.assertEqual(p.capital_usd(), D(1000) + D(str(trade["net_usd"])))


class TestChangingTheSizeOnlyAffectsFutureOperations(unittest.TestCase):
    def test_a_new_value_leaves_the_open_position_and_the_balance_alone(self):
        old = Portfolio(fixed("100"), funding=FULL_FUNDING)
        first(old)
        before = (dict(old.positions), old.snapshot()["capital_definitive_usd"], old.snapshot()["reserved_usd"])
        new = PortfolioPolicy(**{**fixed("100").__dict__, "notional_per_trade_usd": "200"})
        self.assertNotEqual(new.policy_hash(), old.policy.policy_hash())
        # the running portfolio keeps its own policy object: nothing in it reads the new value
        self.assertEqual((old.positions, old.snapshot()["capital_definitive_usd"], old.snapshot()["reserved_usd"]), before)
        self.assertEqual(D(first(old, "PF_ETHUSD", t=T0 + 2 * MIN)["notional_usd"]), D("100"))
        fresh = Portfolio(new, funding=FULL_FUNDING)                      # only a NEW portfolio (a new session) opens with the new size
        self.assertEqual(D(first(fresh)["notional_usd"]), D("200"))
        self.assertEqual(fresh.snapshot()["initial_equity_usd"], "1000")


class TestTheRecordSaysWhatSizedTheOperation(unittest.TestCase):
    """BAL-REV-185-DIM-TRACE-05: in ``fixed_notional`` mode the risk-formula numbers stay (no contract breaks) but every record that carries
    them says they are informational, and ``notional_usd`` + ``sizing_mode`` say what sized the operation, down to the published decision rows."""

    def run_session(self, policy):
        helper = FIN.Fin("setUp")          # the module, not the class: importing Fin by name would make unittest run its tests here
        helper.setUp()
        self.addCleanup(helper.tearDown)
        path, r = helper.start({"a": {(FIN.BTC, FIN.CYCLE): FIN.BUY}}, config=RunnerConfig(portfolio=policy, funding=FIN.FULL, start_ms=FIN.CYCLE - FIN.HOUR))
        f = helper.f
        r.run([f.cycle(FIN.CYCLE + 2 * FIN.SEC, FIN.BTC), f.quote(FIN.BTC, FIN.CYCLE + 6 * FIN.SEC, "100010"),
               f.candle(FIN.BTC, FIN.CYCLE + FIN.MIN, 100010, 100100, 99900, 100010), f.candle(FIN.BTC, FIN.CYCLE + 2 * FIN.MIN, 100010, 103500, 100000, 103400)])
        return r

    def test_the_trace_reaches_the_portfolio_the_execution_record_and_the_published_row(self):
        r = self.run_session(PortfolioPolicy(sizing_mode=FIXED_NOTIONAL, notional_per_trade_usd="100"))
        [opened] = [d for d in r.portfolio.decisions if d["status"] == "opened"]
        [record] = [x for x in r.executor.records if x["status"] == "opened"]
        [row] = decisions(r)
        for body in (opened, record, row):
            self.assertEqual(body["sizing_mode"], FIXED_NOTIONAL)
            self.assertEqual(body["risk_fields_role"], RISK_FIELDS_INFORMATIONAL)
        self.assertEqual(D(opened["notional_usd"]), D(100))                      # what sized the operation
        self.assertEqual(D(record["notional_usd"]), D(100))
        self.assertEqual(D(row["notional_usd"]), D(100))
        self.assertEqual(row["portfolio_at_decision"]["risk_budget_role"], RISK_FIELDS_INFORMATIONAL)
        for key in ("risk_budget_used_usd", "risk_notional_usd"):                # still there: nothing that reads them breaks
            self.assertIn(key, opened)
        self.assertIn("risk_budget_usd", record)
        self.assertIn("risk_budget_usd", row["portfolio_at_decision"])
        published = json.loads(json.dumps(r.report()["sections"]["simulated"]["data"]["decisions"]))
        self.assertEqual(published[0]["risk_fields_role"], RISK_FIELDS_INFORMATIONAL)

    def test_the_rejected_decision_is_labelled_too_and_the_risk_mode_adds_nothing(self):
        p = Portfolio(fixed("100", initial_equity_usd="50"), funding=FULL_FUNDING)
        self.assertEqual(first(p)["risk_fields_role"], RISK_FIELDS_INFORMATIONAL)
        r = self.run_session(PortfolioPolicy())
        [opened] = [d for d in r.portfolio.decisions if d["status"] == "opened"]
        [row] = decisions(r)
        for body in (opened, row, row["portfolio_at_decision"]):
            self.assertFalse({"sizing_mode", "risk_fields_role", "risk_budget_role"} & set(body))


if __name__ == "__main__":
    unittest.main()
