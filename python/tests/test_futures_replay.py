import os
import random
import json
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_llm_decisions as llm
import time

from balancita_engine.futures_replay import ReplayJobs, run
from balancita_engine.futures_replay_qwen import AnswerCache, BlindQwen, CalmFilter, ConsensusRule
from balancita_engine.futures_simulator import simulate_many
from balancita_engine.futures_spec_strategy import load_specs

from test_futures_spec_strategy import _random_walk

SPECS = list(load_specs().values())
ONES, FIVES = _random_walk(random.Random(11), 1500)
DDL = """
CREATE TABLE paper_futures_official_candles(
  product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL,
  revision_hash TEXT NOT NULL, known_at INTEGER NOT NULL, open_price TEXT NOT NULL,
  high_price TEXT NOT NULL, low_price TEXT NOT NULL, close_price TEXT NOT NULL,
  volume_btc TEXT NOT NULL, response_sha256 TEXT NOT NULL);
"""


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.market = os.path.join(self.dir.name, "market.sqlite")
        db = sqlite3.connect(self.market)
        db.executescript(DDL)
        for c in ONES + FIVES:
            db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
                "PF_XBTUSD", c["interval_ms"], c["bucket_start"], c["revision_hash"], c["known_at"],
                c["open"], c["high"], c["low"], c["close"], c["volume_btc"], "x"))
        db.commit()
        db.close()

    def tearDown(self):
        self.dir.cleanup()

    def test_full_range_equals_the_single_simulator_and_writes_its_own_db(self):
        out = os.path.join(self.dir.name, "run.sqlite")
        start, end = ONES[0]["bucket_start"], ONES[-1]["bucket_start"] + 60_000
        summaries = run(self.market, out, "PF_XBTUSD", start, end, SPECS)
        want = [b.summary() for b in simulate_many(SPECS, ONES, FIVES)]
        self.assertEqual(summaries, want)
        db = sqlite3.connect(out)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM replay_summary").fetchone()[0], len(SPECS))
        self.assertEqual(db.execute("SELECT COUNT(*) FROM replay_trade").fetchone()[0], sum(s["trades"] for s in want))
        with self.assertRaises(FileExistsError):
            run(self.market, out, "PF_XBTUSD", start, end, SPECS)

    def test_a_sub_range_only_trades_inside_it(self):
        out = os.path.join(self.dir.name, "sub.sqlite")
        start = ONES[800]["bucket_start"]
        end = ONES[1200]["bucket_start"]
        run(self.market, out, "PF_XBTUSD", start, end, SPECS)
        db = sqlite3.connect(out)
        buckets = [r[0] for r in db.execute("SELECT bucket_ms FROM replay_decision")]
        self.assertTrue(buckets)
        self.assertTrue(all(start <= b < end for b in buckets))

    def _qwen(self, provider, cache=None, trigger="entry", reliability=None):
        prompts = llm.load_prompt_config()
        return BlindQwen(provider, SPECS, llm.load_questions()["trade_action"], llm.load_calibration(),
                         prompts["templates"][prompts["default_version"]], trigger=trigger,
                         mode="raw_logprobs", cache=cache, reliability=reliability)

    def test_calm_filter_threshold_uses_only_the_past(self):
        from decimal import Decimal

        calm = CalmFilter(fraction=0.5, min_history=4)
        for v in (5, 1, 4, 2):
            self.assertFalse(calm.is_calm(Decimal(v)))  # not enough history yet
            calm.add(Decimal(v))
        self.assertTrue(calm.is_calm(Decimal(1)))  # the sorted past is 1,2,4,5: threshold 4
        self.assertTrue(calm.is_calm(Decimal(4)))
        self.assertFalse(calm.is_calm(Decimal(5)))
        self.assertFalse(calm.is_calm(None))
        with self.assertRaises(ValueError):
            CalmFilter(fraction=1)

    def test_calm_skip_is_off_by_default_and_skipped_decisions_are_marked_holds(self):
        start, end = ONES[300]["bucket_start"], ONES[1400]["bucket_start"]
        plain, filtered = llm.FakeProvider(), llm.FakeProvider()
        base = self._qwen(plain, trigger="5min")
        run(self.market, os.path.join(self.dir.name, "p.sqlite"), "PF_XBTUSD", start, end, SPECS, qwen=base)
        self.assertEqual(base.calm_skipped, 0)
        self.assertFalse(any(d.get("skipped") for d in base.decisions))
        quiet = self._qwen(filtered, trigger="5min")
        quiet.calm = CalmFilter(fraction=1 / 3, min_history=50)
        run(self.market, os.path.join(self.dir.name, "f.sqlite"), "PF_XBTUSD", start, end, SPECS, qwen=quiet)
        skipped = [d for d in quiet.decisions if d.get("skipped")]
        self.assertTrue(skipped)
        self.assertEqual(len(skipped), quiet.calm_skipped)
        self.assertEqual(len(quiet.decisions), len(base.decisions))  # every wanted frame still has a decision
        self.assertLess(filtered.calls, plain.calls)
        for d in skipped:
            self.assertEqual((d["chosen"], d["source"]), ("hold", "calm-skip"))
        db = sqlite3.connect(os.path.join(self.dir.name, "f.sqlite"))
        meta = json.loads(db.execute("SELECT value FROM replay_run WHERE key='qwen'").fetchone()[0])
        self.assertEqual((meta["calm_skipped"], meta["calm_filter"]), (quiet.calm_skipped, True))
        # asked decisions are the same as without the filter
        asked = {d["bucket_start"]: d for d in quiet.decisions if not d.get("skipped")}
        for d in base.decisions:
            if d["bucket_start"] in asked:
                self.assertEqual(d["probabilities"], asked[d["bucket_start"]]["probabilities"])

    def test_the_consensus_rule_answers_the_largest_mean_probability_without_a_model(self):
        from balancita_engine.futures_llm_lessons import question_arm

        rule = ConsensusRule(SPECS, question_arm(llm.load_questions()["trade_action"], "original"), trigger="5min")
        out = os.path.join(self.dir.name, "rule.sqlite")
        run(self.market, out, "PF_XBTUSD", ONES[300]["bucket_start"], ONES[900]["bucket_start"], SPECS, qwen=rule)
        self.assertTrue(rule.decisions)
        self.assertEqual(rule.model_ref, "consensus-rule")
        self.assertEqual((rule.cache.hits, rule.cache.misses), (0, 0))
        for d in rule.decisions:
            p = d["probabilities"]
            self.assertEqual(d["source"], "consensus")
            self.assertEqual(d["chosen"], max(("hold", "buy", "sell"), key=lambda n: p[n]))
        self.assertIn(rule.decisions[0]["chosen"], ("buy", "hold", "sell"))

    def test_qwen_prompts_do_not_change_when_the_candles_after_a_decision_are_removed(self):
        """The sentinel for the whole blind replay: state, lessons and reliability read nothing from the future."""
        start = ONES[300]["bucket_start"]
        short, long = llm.FakeProvider(), llm.FakeProvider()
        for provider, end, name in ((short, ONES[900]["bucket_start"], "s"), (long, ONES[1400]["bucket_start"], "l")):
            run(self.market, os.path.join(self.dir.name, name + ".sqlite"), "PF_XBTUSD", start, end, SPECS,
                qwen=self._qwen(provider, trigger="5min"))
        self.assertGreater(len(short.prompts), 50)
        self.assertEqual(long.prompts[:len(short.prompts)], short.prompts)
        self.assertTrue(any("lessons_example" in p for p in short.prompts))

    def test_qwen_reads_only_the_strategies_judged_on_its_own_30_minute_horizon(self):
        provider = llm.FakeProvider()
        qwen = self._qwen(provider, trigger="5min")
        self.assertEqual({s["id"] for s in qwen.specs},
                         {"c25-pullback-perp-v1", "c26-reversion-perp-v1", "c27-breakout-perp-v1",
                          "c28-adapter-perp-v1"})
        run(self.market, os.path.join(self.dir.name, "h.sqlite"), "PF_XBTUSD", ONES[300]["bucket_start"],
            ONES[600]["bucket_start"], SPECS, qwen=qwen)
        self.assertTrue(all("c29" not in p and "c30" not in p for p in provider.prompts))
        db = sqlite3.connect(os.path.join(self.dir.name, "h.sqlite"))
        books = [r[0] for r in db.execute("SELECT strategy_id FROM replay_summary")]
        self.assertIn("c30-momentum-12h-perp-v1", books)  # the books still trade every strategy
        report = db.execute("SELECT payload FROM replay_qwen_report").fetchone()[0]
        self.assertIn("always_hold_rate", report)

    def test_reliability_measured_after_a_decision_is_never_shown_to_it(self):
        from balancita_engine.futures_spec_strategy import spec_hash

        start, end = ONES[300]["bucket_start"], ONES[1000]["bucket_start"]

        def table(last):
            return {"schema": "futures-strategy-reliability.v1", "period": {"last_bucket_ms": last},
                    "strategies": {s["id"]: {"spec_hash": spec_hash(s), "verdict": "reliable_edge", "trades": 500,
                                             "hit_rate": 0.61, "mean_net_bp": 42.0} for s in SPECS}}

        later, earlier = llm.FakeProvider(), llm.FakeProvider()
        qwen = self._qwen(later, trigger="5min", reliability=table(end + 10 ** 9))
        run(self.market, os.path.join(self.dir.name, "later.sqlite"), "PF_XBTUSD", start, end, SPECS, qwen=qwen)
        self.assertTrue(later.prompts)
        self.assertTrue(all("reliable_edge" not in p and "unmeasured" in p for p in later.prompts))
        self.assertEqual(qwen.reliability_hidden, len(later.prompts) // 3)  # 3 option orders per decision
        run(self.market, os.path.join(self.dir.name, "earlier.sqlite"), "PF_XBTUSD", start, end, SPECS,
            qwen=self._qwen(earlier, trigger="5min", reliability=table(start - 1)))
        self.assertTrue(all("reliable_edge" in p for p in earlier.prompts))

    def test_blind_qwen_decides_from_a_state_without_dates_prices_or_product(self):
        provider = llm.FakeProvider()
        out = os.path.join(self.dir.name, "q.sqlite")
        start, end = ONES[300]["bucket_start"], ONES[1400]["bucket_start"]
        run(self.market, out, "PF_XBTUSD", start, end, SPECS, qwen=self._qwen(provider))
        self.assertTrue(provider.prompts)
        for prompt in provider.prompts:
            self.assertNotIn("PF_XBTUSD", prompt)
            self.assertNotIn("2026", prompt)
        db = sqlite3.connect(out)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM replay_qwen_decision").fetchone()[0], len(provider.prompts) // 3)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM replay_qwen_report").fetchone()[0], 1)

    def test_a_second_replay_asks_the_model_nothing_new(self):
        cache = AnswerCache()
        start, end = ONES[300]["bucket_start"], ONES[1000]["bucket_start"]
        first = llm.FakeProvider()
        run(self.market, os.path.join(self.dir.name, "a.sqlite"), "PF_XBTUSD", start, end, SPECS,
            qwen=self._qwen(first, cache, "5min"))
        second = llm.FakeProvider()
        run(self.market, os.path.join(self.dir.name, "b.sqlite"), "PF_XBTUSD", start, end, SPECS,
            qwen=self._qwen(second, cache, "5min"))
        self.assertGreater(first.calls, 0)
        self.assertEqual(second.calls, 0)

    def _wait(self, jobs, run_id):
        for _ in range(600):
            time.sleep(0.05)
            row = [r for r in jobs.list() if r["id"] == run_id][0]
            if row["status"] != "running":
                return row
        self.fail("replay did not finish")

    def test_jobs_run_in_the_background_and_are_listed_with_their_detail(self):
        day = 86_400_000
        first = (ONES[0]["bucket_start"] // day + 1) * day  # the 1500 candles span a day boundary
        iso = lambda ms: time.strftime("%Y-%m-%d", time.gmtime(ms // 1000))
        provider = llm.FakeProvider()
        jobs = ReplayJobs(self.market, os.path.join(self.dir.name, "runs"), lambda: load_specs(),
                          {"PF_XBTUSD": "1"}, lambda specs, params, tick: self._qwen(provider, trigger=params["trigger"]))
        started = jobs.start("PF_XBTUSD", iso(first - day), iso(first + day), {"trigger": "5min"})
        self.assertEqual(started["status"], "running")
        row = self._wait(jobs, started["id"])
        self.assertEqual(row["status"], "done", row)
        detail = jobs.detail(started["id"])
        self.assertEqual({s["strategy_id"] for s in detail["summaries"]}, set(load_specs()))
        self.assertTrue(detail["qwen"]["decisions"])
        chart = jobs.candles(started["id"])["candles"]
        self.assertTrue(chart)
        self.assertTrue(all(first <= c["time"] * 1000 < first + day for c in chart[:1]) or chart[0]["time"] * 1000 >= ONES[0]["bucket_start"])
        with self.assertRaises(ValueError):
            jobs.start("PF_NOPE", "2026-01-01", "2026-01-02")
        with self.assertRaises(KeyError):
            jobs.detail("nope")

    def test_a_replay_without_candles_fails_and_says_why(self):
        jobs = ReplayJobs(self.market, os.path.join(self.dir.name, "runs"), lambda: load_specs(), {"PF_XBTUSD": "1"})
        row = self._wait(jobs, jobs.start("PF_XBTUSD", "2001-01-01", "2001-01-02")["id"])
        self.assertEqual(row["status"], "failed")
        self.assertIn("no official candles", row["error"])

    def test_empty_range_is_refused(self):
        with self.assertRaises(ValueError):
            run(self.market, os.path.join(self.dir.name, "e.sqlite"), "PF_XBTUSD", 5, 5, SPECS)


if __name__ == "__main__":
    unittest.main()
