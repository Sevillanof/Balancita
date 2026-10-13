"""Stage 7: accounting and risk under adverse conditions.

Gaps through stops (LONG and SHORT, evidence, never a better price than planned), the minute of entry watched with
quotes, losses larger than planned with the daily-loss and drawdown suspensions, late funding reconciliation
(partial, complete, duplicated, contradictory, idempotent, across restarts), duplicated and out-of-order events,
the independent validators (including accounting errors planted on purpose) and reproducibility. Synthetic data only."""

import copy
import os
import pickle
import random
import re
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import portfolio_stage7 as S
from balancita_engine.futures_costs import exit_fill
from balancita_engine.futures_simulator import STOP_POLICIES, Book, simulate
from balancita_engine.portfolio import LONG, SHORT, Portfolio, PortfolioError, PortfolioPolicy
from balancita_engine.portfolio_audit import (
    accounting_digest, audit, exit_basis, intake_digest, planned_vs_realized, trade_reconstruction,
)
from balancita_engine.portfolio_funding import ingest_funding, reconcile_funding
from balancita_engine.portfolio_watch import QuoteWatch, WatchPolicy, parse_quote

D = Decimal
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
COMMITTED = os.path.join(ROOT, "analisis", "etapa7-contabilidad-adversa")
APPROVED_POLICY_HASH = "8c22a0c0143c697c"   # PortfolioPolicy().policy_hash() on main before stage 7: no limit may change


def rules(pf):
    return sorted({v["rule"] for v in audit(pf)["violations"]})


def gap_portfolio(side=LONG, policy="gap_open"):
    """One closed trade: planned loss ~10, stop gapped through (LONG 100 000 / stop 98 000 / open 96 950)."""
    pf = S.new_portfolio(stop_policy=policy)
    pf.decide([S.intent(S.BTC, side, S.T10)], S.T10)
    if side == LONG:
        pf.on_candle(S.BTC, S.T10, S.candle(100000, 100100, 98200, 98200))
        pf.on_candle(S.BTC, S.T10 + S.MIN, S.candle(96950, 97200, 96800, 97100))
    else:
        pf.on_candle(S.BTC, S.T10, S.candle(100000, 101800, 99900, 101800))
        pf.on_candle(S.BTC, S.T10 + S.MIN, S.candle(103050, 103200, 102800, 102900))
    return pf


def funded_portfolio():
    """Two trades closed with incomplete funding, then everything reconciled."""
    pf = S._funding_portfolio()
    S._provisional_trades(pf)
    S._open_after_close(pf)
    ingest_funding(pf, S.BTC, S.hourly(S.T8 + S.HOUR, 3), received_ms=S.T8 + 4 * S.HOUR + 5 * S.MIN)
    ingest_funding(pf, S.ETH, S.hourly(S.T8 - S.HOUR, 3), received_ms=S.T8 + 4 * S.HOUR + 5 * S.MIN)
    reconcile_funding(pf, S.T8 + 4 * S.HOUR + 5 * S.MIN)
    return pf


class ApprovedParameters(unittest.TestCase):
    def test_risk_parameters_are_the_approved_ones(self):
        self.assertEqual(S.approved_policy(), PortfolioPolicy())
        self.assertEqual(PortfolioPolicy().policy_hash(), APPROVED_POLICY_HASH)
        p = PortfolioPolicy()
        self.assertEqual((p.initial_equity_usd, p.risk_per_trade, p.max_open_risk_pct, p.daily_loss_limit_usd, p.max_drawdown_usd),
                         ("1000", "0.01", "0.02", "20", "60"))


class GapStops(unittest.TestCase):
    def test_long_gap_exits_below_the_stop_and_books_the_whole_loss(self):
        pf = gap_portfolio(LONG)
        [trade] = pf.trades
        self.assertEqual(trade["exit_reason"], "stop")
        self.assertLess(D(trade["exit_price"]), D(trade["stop_price"]))
        self.assertLess(D(trade["exit_price"]), exit_fill(D(trade["stop_price"]), LONG, S.BTC, "stop"))
        planned, realized = D(str(trade["planned_loss_usd"])), -D(str(trade["pnl_usd"]))
        self.assertAlmostEqual(float(planned), 10.0, places=2)
        self.assertAlmostEqual(float(realized), 15.0, places=1)
        self.assertGreater(realized, planned)
        self.assertEqual(pf.capital_usd(), D("1000") - realized)          # every dollar of the loss is in the capital
        self.assertEqual(rules(pf), [])

    def test_short_gap_mirrors_the_long(self):
        pf = gap_portfolio(SHORT)
        [trade] = pf.trades
        self.assertGreater(D(trade["exit_price"]), D(trade["stop_price"]))
        self.assertGreater(D(trade["exit_price"]), exit_fill(D(trade["stop_price"]), SHORT, S.BTC, "stop"))
        self.assertAlmostEqual(float(-D(str(trade["pnl_usd"]))), 15.0, places=1)
        self.assertEqual(pf.capital_usd(), D("1000") + D(str(trade["pnl_usd"])))
        self.assertEqual(rules(pf), [])

    def test_the_stop_price_executable_price_and_slippage_are_recorded(self):
        for side in (LONG, SHORT):
            [trade] = gap_portfolio(side).trades
            info = trade["stop_exit"]
            self.assertEqual(D(info["stop_level"]), D(trade["stop_price"]))
            self.assertEqual(D(info["executable_price"]), D(trade["exit_price"]))
            self.assertEqual(info["evidence"], "ohlc_open_gap")
            self.assertTrue(info["estimated"])
            self.assertFalse(info["quote_backed"])
            self.assertGreater(D(info["gap_bps"]), 0)
            self.assertGreater(D(info["slippage_bps"]), D(info["gap_bps"]))   # the modelled spread and impact come on top
            self.assertEqual(exit_basis(trade), "estimated_from_candles")

    def test_the_exit_reference_is_the_candle_open_when_it_opened_beyond_the_stop(self):
        [trade] = gap_portfolio(LONG).trades
        self.assertEqual(D(trade["stop_exit"]["reference_price"]), D("96950"))
        [trade] = gap_portfolio(SHORT).trades
        self.assertEqual(D(trade["stop_exit"]["reference_price"]), D("103050"))

    def test_stop_touched_without_a_gap_executes_at_its_level_and_loses_the_plan(self):
        pf = S.new_portfolio()
        pf.decide([S.intent(S.BTC, LONG, S.T10)], S.T10)
        pf.on_candle(S.BTC, S.T10, S.candle(100000, 100200, 99800, 100000))
        [trade] = pf.on_candle(S.BTC, S.T10 + S.MIN, S.candle(99500, 99600, 97900, 98100))
        self.assertEqual(trade["stop_exit"]["evidence"], "ohlc_stop_level")
        self.assertEqual(D(trade["stop_exit"]["gap_bps"]), 0)
        self.assertAlmostEqual(float(-D(str(trade["pnl_usd"]))), float(trade["planned_loss_usd"]), places=3)
        self.assertEqual(exit_basis(trade), "modelled_at_stop_level")
        self.assertEqual(rules(pf), [])

    def test_the_worst_bound_policy_is_never_better_than_the_open_policy(self):
        for side in (LONG, SHORT):
            a, b = gap_portfolio(side, "gap_open").trades[0], gap_portfolio(side, "gap_worst").trades[0]
            self.assertLess(D(str(b["pnl_usd"])), D(str(a["pnl_usd"])))
            self.assertEqual(b["stop_exit"]["evidence"], "ohlc_worst_bound")

    def test_a_candle_without_an_open_falls_back_to_the_worst_bound_not_to_an_invention(self):
        pf = S.new_portfolio()
        pf.decide([S.intent(S.BTC, LONG, S.T10)], S.T10)
        pf.on_candle(S.BTC, S.T10, S.candle(100000, 100100, 98200, 98200))
        [trade] = pf.on_candle(S.BTC, S.T10 + S.MIN, {"high": "97200", "low": "96800", "close": "97100"})
        self.assertEqual(trade["stop_exit"]["evidence"], "ohlc_worst_bound_open_unavailable")
        self.assertTrue(trade["stop_exit"]["estimated"])
        self.assertLessEqual(D(trade["exit_price"]), exit_fill(D("96800"), LONG, S.BTC, "stop"))

    def test_no_open_ever_gives_a_better_price_than_the_plan(self):
        """Property over a grid of candle opens, both policies, both sides."""
        for side in (LONG, SHORT):
            for policy in ("gap_open", "gap_worst"):
                for step in range(0, 6001, 250):
                    sign = 1 if side == LONG else -1
                    open_price = 99900 - sign * 0 - sign * step if side == LONG else 100100 + step
                    pf = S.new_portfolio(stop_policy=policy)
                    pf.decide([S.intent(S.BTC, side, S.T10)], S.T10)
                    low, high = (min(open_price, 98200 if side == LONG else 99900) - 100, 100100) if side == LONG \
                        else (99900, max(open_price, 101800) + 100)
                    closes = pf.on_candle(S.BTC, S.T10 + S.MIN, S.candle(open_price, high, low, open_price)) if False else []
                    # the first candle is the entry minute's follower: touch the stop right away
                    closes = pf.on_candle(S.BTC, S.T10, S.candle(open_price, high, low, open_price))
                    for trade in closes:
                        planned = exit_fill(D(trade["stop_price"]), side, S.BTC, "stop")
                        self.assertTrue(D(trade["exit_price"]) <= planned if side == LONG else D(trade["exit_price"]) >= planned,
                                        (side, policy, open_price))
                    self.assertEqual(rules(pf), [], (side, policy, open_price))

    def test_the_default_policy_keeps_the_earlier_behaviour_bit_for_bit(self):
        legacy = gap_portfolio(LONG, "level")
        [trade] = legacy.trades
        self.assertNotIn("stop_exit", trade)                       # no new field unless the option is on
        self.assertEqual(D(trade["exit_price"]), exit_fill(D(trade["stop_price"]), LONG, S.BTC, "stop"))
        self.assertAlmostEqual(float(-D(str(trade["pnl_usd"]))), float(trade["planned_loss_usd"]), places=3)
        self.assertEqual(Portfolio(PortfolioPolicy()).stop_policy, "level")
        self.assertEqual(Book({"id": "x"}).stop_policy, "level")

    def test_the_option_does_not_change_a_book_that_is_not_gapped(self):
        for policy in STOP_POLICIES:
            pf = S.new_portfolio(stop_policy=policy)
            pf.decide([S.intent(S.BTC, LONG, S.T10, target_pct="0.01")], S.T10)
            [trade] = pf.on_candle(S.BTC, S.T10, S.candle(100000, 101500, 99900, 101000))
            self.assertEqual(trade["exit_reason"], "target")
            self.assertNotIn("stop_exit", trade)

    def test_simulator_default_equals_the_explicit_legacy_policy(self):
        from test_futures_spec_strategy import _random_walk
        from balancita_engine.futures_spec_strategy import load_specs
        ones, fives = _random_walk(random.Random(5), 900)
        spec = next(iter(load_specs().values()))
        a = simulate(spec, ones, fives)
        b = simulate(spec, ones, fives, stop_policy="level")
        self.assertEqual(a.trades, b.trades)
        self.assertEqual(a.decisions, b.decisions)

    def test_an_unknown_policy_is_refused(self):
        with self.assertRaises(ValueError):
            Book({"id": "x"}, stop_policy="optimistic")

    def test_planned_and_realized_loss_decompose_exactly(self):
        rows = planned_vs_realized(gap_portfolio(LONG))
        row = rows[0]
        self.assertAlmostEqual(float(row["excess_usd"]), float(row["price_effect_usd"]) + float(row["fee_effect_usd"])
                               + float(row["funding_usd"]), places=3)


