"""Issue #185, BAL-DECISION-185-CARTERA-SIMULADA-02 (G3): a pending order holds NO reservation. Size and admission are decided when the order
fills (``execution_timing._fill``), against the free capital of that instant; the replay test shows determinism and the duplicate guard, not a real process restart (that is covered by the session tests of #186); what is shown as committed is only open positions. Invented data,
nothing real, no new rule: this pins what the executor does today, so a change that lets an order reserve, double-use or duplicate shows up."""

import unittest
from decimal import Decimal

from balancita_engine import paper_live_publish as PUB
from balancita_engine.execution_timing import ExecutionPolicy, TimedExecutor
from balancita_engine.multi_signals import make_signal
from balancita_engine.portfolio import Portfolio
from test_execution_timing import CYCLE, FUNDING, HOUR, PRODUCT, SEC, Env, quote, roomy

D = Decimal
ETH = "PF_ETHUSD"
BOOK = {PRODUCT: ("100000", "1000"), ETH: ("3500", "35")}               # product -> (reference price, ATR)


def tight():
    """Risk 10 % per trade makes the wanted size far larger than the capital, so the exposure limits are what bind: BTC alone could take 60 %,
    the gross limit leaves ETH only what BTC left."""
    return roomy(risk_per_trade="0.10", max_product_exposure_pct="0.6", daily_loss_limit_usd="100000", max_drawdown_usd="100000")


