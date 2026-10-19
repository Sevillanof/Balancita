"""Speed (concurrent option orders, prompt layout v2.1, entry reason skipped), the new report sections (side bias, exit decisions,
confidence, surrogate) and the probes. Fake provider / synthetic data only; no network."""
import copy
import hashlib
import io
import json
import math
import os
import random
import re
import shutil
import sqlite3
import tempfile
import threading
import unittest
from unittest import mock

import test_futures_qwen_trader as base
from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_insights as ins
from balancita_engine import futures_qwen_trader_probe as probe
from balancita_engine import futures_qwen_trader_report as rep
from balancita_engine import futures_qwen_trader_state as st

CFG2, CFG21 = base.CFG2, qt.load_config(qt.CONFIG_PATH_V21)
V2_CONFIG_HASH = "1e7cfac1bab2c44bff4d60e14df9aecf3f68d4ca0aa3aec2dcdf0828be9fbbf0"      # v2 stays reproducible
V2_PROMPT_PIN = "160dd97e0491bbb92d30d6170ffe19c9dd89321b866467466dbb869aa14b3d31"
V21_PROMPT_PIN = "4c250fafdf308daf42dcaa39d331a03f4288ed7e7192c4f04238ac7bbd6236d0"     # changing v2.1 text needs a new version


def small(cfg, **runtime):
    out = copy.deepcopy(cfg)
    out["practice"] = dict(cfg["practice"], block_days=1, time_bins=3, target_blocks=4, **{"from": base.START_DAY})
    out["practice_entry_threshold"] = 0.5
    out["runtime"] = dict(cfg.get("runtime") or {}, **runtime)
    return out