class QuoteWatching(unittest.TestCase):
    def setUp(self):
        self.pf = S.new_portfolio()
        self.watch = QuoteWatch(self.pf, WatchPolicy())
        S.open_timed(self.pf, S.BTC, LONG, S.ENTRY)

    def test_a_breach_inside_the_entry_minute_closes_at_the_quote_not_at_the_next_candle(self):
        self.assertEqual(self.watch.on_quote(S.quote(S.BTC, S.NOON + 15_000, 99800)), [])
        [trade] = self.watch.on_quote(S.quote(S.BTC, S.NOON + 25_000, 97800))
        self.assertEqual(trade["exit_time_ms"], S.NOON + 25_000)
        self.assertEqual(trade["entry_time_ms"], S.ENTRY)                        # funding and holding time start at the real entry
        self.assertTrue(trade["stop_exit"]["quote_backed"])
        self.assertFalse(trade["stop_exit"]["estimated"])
        self.assertEqual(trade["stop_exit"]["evidence"], "quote_breach")
        self.assertEqual(exit_basis(trade), "quote_backed")
        self.assertEqual(trade["stop_exit"]["quote_time_ms"], S.NOON + 25_000)
        self.assertEqual(self.pf.positions, {})
        self.assertEqual(rules(self.pf), [])

    def test_the_price_is_never_better_than_the_visible_touch_the_model_or_the_plan(self):
        [trade] = self.watch.on_quote(S.quote(S.BTC, S.NOON + 25_000, 97800, half_bps="30"))
        bid = D("97800") * (1 - D("30") / D(10_000))
        self.assertLessEqual(D(trade["exit_price"]), bid)
        self.assertLessEqual(D(trade["exit_price"]), exit_fill(D("97800"), LONG, S.BTC, "stop"))
        self.assertLessEqual(D(trade["exit_price"]), exit_fill(D(trade["stop_price"]), LONG, S.BTC, "stop"))
        self.assertGreater(D(str(-trade["pnl_usd"])), D(str(trade["planned_loss_usd"])) - D("0.001"))

    def test_a_short_is_watched_on_the_ask(self):
        pf = S.new_portfolio()
        watch = QuoteWatch(pf, WatchPolicy())
        S.open_timed(pf, S.BTC, SHORT, S.ENTRY)
        self.assertEqual(watch.on_quote(S.quote(S.BTC, S.NOON + 15_000, 100200)), [])
        [trade] = watch.on_quote(S.quote(S.BTC, S.NOON + 25_000, 102200))
        self.assertGreaterEqual(D(trade["exit_price"]), D("102200") * (1 + D("0.5") / D(10_000)))
        self.assertEqual(trade["side"], SHORT)
        self.assertEqual(rules(pf), [])

    def test_quotes_at_or_before_the_entry_are_never_used(self):
        for t in (S.ENTRY - 5_000, S.ENTRY):
            self.assertEqual(self.watch.on_quote(S.quote(S.BTC, t, 97000)), [])
        self.assertIn(S.BTC, self.pf.positions)
        self.assertEqual([e.get("reason") for e in self.watch.events], ["not_after_entry", "not_after_entry"])

    def test_the_same_movement_is_not_processed_twice(self):
        self.watch.on_quote(S.quote(S.BTC, S.NOON + 25_000, 97800))
        self.assertEqual(self.watch.on_quote(S.quote(S.BTC, S.NOON + 25_000, 97800)), [])
        self.assertEqual(len(self.pf.trades), 1)
        self.assertEqual(len(self.pf.capital_log), 1)

    def test_a_quote_that_goes_back_in_time_is_ignored_and_does_not_reorder_anything(self):
        self.watch.on_quote(S.quote(S.BTC, S.NOON + 30_000, 99900))
        self.assertEqual(self.watch.on_quote(S.quote(S.BTC, S.NOON + 20_000, 90000)), [])
        self.assertIn(S.BTC, self.pf.positions)

    def test_the_position_closed_by_a_quote_cannot_be_closed_again_by_a_candle(self):
        self.watch.on_quote(S.quote(S.BTC, S.NOON + 25_000, 97800))
        before = copy.deepcopy(self.pf.trades)
        self.assertEqual(self.watch.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 97700, 97900)), [])
        self.assertEqual(self.watch.on_candle(S.BTC, S.NOON + S.MIN, S.candle(97900, 98000, 97600, 97700)), [])
        self.assertEqual(self.pf.trades, before)

    def test_the_entry_minute_candle_never_evaluates_the_stop(self):
        flag = QuoteWatch(self.pf, WatchPolicy())
        flag.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 97700, 97900))
        self.assertIn(S.BTC, self.pf.positions)      # it held pre-entry prices: nothing closes on it

    def test_an_unwatched_window_touched_by_the_candle_is_flagged_not_silently_resolved(self):
        self.watch.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 97700, 97900))
        notes = self.pf.position_notes[next(iter(self.pf.position_notes))]
        self.assertEqual(notes["entry_window"]["coverage"], "unwatched")
        self.assertTrue(notes["entry_window"]["unresolved"])
        [trade] = self.watch.on_candle(S.BTC, S.NOON + S.MIN, S.candle(97900, 98050, 97800, 98000))
        self.assertEqual(self.pf.review_flags[trade["trade_id"]], ["entry_minute_unresolved"])
        self.assertTrue(trade["stop_exit"]["estimated"])

    def test_the_conservative_policy_closes_an_unresolved_window_at_the_stop_and_says_it_is_an_estimate(self):
        pf = S.new_portfolio()
        watch = QuoteWatch(pf, WatchPolicy(unresolved_entry_minute="stop"))
        S.open_timed(pf, S.BTC, LONG, S.ENTRY)
        [trade] = watch.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 97700, 97900))
        self.assertEqual(trade["stop_exit"]["evidence"], "assumed_stop_entry_minute")
        self.assertTrue(trade["stop_exit"]["estimated"])
        self.assertEqual(trade["exit_time_ms"], S.NOON + S.MIN)
        self.assertEqual(exit_basis(trade), "estimated_assumed_stop")
        self.assertAlmostEqual(float(-D(str(trade["pnl_usd"]))), float(trade["planned_loss_usd"]), places=3)
        self.assertEqual(rules(pf), [])

    def test_dense_quotes_resolve_the_window_and_a_touching_candle_is_not_flagged(self):
        for k in range(1, 10):
            self.watch.on_quote(S.quote(S.BTC, S.ENTRY + k * 5_000, 99900))
        self.watch.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 97700, 97900))
        notes = next(iter(self.pf.position_notes.values()))
        self.assertEqual(notes["entry_window"]["coverage"], "watched")
        self.assertFalse(notes["entry_window"]["unresolved"])
        self.assertNotIn("entry_minute_unresolved", notes)

    def test_few_quotes_mean_partial_coverage(self):
        self.watch.on_quote(S.quote(S.BTC, S.NOON + 12_000, 99900))
        self.watch.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 97700, 97900))
        notes = next(iter(self.pf.position_notes.values()))
        self.assertEqual(notes["entry_window"]["coverage"], "partially_watched")
        self.assertEqual(notes["entry_window"]["max_gap_ms"], 48_000)

    def test_a_quote_from_a_minute_a_candle_already_covered_is_ignored(self):
        self.watch.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 99800, 99900))
        self.assertEqual(self.watch.on_quote(S.quote(S.BTC, S.NOON + 50_000, 90000)), [])
        self.assertEqual(self.watch.events[-1]["reason"], "covered_by_candle")

    def test_candles_still_close_positions_between_quotes(self):
        self.watch.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 99800, 99900))
        [trade] = self.watch.on_candle(S.BTC, S.NOON + S.MIN, S.candle(99900, 99950, 97800, 98000))
        self.assertEqual(trade["exit_reason"], "stop")
        self.assertNotIn("quote_breach", str(trade["stop_exit"]["evidence"]))

    def test_invalid_quotes_are_ignored(self):
        for bad in ({"product_id": S.BTC, "time_ms": S.NOON + 20_000, "bid": "100", "ask": "99"},
                    {"product_id": S.BTC, "time_ms": S.NOON + 21_000, "bid": "-1", "ask": "1"}, {}, {"bid": "x"}):
            self.assertEqual(self.watch.on_quote(bad), [])
        self.assertIn(S.BTC, self.pf.positions)
        with self.assertRaises(ValueError):
            parse_quote({"product_id": S.BTC, "time_ms": 1, "bid": "2", "ask": "1"})

    def test_a_position_not_opened_with_an_entry_instant_is_not_quote_watched(self):
        pf = S.new_portfolio()
        watch = QuoteWatch(pf, WatchPolicy())
        pf.decide([S.intent(S.BTC, LONG, S.T10)], S.T10)
        self.assertEqual(watch.on_quote(S.quote(S.BTC, S.T10 + 5_000, 90000)), [])
        self.assertIn(S.BTC, pf.positions)

    def test_policy_is_validated(self):
        with self.assertRaises(ValueError):
            WatchPolicy(unresolved_entry_minute="ignore")