class Pending(Env):
    def persist_for(self, product):
        s = self.strategies[0]
        signal = make_signal(strategy_id=s.id, strategy_version=s.version, product_id=product, bucket_ms=CYCLE, action="BUY",
                             strength="0.8", horizon_minutes=60, evidence={"x": "1"})
        receipt = self.log.ingest(signal, {"price": BOOK[product][0]}, CYCLE + 2 * SEC, origin="original")
        return self.log.entries[receipt["seq"] - 1]

    def make(self):
        funding = {p: FUNDING[PRODUCT] for p in BOOK}
        return TimedExecutor(Portfolio(tight(), funding=funding), ExecutionPolicy())

    def send(self, ex, product, decided=CYCLE + 3 * SEC):
        price, atr = BOOK[product]
        return ex.submit(self.persist_for(product), reference_price=price, atr=atr, decided_ms=decided)

    def fill(self, ex, product, t=CYCLE + 5 * SEC):
        price = BOOK[product][0]
        return ex.on_quote(quote(t, price, product=product))

    def money(self, ex):
        snap = ex.portfolio.snapshot()
        return {k: snap[k] for k in ("capital_definitive_usd", "equity_usd", "reserved_usd", "available_usd", "open_positions", "closed_trades")}

    def test_a_pending_order_reserves_nothing_and_is_never_shown_as_committed(self):
        ex = self.make()
        before = self.money(ex)
        for product in BOOK:
            self.assertEqual(self.send(ex, product)["status"], "pending")
        self.assertEqual(len(ex.pending), 2)
        self.assertEqual(self.money(ex), before)                          # nothing was taken from the free capital
        view = PUB.account(ex.portfolio)
        self.assertEqual((view["committed_usd"], view["free_usd"], view["committed_scope"]), ("0", "1000", "open_positions_only"))
        self.assertEqual(ex.portfolio.capital_log, [])                     # and the ledger has nothing for them

    def test_the_published_block_counts_the_pending_orders_apart_from_the_committed_money(self):
        from unittest import mock
        ex = self.make()
        for product in BOOK:
            self.send(ex, product)

        class Runner(object):                               # only what ``positions`` reads from a runner
            portfolio, clock, open_cycles, open_funding, status = ex.portfolio, CYCLE, [], [], "closed"
            executor = ex

        with mock.patch.object(PUB, "protection", lambda r: []), mock.patch.object(PUB, "integrated_audit", lambda r: {"violations": []}):
            before = PUB.positions(Runner(), report_age_ms=None, max_age_ms=None)["account"]
            self.fill(ex, PRODUCT)
        after = PUB.account(ex.portfolio, len(ex.pending))
        self.assertEqual((before["pending_orders"], before["committed_usd"], before["pending_reserved_usd"]), (2, "0", "0"))
        self.assertEqual((after["pending_orders"], after["pending_reservation"], after["pending_reserved_usd"]), (1, "none", "0"))
        self.assertEqual(D(after["committed_usd"]), D("600.00"))          # only the position that opened is committed

    def test_two_simultaneous_orders_fill_one_after_the_other_against_the_free_capital_of_each_instant(self):
        ex = self.make()
        for product in BOOK:
            self.send(ex, product)
        [first] = self.fill(ex, PRODUCT)
        free_for_second = ex.portfolio.available_usd()
        self.assertEqual(D(first["notional_usd"]), D("600.00"))            # the product limit
        self.assertEqual(free_for_second, D(1000) - D(first["notional_usd"]))   # what the first one took is no longer free
        [second] = self.fill(ex, ETH)
        self.assertEqual((first["status"], second["status"]), ("opened", "opened"))
        self.assertLessEqual(D(second["notional_usd"]), free_for_second)   # never funded with capital already committed
        self.assertEqual(D(second["notional_usd"]), D("400.00"))
        self.assertTrue({"gross_limit", "margin"} & set(second["limits_applied"]), second["limits_applied"])
        snap = ex.portfolio.snapshot()
        self.assertLessEqual(D(snap["reserved_usd"]), D(snap["capital_definitive_usd"]))
        self.assertGreaterEqual(D(snap["available_usd"]), 0)
        self.assertEqual(D(snap["reserved_usd"]), D(first["notional_usd"]) + D(second["notional_usd"]))

    def test_sequential_orders_get_the_same_sizes_as_simultaneous_ones(self):
        together, apart = self.make(), self.make()
        for product in BOOK:
            self.send(together, product)
        a = self.fill(together, PRODUCT) + self.fill(together, ETH)
        self.send(apart, PRODUCT)
        b = self.fill(apart, PRODUCT)
        self.send(apart, ETH, decided=CYCLE + 20 * SEC)
        b += self.fill(apart, ETH, t=CYCLE + 22 * SEC)
        self.assertEqual([r["notional_usd"] for r in a], [r["notional_usd"] for r in b])
        self.assertEqual(self.money(together), self.money(apart))

    def test_a_cancelled_and_an_expired_order_leave_the_money_and_the_ledger_untouched(self):
        ex = self.make()
        before = self.money(ex)
        ids = {p: self.send(ex, p)["intent_id"] for p in BOOK}
        cancelled = ex.cancel(ids[PRODUCT], "runner_interrupted", CYCLE + 4 * SEC)
        self.assertEqual(cancelled["status"], "rejected")
        self.assertEqual(self.money(ex), before)
        self.assertIsNone(ex.cancel(ids[PRODUCT], "runner_interrupted", CYCLE + 5 * SEC))       # a second cancel changes nothing
        [expired] = ex.advance(CYCLE + 3 * SEC + 61 * SEC)                                       # the other one runs out of window
        self.assertEqual((expired["status"], expired["reasons"]), ("rejected", ["no_quote_in_window"]))
        self.assertEqual(ex.advance(CYCLE + 3 * SEC + 62 * SEC), [])                              # expiring twice changes nothing
        self.assertEqual(self.money(ex), before)
        self.assertEqual((ex.portfolio.capital_log, ex.portfolio.positions, ex.portfolio.trades), ([], {}, []))

    def test_an_order_is_sized_as_if_a_cancelled_one_beside_it_had_never_existed(self):
        ex, alone = self.make(), self.make()
        ids = {p: self.send(ex, p)["intent_id"] for p in BOOK}
        self.send(alone, ETH)
        ex.cancel(ids[PRODUCT], "runner_interrupted", CYCLE + 4 * SEC)
        [with_cancelled] = self.fill(ex, ETH)
        [reference] = self.fill(alone, ETH)
        self.assertEqual(with_cancelled["notional_usd"], reference["notional_usd"])
        self.assertEqual(self.money(ex), self.money(alone))

    def test_replaying_the_same_orders_is_deterministic_and_a_resent_decision_is_not_counted_twice(self):
        first, replay = self.make(), self.make()
        for ex in (first, replay):
            for product in BOOK:
                self.send(ex, product)
            self.fill(ex, PRODUCT)
            self.fill(ex, ETH)
        self.assertEqual(self.money(first), self.money(replay))
        self.assertEqual(first.ledger_hash(), replay.ledger_hash())
        self.assertEqual(first.portfolio.capital_log, replay.portfolio.capital_log)
        before = self.money(first)
        self.assertEqual(self.send(first, PRODUCT)["status"], "duplicate")      # the same decision again, after a restart
        self.assertEqual(self.fill(first, PRODUCT, t=CYCLE + 30 * SEC), [])
        self.assertEqual(self.money(first), before)
        self.assertEqual(len(first.records), 2)


if __name__ == "__main__":
    unittest.main()
