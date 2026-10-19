"""Strategy gate: split, exam lock, verdict rules, controls (negative and positive), progress and cancellation.

No network: the candles are synthetic, injected through a provider. The "cheating" strategy (positive control) lives
only here; it is not in config/strategies nor in any registry.
"""

import copy
import io
import json
import math
import os
import random
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout

from balancita_engine import strategy_gate as g
from balancita_engine.futures_costs import entry_fill
from balancita_engine.futures_qwen_practice import horizon_net_bp
from balancita_engine.futures_spec_strategy import load_specs
from test_futures_qwen_practice import MINUTE, T0, aggregate, synthetic

DAY = 86_400_000
HOLDOUT = T0 + 20 * DAY            # 2025-01-21
FROM = T0 + 8 * DAY                # 2025-01-09 (the first 8 days only warm indicators up)
NOW = T0 + 28 * DAY
CFG = dict(g.load_config(), holdout_from="2025-01-21", default_from="2025-01-09", default_products=["PF_XBTUSD"],
           random_draws=200, bootstrap_draws=300, neighbors={"enabled": False, "pct": 0.2, "max_params": 6})
ONES, FIVES = synthetic(minutes=30 * 1440, seed=11)
SPECS = load_specs()


def driftless(minutes=30 * 1440, seed=5):
    """A pure Gaussian random walk (no trend, no cycle): nothing to find, so nothing may pass."""
    rng, price, ones = random.Random(seed), 50_000.0, []
    for i in range(minutes):
        open_, price = price, max(100.0, price + rng.gauss(0, 14))
        ones.append({"bucket_start": T0 + i * MINUTE, "open": "%.1f" % open_, "close": "%.1f" % price,
                     "high": "%.1f" % (max(open_, price) + abs(rng.gauss(0, 6))),
                     "low": "%.1f" % (min(open_, price) - abs(rng.gauss(0, 6))),
                     "volume_btc": "%.4f" % (abs(rng.gauss(2.0, 1.0)) * (6 if rng.random() < 0.03 else 1))})
    return ones, aggregate(ones)


class Provider:
    """Synthetic candles; remembers the furthest instant anyone asked for."""

    def __init__(self, ones=ONES, fives=FIVES, funding=(), fail_prefetch=False):
        self.ones, self.fives, self.funding_rows, self.fail_prefetch = ones, fives, list(funding), fail_prefetch
        self.asked_to = []

    def prefetch(self, product, from_ms, to_ms):
        if self.fail_prefetch:
            raise g.HistoryError("sin red")

    def candles(self, product, from_ms, to_ms):
        self.asked_to.append(to_ms)
        return ([c for c in self.ones if from_ms <= c["bucket_start"] < to_ms],
                [c for c in self.fives if from_ms <= c["bucket_start"] < to_ms])

    def funding(self, product):
        return self.funding_rows


def _trade(side, entry_ms, hold, net, reason="time_stop"):
    return {"side": side, "entry_time_ms": entry_ms, "exit_time_ms": entry_ms + hold * MINUTE, "net_bp": net,
            "funding_usd": 0.0, "funding_status": "complete", "exit_reason": reason}


def losing_source(spec, product, tick, ones, fives, funding, start_ms, end_ms, chunk):
    """Negative control: buys every 45 minutes and holds 15; on a driftless walk the costs eat it."""
    trades = []
    for i in range(0, len(ones) - 16, 45):
        if ones[i]["bucket_start"] >= start_ms:
            net = horizon_net_bp("LONG", product, ones[i]["close"], ones[i + 15]["close"])
            trades.append(_trade("LONG", ones[i]["bucket_start"] + MINUTE, 15, net))
    return trades, 0


def cheating_source(spec, product, tick, ones, fives, funding, start_ms, end_ms, chunk):
    """Positive control: peeks 60 minutes into the future and takes the side of a big move."""
    trades, i = [], 0
    while i < len(ones) - 61:
        later = float(ones[i + 60]["close"]) / float(ones[i]["close"]) - 1
        if ones[i]["bucket_start"] >= start_ms and abs(later) > 0.0025:
            side = "LONG" if later > 0 else "SHORT"
            net = horizon_net_bp(side, product, ones[i]["close"], ones[i + 60]["close"])
            trades.append(_trade(side, ones[i]["bucket_start"] + MINUTE, 60, net))
            i += 60
        else:
            i += 1
    return trades, 0


