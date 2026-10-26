"""Real and mirror of a photo asked at the same time (``FactorsDecider.ask_pair``, ``exam`` with the factors question)."""
import contextlib
import hashlib
import io
import os
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest import mock

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_factors as fq
from balancita_engine import futures_qwen_quick_variants as qv
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as ex
from test_futures_qwen_exam import cfg3
from test_futures_qwen_factors import LINE_OK, ChatProvider, completion
from test_futures_qwen_trader import HOLDOUT, MemHistory


def values_of(text):
    """A deterministic line of 8 values out of the STATE text (different for the real and the mirrored one)."""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return [(digest[i] % 5) - 2 for i in range(8)]


def script(body):
    return completion(values_of(body["messages"][-1]["content"]))


class OverlapProvider(ChatProvider):
    """Counts how many requests are in flight at the same time (the pair goes out together, in series it never passes 1)."""

    def __init__(self, chat_script, delay=0.03, **kwargs):
        super().__init__(chat_script, **kwargs)
        self.delay = delay
        self.lock = threading.Lock()
        self.inflight = 0
        self.max_inflight = 0
        self.requests = 0

    def chat(self, body):
        with self.lock:
            self.inflight += 1
            self.requests += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            time.sleep(self.delay)
            return llm.FakeProvider.chat(self, body)
        finally:
            with self.lock:
                self.inflight -= 1


class AskPairTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.cfg = qv.apply_variant(cfg3(), qv.get_variant("ficha"))

    def pdb(self):
        pdb = qt.PracticeDB(os.path.join(self.dir.name, "x.sqlite"))
        pdb.db.executescript(ex._EXAM_SQL + fq.FICHA_SQL)
        self.addCleanup(pdb.close)
        return pdb

    def decider(self, provider, pdb, **kwargs):
        return fq.FactorsDecider(provider, self.cfg, store=pdb, model="m", **kwargs)

    def test_a_pair_goes_out_together_and_both_rows_are_saved(self):
        provider = OverlapProvider(script)
        pdb = self.pdb()
        decider = self.decider(provider, pdb)
        real, mirror = decider.ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        self.assertEqual(provider.max_inflight, 2)
        self.assertEqual((provider.requests, decider.calls), (2, 2))
        rows = {r["step"]: r for r in pdb.db.execute("SELECT * FROM exam_factors WHERE snap_id='exam:X:1'")}
        self.assertEqual(set(rows), {"action", "mirror"})
        self.assertEqual(rows["action"]["text"], real["text"])
        self.assertEqual(rows["mirror"]["text"], mirror["text"])
        self.assertEqual(real["values"], values_of("QUESTION: {}\nSTATE: estado real".format(self.cfg["factors"]["question"])))
        self.assertIn(real["chosen"], ("LARGO", "CORTO", "ESPERAR"))
        # a concurrent pair counts once in the wall time: the mean per call is about half of one call
        self.assertGreater(decider.spent, 0)
        self.assertLess(decider.mean_call(), decider.spent)
        # nothing is asked again
        again = self.decider(provider, pdb).ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        self.assertEqual(provider.requests, 2)
        self.assertEqual(again[0]["grads"], real["grads"])

    def test_with_the_real_answer_stored_only_the_mirror_is_asked(self):
        provider = OverlapProvider(script)
        pdb = self.pdb()
        decider = self.decider(provider, pdb)
        decider.ask("exam:X:1", 1, "action", "estado real")
        provider.requests = provider.max_inflight = 0
        decider.calls = 0
        decider.ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        self.assertEqual((provider.requests, decider.calls, provider.max_inflight), (1, 1, 1))
        self.assertEqual(pdb.db.execute("SELECT COUNT(*) FROM exam_factors").fetchone()[0], 2)

    def test_a_bad_mirror_is_a_decision_error_and_the_real_answer_stays_saved_and_is_not_asked_again(self):
        def bad_mirror(body):
            answer = script(body)
            if "espejo" in body["messages"][-1]["content"]:
                answer["choices"][0]["finish_reason"] = "length"
            return answer
        provider = OverlapProvider(bad_mirror)
        pdb = self.pdb()
        decider = self.decider(provider, pdb)
        with self.assertRaises(qt.DecisionError) as caught:
            decider.ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        self.assertEqual(set(caught.exception.answers), {"action"})
        self.assertEqual([r["step"] for r in pdb.db.execute("SELECT step FROM exam_factors")], ["action"])
        self.assertEqual(pdb.db.execute("SELECT step, kind FROM call_errors").fetchone()[:], ("mirror", "bad_format"))
        self.assertEqual(decider.calls, 1)
        requests = provider.requests
        with self.assertRaises(qt.DecisionError):                   # only the mirror is asked again, never the real one
            decider.ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        self.assertEqual(provider.requests, requests + 1)

    def test_a_bad_real_answer_does_not_stop_the_valid_mirror_from_being_saved(self):
        def bad_real(body):
            answer = script(body)
            if "real" in body["messages"][-1]["content"]:
                answer["choices"][0]["finish_reason"] = "length"
            return answer
        pdb = self.pdb()
        with self.assertRaises(qt.DecisionError) as caught:
            self.decider(OverlapProvider(bad_real), pdb).ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        self.assertEqual(set(caught.exception.answers), {"mirror"})
        self.assertEqual([r["step"] for r in pdb.db.execute("SELECT step FROM exam_factors")], ["mirror"])

    def test_without_budget_nothing_is_launched(self):
        provider = OverlapProvider(script)
        clock = [100.0]
        decider = self.decider(provider, self.pdb(), clock=lambda: clock[0], deadline=99.0)
        with self.assertRaises(qt.BudgetExhausted):
            decider.ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        self.assertEqual((provider.requests, decider.calls), (0, 0))

    def test_the_budget_counts_two_calls_at_the_mean_wall_time(self):
        clock = [0.0]
        provider = ChatProvider(script, clock=clock)           # every request moves the fake clock by 1 s
        decider = self.decider(provider, self.pdb(), clock=lambda: clock[0], deadline=100.0)
        decider.ask("a", 1, "action", "x")                     # mean 1 s per call
        clock[0] = 98.5                                        # 98.5 + 2 x 1 > 100: a pair does not fit, one call does
        with self.assertRaises(qt.BudgetExhausted):
            decider.ask_pair("b", 1, "real", "espejo")
        decider.ask("b", 1, "action", "x")

    def test_three_unreachable_calls_in_a_row_are_model_down(self):
        provider = OverlapProvider(script)
        provider.fail_with = llm.ModelUnavailable("down")
        with self.assertRaises(qt.ModelDown):
            self.decider(provider, self.pdb()).ask_pair("exam:X:1", 1, "estado real", "estado espejo")

    def test_if_one_of_the_pair_is_unreachable_the_other_resets_the_count_and_the_failed_one_is_asked_again(self):
        state = {"n": 0}
        lock = threading.Lock()

        class Flaky(OverlapProvider):
            def chat(self_inner, body):
                with lock:
                    state["n"] += 1
                    first = state["n"] == 1
                if first:
                    raise llm.ModelUnavailable("one request lost")
                return super().chat(body)
        pdb = self.pdb()
        decider = self.decider(Flaky(script), pdb)
        decider.down = 2
        real, mirror = decider.ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        self.assertEqual(decider.down, 0)                          # 2 -> 0 (the other answered) -> 1 (this one) -> 0 (asked again, answered)
        self.assertEqual(pdb.db.execute("SELECT COUNT(*) FROM exam_factors").fetchone()[0], 2)
        self.assertEqual(decider.calls, 2)

    def test_sequential_pairs_ask_one_after_the_other_with_the_same_rows(self):
        a, b = OverlapProvider(script), OverlapProvider(script)
        pa, pb = self.pdb(), qt.PracticeDB(os.path.join(self.dir.name, "y.sqlite"))
        pb.db.executescript(ex._EXAM_SQL + fq.FICHA_SQL)
        self.addCleanup(pb.close)
        self.decider(a, pa).ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        self.decider(b, pb, concurrent=False).ask_pair("exam:X:1", 1, "estado real", "estado espejo")
        self.assertEqual((a.max_inflight, b.max_inflight), (2, 1))
        cut = lambda p: [tuple(r)[:5] for r in p.db.execute("SELECT * FROM exam_factors ORDER BY step")]
        self.assertEqual(cut(pa), cut(pb))


class ExamAndCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        """One exam asked together (building the photos takes seconds); the other tests start from a copy of its photos."""
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cfg = qv.apply_variant(cfg3(), qv.get_variant("ficha"))
        cls.cfg["state_context"] = ["PF_ETHUSD"]
        cls.quick = ex.quick_cfg(cls.cfg, 30)
        cls.together = os.path.join(cls.tmp.name, "together.sqlite")
        cls.together_provider = OverlapProvider(script, delay=0.005)
        cls.together_outcome = ex.run_exam(MemHistory(), cls.together, cls.together_provider, cls.quick, HOLDOUT,
                                           max_minutes=500, log=lambda *a: None, concurrent=True)
        cls.mirrors = {llm.sanitize_text(r[0]) for r in cls.rows(cls.together, "SELECT mirror_text FROM exam_snapshots")}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @staticmethod
    def rows(db, sql):
        con = sqlite3.connect(db)
        try:
            return con.execute(sql).fetchall()
        finally:
            con.close()

    def fresh(self, name):
        """A database with the same photos and no answers: ``run_exam`` finds the photos stored and only asks."""
        path = os.path.join(self.tmp.name, name)
        shutil.copy(self.together, path)
        con = sqlite3.connect(path)
        with con:
            for table in ("exam_factors", "exam_answers", "call_errors"):
                con.execute("DELETE FROM " + table)
        con.close()
        return path

    def ask(self, db, chat_script=script, concurrent=True):
        provider = OverlapProvider(chat_script, delay=0.005)
        outcome = ex.run_exam(MemHistory(), db, provider, self.quick, HOLDOUT, max_minutes=500, log=lambda *a: None,
                              concurrent=concurrent)
        return provider, outcome

    def test_the_exam_stores_the_same_rows_in_series_and_together(self):
        db = self.fresh("series.sqlite")
        provider, outcome = self.ask(db, concurrent=False)
        self.assertEqual(self.together_provider.max_inflight, 2)
        self.assertEqual(provider.max_inflight, 1)
        for out in (self.together_outcome, outcome):
            self.assertEqual((out["stop_reason"], out["answered"], out["calls"]), ("done", 30, 60))
        for sql in ("SELECT snap_id, step, text, grads_json, detail_json, prompt_hash, model FROM exam_factors ORDER BY snap_id, step",
                    "SELECT snap_id, real_action, real_p, mirror_action, mirror_p FROM exam_answers ORDER BY snap_id"):
            rows = self.rows(db, sql)
            self.assertEqual(len(rows), 60 if "factors" in sql else 30)
            self.assertEqual(rows, self.rows(self.together, sql))

    def test_a_bad_mirror_leaves_the_real_answer_in_the_photo_row_as_before(self):
        spent, lock = [], threading.Lock()

        def one_bad_mirror(body):
            answer = script(body)
            with lock:
                if not spent and body["messages"][-1]["content"].split("STATE: ", 1)[1] in self.mirrors:
                    spent.append(1)
                    answer["choices"][0]["finish_reason"] = "length"
            return answer
        db = self.fresh("bad.sqlite")
        _, outcome = self.ask(db, one_bad_mirror)
        self.assertEqual((outcome["stop_reason"], outcome["answered"], len(spent)), ("done", 30, 1))
        self.assertEqual(self.rows(db, "SELECT COUNT(*) FROM exam_answers WHERE real_action IS NOT NULL AND mirror_action IS NULL"),
                         [(1,)])
        self.assertEqual(self.rows(db, "SELECT COUNT(*) FROM exam_factors"), [(59,)])

    def test_check_parallel_says_it_is_good_when_both_ways_give_the_same_answers(self):
        db = self.together
        before = self.rows(db, "SELECT * FROM exam_factors ORDER BY snap_id, step")
        provider = OverlapProvider(script, delay=0.005)
        result = fq.check_parallel(db, self.quick, provider, 5)
        text = fq.parallel_text(result)
        self.assertEqual((result["photos"], result["compared"], result["calls"], provider.requests), (5, 5, 20, 20))
        self.assertEqual(provider.max_inflight, 2)
        self.assertEqual((result["same_both"], result["max_diff"], result["sign_changes"], result["verdict"]), (5, 0.0, 0, "sirve"))
        self.assertIn("Lectura: sirve", text)
        self.assertIn("5 de 5 fotos (100 %)", text)
        self.assertLessEqual(len(text.splitlines()), 6)
        self.assertEqual(before, self.rows(db, "SELECT * FROM exam_factors ORDER BY snap_id, step"))   # nothing was written
        self.assertEqual(self.rows(db, "SELECT COUNT(*) FROM exam_answers"), [(30,)])

    def test_check_parallel_says_to_review_when_the_parallel_answers_differ(self):
        db = self.together

        def drifting(body):
            values = values_of(body["messages"][-1]["content"])
            if threading.current_thread() is not threading.main_thread():     # only the worker threads (the parallel mode)
                values[0] = -values[0] or 2
            return completion(values)
        result = fq.check_parallel(db, self.quick, OverlapProvider(drifting, delay=0.005), 5)
        self.assertEqual(result["verdict"], "revisar")
        self.assertGreaterEqual(result["max_diff"], fq.PARALLEL_MAX_GRAD)
        self.assertIn("Lectura: revisar", fq.parallel_text(result))

    def test_the_command_runs_check_parallel_and_does_not_run_the_exam(self):
        db = self.together
        provider = OverlapProvider(script, delay=0.005)
        out = io.StringIO()
        with mock.patch.object(qt, "_provider", return_value=provider), contextlib.redirect_stdout(out):
            code = qt.main(["exam", "--version", "live", "--exam-db", db, "--check-parallel", "3"])
        self.assertEqual(code, 0)
        self.assertIn("Lectura: sirve", out.getvalue())
        self.assertEqual(provider.requests, 12)
        self.assertEqual(self.rows(db, "SELECT COUNT(*) FROM exam_answers"), [(30,)])


if __name__ == "__main__":
    unittest.main()
