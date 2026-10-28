"""Qwen (C31, exits) and Kronos as subjects of the strategy gate.

Neither is a rule spec: ``propose_spec``/``Book`` cannot replay them, because every decision comes from a local model
(llama-server for Qwen, Kronos weights for Kronos) that is not available to the gate. The gate therefore judges
what each of them DID: the trades recorded in their own databases (``qwen-exit.sqlite`` and ``kronos.sqlite``,
opened read-only), through the same ``trade_source`` hook, statistics, costs, folds and rules as any strategy.

Consequence, said in every report: the models have no recorded history before they started, so the practice
window (before the cutoff) has no trades and cannot judge them; the final exam (after the cutoff) judges the
recorded ones. Re-running a model over old candles needs the model itself and hours of compute, and is not done.
"""

import datetime
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
KRONOS_NOTE = ("Kronos no se puede volver a correr sobre velas viejas (necesita el modelo local y horas de cálculo): se "
               "juzgan las operaciones que hizo en tiempo real desde que empezó a operar. Sus etapas son tramos "
               "consecutivos de esa operación y el examen es el tramo más reciente; se pueden repetir.")


def is_model(strategy_id):
    return strategy_id in (KRONOS_ID, QWEN_ID, QWEN_LIVE_ID)


def is_repeatable(strategy_id):
    """Qwen and Kronos may repeat every stage, the exam included, as often as wanted (owner decision, 2026-10-25).
    That is safe only because the gate never feeds anything back to them: it reads what they recorded in real time
    (read-only), never asks them again, and only counts trades made by the configuration under test."""
    return strategy_id in (KRONOS_ID, QWEN_LIVE_ID)


_MONTHS = ("ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic")
KRONOS_STAGE_PARTS = 6      # five practice stages and, last and most recent, the exam


def has_own_history(strategy_id):
    """Kronos' stages are cut from its own recorded operation, not from the 2025 market windows."""
    return strategy_id == KRONOS_ID


def _day_label(day):
    return "{} {}".format(day.day, _MONTHS[day.month - 1])


