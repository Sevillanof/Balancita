"""Paper runner: durable cancellation of pending orders when the source lost continuity (``source_stale``, D-10C-3).
Invented data only; nothing is connected to a live process."""

import unittest

from balancita_engine import paper_runner_store as ST
from balancita_engine import signal_continuity as SC
from balancita_engine.paper_runner import PaperRunner, RunnerConfig, RunnerError

try:
    from .test_paper_runner_recovery import BTC, CYCLE, ETH, SEC, Base, cfg, cycle, quote, session, strategies
except ImportError:                                   # run as a top-level module
    from test_paper_runner_recovery import BTC, CYCLE, ETH, SEC, Base, cfg, cycle, quote, session, strategies


def cancelled_entries(runner):
    return [e for e in runner.journal.entries if e["kind"] == "order_cancelled" and e["data"]["reason"] == "source_stale"]


class SourceLoss(Base):
    def pending_pair(self, name="run"):
        path, r = self.fresh(name)
        r.run([cycle(CYCLE + 2 * SEC, BTC, 1), cycle(CYCLE + 3 * SEC, ETH, 2)])
        self.assertEqual([o["state"] for o in r.orders()], ["pending", "pending"])
        return path, r

    def single_pending(self, name="single"):
        path, r = self.fresh(name)
        r.run([cycle(CYCLE + 2 * SEC, BTC, 1)])
        self.assertEqual([o["state"] for o in r.orders()], ["pending"])
        return path, r

    def states(self, r):
        return {o["product_id"]: o["state"] for o in r.orders()}

    # ---- what is cancelled -------------------------------------------------------------------------------------
    def test_only_the_pending_orders_of_the_product_that_overlap_the_gap_are_cancelled(self):
        path, r = self.pending_pair()
        ids = r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 10 * SEC)
        self.assertEqual(len(ids), 1)
        self.assertEqual(self.states(r), {BTC: "cancelled", ETH: "pending"})
        record = [o for o in r.orders() if o["product_id"] == BTC][0]
        self.assertEqual(record["reasons"], ["source_stale"])
        self.assertEqual(len(r.portfolio.positions), 0)
        entry = cancelled_entries(r)[0]["data"]
        self.assertEqual((entry["uncovered_from_ms"], entry["uncovered_to_ms"]), (CYCLE + 3 * SEC, CYCLE + 29 * SEC))

    def test_a_gap_that_does_not_overlap_the_order_window_cancels_nothing(self):
        path, r = self.pending_pair()
        late = r.cancel_for_source_loss(BTC, CYCLE + 90 * SEC, CYCLE + 120 * SEC, CYCLE + 100 * SEC)
        early = r.cancel_for_source_loss(BTC, CYCLE + 0, CYCLE + 3 * SEC, CYCLE + 100 * SEC)
        self.assertEqual((late, early), ([], []))
        self.assertEqual(self.states(r), {BTC: "pending", ETH: "pending"})

    def test_open_positions_and_their_stops_are_not_touched(self):
        path, r = self.fresh()
        r.run(session()[:5])
        self.assertEqual(len(r.portfolio.positions), 2)
        before = r.financial_digest()
        ids = r.cancel_for_source_loss(BTC, CYCLE + 5 * SEC, CYCLE + 40 * SEC, r.clock)
        self.assertEqual(ids, [])
        self.assertEqual(r.financial_digest(), before)
        self.assertEqual(len(r.portfolio.positions), 2)

    # ---- before the quote that ends the gap --------------------------------------------------------------------
    def test_the_cancellation_comes_before_the_quote_after_the_cut_and_the_order_does_not_fill(self):
        path, r = self.pending_pair()
        r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 20 * SEC)
        r.handle(quote(BTC, CYCLE + 29 * SEC, "100010", 3))
        self.assertEqual(len(r.portfolio.positions), 0)
        self.assertEqual(self.states(r)[BTC], "cancelled")

    def test_without_the_cancellation_the_same_quote_fills_the_order_regression_26_s(self):
        path, r = self.pending_pair()
        r.handle(quote(BTC, CYCLE + 29 * SEC, "100010", 3))             # a 26 s silence, then the quote
        self.assertEqual(self.states(r)[BTC], "opened")
        self.assertEqual(len(r.portfolio.positions), 1)

    def test_after_the_quote_that_ended_the_gap_it_is_refused(self):
        path, r = self.pending_pair()
        r.handle(quote(BTC, CYCLE + 29 * SEC, "100010", 3))
        with self.assertRaises(RunnerError) as caught:
            r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 30 * SEC)
        self.assertEqual(caught.exception.reason, "source_loss_after_quote")
        self.assertEqual(len(cancelled_entries(r)), 0)

    def test_a_closing_quote_whose_own_time_is_before_the_end_of_the_gap_still_refuses_the_call(self):
        # D-SS-01: the gap is measured in journal time (persisted_at); the quote's time_ms can be earlier than its t_ms
        path, r = self.pending_pair()
        late = quote(BTC, CYCLE + 29 * SEC, "100010", 3)
        late["payload"]["time_ms"] = CYCLE + 29 * SEC - 800
        late["payload"]["received_ms"] = CYCLE + 29 * SEC - 800
        r.handle(late)
        self.assertEqual(self.states(r)[BTC], "opened")
        with self.assertRaises(RunnerError) as caught:
            r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC)
        self.assertEqual(caught.exception.reason, "source_loss_after_quote")
        self.assertEqual(len([e for e in r.journal.entries if e["kind"] == "source_loss"]), 0)

    def test_the_clock_of_the_last_quote_survives_a_recovery(self):
        path, r = self.pending_pair()
        late = quote(ETH, CYCLE + 29 * SEC, "3500", 3)
        late["payload"]["time_ms"] = CYCLE + 29 * SEC - 800
        late["payload"]["received_ms"] = CYCLE + 29 * SEC - 800
        r.handle(late)
        r2 = self.recover(path, CYCLE + 40 * SEC)
        with self.assertRaises(RunnerError) as caught:
            r2.cancel_for_source_loss(ETH, CYCLE + 4 * SEC, CYCLE + 29 * SEC, CYCLE + 41 * SEC)
        self.assertEqual(caught.exception.reason, "source_loss_after_quote")

    def test_an_order_decided_during_the_gap_is_also_cancelled(self):
        # D-SS-02 (declared, conservative): its earliest fill falls inside the gap
        path, r = self.pending_pair()
        ids = r.cancel_for_source_loss(ETH, CYCLE + 2 * SEC, CYCLE + 29 * SEC, CYCLE + 10 * SEC)
        self.assertEqual(len(ids), 1)

    # ---- idempotence -------------------------------------------------------------------------------------------
    def test_a_repeated_call_returns_the_same_ids_and_writes_nothing(self):
        path, r = self.pending_pair()
        first = r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 10 * SEC)
        entries, state, financial = len(r.journal.entries), r.state_digest(), r.financial_digest()
        again = r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 12 * SEC)
        self.assertEqual((again, len(r.journal.entries), r.state_digest(), r.financial_digest()), (first, entries, state, financial))
        self.assertEqual(len(cancelled_entries(r)), 1)

    def test_a_different_gap_over_the_same_order_does_not_cancel_twice(self):
        path, r = self.pending_pair()
        r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 10 * SEC)
        other = r.cancel_for_source_loss(BTC, CYCLE + 5 * SEC, CYCLE + 40 * SEC, CYCLE + 12 * SEC)
        self.assertEqual(other, [])
        self.assertEqual(len(cancelled_entries(r)), 1)

    # ---- recovery ----------------------------------------------------------------------------------------------
    def test_recovery_after_a_clean_cancellation_reproduces_it_without_cancelling_again(self):
        path, r = self.single_pending()
        ids = r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 10 * SEC)
        before = r.financial_digest()
        r2 = self.recover(path, CYCLE + 11 * SEC)
        self.assertEqual(r2.financial_digest(), before)
        self.assertEqual(len(cancelled_entries(r2)), 1)
        self.assertEqual(r2.last_recovery["interrupted_orders"], [])
        self.assertEqual(self.states(r2)[BTC], "cancelled")
        self.assertEqual(r2.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 12 * SEC), ids)
        self.assertEqual(len(cancelled_entries(r2)), 1)

    def test_a_crash_between_the_loss_entry_and_the_cancellation_is_finished_by_the_recovery(self):
        path, r = self.single_pending()
        ST.arm("before_journal", 1, "order_cancelled")
        with self.assertRaises(SC.SimulatedCrash):
            r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 10 * SEC)
        ST.disarm()
        r2 = self.recover(path, CYCLE + 11 * SEC)
        self.assertEqual(self.states(r2), {BTC: "cancelled"})
        self.assertEqual(len(cancelled_entries(r2)), 1)
        self.assertEqual(r2.last_recovery["interrupted_orders"], [])        # cancelled for the loss, not for the interruption
        self.assertEqual(len(r2.portfolio.positions), 0)
        ids = [e["data"]["intent_id"] for e in cancelled_entries(r2)]
        self.assertEqual(r2.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 12 * SEC), ids)
        self.assertEqual(len(cancelled_entries(r2)), 1)

    def test_a_torn_cancellation_entry_is_also_finished_by_the_recovery(self):
        path, r = self.single_pending()
        ST.arm("mid_journal", 1, "order_cancelled")
        with self.assertRaises(SC.SimulatedCrash):
            r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 10 * SEC)
        ST.disarm()
        r2 = self.recover(path, CYCLE + 11 * SEC)
        self.assertEqual(self.states(r2)[BTC], "cancelled")
        self.assertEqual(len(cancelled_entries(r2)), 1)

    def test_the_replay_of_the_journal_gives_the_same_state_as_the_live_run(self):
        path, r = self.pending_pair()
        r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 10 * SEC)
        r.handle(quote(ETH, CYCLE + 30 * SEC, "3500", 3))
        live = (r.financial_digest(), r.state_digest())
        entries = [dict(e) for e in r.journal.entries]
        r3 = PaperRunner(r.config, r.strategies, r.log, entries=entries)
        self.assertEqual((r3.financial_digest(), r3.state_digest()), live)

    # ---- refusals ----------------------------------------------------------------------------------------------
    def test_invalid_calls_are_refused_and_write_nothing(self):
        path, r = self.pending_pair()
        entries = len(r.journal.entries)
        bad = [("", CYCLE, CYCLE + SEC, CYCLE + 5 * SEC), (BTC, CYCLE + SEC, CYCLE + SEC, CYCLE + 5 * SEC),
               (BTC, CYCLE + 9 * SEC, CYCLE + 3 * SEC, CYCLE + 10 * SEC), (BTC, True, CYCLE, CYCLE + 10 * SEC),
               (BTC, CYCLE, CYCLE + 4 * SEC, -1)]
        for args in bad:
            with self.assertRaises(RunnerError):
                r.cancel_for_source_loss(*args)
        with self.assertRaises(RunnerError) as caught:
            r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE)          # before the runner clock
        self.assertEqual(caught.exception.reason, "source_loss_in_the_past")
        self.assertEqual(len(r.journal.entries), entries)

    def test_it_is_not_available_when_orders_fill_on_modelled_prices(self):
        import os
        r = PaperRunner.create(os.path.join(self.dir, "m"), cfg(execution_mode="modelled"), strategies())
        self.live.append(r)
        with self.assertRaises(RunnerError) as caught:
            r.cancel_for_source_loss(BTC, CYCLE, CYCLE + 30 * SEC, CYCLE + 31 * SEC)
        self.assertEqual(caught.exception.reason, "source_loss_not_applicable")


if __name__ == "__main__":
    unittest.main()
