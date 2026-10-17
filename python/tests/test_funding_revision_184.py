"""#184 (BAL-DECISION-184-03): a rate Kraken publishes again with another value is a revision, recorded as an adjustment.

Invented data only. The portfolio is the stage 7 one (the accounting that already reconciles late funding); nothing here reads a
capture, a network or a clock."""

import unittest
from decimal import Decimal

from balancita_engine import portfolio_stage7 as S
from balancita_engine.portfolio_audit import accounting_digest, audit, intake_digest
from balancita_engine.portfolio_funding import ingest_funding, reconcile_funding, revise_funding

D = Decimal
NOW = S.T8 + 6 * S.HOUR
FIRST = S.T8 + S.HOUR                       # the first BTC hour delivered late; the BTC trade overlaps hours 1 to 3 of it


def rules(pf):
    return sorted({v["rule"] for v in audit(pf)["violations"]})


def reconciled():
    """Two trades closed with incomplete funding, then everything delivered and reconciled (as the stage 7 tests do)."""
    pf = S._funding_portfolio()
    S._provisional_trades(pf)
    S._open_after_close(pf)
    ingest_funding(pf, S.BTC, S.hourly(S.T8 + S.HOUR, 3), received_ms=S.T8 + 4 * S.HOUR + 5 * S.MIN)
    ingest_funding(pf, S.ETH, S.hourly(S.T8 - S.HOUR, 3), received_ms=S.T8 + 4 * S.HOUR + 5 * S.MIN)
    reconcile_funding(pf, S.T8 + 4 * S.HOUR + 5 * S.MIN)
    return pf


def btc_trade(pf):
    return [t for t in pf.trades if t["product_id"] == S.BTC][0]


