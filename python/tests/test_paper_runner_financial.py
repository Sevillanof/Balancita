"""Paper runner, stage 8C: the 23 integration scenarios, crashes D/E/F, suspensions, funding and disputes through the journal,
market coverage during interruptions, the read contract, the independent audit (and that it detects deliberate damage), and
the demo run in independent processes. Everything is invented data; nothing is connected to a live process."""

import copy
import json
import os
import shutil
import sys
import tempfile
import unittest
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from balancita_engine import paper_runner_demo as DEMO                       # noqa: E402
from balancita_engine import paper_runner_store as ST                        # noqa: E402
from balancita_engine import signal_continuity as SC                         # noqa: E402
from balancita_engine.multi_signals import make_signal                       # noqa: E402
from balancita_engine.paper_runner import PaperRunner, RunnerConfig, RunnerError, make_event   # noqa: E402
from balancita_engine.paper_runner_report import CLASSES, CONTRACT, integrated_audit, observability, summary_block   # noqa: E402
from balancita_engine.portfolio_audit import accounting_digest               # noqa: E402
from balancita_engine.portfolio_scenarios import ScriptedStrategy            # noqa: E402

D = Decimal
SEC, MIN, HOUR = 1_000, 60_000, 3_600_000
CYCLE = SC.DEMO_START_MS + 100 * SC.FIVE_MINUTES_MS
C2, C3 = CYCLE + 5 * MIN, CYCLE + 10 * MIN
BTC, ETH, SOL = "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"
PRICES = {BTC: ("100000", "1000"), ETH: ("3500", "70"), SOL: ("180", "4.5")}
BUY, SELL = {"action": "BUY", "strength": "0.8"}, {"action": "SELL", "strength": "0.8"}
FULL = tuple((p, ((CYCLE - 2 * HOUR, CYCLE + 48 * HOUR, "0"),)) for p in PRICES)
SRC = "feed"


class Feed(object):
    """Hands out independent offsets per stream so a test reads like the session it describes."""

    def __init__(self):
        self.next = {}

    def off(self, stream):
        self.next[stream] = self.next.get(stream, 0) + 1
        return self.next[stream]

    def cycle(self, t, product, at=CYCLE):
        price, atr = PRICES[product]
        return make_event("cycle", {"product_id": product, "cycle_ms": at, "price": price, "atr": atr}, t_ms=t,
                          source=SRC, stream="cycles", source_offset=self.off("cycles"))

    def quote(self, product, t, mid, half="0.5"):
        mid, half = D(str(mid)), D(half) / D(10_000)
        return make_event("quote", {"product_id": product, "time_ms": t, "received_ms": t, "bid": str(mid * (1 - half)),
                                    "ask": str(mid * (1 + half))}, t_ms=t, source=SRC, stream="quotes",
                          source_offset=self.off("quotes"))

    def candle(self, product, bucket, o, h, l, c):     # noqa: E741
        return make_event("candle", {"product_id": product, "bucket_ms": bucket,
                                     "candle": {"open": str(o), "high": str(h), "low": str(l), "close": str(c)}},
                          t_ms=bucket + MIN, source=SRC, stream="candles", source_offset=self.off("candles"))

    def funding(self, t, product, periods):
        return make_event("funding", {"product_id": product, "periods": periods}, t_ms=t, source=SRC, stream="funding",
                          source_offset=self.off("funding"))

    def reconcile(self, t):
        return make_event("reconcile", {}, t_ms=t, source="operator", stream="main")


class Fin(unittest.TestCase):
    def setUp(self):
        for r in getattr(self, "live", ()):
            r.close()
        self.dir = tempfile.mkdtemp()
        self.live = []
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.addCleanup(self.die)
        ST.disarm()
        self.addCleanup(ST.disarm)
        self.f = Feed()
        self.script, self.ids, self.config = {}, ("a",), None

    def die(self):
        for r in self.live:
            r.close()
        del self.live[:]

    def strategies(self):
        return [ScriptedStrategy(i, self.script.get(i, {})) for i in self.ids]

    def cfg(self, **kw):
        return self.config or RunnerConfig(**dict(dict(funding=FULL, start_ms=CYCLE - HOUR), **kw))

    def start(self, script=None, ids=("a",), name="run", config=None, **kw):
        self.script, self.ids = script or {}, ids
        self.config = config
        self.f = Feed()
        path = os.path.join(self.dir, name)
        r = PaperRunner.create(path, self.cfg(**kw), self.strategies())
        self.live.append(r)
        return path, r

    def reopen(self, path, at, **kw):
        self.die()
        r = PaperRunner.recover(path, self.cfg(), self.strategies(), at, **kw)
        self.live.append(r)
        return r

    @staticmethod
    def fingerprint(r):
        return (r.financial_digest(), accounting_digest(r.portfolio), r.portfolio.ledger_hash(), r.executor.ledger_hash(),
                [a["hash"] for a in r.portfolio.adjustments], [x["hash"] for x in r.portfolio.reclassifications],
                [(e["kind"], e["delta_usd"]) for e in r.portfolio.capital_log])

    def states(self, r):
        return [(o["product_id"], o["state"], tuple(o.get("reasons", ()))) for o in r.orders()]

    def assertAudit(self, r):
        result = integrated_audit(r)
        self.assertEqual(result["violations"], [], result["violations"])


