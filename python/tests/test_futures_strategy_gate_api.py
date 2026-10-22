import gzip
import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from balancita_engine import futures_strategy_gate_api as gate_api
from balancita_engine.futures_strategy_gate_api import GateApi
from balancita_engine.futures_strategy_registry import make_handler
from balancita_engine import strategy_gate
from balancita_engine.futures_history import MINUTE_MS as MINUTE, CandleCache
from balancita_engine.strategy_gate import open_db

SPEC = {"id": "c29-test-v1", "name": "x"}


class FakeRegistry:
    def _version_row(self, strategy_id, version):
        return {"strategy_id": strategy_id, "spec": SPEC} if strategy_id == "c29-test-v1" else None

    def _deleted(self, strategy_id):
        return False

    def version(self, strategy_id, version=None):
        return self._version_row(strategy_id, version)


class FakeService:
    def __init__(self, gate):
        self.gate = gate
        self.registry = FakeRegistry()


class FakeChild:
    def __init__(self, pid, code=None):
        self.pid, self.code = pid, code

    def poll(self):
        return self.code


class GateApiTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.spawned = []
        self.next_child = None
        self.gate = GateApi(FakeRegistry(), data_dir=self.dir, python="py", spawn=self.spawn, wait_s=0.3,
                            products=["PF_XBTUSD", "PF_ETHUSD"])
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(FakeService(self.gate)))
        self.server = server
        self.base = "http://127.0.0.1:{}/api-strategies".format(server.server_address[1])
        threading.Thread(target=server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.dir)

    def spawn(self, args, env, cwd, log_path):
        self.spawned.append((args, env, cwd, log_path))
        if self.next_child and self.next_child.code not in (None, 0):
            os.makedirs(os.path.dirname(log_path), exist_ok=True)
            with open(log_path, "w") as handle:
                handle.write("traza\nEl examen final de esta versión ya se rindió el 2026-10-01: PASA.\n")
        return self.next_child or FakeChild(os.getpid())

    def call(self, path, body=None, method=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def json(self, path, body=None, method=None):
        status, _, raw = self.call(path, body, method)
        return status, json.loads(raw)

    def insert(self, **fields):
        row = {"strategy_id": "c29-test-v1", "family": "c29-test", "version_key": "k", "code_hash": "h", "params": "{}",
               "kind": "practice", "status": "done", "started_at": 1_760_000_000_000, "updated_at": 1, "pid": 0}
        row.update(fields)
        db = open_db(os.path.join(self.dir, "gate.sqlite"))
        db.execute("INSERT INTO runs(%s) VALUES (%s)" % (",".join(row), ",".join("?" * len(row))), list(row.values()))
        db.commit()
        db.close()

    # --------------------------------------------------------------- reads

    def test_no_database_means_empty_lists(self):
        status, body = self.json("/strategies/c29-test-v1/gate/runs")
        self.assertEqual(status, 200)
        self.assertEqual(body["runs"], [])
        self.assertEqual(body["exam"], {"taken": False})
        self.assertIsNone(body["running"])
        self.assertEqual(self.json("/gate/runs/3")[0], 404)

    def test_runs_include_progress_and_exam_lock(self):
        self.insert(status="running", progress=42.5, phase="simulando", eta_s=120, pid=os.getpid())
        self.insert(kind="exam", verdict="NO PASA", attempts=3)
        db = open_db(os.path.join(self.dir, "gate.sqlite"))
        db.execute("INSERT INTO exam_locks VALUES('c29-test-v1','k','h','2026-04-19',2,1760000000000,'done','NO PASA')")
        db.commit()
        db.close()
        status, body = self.json("/strategies/c29-test-v1/gate/runs")
        self.assertEqual(status, 200)
        self.assertEqual([r["id"] for r in body["runs"]], [2, 1])
        self.assertEqual(body["runs"][1]["progress"], 42.5)
        self.assertEqual(body["runs"][0]["attempts"], 3)
        self.assertEqual(body["running"], {"id": 1, "strategy_id": "c29-test-v1"})
        self.assertTrue(body["exam"]["taken"])
        self.assertEqual(body["exam"]["verdict"], "NO PASA")
        self.assertEqual(body["exam"]["date"], "2025-10-09")
        self.assertNotIn("pid", body["runs"][0])
        self.assertEqual(self.json("/gate/runs/1")[1]["run"]["phase"], "simulando")

    def test_dead_process_is_not_reported_as_running(self):
        self.insert(status="running", pid=2_000_000_000)
        self.assertEqual(self.json("/gate/runs/1")[1]["run"]["status"], "failed")
        self.assertIsNone(self.json("/strategies/c29-test-v1/gate/runs")[1]["running"])

    def test_gate_db_is_opened_read_only(self):
        self.insert()
        db = self.gate._connect()
        with self.assertRaises(Exception):
            db.execute("DELETE FROM runs")
        db.close()
        self.assertEqual(self.json("/gate/runs/abc")[0], 404)

    # --------------------------------------------------------------- launch

    def test_launch_validates_and_spawns_without_shell(self):
        for bad in ({"from": "2025-13-01"}, {"from": "ayer"}, {"products": []}, {"products": ["PF_NOPE"]},
                    {"products": ["PF_XBTUSD", "PF_XBTUSD"]}, {"exam": "si"}, {"exam": True, "from": "2025-01-01"},
                    {"extra": 1}, {"products": "PF_XBTUSD"}, {"to": "ayer"}, {"to": "2025-13-01"},
                    {"exam": True, "to": "2025-06-01"}):
            self.assertEqual(self.json("/strategies/c29-test-v1/gate", bad)[0], 400, bad)
        self.assertEqual(self.json("/strategies/otra/gate", {})[0], 404)
        self.assertEqual(self.json("/strategies/..%2Fx;rm/gate", {})[0], 404)
        self.assertEqual(self.spawned, [])
        self.next_child = FakeChild(os.getpid())
        status, body = self.json("/strategies/c29-test-v1/gate",
                                 {"from": "2025-02-01", "to": "2025-05-01", "products": ["PF_ETHUSD"]})
        self.assertEqual((status, body["pending"], body["run_id"]), (200, True, None))
        args, env, cwd, _ = self.spawned[0]
        self.assertEqual(args[:3], ["py", "-m", "balancita_engine.strategy_gate"])
        self.assertEqual(args[args.index("--strategy") + 1], "c29-test-v1")
        self.assertEqual(args[args.index("--from") + 1], "2025-02-01")
        self.assertEqual(args[args.index("--to") + 1], "2025-05-01")
        self.assertEqual(args[args.index("--products") + 1], "PF_ETHUSD")
        self.assertNotIn("--exam", args)
        self.assertIn("python", env["PYTHONPATH"])

    def test_launch_hands_the_registry_db_to_the_gate_so_registry_only_ids_work(self):
        registry = FakeRegistry()
        registry.path = "/tmp/some/futures-strategies.sqlite"
        gate = GateApi(registry, data_dir=self.dir, python="py", spawn=self.spawn, wait_s=0.3, products=["PF_XBTUSD"])
        gate.launch("c29-test-v1", {})
        args = self.spawned[-1][0]
        self.assertEqual(args[args.index("--registry-db") + 1], "/tmp/some/futures-strategies.sqlite")

    def test_launch_returns_the_run_id_when_the_child_registers(self):
        self.insert(status="running", pid=424242)  # someone else's row must not be mistaken for ours
        self.insert(status="done", pid=0)
        child = FakeChild(os.getpid())
        self.next_child = child
        self.insert(status="running", pid=child.pid, strategy_id="c29-test-v1", id=9)
        self.gate._running = lambda: None  # the pre-check passes; the row above is what the child "wrote"
        status, body = self.json("/strategies/c29-test-v1/gate", {"exam": True})
        self.assertEqual((status, body["run_id"], body["pending"]), (200, 9, False))
        self.assertIn("--exam", self.spawned[0][0])

    def test_one_run_at_a_time(self):
        self.insert(status="running", pid=os.getpid())
        status, body = self.json("/strategies/c29-test-v1/gate", {})
        self.assertEqual(status, 409)
        self.assertIn("Ya hay una prueba en curso", body["detail"])
        self.assertEqual(self.spawned, [])

    def test_gate_refusal_is_surfaced_in_spanish(self):
        self.next_child = FakeChild(os.getpid(), code=2)
        status, body = self.json("/strategies/c29-test-v1/gate", {"exam": True})
        self.assertEqual(status, 422)
        self.assertIn("ya se rindió el 2026-10-01", body["detail"])

    # --------------------------------------------------------------- cancel

    def test_cancel_writes_the_flag_and_refuses_finished_runs(self):
        self.insert(status="running", pid=2_000_000_000)
        self.insert(status="done")
        status, body = self.json("/gate/runs/1/cancel", {})
        self.assertEqual((status, body["cancel_requested"]), (200, True))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "cancel", "1")))
        self.assertEqual(self.json("/gate/runs/2/cancel", {})[0], 409)
        self.assertEqual(self.json("/gate/runs/99/cancel", {})[0], 404)

    # --------------------------------------------------------------- report

    def test_report_download_and_traversal(self):
        os.makedirs(os.path.join(self.dir, "reports"))
        good = os.path.join(self.dir, "reports", "1.md")
        with open(good, "w", encoding="utf-8") as handle:
            handle.write("# Informe\nñ\n")
        secret = os.path.join(self.dir, "secret.md")
        with open(secret, "w") as handle:
            handle.write("no")
        self.insert(report_path=good, finished_at=1_760_000_000_000)
        self.insert(report_path=os.path.join(self.dir, "reports", "..", "secret.md"))
        self.insert(report_path=secret)
        self.insert()
        status, headers, raw = self.call("/gate/runs/1/report.md")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/markdown; charset=utf-8")
        self.assertEqual(headers["Content-Disposition"], 'attachment; filename="c29-test-v1-practice-2025-10-09-1.md"')
        self.assertEqual(raw.decode(), "# Informe\nñ\n")
        for run in (2, 3, 4, 77):
            self.assertEqual(self.call("/gate/runs/%d/report.md" % run)[0], 404)


