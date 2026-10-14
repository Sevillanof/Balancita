"""Stage 10C: the session evaluator against the 9A replay. All data is synthetic (the 9A fixture database, built in a
temporary directory); no real database, no network, no wall clock, no reserved period."""

import json
import os
import shutil
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import paper_live_evaluator as LE
from balancita_engine import replay_data as RD
from balancita_engine import replay_driver as RP
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC
from balancita_engine.futures_simulator import FIVE_MINUTES_MS, ONE_MINUTE_MS
from balancita_engine.multi_signals import merged_indicators
from balancita_engine.paper_runner import PaperRunner, RunnerConfig
from balancita_engine.portfolio import PortfolioPolicy
from balancita_engine.portfolio_watch import WatchPolicy

try:
    from test_replay_9a import BTC, DAY, HOUR, MIN, START
    from test_replay_9a_audit import FIRST_DECISION, LAST_DECISION, fixture_db
except ImportError:           # run as python.tests.test_paper_live_evaluator
    from .test_replay_9a import BTC, DAY, HOUR, MIN, START
    from .test_replay_9a_audit import FIRST_DECISION, LAST_DECISION, fixture_db

D = Decimal
LOAD_START = FIRST_DECISION - 4 * DAY


class Fixture(unittest.TestCase):
    """The 37-day synthetic database, its replay run and the data both sides read (built once for the module)."""

    cache = {}

    @classmethod
    def setUpClass(cls):
        SC.disarm()
        if "dir" in cls.cache:
            return
        cls.cache["dir"] = tempfile.mkdtemp()
        db = os.path.join(cls.cache["dir"], "m.sqlite")
        fixture_db(db)
        config = RP.ReplayConfig(products=(BTC,), decision_start_ms=FIRST_DECISION, decision_end_ms=LAST_DECISION,
                                 scenario="S1", load_start_ms=LOAD_START)
        holder = {}
        cls.cache["results"] = RP.run_replay(db, db, config, os.path.join(cls.cache["dir"], "replay"),
                                             on_runner=lambda r: holder.update(runner=r))
        cls.cache["runner"] = holder["runner"]
        cls.cache["config"] = config.resolved()
        gate = RD.ReplayDataGate(db, LOAD_START, cls.cache["config"].data_end_ms)
        fgate = RD.ReplayDataGate(db, RD.LO_MS, cls.cache["config"].data_end_ms)
        cls.cache["ones"] = gate.candles(BTC, ONE_MINUTE_MS)
        cls.cache["fives"] = gate.candles(BTC, FIVE_MINUTES_MS)
        cls.cache["funding"] = fgate.relative_funding(BTC)
        gate.close()
        fgate.close()

    @classmethod
    def tearDownClass(cls):
        pass

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.strategies, self.spec_identity = RS.load_frozen()

    # ---- helpers ------------------------------------------------------------------------------------------
    @property
    def replay(self):
        return self.cache["results"]

    def stream(self, ones=None, funding=None):
        """Every input of the session in the order it arrives: funding hours at end + 10 min, candles at close + 2 s (the
        replay's rules), funding first on a tie."""
        items = [(s + HOUR + RP.FUNDING_LAG_MS, 0, "funding", (s, r)) for s, r in (funding or self.cache["funding"])]
        items += [(c["bucket_start"] + MIN + RP.DATA_LAG_MS, 1, "candle", c) for c in (ones or self.cache["ones"])]
        return sorted(items, key=lambda x: (x[0], x[1]))

    def head(self, candles):
        """The inputs up to and including the first ``candles`` candles (the funding history comes first)."""
        items, seen, out = self.stream(), 0, []
        for item in items:
            out.append(item)
            seen += 1 if item[2] == "candle" else 0
            if seen == candles:
                break
        return out

    def evaluator(self, name="eval.jsonl", **kw):
        return LE.LiveEvaluator.create(os.path.join(self.dir, name), self.strategies, (BTC,), decide_from_ms=FIRST_DECISION,
                                       decide_until_ms=LAST_DECISION, source=RP.SOURCE, **kw)

    def drive(self, ev, items, sink=None):
        """Feeds the inputs; returns the cycle events. ``sink`` receives every event for a runner, in arrival order."""
        cycles = []
        for arrival, _rank, kind, data in items:
            if kind == "funding":
                ev.feed_funding(BTC, data[0], data[1], arrival)
                continue
            out = ev.feed_candle(BTC, data, arrival)
            if sink is not None and data["bucket_start"] + MIN >= FIRST_DECISION - FIVE_MINUTES_MS:
                sink(RP._candle_event(BTC, data))
            if out["cycle"] is not None and not out["duplicate"]:
                cycles.append(out["cycle"])
                if sink is not None:
                    sink(out["cycle"])
        return cycles

    def runner_config(self):
        return RunnerConfig(portfolio=PortfolioPolicy(), execution=RP.execution_policy(), watch=WatchPolicy(), funding=(),
                            start_ms=FIRST_DECISION, execution_mode="modelled")

    def memory_runner(self, ev, name="signals.jsonl"):
        log = SC.SignalLog.create(os.path.join(self.dir, name), FIRST_DECISION)
        return PaperRunner(self.runner_config(), self.strategies, log, evaluator=ev.evaluator)

    @staticmethod
    def signal_ids(runner):
        return [e["data"]["signal"]["signal_id"] for e in runner.log.signals() if e["data"]["origin"] == "original"]


