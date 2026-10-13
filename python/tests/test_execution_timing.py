"""Temporally correct paper entry: closed candle -> signal -> persisted -> decision -> first executable quote -> entry.
Synthetic data only: latency, adverse and favorable moves, missing / stale / crossed quotes, price changes between the
signal and the execution, causality, idempotency and the stop that never moves."""

import ast
import os
import shutil
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import signal_continuity as SC
from balancita_engine.execution_timing import ExecutionPolicy, TimedExecutor, adverse_bps, executable_reference, parse_quote
from balancita_engine.futures_costs import entry_fill
from balancita_engine.multi_signals import make_signal
from balancita_engine.portfolio import LONG, SHORT, Portfolio, PortfolioPolicy

D = Decimal
SEC = 1_000
MIN = 60_000
HOUR = 3_600_000
CYCLE = SC.DEMO_START_MS + 100 * SC.FIVE_MINUTES_MS      # close of the 5-minute bar the signal used
PRODUCT = "PF_XBTUSD"
PRICE, ATR = "100000", "1000"                            # LONG: stop 98 000, target 103 000
FUNDING = {PRODUCT: [(CYCLE - 2 * HOUR, CYCLE + 48 * HOUR, "0")]}


def roomy(**kw):
    """Only the per-trade risk rule binds, so the sizing can be read without the aggregate limits getting in the way."""
    base = dict(max_product_exposure_pct="10", max_gross_exposure_pct="10", max_net_exposure_pct="10",
                max_open_risk_pct="10")
    return PortfolioPolicy(**dict(base, **kw))


def quote(t, mid, *, half_bps="0.5", received=None, product=PRODUCT):
    mid, half = D(str(mid)), D(half_bps) / D(10_000)
    return {"product_id": product, "time_ms": t, "received_ms": t if received is None else received,
            "bid": str(mid * (1 - half)), "ask": str(mid * (1 + half))}