class Reconstruction(unittest.TestCase):
    def test_every_required_field_can_be_rebuilt(self):
        pf = gap_portfolio(LONG)
        r = trade_reconstruction(pf, pf.trades[0])
        self.assertEqual(r["entry"]["price"], pf.trades[0]["entry_price"])
        for key in ("time_ms", "price", "reference_price", "cost_usd"):
            self.assertIn(key, r["entry"])
        self.assertEqual(set(r["levels"]), {"stop", "target"})
        self.assertEqual(r["exit"]["reason"], "stop")
        self.assertIn("planned_loss_usd", r["plan"])
        for key in ("realized_loss_usd", "pnl_gross_usd", "fees_usd", "funding_usd", "funding_status", "pnl_net_usd",
                    "modelled_spread_bps", "modelled_impact_bps"):
            self.assertIn(key, r["result"], key)
        self.assertEqual(D(r["capital"]["before_usd"]), D("1000"))
        self.assertEqual(D(r["capital"]["after_usd"]), pf.capital_usd())
        self.assertEqual(r["adjustments"], [])

    def test_gross_minus_costs_identity_closes_with_the_recorded_references(self):
        pf = gap_portfolio(LONG)
        r = trade_reconstruction(pf, pf.trades[0])
        q = D(pf.trades[0]["quantity"])
        at_references = (D(r["exit"]["reference_price"]) - D(r["entry"]["reference_price"])) * q
        self.assertAlmostEqual(float(at_references - D(r["entry"]["cost_usd"]) - D(r["exit"]["cost_usd"])),
                               float(r["result"]["pnl_gross_usd"]), places=6)

    def test_reconciliation_history_appears_in_the_reconstruction(self):
        pf = funded_portfolio()
        for trade in pf.trades:
            r = trade_reconstruction(pf, trade)
            self.assertTrue(r["adjustments"])
            self.assertFalse(r["as_closed"]["net_complete"])
            self.assertTrue(r["result"]["net_complete"])
            self.assertEqual(len(r["capital"]["events"]), 1 + len(r["adjustments"]))