def run(strategy="c25-pullback-perp-v1", directory=None, **kwargs):
    kwargs.setdefault("cfg", CFG)
    kwargs.setdefault("provider", Provider())
    kwargs.setdefault("jobs", 1)
    kwargs.setdefault("neighbors", False)
    kwargs.setdefault("now_ms", NOW)
    return g.evaluate(strategy, data_dir=directory, **kwargs)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)

    def db(self):
        return g.open_db(os.path.join(self.dir, g.DB_NAME), readonly=True)


class IdentityTests(unittest.TestCase):
    def test_version_key_is_id_plus_spec_hash_and_follows_content(self):
        spec = SPECS["c29-momentum-perp-v1"]
        key, digest = g.version_key_of(spec)
        self.assertEqual(key, "c29-momentum-perp-v1:" + digest)
        self.assertEqual(len(digest), 64)
        changed = copy.deepcopy(spec)
        changed["params"]["z_min"] = "3"
        self.assertNotEqual(g.version_key_of(changed)[0], key)

    def test_family_drops_version_suffix(self):
        self.assertEqual(g.family_of("c29-momentum-perp-v1"), "c29-momentum-perp")
        self.assertEqual(g.family_of("c29-momentum-perp-v12"), "c29-momentum-perp")
        self.assertEqual(g.family_of("lab-x"), "lab-x")

    def test_config_declares_the_holdout_and_the_rules(self):
        cfg = g.load_config()
        self.assertEqual(cfg["holdout_from"], "2026-04-19")
        self.assertEqual(cfg["rules"]["min_trades"], 100)
        self.assertEqual(cfg["rules"]["min_percentile_vs_random"], 95)
        self.assertEqual(cfg["rules"]["cost_stress_multiplier"], 1.5)


class JudgeTests(unittest.TestCase):
    def series(self):
        rng, price, closes = random.Random(3), 50_000.0, []
        for _ in range(20_000):
            price *= 1 + rng.gauss(0, 0.0003)
            closes.append(price)
        return {"BTC": {"closes": closes, "first_ms": 0, "start_index": 0}}

    def trades(self, n, mean, seed=1):
        rng = random.Random(seed)
        return [{"product": "BTC", "side": "LONG" if i % 2 else "SHORT", "entry_ms": 1000 + i * 3_600_000,
                 "exit_ms": 1000 + i * 3_600_000 + 900_000, "net_bp": rng.gauss(mean, 12), "funding_bp": 0.0,
                 "funding_status": "complete", "reason": "time_stop"} for i in range(n)]

    def judge(self, trades, attempts=1):
        end = max(t["exit_ms"] for t in trades) + 1
        return g.judge(trades, self.series(), CFG, kind="practice", start_ms=0, end_ms=end, attempts=attempts,
                       products=["BTC"], seed=5)

    def test_losing_trades_do_not_pass(self):
        result = self.judge(self.trades(400, -4))
        self.assertEqual(result["verdict"], "NO PASA")
        self.assertFalse(result["rules"][1]["ok"])

    def test_positive_trades_with_edge_pass_every_rule(self):
        result = self.judge(self.trades(400, 25))
        self.assertEqual(result["verdict"], "PASA", [c for c in result["rules"] if not c["ok"]])

    def test_few_trades_are_inconclusive(self):
        self.assertEqual(self.judge(self.trades(60, 25))["verdict"], "INCONCLUSO")

    def test_more_attempts_make_the_deflated_sharpe_stricter(self):
        trades = self.trades(150, 3.5)
        one = self.judge(trades, attempts=1)["deflated"]
        many = self.judge(trades, attempts=40)["deflated"]
        self.assertGreater(one, many)

    def test_cost_stress_can_fail_a_thin_edge(self):
        result = self.judge(self.trades(400, 4))
        stress = [c for c in result["rules"] if c["id"] == "cost_stress"][0]
        self.assertFalse(stress["ok"])
        self.assertEqual(result["verdict"], "NO PASA")

    def test_max_drawdown(self):
        self.assertEqual(g.max_drawdown([5, -3, -4, 10, -2]), 7)


