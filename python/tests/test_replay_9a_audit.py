"""Stage 9A audit corrections (A1-A8): the frozen strategies C29/C30/C32 in the replay, funding causality, deduplication,
the scenario report, the window policy, the evidence classes and reproducibility. Invented data only."""

import json
import os
import shutil
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import replay_compare as RC
from balancita_engine import futures_funding_context as FF
from balancita_engine import replay_data as RD
from balancita_engine import replay_funding_audit as RFA
from balancita_engine import replay_driver as RP
from balancita_engine import replay_specs as RS
from balancita_engine import signal_continuity as SC
from balancita_engine.futures_funding_context import FundingContext
from balancita_engine.futures_simulator import FIVE_MINUTES_MS, frames
from balancita_engine.futures_spec_strategy import propose_spec, load_spec, DEFAULT_SPEC_DIR
from balancita_engine.multi_experiment import FrameFeeder
from balancita_engine.multi_signals import merged_indicators
from balancita_engine.paper_runner import PaperRunner
from balancita_engine.portfolio_scenarios import candle_series

try:
    from test_replay_9a import BTC, DAY, HOUR, MIN, START, Tmp, make_db
except ImportError:           # run as python.tests.test_replay_9a_audit
    from .test_replay_9a import BTC, DAY, HOUR, MIN, START, Tmp, make_db

D = Decimal
TICK = "0.5"


def candles(start_ms, minutes, waypoints, seed="a1", noise="8"):
    series = candle_series(start_ms, minutes, waypoints, product=BTC, decimals=1, seed=seed, noise_bps=noise)
    one = [{"bucket_start": start_ms + i * MIN, "known_at": 0, "volume_btc": "1", **series[i]} for i in range(minutes)]
    five = []
    for k in range(0, minutes - minutes % 5, 5):
        g = one[k:k + 5]
        five.append({"bucket_start": g[0]["bucket_start"], "known_at": 0, "volume_btc": "5", "open": g[0]["open"],
                     "high": str(max(D(x["high"]) for x in g)), "low": str(min(D(x["low"]) for x in g)), "close": g[-1]["close"]})
    return one, five


def wave_data(days=12):
    """Flat, a sharp rise, a sharp fall: enough for the momentum specs to fire both ways; extreme funding at the end."""
    minutes = days * 1440
    wave = [(0, "100000"), (4 * 1440, "100000"), (5 * 1440, "112000"), (7 * 1440, "112000"), (8 * 1440, "96000"),
            (minutes, "96000")]
    one, five = candles(START, minutes, wave)
    hours = 740 + minutes // 60                                     # more than 720 hours of history before the first frame
    periods = []
    t0 = START - 740 * HOUR
    for n in range(hours):
        rate = 0.00001 * (n % 40)
        if n in (740 + 5 * 24, ):                                    # extreme high, as the rise is happening
            rate = 0.002
        if n in (740 + 8 * 24 + 6, ):                                # extreme low
            rate = -0.002
        periods.append((t0 + n * HOUR, rate))
    return one, five, periods


