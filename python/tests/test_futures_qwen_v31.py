"""Qwen operador v3.1: entry by lean (real vs mirrored STATE), three cyclic option orders, fixed exit plan (stop + 4 h).

Fake model only. v2.1 and v3 must keep their behaviour and their config hashes."""

import contextlib
import copy
import io
import math
import os
import re
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_report as rep
from test_futures_qwen_trader import (BAR, HOLDOUT, MIN, START_DAY, ClockedProvider, MemHistory, Script, feed_all, trader,
                                      walk, warm_bars)

CFG21 = qt.load_config(qt.CONFIG_PATH_V21)
CFG3 = qt.load_config(qt.CONFIG_PATH_V3)
CFG31 = qt.load_config(qt.CONFIG_PATH_V31)
V21_CONFIG_HASH = "c05bfd0664498f875305589e812986a707bae4b39acfca3b9d37b433a1771ec3"    # pinned before v3.1 existed
V3_CONFIG_HASH = "c342bf2ce5516e901c2c99ac40997bc3273202d711486b2c5853942a5de2ac5e"     # the hash of the v3 practice base

UP = {"LARGO": 0.6, "CORTO": 0.2, "ESPERAR": 0.2}        # lean +0.4
DOWN = {"LARGO": 0.2, "CORTO": 0.6, "ESPERAR": 0.2}      # lean -0.4


def lean_script(real, mirror, position="MANTENER"):
    """``real`` / ``mirror``: probabilities of the flat question on the real and on the mirrored STATE."""
    def fn(t_ms, step, question):
        if question["id"] == "trader_position":
            return {position: 1.0}
        if question["id"] != "trader_flat":
            return {"otro": 1.0}
        return dict(mirror if step == "mirror" else real)
    return fn


def open_with(real, mirror, position="MANTENER", cfg=CFG31):
    warm, nxt = warm_bars()
    script = Script(lean_script(real, mirror, position))
    t = trader(script, warm, cfg=cfg, threshold=cfg["practice_entry_threshold"])
    events = t.feed(walk(1, 8, start=nxt, price=float(warm[-1]["close"]), sigma=0.0001)[0])
    return t, events, script, nxt + BAR


def flat_bars(start, price, n):
    return [{"bucket_start": start + i * BAR, "open": repr(price), "high": repr(price * 1.0001), "low": repr(price * 0.9999),
             "close": repr(price), "volume_btc": "1"} for i in range(n)]


def decisions(events):
    return [e for e in events if e["type"] == "decision"]


def trades(events):
    return [e["trade"] for e in events if e["type"] == "trade"]


