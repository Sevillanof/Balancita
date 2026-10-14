"""Stage 9A: isolated historical replay with modelled execution. Everything here is invented data in temporary databases;
no real database, no network and no reserved period is read."""

import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import replay_data as RD
from balancita_engine import replay_driver as RP
from balancita_engine import signal_continuity as SC
from balancita_engine.paper_runner import BUILD_MODULES, PaperRunner, RunnerConfig, RunnerError, make_event
from balancita_engine.portfolio_scenarios import ScriptedStrategy, candle_series

D = Decimal
MIN, HOUR, DAY = 60_000, 3_600_000, 86_400_000
BTC = "PF_XBTUSD"
START = RD.LO_MS
CYCLE_DAY = START + 3 * DAY                    # decisions on day 4
DECISION_END = CYCLE_DAY + DAY


def make_db(path, *, products=(BTC,), start_ms=START, end_ms=START + 5 * DAY, seed="9a", waypoints=None, funding_skip=(),
            funding_rate="0.00002", extra_funding_until=None, perturb_from=None, revisions=(), funding_overrides=None):
    """Candles (1 m and the 5 m built from them) and one funding response per product, in the market-store schema."""
    db = sqlite3.connect(path)
    db.executescript("""
      CREATE TABLE paper_futures_official_candles(product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL,
        revision_hash TEXT NOT NULL, known_at INTEGER NOT NULL, open_price TEXT NOT NULL, high_price TEXT NOT NULL,
        low_price TEXT NOT NULL, close_price TEXT NOT NULL, volume_btc TEXT NOT NULL, response_sha256 TEXT NOT NULL,
        PRIMARY KEY(product_id, interval_ms, bucket_start, revision_hash));
      CREATE TABLE paper_futures_funding_responses(sha256 TEXT PRIMARY KEY, received_at INTEGER NOT NULL, server_time TEXT NOT NULL,
        raw_response TEXT NOT NULL);
      CREATE TABLE paper_futures_funding_periods(response_sha256 TEXT NOT NULL, product_id TEXT NOT NULL, start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL, funding_rate TEXT NOT NULL, known_at INTEGER NOT NULL, unit TEXT NOT NULL,
        PRIMARY KEY(response_sha256, product_id, start_ms));""")
    minutes = (end_ms - start_ms) // MIN
    for product in products:
        paths = (waypoints or {}).get(product) or [(0, "100000"), (minutes, "100000")]
        series = candle_series(start_ms, minutes, paths, product=product, decimals=1, seed=seed, noise_bps="6")
        rows = []
        for i in range(minutes):
            c = dict(series[i])
            bucket = start_ms + i * MIN
            if perturb_from is not None and bucket >= perturb_from:
                c = {k: str((D(v) * D("1.1")).quantize(D("0.1"))) for k, v in c.items()}
            rows.append((product, MIN, bucket, "r0", 1_790_000_000_000, c["open"], c["high"], c["low"], c["close"], "1", "resp",))
        for k in range(0, minutes - minutes % 5, 5):
            group = [rows[k + j] for j in range(5)]
            rows.append((product, 5 * MIN, group[0][2], "r0", 1_790_000_000_000, group[0][5], str(max(D(g[6]) for g in group)),
                         str(min(D(g[7]) for g in group)), group[-1][8], "5", "resp"))
        for product_, interval, bucket, rev, known, o, h, l, c_, v, sha in [r for r in rows]:   # noqa: E741
            db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       (product_, interval, bucket, rev, known, o, h, l, c_, v, sha))
        for product_, interval, bucket, o, h, l, c_ in revisions:                                # noqa: E741
            db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       (product_, interval, bucket, "r1", 1_790_000_100_000, o, h, l, c_, "1", "resp"))
        hours = ((extra_funding_until or end_ms) - start_ms) // HOUR
        rates, periods = [], []
        for n in range(hours):
            if n in funding_skip:
                continue
            s = start_ms + n * HOUR
            stamp = "{}.000Z".format(RP.iso(s)[:-1])
            rate = D(funding_rate) + D(n % 7) / D(1_000_000)
            if funding_overrides and n in funding_overrides:
                rate = D(funding_overrides[n])
            rates.append({"timestamp": stamp, "fundingRate": "0.5", "relativeFundingRate": format(rate, "f")})
            periods.append(("sha-" + product, product, s, s + HOUR, "0.5", 1_790_000_000_000, "usd_per_base_per_hour"))
        db.execute("INSERT INTO paper_futures_funding_responses VALUES(?,?,?,?)",
                   ("sha-" + product, 1_790_000_000_000, "t", json.dumps({"rates": rates})))
        db.executemany("INSERT INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?,?)", periods)
    db.commit()
    db.close()


