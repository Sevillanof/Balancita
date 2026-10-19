import json
import os
import shutil
import sqlite3
import tempfile
import unittest

from balancita_engine.futures_forward_result import read_forward
from balancita_engine.futures_llm_decisions import DecisionStore
from balancita_engine.futures_q_cases import Q_CASES_LIMIT, model_state, read_q_cases

NOW = 1_800_000_000_000
MINUTE = 60_000
PROBABILITIES = {"buy": 0.6, "hold": 0.3, "sell": 0.1}


class QCasesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.db = os.path.join(self.dir, "decisions.sqlite")

    def schema(self):
        DecisionStore(self.db, {"max_verdict_lag_ms": 1000}).close()
        raw = sqlite3.connect(self.db)
        self.addCleanup(raw.close)
        return raw

    def decide(self, raw, bucket, written_at, product="PF_XBTUSD", chosen="buy", probabilities=PROBABILITIES):
        raw.execute(
            "INSERT INTO paper_futures_llm_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (product, bucket, "trade_action", 3, "h", "choice", "Qwen3-4B", "{}", "p", 2, "raw", "state", "[]",
             json.dumps(probabilities), 1.0, chosen, None, 0.6, 840, json.dumps({"prompt_ms": 412.5, "predicted_ms": 0.4}), written_at))
        raw.commit()

    def skip(self, raw, bucket, written_at, code, reason, product="PF_XBTUSD"):
        raw.execute("INSERT INTO paper_futures_llm_skips(product_id, bucket_start, question_id, question_version, "
                    "code, reason, written_at) VALUES(?,?,'trade_action',3,?,?,?)",
                    (product, bucket, code, reason, written_at))
        raw.commit()

    def error(self, raw, bucket, written_at, kind, message, product="PF_XBTUSD"):
        raw.execute("INSERT INTO paper_futures_llm_errors(product_id, bucket_start, question_id, question_version, "
                    "kind, message, model_ref, written_at) VALUES(?,?,'trade_action',3,?,?,'m',?)",
                    (product, bucket, kind, message, written_at))
        raw.commit()

    def test_a_decision_carries_option_probabilities_confidence_and_provenance(self):
        raw = self.schema()
        self.decide(raw, NOW - 5 * MINUTE, NOW - 4 * MINUTE)
        cases = read_q_cases(self.db, NOW, env={})
        self.assertTrue(cases["available"])
        [case] = cases["latest"]
        self.assertEqual(case["kind"], "decision")
        self.assertEqual((case["question_id"], case["question_version"]), ("trade_action", 3))
        self.assertEqual(case["chosen"], "buy")
        self.assertEqual(case["probabilities"], PROBABILITIES)
        self.assertEqual(case["confidence"], 0.6)
        self.assertEqual((case["probability_source"], case["prompt_version"], case["latency_ms"]), ("raw", 2, 840))
        self.assertEqual(case["model_ref"], "Qwen3-4B")
        self.assertEqual(case["written_at"], NOW - 4 * MINUTE)

    def test_the_time_is_split_between_reading_the_prompt_and_answering(self):
        raw = self.schema()
        self.decide(raw, NOW - 5 * MINUTE, NOW - 4 * MINUTE)
        [case] = read_q_cases(self.db, NOW, env={})["latest"]
        self.assertEqual((case["prompt_ms"], case["predicted_ms"]), (412.5, 0.4))
        # A decision stored without timings says so instead of inventing them.
        raw.execute("DROP TRIGGER paper_futures_llm_decisions_no_update")
        raw.execute("UPDATE paper_futures_llm_decisions SET timings_json='{}'")
        raw.commit()
        [case] = read_q_cases(self.db, NOW, env={})["latest"]
        self.assertEqual((case["prompt_ms"], case["predicted_ms"]), (None, None))

    def test_skips_and_errors_say_why_there_is_no_decision_and_everything_is_newest_first(self):
        raw = self.schema()
        self.decide(raw, NOW - 10 * MINUTE, NOW - 3 * MINUTE)
        self.skip(raw, NOW - 9 * MINUTE, NOW - MINUTE, "model_down", "modelo local caído (llama-server no responde)")
        self.error(raw, NOW - 8 * MINUTE, NOW - 2 * MINUTE, "no_letters", "no option letter", product="PF_ETHUSD")
        latest = read_q_cases(self.db, NOW, env={})["latest"]
        self.assertEqual([c["kind"] for c in latest], ["skip", "error", "decision"])
        self.assertEqual((latest[0]["code"], latest[0]["reason"]),
                         ("model_down", "modelo local caído (llama-server no responde)"))
        self.assertEqual((latest[1]["code"], latest[1]["product_id"]), ("no_letters", "PF_ETHUSD"))
        self.assertNotIn("probabilities", latest[0])

    def test_the_list_is_capped(self):
        raw = self.schema()
        for index in range(Q_CASES_LIMIT + 5):
            self.decide(raw, NOW - (index + 10) * MINUTE, NOW - index * 1000)
            self.skip(raw, NOW - (index + 10) * MINUTE, NOW - index * 1000, "calm_skip", "calma")
        self.assertEqual(len(read_q_cases(self.db, NOW, env={})["latest"]), Q_CASES_LIMIT)

    def test_without_database_or_tables_it_says_why(self):
        missing = read_q_cases(self.db, NOW, env={})
        self.assertFalse(missing["available"])
        self.assertIn("sin base de decisiones", missing["reason"])
        self.assertEqual(missing["latest"], [])
        sqlite3.connect(self.db).close()
        empty = read_q_cases(self.db, NOW, env={})
        self.assertFalse(empty["available"])
        self.assertIn("todavía no existe", empty["reason"])

    def test_the_launcher_says_the_model_was_never_started(self):
        env = {"Q_NOT_STARTED_REASON": "modelo local no iniciado: falta LLAMA_MODEL_PATH"}
        state = model_state(env)
        self.assertEqual(state["code"], "not_started")
        self.assertIn("falta LLAMA_MODEL_PATH", state["reason"])
        # Also without any database: the reason is not hidden behind "Q has not run".
        self.assertEqual(read_q_cases(self.db, NOW, env=env)["model"]["code"], "not_started")

    def health_file(self, **processes):
        path = os.path.join(self.dir, "dev-health.json")
        with open(path, "w") as handle:
            json.dump({"processes": processes}, handle)
        return {"DEV_HEALTH_FILE": path}

    def test_a_stopped_llama_server_is_not_the_same_as_one_that_never_started(self):
        state = model_state(self.health_file(llm={"status": "down", "last_exit": 1}, q={"status": "running"}))
        self.assertEqual(state["code"], "llm_stopped")
        self.assertIn("llama-server", state["reason"])
        self.assertIn("1", state["reason"])
        self.assertNotIn("no iniciado", state["reason"])
        restarting = model_state(self.health_file(llm={"status": "restarting", "last_exit": "SIGKILL"}))
        self.assertEqual(restarting["code"], "llm_stopped")

    def test_a_stopped_q_is_said(self):
        state = model_state(self.health_file(llm={"status": "running"}, q={"status": "down", "last_exit": 2}))
        self.assertEqual(state["code"], "q_stopped")

    def test_healthy_or_unknown_processes_give_no_model_state(self):
        self.assertIsNone(model_state({}))
        self.assertIsNone(model_state(self.health_file(llm={"status": "running"}, q={"status": "running"})))
        self.assertIsNone(model_state({"DEV_HEALTH_FILE": os.path.join(self.dir, "nope.json")}))

    def test_read_forward_exposes_the_cases(self):
        raw = self.schema()
        self.decide(raw, NOW - 10 * MINUTE, NOW - 9 * MINUTE)
        result = read_forward(None, None, None, self.db, now_ms=NOW)
        self.assertEqual(result["q_cases"]["latest"][0]["chosen"], "buy")


if __name__ == "__main__":
    unittest.main()