class V31ConfigTests(unittest.TestCase):
    def test_v31_has_its_own_files_and_the_older_versions_keep_their_hashes(self):
        self.assertEqual(qt.config_hash(CFG21), V21_CONFIG_HASH)
        self.assertEqual(qt.config_hash(CFG3), V3_CONFIG_HASH)
        self.assertNotIn(qt.config_hash(CFG31), (V21_CONFIG_HASH, V3_CONFIG_HASH))
        self.assertEqual(qt.version_paths("3.1"), (qt.CONFIG_PATH_V31, qt.DEFAULT_DB_V31))
        self.assertEqual(len({qt.version_paths(v)[1] for v in qt.VERSIONS}), len(qt.VERSIONS))
        self.assertEqual(CFG31["version"], "3.1")
        self.assertEqual((CFG31["entry_mode"], CFG31["entry_lean"]), ("lean", 0.15))
        self.assertIn("examen por inclinación", CFG31["entry_lean_note"])
        self.assertEqual(CFG31["guardrails"], {"stop_sigma_24h": 1.0, "min_stop_pct": 0.005, "max_stop_pct": 0.03,
                                               "max_hold_min": 240, "cooldown_min": 15})
        self.assertEqual(CFG31["state_variant"], 3)
        for key in ("wake", "practice", "runtime", "products", "notional_usd"):     # the rest comes from v3 unchanged
            self.assertEqual(CFG31[key], CFG3[key])

    def test_v3_stays_in_choice_mode_without_stop_or_time_limit(self):
        self.assertEqual(qt.entry_mode_of(CFG3), "choice")
        self.assertEqual(qt.entry_mode_of(CFG21), "choice")
        self.assertNotIn("entry_mode", CFG3)
        self.assertIsNone(CFG3["guardrails"]["stop_sigma_24h"])
        self.assertIsNone(CFG3["guardrails"]["max_hold_min"])
        self.assertEqual(CFG3["state_variant"], 2)
        self.assertEqual(len(qt.LlmDecider(llm.FakeProvider(), CFG3)._orders(qt.questions_for(CFG3, "PF_XBTUSD")["flat"])), 2)

    def test_the_note_of_entry_lean_is_not_identity_but_entry_lean_is(self):
        other = copy.deepcopy(CFG31)
        other["entry_lean_note"] = "otra nota"
        self.assertEqual(qt.config_hash(other), qt.config_hash(CFG31))
        other["entry_lean"] = 0.2
        self.assertNotEqual(qt.config_hash(other), qt.config_hash(CFG31))
        for key, value in (("entry_mode", "choice"), ("state_variant", 2)):
            another = copy.deepcopy(CFG31)
            another[key] = value
            self.assertNotEqual(qt.config_hash(another), qt.config_hash(CFG31))

    def test_three_cyclic_orders_for_three_options_and_two_for_two(self):
        questions = qt.questions_for(CFG31, "PF_XBTUSD")
        decider = qt.LlmDecider(llm.FakeProvider(), CFG31)
        orders = decider._orders(questions["flat"])
        self.assertEqual(orders, [[0, 1, 2], [1, 2, 0], [2, 0, 1]])
        for option in range(3):                                   # every option takes every letter once
            self.assertEqual({order.index(option) for order in orders}, {0, 1, 2})
        self.assertEqual(decider._orders(questions["position"]), [[0, 1], [1, 0]])
        self.assertEqual(len(decider._orders(questions["reason"])), 2)

    def test_the_questions_say_the_truth_about_the_plan(self):
        q31, q3 = qt.questions_for(CFG31, "PF_XBTUSD"), qt.questions_for(CFG3, "PF_XBTUSD")
        self.assertNotIn("Si no ves una ventaja clara", q31["flat"]["instruction"])
        self.assertIn("Si no ves una ventaja clara, esperá.", q3["flat"]["instruction"])
        self.assertEqual(q31["flat"]["instruction"], q3["flat"]["instruction"].replace(" Si no ves una ventaja clara, esperá.", ""))
        self.assertIn("se cierra sola a las 4 h", q31["position"]["instruction"])
        self.assertIn("podés cerrarla antes", q31["position"]["instruction"])
        self.assertNotIn("No hay stop", q31["position"]["instruction"])
        self.assertIn("No hay stop ni límite de tiempo", q3["position"]["instruction"])
        self.assertEqual(q31["position"]["instruction"].split(" La posición se cierra")[0],
                         q3["position"]["instruction"].split(" No hay stop")[0])

    def test_lean_mode_needs_entry_lean(self):
        cfg = copy.deepcopy(CFG31)
        cfg["entry_lean"] = None
        with self.assertRaises(qt.TraderError):
            qt.Trader(cfg, "PF_XBTUSD", Script(lean_script(UP, DOWN)), entry_threshold=0.15)
        cfg["entry_mode"] = "raro"
        with self.assertRaises(qt.TraderError):
            qt.entry_mode_of(cfg)