class Parity(Tmp):
    @classmethod
    def setUpClass(cls):
        cls.one, cls.five, cls.periods = wave_data()
        cls.strategies, cls.identity = RS.load_frozen(tick_sizes={BTC: TICK})
        cls.specs = {s.id: load_spec(os.path.join(DEFAULT_SPEC_DIR, s.id + ".json")) for s in cls.strategies}

    def reference(self):
        """The forward's path: ``futures_simulator.frames`` and ``propose_spec`` as the forward Book calls it."""
        ctx = FundingContext(self.periods)
        periods = merged_indicators(self.strategies)
        out = {}
        for frame in frames(self.one, self.five, periods=periods, funding=ctx):
            if SC.on_cycle(frame):
                bucket, current, previous, trend, regime = frame
                out[bucket + MIN] = {sid: propose_spec(spec, current, previous=previous, trend=trend, regime=regime, tick_size=TICK)
                                     for sid, spec in self.specs.items()}
        return out

    def adapter(self):
        ctx = FundingContext(self.periods)
        feeder = FrameFeeder(merged_indicators(self.strategies))
        out = {}
        for frame in feeder.stream(self.one, self.five, ctx):
            if SC.on_cycle(frame):
                cycle_ms = frame[0] + MIN
                out[cycle_ms] = (frame, {sig["strategy_id"]: (sig, inputs) for sig, inputs in
                                         SC.evaluate_cycle(self.strategies, BTC, cycle_ms, frame)})
        return out

    def test_signals_match_the_forward_evaluator_on_every_cycle(self):
        ref, got = self.reference(), self.adapter()
        self.assertEqual(sorted(ref), sorted(got))
        fired = {sid: 0 for sid in self.specs}
        for cycle_ms, proposals in sorted(ref.items()):
            for sid, proposal in proposals.items():
                signal = got[cycle_ms][1][sid][0]
                evidence = signal["evidence"]
                self.assertEqual(signal["strategy_id"], sid)
                self.assertEqual(signal["strategy_version"], self.specs[sid]["version"])
                self.assertEqual(signal["horizon_minutes"], self.specs[sid]["rules"]["horizon_minutes"])
                self.assertEqual(evidence["proposal_action"], proposal["action"])
                self.assertEqual(evidence["proposal_reason"], proposal["reason_code"])
                self.assertEqual(signal["reason"], proposal["reason_code"])
                self.assertEqual(evidence["spec_hash"], RS.FROZEN_SPEC_HASHES[sid])
                expected_conditions = ";".join("{}|{}|{}|{}".format(c["code"], c["value"], c["threshold"], c["passed"])
                                               for c in proposal["conditions"])
                self.assertEqual(evidence["conditions"], expected_conditions)
                action = {"LONG": "BUY", "SHORT": "SELL"}.get(proposal["action"], "WAIT")
                self.assertEqual(signal["action"], action)
                if action != "WAIT":
                    fired[sid] += 1
                    self.assertEqual(evidence["proposed_stop"], proposal["proposed_stop"])
                    self.assertEqual(evidence["proposed_target"], proposal["proposed_target"])
                    self.assertEqual(evidence["spec_signal_key"], proposal["signal_key"])
        self.assertTrue(all(n > 0 for n in fired.values()), fired)       # the fixture exercises all three specs

    def test_reference_price_and_indicators_are_the_same_frame(self):
        got = self.adapter()
        ref_frames = {f[0] + MIN: f for f in frames(self.one, self.five, periods=merged_indicators(self.strategies),
                                                    funding=FundingContext(self.periods)) if SC.on_cycle(f)}
        for cycle_ms, (frame, _) in got.items():
            self.assertEqual(frame[3], ref_frames[cycle_ms][3])            # trend features, ATR, logret, fundpct
            self.assertEqual(frame[1], ref_frames[cycle_ms][1])
            self.assertEqual(frame[4], ref_frames[cycle_ms][4])

    def test_the_portfolio_levels_equal_the_specs_levels_within_a_tick(self):
        got, checked = self.adapter(), 0
        for cycle_ms, (frame, sigs) in got.items():
            atr = self.strategies[0].cycle_atr(frame)
            price = D(frame[3]["candidate_close"])
            for sid, (signal, _) in sigs.items():
                if signal["action"] == "WAIT":
                    continue
                long = signal["action"] == "BUY"
                stop = price - 2 * atr if long else price + 2 * atr
                target = price + D("1.5") * 2 * atr if long else price - D("1.5") * 2 * atr
                self.assertLessEqual(abs(stop - D(signal["evidence"]["proposed_stop"])), D(TICK))
                self.assertLessEqual(abs(target - D(signal["evidence"]["proposed_target"])), D(TICK))
                checked += 1
        self.assertGreater(checked, 0)

    def test_identity_is_pinned_and_an_edited_spec_is_refused(self):
        self.assertEqual({k: v["spec_hash"] for k, v in self.identity.items()}, RS.FROZEN_SPEC_HASHES)
        self.assertEqual({k: v["version"] for k, v in self.identity.items()}, {k: 1 for k in RS.FROZEN_SPEC_HASHES})
        copy = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, copy, True)
        for sid in RS.FROZEN_IDS:
            shutil.copy(os.path.join(DEFAULT_SPEC_DIR, sid + ".json"), copy)
        path = os.path.join(copy, RS.FROZEN_IDS[0] + ".json")
        with open(path) as handle:
            spec = json.load(handle)
        spec["params"]["z_min"] = "2.4"
        with open(path, "w") as handle:
            json.dump(spec, handle)
        with self.assertRaises(RS.FrozenSpecError):
            RS.load_frozen(copy, tick_sizes={BTC: TICK})

    def test_an_unsupported_spec_is_refused_not_approximated(self):
        spec = json.loads(json.dumps(self.specs[RS.FROZEN_IDS[0]]))
        spec["rules"]["risk"]["stop_atr"] = "3"
        with self.assertRaises(RS.FrozenSpecError):
            RS.SpecSignalStrategy(spec, {BTC: TICK})
        spec = json.loads(json.dumps(self.specs[RS.FROZEN_IDS[0]]))
        spec["rules"]["checks"][0]["node"]["all"].append({"cmp": "x", "left": "1m_previous.close", "op": ">", "right": "0"})
        with self.assertRaises(RS.FrozenSpecError):
            RS.SpecSignalStrategy(spec, {BTC: TICK})