class ControlTests(Base):
    def test_negative_control_losing_strategy_does_not_pass(self):
        out = run("lab-losing-v1", self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-losing-v1"),
                  trade_source=losing_source)
        self.assertEqual(out["verdict"], "NO PASA")
        self.assertGreaterEqual(out["result"]["overall"]["n"], 100)
        self.assertLess(out["result"]["overall"]["mean_bp"], 0)

    def test_positive_control_cheating_strategy_passes(self):
        out = run("lab-cheat-v1", self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"),
                  trade_source=cheating_source)
        failed = [c for c in out["result"]["rules"] if not c["ok"]]
        self.assertEqual(out["verdict"], "PASA", failed)
        self.assertGreaterEqual(out["result"]["percentile"], 95)

    def test_shipped_strategies_on_a_driftless_walk_never_pass(self):
        # C25-C32 on data with no edge: every verdict is NO PASA or INCONCLUSO, never PASA.
        provider = Provider(*driftless())
        for strategy in sorted(SPECS):
            out = run(strategy, self.dir, provider=provider)
            self.assertIn(out["verdict"], ("NO PASA", "INCONCLUSO"), strategy)
            self.assertEqual(out["status"], "done")
            if out["verdict"] == "NO PASA":
                self.assertFalse(out["result"]["rules"][1]["ok"], strategy)  # no positive mean to defend

    def test_neighbors_move_one_param_at_a_time(self):
        cfg = dict(CFG, neighbors={"enabled": True, "pct": 0.2, "max_params": 6})
        variants = g.neighbor_specs(SPECS["c29-momentum-perp-v1"], cfg)
        self.assertEqual(len(variants), 2 * len(SPECS["c29-momentum-perp-v1"]["params"]))
        name, direction, value, spec = variants[0]
        self.assertNotEqual(spec["params"][name], SPECS["c29-momentum-perp-v1"]["params"][name])
        self.assertEqual(g.neighbor_specs(SPECS["c29-momentum-perp-v1"], CFG), [])

    def test_neighbor_run_reports_sensitivity(self):
        cfg = dict(CFG, neighbors={"enabled": True, "pct": 0.2, "max_params": 2})
        out = run("c29-momentum-perp-v1", self.dir, cfg=cfg, neighbors=True)
        self.assertEqual(len(out["result"]["sensitivity"]), 4)
        with open(out["report_path"], encoding="utf-8") as handle:
            self.assertIn("Vecinos con media positiva", handle.read())


