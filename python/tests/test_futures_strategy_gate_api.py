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
                    {"extra": 1}, {"products": "PF_XBTUSD"}):
            self.assertEqual(self.json("/strategies/c29-test-v1/gate", bad)[0], 400, bad)
        self.assertEqual(self.json("/strategies/otra/gate", {})[0], 404)
        self.assertEqual(self.json("/strategies/..%2Fx;rm/gate", {})[0], 404)
        self.assertEqual(self.spawned, [])
        self.next_child = FakeChild(os.getpid())
        status, body = self.json("/strategies/c29-test-v1/gate", {"from": "2025-02-01", "products": ["PF_ETHUSD"]})
        self.assertEqual((status, body["pending"], body["run_id"]), (200, True, None))
        args, env, cwd, _ = self.spawned[0]
        self.assertEqual(args[:3], ["py", "-m", "balancita_engine.strategy_gate"])
        self.assertEqual(args[args.index("--strategy") + 1], "c29-test-v1")
        self.assertEqual(args[args.index("--from") + 1], "2025-02-01")
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


if __name__ == "__main__":
    unittest.main()