class TestParityWithTheReplay(Fixture):
    def reference_cycles(self):
        cfg = self.cache["config"]
        data = {"1m": self.cache["ones"], "5m": self.cache["fives"], "funding": self.cache["funding"],
                "_by_minute": {c["bucket_start"]: c for c in self.cache["ones"]}}
        cycle_atr = next(s.cycle_atr for s in self.strategies if hasattr(s, "cycle_atr"))
        return [e for _, e in RP.product_events(BTC, data, self.strategies, cfg, {}, cycle_atr, {}) if e["kind"] == "cycle"]

    def test_the_session_produces_the_replays_cycles_event_for_event(self):
        ev = self.evaluator()
        got = self.drive(ev, self.stream())
        want = self.reference_cycles()
        self.assertGreater(len(want), 200)
        self.assertEqual([e["payload"] for e in got], [e["payload"] for e in want])
        self.assertEqual([(e["t_ms"], e["event_id"]) for e in got], [(e["t_ms"], e["event_id"]) for e in want])
        self.assertEqual(ev.report()["gaps"], [])

    def test_the_session_aggregates_the_same_five_minute_bars_the_replay_reads(self):
        by_minute = {c["bucket_start"]: c for c in self.cache["ones"]}
        for bar in self.cache["fives"]:
            minutes = [by_minute[bar["bucket_start"] + i * MIN] for i in range(5)]
            mine = LE.aggregate_five(minutes)
            for key in ("bucket_start", "open", "high", "low", "close"):
                self.assertEqual(D(str(mine[key])), D(str(bar[key])), (bar["bucket_start"], key))
            self.assertEqual(D(mine["volume_btc"]), D(bar["volume_btc"]))
        report = RD.consistency_5m_vs_1m(self.cache["ones"], self.cache["fives"])
        self.assertEqual((report["mismatched"], report["incomplete"]), (0, 0))

    def test_the_frozen_strategies_give_the_same_signals_in_the_same_order(self):
        ev = self.evaluator()
        runner = self.memory_runner(ev)
        self.drive(ev, self.stream(), sink=runner.handle)
        mine = self.signal_ids(runner)
        theirs = [e["data"]["signal"]["signal_id"] for e in self.cache["runner"].log.signals() if e["data"]["origin"] == "original"]
        self.assertEqual(mine, theirs)
        self.assertGreater(len([s for s in runner.log.signals() if s["data"]["signal"]["action"] != "WAIT"]), 0)
        entries = [x for x in runner.log.signals() if x["data"]["origin"] == "original"]
        self.assertEqual(RP.stable_hash(sorted(mine)), self.replay["signals"]["set_hash"])
        self.assertEqual(RP.stable_hash(sorted(x["data"]["signal"]["signal_id"] for x in entries
                                              if x["data"]["signal"]["action"] != "WAIT")), self.replay["signals"]["entries_hash"])
        self.assertEqual(runner.stats.get("rejected:evaluation_failed", 0), 0)

    def test_decisions_follow_the_cycle_order_and_the_arrival_order_never_goes_back(self):
        ev = self.evaluator()
        seen = []
        runner = self.memory_runner(ev)
        self.drive(ev, self.stream(), sink=lambda e: (seen.append(e), runner.handle(e)))
        times = [e["t_ms"] for e in seen]
        self.assertEqual(times, sorted(times))
        cycles = [e["payload"]["cycle_ms"] for e in seen if e["kind"] == "cycle"]
        self.assertEqual(cycles, sorted(cycles))
        for index, event in enumerate(seen):                      # the candle that closes a cycle's bar came first
            if event["kind"] == "cycle":
                closing = event["payload"]["cycle_ms"] - MIN
                before = [e for e in seen[:index] if e["kind"] == "candle" and e["payload"]["bucket_ms"] == closing]
                self.assertEqual(len(before), 1)
        order = [(e["data"]["cycle_ms"], e["data"]["signal"]["strategy_id"]) for e in runner.log.signals()
                 if e["data"]["origin"] == "original"]
        self.assertEqual(order, sorted(order, key=lambda x: x[0]))

    def test_the_funding_audit_rows_match_the_replays(self):
        ev = self.evaluator()
        runner = self.memory_runner(ev)
        self.drive(ev, self.stream(), sink=runner.handle)
        diag = self.replay["funding_diagnostics"]["audit"]
        mine = RP.RFA.summarize(ev.audit_rows)
        self.assertEqual(mine, diag)

    def test_identity_names_the_same_strategies_data_pipeline_and_code(self):
        ev = self.evaluator()
        self.drive(ev, self.stream())
        identity = ev.identity(self.spec_identity)
        manifest = self.replay["manifest"]
        self.assertEqual({k: v["spec_hash"] for k, v in identity["strategies"].items()},
                         {k: v["spec_hash"] for k, v in manifest["spec_identity"].items()})
        self.assertEqual(identity["spec_files"], manifest["spec_identity"])
        self.assertEqual(identity["indicators"], {k: list(v) for k, v in sorted(merged_indicators(self.strategies).items())})
        self.assertEqual(identity["code"]["replay_pipeline"], RP.code_identity()["digest"])
        self.assertEqual(identity["input_log"]["entries"], len(ev.log.entries))
        self.assertEqual(self.evaluator("other.jsonl").identity()["digest"], ev.identity()["digest"])      # same config, same identity
        changed = LE.LiveEvaluator.create(os.path.join(self.dir, "c.jsonl"), self.strategies, (BTC,), decide_from_ms=FIRST_DECISION + DAY)
        self.assertNotEqual(changed.identity()["digest"], ev.identity()["digest"])


