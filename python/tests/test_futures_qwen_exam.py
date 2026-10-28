import copy
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_llm_decisions as llm
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as ex
from test_futures_qwen_trader import (HOLDOUT, START_DAY, ClockedProvider, MemHistory, Script, always, feed_all, trader,
                                            walk, warm_bars)

# the attempts log of the tests lives in a temporary file, never in the machine's own
os.environ["BALANCITA_WF_INTENTOS"] = os.path.join(tempfile.mkdtemp(), "intentos.jsonl")

CFG3 = qt.load_config(qt.CONFIG_PATH_V3)


def cfg3_from(base, **exam):
    cfg = copy.deepcopy(base)
    cfg["practice"]["from"] = START_DAY
    cfg["exam"].update(snapshots=30, time_bins=3, **exam)
    return cfg


def cfg3(**exam):
    cfg = copy.deepcopy(CFG3)
    cfg["practice"]["from"] = START_DAY
    cfg["exam"].update(snapshots=30, time_bins=3, **exam)
    return cfg


def mirror_script(real, mirror):
    def fn(t_ms, step, question):
        if question["id"] != "trader_flat":
            return {"MANTENER": 1.0}
        return {(mirror if step == "mirror" else real): 1.0}
    return fn


def state_policy(prompt, letters):
    """Picks by the STATE line, so the real and the mirrored state of a photo get different, repeatable answers."""
    options = dict(re.findall(r"^([A-Z])\) (\w+)", prompt, re.M))
    h = int(hashlib.sha1(prompt.split("STATE:")[1].encode()).hexdigest(), 16)
    pick = ("LARGO", "CORTO", "ESPERAR", "LARGO", "CORTO")[h % 5]
    return [{"token": letter, "logprob": -0.05 if options[letter] == pick else -5.0} for letter in letters]


class V3ConfigTests(unittest.TestCase):
    def test_v3_has_its_own_files_and_starts_from_v21(self):
        self.assertNotIn(qt.version_paths("3")[1], (qt.version_paths("2.1")[1], qt.version_paths("2")[1]))
        v21 = qt.load_config(qt.CONFIG_PATH_V21)
        for key in ("prompt", "wake", "guardrails", "runtime", "state_variant", "practice"):
            self.assertEqual(CFG3[key].get("questions"), v21[key].get("questions")) if key == "prompt" else \
                self.assertEqual(CFG3[key], v21[key])
        self.assertNotEqual(qt.config_hash(CFG3), qt.config_hash(v21))
        self.assertTrue(CFG3["mirror"])

    def test_exam_settings_are_not_part_of_the_practice_identity(self):
        other = copy.deepcopy(CFG3)
        other["exam"]["snapshots"] = 7
        self.assertEqual(qt.config_hash(other), qt.config_hash(CFG3))

    def test_the_exam_rules_of_the_lean_do_not_change_the_identity_of_an_existing_exam_base(self):
        self.assertTrue(qt.config_hash(CFG3).startswith("c342bf2ce551"))          # the hash of the first exam base
        old = copy.deepcopy(CFG3)
        del old["exam_lean"]
        self.assertEqual(qt.config_hash(old), qt.config_hash(CFG3))
        with tempfile.TemporaryDirectory() as folder:
            db = os.path.join(folder, "exam.sqlite")
            for cfg in (cfg3_from(old), cfg3_from(CFG3)):
                ex.run_exam(MemHistory(), db, ClockedProvider([0.0], entries=state_policy), cfg, HOLDOUT, max_minutes=500,
                            clock=lambda: 0.0, log=lambda *a: None)