class Revision(unittest.TestCase):
    def revise(self, pf, new="0.004", at=NOW, old=S.FR, start=FIRST):
        return revise_funding(pf, S.BTC, [(start, start + S.HOUR, old, new)], received_ms=at)

    def test_the_rate_in_use_changes_and_the_replaced_one_stays_in_the_log_linked_to_its_acceptance(self):
        pf = reconciled()
        accepted = [e for e in pf.funding_log if e["kind"] == "period_accepted" and e["product_id"] == S.BTC and e["period"][0] == FIRST][0]
        self.assertEqual(self.revise(pf), {"revised": 1, "duplicate": 0, "rejected": 0})
        self.assertIn((FIRST, FIRST + S.HOUR, D("0.004")), pf.funding[S.BTC])
        self.assertNotIn((FIRST, FIRST + S.HOUR, D(S.FR)), pf.funding[S.BTC])
        entry = pf.funding_log[-1]
        self.assertEqual((entry["kind"], entry["period"], entry["previous"]),
                         ("period_revised", [FIRST, FIRST + S.HOUR, "0.004"], [FIRST, FIRST + S.HOUR, S.FR]))
        self.assertEqual(entry["supersedes"], {"seq": accepted["seq"], "hash": accepted["hash"]})
        self.assertEqual(rules(pf), [])                                         # chain intact, nothing overwritten
        pending = [w["rule"] for w in audit(pf)["warnings"]]
        self.assertEqual(pending, ["revision_reconciliation_pending"])          # the trade is reconciled in the next step
        reconcile_funding(pf, NOW)
        self.assertEqual(audit(pf)["warnings"], [])

    def test_a_closed_trade_gets_one_funding_revision_adjustment_and_its_funding_moves_by_the_difference(self):
        pf = reconciled()
        trade = btc_trade(pf)
        funding_before, pnl_before, capital_before = D(str(trade["funding_usd"])), D(str(trade["pnl_usd"])), pf.capital_usd()
        self.revise(pf)
        [made] = reconcile_funding(pf, NOW)
        notional = D(trade["quantity"]) * D(trade["entry_price"])
        expected = notional * (D("0.004") - D(S.FR))                              # one hour, the rate went up: a LONG pays more
        self.assertEqual((made["kind"], made["transition"]), ("funding_revision", "funding_rate_revised"))
        self.assertEqual(made["revised_periods"], [[FIRST, FIRST + S.HOUR]])
        self.assertAlmostEqual(float(D(str(trade["funding_usd"])) - funding_before), float(expected), places=4)
        self.assertAlmostEqual(float(D(str(trade["pnl_usd"])) - pnl_before), -float(expected), places=3)
        self.assertEqual(made["before"]["funding_covered_ms"], made["after"]["funding_covered_ms"])      # the coverage did not change
        self.assertEqual(D(made["capital_after_usd"]), pf.capital_usd())
        self.assertEqual(pf.capital_usd() - capital_before, D(made["delta_capital_usd"]))
        self.assertEqual(D("1000") + sum((D(e["delta_usd"]) for e in pf.capital_log), D(0)), pf.capital_usd())
        self.assertEqual(rules(pf), [])

    def test_the_closing_and_every_earlier_state_are_kept(self):
        pf = reconciled()
        trade = btc_trade(pf)
        original = pf.trade_details[trade["trade_id"]]["as_closed"]
        self.revise(pf)
        reconcile_funding(pf, NOW)
        chain = [a for a in pf.adjustments if a["trade_id"] == trade["trade_id"]]
        self.assertEqual(chain[0]["before"], original)
        self.assertEqual([a["kind"] for a in chain], ["funding_reconciliation", "funding_revision"])
        self.assertEqual(chain[1]["before"], chain[0]["after"])
        self.assertEqual(chain[-1]["after"], {k: trade[k] for k in pf.CLOSED_FIELDS})

    def test_repeating_the_revision_or_the_reconciliation_changes_nothing(self):
        pf = reconciled()
        self.revise(pf)
        reconcile_funding(pf, NOW)
        digest, adjustments, capital = accounting_digest(pf), list(pf.adjustments), pf.capital_usd()
        self.assertEqual(self.revise(pf, at=NOW + S.MIN), {"revised": 0, "duplicate": 1, "rejected": 0})
        for _ in range(3):
            self.assertEqual(reconcile_funding(pf, NOW + 2 * S.MIN), [])
        self.assertEqual((pf.adjustments, pf.capital_usd()), (adjustments, capital))
        self.assertEqual(len([e for e in pf.funding_log if e["kind"] == "period_revised"]), 1)
        self.assertEqual(rules(pf), [])

    def test_a_revision_back_to_the_original_rate_is_another_adjustment_that_restores_the_funding(self):
        pf = reconciled()
        trade = btc_trade(pf)
        funding = trade["funding_usd"]
        self.revise(pf)
        reconcile_funding(pf, NOW)
        self.assertNotEqual(trade["funding_usd"], funding)
        self.revise(pf, new=S.FR, old="0.004", at=NOW + S.HOUR)
        [made] = reconcile_funding(pf, NOW + S.HOUR)
        self.assertEqual(made["kind"], "funding_revision")
        self.assertEqual(trade["funding_usd"], funding)
        self.assertEqual(rules(pf), [])

    def test_a_revision_that_does_not_start_from_the_rate_in_use_is_not_applied(self):
        pf = reconciled()
        before = list(pf.funding[S.BTC])
        self.assertEqual(self.revise(pf, old="0.009"), {"revised": 0, "duplicate": 0, "rejected": 1})
        self.assertEqual(pf.funding[S.BTC], before)
        self.assertEqual(pf.funding_log[-1]["reason"], "revision_base_mismatch")
        self.assertEqual(reconcile_funding(pf, NOW), [])

    def test_a_revision_of_a_period_never_accepted_or_not_settled_is_rejected(self):
        pf = reconciled()
        far = S.T8 + 50 * S.HOUR
        self.assertEqual(revise_funding(pf, S.BTC, [(far, far + S.HOUR, S.FR, "0.004")], received_ms=far + 2 * S.HOUR)["rejected"], 1)
        self.assertEqual(pf.funding_log[-1]["reason"], "revision_of_unknown_period")
        self.assertEqual(revise_funding(pf, S.BTC, [(FIRST, FIRST + S.HOUR, S.FR, "0.004")], received_ms=FIRST + 10)["rejected"], 1)
        self.assertEqual(pf.funding_log[-1]["reason"], "not_settled")
        self.assertEqual(revise_funding(pf, S.BTC, [("x", 1)], received_ms=NOW)["rejected"], 1)
        self.assertEqual(reconcile_funding(pf, NOW), [])

    def test_a_trade_that_does_not_overlap_the_revised_period_is_not_adjusted(self):
        pf = reconciled()
        eth_before = dict([t for t in pf.trades if t["product_id"] == S.ETH][0])
        self.revise(pf)
        made = reconcile_funding(pf, NOW)
        self.assertEqual({a["product_id"] for a in made}, {S.BTC})
        self.assertEqual([t for t in pf.trades if t["product_id"] == S.ETH][0], eth_before)

    def test_the_funding_that_feeds_nothing_else_is_untouched(self):
        # The accounting channel only: no signal channel is reachable from the portfolio's funding.
        pf = reconciled()
        intake = intake_digest(pf)
        self.revise(pf)
        self.assertNotEqual(intake_digest(pf), intake)                           # the revision is part of the intake history

    def test_an_open_position_is_priced_with_the_revised_rate_when_it_closes(self):
        pf = S._funding_portfolio()
        S._provisional_trades(pf)
        S._open_after_close(pf)
        ingest_funding(pf, S.SOL, S.hourly(S.T8 + 3 * S.HOUR, 2), received_ms=S.T8 + 6 * S.HOUR)
        book = pf.positions[S.SOL]
        self.assertIn((S.T8 + 3 * S.HOUR, S.T8 + 4 * S.HOUR, D(S.FR)), book.funding)
        revise_funding(pf, S.SOL, [(S.T8 + 3 * S.HOUR, S.T8 + 4 * S.HOUR, S.FR, "0.005")], received_ms=S.T8 + 6 * S.HOUR + S.MIN)
        self.assertIn((S.T8 + 3 * S.HOUR, S.T8 + 4 * S.HOUR, D("0.005")), book.funding)
        self.assertNotIn((S.T8 + 3 * S.HOUR, S.T8 + 4 * S.HOUR, D(S.FR)), book.funding)
        self.assertEqual(reconcile_funding(pf, S.T8 + 6 * S.HOUR + S.MIN), [])    # nothing closed was affected: no adjustment

    def test_the_same_deliveries_in_the_same_order_give_the_same_accounting(self):
        a, b = reconciled(), reconciled()
        for pf in (a, b):
            self.revise(pf)
            reconcile_funding(pf, NOW)
        self.assertEqual(accounting_digest(a), accounting_digest(b))
        self.assertEqual(a.adjustments, b.adjustments)


if __name__ == "__main__":
    unittest.main()
