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

    def test_the_published_state_matches_runner_orders_for_every_closed_record(self):
        r = self.expired()
        by_intent = {o["intent_id"]: o["state"] for o in r.orders()}
        self.assertEqual({d["intent_id"]: d["state"] for d in decisions(r)}, by_intent)


if __name__ == "__main__":
    unittest.main()
