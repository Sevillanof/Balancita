import copy
import gzip
import hashlib
import json
import os
import shutil
import stat
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from balancita_engine import futures_strategy_vectorbt_runner as runner
from balancita_engine import spec_variation
from balancita_engine.futures_spec_strategy import load_specs
from balancita_engine.futures_strategy_gate_api import GateApi
from balancita_engine.futures_strategy_registry import StrategyRegistry, make_handler
from balancita_engine.futures_strategy_vectorbt_api import VectorbtApi, simulator_side
from balancita_engine.strategy_gate import open_db

C27 = "c27-breakout-perp-v1"
DAY = 86_400_000
START = 1_760_572_800_000          # 2025-10-16
END = 1_776_556_800_000            # 2026-04-19
DEAD = 424242


def read(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


class FakeChild:
    def __init__(self, pid, code=None):
        self.pid, self.code = pid, code

    def poll(self):
        return self.code


class FakeService:
    def __init__(self, registry, gate, vectorbt):
        self.registry, self.gate, self.vectorbt = registry, gate, vectorbt


def variant_row(value, rank, is_base=False, net=10.0, gross=25.0, funding=1.0, trades=4, status="ok"):
    ok = status == "ok"
    return {"rank": rank, "value": value, "label": "stop_atr = " + value, "is_base": is_base, "trades": trades,
            "entries_per_day": trades / 185, "net_bp_mean": net if ok else None, "gross_bp_mean": gross if ok else None,
            "hit_rate": 0.5 if ok else None, "status": status, "error": None if ok else "boom", "trial_id": rank,
            "funding_bp_mean": funding if ok else None, "funding_complete_share": 1.0 if ok else None,
            "stop_share": 0.5 if ok else None, "signals": {"raw": 10, "skipped_by_cost": 2}}


def make_report(exploration_id, mode="variants", status="ok"):
    report = {"schema": "balancita.vectorbt-exploration.v1", "exploration_id": exploration_id, "mode": mode,
              "status": status, "strategy_id": C27, "family": "c27-breakout-perp", "products": ["PF_XBTUSD"],
              "window": {"from": "2025-10-16T00:00:00Z", "to": "2026-04-19T00:00:00Z"},
              "warning": "Son HIPÓTESIS.", "unsupported": None, "attempts_in_family": 3,
              "diagnostic": {"totals": {"trades": 5, "entries_per_day": 5 / 185, "gross_bp_mean": 20.0,
                                        "net_bp_mean": 5.0, "hit_rate": 0.4, "funding_bp_mean": 0.5,
                                        "funding_complete_share": 1.0},
                             "by_exit": [{"reason": "stop", "share": 0.4}], "signals": {"raw": 12, "skipped_by_cost": 3}},
              "vary": {"kind": "param", "name": "stop_atr", "label": "stop_atr", "base_value": "1.5"},
              "variants": [variant_row("2", 1), variant_row("1.5", 2, True, net=5.0, gross=20.0, funding=0.5, trades=5),
                           variant_row("3", 3, status="error"), variant_row("1", 4, trades=0, status="no_trades")]}
    if status == "unsupported":
        report.update(diagnostic=None, variants=None, unsupported={"reason": "usa 5m.fundpct"})
    return report


class VectorbtApiTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.spawned, self.killed, self.alive_pids, self.next_child = [], [], set(), None
        self.registry = StrategyRegistry(os.path.join(self.dir, "registry.sqlite"))
        self.registry.import_spec(load_specs()[C27])
        self.python = os.path.join(self.dir, "venv", "bin", "python")
        os.makedirs(os.path.dirname(self.python))
        with open(self.python, "w") as handle:
            handle.write("#!/bin/sh\n")
        os.chmod(self.python, stat.S_IRWXU)
        self.now = 1_800_000_000.0
        self.gate = GateApi(self.registry, data_dir=os.path.join(self.dir, "gate"), python="py", wait_s=0.2,
                            spawn=lambda *a: FakeChild(os.getpid()))
        self.api = self.make_api(self.python)
        self.gate.busy_hook = self.api.busy_message
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(FakeService(self.registry, self.gate, self.api)))
        self.server = server
        self.base = "http://127.0.0.1:{}/api-strategies".format(server.server_address[1])
        threading.Thread(target=server.serve_forever, daemon=True).start()

    def make_api(self, python):
        return VectorbtApi(self.registry, self.gate, data_dir=os.path.join(self.dir, "vbt"), python=python,
                           spawn=self.spawn, kill=self.killed.append, alive=lambda pid: pid in self.alive_pids,
                           clock=lambda: self.now, root=self.dir)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.registry.close()
        shutil.rmtree(self.dir)

    def spawn(self, args, env, cwd, log_path):
        self.spawned.append((args, env, cwd, log_path))
        child = self.next_child or FakeChild(4242)
        self.next_child = None
        self.alive_pids.add(child.pid)
        return child

    def call(self, path, body=None, method=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def launch(self, body=None):
        status, out = self.call("/strategies/{}/vectorbt".format(C27), body or {"mode": "diagnostic"}, "POST")
        self.assertEqual(status, 200, out)
        return out["exploration_id"]

    def folder(self, exploration_id):
        return os.path.join(self.dir, "vbt", "explorations", exploration_id)

    def finish(self, exploration_id, report):
        with open(os.path.join(self.folder(exploration_id), "report.json"), "w", encoding="utf-8") as handle:
            json.dump(report, handle)

    def progress(self, exploration_id, **fields):
        body = {"state": "running", "progress": 0, "phase": "Preparando", "detail": "", "error": None,
                "updated_at": 1}
        body.update(fields)
        with open(os.path.join(self.folder(exploration_id), "progress.json"), "w", encoding="utf-8") as handle:
            json.dump(body, handle)

    def done_variants(self):
        exploration_id = self.launch({"mode": "variants", "vary": "stop_atr", "values": [1, 1.5, 2, 3]})
        self.finish(exploration_id, make_report(exploration_id))
        return exploration_id

    # ------------------------------------------------------------------ environment and state

    def test_analyzer_events_route_reads_file_or_says_how_to_make_it(self):
        status, body = self.call("/analyzer/events")
        self.assertEqual(status, 200)
        self.assertFalse(body["available"])
        self.assertIn("research.vectorbt.event_trades", body["command"])
        path = os.path.join(self.api.data_dir, "analyzer", "events.json")
        os.makedirs(os.path.dirname(path))
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"schema": "balancita.analyzer-events.v1", "cells": [], "events": {}}, handle)
        status, body = self.call("/analyzer/events")
        self.assertTrue(body["available"])
        self.assertEqual(body["data"]["events"], {})

    def test_without_environment_it_is_unavailable_and_says_how_to_install(self):
        self.api.python = os.path.join(self.dir, "nada", "python")
        status, body = self.call("/strategies/{}/vectorbt".format(C27))
        self.assertEqual(status, 200)
        self.assertFalse(body["available"])
        self.assertTrue(body["reason"].startswith("Falta instalar el entorno de VectorBT: "))
        self.assertIn("uv pip install", body["reason"])
        self.assertEqual((body["running"], body["explorations"]), (None, []))
        status, error = self.call("/strategies/{}/vectorbt".format(C27), {"mode": "diagnostic"}, "POST")
        self.assertEqual((status, error["error"]), (503, "vectorbt_unavailable"))
        self.assertEqual(self.spawned, [])

    def test_a_venv_without_vectorbt_installed_is_unavailable(self):
        env = os.path.join(self.dir, "venv")
        open(os.path.join(env, "pyvenv.cfg"), "w").close()
        self.assertFalse(self.api.availability()[0])
        os.makedirs(os.path.join(env, "lib", "python3.12", "site-packages", "vectorbt"))
        self.assertEqual(self.api.availability(), (True, None))

    def test_state_of_an_unknown_strategy_is_404(self):
        self.assertEqual(self.call("/strategies/nada/vectorbt")[0], 404)

    # ------------------------------------------------------------------ launch

    def test_launch_validations(self):
        url = "/strategies/{}/vectorbt".format(C27)
        bad = [({}, "invalid_mode"), ({"mode": "x"}, "invalid_mode"),
               ({"mode": "diagnostic", "values": [1]}, "invalid_body"), ({"mode": "variants"}, "invalid_vary"),
               ({"mode": "variants", "vary": "stop_atr"}, "invalid_values"),
               ({"mode": "variants", "vary": "stop_atr", "values": list(range(13))}, "invalid_values"),
               ({"mode": "variants", "vary": "stop_atr", "values": ["abc"]}, "invalid_values"),
               ({"mode": "variants", "vary": "stop_atr", "values": [True]}, "invalid_values"),
               ({"mode": "variants", "vary": "no_existe", "values": [1]}, "invalid_vary"),
               ({"mode": "variants", "vary": "rules.nada[0]", "values": [1]}, "invalid_vary"),
               ({"mode": "diagnostic", "extra": 1}, "invalid_body")]
        for body, code in bad:
            status, out = self.call(url, body, "POST")
            self.assertEqual((status, out["error"]), (400, code), body)
        self.assertEqual(self.call("/strategies/nada/vectorbt", {"mode": "diagnostic"}, "POST")[0], 404)
        self.assertEqual(self.spawned, [])
        # twelve values are fine; thirteen distinct are not (equal values count once).
        self.assertEqual(self.call(url, {"mode": "variants", "vary": "stop_atr",
                                         "values": [1, "1.0", 2] + list(range(3, 12))}, "POST")[0], 200)

    def test_only_rules_strategies_can_be_explored(self):
        spec = copy.deepcopy(load_specs()[C27])
        spec["kind"] = "model"
        original = self.registry.version
        self.registry.version = lambda *a, **k: dict(original(*a, **k), spec=spec)
        try:
            status, out = self.call("/strategies/{}/vectorbt".format(C27), {"mode": "diagnostic"}, "POST")
        finally:
            self.registry.version = original
        self.assertEqual((status, out["error"]), (422, "unsupported_kind"))

    def test_launch_saves_the_spec_and_spawns_the_runner_detached(self):
        exploration_id = self.launch({"mode": "variants", "vary": "stop_atr", "values": ["1", "2.50", 2.5]})
        args, env, cwd, log = self.spawned[0]
        self.assertEqual(args, [self.python, "-m", "balancita_engine.futures_strategy_vectorbt_runner", "--job-dir",
                                self.folder(exploration_id)])
        self.assertEqual(cwd, self.dir)
        self.assertIn(os.path.join(self.dir, "python"), env["PYTHONPATH"].split(os.pathsep))
        job = read(os.path.join(self.folder(exploration_id), "job.json"))
        self.assertEqual((job["pid"], job["mode"], job["vary"], job["values"], job["status"]),
                         (4242, "variants", "stop_atr", ["1", "2.5"], "running"))
        spec = read(os.path.join(self.folder(exploration_id), "spec.json"))
        self.assertEqual(spec["id"], C27)
        self.assertEqual(job["paths"]["datasets"], os.path.join(self.dir, "vbt", "practice"))
        self.assertEqual(self.call("/strategies/{}/vectorbt".format(C27))[1]["running"]["id"], exploration_id)

    def test_only_one_exploration_at_a_time(self):
        first = self.launch()
        status, out = self.call("/strategies/{}/vectorbt".format(C27), {"mode": "diagnostic"}, "POST")
        self.assertEqual((status, out["error"]), (409, "busy"))
        self.assertIn("exploración de VectorBT en curso", out["detail"])
        self.assertEqual(len(self.spawned), 1)
        self.alive_pids.clear()          # the runner died: the slot is free again
        second = self.launch()
        self.assertNotEqual(first, second)

    def test_it_does_not_run_while_the_gate_runs_and_the_gate_does_not_start_while_it_runs(self):
        db = open_db(os.path.join(self.dir, "gate", "gate.sqlite"))
        db.execute("INSERT INTO runs(strategy_id,family,version_key,code_hash,params,kind,status,started_at,updated_at,pid)"
                   " VALUES('c27-breakout-perp-v1','c27-breakout-perp','k','h','{}','practice','running',1,1,?)",
                   (os.getpid(),))
        db.commit()
        db.close()
        status, out = self.call("/strategies/{}/vectorbt".format(C27), {"mode": "diagnostic"}, "POST")
        self.assertEqual((status, out["error"]), (409, "busy"))
        self.assertIn("compuerta", out["detail"])
        self.assertEqual(self.spawned, [])
        db = open_db(os.path.join(self.dir, "gate", "gate.sqlite"))
        db.execute("UPDATE runs SET status='done'")
        db.commit()
        db.close()
        self.launch()
        status, out = self.call("/strategies/{}/gate".format(C27), {}, "POST")
        self.assertEqual((status, out["error"]), (409, "busy"))
        self.assertIn("VectorBT", out["detail"])

    def test_a_runner_that_dies_at_once_is_reported(self):
        self.next_child = FakeChild(777, code=1)
        status, out = self.call("/strategies/{}/vectorbt".format(C27), {"mode": "diagnostic"}, "POST")
        self.assertEqual((status, out["error"]), (422, "vectorbt_failed"))

    # ------------------------------------------------------------------ progress

    def test_progress_eta_and_dead_process(self):
        exploration_id = self.launch()
        self.progress(exploration_id, progress=25.0, phase="Descargando datos",
                      detail="Descargando velas de Kraken (ETH 2/3)")
        self.now += 100
        item = self.call("/strategies/{}/vectorbt".format(C27))[1]["explorations"][0]
        self.assertEqual((item["status"], item["progress"], item["phase"], item["detail"]),
                         ("running", 25.0, "Descargando datos", "Descargando velas de Kraken (ETH 2/3)"))
        self.assertEqual((item["eta"], item["mode"], item["finished_at"]), (300, "diagnostic", None))
        self.assertIsNone(item["report"])
        self.alive_pids.clear()
        item = self.call("/strategies/{}/vectorbt".format(C27))[1]["explorations"][0]
        self.assertEqual((item["status"], item["detail"]), ("failed", "El proceso terminó sin cerrar la exploración."))

    def test_a_failure_reported_by_the_runner_shows_its_reason(self):
        exploration_id = self.launch()
        self.progress(exploration_id, state="failed", phase="Error", error="falta el dataset de práctica de PF_XBTUSD")
        item = self.call("/strategies/{}/vectorbt".format(C27))[1]["explorations"][0]
        self.assertEqual((item["status"], item["detail"]), ("failed", "falta el dataset de práctica de PF_XBTUSD"))
        self.assertIsNone(self.call("/strategies/{}/vectorbt".format(C27))[1]["running"])

    def test_a_report_means_done_with_the_full_report_newest_first(self):
        first = self.launch()
        self.finish(first, make_report(first, "diagnostic"))
        self.now += 60
        second = self.launch({"mode": "variants", "vary": "stop_atr", "values": [2]})
        self.finish(second, make_report(second, status="unsupported"))
        body = self.call("/strategies/{}/vectorbt".format(C27))[1]
        self.assertEqual([e["id"] for e in body["explorations"]], [second, first])
        self.assertEqual([e["status"] for e in body["explorations"]], ["unsupported", "done"])
        done = body["explorations"][1]
        self.assertEqual((done["progress"], done["phase"], done["report"]["mode"]), (100.0, "Listo", "diagnostic"))
        self.assertEqual(body["explorations"][0]["detail"], "usa 5m.fundpct")
        self.assertIsNone(body["running"])
        self.assertEqual(body["attempts_in_family"], 0)      # no ledger yet

    # ------------------------------------------------------------------ cancel

    def test_cancel_kills_the_group_and_frees_the_slot(self):
        exploration_id = self.launch()
        status, out = self.call("/strategies/{}/vectorbt/{}/cancel".format(C27, exploration_id), {}, "POST")
        self.assertEqual((status, out["cancel_requested"]), (200, True))
        self.assertEqual(self.killed, [4242])
        item = self.call("/strategies/{}/vectorbt".format(C27))[1]["explorations"][0]
        self.assertEqual((item["status"], item["phase"]), ("cancelled", "Cancelada"))
        self.assertEqual(self.call("/strategies/{}/vectorbt/{}/cancel".format(C27, exploration_id), {}, "POST")[0], 409)
        self.alive_pids.clear()
        self.launch()
        self.assertEqual(self.call("/strategies/{}/vectorbt/nada/cancel".format(C27), {}, "POST")[0], 404)
        self.assertEqual(self.call("/strategies/otra/vectorbt/{}/cancel".format(exploration_id), {}, "POST")[0], 404)

    def test_a_finished_exploration_cannot_be_cancelled(self):
        exploration_id = self.launch()
        self.finish(exploration_id, make_report(exploration_id, "diagnostic"))
        status, out = self.call("/strategies/{}/vectorbt/{}/cancel".format(C27, exploration_id), {}, "POST")
        self.assertEqual((status, out["error"]), (409, "not_running"))
        self.assertEqual(self.killed, [])

    # ------------------------------------------------------------------ confirm

    def strategies(self):
        return {r[0]: r[1] for r in self.registry.db.execute("SELECT strategy_id, spec_hash FROM strategy_versions")}

    def test_confirm_creates_a_draft_variant_of_the_same_lineage_and_touches_nothing_else(self):
        exploration_id = self.done_variants()
        before = self.strategies()
        events = self.registry.db.execute("SELECT COUNT(*) FROM strategy_events").fetchone()[0]
        url = "/strategies/{}/vectorbt/{}/confirm".format(C27, exploration_id)
        status, out = self.call(url, {"value": "2"}, "POST")
        self.assertEqual(status, 200, out)
        self.assertEqual((out["strategy_id"], out["state"], out["already"]), ("c27-breakout-perp-v2", "draft", False))
        self.assertEqual(out["title"], "C27 Ruptura Donchian · stop_atr=2")
        after = self.strategies()
        self.assertEqual({k: v for k, v in after.items() if k in before}, before)
        self.assertEqual(set(after) - set(before), {"c27-breakout-perp-v2"})
        self.assertEqual(self.registry.db.execute("SELECT COUNT(*) FROM strategy_events").fetchone()[0], events + 1)
        entry = self.registry.detail("c27-breakout-perp-v2")
        self.assertEqual((entry["state"], entry["parent"], entry["origin"]), ("draft", {"id": C27, "version": 1},
                                                                             "vectorbt"))
        spec = self.registry.version("c27-breakout-perp-v2")["spec"]
        original = load_specs()[C27]
        self.assertEqual(spec["params"]["stop_atr"], "2")
        self.assertEqual({k: v for k, v in spec["params"].items() if k != "stop_atr"},
                         {k: v for k, v in original["params"].items() if k != "stop_atr"})
        self.assertEqual(spec["rules"], original["rules"])
        # The same value again gives the same strategy; another value gets the next -vN of the family.
        again = self.call(url, {"value": 2}, "POST")[1]
        self.assertEqual((again["strategy_id"], again["already"]), ("c27-breakout-perp-v2", True))
        self.assertEqual(self.strategies().keys(), after.keys())
        job = read(os.path.join(self.folder(exploration_id), "job.json"))
        self.assertEqual(job["confirmations"]["2"]["strategy_id"], "c27-breakout-perp-v2")
        self.assertEqual(self.call("/strategies/{}/vectorbt".format(C27))[1]["explorations"][0]["confirmed"],
                         {"2": "c27-breakout-perp-v2"})

    def test_confirm_refusals(self):
        exploration_id = self.launch({"mode": "variants", "vary": "stop_atr", "values": [2]})
        url = "/strategies/{}/vectorbt/{}/confirm".format(C27, exploration_id)
        self.assertEqual(self.call(url, {"value": "2"}, "POST")[1]["error"], "not_ready")     # still running
        self.finish(exploration_id, make_report(exploration_id))
        for body, code in (({}, "invalid_value"), ({"value": "abc"}, "invalid_value"), ({"value": "7"}, "unknown_value"),
                           ({"value": "1.5"}, "is_base"), ({"value": "3"}, "variant_failed")):
            status, out = self.call(url, body, "POST")
            self.assertEqual((status >= 400, out["error"]), (True, code), body)
        self.assertEqual(set(self.strategies()), {C27})
        self.assertEqual(self.call("/strategies/{}/vectorbt/nada/confirm".format(C27), {"value": 2}, "POST")[0], 404)

    def test_confirm_uses_the_spec_that_was_explored_and_a_deleted_variant_can_be_made_again(self):
        exploration_id = self.done_variants()
        url = "/strategies/{}/vectorbt/{}/confirm".format(C27, exploration_id)
        first = self.call(url, {"value": "2"}, "POST")[1]["strategy_id"]
        with self.registry.lock, self.registry.db:
            self.registry.db.execute("INSERT INTO strategy_events(strategy_id, version, state, reason, known_at) "
                                     "VALUES(?,1,'deleted','test',1)", (first,))
        second = self.call(url, {"value": "2"}, "POST")
        self.assertEqual(second[0], 200, second)
        self.assertEqual(second[1]["strategy_id"], "c27-breakout-perp-v3")

    # ------------------------------------------------------------------ compare

    def store_run(self, strategy_id, run_id=1, kind="practice", trades=None, status="done", products=("PF_XBTUSD",),
                  start=START, end=END):
        trades = trades if trades is not None else self.sim_trades()
        body = b"".join((json.dumps(t, sort_keys=True) + "\n").encode() for t in trades)
        folder = os.path.join(self.dir, "gate", "artifacts", str(run_id))
        os.makedirs(folder)
        with open(os.path.join(folder, "trades.jsonl.gz"), "wb") as handle:
            handle.write(gzip.compress(body, mtime=0))
        manifest = {"schema": "balancita.gate-run-artifact.v1", "run_id": run_id, "strategy_id": strategy_id,
                    "kind": kind, "status": "complete", "products": list(products), "range_start_ms": start,
                    "range_end_ms_exclusive": end, "trades_file": "trades.jsonl.gz",
                    "trades_sha256": hashlib.sha256(body).hexdigest()}
        with open(os.path.join(folder, "manifest.json"), "w") as handle:
            json.dump(manifest, handle)
        db = open_db(os.path.join(self.dir, "gate", "gate.sqlite"))
        db.execute("INSERT INTO runs(id,strategy_id,family,version_key,code_hash,params,kind,status,started_at,updated_at,"
                   "pid) VALUES(?,?,?,?,?,?,?,?,1,1,0)", (run_id, strategy_id, "c27-breakout-perp", "k", "h", "{}",
                                                          kind, status))
        db.commit()
        db.close()

    @staticmethod
    def sim_trades():
        def trade(net, reason, funding_usd, status="complete"):
            return {"product_id": "PF_XBTUSD", "side": "LONG", "net_bp": net, "exit_reason": reason,
                    "funding_usd": funding_usd, "funding_status": status, "notional_usd": "100"}
        return [trade(20.0, "target", 0.01), trade(-30.0, "stop", 0.02), trade(40.0, "target", None, "unknown"),
                trade(-10.0, "time", 0.0)]

    def test_compare_puts_both_sides_with_real_numbers(self):
        exploration_id = self.done_variants()
        url = "/strategies/{}/vectorbt/{}/compare?value=2&run_id=1".format(C27, exploration_id)
        status, out = self.call(url)
        self.assertEqual((status, out["error"]), (409, "not_confirmed"))
        variant = self.call("/strategies/{}/vectorbt/{}/confirm".format(C27, exploration_id), {"value": "2"}, "POST")[1]
        self.assertEqual(self.call(url)[1]["error"], "run_not_found")
        self.store_run(variant["strategy_id"])
        status, out = self.call(url)
        self.assertEqual(status, 200, out)
        vbt, sim, diff = out["vectorbt"], out["simulator"], out["difference"]
        self.assertEqual((vbt["trades"], vbt["net_bp_mean"], vbt["gross_bp_mean"], vbt["funding_bp_mean"]),
                         (4, 10.0, 25.0, 1.0))
        self.assertAlmostEqual(vbt["cost_bp_mean"], 14.0)
        self.assertEqual(vbt["skipped_by_cost"], 2)
        self.assertEqual((sim["trades"], sim["net_bp_mean"], sim["hit_rate"], sim["stop_share"]), (4, 5.0, 0.5, 0.25))
        self.assertAlmostEqual(sim["entries_per_day"], 4 / ((END - START) / DAY))
        self.assertAlmostEqual(sim["funding_bp_mean"], (1.0 + 2.0 + 0.0) / 3)      # unknown funding is not zero
        self.assertAlmostEqual(sim["funding_complete_share"], 0.75)
        # net = gross - costs - funding holds on both sides, so the differences add up exactly.
        for side in (vbt, sim):
            self.assertAlmostEqual(side["net_bp_mean"], side["gross_bp_mean"] - side["cost_bp_mean"]
                                   - (side["funding_bp_mean"] if side is vbt else
                                      sum(f or 0.0 for f in (1.0, 2.0, None, 0.0)) / 4), places=6)
        self.assertAlmostEqual(diff["net_bp_mean"], 5.0)
        self.assertEqual((out["run_id"], out["strategy_id"], out["value"]), (1, variant["strategy_id"], "2"))
        text = " ".join(out["explanation"])
        self.assertIn("VectorBT da +10 pb netos por operación y el simulador +5,0 pb: VectorBT queda 5,0 pb por encima",
                      text)
        self.assertIn("De 10 entradas que detecta la estrategia, 2 (20 %) se descartan por costo mínimo", text)
        self.assertIn("Funding real", text)
        self.assertIn("el movimiento del precio aporta", text)
        self.assertIn("no puedo separarla más", text)

    def test_compare_of_the_base_value_uses_the_original_strategy_and_run_defaults_to_the_latest(self):
        exploration_id = self.done_variants()
        self.store_run(C27, run_id=3)
        out = self.call("/strategies/{}/vectorbt/{}/compare?value=1.5".format(C27, exploration_id))[1]
        self.assertEqual((out["run_id"], out["is_base"], out["strategy_id"]), (3, True, C27))
        self.assertEqual(out["vectorbt"]["trades"], 5)       # the diagnostic's figures
        self.assertEqual(out["vectorbt"]["skipped_by_cost"], 3)
        self.assertEqual(out["vectorbt"]["stop_share"], 0.4)

    def test_compare_refuses_other_strategies_exams_and_unfinished_runs(self):
        exploration_id = self.done_variants()
        variant = self.call("/strategies/{}/vectorbt/{}/confirm".format(C27, exploration_id), {"value": "2"}, "POST")[1]
        base = "/strategies/{}/vectorbt/{}/compare?value=2&run_id=".format(C27, exploration_id)
        self.store_run(C27, run_id=1)
        self.assertEqual(self.call(base + "1")[1]["error"], "invalid_run")                   # the original's run
        self.store_run(variant["strategy_id"], run_id=2, kind="exam")
        self.assertEqual(self.call(base + "2")[1]["error"], "invalid_run")
        self.store_run(variant["strategy_id"], run_id=4, status="running")
        self.assertEqual(self.call(base + "4")[1]["error"], "artifact_not_ready")
        self.assertEqual(self.call(base + "99")[1]["error"], "run_not_found")
        self.assertEqual(self.call(base.replace("value=2", "value=7") + "1")[1]["error"], "unknown_value")
        self.assertEqual(self.call(base.replace("value=2", "value=3") + "1")[1]["error"], "unknown_value")  # it failed

    def test_compare_says_when_it_cannot_attribute_and_when_windows_differ(self):
        exploration_id = self.done_variants()
        variant = self.call("/strategies/{}/vectorbt/{}/confirm".format(C27, exploration_id), {"value": "2"}, "POST")[1]
        many = [dict(t) for t in self.sim_trades()] * 5
        self.store_run(variant["strategy_id"], trades=many, end=END - 30 * DAY)
        out = self.call("/strategies/{}/vectorbt/{}/compare?value=2&run_id=1".format(C27, exploration_id))[1]
        text = " ".join(out["explanation"])
        self.assertIn("Las ventanas no coinciden", text)
        self.assertIn("No puedo atribuirla con estos datos", text)
        self.assertEqual(out["window"]["simulator"]["to"], "2026-03-20")

    def test_compare_with_an_old_report_without_the_extra_figures_does_not_invent_them(self):
        exploration_id = self.launch({"mode": "variants", "vary": "stop_atr", "values": [2]})
        report = make_report(exploration_id)
        for key in ("funding_bp_mean", "funding_complete_share", "stop_share", "signals"):
            del report["variants"][0][key]
        self.finish(exploration_id, report)
        variant = self.call("/strategies/{}/vectorbt/{}/confirm".format(C27, exploration_id), {"value": "2"}, "POST")[1]
        self.store_run(variant["strategy_id"])
        out = self.call("/strategies/{}/vectorbt/{}/compare?value=2&run_id=1".format(C27, exploration_id))[1]
        self.assertIsNone(out["vectorbt"]["funding_bp_mean"])
        self.assertIsNone(out["vectorbt"]["cost_bp_mean"])
        self.assertIn("le faltan datos", " ".join(out["explanation"]))

    def test_simulator_side_with_no_trades(self):
        side = simulator_side([], ["PF_XBTUSD"], (START, END))
        self.assertEqual((side["trades"], side["net_bp_mean"], side["hit_rate"]), (0, None, None))


