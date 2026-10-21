"""Strategy gate over HTTP (inside the registry process S): launch, list, poll, cancel and download.

``gate.sqlite`` is written only by ``python3 -m balancita_engine.strategy_gate``; this module opens it read-only
(``mode=ro``). A run is a detached child process (own session, no shell, args array): it keeps writing if S or the
HTTP request goes away, and the UI finds it again through the DB. Cancelling is the gate's own: a flag file plus SIGTERM
to ``runs.pid`` (``strategy_gate.cancel_run``).
"""

import datetime
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time

from .futures_products import load_pinned_products
from .futures_spec_strategy import spec_hash

DB_NAME = "gate.sqlite"
ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_DATA_DIR = os.path.join(ROOT, "data", "strategy-gate")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PUBLIC_FIELDS = ("id", "strategy_id", "family", "kind", "status", "verdict", "progress", "phase", "detail", "eta_s",
                 "started_at", "updated_at", "finished_at", "attempts", "error", "params")
SPAWN_WAIT_S = 30.0


class GateApiError(Exception):
    def __init__(self, code, detail, status=400):
        super().__init__(detail)
        self.code, self.detail, self.status = code, detail, status


def default_python():
    """The interpreter dev.mjs resolved (BALANCITA_PYTHON), else the one S itself runs on (also chosen by dev.mjs)."""
    return (os.environ.get("BALANCITA_PYTHON") or "").strip() or sys.executable


def _alive(pid):
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def popen_detached(args, env, cwd, log_path):
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    log = open(log_path, "ab")
    try:
        return subprocess.Popen(args, shell=False, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                start_new_session=True, close_fds=True)
    finally:
        log.close()


