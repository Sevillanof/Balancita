"""Qwen en vivo con la ficha de 8 factores (config versión 5): la ventana por factores, los datos que la ficha necesita en vivo
(otros activos y posicionamiento), el archivo de la base de otra configuración y el Examen de fotos de la config en vivo.
Todo con proveedor falso, velas inventadas y bases temporales."""
import contextlib
import copy
import io
import json
import os
import sqlite3
import tempfile
import unittest

from balancita_engine import futures_qwen_factors as fq
from balancita_engine import futures_qwen_live as live
from balancita_engine import futures_qwen_quick_api as quick_api
from balancita_engine import futures_qwen_quick_variants as qv
from balancita_engine import futures_qwen_trader as qt
from balancita_engine import futures_qwen_trader_exam as ex
from balancita_engine import positioning_data as pd
from balancita_engine import strategy_gate_models as models
from test_futures_qwen_factors import ChatProvider, completion, positioning_db, reading_script
from test_futures_qwen_live import BASE, BAR, DAY, LIVE_CFG, MIN, Policy, make, walk
from test_futures_qwen_trader import HOLDOUT, MemHistory, SERIES, START_DAY
from test_futures_qwen_trader import walk as walk_series

HOUR = qt.HOUR_MS
LONG_LINE = [2, 2, 2, 2, 2, 2, 2, 0]
SHORT_LINE = [-2, -2, -2, -2, -2, -2, -2, 0]
FLAT_LINE = [0] * 8


def lean_of(values):
    """The lean the window must read off a line written by the fake model (through the real reader)."""
    return fq.lean_of(fq.read_completion(completion(values))["grads"])


def window_cfg(products=("PF_XBTUSD",), min_looks=1, min_score=0.05, **live_over):
    cfg = live.apply_overrides(LIVE_CFG, {"QWEN_LIVE_PRODUCTS": ",".join(products)})
    cfg["live"].update(dict(dict(force_window_h=12, force_min_looks=min_looks, force_min_score=min_score,
                                 force_neutral_lean=0.05, force_record_tol=0.0), **live_over))
    return cfg


