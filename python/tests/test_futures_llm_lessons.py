import os
import random
import sqlite3
import tempfile
import unittest
from decimal import Decimal

from balancita_engine import futures_llm_decisions as llm
from balancita_engine.futures_costs import round_trip_cost_bps
from balancita_engine.futures_llm_lessons import (
    ARMS, HORIZON_MIN, Lessons, question_arm, right_action, summarize_state)
from balancita_engine.futures_llm_scores import score_decisions
from balancita_engine.futures_replay import run
from balancita_engine.futures_replay_qwen import BlindQwen
from balancita_engine.futures_spec_strategy import load_specs

from test_futures_llm_decisions import QUESTION_PINS, ServiceBase, choice_question
from test_futures_replay import DDL, FIVES, ONES, SPECS

MINUTE = 60_000
ORIGINAL_TRADE_ACTION_PIN = "5b23984d5fa37ff049ecb5e40b9fb8f214ec97da258a3359b8455e321416cab4"
STATE = "regime: trend\nstrategy_consensus: buy=0.20 hold=0.70 sell=0.10"


def _verdict(bucket, close):
    return {"bucket_start_ms": bucket, "features": {"1m": {"candidate_close": str(close)}}}


class RightActionTests(unittest.TestCase):
    def test_it_is_the_action_the_scorer_would_reward(self):
        cost = float(round_trip_cost_bps("PF_XBTUSD"))
        for move_bp in (-cost * 3, -cost * 0.4, 0.0, cost * 0.4, cost * 3):
            entry, exit_price = Decimal(100000), Decimal(100000) * (1 + Decimal(str(move_bp)) / 10_000)
            right = right_action(entry, exit_price)
            verdicts = [_verdict(0, entry), _verdict(HORIZON_MIN * MINUTE, exit_price)]
            for chosen in ("buy", "hold", "sell"):
                row = score_decisions([{"bucket_start": 0, "chosen": chosen, "confidence": 1, "probabilities": {}}],
                                      verdicts)[0]
                self.assertEqual(row["point"] == 1, chosen == right, (move_bp, chosen, right))


class LessonsTests(unittest.TestCase):
    def memory(self):
        memory = Lessons()
        for minute in range(0, 120):
            memory.observe_close(minute * MINUTE, 100000 + minute * 50)  # +50 per minute: long wins
        return memory

    def test_a_decision_is_not_a_lesson_before_its_horizon_has_closed(self):
        memory = self.memory()
        memory.record(10 * MINUTE, "hold", STATE)
        self.assertEqual(memory.text(10 * MINUTE + HORIZON_MIN * MINUTE - MINUTE), "lessons: none yet")
        self.assertEqual(memory.judged(10 * MINUTE + HORIZON_MIN * MINUTE - MINUTE), [])
        text = memory.text(10 * MINUTE + HORIZON_MIN * MINUTE)
        self.assertIn("chose hold, right was buy (-1)", text)
        self.assertIn("saw trend b0.20 h0.70 s0.10", text)

    def test_the_summary_counts_points_and_right_actions(self):
        memory = self.memory()
        memory.record(10 * MINUTE, "hold", STATE)
        memory.record(20 * MINUTE, "buy", STATE)
        text = memory.text(60 * MINUTE)
        self.assertIn("1 right of 2 (50%)", text)
        self.assertIn("buy 100%", text)
        self.assertIn("lessons_right_action: buy=100% hold=0% sell=0%", text)

    def test_what_is_still_needed_to_judge_is_reported(self):
        memory = Lessons()
        memory.record(0, "buy", STATE)
        self.assertEqual(memory.needs(HORIZON_MIN * MINUTE), [0, HORIZON_MIN * MINUTE])
        memory.observe_close(0, 100)
        self.assertEqual(memory.needs(HORIZON_MIN * MINUTE), [HORIZON_MIN * MINUTE])
        self.assertEqual(memory.needs(HORIZON_MIN * MINUTE - MINUTE), [])

    def test_the_state_summary_keeps_only_regime_and_consensus(self):
        self.assertEqual(summarize_state(STATE + "\nrsi14: 50"), "trend b0.20 h0.70 s0.10")
        self.assertEqual(summarize_state(""), "n/a n/a")


