"""Qwen's quick test, for the /Estrategias screen: launches ``futures_qwen_trader exam --quick`` and reports its state.

The process is the only writer of its state file (``rapida-v3.json`` beside the exam database); this class launches it and
reads the file. One at a time. The quick test never touches the full exam database or the live operator's.
"""

import json
import os
import threading

from . import futures_qwen_trader_exam as exam
from . import strategy_gate_models as models
from .futures_strategy_gate_api import GateApiError, default_python, popen_detached, _alive

ROOT = models.ROOT
QUICK_ID = models.QWEN_LIVE_ID


class QuickTestApi:
    def __init__(self, exam_db_path=None, python=None, spawn=None):
        from . import futures_qwen_trader as qt
        self.exam_db_path = os.path.abspath(exam_db_path or os.environ.get(models.QWEN_EXAM_DB_ENV) or qt.DEFAULT_EXAM_DB_V3)
        self.python = python or default_python()
        self.spawn = spawn or popen_detached
        self._lock = threading.Lock()

    @property
    def state_path(self):
        return os.path.join(os.path.dirname(self.exam_db_path), exam.QUICK_STATE)

    def _check(self, strategy_id):
        if strategy_id != QUICK_ID:
            raise GateApiError("not_available", "La prueba rápida solo existe para Qwen en vivo.", 404)

    def status(self, strategy_id):
        self._check(strategy_id)
        try:
            with open(self.state_path, encoding="utf-8") as handle:
                state = json.load(handle)
        except (OSError, ValueError):
            return {"state": "none", "snapshots": exam.QUICK_SNAPSHOTS, "note": exam.QUICK_NOTE}
        if state.get("state") == "running" and not _alive(state.get("pid")):
            state = dict(state, state="failed", error="La prueba rápida se cortó antes de terminar.")
        return dict(state, snapshots=exam.QUICK_SNAPSHOTS, note=exam.QUICK_NOTE)

    def launch(self, strategy_id):
        self._check(strategy_id)
        with self._lock:
            if self.status(strategy_id)["state"] == "running":
                raise GateApiError("busy", "Ya hay una prueba rápida en curso.", 409)
            args = [self.python, "-m", "balancita_engine.futures_qwen_trader", "exam", "--version", "3",
                    "--exam-db", self.exam_db_path, "--quick", str(exam.QUICK_SNAPSHOTS)]
            env = dict(os.environ)
            env["PYTHONPATH"] = os.pathsep.join(p for p in (os.path.join(ROOT, "python"), env.get("PYTHONPATH")) if p)
            log_path = os.path.join(os.path.dirname(self.exam_db_path), "rapida-v3.log")
            self.spawn(args, env, ROOT, log_path)
            return {"started": True}