class Env(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        SC.disarm()
        self.addCleanup(SC.disarm)
        self.strategies = SC.demo_strategies()
        self.log = SC.SignalLog.create(os.path.join(self.dir, "s.jsonl"), CYCLE - HOUR)
        for strategy in self.strategies:
            self.log.freeze_strategy(strategy, CYCLE - HOUR)

    def executor(self, policy=None, **exec_kw):
        return TimedExecutor(Portfolio(policy or roomy(), funding=FUNDING), ExecutionPolicy(**exec_kw))

    def persist(self, action="BUY", *, cycle=CYCLE, persisted=None, strategy=0, origin="original", strength="0.8"):
        s = self.strategies[strategy]
        signal = make_signal(strategy_id=s.id, strategy_version=s.version, product_id=PRODUCT, bucket_ms=cycle,
                             action=action, strength=strength, horizon_minutes=60, evidence={"x": "1"})
        receipt = self.log.ingest(signal, {"price": PRICE}, cycle + 2 * SEC if persisted is None else persisted,
                                  origin=origin)
        return self.log.entries[receipt["seq"] - 1]

    def submit(self, ex, entry, decided=CYCLE + 3 * SEC, price=PRICE, atr=ATR):
        return ex.submit(entry, reference_price=price, atr=atr, decided_ms=decided)

    def opened(self, ex):
        return [r for r in ex.records if r["status"] == "opened"]


class Sequence(Env):
    def test_entry_uses_the_first_usable_quote_after_the_decision_not_the_reference_price(self):
        ex, entry = self.executor(), self.persist()
        self.assertEqual(self.submit(ex, entry)["status"], "pending")
        # a quote observed before the order could reach the book (decision + 1 s latency) is not used
        self.assertEqual(ex.on_quote(quote(CYCLE + 3 * SEC + 500, "100050")), [])
        [record] = ex.on_quote(quote(CYCLE + 5 * SEC, "100120", half_bps="0.01"))
        ex.on_quote(quote(CYCLE + 6 * SEC, "99000"))        # a later, very different price changes nothing
        self.assertEqual(record["status"], "opened")
        line = record["timeline"]
        self.assertTrue(line["candle_close_ms"] <= line["generated_ms"] <= line["persisted_ms"] <= line["decided_ms"]
                        < line["earliest_fill_ms"] <= line["entry_ms"] <= line["opened_at_ms"])
        self.assertEqual(line["entry_ms"], CYCLE + 5 * SEC)
        self.assertEqual(record["quotes_discarded"], {"before_latency": 1})
        # the position was bought on the executable quote (mid + model impact), not on the reference price
        quote_mid = D("100120")
        expected = entry_fill(quote_mid, LONG, PRODUCT)
        self.assertAlmostEqual(float(D(record["entry_price"])), float(expected), places=6)
        self.assertNotAlmostEqual(float(D(record["entry_price"])), float(entry_fill(D(PRICE), LONG, PRODUCT)), places=2)
        self.assertEqual(ex.portfolio.positions[PRODUCT].position["entry"], D(record["entry_price"]))

    def test_sizing_is_recomputed_from_the_execution_price_against_the_original_stop(self):
        ex = self.executor()
        self.submit(ex, self.persist())
        [far] = ex.on_quote(quote(CYCLE + 5 * SEC, "100500"))     # price moved away from the stop
        near_ex = self.executor()
        self.submit(near_ex, self.persist())
        [near] = near_ex.on_quote(quote(CYCLE + 5 * SEC, "99500"))   # price moved toward the stop
        budget = D("10")
        for record in (far, near):
            self.assertEqual(D(record["stop"]), D(98000))
            self.assertTrue(record["stop_unchanged"])
            self.assertEqual(D(record["position_stop"]), D("98000"))
            # planned loss against the ORIGINAL stop stays at the risk budget (rounded down to the cent of notional)
            self.assertTrue(budget - D("0.01") < D(record["planned_loss_usd"]) <= budget, record["planned_loss_usd"])
        self.assertTrue(D(far["notional_usd"]) < D(far["notional_at_reference_usd"]) < D(near["notional_usd"]))
        self.assertTrue(D(far["loss_fraction"]) > D(far["loss_fraction_at_reference"]) > D(near["loss_fraction"]))

    def test_stop_hit_loses_the_planned_amount_computed_from_the_execution_price(self):
        ex = self.executor()
        self.submit(ex, self.persist())
        [record] = ex.on_quote(quote(CYCLE + 5 * SEC, "99400"))
        first = D(record["timeline"]["opened_at_ms"])
        # opened mid-minute: the entry-minute candle is not seen; the next candle breaks the stop
        self.assertEqual(first, CYCLE + MIN)
        closed = ex.on_candle(PRODUCT, CYCLE + MIN, {"open": "99400", "high": "99450", "low": "97900", "close": "98100"})
        self.assertEqual(len(closed), 1)
        trade = closed[0]
        self.assertEqual(trade["exit_reason"], "stop")
        self.assertAlmostEqual(float(D(trade["pnl_usd"])), -float(D(record["planned_loss_usd"])), places=3)

    def test_short_side_mirrors_long(self):
        ex = self.executor()
        self.submit(ex, self.persist("SELL"))
        [record] = ex.on_quote(quote(CYCLE + 5 * SEC, "99700", half_bps="0.01"))   # price fell: toward the target of a SHORT
        self.assertEqual((record["status"], record["side"]), ("opened", SHORT))
        self.assertEqual(D(record["stop"]), D(102000))
        self.assertAlmostEqual(float(D(record["entry_price"])), float(entry_fill(D("99700"), SHORT, PRODUCT)), places=6)
        self.assertTrue(D(record["notional_usd"]) < D(record["notional_at_reference_usd"]))


class AdverseAndFavorableMoves(Env):
    def test_adverse_move_that_consumed_too_much_of_the_stop_distance_is_rejected_and_the_stop_stays(self):
        ex = self.executor()
        self.submit(ex, self.persist())
        [record] = ex.on_quote(quote(CYCLE + 5 * SEC, "98900"))   # 55 % of the 2 000 stop distance used
        self.assertEqual((record["status"], record["reasons"]), ("rejected", ["adverse_move_consumed_stop_distance"]))
        self.assertEqual(ex.portfolio.positions, {})
        self.assertEqual(ex.portfolio.decisions, [])              # the portfolio was never asked
        self.assertEqual(D(record["stop"]), D(98000))

    def test_limit_is_a_policy_not_a_constant(self):
        ex = self.executor(max_stop_distance_consumed="0.7")
        self.submit(ex, self.persist())
        [record] = ex.on_quote(quote(CYCLE + 5 * SEC, "98900"))
        self.assertEqual(record["status"], "opened")

    def test_price_through_the_stop_is_rejected(self):
        for mid in ("98000", "97500"):   # the mid at or through the stop, even if the ask is a hair above it
            ex = self.executor(max_stop_distance_consumed="5")
            self.submit(ex, self.persist())
            [record] = ex.on_quote(quote(CYCLE + 5 * SEC, mid))
            self.assertIn("executable_price_beyond_stop", record["reasons"], mid)
            self.assertEqual(ex.portfolio.positions, {})

    def test_price_through_the_target_or_most_of_the_way_there_is_rejected(self):
        ex = self.executor()
        self.submit(ex, self.persist())
        [record] = ex.on_quote(quote(CYCLE + 5 * SEC, "101600"))  # 53 % of the 3 000 target distance already gone
        self.assertEqual(record["reasons"], ["favorable_move_consumed_target_distance"])
        ex = self.executor(max_target_distance_consumed="5")
        self.submit(ex, self.persist())
        [record] = ex.on_quote(quote(CYCLE + 5 * SEC, "103500"))
        self.assertIn("executable_price_beyond_target", record["reasons"])

    def test_short_adverse_move_mirrors(self):
        ex = self.executor()
        self.submit(ex, self.persist("SELL"))
        [record] = ex.on_quote(quote(CYCLE + 5 * SEC, "101100"))  # price rose toward a SHORT stop at 102 000
        self.assertEqual(record["reasons"], ["adverse_move_consumed_stop_distance"])

    def test_adverse_move_is_signed(self):
        self.assertEqual(adverse_bps(LONG, D(100), D("100.1")), D(10))
        self.assertEqual(adverse_bps(SHORT, D(100), D("100.1")), D(-10))

    def test_nearer_stop_still_respects_every_portfolio_limit(self):
        # approved policy: 500 USD per product cap binds when the stop is near, the risk budget is never exceeded
        ex = TimedExecutor(Portfolio(PortfolioPolicy(), funding=FUNDING))
        self.submit(ex, self.persist())
        [record] = ex.on_quote(quote(CYCLE + 5 * SEC, "99300"))
        self.assertEqual(record["status"], "opened")
        self.assertEqual(D(record["notional_usd"]), D("500.00"))
        self.assertIn("product_limit", record["limits_applied"])
        self.assertTrue(D(record["planned_loss_usd"]) < D(record["risk_budget_usd"]))


class LatencyAndMissingQuotes(Env):
    def test_latency_moves_the_fill_to_a_later_price(self):
        prices = {}
        for latency in (0, 1_000, 10_000):
            ex = self.executor(latency_ms=latency)
            self.submit(ex, self.persist())
            done = []
            for step, mid in enumerate(("100000", "100100", "100200", "100300"), start=0):
                done += ex.on_quote(quote(CYCLE + 3 * SEC + step * 5 * SEC, mid))
            prices[latency] = done[0]["quote"]["mid"]
        self.assertEqual({k: D(v) for k, v in prices.items()}, {0: D(100000), 1_000: D(100100), 10_000: D(100200)})

    def test_no_quote_in_window_is_rejected_and_never_falls_back_to_the_reference_price(self):
        ex = self.executor()
        self.submit(ex, self.persist())
        self.assertEqual(ex.advance(CYCLE + 3 * SEC + 59 * SEC), [])      # still inside the window
        [record] = ex.advance(CYCLE + 3 * SEC + 60 * SEC + 1)
        self.assertEqual((record["status"], record["reasons"]), ("rejected", ["no_quote_in_window"]))
        self.assertEqual(ex.portfolio.positions, {})
        self.assertEqual(ex.portfolio.decisions, [])
        self.assertEqual(ex.pending, {})

    def test_quotes_for_another_product_do_not_count(self):
        ex = self.executor()
        self.submit(ex, self.persist())
        ex.on_quote(quote(CYCLE + 5 * SEC, "3500", product="PF_ETHUSD"))
        [record] = ex.advance(CYCLE + 3 * SEC + 61 * SEC)
        self.assertEqual(record["reasons"], ["no_quote_in_window"])

    def test_only_unusable_quotes_gives_no_valid_quote(self):
        ex = self.executor()
        self.submit(ex, self.persist())
        t = CYCLE + 5 * SEC
        ex.on_quote(quote(t, "100000", received=t + 10 * SEC))               # stale: 10 s old when received
        ex.on_quote(quote(t + 11 * SEC, "100000", half_bps="40"))            # 80 bp wide
        ex.on_quote({"product_id": PRODUCT, "time_ms": t + 12 * SEC, "bid": "100100", "ask": "100000"})   # crossed
        ex.on_quote({"product_id": PRODUCT, "time_ms": t + 13 * SEC, "bid": "x", "ask": "100000"})        # garbage
        ex.on_quote(quote(t + 4 * SEC, "100000"))                            # out of order
        [record] = ex.advance(CYCLE + 3 * SEC + 61 * SEC)
        self.assertEqual(record["reasons"], ["no_valid_quote_in_window"])
        self.assertEqual(record["quotes_discarded"], {"invalid_quote": 2, "out_of_order_quote": 1, "stale_quote": 1,
                                                       "wide_spread": 1})
        self.assertEqual(ex.portfolio.positions, {})

    def test_wide_quote_is_skipped_and_the_next_good_one_is_used(self):
        ex = self.executor()
        self.submit(ex, self.persist())
        self.assertEqual(ex.on_quote(quote(CYCLE + 5 * SEC, "100000", half_bps="40")), [])
        [record] = ex.on_quote(quote(CYCLE + 8 * SEC, "100010"))
        self.assertEqual(record["status"], "opened")
        self.assertEqual(record["timeline"]["entry_ms"], CYCLE + 8 * SEC)

    def test_a_quote_after_the_deadline_cannot_fill_the_order(self):
        ex = self.executor()
        self.submit(ex, self.persist())
        [record] = ex.on_quote(quote(CYCLE + 3 * SEC + 90 * SEC, "100000"))
        self.assertEqual(record["reasons"], ["no_quote_in_window"])
        self.assertEqual(ex.portfolio.positions, {})

    def test_after_a_gap_a_late_good_quote_inside_the_window_still_fills(self):
        ex = self.executor()
        self.submit(ex, self.persist())
        [record] = ex.on_quote(quote(CYCLE + 3 * SEC + 50 * SEC, "100200"))
        self.assertEqual(record["status"], "opened")

    def test_touch_is_never_better_than_the_visible_ask_or_bid(self):
        q = parse_quote(quote(CYCLE, "100000", half_bps="20"))       # 20 bp half spread, model impact is 0.06 bp
        self.assertEqual(entry_fill(executable_reference(LONG, PRODUCT, q), LONG, PRODUCT).quantize(D("0.0000001")),
                         q["ask"].quantize(D("0.0000001")))
        self.assertEqual(entry_fill(executable_reference(SHORT, PRODUCT, q), SHORT, PRODUCT).quantize(D("0.0000001")),
                         q["bid"].quantize(D("0.0000001")))
        tight = parse_quote(quote(CYCLE, "100000", half_bps="0.01"))
        self.assertEqual(executable_reference(LONG, PRODUCT, tight), tight["mid"])

    def test_wide_but_allowed_spread_costs_more_than_the_model(self):
        narrow, wide = self.executor(), self.executor()
        self.submit(narrow, self.persist())
        self.submit(wide, self.persist())
        [a] = narrow.on_quote(quote(CYCLE + 5 * SEC, "100000", half_bps="0.5"))
        [b] = wide.on_quote(quote(CYCLE + 5 * SEC, "100000", half_bps="10"))
        self.assertTrue(D(b["entry_price"]) > D(a["entry_price"]))
        self.assertTrue(D(b["notional_usd"]) < D(a["notional_usd"]))


class Causality(Env):
    def test_reconstructed_signal_is_not_an_order(self):
        ex = self.executor()
        result = self.submit(ex, self.persist(origin="reconstructed"))
        self.assertEqual((result["status"], result["reasons"]), ("rejected", ["reconstructed_signal"]))

    def test_expired_signal_is_rejected(self):
        ex = self.executor()
        result = self.submit(ex, self.persist(), decided=CYCLE + 5 * MIN + 1)
        self.assertEqual(result["reasons"], ["signal_expired"])

    def test_decision_before_the_candle_closed_or_before_persistence_is_rejected(self):
        ex = self.executor()
        self.assertIn("candle_not_closed", self.submit(ex, self.persist(), decided=CYCLE - 1)["reasons"])
        ex = self.executor()
        late = self.persist(cycle=CYCLE + 5 * MIN, persisted=CYCLE + 5 * MIN + 30 * SEC)
        result = self.submit(ex, late, decided=CYCLE + 5 * MIN + 10 * SEC)
        self.assertIn("decision_before_persistence", result["reasons"])
        self.assertEqual(ex.on_quote(quote(CYCLE + 5 * MIN + 20 * SEC, "100000")), [])

    def test_quote_observed_before_the_decision_is_never_used(self):
        ex = self.executor()
        ex.on_quote(quote(CYCLE + 2 * SEC, "100000"))      # delivered before the decision
        self.submit(ex, self.persist())
        self.assertEqual(ex.pending[next(iter(ex.pending))]["quotes_seen"], 0)
        [record] = ex.advance(CYCLE + 3 * SEC + 61 * SEC)
        self.assertEqual(record["reasons"], ["no_quote_in_window"])

    def test_events_that_go_back_in_time_are_refused(self):
        ex = self.executor()
        ex.on_quote(quote(CYCLE + 20 * SEC, "100000"))
        result = self.submit(ex, self.persist(), decided=CYCLE + 10 * SEC)
        self.assertIn("time_went_backwards", result["reasons"])

    def test_signal_without_valid_levels_is_rejected(self):
        ex = self.executor()
        result = ex.submit(self.persist(), reference_price=PRICE, atr="0", decided_ms=CYCLE + 3 * SEC)
        self.assertEqual(result["reasons"], ["levels_unavailable"])

    def test_wait_signals_are_ignored(self):
        ex = self.executor()
        self.assertEqual(self.submit(ex, self.persist("WAIT"))["status"], "ignored")
        self.assertEqual((ex.records, ex.pending), ([], {}))


class IdempotencyAndConcurrency(Env):
    def test_submitting_the_same_signal_twice_changes_nothing(self):
        ex, entry = self.executor(), self.persist()
        self.assertEqual(self.submit(ex, entry)["status"], "pending")
        self.assertEqual(self.submit(ex, entry, decided=CYCLE + 4 * SEC)["status"], "duplicate")
        ex.on_quote(quote(CYCLE + 6 * SEC, "100000"))
        self.assertEqual(self.submit(ex, entry, decided=CYCLE + 7 * SEC)["status"], "duplicate")
        self.assertEqual(len(self.opened(ex)), 1)
        self.assertEqual(len(ex.portfolio.positions), 1)

    def test_two_orders_filled_by_one_quote_go_through_one_portfolio_batch(self):
        ex = self.executor()
        self.submit(ex, self.persist("BUY", strategy=0, strength="0.6"))
        self.submit(ex, self.persist("SELL", strategy=1, strength="0.9"))
        records = ex.on_quote(quote(CYCLE + 5 * SEC, "100000"))
        self.assertEqual(sorted(r["status"] for r in records), ["rejected", "rejected"])
        self.assertEqual([r["reasons"] for r in records], [["contradictory_signals"]] * 2)
        self.assertEqual(ex.portfolio.positions, {})

    def test_portfolio_rejections_keep_the_whole_timeline(self):
        ex = self.executor(policy=roomy(min_notional_usd="1000000"))
        self.submit(ex, self.persist())
        [record] = ex.on_quote(quote(CYCLE + 5 * SEC, "100000"))
        self.assertEqual((record["status"], record["reasons"]), ("rejected", ["size_below_minimum"]))
        self.assertTrue(record["portfolio_rejection"])
        self.assertEqual(record["timeline"]["entry_ms"], CYCLE + 5 * SEC)

    def test_entry_on_a_minute_boundary_is_watched_from_the_next_candle(self):
        ex = self.executor()
        self.submit(ex, self.persist())
        [record] = ex.on_quote(quote(CYCLE + MIN, "100000"))
        self.assertEqual(record["timeline"]["opened_at_ms"], CYCLE + MIN)
        self.assertEqual(record["timeline"]["entry_bucket_ms"], CYCLE)
        ex.on_candle(PRODUCT, CYCLE + MIN, {"open": "100000", "high": "100100", "low": "99900", "close": "100050"})

    def test_same_inputs_same_ledger(self):
        hashes = []
        for _ in range(2):
            ex = self.executor()
            self.submit(ex, self.persist())
            ex.on_quote(quote(CYCLE + 5 * SEC, "100120"))
            ex.on_candle(PRODUCT, CYCLE + MIN, {"open": "100120", "high": "100200", "low": "100000", "close": "100100"})
            hashes.append(ex.ledger_hash())
            self.tearDown()
            self.setUp()
        self.assertEqual(hashes[0], hashes[1])


class Isolation(unittest.TestCase):
    def test_portfolio_without_entry_bucket_behaves_as_before(self):
        from balancita_engine.portfolio import make_intent
        t0 = 1_700_000_040_000
        intent = make_intent(strategy_id="s", product_id=PRODUCT, side=LONG, strength="0.8", bucket_ms=t0, price="100",
                             stop="98", target="103", horizon_minutes=60)
        record = Portfolio(roomy()).decide([intent], t0 + MIN)[0]
        self.assertEqual(record["status"], "opened")

    def test_module_imports_nothing_from_the_live_stack(self):
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "balancita_engine", "execution_timing.py")
        with open(path, encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        imported = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
        forbidden = ("forward", "capture", "kronos", "qwen", "store", "sqlite", "multi_experiment")
        self.assertEqual([m for m in imported if any(f in m for f in forbidden)], [])
        with open(path, encoding="utf-8") as handle:
            source = handle.read()
        for token in ("import time", "datetime", "import random", "sqlite3", "socket", "urllib", "requests"):
            self.assertNotIn(token, source)


if __name__ == "__main__":
    unittest.main()