# ------------------------------------------------------------------------------------------------ end to end
DAYS = 37
FIRST_DECISION = START + 34 * DAY
LAST_DECISION = FIRST_DECISION + DAY


def fixture_db(path, **kw):
    wave = [(0, "100000"), (34 * 1440, "100000"), (34 * 1440 + 480, "113000"), (35 * 1440, "113000"), (36 * 1440, "99000"),
            (DAYS * 1440, "99000")]
    base = dict(end_ms=START + DAYS * DAY, waypoints={BTC: wave}, funding_overrides={34 * 24 + 3: "0.003", 34 * 24 + 15: "-0.003"})
    base.update(kw)
    make_db(path, **base)


class Shared(Tmp):
    """One database of 37 days and the runs that several tests read (built once)."""

    cache = {}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.cache.get("dir", ""), True)
        cls.cache.clear()

    @classmethod
    def home(cls):
        if "dir" not in cls.cache:
            cls.cache["dir"] = tempfile.mkdtemp()
            cls.cache["db"] = os.path.join(cls.cache["dir"], "m.sqlite")
            fixture_db(cls.cache["db"])
        return cls.cache["dir"], cls.cache["db"]

    def config(self, **kw):
        base = dict(products=(BTC,), decision_start_ms=FIRST_DECISION, decision_end_ms=LAST_DECISION, scenario="S1",
                    load_start_ms=FIRST_DECISION - 4 * DAY)
        base.update(kw)
        return RP.ReplayConfig(**base)

    def run_cached(self, name, db=None, **kw):
        home, path = self.home()
        if name not in self.cache:
            holder = {}
            self.cache[name] = (RP.run_replay(db or path, db or path, self.config(**kw), os.path.join(home, name),
                                              on_runner=lambda r: holder.update(runner=r)), holder["runner"])
        return self.cache[name]


def fake_run(scenario, klass, orders, trades, signals="h"):
    return {"scenario": scenario, "scenario_class": klass, "manifest": {"manifest_hash": scenario},
            "signals": {"set_hash": signals, "entries": len(orders)}, "orders": orders, "trades": trades,
            "capital": {"equity_usd": "1000"}, "counts": {k: 0 for k in ("signals", "accepted", "rejected", "closed", "wins", "open")}}


def order(cycle, status="opened", entry="100", intent="i1", reasons=()):
    return {"strategy_id": "s", "product_id": BTC, "side": "LONG", "cycle_ms": cycle, "signal_key": "k", "status": status,
            "reasons": list(reasons), "entry_price": entry, "intent_id": intent}


def trade(intent, pnl, entry="100"):
    return {"intent_id": intent, "entry_price": entry, "entry_time_ms": 1, "exit_reason": "target", "exit_price": "101",
            "pnl_usd": pnl, "fees_usd": 0.1}