class LossesBeyondThePlan(unittest.TestCase):
    def test_a_loss_of_15_against_a_plan_of_10_is_booked_whole_and_feeds_the_next_budget(self):
        f = S.loss_beyond_plan()["facts"]
        self.assertAlmostEqual(float(f["planned_loss_usd"]), 10.0, places=2)
        self.assertAlmostEqual(float(f["realized_loss_usd"]), 15.0, places=1)
        self.assertEqual(D(f["after_loss"]["capital"]), D("1000") - D(f["realized_loss_usd"]))
        self.assertEqual(D(f["after_loss"]["risk_budget"]), D(f["after_loss"]["capital"]) * D("0.01"))
        self.assertEqual(D(f["after_loss"]["drawdown"]), D(f["realized_loss_usd"]))
        nxt = f["next_trade"]
        self.assertEqual(D(nxt["risk_budget_used_usd"]), D(f["after_loss"]["capital"]) * D("0.01"))
        self.assertEqual(D(nxt["capital_definitive_usd"]), D(f["after_loss"]["capital"]))
        self.assertLessEqual(D(nxt["planned_loss_usd"]), D("20") - D(f["realized_loss_usd"]) + D("0.0001"))  # daily room
        self.assertIn("daily_loss_budget", nxt["limits_applied"])

    def test_the_loss_is_not_reduced_to_fit_the_plan(self):
        pf = gap_portfolio(LONG)
        t = pf.trades[0]
        self.assertGreater(-D(str(t["pnl_usd"])), D(str(t["planned_loss_usd"])) * D("1.4"))
        self.assertEqual(rules(pf), [])

    def test_daily_loss_beyond_the_limit_suspends_entries_but_not_closes(self):
        f = S.daily_loss_suspension()["facts"]
        self.assertGreater(D(f["first_loss"]["realized"]), D("20"))
        self.assertTrue(f["suspension_after_gap"]["daily_loss"])
        self.assertFalse(f["suspension_after_gap"]["drawdown"])
        self.assertEqual(f["rejected_while_suspended"], ["suspended_daily_loss"])
        self.assertEqual(f["close_while_suspended"], "stop")            # the other position was still managed and closed
        self.assertAlmostEqual(float(f["second_loss"]["realized"]), 10.0, places=2)
        self.assertLess(D(f["realized_today_usd_at_suspension"]), D("-30"))   # losses after the suspension still count
        self.assertEqual(f["rejected_again"], ["suspended_daily_loss"])
        self.assertEqual(f["next_utc_day"], "opened")                        # the daily suspension is a UTC-day rule

    def test_drawdown_suspension_comes_from_losses_each_below_the_daily_limit(self):
        f = S.drawdown_suspension()["facts"]
        self.assertTrue(all(D(d["realized"]) < D("20") for d in f["days"]))
        self.assertEqual([d["suspension"]["drawdown"] for d in f["days"]], [False, False, False, True])
        self.assertTrue(all(not d["suspension"]["daily_loss"] for d in f["days"]))
        self.assertGreaterEqual(D(f["days"][-1]["drawdown"]), D("60"))
        self.assertLess(D(f["days"][-2]["drawdown"]), D("60"))
        self.assertEqual(f["rejected"], ["suspended_drawdown"])
        planned = [D(str(d["planned"])) for d in f["days"]]
        self.assertTrue(all(a > b for a, b in zip(planned, planned[1:])))   # the budget shrinks with the capital

    def test_a_suspension_never_blocks_reconciliation_or_accounting(self):
        pf = S.new_portfolio(funding={S.BTC: S.hourly(S.T8 - S.HOUR, 2), S.ETH: []})
        S._provisional_trades(pf)
        # push the account into the daily-loss suspension, then reconcile
        pf.decide([S.intent(S.SOL, LONG, S.T8 + 3 * S.HOUR + 10 * S.MIN)], S.T8 + 3 * S.HOUR + 10 * S.MIN)
        [t] = pf.on_candle(S.SOL, S.T8 + 3 * S.HOUR + 10 * S.MIN, S.candle(170, 171, 150, 152))
        self.assertTrue(pf.suspension_state(S.T8 + 3 * S.HOUR + 12 * S.MIN)["daily_loss"])
        ingest_funding(pf, S.ETH, S.hourly(S.T8 - S.HOUR, 3), received_ms=S.T8 + 4 * S.HOUR)
        made = reconcile_funding(pf, S.T8 + 4 * S.HOUR)
        self.assertEqual(len(made), 1)
        self.assertEqual(rules(pf), [])

    def test_a_quote_watched_position_still_closes_while_the_account_is_suspended(self):
        pf = S.new_portfolio()
        watch = QuoteWatch(pf, WatchPolicy())
        eth = dict(S.intent(S.ETH, LONG, S.T10, strategy="e"), entry_bucket_ms=S.T10, entry_ms=S.T10 + 10_000)
        records = pf.decide([S.intent(S.BTC, LONG, S.T10), eth], S.T10 + 10_000)
        self.assertEqual([r["status"] for r in records], ["opened", "opened"])
        pf.on_candle(S.BTC, S.T10, S.candle(100000, 100100, 98200, 98200))
        pf.on_candle(S.BTC, S.T10 + S.MIN, S.candle(95700, 95900, 95500, 95800))
        self.assertTrue(pf.suspension_state(S.T10 + 2 * S.MIN)["daily_loss"])
        self.assertEqual(watch.on_quote(S.quote(S.ETH, S.T10 + 2 * S.MIN, 3480)), [])
        [trade] = watch.on_quote(S.quote(S.ETH, S.T10 + 3 * S.MIN, 3300))
        self.assertEqual((trade["product_id"], trade["exit_reason"]), (S.ETH, "stop"))
        self.assertTrue(trade["stop_exit"]["quote_backed"])
        self.assertEqual(pf.positions, {})
        self.assertEqual(rules(pf), [])

    def test_entries_are_rejected_by_the_portfolio_with_the_reason_and_nothing_else_changes(self):
        pf = gap_portfolio(LONG)
        pf.decide([S.intent(S.ETH, LONG, S.T10 + 2 * S.MIN, strategy="e")], S.T10 + 2 * S.MIN)
        pf.on_candle(S.ETH, S.T10 + 2 * S.MIN, S.candle(3500, 3510, 3440, 3450))
        [t] = pf.on_candle(S.ETH, S.T10 + 3 * S.MIN, S.candle(3300, 3310, 3290, 3300))
        self.assertTrue(pf.suspension_state(S.T10 + 5 * S.MIN)["daily_loss"])
        digest = accounting_digest(pf)
        [rec] = pf.decide([S.intent(S.SOL, LONG, S.T10 + 5 * S.MIN, strategy="s")], S.T10 + 5 * S.MIN)
        self.assertEqual((rec["status"], rec["reasons"]), ("rejected", ["suspended_daily_loss"]))
        self.assertEqual(len(pf.positions), 0)
        self.assertEqual(len(pf.trades), 2)
        self.assertNotEqual(digest, accounting_digest(pf))   # only the new rejected decision was added
        self.assertEqual(rules(pf), [])


