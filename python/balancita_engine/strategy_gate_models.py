"""Qwen (C31, exits) and Kronos as subjects of the strategy gate.

Neither is a rule spec: ``propose_spec``/``Book`` cannot replay them, because every decision comes from a local model
(llama-server for Qwen, Kronos weights for Kronos) that is not available to the gate. The gate therefore judges
what each of them DID: the trades recorded in their own databases (``qwen-exit.sqlite`` and ``kronos.sqlite``,
opened read-only), through the same ``trade_source`` hook, statistics, costs, folds and rules as any strategy.

Consequence, said in every report: the models have no recorded history before they started, so the practice
window (before the cutoff) has no trades and cannot judge them; the final exam (after the cutoff) judges the
recorded ones. Re-running a model over old candles needs the model itself and hours of compute, and is not done.
"""

import json
import os
import sqlite3

from . import strategy_purge

KRONOS_ID = "kronos-small-1h-h4-v1"
QWEN_ID = "c31-qwen-exit-perp-v1"
ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
KRONOS_CONFIG = os.path.join(ROOT, "config", "models", "kronos-small-1h-h4-v1.json")
QWEN_CONFIG = os.path.join(ROOT, "config", "qwen-exit.json")
NOTE = ("Este modelo no se puede volver a correr sobre velas viejas desde acá (necesita el modelo local y horas de "
        "cálculo): se juzgan las operaciones que ya hizo y quedaron guardadas. Antes de empezar a operar no hay "
        "ninguna, así que la práctica (que termina en la fecha de corte) casi nunca tiene operaciones; el examen "
        "final sí juzga las registradas.")


def is_model(strategy_id):
    return strategy_id in (KRONOS_ID, QWEN_ID)


def _read(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _canonical(value):
    """Floats are not canonical-hashable: they become strings (the digest only has to be stable)."""
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, dict):
        return {k: _canonical(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_canonical(v) for v in value]
    return value


def model_spec(strategy_id):
    """A stand-in for the spec (id, name, version and the model's descriptor) whose digest names the version."""
    if strategy_id == KRONOS_ID:
        descriptor = _read(KRONOS_CONFIG)
        return _canonical(dict(descriptor, id=KRONOS_ID, kind="model", name=descriptor.get("name", "Kronos")))
    if strategy_id == QWEN_ID:
        config = _read(QWEN_CONFIG)
        config = {k: v for k, v in config.items() if k not in ("off", "note")}
        return _canonical(dict(config, id=QWEN_ID, kind="qwen_exit", version=1, name="Qwen decide salidas"))
    raise KeyError(strategy_id)


class RecordedTrades:
    """``trade_source`` that reads the trades a model already made, from its own DB (read-only)."""

    note = NOTE

    def __init__(self, db_path, table):
        self.db_path, self.table = db_path, table

    def __call__(self, spec, product_id, tick_size, ones, fives, funding, start_ms, end_ms, chunk):
        if not self.db_path or not os.path.isfile(self.db_path):
            return [], 0
        db = sqlite3.connect("file:{}?mode=ro".format(self.db_path), uri=True, timeout=10)
        try:
            rows = db.execute("SELECT payload FROM {} WHERE product_id=?".format(self.table), (product_id,)).fetchall()
            trades = [json.loads(payload) for (payload,) in rows]
        except sqlite3.OperationalError:
            return [], 0
        finally:
            db.close()
        chunk(1.0)
        trades = [t for t in trades if t.get("net_bp") is not None
                  and start_ms <= int(t["entry_time_ms"]) and int(t["exit_time_ms"]) <= end_ms]
        for trade in trades:
            trade.setdefault("exit_reason", "time" if "kronos" in str(spec.get("id")) else "qwen")
        return sorted(trades, key=lambda t: t["entry_time_ms"]), 0


def model_subject(strategy_id, kronos_dir=None, qwen_exit_dir=None):
    """``(spec, trade_source)`` for Kronos or Qwen; the directories are where their databases live."""
    kronos_dir = kronos_dir or os.path.join(ROOT, "data", "kronos")
    qwen_exit_dir = qwen_exit_dir or os.path.join(ROOT, "data", "dev-live", "qwen-exit")
    if strategy_id == KRONOS_ID:
        return model_spec(KRONOS_ID), RecordedTrades(os.path.join(kronos_dir, "kronos.sqlite"), "trade")
    if strategy_id == QWEN_ID:
        return model_spec(QWEN_ID), RecordedTrades(os.path.join(qwen_exit_dir, "qwen-exit.sqlite"), "qwen_exit_trade")
    raise KeyError(strategy_id)


__all__ = ["KRONOS_ID", "QWEN_ID", "is_model", "model_spec", "model_subject", "RecordedTrades", "strategy_purge"]