class PlanScript:
    """The fake llama-server for the window: each look is two requests, the real STATE and then the mirrored one."""

    def __init__(self, plan):
        self.plan, self.n = plan, 0

    def __call__(self, body):
        n, self.n = self.n, self.n + 1
        return completion(self.plan(n // 2, bool(n % 2)))


def factor_env(test, plan, *, cfg=None, sol=True, healthy=True, **kwargs):
    provider = ChatProvider(PlanScript(plan), entries=Policy(), **kwargs)
    provider.healthy = healthy
    env = make(test, cfg=cfg or window_cfg(), provider=provider)
    if sol:
        env.candles["PF_SOLUSD"] = walk(11 * 288, 31, BASE - 9 * DAY)
    return env


def decisions(env, where="1=1"):
    return env.rows("SELECT * FROM decisions WHERE {} ORDER BY t_ms".format(where))


def add_positioning(path, product, first_ms, hours, long_start=40.0):
    con = sqlite3.connect(path)
    with con:
        for k in range(hours):
            bucket = first_ms + k * HOUR
            con.execute("INSERT INTO positioning VALUES(?,?,?,?,?,?,?,?,?)",
                        (product, bucket, long_start + k * 0.5, 10, 10, 60.0 + k * 0.25, 1, 1, 5.0))
            con.execute("INSERT INTO premium VALUES(?,?,?,?,?,?)", (product, HOUR, bucket, 101.0, 100.0, 10.0 + k * 0.5))
    con.close()


# --------------------------------------------------------------------------- the config


class ConfigTests(unittest.TestCase):
    def test_version_6_has_the_sheet_the_context_and_the_question_of_the_ficha_variant(self):
        variant = qv.get_variant("ficha")
        self.assertEqual(LIVE_CFG["prompt"]["version"], 6)
        self.assertTrue(LIVE_CFG["state_ficha"])
        self.assertEqual(LIVE_CFG["factors"], variant["factors"])                       # without the reversion hint
        self.assertEqual(LIVE_CFG["prompt"]["system"], variant["prompt"]["system"])
        self.assertNotIn("reversión", LIVE_CFG["prompt"]["system"])
        self.assertEqual(LIVE_CFG["state_context"], ["PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"])
        self.assertIn("línea con el formato que se pide", LIVE_CFG["prompt"]["system"])

    def test_the_thresholds_of_the_window_are_the_ones_of_version_4_and_the_note_says_they_get_recalibrated(self):
        live_cfg = LIVE_CFG["live"]
        self.assertEqual((live_cfg["force_neutral_lean"], live_cfg["force_min_score"], live_cfg["force_record_tol"],
                          live_cfg["force_window_h"], live_cfg["force_min_looks"]), (0.05, 0.15, 0.03, 12, 6))
        self.assertIn("se recalibran con el primer día de datos", LIVE_CFG["note"])
        self.assertIn("force_question ya no se usa", LIVE_CFG["note"])

    def test_the_position_question_and_the_guardrails_do_not_change(self):
        self.assertEqual([o["id"] for o in LIVE_CFG["prompt"]["questions"]["position"]["options"]], ["MANTENER", "CERRAR"])
        self.assertEqual(LIVE_CFG["guardrails"], {"stop_sigma_24h": 1.5, "min_stop_pct": 0.005, "max_stop_pct": 0.03,
                                                 "max_hold_min": 240, "cooldown_min": 15})
        self.assertEqual(LIVE_CFG["state_variant"], 3)
        self.assertFalse(LIVE_CFG["wake"]["extra_wakes"])

    def test_the_old_configs_keep_their_identity(self):
        v3 = qt.load_config(qt.CONFIG_PATH_V3)
        self.assertNotIn("factors", v3)
        self.assertNotIn("state_ficha", v3)
        self.assertTrue(qt.config_hash(v3).startswith("c342bf2c"))


# --------------------------------------------------------------------------- the window by factors


class FactorsWindowTests(unittest.TestCase):
    def test_one_factors_call_on_the_real_state_and_one_on_the_mirror_instead_of_four_letter_questions(self):
        env = factor_env(self, lambda look, mirrored: SHORT_LINE if mirrored else LONG_LINE)
        env.op.start()
        env.advance(10)                                                         # the first wake of the window
        self.assertEqual(env.provider.calls, 2)
        self.assertEqual(len(env.provider.bodies), 2)
        self.assertTrue(all("grammar" in b and b["grammar"] == fq.GRAMMAR for b in env.provider.bodies))
        real, mirror = env.provider.prompts
        self.assertIn("QUESTION: Mirá los factores F1 a F8", real)
        self.assertNotIn("elegir un lado", real)
        self.assertIn("F1 Tendencia larga", real)
        self.assertNotEqual(real, mirror)
        self.assertEqual(real.split("STATE:")[0], mirror.split("STATE:")[0])         # the fixed text first (prefix cache)

    def test_lean_lean_m_lean_num_score_and_mirror_ok_come_out_of_the_sums_over_fourteen(self):
        env = factor_env(self, lambda look, mirrored: SHORT_LINE if mirrored else LONG_LINE)
        env.op.start()
        env.advance(10)
        row = decisions(env)[0]
        lean, lean_m = lean_of(LONG_LINE), lean_of(SHORT_LINE)
        self.assertGreater(lean, 0.5)
        self.assertLessEqual(lean, 1.0)
        self.assertAlmostEqual(row["lean"], lean)
        self.assertAlmostEqual(row["lean_m"], lean_m)
        self.assertAlmostEqual(row["lean_num"], (lean - lean_m) / 2)
        self.assertAlmostEqual(row["score"], abs((lean - lean_m) / 2))
        self.assertEqual((row["override"], row["action"], row["model_action"], row["look_n"], row["mirror_ok"]),
                         ("ventana_mirando", "ESPERAR", "LARGO", 1, 1))
        self.assertAlmostEqual(row["best_score"], row["score"])
        self.assertEqual(row["mirror_action"], "CORTO")
        p_largo, p_corto = fq.probabilities_for(lean)
        self.assertAlmostEqual(row["p_action"], p_largo)
        self.assertAlmostEqual(json.loads(row["probs_json"])["CORTO"], p_corto)

    def test_it_enters_when_the_numbers_and_the_mirror_agree_after_the_minimum_looks_and_keeps_the_eight_gradients(self):
        env = factor_env(self, lambda look, mirrored: SHORT_LINE if mirrored else LONG_LINE)
        env.op.start()
        env.advance(10)
        self.assertEqual(env.rows("SELECT * FROM trades"), [])                  # one look is not enough (min_looks 1)
        env.advance(15)
        entry = decisions(env)[-1]
        self.assertEqual((entry["override"], entry["action"], entry["look_n"], entry["reason"]),
                         ("entrada_ventana", "LARGO", 2, "entrada_ventana"))
        [trade] = env.rows("SELECT * FROM trades")
        self.assertEqual((trade["side"], trade["status"], trade["entry_reason"]), ("LONG", "open", "ventana"))
        # the 8 gradients of both answers are stored with the decision: {"real", "mirror", "lectura"}
        factors = json.loads(entry["factors_json"])
        self.assertEqual(set(factors), {"real", "mirror", "lectura"})
        self.assertTrue(all(len(v) == 8 for v in factors.values()))
        self.assertGreater(factors["real"][0], 1.0)
        self.assertLess(factors["mirror"][0], -1.0)
        for r, m, lec in zip(factors["real"], factors["mirror"], factors["lectura"]):
            self.assertAlmostEqual(lec, (r - m) / 2, places=3)
        self.assertAlmostEqual(sum(factors["lectura"][i] for i in (0, 1, 2, 3, 5, 6)) / 12, entry["lean_num"], places=3)   # F5 and F8 do not vote
        self.assertIn("F1 Tendencia larga", entry["state_text"])

    def test_an_answer_that_repeats_the_same_side_on_the_mirror_never_enters(self):
        env = factor_env(self, lambda look, mirrored: LONG_LINE, cfg=window_cfg(min_looks=2))
        env.op.start()
        env.advance(10 + 15 * 5)
        looks = decisions(env)
        self.assertEqual([r["look_n"] for r in looks], [1, 2, 3, 4, 5, 6])
        self.assertTrue(all(r["mirror_ok"] == 0 and r["override"] == "ventana_mirando" for r in looks))
        self.assertTrue(all(abs(r["score"]) < 0.01 for r in looks))
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        self.assertTrue(all(json.loads(r["factors_json"])["real"] for r in looks))        # still explained

    def test_a_neutral_real_answer_with_a_sure_mirror_is_a_candidate_with_the_neutral_threshold_of_always(self):
        env = factor_env(self, lambda look, mirrored: SHORT_LINE if mirrored else FLAT_LINE)
        env.op.start()
        env.advance(10)
        row = decisions(env)[0]
        self.assertLess(abs(row["lean"]), 0.05)                                  # a 50/50 real is noise, not a side
        self.assertLess(row["lean_m"], -0.5)
        self.assertEqual((row["mirror_ok"], row["model_action"]), (1, "LARGO"))
        self.assertAlmostEqual(row["lean_num"], (row["lean"] - row["lean_m"]) / 2)

    def test_the_minimum_score_is_the_same_rule_on_the_new_scale(self):
        small = [1, 0, 0, 0, 0, 0, 0, 0]
        env = factor_env(self, lambda look, mirrored: [-1] + [0] * 7 if mirrored else small, cfg=window_cfg(min_score=0.15))
        env.op.start()
        env.advance(10 + 15 * 3)
        looks = decisions(env)
        self.assertTrue(all(r["score"] < 0.15 and r["mirror_ok"] == 0 for r in looks))   # one line at +1 moves the lean 1/12
        self.assertEqual(env.rows("SELECT * FROM trades"), [])

    def test_after_the_window_hours_it_enters_at_the_first_candidate_without_a_record(self):
        def plan(look, mirrored):
            if look == 0:
                return SHORT_LINE if mirrored else LONG_LINE
            return [-1] * 7 + [0] if mirrored else [1] * 7 + [0]               # weaker than the first: never a record

        env = factor_env(self, plan, cfg=window_cfg(min_looks=50))
        env.op.start()
        env.advance(10 + 15 * 10)
        self.assertEqual(env.rows("SELECT * FROM trades"), [])
        env.advance(12 * 60)
        entry = [r for r in decisions(env) if r["override"] == "entrada_ventana"][0]
        self.assertGreater(entry["look_n"], 40)

    def test_an_unreadable_answer_is_an_omitted_wake_not_a_decision(self):
        def broken(look, mirrored):
            return LONG_LINE

        env = factor_env(self, broken)
        env.provider.chat_script = lambda body: completion(LONG_LINE, finish="length")
        env.op.start()
        env.advance(10)
        self.assertEqual(decisions(env), [])
        [skip] = env.rows("SELECT * FROM skipped")
        self.assertEqual(skip["reason"], "sin_respuesta")
        self.assertEqual(env.rows("SELECT * FROM trades"), [])

    def test_a_model_that_is_down_omits_the_wake_with_the_reason(self):
        env = factor_env(self, lambda look, mirrored: LONG_LINE, healthy=False)
        env.op.start()
        env.advance(10)
        self.assertEqual(decisions(env), [])
        self.assertEqual({r["reason"] for r in env.rows("SELECT * FROM skipped")}, {"modelo_caido"})
        self.assertEqual(env.provider.calls, 0)

    def test_the_position_question_is_still_one_letter_over_the_sheet_with_the_rules_tail(self):
        env = factor_env(self, lambda look, mirrored: SHORT_LINE if mirrored else LONG_LINE)
        env.op.start()
        env.advance(25)                                                         # look 1, look 2 = entry
        asked = env.provider.calls
        env.advance(15)
        held = decisions(env, "kind='position'")
        self.assertEqual([r["action"] for r in held], ["MANTENER"])
        self.assertEqual(env.provider.calls, asked + 2)                         # two option orders of the letter question
        prompt = env.provider.prompts[-1]
        self.assertIn("Tenés una posición abierta", prompt)
        self.assertIn("F1 Tendencia larga", prompt)
        self.assertIn("Posicion: LARGO abierta hace", prompt)
        self.assertIn("Reglas fijas que no podés cambiar: stop automatico", prompt)
        self.assertEqual(len(env.provider.bodies), 4)                           # no factors call while in a position

    def test_the_window_state_survives_a_restart(self):
        env = factor_env(self, lambda look, mirrored: SHORT_LINE if mirrored else LONG_LINE, cfg=window_cfg(min_looks=3))
        env.op.start()
        env.advance(10 + 15)
        op = env.restart()
        op.start()
        self.assertEqual(op.traders["PF_XBTUSD"].window["looks"], 2)
        self.assertEqual(op.gate.factors.template["version"], 6)

    def test_the_letters_window_is_still_there_for_a_config_without_factors(self):
        cfg = window_cfg()
        cfg.pop("factors")
        cfg["state_ficha"], cfg["state_context"] = False, []
        env = make(self, cfg=cfg, provider=ChatProvider(lambda body: completion(LONG_LINE), entries=Policy(forced="LARGO")))
        env.op.start()
        env.advance(10)
        self.assertTrue(any("elegir un lado" in p for p in env.provider.prompts))
        self.assertEqual(env.provider.bodies, [])
        self.assertIsNone(decisions(env)[0]["factors_json"])


# --------------------------------------------------------------------------- what the sheet needs in live


def row_f(text, number):
    return next(x for x in text.splitlines() if x.startswith("F{} ".format(number)))


class SheetDataTests(unittest.TestCase):
    def window_off(self, positioning_path=None, **kwargs):
        cfg = window_cfg(products=("PF_XBTUSD", "PF_ETHUSD"), force_window_h=0)
        if positioning_path:
            cfg["positioning_db"] = positioning_path
        return make(self, cfg=cfg, policy=Policy(flat="ESPERAR"), **kwargs)

    def sol(self, env):
        env.candles["PF_SOLUSD"] = walk(11 * 288, 31, BASE - 9 * DAY)

    def test_a_product_gets_the_closes_of_the_other_two_assets_and_never_its_own(self):
        env = self.window_off()
        self.sol(env)
        env.op.start()
        env.advance(10)
        btc, eth = env.op.traders["PF_XBTUSD"], env.op.traders["PF_ETHUSD"]
        self.assertEqual(sorted(btc.context), ["PF_ETHUSD", "PF_SOLUSD"])
        self.assertEqual(sorted(eth.context), ["PF_SOLUSD", "PF_XBTUSD"])
        last = btc.t[-1] + BAR
        self.assertIn(last, btc.context["PF_ETHUSD"])
        self.assertEqual(max(btc.context["PF_SOLUSD"]), last)                  # fed up to the closed candle, like the exam
        rows = {r["product"]: r["state_text"] for r in decisions(env)}
        f7_btc, f7_eth = row_f(rows["PF_XBTUSD"], 7), row_f(rows["PF_ETHUSD"], 7)
        self.assertIn("ETH:", f7_btc)
        self.assertIn("SOL:", f7_btc)
        self.assertNotIn("XBT:", f7_btc)
        self.assertIn("XBT:", f7_eth)
        self.assertIn("SOL:", f7_eth)
        self.assertNotIn("ETH:", f7_eth)
        self.assertNotIn("n/d", f7_btc)
        self.assertIn("fuerza de XBT contra el activo en 4h", f7_btc)

    def test_the_context_follows_the_candles_and_stays_bounded(self):
        env = self.window_off()
        self.sol(env)
        env.op.start()
        env.advance(60)
        sol = env.op.traders["PF_XBTUSD"].context["PF_SOLUSD"]
        self.assertEqual(max(sol), env.op.traders["PF_XBTUSD"].t[-1] + BAR)
        self.assertLessEqual(len(sol), 3 * 288 + 20)

    def test_an_asset_whose_candles_cannot_be_read_leaves_its_part_of_f7_empty_and_the_product_goes_on(self):
        env = self.window_off()                                                 # SOL has no candles in this feed
        env.op.start()
        env.advance(30)
        logs = [m for m in env.logs if "PF_SOLUSD" in m and "contexto" in m]
        self.assertEqual(len(logs), 2)                                          # once per product, not once per poll
        text = decisions(env, "product='PF_XBTUSD'")[0]["state_text"]
        self.assertIn("ETH:", row_f(text, 7))
        self.assertNotIn("SOL:", row_f(text, 7))
        self.assertTrue(decisions(env))

    def test_the_positioning_database_feeds_row_f6_and_is_opened_read_only(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "positioning.sqlite")
            positioning_db(path, "PF_XBTUSD", first_ms=BASE - 30 * HOUR, hours=60, long_start=40.0)
            add_positioning(path, "PF_ETHUSD", BASE - 30 * HOUR, 60, long_start=60.0)
            env = self.window_off(positioning_path=path)
            self.sol(env)
            env.op.start()
            env.advance(10)
            rows = {r["product"]: r["state_text"] for r in decisions(env)}
            for product in rows:
                self.assertIn("cuentas largas", row_f(rows[product], 6))
                self.assertNotIn("cuentas largas n/d", row_f(rows[product], 6))
            self.assertIn("grandes operadores", row_f(rows["PF_XBTUSD"], 6))
            self.assertTrue(any("posicionamiento de PF_XBTUSD leído de" in m for m in env.logs))
            self.assertEqual(env.rows("SELECT value FROM meta WHERE key='positioning_PF_XBTUSD'")[0]["value"], "true")
            os.chmod(path, 0o444)
            self.assertTrue(env.op.positioning["PF_XBTUSD"].available)              # mode=ro: no write was ever needed

    def test_without_the_database_f6_says_n_d_the_process_goes_on_and_the_log_says_it_once(self):
        env = self.window_off()
        self.sol(env)
        env.op.start()
        env.advance(90)                                                         # many polls, several refreshes
        said = [m for m in env.logs if "no existe la base de posicionamiento" in m]
        self.assertEqual(len(said), 1)
        self.assertIn("--positioning-db", said[0])
        self.assertIn("pnpm dev", said[0])
        self.assertGreater(len(decisions(env)), 4)
        self.assertIn("cuentas largas n/d", row_f(decisions(env)[0]["state_text"], 6))
        self.assertEqual(env.rows("SELECT value FROM meta WHERE key='positioning_PF_XBTUSD'")[0]["value"], "false")

    def test_a_database_that_shows_up_later_is_picked_up_without_a_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "positioning.sqlite")
            env = self.window_off(positioning_path=path)
            self.sol(env)
            env.op.start()
            env.advance(30)
            self.assertIn("cuentas largas n/d", row_f(decisions(env)[-1]["state_text"], 6))
            positioning_db(path, "PF_XBTUSD", first_ms=BASE - 30 * HOUR, hours=60)
            add_positioning(path, "PF_ETHUSD", BASE - 30 * HOUR, 60)
            env.advance(30)                                                     # past the 10 minutes between reads
            self.assertNotIn("cuentas largas n/d", row_f(decisions(env)[-1]["state_text"], 6))
            self.assertTrue(any("posicionamiento de PF_XBTUSD leído de" in m for m in env.logs))
            self.assertEqual(len([m for m in env.logs if "no existe la base de posicionamiento" in m]), 1)

    def test_a_file_without_rows_for_the_product_says_so_once_per_product(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "positioning.sqlite")
            positioning_db(path, "PF_XBTUSD", first_ms=BASE - 30 * HOUR, hours=60)
            env = self.window_off(positioning_path=path)
            self.sol(env)
            env.op.start()
            env.advance(60)
            self.assertEqual(len([m for m in env.logs if "no tiene datos de PF_ETHUSD" in m]), 1)
            self.assertIn("cuentas largas n/d", row_f(decisions(env, "product='PF_ETHUSD'")[0]["state_text"], 6))
            self.assertNotIn("cuentas largas n/d", row_f(decisions(env, "product='PF_XBTUSD'")[0]["state_text"], 6))

    def test_the_cli_takes_the_positioning_path_and_it_is_not_part_of_the_identity(self):
        args = live._parser().parse_args(["--positioning-db", "/tmp/x.sqlite"])
        self.assertEqual(args.positioning_db, "/tmp/x.sqlite")
        other = copy.deepcopy(LIVE_CFG)
        other["positioning_db"] = "/otra/ruta.sqlite"
        self.assertEqual(qt.config_hash(other), qt.config_hash(LIVE_CFG))


class PositioningFeedReloadTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "positioning.sqlite")

    def test_reload_sees_the_new_bucket_and_the_future_is_still_hidden(self):
        positioning_db(self.path, "PF_XBTUSD", first_ms=BASE, hours=5)
        feed = pd.PositioningFeed(self.path, "PF_XBTUSD", since_ms=BASE)
        at = BASE + 9 * HOUR
        self.assertEqual(feed.at(at)["long"], None)                             # the last bucket ended 3 h+ ago: a gap
        add_positioning(self.path, "PF_XBTUSD", BASE + 5 * HOUR, 3, long_start=70.0)
        self.assertTrue(feed.reload())
        self.assertEqual(feed.at(at)["long"], 70.0 + 1.0)
        self.assertEqual(pd.PositioningFeed(self.path, "PF_XBTUSD").at(BASE)["long"], None)   # nothing ended before the first bucket

    def test_reload_keeps_the_rows_when_the_file_cannot_be_read_and_since_limits_what_is_kept(self):
        positioning_db(self.path, "PF_XBTUSD", first_ms=BASE, hours=10)
        feed = pd.PositioningFeed(self.path, "PF_XBTUSD")
        self.assertEqual(len(feed.positioning), 10)
        feed.reload(since_ms=BASE + 6 * HOUR)
        self.assertEqual(len(feed.positioning), 4)
        with open(self.path, "wb") as handle:
            handle.write(b"esto no es una base sqlite" * 100)
        self.assertTrue(feed.reload())
        self.assertEqual(len(feed.positioning), 4)
        os.remove(self.path)
        self.assertFalse(feed.reload())


