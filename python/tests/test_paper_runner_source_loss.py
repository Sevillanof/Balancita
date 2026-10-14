"""Paper runner: durable cancellation of pending orders when the source lost continuity (``source_stale``, D-10C-3).
Invented data only; nothing is connected to a live process."""

import unittest

from balancita_engine import paper_runner_store as ST
from balancita_engine import signal_continuity as SC
from balancita_engine.paper_runner import PaperRunner, RunnerConfig, RunnerError, make_event

try:
    from .test_paper_runner_recovery import BTC, CYCLE, ETH, SEC, SRC, Base, cfg, cycle, quote, session, strategies
except ImportError:                                   # run as a top-level module
    from test_paper_runner_recovery import BTC, CYCLE, ETH, SEC, SRC, Base, cfg, cycle, quote, session, strategies

TH = 15 * SEC                                          # the continuity threshold of these invented examples


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
        ids = r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
        self.assertEqual(len(ids), 1)
        self.assertEqual(self.states(r), {BTC: "cancelled", ETH: "pending"})
        record = [o for o in r.orders() if o["product_id"] == BTC][0]
        self.assertEqual(record["reasons"], ["source_stale"])
        self.assertEqual(len(r.portfolio.positions), 0)
        entry = cancelled_entries(r)[0]["data"]
        self.assertEqual((entry["uncovered_from_ms"], entry["uncovered_to_ms"]), (CYCLE + 3 * SEC, CYCLE + 29 * SEC))

    def test_a_gap_that_does_not_overlap_the_order_window_cancels_nothing(self):
        path, r = self.pending_pair()
        late = r.cancel_for_source_loss(BTC, CYCLE + 90 * SEC, CYCLE + 120 * SEC, CYCLE + 120 * SEC, TH)
        early = r.cancel_for_source_loss(BTC, CYCLE + 0, CYCLE + 3 * SEC, CYCLE + 100 * SEC, SEC)
        self.assertEqual((late, early), ([], []))
        self.assertEqual(self.states(r), {BTC: "pending", ETH: "pending"})

    def test_open_positions_and_their_stops_are_not_touched(self):
        path, r = self.fresh()
        r.run(session()[:5])
        self.assertEqual(len(r.portfolio.positions), 2)
        before = r.financial_digest()
        ids = r.cancel_for_source_loss(BTC, CYCLE + 5 * SEC, CYCLE + 40 * SEC, max(r.clock, CYCLE + 40 * SEC), TH)
        self.assertEqual(ids, [])
        self.assertEqual(r.financial_digest(), before)
        self.assertEqual(len(r.portfolio.positions), 2)

    # ---- before the quote that ends the gap --------------------------------------------------------------------
    def test_the_cancellation_comes_before_the_quote_after_the_cut_and_the_order_does_not_fill(self):
        path, r = self.pending_pair()
        r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
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
            r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 30 * SEC, TH)
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
            r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
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
            r2.cancel_for_source_loss(ETH, CYCLE + 4 * SEC, CYCLE + 29 * SEC, CYCLE + 41 * SEC, TH)
        self.assertEqual(caught.exception.reason, "source_loss_after_quote")

    def test_an_order_decided_during_the_gap_is_also_cancelled(self):
        # D-SS-02 (declared, conservative): its earliest fill falls inside the gap
        path, r = self.pending_pair()
        ids = r.cancel_for_source_loss(ETH, CYCLE + 2 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
        self.assertEqual(len(ids), 1)

    # ---- idempotence -------------------------------------------------------------------------------------------
    def test_a_repeated_call_returns_the_same_ids_and_writes_nothing(self):
        path, r = self.pending_pair()
        first = r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
        entries, state, financial = len(r.journal.entries), r.state_digest(), r.financial_digest()
        again = r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 12 * SEC, TH)
        self.assertEqual((again, len(r.journal.entries), r.state_digest(), r.financial_digest()), (first, entries, state, financial))
        self.assertEqual(len(cancelled_entries(r)), 1)

    def test_a_different_gap_over_the_same_order_does_not_cancel_twice(self):
        path, r = self.pending_pair()
        r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
        other = r.cancel_for_source_loss(BTC, CYCLE + 5 * SEC, CYCLE + 40 * SEC, CYCLE + 40 * SEC, TH)
        self.assertEqual(other, [])
        self.assertEqual(len(cancelled_entries(r)), 1)

    # ---- recovery ----------------------------------------------------------------------------------------------
    def test_recovery_after_a_clean_cancellation_reproduces_it_without_cancelling_again(self):
        path, r = self.single_pending()
        ids = r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
        before = r.financial_digest()
        r2 = self.recover(path, CYCLE + 31 * SEC)
        self.assertEqual(r2.financial_digest(), before)
        self.assertEqual(len(cancelled_entries(r2)), 1)
        self.assertEqual(r2.last_recovery["interrupted_orders"], [])
        self.assertEqual(self.states(r2)[BTC], "cancelled")
        self.assertEqual(r2.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 12 * SEC, TH), ids)
        self.assertEqual(len(cancelled_entries(r2)), 1)

    def test_a_crash_between_the_loss_entry_and_the_cancellation_is_finished_by_the_recovery(self):
        path, r = self.single_pending()
        ST.arm("before_journal", 1, "order_cancelled")
        with self.assertRaises(SC.SimulatedCrash):
            r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
        ST.disarm()
        r2 = self.recover(path, CYCLE + 31 * SEC)
        self.assertEqual(self.states(r2), {BTC: "cancelled"})
        self.assertEqual(len(cancelled_entries(r2)), 1)
        self.assertEqual(r2.last_recovery["interrupted_orders"], [])        # cancelled for the loss, not for the interruption
        self.assertEqual(len(r2.portfolio.positions), 0)
        ids = [e["data"]["intent_id"] for e in cancelled_entries(r2)]
        self.assertEqual(r2.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 12 * SEC, TH), ids)
        self.assertEqual(len(cancelled_entries(r2)), 1)

    def test_a_torn_cancellation_entry_is_also_finished_by_the_recovery(self):
        path, r = self.single_pending()
        ST.arm("mid_journal", 1, "order_cancelled")
        with self.assertRaises(SC.SimulatedCrash):
            r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
        ST.disarm()
        r2 = self.recover(path, CYCLE + 31 * SEC)
        self.assertEqual(self.states(r2)[BTC], "cancelled")
        self.assertEqual(len(cancelled_entries(r2)), 1)

    def test_the_replay_of_the_journal_gives_the_same_state_as_the_live_run(self):
        path, r = self.pending_pair()
        r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
        r.handle(quote(ETH, CYCLE + 30 * SEC, "3500", 3))
        live = (r.financial_digest(), r.state_digest())
        entries = [dict(e) for e in r.journal.entries]
        r3 = PaperRunner(r.config, r.strategies, r.log, entries=entries)
        self.assertEqual((r3.financial_digest(), r3.state_digest()), live)

    # ---- causality: HIGH 1 and HIGH 2 of the review of #168 ---------------------------------------------------
    def test_a_new_declaration_before_the_end_of_the_gap_is_refused_and_writes_nothing(self):
        path, r = self.pending_pair()
        entries = len(r.journal.entries)
        with self.assertRaises(RunnerError) as caught:
            r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 10 * SEC, TH)
        self.assertEqual(caught.exception.reason, "source_loss_before_gap_end")
        self.assertEqual(len(r.journal.entries), entries)
        self.assertEqual(self.states(r)[BTC], "pending")
        self.assertEqual(len(r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)), 1)

    def test_a_declaration_exactly_at_the_end_of_the_gap_is_accepted(self):
        path, r = self.pending_pair()
        self.assertEqual(len(r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)), 1)

    def test_a_persisted_declaration_is_repeated_even_with_an_earlier_t_ms(self):
        path, r = self.pending_pair()
        ids = r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
        entries = len(r.journal.entries)
        self.assertEqual(r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 10 * SEC, TH), ids)
        self.assertEqual(len(r.journal.entries), entries)

    def closing_quote(self, event_time_delta, source, stream):
        """The quote that ends the gap: persisted at CYCLE + 29 s, its own time ``event_time_delta`` ms earlier."""
        t = CYCLE + 29 * SEC
        e = quote(BTC, t, "100010", 3)
        e["source"], e["stream"] = source, stream
        e["payload"]["time_ms"] = e["payload"]["received_ms"] = t - event_time_delta
        return e

    def test_before_the_closing_quote_it_cancels_and_after_it_it_refuses_for_every_clock_relation_and_transport(self):
        for delta in (0, 800):                                  # event_time == persisted_at and event_time < persisted_at
            for source, stream in (("kraken-rest", "tickers"), ("kraken-ws", "ticker")):    # REST and WebSocket quotes
                with self.subTest(delta=delta, source=source):
                    path, r = self.pending_pair("c{}{}".format(delta, source))
                    ids = r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
                    self.assertEqual(len(ids), 1)
                    r.handle(self.closing_quote(delta, source, stream))
                    self.assertEqual(self.states(r)[BTC], "cancelled")
                    self.assertEqual(len(r.portfolio.positions), 0)
                    path, r = self.pending_pair("a{}{}".format(delta, source))
                    r.handle(self.closing_quote(delta, source, stream))
                    with self.assertRaises(RunnerError) as caught:
                        r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
                    self.assertEqual(caught.exception.reason, "source_loss_after_quote")
                    self.assertEqual(len([e for e in r.journal.entries if e["kind"] == "source_loss"]), 0)

    def test_the_journal_times_never_go_back_across_successive_calls(self):
        path, r = self.pending_pair()
        r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 29 * SEC, TH)
        r.cancel_for_source_loss(ETH, CYCLE + 4 * SEC, CYCLE + 35 * SEC, CYCLE + 35 * SEC, TH)
        r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE + 12 * SEC, TH)      # repeated
        times = [e["t_ms"] for e in r.journal.entries]
        self.assertEqual(times, sorted(times))

    # ---- D-10B-17: an order that was over before the silence became excessive expires, it is not cancelled ----------
    FROM = CYCLE + 3 * SEC

    def deadlines(self, r):
        return {o["product_id"]: o["timeline"]["deadline_ms"] for o in r.orders() if o["state"] == "pending"}

    def reasons(self, r):
        return {o["product_id"]: (o["state"], o.get("reasons", [])) for o in r.orders()}

    def declare(self, r, product, threshold, extra=SEC, t_ms=None):
        """Declares a silence from FROM that exceeds ``threshold`` by ``extra``; ``gap_to`` is also the call's ``t_ms``."""
        to = self.FROM + threshold + extra
        return to, r.cancel_for_source_loss(product, self.FROM, to, to if t_ms is None else t_ms, threshold)

    def test_an_order_whose_deadline_is_before_the_limit_is_not_cancelled(self):
        path, r = self.pending_pair()
        deadline = self.deadlines(r)[BTC]
        to, ids = self.declare(r, BTC, deadline - self.FROM + 5 * SEC)
        self.assertEqual(ids, [])
        self.assertEqual(self.states(r)[BTC], "pending")
        self.assertEqual(len(cancelled_entries(r)), 0)

    def test_an_order_whose_deadline_equals_the_limit_expires_and_one_millisecond_less_cancels_it(self):
        # the silence is excessive only when it exceeds the threshold: at deadline == gap_from + threshold it did not yet
        path, r = self.pending_pair()
        deadline = self.deadlines(r)[BTC]
        self.assertEqual(self.declare(r, BTC, deadline - self.FROM)[1], [])
        path, r = self.pending_pair("one_less")
        self.assertEqual(len(self.declare(r, BTC, deadline - self.FROM - 1)[1]), 1)

    def test_an_order_still_executable_when_the_threshold_is_exceeded_is_cancelled(self):
        path, r = self.pending_pair()
        to, ids = self.declare(r, BTC, TH)
        self.assertEqual(len(ids), 1)
        self.assertEqual(self.reasons(r)[BTC], ("cancelled", ["source_stale"]))

    def test_a_silence_that_did_not_exceed_the_threshold_is_refused_and_writes_nothing(self):
        path, r = self.pending_pair()
        entries = len(r.journal.entries)
        for to in (self.FROM + TH, self.FROM + TH - 1):
            with self.assertRaises(RunnerError) as caught:
                r.cancel_for_source_loss(BTC, self.FROM, to, to, TH)
            self.assertEqual(caught.exception.reason, "source_loss_below_threshold")
        self.assertEqual(len(r.journal.entries), entries)
        self.assertEqual(len(r.cancel_for_source_loss(BTC, self.FROM, self.FROM + TH + 1, self.FROM + TH + 1, TH)), 1)

    def test_an_open_silence_leaves_the_expired_order_to_the_executor_which_expires_it_with_its_own_reason(self):
        path, r = self.pending_pair()
        deadline = self.deadlines(r)[BTC]
        to, ids = self.declare(r, BTC, deadline - self.FROM + 5 * SEC)          # no quote after the silence
        self.assertEqual((ids, self.states(r)[BTC]), ([], "pending"))
        r.handle(make_event("clock", {}, t_ms=deadline + SEC, source=SRC, source_offset=4))
        self.assertEqual(self.reasons(r)[BTC], ("expired", ["no_quote_in_window"]))
        self.assertEqual(len(cancelled_entries(r)), 0)
        self.assertEqual(len(r.portfolio.positions), 0)

    def test_a_quote_that_closes_the_silence_after_the_deadline_expires_the_order_with_its_original_reason(self):
        path, r = self.pending_pair()
        deadline = self.deadlines(r)[BTC]
        to, ids = self.declare(r, BTC, deadline - self.FROM + 5 * SEC)
        self.assertEqual(ids, [])
        r.handle(quote(BTC, to, "100010", 4))
        self.assertEqual(self.reasons(r)[BTC][0], "expired")
        self.assertIn(self.reasons(r)[BTC][1][0], ("no_quote_in_window", "no_valid_quote_in_window"))
        self.assertEqual(len(cancelled_entries(r)), 0)
        self.assertEqual(len(r.portfolio.positions), 0)

    def test_two_products_with_different_deadlines_get_the_rule_each(self):
        path, r = self.pending_pair()
        deadlines = self.deadlines(r)
        self.assertLess(deadlines[BTC], deadlines[ETH])
        threshold = deadlines[BTC] - self.FROM                  # limit == BTC deadline, below the ETH one
        to = self.FROM + threshold + 5 * SEC
        self.assertEqual(r.cancel_for_source_loss(BTC, self.FROM, to, to, threshold), [])
        self.assertEqual(len(r.cancel_for_source_loss(ETH, self.FROM, to, to, threshold)), 1)
        self.assertEqual(self.reasons(r), {BTC: ("pending", []), ETH: ("cancelled", ["source_stale"])})

    def test_recovery_after_the_expiry_reproduces_the_continuous_run(self):
        events_after = lambda deadline: [quote(BTC, deadline + 5 * SEC, "100010", 4)]
        path, r = self.pending_pair("cont")
        deadline = self.deadlines(r)[BTC]
        to, _ = self.declare(r, BTC, deadline - self.FROM + 5 * SEC)
        for e in events_after(deadline):
            r.handle(e)
        reference = (self.reasons(r), r.financial_digest(), len(cancelled_entries(r)))
        r2 = self.recover(path, deadline + 30 * SEC)
        self.assertEqual((self.reasons(r2), r2.financial_digest(), len(cancelled_entries(r2))), reference)

    def test_recovery_before_the_expiry_keeps_the_cancellation_and_does_not_double_it(self):
        path, r = self.pending_pair()
        deadline = self.deadlines(r)[BTC]
        threshold = deadline - self.FROM                         # BTC is not affected, ETH is
        to = self.FROM + threshold + 5 * SEC
        r.cancel_for_source_loss(BTC, self.FROM, to, to, threshold)
        r.cancel_for_source_loss(ETH, self.FROM, to, to, threshold)
        r2 = self.recover(path, to + SEC)
        self.assertEqual(self.reasons(r2)[ETH], ("cancelled", ["source_stale"]))
        self.assertEqual(len(cancelled_entries(r2)), 1)
        self.assertEqual(len(r2.portfolio.positions), 0)
        self.assertEqual(r2.cancel_for_source_loss(ETH, self.FROM, to, to, threshold), [e["data"]["intent_id"] for e in cancelled_entries(r2)])

    def test_a_repeated_declaration_with_another_threshold_is_a_conflict(self):
        path, r = self.pending_pair()
        self.declare(r, BTC, TH)
        with self.assertRaises(RunnerError) as caught:
            r.cancel_for_source_loss(BTC, self.FROM, self.FROM + TH + SEC, self.FROM + TH + SEC, TH + 1)
        self.assertEqual(caught.exception.reason, "source_loss_conflict")

    # ---- refusals ----------------------------------------------------------------------------------------------
    def test_invalid_calls_are_refused_and_write_nothing(self):
        path, r = self.pending_pair()
        entries = len(r.journal.entries)
        bad = [("", CYCLE, CYCLE + SEC, CYCLE + 5 * SEC, TH), (BTC, CYCLE + SEC, CYCLE + SEC, CYCLE + 5 * SEC, TH),
               (BTC, CYCLE + 9 * SEC, CYCLE + 3 * SEC, CYCLE + 10 * SEC, TH), (BTC, True, CYCLE, CYCLE + 10 * SEC, TH),
               (BTC, CYCLE, CYCLE + 4 * SEC, -1, TH), (BTC, CYCLE, CYCLE + 4 * SEC, CYCLE + 5 * SEC, 0),
               (BTC, CYCLE, CYCLE + 4 * SEC, CYCLE + 5 * SEC, None)]
        for args in bad:
            with self.assertRaises(RunnerError):
                r.cancel_for_source_loss(*args)
        with self.assertRaises(RunnerError) as caught:
            r.cancel_for_source_loss(BTC, CYCLE + 3 * SEC, CYCLE + 29 * SEC, CYCLE, TH)          # before the runner clock
        self.assertEqual(caught.exception.reason, "source_loss_in_the_past")
        self.assertEqual(len(r.journal.entries), entries)

    def test_it_is_not_available_when_orders_fill_on_modelled_prices(self):
        import os
        r = PaperRunner.create(os.path.join(self.dir, "m"), cfg(execution_mode="modelled"), strategies())
        self.live.append(r)
        with self.assertRaises(RunnerError) as caught:
            r.cancel_for_source_loss(BTC, CYCLE, CYCLE + 30 * SEC, CYCLE + 31 * SEC, TH)
        self.assertEqual(caught.exception.reason, "source_loss_not_applicable")


if __name__ == "__main__":
    unittest.main()