class Compare(unittest.TestCase):
    def test_orders_that_diverge_and_trades_that_exist_in_only_one_scenario_are_separated(self):
        base = fake_run("S1", "modelled_base", [order(1, intent="a"), order(2, intent="b"), order(3, status="rejected", intent=None,
                                                                                                    reasons=["x"])],
                        [trade("a", 1.0), trade("b", 2.0)])
        other = fake_run("S3", "unapproved_sensitivity", [order(1, entry="100.5", intent="a2"), order(2, status="rejected",
                                                                                                          intent=None, reasons=["y"]),
                                                          order(3, intent="c")], [trade("a2", 0.5, "100.5"), trade("c", 4.0)])
        report = RC.compare({"S1": base, "S3": other})
        self.assertEqual(report["orders"]["comparable_in_all"], 3)
        kinds = {d["order"].split("|")[2]: d["kind"] for d in report["orders"]["diverging"]}
        self.assertEqual(kinds, {"1": "entry_price_only", "2": "status_or_reasons", "3": "status_or_reasons"})
        self.assertEqual(sorted(x["order"].split("|")[2] for x in report["trades"]["only_in_some"]), ["2", "3"])
        split = report["trajectory"]["pnl_split_against_base"]["S3"]
        self.assertEqual(split["from_comparable_trades_usd"], "-0.5")
        self.assertEqual(split["from_trades_only_in_scenario_usd"], "4.0")
        self.assertEqual(split["from_trades_only_in_base_usd"], "-2.0")
        self.assertEqual(split["pnl_difference_usd"], "1.5")

    def test_different_signals_are_reported_as_different(self):
        a = fake_run("S1", "modelled_base", [], [], signals="x")
        b = fake_run("S0", "counterfactual", [], [], signals="y")
        self.assertFalse(RC.compare({"S1": a, "S0": b})["signals"]["identical_across_scenarios"])


def periods(n, skip=()):
    return [(START + i * HOUR, 0.00001 * (i % 40) + i * 1e-9) for i in range(n) if i not in skip]