class LeanEntryTests(unittest.TestCase):
    def test_enters_by_the_sign_of_lean_num_when_the_mirror_turns_over(self):
        for real, mirror, side, action in ((UP, DOWN, "LONG", "LARGO"), (DOWN, UP, "SHORT", "CORTO")):
            t, events, script, _ = open_with(real, mirror)
            self.assertEqual(t.position.side, side)
            d = decisions(events)[0]
            self.assertEqual(d["action"], action)
            self.assertIsNone(d["override"])
            sign = 1.0 if side == "LONG" else -1.0
            self.assertAlmostEqual(d["lean"], 0.4 * sign)
            self.assertAlmostEqual(d["lean_m"], -0.4 * sign)
            self.assertAlmostEqual(d["lean_num"], 0.4 * sign)
            self.assertAlmostEqual(d["habit"], 0.0)
            self.assertAlmostEqual(t.position.entry_p, 0.4)                 # entry_p = |lean_num|
            self.assertEqual(d["threshold"], 0.15)
            self.assertEqual([s for _, s, _, _ in script.asked], ["action", "mirror"])   # the mirror is always asked
            texts = {s: x for _, s, _, x in script.asked}
            self.assertNotEqual(texts["action"], texts["mirror"])

    def test_pure_habit_does_not_enter(self):
        for same in (UP, DOWN):
            t, events, _, _ = open_with(same, same)
            self.assertIsNone(t.position)
            d = decisions(events)[0]
            self.assertEqual(d["action"], "ESPERAR")
            self.assertIsNone(d["override"])
            self.assertAlmostEqual(d["lean_num"], 0.0)
            self.assertAlmostEqual(abs(d["habit"]), 0.4)

    def test_the_chosen_letter_and_the_half_threshold_do_not_matter_only_the_lean(self):
        # both STATEs choose ESPERAR (0.6) and no side reaches 0.5, yet the lean turns over: v3.1 enters LONG
        t, events, _, _ = open_with({"LARGO": 0.4, "CORTO": 0.0, "ESPERAR": 0.6}, {"LARGO": 0.0, "CORTO": 0.4, "ESPERAR": 0.6})
        self.assertEqual(t.position.side, "LONG")
        d = decisions(events)[0]
        self.assertEqual((d["model_action"], d["mirror_action"]), ("ESPERAR", "ESPERAR"))
        self.assertAlmostEqual(d["lean_num"], 0.4)
        # LARGO is the chosen option with 0.7 on both STATEs: the mirror does not move, so nothing is entered
        t, events, _, _ = open_with({"LARGO": 0.7, "CORTO": 0.1, "ESPERAR": 0.2}, {"LARGO": 0.7, "CORTO": 0.1, "ESPERAR": 0.2})
        self.assertIsNone(t.position)
        self.assertEqual(decisions(events)[0]["model_action"], "LARGO")

    def test_entry_lean_is_the_limit_a_weaker_lean_waits_and_an_equal_one_enters(self):
        weak_real, weak_mirror = {"LARGO": 0.4, "CORTO": 0.3, "ESPERAR": 0.3}, {"LARGO": 0.3, "CORTO": 0.4, "ESPERAR": 0.3}
        t, events, _, _ = open_with(weak_real, weak_mirror)                 # lean_num = 0.10 < 0.15
        self.assertIsNone(t.position)
        self.assertAlmostEqual(decisions(events)[0]["lean_num"], 0.1)
        cfg = copy.deepcopy(CFG31)
        cfg["entry_lean"] = 0.1
        t, _, _, _ = open_with(weak_real, weak_mirror, cfg=cfg)            # lean_num = 0.10 >= 0.10
        self.assertEqual(t.position.side, "LONG")

    def test_an_unanswered_question_enters_nothing_and_is_counted(self):
        class Flaky(Script):
            def ask(self, key, t_ms, step, question, state_text, single=False):
                if step == "mirror":
                    raise qt.DecisionError("nada")
                return super().ask(key, t_ms, step, question, state_text, single)
        warm, nxt = warm_bars()
        t = trader(Flaky(lean_script(UP, DOWN)), warm, cfg=CFG31, threshold=0.15)
        events = t.feed(walk(1, 8, start=nxt, price=float(warm[-1]["close"]), sigma=0.0001)[0])
        self.assertIsNone(t.position)
        self.assertEqual(decisions(events)[0]["override"], "espejo_sin_respuesta")
        self.assertIsNone(decisions(events)[0]["lean_num"])

    def test_v3_still_decides_by_the_chosen_option_with_the_threshold_and_the_mirror(self):
        t, events, script, _ = open_with(UP, DOWN, cfg=CFG3)
        self.assertEqual(t.position.side, "LONG")
        d = decisions(events)[0]
        self.assertIsNone(d["lean_num"])
        self.assertEqual((d["model_action"], d["mirror_action"], d["threshold"]), ("LARGO", "CORTO", 0.5))   # v3 keeps its own threshold
        self.assertAlmostEqual(t.position.entry_p, 0.6)                      # v3: entry_p = p(chosen)
        t, events, _, _ = open_with({"LARGO": 0.45, "CORTO": 0.05, "ESPERAR": 0.5}, DOWN, cfg=CFG3)
        self.assertIsNone(t.position)                                        # v3: ESPERAR is the chosen option


