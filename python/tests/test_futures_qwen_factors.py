"""La ficha de 8 factores y la pregunta por factores de la Prueba rápida (variantes ``ficha`` y ``ficha-pista``)."""
import copy
import json
import math
import os
import re
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_factors as fq
from balancita_engine import futures_qwen_ficha as ficha
from balancita_engine import futures_qwen_quick_api as quick_api
from balancita_engine import futures_qwen_quick_variants as qv
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as ex
from balancita_engine import positioning_data as pd
from balancita_engine import strategy_gate_models as models
from test_futures_qwen_exam import CFG3, cfg3
from test_futures_qwen_trader import HOLDOUT, MemHistory
from test_futures_value_area import _ts_value_area

HOUR = qt.HOUR_MS


# --------------------------------------------------------------------------- fake llama-server answers


def _entry(token, alts):
    return {"token": token, "logprob": math.log(alts[token]),
            "top_logprobs": [{"token": t, "logprob": math.log(p)} for t, p in alts.items()]}


def completion(values, style="qwen", dist=None, finish="stop"):
    """What llama-server answers to the factors question: ``choices[0].logprobs.content``, one entry per generated token.

    ``style``: how the tokenizer cuts the line. ``qwen``: ``F`` ``1`` ``:+`` ``1`` `` F`` ... and ``:`` ``0`` for a zero (what the
    Qwen3 tokenizer does); ``split``: ``:`` ``+`` ``1``; ``joint``: ``:+1`` in one token. ``dist``: per factor
    ``{"+": p, "-": p, "0": p, "mag": {1: p, 2: p}}`` (default: 0,9 on the written value, the rest shared)."""
    entries = []
    for index, value in enumerate(values):
        d = (dist or {}).get(index)
        if d is None:
            hit, rest = 0.9, 0.05
            d = {"+": hit if value > 0 else rest, "-": hit if value < 0 else rest, "0": hit if value == 0 else rest,
                 "mag": {1: 0.9, 2: 0.1} if abs(value) == 1 else {1: 0.1, 2: 0.9} if abs(value) == 2 else {1: 0.5, 2: 0.5}}
        entries.append(_entry("F" if index == 0 else " F", {"F" if index == 0 else " F": 0.99, "(": 0.001}))
        entries.append(_entry(str(index + 1), {str(index + 1): 0.99, "0": 0.001}))
        sign = "+" if value > 0 else "-" if value < 0 else "0"
        mag = d["mag"]
        if style == "qwen":
            colon = {":+": d["+"], ":-": d["-"], ":": d["0"], "(": 1e-4}
            entries.append(_entry({"+": ":+", "-": ":-", "0": ":"}[sign], colon))
            if value == 0:
                entries.append(_entry("0", {"0": 0.95, "1": 0.03, "2": 0.02}))
            else:
                entries.append(_entry(str(abs(value)), {"1": mag[1], "2": mag[2], "0": 0.001}))
        elif style == "split":
            entries.append(_entry(":", {":": 0.99, "(": 1e-4}))
            entries.append(_entry(sign, {"+": d["+"], "-": d["-"], "0": d["0"], "(": 1e-4}))
            if value != 0:
                entries.append(_entry(str(abs(value)), {"1": mag[1], "2": mag[2]}))
        else:
            alts = {":+1": d["+"] * mag[1], ":+2": d["+"] * mag[2], ":-1": d["-"] * mag[1], ":-2": d["-"] * mag[2],
                    ":0": d["0"]}
            token = ":0" if value == 0 else ":{}{}".format(sign, abs(value))
            entries.append(_entry(token, alts))
    return {"choices": [{"finish_reason": finish, "message": {"content": ""}, "logprobs": {"content": entries}}]}


class ChatProvider(llm.FakeProvider):
    """A fake llama-server for the factors question: ``script(body)`` answers each request."""

    def __init__(self, script, clock=None, **kwargs):
        super().__init__(**kwargs)
        self.chat_script = script
        self.clock = clock
        self.bodies = []

    def chat(self, body):
        if self.clock is not None:
            self.clock[0] += 1.0
        self.bodies.append(body)
        return super().chat(body)


LINE_OK = [1, -2, 0, 0, 0, 0, 0, 0]


def expected(p_plus, p_minus, mag1, mag2):
    return (p_plus - p_minus) * (mag1 + 2 * mag2) / (mag1 + mag2)


# --------------------------------------------------------------------------- grammar, request and parsing


class GrammarAndParsingTests(unittest.TestCase):
    def test_the_grammar_allows_only_one_line_of_eight_factors_with_five_values(self):
        self.assertTrue(fq.GRAMMAR.startswith('root ::= "F1:" v " F2:" v'))
        for number in range(1, 9):
            self.assertIn('"F{}:"'.format(number) if number == 1 else '" F{}:"'.format(number), fq.GRAMMAR)
        self.assertIn('v ::= ("+" | "-") ("1" | "2") | "0"', fq.GRAMMAR)
        self.assertEqual(fq.GRAMMAR.count("\n"), 1)

    def test_a_line_in_the_format_is_parsed_and_anything_else_is_not(self):
        self.assertEqual(fq.parse_line("F1:+1 F2:-2 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0"), LINE_OK)
        self.assertEqual(fq.parse_line("F1:+2 F2:+1 F3:-1 F4:-2 F5:+1 F6:-1 F7:0 F8:0 "), [2, 1, -1, -2, 1, -1, 0, 0])
        for bad in ("F1:+1 F2:-2 F3:0 F4:0 F5:0 F6:0 F7:0",                       # seven factors
                    "F1:+1 F2:-2 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0 F9:0",
                    "F1:+0 F2:-2 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0",                   # +0 is not a value
                    "F1:+3 F2:-2 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0",
                    "F1:1 F2:-2 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0",                    # a digit without a sign
                    "F2:+1 F1:-2 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0",                   # out of order
                    "F1:+1\nF2:-2 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0", "", "sube"):
            self.assertIsNone(fq.parse_line(bad), bad)

    def test_the_request_is_one_grammar_constrained_call_with_logprobs_and_the_fixed_text_first(self):
        template = {"version": 6.0, "system": "Sistema.", "answer_line": None, "prefill": None}
        prompt = fq.build_prompt("Mercado\nF1 algo", "¿Qué empuja?")
        body = fq.request_body(prompt, template)
        self.assertEqual((body["temperature"], body["logprobs"], body["top_logprobs"], body["cache_prompt"]),
                         (0, True, llm.TOP_LOGPROBS, True))
        self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(body["grammar"], fq.GRAMMAR)
        self.assertGreaterEqual(body["max_tokens"], 60)
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user"])
        self.assertTrue(prompt.startswith("QUESTION: ¿Qué empuja?\nSTATE: Mercado"))     # the shared prefix comes first
        self.assertEqual(fq.request_body(prompt, dict(template, system=None))["messages"][0]["role"], "user")

    def test_the_question_of_the_variants_is_the_one_in_the_design_and_names_every_factor(self):
        for variant_id in ("ficha", "ficha-pista"):
            question = qv.get_variant(variant_id)["factors"]["question"]
            for needle in ("F1 a F8", "próximas 4 horas", "-2 baja fuerte", "+2 sube fuerte", "F5 y F8 no votan",
                           "tiene que votar según sus números", "n/d"):
                self.assertIn(needle, question)
            # sin línea de ejemplo: Qwen la copiaba (127 de 150 fotos); la gramática ya fija el formato
            self.assertNotIn("F1:", question)
            self.assertNotIn("F1:+1", question)


# --------------------------------------------------------------------------- the gradient from the logprobs


