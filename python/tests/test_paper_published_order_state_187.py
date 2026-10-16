"""Issue #187: the published order state is the one ``runner.orders()`` gives. The executor records an order that expired without a
quote as ``rejected``; the operator reads it as ``expired``. Invented data."""

import unittest

from balancita_engine import paper_live_publish as PUB
from balancita_engine.paper_runner_report import decisions

import test_paper_runner as T


class TestPublishedOrderState(T.Rig):
    def expired(self):
        r = self.runner({"scripted-a": {(T.BTC, T.CYCLE): self.call("BUY")}})
        r.run([T.cycle(T.CYCLE + 2 * T.SEC, T.BTC)])
        r.run([T.make_event("clock", {}, t_ms=T.CYCLE + 70 * T.SEC)])
        return r

    def test_an_order_that_expired_without_a_quote_is_published_as_expired_everywhere(self):
        r = self.expired()
        [order] = r.orders()
        [decision] = decisions(r)
        [interval] = PUB.intervals(r)["intervals"]
        self.assertEqual(order["state"], "expired")
        self.assertEqual((decision["state"], decision["result"]), ("expired", "expired"))
        self.assertEqual(interval["stages"]["order"]["state"], "expired")
        self.assertEqual(interval["stages"]["order"]["reasons"], ["no_quote_in_window"])

    def competing(self):
        """Three products want in at once: two open and one is refused by the open-risk limit."""
        r = self.runner({"scripted-a": {(p, T.CYCLE): self.call("BUY") for p in T.PRICES}})
        r.run([T.cycle(T.CYCLE + 2 * T.SEC, p) for p in T.PRICES])
        r.run([T.quote(p, T.CYCLE + 5 * T.SEC + i, T.PRICES[p][0]) for i, p in enumerate(T.PRICES)])
        return r

    def pending(self):
        r = self.runner({"scripted-a": {(T.BTC, T.CYCLE): self.call("BUY")}})
        r.run([T.cycle(T.CYCLE + 2 * T.SEC, T.BTC)])
        return r

    def cancelled(self):
        r = self.pending()
        r.cancel_for_source_loss(T.BTC, T.CYCLE + 2 * T.SEC, T.CYCLE + 29 * T.SEC, T.CYCLE + 29 * T.SEC, 15 * T.SEC)
        return r

    def same_in_all_three_places(self, r):
        orders = {o["intent_id"]: o["state"] for o in r.orders()}
        self.assertTrue(orders)
        self.assertEqual({d["intent_id"]: d["state"] for d in decisions(r)}, orders)
        by_product = {row["product_id"]: row["stages"]["order"]["state"] for row in PUB.intervals(r)["intervals"]}
        self.assertEqual(by_product, {o["product_id"]: o["state"] for o in r.orders()})
        return orders

    def test_the_published_state_matches_runner_orders_row_by_row_for_every_kind_of_order(self):
        seen = {}
        for name in ("expired", "cancelled", "pending", "competing"):
            with self.subTest(case=name):
                seen[name] = sorted(set(self.same_in_all_three_places(getattr(self, name)()).values()))
        self.assertEqual(seen["expired"], ["expired"])
        self.assertEqual(seen["cancelled"], ["cancelled"])
        self.assertEqual(seen["pending"], ["pending"])
        self.assertEqual(seen["competing"], ["opened", "rejected"])                # opened, and refused by the risk limit


if __name__ == "__main__":
    unittest.main()