class FundingAudit(Tmp):
    BANDS = (10.0, 90.0)

    def at(self, hour):                                       # the instant hour ``hour`` becomes published
        return START + hour * HOUR + HOUR + 600_000

    def test_clean_history_has_no_carry_forward_and_both_readings_agree(self):
        ctx = FundingContext(periods(800))
        r = RFA.audit_record(ctx, self.at(790), self.BANDS)
        self.assertFalse(r["carry_forward"])
        self.assertEqual(r["window_hours"], 720)
        self.assertEqual(r["last_hour_used_ms"], START + 790 * HOUR)
        self.assertEqual(r["forward_percentile"], r["strict_percentile"])
        self.assertEqual(r["forward_percentile"], ctx.percentile(self.at(790))[1])

    def test_an_hour_in_its_publication_wait_is_not_a_carry_forward(self):
        ctx = FundingContext(periods(800))
        r = RFA.audit_record(ctx, self.at(790) - 1, self.BANDS)        # hour 790 exists but is not published yet
        self.assertEqual(r["last_hour_used_ms"], START + 789 * HOUR)
        self.assertFalse(r["carry_forward"])
        self.assertTrue(r["in_publication_wait"])
        # clock only: the flag does not depend on whether later hours exist in the data
        short = RFA.audit_record(FundingContext(periods(790)), self.at(789) + HOUR + 1, self.BANDS)
        full = RFA.audit_record(FundingContext(periods(800)), self.at(789) + HOUR + 1, self.BANDS)
        self.assertEqual(short["in_publication_wait"], full["in_publication_wait"])

    def test_a_missing_last_hour_is_a_data_gap_carry_forward_and_strict_is_unknown(self):
        ctx = FundingContext(periods(800, skip=(790,)))
        r = RFA.audit_record(ctx, self.at(790), self.BANDS)
        self.assertTrue(r["carry_forward"])
        self.assertEqual(r["carry_forward_reason"], "data_gap")
        self.assertEqual(r["last_hour_used_ms"], START + 789 * HOUR)
        self.assertEqual(r["missing_hours_since_due"], 1)
        self.assertEqual(r["forward_percentile"], ctx.percentile(self.at(790))[1])      # the forward's own number, unchanged
        self.assertTrue(r["strict_unknown"])
        self.assertIsNone(r["strict_signal"])

    def test_a_hole_inside_the_window_stretches_it_and_makes_strict_unknown(self):
        ctx = FundingContext(periods(800, skip=(300,)))
        r = RFA.audit_record(ctx, self.at(790), self.BANDS)
        self.assertFalse(r["carry_forward"])
        self.assertEqual(r["window_hours"], 721)
        self.assertEqual(r["missing_hours_in_window"], 1)
        self.assertTrue(r["long_window"])
        self.assertTrue(r["strict_unknown"])
        # the hole leaves the window 720 hours later: both readings agree again
        later = RFA.audit_record(ctx, self.at(790 + 0), self.BANDS)
        self.assertEqual(later["window_hours"], 721)
        clean = RFA.audit_record(FundingContext(periods(1100, skip=(300,))), self.at(1040), self.BANDS)
        self.assertEqual(clean["window_hours"], 720)
        self.assertFalse(clean["strict_unknown"])

    def test_under_30_days_is_unknown_in_both_readings(self):
        r = RFA.audit_record(FundingContext(periods(800)), self.at(700), self.BANDS)
        self.assertTrue(r["unknown"] and r["strict_unknown"])

    def test_strict_never_invents_a_signal_and_the_classes_cover_every_case(self):
        self.assertEqual(RFA.classify("SELL", None), "disappears_unknown")
        self.assertEqual(RFA.classify("SELL", "WAIT"), "disappears_wait")
        self.assertEqual(RFA.classify("SELL", "BUY"), "different_direction")
        self.assertEqual(RFA.classify("SELL", "SELL"), "same_entry")
        self.assertEqual(RFA.classify("WAIT", "BUY"), "additional_in_strict")
        self.assertEqual(RFA.classify("WAIT", None), "wait_strict_unknown")
        self.assertEqual(RFA.classify("WAIT", "WAIT"), "both_wait")

    def test_summary_counts_divergence_without_touching_the_records(self):
        rows = [dict(unknown=False, carry_forward=True, carry_forward_reason="data_gap", in_publication_wait=False, long_window=False,
                     window_hours=720, original="SELL", incomplete_evidence=True, strict_unknown=True, strict_class="disappears_unknown"),
                dict(unknown=False, carry_forward=False, carry_forward_reason=None, in_publication_wait=False, long_window=False,
                     window_hours=720, original="WAIT", incomplete_evidence=False, strict_unknown=False, strict_class="both_wait")]
        before = json.dumps(rows, sort_keys=True)
        out = RFA.summarize(rows)
        self.assertEqual(json.dumps(rows, sort_keys=True), before)
        self.assertEqual(out["with_carry_forward"], 1)
        self.assertEqual(out["original_entries_that_disappear_strict"], 1)
        self.assertEqual(out["divergence_pct_of_evaluations"], 50.0)
        self.assertEqual(out["divergence_pct_of_original_entries"], 100.0)

    def test_the_replay_reads_the_same_periods_as_the_forward(self):
        path = os.path.join(tempfile.mkdtemp(), "m.sqlite")
        self.addCleanup(shutil.rmtree, os.path.dirname(path), True)
        make_db(path, start_ms=START, end_ms=START + 5 * DAY)
        import sqlite3
        db = sqlite3.connect(path)
        raw = json.loads(db.execute("SELECT raw_response FROM paper_futures_funding_responses").fetchone()[0])
        for n, (received, revised) in enumerate(((1_790_000_100_000, "0.0099"), (1_790_000_200_000, "0.0088"), (1_790_000_300_000, "0.0077"))):
            body = json.loads(json.dumps(raw))
            body["rates"][3]["relativeFundingRate"] = revised                    # a later revision of hour 3: the oldest wins
            body["rates"].append({"timestamp": "{}.000Z".format(RP.iso(START + 5 * DAY + n * HOUR)[:-1]), "fundingRate": "0.5",
                                  "relativeFundingRate": "0.0001"})
            db.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)", ("r%d" % n, received, "t", json.dumps(body)))
            db.execute("INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)",
                       ("r%d" % n, BTC, START, START + HOUR, "0.5", received, "usd_per_base_per_hour"))
        db.commit()
        db.close()
        forward = dict(FF.load_periods(path, BTC))
        gate = RD.ReplayDataGate(path, START, START + 5 * DAY + 3 * HOUR)
        replay = {s: float(r) for s, r in gate.relative_funding(BTC)}
        gate.close()
        self.assertEqual(replay, {s: v for s, v in forward.items() if s < START + 5 * DAY + 3 * HOUR})
        self.assertNotEqual(replay[START + 3 * HOUR], 0.0099)                        # not the revision: the oldest response


