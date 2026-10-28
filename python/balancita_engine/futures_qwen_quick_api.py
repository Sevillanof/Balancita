"""Qwen's quick test, for the /Estrategias screen: launches ``futures_qwen_trader exam --quick`` and reports its state.

The process is the only writer of its state file (``rapida-v3.json`` beside the exam database); this class launches it and
reads the file. One at a time. The quick test never touches the full exam database or the live operator's.
"""

import json
import os
import threading

from . import futures_qwen_exigencia as exigencia
from . import futures_qwen_quick_variants as variants
from . import futures_qwen_trader_exam as exam
from . import strategy_gate_models as models
from .futures_strategy_gate_api import GateApiError, default_python, popen_detached, _alive

ROOT = models.ROOT
QUICK_ID = models.QWEN_LIVE_ID


class QuickTestApi:
    def __init__(self, exam_db_path=None, python=None, spawn=None):
        from . import futures_qwen_trader as qt
        self.exam_db_path = os.path.abspath(exam_db_path or os.environ.get(models.QWEN_EXAM_DB_ENV) or qt.DEFAULT_EXAM_DB_LIVE)
        self.python = python or default_python()
        self.spawn = spawn or popen_detached
        self._lock = threading.Lock()

    @property
    def state_path(self):
        return self._state_path(variants.CONTROL)

    def _state_path(self, variant_id):
        return os.path.join(os.path.dirname(self.exam_db_path), variants.state_name(variant_id))

    def _check(self, strategy_id):
        if strategy_id != QUICK_ID:
            raise GateApiError("not_available", "La prueba rápida solo existe para Qwen en vivo.", 404)

    def _variant(self, variant_id):
        try:
            return variants.get_variant(variant_id)
        except variants.VariantError as error:
            raise GateApiError("unknown_variant", str(error), 404) from error

    def _read(self, variant_id):
        try:
            with open(self._state_path(variant_id), encoding="utf-8") as handle:
                state = json.load(handle)
        except (OSError, ValueError):
            return {"state": "none"}
        if state.get("state") == "running" and not _alive(state.get("pid")):
            state = dict(state, state="failed", error="La prueba rápida se cortó antes de terminar.")
        return dict(state, variant=variant_id)

    def _catalog(self):
        """Every variant with its last state: the screen picks one and compares the finished ones."""
        out = []
        for variant in variants.load_variants():
            state = self._read(variant["id"])
            model = variant.get("model")
            out.append({"id": variant["id"], "label": variant["label"], "kind": variant["kind"], "note": variant.get("note"),
                        "approx_gb": model["approx_gb"] if model else None, "state": state["state"],
                        "summary": state.get("summary"), "error": state.get("error"),
                        "started_ms": state.get("started_ms")})
        return out

    def status(self, strategy_id, variant=None):
        """The state of ``variant``; without one, of the variant started last (the control when none ever ran)."""
        self._check(strategy_id)
        catalog = self._catalog()
        if variant is None:
            started = [v for v in catalog if v["started_ms"]]
            variant = max(started, key=lambda v: v["started_ms"])["id"] if started else variants.CONTROL
        else:
            self._variant(variant)
        state = self._read(variant)
        return dict(state, variant=variant, snapshots=exam.QUICK_SNAPSHOTS, note=exam.QUICK_NOTE, variants=catalog)

    def launch(self, strategy_id, variant=None, exigencia_levels=None):
        """``exigencia_levels``: ``{maestro, portero}`` 0-10 for this test only (5 and 5 = what paper operates)."""
        self._check(strategy_id)
        chosen = self._variant(variant)
        asked = exigencia_levels or {}
        if not isinstance(asked, dict) or set(asked) - {"maestro", "portero"}:
            raise GateApiError("invalid_exigencia", "La exigencia lleva 'maestro' y 'portero', de 0 a 10.", 422)
        try:
            levels_env = exigencia.env_for(asked.get("maestro"), asked.get("portero"))
        except ValueError as error:
            raise GateApiError("invalid_exigencia", str(error), 422) from error
        with self._lock:
            if any(v["state"] == "running" for v in self._catalog()):
                raise GateApiError("busy", "Ya hay una prueba rápida en curso.", 409)
            # «actual» is Qwen en vivo as it runs today (its own config, ``--version live``); the others change the v3 questions
            args = [self.python, "-m", "balancita_engine.futures_qwen_trader", "exam", "--version", chosen.get("base", "3"),
                    "--exam-db", self.exam_db_path, "--quick", str(exam.QUICK_SNAPSHOTS), "--variant", chosen["id"]]
            env = dict(os.environ, **levels_env)
            env["PYTHONPATH"] = os.pathsep.join(p for p in (os.path.join(ROOT, "python"), env.get("PYTHONPATH")) if p)
            log_path = os.path.join(os.path.dirname(self.exam_db_path), "rapida-v3-{}.log".format(chosen["id"]))
            self.spawn(args, env, ROOT, log_path)
            return {"started": True, "variant": chosen["id"]}