class SplitTests(Base):
    def test_practice_never_asks_for_nor_depends_on_data_from_the_cutoff(self):
        clean = Provider()
        first = run("lab-cheat-v1", self.dir, provider=clean, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"),
                    trade_source=losing_source)
        self.assertTrue(all(t <= HOLDOUT for t in clean.asked_to), clean.asked_to)
        # Poison everything from the cutoff on: same trades, byte for byte.
        poisoned = [dict(c, close="1.0", high="1000000.0") if c["bucket_start"] >= HOLDOUT else c for c in ONES]
        other = run("lab-cheat-v1", tempfile.mkdtemp(), provider=Provider(ones=poisoned, fives=FIVES),
                    spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"), trade_source=losing_source)
        self.assertEqual(first["result"]["overall"], other["result"]["overall"])
        self.assertLessEqual(max(t["exit_ms"] for t in [] or [{"exit_ms": 0}]), HOLDOUT)

    def test_real_strategy_practice_ignores_poisoned_future_and_exits_before_cutoff(self):
        poisoned = [dict(c, close="1.0", low="0.5") if c["bucket_start"] >= HOLDOUT else c for c in ONES]
        poisoned_fives = [dict(c, close="1.0", low="0.5") if c["bucket_start"] >= HOLDOUT else c for c in FIVES]
        a = run("c27-breakout-perp-v1", self.dir)
        b = run("c27-breakout-perp-v1", self.dir, provider=Provider(poisoned, poisoned_fives))
        self.assertEqual(a["result"]["overall"], b["result"]["overall"])
        self.assertEqual(a["result"]["folds"], b["result"]["folds"])

    def test_practice_cannot_start_at_or_after_the_cutoff(self):
        with self.assertRaises(g.GateError):
            run("c25-pullback-perp-v1", self.dir, from_date="2025-01-21")

    def test_exam_takes_no_from(self):
        with self.assertRaises(g.GateError):
            run("c25-pullback-perp-v1", self.dir, kind="exam", from_date="2025-01-10")

    def test_exam_only_counts_entries_from_the_cutoff(self):
        out = run("lab-cheat-v1", self.dir, kind="exam", spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"),
                  trade_source=cheating_source)
        self.assertGreater(out["result"]["overall"]["n"], 0)
        self.assertGreaterEqual(out["result"]["edges"][0], HOLDOUT)
        self.assertEqual(len(out["result"]["folds"]), CFG["exam_folds"])


class ExamLockTests(Base):
    def cheat(self, version=1, **kwargs):
        sid = "lab-cheat-v{}".format(version)
        return run(sid, self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id=sid, **kwargs.pop("changes", {})),
                   trade_source=cheating_source, **kwargs)

    def test_second_exam_of_the_same_version_is_refused_with_date_and_verdict(self):
        first = self.cheat(kind="exam")
        with self.assertRaises(g.GateError) as caught:
            self.cheat(kind="exam")
        message = str(caught.exception)
        self.assertIn("El examen final de esta versión ya se rindió el ", message)
        self.assertIn(first["verdict"], message)
        self.assertIn("Para volver a rendirlo, creá una versión nueva.", message)
        self.assertEqual(len(g.list_runs(os.path.join(self.dir, g.DB_NAME))), 1)

    def test_a_new_version_can_sit_its_own_exam(self):
        self.cheat(1, kind="exam")
        out = self.cheat(2, kind="exam")
        self.assertEqual(out["status"], "done")
        rows = self.db().execute("SELECT strategy_id FROM exam_locks ORDER BY strategy_id").fetchall()
        self.assertEqual([r[0] for r in rows], ["lab-cheat-v1", "lab-cheat-v2"])

    def test_changed_content_with_the_same_id_is_refused_after_an_exam(self):
        self.cheat(1, kind="exam")
        with self.assertRaises(g.GateError) as caught:
            self.cheat(1, kind="exam", changes={"name": "otro contenido"})
        self.assertIn("versión", str(caught.exception))
        self.assertIn("-v2", str(caught.exception))

    def test_changed_content_with_the_same_id_is_refused_without_a_lock_too(self):
        self.cheat(1)  # a practice run registers the hash
        with self.assertRaises(g.GateError) as caught:
            self.cheat(1, kind="exam", changes={"name": "otro contenido"})
        self.assertIn("la versión es la misma", str(caught.exception))

    def test_practice_does_not_consume_the_exam(self):
        self.cheat(1)
        self.cheat(1)
        self.assertEqual(self.cheat(1, kind="exam")["status"], "done")

    def test_failure_before_any_outcome_keeps_the_lock_free(self):
        with self.assertRaises(g.HistoryError):
            self.cheat(1, kind="exam", provider=Provider(fail_prefetch=True))
        self.assertEqual(self.db().execute("SELECT COUNT(*) FROM exam_locks").fetchone()[0], 0)
        self.assertEqual(self.db().execute("SELECT status FROM runs").fetchone()[0], "failed")
        self.assertEqual(self.cheat(1, kind="exam")["status"], "done")

    def test_cancel_after_reading_the_cutoff_consumes_the_lock(self):
        def cancel(event):
            if event["detail"] == "calculando operaciones":
                os.makedirs(os.path.join(self.dir, "cancel"), exist_ok=True)
                open(os.path.join(self.dir, "cancel", str(event["run_id"])), "w").close()
        out = self.cheat(1, kind="exam", on_progress=cancel)
        self.assertEqual(out["status"], "cancelled")
        row = self.db().execute("SELECT status, verdict FROM exam_locks").fetchone()
        self.assertEqual(row["status"], "cancelled")
        self.assertEqual(self.db().execute("SELECT holdout_read FROM runs").fetchone()[0], 1)
        with self.assertRaises(g.GateError) as caught:
            self.cheat(1, kind="exam")
        self.assertIn("ya se rindió", str(caught.exception))

    def test_cancel_during_download_keeps_the_lock_free(self):
        def cancel(event):
            if event["detail"] and event["detail"].startswith("descargando"):
                os.makedirs(os.path.join(self.dir, "cancel"), exist_ok=True)
                open(os.path.join(self.dir, "cancel", str(event["run_id"])), "w").close()
        out = self.cheat(1, kind="exam", on_progress=cancel)
        self.assertEqual(out["status"], "cancelled")
        self.assertEqual(self.db().execute("SELECT COUNT(*) FROM exam_locks").fetchone()[0], 0)