class Tmp(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        SC.disarm()
        self.addCleanup(SC.disarm)

    def path(self, name):
        return os.path.join(self.dir, name)


class Gate(Tmp):
    def test_window_outside_the_range_is_refused_before_opening_the_file(self):
        missing = self.path("does-not-exist.sqlite")
        with self.assertRaises(RD.RangeGateError):
            RD.ReplayDataGate(missing, RD.LO_MS, RD.HI_EXCL_MS + 1)
        with self.assertRaises(RD.RangeGateError):
            RD.ReplayDataGate(missing, RD.LO_MS - 1, RD.HI_EXCL_MS)
        self.assertFalse(os.path.exists(missing))        # never created: the file was not even opened

    def test_rows_at_or_after_the_cap_never_reach_python(self):
        path = self.path("m.sqlite")
        make_db(path, start_ms=RD.HI_EXCL_MS - 2 * HOUR, end_ms=RD.HI_EXCL_MS + 2 * HOUR)
        gate = RD.ReplayDataGate(path, RD.HI_EXCL_MS - 2 * HOUR, RD.HI_EXCL_MS)
        one = gate.candles(BTC, RD.ONE_MINUTE_MS)
        five = gate.candles(BTC, RD.FIVE_MINUTES_MS)
        funding = gate.relative_funding(BTC)
        gate.close()
        self.assertEqual(one[-1]["bucket_start"], RD.HI_EXCL_MS - MIN)
        self.assertEqual(five[-1]["bucket_start"], RD.HI_EXCL_MS - 5 * MIN)
        self.assertEqual(funding[-1][0], RD.HI_EXCL_MS - HOUR)
        self.assertTrue(all(c["bucket_start"] < RD.HI_EXCL_MS for c in one + five))
        self.assertTrue(all(s < RD.HI_EXCL_MS for s, _ in funding))
        self.assertTrue(all(len(s["params"]) >= 3 for s in gate.statements if s["name"] != "funding_responses"))

    def test_it_is_read_only_and_leaves_the_file_untouched(self):
        path = self.path("m.sqlite")
        make_db(path, end_ms=START + DAY)
        with open(path, "rb") as handle:
            before = handle.read()
        gate = RD.ReplayDataGate(path, START, START + DAY)
        gate.candles(BTC, RD.ONE_MINUTE_MS)
        with self.assertRaises(sqlite3.OperationalError):
            gate.db.execute("DELETE FROM paper_futures_official_candles")
        gate.close()
        with open(path, "rb") as handle:
            self.assertEqual(handle.read(), before)

    def test_first_revision_wins_and_conflicting_revisions_are_reported(self):
        path = self.path("m.sqlite")
        make_db(path, end_ms=START + DAY, revisions=[(BTC, MIN, START + 10 * MIN, "1", "9", "0.5", "5")])
        gate = RD.ReplayDataGate(path, START, START + DAY)
        one = gate.candles(BTC, RD.ONE_MINUTE_MS)
        self.assertEqual(len(one), 1440)
        self.assertEqual(one[10]["known_at"], 1_790_000_000_000)            # the first-known revision
        self.assertEqual(gate.conflicting_revisions(BTC, RD.ONE_MINUTE_MS), [START + 10 * MIN])
        gate.close()

    def test_relative_funding_is_read_from_the_stored_response_not_the_absolute_column(self):
        path = self.path("m.sqlite")
        make_db(path, end_ms=START + 3 * HOUR, funding_rate="0.00002")
        gate = RD.ReplayDataGate(path, START, START + 3 * HOUR)
        periods = gate.relative_funding(BTC)
        gate.close()
        self.assertEqual(periods[0], (START, "0.00002"))                    # the known value, not the 0.5 of ``funding_rate``
        self.assertEqual(len(periods), 3)

    def test_a_missing_funding_hour_is_unknown_not_zero(self):
        path = self.path("m.sqlite")
        make_db(path, end_ms=START + 6 * HOUR, funding_skip=(3,))
        gate = RD.ReplayDataGate(path, START, START + 6 * HOUR)
        periods = gate.relative_funding(BTC)
        gate.close()
        report = RD.funding_report(periods, START, START + 6 * HOUR)
        self.assertEqual(report["missing_hours"], [START + 3 * HOUR])
        self.assertNotIn(START + 3 * HOUR, [s for s, _ in periods])


    # ---- A2: the reserved hours are not processed ----------------------------------------------------------------
    def poisoned_db(self, tail):
        """A funding response whose hours at and after the cap are replaced by ``tail`` (text spliced into the JSON)."""
        path = self.path("m.sqlite")
        make_db(path, start_ms=RD.HI_EXCL_MS - 6 * HOUR, end_ms=RD.HI_EXCL_MS)
        db = sqlite3.connect(path)
        raw = db.execute("SELECT raw_response FROM paper_futures_funding_responses").fetchone()[0]
        db.execute("UPDATE paper_futures_funding_responses SET raw_response=?", (raw[:-2] + tail + "]}",))
        db.commit()
        db.close()
        return path

    def test_reserved_hours_are_never_parsed(self):
        # a canary: after the cap the response is not even valid JSON. A JSON function over the whole response would fail
        # or touch it; the stream stops at the first reserved period.
        stamp = "2026-08-02T00:00:00.000Z"
        tail = ', {"timestamp": "%s", "relativeFundingRate": "0.5"}, THIS IS NOT JSON {{{{' % stamp
        path = self.poisoned_db(tail)
        gate = RD.ReplayDataGate(path, RD.HI_EXCL_MS - 6 * HOUR, RD.HI_EXCL_MS)
        funding = gate.relative_funding(BTC)
        gate.close()
        self.assertEqual(len(funding), 6)
        self.assertEqual(funding[-1][0], RD.HI_EXCL_MS - HOUR)

    def test_the_stream_stops_at_the_first_reserved_period_and_declares_it(self):
        path = self.path("m.sqlite")
        make_db(path, start_ms=RD.HI_EXCL_MS - 3 * HOUR, end_ms=RD.HI_EXCL_MS + 400 * HOUR)
        gate = RD.ReplayDataGate(path, RD.HI_EXCL_MS - 3 * HOUR, RD.HI_EXCL_MS)
        funding = gate.relative_funding(BTC)
        trail = [x for x in gate.statements if x["name"] == "funding_stream"][0]["responses"][0]
        gate.close()
        self.assertEqual([s for s, _ in funding], [RD.HI_EXCL_MS - h * HOUR for h in (3, 2, 1)])
        self.assertEqual(trail["stopped_at_ms"], RD.HI_EXCL_MS)
        self.assertLess(trail["bytes_read"], trail["bytes_stored"] // 5)       # only the start of the response was read

    def test_a_funding_response_out_of_order_is_refused(self):
        path = self.path("m.sqlite")
        make_db(path, start_ms=START, end_ms=START + 4 * HOUR)
        db = sqlite3.connect(path)
        raw = json.loads(db.execute("SELECT raw_response FROM paper_futures_funding_responses").fetchone()[0])
        raw["rates"].reverse()
        db.execute("UPDATE paper_futures_funding_responses SET raw_response=?", (json.dumps(raw),))
        db.commit()
        db.close()
        gate = RD.ReplayDataGate(path, START, START + 4 * HOUR)
        with self.assertRaises(RD.DataError):
            gate.relative_funding(BTC)
        gate.close()

    def test_the_relative_rate_is_what_is_used_never_the_absolute_one(self):
        path = self.path("m.sqlite")
        make_db(path, start_ms=START, end_ms=START + 3 * HOUR, funding_rate="0.00002")
        gate = RD.ReplayDataGate(path, START, START + 3 * HOUR)
        funding = gate.relative_funding(BTC)
        gate.close()
        self.assertTrue(all(D(rate) < D("0.001") for _, rate in funding))          # the absolute rate in the fixture is 0.5


class Integrity(unittest.TestCase):
    def candles(self, interval, count, skip=()):
        return [{"bucket_start": START + i * interval, "open": "10", "high": "11", "low": "9", "close": "10", "volume_btc": "1"}
                for i in range(count) if i not in skip]

    def test_gaps_are_counted_not_filled(self):
        report = RD.series_report(self.candles(MIN, 10, skip=(3, 4)), MIN, START, START + 10 * MIN)
        self.assertEqual((report["missing"], report["gap_count"], report["gaps"]), (2, 1, [[START + 3 * MIN, START + 4 * MIN]]))

    def test_invalid_ohlc_and_disorder_are_found(self):
        rows = self.candles(MIN, 3)
        rows[1]["low"] = "12"
        self.assertEqual(RD.series_report(rows, MIN, START, START + 3 * MIN)["invalid_ohlc"], 1)
        rows = self.candles(MIN, 3)[::-1]
        self.assertGreater(RD.series_report(rows, MIN, START, START + 3 * MIN)["unordered"], 0)

    def test_five_minute_bars_are_checked_against_their_minutes(self):
        one = self.candles(MIN, 10)
        five = [{"bucket_start": START, "open": "10", "high": "11", "low": "9", "close": "10", "volume_btc": "5"},
                {"bucket_start": START + 5 * MIN, "open": "10", "high": "13", "low": "9", "close": "10", "volume_btc": "5"}]
        report = RD.consistency_5m_vs_1m(one, five)
        self.assertEqual((report["compared"], report["mismatched"], report["examples"]), (2, 1, [START + 5 * MIN]))


class Executor(Tmp):
    """The modelled mode through the real runner."""

    CYCLE = START + 100 * 300_000
    PRICES = {BTC: ("100000", "1000")}

    def runner(self, script=None):
        self.strategies = [ScriptedStrategy("scripted-a", script or {})]
        log = SC.SignalLog.create(self.path("signals-{}.jsonl".format(len(os.listdir(self.dir)))), self.CYCLE - 2 * HOUR)
        config = RunnerConfig(start_ms=self.CYCLE - HOUR, execution_mode="modelled",
                              execution=RP.execution_policy())
        return PaperRunner(config, self.strategies, log)

    def cycle(self, t=None):
        return make_event("cycle", {"product_id": BTC, "cycle_ms": self.CYCLE, "price": "100000", "atr": "1000"},
                          t_ms=self.CYCLE + 2_000 if t is None else t)

    @staticmethod
    def price(t, value, scenario="S1"):
        return make_event("modelled_price", {"product_id": BTC, "price": value, "source": "test", "scenario": scenario}, t_ms=t)

    @staticmethod
    def candle(bucket, o, h, l, c):                                            # noqa: E741
        return make_event("candle", {"product_id": BTC, "bucket_ms": bucket,
                                     "candle": {"open": str(o), "high": str(h), "low": str(l), "close": str(c)}}, t_ms=bucket + MIN + 2_000)

    def buy(self):
        return {(BTC, self.CYCLE): {"action": "BUY", "strength": "0.8"}}

    def test_a_quote_is_refused_in_modelled_mode(self):
        r = self.runner()
        result = r.handle(make_event("quote", {"product_id": BTC, "time_ms": self.CYCLE + 5_000, "received_ms": self.CYCLE + 5_000,
                                               "bid": "99999", "ask": "100001"}, t_ms=self.CYCLE + 5_000))
        self.assertEqual((result["status"], result["reason"]), ("rejected", "quote_not_allowed_in_modelled_mode"))
        self.assertIsNone(r.executor.watch)

    def test_a_modelled_price_is_refused_in_the_default_mode(self):
        log = SC.SignalLog.create(self.path("s.jsonl"), self.CYCLE - 2 * HOUR)
        r = PaperRunner(RunnerConfig(start_ms=self.CYCLE - HOUR), [ScriptedStrategy("scripted-a", {})], log)
        result = r.handle(self.price(self.CYCLE + 5_000, "100000"))
        self.assertEqual((result["status"], result["reason"]), ("rejected", "invalid_event"))

    def test_the_fill_is_labelled_modelled_and_carries_no_quote(self):
        r = self.runner(self.buy())
        r.run([self.cycle(), self.price(self.CYCLE + 63_000, "100010")])
        [record] = [x for x in r.executor.records if x["status"] == "opened"]
        self.assertEqual(record["execution"], "MODELLED_EXECUTION")
        self.assertNotIn("quote", record)
        self.assertEqual((record["modelled_fill"]["observed"], record["modelled_fill"]["scenario"]), (False, "S1"))
        self.assertTrue(record["timeline"]["earliest_fill_ms"] <= record["timeline"]["entry_ms"])

    def test_boundary_instants_are_ignored(self):
        r = self.runner(self.buy())
        r.run([self.cycle(), self.price(self.CYCLE + 60_000, "100010")])
        self.assertEqual(len(r.portfolio.positions), 0)
        self.assertEqual(r.executor.modelled_log[0]["reason"], "boundary_instant")

    def test_an_order_without_a_price_expires(self):
        r = self.runner(self.buy())
        r.run([self.cycle(), make_event("clock", {}, t_ms=self.CYCLE + 130_000)])
        self.assertEqual([o["state"] for o in r.orders()], ["expired"])

    def test_the_entry_minute_that_touches_the_stop_closes_the_position_as_estimated(self):
        r = self.runner(self.buy())
        r.run([self.cycle(), self.price(self.CYCLE + 63_000, "100010"),
               self.candle(self.CYCLE, 100000, 100100, 99950, 100010),
               self.candle(self.CYCLE + MIN, 100010, 100020, 97000, 97500)])        # the entry minute breaks the stop (2 ATR)
        [trade] = r.portfolio.trades
        self.assertEqual(trade["exit_reason"], "stop")
        self.assertTrue(trade["stop_exit"]["details"]["estimated"] if "details" in trade["stop_exit"] else True)
        self.assertEqual(len(r.portfolio.positions), 0)

    def test_the_entry_minute_that_does_not_touch_the_stop_leaves_the_position_open(self):
        r = self.runner(self.buy())
        r.run([self.cycle(), self.price(self.CYCLE + 63_000, "100010"),
               self.candle(self.CYCLE, 100000, 100100, 99950, 100010),
               self.candle(self.CYCLE + MIN, 100010, 100200, 99900, 100100)])
        self.assertEqual((len(r.portfolio.trades), len(r.portfolio.positions)), (0, 1))

    def test_the_manifest_tells_the_mode_only_when_it_is_modelled(self):
        modelled = self.runner()
        log = SC.SignalLog.create(self.path("d.jsonl"), self.CYCLE - 2 * HOUR)
        default = PaperRunner(RunnerConfig(start_ms=self.CYCLE - HOUR), [ScriptedStrategy("scripted-a", {})], log)
        self.assertEqual(modelled.manifest["execution_mode"], "modelled")
        self.assertNotIn("execution_mode", default.manifest)

    def test_an_unknown_mode_is_refused(self):
        log = SC.SignalLog.create(self.path("x.jsonl"), self.CYCLE - 2 * HOUR)
        with self.assertRaises(RunnerError):
            PaperRunner(RunnerConfig(start_ms=self.CYCLE - HOUR, execution_mode="live"), [], log)

    def test_the_replay_layer_is_outside_the_build_identity(self):
        self.assertEqual(len(BUILD_MODULES), 10)
        self.assertFalse(any(name.startswith("replay") or name == "paper_runner" for name in BUILD_MODULES))

    def test_a_journal_of_a_modelled_run_replays_to_the_same_state(self):
        r = self.runner(self.buy())
        r.run([self.cycle(), self.price(self.CYCLE + 63_000, "100010"), self.candle(self.CYCLE, 100000, 100100, 99950, 100010),
               self.candle(self.CYCLE + MIN, 100010, 100200, 99900, 100100)])
        again = PaperRunner(r.config, r.strategies, r.log, entries=[dict(e) for e in r.journal.entries])
        self.assertEqual(again.financial_digest(), r.financial_digest())


class Driver(Tmp):
    def config(self, **kw):
        base = dict(products=(BTC,), decision_start_ms=CYCLE_DAY, decision_end_ms=DECISION_END, scenario="S1")
        base.update(kw)
        return RP.ReplayConfig(**base)

    def setup_db(self, name="m.sqlite", **kw):
        path = self.path(name)
        make_db(path, **kw)
        return path

    def scripted(self, *minutes, action="BUY"):
        script = {(BTC, CYCLE_DAY + m * MIN): {"action": action, "strength": "0.8"} for m in minutes}
        return [ScriptedStrategy("scripted-a", script)]

    def replay(self, path, out, cfg=None, strategies=None, **kw):
        return RP.run_replay(path, path, cfg or self.config(**kw), self.path(out), strategies=strategies)

    def test_the_gate_stops_a_window_that_reaches_the_cap(self):
        path = self.setup_db()
        with self.assertRaises(RP.ReplayError):
            self.replay(path, "o", cfg=self.config(decision_end_ms=RD.HI_EXCL_MS))
        with self.assertRaises(RD.RangeGateError):
            RP.load_data(path, path, self.config(data_end_ms=RD.HI_EXCL_MS + HOUR))

    def test_results_are_labelled_modelled_everywhere(self):
        path = self.setup_db()
        out = self.replay(path, "o", strategies=self.scripted(30 * 5, 90 * 5))
        self.assertEqual(out["execution"], "MODELLED_EXECUTION")
        self.assertTrue(out["trades"] or out["open_at_window_end"])
        self.assertTrue(all(t["execution"] == "MODELLED_EXECUTION" for t in out["trades"]))
        self.assertTrue(out["audit"]["passed"], out["audit"]["violations"])
        self.assertEqual(out["event_rejections"], {})
        self.assertIn("not independent evidence", out["label"])
        with open(self.path("o/results.json")) as handle:
            stored = json.load(handle)
        self.assertEqual(stored["digests"], json.loads(json.dumps(out["digests"])))

    def test_a_run_is_written_once(self):
        path = self.setup_db()
        self.replay(path, "o")
        with self.assertRaises(RP.ReplayError):
            self.replay(path, "o")

    def test_two_runs_have_the_same_hashes_and_one_changed_candle_changes_them(self):
        a = self.setup_db("a.sqlite")
        b = self.setup_db("b.sqlite")
        first, second = self.replay(a, "o1", strategies=self.scripted(150, 450)), self.replay(b, "o2", strategies=self.scripted(150, 450))
        self.assertEqual(first["digests"], second["digests"])
        self.assertEqual(first["manifest"]["data_hash"], second["manifest"]["data_hash"])
        c = self.setup_db("c.sqlite", perturb_from=CYCLE_DAY + 200 * MIN)
        third = self.replay(c, "o3", strategies=self.scripted(150, 450))
        self.assertNotEqual(first["manifest"]["data_hash"], third["manifest"]["data_hash"])
        self.assertNotEqual(first["digests"]["ledger_hash"], third["digests"]["ledger_hash"])

    def test_entry_cost_orders_the_scenarios(self):
        path = self.setup_db(waypoints={BTC: [(0, "100000"), (7200, "101000")]})
        entries = {}
        for scenario in RP.SCENARIOS:
            out = self.replay(path, "o-" + scenario, cfg=self.config(scenario=scenario), strategies=self.scripted(150))
            rows = out["trades"] or list(out["open_at_window_end"].values())
            [row] = rows
            entries[scenario] = D(row["entry_price"])
        self.assertLessEqual(entries["S0"], entries["S1"])
        self.assertLessEqual(entries["S1"], entries["S2"])
        self.assertLess(entries["S1"], entries["S3"])

    def test_decisions_before_a_moment_do_not_depend_on_candles_after_it(self):
        cut = CYCLE_DAY + 600 * MIN
        wave = {BTC: [(0, "100000"), (3 * 1440, "100000"), (3 * 1440 + 300, "104000"), (3 * 1440 + 900, "98000"),
                      (5 * 1440, "103000")]}
        plain = self.setup_db("plain.sqlite", waypoints=wave)
        changed = self.setup_db("changed.sqlite", waypoints=wave, perturb_from=cut)
        cfg = self.config(strategy_ids=())
        one = self.replay(plain, "p", cfg=cfg)
        two = self.replay(changed, "c", cfg=cfg)

        def signals(out_dir):
            log = SC.SignalLog.load(self.path(out_dir + "/signals.jsonl"))
            rows = [(e["data"]["signal"]["strategy_id"], e["data"]["signal"]["bucket_ms"], e["data"]["signal"]["action"],
                     e["data"]["signal"]["strength"], json.dumps(e["data"]["signal"]["evidence"], sort_keys=True))
                    for e in log.signals()]
            return sorted(r for r in rows if r[1] <= cut)
        before_one, before_two = signals("p"), signals("c")
        self.assertTrue(before_one)
        self.assertEqual(before_one, before_two)
        self.assertNotEqual(one["manifest"]["data_hash"], two["manifest"]["data_hash"])

    def test_funding_is_delivered_only_after_its_hour_plus_the_publication_lag(self):
        path = self.setup_db(waypoints={BTC: [(0, "100000"), (7200, "100000")]})
        data = RP.load_data(path, path, self.config())
        cfg = self.config().resolved()
        events = list(RP.funding_events(BTC, data["products"][BTC], cfg))
        self.assertTrue(events)
        for _, event in events:
            [(start, end, _)] = event["payload"]["periods"]
            self.assertEqual(event["t_ms"], end + RP.FUNDING_LAG_MS)
            self.assertGreaterEqual(event["t_ms"], end + 600_000)

    def test_a_missing_funding_hour_produces_no_event_and_no_zero(self):
        skip = 3 * 24 + 5
        path = self.setup_db(funding_skip=(skip,))
        data = RP.load_data(path, path, self.config())
        starts = [e["payload"]["periods"][0][0] for _, e in RP.funding_events(BTC, data["products"][BTC], self.config().resolved())]
        self.assertNotIn(START + skip * HOUR, starts)
        self.assertEqual(data["reports"][BTC]["funding"]["missing_hours"], [START + skip * HOUR])

    def test_a_trade_closed_before_its_last_funding_hour_is_provisional_then_reconciled(self):
        path = self.setup_db(waypoints={BTC: [(0, "100000"), (7200, "100000")]})
        out = self.replay(path, "o", strategies=self.scripted(150))
        trades = out["trades"]
        self.assertTrue(trades or out["open_at_window_end"])
        for t in trades:
            self.assertIsNotNone(t["funding_usd"])        # the hours were delivered before the end of the tail

    def test_a_gap_inside_the_decision_window_stops_the_run_unless_declared(self):
        path = self.setup_db()
        db = sqlite3.connect(path)
        db.execute("DELETE FROM paper_futures_official_candles WHERE interval_ms=? AND bucket_start=?", (MIN, CYCLE_DAY + 700 * MIN))
        db.commit()
        db.close()
        with self.assertRaises(RP.ReplayError):
            self.replay(path, "o")
        out = self.replay(path, "o2", allow_gaps=True)
        self.assertTrue(out["manifest"]["allow_gaps"])

    def test_native_strategies_run_end_to_end_without_rejected_events(self):
        wave = {BTC: [(0, "100000"), (4 * 1440, "112000"), (5 * 1440, "99000")]}
        path = self.setup_db(waypoints=wave)
        out = self.replay(path, "o", strategy_set="mx")
        self.assertEqual(out["event_rejections"], {})
        self.assertTrue(out["audit"]["passed"], out["audit"]["violations"])
        self.assertEqual(out["manifest"]["strategies"], ["mx-funding-v1@1", "mx-momentum-v1@1", "mx-meanrev-v1@1"])
        self.assertGreater(out["counts"]["signals"], 0)


if __name__ == "__main__":
    unittest.main()
