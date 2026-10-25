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
QWEN_LIVE_ID = "qwen-live-perp-v1"
ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
KRONOS_CONFIG = os.path.join(ROOT, "config", "models", "kronos-small-1h-h4-v1.json")
QWEN_CONFIG = os.path.join(ROOT, "config", "qwen-exit.json")
QWEN_LIVE_CONFIG = os.path.join(ROOT, "config", "qwen-live.json")
QWEN_LIVE_DIR = os.path.join(ROOT, "data", "qwen-live")
QWEN_EXAM_DB_ENV = "QWEN_EXAM_DB"
LIVE_HOLD_MS = 4 * 60 * 60_000       # the live operator's mandatory close, also the horizon of a photo trade
NOTE = ("Este modelo no se puede volver a correr sobre velas viejas desde acá (necesita el modelo local y horas de "
        "cálculo): se juzgan las operaciones que ya hizo y quedaron guardadas. Antes de empezar a operar no hay "
        "ninguna, así que la práctica (que termina en la fecha de corte) casi nunca tiene operaciones; el examen "
        "final sí juzga las registradas.")


def is_model(strategy_id):
    return strategy_id in (KRONOS_ID, QWEN_ID, QWEN_LIVE_ID)


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
    if strategy_id == QWEN_LIVE_ID:
        from . import futures_qwen_trader as qt
        config = _read(QWEN_LIVE_CONFIG)
        return _canonical({"id": QWEN_LIVE_ID, "kind": "qwen_live", "version": 1, "name": "Qwen en vivo",
                           "products": config["products"], "notional_usd": config["notional_usd"],
                           "leverage": config.get("leverage", "1"), "config_hash": qt.config_hash(config)})
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


LIVE_NOTE = ("Qwen en vivo se juzga sin llamar al modelo. Práctica (antes de la fecha de corte): las \"fotos\" del pasado "
             "que Qwen ya contestó (examen por fotos, exam-v3.sqlite), convertidas en operaciones de 4 h con costos y "
             "funding reales, una a la vez por producto. Examen (desde la fecha de corte): sus operaciones reales en paper, "
             "cerradas; las abiertas no cuentan y Qwen sigue operando mientras tanto.")


class QwenLiveTrades:
    """``trade_source`` of the live Qwen operator: answered photos before the cut, its own closed paper trades after it."""

    note = LIVE_NOTE

    def __init__(self, live_db_path, exam_db_path):
        self.live_db_path, self.exam_db_path = live_db_path, exam_db_path

    def photo_trades(self, product_id, funding):
        if not self.exam_db_path or not os.path.isfile(self.exam_db_path):
            return []
        from . import futures_qwen_trader as qt
        from . import futures_qwen_trader_exam as exam
        threshold = qt.load_config(qt.CONFIG_PATH_V3)["practice_entry_threshold"]
        try:
            rows, _ = exam.load_answers(self.exam_db_path)
        except sqlite3.OperationalError:
            return []
        line = qt.FundingLine([(r[0], r[1]) for r in funding]) if funding else None
        out, free_at = [], 0
        for row in sorted((r for r in rows if r["product"] == product_id and exam.classify(r, threshold) == "pasa"),
                          key=lambda r: r["t_ms"]):
            entry = int(row["t_ms"])
            if entry < free_at:                     # one position at a time, like the live operator
                continue
            move = row["moves"].get("240")
            if move is None:
                continue
            long = row["real_action"] == "LARGO"
            end = entry + LIVE_HOLD_MS
            paid, covered = line.accrue(entry, end, 100.0, long) if line is not None else (0.0, 0)
            funding_bp = float(paid) / 100.0 * 10_000
            status = "complete" if covered >= LIVE_HOLD_MS else ("partial" if covered > 0 else "unknown")
            out.append({"side": "LONG" if long else "SHORT", "entry_time_ms": entry, "exit_time_ms": end,
                        "net_bp": (move if long else -move) - row["cost_bp"] - funding_bp,
                        "funding_usd": float(paid), "funding_status": status, "exit_reason": "time",
                        "source": "photo"})
            free_at = end
        return out

    def live_trades(self, product_id):
        if not self.live_db_path or not os.path.isfile(self.live_db_path):
            return []
        db = sqlite3.connect("file:{}?mode=ro".format(self.live_db_path), uri=True, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            rows = db.execute("SELECT * FROM trades WHERE product=? AND status='closed' AND net_bp IS NOT NULL "
                              "AND exit_ms IS NOT NULL", (product_id,)).fetchall()
        except sqlite3.OperationalError:
            return []
        finally:
            db.close()
        out = []
        for r in rows:
            held = int(r["exit_ms"]) - int(r["entry_ms"])
            status = r["funding_status"] or "unknown"
            out.append({"side": r["side"], "entry_time_ms": int(r["entry_ms"]), "exit_time_ms": int(r["exit_ms"]),
                        "net_bp": float(r["net_bp"]), "entry_price": r["entry_px"], "exit_price": r["exit_px"],
                        "quantity": r["qty"], "notional_usd": r["notional_usd"], "pnl_usd": r["net_usd"],
                        "funding_usd": r["funding_usd"] if status != "unknown" else None, "funding_status": status,
                        "funding_complete": status == "complete", "funding_held_ms": held,
                        "funding_covered_ms": held if status == "complete" else (0 if status == "unknown" else None),
                        "exit_reason": r["exit_reason"] or r["closed_by"] or "qwen", "source": "live"})
        return out

    def __call__(self, spec, product_id, tick_size, ones, fives, funding, start_ms, end_ms, chunk):
        trades = self.photo_trades(product_id, funding) + self.live_trades(product_id)
        chunk(1.0)
        trades = [t for t in trades if start_ms <= t["entry_time_ms"] and t["exit_time_ms"] <= end_ms]
        return sorted(trades, key=lambda t: t["entry_time_ms"]), 0


def model_subject(strategy_id, kronos_dir=None, qwen_exit_dir=None, qwen_live_dir=None):
    """``(spec, trade_source)`` for Kronos or Qwen; the directories are where their databases live."""
    kronos_dir = kronos_dir or os.path.join(ROOT, "data", "kronos")
    qwen_exit_dir = qwen_exit_dir or os.path.join(ROOT, "data", "dev-live", "qwen-exit")
    if strategy_id == KRONOS_ID:
        return model_spec(KRONOS_ID), RecordedTrades(os.path.join(kronos_dir, "kronos.sqlite"), "trade")
    if strategy_id == QWEN_ID:
        return model_spec(QWEN_ID), RecordedTrades(os.path.join(qwen_exit_dir, "qwen-exit.sqlite"), "qwen_exit_trade")
    if strategy_id == QWEN_LIVE_ID:
        from . import futures_qwen_trader as qt
        exam_db = os.environ.get(QWEN_EXAM_DB_ENV) or qt.DEFAULT_EXAM_DB_V3
        return model_spec(QWEN_LIVE_ID), QwenLiveTrades(os.path.join(qwen_live_dir or QWEN_LIVE_DIR, "live.sqlite"), exam_db)
    raise KeyError(strategy_id)


__all__ = ["KRONOS_ID", "QWEN_ID", "QWEN_LIVE_ID", "QwenLiveTrades", "is_model", "model_spec", "model_subject", "RecordedTrades", "strategy_purge"]