class FixedPlanTests(unittest.TestCase):
    def test_the_position_closes_by_itself_at_4h_and_qwen_was_asked_every_15_min_before(self):
        t, _, script, bucket = open_with(UP, DOWN)
        self.assertEqual(t.position.max_hold_ms, 240 * MIN)
        self.assertIsNotNone(t.position.stop_px)
        events = feed_all(t, flat_bars(bucket, t.c[-1], 48))
        trade = trades(events)
        self.assertEqual(len(trade), 1)
        self.assertEqual((trade[0]["closed_by"], trade[0]["hold_min"]), ("tiempo", 240))
        self.assertEqual([e["guardrail"] for e in events if e["type"] == "guardrail"], ["tiempo"])
        self.assertIsNone(t.position)
        self.assertEqual(t.cooldown_until, trade[0]["exit_ms"] + 15 * MIN)
        position_asks = [d for d in decisions(events) if d["kind"] == "position"]
        self.assertEqual(len(position_asks), 15)                              # every 15 min until the close
        self.assertTrue(all(d["action"] == "MANTENER" for d in position_asks))
        self.assertLess(trade[0]["net_bp"], 0)                                # costs of both legs were charged

    def test_the_stop_is_clamped_between_half_a_percent_and_three_percent(self):
        t, _, _, _ = open_with(UP, DOWN)
        self.assertEqual(t._stop_pct(sigma5=1e-9), 0.005)                    # very low sigma: floor
        self.assertEqual(t._stop_pct(sigma5=1.0), 0.03)                      # very high sigma: cap
        self.assertTrue(0.005 < t._stop_pct(sigma5=0.0005) < 0.03)           # in between: 1 sigma daily, unclamped

    def test_the_stop_closes_on_the_candle_that_touches_it_not_only_on_a_wake(self):
        t, _, _, bucket = open_with(UP, DOWN)
        stop_pct = t.position.stop_pct
        self.assertTrue(0.005 <= stop_pct <= 0.03)
        self.assertAlmostEqual(t.position.stop_px, t.position.entry_ref * (1 - stop_pct))
        stop = t.position.stop_px
        calm = flat_bars(bucket, t.c[-1], 1)                                  # +5 min: no wake, no stop
        events = feed_all(t, calm)
        self.assertEqual(events, [])
        crash = {"bucket_start": bucket + BAR, "open": repr(stop * 1.002), "high": repr(stop * 1.002), "low": repr(stop * 0.99),
                 "close": repr(stop * 0.995), "volume_btc": "30"}
        events = t.feed(crash)                                                # +10 min: not a 15 min boundary either
        trade = trades(events)
        self.assertEqual([x["closed_by"] for x in trade], ["stop"])
        self.assertEqual(events[0]["guardrail"], "stop")
        self.assertLessEqual(trade[0]["exit_px"], stop)                       # never better than the stop level
        self.assertLess(trade[0]["net_bp"], -stop_pct * 1e4 * 0.9)
        self.assertEqual(trade[0]["hold_min"], 10)
        self.assertIsNone(t.position)

    def test_a_short_has_its_stop_above_and_closes_by_time_too(self):
        t, _, _, bucket = open_with(DOWN, UP)
        self.assertEqual(t.position.side, "SHORT")
        self.assertGreater(t.position.stop_px, t.position.entry_ref)
        events = feed_all(t, flat_bars(bucket, t.c[-1], 48))
        self.assertEqual([x["closed_by"] for x in trades(events)], ["tiempo"])

    def test_qwen_can_close_before_the_plan(self):
        t, _, script, bucket = open_with(UP, DOWN, position="CERRAR")
        events = feed_all(t, flat_bars(bucket, t.c[-1], 3))                   # the 15 min wake
        trade = trades(events)
        self.assertEqual([(x["closed_by"], x["hold_min"]) for x in trade], [("qwen", 15)])
        self.assertFalse([e for e in events if e["type"] == "guardrail"])
        self.assertEqual([s for _, s, _, _ in script.asked][-2:], ["action", "reason"])
        self.assertIsNone(t.position)

    def test_the_state_tells_the_truth_about_the_plan(self):
        warm, nxt = warm_bars()
        t = trader(Script(lean_script(UP, UP)), warm, cfg=CFG31, threshold=0.15)
        t_ms = nxt + BAR
        t.feed(walk(1, 8, start=nxt, price=float(warm[-1]["close"]), sigma=0.0001)[0])
        flat, mirror = t.state_text(t_ms, ["hora_cerrada"]), t.state_text(t_ms, ["hora_cerrada"], mirror=True)
        rules = next(x for x in flat.split("\n") if x.startswith("Reglas fijas"))
        self.assertRegex(rules, r"La posicion se cierra sola a las 4 h o si el precio va [\d,]+ % en contra \(stop\); podes cerrarla antes\.")
        self.assertNotIn("No hay stop", flat)
        self.assertIn(rules, mirror)                                          # the rules do not depend on the signs
        shown = float(re.search(r"va ([\d,]+) % en contra", rules).group(1).replace(",", "."))
        self.assertAlmostEqual(shown, t._stop_pct() * 100, places=2)
        self.assertTrue(flat.endswith("Posicion: ninguna."))
        # with a position: time left to the automatic close and the distance to the stop
        t3, _, _, bucket = open_with(UP, DOWN)
        feed_all(t3, flat_bars(bucket, t3.c[-1], 2))
        text = t3.state_text(bucket + 2 * BAR, ["cada_15_min"])
        self.assertIn("Cierre automatico en 3 h 50 min si no la cerras antes.", text)
        self.assertRegex(text, r"El stop esta a [\d,]+ % del precio actual\.")
        self.assertIn("Resultado si cerras ahora, ya con todos los costos:", text)
        for banned in ("stop automatico", "cierre obligatorio", "No hay stop", "deberias", "conviene"):
            self.assertNotIn(banned, text)
        # v3 keeps its sentence
        t_v3 = trader(Script(lean_script(UP, UP)), warm_bars()[0], cfg=CFG3)
        self.assertIn("No hay stop ni limite de tiempo", t_v3.state_text(t_ms, ["hora_cerrada"]))