class LateFunding(unittest.TestCase):
    def test_partial_then_complete_coverage_with_an_explicit_transition(self):
        f = S.funding_late_complete()["facts"]
        self.assertEqual((f["gain_status"], f["loss_status"]), ("partial", "unknown"))
        first, second = f["first_reconciliation"], f["second_reconciliation"]
        self.assertEqual([a["transition"] for a in first], ["provisional_more_covered"])
        self.assertEqual([a["transition"] for a in second], ["provisional_to_definitive", "provisional_to_definitive"])
        self.assertEqual(first[0]["delta_capital_usd"], "0")                  # a provisional gain never moves the capital
        stages = {s["stage"]: s for s in f["stages"]}
        self.assertGreater(D(stages["cerradas_con_funding_incompleto"]["provisional_gains_usd"]), 0)
        self.assertEqual(D(stages["btc_y_eth_completos"]["provisional_gains_usd"]), 0)
        self.assertEqual(stages["cerradas_con_funding_incompleto"]["capital_usd"], stages["btc_cobertura_parcial"]["capital_usd"])

    def test_the_provisional_loss_counts_from_the_start_and_the_gain_only_when_verified(self):
        pf = S._funding_portfolio()
        gain, loss = S._provisional_trades(pf)
        self.assertEqual(pf.capital_usd(), D("1000") + D(str(loss["pnl_usd"])))        # the loss is in, the gain is not
        self.assertGreater(pf.provisional_gains_usd(), 0)
        self.assertEqual(pf.equity_usd(), D("1000") + D(str(loss["pnl_usd"])) + D(str(gain["pnl_usd"])))
        self.assertFalse(gain["net_complete"] or loss["net_complete"])

    def test_the_net_result_is_recomputed_from_the_periods_and_matches_an_independent_calculation(self):
        pf = funded_portfolio()
        for trade in pf.trades:
            q, entry = D(trade["quantity"]), D(trade["entry_price"])
            hours = D(trade["exit_time_ms"] - trade["entry_time_ms"]) / D(S.HOUR)
            funding = q * entry * D(S.FR) * hours                       # a flat rate: a LONG pays it
            gross = (D(trade["exit_price"]) - entry) * q
            fees = (entry + D(trade["exit_price"])) * q * D("0.0005")
            self.assertAlmostEqual(float(D(str(trade["pnl_usd"]))), float(gross - fees - funding), places=3)
            self.assertAlmostEqual(float(D(str(trade["funding_usd"]))), float(funding), places=4)
            self.assertTrue(trade["net_complete"])

    def test_capital_budget_and_drawdown_follow_the_adjustments(self):
        pf = funded_portfolio()
        self.assertEqual(rules(pf), [])
        last = pf.adjustments[-1]
        self.assertEqual(D(last["capital_after_usd"]), pf.capital_usd())
        self.assertEqual(D(last["risk_budget_after_usd"]), pf.risk_budget_usd())
        self.assertEqual(D(last["drawdown_after_usd"]), pf.drawdown_usd())
        # the capital log tells the same story: initial + every delta
        self.assertEqual(D("1000") + sum((D(e["delta_usd"]) for e in pf.capital_log), D(0)), pf.capital_usd())

    def test_history_keeps_the_closing_and_every_change(self):
        pf = funded_portfolio()
        for trade in pf.trades:
            original = pf.trade_details[trade["trade_id"]]["as_closed"]
            self.assertFalse(original["net_complete"])
            chain = [a for a in pf.adjustments if a["trade_id"] == trade["trade_id"]]
            self.assertEqual(chain[0]["before"], original)
            self.assertEqual(chain[-1]["after"], {k: trade[k] for k in pf.CLOSED_FIELDS})

    def test_decisions_already_taken_are_listed_and_not_revised(self):
        pf = funded_portfolio()
        [later] = [d for d in pf.decisions if d["status"] == "opened" and d["product_id"] == S.SOL]
        capital_at_decision = later["capital_definitive_usd"]
        self.assertTrue(any(later["decision_id"] in a["decisions_not_revised"] for a in pf.adjustments))
        self.assertEqual(later["capital_definitive_usd"], capital_at_decision)
        self.assertNotEqual(D(capital_at_decision), pf.capital_usd())          # sized with the provisional capital: kept so
        self.assertEqual(pf.positions[S.SOL].planned_loss_usd, D(later["planned_loss_usd"]))

    def test_repeating_the_reconciliation_changes_nothing(self):
        pf = funded_portfolio()
        digest, log = accounting_digest(pf), list(pf.adjustments)
        for _ in range(3):
            self.assertEqual(reconcile_funding(pf, S.T8 + 6 * S.HOUR), [])
        self.assertEqual(accounting_digest(pf), digest)
        self.assertEqual(pf.adjustments, log)

    def test_funding_received_twice_is_applied_once(self):
        f = S.funding_received_twice()["facts"]
        self.assertEqual(f["first"]["accepted"], 3)
        self.assertEqual((f["second"]["accepted"], f["second"]["duplicate"]), (0, 3))
        self.assertEqual(f["duplicated_inside_one_batch"]["accepted"], 0)
        self.assertEqual((f["adjustments_made"], f["adjustments_on_repetition"]), (1, 0))
        self.assertEqual(f["funding_applied_usd"], f["expected_single_funding_usd"])
        self.assertTrue(f["digest_unchanged_by_repetition"])

    def test_the_intake_log_records_every_delivery_even_when_the_result_is_unchanged(self):
        pf = funded_portfolio()
        digest, intake = accounting_digest(pf), intake_digest(pf)
        ingest_funding(pf, S.BTC, S.hourly(S.T8 + S.HOUR, 3), received_ms=S.T8 + 5 * S.HOUR)
        self.assertEqual(accounting_digest(pf), digest)
        self.assertNotEqual(intake_digest(pf), intake)
        self.assertEqual(rules(pf), [])

    def test_contradictory_funding_is_quarantined_and_applied_nowhere(self):
        r = S.funding_contradictory()
        f = r["facts"]
        self.assertEqual(f["two_versions_same_hour"], {"accepted": 0, "duplicate": 0, "conflict": 2, "rejected": 0})
        self.assertEqual((f["adjustments_after_versions"], f["adjustments_after_later"], f["adjustments_after_correction"]), (0, 0, 0))
        self.assertEqual(f["capital_before_correction"], f["capital_after_correction"])
        self.assertEqual(f["later_delivery"]["conflict"], 1)                  # a third version cannot break the tie
        self.assertEqual(f["correction_of_accepted"]["conflict"], 1)
        self.assertEqual(r["summary"]["adjustments"], 0)
        self.assertEqual(sorted({tuple(v) for v in f["review_flags"].values()}), [("funding_conflict",)])
        self.assertEqual(r["summary"]["audit"]["violations"], [])

    def test_the_outcome_does_not_depend_on_the_order_of_a_contradictory_batch(self):
        outcomes = []
        for batch in ([(S.T8, S.T8 + S.HOUR, "0.002"), (S.T8, S.T8 + S.HOUR, "0.004")],
                      [(S.T8, S.T8 + S.HOUR, "0.004"), (S.T8, S.T8 + S.HOUR, "0.002")]):
            pf = S._funding_portfolio()
            S._provisional_trades(pf)
            ingest_funding(pf, S.ETH, batch, received_ms=S.T8 + 4 * S.HOUR)
            outcomes.append((accounting_digest(pf), intake_digest(pf), pf.funding.get(S.ETH)))
        self.assertEqual(outcomes[0], outcomes[1])
        self.assertEqual(outcomes[0][2], [])

    def test_periods_that_are_not_settled_or_malformed_are_rejected(self):
        pf = S._funding_portfolio()
        counts = ingest_funding(pf, S.ETH, [(S.T8, S.T8 + S.HOUR, "0.001"), (S.T8, S.T8, "0"), ("x", 1, 2), (1, 2, "nan")],
                                received_ms=S.T8 + 30 * S.MIN)
        self.assertEqual(counts, {"accepted": 0, "duplicate": 0, "conflict": 0, "rejected": 4})
        self.assertEqual(pf.funding[S.ETH], [])

    def test_the_covered_time_never_regresses_and_new_periods_alone_trigger_an_adjustment(self):
        pf = S._funding_portfolio()
        S._provisional_trades(pf)
        self.assertEqual(reconcile_funding(pf, S.T8 + 4 * S.HOUR), [])          # nothing new yet
        ingest_funding(pf, S.ETH, S.hourly(S.T8 - S.HOUR, 1), received_ms=S.T8 + 4 * S.HOUR)   # outside the holding time
        self.assertEqual(reconcile_funding(pf, S.T8 + 4 * S.HOUR), [])

    def test_a_trade_is_not_reconciled_before_it_closed(self):
        pf = S._funding_portfolio()
        S._provisional_trades(pf)
        ingest_funding(pf, S.BTC, S.hourly(S.T8 + S.HOUR, 3), received_ms=S.T8 + 4 * S.HOUR)
        self.assertEqual(reconcile_funding(pf, S.T8 + 2 * S.HOUR), [])           # the BTC trade closes at T8 + 3 h

    def test_open_positions_receive_late_funding_known_before_they_close(self):
        pf = S._funding_portfolio()
        pf.decide([S.intent(S.BTC, LONG, S.T8, target_pct="0.01")], S.T8)
        ingest_funding(pf, S.BTC, S.hourly(S.T8 + S.HOUR, 3), received_ms=S.T8 + 4 * S.HOUR)
        [trade] = pf.on_candle(S.BTC, S.T8 + 3 * S.HOUR, S.candle(100500, 101500, 100400, 101200))
        self.assertTrue(trade["funding_complete"])
        self.assertTrue(trade["net_complete"])
        self.assertEqual(pf.adjustments, [])

    def test_a_product_without_a_measured_cost_row_never_becomes_definitive(self):
        pf = S.new_portfolio(funding={"PF_NOSUCH": []})
        pf.funding["PF_NOSUCH"] = []
        # the portfolio rejects unmeasured products at the door, so the rule is exercised on the closed-trade record
        [rec] = pf.decide([S.intent("PF_NOSUCH", LONG, S.T10, price="10")], S.T10)
        self.assertEqual(rec["status"], "rejected")
        self.assertIn("cost_data_missing", rec["reasons"])

    def test_reconciliation_survives_a_restart_before_and_after(self):
        f = S.restart_around_reconciliation()["facts"]
        self.assertTrue(f["equal_before"])
        self.assertTrue(f["equal_after"])
        self.assertEqual(f["adjustments_on_repetition"], 0)
        self.assertEqual(f["checkpoint_before_reconciliation_still_provisional"], 2)

    def test_restart_in_the_middle_of_a_partial_reconciliation(self):
        a = S._funding_portfolio()
        S._provisional_trades(a)
        ingest_funding(a, S.BTC, S.hourly(S.T8 + S.HOUR, 1), received_ms=S.T8 + 3 * S.HOUR + 5 * S.MIN)
        reconcile_funding(a, S.T8 + 3 * S.HOUR + 5 * S.MIN)
        b = pickle.loads(pickle.dumps(a, protocol=4))
        for pf in (a, b):
            ingest_funding(pf, S.BTC, S.hourly(S.T8 + 2 * S.HOUR, 2), received_ms=S.T8 + 4 * S.HOUR + 5 * S.MIN)
            reconcile_funding(pf, S.T8 + 4 * S.HOUR + 5 * S.MIN)
        self.assertEqual(accounting_digest(a), accounting_digest(b))
        self.assertEqual(a.adjustments, b.adjustments)


