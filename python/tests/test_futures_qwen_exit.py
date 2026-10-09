import json
import os
import random
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_llm_decisions as llm
from balancita_engine.futures_qwen_exit import (
    CONFIG_PATH,
    JUDGE_MS,
    AskBudget,
    STRATEGY_ID,
    ExitLessons,
    QwenExitDecider,
    check_interval_ms,
    exit_calibration,
    load_config,
    run_once,
    write_summary,
)
from balancita_engine.futures_replay_qwen import AnswerCache
from balancita_engine.futures_spec_strategy import load_specs

from test_futures_replay import DDL
from test_futures_spec_strategy import MINUTE, START, _random_walk

SPECS = load_specs()
ONES, FIVES = _random_walk(random.Random(11), 2400)
PRODUCT = "PF_XBTUSD"
QUESTION = llm.load_questions(scope="exit")["exit_decision"]
TEMPLATE = llm.default_template()


def config(**extra):
    base = {"schema": "futures-qwen-exit.v1", "start_ms": ONES[300]["bucket_start"], "notional_usd": "100",
            "entry_specs": ["c25-pullback-perp-v1", "c27-breakout-perp-v1"]}
    base.update(extra)
    return base


def answers(*, close_when=lambda prompt: False):
    """Scripted logprobs: A = hold, B = close."""
    def script(prompt, letters):
        close = close_when(prompt)
        return [{"token": "A", "logprob": -3.0 if close else -0.1}, {"token": "B", "logprob": -0.1 if close else -3.0}]
    return script


def decider(provider, cache=None):
    return QwenExitDecider(provider, QUESTION, {"temperatures": {}}, TEMPLATE, mode="raw_logprobs", cache=cache)


class AskBudgetTests(unittest.TestCase):
    def test_it_allows_the_limit_then_stops_asking_until_reset(self):
        budget = AskBudget(2)
        budget.spend()
        budget.spend()
        self.assertTrue(budget.exhausted)
        with self.assertRaises(llm.ModelUnavailable):
            budget.spend()
        budget.reset()
        budget.spend()
        self.assertFalse(budget.exhausted)


class QuestionTests(unittest.TestCase):
    def test_the_exit_question_is_its_own_scope_and_trade_action_is_untouched(self):
        self.assertIn("exit_decision", llm.load_questions(scope="exit"))
        self.assertNotIn("exit_decision", llm.load_questions())  # Q never asks it
        self.assertNotIn("exit_decision", llm.load_questions(scope="news"))
        shipped = llm.load_questions()["trade_action"]
        self.assertEqual(shipped["version"], 4)
        self.assertNotIn("position", shipped["state_fields"])
        self.assertNotIn("exit_lessons", shipped["state_fields"])

    def test_it_offers_hold_and_close_and_names_no_stop_or_target_to_aim_for(self):
        self.assertEqual([o["id"] for o in QUESTION["options"]], ["hold", "close"])
        self.assertEqual(QUESTION["scope"], "exit")


class ExitLessonsTests(unittest.TestCase):
    CLOSES = {}

    def close_at(self, bucket):
        return self.CLOSES.get(bucket)

    def test_a_decision_is_judged_only_once_its_later_close_exists(self):
        lessons = ExitLessons()
        lessons.record_decision(0, "hold", "LONG", "100", 10, 5)
        self.CLOSES = {JUDGE_MS: "100.5"}
        self.assertEqual(lessons.judged(JUDGE_MS - 60_000, self.close_at), [])
        self.assertEqual(lessons.text(JUDGE_MS - 60_000, self.close_at), "exit_lessons: none yet")
        rows = lessons.judged(JUDGE_MS, self.close_at)
        self.assertEqual([r["right"] for r in rows], ["hold"])  # 50 bp later beats 10 bp then
        self.assertEqual(rows[0]["point"], 1)

    def test_closing_was_right_when_the_position_stood_lower_later(self):
        lessons = ExitLessons()
        lessons.record_decision(0, "hold", "SHORT", "100", 20, 30)
        self.CLOSES = {JUDGE_MS: "101"}  # short lost 100 bp meanwhile
        (row,) = lessons.judged(JUDGE_MS, self.close_at)
        self.assertEqual((row["right"], row["point"]), ("close", -1))
        self.assertIn("right was close (-1)", lessons.text(JUDGE_MS, self.close_at))

    def test_closed_trades_show_up_with_their_result_and_never_before_they_close(self):
        lessons = ExitLessons()
        lessons.record_trade(1000, -42.5, 700, -90.0)
        self.assertEqual(lessons.text(999, self.close_at), "exit_lessons: none yet")
        text = lessons.text(1000, self.close_at)
        self.assertIn("-42.5 after 700min (worst -90.0)", text)

    def test_the_memory_is_bounded(self):
        lessons = ExitLessons(window=3)
        self.CLOSES = {}
        for i in range(10):
            lessons.record_decision(i * 60_000, "hold", "LONG", "100", 0, 5)
            self.CLOSES[i * 60_000 + JUDGE_MS] = "101"
        self.assertEqual(len(lessons.judged(10 * 60_000 + JUDGE_MS, self.close_at)), 3)