class QuestionArmTests(unittest.TestCase):
    def test_the_original_arm_is_exactly_the_question_as_first_defined(self):
        shipped = llm.load_questions()["trade_action"]
        original = question_arm(shipped, "original")
        self.assertEqual(llm.question_hash(original), ORIGINAL_TRADE_ACTION_PIN)
        self.assertEqual(original["version"], 1)
        self.assertNotIn("lessons", original["state_fields"])
        self.assertNotIn("strategy_reliability", original["state_fields"])

    def test_every_arm_asks_the_same_decision_with_the_same_options_and_text(self):
        shipped = llm.load_questions()["trade_action"]
        for arm in ARMS:
            variant = question_arm(shipped, arm)
            self.assertEqual(variant["instruction"], shipped["instruction"])
            self.assertEqual(variant["options"], shipped["options"])
        self.assertIn("lessons", question_arm(shipped, "learning")["state_fields"])
        self.assertIn("strategy_reliability", question_arm(shipped, "context")["state_fields"])
        self.assertNotIn("lessons", question_arm(shipped, "context")["state_fields"])
        with self.assertRaises(ValueError):
            question_arm(shipped, "other")

    def test_the_shipped_question_has_no_rule_that_decides_for_the_model(self):
        text = llm.load_questions()["trade_action"]["instruction"].lower()
        for phrase in ("choose hold", "do not follow", "negative_edge"):
            self.assertNotIn(phrase, text)
        self.assertIn("trade_action@4", QUESTION_PINS)


class ReplayLearningTests(unittest.TestCase):
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

    def _blind(self, arm):
        prompts = llm.load_prompt_config()
        question = question_arm(llm.load_questions()["trade_action"], arm)
        provider = llm.FakeProvider()
        return provider, BlindQwen(provider, SPECS, question, llm.load_calibration(),
                                   prompts["templates"][prompts["default_version"]], trigger="5min",
                                   mode="raw_logprobs")

    def test_lessons_only_use_decisions_whose_horizon_had_closed(self):
        provider, blind = self._blind("learning")
        run(self.market, os.path.join(self.dir.name, "l.sqlite"), "PF_XBTUSD", ONES[300]["bucket_start"],
            ONES[1400]["bucket_start"], SPECS, qwen=blind)
        self.assertGreater(len(blind.decisions), 40)
        examples_seen = 0
        for index, decision in enumerate(blind.decisions):
            judged = [d for d in blind.decisions[:index]
                      if d["bucket_start"] + HORIZON_MIN * MINUTE <= decision["bucket_start"]]
            shown = decision["state_text"].count("lessons_example")
            self.assertLessEqual(shown, min(8, len(judged)), decision["bucket_start"])
            examples_seen += shown
        self.assertGreater(examples_seen, 0)
        self.assertIn("lessons: none yet", blind.decisions[0]["state_text"])

    def test_the_original_arm_never_sees_lessons_or_reliability(self):
        provider, blind = self._blind("original")
        run(self.market, os.path.join(self.dir.name, "o.sqlite"), "PF_XBTUSD", ONES[300]["bucket_start"],
            ONES[900]["bucket_start"], SPECS, qwen=blind)
        self.assertTrue(provider.prompts)
        for prompt in provider.prompts:
            self.assertNotIn("lessons", prompt)
            self.assertNotIn("strategy_reliability", prompt)


class LiveLessonsTests(ServiceBase):
    def test_the_live_service_keeps_each_decision_for_the_next_ones(self):
        self.questions = {"t_choice": choice_question(state_fields=["regime", "lessons"])}
        service = self.service()
        self.assertEqual(service.poll(), 1)
        row = self.rows()[0]
        self.assertIn("lessons: none yet", row["state_text"])
        memory = next(iter(service._lessons.values()))
        self.assertEqual(list(memory.decisions), [row["bucket_start"]])
        # a restart rebuilds the memory from the stored decisions
        again = self.service()
        again._readers()
        again._lessons_for(row["product_id"], self.questions["t_choice"], row["bucket_start"] + 60 * MINUTE)
        self.assertEqual(list(next(iter(again._lessons.values())).decisions), [row["bucket_start"]])

    def test_questions_without_the_field_get_no_lessons(self):
        service = self.service()
        service._readers()
        self.assertIsNone(service._lessons_for("PF_XBTUSD", self.questions["t_choice"], 0))


if __name__ == "__main__":
    unittest.main()