class IndependentValidators(unittest.TestCase):
    """Each test plants one accounting error and expects the matching rule to fire; clean books fire nothing."""

    def test_clean_books_pass(self):
        for pf in (gap_portfolio(LONG), gap_portfolio(SHORT), funded_portfolio()):
            self.assertEqual(audit(pf)["violations"], [])

    def test_pnl_that_does_not_close_the_identity(self):
        pf = gap_portfolio()
        pf.trades[0]["pnl_usd"] = pf.trades[0]["pnl_usd"] + 1.0
        self.assertIn("trade_identity", rules(pf))

    def test_fees_charged_twice(self):
        pf = gap_portfolio()
        pf.trades[0]["fees_usd"] = pf.trades[0]["fees_usd"] * 2
        self.assertIn("trade_identity", rules(pf))

    def test_funding_applied_twice(self):
        pf = funded_portfolio()
        trade = pf.trades[0]
        trade["funding_usd"] = trade["funding_usd"] * 2
        found = rules(pf)
        self.assertIn("trade_identity", found)
        self.assertIn("funding_recount", found)

    def test_entry_price_that_is_not_the_modelled_fill(self):
        pf = gap_portfolio()
        pf.trades[0]["entry_price"] = str(D(pf.trades[0]["entry_price"]) - 50)
        self.assertIn("entry_price_model", rules(pf))

    def test_a_stop_exit_better_than_the_plan_is_caught(self):
        pf = gap_portfolio()
        t = pf.trades[0]
        better = D(t["stop_price"]) + 10                          # an exit above the stop for a LONG: the loss was trimmed
        t["exit_price"] = str(better)
        found = rules(pf)
        self.assertIn("exit_not_better_than_plan", found)

    def test_a_loss_trimmed_to_the_budget_is_caught(self):
        pf = gap_portfolio()
        t = pf.trades[0]
        t["pnl_usd"] = -float(t["planned_loss_usd"])               # booked as if the stop had held
        found = rules(pf)
        self.assertIn("trade_identity", found)

    def test_capital_log_with_a_missing_event(self):
        pf = funded_portfolio()
        del pf.capital_log[1]
        found = rules(pf)
        self.assertTrue({"capital_log_chain", "capital_log_sum"} & set(found), found)

    def test_a_capital_event_edited_in_place(self):
        pf = gap_portfolio()
        pf.capital_log[0]["delta_usd"] = "-1"
        self.assertIn("capital_log_chain", rules(pf))

    def test_capital_counted_twice(self):
        pf = gap_portfolio()
        pf.append_capital_event("trade_closed", pf.trades[0]["exit_time_ms"], pf.trades[0]["trade_id"], D("0"))
        found = rules(pf)
        self.assertIn("duplicate_capital_event", found)

    def test_provisional_gain_counted_in_the_capital(self):
        pf = S._funding_portfolio()
        gain, _ = S._provisional_trades(pf)
        gain["net_complete"], gain["net_usd"] = True, gain["pnl_usd"]       # promoted without a reconciliation
        found = rules(pf)
        self.assertTrue({"capital_events_per_trade", "capital_recomputed", "transition_not_explicit"} & set(found), found)

    def test_completion_without_the_full_coverage(self):
        pf = S._funding_portfolio()
        gain, _ = S._provisional_trades(pf)
        gain["funding_complete"] = True
        self.assertIn("complete_without_full_coverage", rules(pf))

    def test_a_reconciled_trade_edited_afterwards(self):
        pf = funded_portfolio()
        pf.trades[0]["pnl_usd"] += 5
        found = rules(pf)
        self.assertTrue({"adjustment_end_state", "trade_identity"} <= set(found), found)

    def test_a_forged_adjustment_breaks_the_chain(self):
        pf = funded_portfolio()
        pf.adjustments[0]["delta_capital_usd"] = "123"
        self.assertIn("adjustment_chain", rules(pf))

    def test_an_adjustment_that_does_not_start_from_the_closing(self):
        pf = funded_portfolio()
        pf.trade_details[pf.adjustments[0]["trade_id"]]["as_closed"]["pnl_usd"] = 99.0
        self.assertIn("adjustment_chain_state", rules(pf))

    def test_completeness_changed_without_a_recorded_transition(self):
        pf = funded_portfolio()
        a = pf.adjustments[-1]
        a["transition"] = "provisional_more_covered"
        a["hash"] = None
        found = rules(pf)
        self.assertTrue({"transition_not_explicit", "adjustment_chain"} <= set(found), found)

    def test_a_trade_changed_without_an_adjustment(self):
        pf = funded_portfolio()
        trade = pf.trades[0]
        pf.adjustments = [a for a in pf.adjustments if a["trade_id"] != trade["trade_id"]]
        self.assertIn("trade_changed_without_adjustment", rules(pf))

    def test_funding_log_tampering(self):
        pf = funded_portfolio()
        pf.funding_log[0]["period"] = [1, 2, "3"]
        self.assertIn("funding_log_chain", rules(pf))

    def test_funding_periods_removed_after_the_fact(self):
        pf = funded_portfolio()
        pf.funding[S.BTC] = pf.funding[S.BTC][:1]
        self.assertIn("funding_covers_more_than_accepted", rules(pf))

    def test_an_entry_opened_while_suspended(self):
        pf = gap_portfolio()
        pf.decide([S.intent(S.ETH, LONG, S.T10 + 2 * S.MIN, strategy="e")], S.T10 + 2 * S.MIN)
        pf.on_candle(S.ETH, S.T10 + 2 * S.MIN, S.candle(3500, 3510, 3440, 3450))
        pf.on_candle(S.ETH, S.T10 + 3 * S.MIN, S.candle(3300, 3310, 3290, 3300))
        forged = copy.deepcopy(pf.decisions[0])
        forged.update(decided_ms=S.T10 + 5 * S.MIN, decision_id="forged")
        pf.decisions.append(forged)
        self.assertIn("no_entry_while_suspended", rules(pf))

    def test_a_risk_budget_that_is_not_one_percent_of_the_capital(self):
        pf = gap_portfolio()
        pf.decisions[0]["risk_budget_used_usd"] = "25"
        self.assertIn("risk_budget_recomputed", rules(pf))

    def test_a_planned_loss_above_the_budget(self):
        pf = gap_portfolio()
        pf.decisions[0]["planned_loss_usd"] = "11"
        self.assertIn("planned_loss_within_budget", rules(pf))

    def test_a_quote_backed_exit_that_used_a_quote_from_before_the_entry(self):
        pf = S.new_portfolio()
        watch = QuoteWatch(pf, WatchPolicy())
        S.open_timed(pf, S.BTC, LONG, S.ENTRY)
        [trade] = watch.on_quote(S.quote(S.BTC, S.NOON + 25_000, 97800))
        trade["stop_exit"]["quote_time_ms"] = S.ENTRY - 1
        self.assertIn("quote_before_entry", rules(pf))

    def test_an_estimate_presented_as_a_fact(self):
        pf = gap_portfolio()
        pf.trades[0]["stop_exit"]["estimated"] = False
        self.assertIn("stop_exit_fields", rules(pf))

    def test_slippage_that_disagrees_with_the_prices(self):
        pf = gap_portfolio()
        pf.trades[0]["stop_exit"]["slippage_bps"] = "1"
        self.assertIn("stop_exit_fields", rules(pf))

    def test_a_duplicated_trade(self):
        pf = gap_portfolio()
        pf.trades.append(copy.deepcopy(pf.trades[0]))
        self.assertIn("duplicate_trade", rules(pf))

    def test_exit_before_entry(self):
        pf = gap_portfolio()
        pf.trades[0]["exit_time_ms"] = pf.trades[0]["entry_time_ms"] - 1
        self.assertIn("exit_before_entry", rules(pf))


class AgainstTheStage6Scenarios(unittest.TestCase):
    """The validators and the reconciliation on the books of the earlier validation scenarios (no false positives)."""

    def test_the_validators_find_nothing_wrong_in_the_stage_6_scenarios(self):
        from balancita_engine import portfolio_scenarios as PS
        from balancita_engine.portfolio_offline import run_scenario
        for scenario in PS.all_scenarios():
            portfolio = run_scenario(scenario)["executor"].portfolio
            found = audit(portfolio)
            self.assertEqual(found["violations"], [], scenario["name"])
            self.assertGreater(found["checks"], 0)

    def test_incomplete_funding_of_the_stage_6_scenario_completes_late_without_breaking_an_identity(self):
        from balancita_engine import portfolio_scenarios as PS
        from balancita_engine.portfolio_offline import run_scenario
        pf = run_scenario(PS.s4_incomplete_funding())["executor"].portfolio
        incomplete = [t for t in pf.trades if not t["net_complete"]]
        self.assertGreaterEqual(len(incomplete), 2)
        capital, gains = pf.capital_usd(), pf.provisional_gains_usd()
        self.assertGreater(gains, 0)
        end = max(t["exit_time_ms"] for t in pf.trades) + 12 * S.HOUR
        for product in sorted({t["product_id"] for t in incomplete}):
            last = max((p[1] for p in pf.funding.get(product, ())), default=min(t["entry_time_ms"] for t in pf.trades) - S.HOUR)
            ingest_funding(pf, product, [(last, last + 6 * S.HOUR, "0.00002")], received_ms=end)
        made = reconcile_funding(pf, end)
        self.assertEqual(len(made), len(incomplete))
        self.assertTrue(all(t["net_complete"] for t in pf.trades))
        self.assertEqual(pf.provisional_gains_usd(), 0)
        self.assertEqual(audit(pf)["violations"], [])
        self.assertEqual(reconcile_funding(pf, end + S.MIN), [])
        self.assertNotEqual(pf.capital_usd(), capital)