class GradientTests(unittest.TestCase):
    def check(self, style, values=(1, -2, 2, -1, 1, -1, 2, -2)):
        dist = {i: {"+": 0.6, "-": 0.1, "0": 0.3, "mag": {1: 0.25, 2: 0.75}} for i in range(8)}
        # the sign written must be the most likely one for the generated branch to be the one the model would take
        result = fq.read_completion(completion(list(values), style, dist))
        self.assertEqual(result["values"], list(values))
        return result

    def test_the_gradient_is_the_expected_value_whatever_way_the_tokenizer_cuts_the_line(self):
        want = expected(0.6, 0.1, 0.25, 0.75)                          # 0.5 x 1.75
        results = {style: self.check(style) for style in ("qwen", "split", "joint")}
        for style, result in results.items():
            for grad in result["grads"]:
                self.assertAlmostEqual(grad, want, places=9, msg=style)
        for index in range(8):
            self.assertAlmostEqual(results["qwen"]["detail"][index]["p"]["plus"], 0.6)
            self.assertAlmostEqual(results["qwen"]["detail"][index]["p"]["zero"], 0.3)

    def test_the_text_that_was_written_is_kept_and_the_gradient_is_not_the_written_value(self):
        result = fq.read_completion(completion(LINE_OK))
        self.assertEqual(result["text"], "F1:+1 F2:-2 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0")
        self.assertLess(result["grads"][0], 1.0)           # +1 written with 0.9 of the mass: the expected value is lower
        self.assertGreater(result["grads"][0], 0.5)
        self.assertLess(result["grads"][1], -1.0)           # -2 with the magnitude mass on 2
        self.assertAlmostEqual(result["grads"][2], 0.0, places=9)

    def test_a_zero_with_the_sign_mass_split_evenly_is_zero_and_a_sure_value_is_the_value(self):
        dist = {0: {"+": 0.0001, "-": 0.0001, "0": 0.9998, "mag": {1: 0.5, 2: 0.5}},
                1: {"+": 0.9999, "-": 0.00005, "0": 0.00005, "mag": {1: 0.0001, 2: 0.9999}}}
        result = fq.read_completion(completion([0, 2, 0, 0, 0, 0, 0, 0], "qwen", dist))
        self.assertAlmostEqual(result["grads"][0], 0.0, places=3)
        self.assertAlmostEqual(result["grads"][1], 2.0, places=3)

    def test_a_zero_written_with_signed_mass_left_uses_a_magnitude_of_one(self):
        dist = {0: {"+": 0.3, "-": 0.1, "0": 0.6, "mag": {1: 0.5, 2: 0.5}}}
        for style in ("qwen", "split"):
            grads = fq.read_completion(completion([0] * 8, style, dist))["grads"]
            self.assertAlmostEqual(grads[0], 0.3 - 0.1, places=9, msg=style)
        joint = fq.read_completion(completion([0] * 8, "joint", dist))["grads"]
        self.assertAlmostEqual(joint[0], 0.2 * 1.5, places=9)            # in one token the digit mass is known

    def test_every_gradient_stays_inside_minus_two_and_plus_two(self):
        for values in ([2] * 8, [-2] * 8):
            for grad in fq.read_completion(completion(values))["grads"]:
                self.assertLessEqual(abs(grad), 2.0)

    def test_the_provider_gradients_follow_the_temperature(self):
        dist = {i: {"+": 0.6, "-": 0.3, "0": 0.1, "mag": {1: 0.5, 2: 0.5}} for i in range(8)}
        warm = fq.read_completion(completion([1] * 8, "qwen", dist), temperature=1.0)["grads"][0]
        cold = fq.read_completion(completion([1] * 8, "qwen", dist), temperature=0.2)["grads"][0]
        self.assertGreater(cold, warm)                                    # sharper distribution, closer to the written sign

    def test_an_answer_out_of_the_format_is_an_error(self):
        good = completion(LINE_OK)
        for bad in (completion(LINE_OK, finish="length"), {"choices": []}, {}, {"choices": [{"logprobs": {"content": []}}]},
                    {"choices": [{"logprobs": {"content": [_entry("sube", {"sube": 0.9})]}}]}):
            with self.assertRaises(llm.ModelResponseError):
                fq.read_completion(bad)
        broken = copy.deepcopy(good)
        broken["choices"][0]["logprobs"]["content"][3]["token"] = ":*"      # a token that is not a value
        with self.assertRaises(llm.ModelResponseError):
            fq.read_completion(broken)

    def test_the_lean_is_the_sum_of_the_six_voting_gradients_over_twelve(self):
        self.assertEqual(fq.VOTING, ("F1", "F2", "F3", "F4", "F6", "F7"))      # F5 and F8 do not vote
        self.assertEqual(fq.DENOMINATOR, 12.0)
        self.assertAlmostEqual(fq.lean_of([2, 2, 2, 2, -2, 2, 2, -2]), 1.0)   # F5 and F8 do not vote
        self.assertAlmostEqual(fq.lean_of([-2, -2, -2, -2, 2, -2, -2, 2]), -1.0)
        self.assertAlmostEqual(fq.lean_of([1, -1, 0, 0, 2, 0, 0, 2]), 0.0)
        self.assertAlmostEqual(fq.lean_of([0, 0, 0, 0, 0, 2, 0, 0]), 2 / 12)   # F6 is the fifth voter, not the sixth line
        self.assertAlmostEqual(fq.lean_of([0, 0, 0, 0, 0, 0, 2, 0]), 2 / 12)   # F7 votes
        self.assertEqual(fq.summary_action([1, 0, 0, 0, 0, 0, 0, 0])[0], "LARGO")
        self.assertEqual(fq.summary_action([0, 0, 0, 0, 2, 0, 0, 0]), ("ESPERAR", 0.0))   # a lone F5 moves nothing
        self.assertEqual(fq.summary_action([0] * 8), ("ESPERAR", 0.0))

    def test_reading_and_habit_per_factor_and_the_lean_of_the_numbers_stay_in_range(self):
        real, mirror = [2, -1, 0, 1, 1, 0, -2, 2], [-2, 1, 0, 1, -1, 0, 2, 2]
        got = fq.photo_numbers(real, mirror)
        self.assertEqual(got["lectura"], [2, -1, 0, 0, 1, 0, -2, 0])
        self.assertEqual(got["habito"], [0, 0, 0, 1, 0, 0, 0, 2])
        self.assertAlmostEqual(got["lean_num"], (2 - 1 + 0 + 0 + 0 - 2) / 12)        # F5 (1) and F8 do not add
        self.assertTrue(-1 <= got["lean_num"] <= 1)
        self.assertAlmostEqual(fq.photo_numbers([2] * 8, [-2] * 8)["lean_num"], 1.0)
        self.assertAlmostEqual(fq.photo_numbers([2] * 8, [2] * 8)["lean_num"], 0.0)


# --------------------------------------------------------------------------- the decider


class DeciderTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.cfg = qv.apply_variant(cfg3(), qv.get_variant("ficha"))

    def pdb(self):
        pdb = qt.PracticeDB(os.path.join(self.dir.name, "x.sqlite"))
        pdb.db.executescript(ex._EXAM_SQL + fq.FICHA_SQL)
        self.addCleanup(pdb.close)
        return pdb

    def decider(self, provider, pdb=None, **kwargs):
        return fq.FactorsDecider(provider, self.cfg, store=pdb, model="m", **kwargs)

    def test_an_answer_is_stored_and_a_question_already_answered_is_never_asked_again(self):
        provider = ChatProvider(lambda body: completion(LINE_OK))
        pdb = self.pdb()
        decider = self.decider(provider, pdb)
        first = decider.ask("exam:X:1", 1, "action", "estado")
        again = decider.ask("exam:X:1", 1, "action", "estado")
        self.assertEqual(provider.calls, 1)
        self.assertEqual(first["grads"], again["grads"])
        self.assertEqual(first["chosen"], "LARGO" if sum(first["grads"][:7]) > 0 else "CORTO")
        fresh = self.decider(provider, pdb)
        self.assertEqual(fresh.ask("exam:X:1", 1, "action", "estado")["values"], LINE_OK)
        self.assertEqual(provider.calls, 1)
        row = pdb.db.execute("SELECT * FROM exam_factors").fetchone()
        self.assertEqual((row["step"], row["text"], row["model"]), ("action", "F1:+1 F2:-2 F3:0 F4:0 F5:0 F6:0 F7:0 F8:0", "m"))

    def test_the_system_text_and_the_state_go_in_the_request(self):
        provider = ChatProvider(lambda body: completion(LINE_OK))
        self.decider(provider).ask("k", 1, "action", "ESTADO-DE-PRUEBA")
        messages = provider.bodies[0]["messages"]
        self.assertEqual(messages[0]["content"], self.cfg["prompt"]["system"])
        self.assertIn("Respondé con exactamente una línea", messages[0]["content"])
        self.assertTrue(messages[1]["content"].endswith("STATE: ESTADO-DE-PRUEBA"))

    def test_a_bad_format_is_a_decision_error_stored_as_a_call_error(self):
        provider = ChatProvider(lambda body: completion(LINE_OK, finish="length"))
        pdb = self.pdb()
        with self.assertRaises(qt.DecisionError):
            self.decider(provider, pdb).ask("exam:X:1", 5, "mirror", "estado")
        self.assertEqual(pdb.db.execute("SELECT block_id, step, kind FROM call_errors").fetchone()[:], ("exam:X:1", "mirror",
                                                                                                          "bad_format"))
        self.assertEqual(pdb.db.execute("SELECT COUNT(*) FROM exam_factors").fetchone()[0], 0)

    def test_three_unreachable_calls_in_a_row_mean_model_down_and_the_budget_is_respected(self):
        provider = ChatProvider(lambda body: completion(LINE_OK))
        provider.fail_with = llm.ModelUnavailable("down")
        with self.assertRaises(qt.ModelDown):
            self.decider(provider).ask("k", 1, "action", "estado")
        clock = [0.0]
        slow = ChatProvider(lambda body: completion(LINE_OK), clock=clock)
        decider = self.decider(slow, clock=lambda: clock[0], deadline=2.5)
        decider.ask("a", 1, "action", "estado")
        decider.ask("b", 1, "action", "estado")
        with self.assertRaises(qt.BudgetExhausted):
            decider.ask("c", 1, "action", "estado")


# --------------------------------------------------------------------------- the sheet (the state Qwen is shown)


def build_trader(*, positioning=None, context=("PF_ETHUSD",), bars_after=600, cfg=None):
    cfg = cfg or qv.apply_variant(cfg3(), qv.get_variant("ficha"))
    cfg["state_context"] = list(context)
    history = MemHistory()
    practice = cfg["practice"]
    start = qt.date_ms(practice["from"])
    bars = history.bars("PF_XBTUSD", start - practice["warmup_days"] * qt.DAY_MS, HOLDOUT)
    trader = qt.Trader(cfg, "PF_XBTUSD", None, history.funding("PF_XBTUSD"), key="t", entry_threshold=0.5)
    trader.positioning = positioning
    for other in context:
        trader.context[other] = {int(b["bucket_start"]) + qt.BAR_MS: float(b["close"]) for b in history.bars(
            other, start - practice["warmup_days"] * qt.DAY_MS, HOLDOUT)}
    for bar in bars[:qt.MIN_BARS + bars_after]:
        trader.feed(bar, trade=False)
    return trader, int(bars[qt.MIN_BARS + bars_after - 1]["bucket_start"]) + qt.BAR_MS


def row_of(text, number):
    return next(x for x in text.splitlines() if x.startswith("F{} ".format(number)))


def numbers_in(line):
    return [float(x.replace(",", ".")) for x in re.findall(r"[+-]?\d+(?:,\d+)?", line)]