class MirrorStateTests(unittest.TestCase):
    def test_signs_are_turned_over_and_the_rest_is_kept(self):
        bars, _ = warm_bars()
        t = trader(Script(always()), bars, cfg=CFG3, funding=[(bars[-1]["bucket_start"] - 3 * qt.HOUR_MS * k, 3e-5)
                                                              for k in range(1, 5)])
        t_ms = t.t[-1] + qt.BAR_MS
        real, mirror = t.state_text(t_ms, ["x"]), t.state_text(t_ms, ["x"], mirror=True)
        self.assertNotEqual(real, mirror)
        ret = lambda text: re.findall(r"(\d+h|7d) ([+-][\d,]+) %", text.split("\n")[1])
        for (n1, v1), (n2, v2) in zip(ret(real), ret(mirror)):
            self.assertEqual(n1, n2)
            self.assertEqual(float(v1.replace(",", ".")), -float(v2.replace(",", ".")))
        line = lambda text, start: next(x for x in text.split("\n") if x.startswith(start))
        self.assertEqual(line(real, "Volatilidad").split("Movimiento")[0], line(mirror, "Volatilidad").split("Movimiento")[0])
        self.assertEqual(line(real, "Volumen"), line(mirror, "Volumen"))
        hi, lo, hi7, lo7 = [float(x.replace(",", ".")) for x in re.findall(r"([+-]?[\d,]+) %", line(real, "Distancia"))]
        mhi, mlo, mhi7, mlo7 = [float(x.replace(",", ".")) for x in re.findall(r"([+-]?[\d,]+) %", line(mirror, "Distancia"))]
        self.assertEqual((mhi, mlo, mhi7, mlo7), (-lo, -hi, -lo7, -hi7))
        self.assertIn("los largos pagan", line(real, "Funding"))
        self.assertIn("los cortos pagan", line(mirror, "Funding"))

    def test_no_mirror_with_an_open_position(self):
        cfg = copy.deepcopy(CFG3)
        cfg["mirror"] = False
        bars, nxt = warm_bars()
        t = trader(Script(always(flat="LARGO")), bars, cfg=cfg)
        feed_all(t, walk(1, 5, start=nxt))
        self.assertIsNotNone(t.position)
        with self.assertRaises(ValueError):
            t.state_text(t.t[-1] + qt.BAR_MS, ["x"], mirror=True)


class MirrorEntryTests(unittest.TestCase):
    def run_flat(self, real, mirror, cfg=CFG3):
        bars, nxt = warm_bars()
        decider = Script(mirror_script(real, mirror))
        t = trader(decider, bars, cfg=cfg)
        events = feed_all(t, walk(1, 9, start=nxt))
        return t, events, decider

    def test_enters_only_when_the_mirror_says_the_opposite(self):
        for real, mirror, side in (("LARGO", "CORTO", "LONG"), ("CORTO", "LARGO", "SHORT")):
            t, events, _ = self.run_flat(real, mirror)
            self.assertEqual(t.position.side, side)
            decision = [e for e in events if e["type"] == "decision"][0]
            self.assertEqual(decision["mirror_action"], mirror)
            self.assertIsNone(decision["override"])

    def test_same_side_or_waiting_on_the_mirror_blocks_the_entry_and_is_counted(self):
        for real, mirror in (("LARGO", "LARGO"), ("CORTO", "CORTO"), ("LARGO", "ESPERAR")):
            t, events, _ = self.run_flat(real, mirror)
            self.assertIsNone(t.position)
            decision = [e for e in events if e["type"] == "decision"][0]
            self.assertEqual(decision["override"], "espejo")
            self.assertEqual(decision["action"], "ESPERAR")

    def test_the_mirror_is_not_asked_when_nothing_would_be_entered(self):
        _, _, decider = self.run_flat("ESPERAR", "CORTO")
        self.assertEqual([s for _, s, _, _ in decider.asked], ["action"])

    def test_the_mirror_state_is_what_is_asked(self):
        _, _, decider = self.run_flat("LARGO", "CORTO")
        texts = {s: x for _, s, _, x in decider.asked}
        self.assertNotEqual(texts["action"], texts["mirror"])

    def test_without_the_mirror_option_nothing_changes(self):
        cfg = copy.deepcopy(CFG3)
        cfg["mirror"] = False
        t, _, decider = self.run_flat("LARGO", "LARGO", cfg)
        self.assertEqual(t.position.side, "LONG")
        self.assertEqual([s for _, s, _, _ in decider.asked], ["action"])


class ExamTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.dir.name, "exam.sqlite")

    def tearDown(self):
        self.dir.cleanup()

    def go(self, minutes=500, cfg=None, clock=None, history=None):
        clock = clock or [0.0]
        provider = ClockedProvider(clock, entries=state_policy)
        history = history or MemHistory()
        result = ex.run_exam(history, self.db, provider, cfg or cfg3(), HOLDOUT, max_minutes=minutes,
                             clock=lambda: clock[0], log=lambda *a: None)
        return result, provider, history

    def test_photos_are_flat_wake_moments_before_the_holdout_with_their_outcome(self):
        history = MemHistory()
        photos = ex.make_photos(history, cfg3(), "PF_XBTUSD", HOLDOUT)
        self.assertGreater(len(photos), 100)
        self.assertTrue(all(p["t_ms"] + 1440 * 60_000 <= HOLDOUT for p in photos))
        self.assertTrue(all(p["t_ms"] % qt.HOUR_MS == 0 or p["wake"] != ["hora_cerrada"] for p in photos))
        self.assertTrue(all(set(p["moves"]) == {"240", "1440"} for p in photos))
        chosen = ex.choose_photos(photos, cfg3(), HOLDOUT)
        self.assertEqual(len(chosen), 30)
        self.assertEqual([p["t_ms"] for p in chosen], [p["t_ms"] for p in ex.choose_photos(photos, cfg3(), HOLDOUT)])

    def test_full_run_answers_every_photo_and_the_holdout_is_never_requested(self):
        result, _, history = self.go()
        self.assertEqual((result["stop_reason"], result["answered"], result["total"]), ("done", 30, 30))
        self.assertTrue(all(to <= HOLDOUT for _, _, to in history.requests))
        rows = [r[1:] for r in self.answers(self.db)]
        self.assertTrue(all(a is not None and m is not None for a, m in rows))       # the mirror is asked for every photo
        self.assertGreater(len({a for a, _ in rows}), 1)

    def answers(self, path):
        con = sqlite3.connect(path)
        try:
            return con.execute("SELECT snap_id, real_action, mirror_action FROM exam_answers ORDER BY snap_id").fetchall()
        finally:
            con.close()

    def test_resume_after_the_budget_repeats_no_call_and_gives_the_same_answers(self):
        clock = [0.0]
        first, _, _ = self.go(minutes=1.0, clock=clock)
        self.assertEqual(first["stop_reason"], "budget")
        self.assertLess(first["answered"], 30)
        self.assertEqual(self.go(clock=clock)[0]["answered"], 30)
        resumed = self.answers(self.db)
        self.db = os.path.join(self.dir.name, "full.sqlite")
        self.go()
        self.assertEqual(resumed, self.answers(self.db))
        again, provider, _ = self.go()
        self.assertEqual((again["calls"], provider.calls), (0, 0))

    def test_a_database_from_the_first_exam_only_gets_the_missing_mirrors(self):
        self.go()
        full = self.answers(self.db)
        con = sqlite3.connect(self.db)
        with con:
            con.execute("UPDATE exam_answers SET mirror_action=NULL, mirror_p=NULL")
            con.execute("DELETE FROM calls WHERE step='mirror'")
        real_before = con.execute("SELECT COUNT(*) FROM calls WHERE step='action'").fetchone()[0]
        con.close()
        result, provider, _ = self.go()
        self.assertEqual(result["stop_reason"], "done")
        self.assertEqual(self.answers(self.db), full)
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM calls WHERE step='action'").fetchone()[0], real_before)
        con.close()
        self.assertEqual(provider.calls, 60)                       # 30 photos x 2 option orders, the mirror only

    def test_a_mirror_cut_after_one_order_does_not_count_as_a_mirrored_photo(self):
        self.go()
        con = sqlite3.connect(self.db)
        with con:
            snap = con.execute("SELECT snap_id FROM exam_answers LIMIT 1").fetchone()[0]
            con.execute("DELETE FROM calls WHERE block_id=? AND step='mirror' AND variant=1", (snap,))
        con.close()
        rows, _ = ex.load_answers(self.db)
        cut = next(r for r in rows if r["snap_id"] == snap)
        self.assertIsNone(cut["lean_num"])
        self.assertEqual(sum(1 for r in rows if r["lean_num"] is not None), 29)

    def test_lean_is_split_into_numbers_and_habit(self):
        r = {"p_largo": 0.6, "p_corto": 0.2, "p_largo_m": 0.5, "p_corto_m": 0.3}
        got = ex.split_lean(r)
        self.assertAlmostEqual(got["lean"], 0.4)
        self.assertAlmostEqual(got["lean_m"], 0.2)
        self.assertAlmostEqual(got["lean_num"], 0.1)
        self.assertAlmostEqual(got["habit"], 0.3)
        self.assertIsNone(ex.split_lean(dict(r, p_largo_m=None))["lean_num"])

    def test_a_database_of_another_config_is_refused(self):
        self.go()
        with self.assertRaises(qt.TraderError):
            self.go(cfg=cfg3(seed=1))

    def test_report_is_spanish_markdown_with_a_verdict(self):
        self.go()
        text = ex.build_exam_report(self.db, cfg3())
        for part in ("## ❌ NO PASA", "## En pocas palabras", "## Qué revisamos", "## Glosario", "## Detalle técnico"):
            if part == "## ❌ NO PASA":
                self.assertTrue(any(v in text for v in ("## ❌ NO PASA", "## ✅ PASA", "## ⚠️ INCONCLUSO")))
            else:
                self.assertIn(part, text)
        self.assertLess(text.index("## Glosario"), text.index("## Detalle técnico"))

    def test_an_exam_where_qwen_never_enters_is_inconclusive_and_shows_how_close_it_got(self):
        def wait(prompt, letters):
            options = dict(re.findall(r"^([A-Z])\) (\w+)", prompt, re.M))
            return [{"token": l, "logprob": -0.1 if options[l] == "ESPERAR" else -2.0 - (options[l] == "CORTO")} for l in letters]
        ex.run_exam(MemHistory(), self.db, ClockedProvider([0.0], entries=wait), cfg3(), HOLDOUT, max_minutes=500,
                    clock=lambda: 0.0, log=lambda *a: None)
        text = ex.build_exam_report(self.db, cfg3())
        self.assertIn("## ⚠️ INCONCLUSO", text)
        self.assertIn("### Qué tan cerca estuvo de entrar", text)
        rows, _ = ex.load_answers(self.db)
        counts, top, known = ex.lean_bands(rows, "p_largo")
        self.assertEqual((sum(counts), known), (30, 30))
        self.assertLess(top, 0.5)

    def test_empty_exam_does_not_crash(self):
        pdb = qt.PracticeDB(self.db)
        pdb.db.executescript(ex._EXAM_SQL)
        pdb.close()
        self.assertIn("Todavía no hay fotos", ex.build_exam_report(self.db, cfg3()))


