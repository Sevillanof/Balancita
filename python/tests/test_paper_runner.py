"""Paper runner, stage 8A: coordination of the existing components on synthetic events, causality, idempotency of the
events, and replay of the journal. Everything here is invented data; nothing is connected to a live process."""

import copy
import os
import shutil
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import signal_continuity as SC
from balancita_engine.futures_costs import cost_model_hash
from balancita_engine.multi_signals import make_signal
from balancita_engine.paper_runner import (
    FINISHED, PaperRunner, RunnerConfig, RunnerError, RunnerJournal, make_event,
)
from balancita_engine.portfolio import PortfolioPolicy
from balancita_engine.portfolio_audit import audit
from balancita_engine.portfolio_scenarios import ScriptedStrategy

D = Decimal
SEC, MIN, HOUR = 1_000, 60_000, 3_600_000
CYCLE = SC.DEMO_START_MS + 100 * SC.FIVE_MINUTES_MS        # close of the 5-minute bar a signal used
BTC, ETH, SOL = "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"
PRICES = {BTC: ("100000", "1000"), ETH: ("3500", "70"), SOL: ("180", "4.5")}   # price, ATR (stop 2 ATR, target 3 ATR)
FUNDING = tuple((p, ((CYCLE - 2 * HOUR, CYCLE + 48 * HOUR, "0"),)) for p in PRICES)


def cfg(**kw):
    return RunnerConfig(**dict(dict(funding=FUNDING, start_ms=CYCLE - HOUR), **kw))


def cycle(t, product, at=CYCLE, **kw):
    price, atr = PRICES[product]
    return make_event("cycle", {"product_id": product, "cycle_ms": at, "price": price, "atr": atr}, t_ms=t, **kw)


def quote(product, t, mid, half_bps="0.5", **kw):
    mid, half = D(str(mid)), D(half_bps) / D(10_000)
    return make_event("quote", {"product_id": product, "time_ms": t, "received_ms": t,
                                "bid": str(mid * (1 - half)), "ask": str(mid * (1 + half))}, t_ms=t, **kw)


def candle(product, bucket, o, h, l, c, t=None, **kw):     # noqa: E741
    return make_event("candle", {"product_id": product, "bucket_ms": bucket,
                                 "candle": {"open": str(o), "high": str(h), "low": str(l), "close": str(c)}},
                      t_ms=bucket + MIN if t is None else t, **kw)