# --------------------------------------------------------------------------- practice, base and report


def lean_policy(prompt, letters):
    """Fake model that reads the sign of the 1 h return: LARGO-heavy when it is up, CORTO-heavy when down. The mirror turns the
    sign over, so the lean that comes from the numbers is about 0.4 on every flat wake."""
    options = dict(re.findall(r"^([A-Z])\) (\w+)", prompt, re.M))
    names = list(options.values())
    state = prompt.split("STATE:")[1]
    if "LARGO" in names:
        up = float(re.search(r"Retornos: 1h ([+-]?[\d,]+) %", state).group(1).replace(",", ".")) >= 0
        weights = {"LARGO": 0.6 if up else 0.2, "CORTO": 0.2 if up else 0.6, "ESPERAR": 0.2}
    elif "MANTENER" in names:
        close = int(re.search(r"abierta hace (\d+)", state).group(1)) >= 2 and "Resultado si cerras ahora, ya con todos los costos: -" in state
        weights = {"MANTENER": 0.2 if close else 0.9, "CERRAR": 0.8 if close else 0.1}
    else:
        weights = {name: 1.0 / len(names) for name in names}
    return [{"token": letter, "logprob": math.log(weights[options[letter]])} for letter in letters]


def small_cfg31():
    cfg = copy.deepcopy(CFG31)
    cfg["practice"].update(block_days=1, time_bins=3, target_blocks=4, **{"from": START_DAY})
    return cfg