class DirtyEventStreams(unittest.TestCase):
    def test_duplicated_stale_early_and_out_of_order_events_leave_the_same_accounting(self):
        f = S.duplicates_and_disorder()["facts"]
        self.assertTrue(f["same_ledger_as_clean_run"])
        self.assertTrue(f["same_accounting_as_clean_run"])
        self.assertTrue(f["closed_once"])
        self.assertEqual(f["exit_evidence"], "quote_breach")
        for reason in ("duplicate_or_out_of_order_quote", "covered_by_candle", "invalid_quote",
                       "duplicate_entry_minute_candle_ignored"):
            self.assertIn(reason, f["ignored"])

    def test_a_duplicated_intent_does_not_open_a_second_position(self):
        pf = S.new_portfolio()
        i = S.intent(S.BTC, LONG, S.T10)
        pf.decide([i], S.T10)
        [again] = pf.decide([i], S.T10 + 1)
        self.assertIn("duplicate_intent", again["reasons"])
        self.assertEqual(len(pf.positions), 1)

    def test_a_candle_delivered_twice_is_refused_not_applied_twice(self):
        pf = S.new_portfolio()
        pf.decide([S.intent(S.BTC, LONG, S.T10)], S.T10)
        pf.on_candle(S.BTC, S.T10, S.candle(100000, 100100, 99900, 100000))
        with self.assertRaises(PortfolioError):
            pf.on_candle(S.BTC, S.T10, S.candle(100000, 100100, 99900, 100000))
        self.assertEqual(len(pf.trades), 0)


class TimedExecutorIntegration(unittest.TestCase):
    """The real entry path (signal log -> decision -> first executable quote) with quote watching switched on."""

    def setUp(self):
        from test_execution_timing import Env, CYCLE, PRODUCT, quote as tquote, roomy, FUNDING
        from balancita_engine.execution_timing import ExecutionPolicy, TimedExecutor
        self.Env, self.CYCLE, self.PRODUCT, self.tquote = Env, CYCLE, PRODUCT, tquote
        self.env = Env("setUp")
        self.env.setUp()
        self.addCleanup(self.env.doCleanups)
        self.TimedExecutor, self.ExecutionPolicy, self.roomy, self.FUNDING = TimedExecutor, ExecutionPolicy, roomy, FUNDING

    def executor(self, watch):
        return self.TimedExecutor(Portfolio(self.roomy(), funding=self.FUNDING, stop_policy="gap_open"),
                                  self.ExecutionPolicy(), watch=watch)

    def test_the_stop_is_watched_from_the_first_quote_after_the_entry(self):
        ex = self.executor(WatchPolicy())
        self.env.submit(ex, self.env.persist())
        [record] = ex.on_quote(self.tquote(self.CYCLE + 5_000, "100000", half_bps="0.01"))
        self.assertEqual(record["status"], "opened")
        self.assertEqual(ex.portfolio.positions[self.PRODUCT].position["entry_ms"], self.CYCLE + 5_000)
        self.assertEqual(ex.on_quote(self.tquote(self.CYCLE + 10_000, "99500")), [])
        ex.on_quote(self.tquote(self.CYCLE + 20_000, "97500"))
        [trade] = ex.portfolio.trades
        self.assertEqual(trade["exit_time_ms"], self.CYCLE + 20_000)
        self.assertEqual(trade["entry_time_ms"], self.CYCLE + 5_000)
        self.assertEqual(trade["stop_exit"]["evidence"], "quote_breach")
        self.assertEqual(audit(ex.portfolio)["violations"], [])
        # the candles of the entry minute and after find nothing to close
        self.assertEqual(ex.on_candle(self.PRODUCT, self.CYCLE, {"open": "100000", "high": "100010", "low": "97400", "close": "97600"}), [])
        self.assertEqual(len(ex.portfolio.trades), 1)

    def test_without_watching_the_stage_6_behaviour_is_unchanged(self):
        ex = self.TimedExecutor(Portfolio(self.roomy(), funding=self.FUNDING))
        self.env.submit(ex, self.env.persist())
        ex.on_quote(self.tquote(self.CYCLE + 5_000, "100000", half_bps="0.01"))
        self.assertIsNone(ex.watch)
        self.assertNotIn("entry_ms", ex.portfolio.positions[self.PRODUCT].position)
        ex.on_quote(self.tquote(self.CYCLE + 20_000, "90000"))
        self.assertEqual(ex.portfolio.trades, [])        # quotes alone never close a position when watching is off