def row(side_action, mirror, move, p=0.9, t=0):
    return {"real_action": side_action, "real_p": p, "mirror_action": mirror, "mirror_p": 0.9, "t_ms": t * ex.DAY_MS,
            "moves": {"240": move, "1440": move}, "cost_bp": 10.0}


class VerdictTests(unittest.TestCase):
    cfg = copy.deepcopy(CFG3)

    def judge(self, rows):
        return ex.analyse(rows, {}, self.cfg)

    def test_good_entries_that_beat_always_long_pass(self):
        rows = [row("CORTO", "LARGO", -60 - i % 7, t=i) for i in range(150)] + [row("LARGO", "CORTO", 55 + i % 5, t=i) for i in range(150)]
        self.assertEqual(self.judge(rows)["verdict"], ex.PASS)

    def test_entries_that_lose_after_costs_fail(self):
        rows = [row("LARGO", "CORTO", -3 - i % 4, t=i) for i in range(150)] + [row("CORTO", "LARGO", 4 + i % 3, t=i) for i in range(150)]
        self.assertEqual(self.judge(rows)["verdict"], ex.FAIL)

    def test_no_entry_at_all_is_inconclusive_not_a_failure(self):
        self.assertEqual(self.judge([row("ESPERAR", None, 50, t=i) for i in range(50)])["verdict"], ex.INCONCLUSIVE)

    def test_few_good_entries_are_inconclusive(self):
        rows = [row("CORTO", "LARGO", -60 - i % 7, t=i) for i in range(20)] + [row("LARGO", "CORTO", 55 + i % 5, t=i) for i in range(20)]
        self.assertEqual(self.judge(rows)["verdict"], ex.INCONCLUSIVE)

    def test_the_mirror_decides_what_counts_and_the_threshold_blocks_first(self):
        t = self.cfg["practice_entry_threshold"]
        self.assertEqual(ex.classify(row("LARGO", "CORTO", 0), t), "pasa")
        self.assertEqual(ex.classify(row("LARGO", "LARGO", 0), t), "espejo")
        self.assertEqual(ex.classify(row("LARGO", "CORTO", 0, p=0.3), t), "umbral")
        self.assertEqual(ex.classify(row("ESPERAR", None, 0), t), "espera")
        self.assertEqual(ex.classify(row(None, None, 0), t), "sin_respuesta")