class TestNoLookahead(Fixture):
    CUT = FIRST_DECISION + 6 * HOUR

    def cycles_until(self, items, until):
        ev = self.evaluator("t{}.jsonl".format(len(os.listdir(self.dir))))
        got = self.drive(ev, [i for i in items if i[0] <= until])
        return [(e["payload"]["cycle_ms"], e["payload"]["price"], e["payload"]["atr"]) for e in got], ev

    def signals_until(self, items, until):
        ev = self.evaluator("s{}.jsonl".format(len(os.listdir(self.dir))))
        runner = self.memory_runner(ev, "sig{}.jsonl".format(len(os.listdir(self.dir))))
        self.drive(ev, [i for i in items if i[0] <= until], sink=runner.handle)
        return self.signal_ids(runner)

    def test_cutting_the_future_changes_nothing_about_the_past(self):
        items = self.stream()
        short, _ = self.cycles_until(items, self.CUT)
        full, _ = self.cycles_until(items, items[-1][0])
        self.assertGreater(len(short), 50)
        self.assertEqual(full[:len(short)], short)
        self.assertEqual(self.signals_until(items, items[-1][0])[:len(self.signals_until(items, self.CUT))],
                         self.signals_until(items, self.CUT))

    def test_changing_candles_after_a_cycle_does_not_change_that_cycle(self):
        ones = [dict(c) for c in self.cache["ones"]]
        cut_bucket = self.CUT - 40 * MIN
        for c in ones:
            if c["bucket_start"] > cut_bucket:
                for k in ("open", "high", "low", "close"):
                    c[k] = str((D(c[k]) * D("1.05")).quantize(D("0.1")))
        base, _ = self.cycles_until(self.stream(), self.CUT)
        changed, _ = self.cycles_until(self.stream(ones=ones), self.CUT)
        last_safe = cut_bucket + MIN
        self.assertEqual([c for c in base if c[0] <= last_safe], [c for c in changed if c[0] <= last_safe])
        self.assertNotEqual(base, changed)                                   # the probe does bite once the changed candles are in

    def test_a_funding_hour_published_after_a_cycle_does_not_reach_it(self):
        cycle_ms = FIRST_DECISION + 10 * HOUR                                # a 5-minute close
        hour = ((cycle_ms - RP.FUNDING_LAG_MS - HOUR) // HOUR) * HOUR + HOUR        # the first hour not yet published at the cycle
        funding = [(s, 0.5 if s == hour else r) for s, r in self.cache["funding"]]
        base_ev, changed_ev = self.evaluator("b.jsonl"), self.evaluator("c.jsonl")
        base = self.drive(base_ev, [i for i in self.stream() if i[0] <= cycle_ms + 2 * HOUR])
        changed = self.drive(changed_ev, [i for i in self.stream(funding=funding) if i[0] <= cycle_ms + 2 * HOUR])
        before = [(e["payload"]["cycle_ms"], e["payload"]["atr"]) for e in base if e["payload"]["cycle_ms"] <= cycle_ms]
        after = [(e["payload"]["cycle_ms"], e["payload"]["atr"]) for e in changed if e["payload"]["cycle_ms"] <= cycle_ms]
        self.assertEqual(before, after)
        flags = lambda ev: [ev.flags[(BTC, c)]["forward_percentile"] for c in sorted(k[1] for k in ev.flags) if c <= cycle_ms]   # noqa: E731
        self.assertEqual(flags(base_ev), flags(changed_ev))

    def test_a_late_funding_hour_is_reported_with_the_cycles_that_went_without_it(self):
        skipped = ((FIRST_DECISION + 10 * HOUR) // HOUR) * HOUR - 3 * HOUR
        funding = [(s, r) for s, r in self.cache["funding"] if s != skipped]
        ev = self.evaluator()
        items = self.stream(funding=funding)
        late_at = skipped + HOUR + RP.FUNDING_LAG_MS + 3 * HOUR
        self.drive(ev, [i for i in items if i[0] <= late_at])
        ev.feed_funding(BTC, skipped, dict(self.cache["funding"])[skipped], late_at)
        report = ev.report()["late_funding"]
        self.assertEqual(len(report), 1)
        self.assertEqual(report[0]["hour_ms"], skipped)
        self.assertGreater(report[0]["cycles_evaluated_without_it"], 0)
        self.assertEqual(report[0]["arrival_ms"] - report[0]["due_ms"], 3 * HOUR)


class TestRecoveryAndGaps(Fixture):
    def uninterrupted(self):
        ev = self.evaluator("whole.jsonl")
        runner = self.memory_runner(ev, "whole-signals.jsonl")
        cycles = self.drive(ev, self.stream(), sink=runner.handle)
        return cycles, self.signal_ids(runner), ev

    def test_recovering_from_the_input_log_gives_the_same_cycles_and_signals(self):
        items = self.stream()
        want_cycles, want_signals, whole = self.uninterrupted()
        cut = len(items) // 2 + 137
        ev = self.evaluator("cut.jsonl")
        first = self.drive(ev, items[:cut])
        again = LE.LiveEvaluator.recover(os.path.join(self.dir, "cut.jsonl"), self.strategies, source=RP.SOURCE)
        second = self.drive(again, items[cut:])
        self.assertEqual([e["event_id"] for e in first + second], [e["event_id"] for e in want_cycles])
        self.assertEqual(again.identity()["digest"], whole.identity()["digest"])
        self.assertEqual(again.log.head, whole.log.head)

    def test_a_candle_handed_in_again_returns_the_same_cycle_and_nothing_new(self):
        items = self.stream()
        ev = self.evaluator()
        part = self.head(6000)
        cycles = self.drive(ev, part)
        last = [e for e in cycles][-1]
        closing = next(i for i in part if i[2] == "candle" and i[3]["bucket_start"] == last["payload"]["cycle_ms"] - MIN)
        entries = len(ev.log.entries)
        out = ev.feed_candle(BTC, closing[3], closing[0])
        self.assertTrue(out["duplicate"])
        self.assertEqual(out["cycle"]["event_id"], last["event_id"])
        self.assertEqual(len(ev.log.entries), entries)                 # a repeat is not logged twice
        revived = LE.LiveEvaluator.recover(os.path.join(self.dir, "eval.jsonl"), self.strategies, source=RP.SOURCE)
        self.assertEqual(revived.feed_candle(BTC, closing[3], closing[0])["cycle"]["event_id"], last["event_id"])

    def test_a_crash_between_evaluating_and_the_runner_journal_loses_no_cycle_and_duplicates_none(self):
        items = self.stream()
        want_cycles, want_signals, _ = self.uninterrupted()
        first_cycle = next(i for i, it in enumerate(items) if it[2] == "candle"
                           and it[3]["bucket_start"] + MIN >= FIRST_DECISION and (it[3]["bucket_start"] + MIN) % FIVE_MINUTES_MS == 0)
        durable = os.path.join(self.dir, "runner")
        ev = self.evaluator("crash.jsonl")
        runner = PaperRunner.create(durable, self.runner_config(), self.strategies, evaluator=ev.evaluator)
        sink = runner.handle
        self.drive(ev, items[:first_cycle + 2000], sink=sink)
        victim = next(it for it in items[first_cycle + 2000:] if it[2] == "candle" and (it[3]["bucket_start"] + MIN) % FIVE_MINUTES_MS == 0
                      and it[3]["bucket_start"] + MIN >= FIRST_DECISION)
        resume = items.index(victim)
        self.drive(ev, items[first_cycle + 2000:resume])
        # the evaluator logged the closing candle and made the cycle; the process dies before the runner journaled it
        ev.feed_candle(BTC, victim[3], victim[0])
        clock = runner.clock
        runner.close()
        revived = LE.LiveEvaluator.recover(os.path.join(self.dir, "crash.jsonl"), self.strategies, source=RP.SOURCE)
        runner2 = PaperRunner.recover(durable, self.runner_config(), self.strategies, clock, evaluator=revived.evaluator)
        self.addCleanup(runner2.close)
        self.drive(revived, items[resume:], sink=runner2.handle)      # the ingestor hands the victim candle in again
        self.assertEqual(self.signal_ids(runner2), want_signals)
        self.assertEqual(runner2.stats.get("rejected:evaluation_failed", 0), 0)

    def test_a_half_written_last_line_is_dropped_and_reported(self):
        ev = self.evaluator("tail.jsonl")
        self.drive(ev, self.head(300))
        path = os.path.join(self.dir, "tail.jsonl")
        with open(path, "ab") as handle:
            handle.write(b'{"seq": 999, "kind": "candle", "da')
        revived = LE.LiveEvaluator.recover(path, self.strategies, source=RP.SOURCE)
        self.assertEqual(revived.report()["log_tail_discarded"], 1)
        self.assertEqual(revived.log.head, ev.log.head)

    def test_a_tampered_or_foreign_log_is_refused(self):
        ev = self.evaluator("tamper.jsonl")
        self.drive(ev, self.head(300))
        path = os.path.join(self.dir, "tamper.jsonl")
        text = open(path).read().replace('"open": "', '"open": "9', 1)
        open(path, "w").write(text)
        with self.assertRaises(LE.EvaluatorError) as bad:
            LE.LiveEvaluator.recover(path, self.strategies, source=RP.SOURCE)
        self.assertEqual(bad.exception.reason, "log_corrupt")
        other = [s for s in self.strategies if s.id.startswith("c29")]
        self.evaluator("ok.jsonl")
        with self.assertRaises(LE.EvaluatorError) as changed:
            LE.LiveEvaluator.recover(os.path.join(self.dir, "ok.jsonl"), other, source=RP.SOURCE)
        self.assertEqual(changed.exception.reason, "strategies_changed")

    def test_a_missing_minute_rebuilds_the_features_and_holds_the_cycles_back_for_the_warmup(self):
        items = self.stream()
        hole = FIRST_DECISION + 8 * HOUR
        short = [i for i in items if not (i[2] == "candle" and i[3]["bucket_start"] == hole)]
        ev = self.evaluator()
        got = self.drive(ev, [i for i in short if i[0] <= FIRST_DECISION + 20 * HOUR])
        report = ev.report()
        self.assertEqual(report["gaps"], [{"product_id": BTC, "from_ms": hole, "to_ms": hole + MIN}])
        self.assertGreater(len(report["suppressed"]), 0)
        self.assertTrue(all(s["reason"] == "gap_warmup" for s in report["suppressed"]))
        cycles = sorted(e["payload"]["cycle_ms"] for e in got)
        gap_free = [c for c in cycles if hole < c < hole + ev.warmup_ms]
        self.assertEqual(gap_free, [])                                  # nothing is decided on features rebuilt after a hole
        self.assertTrue([c for c in cycles if c < hole])                 # decisions before the hole stand

    def test_invalid_candles_and_unknown_products_are_refused_without_touching_state(self):
        ev = self.evaluator()
        bad = dict(self.cache["ones"][0], high="1", low="2")
        entries = len(ev.log.entries)
        self.assertEqual(ev.feed_candle(BTC, bad, 0)["rejected"], "invalid_candle")
        self.assertEqual(len(ev.log.entries), entries)
        self.assertEqual(ev.report()["rejected"][0]["reason"], "invalid_candle")
        with self.assertRaises(LE.EvaluatorError):
            ev.feed_candle("PF_NOPE", self.cache["ones"][0], 0)


if __name__ == "__main__":
    unittest.main()
