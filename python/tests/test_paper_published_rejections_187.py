"""Issue #187 (BAL-MATRIZ-187-COBERTURA-01, brecha 1): the published ``decisions``/``intervals`` rows tell why an entry did not open and
which orders are still waiting. Only reads what the runner already holds; invented data; no production code is touched."""

import os
import unittest

from balancita_engine import paper_live_publish as PUB
from balancita_engine.paper_runner import PaperRunner
from balancita_engine.paper_runner_report import decisions

import test_paper_entry_blocked_186 as BLK
import test_paper_runner as T
import test_paper_runner_recovery as REC


def rows(runner, **kw):
    return {r["product_id"]: r for r in PUB.intervals(runner, **kw)["intervals"]}


class TestRejectionsAndPending(T.Rig):
    def competing(self):
        script = {"scripted-a": {(p, T.CYCLE): self.call("BUY") for p in T.PRICES}}
        r = self.runner(script)
        r.run([T.cycle(T.CYCLE + 2 * T.SEC, p) for p in T.PRICES])
        r.run([T.quote(p, T.CYCLE + 5 * T.SEC + i, T.PRICES[p][0]) for i, p in enumerate(T.PRICES)])
        return r

    def test_an_order_rejected_by_the_risk_limit_is_published_with_its_reason_and_no_trade(self):
        r = self.competing()
        by_state = {}
        for product, row in rows(r).items():
            by_state.setdefault(row["stages"]["order"]["state"], []).append(row)
        self.assertEqual(sorted(by_state), ["opened", "rejected"])
        [rejected] = by_state["rejected"]
        self.assertIn("open_risk_limit", rejected["stages"]["order"]["reasons"])
        self.assertEqual(rejected["stages"]["trade"]["state"], "none")                 # no trade is invented for a rejected order
        self.assertEqual(rejected["stages"]["decision"]["state"], "recorded")
        for row in by_state["opened"]:
            self.assertEqual(row["stages"]["order"]["reasons"], [])
            self.assertEqual(row["stages"]["trade"]["state"], "open")
        direct = {d["product_id"]: d for d in decisions(r)}
        self.assertEqual(direct[rejected["product_id"]]["state"], "rejected")          # decisions() itself (D: it had no direct test)
        self.assertEqual(direct[rejected["product_id"]]["result"], "rejected")
        self.assertIn("open_risk_limit", direct[rejected["product_id"]]["reasons"])

    def test_the_contract_is_complete_only_because_every_signal_reference_checks_out(self):
        r = self.competing()
        block = PUB.intervals(r)
        self.assertTrue(block["contract"]["complete"])
        self.assertEqual(block["contract"]["stages_missing"], [])
        self.assertTrue(all(row["stages"]["signal"]["state"] == "recorded" for row in block["intervals"]))

    def test_an_order_without_a_quote_is_published_as_pending_with_no_entry_and_then_as_expired(self):
        r = self.runner({"scripted-a": {(T.BTC, T.CYCLE): self.call("BUY")}})
        r.run([T.cycle(T.CYCLE + 2 * T.SEC, T.BTC)])
        pending = rows(r)[T.BTC]["stages"]
        self.assertEqual((pending["order"]["state"], pending["order"]["entry_ms"], pending["trade"]["state"]), ("pending", None, "none"))
        self.assertEqual(pending["decision"]["state"], "recorded")
        r.run([T.make_event("clock", {}, t_ms=T.CYCLE + 70 * T.SEC)])
        gone = rows(r)[T.BTC]["stages"]["order"]
        # KNOWN GAP (BAL-MATRIZ-187-COBERTURA-01): the published row copies the executor's raw state, so an order that expired without a
        # quote reads "rejected" here while ``runner.orders()`` normalizes it to "expired". The reason is the same and is what a reader needs;
        # the state word is fixed by the follow-up change proposed in the matrix, and this assertion must then change with it.
        self.assertEqual((gone["state"], gone["reasons"]), ("rejected", ["no_quote_in_window"]))
        [order] = r.orders()
        self.assertEqual((order["state"], order["reasons"]), ("expired", ["no_quote_in_window"]))

    def test_the_interval_filters_keep_the_rejections_of_their_own_product_and_window(self):
        r = self.competing()
        everything = PUB.intervals(r)["intervals"]
        self.assertEqual(len(everything), 3)
        rejected = [x for x in everything if x["stages"]["order"]["state"] == "rejected"][0]
        only = PUB.intervals(r, product=rejected["product_id"])["intervals"]
        self.assertEqual([x["stages"]["order"]["state"] for x in only], ["rejected"])
        self.assertEqual(PUB.intervals(r, to_ms=rejected["decided_ms"])["intervals"], [])      # the window ends before the decision


class TestStaleEntryIsPublished(REC.Base):
    def test_an_entry_blocked_for_old_data_is_published_as_rejected_with_the_stale_reason(self):
        path = os.path.join(self.dir, "stale")
        r = PaperRunner.create(path, BLK.with_limit(), REC.strategies())
        self.live.append(r)
        r.run([REC.cycle(REC.CYCLE + 2 * REC.SEC, REC.BTC, 1)])                       # no quote at all: the entry is blocked, no order exists
        [row] = PUB.intervals(r)["intervals"]
        self.assertEqual((row["stages"]["order"]["state"], row["stages"]["order"]["reasons"]), ("rejected", ["entry_blocked_source_stale"]))
        self.assertEqual(row["stages"]["trade"]["state"], "none")
        self.assertEqual((len(r.executor.pending), len(r.portfolio.positions)), (0, 0))


if __name__ == "__main__":
    unittest.main()
