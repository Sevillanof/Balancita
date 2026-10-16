"""Issue #185, BAL-DECISION-185-CARTERA-SIMULADA-01: one shared SIMULATED balance of 1000 USD that every operation moves, with all the costs of
the operation counted once, and a published view of balance / committed / free. Invented data, nothing real, no new rule: the numbers are the
portfolio's own and the block only copies them."""

import json
import unittest
from decimal import Decimal

from balancita_engine import paper_live_publish as PUB
from balancita_engine.portfolio import Portfolio
from test_portfolio import D, FULL_FUNDING, MIN, T0, candle, intent, roomy


def closed(trade_id, net, fees):
    """A closed trade as the portfolio stores it, with the costs already inside ``net`` (``fees`` is informational)."""
    return {"trade_id": trade_id, "pnl_usd": net, "net_usd": net, "net_complete": True, "fees_usd": fees, "funding_usd": 0.0}


class TestTheAgreedExample(unittest.TestCase):
    def test_minus_5_and_plus_15_leave_1010_and_the_fees_are_not_taken_again(self):
        for fees in (0.0, 1.5, 40.0):                       # whatever the fees were, they are already inside the net results
            with self.subTest(fees=fees):
                p = Portfolio(roomy())
                p.trades.extend([closed("a", -5.0, fees), closed("b", 15.0, fees)])
                snap = p.snapshot()
                self.assertEqual((snap["initial_equity_usd"], snap["capital_definitive_usd"], snap["equity_usd"]), ("1000", "1010.0", "1010.0"))

    def test_real_closes_move_the_balance_by_exactly_their_net_results(self):
        p = Portfolio(roomy(), funding=FULL_FUNDING)
        p.decide([intent("PF_XBTUSD")], T0 + MIN)
        [win] = p.on_candle("PF_XBTUSD", T0 + MIN, candle("103", high="103", low="100"))
        p.decide([intent("PF_ETHUSD", t=T0 + MIN)], T0 + 2 * MIN)
        [loss] = p.on_candle("PF_ETHUSD", T0 + 2 * MIN, candle("97", high="100", low="97"))
        self.assertGreater(win["pnl_usd"], 0)
        self.assertLess(loss["pnl_usd"], 0)
        expected = D(1000) + D(str(win["net_usd"])) + D(str(loss["net_usd"]))
        snap = p.snapshot()
        self.assertEqual((D(snap["capital_definitive_usd"]), D(snap["equity_usd"])), (expected, expected))
        self.assertGreater(D(snap["fees_usd"]), 0)          # the fees exist, and are inside the results, not subtracted a second time
        self.assertEqual(p.capital_usd(), D(1000) + sum(D(str(t["pnl_usd"])) for t in p.trades))

    def test_there_is_one_balance_and_it_is_not_reset_by_a_close(self):
        p = Portfolio(roomy(), funding=FULL_FUNDING)
        p.decide([intent("PF_XBTUSD")], T0 + MIN)
        p.on_candle("PF_XBTUSD", T0 + MIN, candle("103", high="103", low="100"))
        after_first = p.capital_usd()
        self.assertNotEqual(after_first, D(1000))
        p.decide([intent("PF_ETHUSD", t=T0 + MIN)], T0 + 2 * MIN)   # the next operation starts from the same balance, not from 1000
        self.assertEqual(p.capital_usd(), after_first)
        self.assertEqual(p.snapshot()["initial_equity_usd"], "1000")


class TestThePublishedAccount(unittest.TestCase):
    def test_balance_committed_and_free_are_the_portfolios_own_numbers(self):
        p = Portfolio(roomy(), funding=FULL_FUNDING)
        p.decide([intent("PF_XBTUSD")], T0 + MIN)
        view, snap = PUB.account(p), p.snapshot()
        self.assertEqual(view["class"], "simulated")
        self.assertEqual((view["total_simulated_usd"], view["definitive_usd"], view["committed_usd"], view["free_usd"]),
                         (snap["equity_usd"], snap["capital_definitive_usd"], snap["reserved_usd"], snap["available_usd"]))
        self.assertGreater(D(view["committed_usd"]), 0)
        self.assertEqual(D(view["free_usd"]), D(view["definitive_usd"]) - D(view["committed_usd"]))
        self.assertEqual(view["committed_scope"], "open_positions_only")
        json.dumps(view)

    def test_the_two_balances_differ_only_by_the_gains_still_provisional(self):
        p = Portfolio(roomy())                              # no funding history: a gain stays provisional
        p.decide([intent()], T0 + MIN)
        p.on_candle("PF_XBTUSD", T0 + MIN, candle("104", high="104", low="100"))
        view = PUB.account(p)
        self.assertGreater(D(view["provisional_gains_usd"]), 0)
        self.assertEqual(D(view["total_simulated_usd"]) - D(view["definitive_usd"]), D(view["provisional_gains_usd"]))
        self.assertEqual(view["committed_usd"], "0")        # nothing open

    def test_the_positions_block_carries_it_and_still_claims_nothing_else(self):
        p = Portfolio(roomy(), funding=FULL_FUNDING)
        p.trades.extend([closed("a", -5.0, 1.0), closed("b", 15.0, 1.0)])

        class Runner(object):                               # only what ``positions`` reads from a runner
            portfolio, clock, open_cycles, open_funding, status = p, T0, [], [], "closed"
            journal = type("J", (), {"entries": []})()

        from unittest import mock
        with mock.patch.object(PUB, "protection", lambda r: []), mock.patch.object(PUB, "integrated_audit", lambda r: {"violations": []}):
            block = PUB.positions(Runner(), report_age_ms=None, max_age_ms=None)
        self.assertEqual(block["account"], PUB.account(p))
        self.assertEqual((block["account"]["total_simulated_usd"], block["account"]["free_usd"]), ("1010.0", "1010.0"))
        self.assertEqual(block["verification"]["freshness"], "unknown")
        self.assertFalse(block["verification"]["verified"])
        self.assertIn("runner_not_processing", block["verification"]["reasons"])
        self.assertEqual(block["evidence_class"], "not_forward_evidence")


if __name__ == "__main__":
    unittest.main()