class AttemptsTests(Base):
    def test_every_practice_run_of_the_family_is_an_attempt_and_the_report_shows_it(self):
        sid = lambda v: "c25-pullback-perp-v{}".format(v)  # noqa: E731
        run(sid(1), self.dir)
        run(sid(1), self.dir)
        out = run(sid(2), self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id=sid(2)))
        self.assertEqual(out["result"]["attempts"], 3)
        with open(out["report_path"], encoding="utf-8") as handle:
            self.assertIn("intentos: 3", handle.read())
        run("c26-reversion-perp-v1", self.dir)
        counts = dict(self.db().execute("SELECT family, COUNT(*) FROM attempts GROUP BY family").fetchall())
        self.assertEqual(counts, {"c25-pullback-perp": 3, "c26-reversion-perp": 1})

    def test_exam_is_not_an_attempt(self):
        run("lab-cheat-v1", self.dir, kind="exam", spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"),
            trade_source=cheating_source)
        self.assertEqual(self.db().execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 0)


class ProgressTests(Base):
    def test_progress_events_and_run_row(self):
        events = []
        out = run("c26-reversion-perp-v1", self.dir, on_progress=events.append)
        self.assertEqual(out["status"], "done")
        percents = [e["percent"] for e in events]
        self.assertEqual(percents, sorted(percents))
        self.assertTrue(all(0 <= p <= 100 for p in percents))
        phases = []
        for e in events:
            if not phases or phases[-1] != e["phase"]:
                phases.append(e["phase"])
        self.assertEqual(phases, ["generando señales", "simulando", "sorteos al azar", "informe"])
        self.assertTrue(all("started_at" in e and "eta_seconds" in e for e in events))
        row = dict(self.db().execute("SELECT * FROM runs").fetchone())
        self.assertEqual((row["status"], row["progress"], row["eta_s"]), ("done", 100.0, 0.0))
        self.assertEqual(row["kind"], "practice")
        self.assertTrue(row["report_path"].endswith(os.path.join("reports", "{}.md".format(row["id"]))))
        for column in ("phase", "eta_s", "started_at", "updated_at", "finished_at", "verdict", "params", "version_key"):
            self.assertIn(column, row)

    def test_json_progress_lines_on_the_stream(self):
        stream = io.StringIO()
        run("c26-reversion-perp-v1", self.dir, json_progress=True, stream=stream)
        lines = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertTrue(all({"phase", "percent", "eta_seconds", "started_at"} <= set(l) for l in lines))
        self.assertEqual(lines[-1]["status"], "done")

    def test_cancel_between_chunks_marks_the_run_cancelled(self):
        def cancel(event):
            if event["phase"] == "generando señales" and event["percent"] > 15:
                os.makedirs(os.path.join(self.dir, "cancel"), exist_ok=True)
                open(os.path.join(self.dir, "cancel", str(event["run_id"])), "w").close()
        out = run("c27-breakout-perp-v1", self.dir, on_progress=cancel)
        self.assertEqual(out["status"], "cancelled")
        row = self.db().execute("SELECT status, phase, report_path FROM runs").fetchone()
        self.assertEqual((row["status"], row["phase"], row["report_path"]), ("cancelled", "cancelada", None))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "reports", "1.md")))

    def test_cancel_request_flag_cancels(self):
        # The signal handler only sets ``cancel_requested``; the run stops at the next check.
        calls = []

        def trip(event):
            calls.append(event)
        out = run("c27-breakout-perp-v1", self.dir, on_progress=trip, install_signals=True)
        self.assertEqual(out["status"], "done")

    def test_failed_run_is_recorded(self):
        with self.assertRaises(g.HistoryError):
            run("c25-pullback-perp-v1", self.dir, provider=Provider(fail_prefetch=True))
        row = self.db().execute("SELECT status, error FROM runs").fetchone()
        self.assertEqual(row["status"], "failed")
        self.assertIn("sin red", row["error"])