class LockedProvider(llm.FakeProvider):
    """FakeProvider that is safe to call from the worker threads."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.lock = threading.Lock()

    def complete(self, *args, **kwargs):
        with self.lock:
            return super().complete(*args, **kwargs)


def table(db, sql):
    con = sqlite3.connect(db)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


def prompt_pin(cfg):
    p = cfg["prompt"]
    body = {"p": p["system"], "a": p["answer_line"], "q": p["questions"], "v": p["version"], "o": p["orders"]}
    if p.get("state_last"):
        body["s"] = True
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


class IdentityTests(unittest.TestCase):
    def test_v2_is_reproducible_and_the_runtime_options_are_not_part_of_its_identity(self):
        self.assertEqual(qt.config_hash(CFG2), V2_CONFIG_HASH)
        self.assertEqual(prompt_pin(dict(CFG2, prompt={k: v for k, v in CFG2["prompt"].items()})), V2_PROMPT_PIN)
        flipped = dict(CFG2, runtime={"concurrent_orders": False, "skip_entry_reason": False})
        self.assertEqual(qt.config_hash(flipped), V2_CONFIG_HASH)
        self.assertEqual(CFG2["runtime"], {"concurrent_orders": True, "skip_entry_reason": True})

    def test_v21_is_a_new_prompt_version_with_the_same_texts_except_the_word_above_and_the_layout(self):
        self.assertEqual((CFG21["version"], CFG21["prompt"]["version"]), ("2.1", 2.1))
        self.assertNotEqual(qt.config_hash(CFG21), qt.config_hash(CFG2))
        self.assertEqual(prompt_pin(CFG21), V21_PROMPT_PIN)
        for name, q in CFG21["prompt"]["questions"].items():
            old = CFG2["prompt"]["questions"][name]
            self.assertEqual(q["instruction"], old["instruction"].replace("estado de arriba", "estado de abajo"))
            self.assertEqual(q["options"], old["options"])
        self.assertNotIn("arriba", json.dumps(CFG21["prompt"]["questions"], ensure_ascii=False))
        self.assertEqual(CFG21["practice"], CFG2["practice"])
        self.assertEqual(qt.block_plan(CFG21, base.HOLDOUT)[0], qt.block_plan(CFG2, base.HOLDOUT)[0])
        self.assertEqual(qt.version_paths("2.1")[1], qt.DEFAULT_DB_V21)
        self.assertNotEqual(qt.DEFAULT_DB_V21, qt.DEFAULT_DB_V2)
        self.assertEqual(qt.runtime_of(CFG21), {"concurrent_orders": True, "skip_entry_reason": True})
        self.assertEqual(qt.runtime_of(base.CFG), {"concurrent_orders": False, "skip_entry_reason": False})

    def test_the_state_text_is_identical_in_v2_and_v21(self):
        warm, nxt = base.warm_bars()
        texts = []
        for cfg in (CFG2, CFG21):
            t = base.trader(base.Script(base.always()), warm, cfg=cfg)
            texts.append(t.state_text(nxt + 11 * base.BAR, ["hora_cerrada"]))
        self.assertEqual(texts[0], texts[1])


class PromptLayoutTests(unittest.TestCase):
    def capture(self, cfg, state):
        provider = llm.LlamaCppProvider("http://127.0.0.1:8088")
        bodies = []

        def fake(method, path, timeout, body=None):
            bodies.append(body)
            return 200, json.dumps({"choices": [{"message": {"content": "A"}, "logprobs": {"content": [{
                "token": "A", "logprob": -0.1, "top_logprobs": [{"token": "A", "logprob": -0.1}, {"token": "B", "logprob": -3.0},
                                                                 {"token": "C", "logprob": -3.0}]}]}}]}).encode()
        provider._request = fake
        decider = qt.LlmDecider(provider, cfg, concurrency=1)
        decider.ask("k", 1, "action", qt.questions_for(cfg, "PF_XBTUSD")["flat"], state)
        return bodies

    def test_the_request_asks_for_prompt_caching_one_token_a_grammar_and_no_thinking(self):
        for cfg in (CFG2, CFG21):
            for body in self.capture(cfg, "estado"):
                self.assertIs(body["cache_prompt"], True)
                self.assertEqual(body["max_tokens"], 1)
                self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
                self.assertTrue(body["grammar"].startswith("root ::="))

    def test_v21_puts_the_fixed_text_first_so_two_wakes_share_a_long_prefix_and_v2_does_not(self):
        a = self.capture(CFG21, "Retornos: 1h +0,10 %\nPosicion: ninguna.")
        b = self.capture(CFG21, "Retornos: 1h -2,40 %\nPosicion: ninguna.")
        ua, ub = [[m for m in body["messages"] if m["role"] == "user"][0]["content"] for body in (a[0], b[0])]
        self.assertEqual(ua.split("STATE:")[0], ub.split("STATE:")[0])
        self.assertTrue(ua.startswith("QUESTION:"))
        prefix = ua.split("STATE:")[0]
        self.assertIn("A) ", prefix)
        self.assertIn("Respondé con una sola letra", prefix)
        self.assertNotIn("Retornos", prefix)
        self.assertTrue(ua.rstrip().endswith("Posicion: ninguna."))                  # the variable state is the tail
        common = os.path.commonprefix([ua, ub])
        self.assertGreater(len(common), len(prefix))
        # v2 starts with the state, so the shared prefix is (almost) nothing
        a2 = self.capture(CFG2, "Retornos: 1h +0,10 %")
        b2 = self.capture(CFG2, "Retornos: 1h -2,40 %")
        u2a, u2b = [[m for m in body["messages"] if m["role"] == "user"][0]["content"] for body in (a2[0], b2[0])]
        self.assertTrue(u2a.startswith("STATE:"))
        self.assertLess(len(os.path.commonprefix([u2a, u2b])), 40)

    def test_default_layout_is_exactly_the_llm_decisions_layout(self):
        question = qt.questions_for(CFG2, "PF_XBTUSD")["position"]
        template = qt.template_of(CFG2)
        self.assertEqual(qt.build_prompt("x", question, template), llm.build_prompt("x", question, template))
        self.assertNotIn("state_last", template)
        self.assertTrue(qt.template_of(CFG21)["state_last"])


class ConcurrencyTests(unittest.TestCase):
    def test_both_orders_really_go_out_at_the_same_time(self):
        barrier = threading.Barrier(2, timeout=3)

        class Barrier(LockedProvider):
            def complete(self, *args, **kwargs):
                barrier.wait()                      # only passes when the other order is in flight too
                return super().complete(*args, **kwargs)
        question = qt.questions_for(CFG2, "PF_XBTUSD")["flat"]
        decider = qt.LlmDecider(Barrier(entries=base.hashed_policy), CFG2, concurrency=2)
        answer = decider.ask("k", 1, "action", question, "estado")
        self.assertEqual(len(answer["orders"]), 2)
        sequential = qt.LlmDecider(Barrier(entries=base.hashed_policy), CFG2, concurrency=1)
        with self.assertRaises(threading.BrokenBarrierError):
            sequential.ask("k", 1, "action", question, "estado")

    def run_db(self, tmp, name, concurrent):
        db = os.path.join(tmp, name)
        provider = LockedProvider(entries=base.hashed_policy)
        qt.run_practice(base.MemHistory(), db, provider, small(CFG2), base.HOLDOUT, blocks=4, log=lambda *a: None,
                        concurrent=concurrent)
        return db, provider

    def test_sequential_and_concurrent_store_identical_decisions_trades_and_calls(self):
        tmp = tempfile.mkdtemp()
        try:
            one, p1 = self.run_db(tmp, "seq.sqlite", False)
            two, p2 = self.run_db(tmp, "conc.sqlite", True)
            self.assertEqual(p1.calls, p2.calls)
            self.assertGreater(p1.calls, 100)
            for sql in ("SELECT block_id, seq, t_ms, kind, action, model_action, p_action, override, reason, state_hash, probs_json, "
                        "orders_json, reason_json, outcome_json, net_bp_now FROM decisions ORDER BY 1, 2",
                        "SELECT * FROM trades ORDER BY 1, 2",
                        "SELECT block_id, t_ms, step, variant, order_json, probs_json, chosen, prompt_hash FROM calls ORDER BY 1, 2, 3, 4"):
                self.assertEqual(table(one, sql), table(two, sql))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_the_first_failing_order_stops_the_question_like_the_sequential_path(self):
        class Fails(LockedProvider):
            def complete(self, prompt, letters, source="raw_logprobs", template=None):
                if re.search(r"^A\) LARGO", prompt, re.M):
                    raise llm.ModelResponseError("malformed_response", "bad")
                return super().complete(prompt, letters, source, template)
        question = qt.questions_for(CFG2, "PF_XBTUSD")["flat"]

        class Store:
            def __init__(self):
                self.rows, self.errors = {}, []

            def calls(self, key, t_ms, step):
                return dict(self.rows)

            def put_call(self, row):
                self.rows[row["variant"]] = row

            def error(self, *a):
                self.errors.append(a)
        for concurrency in (1, 2):
            store = Store()
            decider = qt.LlmDecider(Fails(entries=base.hashed_policy), CFG2, store=store, concurrency=concurrency)
            with self.assertRaises(qt.DecisionError):
                decider.ask("k", 1, "action", question, "estado")
            self.assertEqual(sorted(store.rows), [], concurrency)          # variant 0 failed: nothing after it is stored
            self.assertEqual(len(store.errors), 1)

    def test_budget_check_counts_the_whole_pair(self):
        clock = [0.0]

        class Tick(LockedProvider):
            def complete(self, *a, **k):
                with self.lock:
                    clock[0] += 1.0
                return super().complete(*a, **k)
        decider = qt.LlmDecider(Tick(entries=base.hashed_policy), CFG2, clock=lambda: clock[0], deadline=3.0, concurrency=2)
        question = qt.questions_for(CFG2, "PF_XBTUSD")["flat"]
        decider.ask("k", 1, "action", question, "a")           # 2 calls, 2 s of clock: mean 1 s per call
        with self.assertRaises(qt.BudgetExhausted):
            decider.ask("k", 2, "action", question, "b")       # 2 s at 1 s per call would end at 4 s > 3 s


class EntryReasonTests(unittest.TestCase):
    def run_entry(self, cfg):
        warm, nxt = base.warm_bars()
        provider = llm.FakeProvider(entries=lambda prompt, letters: [
            {"token": l, "logprob": -0.05 if re.search(r"^{}\) (LARGO)".format(l), prompt, re.M) or
             (not re.search(r"LARGO|MANTENER", prompt) and l == "A") else -5.0} for l in letters])
        t = base.trader(qt.LlmDecider(provider, cfg, concurrency=1), warm, cfg=cfg, threshold=0.5)
        events = t.feed(base.walk(1, 14, start=nxt, price=float(warm[-1]["close"]))[0])
        return t, events, provider

    def test_the_entry_reason_is_skipped_but_the_entry_still_happens(self):
        t, events, provider = self.run_entry(CFG2)
        self.assertIsNotNone(t.position)
        self.assertEqual(len(provider.prompts), 2)                           # the two orders of the action, no reason
        self.assertIsNone(events[0]["reason"])
        self.assertIsNone(events[0]["reason_answer"])
        self.assertIsNone(t.position.entry_reason)

    def test_the_exit_reason_is_still_asked(self):
        warm, nxt = base.warm_bars()
        provider = llm.FakeProvider(entries=lambda prompt, letters: [
            {"token": l, "logprob": -0.05 if re.search(r"^{}\) (LARGO|CERRAR)".format(l), prompt, re.M) or
             (not re.search(r"LARGO|CERRAR", prompt) and l == "A") else -5.0} for l in letters])
        t = base.trader(qt.LlmDecider(provider, CFG2, concurrency=1), warm, cfg=CFG2, threshold=0.5)
        t.feed(base.walk(1, 14, start=nxt, price=float(warm[-1]["close"]))[0])
        self.assertIsNotNone(t.position)
        events = []
        for i in range(1, 4):
            events += t.feed(base.walk(1, 20 + i, start=nxt + i * base.BAR, price=t.c[-1])[0])
        trade = [e["trade"] for e in events if e["type"] == "trade"]
        self.assertTrue(trade)
        self.assertIsNotNone(trade[0]["exit_reason"])
        self.assertTrue([p for p in provider.prompts if "motivo principal" in p and "Elegiste CERRAR" in p])

    def test_the_flag_can_be_turned_off_and_v1_never_skips(self):
        t, events, provider = self.run_entry(dict(CFG2, runtime={"skip_entry_reason": False}))
        self.assertEqual(len([p for p in provider.prompts if "motivo principal" in p]), 2)
        self.assertIsNotNone(events[0]["reason"])
        t1, events1, provider1 = self.run_entry(base.CFG)
        self.assertEqual(len([p for p in provider1.prompts if "motivo principal" in p]), 1)

    def test_a_practice_without_entry_reasons_has_no_entry_reason_rows_and_the_report_does_not_break(self):
        tmp = tempfile.mkdtemp()
        try:
            db = os.path.join(tmp, "p.sqlite")
            qt.run_practice(base.MemHistory(), db, LockedProvider(entries=base.hashed_policy), small(CFG2), base.HOLDOUT, blocks=4,
                            log=lambda *a: None)
            self.assertEqual(table(db, "SELECT COUNT(*) FROM trades WHERE entry_reason IS NOT NULL")[0][0], 0)
            self.assertGreater(table(db, "SELECT COUNT(*) FROM trades WHERE exit_reason IS NOT NULL")[0][0], 0)
            text = rep.build_report(db, small(CFG2), history=base.MemHistory())
            self.assertIn("sin motivo", text)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class ThroughputAndToolsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.db2 = os.path.join(cls.tmp, "p2.sqlite")
        cls.logs = []
        qt.run_practice(base.MemHistory(), cls.db2, LockedProvider(entries=base.hashed_policy), small(CFG2), base.HOLDOUT, blocks=4,
                        log=cls.logs.append)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_the_measured_throughput_is_printed_at_the_end_of_the_batch(self):
        line = [l for l in self.logs if l.startswith("rendimiento:")]
        self.assertEqual(len(line), 1)
        for needle in ("llamadas/s", "s de reloj por llamada", "latencia de una llamada", "en paralelo", "bloques por hora"):
            self.assertIn(needle, line[0])

    def test_the_cache_share_is_shown_when_the_server_reports_it(self):
        decider = qt.LlmDecider(llm.FakeProvider(entries=base.hashed_policy), CFG2)
        decider.ask("k", 1, "action", qt.questions_for(CFG2, "PF_XBTUSD")["flat"], "x")

        class P:
            def perf_summary(self):
                return {"cache_share": 0.62}
        self.assertIn("62 % del prompt salió de la caché", qt.throughput_line(decider, P(), 10.0, 1, 10.0))

    def test_determinism_and_compare_prompts_print_progress(self):
        for fn in (lambda log, clock, prov: probe.check_determinism(self.db2, CFG2, prov, 10, log=log, clock=clock),
                   lambda log, clock, prov: probe.compare_prompts(self.db2, CFG21, prov, 10, log=log, clock=clock)):
            clock, lines = [0.0], []

            class Tick(LockedProvider):
                def complete(self, *a, **k):
                    with self.lock:
                        clock[0] += 8.0
                    return super().complete(*a, **k)
            fn(lines.append, lambda: clock[0], Tick(entries=base.hashed_policy))
            self.assertIn("Ctrl+C", lines[0])
            self.assertGreaterEqual(len([l for l in lines if " de " in l and "faltan ~" in l]), 2, lines)

    def test_check_determinism_is_zero_with_a_deterministic_server_and_sees_noise_and_wrong_versions(self):
        result = probe.check_determinism(self.db2, CFG2, LockedProvider(entries=base.hashed_policy), 10)
        self.assertEqual(result["decisions"], 10)
        self.assertEqual(result["hash_mismatch"], 0)
        self.assertEqual((result["max_seq"], result["max_conc"], result["flips_seq"]), (0.0, 0.0, 0))

        class Noisy(LockedProvider):
            def complete(self, prompt, letters, source="raw_logprobs", template=None):
                out = super().complete(prompt, letters, source, template)
                out["top_logprobs"][0]["logprob"] += 0.3 * (self.calls % 3)
                return out
        noisy = probe.check_determinism(self.db2, CFG2, Noisy(entries=base.hashed_policy), 10)
        self.assertGreater(noisy["max_seq"], 0.0)
        wrong = probe.check_determinism(self.db2, CFG21, LockedProvider(entries=base.hashed_policy), 5)
        self.assertGreater(wrong["hash_mismatch"], 0)                      # v2.1 text is not the stored v2 text
        self.assertIn("Diferencia máxima", probe.determinism_text(noisy))

    def test_compare_prompts_asks_the_same_states_under_the_new_layout(self):
        policy = lambda prompt, letters: [{"token": l, "logprob": -0.05 if re.search(r"^{}\) (ESPERAR|MANTENER)".format(l), prompt, re.M)
                                           else -5.0} for l in letters]
        result = probe.compare_prompts(self.db2, CFG21, LockedProvider(entries=policy), 20)
        n = sum(s["n"] for s in result["stats"].values())
        self.assertEqual(n, 20)
        text = probe.compare_lines(result)
        self.assertIn("v2 contra v2.1", text)
        self.assertIn("Coincidieron en el", text)
        stored = probe.stored_decisions(self.db2)
        self.assertTrue(all(d["state_text"] for d in stored))

    def test_the_v21_practice_runs_the_same_blocks_and_the_report_compares_it_with_v2_on_identical_states(self):
        db21 = os.path.join(self.tmp, "p21.sqlite")
        qt.run_practice(base.MemHistory(), db21, LockedProvider(entries=base.hashed_policy), small(CFG21), base.HOLDOUT, blocks=4,
                        log=lambda *a: None)
        self.assertEqual(table(db21, "SELECT DISTINCT prompt_version FROM decisions"), [(2.1,)])
        self.assertEqual(table(self.db2, "SELECT block_id FROM blocks ORDER BY 1"), table(db21, "SELECT block_id FROM blocks ORDER BY 1"))
        text = rep.build_report(db21, small(CFG21), history=base.MemHistory(), prompt_baseline=(self.db2, small(CFG2)))
        self.assertIn("## v2 contra v2.1", text)
        self.assertIn("Decisiones con el mismo estado", text)
        self.assertIn("prompt `qwen-trader` v2.1", text)
        self.assertNotIn("v2 contra v2.1", rep.build_report(self.db2, small(CFG2), history=base.MemHistory()))


# --------------------------------------------------------------------------- statistics and report calculations


def rows_of(scores, goods, fold, block="b0", results=None):
    return [{"block_id": "{}{}".format(block, i % 6), "t_ms": i, "fold": fold, "score": s, "good": g, "p": s, "margin": s,
             "agree": 1.0 if g else 0.0, "result": (results[i] if results else (1.0 if g else -1.0))}
            for i, (s, g) in enumerate(zip(scores, goods))]


class StatsTests(unittest.TestCase):
    def test_auc_known_values_ties_and_missing_class(self):
        self.assertEqual(ins.auc([1, 2, 3, 4], [False, False, True, True]), 1.0)
        self.assertEqual(ins.auc([4, 3, 2, 1], [False, False, True, True]), 0.0)
        self.assertEqual(ins.auc([1, 1, 1, 1], [False, True, False, True]), 0.5)
        self.assertAlmostEqual(ins.auc([1, 3, 2, 4], [False, True, True, False]), 0.5)
        self.assertIsNone(ins.auc([1, 2], [True, True]))

    def test_spearman_and_top_bottom_quintiles(self):
        self.assertAlmostEqual(ins.spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]), 1.0)
        self.assertAlmostEqual(ins.spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1.0)
        self.assertIsNone(ins.spearman([1, 1, 1], [1, 2, 3]))
        rows = rows_of(list(range(50)), [i >= 25 for i in range(50)], "validation", results=[float(i) for i in range(50)])
        top, bottom, nt, nb = ins.top_bottom(rows)
        self.assertEqual((nt, nb), (10, 10))
        self.assertAlmostEqual(top, statistics_mean(range(40, 50)))
        self.assertAlmostEqual(bottom, statistics_mean(range(0, 10)))
        binary = rows_of([0.0, 1.0] * 20, [i % 2 == 1 for i in range(40)], "validation")
        top, bottom, nt, nb = ins.top_bottom(binary)
        self.assertEqual((top, bottom, nt, nb), (1.0, -1.0, 20, 20))

    def test_isotonic_is_monotone_and_pools_violators(self):
        knots, values = ins.isotonic_fit([1, 2, 3, 4, 5, 6], [0, 1, 0, 1, 1, 1])
        self.assertEqual(values, sorted(values))
        model = (knots, values)
        self.assertAlmostEqual(ins.isotonic_predict(model, 1), 0.0)
        self.assertAlmostEqual(ins.isotonic_predict(model, 2), 0.5)
        self.assertAlmostEqual(ins.isotonic_predict(model, 3), 0.5)
        self.assertAlmostEqual(ins.isotonic_predict(model, 6), 1.0)
        self.assertAlmostEqual(ins.isotonic_predict(model, 100), 1.0)

    def test_confidence_that_ranks_is_detected_and_noise_is_not(self):
        rng = random.Random(3)
        n = 400
        good = [rng.random() < 0.5 for _ in range(n)]
        informative = [(0.6 + 0.3 * g + 0.05 * rng.random()) for g in good]
        noise = [rng.random() for _ in range(n)]
        for scores, expect in ((informative, "ordena"), (noise, "no ordena")):
            rows = rows_of(scores, good, "validation")
            lo, hi = ins.auc_ci(rows, seed=1)
            if expect == "ordena":
                self.assertGreater(lo, 0.5)
            else:
                self.assertLess(lo, 0.5 < hi or 0.5)
                self.assertTrue(lo < 0.5 < hi)

    def test_the_calibration_map_only_uses_the_calibration_fold(self):
        rng = random.Random(5)
        cal = rows_of([rng.random() for _ in range(200)], [rng.random() < 0.5 for _ in range(200)], "calibration")
        val_a = rows_of([rng.random() for _ in range(100)], [True] * 100, "validation", block="v")
        val_b = rows_of([r["p"] for r in val_a], [False] * 100, "validation", block="v")
        self.assertEqual(ins.calibration_map(cal + val_a), ins.calibration_map(cal + val_b))
        self.assertIsNone(ins.calibration_map(val_a))                     # no calibration rows: no map, never validation
        table_a = ins.calibration_table(cal + val_a)
        table_b = ins.calibration_table(cal + val_b)
        self.assertEqual([t["calibrated"] for t in table_a], [t["calibrated"] for t in table_b])
        self.assertNotEqual([t["observed"] for t in table_a], [t["observed"] for t in table_b])


def statistics_mean(values):
    values = list(values)
    return sum(values) / len(values)


class StateParsingTests(unittest.TestCase):
    def state(self):
        warm, nxt = base.warm_bars()
        script = base.Script(lambda t, step, q: {"LARGO": 1.0} if q["id"] == "trader_flat" else {"MANTENER": 1.0})
        t = base.trader(script, warm, cfg=CFG2,
                        funding=[(nxt - 3000 * qt.HOUR_MS + i * qt.HOUR_MS, 3e-5 * ((-1) ** i)) for i in range(3000)])
        t.feed(base.walk(1, 8, start=nxt, price=float(warm[-1]["close"]), sigma=0.0001)[0])
        for i in range(6):
            t.feed(base.walk(1, 30 + i, start=nxt + (i + 1) * base.BAR, price=t.c[-1], sigma=0.0003)[0])
        return t.state_text(nxt + 8 * base.BAR, ["cada_15_min"])

    def test_every_number_is_read_back_and_a_substitution_changes_only_that_number(self):
        text = self.state()
        feats = st.extract(text)
        for name in ("ret_1h", "ret_7d", "z_4h", "vol24", "mov15", "norm15", "dist_max24", "dist_min7", "vol_1h_rel", "funding_rate",
                     "funding_pct", "open_min", "pnl_pct", "pnl_usd", "sig4h", "favor", "side"):
            self.assertIn(name, feats, name)
        self.assertEqual(feats["side"], 1.0)
        self.assertEqual(feats["open_min"], 35)
        for name, value in (("ret_4h", 3.21), ("vol24", 4.0), ("open_min", 400), ("pnl_pct", -1.5), ("funding_rate", 0.0123)):
            new = st.substitute(text, name, value)
            self.assertNotEqual(new, text)
            self.assertAlmostEqual(st.extract(new)[name], st.displayed(name, value))
            others = {k: v for k, v in st.extract(text).items() if k != name}
            self.assertEqual({k: v for k, v in st.extract(new).items() if k != name}, others)
            a, b = text.splitlines(), new.splitlines()
            self.assertEqual(len(a), len(b))
            self.assertEqual(sum(1 for x, y in zip(a, b) if x != y), 1)          # exactly one line differs
        self.assertIsNone(st.substitute("Posicion: ninguna.", "pnl_pct", 1.0))


# --------------------------------------------------------------------------- synthetic report data


def block(block_id, fold, closes, product="PF_XBTUSD"):
    return {"block_id": block_id, "product": product, "start_ms": 0, "end_ms": len(closes) * qt.BAR_MS, "bin": 0, "fold": fold,
            "wakes": 0, "seconds": 1.0, "closes": closes}


def trade(block_id, no, side, net, fold="validation", product="PF_XBTUSD"):
    return {"block_id": block_id, "trade_no": no, "product": product, "side": side, "fold": fold, "net_bp": net, "funding_bp": 0.0,
            "entry_ms": 0, "exit_ms": 1, "closed_by": "qwen", "hold_min": 5, "entry_p": 0.7, "entry_reason": None, "exit_reason": None,
            "time_bin": 0}


class SideBiasTests(unittest.TestCase):
    def test_counts_shares_means_and_the_market_drift_of_the_same_blocks(self):
        data = {"blocks": {"a": block("a", "calibration", [100.0, 110.0]), "b": block("b", "validation", [100.0, 90.0]),
                           "c": block("c", "validation", [100.0, 120.0])},
                "trades": [trade("a", 1, "LONG", 50.0, "calibration"), trade("a", 2, "LONG", -10.0, "calibration"),
                           trade("b", 1, "SHORT", 80.0), trade("c", 1, "LONG", 30.0)]}
        rows = {(r["product"], r["fold"]): r for r in ins.side_bias(data, ["PF_XBTUSD"])}
        total = rows[(None, None)]
        self.assertEqual((total["n"], total["long"], total["short"]), (4, 3, 1))
        self.assertAlmostEqual(total["long_mean"], (50 - 10 + 30) / 3)
        self.assertAlmostEqual(total["short_mean"], 80.0)
        self.assertAlmostEqual(total["drift"], (0.10 - 0.10 + 0.20) / 3)
        self.assertAlmostEqual(total["up_share"], 2 / 3)
        val = rows[(None, "validation")]
        self.assertEqual((val["n"], val["long"], val["blocks"]), (2, 1, 2))
        sentence = ins.side_bias_sentence(list(rows.values()))
        self.assertIn("Compró (largo) el 75 %", sentence)
        self.assertIn("mientras el mercado subió", sentence)
        self.assertIn("## ¿Prefiere comprar o vender?", "\n".join(ins.side_bias_lines(data, ["PF_XBTUSD"])))

    def test_no_entries_is_handled(self):
        data = {"blocks": {"a": block("a", "calibration", [100.0, 101.0])}, "trades": []}
        self.assertIn("no hay entradas", ins.side_bias_sentence(ins.side_bias(data, ["PF_XBTUSD"])))


def state_text(pnl, vol24, open_text):
    return ("Mercado. Despertaste por: cada_15_min.\nVolatilidad diaria: ultimas 24h {} % | ultimos 7d 2,00 %. Movimiento de los ultimos "
            "15 min +0,10 % (lo normal es +-0,20 %)\nPosicion: LARGO abierta hace {}.\nResultado si cerras ahora, ya con todos los "
            "costos: {} % ({} USD).").format(qt.es(vol24), open_text, qt.es(pnl, 2, True), qt.es(pnl, 2, True))


def pos_decision(block_id, t_ms, action, now_bp, fold, state, snapshot, p=0.9):
    probs = {"MANTENER": p, "CERRAR": 1 - p} if action == "MANTENER" else {"MANTENER": 1 - p, "CERRAR": p}
    orders = json.dumps([{"order": ["MANTENER", "CERRAR"], "probabilities": probs}, {"order": ["CERRAR", "MANTENER"], "probabilities": probs}])
    return {"block_id": block_id, "seq": 1, "t_ms": t_ms, "kind": "position", "product": "PF_XBTUSD", "fold": fold, "model_action": action,
            "p_action": p, "action": action, "override": None, "reason": None, "orders_json": orders, "reason_json": None,
            "outcome_json": None, "net_bp_now": now_bp, "latency_ms": 0, "wake_json": "[]", "prompt_version": 2, "state_hash": "h",
            "state_text": state, "position_json": json.dumps(snapshot), "trade_no": snapshot["trade_no"]}


class ExitDecisionTests(unittest.TestCase):
    def setUp(self):
        # a day of steadily rising closes: holding beats closing, closing beats nothing
        closes = [100.0 * (1 + 0.0005 * i) for i in range(288)]
        self.block = block("a", "validation", closes)
        entry_px = qt.D("100.00")
        self.snap = {"side": "LONG", "entry_ms": 0, "entry_px": str(entry_px), "qty": str(qt.D(100) / entry_px), "trade_no": 1}
        self.cfg = base.CFG2

    def now_bp(self, index):
        pos = qt.Position(side="LONG", entry_ms=0, entry_px=qt.D("100.00"), qty=qt.D(100) / qt.D("100.00"))
        return qt.settle("PF_XBTUSD", pos, self.block["closes"][index], "strategy_exit", (index + 1) * qt.BAR_MS, None, qt.D(100))["net_bp"]

    def data(self, decisions):
        return {"blocks": {"a": self.block}, "trades": [], "decisions": decisions, "meta": {}}

    def test_hold_beats_close_in_a_rally_and_the_numbers_are_the_other_choice_counterfactual(self):
        t_ms = 24 * qt.BAR_MS
        now = self.now_bp(23)
        keep = pos_decision("a", t_ms, "MANTENER", now, "validation", state_text(-1.5, 2.4, "7 h 05 min"), self.snap)
        shut = pos_decision("a", t_ms + qt.BAR_MS, "CERRAR", self.now_bp(24), "validation", state_text(0.4, 2.4, "30 min"), self.snap)
        rows = ins.position_rows(self.data([keep, shut]), self.cfg)
        self.assertEqual(len(rows), 2)
        k, c = rows
        self.assertGreater(k["gain"]["1h"], 0)                       # holding in a rally beat closing
        self.assertAlmostEqual(c["gain"]["1h"], -(k["gain"]["1h"] + 0) + 0, delta=40)    # closing lost the same kind of money
        self.assertLess(c["gain"]["1h"], 0)
        self.assertLess(c["gain"]["4h"], c["gain"]["1h"])
        self.assertIsNotNone(k["gain"]["block_end"])
        # exact check against the shared accounting
        pos = qt.Position(side="LONG", entry_ms=0, entry_px=qt.D("100.00"), qty=qt.D(100) / qt.D("100.00"))
        hold = qt.settle("PF_XBTUSD", pos, self.block["closes"][23 + 12], "strategy_exit", t_ms + qt.HOUR_MS, None, qt.D(100))["net_bp"]
        self.assertAlmostEqual(k["gain"]["1h"], hold - now, delta=0.02)
        self.assertEqual((k["pnl_bucket"], k["time_bucket"]), ("perdida_grande", "4_12h"))
        self.assertEqual((c["pnl_bucket"], c["time_bucket"]), ("ganancia_pequena", "menos_1h"))

    def test_no_lookahead_past_the_block_end_there_is_no_label(self):
        late = 280 * qt.BAR_MS
        row = ins.position_rows(self.data([pos_decision("a", late, "MANTENER", self.now_bp(279), "validation",
                                                        state_text(0.1, 2.4, "5 h 00 min"), self.snap)]), self.cfg)[0]
        self.assertIsNone(row["gain"]["1h"])
        self.assertIsNone(row["gain"]["4h"])
        # the closes list ends at the block end: nothing after it exists to be read
        self.assertEqual(len(self.block["closes"]) * qt.BAR_MS, self.block["end_ms"])

    def test_summaries_buckets_and_the_plain_conclusion(self):
        decisions = []
        for i in range(60):
            t_ms = (10 + i) * qt.BAR_MS
            decisions.append(pos_decision("a", t_ms, "MANTENER", self.now_bp(9 + i), "validation",
                                          state_text(0.3, 2.4, "{} min".format(10 + i)), self.snap))
        rows = ins.position_rows(self.data(decisions), self.cfg)
        s = ins.exit_summary(rows, "1h")
        self.assertEqual(s["n"], 60)
        self.assertEqual(s["better"], 1.0)
        text = "\n".join(ins.exit_lines(rows))
        for needle in ("## Decisiones de salida, una por una", "Mejor (1 h)", "ganancia pequeña", "menos de 1 h abierta",
                       "Donde mejor decide: mantener"):
            self.assertIn(needle, text)
        self.assertIsNone(re.search(r"\bnan\b", text.lower()))
        self.assertIn("todavía no hay decisiones", "\n".join(ins.exit_lines([])).lower())

    def test_forced_closes_of_v1_are_respected_like_in_the_export(self):
        data = self.data([pos_decision("a", 24 * qt.BAR_MS, "MANTENER", self.now_bp(23), "validation",
                                       state_text(0.1, 2.4, "5 min"), self.snap)])
        data["trades"] = [{"block_id": "a", "trade_no": 1, "closed_by": "stop", "exit_ms": 26 * qt.BAR_MS, "net_bp": -300.0}]
        row = ins.position_rows(data, self.cfg)[0]
        self.assertAlmostEqual(row["gain"]["1h"], -300.0 - self.now_bp(23), delta=0.02)


class ConfidenceAnalysisTests(unittest.TestCase):
    def make(self, informative, n_val=120, n_cal=120, seed=2):
        rng = random.Random(seed)
        decisions, blocks, trades = [], {}, []
        for fold, n in (("calibration", n_cal), ("validation", n_val)):
            for i in range(n):
                good = rng.random() < 0.5
                p = (0.6 + 0.3 * good + 0.05 * rng.random()) if informative else 0.6 + 0.3 * rng.random()
                block_id = "{}{}".format(fold[0], i % 8)
                blocks[block_id] = block(block_id, fold, [100.0, 100.0])
                probs = {"LARGO": p, "CORTO": (1 - p) / 2, "ESPERAR": (1 - p) / 2}
                orders = json.dumps([{"order": list(probs), "probabilities": probs}, {"order": list(probs), "probabilities": probs}])
                trades.append(trade(block_id, 1000 + len(trades), "LONG", 10.0 if good else -10.0, fold))
                decisions.append({"block_id": block_id, "t_ms": len(decisions), "kind": "flat", "fold": fold, "action": "LARGO",
                                  "p_action": p, "orders_json": orders, "trade_no": trades[-1]["trade_no"], "state_text": ""})
                trades[-1]["block_id"] = block_id
        return {"blocks": blocks, "trades": trades, "decisions": decisions}

    def test_informative_confidence_orders_entries_and_noise_does_not(self):
        for informative, verdict in ((True, "ordena"), (False, "no ordena")):
            data = self.make(informative)
            results = ins.confidence_analysis(data, [], seed=1)
            entry_p = [r for r in results if r["group"].startswith("Entradas") and r["signal"] == "p"][0]
            self.assertEqual(entry_p["verdict"], verdict, entry_p)
            if informative:
                self.assertGreater(entry_p["auc"], 0.9)
                self.assertGreater(entry_p["top"], entry_p["bottom"])
                self.assertIn("ordena", ins.confidence_conclusion(results))
                self.assertIn("La mejor señal es", ins.confidence_conclusion(results))
            else:
                self.assertIn("no lleva información y no debe usarse como filtro", ins.confidence_conclusion(results))

    def test_order_agreement_and_margin_signals(self):
        margin, agree = ins.order_signals(json.dumps([{"probabilities": {"A": 0.9, "B": 0.1}}, {"probabilities": {"A": 0.6, "B": 0.4}}]))
        self.assertAlmostEqual(margin, (math.log(9) + math.log(1.5)) / 2)
        self.assertEqual(agree, 1.0)
        _, agree = ins.order_signals(json.dumps([{"probabilities": {"A": 0.9, "B": 0.1}}, {"probabilities": {"A": 0.4, "B": 0.6}}]))
        self.assertEqual(agree, 0.0)
        self.assertEqual(ins.order_signals(None), (None, None))

    def test_changing_validation_outcomes_changes_validation_numbers_but_not_the_calibration_map(self):
        data = self.make(True)
        samples = ins.confidence_samples(data, [])["Entradas (resultado de la operación)"]
        flipped = copy_with_flipped_validation(data)
        samples2 = ins.confidence_samples(flipped, [])["Entradas (resultado de la operación)"]
        self.assertEqual(ins.calibration_map(samples), ins.calibration_map(samples2))
        a = ins.confidence_analysis(data, [], seed=1)[0]
        b = ins.confidence_analysis(flipped, [], seed=1)[0]
        self.assertNotEqual(a["auc"], b["auc"])

    def test_the_section_renders_plain_spanish_and_never_nan(self):
        data = self.make(False)
        text = "\n".join(ins.confidence_lines(data, [], seed=1))
        for needle in ("## ¿Sirve su seguridad", "AUC", "Calibración con isotónica", "Veredicto"):
            self.assertIn(needle, text)
        self.assertIsNone(re.search(r"\bnan\b", text.lower()))


def copy_with_flipped_validation(data):
    out = dict(data, trades=[dict(t, net_bp=-t["net_bp"]) if t["fold"] == "validation" else dict(t) for t in data["trades"]])
    return out


class SurrogateTests(unittest.TestCase):
    def make(self, seed=1, poison_validation=False):
        rng = random.Random(seed)
        decisions = []
        for fold, n in (("calibration", 240), ("validation", 120)):
            for i in range(n):
                pnl = rng.uniform(-3.0, 3.0)
                hours = rng.uniform(0.2, 14.0)
                minutes = int(hours * 60)
                text = state_text(pnl, 2.4, "{} h {:02d} min".format(minutes // 60, minutes % 60) if minutes >= 60 else "{} min".format(minutes))
                action = "CERRAR" if (pnl < -0.5 and hours > 6) else "MANTENER"
                if poison_validation and fold == "validation":
                    action = "MANTENER" if action == "CERRAR" else "CERRAR"
                decisions.append({"block_id": "{}{}".format(fold[0], i % 6), "t_ms": i, "kind": "position", "fold": fold,
                                  "model_action": action, "state_text": text})
        return {"decisions": decisions}

    def test_the_tree_recovers_a_simple_rule_and_says_it_in_plain_spanish(self):
        r = ins.surrogate(self.make(), "position", ins.POSITION_FEATURES, ("MANTENER", "CERRAR"))
        self.assertEqual(r["status"], "ok")
        self.assertGreater(r["agree_tree"], 0.9)
        self.assertGreater(r["agree_tree"], r["agree_base"])
        sentences = [ins.rule_sentence(x) for x in r["rules"]]
        close = [s for s in sentences if "elige **CERRAR**" in s]
        self.assertTrue(close, sentences)
        self.assertTrue(any("lleva abierta más de" in s or "el resultado actual" in s for s in close), close)
        text = "\n".join(ins.surrogate_lines(self.make()))
        for needle in ("Describe la conducta de Qwen, no la verdad del mercado", "Reglas del árbol", "Con posición (MANTENER o CERRAR)",
                       "regresión logística"):
            self.assertIn(needle, text)
        self.assertIn("Es más probable que elija CERRAR", text)

    def test_logistic_regression_gets_the_direction_right(self):
        r = ins.surrogate(self.make(), "position", ins.POSITION_FEATURES, ("MANTENER", "CERRAR"))
        coef = r["models"]["CERRAR"]["coef"]
        self.assertLess(coef["pnl_pct"], 0)             # the more it loses, the more it closes
        self.assertGreater(coef["open_h"], 0)           # the longer it is open, the more it closes

    def test_it_is_fitted_on_calibration_only(self):
        a = ins.surrogate(self.make(), "position", ins.POSITION_FEATURES, ("MANTENER", "CERRAR"))
        b = ins.surrogate(self.make(poison_validation=True), "position", ins.POSITION_FEATURES, ("MANTENER", "CERRAR"))
        self.assertEqual(a["rules"], b["rules"])
        self.assertEqual(json.dumps(a["models"]["CERRAR"]["coef"], sort_keys=True), json.dumps(b["models"]["CERRAR"]["coef"], sort_keys=True))
        self.assertLess(b["agree_tree"], 0.2)           # judged on the (poisoned) validation fold: agreement collapses
        self.assertGreater(a["agree_tree"], 0.9)

    def test_too_little_data_is_said_not_hidden(self):
        r = ins.surrogate({"decisions": self.make()["decisions"][:10]}, "position", ins.POSITION_FEATURES, ("MANTENER", "CERRAR"))
        self.assertEqual(r["status"], "pocos datos")
        self.assertIn("Todavía no hay decisiones suficientes", "\n".join(ins.surrogate_lines({"decisions": []})))


# --------------------------------------------------------------------------- probes


class ProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.db = os.path.join(cls.tmp, "p2.sqlite")
        qt.run_practice(base.MemHistory(), cls.db, LockedProvider(entries=cls.mixed_policy), small(CFG2), base.HOLDOUT, blocks=4,
                        log=lambda *a: None)

    @staticmethod
    def mixed_policy(prompt, letters):
        """Flat decisions as in the other tests; in a position, close exactly when the shown result is below -0.20 %."""
        options = dict(re.findall(r"^([A-Z])\) (\w+)", prompt, re.M))
        if "MANTENER" in options.values():
            return ProbeTests.pnl_policy(prompt, letters)
        key = (re.search(r"\| de 7d: [^\n]*", prompt) or re.search(r".", prompt)).group(0)       # a number no probe changes
        stand_in = key + "\nQUESTION: x\n" + "\n".join("{}) {}".format(k, v) for k, v in options.items())
        return base.hashed_policy(stand_in, letters)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def fresh(self, name):
        path = os.path.join(self.tmp, name)
        shutil.copy(self.db, path)
        return path

    @staticmethod
    def pnl_policy(prompt, letters):
        """A model that closes exactly when the result shown is below -0.20 % and otherwise looks at nothing."""
        options = dict(re.findall(r"^([A-Z])\) (\w+)", prompt, re.M))
        if "MANTENER" in options.values():
            match = re.search(r"cerras ahora, ya con todos los costos: ([+-]?\d+,\d+) %", prompt)
            pick = "CERRAR" if match and float(match.group(1).replace(",", ".")) < -0.20 else "MANTENER"
        else:
            pick = "ESPERAR"
        return [{"token": l, "logprob": -0.05 if options[l] == pick else -5.0} for l in letters]

    def test_each_variant_changes_exactly_one_number_to_a_realistic_value(self):
        decisions = probe.stored_decisions(self.db)
        pct = probe.percentiles(decisions)
        positions = [d for d in decisions if d["kind"] == "position"]
        self.assertTrue(positions)
        checked = set()
        for d in positions[:80]:
            for name, level, text, old, new in probe.variants_for(d, pct)[1:]:
                feats, after = st.extract(d["state_text"]), st.extract(text)
                changed = {k for k in after if k != "wake" and after[k] != feats.get(k)}
                allowed = {"retorno_1h": {"ret_1h", "z_1h"}, "retorno_4h": {"ret_4h", "z_4h"}, "retorno_24h": {"ret_24h", "z_24h"},
                           "retorno_7d": {"ret_7d", "z_7d"}, "resultado_actual": {"pnl_pct", "pnl_usd"}}.get(name, {probe.FEATURES[name][2]})
                self.assertTrue(changed and changed <= allowed, (name, changed))
                lo, hi = pct[(d["product"], d["kind"], probe.FEATURES[name][2])]
                self.assertTrue(min(lo, hi) - 1e-9 <= new <= max(lo, hi) + 1e-9)       # the observed 10th / 90th percentile
                self.assertEqual(len(text.splitlines()), len(d["state_text"].splitlines()))
                checked.add(name)
        self.assertTrue({"resultado_actual", "tiempo_abierto", "retorno_4h", "volatilidad"} <= checked, checked)
        flats = [d for d in decisions if d["kind"] == "flat"][:30]
        for d in flats:
            self.assertFalse({"resultado_actual", "tiempo_abierto"} & {v[0] for v in probe.variants_for(d, pct)})

    def test_the_sample_is_seeded_stratified_and_every_prefix_is_balanced(self):
        decisions = probe.stored_decisions(self.db)
        a = probe.probe_sample(decisions, 40, 7)
        self.assertEqual([(d["block_id"], d["seq"]) for d in a], [(d["block_id"], d["seq"]) for d in probe.probe_sample(decisions, 40, 7)])
        self.assertNotEqual([(d["block_id"], d["seq"]) for d in a], [(d["block_id"], d["seq"]) for d in probe.probe_sample(decisions, 40, 8)])
        self.assertEqual({d["kind"] for d in a[:12]}, {"flat", "position"})
        self.assertEqual([(d["block_id"], d["seq"]) for d in probe.probe_sample(decisions, 20, 7)],
                         [(d["block_id"], d["seq"]) for d in a[:20]])

    def test_probes_find_the_one_number_the_model_looks_at_and_the_noise_floor_is_zero(self):
        db = self.fresh("probe1.sqlite")
        result = probe.run_probe(db, small(CFG2), LockedProvider(entries=self.mixed_policy), sample=60, max_minutes=55.0, log=lambda *a: None)
        self.assertEqual(result["stop_reason"], "done")
        results = probe.probe_results(db)
        self.assertEqual(results[probe.CONTROL]["levels"]["repetir"]["flip"], 0.0)
        rows, base_flip, base_shift, sentence = ins.probe_summary(results)
        self.assertEqual(rows[0]["name"], "resultado_actual")
        self.assertGreater(rows[0]["flip"], 0.0)
        for r in rows[1:]:
            self.assertEqual(r["flip"], 0.0, r["name"])
        self.assertIn("resultado si cierra ahora", sentence)
        text = "\n".join(ins.probe_lines(db))
        for needle in ("## ¿Qué datos mira de verdad?", "percentil 10", "repetir sin cambiar nada", "**mira**"):
            self.assertIn(needle, text)
        full = rep.build_report(db, small(CFG2), history=base.MemHistory())
        self.assertIn("## ¿Qué datos mira de verdad?", full)
        self.assertNotIn("## ¿Qué datos mira de verdad?", rep.build_report(self.db, small(CFG2), history=base.MemHistory()))
        # the practice's own call statistics are untouched by the probes
        self.assertEqual(table(db, "SELECT COUNT(*) FROM calls"), table(self.db, "SELECT COUNT(*) FROM calls"))
        self.assertGreater(table(db, "SELECT COUNT(*) FROM probe_calls")[0][0], 100)

    def test_the_probe_is_resumable_and_budgeted(self):
        db_full, db_cut = self.fresh("full.sqlite"), self.fresh("cut.sqlite")
        p_full = LockedProvider(entries=self.mixed_policy)
        probe.run_probe(db_full, small(CFG2), p_full, sample=20, log=lambda *a: None)
        clock = [0.0]

        class Tick(LockedProvider):
            def complete(self, *a, **k):
                with self.lock:
                    clock[0] += 1.0
                return super().complete(*a, **k)
        p1, p2 = Tick(entries=self.mixed_policy), LockedProvider(entries=self.mixed_policy)
        cut = probe.run_probe(db_cut, small(CFG2), p1, sample=20, max_minutes=0.5, clock=lambda: clock[0], log=lambda *a: None)
        self.assertEqual(cut["stop_reason"], "budget")
        done = probe.run_probe(db_cut, small(CFG2), p2, sample=20, log=lambda *a: None)
        self.assertEqual(done["stop_reason"], "done")
        self.assertEqual(p1.calls + p2.calls, p_full.calls)                       # nothing asked twice
        sql = "SELECT block_id, t_ms, step, variant, probs_json FROM probe_calls ORDER BY 1, 2, 3, 4"
        self.assertEqual(table(db_full, sql), table(db_cut, sql))
        again = LockedProvider(entries=self.mixed_policy)
        probe.run_probe(db_cut, small(CFG2), again, sample=20, log=lambda *a: None)
        self.assertEqual(again.calls, 0)

    def ticking(self, clock, step=10.0):
        class Tick(LockedProvider):
            def complete(self, *a, **k):
                with self.lock:
                    clock[0] += step
                return super().complete(*a, **k)
        return Tick(entries=self.mixed_policy)

    def test_the_probe_prints_a_line_before_the_first_request_and_progress_while_running(self):
        clock, lines = [0.0], []
        probe.run_probe(self.fresh("prog.sqlite"), small(CFG2), self.ticking(clock), sample=12, clock=lambda: clock[0], log=lines.append)
        first = next(i for i, l in enumerate(lines) if l.startswith("preguntando a Qwen"))
        self.assertIn("Ctrl+C", lines[first])
        self.assertTrue(lines[0].startswith("sondas:") and first == 1)
        progress = [l for l in lines if l.startswith("sondas: ") and " de 12 decisiones" in l]
        self.assertGreaterEqual(len(progress), 3)
        self.assertRegex(progress[-1], r"sondas: \d+ de 12 decisiones, \d+ llamadas, [\d.]+ min, faltan ~[\d.]+ min")
        stamps = [float(re.search(r"([\d.]+) min, faltan", l).group(1)) for l in progress]
        self.assertTrue(all(b - a <= 1.0 for a, b in zip(stamps, stamps[1:])))      # never more than ~60 s of clock apart

    def test_ctrl_c_exits_cleanly_and_leaves_the_probe_resumable(self):
        db = self.fresh("ctrlc.sqlite")
        seen = {"n": 0}

        class Interrupt(LockedProvider):
            def complete(self, *a, **k):
                seen["n"] += 1
                if seen["n"] > 6:
                    raise KeyboardInterrupt
                return super().complete(*a, **k)
        with self.assertRaises(KeyboardInterrupt):
            probe.run_probe(db, small(CFG2), Interrupt(entries=self.mixed_policy), sample=10, log=lambda *a: None, concurrency=1)
        stored = table(db, "SELECT COUNT(*) FROM probe_calls")[0][0]
        self.assertGreater(stored, 0)
        again = LockedProvider(entries=self.mixed_policy)
        self.assertEqual(probe.run_probe(db, small(CFG2), again, sample=10, log=lambda *a: None)["stop_reason"], "done")
        full = LockedProvider(entries=self.mixed_policy)
        probe.run_probe(self.fresh("ctrlc-full.sqlite"), small(CFG2), full, sample=10, log=lambda *a: None)
        self.assertEqual(again.calls + stored, full.calls)
        with mock.patch.object(qt, "load_config", side_effect=KeyboardInterrupt):
            self.assertEqual(qt.main(["probe"]), 130)

    def test_a_probe_database_from_another_seed_is_refused_and_a_dead_server_is_said(self):
        db = self.fresh("seed.sqlite")
        probe.run_probe(db, small(CFG2), LockedProvider(entries=self.mixed_policy), sample=4, seed=1, log=lambda *a: None)
        with self.assertRaises(qt.TraderError):
            probe.run_probe(db, small(CFG2), LockedProvider(entries=self.mixed_policy), sample=4, seed=2, log=lambda *a: None)
        with self.assertRaises(qt.TraderError):
            probe.run_probe(self.fresh("down.sqlite"), small(CFG2), LockedProvider(healthy=False), sample=4, log=lambda *a: None)

    def test_the_probe_only_reads_stored_text_never_candles_or_the_holdout(self):
        db = self.fresh("nocandles.sqlite")
        real = qt.History.bars
        qt.History.bars = lambda *a, **k: (_ for _ in ()).throw(AssertionError("candles were read"))
        try:
            probe.run_probe(db, small(CFG2), LockedProvider(entries=self.mixed_policy), sample=6, log=lambda *a: None)
        finally:
            qt.History.bars = real
        self.assertTrue(all(d["t_ms"] < base.HOLDOUT for d in probe.stored_decisions(db)))

    def test_the_estimate_counts_both_orders_and_uses_the_measured_latency(self):
        calls, minutes = probe.estimate(1000, 1.1, True)
        self.assertEqual(calls, 2000)
        self.assertAlmostEqual(minutes, 1000 * 1.1 / 60)
        self.assertAlmostEqual(probe.estimate(1000, 1.1, False)[1], 2 * 1000 * 1.1 / 60)


class CliTests(unittest.TestCase):
    def test_the_new_commands_and_flags_parse_and_loopback_is_enforced(self):
        parser = qt._parser()
        args = parser.parse_args(["probe", "--version", "2", "--sample", "200", "--max-minutes", "55"])
        self.assertEqual((args.command, args.version, args.sample), ("probe", "2", 200))
        args = parser.parse_args(["practice", "--version", "2.1", "--check-determinism", "100", "--sequential"])
        self.assertEqual((args.version, args.check_determinism, args.sequential), ("2.1", 100, True))
        args = parser.parse_args(["compare-prompts", "--n", "50"])
        self.assertEqual((args.version, args.from_version, args.n), ("2.1", "2", 50))
        for command in (["probe", "--llama-url", "http://example.com:8088"], ["compare-prompts", "--llama-url", "http://example.com:8088"],
                        ["practice", "--check-determinism", "5", "--llama-url", "http://example.com:8088"]):
            err = io.StringIO()
            import contextlib
            with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(qt.main(command), 2)
            self.assertIn("loopback", err.getvalue())


if __name__ == "__main__":
    unittest.main()