class SheetTests(unittest.TestCase):
    def setUp(self):
        self.trader, self.t_ms = build_trader()
        self.real = self.trader.state_text(self.t_ms, ["hora_cerrada"])
        self.mirror = self.trader.state_text(self.t_ms, ["hora_cerrada"], mirror=True)

    def test_the_state_is_the_eight_numbered_lines_in_order_then_the_cost_and_the_fixed_rules(self):
        lines = self.real.splitlines()
        heads = [i for i, x in enumerate(lines) if re.match(r"F[1-8] ", x)]
        self.assertEqual([lines[i][:2] for i in heads], ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8"])
        self.assertEqual(heads, list(range(heads[0], heads[0] + 8)))
        self.assertTrue(lines[0].startswith("Mercado (velas cerradas"))
        self.assertTrue(lines[heads[-1] + 1].startswith("Costo de entrar y salir"))
        self.assertTrue(lines[heads[-1] + 2].startswith("Reglas fijas que no podés cambiar"))
        self.assertEqual(lines[-1], "Posicion: ninguna.")
        self.assertIn("F8 Momento (no vota)", self.real)
        for old in ("Retornos:", "Tendencia (retorno", "Funding:", "Volumen: ultima hora"):
            self.assertNotIn(old, self.real)                       # the plain lines are replaced, not repeated

    def test_the_mirror_turns_over_exactly_the_lines_with_a_direction(self):
        for number in (1, 2, 3, 4, 6, 7):
            self.assertNotEqual(row_of(self.real, number), row_of(self.mirror, number), "F{}".format(number))
        for number in (5, 8):                                      # sizes and the clock do not flip
            self.assertEqual(row_of(self.real, number), row_of(self.mirror, number), "F{}".format(number))
        real, mirror = self.real.splitlines(), self.mirror.splitlines()
        self.assertEqual(len(real), len(mirror))
        for a, b in zip(real, mirror):
            if not re.match(r"F[1-47] ", a) and not a.startswith("F6 "):
                self.assertEqual(a, b)                                # header, cost, rules, position: identical

    def test_f1_and_f2_flip_every_return_and_every_z(self):
        shown = lambda line: [float(x.replace(",", ".")) for x in re.findall(r"([+-]?\d+,\d+) %", line)] + \
            [float(x.replace(",", ".")) for x in re.findall(r"\(z ([+-]?\d+,\d+):", line)]
        for number in (1, 2):
            real, mirror = shown(row_of(self.real, number)), shown(row_of(self.mirror, number))
            self.assertEqual(len(real), len(mirror))
            self.assertGreaterEqual(len(real), 4)
        f1r, f1m = shown(row_of(self.real, 1)), shown(row_of(self.mirror, 1))
        self.assertEqual([-x if x else 0 for x in f1r], f1m)                         # 7d, 24h and both z
        f2r, f2m = shown(row_of(self.real, 2)), shown(row_of(self.mirror, 2))
        # 4h, 1h, 15 min flip; the normal size of 15 min (the one after them) does not
        self.assertEqual([-x if x else 0 for x in f2r[:3]], f2m[:3])
        self.assertEqual(f2r[3], f2m[3])
        self.assertEqual([-x if x else 0 for x in f2r[4:]], f2m[4:])

    def test_f3_position_goes_to_its_opposite_and_the_hours_since_high_and_low_swap(self):
        real, mirror = row_of(self.real, 3), row_of(self.mirror, 3)
        pr, pm = re.findall(r"([+-]\d,\d\d) \(", real), re.findall(r"([+-]\d,\d\d) \(", mirror)
        self.assertEqual(len(pr), 2)
        self.assertEqual([-float(x.replace(",", ".")) for x in pr], [float(x.replace(",", ".")) for x in pm])
        hr = re.search(r"máximo de 24h: ([\d,]+) \| desde el mínimo de 24h: ([\d,]+)", real).groups()
        hm = re.search(r"máximo de 24h: ([\d,]+) \| desde el mínimo de 24h: ([\d,]+)", mirror).groups()
        self.assertEqual((hr[0], hr[1]), (hm[1], hm[0]))
        self.assertTrue(-1 <= float(pr[0].replace(",", ".")) <= 1)

    def test_f7_f8_reuse_the_context_lines_and_f8_says_it_does_not_vote(self):
        self.assertIn("F7 Otros activos (retornos): ETH: 1h", self.real)
        self.assertIn("fuerza de XBT contra el activo en 4h", row_of(self.real, 7))
        self.assertRegex(row_of(self.real, 8), r"^F8 Momento \(no vota\): \w+ \d\d:00 UTC \(sesión de [^)]+\)\.$")
        alone, _ = build_trader(context=())
        self.assertIn("F7 Otros activos: n/d.", alone.state_text(self.t_ms, ["x"]))

    def test_the_numbers_for_the_table_come_from_the_same_facts_as_the_text(self):
        numbers = ficha.numbers(self.trader, self.t_ms)
        self.assertEqual(set(numbers), {"F1", "F2", "F3", "F4", "F5", "F6", "F7"})
        self.assertIsNone(numbers["F6"])                                           # no collector database in this test
        z24 = numbers_in(row_of(self.real, 1))
        self.assertAlmostEqual(numbers["F1"], z24[-1], places=1)                     # z of 24 h as printed (1 decimal)
        self.assertTrue(-1 <= numbers["F3"] <= 1)
        mirrored = ficha.numbers(self.trader, self.t_ms)
        self.assertEqual(numbers, mirrored)                                          # the numbers are always the real ones

    def test_a_plain_variant_is_not_touched_and_the_extras_still_work(self):
        variant = qv.get_variant("e123-contexto")
        cfg = qv.apply_variant(cfg3(), variant)
        trader, t_ms = build_trader(cfg=cfg)
        text = trader.state_text(t_ms, ["x"])
        for needle in ("Retornos:", "Otros activos (retornos):", "Momento: ", "Rango de las últimas 24h:", "Funding:"):
            self.assertIn(needle, text)
        self.assertNotIn("F1 Tendencia", text)

    def test_the_sheet_is_a_pure_function_of_the_candles_up_to_the_photo(self):
        trader, t_ms = build_trader(bars_after=600)
        again, _ = build_trader(bars_after=600)
        self.assertEqual(trader.state_text(t_ms, ["x"]), again.state_text(t_ms, ["x"]))
        history = MemHistory()
        later = history.bars("PF_XBTUSD", qt.date_ms("2025-01-01") - 9 * qt.DAY_MS, HOLDOUT)[qt.MIN_BARS + 600]
        self.assertNotEqual(trader.c[-1], float(later["close"]))                 # (the next candle exists but was not fed)


class ValueAreaTests(unittest.TestCase):
    @staticmethod
    def fake_trader(extra_closes):
        """288 bars of a profile with a heavy middle, then 6 bars with the given closes."""
        highs, lows, vols = [], [], []
        for i in range(288):
            mid = 100 + 5 * math.sin(i / 20.0)
            highs.append(mid + 0.5)
            lows.append(mid - 0.5)
            vols.append(1.0 + 10.0 * math.exp(-((mid - 100) ** 2) / 4.0))
        for close in extra_closes:
            highs.append(close + 0.1)
            lows.append(close - 0.1)
            vols.append(1.0)
        return SimpleNamespace(c=[(h + l) / 2 for h, l in zip(highs, lows)], h=highs, l=lows, v=vols), highs[:288], lows[:288], vols[:288]

    def test_the_area_is_the_one_of_the_value_area_indicator_on_a_small_case(self):
        trader, highs, lows, vols = self.fake_trader([100.0] * 6)
        vah, val = ficha._area(trader)
        want_poc, want_vah, want_val = _ts_value_area(list(zip(highs, lows, vols)), bins=48, share=0.7)
        self.assertAlmostEqual(vah, want_vah, places=6)
        self.assertAlmostEqual(val, want_val, places=6)
        self.assertLess(val, want_poc)
        self.assertLess(want_poc, vah)

    def test_inside_above_accepted_above_not_accepted_and_returned_from_an_exit(self):
        probe, *_ = self.fake_trader([100.0] * 6)
        vah, val = ficha._area(probe)
        width = vah - val
        inside = ficha._area_facts(self.fake_trader([100.0] * 6)[0])
        self.assertEqual((inside["place"], inside["distance"], inside["signed"]), ("dentro", 0.0, 0.0))
        out = vah + 0.5 * width
        accepted = ficha._area_facts(self.fake_trader([out] * 6)[0])
        self.assertEqual((accepted["place"], accepted["above"]), ("arriba", 6))
        self.assertGreater(accepted["distance"], 0.4)
        self.assertGreater(accepted["signed"], 0)
        brief = ficha._area_facts(self.fake_trader([100.0, 100.0, 100.0, 100.0, out, out])[0])
        self.assertEqual((brief["place"], brief["above"]), ("arriba", 2))
        back = ficha._area_facts(self.fake_trader([out, out, out, out, 100.0, 100.0])[0])
        self.assertEqual((back["place"], back["above"]), ("dentro", 4))
        under = ficha._area_facts(self.fake_trader([val - 0.2 * width] * 6)[0])
        self.assertEqual((under["place"], under["below"]), ("abajo", 6))
        self.assertLess(under["signed"], 0)

    def test_the_text_says_accepted_or_rejected_and_the_mirror_swaps_above_and_below(self):
        area = {"place": "arriba", "distance": 0.5, "above": 5, "below": 0, "signed": 0.5}
        self.assertIn("por encima del VAH a 0,50 anchos de área; 5 de los últimos 6 cierres quedaron afuera: salida aceptada",
                      ficha._f4(area, 1))
        self.assertIn("por debajo del VAL a 0,50 anchos de área; 5 de los últimos 6 cierres quedaron afuera: salida aceptada",
                      ficha._f4(area, -1))
        self.assertIn("salida todavía sin aceptar", ficha._f4(dict(area, above=2), 1))
        back = {"place": "dentro", "distance": 0.0, "above": 3, "below": 0, "signed": 0.0}
        self.assertIn("salió por encima del VAH y volvió (3 de los últimos 6 cierres afuera): salida rechazada",
                      ficha._f4(back, 1))
        self.assertIn("salió por debajo del VAL y volvió", ficha._f4(back, -1))
        self.assertIn("dentro del área.", ficha._f4(dict(back, above=0), 1))
        self.assertIn("n/d", ficha._f4(None, 1))


# --------------------------------------------------------------------------- F6: the collector's database


def positioning_db(path, product="PF_XBTUSD", first_ms=None, hours=60, long_start=40.0):
    """A collector database like ``server/src/features/positioning-collector/store.ts`` writes it."""
    con = sqlite3.connect(path)
    with con:
        con.executescript("""
CREATE TABLE positioning(product_id TEXT NOT NULL, bucket_ms INTEGER NOT NULL, long_percent REAL, long_count INTEGER,
  short_count INTEGER, top_long_percent REAL, top_long_count INTEGER, top_short_count INTEGER, top_open_interest REAL,
  PRIMARY KEY(product_id, bucket_ms)) WITHOUT ROWID, STRICT;
CREATE TABLE premium(product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_ms INTEGER NOT NULL, mark REAL NOT NULL,
  spot REAL NOT NULL, premium_bp REAL NOT NULL, PRIMARY KEY(product_id, interval_ms, bucket_ms)) WITHOUT ROWID, STRICT;""")
        for k in range(hours):
            bucket = first_ms + k * HOUR
            con.execute("INSERT INTO positioning VALUES(?,?,?,?,?,?,?,?,?)",
                        (product, bucket, long_start + k * 0.5, 10, 10, 60.0 + k * 0.25, 1, 1, 5.0))
            con.execute("INSERT INTO premium VALUES(?,?,?,?,?,?)", (product, HOUR, bucket, 101.0, 100.0, 10.0 + k * 0.5))
    con.close()


class PositioningTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "positioning.sqlite")

    def test_a_photo_sees_the_last_closed_bucket_and_never_one_that_ends_after_it(self):
        t_ms = 100 * HOUR + 20 * 60_000
        positioning_db(self.path, first_ms=40 * HOUR, hours=70)                # buckets 40 h .. 109 h
        feed = pd.PositioningFeed(self.path, "PF_XBTUSD")
        now = feed.at(t_ms)
        k = (99 * HOUR - 40 * HOUR) // HOUR                                    # the bucket 99 h..100 h ended before t_ms
        self.assertAlmostEqual(now["long"], 40.0 + k * 0.5)
        self.assertAlmostEqual(feed.at(100 * HOUR)["long"], 40.0 + k * 0.5)      # a bucket is known only from its END
        self.assertAlmostEqual(feed.at(100 * HOUR - 1)["long"], 40.0 + (k - 1) * 0.5)
        self.assertAlmostEqual(now["premium_bp"], 10.0 + k * 0.5)

    def test_a_bucket_older_than_three_hours_is_a_gap_not_the_last_value(self):
        positioning_db(self.path, first_ms=0, hours=10)
        feed = pd.PositioningFeed(self.path, "PF_XBTUSD")
        self.assertIsNotNone(feed.at(10 * HOUR + HOUR))
        self.assertIsNone(feed.at(10 * HOUR + 4 * HOUR)["long"])

    def test_the_database_is_opened_read_only_and_a_missing_file_or_product_is_not_available(self):
        positioning_db(self.path, first_ms=0, hours=5)
        feed = pd.PositioningFeed(self.path, "PF_XBTUSD")
        with self.assertRaises(sqlite3.OperationalError):
            pd._connect(self.path).execute("INSERT INTO premium VALUES('x',1,1,1,1,1)")
        self.assertTrue(feed.available)
        missing = pd.PositioningFeed(os.path.join(self.dir.name, "no.sqlite"), "PF_XBTUSD")
        self.assertFalse(missing.available)
        self.assertIsNone(missing.at(10 * HOUR))
        self.assertFalse(pd.PositioningFeed(self.path, "PF_OTRO").available)
        self.assertFalse(pd.PositioningFeed(None, "PF_XBTUSD").available)
        junk = os.path.join(self.dir.name, "junk.sqlite")
        with open(junk, "w") as handle:
            handle.write("no es una base")
        self.assertFalse(pd.PositioningFeed(junk, "PF_XBTUSD").available)

    def test_the_default_path_is_the_one_pnpm_dev_writes_unless_the_environment_says_otherwise(self):
        self.assertTrue(pd.default_path({}).endswith(os.path.join("server", "data", "dev-live", "positioning.sqlite")))
        self.assertEqual(pd.default_path({"POSITIONING_DB_PATH": "/x/p.sqlite"}), "/x/p.sqlite")
        self.assertEqual(ex.positioning_path({"positioning_db": "/y/p.sqlite"}), "/y/p.sqlite")

    def test_f6_shows_the_shares_the_change_in_24h_the_premium_and_the_funding_and_the_mirror_flips_them(self):
        probe, t_ms = build_trader()
        positioning_db(self.path, first_ms=t_ms - 60 * HOUR, hours=60)
        trader, _ = build_trader(positioning=pd.PositioningFeed(self.path, "PF_XBTUSD"))
        real = row_of(trader.state_text(t_ms, ["x"]), 6)
        mirror = row_of(trader.state_text(t_ms, ["x"], mirror=True), 6)
        last = 59                                      # the bucket that ends exactly at the photo is already known
        long_now = 40.0 + last * 0.5
        self.assertIn("cuentas largas {} %".format(qt.es(long_now, 1)), real)
        self.assertIn("cambio en 24h +12,0 puntos", real)                         # 24 buckets x 0,5
        self.assertIn("grandes operadores (20 % de mayor tamaño) largos {} %".format(qt.es(60.0 + last * 0.25, 1)), real)
        self.assertIn("prima perpetuo menos contado {} pb".format(qt.es(10.0 + last * 0.5, 1, True)), real)
        self.assertIn("cuentas largas {} %".format(qt.es(100 - long_now, 1)), mirror)
        self.assertIn("cambio en 24h -12,0 puntos", mirror)
        self.assertIn("prima perpetuo menos contado {} pb".format(qt.es(-(10.0 + last * 0.5), 1, True)), mirror)
        self.assertIn("los largos pagan", real)
        self.assertIn("los cortos pagan", mirror)
        self.assertAlmostEqual(ficha.numbers(trader, t_ms)["F6"], long_now - 50.0)

    def test_without_the_database_f6_says_n_d_and_the_photo_goes_on(self):
        trader, t_ms = build_trader(positioning=pd.PositioningFeed(os.path.join(self.dir.name, "no.sqlite"), "PF_XBTUSD"))
        line = row_of(trader.state_text(t_ms, ["x"]), 6)
        self.assertIn("cuentas largas n/d", line)
        self.assertIn("prima perpetuo menos contado n/d", line)
        self.assertIn("funding por hora", line)                                    # the funding comes from the candles' side
        text = trader.state_text(t_ms, ["x"])
        self.assertEqual(len([x for x in text.splitlines() if re.match(r"F[1-8] ", x)]), 8)
        self.assertIsNone(ficha.numbers(trader, t_ms)["F6"])

    def test_the_path_of_the_database_is_not_part_of_the_identity_of_a_run(self):
        cfg = qv.apply_variant(cfg3(), qv.get_variant("ficha"))
        self.assertEqual(qt.config_hash(cfg), qt.config_hash(dict(cfg, positioning_db="/otra/ruta.sqlite")))