class Rig(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        SC.disarm()
        self.addCleanup(SC.disarm)

    def runner(self, script=None, ids=("scripted-a",), config=None, **kw):
        script = script or {}
        self.strategies = [ScriptedStrategy(i, script.get(i, {})) for i in ids]
        self.log = SC.SignalLog.create(os.path.join(self.dir, "signals-{}.jsonl".format(len(os.listdir(self.dir)))), CYCLE - 2 * HOUR)
        self.config = config or cfg()
        return PaperRunner(self.config, self.strategies, self.log, **kw)

    def replay(self, runner):
        return PaperRunner(self.config, self.strategies, self.log, entries=copy.deepcopy(runner.journal.entries))

    @staticmethod
    def call(action, strength="0.8"):
        return {"action": action, "strength": strength}

    def trades(self, runner):
        return runner.portfolio.trades

    def open_long_btc(self, runner):
        runner.run([cycle(CYCLE + 2 * SEC, BTC), quote(BTC, CYCLE + 5 * SEC, "100010")])


class Flow(Rig):
    def test_long_opens_on_the_first_executable_quote_and_closes_at_the_target(self):
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        [c] = r.run([cycle(CYCLE + 2 * SEC, BTC)])
        self.assertEqual(c["status"], "accepted")
        self.assertEqual([o["state"] for o in r.orders()], ["pending"])
        self.assertEqual(len(r.portfolio.positions), 0)                       # nothing opens at the reference price
        r.run([quote(BTC, CYCLE + 5 * SEC, "100010"), candle(BTC, CYCLE, 100000, 100100, 99900, 100010),
               candle(BTC, CYCLE + MIN, 100010, 103500, 100000, 103400)])
        [trade] = self.trades(r)
        self.assertEqual((trade["side"], trade["exit_reason"]), ("LONG", "target"))
        self.assertGreater(D(str(trade["pnl_usd"])), 0)
        self.assertEqual(r.orders()[0]["state"], "opened")
        self.assertEqual(audit(r.portfolio)["violations"], [])

    def test_short_opens_and_closes_at_the_stop(self):
        r = self.runner({"scripted-a": {(ETH, CYCLE): self.call("SELL")}})
        r.run([cycle(CYCLE + 2 * SEC, ETH), quote(ETH, CYCLE + 5 * SEC, "3500"), candle(ETH, CYCLE, 3500, 3510, 3490, 3500),
               candle(ETH, CYCLE + MIN, 3500, 3700, 3499, 3690)])
        [trade] = self.trades(r)
        self.assertEqual((trade["side"], trade["exit_reason"]), ("SHORT", "stop"))
        self.assertLess(D(str(trade["pnl_usd"])), 0)
        self.assertEqual(audit(r.portfolio)["violations"], [])

    def test_the_decision_chain_is_causal_and_recorded(self):
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        self.open_long_btc(r)
        [record] = [x for x in r.executor.records if x["status"] == "opened"]
        t = record["timeline"]
        self.assertTrue(t["candle_close_ms"] <= t["generated_ms"] <= t["persisted_ms"] <= t["decided_ms"]
                        <= t["earliest_fill_ms"] <= t["entry_ms"])
        kinds = [e["kind"] for e in r.journal.entries]
        self.assertEqual(kinds, ["run_start", "event_accepted", "signals_persisted", "decision", "event_accepted"])

    def test_wait_signals_are_persisted_but_never_decided(self):
        r = self.runner()                                                      # the script is empty: WAIT
        r.run([cycle(CYCLE + 2 * SEC, BTC)])
        self.assertEqual(len(list(r.log.signals())), 1)
        self.assertEqual((r.stats.get("decisions", 0), len(r.orders())), (0, 0))

    def test_three_products_compete_for_the_same_capital_and_the_risk_limit_binds(self):
        script = {"scripted-a": {(p, CYCLE): self.call("BUY") for p in PRICES}}
        r = self.runner(script)
        r.run([cycle(CYCLE + 2 * SEC, p) for p in PRICES])
        r.run([quote(p, CYCLE + 5 * SEC + i, PRICES[p][0]) for i, p in enumerate(PRICES)])
        states = sorted(o["state"] for o in r.orders())
        self.assertEqual(states, ["opened", "opened", "rejected"])             # 2 % aggregate risk = two 1 % positions
        [rejected] = [o for o in r.orders() if o["state"] == "rejected"]
        self.assertIn("open_risk_limit", rejected["reasons"])
        snap = r.portfolio.snapshot()
        self.assertLessEqual(D(snap["open_risk_usd"]), D("20.0000001"))
        self.assertEqual(audit(r.portfolio)["violations"], [])

    def test_contradictory_signals_on_one_product_open_nothing(self):
        script = {"scripted-a": {(BTC, CYCLE): self.call("BUY")}, "scripted-b": {(BTC, CYCLE): self.call("SELL")}}
        r = self.runner(script, ids=("scripted-a", "scripted-b"))
        r.run([cycle(CYCLE + 2 * SEC, BTC), quote(BTC, CYCLE + 5 * SEC, "100000")])
        self.assertEqual(len(r.portfolio.positions), 0)
        self.assertEqual([o["state"] for o in r.orders()], ["rejected", "rejected"])
        self.assertTrue(all("contradictory_signals" in o["reasons"] for o in r.orders()))

    def test_two_strategies_same_side_open_one_position_not_two(self):
        script = {"scripted-a": {(BTC, CYCLE): self.call("BUY", "0.6")}, "scripted-b": {(BTC, CYCLE): self.call("BUY", "0.9")}}
        r = self.runner(script, ids=("scripted-a", "scripted-b"))
        r.run([cycle(CYCLE + 2 * SEC, BTC), quote(BTC, CYCLE + 5 * SEC, "100000")])
        self.assertEqual(len(r.portfolio.positions), 1)
        self.assertEqual(sorted(o["state"] for o in r.orders()), ["opened", "rejected"])
        self.assertEqual(r.portfolio.positions[BTC].intent["strategy_id"], "scripted-b")   # the stronger one

    def test_a_signal_without_a_quote_stays_pending_then_expires_without_the_reference_price(self):
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        r.run([cycle(CYCLE + 2 * SEC, BTC)])
        r.run([make_event("clock", {}, t_ms=CYCLE + 30 * SEC)])
        self.assertEqual([o["state"] for o in r.orders()], ["pending"])
        r.run([make_event("clock", {}, t_ms=CYCLE + 70 * SEC)])                # window: 60 s after the decision
        [order] = r.orders()
        self.assertEqual((order["state"], order["reasons"]), ("expired", ["no_quote_in_window"]))
        self.assertEqual((len(r.portfolio.positions), len(r.portfolio.trades)), (0, 0))

    def test_a_late_better_quote_does_not_improve_the_decision(self):
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        r.run([cycle(CYCLE + 2 * SEC, BTC), quote(BTC, CYCLE + 5 * SEC, "100200"), quote(BTC, CYCLE + 8 * SEC, "99000")])
        self.assertEqual(r.portfolio.positions[BTC].position["entry_ms"], CYCLE + 5 * SEC)

    def test_a_reconstructed_signal_is_evidence_and_never_an_order(self):
        r = self.runner()
        s = self.strategies[0]
        signal = make_signal(strategy_id=s.id, strategy_version=s.version, product_id=BTC, bucket_ms=CYCLE, action="BUY",
                             strength="0.8", horizon_minutes=60, evidence={"x": "1"})
        r.run([make_event("reconstructed", {"signal": signal, "inputs": {"price": "100000"}, "price": "100000", "atr": "1000"},
                          t_ms=CYCLE + HOUR), quote(BTC, CYCLE + HOUR + SEC, "100000")])
        [entry] = list(r.log.signals())
        self.assertFalse(entry["data"]["executable"])
        self.assertEqual((len(r.orders()), len(r.portfolio.positions), r.stats.get("decisions", 0)), (0, 0, 0))
        # even offered directly to the executor, the guard refuses it
        result = r.executor.submit(entry, reference_price="100000", atr="1000", decided_ms=CYCLE + HOUR + 2 * SEC)
        self.assertEqual((result["status"], result["reasons"]), ("rejected", ["reconstructed_signal"]))

    def test_an_expired_original_signal_does_not_open_after_the_validity_window(self):
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        r.run([make_event("cycle", {"product_id": BTC, "cycle_ms": CYCLE, "price": "100000", "atr": "1000"}, t_ms=CYCLE + 6 * MIN)])
        [order] = r.orders()
        self.assertEqual((order["state"], order["reasons"]), ("rejected", ["signal_expired"]))


class Events(Rig):
    def test_a_duplicate_event_changes_nothing(self):
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        events = [cycle(CYCLE + 2 * SEC, BTC), quote(BTC, CYCLE + 5 * SEC, "100010")]
        r.run(events)
        digest = r.state_digest()
        accounting = r.portfolio.ledger_hash()
        again = r.run(events + events)
        self.assertEqual([x["status"] for x in again], ["duplicate"] * 4)
        self.assertEqual(r.portfolio.ledger_hash(), accounting)
        self.assertEqual((len(r.portfolio.positions), len(r.executor.records)), (1, 1))
        self.assertEqual(r.stats["rejected:duplicate_event"], 4)
        self.assertNotEqual(r.state_digest(), digest)                          # only the counter of rejections moved

    def test_the_same_id_with_other_content_is_a_conflict_and_never_replaces_the_first(self):
        r = self.runner()
        first = candle(BTC, CYCLE, 1, 2, 1, 2)
        r.run([first])
        other = dict(first, payload=candle(BTC, CYCLE, 1, 9, 1, 9)["payload"])
        self.assertEqual(r.handle(other)["status"], "conflict")
        self.assertEqual(r.portfolio.marks[BTC], D("2"))

    def test_an_event_that_arrives_before_the_clock_is_rejected_not_reordered(self):
        r = self.runner()
        r.run([quote(BTC, CYCLE + 10 * SEC, "100000")])
        result = r.handle(quote(BTC, CYCLE + 5 * SEC, "100000"))
        self.assertEqual((result["status"], result["reason"]), ("rejected", "out_of_order_event"))

    def test_candle_policy_future_duplicate_conflicting_and_late(self):
        r = self.runner()
        self.assertEqual(r.handle(candle(BTC, CYCLE, 1, 2, 1, 2, t=CYCLE + 30 * SEC))["reason"], "candle_not_closed")
        self.assertEqual(r.handle(candle(BTC, CYCLE, 1, 2, 1, 2))["status"], "accepted")
        self.assertEqual(r.handle(candle(BTC, CYCLE, 1, 2, 1, 2, event_id="other-id"))["reason"], "duplicate_candle")
        self.assertEqual(r.handle(candle(BTC, CYCLE, 1, 5, 1, 5, event_id="third-id"))["reason"], "conflicting_candle")
        self.assertEqual(r.handle(candle(BTC, CYCLE - MIN, 1, 2, 1, 2, t=CYCLE + 2 * MIN))["reason"], "late_candle")

    def test_a_cycle_cannot_be_evaluated_before_its_candle_closed(self):
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        self.assertEqual(r.handle(cycle(CYCLE - SEC, BTC))["reason"], "candle_not_closed")
        self.assertEqual(len(list(r.log.signals())), 0)

    def test_malformed_events_are_rejected_and_journaled(self):
        r = self.runner()
        self.assertEqual(r.handle({"kind": "nope"})["reason"], "invalid_event")
        self.assertEqual(r.handle(dict(quote(BTC, CYCLE, "1"), t_ms="x"))["reason"], "invalid_event")
        self.assertEqual(r.handle(make_event("candle", {"product_id": BTC}, t_ms=CYCLE))["reason"], "invalid_event")
        bad = make_event("cycle", {"product_id": BTC, "cycle_ms": CYCLE, "price": "abc", "atr": "1"}, t_ms=CYCLE + SEC)
        self.assertEqual(r.handle(bad)["reason"], "invalid_event")
        self.assertEqual(r.stats["events_rejected"], 4)
        with self.assertRaises(ValueError):
            make_event("order", {}, t_ms=1)


class StopBetweenCandles(Rig):
    def test_a_quote_through_the_stop_closes_once_and_the_candle_does_not_close_it_again(self):
        """Opens at 12:00:10, a quote crosses the stop at 12:00:25, the candle closes at 12:01:00: one close."""
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        r.run([cycle(CYCLE + 2 * SEC, BTC), quote(BTC, CYCLE + 10 * SEC, "100000"), quote(BTC, CYCLE + 20 * SEC, "99500"),
               quote(BTC, CYCLE + 25 * SEC, "97900"), quote(BTC, CYCLE + 40 * SEC, "97000")])
        self.assertEqual(len(self.trades(r)), 1)
        [trade] = self.trades(r)
        self.assertEqual(trade["exit_time_ms"], CYCLE + 25 * SEC)
        before = (r.portfolio.ledger_hash(), copy.deepcopy(r.portfolio.capital_log))
        r.run([candle(BTC, CYCLE, 100000, 100100, 97000, 97500), candle(BTC, CYCLE + MIN, 97500, 97600, 97000, 97100)])
        self.assertEqual(len(self.trades(r)), 1)
        self.assertEqual(r.portfolio.capital_log, before[1])
        self.assertEqual(r.portfolio.ledger_hash(), before[0])
        self.assertEqual(audit(r.portfolio)["violations"], [])


class Validation(Rig):
    """Whatever could fail while applying an event is refused before it reaches the journal, so the journal stays
    replayable and the financial state is untouched."""

    def assertUntouched(self, r, bad_events, reason=None):
        before = (r.portfolio.ledger_hash(), r.executor.ledger_hash(), len(r.log.entries), r.clock)
        accepted_before = r.stats.get("events_accepted", 0)
        for event in bad_events:
            result = r.handle(event)
            self.assertEqual(result["status"], "rejected", event)
            if reason:
                self.assertEqual(result["reason"], reason, event)
        self.assertEqual((r.portfolio.ledger_hash(), r.executor.ledger_hash(), len(r.log.entries), r.clock), before)
        self.assertEqual(r.stats.get("events_accepted", 0), accepted_before)
        again = self.replay(r)                                        # the journal with the rejections is still reproducible
        self.assertEqual((again.state_digest(), again.operational_digest()), (r.state_digest(), r.operational_digest()))

    def test_malformed_candles_never_become_accepted_entries(self):
        r = self.runner()
        t = CYCLE + 2 * MIN
        base = {"product_id": BTC, "bucket_ms": CYCLE}
        bad = [make_event("candle", dict(base, candle=c), t_ms=t, event_id="c{}".format(i)) for i, c in enumerate([
            {"open": "1", "high": "2", "low": "1"},                              # incomplete OHLC
            {"open": "1", "high": "2", "low": "1", "close": "abc"},              # not a number
            {"open": "1", "high": "NaN", "low": "1", "close": "1"},              # not finite
            {"open": "1", "high": "1", "low": "2", "close": "1"},                # high below low
            {"open": "3", "high": "2", "low": "1", "close": "2"},                # open outside the range
            {"open": "0", "high": "2", "low": "0", "close": "1"},                # non-positive price
            "not a dict", None])]
        self.assertUntouched(r, bad, "invalid_candle")
        self.assertUntouched(r, [make_event("candle", {"product_id": BTC, "bucket_ms": CYCLE + 7, "candle": {
            "open": "1", "high": "2", "low": "1", "close": "2"}}, t_ms=t),
            make_event("candle", {"product_id": 5, "bucket_ms": CYCLE, "candle": {"open": "1", "high": "2", "low": "1", "close": "2"}}, t_ms=t),
            make_event("candle", {"product_id": BTC}, t_ms=t, event_id="no-candle")])
        r.run([candle(BTC, CYCLE, 1, 2, 1, 2)])                                  # a valid one is still accepted afterwards
        self.assertEqual(r.portfolio.marks[BTC], D("2"))

    def test_malformed_reconstructed_events_are_rejected_before_the_journal(self):
        r = self.runner()
        s = self.strategies[0]
        good = make_signal(strategy_id=s.id, strategy_version=s.version, product_id=BTC, bucket_ms=CYCLE, action="BUY",
                           strength="0.8", horizon_minutes=60, evidence={"x": "1"})
        unfrozen = make_signal(strategy_id="never-frozen", strategy_version=1, product_id=BTC, bucket_ms=CYCLE, action="BUY",
                               strength="0.8", horizon_minutes=60, evidence={"x": "1"})
        tampered = dict(good, strength="0.9")
        t = CYCLE + HOUR
        bad = [make_event("reconstructed", payload, t_ms=t, event_id="r{}".format(i)) for i, payload in enumerate([
            {"signal": good},                                                    # no inputs
            {"signal": good, "inputs": "not a dict"},
            {"signal": tampered, "inputs": {}},                                  # signal_id no longer matches
            {"signal": unfrozen, "inputs": {}},                                  # strategy never frozen in the log
            {"signal": {"schema": "x"}, "inputs": {}},
            {"signal": None, "inputs": {}}])]
        self.assertUntouched(r, bad, "invalid_event")
        self.assertEqual(r.handle(make_event("reconstructed", {"signal": good, "inputs": {}}, t_ms=CYCLE - SEC))["reason"],
                         "candle_not_closed")

    def test_malformed_cycles_quotes_and_envelopes_are_rejected_before_the_journal(self):
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        t = CYCLE + 2 * SEC
        bad_cycles = [make_event("cycle", payload, t_ms=t, event_id="y{}".format(i)) for i, payload in enumerate([
            {"product_id": BTC, "cycle_ms": CYCLE, "price": 100000, "atr": "1000"},   # a float/int is not a Decimal string
            {"product_id": BTC, "cycle_ms": CYCLE, "price": "100000", "atr": "0"},
            {"product_id": BTC, "cycle_ms": CYCLE, "price": "NaN", "atr": "1"},
            {"product_id": BTC, "cycle_ms": "x", "price": "1", "atr": "1"},
            {"product_id": BTC, "price": "1", "atr": "1"}])]
        self.assertUntouched(r, bad_cycles, "invalid_event")
        bad_quotes = [make_event("quote", payload, t_ms=t, event_id="q{}".format(i)) for i, payload in enumerate([
            {"product_id": BTC, "time_ms": t, "bid": "2", "ask": "1"},                # crossed
            {"product_id": BTC, "time_ms": t, "bid": "x", "ask": "1"},
            {"product_id": BTC}])]
        self.assertUntouched(r, bad_quotes, "invalid_quote")
        self.assertUntouched(r, [dict(cycle(t, BTC), source=5), dict(cycle(t, BTC), source_offset="3")], "invalid_event")

    def test_a_strategy_that_fails_rejects_the_event_instead_of_poisoning_the_journal(self):
        def broken(strategies, payload):
            raise RuntimeError("boom")
        r = self.runner(evaluator=broken)
        self.assertUntouched(r, [cycle(CYCLE + 2 * SEC, BTC)], "evaluation_failed")

    def test_a_good_session_with_many_rejections_replays_to_the_same_state(self):
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        r.run([cycle(CYCLE + 2 * SEC, BTC), make_event("candle", {"product_id": BTC, "bucket_ms": CYCLE, "candle": {"open": "1"}},
                                                      t_ms=CYCLE + MIN), quote(BTC, CYCLE + 5 * SEC, "100010"),
               candle(BTC, CYCLE, 100000, 100100, 99900, 100010)])
        again = self.replay(r)
        self.assertEqual((again.state_digest(), again.operational_digest()), (r.state_digest(), r.operational_digest()))


class Finished(Rig):
    def finished(self):
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        r.run([cycle(CYCLE + 2 * SEC, BTC), quote(BTC, CYCLE + 5 * SEC, "100010")])
        r.finish()
        return r

    def test_a_finished_session_recovers_as_finished_and_accepts_nothing(self):
        live = self.finished()
        again = self.replay(live)
        self.assertEqual((live.status, again.status), (FINISHED, FINISHED))
        self.assertEqual(again.operational_digest(), live.operational_digest())
        self.assertEqual(again.state_digest(), live.state_digest())
        for runner in (live, again):
            with self.assertRaises(RunnerError) as caught:
                runner.handle(quote(BTC, CYCLE + 9 * SEC, "100000"))
            self.assertEqual(caught.exception.reason, "not_processing")
            with self.assertRaises(RunnerError):
                runner.finish()
        self.assertEqual(len(again.journal.entries), len(live.journal.entries))      # nothing was written by the refusals

    def test_an_unfinished_session_recovers_as_processing_and_continues(self):
        r = self.runner({"scripted-a": {(BTC, CYCLE): self.call("BUY")}})
        r.run([cycle(CYCLE + 2 * SEC, BTC)])
        again = self.replay(r)
        self.assertEqual(again.operational_digest(), r.operational_digest())
        again.run([quote(BTC, CYCLE + 5 * SEC, "100010")])
        r.run([quote(BTC, CYCLE + 5 * SEC, "100010")])
        self.assertEqual(again.state_digest(), r.state_digest())

    def test_entries_after_run_end_are_refused(self):
        live = self.finished()
        entries = copy.deepcopy(live.journal.entries)
        extra = RunnerJournal(entries)
        extra.add(CYCLE + 20 * SEC, "event_rejected", {"event_id": "x", "kind": "quote", "reason": "invalid_event", "event_hash": "0"})
        with self.assertRaises(RunnerError) as caught:
            PaperRunner(self.config, self.strategies, self.log, entries=extra.entries)
        self.assertEqual(caught.exception.reason, "journal_incompatible")


class Replay(Rig):
    SCRIPT = {"scripted-a": {(BTC, CYCLE): {"action": "BUY", "strength": "0.8"}, (ETH, CYCLE): {"action": "SELL", "strength": "0.7"}}}

    def session(self):
        r = self.runner(self.SCRIPT)
        r.run([cycle(CYCLE + 2 * SEC, BTC), cycle(CYCLE + 2 * SEC, ETH), quote(BTC, CYCLE + 5 * SEC, "100010"),
               quote(ETH, CYCLE + 6 * SEC, "3500"), quote(BTC, CYCLE + 5 * SEC, "100010", event_id="dup"),
               candle(BTC, CYCLE, 100000, 100100, 99900, 100010), candle(ETH, CYCLE, 3500, 3510, 3490, 3500),
               candle(BTC, CYCLE + MIN, 100010, 103500, 100000, 103400), candle(ETH, CYCLE + MIN, 3500, 3700, 3499, 3690)])
        r.finish()
        return r

    def test_a_runner_rebuilt_from_the_journal_has_the_same_state_and_hashes(self):
        live = self.session()
        self.assertEqual(live.status, FINISHED)
        again = self.replay(live)
        self.assertEqual(again.state_digest(), live.state_digest())
        self.assertEqual(again.portfolio.ledger_hash(), live.portfolio.ledger_hash())
        self.assertEqual(again.executor.ledger_hash(), live.executor.ledger_hash())
        self.assertEqual(again.journal.head, live.journal.head)
        self.assertEqual([t["trade_id"] for t in again.portfolio.trades], [t["trade_id"] for t in live.portfolio.trades])
        self.assertEqual(again.stats, live.stats)

    def test_the_digest_recorded_at_the_end_is_what_the_replay_reproduces(self):
        live = self.session()
        recorded = live.journal.entries[-1]["data"]["state_digest"]
        again = self.replay(live)
        self.assertEqual(again.state_digest(), recorded)

    def test_replay_does_not_evaluate_the_strategies_again(self):
        live = self.session()
        count = len(live.log.entries)
        self.replay(live)
        self.assertEqual(len(live.log.entries), count)

    def test_two_replays_of_the_same_events_give_identical_hashes(self):
        a, b = self.session(), self.session()
        self.assertEqual(a.state_digest(), b.state_digest())
        self.assertEqual(a.journal.head, b.journal.head)

    def test_a_tampered_journal_is_refused(self):
        live = self.session()
        entries = copy.deepcopy(live.journal.entries)
        entries[3]["data"]["decided_ms"] = 1
        with self.assertRaises(RunnerError) as caught:
            PaperRunner(self.config, self.strategies, self.log, entries=entries)
        self.assertEqual(caught.exception.reason, "journal_corrupt")

    def test_a_different_configuration_is_refused_not_continued(self):
        live = self.session()
        other = cfg(portfolio=PortfolioPolicy(risk_per_trade="0.02"))
        with self.assertRaises(RunnerError) as caught:
            PaperRunner(other, self.strategies, self.log, entries=copy.deepcopy(live.journal.entries))
        self.assertEqual(caught.exception.reason, "config_incompatible")

    def test_a_journal_that_does_not_start_with_run_start_is_refused(self):
        live = self.session()
        with self.assertRaises(RunnerError) as caught:
            PaperRunner(self.config, self.strategies, self.log, entries=copy.deepcopy(live.journal.entries[1:]))
        self.assertIn(caught.exception.reason, ("journal_corrupt", "journal_incompatible"))

    def test_a_journal_pointing_to_a_signal_the_log_does_not_have_is_refused(self):
        live = self.session()
        other_log = SC.SignalLog.create(os.path.join(self.dir, "other.jsonl"), CYCLE - 2 * HOUR)
        for strategy in self.strategies:
            other_log.freeze_strategy(strategy, self.config.start_ms)
        with self.assertRaises(RunnerError) as caught:
            PaperRunner(self.config, self.strategies, other_log, entries=copy.deepcopy(live.journal.entries))
        self.assertEqual(caught.exception.reason, "signal_log_mismatch")

    def test_the_manifest_records_policies_and_marks_them_experimental(self):
        r = self.runner()
        m = r.manifest
        self.assertEqual(m["cost_model_hash"], cost_model_hash())
        self.assertEqual(m["portfolio_policy"], PortfolioPolicy().__dict__)       # the approved parameters, unchanged
        self.assertIn("experimental", m["policy_status"])
        self.assertTrue(all(v is not None for v in m["strategies"].values()))
        self.assertEqual(RunnerJournal.verify(r.journal.entries), None)


if __name__ == "__main__":
    unittest.main()