# ------------------------------------------------------------------------------------------------ scenarios 1-12
class Battery(Fin):
    def long_and_short(self):
        return {"a": {(BTC, CYCLE): BUY, (ETH, CYCLE): SELL}}

    def open_both(self, r):
        f = self.f
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.cycle(CYCLE + 3 * SEC, ETH), f.quote(BTC, CYCLE + 6 * SEC, "100010"),
               f.quote(ETH, CYCLE + 7 * SEC, "3500")])

    def test_01_a_long_opens_and_closes_at_its_target(self):
        path, r = self.start(self.long_and_short())
        self.open_both(r)
        r.run([self.f.candle(BTC, CYCLE + MIN, 100010, 100100, 99900, 100010), self.f.candle(BTC, CYCLE + 2 * MIN, 100010, 103500, 100000, 103400)])
        [trade] = [t for t in r.portfolio.trades if t["product_id"] == BTC]
        self.assertEqual((trade["side"], trade["exit_reason"]), ("LONG", "target"))
        self.assertGreater(trade["pnl_usd"], 0)
        self.assertAudit(r)

    def test_02_a_short_opens_and_closes_at_its_stop(self):
        path, r = self.start(self.long_and_short())
        self.open_both(r)
        r.run([self.f.candle(ETH, CYCLE + MIN, 3500, 3510, 3490, 3500), self.f.candle(ETH, CYCLE + 2 * MIN, 3500, 3700, 3499, 3690)])
        [trade] = [t for t in r.portfolio.trades if t["product_id"] == ETH]
        self.assertEqual((trade["side"], trade["exit_reason"]), ("SHORT", "stop"))
        self.assertLess(trade["pnl_usd"], 0)
        self.assertAudit(r)

    def test_03_two_strategies_compete_for_the_same_capital(self):
        path, r = self.start({"a": {(BTC, CYCLE): BUY, (ETH, CYCLE): BUY}, "b": {(SOL, CYCLE): BUY}}, ids=("a", "b"))
        f = self.f
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.cycle(CYCLE + 3 * SEC, ETH), f.cycle(CYCLE + 4 * SEC, SOL),
               f.quote(BTC, CYCLE + 6 * SEC, "100010"), f.quote(ETH, CYCLE + 7 * SEC, "3500"), f.quote(SOL, CYCLE + 8 * SEC, "180")])
        self.assertEqual(self.states(r), [(BTC, "opened", ()), (ETH, "opened", ()), (SOL, "rejected", ("open_risk_limit",))])
        self.assertAudit(r)

    def test_04_two_contradictory_signals_on_one_product_open_nothing(self):
        path, r = self.start({"a": {(BTC, CYCLE): BUY}, "b": {(BTC, CYCLE): SELL}}, ids=("a", "b"))
        r.run([self.f.cycle(CYCLE + 2 * SEC, BTC), self.f.quote(BTC, CYCLE + 6 * SEC, "100010")])
        self.assertEqual(sorted(x[1:] for x in self.states(r)), [("rejected", ("contradictory_signals",))] * 2)
        self.assertEqual(len(r.portfolio.positions), 0)

    def test_05_a_signal_stays_pending_until_a_quote_arrives(self):
        path, r = self.start(self.long_and_short())
        r.run([self.f.cycle(CYCLE + 2 * SEC, BTC)])
        self.assertEqual([o["state"] for o in r.orders()], ["pending"])
        self.assertEqual(len(r.portfolio.positions), 0)
        self.assertEqual(r.report()["state"]["runner"], "processing")

    def test_06_a_signal_expires_before_it_can_execute(self):
        path, r = self.start(self.long_and_short())
        r.run([self.f.cycle(CYCLE + 2 * SEC, BTC), make_event("clock", {}, t_ms=CYCLE + 5 * MIN, source="operator")])
        self.assertEqual(self.states(r), [(BTC, "expired", ("no_quote_in_window",))])
        self.assertEqual(len(r.portfolio.positions), 0)

    def test_07_a_loss_larger_than_planned_lowers_capital_and_the_next_budget(self):
        path, r = self.start({"a": {(ETH, CYCLE): BUY, (SOL, C2): BUY}})
        f, p = self.f, r.portfolio
        r.run([f.cycle(CYCLE + 2 * SEC, ETH), f.quote(ETH, CYCLE + 6 * SEC, "3500"), f.quote(ETH, CYCLE + 20 * SEC, "3300")])
        [trade] = p.trades
        planned = D(str(trade["planned_loss_usd"]))
        self.assertGreater(-D(str(trade["pnl_usd"])), planned * D("1.3"))
        self.assertLess(p.capital_usd(), D(1000) - planned)
        self.assertEqual(p.risk_budget_usd(), p.capital_usd() * D("0.01"))
        self.assertGreater(D(p.drawdown_usd()), planned)
        self.assertAudit(r)

    def test_08_a_position_closes_by_stop_between_candles_exactly_once(self):
        path, r = self.start({"a": {(BTC, CYCLE): BUY}})
        f = self.f
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.quote(BTC, CYCLE + 10 * SEC, "100010"), f.quote(BTC, CYCLE + 25 * SEC, "97800"),
               f.candle(BTC, CYCLE, 100000, 100200, 97500, 97900), f.candle(BTC, CYCLE + MIN, 97900, 98000, 97800, 97900)])
        [trade] = r.portfolio.trades
        self.assertEqual((trade["exit_time_ms"], trade["exit_reason"]), (CYCLE + 25 * SEC, "stop"))
        self.assertEqual(len(r.portfolio.trades), 1)
        self.assertAudit(r)

    def suspended_session(self, r):
        """ETH loses far more than planned (daily-loss suspension) while a BTC long is still open."""
        f = self.f
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.cycle(CYCLE + 3 * SEC, ETH), f.quote(BTC, CYCLE + 6 * SEC, "100010"),
               f.quote(ETH, CYCLE + 7 * SEC, "3500"), f.quote(ETH, CYCLE + 20 * SEC, "3000")])

    def test_09_a_suspension_blocks_entries_but_not_closes(self):
        path, r = self.start({"a": {(BTC, CYCLE): BUY, (ETH, CYCLE): BUY, (SOL, C3): BUY}})
        f = self.f
        self.suspended_session(r)
        self.assertTrue(r.portfolio.suspension_state(r.clock)["daily_loss"])
        self.assertEqual(list(r.portfolio.positions), [BTC])
        r.run([f.cycle(C3 + 2 * SEC, SOL, at=C3), f.quote(SOL, C3 + 6 * SEC, "180")])
        self.assertEqual(self.states(r)[-1], (SOL, "rejected", ("suspended_daily_loss",)))
        r.run([f.candle(BTC, C3 + MIN, 100010, 100100, 99900, 100010), f.candle(BTC, C3 + 2 * MIN, 100010, 103500, 100000, 103400)])
        self.assertEqual(r.portfolio.positions, {})                                       # the close went through
        self.assertEqual([t["exit_reason"] for t in r.portfolio.trades], ["stop", "target"])
        self.assertTrue(r.portfolio.suspension_state(r.clock)["daily_loss"])
        self.assertEqual(r.report()["state"]["suspended_entries"]["daily_loss"], True)
        self.assertAudit(r)

    def late_funding_session(self):
        path, r = self.start({"a": {(BTC, CYCLE): BUY}}, config=RunnerConfig(funding=(), start_ms=CYCLE - HOUR))
        f = self.f
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.quote(BTC, CYCLE + 6 * SEC, "100010"),
               f.candle(BTC, CYCLE + MIN, 100010, 100100, 99900, 100010), f.candle(BTC, CYCLE + 2 * MIN, 100010, 103500, 100000, 103400)])
        return path, r

    def test_10_funding_arrives_after_the_close(self):
        path, r = self.late_funding_session()
        p = r.portfolio
        self.assertEqual(p.snapshot()["complete_trades"], 0)
        self.assertGreater(D(p.snapshot()["provisional_gains_usd"]), 0)
        self.assertEqual(p.capital_usd(), D(1000))                                         # a provisional gain is not usable
        out = r.handle(self.f.funding(CYCLE + HOUR + 5 * MIN, BTC, [[CYCLE - HOUR, CYCLE + HOUR, "0.0001"]]))
        self.assertEqual(out["status"], "accepted")
        self.assertEqual(p.snapshot()["complete_trades"], 1)
        self.assertGreater(p.capital_usd(), D(1000))
        self.assertEqual(len(p.adjustments), 1)
        self.assertEqual([e["kind"] for e in r.journal.entries[-2:]], ["event_accepted", "reconciliation"])
        self.assertAudit(r)

    def test_11_a_dispute_keeps_a_gain_out_of_the_usable_capital(self):
        path, r = self.late_funding_session()
        p = r.portfolio
        r.handle(self.f.funding(CYCLE + HOUR + 5 * MIN, BTC, [[CYCLE - HOUR, CYCLE + HOUR, "0.0001"], [CYCLE - HOUR, CYCLE + HOUR, "0.0003"]]))
        self.assertIn(BTC, p.funding_conflicts)                                            # both versions quarantined
        self.assertEqual(p.snapshot()["complete_trades"], 0)
        self.assertEqual(p.capital_usd(), D(1000))                                         # the gain stays provisional
        self.assertEqual(len(p.adjustments), 0)
        self.assertEqual(r.report()["sections"]["uncertain"]["data"]["funding"]["disputed"], sorted(p.funding_disputes))
        self.assertAudit(r)

    def test_12_a_later_dispute_reclassifies_capital_once(self):
        path, r = self.late_funding_session()
        p, f = r.portfolio, self.f
        r.handle(f.funding(CYCLE + HOUR + 5 * MIN, BTC, [[CYCLE - HOUR, CYCLE + HOUR, "0.0001"]]))
        gained = p.capital_usd()
        self.assertGreater(gained, D(1000))
        r.handle(f.funding(CYCLE + HOUR + 6 * MIN, BTC, [[CYCLE - HOUR, CYCLE + HOUR, "0.0002"]]))
        self.assertEqual(p.capital_usd(), D(1000))
        self.assertEqual(len(p.reclassifications), 1)
        r.handle(f.funding(CYCLE + HOUR + 7 * MIN, BTC, [[CYCLE - HOUR, CYCLE + HOUR, "0.0004"]]))      # more disputed data
        self.assertEqual(len(p.reclassifications), 1)
        self.assertEqual([e["kind"] for e in p.capital_log].count("funding_dispute_reclassified"), 1)
        self.assertEqual(r.handle(f.funding(CYCLE + HOUR + 8 * MIN, BTC, [[CYCLE - HOUR, CYCLE + HOUR, "0.0001"]]))["status"], "accepted")
        self.assertEqual(p.capital_usd(), D(1000))                                         # the quarantine is never silently lifted
        self.assertAudit(r)

    def test_funding_that_is_not_settled_or_malformed_is_rejected_by_the_period_not_the_event(self):
        path, r = self.late_funding_session()
        r.handle(self.f.funding(CYCLE + HOUR + 5 * MIN, BTC, [[CYCLE - HOUR, CYCLE + 9 * HOUR, "0.0001"], ["x", 1, 2], [1, 2]]))
        self.assertEqual(r.stats["funding_rejected"], 3)
        self.assertEqual(r.portfolio.snapshot()["complete_trades"], 0)
        bad = self.f.funding(CYCLE + HOUR + 6 * MIN, BTC, [[CYCLE - HOUR, CYCLE + HOUR, "0.0001"]])
        bad["payload"]["periods"] = "not a list"
        self.assertEqual(r.handle(bad)["reason"], "invalid_event")