# --------------------------------------------------------------------------- the database of another configuration


class ArchiveTests(unittest.TestCase):
    def other_cfg(self, cfg=None, **change):
        out = copy.deepcopy(cfg or LIVE_CFG)
        out["prompt"]["version"] = 6
        out["prompt"]["system"] += " Otra cosa."
        out.update(change)
        return out

    def traded(self, policy):
        env = make(self, policy=policy)
        env.op.start()
        env.advance(60)
        env.store.close()
        return env

    def archive(self, env, cfg, **kwargs):
        logs = []
        return live.archive_other_config(env.db_path, cfg, funding_for=lambda product: [], now_ms=env.now[0], log=logs.append,
                                         **kwargs), logs

    def rows(self, path, sql):
        con = sqlite3.connect(path)
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql)]
        finally:
            con.close()

    def test_a_database_of_another_config_is_archived_with_the_old_hash_in_the_name_and_a_new_one_starts(self):
        env = self.traded(Policy(flat="ESPERAR"))
        old_hash = qt.config_hash(env.cfg)
        before = {t: self.rows(env.db_path, "SELECT * FROM {}".format(t)) for t in ("decisions", "trades", "skipped", "meta")}
        self.assertTrue(before["decisions"])
        new = self.other_cfg(env.cfg)
        result, logs = self.archive(env, new)
        self.assertEqual(os.path.basename(result["path"]), "live-{}.sqlite".format(old_hash[:12]))
        self.assertEqual(os.path.dirname(result["path"]), env.tmp)                                   # same folder
        self.assertEqual(result["old_hash"], old_hash)
        self.assertFalse(os.path.exists(env.db_path))
        for table, rows in before.items():                                                          # nothing lost
            self.assertEqual(self.rows(result["path"], "SELECT * FROM {}".format(table)), rows, table)
        self.assertTrue(any("ARCHIVÓ" in m and "no se borró nada" in m for m in logs))
        store = live.LiveStore(env.db_path)
        self.addCleanup(store.close)
        store.check_identity(new)                                                                   # the new base takes the new identity
        self.assertEqual(store.meta()["config_hash"], qt.config_hash(new))
        self.assertEqual(store.db.execute("SELECT COUNT(*) FROM decisions").fetchone()[0], 0)

    def test_an_open_position_is_closed_as_fin_de_bloque_cambio_de_version_before_archiving(self):
        env = self.traded(Policy(flat="LARGO"))
        open_rows = self.rows(env.db_path, "SELECT * FROM trades WHERE status='open' ORDER BY product")
        self.assertEqual(len(open_rows), 2)
        result, logs = self.archive(env, self.other_cfg(env.cfg))
        self.assertEqual({(p, n) for p, n, _ in result["closed"]}, {(r["product"], r["trade_no"]) for r in open_rows})
        archived = self.rows(result["path"], "SELECT * FROM trades ORDER BY product")
        for before, row in zip(open_rows, archived):
            self.assertEqual((row["status"], row["closed_by"], row["exit_reason"]), ("closed", "fin_de_bloque", "cambio_de_version"))
            self.assertEqual(row["exit_ms"], before["mark_ms"])                                           # at the last moment seen
            self.assertAlmostEqual(float(row["exit_px"]) / before["mark_px"], 1.0, delta=0.002)           # its price, less the exit slippage
            self.assertLess(float(row["exit_px"]), before["mark_px"])
            self.assertIsNotNone(row["net_usd"])
            self.assertIsNotNone(row["net_bp"])
            self.assertEqual(row["entry_px"], before["entry_px"])
            self.assertEqual(row["notional_usd"], before["notional_usd"])
            self.assertGreater(float(row["fees_usd"]), 0)
        self.assertEqual(self.rows(result["path"], "SELECT COUNT(*) AS n FROM trader_state WHERE position_json IS NOT NULL")[0]["n"], 0)
        self.assertEqual(len([m for m in logs if "fin_de_bloque / cambio_de_version" in m]), 2)
        self.assertEqual(self.rows(result["path"], "SELECT COUNT(*) AS n FROM decisions")[0]["n"],
                         len(self.rows(result["path"], "SELECT * FROM decisions")))
        # the gate and the Terminal read the new base: no trades, no decisions, and the old ones stay in the archive
        new = self.other_cfg(env.cfg)
        store = live.LiveStore(env.db_path)
        self.addCleanup(store.close)
        store.check_identity(new)
        source = models.QwenLiveTrades(env.db_path, os.path.join(env.tmp, "no-exam.sqlite"))
        self.assertEqual(source.live_trades("PF_XBTUSD"), [])
        self.assertEqual(models.live_config_hash(env.tmp), qt.config_hash(new))
        archived_source = models.QwenLiveTrades(result["path"], os.path.join(env.tmp, "no-exam.sqlite"))
        self.assertEqual([t["net_bp"] is not None for t in archived_source.live_trades("PF_XBTUSD")], [True])

    def test_the_funding_that_cannot_be_read_does_not_stop_the_archive(self):
        env = self.traded(Policy(flat="LARGO"))

        def down(product):
            raise OSError("sin red")

        logs = []
        result = live.archive_other_config(env.db_path, self.other_cfg(env.cfg), funding_for=down, now_ms=env.now[0], log=logs.append)
        self.assertEqual(len(result["closed"]), 2)
        self.assertEqual({r["funding_status"] for r in self.rows(result["path"], "SELECT * FROM trades")}, {"unknown"})

    def test_the_same_configuration_or_no_file_or_an_empty_one_archives_nothing(self):
        env = self.traded(Policy(flat="LARGO"))
        self.assertIsNone(live.archive_other_config(env.db_path, env.cfg, log=lambda m: self.fail(m)))
        self.assertTrue(os.path.exists(env.db_path))
        self.assertEqual(len(self.rows(env.db_path, "SELECT * FROM trades WHERE status='open'")), 2)     # untouched
        # the window and polling settings live outside the identity
        tuned = copy.deepcopy(env.cfg)
        tuned["live"]["force_min_score"] = 0.3
        self.assertIsNone(live.archive_other_config(env.db_path, tuned, log=lambda m: self.fail(m)))
        self.assertIsNone(live.archive_other_config(os.path.join(env.tmp, "nada.sqlite"), env.cfg))
        empty = os.path.join(env.tmp, "vacia.sqlite")
        open(empty, "wb").close()
        self.assertIsNone(live.archive_other_config(empty, env.cfg))
        self.assertTrue(os.path.exists(empty))

    def test_a_changed_size_leverage_or_product_list_is_another_configuration_too(self):
        for change in ({"QWEN_LIVE_NOTIONAL_USD": "250"}, {"QWEN_LIVE_LEVERAGE": "2"}, {"QWEN_LIVE_PRODUCTS": "PF_XBTUSD"}):
            env = self.traded(Policy(flat="ESPERAR"))
            new = live.apply_overrides(env.cfg, change)
            result, _ = self.archive(env, new)
            self.assertIsNotNone(result, change)
            self.assertTrue(os.path.exists(result["path"]))

    def test_a_name_that_is_taken_gets_a_number_and_nothing_is_ever_overwritten(self):
        env = self.traded(Policy(flat="ESPERAR"))
        new = self.other_cfg(env.cfg)
        first, _ = self.archive(env, new)
        shutil_copy = lambda src, dst: open(dst, "wb").write(open(src, "rb").read())
        shutil_copy(first["path"], env.db_path)                                  # the same old base shows up again
        second, _ = self.archive(env, new)
        self.assertNotEqual(first["path"], second["path"])
        self.assertTrue(second["path"].endswith("-2.sqlite"))
        self.assertTrue(os.path.exists(first["path"]) and os.path.exists(second["path"]))

    def test_the_operator_itself_still_refuses_a_base_of_another_config(self):
        env = self.traded(Policy(flat="ESPERAR"))
        store = live.LiveStore(env.db_path)
        self.addCleanup(store.close)
        with self.assertRaises(qt.TraderError):
            store.check_identity(self.other_cfg(env.cfg))

    def test_a_base_without_the_factors_column_gets_it_and_a_decision_keeps_its_factors(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "live.sqlite")
            old = sqlite3.connect(path)
            old.executescript("""
CREATE TABLE decisions(product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, decided_at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL, action TEXT NOT NULL, lean REAL, PRIMARY KEY(product, bucket_ms));
INSERT INTO decisions VALUES('PF_XBTUSD', 0, 900000, 1, 'flat', 'ESPERAR', 0.1);""")
            old.commit()
            old.close()
            store = live.LiveStore(path)
            self.addCleanup(store.close)
            self.assertIn("factors_json", {r[1] for r in store.db.execute("PRAGMA table_info(decisions)")})
            self.assertEqual(store.db.execute("SELECT action, factors_json FROM decisions").fetchone()[:], ("ESPERAR", None))