class SpecVariationTests(unittest.TestCase):
    def test_param_and_condition_variations_do_not_touch_the_input(self):
        spec = load_specs()[C27]
        before = copy.deepcopy(spec)
        variation = spec_variation.describe_variation(spec, "stop_atr")
        self.assertEqual((variation["kind"], variation["base_value"]), ("param", "1.5"))
        changed = spec_variation.apply_value(spec, variation, "2")
        self.assertEqual((changed["params"]["stop_atr"], spec), ("2", before))
        with self.assertRaises(spec_variation.VariationError):
            spec_variation.describe_variation(spec, "no_existe")
        with self.assertRaises(spec_variation.VariationError):
            spec_variation.check_values(list(range(13)))
        self.assertEqual(spec_variation.check_values(["1", "1.0", 2]), ["1", "2"])


class RunnerTests(unittest.TestCase):
    class Child:
        def __init__(self, lines="", code=0):
            self.stdout, self.returncode, self.text = iter(lines.splitlines(True)), code, lines

        def communicate(self):
            return self.text, None

        def wait(self):
            return self.returncode

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.gate_config = os.path.join(self.dir, "gate.json")
        with open(self.gate_config, "w") as handle:
            json.dump({"default_products": ["PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"]}, handle)
        self.job = {"exploration_id": "e1", "strategy_id": C27, "mode": "variants", "vary": "stop_atr",
                    "values": ["1", "2"], "products": None, "root": self.dir, "gate_config": self.gate_config,
                    "paths": {"explorations": os.path.join(self.dir, "x"), "datasets": os.path.join(self.dir, "d"),
                              "cache": os.path.join(self.dir, "c"), "ledger": os.path.join(self.dir, "l.sqlite")}}
        with open(os.path.join(self.dir, "job.json"), "w") as handle:
            json.dump(self.job, handle)
        os.makedirs(os.path.join(self.dir, "d", "PF_XBTUSD"))
        open(os.path.join(self.dir, "d", "PF_XBTUSD", "manifest.json"), "w").close()
        self.calls, self.seen = [], []

    def tearDown(self):
        shutil.rmtree(self.dir)

    def popen(self, args, **kwargs):
        self.calls.append(args)
        with open(os.path.join(self.dir, "progress.json")) as handle:
            self.seen.append(json.load(handle))
        if "research.vectorbt.explore" in args:
            return self.Child('{"progress": 50, "phase": "Probando variantes", "detail": "stop_atr = 2"}\n'
                              'ruido\n{"progress": 100, "phase": "Listo", "detail": "x"}\n')
        return self.Child("ok")

    def test_downloads_only_the_missing_datasets_then_explores_with_the_scaled_bar(self):
        code = runner.run(self.dir, python="py", popen=self.popen)
        self.assertEqual(code, 0)
        exports = [c for c in self.calls if "research.vectorbt.export_practice" in c]
        self.assertEqual([c[c.index("--product") + 1] for c in exports], ["PF_ETHUSD", "PF_SOLUSD"])
        self.assertTrue(all("--fetch" in c for c in exports))
        self.assertEqual(self.seen[0]["detail"], "Descargando velas de Kraken (ETH 1/2)")
        self.assertEqual(self.seen[1]["detail"], "Descargando velas de Kraken (SOL 2/2)")
        explore = self.calls[-1]
        self.assertEqual(explore[explore.index("--vary") + 1], "stop_atr")
        self.assertEqual(explore[explore.index("--values") + 1], "1,2")
        final = read(os.path.join(self.dir, "progress.json"))
        self.assertEqual((final["state"], final["progress"], final["phase"]), ("done", 100.0, "Listo"))

    def test_progress_never_goes_down_and_is_scaled_after_downloading(self):
        for name in ("PF_ETHUSD", "PF_SOLUSD"):
            os.makedirs(os.path.join(self.dir, "d", name))
            open(os.path.join(self.dir, "d", name, "manifest.json"), "w").close()
        values = []
        original = runner.Reporter.write

        def spy(reporter, percent, *args, **kwargs):
            original(reporter, percent, *args, **kwargs)
            values.append(reporter.last)
        runner.Reporter.write = spy
        try:
            runner.run(self.dir, python="py", popen=self.popen)
        finally:
            runner.Reporter.write = original
        self.assertEqual(values, sorted(values))
        self.assertIn(50.0, values)       # nothing was downloaded: the lab's 50 % is 50 %
        self.assertFalse([c for c in self.calls if "research.vectorbt.export_practice" in c])

    def test_a_failed_download_or_a_refused_exploration_is_reported(self):
        def failing(args, **kwargs):
            return self.Child("ERROR: sin red\n", code=2) if "research.vectorbt.export_practice" in args else \
                self.Child('{"progress": 0, "phase": "Error", "detail": "más de 12 valores"}\n', code=2)
        self.assertEqual(runner.run(self.dir, python="py", popen=failing), 2)
        failed = read(os.path.join(self.dir, "progress.json"))
        self.assertEqual(failed["state"], "failed")
        self.assertIn("No se pudieron descargar las velas de ETH", failed["error"])
        for name in ("PF_ETHUSD", "PF_SOLUSD"):
            os.makedirs(os.path.join(self.dir, "d", name))
            open(os.path.join(self.dir, "d", name, "manifest.json"), "w").close()
        self.assertEqual(runner.run(self.dir, python="py", popen=failing), 2)
        self.assertEqual(read(os.path.join(self.dir, "progress.json"))["error"], "más de 12 valores")


if __name__ == "__main__":
    unittest.main()