def kronos_stages(db_path, now_ms, parts=KRONOS_STAGE_PARTS):
    """Kronos' real operation (forward trades, never the backtest) cut into ``parts`` consecutive tramos of equal
    trade count, each starting on a whole UTC day. ``{"practice": [...], "exam": {...} | None}``; the exam is the
    newest tramo and runs to now. Empty when it has not traded."""
    entries = []
    if db_path and os.path.isfile(db_path):
        db = sqlite3.connect("file:{}?mode=ro".format(db_path), uri=True, timeout=10)
        try:
            columns = {r[1] for r in db.execute("PRAGMA table_info(trade)")}
            only_forward = " WHERE mode<>'backtest'" if "mode" in columns else ""
            for (payload,) in db.execute("SELECT payload FROM trade{}".format(only_forward)):
                trade = json.loads(payload)
                if trade.get("net_bp") is not None:
                    entries.append(int(trade["entry_time_ms"]))
        except sqlite3.OperationalError:
            entries = []
        finally:
            db.close()
    if not entries:
        return {"practice": [], "exam": None}
    entries.sort()
    day_of = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).date()
    first, last = day_of(entries[0]), day_of(now_ms)
    cuts = [first]
    for i in range(1, parts):
        day = day_of(entries[len(entries) * i // parts])
        if day > cuts[-1]:
            cuts.append(day)
    ends = cuts[1:] + [last + datetime.timedelta(days=1)]
    tramos = [{"label": "{}–{}".format(_day_label(a), _day_label(b - datetime.timedelta(days=1))),
               "from": a.isoformat(), "to": b.isoformat()} for a, b in zip(cuts, ends)]
    exam = dict(tramos[-1], to=None)
    return {"practice": tramos[:-1], "exam": exam}


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


def live_config_hash(qwen_live_dir=None):
    """The configuration identity the live database was made with (its own ``meta``), else the config file's. The live
    process refuses a database made with another configuration, so one database is one configuration: a changed
    prompt, size or product list is a new version here too and never inherits the trades of the old one."""
    from . import futures_qwen_trader as qt
    path = os.path.join(qwen_live_dir or QWEN_LIVE_DIR, "live.sqlite")
    if os.path.isfile(path):
        try:
            db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=10)
            try:
                row = db.execute("SELECT value FROM meta WHERE key='config_hash'").fetchone()
            finally:
                db.close()
            if row and row[0]:
                try:                                  # the live process stores its meta values as JSON: «"abc…"»
                    value = json.loads(row[0])
                except ValueError:
                    value = row[0]
                return value if isinstance(value, str) else row[0]
        except sqlite3.Error:
            pass
    return qt.config_hash(_read(QWEN_LIVE_CONFIG))


def model_spec(strategy_id, qwen_live_dir=None):
    """A stand-in for the spec (id, name, version and the model's descriptor) whose digest names the version."""
    if strategy_id == KRONOS_ID:
        descriptor = _read(KRONOS_CONFIG)
        return _canonical(dict(descriptor, id=KRONOS_ID, kind="model", name=descriptor.get("name", "Kronos")))
    if strategy_id == QWEN_ID:
        config = _read(QWEN_CONFIG)
        config = {k: v for k, v in config.items() if k not in ("off", "note")}
        return _canonical(dict(config, id=QWEN_ID, kind="qwen_exit", version=1, name="Qwen decide salidas"))
    if strategy_id == QWEN_LIVE_ID:
        config = _read(QWEN_LIVE_CONFIG)
        return _canonical({"id": QWEN_LIVE_ID, "kind": "qwen_live", "version": 1, "name": "Qwen en vivo",
                           "products": config["products"], "notional_usd": config["notional_usd"],
                           "leverage": config.get("leverage", "1"), "config_hash": live_config_hash(qwen_live_dir)})
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
            columns = {r[1] for r in db.execute("PRAGMA table_info({})".format(self.table))}
            # Kronos' backtest rows ran on history it was pre-trained on: they are never evidence.
            only_forward = " AND mode<>'backtest'" if "mode" in columns else ""
            rows = db.execute("SELECT payload FROM {} WHERE product_id=?{}".format(self.table, only_forward),
                              (product_id,)).fetchall()
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


LIVE_NOTE = ("Qwen en vivo se juzga sin llamar al modelo. Práctica (antes de la fecha de corte): se repite sobre las velas viejas "
             "el esquema que opera en paper (la fórmula decide: maestro fuerte y portero a favor, una posición por producto, sale "
             "cuando el maestro se da vuelta o por el cierre de seguridad), con costos y funding reales. Es lo que decide la "
             "fórmula, no la opinión de Qwen (esa se mide aparte, en la Prueba rápida). Examen (desde la fecha de corte): sus "
             "operaciones reales en paper, cerradas; las abiertas no cuentan.")

def scheme_replay(product_id, funding, start_ms, end_ms):
    """The live scheme (formula decides, safety close, exit when the maestro turns) over the old candles, no model needed.
    Candles come from the exam's cache (fetched once from Kraken's public API). Never reaches the holdout."""
    from . import futures_qwen_live as live
    from . import futures_qwen_trader as qt
    from . import futures_qwen_trader_exam as exam
    from . import futures_qwen_exigencia as exigencia
    from . import futures_qwen_analista as analista
    # niveles de la prueba (5 y 5: paper) y modo del analista de movimiento (apagado: paper)
    from . import futures_walkforward as walkforward
    cfg = analista.apply_env(exigencia.apply_env(live.apply_overrides(qt.load_config(qt.CONFIG_PATH_LIVE))))
    if walkforward.medicion_from_env() == "honesta":      # each quarter with the formulas fitted only on what came before it
        cfg = walkforward.honest_cfg(cfg, products=cfg["products"], cap_min=cfg["guardrails"]["max_hold_min"])
    holdout_ms = qt.load_holdout_ms()
    if start_ms >= holdout_ms or product_id not in cfg["products"]:
        return []
    history = qt.History(qt.DEFAULT_CACHE, holdout_ms)
    first = qt.date_ms(cfg["practice"]["from"]) - (cfg["practice"]["warmup_days"] + analista.extra_days(cfg)) * qt.DAY_MS
    for name in dict.fromkeys(list(cfg["products"]) + list(cfg.get("state_context") or ())):
        history.prefetch(name, first, holdout_ms, log=lambda *a: None)
    return exam.scheme_trades(history, cfg, product_id, start_ms, end_ms, holdout_ms, funding)


class QwenLiveTrades:
    """``trade_source`` of the live Qwen operator: answered photos before the cut, its own closed paper trades after it."""

    @property
    def note(self):
        from . import futures_qwen_exigencia as exigencia
        got = exigencia.from_env()
        from . import futures_qwen_analista as analista
        mode = analista.from_env()
        return "{} Exigencia de esta prueba: maestro {} y portero {} (de 0 a 10; {} es lo que opera en paper).{}".format(
            LIVE_NOTE, got["maestro"], got["portero"], exigencia.DEFAULT,
            "" if mode == analista.DEFAULT else " Analista de movimiento: {} (tamaño {} con movimiento, {} en calma).".format(
                mode, *analista.MODES[mode]))

    def __init__(self, live_db_path, exam_db_path, replay=None):
        self.live_db_path, self.exam_db_path = live_db_path, exam_db_path
        self.replay = replay or scheme_replay


    def photo_trades(self, product_id, funding):
        """The extremes of the lean (the exam's own criterion): long on the fifth of photos where the numbers lean most
        to LARGO, short on the fifth that lean most to CORTO. Qwen almost never answers LARGO/CORTO outright, so the
        entries come from its probabilities, not from its chosen action."""
        if not self.exam_db_path or not os.path.isfile(self.exam_db_path):
            return []
        from . import futures_qwen_trader as qt
        from . import futures_qwen_trader_exam as exam
        cfg = qt.load_config(qt.CONFIG_PATH_LIVE)
        share = cfg["exam_lean"]["extreme_share"]
        try:
            rows, meta = exam.load_answers(self.exam_db_path)
        except sqlite3.OperationalError:
            return []
        # The photos count only if they were asked with the configuration of the live version under judgement (the hash its
        # database carries): answers from another prompt or config are never mixed in (a changed one means asking every photo
        # again, ``exam --version live``).
        if meta.get("config_hash") != live_config_hash(os.path.dirname(self.live_db_path) if self.live_db_path else None):
            return []
        # lean_num (the part that comes from the numbers) needs the mirrored question. While the photos have not been
        # mirrored, the plain lean (p LARGO - p CORTO on the real numbers) orders them: weaker, and said in the report.
        key = "lean_num" if any(r.get("lean_num") is not None for r in rows) else "lean"
        pool = sorted((r for r in rows if r.get(key) not in (None, 0) and r["moves"].get("240") is not None),
                      key=lambda r: r[key])
        k = max(1, int(len(pool) * share)) if pool else 0
        side_of = {r["snap_id"]: -1 for r in pool[:k]}
        side_of.update({r["snap_id"]: 1 for r in pool[len(pool) - k:]})
        line = qt.FundingLine([(r[0], r[1]) for r in funding]) if funding else None
        out, free_at = [], 0
        for row in sorted((r for r in pool if r["product"] == product_id and r["snap_id"] in side_of),
                          key=lambda r: r["t_ms"]):
            entry = int(row["t_ms"])
            if entry < free_at:                     # one position at a time, like the live operator
                continue
            long = side_of[row["snap_id"]] > 0
            move = row["moves"]["240"]
            end = entry + LIVE_HOLD_MS
            paid, covered = line.accrue(entry, end, qt.D(100), long) if line is not None else (0.0, 0)
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
        trades = self.replay(product_id, funding, start_ms, end_ms) + self.live_trades(product_id)
        chunk(1.0)
        trades = [t for t in trades if start_ms <= t["entry_time_ms"] and t["exit_time_ms"] <= end_ms]
        return sorted(trades, key=lambda t: t["entry_time_ms"]), 0


def model_subject(strategy_id, kronos_dir=None, qwen_exit_dir=None, qwen_live_dir=None):
    """``(spec, trade_source)`` for Kronos or Qwen; the directories are where their databases live."""
    kronos_dir = kronos_dir or os.path.join(ROOT, "data", "kronos")
    qwen_exit_dir = qwen_exit_dir or os.path.join(ROOT, "data", "dev-live", "qwen-exit")
    if strategy_id == KRONOS_ID:
        source = RecordedTrades(os.path.join(kronos_dir, "kronos.sqlite"), "trade")
        source.note = KRONOS_NOTE
        return model_spec(KRONOS_ID), source
    if strategy_id == QWEN_ID:
        return model_spec(QWEN_ID), RecordedTrades(os.path.join(qwen_exit_dir, "qwen-exit.sqlite"), "qwen_exit_trade")
    if strategy_id == QWEN_LIVE_ID:
        from . import futures_qwen_trader as qt
        exam_db = os.environ.get(QWEN_EXAM_DB_ENV) or qt.DEFAULT_EXAM_DB_LIVE
        return model_spec(QWEN_LIVE_ID, qwen_live_dir), QwenLiveTrades(os.path.join(qwen_live_dir or QWEN_LIVE_DIR, "live.sqlite"), exam_db)
    raise KeyError(strategy_id)


__all__ = ["has_own_history", "kronos_stages", "KRONOS_ID", "QWEN_ID", "QWEN_LIVE_ID", "QwenLiveTrades", "is_model", "model_spec", "model_subject", "RecordedTrades", "strategy_purge"]
