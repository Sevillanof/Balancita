"""Stage 10C: the session evaluator against the 9A replay. All data is synthetic (the 9A fixture database, built in a
temporary directory); no real database, no network, no wall clock, no reserved period."""

import copy
import json
import os
import shutil
import tempfile
import unittest
from decimal import Decimal
from unittest import mock

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
            if out["cycle"] is not None:
                if not out["duplicate"]:
                    cycles.append(out["cycle"])
                if sink is not None:
                    sink(out["cycle"])          # contract: a duplicate returns its cycle too and the runner dedups by event_id
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
        other = self.evaluator("other.jsonl")
        self.assertEqual(other.identity()["config_digest"], ev.identity()["config_digest"])      # same config, same config digest
        self.assertNotEqual(other.identity()["digest"], ev.identity()["digest"])                 # the full identity adds the log head
        self.drive(other, self.stream())
        self.assertEqual(other.identity()["digest"], ev.identity()["digest"])                    # same inputs, same full identity
        changed = LE.LiveEvaluator.create(os.path.join(self.dir, "c.jsonl"), self.strategies, (BTC,), decide_from_ms=FIRST_DECISION + DAY)
        self.assertNotEqual(changed.identity()["config_digest"], ev.identity()["config_digest"])


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
        later = lambda ev: [ev.flags[(BTC, c)]["forward_percentile"] for c in sorted(k[1] for k in ev.flags) if c > cycle_ms + HOUR]   # noqa: E731
        self.assertNotEqual(later(base_ev), later(changed_ev))               # the probe bites once the hour is published

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
        victim = next(it for it in items if it[2] == "candle" and it[3]["bucket_start"] + MIN >= FIRST_DECISION + 12 * HOUR
                      and (it[3]["bucket_start"] + MIN) % FIVE_MINUTES_MS == 0)
        resume = items.index(victim)
        durable = os.path.join(self.dir, "runner")
        ev = self.evaluator("crash.jsonl")
        runner = PaperRunner.create(durable, self.runner_config(), self.strategies, evaluator=ev.evaluator)
        self.drive(ev, items[:resume], sink=runner.handle)
        # the evaluator logged the closing candle and made the cycle; the process dies before the runner journaled it
        made = ev.feed_candle(BTC, victim[3], victim[0])
        self.assertIsNotNone(made["cycle"])                             # the probe bites: the victim is a cycle inside the window
        clock = runner.clock
        runner.close()
        revived = LE.LiveEvaluator.recover(os.path.join(self.dir, "crash.jsonl"), self.strategies, source=RP.SOURCE)
        runner2 = PaperRunner.recover(durable, self.runner_config(), self.strategies, clock, evaluator=revived.evaluator)
        self.addCleanup(runner2.close)
        self.drive(revived, items[resume:], sink=runner2.handle)      # the ingestor hands the victim candle in again
        self.assertEqual(len(self.signal_ids(runner2)), len(want_signals))
        self.assertEqual(self.signal_ids(runner2), want_signals)
        self.assertEqual(runner2.stats.get("rejected:evaluation_failed", 0), 0)

    def test_without_delivering_the_duplicates_cycle_the_runner_would_lose_it(self):
        """The contract made explicit: the cycle a duplicate returns must go to the runner, which dedups by event_id."""
        items = self.stream()
        want_signals = self.uninterrupted()[1]
        victim = next(it for it in items if it[2] == "candle" and it[3]["bucket_start"] + MIN >= FIRST_DECISION + 12 * HOUR
                      and (it[3]["bucket_start"] + MIN) % FIVE_MINUTES_MS == 0)
        resume = items.index(victim)
        durable = os.path.join(self.dir, "runner-lossy")
        ev = self.evaluator("lossy.jsonl")
        runner = PaperRunner.create(durable, self.runner_config(), self.strategies, evaluator=ev.evaluator)
        self.drive(ev, items[:resume], sink=runner.handle)
        ev.feed_candle(BTC, victim[3], victim[0])
        clock = runner.clock
        runner.close()
        revived = LE.LiveEvaluator.recover(os.path.join(self.dir, "lossy.jsonl"), self.strategies, source=RP.SOURCE)
        runner2 = PaperRunner.recover(durable, self.runner_config(), self.strategies, clock, evaluator=revived.evaluator)
        self.addCleanup(runner2.close)
        for arrival, _rank, kind, data in items[resume:]:             # the wrong caller: it drops what a duplicate returns
            if kind == "funding":
                revived.feed_funding(BTC, data[0], data[1], arrival)
                continue
            out = revived.feed_candle(BTC, data, arrival)
            runner2.handle(RP._candle_event(BTC, data))
            if out["cycle"] is not None and not out["duplicate"]:
                runner2.handle(out["cycle"])
        self.assertNotEqual(self.signal_ids(runner2), want_signals)

    def test_a_candle_that_arrives_before_its_minute_ends_is_rejected(self):
        ev = self.evaluator("early.jsonl")
        self.drive(ev, self.head(50))
        candle = self.cache["ones"][50]
        out = ev.feed_candle(BTC, candle, candle["bucket_start"] + 1000)
        self.assertEqual(out["rejected"], "arrival_before_close")
        self.assertEqual(ev.report()["rejected"][-1]["reason"], "arrival_before_close")
        self.assertEqual(len(ev.log.entries), len(self.head(50)) + 1)

    def test_a_funding_hour_that_has_not_ended_is_not_fixed(self):
        ev = self.evaluator("early-funding.jsonl")
        start = FIRST_DECISION
        self.assertFalse(ev.feed_funding(BTC, start, 0.5, start + 30 * 60_000))
        self.assertEqual(ev.report()["rejected"][-1]["reason"], "funding_before_hour_end")
        self.assertTrue(ev.feed_funding(BTC, start, 0.00001, start + HOUR + RP.FUNDING_LAG_MS))   # the final value is accepted later
        self.assertEqual(ev.state[BTC]["funding"][start], 0.00001)

    def test_a_repeated_candle_with_other_content_is_recorded_as_a_conflict(self):
        ev = self.evaluator("conflict.jsonl")
        items = self.head(80)
        self.drive(ev, items)
        _arrival, _rank, _kind, last = [i for i in items if i[2] == "candle"][-1]
        revised = dict(last, close=str(D(last["close"]) + D("0.1")), high=str(D(last["high"]) + D("0.1")))
        out = ev.feed_candle(BTC, revised, last["bucket_start"] + MIN + 5000)
        self.assertTrue(out["duplicate"])
        self.assertEqual(len(ev.report()["candle_conflicts"]), 1)
        self.assertEqual(len(LE.LiveEvaluator.recover(os.path.join(self.dir, "conflict.jsonl"), self.strategies,
                                                       source=RP.SOURCE).report()["candle_conflicts"]), 1)
        again = ev.feed_candle(BTC, last, last["bucket_start"] + MIN + 5000)       # the identical repeat is a plain duplicate
        self.assertTrue(again["duplicate"])
        self.assertEqual(len(ev.report()["candle_conflicts"]), 1)

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

    def refused(self, path, strategies, **kw):
        with self.assertRaises(LE.EvaluatorError) as bad:
            LE.LiveEvaluator.recover(path, strategies, **kw)
        return bad.exception

    def test_the_header_holds_the_configuration_identity_and_recover_accepts_the_same_one(self):
        ev = self.evaluator("cfg.jsonl")
        self.drive(ev, self.head(60))
        header = ev.log.entries[0]["data"]
        self.assertEqual(header["config_digest"], ev.config_digest)
        self.assertEqual(header["config"]["source"], RP.SOURCE)
        for key in ("strategies", "indicators", "tick_sizes", "code", "warmup_ms", "decide_from_ms", "decide_until_ms", "source"):
            self.assertIn(key, header["config"])
        revived = LE.LiveEvaluator.recover(os.path.join(self.dir, "cfg.jsonl"), self.strategies)      # source taken from the header
        self.assertEqual(revived.config_digest, ev.config_digest)
        self.assertEqual(revived.identity()["digest"], ev.identity()["digest"])

    def test_recover_refuses_a_changed_spec_hash_with_the_same_id_and_version(self):
        ev = self.evaluator("hash.jsonl")
        self.drive(ev, self.head(60))
        altered = [copy.copy(s) for s in self.strategies]
        altered[0].spec_hash = "0" * 64
        self.assertEqual([(s.id, s.version) for s in altered], [(s.id, s.version) for s in self.strategies])
        error = self.refused(os.path.join(self.dir, "hash.jsonl"), altered)
        self.assertEqual(error.reason, "config_incompatible")
        self.assertIn("strategies", str(error))

    def test_recover_refuses_another_source_other_ticks_and_other_code(self):
        ev = self.evaluator("src.jsonl")
        self.drive(ev, self.head(60))
        path = os.path.join(self.dir, "src.jsonl")
        error = self.refused(path, self.strategies, source="another-source")
        self.assertEqual(error.reason, "config_incompatible")
        self.assertIn("source", str(error))
        ticks = [copy.copy(s) for s in self.strategies]
        for s in ticks:
            s.tick_sizes = dict(s.tick_sizes, **{BTC: "0.5"})
        self.assertEqual(self.refused(path, ticks).reason, "config_incompatible")
        real = RP.code_identity
        RP.code_identity = lambda: dict(real(), digest="f" * 16)       # the replay pipeline changed
        try:
            error = self.refused(path, self.strategies)
        finally:
            RP.code_identity = real
        self.assertEqual(error.reason, "config_incompatible")
        self.assertIn("code", str(error))
        LE.LiveEvaluator.recover(path, self.strategies)                 # the untouched configuration still recovers

    def test_a_log_without_the_configuration_identity_is_refused(self):
        ev = self.evaluator("old.jsonl")
        path = os.path.join(self.dir, "old.jsonl")
        data = ev.log.entries[0]["data"]
        legacy = {k: v for k, v in data.items() if k not in ("config", "config_digest")}
        body = {"seq": 1, "kind": "header", "data": legacy, "prev": LE.GENESIS}
        with open(path, "w") as handle:
            handle.write(json.dumps(dict(body, hash=LE.stable_hash(body)), sort_keys=True) + "\n")
        self.assertEqual(self.refused(path, self.strategies).reason, "log_header")

    def test_a_frame_waits_for_the_runner_however_long_it_takes_while_the_bound_holds(self):
        ev = self.evaluator("late.jsonl")
        items = self.stream()
        cut = FIRST_DECISION + 6 * HOUR
        made = self.drive(ev, [i for i in items if i[0] <= cut])
        first = made[0]["payload"]
        self.assertGreater(len(made), 12)                                # 6 hours of cycles are pending, the first is > 1 h old
        later = ev.evaluator(self.strategies, first)
        self.assertTrue(later)                                           # evaluated 6 h after it was created, nothing dropped
        self.assertEqual(ev.report()["frames_expired"], [])
        again = self.refused_eval(ev, first)
        self.assertEqual(again, "already_evaluated")

    def refused_eval(self, ev, payload):
        with self.assertRaises(LE.EvaluatorError) as bad:
            ev.evaluator(self.strategies, payload)
        return bad.exception.reason

    def test_past_the_bound_the_oldest_frame_is_recorded_as_expired_and_changes_no_signal(self):
        ev = self.evaluator("bound.jsonl", max_pending_frames=3)
        made = self.drive(ev, [i for i in self.stream() if i[0] <= FIRST_DECISION + 3 * HOUR])
        report = ev.report()
        self.assertEqual(len(report["frames_expired"]), len(made) - 3)
        self.assertEqual(report["memory"]["pending_frames"], 3)
        oldest = made[0]["payload"]
        self.assertEqual(self.refused_eval(ev, oldest), "frame_expired")
        self.assertEqual(ev.report()["evaluation_misses"][-1], {"product_id": BTC, "cycle_ms": oldest["cycle_ms"], "reason": "frame_expired"})
        self.assertTrue(ev.evaluator(self.strategies, made[-1]["payload"]))      # the newest are still evaluable
        self.assertEqual(self.refused_eval(ev, {"product_id": BTC, "cycle_ms": 1}), "unknown_cycle")
        runner = self.memory_runner(ev, "bound-signals.jsonl")                    # the runner rejects it and writes no signal
        runner.handle(made[0])
        self.assertEqual(runner.stats.get("rejected:evaluation_failed", 0), 1)
        self.assertEqual(self.signal_ids(runner), [])

    def test_recovering_a_session_longer_than_the_bound_invents_no_expired_frames(self):
        ev = self.evaluator("long.jsonl", max_pending_frames=50)
        made = self.drive(ev, [i for i in self.stream() if i[0] <= FIRST_DECISION + 8 * HOUR],
                          sink=lambda e: e["kind"] == "cycle" and ev.evaluator(self.strategies, e["payload"]))   # the runner keeps up
        evaluated = {m["payload"]["cycle_ms"] for m in made}
        self.assertGreater(len(made), 60)
        self.assertEqual(ev.report()["frames_expired"], [])
        revived = LE.LiveEvaluator.recover(os.path.join(self.dir, "long.jsonl"), self.strategies)      # bounds come from the header
        self.assertEqual(revived.max_pending_frames, 50)
        self.assertEqual(revived.report()["frames_expired"], [])             # nothing is recorded as evidence by rebuilding
        self.assertEqual(revived.report()["frames_dropped_on_recovery"], len(evaluated) - 50)
        self.assertTrue(revived.evaluator(self.strategies, made[-1]["payload"]))
        self.assertEqual(self.refused_eval(revived, made[0]["payload"]), "frame_expired")
        self.assertEqual(revived.report()["evaluation_misses"][-1]["reason"], "frame_expired")    # asked for, so it is evidence now

    def test_the_bounds_are_part_of_the_identified_configuration(self):
        ev = self.evaluator("bounds.jsonl", max_pending_frames=7, retain_cycles=70)
        self.drive(ev, self.head(40))
        self.assertEqual(ev.config["bounds"], {"max_pending_frames": 7, "retain_cycles": 70})
        path = os.path.join(self.dir, "bounds.jsonl")
        error = self.refused(path, self.strategies, max_pending_frames=8)
        self.assertEqual(error.reason, "config_incompatible")
        self.assertIn("bounds", str(error))
        self.assertEqual(LE.LiveEvaluator.recover(path, self.strategies).retain_cycles, 70)

    def test_cycles_and_flags_are_bounded_and_the_memory_is_reported(self):
        ev = self.evaluator("mem.jsonl", retain_cycles=10)
        made = self.drive(ev, [i for i in self.stream() if i[0] <= FIRST_DECISION + 3 * HOUR])
        memory = ev.report()["memory"]
        self.assertGreater(len(made), 10)
        self.assertEqual((memory["cycles"], memory["flags"]), (10, 10))
        self.assertLessEqual(memory["seen_candles"], LE.SEEN_MINUTES)

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

    def test_the_session_resumes_at_the_instant_the_warmup_names_not_before_and_not_later(self):
        """The edge of the warm-up after a hole, on the fixture and with a shortened ``required_warmup_ms`` (it proves the gate, not the 12 days):
        no cycle closes before ``until_ms``, every suppressed cycle names that instant, and the first cycle at or after it is made."""
        warmup = 12 * HOUR                  # longer than the rebuilt indicators need (a cycle exists), so the warm-up is what holds it, and inside the fixture's day
        hole = FIRST_DECISION + 8 * HOUR
        short = [i for i in self.stream() if not (i[2] == "candle" and i[3]["bucket_start"] == hole)]
        with mock.patch.object(LE, "required_warmup_ms", lambda periods: warmup):
            ev = self.evaluator()
        got = self.drive(ev, [i for i in short if i[0] <= hole + warmup + HOUR])
        until = hole + MIN + warmup
        report = ev.report()
        cycles = sorted(e["payload"]["cycle_ms"] for e in got)
        self.assertEqual({s["until_ms"] for s in report["suppressed"]}, {until})                  # the instant it waits for, written down
        self.assertTrue(all(s["cycle_ms"] < until for s in report["suppressed"]))
        self.assertEqual([c for c in cycles if hole < c < until], [])                           # nothing before it, down to the last cycle
        after = [c for c in cycles if c >= until]
        self.assertTrue(after)
        self.assertLess(after[0], until + FIVE_MINUTES_MS)                                      # the first cycle that is allowed is made, not one later
        self.assertEqual(max(s["cycle_ms"] for s in report["suppressed"]) + FIVE_MINUTES_MS >= until, True)     # and the one just before it was held back

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