class UnresolvedExecutionAndOpenDisputes(unittest.TestCase):
    def unresolved_gain(self, policy=None):
        pf = S.new_portfolio()
        watch = QuoteWatch(pf, policy or WatchPolicy())
        S.open_timed(pf, S.BTC, LONG, S.ENTRY)
        watch.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 97700, 97900))        # range below the stop, no quotes
        [trade] = watch.on_candle(S.BTC, S.NOON + S.MIN, S.candle(100500, 103500, 100400, 103200))
        return pf, trade

    def test_the_old_rule_would_have_made_the_uncertain_gain_definitive_capital(self):
        pf, trade = self.unresolved_gain()
        self.assertGreater(D(str(trade["pnl_usd"])), 0)
        self.assertTrue(trade["net_complete"])                        # funding is complete: a different dimension
        old_rule = D(str(trade["net_usd"])) if trade["net_complete"] else min(D(0), D(str(trade["pnl_usd"])))
        self.assertGreater(old_rule, 0)                                # what contribution() used to add to the capital
        self.assertEqual(pf.contribution(trade), 0)                    # what it adds now

    def test_the_simulated_result_is_untouched_and_only_the_usable_amount_is_held_back(self):
        pf, trade = self.unresolved_gain()
        self.assertTrue(trade["execution_unresolved"])
        self.assertEqual(pf.capital_usd(), D("1000"))
        self.assertEqual(pf.risk_budget_usd(), D("10"))
        self.assertEqual(pf.unresolved_execution_gains_usd(), D(str(trade["pnl_usd"])))
        self.assertEqual(pf.provisional_gains_usd(), pf.unresolved_execution_gains_usd())
        self.assertEqual(pf.equity_usd(), D("1000") + D(str(trade["pnl_usd"])))
        self.assertEqual(rules(pf), [])

    def test_an_unresolved_loss_is_still_booked_in_full(self):
        pf = S.new_portfolio()
        watch = QuoteWatch(pf, WatchPolicy())
        S.open_timed(pf, S.BTC, LONG, S.ENTRY)
        watch.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 97700, 97900))
        [trade] = watch.on_candle(S.BTC, S.NOON + S.MIN, S.candle(97900, 98050, 97800, 98000))
        self.assertLess(D(str(trade["pnl_usd"])), 0)
        self.assertEqual(pf.contribution(trade), D(str(trade["pnl_usd"])))
        self.assertEqual(pf.capital_usd(), D("1000") + D(str(trade["pnl_usd"])))

    def test_funding_completion_does_not_release_an_unresolved_execution_gain(self):
        pf = S.new_portfolio(funding={S.BTC: []})
        watch = QuoteWatch(pf, WatchPolicy())
        S.open_timed(pf, S.BTC, LONG, S.ENTRY)
        watch.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 97700, 97900))
        [trade] = watch.on_candle(S.BTC, S.NOON + S.MIN, S.candle(100500, 103500, 100400, 103200))
        self.assertFalse(trade["net_complete"])
        ingest_funding(pf, S.BTC, S.hourly(S.NOON - S.HOUR, 3, rate="0"), received_ms=S.NOON + 2 * S.HOUR)
        [adjustment] = reconcile_funding(pf, S.NOON + 2 * S.HOUR)
        self.assertEqual(adjustment["transition"], "provisional_to_definitive")    # the funding dimension is complete...
        self.assertTrue(trade["net_complete"])
        self.assertEqual(adjustment["delta_capital_usd"], "0")                       # ...the execution one is not
        self.assertEqual(pf.capital_usd(), D("1000"))
        self.assertEqual(rules(pf), [])

    def test_the_audit_lists_the_economically_unresolved_result(self):
        pf, trade = self.unresolved_gain()
        [warning] = [w for w in audit(pf)["warnings"] if w["rule"] == "economically_unresolved_execution"]
        self.assertEqual(warning["trade_id"], trade["trade_id"])
        self.assertEqual(warning["counted_in_capital_usd"], "0")

    def test_the_audit_catches_an_unresolved_gain_counted_as_capital(self):
        pf, trade = self.unresolved_gain()
        del trade["execution_unresolved"]                              # planted: the mark is lost, the gain would count
        self.assertIn("unresolved_execution_not_marked", rules(pf))
        trade["execution_unresolved"] = True
        pf.review_flags[trade["trade_id"]].remove("entry_minute_unresolved")
        self.assertIn("unresolved_execution_not_marked", rules(pf))

    def test_resolved_windows_keep_the_old_behaviour(self):
        pf = S.new_portfolio()
        watch = QuoteWatch(pf, WatchPolicy())
        S.open_timed(pf, S.BTC, LONG, S.ENTRY)
        for k in range(1, 10):
            watch.on_quote(S.quote(S.BTC, S.ENTRY + k * 5_000, 99900))
        watch.on_candle(S.BTC, S.NOON, S.candle(100000, 100050, 97700, 97900))
        [trade] = watch.on_candle(S.BTC, S.NOON + S.MIN, S.candle(100500, 103500, 100400, 103200))
        self.assertNotIn("execution_unresolved", trade)
        self.assertEqual(pf.contribution(trade), D(str(trade["net_usd"])))

    def test_a_dispute_that_arrives_while_the_position_is_open_survives_the_close(self):
        pf = S.new_portfolio(funding={S.BTC: S.hourly(S.T8 - S.HOUR, 3)})
        pf.decide([S.intent(S.BTC, LONG, S.T8, target_pct="0.01")], S.T8)
        pf.on_candle(S.BTC, S.T8, S.candle(100000, 100100, 99900, 100050))
        counts = ingest_funding(pf, S.BTC, [(S.T8, S.T8 + S.HOUR, "0.01")], received_ms=S.T8 + 2 * S.HOUR)
        self.assertEqual(counts["conflict"], 1)
        self.assertIn(S.BTC, pf.positions)
        self.assertEqual(pf.review_flags, {})                            # nothing closed yet: nothing to flag
        [trade] = pf.on_candle(S.BTC, S.T8 + 3 * S.HOUR, S.candle(100500, 101500, 100400, 101200))
        tid = trade["trade_id"]
        self.assertIn("funding_conflict", pf.review_flags[tid])
        self.assertEqual(pf.trade_details[tid]["notes"]["funding_conflict"], [[S.T8, S.T8 + S.HOUR, "0.01"]])
        # the accepted data keeps being the only data used; nothing is resolved or overwritten
        self.assertEqual(pf.funding[S.BTC], S.hourly(S.T8 - S.HOUR, 3) and sorted(pf.funding[S.BTC]))
        self.assertNotIn(D("0.01"), [r for _, _, r in pf.funding[S.BTC]])
        self.assertIn("funding_disputed", {w["rule"] for w in audit(pf)["warnings"]})
        self.assertEqual(rules(pf), [])

    def test_the_audit_catches_a_lost_dispute_flag(self):
        pf = S.new_portfolio(funding={S.BTC: S.hourly(S.T8 - S.HOUR, 3)})
        pf.decide([S.intent(S.BTC, LONG, S.T8, target_pct="0.01")], S.T8)
        pf.on_candle(S.BTC, S.T8, S.candle(100000, 100100, 99900, 100050))
        ingest_funding(pf, S.BTC, [(S.T8, S.T8 + S.HOUR, "0.01")], received_ms=S.T8 + 2 * S.HOUR)
        [trade] = pf.on_candle(S.BTC, S.T8 + 3 * S.HOUR, S.candle(100500, 101500, 100400, 101200))
        pf.review_flags[trade["trade_id"]].remove("funding_conflict")
        self.assertIn("funding_dispute_lost", rules(pf))

    def test_a_dispute_quarantined_before_the_entry_also_reaches_the_trade(self):
        pf = S.new_portfolio(funding={S.BTC: S.hourly(S.T8 - 3 * S.HOUR, 4)})
        ingest_funding(pf, S.BTC, [(S.T8, S.T8 + S.HOUR, "0.01")], received_ms=S.T8 + S.HOUR)
        pf.decide([S.intent(S.BTC, LONG, S.T8 + 10 * S.MIN, target_pct="0.01")], S.T8 + 10 * S.MIN)
        pf.on_candle(S.BTC, S.T8 + 10 * S.MIN, S.candle(100000, 100100, 99900, 100050))
        [trade] = pf.on_candle(S.BTC, S.T8 + 40 * S.MIN, S.candle(100500, 101500, 100400, 101200))
        self.assertIn("funding_conflict", pf.review_flags[trade["trade_id"]])

    def test_the_new_scenarios_are_clean_and_reproducible(self):
        for scenario in (S.unresolved_execution_gain, S.funding_dispute_on_open_position):
            a, b = scenario(), scenario()
            self.assertEqual(a["summary"]["audit"]["violations"], [])
            self.assertEqual(a["summary"]["accounting_digest"], b["summary"]["accounting_digest"])


class Reproducibility(unittest.TestCase):
    def test_same_scenarios_same_hashes(self):
        a, b = S.run_all(), S.run_all()
        self.assertEqual(S.build_results(a), S.build_results(b))

    def test_hashes_do_not_depend_on_the_interpreter_hash_seed(self):
        code = ("import json;from balancita_engine import portfolio_stage7 as S;"
                "print(json.dumps(S.build_results(S.run_all())['hashes'],sort_keys=True))")
        outs = []
        for seed in ("1", "424242"):
            env = dict(os.environ, PYTHONHASHSEED=seed, PYTHONPATH=os.path.join(ROOT, "python"))
            outs.append(subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True).stdout)
        self.assertEqual(outs[0], outs[1])

    def test_committed_results_match_a_fresh_run(self):
        """The report is regenerated, not hand-edited: ``python -m balancita_engine.portfolio_stage7`` and commit."""
        with tempfile.TemporaryDirectory() as out:
            S.write_outputs(out)
            for name in ("resultados.json", "informe.md"):
                with open(os.path.join(out, name), encoding="utf-8") as fresh, \
                        open(os.path.join(COMMITTED, name), encoding="utf-8") as kept:
                    self.assertEqual(fresh.read(), kept.read(), name)

    def test_every_scenario_passes_every_independent_check(self):
        results = S.run_all()
        self.assertEqual([r["id"] for r in results], sorted(r["id"] for r in results))
        self.assertEqual(len(results), 15)
        for r in results:
            self.assertEqual(r["summary"]["audit"]["violations"], [], r["id"])
            self.assertGreater(r["summary"]["audit"]["checks"], 0)

    def test_the_new_modules_import_nothing_that_touches_the_outside_world(self):
        forbidden = re.compile(r"^\s*(?:import|from)\s+(sqlite3|socket|http|urllib|requests|ssl|subprocess|random|time|datetime|"
                               r"asyncio|threading)\b|kronos|qwen|futures_forward|futures_replay|capture", re.I | re.M)
        base = os.path.join(ROOT, "python", "balancita_engine")
        for name in ("portfolio_watch.py", "portfolio_funding.py", "portfolio_audit.py", "portfolio_stage7.py"):
            with open(os.path.join(base, name), encoding="utf-8") as handle:
                source = handle.read()
            imports = "\n".join(line for line in source.splitlines() if re.match(r"\s*(import|from)\s", line))
            self.assertIsNone(forbidden.search(imports), name)
            self.assertNotIn("time.time", source)
            self.assertNotIn("datetime", source)


if __name__ == "__main__":
    unittest.main()