class FrozenEndToEnd(Shared):
    def test_the_run_uses_the_three_frozen_strategies_and_declares_their_identity(self):
        out, _ = self.run_cached("s1")
        self.assertEqual(out["manifest"]["strategies"], ["c29-momentum-perp-v1@1", "c30-momentum-12h-perp-v1@1",
                                                         "c32-funding-contrarian-24h-perp-v1@1"])
        identity = out["manifest"]["spec_identity"]
        self.assertEqual({k: v["spec_hash"] for k, v in identity.items()}, RS.FROZEN_SPEC_HASHES)
        self.assertTrue(all(v["file_sha256"] and v["horizon_minutes"] == 1440 or k.startswith("c30") for k, v in identity.items()))
        self.assertEqual(out["event_rejections"], {})
        self.assertTrue(out["audit"]["passed"], out["audit"]["violations"])
        self.assertGreater(out["signals"]["entries"], 0)
        self.assertNotIn("mx-", json.dumps(out["manifest"]["strategies"]))

    def test_orders_and_trades_belong_to_the_frozen_strategies_only(self):
        out, _ = self.run_cached("s1")
        ids = {"c29-momentum-perp-v1", "c30-momentum-12h-perp-v1", "c32-funding-contrarian-24h-perp-v1"}
        self.assertTrue({o["strategy_id"] for o in out["orders"]} <= ids)
        self.assertTrue(all(o["signal_key"] for o in out["orders"]))

    # ---- A3 -------------------------------------------------------------------------------------------------------
    def test_funding_hours_are_delivered_after_they_end_plus_the_publication_wait(self):
        cfg = self.config().resolved()
        events = list(RP.funding_events(BTC, {"funding": [(FIRST_DECISION, "0.00001"), (FIRST_DECISION + 2 * HOUR, "0.00002")]}, cfg))
        self.assertEqual([k[0] for k, _ in events], [FIRST_DECISION + HOUR + 600_000, FIRST_DECISION + 3 * HOUR + 600_000])
        self.assertEqual(len(events), 2)                                  # the missing hour produces no event (unknown, not 0)

    def test_a_percentile_never_uses_an_hour_before_it_is_published(self):
        periods = [(START + n * HOUR, 0.00001 * (n % 40)) for n in range(760)]
        periods[750] = (periods[750][0], 0.05)
        ctx = FundingContext(periods)
        published = periods[750][0] + HOUR + 600_000
        self.assertNotEqual(ctx.percentile(published - 1)[0], 0.05)
        self.assertEqual(ctx.percentile(published)[0], 0.05)

    def test_the_30_day_window_boundary_and_missing_hours_are_flagged_not_filled(self):
        periods = [(START + n * HOUR, 0.00001 * (n % 40)) for n in range(800)]
        at = lambda n: START + n * HOUR + HOUR + 600_000                       # noqa: E731  the moment hour n is published
        self.assertTrue(RP.funding_flags(FundingContext(periods), at(719))["unknown"])
        self.assertFalse(RP.funding_flags(FundingContext(periods), at(720))["unknown"])
        self.assertFalse(RP.funding_flags(FundingContext(periods), at(760))["stale"])
        holes = periods[:799] + periods[800:]                                  # hour 799 never arrives
        self.assertTrue(RP.funding_flags(FundingContext(holes), at(799))["stale"])      # the forward would carry hour 798
        gap = periods[:300] + periods[301:]                                    # a hole inside the last 30 days
        self.assertTrue(RP.funding_flags(FundingContext(gap), at(799))["long_window"])

    def test_stale_funding_decisions_are_counted_and_declared(self):
        home, _ = self.home()
        path = os.path.join(home, "holes.sqlite")
        if not os.path.exists(path):
            fixture_db(path, funding_skip=tuple(range(34 * 24 + 4, 34 * 24 + 24)))      # no funding for most of the decision day
        out, _ = self.run_cached("holes", db=path)
        diag = out["funding_diagnostics"]
        self.assertGreater(diag["stale"], 0)
        self.assertGreater(diag["cycles"], diag["stale"] - 1)
        self.assertIn("funding_decisions_with_stale_hour", diag)

    def test_c32_evaluations_are_audited_one_by_one_and_summarised(self):
        out, _ = self.run_cached("s1")
        audit = out["funding_diagnostics"]["audit"]
        self.assertEqual(audit["evaluations"], out["funding_diagnostics"]["cycles"])
        self.assertEqual(audit["with_carry_forward"], 0)
        self.assertEqual(audit["strict_classes"].get("different_direction", 0), 0)
        home, _ = self.home()
        info = out["funding_diagnostics"]["audit_file"]
        with open(os.path.join(home, "s1", info["path"]), "rb") as handle:
            blob = handle.read()
        import hashlib
        self.assertEqual(hashlib.sha256(blob).hexdigest(), info["sha256"])
        self.assertEqual(len(blob.splitlines()), info["rows"])

    def test_the_audit_sees_the_holes_without_changing_the_decisions(self):
        home, path = self.home()
        holes = os.path.join(home, "holes.sqlite")
        if not os.path.exists(holes):
            fixture_db(holes, funding_skip=tuple(range(34 * 24 + 4, 34 * 24 + 24)))
        out, _ = self.run_cached("holes", db=holes)
        audit = out["funding_diagnostics"]["audit"]
        self.assertGreater(audit["with_carry_forward"], 0)
        self.assertGreater(audit["original_entries_on_incomplete_evidence"], 0)
        self.assertGreater(audit["original_entries_that_disappear_strict"], 0)

    def test_funding_accounting_is_not_duplicated_by_reconciliation(self):
        out, _ = self.run_cached("s1")
        paid = sum(D(str(t["funding_usd"])) for t in out["trades"] if t["funding_usd"] is not None)
        self.assertEqual(D(out["capital"]["funding_usd"]), paid)

    # ---- A4 -------------------------------------------------------------------------------------------------------
    def test_duplicate_modelled_prices_are_removed_without_changing_the_accounting(self):
        on, _ = self.run_cached("s1")
        off, _ = self.run_cached("nodedupe", dedupe_modelled_prices=False)
        self.assertGreater(on["modelled_prices"]["deduplicated"], 0)
        self.assertEqual(off["modelled_prices"]["deduplicated"], 0)
        self.assertNotIn("modelled_price:duplicate_event", on["event_rejections"])
        self.assertEqual(off["event_rejections"].get("modelled_price:duplicate_event", 0), on["modelled_prices"]["deduplicated"])
        for key in ("ledger_hash", "accounting_digest", "financial_digest"):
            self.assertEqual(on["digests"][key], off["digests"][key], key)
        self.assertEqual(on["trades"], off["trades"])
        self.assertEqual(on["capital"], off["capital"])

    # ---- A5 -------------------------------------------------------------------------------------------------------
    def test_the_scenario_report_separates_signals_orders_trades_and_trajectory(self):
        runs = {name: self.run_cached(name.lower(), scenario=name)[0] if name != "S1" else self.run_cached("s1")[0]
                for name in ("S0", "S1", "S2", "S3")}
        report = RC.compare(runs)
        self.assertTrue(report["signals"]["identical_across_scenarios"])
        self.assertEqual(report["base"], "S1")
        self.assertIn("COUNTERFACTUAL", report["runs"]["S0"]["label"])
        self.assertIn("NON-CAUSAL", report["runs"]["S2"]["label"])
        for key in ("orders", "trades", "execution_differences_of_comparable_trades", "trajectory", "note"):
            self.assertIn(key, report)
        self.assertEqual(report["orders"]["total_distinct"], report["orders"]["comparable_in_all"] + report["orders"]["present_only_in_some"])
        for label, split in report["trajectory"]["pnl_split_against_base"].items():
            parts = (D(split["from_comparable_trades_usd"]) + D(split["from_trades_only_in_scenario_usd"])
                     + D(split["from_trades_only_in_base_usd"]))
            self.assertEqual(parts, D(split["pnl_difference_usd"]), label)
        self.assertEqual(runs["S0"]["scenario_class"], "counterfactual")
        self.assertEqual(runs["S2"]["scenario_class"], "non_causal_stress")
        self.assertIn("COUNTERFACTUAL", RP.SCENARIO_TEXT["S0"])

    def test_no_ordering_of_scenarios_is_assumed(self):
        report = RC.compare({"A": self.run_cached("s1")[0], "B": self.run_cached("s2", scenario="S2")[0]}, base="A")
        self.assertEqual(report["base"], "A")                               # the report states differences, never "S2 <= S1"
        self.assertNotIn("ordering", json.dumps(report).lower())

    # ---- A6 -------------------------------------------------------------------------------------------------------
    def test_the_window_policy_is_declared_and_open_positions_are_never_closed_with_later_data(self):
        out, _ = self.run_cached("s1")
        self.assertEqual(out["window"]["policy"], "cut_decisions_24h_before_end")
        cfg = self.config(decision_end_ms=FIRST_DECISION + 14 * 3600_000, data_end_ms=FIRST_DECISION + 14 * 3600_000 + 4 * 3600_000,
                          window_policy="decide_until_data_end").resolved()
        self.assertEqual(cfg.data_end_ms - cfg.decision_end_ms, 4 * 3600_000)       # the effective window is what was asked
        cut, _ = self.run_cached("short", decision_end_ms=cfg.decision_end_ms, data_end_ms=cfg.data_end_ms,
                                 window_policy="decide_until_data_end")
        self.assertEqual(cut["window"]["policy"], "decide_until_data_end")
        self.assertEqual(cut["window"]["forced_closes_with_later_data"], 0)
        self.assertTrue(all(t["exit_time_ms"] <= cfg.data_end_ms + 120_000 for t in cut["trades"]))
        self.assertEqual(cut["window"]["positions_open_at_window_end"], len(cut["open_at_window_end"]))

    def test_the_default_policy_refuses_decisions_in_the_last_day_before_the_cap(self):
        with self.assertRaises(RP.ReplayError):
            self.config(decision_end_ms=RD.HI_EXCL_MS - 3600_000, data_end_ms=RD.HI_EXCL_MS).resolved().validate()

    # ---- A7 -------------------------------------------------------------------------------------------------------
    def test_candles_are_never_presented_as_quotes(self):
        out, runner = self.run_cached("s1")
        self.assertIsNone(runner.executor.watch)
        self.assertEqual(out["evidence"]["observed_by_quotes"], 0)
        self.assertEqual(sum(out["evidence"]["classes"].values()), len(out["trades"]))
        self.assertTrue(all(t["execution"] == "MODELLED_EXECUTION" and t["evidence_class"] in out["evidence"]["classes"]
                            for t in out["trades"]))
        self.assertTrue(all(e["kind"] != "quote" for e in runner.journal.entries))

    def test_the_entry_minute_stop_stays_uncertain(self):
        out, _ = self.run_cached("s1")
        uncertain = [t for t in out["trades"] if t["evidence_class"] == "uncertain_entry_minute_stop"]
        self.assertEqual(len(uncertain), out["entry_minute"]["stop_assumed"])

    # ---- A8 -------------------------------------------------------------------------------------------------------
    def test_the_same_run_twice_gives_the_same_everything(self):
        a, _ = self.run_cached("s1")
        b, _ = self.run_cached("s1b")
        for key in ("ledger_hash", "accounting_digest", "financial_digest", "state_digest", "journal_head"):
            self.assertEqual(a["digests"][key], b["digests"][key], key)
        self.assertEqual(a["signals"], b["signals"])
        self.assertEqual(a["orders"], b["orders"])
        self.assertEqual(a["manifest"]["manifest_hash"], b["manifest"]["manifest_hash"])
        self.assertEqual(a["trades"], b["trades"])

    def test_the_identity_covers_the_code_the_specs_the_scenario_and_the_data(self):
        a, _ = self.run_cached("s1")
        modules = a["manifest"]["code"]["modules"]
        for name in ("futures_funding_context", "multi_experiment", "signal_continuity", "futures_spec_strategy",
                     "replay_specs", "replay_driver", "futures_simulator", "portfolio"):
            self.assertIn(name, modules)
        s0, _ = self.run_cached("s0", scenario="S0")
        self.assertNotEqual(a["manifest"]["manifest_hash"], s0["manifest"]["manifest_hash"])
        home, _ = self.home()
        moved = os.path.join(home, "perturbed.sqlite")
        if not os.path.exists(moved):
            fixture_db(moved, perturb_from=FIRST_DECISION - DAY)
        other, _ = self.run_cached("perturbed", db=moved)
        self.assertNotEqual(a["manifest"]["data_hash"], other["manifest"]["data_hash"])
        self.assertNotEqual(a["manifest"]["manifest_hash"], other["manifest"]["manifest_hash"])

    def test_a_journal_of_the_frozen_run_recovers_to_the_same_state(self):
        out, runner = self.run_cached("s1")
        again = PaperRunner(runner.config, runner.strategies, runner.log, entries=[dict(e) for e in runner.journal.entries])
        self.assertEqual(again.financial_digest(), out["digests"]["financial_digest"])
        self.assertEqual(again.state_digest(), out["digests"]["state_digest"])


if __name__ == "__main__":
    unittest.main()