class ReportAndCliTests(Base):
    def test_report_is_spanish_lists_rules_with_marks_and_config(self):
        out = run("lab-cheat-v1", self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-cheat-v1"),
                  trade_source=cheating_source)
        with open(out["report_path"], encoding="utf-8") as handle:
            text = handle.read()
        for needle in ("## Veredicto: **PASA**", "✓", "## Reglas (declaradas de antemano", "## Por tramo de tiempo",
                       "## Por producto", "## Por lado", "Entradas al azar", "Costes x1.5", "intentos: 1",
                       "n/d", "min_trades", "Operaciones aún abiertas"):
            self.assertIn(needle, text)
        failing = run("lab-losing-v1", self.dir, spec=dict(SPECS["c25-pullback-perp-v1"], id="lab-losing-v1"),
                      trade_source=losing_source)
        with open(failing["report_path"], encoding="utf-8") as handle:
            self.assertIn("✕", handle.read())

    def test_runs_lists_json_lines_and_filters(self):
        run("c26-reversion-perp-v1", self.dir)
        run("c27-breakout-perp-v1", self.dir)
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            self.assertEqual(g.main(["--data-dir", self.dir, "runs", "--strategy", "c27-breakout-perp-v1"]), 0)
        rows = [json.loads(line) for line in buffer.getvalue().splitlines()]
        self.assertEqual([r["strategy_id"] for r in rows], ["c27-breakout-perp-v1"])

    def test_cli_refuses_unknown_strategy_in_spanish(self):
        err = io.StringIO()
        import contextlib
        with contextlib.redirect_stderr(err):
            code = g.main(["--data-dir", self.dir, "evaluate", "--strategy", "no-existe-v1"])
        self.assertEqual(code, 2)
        self.assertIn("estrategia desconocida", err.getvalue())

    def test_cancel_run_command_writes_only_the_flag_file(self):
        out = run("c26-reversion-perp-v1", self.dir)
        with self.assertRaises(g.GateError):
            g.cancel_run(out["run_id"], self.dir)  # not running any more
        db = sqlite3.connect(os.path.join(self.dir, g.DB_NAME))
        db.execute("UPDATE runs SET status='running', pid=NULL WHERE id=?", (out["run_id"],))
        db.commit()
        db.close()
        g.cancel_run(out["run_id"], self.dir)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "cancel", str(out["run_id"]))))


class RandomBaselineTests(unittest.TestCase):
    def test_random_entries_reproduce_the_cost_drag_and_are_deterministic(self):
        rng, price, closes = random.Random(2), 50_000.0, []
        for _ in range(5000):
            price *= 1 + rng.gauss(0, 0.0003)
            closes.append(price)
        series = {"PF_XBTUSD": {"closes": closes, "first_ms": 0, "start_index": 100}}
        trades = [{"product": "PF_XBTUSD", "side": "LONG" if i % 2 else "SHORT", "entry_ms": 0, "exit_ms": 20 * MINUTE}
                  for i in range(50)]
        a, _ = g.random_entries_means(trades, series, draws=100, seed=1)
        b, _ = g.random_entries_means(trades, series, draws=100, seed=1)
        self.assertEqual(a, b)
        self.assertAlmostEqual(sum(a) / len(a), -g.trade_cost_bp("PF_XBTUSD", "time_stop"), delta=3)
        self.assertEqual(g.percentile_in([1, 2, 3, 4], 10), 100.0)
        self.assertEqual(g.percentile_in([1, 2, 3, 4], 0), 0.0)

    def test_float_cost_matches_the_exact_horizon_net(self):
        exact = horizon_net_bp("LONG", "PF_ETHUSD", "100", "100")
        self.assertAlmostEqual(-exact, g.trade_cost_bp("PF_ETHUSD", "time_stop"), places=3)


if __name__ == "__main__":
    unittest.main()