def lean_row(i, x, move):
    probs = {"p_largo": 0.5 + x / 2, "p_corto": 0.5 - x / 2, "p_largo_m": 0.5 - x / 2, "p_corto_m": 0.5 + x / 2}
    r = dict(snap_id="s{}".format(i), t_ms=(i % 60) * ex.DAY_MS + i, moves={"240": move, "1440": move}, cost_bp=10.0,
             real_action="ESPERAR", real_p=0.9, mirror_action="ESPERAR", mirror_p=0.9, **probs)
    r.update(ex.split_lean(r))
    return r


class LeanVerdictTests(unittest.TestCase):
    def cfg(self):
        cfg = copy.deepcopy(CFG3)
        cfg["exam_rules"]["random_draws"] = 200
        return cfg

    def photos(self, n, informative):
        rows = []
        for i in range(n):
            x = ((i * 37) % 201 - 100) / 100.0                  # spread over -1..1
            noise = ((i * 7919) % 41 - 20)
            rows.append(lean_row(i, x, x * 200 + noise if informative else ((i * 104729) % 401 - 200)))
        return rows

    def test_a_lean_that_anticipates_the_move_passes(self):
        a = ex.analyse_lean(self.photos(600, True), self.cfg())
        self.assertEqual(a["verdict"], ex.PASS)
        self.assertGreater(a["horizons"][240]["lean_num"]["spearman"], 0.9)

    def test_a_lean_unrelated_to_the_move_does_not_pass(self):
        self.assertEqual(ex.analyse_lean(self.photos(600, False), self.cfg())["verdict"], ex.FAIL)

    def test_few_mirrored_photos_are_inconclusive_and_a_pure_habit_has_no_numbers_lean(self):
        self.assertEqual(ex.analyse_lean(self.photos(100, True), self.cfg())["verdict"], ex.INCONCLUSIVE)
        habit = [lean_row(i, 0.0, 50) for i in range(10)]
        for r in habit:
            r.update(p_largo=0.8, p_corto=0.1, p_largo_m=0.8, p_corto_m=0.1)
            r.update(ex.split_lean(r))
        self.assertTrue(all(abs(r["lean_num"]) < 1e-12 and r["habit"] > 0.6 for r in habit))

    def test_the_random_baseline_flips_whole_days_not_single_photos(self):
        rows = [lean_row(i, 0.5, 100.0) for i in range(40)]
        for r in rows:
            r["t_ms"] = 7 * ex.DAY_MS + r["t_ms"] % 1000          # one single day
        observed = ex.mean([ex.net(r, 1, 240) for r in rows])
        pct = ex.random_percentile(rows, 240, 400, 1, observed, side=lambda r: 1)
        self.assertTrue(30 <= pct <= 70, pct)                       # a coin per photo would give ~100

    def test_photos_with_a_lean_of_exactly_zero_are_not_extremes(self):
        rows = [lean_row(i, 0.0, 50.0) for i in range(100)] + [lean_row(100 + i, 0.5, 80.0) for i in range(10)]
        block = ex.lean_block(rows, "lean_num", 240, self.cfg())
        self.assertAlmostEqual(block["top_move"], 80.0)
        self.assertAlmostEqual(block["bottom_move"], 80.0)           # only 10 non-zero photos: the bottom fifth is one of them

    def test_spearman_and_ties(self):
        self.assertAlmostEqual(ex.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0)
        self.assertAlmostEqual(ex.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1.0)
        self.assertIsNone(ex.spearman([1, 1, 1], [1, 2, 3]))


if __name__ == "__main__":
    unittest.main()