# --------------------------------------------------------------------------- the variants


class VariantTests(unittest.TestCase):
    def test_the_two_variants_are_in_the_list_and_are_their_own_versions(self):
        ids = [v["id"] for v in qv.load_variants()]
        self.assertIn("ficha", ids)
        self.assertIn("ficha-pista", ids)
        base, plain, hint = qt.config_hash(CFG3), qv.get_variant("ficha"), qv.get_variant("ficha-pista")
        applied = {v["id"]: qv.apply_variant(CFG3, v) for v in (plain, hint)}
        self.assertEqual((applied["ficha"]["prompt"]["version"], applied["ficha-pista"]["prompt"]["version"]), (6.2, 6.3))
        self.assertEqual(len({base, qt.config_hash(applied["ficha"]), qt.config_hash(applied["ficha-pista"])}), 3)
        for cfg in applied.values():
            self.assertTrue(cfg["state_ficha"])
            self.assertEqual(cfg["state_context"], ["PF_ETHUSD", "PF_SOLUSD"])
            self.assertEqual(cfg["factors"]["question"], plain["factors"]["question"])
            self.assertEqual(cfg["state_variant"], CFG3["state_variant"])
        self.assertNotIn("state_ficha", CFG3)
        self.assertEqual(qt.config_hash(qv.apply_variant(CFG3, qv.get_variant("actual"))), base)

    def test_the_hint_variant_carries_the_reversion_hint_in_the_system_and_the_plain_one_does_not(self):
        reversion = qv.get_variant("p3-reversion")["prompt"]["system"]
        hint_rule = reversion.split("Regla empírica:")[1].split("Respondé")[0].strip()
        self.assertIn(hint_rule, qv.get_variant("ficha-pista")["prompt"]["system"])
        self.assertNotIn("Regla empírica", qv.get_variant("ficha")["prompt"]["system"])
        for variant_id in ("ficha", "ficha-pista"):
            self.assertIn("una línea", qv.get_variant(variant_id)["prompt"]["system"])
            self.assertNotIn("una letra", qv.get_variant(variant_id)["prompt"]["system"])

    def test_the_variants_have_their_own_files_and_the_screen_catalog_lists_them(self):
        names = {qv.db_name(v["id"]) for v in qv.load_variants()}
        self.assertEqual(len(names), len(qv.load_variants()))
        with tempfile.TemporaryDirectory() as tmp:
            api = quick_api.QuickTestApi(os.path.join(tmp, "exam-v3.sqlite"), python="py", spawn=lambda *a: None)
            catalog = {v["id"]: v for v in api.status(models.QWEN_LIVE_ID)["variants"]}
            self.assertEqual(catalog["ficha"]["kind"], "factors")
            self.assertEqual(catalog["ficha-pista"]["label"], "Ficha de 8 factores con pista de reversión")
            spawned = []
            api.spawn = lambda *a: spawned.append(a)
            api.launch(models.QWEN_LIVE_ID, "ficha")
            args = spawned[0][0]
            self.assertEqual(args[args.index("--variant") + 1], "ficha")
            self.assertIn("--quick", args)