# --------------------------------------------------------------------------- the Examen and the quick test of the live config


def exam_cfg():
    cfg = live.apply_overrides(LIVE_CFG)
    cfg["practice"]["from"] = "2025-02-05"
    cfg["exam"].update(snapshots=30, time_bins=3)
    cfg["positioning_db"] = os.path.join(tempfile.gettempdir(), "no-existe-posicionamiento.sqlite")
    return cfg


def history_with_sol():
    series = dict(SERIES)
    start = qt.date_ms(START_DAY) - 9 * DAY
    series["PF_SOLUSD"] = walk_series(((HOLDOUT + 3 * DAY) - start) // BAR, 22, start=start, price=200.0)
    return MemHistory(series=series)


class ExamLiveTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = os.path.join(self.dir.name, "exam-live.sqlite")
        self.cfg = exam_cfg()

    def run_exam(self, cfg=None, db=None):
        clock = [0.0]
        provider = ChatProvider(reading_script(clock))
        outcome = ex.run_exam(history_with_sol(), db or self.db, provider, cfg or self.cfg, HOLDOUT, max_minutes=500,
                              clock=lambda: clock[0], log=lambda *a: None)
        return outcome, provider

    def test_the_exam_of_the_live_config_asks_by_factors_real_and_mirror_with_the_sheet_context_and_the_live_wakes(self):
        outcome, provider = self.run_exam()
        self.assertEqual((outcome["stop_reason"], outcome["answered"], outcome["total"]), ("done", 30, 30))
        self.assertEqual(provider.calls, 60)                                      # one call per STATE: real and mirror
        con = sqlite3.connect(self.db)
        self.addCleanup(con.close)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM exam_factors").fetchone()[0], 60)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM exam_ficha").fetchone()[0], 30)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM calls").fetchone()[0], 0)
        times = [r[0] for r in con.execute("SELECT t_ms FROM exam_snapshots")]
        self.assertTrue(all(t % (15 * MIN) == 0 for t in times))                  # live wakes: the 15 minute boundaries only
        for state, in con.execute("SELECT state_text FROM exam_snapshots"):
            self.assertIn("Despertaste por: cada_15_min", state)
            self.assertIn("F1 Tendencia larga", state)
            self.assertIn("ETH:", row_f(state, 7))
            self.assertIn("SOL:", row_f(state, 7))
            self.assertNotIn("XBT:", row_f(state, 7))
            self.assertIn("cuentas largas n/d", row_f(state, 6))                  # no collector database in the test
            self.assertIn("Posicion: ninguna", state)
        identity = json.loads(con.execute("SELECT value FROM meta WHERE key='config_hash'").fetchone()[0])
        self.assertEqual(identity, qt.config_hash(self.cfg))

    def test_every_photo_has_a_lean_num_and_the_analysis_of_the_exam_runs_on_them(self):
        self.run_exam()
        rows, meta = ex.load_answers(self.db)
        self.assertEqual(len(rows), 30)
        for r in rows:
            self.assertIsNotNone(r["lean_num"])
            self.assertTrue(-1.0 <= r["lean_num"] <= 1.0)
            f = r["factors"]
            self.assertAlmostEqual(r["lean_num"], (fq.lean_of(f["real"]) - fq.lean_of(f["mirror"])) / 2)
            self.assertAlmostEqual(r["lean"], fq.lean_of(f["real"]))
            self.assertAlmostEqual(r["lean_m"], fq.lean_of(f["mirror"]))
        result = ex.analyse_lean(rows, self.cfg)
        self.assertEqual(result["n"], 30)
        self.assertEqual(meta["config_hash"], qt.config_hash(self.cfg))

    def test_the_gate_reads_those_photos_for_the_live_version_and_only_for_it(self):
        self.run_exam()
        live_path = os.path.join(self.dir.name, "live.sqlite")
        store = live.LiveStore(live_path)
        self.addCleanup(store.close)
        store.set_meta("config_hash", qt.config_hash(self.cfg))                  # the version the live database carries
        rows, _ = ex.load_answers(self.db)
        source = models.QwenLiveTrades(live_path, self.db)
        got = source.photo_trades("PF_XBTUSD", [])
        self.assertTrue(got)
        self.assertEqual({t["source"] for t in got}, {"photo"})
        by_time = {r["t_ms"]: r for r in rows}
        pool = sorted((r for r in rows if r["lean_num"] not in (None, 0)), key=lambda r: r["lean_num"])
        k = max(1, int(len(pool) * LIVE_CFG["exam_lean"]["extreme_share"]))
        lows, highs = {r["t_ms"] for r in pool[:k]}, {r["t_ms"] for r in pool[len(pool) - k:]}
        for trade in got:
            row = by_time[trade["entry_time_ms"]]
            self.assertEqual(trade["side"], "LONG" if trade["entry_time_ms"] in highs else "SHORT")
            self.assertIn(trade["entry_time_ms"], lows | highs)
            self.assertEqual(trade["exit_time_ms"] - trade["entry_time_ms"], models.LIVE_HOLD_MS)
            sign = 1 if trade["side"] == "LONG" else -1
            self.assertAlmostEqual(trade["net_bp"], sign * row["moves"]["240"] - row["cost_bp"])
        # a live version with another configuration (its database carries another hash) takes none of them
        store.set_meta("config_hash", "otra-configuracion")
        self.assertEqual(source.photo_trades("PF_XBTUSD", []), [])

    def test_the_default_exam_database_of_the_gate_is_the_live_one_and_v3_keeps_its_own(self):
        self.assertTrue(qt.DEFAULT_EXAM_DB_LIVE.endswith("exam-live.sqlite"))
        self.assertNotEqual(qt.DEFAULT_EXAM_DB_LIVE, qt.DEFAULT_EXAM_DB_V3)
        with tempfile.TemporaryDirectory() as folder:
            _, source = models.model_subject(models.QWEN_LIVE_ID, qwen_live_dir=folder)
            self.assertEqual(source.exam_db_path, qt.DEFAULT_EXAM_DB_LIVE)
            self.assertEqual(source.live_db_path, os.path.join(folder, "live.sqlite"))
        args = qt._parser().parse_args(["exam", "--version", "live"])
        self.assertEqual((args.version, args.exam_db), ("live", None))
        self.assertEqual(qt._parser().parse_args(["exam"]).version, "3")

    def test_exam_version_live_from_the_command_line_runs_the_live_config_in_its_own_database(self):
        config = os.path.join(self.dir.name, "live-chica.json")
        with open(config, "w", encoding="utf-8") as handle:
            json.dump(self.cfg, handle)
        clock = [0.0]
        provider = ChatProvider(reading_script(clock))
        saved = (qt.History, qt._provider, qt.load_holdout_ms)
        qt.History, qt._provider, qt.load_holdout_ms = (lambda *a, **k: history_with_sol(), lambda url, timeout=120.0: provider,
                                                        lambda path=None: HOLDOUT)
        self.addCleanup(lambda: setattr(qt, "History", saved[0]) or setattr(qt, "_provider", saved[1])
                        or setattr(qt, "load_holdout_ms", saved[2]))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = qt.main(["exam", "--version", "live", "--config", config, "--exam-db", self.db, "--offline"])
        self.assertEqual(code, 0)
        self.assertIn("versión live", out.getvalue())
        con = sqlite3.connect(self.db)
        self.addCleanup(con.close)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM exam_answers").fetchone()[0], 30)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM exam_factors").fetchone()[0], 60)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = qt.main(["exam", "--version", "live", "--config", config, "--exam-db", self.db, "--offline", "--variant",
                            "p1-direccion"])
        self.assertEqual(code, 2)                                                 # the other variants are changes of the v3

    def test_the_v3_exam_is_not_touched_by_any_of_this(self):
        cfg = ex_cfg3()
        clock = [0.0]
        provider = ChatProvider(reading_script(clock), entries=lambda prompt, letters: [
            {"token": x, "logprob": -0.05 if x == letters[0] else -6.0} for x in letters])
        db = os.path.join(self.dir.name, "exam-v3.sqlite")
        outcome = ex.run_exam(MemHistory(), db, provider, cfg, HOLDOUT, max_minutes=500, clock=lambda: clock[0], log=lambda *a: None)
        self.assertEqual(outcome["stop_reason"], "done")
        con = sqlite3.connect(db)
        self.addCleanup(con.close)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM exam_factors").fetchone()[0] if con.execute(
            "SELECT name FROM sqlite_master WHERE name='exam_factors'").fetchone() else 0, 0)
        self.assertGreater(con.execute("SELECT COUNT(*) FROM calls").fetchone()[0], 0)