class VisualApiTests(unittest.TestCase):
    """Stored trades and candles of a finished run, read-only, with the exam kept shut until it was taken."""

    setUp, tearDown, spawn, call, json, insert = (GateApiTests.setUp, GateApiTests.tearDown, GateApiTests.spawn,
                                                  GateApiTests.call, GateApiTests.json, GateApiTests.insert)
    START = 1_760_000_000_000 // MINUTE * MINUTE
    END = START + 600 * MINUTE

    def trade(self, side, entry, exit_, net, product="PF_XBTUSD"):
        return {"product_id": product, "side": side, "entry_time_ms": entry, "exit_time_ms": exit_,
                "entry_price": "100.5", "exit_price": "101.0", "exit_reason": "time_stop", "net_bp": net,
                "pnl_usd": net / 100, "funding_usd": None, "funding_status": "unknown"}

    def store(self, run_id=1, kind="practice", status="done", products=("PF_XBTUSD",), candles=True, traces=None):
        self.insert(kind=kind, status=status)
        meta = {"run_id": run_id, "strategy_id": "c29-test-v1", "family": "c29-test", "version_key": "k",
                "kind": kind, "start_ms": self.START, "end_ms": self.END, "products": list(products),
                "config_hash": "h"}
        cfg = {"holdout_from": "2026-04-19"}
        trades = [self.trade("LONG", self.START + 30 * MINUTE, self.START + 45 * MINUTE, 12.0),
                  self.trade("SHORT", self.START + 200 * MINUTE, self.START + 230 * MINUTE, -4.2),
                  self.trade("LONG", self.START + 400 * MINUTE, self.START + 410 * MINUTE, 3.0, "PF_ETHUSD")]
        result = {"verdict": "NO PASA", "verdict_note": None, "inconclusive_reasons": [], "ci": (None, None),
                  "overall": {"n": 3, "mean_bp": 3.6}, "percentile": 87.0, "funding_share": 0.0,
                  "funding_status": {"unknown": 3},
                  "rules": [{"id": "positive_folds", "label": "folds", "value": {"positive": 2, "total": 5},
                             "threshold": 0.6, "ok": False}]}
        cfg["rules"] = {"min_trades": 100, "min_positive_fold_share": 0.6, "min_percentile_vs_random": 95}
        strategy_gate.write_artifact(self.dir, meta, cfg, SPEC, "h", trades, 1, result, traces=traces)
        if candles:
            cache = CandleCache(os.path.join(self.dir, "cache", "candles-PF_XBTUSD.sqlite"))
            cache.db.executemany("INSERT INTO candles VALUES('1m',?,?,?,?,?,?)",
                                 [(t, "100", "101", "99", "100.5", "2") for t in range(self.START - 5 * MINUTE,
                                                                                    self.END + 5 * MINUTE, MINUTE)
                                  if not 100 * MINUTE <= t - self.START < 103 * MINUTE])
            cache.db.commit()
            cache.close()

    def test_summary_carries_identity_figures_and_trade_counts(self):
        self.store()
        status, body = self.json("/gate/runs/1/visual-summary")
        self.assertEqual(status, 200)
        self.assertEqual(body["products"], ["PF_XBTUSD"])
        self.assertEqual(body["trades_by_product"], {"PF_XBTUSD": 2})
        self.assertEqual((body["summary"]["trades"], body["summary"]["percentile"]), (3, 87.0))
        self.assertEqual((body["summary"]["positive_folds"], body["summary"]["folds"]), (2, 5))
        self.assertEqual(body["decision_evidence"], "not_captured")
        self.assertEqual(body["label"], "Histórico Kraken · ejecuciones paper simuladas")

    def test_trades_are_paginated_filtered_by_product_and_window(self):
        self.store(products=("PF_XBTUSD", "PF_ETHUSD"))
        status, body = self.json("/gate/runs/1/trades?product=PF_XBTUSD&limit=1")
        self.assertEqual((status, body["total"], len(body["trades"]), body["next_cursor"]), (200, 2, 1, "1"))
        self.assertEqual(body["trades"][0]["side"], "LONG")
        second = self.json("/gate/runs/1/trades?product=PF_XBTUSD&limit=1&cursor=1")[1]
        self.assertEqual((second["trades"][0]["side"], second["next_cursor"]), ("SHORT", None))
        # A trade that enters before the window and leaves inside it is NOT dropped.
        window = "&from={}&to={}".format(self.START + 40 * MINUTE, self.START + 100 * MINUTE)
        inside = self.json("/gate/runs/1/trades?product=PF_XBTUSD" + window)[1]
        self.assertEqual([t["entry_time_ms"] for t in inside["trades"]], [self.START + 30 * MINUTE])
        self.assertEqual(self.json("/gate/runs/1/trades?product=PF_ETHUSD")[1]["total"], 1)

    def test_candles_come_from_the_run_range_with_gaps_counted_not_filled(self):
        self.store()
        window = "&from={}&to={}".format(self.START + 90 * MINUTE, self.START + 130 * MINUTE)
        status, body = self.json("/gate/runs/1/candles?product=PF_XBTUSD" + window)
        self.assertEqual(status, 200)
        self.assertEqual(len(body["candles"]), 37)
        self.assertEqual(body["missing_minutes"], 3)
        self.assertEqual(body["candles"][0]["time_ms"], self.START + 90 * MINUTE)
        self.assertEqual(body["resolution"], "1m")

    def test_default_window_is_around_the_newest_trade_and_never_leaves_the_range(self):
        self.store()
        body = self.json("/gate/runs/1/candles?product=PF_XBTUSD")[1]
        self.assertGreaterEqual(body["from_ms"], self.START)
        self.assertLessEqual(body["to_ms"], self.END)
        self.assertLessEqual(body["from_ms"], self.START + 200 * MINUTE)
        self.assertGreaterEqual(body["to_ms"], self.START + 230 * MINUTE)
        outside = "&from={}&to={}".format(self.END, self.END + 60 * MINUTE)
        self.assertEqual(self.json("/gate/runs/1/candles?product=PF_XBTUSD" + outside)[0], 400)
        clamped = self.json("/gate/runs/1/candles?product=PF_XBTUSD&from=0&to={}".format(self.END * 2))[1]
        self.assertEqual((clamped["from_ms"], clamped["to_ms"]), (self.START, self.END))

    def test_an_exam_is_shut_until_it_finished_and_a_practice_without_artifact_says_so(self):
        self.store(kind="exam", status="running")
        for path in ("visual-summary", "candles?product=PF_XBTUSD", "trades?product=PF_XBTUSD"):
            status, body = self.json("/gate/runs/1/" + path)
            self.assertEqual((status, body["error"]), (409, "exam_not_unlocked"), path)
        self.insert()
        status, body = self.json("/gate/runs/2/visual-summary")
        self.assertEqual((status, body["error"]), (404, "artifact_not_ready"))
        self.assertEqual(self.json("/gate/runs/9/visual-summary")[1]["error"], "run_not_found")

    def test_bad_products_and_values_are_refused_and_no_path_is_taken_from_the_client(self):
        self.store()
        for bad in ("product=PF_ETHUSD", "product=..%2F..%2Fx", "product=", "product=PF_XBTUSD&from=abc",
                    "product=PF_XBTUSD&limit=0", "product=PF_XBTUSD&limit=9999"):
            self.assertEqual(self.json("/gate/runs/1/trades?" + bad)[0], 400, bad)
        self.assertEqual(self.json("/gate/runs/1/candles?product=PF_ETHUSD")[0], 400)

    def test_a_tampered_trades_file_is_not_served(self):
        self.store()
        path = os.path.join(self.dir, "artifacts", "1", "trades.jsonl.gz")
        with open(path, "wb") as handle:
            handle.write(gzip.compress(b'{"product_id":"PF_XBTUSD"}\n'))
        self.assertEqual(self.json("/gate/runs/1/trades?product=PF_XBTUSD")[1]["error"], "artifact_not_ready")

    def test_missing_candle_cache_is_reported_not_invented(self):
        self.store(candles=False)
        status, body = self.json("/gate/runs/1/candles?product=PF_XBTUSD")
        self.assertEqual((status, body["error"]), (404, "data_missing"))

    def traced(self):
        """A hand-built trace: 4 signals of PF_XBTUSD (one taken, three not) and one of PF_ETHUSD."""
        def signal(minute, side, outcome):
            return {"bucket_ms": self.START + minute * MINUTE, "side": side, "outcome": outcome,
                    "reason_code": "breakout", "stop": "99", "target": "102"}
        xbt = {"signals": [signal(29, "LONG", "accepted"), signal(31, "LONG", "position_open"),
                           signal(150, "SHORT", "rejected_target_does_not_clear_cost"),
                           signal(300, "SHORT", "rejected_stale_data")],
               "trades": [], "counts": {"WAIT:entry_conditions_not_met": 40, "LONG:accepted": 1}}
        eth = {"signals": [signal(10, "LONG", "accepted")], "trades": [], "counts": {}}
        return [("PF_XBTUSD", self.START, self.END, xbt), ("PF_ETHUSD", self.START, self.END, eth)]

    def test_decisions_come_from_the_trace_filtered_by_product_and_window(self):
        self.store(products=("PF_XBTUSD", "PF_ETHUSD"), traces=self.traced())
        self.assertEqual(self.json("/gate/runs/1/visual-summary")[1]["decision_evidence"], "captured")
        status, body = self.json("/gate/runs/1/decisions?product=PF_XBTUSD")
        self.assertEqual((status, body["captured"], body["total"], body["truncated"]), (200, True, 4, False))
        self.assertEqual([s["outcome"] for s in body["signals"]],
                         ["accepted", "position_open", "rejected_target_does_not_clear_cost", "rejected_stale_data"])
        self.assertEqual(set(body["signals"][0]), {"bucket_ms", "side", "outcome", "reason_code"})
        self.assertEqual(body["counts"]["WAIT:entry_conditions_not_met"], 40)
        window = "&from={}&to={}".format(self.START + 30 * MINUTE, self.START + 200 * MINUTE)
        inside = self.json("/gate/runs/1/decisions?product=PF_XBTUSD" + window)[1]
        self.assertEqual([s["outcome"] for s in inside["signals"]],
                         ["position_open", "rejected_target_does_not_clear_cost"])
        self.assertEqual(self.json("/gate/runs/1/decisions?product=PF_ETHUSD")[1]["total"], 1)

    def test_decisions_are_capped_and_say_so(self):
        self.store(traces=self.traced())
        old = gate_api.MAX_DECISIONS
        gate_api.MAX_DECISIONS = 2
        try:
            body = self.json("/gate/runs/1/decisions?product=PF_XBTUSD")[1]
        finally:
            gate_api.MAX_DECISIONS = old
        self.assertEqual((len(body["signals"]), body["total"], body["truncated"]), (2, 4, True))

    def test_a_run_saved_without_trace_says_not_captured_and_invents_nothing(self):
        self.store()
        status, body = self.json("/gate/runs/1/decisions?product=PF_XBTUSD")
        self.assertEqual((status, body["captured"]), (200, False))
        self.assertIn("sin el detalle de decisiones", body["reason"])
        self.assertNotIn("signals", body)

    def test_decisions_refuse_what_trades_refuses_and_a_tampered_trace(self):
        self.store(traces=self.traced())
        for bad in ("product=PF_ETHUSD", "product=..%2Fx", "product=PF_XBTUSD&from=abc"):
            self.assertEqual(self.json("/gate/runs/1/decisions?" + bad)[0], 400, bad)
        self.assertEqual(self.json("/gate/runs/9/decisions?product=PF_XBTUSD")[1]["error"], "run_not_found")
        with open(os.path.join(self.dir, "artifacts", "1", "trace.jsonl.gz"), "wb") as handle:
            handle.write(gzip.compress(b'{"type":"signal","product_id":"PF_XBTUSD","bucket_ms":1}\n'))
        status, body = self.json("/gate/runs/1/decisions?product=PF_XBTUSD")
        self.assertEqual((status, body["error"]), (409, "artifact_not_ready"))

    def test_decisions_of_an_exam_are_shut_until_it_finished(self):
        self.store(kind="exam", status="running")
        status, body = self.json("/gate/runs/1/decisions?product=PF_XBTUSD")
        self.assertEqual((status, body["error"]), (409, "exam_not_unlocked"))


if __name__ == "__main__":
    unittest.main()