# --------------------------------------------------------------------------- the quick test end to end


def reading_script(clock):
    """A Qwen that reads F1 (follows the z of 24 h) and writes the same F2 whatever the numbers say (a habit)."""
    def script(body):
        clock[0] += 1.0
        state = body["messages"][-1]["content"]
        z24 = float(re.search(r"de 24h [+-]?[\d,]+ % \(z ([+-]?[\d,]+)", state).group(1).replace(",", "."))
        values = [2 if z24 > 0.3 else -2 if z24 < -0.3 else 0, 1, 0, 0, 0, 0, 0, 0]
        return completion(values)
    return script


class QuickRunTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.variant = qv.get_variant("ficha")
        self.cfg = qv.apply_variant(cfg3(), self.variant)
        self.cfg["state_context"] = ["PF_ETHUSD"]                      # the test series only has two assets
        self.db = os.path.join(self.dir.name, qv.db_name("ficha"))
        self.state_path = os.path.join(self.dir.name, qv.state_name("ficha"))

    def run_quick(self, script=None, cfg=None, mirror_every=1):
        clock = [0.0]
        provider = ChatProvider(script or reading_script(clock))
        state = ex.run_quick(MemHistory(), self.db, provider, cfg or self.cfg, HOLDOUT, snapshots=30, max_minutes=500,
                             clock=lambda: clock[0], log=lambda *a: None, state_path=self.state_path, variant=self.variant,
                             mirror_every=mirror_every)
        return state, provider

    def test_the_factors_question_replaces_the_letters_two_calls_per_photo(self):
        state, provider = self.run_quick()
        self.assertEqual((state["state"], state["answered"], state["total"]), ("done", 30, 30))
        self.assertEqual(provider.calls, 60)                                       # real and mirror, one call each
        self.assertTrue(all("grammar" in b and b["max_tokens"] >= 60 for b in provider.bodies))
        con = sqlite3.connect(self.db)
        self.addCleanup(con.close)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM exam_factors").fetchone()[0], 60)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM calls").fetchone()[0], 0)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM exam_ficha").fetchone()[0], 30)
        states = {r[0] for r in con.execute("SELECT state_text FROM exam_snapshots")}
        self.assertTrue(all("F1 Tendencia larga" in s for s in states))

    def test_the_answers_come_back_as_a_lean_split_in_numbers_and_habit_like_the_exam(self):
        self.run_quick()
        rows, _ = ex.load_answers(self.db)
        self.assertEqual(len(rows), 30)
        for r in rows:
            f = r["factors"]
            self.assertTrue(-1.0 <= r["lean_num"] <= 1.0)
            self.assertAlmostEqual(r["lean"], fq.lean_of(f["real"]), places=9)
            self.assertAlmostEqual(r["lean_m"], fq.lean_of(f["mirror"]), places=9)
            self.assertAlmostEqual(r["lean_num"], (r["lean"] - r["lean_m"]) / 2, places=9)
            self.assertAlmostEqual(r["lean_num"], sum(f["lectura"][i] for i in (0, 1, 2, 3, 5, 6)) / 12, places=9)
            self.assertAlmostEqual(r["habit"], (r["lean"] + r["lean_m"]) / 2, places=9)
            self.assertAlmostEqual(r["habit"], sum(f["habito"][i] for i in (0, 1, 2, 3, 5, 6)) / 12, places=9)
            self.assertEqual(r["real_action"], fq.summary_action(f["real"])[0])
            self.assertEqual(len(f["real"]), 8)
            self.assertEqual(len(f["mirror"]), 8)
        self.assertGreaterEqual(len({round(r["lean_num"], 3) for r in rows}), 3)

    def test_the_exam_analysis_runs_unchanged_on_these_photos(self):
        self.run_quick()
        rows, _ = ex.load_answers(self.db)
        result = ex.analyse_lean(rows, self.cfg)
        self.assertEqual(result["n"], 30)
        self.assertIn(240, result["horizons"])
        text = ex.build_exam_report(self.db, self.cfg)
        self.assertIn("## Lectura por renglón", text)
        self.assertIn("## Contra la regla sin Qwen", text)

    def test_the_summary_for_the_screen_has_the_reading_table_and_the_comparison(self):
        state, _ = self.run_quick()
        summary = state["summary"]
        self.assertEqual(summary["horizon_min"], 240)
        json.dumps(summary)                                                    # it must be JSON for the screen
        with open(self.state_path, encoding="utf-8") as handle:
            self.assertIn("ficha", json.load(handle)["summary"])
        sheet = summary["ficha"]
        self.assertEqual(sheet["photos"], 30)
        table = {x["id"]: x for x in sheet["readings"]}
        self.assertEqual(list(table), ["F1", "F2", "F3", "F4", "F6", "F7"])                # F5 and F8 do not vote
        f1, f2 = table["F1"], table["F2"]
        self.assertGreaterEqual(f1["flip_share"], 0.95)                         # F1 follows the z: it flips with the mirror
        self.assertGreaterEqual(f1["corr"], 0.5)
        self.assertEqual(f1["verdict"], "lee")
        self.assertLess(f2["flip_share"] or 0.0, 0.2)                           # F2 is always +1: a habit
        self.assertEqual(f2["verdict"], "no lee")
        self.assertIsNone(table["F6"]["corr"])                                  # no collector database: nothing to correlate
        self.assertEqual(table["F6"]["corr_n"], 0)
        self.assertEqual(table["F6"]["verdict"], "sin dato")
        horizons = {c["horizon_min"]: c for c in sheet["comparison"]}
        self.assertEqual(set(horizons), {240, 1440})
        for c in horizons.values():
            self.assertEqual(c["photos"], 30)
            for key in ("qwen_spearman", "rule_spearman", "always_long_net_bp", "always_short_net_bp"):
                self.assertIn(key, c)
        self.assertAlmostEqual(horizons[1440]["always_long_net_bp"] + horizons[1440]["always_short_net_bp"],
                               -2 * ex.mean([r["cost_bp"] for r in ex.load_answers(self.db)[0]]), places=6)

    def test_the_letters_variants_do_not_get_a_sheet_in_their_summary(self):
        from test_futures_qwen_exam import state_policy
        from test_futures_qwen_trader import ClockedProvider
        clock = [0.0]
        db = os.path.join(self.dir.name, "letras.sqlite")
        state = ex.run_quick(MemHistory(), db, ClockedProvider(clock, entries=state_policy), cfg3(), HOLDOUT, snapshots=30,
                             max_minutes=500, clock=lambda: clock[0], log=lambda *a: None,
                             state_path=os.path.join(self.dir.name, "letras.json"))
        self.assertEqual(state["state"], "done")
        self.assertNotIn("ficha", state["summary"])

    def test_a_photo_whose_answer_does_not_follow_the_format_is_left_without_lean(self):
        clock = [0.0]
        good = reading_script(clock)
        counter = {"n": 0}

        def script(body):
            counter["n"] += 1
            answer = good(body)
            if counter["n"] == 2:                                # the mirror of the first photo
                answer["choices"][0]["finish_reason"] = "length"
            return answer
        state, provider = self.run_quick(script)
        self.assertEqual(state["state"], "done")
        rows, _ = ex.load_answers(self.db)
        self.assertEqual(sum(1 for r in rows if r["lean_num"] is None), 1)
        self.assertEqual(provider.calls, 60)                                       # the failed mirror was not asked again
        self.assertEqual(state["summary"]["photos"], 29)

    def test_the_positioning_database_gives_f6_a_number_and_a_correlation(self):
        photos = ex.make_photos(MemHistory(), self.cfg, "PF_XBTUSD", HOLDOUT)
        self.assertTrue(all(p["ficha"]["F6"] is None for p in photos))
        first = min(p["t_ms"] for p in photos)
        path = os.path.join(self.dir.name, "positioning.sqlite")
        positioning_db(path, first_ms=(first // HOUR - 30) * HOUR, hours=24 * 70)
        cfg = dict(self.cfg, positioning_db=path)
        withdb = ex.make_photos(MemHistory(), cfg, "PF_XBTUSD", HOLDOUT)
        self.assertEqual(len(withdb), len(photos))
        known = [p for p in withdb if p["ficha"]["F6"] is not None]
        self.assertGreater(len(known), len(photos) // 2)
        self.assertTrue(all("cuentas largas" in p["state_text"] for p in known))
        self.assertEqual(withdb[0]["state_text"].splitlines()[0], photos[0]["state_text"].splitlines()[0])


# --------------------------------------------------------------------------- the reading table and the comparison


def photo(i, real, mirror, numbers, moves=(0.0, 0.0), t=None):
    f = fq.photo_numbers(real, mirror)
    f["numbers"] = numbers
    r = {"snap_id": "s{}".format(i), "t_ms": (t if t is not None else i) * ex.DAY_MS, "moves": {"240": moves[0], "1440": moves[1]},
         "cost_bp": 10.0, "factors": f}
    r["p_largo"], r["p_corto"] = fq.probabilities_for(fq.lean_of(real))
    r["p_largo_m"], r["p_corto_m"] = fq.probabilities_for(fq.lean_of(mirror))
    r.update(ex.split_lean(r))
    return r


class ReadingTableTests(unittest.TestCase):
    def test_the_verdict_uses_the_fixed_criteria_in_order(self):
        # (vote_share, vote_n, flip, corr) -> verdict
        self.assertEqual(fq.verdict_of(0.15, 20, 0.95, 0.9), "no vota")            # votes in less than 20 % of the photos
        self.assertEqual(fq.verdict_of(0.19, 30, 0.95, 0.9), "no vota")
        self.assertEqual(fq.verdict_of(0.20, 4, 1.0, 0.9), "no vota")              # or in fewer than 5 photos
        self.assertEqual(fq.verdict_of(0.20, 5, 0.85, 0.6), "lee")                 # 20 % and 5 photos are enough to vote
        self.assertEqual(fq.verdict_of(0.97, 145, 0.85, 0.6), "lee")
        self.assertEqual(fq.verdict_of(0.97, 145, 0.80, 0.50), "lee")
        self.assertEqual(fq.verdict_of(0.97, 145, 0.9, -0.7), "lee")               # reverting the number is reading it
        self.assertEqual(fq.verdict_of(0.97, 145, 0.34, 0.64), "sesgado")          # reads the size, the habit decides the sign
        self.assertEqual(fq.verdict_of(0.97, 145, 0.79, 0.5), "sesgado")
        self.assertEqual(fq.verdict_of(0.97, 145, 0.10, -0.8), "sesgado")
        self.assertEqual(fq.verdict_of(0.97, 145, 0.95, 0.19), "no lee")
        self.assertEqual(fq.verdict_of(0.97, 145, 0.59, 0.4), "no lee")
        self.assertEqual(fq.verdict_of(0.97, 145, 0.95, None), "no lee")
        self.assertEqual(fq.verdict_of(0.97, 145, 0.85, 0.45), "a medias")
        self.assertEqual(fq.verdict_of(0.97, 145, 0.70, 0.30), "a medias")
        self.assertEqual(fq.verdict_of(None, 0, None, None), "sin dato")           # nothing to judge the line on

    def test_the_table_gives_the_four_new_verdicts_on_synthetic_rows(self):
        rows = []
        for i in range(40):
            z = (i - 20) / 10.0 or 0.05
            v = 2 if z > 0 else -2
            lazy = 1 if i % 20 == 0 else 0
            rows.append(photo(i, [v, v, 0 if i % 20 else 1, 2, 0, 0, lazy, 0],
                              [-v, v, 0 if i % 20 else 1, 2, 0, 0, lazy, 0],
                              {"F1": z, "F2": z, "F3": z, "F4": z, "F6": z, "F7": z}))
        # F1 follows the z and flips with the mirror: reads. F2 follows the z but the mirror gives the same sign: biased
        # (corr high, flips never). F3 is almost always 0: does not vote. F4 is always +2 whatever: does not read.
        table = {x["id"]: x for x in fq.reading_table(rows)}
        self.assertEqual(table["F1"]["verdict"], "lee")
        self.assertEqual((table["F1"]["vote_share"], table["F1"]["vote_n"], table["F1"]["flip_share"]), (1.0, 40, 1.0))
        self.assertAlmostEqual(table["F1"]["habit"], 0.0)
        self.assertGreater(table["F1"]["corr"], 0.8)
        self.assertEqual(table["F2"]["verdict"], "sesgado")
        self.assertEqual(table["F2"]["flip_share"], 0.0)
        self.assertGreater(table["F2"]["corr"], 0.8)
        self.assertEqual(table["F3"]["verdict"], "no vota")                        # votes in 2 of 40 photos
        self.assertEqual((table["F3"]["vote_n"], round(table["F3"]["vote_share"], 3)), (2, 0.05))
        self.assertEqual(table["F4"]["verdict"], "no lee")                         # always +2, even flipped: no flips, no corr
        self.assertEqual(table["F4"]["flip_share"], 0.0)
        self.assertEqual(table["F6"]["verdict"], "no vota")                        # never votes: not «no lee»
        self.assertEqual(table["F6"]["vote_share"], 0.0)
        self.assertIsNone(table["F6"]["flip_share"])

    def test_a_vote_in_the_middle_is_not_counted_as_not_reading(self):
        # a line that reads well when it votes but votes in 10 % of the photos is «no vota», whatever its flips and correlation
        rows = []
        for i in range(50):
            z = 2.0 if i < 5 else 0.0 + (i % 3) * 0.01
            real = [2 if i < 5 else 0, 0, 0, 0, 0, 0, 0, 0]
            mirror = [-2 if i < 5 else 0, 0, 0, 0, 0, 0, 0, 0]
            rows.append(photo(i, real, mirror, {"F1": z}))
        f1 = {x["id"]: x for x in fq.reading_table(rows)}["F1"]
        self.assertEqual((f1["vote_n"], f1["vote_share"], f1["flip_share"]), (5, 0.1, 1.0))
        self.assertEqual(f1["verdict"], "no vota")

    def test_f4_is_measured_only_on_the_photos_with_the_price_outside_the_area(self):
        def rows_with(outside, inside, votes_outside):
            rows = []
            for i in range(outside + inside):
                out = i < outside
                number = (1.0 + i % 4) * (1 if i % 2 else -1) if out else 0.0
                vote = (2 if number > 0 else -2) if out and i < votes_outside else 0
                rows.append(photo(i, [0, 0, 0, vote, 0, 0, 0, 0], [0, 0, 0, -vote, 0, 0, 0, 0], {"F4": number}))
            return rows
        # 150 photos, 15 outside the area (like the real ones): the 135 inside do not dilute the share
        f4 = {x["id"]: x for x in fq.reading_table(rows_with(15, 135, 15))}["F4"]
        self.assertEqual((f4["vote_n"], f4["base_n"], f4["vote_share"], f4["flip_share"]), (15, 15, 1.0, 1.0))
        self.assertEqual(f4["corr_n"], 15)                                         # the zeros are out of the correlation too
        self.assertEqual(f4["verdict"], "lee")
        # the photos inside the area are not «votes» even when Qwen invents one there
        noisy = rows_with(15, 135, 15)
        for r in noisy[15:]:
            r["factors"]["real"][3], r["factors"]["mirror"][3] = 2, -2
        f4n = {x["id"]: x for x in fq.reading_table(noisy)}["F4"]
        self.assertEqual((f4n["vote_n"], f4n["base_n"]), (15, 15))
        # fewer than 5 photos outside the area: nothing to say about the line
        few = {x["id"]: x for x in fq.reading_table(rows_with(4, 146, 4))}["F4"]
        self.assertEqual((few["verdict"], few["vote_share"], few["base_n"]), ("sin dato", None, 4))
        none = {x["id"]: x for x in fq.reading_table(rows_with(0, 150, 0))}["F4"]
        self.assertEqual((none["verdict"], none["vote_n"], none["corr_n"]), ("sin dato", 0, 0))
        text = "\n".join(fq.ficha_lines(fq.ficha_summary(rows_with(0, 40, 0), [240, 1440])))
        self.assertIn("F4 área de valor del día previo: sin fotos fuera del área → sin dato", text)

    def test_flips_are_counted_over_the_photos_with_a_real_gradient_of_at_least_a_quarter(self):
        rows = []
        for i in range(10):                      # F1: 5 flip, 3 do not, 2 are too small to count
            real = [2, 0, 0, 0, 0, 0, 0, 0] if i < 8 else [0.1, 0, 0, 0, 0, 0, 0, 0]
            mirror = [-2, 0, 0, 0, 0, 0, 0, 0] if i < 5 else [1, 0, 0, 0, 0, 0, 0, 0]
            rows.append(photo(i, real, mirror, {"F1": float(i)}))
        flip, n = fq._flips(rows, "F1")
        self.assertEqual((n, round(flip, 6)), (8, round(5 / 8, 6)))
        flat = [photo(1, [0.2] + [0] * 7, [-0.2] + [0] * 7, {})]
        self.assertEqual(fq._flips(flat, "F1"), (None, 0))

    def test_the_table_has_the_six_voting_lines_with_vote_flip_habit_correlation_and_verdict(self):
        rows = []
        for i in range(40):
            z = (i - 20) / 10.0
            v = 2 if z > 0 else -2
            rows.append(photo(i, [v, 1, 0, 0, 0, 0, 0, 0], [-v, 1, 0, 0, 0, 0, 0, 0], {"F1": z, "F2": z, "F3": 0.1 * (i % 5)}))
        table = {x["id"]: x for x in fq.reading_table(rows)}
        self.assertEqual(list(table), list(fq.VOTING))
        self.assertEqual((table["F1"]["verdict"], round(table["F1"]["flip_share"], 6)), ("lee", 1.0))
        self.assertGreater(table["F1"]["corr"], 0.8)
        self.assertEqual(table["F2"]["verdict"], "no lee")                       # same +1 in both: never flips
        self.assertEqual(table["F4"]["flip_n"], 0)
        self.assertEqual(table["F4"]["verdict"], "sin dato")
        self.assertEqual(table["F2"]["vote_share"], 1.0)
        self.assertAlmostEqual(table["F2"]["habit"], 1.0)                        # (+1 + +1) / 2 on every photo
        self.assertEqual(table["F1"]["number"], "z de 24 h")

    def test_the_rule_without_qwen_reverts_f1_f2_f3_f4_and_f6_with_equal_weights_scaled_to_the_range(self):
        rows = [photo(0, [0] * 8, [0] * 8, {"F1": 3.0, "F2": 3.0, "F3": 1.0, "F4": 2.0, "F6": 10.0}),
                photo(1, [0] * 8, [0] * 8, {"F1": -3.0, "F2": -3.0, "F3": -1.0, "F4": -2.0, "F6": -10.0}),
                photo(2, [0] * 8, [0] * 8, {"F1": 0.0, "F2": 0.0, "F3": 0.0, "F4": 0.0, "F6": 0.0}),
                photo(3, [0] * 8, [0] * 8, {"F1": 1.5, "F5": 9.0})]                    # missing lines count 0
        scores = [s for _, s in fq.rule_scores(rows)]
        self.assertAlmostEqual(scores[0], -1.0)                                         # everything at the top: all reversion
        self.assertAlmostEqual(scores[1], 1.0)
        self.assertAlmostEqual(scores[2], 0.0)
        self.assertAlmostEqual(scores[3], -0.5 / 5)                                    # only F1 (half of the range) counts
        self.assertTrue(all(-1.0 <= s <= 1.0 for s in scores))

    def test_the_comparison_puts_qwen_the_rule_and_always_long_short_on_the_same_photos(self):
        rows = []
        for i in range(30):
            x = (i - 15) / 15.0
            real = [2 if x > 0 else -2] + [0] * 7
            rows.append(photo(i, real, [-real[0]] + [0] * 7, {"F1": x, "F2": x, "F3": x, "F4": x, "F6": x},
                              moves=(-50.0 * x, -50.0 * x)))
        c = {x["horizon_min"]: x for x in fq.comparison(rows, [240, 1440])}
        self.assertLess(c[240]["qwen_spearman"], -0.8)                        # Qwen goes with the number, the move against it...
        self.assertGreater(c[240]["rule_spearman"], 0.9)                      # ...and the reversion rule goes against the number
        self.assertEqual(c[240]["photos"], 30)
        drift = ex.mean([r["moves"]["1440"] for r in rows])
        self.assertAlmostEqual(c[1440]["always_long_net_bp"], drift - 10.0, places=6)
        self.assertAlmostEqual(c[1440]["always_short_net_bp"], -drift - 10.0, places=6)
        self.assertEqual(fq.comparison([], [240])[0]["photos"], 0)

    def test_the_summary_block_is_none_without_factor_photos_and_has_the_markdown_tables_with_them(self):
        self.assertIsNone(fq.ficha_summary([{"snap_id": "x"}], [240]))
        rows = [photo(i, [2, 0, 0, 0, 0, 0, 0, 0], [-2, 0, 0, 0, 0, 0, 0, 0], {"F1": i / 10.0}, moves=(i, i)) for i in range(12)]
        summary = fq.ficha_summary(rows, [240, 1440])
        text = "\n".join(fq.ficha_lines(summary))
        self.assertIn("## Lectura por renglón", text)
        self.assertIn("## Contra la regla sin Qwen", text)
        self.assertIn("| 4 h |", text)
        self.assertIn("| 24 h |", text)
        self.assertIn("- F1 tendencia larga: vota 100 % (12) · da vuelta 100 % · hábito 0,00 · corr", text)
        self.assertIn("→ no lee", text)
        self.assertIn("«no vota»", text)
        self.assertIn("«sesgado»", text)
        self.assertIn("«a medias»", text)
        self.assertNotIn("F5 Volumen", text)                                     # F5 does not vote: not in the table


if __name__ == "__main__":
    unittest.main()