class GateApi:
    def __init__(self, registry, data_dir=None, python=None, spawn=None, wait_s=SPAWN_WAIT_S, products=None):
        self.registry = registry
        self.data_dir = os.path.abspath(data_dir or os.environ.get("STRATEGY_GATE_DIR") or DEFAULT_DATA_DIR)
        self.python = python or default_python()
        self.spawn = spawn or popen_detached
        self.wait_s = wait_s
        self.products = products
        self._launch_lock = threading.Lock()

    # ------------------------------------------------------------------ read-only DB

    @property
    def db_path(self):
        return os.path.join(self.data_dir, DB_NAME)

    def _connect(self):
        if not os.path.exists(self.db_path):
            return None
        db = sqlite3.connect("file:{}?mode=ro".format(self.db_path), uri=True, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def _query(self, sql, args=()):
        db = self._connect()
        if db is None:
            return []
        try:
            return [dict(row) for row in db.execute(sql, args)]
        except sqlite3.OperationalError:  # file exists but the gate has not created its tables yet
            return []
        finally:
            db.close()

    @staticmethod
    def _public(row):
        out = {key: row.get(key) for key in PUBLIC_FIELDS}
        try:
            out["params"] = json.loads(row["params"]) if row.get("params") else None
        except (TypeError, ValueError):
            out["params"] = None
        out["has_report"] = bool(row.get("report_path"))
        if row["status"] == "running" and not _alive(row.get("pid")):
            out["status"], out["phase"] = "failed", "falló"
            out["detail"] = "El proceso terminó sin cerrar la corrida."
            out["eta_s"] = None
        return out

    def _running(self):
        for row in self._query("SELECT * FROM runs WHERE status='running' ORDER BY id"):
            if _alive(row.get("pid")):
                return row
        return None

    # ------------------------------------------------------------------ validation

    def _known_products(self):
        if self.products is not None:
            return set(self.products)
        return {pid for pid, _ in load_pinned_products()}

    def _check_strategy(self, strategy_id):
        if (not isinstance(strategy_id, str) or self.registry._version_row(strategy_id, None) is None
                or self.registry._deleted(strategy_id)):
            raise GateApiError("not_found", "No existe la estrategia indicada.", 404)

    def _validate(self, body):
        if not isinstance(body, dict):
            raise GateApiError("invalid_body", "El pedido debe ser un objeto.")
        extra = set(body) - {"from", "products", "exam"}
        if extra:
            raise GateApiError("invalid_body", "Campos no admitidos: {}.".format(", ".join(sorted(extra))))
        exam = body.get("exam", False)
        if not isinstance(exam, bool):
            raise GateApiError("invalid_exam", "El campo 'exam' debe ser verdadero o falso.")
        start = body.get("from")
        if start is not None:
            if not isinstance(start, str) or not DATE.match(start):
                raise GateApiError("invalid_from", "La fecha 'desde' debe tener el formato AAAA-MM-DD.")
            try:
                datetime.date.fromisoformat(start)
            except ValueError:
                raise GateApiError("invalid_from", "La fecha 'desde' no es válida.")
            if exam:
                raise GateApiError("invalid_from", "El examen siempre usa los últimos meses: no lleva fecha 'desde'.")
        products = body.get("products")
        if products is not None:
            if (not isinstance(products, list) or not products or len(products) > 16
                    or not all(isinstance(p, str) for p in products) or len(set(products)) != len(products)):
                raise GateApiError("invalid_products", "Elegí al menos un producto, sin repetir.")
            unknown = [p for p in products if p not in self._known_products()]
            if unknown:
                raise GateApiError("invalid_products", "Producto desconocido: {}.".format(", ".join(unknown)))
        return start, products, exam

    # ------------------------------------------------------------------ actions

    def launch(self, strategy_id, body):
        self._check_strategy(strategy_id)
        start, products, exam = self._validate(body)
        args = [self.python, "-m", "balancita_engine.strategy_gate", "--data-dir", self.data_dir, "evaluate",
                "--strategy", strategy_id]
        registry_db = getattr(self.registry, "path", None)
        if isinstance(registry_db, str) and registry_db:
            args += ["--registry-db", os.path.abspath(registry_db)]
        if start:
            args += ["--from", start]
        if products:
            args += ["--products", ",".join(products)]
        if exam:
            args.append("--exam")
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(p for p in (os.path.join(ROOT, "python"), env.get("PYTHONPATH")) if p)
        with self._launch_lock:
            running = self._running()
            if running is not None:
                raise GateApiError("busy", "Ya hay una prueba en curso ({}). Esperá a que termine o cancelala."
                                   .format(running["strategy_id"]), 409)
            log_path = os.path.join(self.data_dir, "logs", "launch-{}.log".format(int(time.time() * 1000)))
            child = self.spawn(args, env, ROOT, log_path)
            deadline = time.time() + self.wait_s
            while True:
                rows = self._query("SELECT * FROM runs WHERE pid=? AND strategy_id=? ORDER BY id DESC LIMIT 1",
                                   (child.pid, strategy_id))
                if rows:
                    return {"run_id": rows[0]["id"], "pid": child.pid, "pending": False}
                code = child.poll()
                if code is not None:
                    rows = self._query("SELECT * FROM runs WHERE pid=? AND strategy_id=? ORDER BY id DESC LIMIT 1",
                                       (child.pid, strategy_id))
                    if rows:
                        return {"run_id": rows[0]["id"], "pid": child.pid, "pending": False}
                    raise GateApiError("gate_refused", self._refusal(log_path), 422)
                if time.time() >= deadline:
                    return {"run_id": None, "pid": child.pid, "pending": True}
                time.sleep(0.1)

    @staticmethod
    def _refusal(log_path):
        try:
            with open(log_path, "rb") as handle:
                text = handle.read()[-2000:].decode("utf-8", "replace").strip()
        except OSError:
            text = ""
        lines = [line for line in text.splitlines() if line.strip()]
        return lines[-1] if lines and len(lines[-1]) < 600 else (
            "La prueba no pudo empezar. Revisá el registro en data/strategy-gate/logs.")

    def runs(self, strategy_id):
        self._check_strategy(strategy_id)
        rows = self._query("SELECT * FROM runs WHERE strategy_id=? ORDER BY id DESC LIMIT 200", (strategy_id,))
        lock = self._query("SELECT * FROM exam_locks WHERE strategy_id=?", (strategy_id,))
        return {"runs": [self._public(row) for row in rows], "exam": self._exam(strategy_id, lock[0] if lock else None),
                "running": self._running_public()}

    def _running_public(self):
        row = self._running()
        return None if row is None else {"id": row["id"], "strategy_id": row["strategy_id"]}

    def _exam(self, strategy_id, lock):
        if lock is None:
            return {"taken": False}
        try:
            current = spec_hash(self.registry.version(strategy_id)["spec"])
        except Exception:  # noqa: BLE001 - a registry hiccup must not hide the lock itself
            current = None
        same = current is None or current == lock["code_hash"]
        return {"taken": True, "same_version": same, "status": lock["status"], "verdict": lock["verdict"],
                "date": time.strftime("%Y-%m-%d", time.gmtime(lock["locked_at"] / 1000)), "run_id": lock["run_id"]}

    def run(self, run_id):
        rows = self._query("SELECT * FROM runs WHERE id=?", (self._run_id(run_id),))
        if not rows:
            raise GateApiError("not_found", "No existe esa corrida.", 404)
        return {"run": self._public(rows[0]), "running": self._running_public()}

    @staticmethod
    def _run_id(value):
        if not isinstance(value, str) or not re.match(r"^[0-9]{1,9}$", value):
            raise GateApiError("not_found", "No existe esa corrida.", 404)
        return int(value)

    def cancel(self, run_id):
        number = self._run_id(run_id)
        rows = self._query("SELECT * FROM runs WHERE id=?", (number,))
        if not rows:
            raise GateApiError("not_found", "No existe esa corrida.", 404)
        if rows[0]["status"] != "running":
            raise GateApiError("not_running", "Esa corrida ya no está en curso.", 409)
        from .strategy_gate import GateError, cancel_run

        try:
            cancel_run(number, self.data_dir)
        except GateError as error:
            raise GateApiError("not_running", str(error), 409)
        return {"run_id": number, "cancel_requested": True}

    def report(self, run_id):
        """``(filename, bytes)``; the file must resolve inside ``<data>/reports``."""
        rows = self._query("SELECT * FROM runs WHERE id=?", (self._run_id(run_id),))
        if not rows or not rows[0].get("report_path"):
            raise GateApiError("not_found", "Esa corrida no tiene informe.", 404)
        row = rows[0]
        reports = os.path.realpath(os.path.join(self.data_dir, "reports"))
        path = row["report_path"]
        path = os.path.realpath(path if os.path.isabs(path) else os.path.join(ROOT, path))
        if os.path.commonpath([reports, path]) != reports or not os.path.isfile(path):
            raise GateApiError("not_found", "Esa corrida no tiene informe.", 404)
        with open(path, "rb") as handle:
            data = handle.read()
        stamp = time.strftime("%Y-%m-%d", time.gmtime((row["finished_at"] or row["started_at"]) / 1000))
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", row["strategy_id"])
        return "{}-{}-{}-{}.md".format(safe, row["kind"], stamp, row["id"]), data