def rows(db, sql):
    con = sqlite3.connect(db)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


class PracticeV31Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "practice-v3.1.sqlite")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_practice(self, cfg=None):
        clock = [0.0]
        provider = ClockedProvider(clock, entries=lean_policy)
        result = qt.run_practice(MemHistory(), self.db, provider, cfg or small_cfg31(), HOLDOUT, max_minutes=500, blocks=4,
                                 clock=lambda: clock[0], log=lambda *a: None)
        return result, provider

    def test_a_full_run_stores_the_lean_three_orders_and_trades_that_follow_the_plan(self):
        result, provider = self.run_practice()
        self.assertEqual((result["stop_reason"], result["blocks_done"]), ("done", 4))
        flat = rows(self.db, "SELECT block_id, trade_no, action, lean, lean_m, lean_num, habit, threshold, model_action "
                             "FROM decisions WHERE kind='flat'")
        self.assertTrue(flat)
        self.assertTrue(all(r[5] is not None for r in flat))
        for _, _, action, lean, lean_m, lean_num, habit, threshold, _ in flat:
            self.assertAlmostEqual(lean_num, (lean - lean_m) / 2)
            self.assertAlmostEqual(habit, (lean + lean_m) / 2)
            self.assertEqual(threshold, 0.15)
            self.assertEqual(action, "LARGO" if lean_num >= 0.15 else "CORTO" if lean_num <= -0.15 else "ESPERAR")
        entries = [r for r in flat if r[2] in ("LARGO", "CORTO")]
        self.assertTrue(entries)
        for block_id, trade_no, action, _, _, lean_num, _, _, _ in entries:
            side, entry_p = rows(self.db, "SELECT side, entry_p FROM trades WHERE block_id='{}' AND trade_no={}".format(
                block_id, trade_no))[0]
            self.assertEqual(side, "LONG" if action == "LARGO" else "SHORT")
            self.assertAlmostEqual(entry_p, abs(lean_num))
        # three option orders for the flat question and for the mirror, two for the position question
        self.assertEqual({r[0] for r in rows(self.db, "SELECT DISTINCT variant FROM calls WHERE step='mirror'")}, {0, 1, 2})
        mirrors = rows(self.db, "SELECT COUNT(*) FROM calls WHERE step='mirror'")[0][0]
        self.assertEqual(mirrors, 3 * len(flat))
        for block_id, t_ms in rows(self.db, "SELECT block_id, t_ms FROM decisions WHERE kind='position' LIMIT 5"):
            variants = rows(self.db, "SELECT variant FROM calls WHERE block_id='{}' AND t_ms={} AND step='action'".format(
                block_id, t_ms))
            self.assertEqual(sorted(v[0] for v in variants), [0, 1])
        orders = rows(self.db, "SELECT order_json FROM calls WHERE step='action' AND order_json LIKE '%LARGO%'")
        self.assertEqual({o[0] for o in orders}, {'["LARGO", "CORTO", "ESPERAR"]', '["CORTO", "ESPERAR", "LARGO"]',
                                                  '["ESPERAR", "LARGO", "CORTO"]'})
        # the exits follow the plan
        all_trades = rows(self.db, "SELECT closed_by, hold_min, net_bp FROM trades")
        self.assertTrue(all_trades)
        self.assertTrue(all(c in qt.CLOSED_BY for c, _, _ in all_trades))
        self.assertTrue(all(h <= 240 for _, h, _ in all_trades))
        self.assertTrue(all(c == "tiempo" for c, h, _ in all_trades if h == 240))
        self.assertTrue(all(h < 240 for c, h, _ in all_trades if c in ("qwen", "stop")))
        self.assertEqual(provider.calls, rows(self.db, "SELECT COUNT(*) FROM calls")[0][0])

    def test_the_report_has_the_lean_section_in_spanish(self):
        self.run_practice()
        text = rep.build_report(self.db, small_cfg31(), history=MemHistory())
        for needle in ("## Entrada por inclinación", "Distribución de la inclinación que viene de los números", "largas y",
                       "cortas", "Cierres por motivo", "Quién cerró", "Límite de tiempo", "Stop (precio en contra)",
                       "Cerró el límite de 4 h", "## Umbral de inclinación", "En pocas palabras", "Qué revisamos",
                       "## Glosario", "## Detalles técnicos", "entre 0,5 % y 3,0 %"):
            self.assertIn(needle, text)
        self.assertNotIn("Cerró el límite de 24 h", text)
        self.assertNotIn("1,5 veces la volatilidad diaria", text)
        self.assertLess(text.index("En pocas palabras"), text.index("Qué revisamos"))
        self.assertLess(text.index("## Glosario"), text.index("## Detalles técnicos"))
        summary = rep.lean_summary(rep.load(self.db)["decisions"], rep.load(self.db)["trades"], small_cfg31())
        self.assertEqual(sum(b["n"] for b in summary["bands"]), summary["n"])
        self.assertEqual(summary["sides"]["LONG"] + summary["sides"]["SHORT"], sum(c["n"] for c in summary["closes"]))

    def test_the_lean_section_is_absent_from_a_choice_report_and_its_header_keeps_24h(self):
        cfg3 = copy.deepcopy(CFG3)
        cfg3["practice"].update(block_days=1, time_bins=3, target_blocks=4, **{"from": START_DAY})
        self.assertEqual(rep.lean_lines([], [], cfg3), [])
        self.assertIn("Cerró el límite de 24 h", rep.main_header(cfg3))
        self.assertIn("Cerró el límite de 4 h", rep.main_header(CFG31))

    def test_an_older_decisions_table_gets_the_lean_columns_only_when_opened_for_v31(self):
        old = os.path.join(self.tmp, "old.sqlite")
        con = sqlite3.connect(old)
        with con:
            con.execute("CREATE TABLE decisions(block_id TEXT NOT NULL, seq INTEGER NOT NULL, t_ms INTEGER, kind TEXT, "
                        "PRIMARY KEY(block_id, seq))")
            con.execute("INSERT INTO decisions VALUES('b', 1, 0, 'flat')")
        con.close()
        qt.PracticeDB(old, readonly=True).close()                             # a reader never alters anything
        self.assertFalse({"lean_num"} & {r[1] for r in rows(old, "PRAGMA table_info(decisions)")})
        qt.PracticeDB(old).close()                                            # another version: not touched
        self.assertFalse({"lean_num"} & {r[1] for r in rows(old, "PRAGMA table_info(decisions)")})
        qt.PracticeDB(old, lean=True).close()
        columns = {r[1] for r in rows(old, "PRAGMA table_info(decisions)")}
        self.assertTrue(set(qt.LEAN_COLUMNS) <= columns)
        self.assertEqual(rows(old, "SELECT lean_num FROM decisions"), [(None,)])

    def test_bases_of_other_versions_keep_27_columns_and_the_positional_insert(self):
        block = {"block_id": "BTC:x", "product": "BTC", "start_ms": 0, "end_ms": 1, "bin": 0, "fold": "calibration"}
        stats = {"bars": 0, "wakes": 0, "seconds": 0.0}
        event = {"type": "decision", "t_ms": 5, "kind": "flat", "action": "ESPERAR"}
        for name, cfg in (("v3", CFG3), ("v2.1", CFG21)):
            path = os.path.join(self.tmp, "practice-{}.sqlite".format(name))
            con = sqlite3.connect(path)                                        # a base made by the code without lean
            with con:
                con.executescript(qt._SCHEMA_SQL)
            con.close()
            self.assertEqual(len(rows(path, "PRAGMA table_info(decisions)")), 27)
            pdb = qt.PracticeDB(path, lean=qt.entry_mode_of(cfg) == "lean")
            pdb.commit_block(block, [event], {"prompt_version": 1, "model": "m"}, stats, [])
            pdb.close()
            info = rows(path, "PRAGMA table_info(decisions)")
            self.assertEqual(len(info), 27)
            self.assertFalse({"lean", "lean_m", "lean_num", "habit"} & {r[1] for r in info})
            self.assertEqual(rows(path, "SELECT kind, action FROM decisions"), [("flat", "ESPERAR")])
            con = sqlite3.connect(path)                                        # the 27-value positional INSERT still works
            with con:
                con.execute("INSERT INTO decisions VALUES(" + ",".join("?" * 27) + ")",
                            ("BTC:y", 1, 0, "flat", "BTC", "calibration") + (None,) * 21)
            con.close()
            self.assertEqual(rows(path, "SELECT count(*) FROM decisions"), [(2,)])

    def test_a_new_v31_base_has_the_lean_columns(self):
        path = os.path.join(self.tmp, "new31.sqlite")
        qt.PracticeDB(path, lean=True).close()
        self.assertEqual(len(rows(path, "PRAGMA table_info(decisions)")), 31)

    def test_run_practice_with_a_non_lean_config_opens_the_base_without_the_lean_columns(self):
        cfg = copy.deepcopy(CFG3)
        cfg["practice"].update(block_days=1, time_bins=3, target_blocks=4, **{"from": START_DAY})
        self.assertNotEqual(qt.entry_mode_of(cfg), "lean")
        self.run_practice(cfg)
        info = rows(self.db, "PRAGMA table_info(decisions)")
        self.assertEqual(len(info), 27)
        self.assertFalse(set(qt.LEAN_COLUMNS) & {r[1] for r in info})

    def test_reopening_a_created_v31_base_with_lean_does_not_fail_and_keeps_31_columns(self):
        path = os.path.join(self.tmp, "again31.sqlite")
        qt.PracticeDB(path, lean=True).close()
        qt.PracticeDB(path, lean=True).close()
        self.assertEqual(len(rows(path, "PRAGMA table_info(decisions)")), 31)
        self.run_practice()                                                    # and a full run reopens it the same way
        self.run_practice()
        self.assertEqual(len(rows(self.db, "PRAGMA table_info(decisions)")), 31)

    def test_export_carries_the_lean(self):
        self.run_practice()
        out = os.path.join(self.tmp, "dataset.jsonl")
        n = qt.export_dataset(self.db, out, small_cfg31())
        self.assertGreater(n, 0)
        import json
        with open(out, encoding="utf-8") as handle:
            lines = [json.loads(line) for line in handle]
        flat = [x for x in lines if x["kind"] == "flat"]
        self.assertTrue(all(set(x["lean"]) == set(qt.LEAN_COLUMNS) for x in flat if x["lean"] is not None))
        self.assertTrue(any(x["lean"] is not None for x in flat))
        self.assertTrue(all(x["lean"] is None for x in lines if x["kind"] == "position"))

    def test_cli_knows_version_31_and_its_files(self):
        out = io.StringIO()
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(out):
            code = qt.main(["practice", "--version", "3.1", "--offline", "--cache-dir", self.tmp, "--db",
                            os.path.join(self.tmp, "x.sqlite"), "--llama-url", "http://example.com:8088"])
        self.assertEqual(code, 2)
        self.assertIn("versión 3.1", out.getvalue())
        self.assertIn("qwen-trader-v3.1.json", out.getvalue())
        self.assertTrue(qt.DEFAULT_DB_V31.endswith("practice-v3.1.sqlite"))
        parser_out = io.StringIO()
        with contextlib.redirect_stdout(parser_out), self.assertRaises(SystemExit):
            qt.main(["report", "--help"])
        self.assertIn("--out-v31", parser_out.getvalue())


if __name__ == "__main__":
    unittest.main()