# ------------------------------------------------------------------------------------------------ scenarios 13-23
class Crashes(Fin):
    """Cases 13 to 17 and D, E, F: the process dies, another one recovers at the logical time of the event that was
    being processed, everything is delivered again and the books must equal the uninterrupted run."""

    def session_open_close(self):
        f = Feed()
        return [f.cycle(CYCLE + 2 * SEC, BTC), f.quote(BTC, CYCLE + 6 * SEC, "100010"),
                f.candle(BTC, CYCLE + MIN, 100010, 100100, 99900, 100010), f.candle(BTC, CYCLE + 2 * MIN, 100010, 103500, 100000, 103400),
                f.funding(CYCLE + HOUR + 5 * MIN, BTC, [[CYCLE - HOUR, CYCLE + HOUR, "0.0001"]]),
                f.funding(CYCLE + HOUR + 6 * MIN, BTC, [[CYCLE - HOUR, CYCLE + HOUR, "0.0002"]])]

    def setup_run(self, name):
        return self.start({"a": {(BTC, CYCLE): BUY}}, name=name, config=RunnerConfig(funding=(), start_ms=CYCLE - HOUR))

    def reference(self, events):
        path, r = self.setup_run("ref{}".format(len(os.listdir(self.dir))))
        r.run(events)
        return self.fingerprint(r), r

    def crash(self, events, point, kind, nth=1):
        path, r = self.setup_run("c{}".format(len(os.listdir(self.dir))))
        ST.arm(point, nth, kind)
        at = None
        for event in events:
            try:
                r.handle(event)
            except SC.SimulatedCrash:
                at = event["t_ms"]
                break
        ST.disarm()
        SC.disarm()
        self.assertIsNotNone(at, "{} {} never fired".format(point, kind))
        r2 = self.reopen(path, at)
        r2.run(events)
        return path, r2

    def check(self, point, kind, nth=1):
        events = self.session_open_close()
        want, ref = self.reference(events)
        path, r2 = self.crash(events, point, kind, nth)
        self.assertEqual(self.fingerprint(r2), want, "{} {} #{}".format(point, kind, nth))
        p, q = r2.portfolio, ref.portfolio
        self.assertEqual((len(p.trades), len(p.positions), len(p.adjustments), len(p.reclassifications)),
                         (len(q.trades), len(q.positions), len(q.adjustments), len(q.reclassifications)))
        self.assertEqual(sum(D(str(t["fees_usd"])) for t in p.trades), sum(D(str(t["fees_usd"])) for t in q.trades))
        self.assertEqual(r2.integrity()["unprocessed_events"], 0)
        self.assertAudit(r2)
        again = self.reopen(path, r2.clock + 1)
        self.assertEqual(again.financial_digest(), r2.financial_digest())
        return r2

    def test_13_the_process_dies_before_opening(self):
        self.check("after_journal", "decision")
        self.setUp()
        self.check("before_journal", "decision")

    def test_14_the_process_dies_after_opening(self):
        self.check("after_apply", "event_accepted", 2)           # the quote that opens the position
        self.setUp()
        self.check("after_journal", "event_accepted", 2)

    def test_15_the_process_dies_after_closing(self):
        for point in ("after_journal", "after_apply"):
            for nth in (3, 4):                                    # the two candles; the second one closes the position
                with self.subTest(point=point, nth=nth):
                    self.setUp()
                    self.check(point, "event_accepted", nth)

    def test_case_d_after_the_close_the_result_is_recorded_once(self):
        r2 = self.check("after_apply", "event_accepted", 4)
        [trade] = r2.portfolio.trades
        self.assertEqual(trade["exit_reason"], "target")
        self.assertEqual([e["kind"] for e in r2.portfolio.capital_log].count("trade_closed"), 1)

    def test_16_the_process_dies_during_a_funding_reconciliation_case_e(self):
        for point, kind in (("before_journal", "reconciliation"), ("after_journal", "reconciliation"), ("after_apply", "reconciliation"),
                            ("mid_journal", "reconciliation"), ("after_journal", "event_accepted")):
            with self.subTest(point=point, kind=kind):
                self.setUp()
                nth = 1 if kind == "reconciliation" else 5
                r2 = self.check(point, kind, nth)
                self.assertEqual(len(r2.portfolio.adjustments), 1)

    def test_case_e_a_funding_event_without_its_reconciliation_leaves_an_obligation_paid_at_recovery(self):
        events = self.session_open_close()
        path, r = self.setup_run("obl")
        ST.arm("before_journal", 1, "reconciliation")
        with self.assertRaises(SC.SimulatedCrash):
            r.run(events)
        ST.disarm()
        self.assertEqual(len(r.portfolio.adjustments), 0)
        r2 = self.reopen(path, CYCLE + HOUR + 5 * MIN)
        self.assertEqual([o["obligation"] for o in r2.last_recovery["obligations"]], ["reconciliation_pending"])
        self.assertEqual(len(r2.portfolio.adjustments), 1)
        self.assertEqual(r2.integrity()["unprocessed_events"], 0)
        self.assertEqual(r2.last_recovery["obligations"][0]["obligation"], "reconciliation_pending")

    def test_case_f_the_process_dies_during_a_reclassification_for_disputed_funding(self):
        for point, kind, nth in (("after_journal", "event_accepted", 6), ("after_apply", "event_accepted", 6),
                                 ("before_journal", "reconciliation", 2), ("after_journal", "reconciliation", 2),
                                 ("mid_journal", "event_accepted", 6)):
            with self.subTest(point=point, kind=kind, nth=nth):
                self.setUp()
                r2 = self.check(point, kind, nth)
                p = r2.portfolio
                self.assertEqual(len(p.reclassifications), 1)
                self.assertEqual([e["kind"] for e in p.capital_log].count("funding_dispute_reclassified"), 1)
                self.assertEqual(p.capital_usd(), D(1000))                                    # the gain left the usable capital once

    def test_several_interruptions_across_the_whole_financial_path(self):
        events = self.session_open_close()
        want, _ = self.reference(events)
        path, r = self.setup_run("multi")
        at = events[0]["t_ms"]
        for point, kind in (("after_journal", "decision"), ("after_apply", "event_accepted"), ("after_journal", "reconciliation"),
                            ("before_journal", "event_accepted")):
            ST.arm(point, 1, kind)
            try:
                for event in events:
                    at = event["t_ms"]
                    r.handle(event)
            except SC.SimulatedCrash:
                pass
            ST.disarm()
            SC.disarm()
            r = self.reopen(path, at)
        r.run(events)
        self.assertEqual(self.fingerprint(r), want)

    def test_17_the_same_session_in_independent_processes_gives_the_same_books(self):
        import tempfile as T
        work = T.mkdtemp()
        self.addCleanup(shutil.rmtree, work, True)
        result = DEMO.compare(work)
        self.assertTrue(result["all_identical"], result["identical"])
        self.assertEqual(len(result["recovered"]["history"]), 4)
        self.assertEqual(result["continuous"]["audit"], [])
        self.assertEqual(result["recovered"]["audit"], [])
        self.assertEqual(result["recovered"]["recoveries"], 4)

    def test_18_a_duplicate_event_does_not_duplicate_anything(self):
        events = self.session_open_close()
        want, ref = self.reference(events)
        before = ref.financial_digest()
        results = ref.run(events)
        self.assertTrue(all(x["reason"] == "duplicate_event" for x in results))
        self.assertEqual(ref.financial_digest(), before)
        self.assertEqual(self.fingerprint(ref), want)

    def test_19_a_corrupt_checkpoint_is_not_accepted_silently(self):
        events = self.session_open_close()
        path, r = self.setup_run("g")
        r.run(events)
        r.checkpoint()
        with open(os.path.join(path, ST.CHECKPOINT_FILE), "w") as handle:
            handle.write("{broken")
        with self.assertRaises(RunnerError) as caught:
            self.reopen(path, r.clock + 1)
        self.assertEqual(caught.exception.reason, "corrupt_checkpoint")
        self.assertEqual(len(os.listdir(os.path.join(path, ST.QUARANTINE_DIR))), 1)

    def test_20_a_historically_reconstructed_signal_never_opens_a_position(self):
        path, r = self.setup_run("recon")
        template = make_signal(strategy_id="a", strategy_version=1, product_id=BTC, bucket_ms=CYCLE - 10 * 5 * MIN, action="BUY",
                               strength="0.8", horizon_minutes=60, evidence={})
        out = r.handle(make_event("reconstructed", {"signal": template, "inputs": {"x": "1"}}, t_ms=CYCLE + 2 * SEC, source="audit"))
        self.assertIn(out["status"], ("accepted", "rejected"))
        r.run([Feed().quote(BTC, CYCLE + 6 * SEC, "100010")])
        self.assertEqual(len(r.portfolio.positions), 0)
        self.assertEqual(r.orders(), [])
        self.assertEqual(r.stats.get("decisions", 0), 0)

    def test_21_a_hole_in_the_events_is_not_declared_recovered_without_evidence(self):
        path, r = self.setup_run("hole")
        f = Feed()
        events = [f.quote(BTC, CYCLE + 6 * SEC, "100010"), f.quote(BTC, CYCLE + 7 * SEC, "100011"), f.quote(BTC, CYCLE + 8 * SEC, "100012")]
        r.run([events[0], events[2]] if False else [events[0]])
        skipped = make_event("quote", dict(events[2]["payload"]), t_ms=events[2]["t_ms"], source=SRC, stream="quotes", source_offset=3)
        r.handle(skipped)
        self.assertEqual(r.integrity()["offset_holes"], 1)
        r2 = self.reopen(path, r.clock)
        self.assertEqual(r2.integrity()["offset_holes"], 1)                                   # recovery does not make it disappear
        self.assertEqual(r2.integrity()["confirmable_offsets"][SRC + "|quotes#0"], 1)
        self.assertEqual(r2.handle(Feed().reconcile(r2.clock + 1))["status"], "accepted")
        self.assertEqual(r2.integrity()["offset_holes"], 1)
        self.assertTrue(any(a["code"] == "offset_holes" for a in r2.report()["alerts"]))

    def test_22_a_restart_keeps_the_suspensions_and_the_pending_obligations(self):
        script = {"a": {(BTC, CYCLE): BUY, (ETH, CYCLE): BUY, (SOL, C3): BUY}}
        path, r = self.start(script, name="susp")
        f = self.f
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.cycle(CYCLE + 3 * SEC, ETH), f.quote(BTC, CYCLE + 6 * SEC, "100010"),
               f.quote(ETH, CYCLE + 7 * SEC, "3500"), f.quote(ETH, CYCLE + 20 * SEC, "3000")])
        self.assertTrue(r.portfolio.suspension_state(r.clock)["daily_loss"])
        late = f.cycle(C3 + 2 * SEC, SOL, at=C3)
        ST.arm("before_journal", 1, "decision")
        with self.assertRaises(SC.SimulatedCrash):
            r.handle(late)
        ST.disarm()
        r2 = self.reopen(path, C3 + 2 * SEC)
        self.assertEqual([o["obligation"] for o in r2.last_recovery["obligations"]], ["decision_pending"])
        self.assertTrue(r2.portfolio.suspension_state(r2.clock)["daily_loss"])
        self.assertEqual([o["state"] for o in r2.orders() if o["product_id"] == SOL], ["pending"])                       # decided at recovery, not in the past
        r2.run([f.quote(SOL, C3 + 6 * SEC, "180")])
        self.assertEqual(self.states(r2)[-1], (SOL, "rejected", ("suspended_daily_loss",)))
        self.assertEqual(list(r2.portfolio.positions), [BTC])                                   # the open position survived
        r2.run([f.candle(BTC, C3 + MIN, 100010, 100100, 99900, 100010), f.candle(BTC, C3 + 2 * MIN, 100010, 103500, 100000, 103400)])
        self.assertEqual(r2.portfolio.positions, {})                                           # and it could close while suspended
        late_funding = f.funding(C3 + HOUR, ETH, [[CYCLE - HOUR, C3 + MIN, "0.0001"]])
        self.assertEqual(r2.handle(late_funding)["status"], "accepted")                         # funding is not blocked either
        self.assertAudit(r2)

    def test_23_a_position_open_during_an_interruption_keeps_its_state_and_records_the_lack_of_coverage(self):
        path, r = self.setup_run("cov")
        f = Feed()
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.quote(BTC, CYCLE + 6 * SEC, "100010"), f.quote(BTC, CYCLE + 20 * SEC, "100020")])
        book = r.portfolio.positions[BTC]
        before = (book.position["entry"], book.intent["stop"], book.intent["target"], book.notional, book.funding)
        self.assertEqual(r.report()["sections"]["uncertain"]["data"]["market_coverage"][0]["stop_protection"], "observed")
        r2 = self.reopen(path, CYCLE + 20 * MIN)                      # twenty minutes without anybody watching
        book2 = r2.portfolio.positions[BTC]
        self.assertEqual((book2.position["entry"], book2.intent["stop"], book2.intent["target"], book2.notional, book2.funding), before)
        [gap] = r2.coverage["gaps"]
        self.assertEqual((gap["product_id"], gap["kind"], gap["from_ms"], gap["to_ms"]), (BTC, "runner_interrupted", CYCLE + 20 * SEC, CYCLE + 20 * MIN))
        report = r2.report()
        self.assertEqual(report["sections"]["uncertain"]["data"]["market_coverage"][0]["stop_protection"], "unobserved")
        self.assertIn("insufficient_market_data", [a["code"] for a in report["alerts"]])
        self.assertTrue(report["state"]["degraded"])
        self.assertEqual(r2.last_recovery["open_positions"], [BTC])
        # a quote after the restart does not make the interruption "protected"
        r2.run([f.quote(BTC, CYCLE + 20 * MIN + 5 * SEC, "100030")])
        self.assertEqual(r2.report()["sections"]["uncertain"]["data"]["market_coverage"][0]["stop_protection"], "unobserved")
        self.assertEqual(len([g for g in r2.coverage["gaps"] if g["kind"] == "quote_gap"]), 0)     # the same silence is not counted twice

    def test_a_silence_with_an_open_position_is_a_quote_gap(self):
        path, r = self.setup_run("silence")
        f = Feed()
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.quote(BTC, CYCLE + 6 * SEC, "100010"), f.quote(BTC, CYCLE + 10 * MIN, "100020")])
        [gap] = r.coverage["gaps"]
        self.assertEqual((gap["kind"], gap["from_ms"], gap["to_ms"]), ("quote_gap", CYCLE + 6 * SEC, CYCLE + 10 * MIN))
        self.assertEqual(r.report()["sections"]["uncertain"]["data"]["market_coverage"][0]["stop_protection"], "unobserved")


