"""Strategy gate over HTTP (inside the registry process S): launch, list, poll, cancel and download.

``gate.sqlite`` is written only by ``python3 -m balancita_engine.strategy_gate``; this module opens it read-only
(``mode=ro``). A run is a detached child process (own session, no shell, args array): it keeps writing if S or the
HTTP request goes away, and the UI finds it again through the DB. Cancelling is the gate's own: a flag file plus SIGTERM
to ``runs.pid`` (``strategy_gate.cancel_run``).
"""

import datetime
import gzip
import hashlib
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
from . import strategy_gate_models

DB_NAME = "gate.sqlite"
ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_DATA_DIR = os.path.join(ROOT, "data", "strategy-gate")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PUBLIC_FIELDS = ("id", "strategy_id", "family", "kind", "status", "verdict", "progress", "phase", "detail", "eta_s",
                 "started_at", "updated_at", "finished_at", "attempts", "error", "params")
SPAWN_WAIT_S = 30.0
ARTIFACT_SCHEMA = "balancita.gate-run-artifact.v1"
MINUTE_MS = 60_000
PRODUCT = re.compile(r"^[A-Za-z0-9_]{3,32}$")
MAX_WINDOW_MS = 3 * 24 * 60 * MINUTE_MS      # at most 3 days of 1m candles (4320) per request
DEFAULT_WINDOW_MS = 6 * 60 * MINUTE_MS
CONTEXT_MS = 2 * 60 * MINUTE_MS             # candles shown around the anchor trade
MAX_TRADES_PAGE = 500


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
    def __init__(self, registry, data_dir=None, python=None, spawn=None, wait_s=SPAWN_WAIT_S, products=None,
                 kronos_dir=None, qwen_exit_dir=None):
        self.registry = registry
        self.kronos_dir, self.qwen_exit_dir = kronos_dir, qwen_exit_dir
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
        if strategy_gate_models.is_model(strategy_id):  # Qwen and Kronos are judged by their recorded trades
            return
        if (not isinstance(strategy_id, str) or self.registry._version_row(strategy_id, None) is None
                or self.registry._deleted(strategy_id)):
            raise GateApiError("not_found", "No existe la estrategia indicada.", 404)

    def _validate(self, body):
        if not isinstance(body, dict):
            raise GateApiError("invalid_body", "El pedido debe ser un objeto.")
        extra = set(body) - {"from", "to", "products", "exam"}
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
        end = body.get("to")
        if end is not None:
            if not isinstance(end, str) or not DATE.match(end):
                raise GateApiError("invalid_to", "La fecha 'hasta' debe tener el formato AAAA-MM-DD.")
            try:
                datetime.date.fromisoformat(end)
            except ValueError:
                raise GateApiError("invalid_to", "La fecha 'hasta' no es válida.")
            if exam:
                raise GateApiError("invalid_to", "El examen no lleva fecha 'hasta'.")
        products = body.get("products")
        if products is not None:
            if (not isinstance(products, list) or not products or len(products) > 16
                    or not all(isinstance(p, str) for p in products) or len(set(products)) != len(products)):
                raise GateApiError("invalid_products", "Elegí al menos un producto, sin repetir.")
            unknown = [p for p in products if p not in self._known_products()]
            if unknown:
                raise GateApiError("invalid_products", "Producto desconocido: {}.".format(", ".join(unknown)))
        return start, end, products, exam

    # ------------------------------------------------------------------ actions

    def launch(self, strategy_id, body):
        self._check_strategy(strategy_id)
        start, end, products, exam = self._validate(body)
        args = [self.python, "-m", "balancita_engine.strategy_gate", "--data-dir", self.data_dir, "evaluate",
                "--strategy", strategy_id]
        registry_db = getattr(self.registry, "path", None)
        if isinstance(registry_db, str) and registry_db:
            args += ["--registry-db", os.path.abspath(registry_db)]
        if strategy_gate_models.is_model(strategy_id):
            for flag, folder in (("--kronos-dir", self.kronos_dir), ("--qwen-exit-dir", self.qwen_exit_dir)):
                if folder:
                    args += [flag, os.path.abspath(folder)]
        if start:
            args += ["--from", start]
        if end:
            args += ["--to", end]
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

    def _current_hash(self, strategy_id, version=None):
        try:
            if strategy_gate_models.is_model(strategy_id):
                return spec_hash(strategy_gate_models.model_spec(strategy_id))
            return spec_hash(self.registry.version(strategy_id, version)["spec"])
        except Exception:  # noqa: BLE001 - unknown version or unreadable descriptor: nothing can be said
            return None

    def runs(self, strategy_id, version=None):
        """Runs, the exam and whether THIS version (``version``, else the newest) already passed.

        ``passed`` is true when a finished practice run of exactly this content (same ``code_hash``) says PASA, or
        its exam does; the front uses it to warn before activating a version that did not pass.
        """
        self._check_strategy(strategy_id)
        rows = self._query("SELECT * FROM runs WHERE strategy_id=? ORDER BY id DESC LIMIT 200", (strategy_id,))
        lock = self._query("SELECT * FROM exam_locks WHERE strategy_id=?", (strategy_id,))
        digest = self._current_hash(strategy_id, version)
        practice = [r for r in rows if r["kind"] == "practice" and r["status"] == "done"
                    and digest is not None and r["code_hash"] == digest]
        passed_practice = bool(practice) and practice[0]["verdict"] == "PASA"
        passed_exam = (bool(lock) and digest is not None and lock[0]["code_hash"] == digest
                       and lock[0]["verdict"] == "PASA")
        return {"runs": [dict(self._public(row), same_version=digest is not None and row["code_hash"] == digest)
                         for row in rows],
                "exam": self._exam(strategy_id, lock[0] if lock else None),
                "running": self._running_public(),
                "passed": {"practice": passed_practice, "exam": passed_exam, "any": passed_practice or passed_exam}}

    def purge(self, strategy_id, wait_s=60.0):
        """Asks a gate process to delete everything it holds about ``strategy_id`` (it is the DB's single writer)."""
        running = [r for r in self._query("SELECT * FROM runs WHERE strategy_id=? AND status='running'", (strategy_id,))
                   if _alive(r.get("pid"))]
        if running:
            raise GateApiError("busy", "Hay una prueba en curso de esta estrategia: cancelala antes de borrarla.", 409)
        if not os.path.isdir(self.data_dir):
            return {"skipped": True}
        self.run_module(["balancita_engine.strategy_gate", "--data-dir", self.data_dir, "purge", "--strategy",
                         strategy_id], "purge", wait_s)
        return {"skipped": False}

    def run_module(self, module_args, label, wait_s=60.0):
        """Runs ``python -m <module_args>`` as a detached child, waits for it, raises GateApiError if it fails."""
        args = [self.python, "-m"] + list(module_args)
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(p for p in (os.path.join(ROOT, "python"), env.get("PYTHONPATH")) if p)
        os.makedirs(self.data_dir, exist_ok=True)
        log_path = os.path.join(self.data_dir, "logs", "{}-{}.log".format(label, int(time.time() * 1000)))
        child = self.spawn(args, env, ROOT, log_path)
        deadline = time.time() + wait_s
        while child.poll() is None:
            if time.time() >= deadline:
                raise GateApiError("purge_pending", "El borrado de {} sigue en curso.".format(label), 504)
            time.sleep(0.05)
        text = self._refusal(log_path)
        try:
            os.remove(log_path)
        except OSError:
            pass
        if child.returncode not in (0, None):
            raise GateApiError("purge_failed", text, 500)

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

    # ------------------------------------------------------------------ stored trades and candles (read-only)

    def _finished_run(self, run_id):
        """The row of a FINISHED run. An exam still running (or cancelled/failed) has revealed nothing yet."""
        rows = self._query("SELECT * FROM runs WHERE id=?", (self._run_id(run_id),))
        if not rows:
            raise GateApiError("run_not_found", "No existe esa corrida.", 404)
        row = rows[0]
        if row["status"] != "done":
            code = "exam_not_unlocked" if row["kind"] == "exam" else "artifact_not_ready"
            raise GateApiError(code, "Esa corrida todavía no terminó: no hay operaciones para mostrar.", 409)
        return row

    def _artifact(self, run_id):
        """``(row, manifest, folder)`` of a finished run that stored its trades; refuses anything not inside ``artifacts``."""
        row = self._finished_run(run_id)
        root = os.path.realpath(os.path.join(self.data_dir, "artifacts"))
        folder = os.path.realpath(os.path.join(root, str(row["id"])))
        try:
            if os.path.commonpath([root, folder]) != root:
                raise ValueError("outside")
            with open(os.path.join(folder, "manifest.json"), encoding="utf-8") as handle:
                manifest = json.load(handle)
        except (OSError, ValueError):
            raise GateApiError("artifact_not_ready", "Esa corrida no guardó sus operaciones (es anterior a este "
                                                     "cambio o no pudo guardarlas).", 404)
        if (not isinstance(manifest, dict) or manifest.get("schema") != ARTIFACT_SCHEMA
                or manifest.get("run_id") != row["id"] or manifest.get("status") != "complete"):
            raise GateApiError("artifact_not_ready", "Las operaciones guardadas de esa corrida no son válidas.", 409)
        return row, manifest, folder

    def _stored_trades(self, folder, manifest):
        try:
            with open(os.path.join(folder, str(manifest.get("trades_file"))), "rb") as handle:
                packed = handle.read()
            raw = gzip.decompress(packed)
        except (OSError, EOFError, ValueError):
            raise GateApiError("artifact_not_ready", "No se pudieron leer las operaciones guardadas.", 409)
        if hashlib.sha256(raw).hexdigest() != manifest.get("trades_sha256"):
            raise GateApiError("artifact_not_ready", "Las operaciones guardadas no coinciden con su suma de control.", 409)
        return [json.loads(line) for line in raw.decode("utf-8").splitlines() if line]

    @staticmethod
    def _product_of(manifest, product):
        if not isinstance(product, str) or not PRODUCT.match(product) or product not in manifest.get("products", []):
            raise GateApiError("invalid_product", "Ese producto no es de esta corrida.", 400)
        return product

    @staticmethod
    def _ms(value, name):
        if value is None:
            return None
        if not isinstance(value, str) or not re.match(r"^[0-9]{1,15}$", value):
            raise GateApiError("invalid_window", "El valor '{}' no es un instante válido.".format(name))
        return int(value)

    def visual_summary(self, run_id):
        """What the screen needs before any candle: the run's identity, its four figures and which products it has."""
        row, manifest, folder = self._artifact(run_id)
        trades = self._stored_trades(folder, manifest)
        counts = {}
        for trade in trades:
            counts[trade["product_id"]] = counts.get(trade["product_id"], 0) + 1
        return {"run": self._public(row),
                "run_id": row["id"], "strategy_id": manifest["strategy_id"], "kind": manifest["kind"],
                "spec_hash": manifest["spec_hash"], "products": manifest["products"],
                "trades_by_product": {p: counts.get(p, 0) for p in manifest["products"]},
                "range_start_ms": manifest["range_start_ms"], "range_end_ms": manifest["range_end_ms_exclusive"],
                "source": manifest["source"], "resolution": manifest["resolution"],
                "decision_evidence": manifest["decision_evidence"], "contaminated": manifest["contaminated"],
                "cost_model_version": manifest["cost_model_version"], "summary": manifest.get("summary"),
                "label": "Histórico Kraken · ejecuciones paper simuladas"}

    def _window(self, manifest, trades, start, end):
        lo, hi = manifest["range_start_ms"], manifest["range_end_ms_exclusive"]
        if start is None and end is None:
            if trades:       # around the newest closed trade of this product
                last = max(trades, key=lambda t: t["exit_time_ms"])
                start, end = last["entry_time_ms"] - CONTEXT_MS, last["exit_time_ms"] + CONTEXT_MS
            else:
                start, end = hi - DEFAULT_WINDOW_MS, hi
        elif end is None:
            end = start + DEFAULT_WINDOW_MS
        elif start is None:
            start = end - DEFAULT_WINDOW_MS
        start, end = max(start, lo), min(end, hi)
        if end - start > MAX_WINDOW_MS:
            end = start + MAX_WINDOW_MS
        if end <= start:
            raise GateApiError("invalid_window", "La ventana pedida queda fuera de la prueba.")
        return start // MINUTE_MS * MINUTE_MS, end

    def _read_candles(self, product, start, end):
        path = os.path.join(self.data_dir, "cache", "candles-{}.sqlite".format(product))
        if not os.path.isfile(path):
            raise GateApiError("data_missing", "No hay velas guardadas de {} para esa prueba.".format(product), 404)
        db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=10)
        try:
            return db.execute("SELECT t,o,h,l,c,v FROM candles WHERE res='1m' AND t>=? AND t<? ORDER BY t",
                              (start, end)).fetchall()
        except sqlite3.OperationalError:
            raise GateApiError("data_missing", "No hay velas guardadas de {} para esa prueba.".format(product), 404)
        finally:
            db.close()

    def candles(self, run_id, product, start=None, end=None):
        """The 1m candles Kraken published inside a finished run's range (never outside it), as the gate cached them.

        Missing minutes are NOT filled: ``missing_minutes`` counts them and the chart shows the gap.
        """
        row, manifest, folder = self._artifact(run_id)
        product = self._product_of(manifest, product)
        mine = [t for t in self._stored_trades(folder, manifest) if t["product_id"] == product]
        start, end = self._window(manifest, mine, self._ms(start, "from"), self._ms(end, "to"))
        rows = self._read_candles(product, start, end)
        expected = (end - start + MINUTE_MS - 1) // MINUTE_MS
        return {"run_id": row["id"], "product": product, "resolution": "1m", "from_ms": start, "to_ms": end,
                "range_start_ms": manifest["range_start_ms"], "range_end_ms": manifest["range_end_ms_exclusive"],
                "candles": [{"time_ms": t, "open": o, "high": h, "low": l, "close": c, "volume": v}
                            for t, o, h, l, c, v in rows],
                "missing_minutes": max(0, expected - len(rows)),
                "label": "Histórico Kraken · ejecuciones paper simuladas"}

    def trades(self, run_id, product, start=None, end=None, cursor=None, limit=None):
        """Closed trades of a run for one product, oldest first, paginated. With a window: those that overlap it."""
        row, manifest, folder = self._artifact(run_id)
        product = self._product_of(manifest, product)
        start, end = self._ms(start, "from"), self._ms(end, "to")
        offset = self._ms(cursor, "cursor") or 0
        size = 200 if limit is None else self._ms(limit, "limit")
        if not 1 <= size <= MAX_TRADES_PAGE:
            raise GateApiError("invalid_window", "El límite debe estar entre 1 y {}.".format(MAX_TRADES_PAGE))
        mine = [t for t in self._stored_trades(folder, manifest) if t["product_id"] == product]
        if start is not None or end is not None:
            lo = -1 if start is None else start
            hi = float("inf") if end is None else end
            mine = [t for t in mine if t["entry_time_ms"] < hi and t["exit_time_ms"] >= lo]
        page = mine[offset:offset + size]
        more = offset + size < len(mine)
        return {"run_id": row["id"], "product": product, "total": len(mine), "trades": page,
                "next_cursor": str(offset + size) if more else None}

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