def ex_cfg3():
    from test_futures_qwen_exam import cfg3
    return cfg3()


class QuickLiveTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def test_the_actual_variant_is_qwen_en_vivo_as_it_runs_and_the_others_still_change_the_v3(self):
        actual = qv.get_variant("actual")
        self.assertEqual((actual["kind"], actual["base"]), ("control", "live"))
        self.assertIn("Qwen en vivo", actual["label"])
        self.assertNotIn("base", qv.get_variant("ficha"))
        cfg = exam_cfg()
        self.assertEqual(qt.config_hash(qv.apply_variant(cfg, actual)), qt.config_hash(cfg))
        spawned = []
        api = quick_api.QuickTestApi(os.path.join(self.dir.name, "exam-live.sqlite"), python="py", spawn=lambda *a: spawned.append(a))
        api.launch(models.QWEN_LIVE_ID, "actual")
        api.launch(models.QWEN_LIVE_ID, "ficha")
        versions = [a[0][a[0].index("--version") + 1] for a in spawned]
        self.assertEqual(versions, ["live", "3"])
        self.assertEqual([a[0][a[0].index("--variant") + 1] for a in spawned], ["actual", "ficha"])

    def test_the_quick_test_on_the_live_config_leaves_the_reading_table_per_line_for_the_screen(self):
        variant = qv.get_variant("actual")
        clock = [0.0]
        provider = ChatProvider(reading_script(clock))
        db = os.path.join(self.dir.name, qv.db_name("actual"))
        state_path = os.path.join(self.dir.name, qv.state_name("actual"))
        state = ex.run_quick(history_with_sol(), db, provider, qv.apply_variant(exam_cfg(), variant), HOLDOUT, snapshots=30,
                             max_minutes=500, clock=lambda: clock[0], log=lambda *a: None, state_path=state_path, variant=variant)
        self.assertEqual((state["state"], state["answered"]), ("done", 30))
        ficha = state["summary"]["ficha"]
        self.assertEqual([r["id"] for r in ficha["readings"]], ["F1", "F2", "F3", "F4", "F6", "F7"])
        self.assertEqual(ficha["photos"], 30)
        self.assertTrue(ficha["comparison"])
        with open(state_path, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["variant"], "actual")


if __name__ == "__main__":
    unittest.main()