# ------------------------------------------------------------------------------------------------ contract and audit
class Contract(Fin):
    def finished(self):
        path, r = self.start({"a": {(BTC, CYCLE): BUY, (ETH, CYCLE): SELL}})
        f = self.f
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.cycle(CYCLE + 3 * SEC, ETH), f.quote(BTC, CYCLE + 6 * SEC, "100010"),
               f.quote(ETH, CYCLE + 7 * SEC, "3500"), f.candle(BTC, CYCLE + MIN, 100010, 100100, 99900, 100010),
               f.candle(BTC, CYCLE + 2 * MIN, 100010, 103500, 100000, 103400),
               f.candle(ETH, CYCLE + MIN, 3500, 3510, 3490, 3500), f.candle(ETH, CYCLE + 2 * MIN, 3500, 3700, 3499, 3690)])
        return path, r

    def test_the_contract_is_versioned_and_every_section_has_one_class(self):
        path, r = self.finished()
        report = r.report()
        self.assertEqual(report["schema"], CONTRACT)
        self.assertEqual(report["classes"], list(CLASSES))
        self.assertEqual(sorted(report["sections"]), sorted(CLASSES))
        for name, section in report["sections"].items():
            self.assertEqual(section["class"], name)
        self.assertEqual(report["state"]["runner"], "processing")
        self.assertEqual(report["state"]["mode"], "OFFLINE / PAPER")
        self.assertIn("experimental", report["labels"]["policies"])
        json.dumps(report)                                                                   # serialisable as it is

    def test_each_decision_carries_what_the_contract_promises(self):
        path, r = self.finished()
        rows = r.report()["sections"]["simulated"]["data"]["decisions"]
        self.assertEqual(len(rows), 2)
        for key in ("decided_ms", "product_id", "strategy_id", "signal_key", "side", "state", "reasons", "reference_price",
                    "executable_price", "stop", "target", "notional_usd", "planned_loss_usd", "portfolio_at_decision", "result",
                    "pnl_usd", "funding"):
            self.assertIn(key, rows[0])
        self.assertEqual({row["result"] for row in rows}, {"closed"})
        self.assertEqual(rows[0]["funding"]["status"], "complete")

    def test_uncertain_things_stay_visible_and_are_not_in_the_usable_capital(self):
        path, r = self.start({"a": {(BTC, CYCLE): BUY}}, config=RunnerConfig(funding=(), start_ms=CYCLE - HOUR))
        f = self.f
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.quote(BTC, CYCLE + 6 * SEC, "100010"),
               f.candle(BTC, CYCLE + MIN, 100010, 100100, 99900, 100010), f.candle(BTC, CYCLE + 2 * MIN, 100010, 103500, 100000, 103400)])
        data = r.report()["sections"]
        self.assertEqual(len(data["uncertain"]["data"]["funding"]["incomplete"]), 1)
        self.assertEqual(len(data["estimated"]["data"]["provisional_trades"]), 1)
        self.assertGreater(D(data["estimated"]["data"]["provisional_gains_usd"]), 0)
        self.assertEqual(D(data["simulated"]["data"]["portfolio"]["capital_definitive_usd"]), D(1000))
        self.assertIn("funding_incomplete", [a["code"] for a in r.report()["alerts"]])

    def test_alerts_name_what_a_person_must_look_at(self):
        path, r = self.start({"a": {(BTC, CYCLE): BUY}}, config=RunnerConfig(funding=(), start_ms=CYCLE - HOUR))
        f = self.f
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.quote(BTC, CYCLE + 6 * SEC, "100010"),
               f.candle(BTC, CYCLE + MIN, 100010, 100100, 99900, 100010), f.candle(BTC, CYCLE + 2 * MIN, 100010, 103500, 100000, 103400),
               f.funding(CYCLE + HOUR + 5 * MIN, BTC, [[CYCLE - HOUR, CYCLE + HOUR, "0.0001"], [CYCLE - HOUR, CYCLE + HOUR, "0.0009"]])])
        codes = [a["code"] for a in r.report()["alerts"]]
        self.assertIn("funding_conflict", codes)
        self.assertNotIn("accounting_discrepancy", codes)
        self.assertTrue(r.report()["state"]["degraded"])

    def test_the_summary_block_comes_from_the_engine(self):
        path, r = self.finished()
        r.finish()
        text = summary_block(r)
        for needle in ("BALANCITA PAPER RUNNER", "Estado:                    FINALIZADO", "Modo:                      OFFLINE / PAPER",
                       "Capital inicial:           1000.00 USD", "Señales generadas:         2", "Operaciones cerradas:      2",
                       "Violaciones contables:     0", "Hash ejecución continua:", "Hash ejecución recuperada:"):
            self.assertIn(needle, text)