class CadenceTests(unittest.TestCase):
    def test_it_asks_less_often_the_longer_the_position_is_held(self):
        self.assertEqual(check_interval_ms(10 * MINUTE), 5 * MINUTE)
        self.assertEqual(check_interval_ms(2 * 60 * MINUTE), 15 * MINUTE)
        self.assertEqual(check_interval_ms(24 * 60 * MINUTE), 60 * MINUTE)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.market = os.path.join(self.dir.name, "market.sqlite")
        self.db = os.path.join(self.dir.name, "qwen-exit.sqlite")
        db = sqlite3.connect(self.market)
        db.executescript(DDL)
        for c in ONES + FIVES:
            db.execute("INSERT INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
                PRODUCT, c["interval_ms"], c["bucket_start"], c["revision_hash"], c["known_at"],
                c["open"], c["high"], c["low"], c["close"], c["volume_btc"], "x"))
        db.commit()
        db.close()
        self.now = ONES[-1]["bucket_start"] + MINUTE

    def tearDown(self):
        self.dir.cleanup()

    def run_with(self, provider, cache=None, cfg=None, **kwargs):
        cache = cache or AnswerCache()
        made = []

        def factory(product_id):
            made.append(decider(provider, cache))
            return made[-1]

        report = run_once(self.market, self.db, cfg or config(), SPECS, [(PRODUCT, "1")], factory, now_ms=self.now,
                          log=lambda *_: None, **kwargs)
        return report, made

    def trades(self):
        db = sqlite3.connect(self.db)
        try:
            return [json.loads(p) for (p,) in db.execute("SELECT payload FROM qwen_exit_trade ORDER BY entry_bucket_ms")]
        finally:
            db.close()

    def test_a_position_qwen_never_closes_has_no_stop_target_or_time_stop(self):
        provider = llm.FakeProvider(entries=answers())  # always hold
        report, (made,) = self.run_with(provider)
        self.assertEqual(self.trades(), [])  # nothing closed by itself in 2 000 minutes of ups and downs
        self.assertTrue(made.records)
        self.assertEqual({r["chosen"] for r in made.records}, {"hold"})
        db = sqlite3.connect(self.db)
        (payload,) = db.execute("SELECT payload FROM qwen_exit_open").fetchone()
        db.close()
        position = json.loads(payload)
        self.assertEqual(set(position), {"side", "held_min", "net_bp", "best_bp", "worst_bp", "entry_bucket_ms"})
        self.assertGreater(position["held_min"], 600)

    def test_qwen_closing_realizes_the_result_after_costs(self):
        provider = llm.FakeProvider(entries=answers(close_when=lambda prompt: True))
        report, (made,) = self.run_with(provider)
        trades = self.trades()
        self.assertGreater(len(trades), 3)
        for trade in trades:
            self.assertEqual(trade["exit_reason"], "qwen_close")
            self.assertIsNone(trade["stop_price"])
            self.assertIsNone(trade["target_price"])
            self.assertEqual(trade["strategy_id"], STRATEGY_ID)
            self.assertEqual(trade["notional_usd"], "100")
            self.assertGreaterEqual(trade["held_min"], 5)
            self.assertEqual(trade["exit_time_ms"] % (5 * MINUTE), 0)  # decided on a 5-minute close
            self.assertLess(trade["funding_usd"], 1)
            self.assertTrue(trade["funding_usd"] > 0)  # conservative: always charged
        self.assertEqual(report["products"][PRODUCT]["new_trades"], len(trades))

    def test_the_position_state_reaches_qwen_without_prices_dates_or_the_product(self):
        provider = llm.FakeProvider(entries=answers(close_when=lambda prompt: True))
        self.run_with(provider)
        prompt = provider.prompts[0]
        self.assertIn("position: side=", prompt)
        self.assertIn("net_bp=", prompt)
        self.assertIn("no stop loss and no take profit", prompt)
        self.assertNotIn(PRODUCT, prompt)
        self.assertNotIn("100000", prompt)

    def test_it_learns_from_its_own_judged_exits_and_closed_trades(self):
        provider = llm.FakeProvider(entries=answers(close_when=lambda prompt: True))
        self.run_with(provider)
        self.assertIn("exit_lessons: none yet", provider.prompts[0])
        late = [p for p in provider.prompts if "exit_trades:" in p]
        self.assertTrue(late)
        self.assertTrue(any("your last" in p and "exit decisions" in p for p in provider.prompts))

    def test_rerunning_asks_nothing_new_and_adds_no_trades(self):
        provider = llm.FakeProvider(entries=answers(close_when=lambda prompt: "held_min=5 " in prompt))
        cache = AnswerCache()
        self.run_with(provider, cache)
        first, calls = self.trades(), provider.calls
        report, _ = self.run_with(provider, cache)
        self.assertEqual(provider.calls, calls)
        self.assertEqual(self.trades(), first)
        self.assertEqual(report["products"][PRODUCT]["new_trades"], 0)

    def test_trades_and_decisions_cannot_be_rewritten(self):
        self.run_with(llm.FakeProvider(entries=answers(close_when=lambda prompt: True)))
        db = sqlite3.connect(self.db)
        for table in ("qwen_exit_trade", "qwen_exit_decision"):
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE {} SET payload='{{}}'".format(table))
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("DELETE FROM " + table)
        db.close()

    def test_another_model_or_start_cannot_continue_the_same_db(self):
        self.run_with(llm.FakeProvider(entries=answers(), model_ref="model-a"))
        with self.assertRaises(ValueError):
            self.run_with(llm.FakeProvider(entries=answers(), model_ref="model-b"))
        with self.assertRaises(ValueError):
            self.run_with(llm.FakeProvider(entries=answers(), model_ref="model-a"),
                          cfg=config(start_ms=ONES[400]["bucket_start"]))

    def test_a_model_that_goes_down_halts_the_product_and_keeps_what_closed(self):
        provider = llm.FakeProvider(entries=answers(close_when=lambda prompt: True))
        original = provider.complete
        state = {"left": 5}

        def flaky(*args, **kwargs):
            if state["left"] <= 0:
                raise llm.ModelUnavailable("down")
            state["left"] -= 1
            return original(*args, **kwargs)

        provider.complete = flaky
        report, _ = self.run_with(provider)
        self.assertEqual(report["halted"], [PRODUCT])
        self.assertEqual(len(self.trades()), 5)
        db = sqlite3.connect(self.db)
        (payload,) = db.execute("SELECT payload FROM qwen_exit_open").fetchone()
        db.close()
        self.assertIsNone(json.loads(payload))  # an unfinished replay claims no open position

    def test_the_summary_reports_closed_trades_open_positions_and_the_model(self):
        self.run_with(llm.FakeProvider(entries=answers(close_when=lambda prompt: True)))
        out = os.path.join(self.dir.name, "summary.json")
        body = write_summary(self.db, config(), out, now_ms=self.now)
        with open(out) as handle:
            self.assertEqual(json.load(handle)["schema"], "futures-qwen-exit-summary.v1")
        self.assertEqual(body["strategy_id"], STRATEGY_ID)
        self.assertEqual(body["model_ref"], "fake-model")
        self.assertEqual(body["closed"]["trades"], len(self.trades()))
        self.assertIn(PRODUCT, body["by_product"])
        self.assertEqual(body["exit_decisions"]["hold"], 0)
        self.assertGreater(body["exit_decisions"]["close"], 0)

    def test_the_calibration_judges_each_answer_by_the_price_30_minutes_later(self):
        self.run_with(llm.FakeProvider(entries=answers(close_when=lambda prompt: True)))
        cal = exit_calibration(self.db, self.market, config(), now_ms=self.now)
        self.assertGreater(cal["decisions"], 0)
        self.assertEqual(set(cal["right_action_rates"]), {"hold", "close"})
        self.assertAlmostEqual(cal["brier_uniform"], 0.5)
        self.assertEqual(sum(b["decisions"] for b in cal["reliability"]), cal["decisions"])
        self.assertEqual(cal["high_confidence"]["decisions"], cal["decisions"])  # scripted p(close) is about 0.95
        body = write_summary(self.db, config(), os.path.join(self.dir.name, "s.json"), now_ms=self.now,
                             market_db=self.market)
        self.assertEqual(body["calibration"]["decisions"], cal["decisions"])
        self.assertIsNone(write_summary(self.db, config(), os.path.join(self.dir.name, "t.json"),
                                        now_ms=self.now)["calibration"])


class ShippedConfigTests(unittest.TestCase):
    def test_the_registration_names_shipped_specs_and_a_fixed_start(self):
        shipped = load_config(CONFIG_PATH)
        self.assertEqual(shipped["strategy_id"], STRATEGY_ID)
        for spec_id in shipped["entry_specs"]:
            self.assertIn(spec_id, SPECS)
        self.assertEqual(shipped["notional_usd"], "100")
        self.assertIsInstance(shipped["start_ms"], int)


if __name__ == "__main__":
    unittest.main()