class AuditDetectsDamage(Fin):
    """The audit is only worth something if it fails when the books are wrong."""

    def books(self):
        path, r = self.start({"a": {(BTC, CYCLE): BUY, (ETH, CYCLE): SELL}})
        f = self.f
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.cycle(CYCLE + 3 * SEC, ETH), f.quote(BTC, CYCLE + 6 * SEC, "100010"),
               f.quote(ETH, CYCLE + 7 * SEC, "3500"), f.candle(BTC, CYCLE + MIN, 100010, 100100, 99900, 100010),
               f.candle(BTC, CYCLE + 2 * MIN, 100010, 103500, 100000, 103400),
               f.candle(ETH, CYCLE + MIN, 3500, 3510, 3490, 3500), f.candle(ETH, CYCLE + 2 * MIN, 3500, 3700, 3499, 3690)])
        self.assertAudit(r)
        return path, r

    def rules(self, r):
        return {v["rule"] if isinstance(v, dict) and "rule" in v else str(v) for v in integrated_audit(r)["violations"]}

    def test_a_duplicated_trade_is_detected(self):
        path, r = self.books()
        r.portfolio.trades.append(copy.deepcopy(r.portfolio.trades[0]))
        self.assertTrue(self.rules(r))

    def test_a_tampered_pnl_is_detected(self):
        path, r = self.books()
        r.portfolio.trades[0]["pnl_usd"] = r.portfolio.trades[0]["pnl_usd"] + 5
        self.assertTrue(self.rules(r))

    def test_a_reconciliation_without_its_capital_event_is_detected(self):
        path, r = self.start({"a": {(BTC, CYCLE): BUY}}, config=RunnerConfig(funding=(), start_ms=CYCLE - HOUR))
        f = self.f
        r.run([f.cycle(CYCLE + 2 * SEC, BTC), f.quote(BTC, CYCLE + 6 * SEC, "100010"),
               f.candle(BTC, CYCLE + MIN, 100010, 100100, 99900, 100010), f.candle(BTC, CYCLE + 2 * MIN, 100010, 103500, 100000, 103400),
               f.funding(CYCLE + HOUR + 5 * MIN, BTC, [[CYCLE - HOUR, CYCLE + HOUR, "0.0001"]])])
        self.assertAudit(r)
        r.portfolio.capital_log[:] = [e for e in r.portfolio.capital_log if e["kind"] != "funding_reconciled"]
        self.assertTrue(self.rules(r))

    def test_a_decision_without_an_order_is_detected(self):
        path, r = self.books()
        r.executor.records.pop()
        self.assertIn("decisions_not_matched_by_orders", self.rules(r))

    def test_an_order_opened_without_a_position_or_trade_is_detected(self):
        path, r = self.books()
        r.portfolio.trades.pop()
        self.assertIn("opened_orders_do_not_match_positions", self.rules(r))

    def test_a_broken_journal_chain_is_detected(self):
        path, r = self.books()
        r.journal.entries[2]["data"] = {"tampered": True}
        self.assertIn("journal_chain_broken", self.rules(r))

    def test_a_finished_run_with_open_obligations_is_detected(self):
        path, r = self.books()
        r.finish()
        r.open_funding["x"] = {"event": None, "stream": None}
        self.assertIn("finished_with_open_obligations", self.rules(r))

    def test_recovery_refuses_a_journal_whose_books_no_longer_replay_to_the_checkpoint(self):
        path, r = self.books()
        r.checkpoint()
        self.die()
        journal = os.path.join(path, ST.JOURNAL_FILE)
        with open(journal, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
        entry = json.loads(lines[4])
        entry["t_ms"] += 1                                   # a change the hash chain does not allow
        lines[4] = json.dumps(entry, sort_keys=True, separators=(",", ":"))
        with open(journal, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
        with self.assertRaises(RunnerError) as caught:
            self.reopen(path, r.clock + 1)
        self.assertEqual(caught.exception.reason, "journal_corrupt")


if __name__ == "__main__":
    unittest.main()
