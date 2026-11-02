"""Qwen operador EN VIVO (paper): el mismo ``Trader`` de la práctica, alimentado con velas públicas reales.

Sin claves, sin cuenta y sin órdenes reales: solo lee velas de 5 minutos y el funding PÚBLICOS de Kraken Futures
(``futures_history``) y le pregunta al llama-server local (127.0.0.1). Todo lo que "opera" es contabilidad en papel con los
costos reales de Kraken (``futures_costs``: 0,02 % maker / 0,05 % taker) y el funding publicado, calculados con ``settle``,
la misma cuenta que usa la práctica sobre historia (live == replay).

Con ``decide_by=formula`` deciden las fórmulas y Qwen solo opina; ``opinion_enabled=false`` apaga esa opinión.
El modo opt-in ``noticias.policy=priority_v2`` usa Qwen solo para clasificar noticias: catalizadores verificados
pueden abrir o girar en velas cerradas de 5 min, con un máximo de 24 h por posición de noticias. Sin noticia,
el maestro y el portero autónomo deben coincidir. La prueba histórica de fórmulas no simula esta política.
La cuenta entera limita entradas al saldo disponible, reservando la comisión de entrada; no redimensiona lo abierto.

Diseño histórico de la versión 8 (``config/qwen-live-v7.json`` conserva la versión anterior)
    * Cada 15 minutos, con o sin posición, y NUNCA en otro momento: no hay despertares extra (movimiento fuerte, cerca del
      stop, funding, movimiento grande). La clave de cada despertar es (producto, ventana de 15 minutos).
    * Qwen abre y cierra. Guardrails que no puede cambiar (versión 8): sin stop, cierre obligatorio a las 48 h y espera de
      15 min después de cerrar. Tamaño fijo de 100 USD.
    * Si el modelo está caído o lento, ese despertar queda anotado como OMITIDO con el motivo y no se reintenta después:
      nunca se inventa una decisión y sin respuesta no se opera. Lo mismo si la ficha está incompleta (``datos_incompletos``):
      los datos viejos o faltantes no se le muestran.
    * Versión 8 de la config (``state_corta``): el estado es la FICHA CORTA (``futures_qwen_corta``): el veredicto del maestro de
      dirección (``futures_qwen_maestro``, 12 h), el del portero (``futures_qwen_portero``, ¿conviene entrar ahora?), el régimen
      de volatilidad y la posición abierta. Las dos fórmulas corren en CPU. Preguntas de letras (LARGO / CORTO / ESPERAR con
      espejo; MANTENER / CERRAR), sin ventana de oportunidad y sin adaptador LoRA. La versión 7 (ficha de 8 factores, pregunta
      por factores, adaptador) queda congelada en ``config/qwen-live-v7.json`` para el examen y el LoRA.

Una base propia (``data/qwen-live/live.sqlite`` o ``QWEN_LIVE_DB``) y UN solo proceso por base (candado de archivo). Si el
proceso se reinicia, recupera la posición abierta y no repite un despertar ya decidido. Si la base es de OTRA configuración
(cambió la versión del prompt, el tamaño, los productos...), el arranque se rechaza sin cerrar ni renombrar nada.
``--activate-flat-config`` cambia de versión sobre la misma cuenta solo si está sin posiciones; no archiva ni reinicia dinero.

    python -m balancita_engine.futures_qwen_live                      # corre hasta Ctrl+C
    python -m balancita_engine.futures_qwen_live --export datos.jsonl  # decisiones para reentrenar offline (sin modelo)
    python -m balancita_engine.futures_qwen_live --positioning-db RUTA # otra base del colector para el renglón F6
"""

import argparse
import copy
import hashlib
import json
import os
import signal
import sqlite3
import sys
import time
from decimal import Decimal

from . import futures_auditor as auditor
from . import futures_llm_decisions as llm
from . import futures_qwen_analista as analista
from . import futures_qwen_aprende as aprende
from . import futures_qwen_factors as fq
from . import futures_qwen_noticias as noticias
from . import futures_qwen_trader as qt
from . import positioning_data
from .futures_costs import round_trip_cost_bps
from .futures_products import is_product_id
from .futures_history import (DAY_MS, HOUR_MS, MINUTE_MS, CandleCache, HistoryError, fetch_candles, fetch_funding,
                              fill_gaps)

D = Decimal
OPEN_TRADE_QUERY = "SELECT 1 FROM trades WHERE status='open' LIMIT 1"
OPEN_POSITION_QUERY = "SELECT 1 FROM trader_state WHERE position_json IS NOT NULL LIMIT 1"
BAR_MS = qt.BAR_MS
BUCKET_MS = 15 * MINUTE_MS                      # one wake per product and bucket
DB_ENV = "QWEN_LIVE_DB"
DEFAULT_DIR = os.path.join(qt.ROOT, "data", "qwen-live")
DEFAULT_DB = os.path.join(DEFAULT_DIR, "live.sqlite")
DEFAULT_CACHE = os.path.join(DEFAULT_DIR, "cache")
SCHEMA_VERSION = 1
SOURCE = "live"
POSITIONING_KEEP_MS = 3 * DAY_MS                # F6 needs the last bucket and the one 24 h before: no need to read two years
CONTEXT_KEEP_MS = 3 * DAY_MS                    # F7 needs 24 h of the other assets

# Motivos de un despertar omitido (se guardan tal cual y se muestran en la Terminal).
SKIP_TEXT = {
    "modelo_caido": "el modelo local no respondió",
    "modelo_lento": "el modelo local tardó más de lo permitido",
    "sin_respuesta": "el modelo contestó algo que no se pudo leer",
    "proceso_detenido": "el proceso estaba apagado a esa hora",
    "datos_incompletos": "la ficha estaba incompleta (faltaban datos), no se le preguntó",
    "saldo_insuficiente": "no hay saldo disponible para abrir la operación",
    "libro_no_disponible": "no se pudo recibir el libro público",
    "libro_invalido": "el libro público no es válido",
    "libro_obsoleto": "el libro público perdió vigencia",
    "liquidez_insuficiente": "el libro no cubre toda la operación",
    "ejecucion_tarde": "la decisión venció antes de ejecutarse",
}


class LockError(qt.TraderError):
    """Another process already writes this database."""


# --------------------------------------------------------------------------- size, leverage and products


def _positive(text, name):
    try:
        value = D(str(text).strip())
    except Exception:
        value = None
    if value is None or not value.is_finite() or value <= 0:
        raise qt.TraderError("{}: tiene que ser un número mayor que cero (llegó {!r})".format(name, text))
    return value


def _non_negative(raw, name):
    try:
        number = D(raw)
    except Exception:
        number = None
    if number is None or not number.is_finite() or number < 0:
        raise qt.TraderError("{}: tiene que ser un número, 0 o más; llegó {!r}".format(name, raw))
    return float(number)


def _apply_window_overrides(out, env):
    window_keys = (
        ("QWEN_LIVE_FORCE_SIDE_AFTER_H", "force_side_after_h"),
        ("QWEN_LIVE_FORCE_WINDOW_H", "force_window_h"),
        ("QWEN_LIVE_FORCE_MIN_LOOKS", "force_min_looks"),
        ("QWEN_LIVE_FORCE_NEUTRAL_LEAN", "force_neutral_lean"),
        ("QWEN_LIVE_FORCE_MIN_SCORE", "force_min_score"),
        ("QWEN_LIVE_FORCE_RECORD_TOL", "force_record_tol"),
    )
    for name, key in window_keys:
        raw = (env.get(name) or "").strip()
        if raw:
            out.setdefault("live", {})[key] = _non_negative(raw, name)


def _validate_products(product_list):
    if not product_list or len(set(product_list)) != len(product_list):
        raise qt.TraderError("QWEN_LIVE_PRODUCTS: hace falta al menos un producto y sin repetir")
    for product in product_list:
        if not is_product_id(product):
            raise qt.TraderError("producto inválido: {!r} (ejemplo: PF_XBTUSD)".format(product))


def apply_overrides(cfg, env=None):
    """The config with what the owner may change by environment."""
    env = os.environ if env is None else env
    out = copy_config(cfg)
    notional = (env.get("QWEN_LIVE_NOTIONAL_USD") or "").strip()
    leverage = (env.get("QWEN_LIVE_LEVERAGE") or "").strip()
    products = (env.get("QWEN_LIVE_PRODUCTS") or "").strip()
    _apply_window_overrides(out, env)
    out["notional_usd"] = format(_positive(notional or out["notional_usd"], "QWEN_LIVE_NOTIONAL_USD").normalize(), "f")
    out["leverage"] = format(_positive(leverage or out.get("leverage", "1"), "QWEN_LIVE_LEVERAGE").normalize(), "f")
    if products:
        out["products"] = [p.strip() for p in products.split(",") if p.strip()]
    _validate_products(out["products"])
    return analista.apply_env(out, env)


def copy_config(cfg):
    return json.loads(json.dumps(cfg))


# --------------------------------------------------------------------------- one process per database


def _try_lock(fd):
    try:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except ImportError:                                   # Windows
        import msvcrt
        os.lseek(fd, 0, os.SEEK_SET)
        getattr(msvcrt, "locking")(fd, getattr(msvcrt, "LK_NBLCK"), 1)


class ProcessLock:
    """Exclusive file lock beside the database (``<db>.lock``). The operating system frees it when the process dies, so a
    crash never leaves a stale lock behind."""

    def __init__(self, db_path):
        self.path = os.path.abspath(db_path) + ".lock"
        self.db_path = os.path.abspath(db_path)
        self.fd = None

    def acquire(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            _try_lock(fd)
        except OSError:
            pid = ""
            try:
                pid = os.pread(fd, 32, 0).decode("ascii", "ignore").strip()
            except OSError:
                pass
            os.close(fd)
            raise LockError(
                "Qwen en vivo: ya está escribiendo esta base otro proceso{} ({}). Hay un solo proceso por base: cerralo "
                "primero o usá otra base con QWEN_LIVE_DB.".format(" (pid {})".format(pid) if pid else "", self.db_path))
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode("ascii"))
        self.fd = fd
        return self

    def release(self):
        if self.fd is not None:
            try:
                os.close(self.fd)                         # closing the descriptor drops the lock
            finally:
                self.fd = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()


# --------------------------------------------------------------------------- the live database

DEFAULT_ACCOUNT_START_USD = "1000"

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account(
  id INTEGER PRIMARY KEY CHECK(id=1), initial_usd TEXT NOT NULL, created_ms INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS account_no_update BEFORE UPDATE ON account
BEGIN SELECT RAISE(ABORT,'account genesis is immutable'); END;
CREATE TRIGGER IF NOT EXISTS account_no_delete BEFORE DELETE ON account
BEGIN SELECT RAISE(ABORT,'account genesis is immutable'); END;
CREATE TRIGGER IF NOT EXISTS account_no_replace BEFORE INSERT ON account WHEN EXISTS(SELECT 1 FROM account)
BEGIN SELECT RAISE(ABORT,'account genesis already exists'); END;
CREATE TABLE IF NOT EXISTS config_versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, previous_hash TEXT, config_hash TEXT NOT NULL,
  activated_ms INTEGER NOT NULL, config_json TEXT NOT NULL, cash_usd TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS config_versions_no_update BEFORE UPDATE ON config_versions
BEGIN SELECT RAISE(ABORT,'configuration history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS config_versions_no_delete BEFORE DELETE ON config_versions
BEGIN SELECT RAISE(ABORT,'configuration history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS config_versions_no_replace BEFORE INSERT ON config_versions
WHEN EXISTS(SELECT 1 FROM config_versions WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'configuration history is append-only'); END;
CREATE TABLE IF NOT EXISTS decisions(
  product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, decided_at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL, action TEXT NOT NULL, model_action TEXT, p_action REAL, confidence REAL, probs_json TEXT,
  orders_json TEXT, override TEXT, reason TEXT, reason_json TEXT, mirror_action TEXT, mirror_p REAL, wake_json TEXT,
  state_text TEXT, state_hash TEXT, latency_ms INTEGER, threshold REAL, prompt_version TEXT, prompt_hash TEXT, model TEXT,
  config_hash TEXT, position_json TEXT, net_bp_now REAL, trade_no INTEGER,
  lean REAL, lean_m REAL, lean_num REAL, score REAL, best_score REAL, look_n INTEGER, mirror_ok INTEGER, factors_json TEXT,
  formula_action TEXT, formula_json TEXT, opinion_agrees INTEGER, opinion_error TEXT,
  PRIMARY KEY(product, bucket_ms));
CREATE TABLE IF NOT EXISTS examples(
  product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
  label_json TEXT NOT NULL, resolved_ms INTEGER NOT NULL, PRIMARY KEY(product, bucket_ms));
CREATE TABLE IF NOT EXISTS skipped(
  product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, at_ms INTEGER NOT NULL, reason TEXT NOT NULL,
  detail TEXT, wake_json TEXT, PRIMARY KEY(product, bucket_ms));
CREATE TABLE IF NOT EXISTS trades(
  product TEXT NOT NULL, trade_no INTEGER NOT NULL, status TEXT NOT NULL, side TEXT NOT NULL, entry_ms INTEGER NOT NULL,
  exit_ms INTEGER, entry_px TEXT, exit_px TEXT, qty TEXT, notional_usd TEXT, gross_usd TEXT, fees_usd TEXT,
  funding_usd TEXT, net_usd TEXT, net_bp REAL, funding_status TEXT, closed_by TEXT, exit_reason TEXT, entry_reason TEXT,
  entry_p REAL, hold_min INTEGER, mfe_bp REAL, mae_bp REAL, stop_px REAL, max_hold_ms INTEGER, mark_px REAL,
  mark_ms INTEGER, net_now_usd TEXT, opened_at_ms INTEGER, closed_at_ms INTEGER, leverage TEXT, margin_usd TEXT,
  PRIMARY KEY(product, trade_no));
CREATE TABLE IF NOT EXISTS errors(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, place TEXT NOT NULL, product TEXT, kind TEXT NOT NULL,
  detail TEXT);
CREATE TABLE IF NOT EXISTS execution_receipts(
  receipt_id TEXT PRIMARY KEY, product TEXT NOT NULL, trade_no INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('entry','exit','mark','funding')),
  signal_ms INTEGER NOT NULL, recorded_at_ms INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL, evidence_json TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS execution_receipts_single_leg
ON execution_receipts(product,trade_no,purpose) WHERE purpose IN ('entry','exit');
CREATE TRIGGER IF NOT EXISTS execution_receipts_no_update BEFORE UPDATE ON execution_receipts
BEGIN SELECT RAISE(ABORT,'execution evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS execution_receipts_no_delete BEFORE DELETE ON execution_receipts
BEGIN SELECT RAISE(ABORT,'execution evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS execution_receipts_no_replace BEFORE INSERT ON execution_receipts
WHEN EXISTS(SELECT 1 FROM execution_receipts WHERE receipt_id=NEW.receipt_id)
BEGIN SELECT RAISE(ABORT,'execution evidence already exists'); END;
CREATE TABLE IF NOT EXISTS news_actions(
  product TEXT NOT NULL, event_id TEXT NOT NULL, consumed_ms INTEGER NOT NULL,
  action TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY(product,event_id));
CREATE TABLE IF NOT EXISTS trader_state(
  product TEXT PRIMARY KEY, last_fed_ms INTEGER, trade_seq INTEGER NOT NULL, cooldown_until INTEGER NOT NULL,
  last_call_ms INTEGER, position_json TEXT, updated_ms INTEGER NOT NULL, window_json TEXT);
"""

_ADDED_COLUMNS = {
    "decisions": (("lean", "REAL"), ("lean_m", "REAL"), ("lean_num", "REAL"), ("score", "REAL"), ("best_score", "REAL"),
                  ("look_n", "INTEGER"), ("mirror_ok", "INTEGER"), ("factors_json", "TEXT"),
                  ("formula_action", "TEXT"), ("formula_json", "TEXT"), ("opinion_agrees", "INTEGER"), ("opinion_error", "TEXT")),
    "trader_state": (("window_json", "TEXT"),),
    "trades": (("funding_model", "TEXT"), ("net_complete_usd", "TEXT"), ("config_hash", "TEXT"),
               ("execution_model", "TEXT"), ("entry_receipt_id", "TEXT"), ("exit_receipt_id", "TEXT"),
               ("mark_receipt_id", "TEXT"), ("funding_receipt_id", "TEXT"), ("execution_error", "TEXT"),
               ("exit_plan_json", "TEXT")),
}

_TRADE_COLUMNS = ("status", "side", "entry_ms", "exit_ms", "entry_px", "exit_px", "qty", "notional_usd", "gross_usd",
                  "fees_usd", "funding_usd", "net_usd", "net_bp", "funding_status", "closed_by", "exit_reason",
                  "entry_reason", "entry_p", "hold_min", "mfe_bp", "mae_bp", "stop_px", "max_hold_ms", "mark_px",
                  "mark_ms", "net_now_usd", "opened_at_ms", "closed_at_ms", "leverage", "margin_usd",
                  "funding_model", "net_complete_usd", "config_hash", "execution_model", "entry_receipt_id",
                  "exit_receipt_id", "mark_receipt_id", "funding_receipt_id", "execution_error")


def position_to_json(position):
    body = {"side": position.side, "entry_ms": position.entry_ms, "entry_ref": position.entry_ref,
            "entry_px": str(position.entry_px), "qty": str(position.qty), "stop_px": position.stop_px,
            "stop_pct": position.stop_pct, "max_hold_ms": position.max_hold_ms, "entry_p": position.entry_p,
            "entry_reason": position.entry_reason, "trade_no": position.trade_no, "mfe_bp": position.mfe_bp,
            "mae_bp": position.mae_bp, "funding_model": position.funding_model}
    if position.notional_usd is not None:
        body["notional_usd"] = str(position.notional_usd)
    if position.news_armed is not None:
        body["news_armed"] = position.news_armed
    if position.entry_execution is not None:
        body["entry_execution"] = position.entry_execution
    if position.exit_plan is not None:
        body["exit_plan"] = position.exit_plan
    return json.dumps(body, sort_keys=True)


def position_from_json(text):
    raw = json.loads(text)
    raw["entry_px"], raw["qty"] = D(raw["entry_px"]), D(raw["qty"])
    if raw.get("notional_usd") is not None:
        raw["notional_usd"] = D(str(raw["notional_usd"]))
    if raw.get("entry_execution") is not None:
        from . import futures_book_execution as book
        fill = book.replay_fill(raw["entry_execution"])
        if (fill.purpose != "entry" or fill.price != raw["entry_px"] or fill.quantity != raw["qty"]
                or fill.executed_at_ms != raw["entry_ms"]
                or raw["entry_execution"].get("funding_model") != raw.get("funding_model")):
            raise qt.TraderError("La posición guardada contradice su recibo de entrada.")
    plan = raw.get("exit_plan")
    if plan is not None and (not isinstance(plan, dict) or plan.get("schema") != qt.maker_exit.SCHEMA
                             or plan.get("position_side") != raw["side"] or not plan.get("orders")):
        raise qt.TraderError("La posición guardada tiene una orden de salida inválida.")
    return qt.Position(**raw)


def identity_of(cfg):
    """Active strategy version; the permanent account genesis and previous versions are independent of this pointer."""
    return {"schema_version": SCHEMA_VERSION, "config_hash": qt.config_hash(cfg), "prompt_version": cfg["prompt"]["version"],
            "products": list(cfg["products"])}


class LiveStore:
    """The live database. Single writer (the process holds the lock); the gateway opens it read-only. Writes of one candle
    are one transaction (``with store.db:``), so a crash leaves either all of it or none."""

    def __init__(self, path, readonly=False):
        self.path = path
        if readonly:
            self.db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
        else:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            self.db = sqlite3.connect(path, timeout=30)
            self.db.executescript(_SCHEMA_SQL)
            self._add_missing_columns()
        self.db.row_factory = sqlite3.Row

    def _add_missing_columns(self):
        """Bases written by an older version get the new columns (appended, NULL): they stay valid."""
        for table, columns in _ADDED_COLUMNS.items():
            have = {r[1] for r in self.db.execute("PRAGMA table_info({})".format(table))}
            for name, kind in columns:
                if name not in have:
                    self.db.execute("ALTER TABLE {} ADD COLUMN {} {}".format(table, name, kind))
        self.db.commit()

    def close(self):
        self.db.close()

    # ---- identity

    def meta(self):
        return {r["key"]: json.loads(r["value"]) for r in self.db.execute("SELECT key, value FROM meta")}

    def set_meta(self, key, value):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, json.dumps(value)))

    def put_error(self, at_ms, place, product, kind, detail):
        with self.db:
            self.db.execute("INSERT INTO errors(at_ms, place, product, kind, detail) VALUES(?,?,?,?,?)",
                            (at_ms, place, product, kind, str(detail)[:2000]))

    def check_identity(self, cfg, *, account_start_usd=DEFAULT_ACCOUNT_START_USD):
        """Resume the active version; changing rules needs an explicit flat-only transition, never a new wallet."""
        wanted = identity_of(cfg)
        stored = self.meta()
        for key, value in wanted.items():
            if key in stored and stored[key] != value:
                raise qt.TraderError(
                    "Qwen en vivo: esta base se hizo con otra configuración ({} era {!r} y ahora es {!r}). "
                    "Conservá esta cuenta y usá --activate-flat-config cuando no haya operaciones abiertas."
                    .format(key, stored[key], value))
        with self.db:
            initial = (cfg["notional_usd"] if stored.get("config_hash") and cfg.get("cuenta") == "entera"
                       else account_start_usd)
            self._ensure_account(initial)
            for key, value in wanted.items():
                if key not in stored:
                    self.db.execute("INSERT INTO meta VALUES(?,?)", (key, json.dumps(value)))
            if self.db.execute("SELECT 1 FROM config_versions LIMIT 1").fetchone() is None:
                self._record_config(cfg, None, int(time.time() * 1000))

    def _ensure_account(self, initial_usd):
        if self.db.execute("SELECT 1 FROM account WHERE id=1").fetchone() is None:
            initial = _positive(initial_usd, "capital inicial de la cuenta")
            self.db.execute("INSERT INTO account VALUES(1,?,?)", (format(initial, "f"), int(time.time() * 1000)))
        self.initial_balance_usd()

    def initial_balance_usd(self):
        row = self.db.execute("SELECT initial_usd FROM account WHERE id=1").fetchone()
        if row is None:
            raise qt.TraderError("Cuenta paper sin inicializar; no se inventa ni reinicia el saldo.")
        return _positive(row["initial_usd"], "capital guardado de la cuenta")

    def _record_config(self, cfg, previous_hash, now_ms):
        self.db.execute(
            "INSERT INTO config_versions(previous_hash,config_hash,activated_ms,config_json,cash_usd) VALUES(?,?,?,?,?)",
            (previous_hash, qt.config_hash(cfg), now_ms, json.dumps(cfg, sort_keys=True), str(self.cash_balance_usd())))

    def activate_flat_config(self, cfg, *, now_ms=None, account_start_usd=DEFAULT_ACCOUNT_START_USD):
        """Change only the active configuration pointer, atomically, on the same flat account and trade history."""
        with self.db:
            stored = self.meta()
            wanted = identity_of(cfg)
            if not stored.get("config_hash"):
                raise qt.TraderError("No hay una cuenta de origen para cambiar de configuración.")
            if self.db.execute("SELECT 1 FROM account WHERE id=1").fetchone() is None:
                raise qt.TraderError(
                    "Primero migrá la cuenta con su configuración vigente; no se toma capital de la configuración nueva.")
            has_open = self.db.execute(OPEN_TRADE_QUERY).fetchone() is not None
            has_position = self.db.execute(
                OPEN_POSITION_QUERY).fetchone() is not None
            if has_open or has_position:
                raise qt.TraderError("Hay una operación abierta: no se corta ni se cambia su configuración.")
            self._ensure_account(account_start_usd)
            if all(stored.get(k) == v for k, v in wanted.items()):
                return
            before = self.cash_balance_usd()
            self._record_config(cfg, stored["config_hash"], int(time.time() * 1000) if now_ms is None else now_ms)
            for key, value in wanted.items():
                self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, json.dumps(value)))
            if self.cash_balance_usd() != before:
                raise qt.TraderError("La transición alteró el saldo; se revierte completa.")

    # ---- state of the trader

    def load_state(self, product):
        row = self.db.execute("SELECT * FROM trader_state WHERE product=?", (product,)).fetchone()
        return None if row is None else dict(row)

    def save_state(self, product, trader, last_fed_ms, now_ms):
        self.db.execute(
            "INSERT OR REPLACE INTO trader_state(product, last_fed_ms, trade_seq, cooldown_until, last_call_ms, position_json, "
            "updated_ms, window_json) VALUES(?,?,?,?,?,?,?,?)",
            (product, last_fed_ms, trader.trade_seq, trader.cooldown_until, trader.last_call_ms,
             None if trader.position is None else position_to_json(trader.position), now_ms,
             None if trader.window is None else json.dumps(trader.window)))

    # ---- decisions and skipped wakes

    def bucket_done(self, product, t_ms):
        bucket = t_ms - BUCKET_MS
        for table in ("decisions", "skipped"):
            if self.db.execute("SELECT 1 FROM {} WHERE product=? AND bucket_ms=?".format(table),
                               (product, bucket)).fetchone():
                return True
        return False

    def put_decision(self, product, event, meta, now_ms):
        answer = event.get("answer") or {}
        orders = answer.get("orders") or [{}]
        reason_answer = event.get("reason_answer")
        self.db.execute(
            "INSERT OR IGNORE INTO decisions(product, bucket_ms, t_ms, decided_at_ms, kind, action, model_action, p_action, "
            "confidence, probs_json, orders_json, override, reason, reason_json, mirror_action, mirror_p, wake_json, state_text, "
            "state_hash, latency_ms, threshold, prompt_version, prompt_hash, model, config_hash, position_json, net_bp_now, "
            "trade_no, lean, lean_m, lean_num, score, best_score, look_n, mirror_ok, factors_json, formula_action, formula_json, "
            "opinion_agrees, opinion_error) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (product, event["t_ms"] - BUCKET_MS, event["t_ms"], now_ms, event["kind"], event["action"],
             event.get("model_action"), event.get("p_action"), answer.get("confidence"),
             json.dumps(answer.get("probabilities")), json.dumps(orders), event.get("override"), event.get("reason"),
             json.dumps(reason_answer), event.get("mirror_action"), event.get("mirror_p"), json.dumps(event.get("wake")),
             event.get("state_text"), event.get("state_hash"), answer.get("latency_ms"), event.get("threshold"),
             str(meta["prompt_version"]), orders[0].get("prompt_hash"), meta["model"], meta["config_hash"],
             json.dumps(event.get("position")), event.get("net_bp_now"), event.get("trade_no"), event.get("lean"),
             event.get("lean_m"), event.get("lean_num"), event.get("score"), event.get("best_score"), event.get("look_n"),
             None if event.get("mirror_ok") is None else int(event["mirror_ok"]),
             None if not event.get("factors") else json.dumps(event["factors"]), event.get("formula_action"),
             None if not event.get("formula") else json.dumps(event["formula"]),
             None if event.get("opinion_agrees") is None else int(event["opinion_agrees"]), event.get("opinion_error")))

    def put_skipped(self, product, t_ms, kind, detail, wake, now_ms):
        self.db.execute("INSERT OR IGNORE INTO skipped VALUES(?,?,?,?,?,?,?)",
                        (product, t_ms - BUCKET_MS, t_ms, now_ms, kind, detail, json.dumps(wake)))

    # ---- trades

    def put_trade(self, product, trade_no, **fields):
        """Insert or update one trade; a field given as ``None`` keeps what is already there."""
        values = {name: fields.get(name) for name in _TRADE_COLUMNS}
        names = ("product", "trade_no") + _TRADE_COLUMNS
        sets = ", ".join(
            "{0}=COALESCE({0}, excluded.{0})".format(c) if c == "opened_at_ms"
            else "{0}=excluded.{0}".format(c) if c == "net_complete_usd"
            else "{0}=COALESCE(excluded.{0}, {0})".format(c) for c in _TRADE_COLUMNS)
        self.db.execute(
            "INSERT INTO trades({}) VALUES({}) ON CONFLICT(product, trade_no) DO UPDATE SET {}".format(
                ", ".join(names), ",".join("?" * len(names)), sets),
            (product, trade_no) + tuple(values[c] for c in _TRADE_COLUMNS))

    def update_trade(self, product, trade_no, **fields):
        """Changes some fields of a trade that already exists."""
        names = sorted(fields)
        self.db.execute("UPDATE trades SET {} WHERE product=? AND trade_no=?".format(", ".join(n + "=?" for n in names)),
                        tuple(fields[n] for n in names) + (product, trade_no))

    def put_execution(self, product, trade_no, evidence, recorded_at_ms):
        from . import futures_book_execution as book
        try:
            book.replay_fill(evidence)
        except book.BookError as error:
            raise qt.TraderError(error.detail) from error
        if (evidence["product"] != product or type(trade_no) is not int or trade_no <= 0
                or type(recorded_at_ms) is not int or recorded_at_ms < evidence["executed_at_ms"]):
            raise qt.TraderError("El recibo no pertenece a esta operación o todavía no estaba disponible.")
        trade = self.db.execute("SELECT side,qty,entry_ms,entry_px,execution_model FROM trades "
                                "WHERE product=? AND trade_no=?", (product, trade_no)).fetchone()
        if (trade is None or trade["execution_model"] != evidence["model"]
                or D(trade["qty"]) != D(evidence["quantity"])):
            raise qt.TraderError("La operación no corresponde al recibo de ejecución.")
        if evidence["purpose"] == "entry":
            if (evidence["side"] != trade["side"] or D(evidence["price"]) != D(trade["entry_px"])
                    or evidence["executed_at_ms"] != trade["entry_ms"]):
                raise qt.TraderError("La entrada contradice la posición guardada.")
        elif evidence["side"] != ("SHORT" if trade["side"] == "LONG" else "LONG"):
            raise qt.TraderError("La ejecución de salida tiene el lado incorrecto.")
        for period in (evidence.get("settlement") or {}).get("funding_periods", []):
            if period["known_at_ms"] > recorded_at_ms:
                raise qt.TraderError("No se registra funding antes de que haya sido recibido.")
        digest = book.canonical_hash(evidence)
        purpose = evidence["purpose"]
        key = {"product": product, "trade_no": trade_no, "purpose": purpose,
               "signal_ms": evidence["signal_at_ms"]}
        if purpose == "funding":
            key["revision"] = digest
        receipt_id = book.canonical_hash(key)
        previous = self.db.execute(
            "SELECT evidence_hash FROM execution_receipts WHERE receipt_id=?", (receipt_id,)).fetchone()
        if previous is not None:
            if previous["evidence_hash"] != digest:
                raise qt.TraderError("Un recibo existente no puede cambiar de precios ni de costes.")
            return receipt_id
        self.db.execute("INSERT INTO execution_receipts VALUES(?,?,?,?,?,?,?,?)",
                        (receipt_id, product, trade_no, purpose, evidence["signal_at_ms"],
                         recorded_at_ms, digest, json.dumps(evidence, sort_keys=True)))
        return receipt_id

    def execution_evidence(self, receipt_id, *, product=None, trade_no=None, purpose=None):
        from . import futures_book_execution as book
        row = self.db.execute("SELECT product,trade_no,purpose,evidence_hash,evidence_json "
                              "FROM execution_receipts WHERE receipt_id=?",
                              (receipt_id,)).fetchone()
        if row is None:
            raise qt.TraderError("Falta el recibo de ejecución.")
        if ((product is not None and row["product"] != product)
                or (trade_no is not None and row["trade_no"] != trade_no)
                or (purpose is not None and row["purpose"] != purpose)):
            raise qt.TraderError("El recibo pertenece a otra operación o acción.")
        evidence = json.loads(row["evidence_json"])
        if book.canonical_hash(evidence) != row["evidence_hash"]:
            raise qt.TraderError("El recibo no pasa su hash; no se sustituye por una estimación.")
        key = {"product": row["product"], "trade_no": row["trade_no"], "purpose": row["purpose"],
               "signal_ms": evidence["signal_at_ms"]}
        if row["purpose"] == "funding":
            key["revision"] = row["evidence_hash"]
        if (book.canonical_hash(key) != receipt_id or evidence["product"] != row["product"]
                or evidence["purpose"] != row["purpose"]):
            raise qt.TraderError("La identidad del recibo no pasa su hash.")
        try:
            book.replay_fill(evidence)
        except book.BookError as error:
            raise qt.TraderError(error.detail) from error
        return evidence

    def replay_trade(self, product, trade_no):
        own_transaction = not self.db.in_transaction
        if own_transaction:
            self.db.execute("BEGIN")
        try:
            return self._replay_trade(product, trade_no)
        finally:
            if own_transaction:
                self.db.rollback()

    def _replay_trade(self, product, trade_no):
        from . import futures_book_execution as book
        row = self.db.execute("SELECT * FROM trades WHERE product=? AND trade_no=?", (product, trade_no)).fetchone()
        if row is None or "execution_model" not in row.keys() or row["execution_model"] != book.MODEL:
            raise qt.TraderError("La operación no tiene ejecución de libro reproducible.")
        entry_data = self.execution_evidence(row["entry_receipt_id"], product=product,
                                            trade_no=trade_no, purpose="entry")
        ending_id = row["exit_receipt_id"] if row["status"] == "closed" else row["mark_receipt_id"]
        if row["status"] == "open" and row["execution_error"]:
            raise qt.TraderError("La posición no tiene una marca ejecutable vigente.")
        exit_data = self.execution_evidence(ending_id, product=product, trade_no=trade_no,
                                           purpose="exit" if row["status"] == "closed" else "mark")
        settlement = self.execution_evidence(row["funding_receipt_id"], product=product,
                                              trade_no=trade_no, purpose="funding")["settlement"] \
            if row["funding_receipt_id"] else exit_data["settlement"]
        if settlement["entry_execution_hash"] != book.canonical_hash(entry_data):
            raise qt.TraderError("La liquidación no pertenece a este recibo de entrada.")
        entry, exit_ = book.replay_fill(entry_data), book.replay_fill(exit_data)
        periods = [qt.exact_funding.FundingPeriod(**period) for period in settlement["funding_periods"]]
        history = qt.exact_funding._history(product, periods)
        position = qt.Position(
            side=settlement["position_side"], entry_ms=settlement["entry_at_ms"], entry_px=entry.price,
            qty=entry.quantity, notional_usd=entry.notional, entry_execution=entry_data,
            funding_model=settlement["funding_model"],
        )
        done = qt.settle(product, position, 0, "strategy_exit", exit_.executed_at_ms,
                         qt.FundingLine(history), entry.notional, execution=exit_)
        result = {key: None if done[key] is None else str(done[key])
                  for key in ("net_usd", "gross_usd", "fees_usd", "funding_usd", "net_complete_usd")}
        result["funding_status"] = done["funding_status"]
        if result != settlement["expected"]:
            raise qt.TraderError("La liquidación no coincide con sus entradas registradas.")
        return result

    def last_entry_ms(self, product):
        row = self.db.execute("SELECT MAX(entry_ms) AS m FROM trades WHERE product=?", (product,)).fetchone()
        return row["m"]

    def consumed_news(self, product):
        return {r[0] for r in self.db.execute("SELECT event_id FROM news_actions WHERE product=?", (product,))}

    def consume_news(self, product, signal, action, t_ms):
        self.db.execute("INSERT OR IGNORE INTO news_actions VALUES(?,?,?,?,?)",
                        (product, signal["event_id"], t_ms, action, json.dumps(signal, sort_keys=True)))

    def incomplete_funding(self, product):
        return [dict(r) for r in self.db.execute(
            "SELECT * FROM trades WHERE product=? AND status='closed' AND funding_status != 'complete'", (product,))]

    @staticmethod
    def _money(value, field):
        try:
            out = D(str(value))
        except (ArithmeticError, TypeError, ValueError) as error:
            raise qt.TraderError("Cuenta paper: {} inválido: {!r}".format(field, value)) from error
        if not out.is_finite():
            raise qt.TraderError("Cuenta paper: {} no es finito.".format(field))
        return out

    def cash_balance_usd(self):
        total = self.initial_balance_usd()
        for row in self.db.execute("SELECT net_usd FROM trades WHERE status='closed'"):
            total += self._money(row["net_usd"], "neto realizado")
        return total

    def available_balance_usd(self, *, excluding_product=None):
        """Persistent cash plus other marks minus reserved margins; configuration is never a capital source."""
        total = self.cash_balance_usd()
        for row in self.db.execute("SELECT product, margin_usd, net_now_usd FROM trades WHERE status='open'"):
            if row["product"] != excluding_product:
                total += self._money(row["net_now_usd"], "resultado abierto") - self._money(row["margin_usd"], "margen reservado")
        return total


# --------------------------------------------------------------------------- the public feed


class PublicFeed:
    """Kraken's PUBLIC 5m candles (through the candle cache) and hourly funding. No account, no keys.

    The history layer of the practice refuses anything after the holdout; this feed lives in the present on purpose, so it
    uses the cache and the fetchers directly."""

    def __init__(self, cache_dir, fetch=fetch_candles, fetch_funding_fn=None):
        from .futures_history import fetch_funding_records
        self.cache_dir, self._fetch, self._fetch_funding = cache_dir, fetch, fetch_funding_fn or fetch_funding_records
        self._next_gap_repair = {}
        self._book_cache = {}

    def bars(self, product, from_ms, to_ms):
        """Closed 5m candles of ``[from_ms, to_ms)``; downloads only what the cache lacks."""
        cache = CandleCache(os.path.join(self.cache_dir, "candles-{}.sqlite".format(product)))
        try:
            repair = to_ms >= self._next_gap_repair.get(product, 0)
            cache.ensure(product, "5m", from_ms, to_ms, fetch=self._fetch, repair_gaps=repair)
            if repair:
                self._next_gap_repair[product] = to_ms + BAR_MS
            return cache.read("5m", from_ms, to_ms)
        finally:
            cache.close()

    def funding(self, product):
        records = self._fetch_funding(product)
        if isinstance(records, qt.exact_funding.FundingHistory):
            return records
        return [(int(s), float(r)) for s, r in records]

    def book_snapshot(self, product):
        from . import futures_book_execution as book
        cached = self._book_cache.get(product)
        if cached is None or int(time.time() * 1000) - cached.received_at_ms > 500:
            cached = book.fetch_snapshot(product)
            self._book_cache[product] = cached
        return cached


# --------------------------------------------------------------------------- the decider the Trader sees


class WakeGate:
    """Sits between ``Trader`` and ``LlmDecider``. It turns "the model cannot answer" into ``WakeSkipped`` (the wake is
    recorded as omitted and never retried) and refuses to ask at all for wakes that are too old or already decided."""

    def __init__(self, inner, provider, budget_s, clock=time.monotonic, factors=None):
        self.inner, self.provider, self.budget_s, self.clock = inner, provider, budget_s, clock
        self.factors = factors                            # ``FactorsDecider`` of the window (configs with ``factors``)
        self.mode = "live"
        self._healthy = None

    def begin(self, mode):
        """``live``: ask the model. ``late``: this wake is older than allowed. ``done``: this bucket was already decided."""
        self.mode, self._healthy = mode, None
        if mode == "live":
            self.inner.deadline = self.clock() + self.budget_s
            self.inner.down = 0
            if self.factors is not None:
                self.factors.deadline, self.factors.down = self.inner.deadline, 0

    def ask(self, key, t_ms, step, question, state_text, *, single=False):
        self._check()
        try:
            return self.inner.ask(key, t_ms, step, question, state_text, single=single)
        except qt.ModelDown:
            raise qt.WakeSkipped("modelo_caido", SKIP_TEXT["modelo_caido"]) from None
        except qt.BudgetExhausted:
            raise qt.WakeSkipped("modelo_lento", SKIP_TEXT["modelo_lento"]) from None

    def check_execution(self):
        if self.mode == "late":
            raise qt.WakeSkipped("proceso_detenido", SKIP_TEXT["proceso_detenido"])
        if self.mode == "done":
            raise qt.WakeSkipped("ya_decidido", "")

    def _check(self):
        self.check_execution()
        if self._healthy is None:
            self._healthy = bool(self.provider.health())
        if not self._healthy:
            raise qt.WakeSkipped("modelo_caido", SKIP_TEXT["modelo_caido"])

    def ask_factors(self, key, t_ms, step, state_text):
        """The factors question (``futures_qwen_factors``) of one STATE, with the same gate as ``ask``."""
        self._check()
        if self.factors is None:
            raise qt.TraderError("esta configuración no tiene la pregunta por factores (falta 'factors')")
        try:
            return self.factors.ask(key, t_ms, step, state_text)
        except qt.ModelDown:
            raise qt.WakeSkipped("modelo_caido", SKIP_TEXT["modelo_caido"]) from None
        except qt.BudgetExhausted:
            raise qt.WakeSkipped("modelo_lento", SKIP_TEXT["modelo_lento"]) from None


# --------------------------------------------------------------------------- the operator


def closed_fields(trade, notional, leverage, margin, now):
    """The columns of a closed trade (``trade``: the dict ``Trader`` returns in a ``trade`` event)."""
    trade_notional = D(str(trade["notional_usd"])) if trade.get("notional_usd") else D(str(notional))
    trade_margin = trade_notional / D(str(leverage)) if trade.get("notional_usd") else margin
    return {
        "status": "closed", "side": trade["side"], "entry_ms": trade["entry_ms"], "exit_ms": trade["exit_ms"],
        "entry_px": trade["entry_fill"],
        "exit_px": trade["exit_fill"] if trade.get("exit_execution") is not None else repr(trade["exit_px"]),
        "qty": trade["qty"],
        "notional_usd": str(trade_notional), "leverage": str(leverage), "margin_usd": str(trade_margin),
        "gross_usd": trade["gross_usd"], "fees_usd": trade["fees_usd"], "funding_usd": trade["funding_usd"],
        "net_usd": trade["net_usd"], "net_bp": trade["net_bp"], "funding_status": trade["funding_status"],
        "closed_by": trade["closed_by"], "exit_reason": trade["exit_reason"], "entry_reason": trade["entry_reason"],
        "entry_p": trade["entry_p"], "hold_min": trade["hold_min"], "mfe_bp": trade["mfe_bp"],
        "mae_bp": trade["mae_bp"], "closed_at_ms": now,
        "funding_model": trade.get("funding_model", qt.exact_funding.LEGACY_MODEL),
        "net_complete_usd": trade.get("net_complete_usd"),
    }


def _hhmm(ms):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(ms / 1000)) + " UTC"


def _usd(value):
    return "{:+.2f}".format(float(value))


def _flat_candle(close_text, bucket):
    return {"bucket_start": bucket, "open": close_text, "high": close_text, "low": close_text, "close": close_text,
            "volume_btc": "0"}


def validate_priority_config(cfg):
    if noticias.priority_enabled(cfg) and (
        qt.candle_opinions_enabled(cfg) or cfg.get("cuenta") != "entera"
        or _positive(str(cfg.get("leverage", "1")), "apalancamiento") != 1
        or cfg["products"] != ["PF_ETHUSD"]
    ):
        raise qt.TraderError("Prioridad de noticias requiere solo ETH, cuenta entera, apalancamiento 1 y opiniones de velas apagadas.")


class LiveOperator:
    """Feeds one ``Trader`` per product with closed public candles and records what happens.

    ``feed`` (``PublicFeed`` or a fake in tests), ``provider`` (llama-server on loopback or a fake), ``now_ms`` (the wall clock
    in milliseconds)."""

    def __init__(self, cfg, store, feed, provider, *, now_ms=lambda: int(time.time() * 1000), clock=time.monotonic,
                 log=print, model=None, account_start_usd=DEFAULT_ACCOUNT_START_USD):
        self.cfg, self.store, self.feed, self.provider = cfg, store, feed, provider
        self.now_ms, self.clock, self.log = now_ms, clock, log
        self.account_start_usd = account_start_usd
        live = cfg.get("live") or {}
        self.warmup_ms = int(live.get("warmup_days", 8)) * DAY_MS
        self.poll_s = float(live.get("poll_seconds", 30))
        self.max_late_ms = int(float(live.get("max_late_seconds", 240)) * 1000)
        self.book_enabled = "execution" in cfg
        if self.book_enabled:
            from . import futures_book_execution as book
            if ({k: v for k, v in cfg["execution"].items() if k != "exit"} != {"model": book.MODEL}
                    or cfg["products"] != ["PF_ETHUSD"]
                    or cfg.get("funding_model") != qt.exact_funding.EXACT_MODEL):
                raise qt.TraderError("La ejecución de libro requiere ETH y el funding absoluto.")
            self.max_late_ms = min(self.max_late_ms, 15_000)
            self.poll_s = min(self.poll_s, 5.0)
        if noticias.priority_enabled(cfg):
            self.max_late_ms = min(self.max_late_ms, 15_000)
            self.poll_s = min(self.poll_s, 5.0)
        self.funding_every_ms = int(float(live.get("funding_refresh_minutes", 30)) * MINUTE_MS)
        self.notional = D(cfg["notional_usd"])
        self.leverage = D(str(cfg.get("leverage", "1")))
        validate_priority_config(cfg)
        self.margin = self.notional / self.leverage           # money set aside; costs and funding run on the notional
        served = getattr(provider, "served_model", None)
        self.model = "news-only"
        if qt.candle_opinions_enabled(cfg):
            if not model and callable(served):
                model = served()
            self.model = model or getattr(provider, "model_ref", None) or "unknown"
        inner = qt.LlmDecider(provider, cfg, clock=clock, model=self.model)
        by_factors = fq.FactorsDecider(provider, cfg, clock=clock, model=self.model) if cfg.get("factors") else None
        self.gate = WakeGate(inner, provider, float(live.get("wake_budget_seconds", 240)), clock, factors=by_factors)
        # What the sheet (``state_ficha``) needs besides the candles of the product: the closes of the other assets (row F7,
        # fed like the exam does) and the collector's positioning database (row F6, read-only, read again every few minutes).
        self.context_pool = list(cfg.get("state_context") or ())
        self.positioning_path = cfg.get("positioning_db") or positioning_data.default_path()
        self.positioning_every_ms = int(float(live.get("positioning_refresh_minutes", 10)) * MINUTE_MS)
        self.positioning = {}                             # product -> PositioningFeed
        self.positioning_checked_ms = 0
        self._positioning_seen = {}                       # product -> last availability said in the log
        self.news_path = cfg.get("news_db") if "news_db" in cfg else noticias.default_path()
        self.news = None
        self.news_checked_ms = 0
        self._context_warned = set()
        self.config_hash = qt.config_hash(cfg)
        self.traders = {}
        self.funding_checked_ms = 0
        self.ready = False
        self.model_ok = None                              # None: not probed yet
        self.next_config = None
        self._pending_error = None                              # None: not probed yet
        self._probe_failures, self._next_probe = 0, 0.0
        self._errors = {}
        self.failed_cycle = False

    # ---- start

    def start(self):
        """Warm up every product with ~8 days of candles (never traded) and restore the open position, if any."""
        self.store.check_identity(self.cfg, account_start_usd=self.account_start_usd)
        self.store.set_meta("model_scope", "candles" if qt.candle_opinions_enabled(self.cfg) else "news_only")
        if not qt.candle_opinions_enabled(self.cfg):
            self.store.set_meta("model_ok", None)
        now = self.now_ms()
        self._refresh_funding(now, first=True)
        for product in self.cfg["products"]:
            self._try_start(product, now)
        self.ready = True

    def _try_start(self, product, now):
        """A product that cannot start (public feed down, busy base) stays out and is tried again every poll."""
        try:
            self._start_product(product, now)
        except qt.TraderError:
            raise
        except Exception as error:                      # noqa: BLE001 - the process must stay alive
            self.traders.pop(product, None)
            self._failure("arranque", product, error)

    def _start_product(self, product, now):
        trader = qt.Trader(self.cfg, product, self.gate, self._funding[product], key=product,
                           entry_threshold=self.cfg["entry_threshold"])
        trader.execution_check = lambda: self._check_execution(trader)
        trader.entry_check = self._check_pending_entry
        if self.book_enabled:
            from . import futures_book_execution as book
            snapshot_for = getattr(self.feed, "book_snapshot", None)
            if not callable(snapshot_for):
                raise qt.TraderError("La fuente no ofrece un libro público verificable.")
            trader.book_execution = book.BookExecution(snapshot_for, self.now_ms)
        trader.news_consumed = self.store.consumed_news(product)
        state = self.store.load_state(product)
        last_fed = None
        if state is not None:
            trader.trade_seq, trader.cooldown_until = state["trade_seq"], state["cooldown_until"]
            trader.last_call_ms = state["last_call_ms"]
            if state["position_json"]:
                trader.position = position_from_json(state["position_json"])
            if state.get("window_json"):
                trader.window = json.loads(state["window_json"])
            last_fed = state["last_fed_ms"]
        live_cfg = self.cfg.get("live") or {}
        hours = float(live_cfg.get("force_side_after_h") or 0)
        trader.force_idle_ms = int(hours * HOUR_MS) if hours > 0 else None
        trader.window_on = float(live_cfg.get("force_window_h") or 0) > 0
        self._attach_sheet_data(product, trader, now)
        last_open = self.store.last_entry_ms(product)
        trader.last_open_ms = last_open
        trader.idle_since_ms = now                    # no opening on record: counted from this start
        if self.cfg.get("cuenta") == "entera":
            trader.notional = self.store.available_balance_usd(excluding_product=product)
        self.traders[product] = trader
        warm, fresh = self._warm_product_bars(product, trader, now, last_fed)
        pos_note = ""
        if trader.position is not None:
            side_label = "LARGO" if trader.position.side == "LONG" else "CORTO"
            pos_note = " (posición {} recuperada, abierta desde {})".format(side_label, _hhmm(trader.position.entry_ms))
        self.log("Qwen en vivo: {} calentado con {} velas de 5 min{}.".format(product, len(warm), pos_note))
        for bar in fresh:
            self._process(product, bar)
        self._data_health(product, trader)

    def _warm_product_bars(self, product, trader, now, last_fed):
        warm_start = (now // BAR_MS) * BAR_MS - self.warmup_ms
        self._load_context(product, trader, warm_start, now)
        extra_ms = analista.extra_days(self.cfg) * DAY_MS
        all_bars = fill_gaps(self.feed.bars(product, warm_start - extra_ms, now), BAR_MS, annotate=True)
        all_bars = [b for b in all_bars if b["bucket_start"] + BAR_MS <= now]
        gaps = [b["bucket_start"] + BAR_MS for b in all_bars if b["observed"] is False]
        trader.data_gap_ms = max(gaps) if gaps else None
        if extra_ms > 0:
            # Trader.feed adds the warm and fresh candles; seed only the earlier history.
            trader.movement = analista.Movement(b for b in all_bars if b["bucket_start"] < warm_start and b["observed"])
        bars = [b for b in all_bars if b["bucket_start"] >= warm_start]
        warm = [b for b in bars if (b["bucket_start"] <= last_fed if last_fed is not None
                                    else now - (b["bucket_start"] + BAR_MS) > self.max_late_ms)]
        for bar in warm:
            trader.feed(bar, trade=False)
        return warm, bars[len(warm):]

    # ---- one poll

    def poll(self):
        """Looks for newly closed candles and feeds them in order. Nothing that goes wrong in here ends the process: a
        failure of one product is recorded in ``errors`` and that product is rebuilt from the database on the next poll
        (what was not written is asked again; what was written is never asked twice)."""
        now = self.now_ms()
        self.failed_cycle = False
        self._try_pending_config()
        if self.next_config is not None:
            self._heartbeat()
            return
        self._check_model()
        try:
            if now - self.funding_checked_ms >= self.funding_every_ms:
                self._refresh_funding(now)
                self._recovered("funding", None)
        except Exception as error:                        # noqa: BLE001
            self._failure("funding", None, error)
        self._refresh_positioning(now)
        self._refresh_news(now)
        for product in self.cfg["products"]:
            if product not in self.traders:
                try:
                    self._try_start(product, now)
                    if product in self.traders:
                        self._recovered("arranque", product)
                except qt.TraderError as error:
                    self._failure("arranque", product, error)
                continue
            try:
                self._poll_product(product, now)
                self._recovered("ciclo", product)
            except Exception as error:                    # noqa: BLE001 - the process must stay alive
                self.traders.pop(product, None)           # in-memory state may be ahead of the database: rebuild it
                self._failure("ciclo", product, error)
        self._try_pending_config()
        self._heartbeat()

    def _check_pending_entry(self):
        requested = (self.cfg.get("runtime") or {}).get("pending_config")
        if requested and (not isinstance(requested, dict) or requested.get("sha256") != (self.cfg.get("runtime") or {}).get("activation_request_sha256")):
            raise qt.WakeSkipped("cambio_pendiente", "No se abre otra operación del flujo anterior: espera el traspaso sin reiniciar la cuenta.")

    def _try_pending_config(self):
        spec = (self.cfg.get("runtime") or {}).get("pending_config")
        if not spec:
            return
        if isinstance(spec, dict) and spec.get("sha256") == (self.cfg.get("runtime") or {}).get("activation_request_sha256"):
            self._meta("pending_config", {"state": "active", "request_sha256": spec["sha256"], "target_hash": self.config_hash})
            return
        try:
            target = pending_config(self.cfg, spec)
            validate_activation(target, now_ms=self.now_ms())
            flat = not any(trader.position is not None for trader in self.traders.values())
            flat = flat and self.store.db.execute(OPEN_TRADE_QUERY).fetchone() is None
            flat = flat and self.store.db.execute(OPEN_POSITION_QUERY).fetchone() is None
            if not flat:
                self._meta("pending_config", {"state": "waiting", "target_hash": qt.config_hash(target),
                                              "reason": "Esperando el cierre normal de todas las operaciones."})
                return
            self.store.activate_flat_config(target, now_ms=self.now_ms())
        except (qt.TraderError, OSError, ValueError, TypeError) as error:
            message = str(error)
            self._meta("pending_config", {"state": "error", "reason": message})
            if self._pending_error != message:
                self.log("Qwen en vivo: no se activa el flujo pendiente: " + message)
                self._pending_error = message
            return
        self.next_config = target
        self._meta("pending_config", {"state": "active", "request_sha256": target["runtime"]["activation_request_sha256"],
                                      "target_hash": qt.config_hash(target), "cash_usd": str(self.store.cash_balance_usd())})
        self.log("Qwen en vivo: traspaso plano confirmado; se conservan la cuenta, el saldo y las operaciones anteriores.")

    def _poll_product(self, product, now):
        trader = self.traders[product]
        self._service_exit(product, now)
        from_ms = trader.t[-1] + BAR_MS if trader.t else now - self.warmup_ms
        if trader.data_gap_ms is not None:
            from_ms = min(from_ms, trader.data_gap_ms - BAR_MS)
        try:
            fresh = self.feed.bars(product, from_ms, now)
        except (HistoryError, OSError, ValueError) as error:
            self._failure("datos", product, error)
            self._data_health(product, trader, status="error", reason=str(error))
            return
        self._recovered("datos", product)
        if trader.data_gap_ms is not None and any(
                bar["bucket_start"] + BAR_MS == trader.data_gap_ms and bar.get("observed", True) for bar in fresh):
            self.log("Qwen en vivo: {} recuperó una vela ausente; reconstruyendo datos sin cambiar su operación.".format(product))
            self._start_product(product, now)
            return
        if fresh:
            self._load_context(product, trader, fresh[0]["bucket_start"] - 3 * BAR_MS, now)
        for bar in fresh:
            if bar["bucket_start"] + BAR_MS > now or (trader.t and bar["bucket_start"] <= trader.t[-1]):
                continue
            while trader.t and bar["bucket_start"] > trader.t[-1] + BAR_MS:
                self._process(product, dict(_flat_candle(repr(trader.c[-1]), trader.t[-1] + BAR_MS), observed=False))
            self._process(product, bar)
        self._data_health(product, trader)

    def _data_health(self, product, trader, *, status=None, reason=None):
        now = self.now_ms()
        if status is None:
            if trader.data_gap_ms is not None:
                status = "gap"
            elif trader.last_observed_ms is None or now - trader.last_observed_ms > BAR_MS + self.max_late_ms:
                status = "stale"
            else:
                status = "ok"
        self._meta("data_health_" + product, {
            "status": status, "checked_at_ms": now, "last_observed_ms": trader.last_observed_ms,
            "gap_at_ms": trader.data_gap_ms, "reason": reason})

    # ---- what the sheet needs: other assets (F7) and positioning (F6)

    def _attach_sheet_data(self, product, trader, now):
        """Row F6: the collector's database, read-only. Without the file (or without rows of this product) F6 says «n/d» and the
        process goes on; it is said once in the log, and again only when that changes."""
        if self.news is None:
            policy = self.cfg["noticias"] if noticias.priority_enabled(self.cfg) else None
            self.news = noticias.NewsFeed(self.news_path, since_ms=now - POSITIONING_KEEP_MS, priority_policy=policy)
            self.news_checked_ms = now
        trader.news = self.news
        if not self.cfg.get("state_ficha"):
            return
        feed = positioning_data.PositioningFeed(self.positioning_path, product, since_ms=now - POSITIONING_KEEP_MS)
        self.positioning[product] = feed
        trader.positioning = feed
        self._say_positioning(product, feed)

    def _say_positioning(self, product, feed):
        """One line in the log when the state of the positioning data of a product changes (and at the start). A missing FILE is
        said once for all the products, not once per product."""
        if feed.available:
            status = "ok"
        elif not os.path.isfile(self.positioning_path):
            status = "sin_archivo"
        else:
            status = "sin_datos"
        if self._positioning_seen.get(product) == status:
            return
        said = any(seen == status for other, seen in self._positioning_seen.items() if other != product)
        self._positioning_seen[product] = status
        self._meta("positioning_" + product, status == "ok")
        if status == "ok":
            self.log("Qwen en vivo: posicionamiento de {} leído de {} (solo lectura, se vuelve a leer cada {} min).".format(
                product, self.positioning_path, self.positioning_every_ms // MINUTE_MS))
        elif status == "sin_archivo" and not said:
            self.log("Qwen en vivo: ATENCIÓN, no existe la base de posicionamiento ({}): el renglón F6 de la ficha dice n/d y el "
                     "proceso sigue igual. Se vuelve a mirar solo; para usar otra ruta, --positioning-db o POSITIONING_DB_PATH "
                     "(pnpm dev escribe server/data/dev-live/positioning.sqlite con el colector).".format(self.positioning_path))
        elif status == "sin_datos":
            self.log("Qwen en vivo: ATENCIÓN, la base de posicionamiento ({}) no tiene datos de {}: su renglón F6 dice n/d y se "
                     "sigue igual.".format(self.positioning_path, product))

    def _refresh_positioning(self, now):
        if not self.positioning or now - self.positioning_checked_ms < self.positioning_every_ms:
            return
        self.positioning_checked_ms = now
        for product, feed in self.positioning.items():
            try:
                feed.reload(since_ms=now - POSITIONING_KEEP_MS)
            except Exception as error:                    # noqa: BLE001 - F6 is optional: never stop the process for it
                self._failure("posicionamiento", product, error)
                continue
            self._recovered("posicionamiento", product)
            self._say_positioning(product, feed)

    def _refresh_news(self, now):
        if self.news is None:
            return
        self.news_checked_ms = now
        try:
            self.news.reload(since_ms=now - POSITIONING_KEEP_MS)
            if self.news.last_error is not None:
                raise qt.TraderError("No se pudieron leer las noticias: " + self.news.last_error)
        except Exception as error:                        # noqa: BLE001 - news is optional: never stop the process for it
            self.news.available, self.news.last_error = False, str(error)
            self._failure("noticias", None, error)
            return
        self._recovered("noticias", None)

    def _publish_news_lifecycle(self, now):
        if self.news is None:
            return
        consumed = set().union(*(self.store.consumed_news(product) for product in self.cfg["products"]))
        self._meta("news_lifecycle", self.news.lifecycle_at(now, consumed_event_ids=consumed))

    def _update_context_closes(self, trader, other, bars, to_ms):
        closes = trader.context.setdefault(other, {})
        for bar in bars:
            if bar.get("observed") is False:
                continue
            end = int(bar["bucket_start"]) + BAR_MS
            if end <= to_ms:
                closes[end] = float(bar["close"])
        for key in [k for k in closes if k < to_ms - CONTEXT_KEEP_MS]:
            del closes[key]

    def _load_context(self, product, trader, from_ms, to_ms):
        """Closes of the other assets, keyed by the END of each 5m candle (``trader.context``, as the exam builds it): row F7 of
        the sheet. A product is never its own context. An asset whose candles cannot be read leaves F7 «n/d» for that asset
        (said once) and never stops the product."""
        for other in self.context_pool:
            if other == product:
                continue
            try:
                bars = fill_gaps(self.feed.bars(other, from_ms, to_ms), BAR_MS, annotate=True)
            except Exception as error:                    # noqa: BLE001
                if (product, other) not in self._context_warned:
                    self._context_warned.add((product, other))
                    self.log("Qwen en vivo: no se pudieron leer las velas de {} para el contexto de {} ({}); el renglón F7 queda "
                             "sin ese activo hasta que vuelvan.".format(other, product, error))
                continue
            if (product, other) in self._context_warned:
                self._context_warned.discard((product, other))
                self.log("Qwen en vivo: las velas de {} (contexto de {}) volvieron.".format(other, product))
            self._update_context_closes(trader, other, bars, to_ms)

    # ---- resilience: model state, unexpected failures, heartbeat

    def _check_model(self):
        """Tracks whether llama-server answers /health. One log line per change of state; while it is down the probe backs
        off (5 s, 10 s ... 60 s). Does not decide anything: each wake still asks for itself."""
        if not qt.candle_opinions_enabled(self.cfg):
            return
        now = self.clock()
        if self.model_ok is False and now < self._next_probe:
            return
        try:
            ok = bool(self.provider.health())
        except Exception:                                  # noqa: BLE001
            ok = False
        if ok:
            self._probe_failures = 0
        else:
            self._probe_failures += 1
            self._next_probe = now + min(60.0, 5.0 * 2 ** (self._probe_failures - 1))
        if ok != self.model_ok:
            if ok:
                if self.model_ok is False:
                    self.log("Qwen en vivo: el modelo local volvió a responder; se retoma con el próximo despertar.")
            else:
                self.log("Qwen en vivo: el modelo local no responde. Sigo vivo, anoto cada despertar como omitido y "
                         "reintento solo hasta que /health vuelva a dar 200.")
            self.model_ok = ok
            self._meta("model_ok", ok)
            self._meta("model_changed_ms", self.now_ms())

    def _failure(self, place, product, error):
        """Records an unexpected failure (table ``errors``) and goes on. The same failure is logged and stored once, not once
        per cycle, until it changes or ten minutes pass; a recovery is logged once too."""
        key = (place, product)
        detail = "{}: {}".format(type(error).__name__, error)
        now = self.now_ms()
        last = self._errors.get(key)
        if last is None or last[0] != detail or now - last[1] >= 10 * MINUTE_MS:
            self._errors[key] = (detail, now)
            self.log("Qwen en vivo: falló {}{} ({}); sigo vivo y reintento en el próximo ciclo.".format(
                place, "" if product is None else " de " + product, detail))
            try:
                self.store.put_error(now, place, product, type(error).__name__, detail)
                self.store.set_meta("last_error_ms", now)
            except Exception as second:                    # noqa: BLE001 - a busy database must not end the loop either
                self.log("Qwen en vivo: tampoco se pudo anotar el error ({}).".format(second))
        self.failed_cycle = True

    def _recovered(self, place, product):
        if self._errors.pop((place, product), None) is not None:
            self.log("Qwen en vivo: {}{} volvió a andar.".format(place, "" if product is None else " de " + product))

    def _meta(self, key, value):
        try:
            self.store.set_meta(key, value)
        except Exception as error:                         # noqa: BLE001
            self._failure("meta", None, error)

    def _heartbeat(self):
        """Last sign of life: the gateway says «Qwen sin latidos hace X min» from it. Written every cycle, with or without
        a model, so a silent process is told apart from a model that is down."""
        now = self.now_ms()
        self._publish_news_lifecycle(now)
        self._meta("heartbeat_ms", now)

    def _refresh_funding(self, now, first=False):
        self.funding_checked_ms = now
        if first:
            self._funding = {}
        for product in self.cfg["products"]:
            try:
                rows = self.feed.funding(product)
            except (HistoryError, OSError, ValueError) as error:
                self.log("Qwen en vivo: no se pudo leer el funding público de {} ({}); las operaciones quedan marcadas "
                         "con funding incompleto hasta que vuelva.".format(product, error))
                rows = None
            if rows is not None:
                self._funding[product] = qt.FundingLine(rows)
                if product in self.traders:
                    self.traders[product].funding = self._funding[product]
                    self._reconcile_funding(product)
            elif product not in self._funding:
                self._funding[product] = qt.FundingLine(())

    def _reconcile_funding(self, product):
        """Reconcile observed missing funding without changing price, fee or entry/exit receipts."""
        line = self.traders[product].funding
        with self.store.db:
            for row in self.store.incomplete_funding(product):
                long = row["side"] == "LONG"
                paid, covered = line.accrue_position(
                    row["entry_ms"], row["exit_ms"], D(row["entry_px"]) * D(row["qty"]), D(row["qty"]), long,
                    row["funding_model"] or qt.exact_funding.LEGACY_MODEL)
                held = max(0, row["exit_ms"] - row["entry_ms"])
                status = qt.funding_status(held, covered)
                net = D(row["gross_usd"]) - D(row["fees_usd"]) - paid
                notional = D(row["notional_usd"]) if row["notional_usd"] is not None else D(row["entry_px"]) * D(row["qty"])
                if not notional.is_finite() or notional <= 0:
                    raise qt.TraderError("Funding: el nocional de la operación no es válido.")
                reconciliation = None
                net_bp = float(net / notional * 10_000)
                if row["execution_model"] is not None:
                    from . import futures_book_execution as book
                    entry_data = self.store.execution_evidence(row["entry_receipt_id"], product=product,
                                                               trade_no=row["trade_no"], purpose="entry")
                    exit_data = self.store.execution_evidence(row["exit_receipt_id"], product=product,
                                                              trade_no=row["trade_no"], purpose="exit")
                    position = qt.Position(
                        side=row["side"], entry_ms=row["entry_ms"], entry_px=D(row["entry_px"]), qty=D(row["qty"]),
                        notional_usd=notional, entry_execution=entry_data, funding_model=row["funding_model"],
                    )
                    done = qt.settle(product, position, 0, "strategy_exit", row["exit_ms"], line, notional,
                                     execution=book.replay_fill(exit_data))
                    paid, net, status, net_bp = done["funding_usd"], done["net_usd"], done["funding_status"], done["net_bp"]
                    reconciliation = copy.deepcopy(exit_data)
                    reconciliation.update(purpose="funding", settlement=done["execution"]["settlement"],
                                          reconciled_at_ms=self.now_ms())
                if status == row["funding_status"] and str(paid) == row["funding_usd"]:
                    continue
                if reconciliation is not None:
                    receipt = self.store.put_execution(product, row["trade_no"], reconciliation, self.now_ms())
                    self.store.update_trade(product, row["trade_no"], funding_receipt_id=receipt)
                self.store.update_trade(product, row["trade_no"], funding_usd=str(paid), funding_status=status,
                                        net_usd=str(net), net_bp=net_bp,
                                        net_complete_usd=str(net) if status == "complete" else None)

    # ---- one candle

    def _check_execution(self, trader):
        self.gate.check_execution()
        now = self.now_ms()
        if noticias.priority_enabled(self.cfg) and now - (trader.t[-1] + BAR_MS) > self.max_late_ms:
            raise qt.WakeSkipped("proceso_detenido", SKIP_TEXT["proceso_detenido"])
        return now

    def _process(self, product, bar):
        trader = self.traders[product]
        if self.cfg.get("cuenta") == "entera":
            trader.notional = self.store.available_balance_usd(excluding_product=product)
        t_ms = int(bar["bucket_start"]) + BAR_MS
        now = self.now_ms()
        if self.store.bucket_done(product, t_ms):
            self.gate.begin("done")
        else:
            self.gate.begin("late" if now - t_ms > self.max_late_ms else "live")
        events = trader.feed(bar)
        self._record(product, trader, t_ms, events, self.now_ms(), observed=bar.get("observed", True))
        if self.cfg.get("cuenta") == "entera" and trader.position is None:
            trader.notional = self.store.available_balance_usd(excluding_product=product)

    def _record(self, product, trader, t_ms, events, now, *, observed=True):
        meta = {"prompt_version": self.cfg["prompt"]["version"], "model": self.model, "config_hash": self.config_hash}
        mark, mark_error = None, None
        if trader.position is not None and observed:
            try:
                mark = trader.mark(t_ms)
            except qt.WakeSkipped as error:
                mark_error = error
        if self.book_enabled:
            now = self.now_ms()
        with self.store.db:
            for event in events:
                kind = event["type"]
                if kind == "trade":
                    self._write_closed(product, event["trade"], now)
                elif kind == "skipped":
                    if event["kind"] == "ya_decidido":
                        continue
                    self.store.put_skipped(product, event["t_ms"], event["kind"], event["detail"], event["wake"], now)
                    self.log("{} {}: despertar omitido ({}); no se reintenta.".format(
                        _hhmm(event["t_ms"]), product, SKIP_TEXT.get(event["kind"], event["kind"])))
                elif kind == "decision":
                    self._record_decision(product, event, meta, now)
                elif kind == "exit_plan":
                    self._log_exit_plan(product, event)
            position = trader.position
            if position is not None and observed:
                self._write_open(product, trader, position, t_ms, now, mark=mark)
                if position.exit_plan is not None or self.book_enabled:
                    self.store.update_trade(product, position.trade_no, exit_plan_json=(
                        None if position.exit_plan is None else json.dumps(position.exit_plan, sort_keys=True)))
                if mark_error is not None:
                    self.store.update_trade(product, position.trade_no, net_now_usd=None, net_complete_usd=None,
                                            execution_error=mark_error.kind)
            self.store.save_state(product, trader, t_ms - BAR_MS, now)
        if mark_error is not None:
            self._failure("ejecucion", product, mark_error)
        elif self.book_enabled:
            self._recovered("ejecucion", product)
        if events and self.cfg.get("decide_by") == "formula" and qt.candle_opinions_enabled(self.cfg):
            self._resolve_examples(product, trader, now)
        if events and self.cfg.get("decide_by") == "formula":          # el auditor no necesita la opinión de Qwen
            self._audit(product, trader, events, now)

    def _log_exit_plan(self, product, event):
        plan = event["plan"]
        self.log("{} {}: orden de salida {} a {} (espera máx. {} min, tope {} pb).".format(
            _hhmm(event["t_ms"]), product, "colocada" if event["action"] == "colocada" else "movida",
            event["price"], plan["ttl_ms"] // MINUTE_MS, plan["tope_bp"]))

    def _service_exit(self, product, now):
        """Every poll, between candles: the waiting exit order follows the public book (fills, moves or goes to market)."""
        trader = self.traders[product]
        position = trader.position
        if position is None or position.exit_plan is None:
            return
        try:
            events = trader.service_exit(now)
        except qt.WakeSkipped as skip:
            self._failure("ejecucion", product, skip)
            return
        self._recovered("ejecucion", product)
        if any(event["type"] == "trade" for event in events):
            self._record(product, trader, trader.t[-1] + BAR_MS, events, self.now_ms(), observed=True)
            return
        # still waiting: keep the order (and its last sign of life) on disk, without a new mark receipt
        with self.store.db:
            for event in events:
                self._log_exit_plan(product, event)
            self.store.update_trade(product, trader.position.trade_no, exit_plan_json=json.dumps(
                trader.position.exit_plan, sort_keys=True))
            self.store.save_state(product, trader, trader.t[-1], self.now_ms())

    def _record_decision(self, product, event, meta, now):
        if event.get("answer") is None and not event.get("formula_action"):
            self.store.put_skipped(product, event["t_ms"], "sin_respuesta", SKIP_TEXT["sin_respuesta"], event["wake"], now)
            self.log("{} {}: despertar omitido ({}); no se reintenta.".format(
                _hhmm(event["t_ms"]), product, SKIP_TEXT["sin_respuesta"]))
            return
        self.store.put_decision(product, event, meta, now)
        if event.get("news_event") is not None:
            self.store.consume_news(product, event["news_event"], event["action"], now)
        self.log(self._decision_line(product, event))

    def _resolve_examples(self, product, trader, now):
        """Labels resolved flat and position looks in ``examples`` as soon as their outcome is known."""
        try:
            closes_of = lambda _p, _a, _b: {int(t) + BAR_MS: float(c) for t, c in zip(trader.t, trader.c)}
            aprende.resolve_live(self.store.db, closes_of, dict(self.cfg, products=[product]), now)
        except Exception as error:                        # noqa: BLE001 - learning labels never block live operation
            self._failure("ejemplos", product, error)

    def _audit(self, product, trader, events, now):
        """Auditor de decisiones (``futures_auditor``): anota cada mirada con decisión y resuelve las que ya pueden juzgarse. Escribe
        solo en ``auditor.sqlite`` (nunca en esta base) y no cambia ninguna decisión; si falla, queda anotado como aviso y la
        operación sigue igual (no cuenta como ciclo fallido: no frena el sondeo)."""
        failed = self.failed_cycle
        try:
            for event in events:
                if event["type"] in ("decision", "guardrail"):
                    auditor.snapshot(self.store.path, product, trader, event, now)
            closes = {int(t) + BAR_MS: float(c) for t, c in zip(trader.t, trader.c)}
            auditor.resolve(self.store.path, product, closes, dict(self.cfg, products=[product]), now,
                            float(round_trip_cost_bps(product)))
            self._recovered("auditor", product)
        except Exception as error:                        # noqa: BLE001 - el auditor nunca bloquea la operación en vivo
            self._failure("auditor", product, error)
            self.failed_cycle = failed

    @staticmethod
    def _formula_decision_line(head, event):
        if event["formula"].get("opinion_enabled") is False:
            authority = "noticias verificadas" if event["formula"].get("authority") == "noticias" else "reglas"
            return "{}: {} ({}: {})".format(head, event["action"], authority, event["formula"]["motivo"])
        opinion = event.get("model_action")
        if opinion is None:
            opinion_text = "nada (" + str(event.get("opinion_error")) + ")"
            agree_text = ""
        else:
            opinion_text = "{} (p {:.2f})".format(opinion, event.get("p_action") or 0.0)
            agree_text = " y coincide" if event.get("opinion_agrees") else " y no coincide"
        return "{}: {} (fórmulas: {}) — Qwen opina {}{}".format(
            head, event["action"], event["formula"]["motivo"], opinion_text, agree_text
        )

    @staticmethod
    def _legacy_tail(event):
        if event.get("forced"):
            return " — entró en la mejor ocasión de la ventana (puntaje {:.3f}, chequeo {})".format(
                event["score"], event["look_n"]
            )
        if event.get("override") == "ventana_mirando":
            mirror_text = "coincide" if event["mirror_ok"] else "no coincide"
            return " — mirando la mejor ocasión (chequeo {}: puntaje {:.3f}, mejor {:.3f}, espejo {})".format(
                event["look_n"], event["score"], event["best_score"], mirror_text
            )
        if event.get("override"):
            return " — sin operar: " + str(event["override"])
        return ""

    @staticmethod
    def _decision_line(product, event):
        """One log line per decision. Version 9 (the formulas decide): the formula's action, why, and what Qwen thinks."""
        head = "{} {}".format(_hhmm(event["t_ms"]), product)
        if event.get("formula_action"):
            return LiveOperator._formula_decision_line(head, event)
        model_act = event.get("model_action")
        model_note = "" if (not model_act or event["action"] == model_act) else " [el modelo dijo {}]".format(model_act)
        return "{}: {}{} (p {:.2f}, confianza {:.2f}){}".format(
            head, event["action"], model_note, event.get("p_action") or 0.0,
            event["answer"]["confidence"], LiveOperator._legacy_tail(event)
        )

    def _write_open(self, product, trader, position, t_ms, now, *, mark=None):
        pos_notional = position.notional_usd or trader.notional
        pos_margin = pos_notional / self.leverage
        marked = {} if mark is None else {
            "gross_usd": str(mark["gross_usd"]), "fees_usd": str(mark["fees_usd"]),
            "funding_usd": str(mark["funding_usd"]), "funding_status": mark["funding_status"],
            "mark_px": float(mark["exit_px"]) if mark["execution"] is not None else trader.c[-1],
            "mark_ms": mark["executed_at_ms"], "net_now_usd": str(mark["net_usd"]),
            "net_complete_usd": None if mark["net_complete_usd"] is None else str(mark["net_complete_usd"]),
        }
        self.store.put_trade(
            product, position.trade_no, status="open", side=position.side, entry_ms=position.entry_ms,
            entry_px=str(position.entry_px), qty=str(position.qty), notional_usd=str(pos_notional),
            leverage=str(self.leverage), margin_usd=str(pos_margin), entry_reason=position.entry_reason, entry_p=position.entry_p, mfe_bp=round(position.mfe_bp, 2),
            mae_bp=round(position.mae_bp, 2), stop_px=position.stop_px, max_hold_ms=position.max_hold_ms,
            opened_at_ms=now,
            funding_model=position.funding_model, config_hash=self.config_hash,
            execution_model=None if position.entry_execution is None else position.entry_execution["model"],
            **marked)
        if position.entry_execution is not None:
            entry_id = self.store.put_execution(product, position.trade_no, position.entry_execution, now)
            updates = {"execution_model": position.entry_execution["model"], "entry_receipt_id": entry_id}
            if mark is not None:
                updates["mark_receipt_id"] = self.store.put_execution(product, position.trade_no, mark["execution"], now)
                updates["execution_error"] = None
            self.store.update_trade(product, position.trade_no, **updates)

    def _write_closed(self, product, trade, now):
        self.store.put_trade(product, trade["trade_no"], **closed_fields(trade, self.notional, self.leverage, self.margin, now),
                             config_hash=self.config_hash,
                             execution_model=None if trade.get("entry_execution") is None else trade["entry_execution"]["model"])
        if trade.get("entry_execution") is not None:
            entry_id = self.store.put_execution(product, trade["trade_no"], trade["entry_execution"], now)
            exit_id = self.store.put_execution(product, trade["trade_no"], trade["exit_execution"], now)
            self.store.update_trade(product, trade["trade_no"], execution_model=trade["entry_execution"]["model"],
                                    entry_receipt_id=entry_id, exit_receipt_id=exit_id, execution_error=None)
        self.log("{} {}: cierre {} por {} — neto {} USD (costos {} USD, funding {} USD, {})".format(
            _hhmm(trade["exit_ms"]), product, "LARGO" if trade["side"] == "LONG" else "CORTO", trade["closed_by"],
            _usd(trade["net_usd"]), _usd(trade["fees_usd"]), _usd(trade["funding_usd"]), trade["funding_status"]))


# --------------------------------------------------------------------------- a new configuration, a new database

CHANGE_CLOSE = "cambio_de_version"                # exit_reason of a position closed because the configuration changed


def _restore_open_position(store, product, row):
    state = store.load_state(product)
    if state and state.get("position_json"):
        return position_from_json(state["position_json"])
    return qt.Position(
        side=row["side"], entry_ms=row["entry_ms"], entry_ref=float(row["entry_px"]), entry_px=D(row["entry_px"]),
        qty=D(row["qty"]), stop_px=row["stop_px"], stop_pct=None, max_hold_ms=row["max_hold_ms"],
        entry_p=row["entry_p"], entry_reason=row["entry_reason"], trade_no=row["trade_no"],
        mfe_bp=row["mfe_bp"] or 0.0, mae_bp=row["mae_bp"] or 0.0)


def _safe_funding_rows(funding_for, product):
    if not funding_for:
        return []
    try:
        return funding_for(product)
    except Exception:  # noqa: BLE001
        return []


def _close_open_trades(db_path, cfg, funding_for, now_ms, log):
    """Closes, in the database that is about to be archived, every position still open."""
    store = LiveStore(db_path)
    done = []
    try:
        open_rows = [dict(r) for r in store.db.execute("SELECT * FROM trades WHERE status='open' ORDER BY product, trade_no")]
        for row in open_rows:
            product = row["product"]
            position = _restore_open_position(store, product, row)
            mark_px = row["mark_px"] or position.entry_ref
            mark_ms = row["mark_ms"] or now_ms
            rows = _safe_funding_rows(funding_for, product)
            notional = D(row["notional_usd"] or cfg["notional_usd"])
            trader = qt.Trader(cfg, product, None, qt.FundingLine(rows), key=product, entry_threshold=cfg["entry_threshold"])
            trader.notional, trader.position = notional, position
            trader.t, trader.c = [int(mark_ms) - BAR_MS], [float(mark_px)]
            trade = [e["trade"] for e in trader.force_close("fin_de_bloque") if e["type"] == "trade"][0]
            trade["exit_reason"] = CHANGE_CLOSE
            leverage = D(row["leverage"] or "1")
            with store.db:
                store.put_trade(product, row["trade_no"], **closed_fields(trade, notional, leverage, notional / leverage, now_ms))
                store.db.execute("UPDATE trader_state SET position_json=NULL, window_json=NULL, updated_ms=? WHERE product=?",
                                 (now_ms, product))
            done.append((product, row["trade_no"], trade["net_usd"]))
            side_label = "LARGO" if row["side"] == "LONG" else "CORTO"
            log("Qwen en vivo: la posición {} de {} (n.º {}) estaba abierta en la base vieja: se cerró como fin_de_bloque / {} a "
                "{} — neto {} USD.".format(side_label, product, row["trade_no"], CHANGE_CLOSE,
                                           _hhmm(int(mark_ms)), _usd(trade["net_usd"])))
        return done
    finally:
        store.close()


def archive_other_config(db_path, cfg, **_legacy_options):
    """Deprecated guard; old funding/time/log options remain accepted but never recost or move an account."""
    unknown = set(_legacy_options) - {"funding_for", "now_ms", "log"}
    if unknown:
        raise TypeError("Unexpected archive options: " + ", ".join(sorted(unknown)))
    if not os.path.isfile(db_path):
        return None
    try:
        old = LiveStore(db_path, readonly=True)
        try:
            stored = old.meta()
            has_open = old.db.execute(OPEN_TRADE_QUERY).fetchone() is not None
            has_position = old.db.execute(
                OPEN_POSITION_QUERY).fetchone() is not None
        finally:
            old.close()
    except sqlite3.Error:
        return None                                   # not a live database (or an empty file): ``LiveStore`` deals with it
    wanted = identity_of(cfg)
    if not stored or all(stored.get(key, value) == value for key, value in wanted.items()):
        return None
    if has_open or has_position:
        raise qt.TraderError(
            "Hay una operación abierta de otra configuración: no se cierra, no se redimensiona ni se archiva. "
            "La nueva configuración requiere una transición explícita cuando el libro esté libre.")
    raise qt.TraderError(
        "La cuenta no se archiva ni se reinicia al cambiar Terminal. "
        "Usá --activate-flat-config con el libro plano para conservar saldo e historial.")


# --------------------------------------------------------------------------- learning data


_EXPORT_TRADE_KEYS = (
    "side", "entry_ms", "exit_ms", "net_bp", "funding_status", "closed_by", "hold_min", "mfe_bp",
    "mae_bp", "net_usd", "fees_usd", "funding_usd"
)


def _export_decision_line(r, seq_num, trades):
    product = r["product"]
    snapshot = json.loads(r["position_json"] or "null")
    trade_no = snapshot["trade_no"] if snapshot else r["trade_no"]
    trade = trades.get((product, trade_no)) if trade_no else None
    closed = trade if trade is not None and trade["status"] == "closed" else None
    outcome = None
    if closed is not None and r["kind"] == "flat" and r["action"] in ("LARGO", "CORTO"):
        outcome = {"type": "entry", "net_bp": closed["net_bp"], "closed_by": closed["closed_by"],
                   "hold_min": closed["hold_min"]}
    return {
        "schema": qt.DATASET_SCHEMA, "source": SOURCE, "fold": SOURCE, "block_id": "live:" + product,
        "seq": seq_num, "product": product, "t_ms": r["t_ms"], "kind": r["kind"],
        "state_text": r["state_text"], "state_hash": r["state_hash"],
        "wake": json.loads(r["wake_json"] or "null"), "orders": json.loads(r["orders_json"] or "null"),
        "probabilities": json.loads(r["probs_json"] or "null"), "confidence": r["confidence"],
        "model_action": r["model_action"], "action": r["action"], "p_action": r["p_action"],
        "entry_threshold": r["threshold"], "guardrail": {"override": r["override"], "forced": False},
        "reason": r["reason"], "reason_probabilities": (json.loads(r["reason_json"] or "null") or {}).get(
            "probabilities"),
        "mirror_action": r["mirror_action"], "mirror_p": r["mirror_p"],
        "position": snapshot, "net_bp_now": r["net_bp_now"], "exit_labels": None, "outcome": outcome,
        "trade": None if closed is None else {k: closed[k] for k in _EXPORT_TRADE_KEYS},
        "prompt_version": r["prompt_version"], "prompt_hash": r["prompt_hash"], "model": r["model"],
        "config_hash": r["config_hash"], "latency_ms": r["latency_ms"],
    }


def export_dataset(db_path, out_path, *_unused):
    """One JSON line per live decision in the format of ``futures_qwen_trader.export_dataset``."""
    store = LiveStore(db_path, readonly=True)
    try:
        trades = {(r["product"], r["trade_no"]): dict(r) for r in store.db.execute("SELECT * FROM trades")}
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        count = 0
        seq = {}
        with open(out_path, "w", encoding="utf-8") as out:
            for r in store.db.execute("SELECT * FROM decisions ORDER BY product, bucket_ms"):
                product = r["product"]
                seq[product] = seq.get(product, 0) + 1
                line = _export_decision_line(r, seq[product], trades)
                out.write(json.dumps(line, sort_keys=True, ensure_ascii=False) + "\n")
                count += 1
        return count
    finally:
        store.close()


# --------------------------------------------------------------------------- CLI


def resolve_db(path=None, env=None):
    env = os.environ if env is None else env
    return path or (env.get(DB_ENV) or "").strip() or DEFAULT_DB


def _wait_until_ready(operator, stop, sleep):
    failures = 0
    while not operator.ready and not (stop and stop()):
        try:
            operator.start()
        except qt.TraderError:
            raise
        except Exception as error:  # noqa: BLE001
            failures += 1
            operator.log("Qwen en vivo: no pudo arrancar ({}: {}); reintento.".format(type(error).__name__, error))
            sleep(min(60.0, operator.poll_s * 2 ** min(failures, 6)))


def run(operator, *, stop=None, sleep=time.sleep, max_polls=None):
    """Start, then poll every ``poll_s`` seconds until ``stop()`` is true (or ``max_polls``)."""
    _wait_until_ready(operator, stop, sleep)
    role = ("Qwen solo clasifica noticias; decisiones de velas sin modelo" if not qt.candle_opinions_enabled(operator.cfg)
            else "pregunta al modelo cada 15 minutos")
    operator.log("Qwen en vivo: en marcha; {} (productos: {}).".format(role, ", ".join(operator.cfg["products"])))
    polls, failures = 0, 0
    while not (stop and stop()):
        try:
            operator.poll()
            bad = operator.failed_cycle
        except Exception as error:  # noqa: BLE001
            operator._failure("ciclo", None, error)
            bad = True
        failures = failures + 1 if bad else 0
        polls += 1
        if operator.next_config is not None:
            operator = LiveOperator(
                operator.next_config, operator.store, operator.feed, operator.provider,
                now_ms=operator.now_ms, clock=operator.clock, log=operator.log)
            _wait_until_ready(operator, stop, sleep)
        if max_polls is not None and polls >= max_polls:
            break
        sleep(min(60.0, operator.poll_s * 2 ** min(failures, 6)) if failures else operator.poll_s)


def pending_config(cfg, spec) -> dict:
    if not isinstance(spec, dict) or set(spec) != {"path", "sha256"} or not isinstance(spec["path"], str):
        raise qt.TraderError("Traspaso: hacen falta una ruta y su SHA-256 aprobado.")
    path = spec["path"]
    if not os.path.isabs(path):
        path = os.path.join(os.path.dirname(qt.CONFIG_PATH_LIVE), path)
    with open(path, "rb") as handle:
        raw = handle.read()
    if hashlib.sha256(raw).hexdigest() != spec["sha256"]:
        raise qt.TraderError("Traspaso: el archivo cambió o no coincide con el SHA-256 aprobado.")
    overlay = json.loads(raw)
    if (not isinstance(overlay, dict) or overlay.get("schema") != "balancita-qwen-flow-transition.v1"
            or overlay.get("base_config_hash") != qt.config_hash(cfg)):
        raise qt.TraderError("Traspaso: la configuración de origen no coincide.")
    changes = overlay.get("changes")
    allowed = {"note", "corta", "noticias", "funding_model", "opinion_enabled", "live", "decide_by", "mirror", "execution"}
    if not isinstance(changes, dict) or not changes or set(changes) - allowed:
        raise qt.TraderError("Traspaso: cambios inválidos; no se redefine la cuenta ni su capital.")
    target = copy.deepcopy(cfg)
    _apply_pending_changes(target, changes)
    target.setdefault("runtime", {}).pop("pending_config", None)
    target["runtime"]["activation_request_sha256"] = spec["sha256"]
    return target


def _apply_pending_changes(target, changes):
    for key, value in changes.items():
        if key == "live":
            if not isinstance(value, dict):
                raise qt.TraderError("Traspaso: parámetros de ciclo inválidos.")
            target[key] = dict(target.get(key) or {}, **value)
        else:
            target[key] = value


def active_config(store, requested) -> dict:
    """Resume only a committed configuration descended from this known root, never an unknown override."""
    stored_hash = store.meta().get("config_hash")
    requested_hash = qt.config_hash(requested)
    if not stored_hash or stored_hash == requested_hash:
        return requested
    known = store.db.execute("SELECT 1 FROM config_versions WHERE config_hash=? LIMIT 1", (requested_hash,)).fetchone()
    last = store.db.execute("SELECT config_hash,config_json FROM config_versions ORDER BY id DESC LIMIT 1").fetchone()
    if known is None or last is None or last["config_hash"] != stored_hash:
        raise qt.TraderError("La configuración pedida no pertenece a la versión activa registrada; no se cambia la cuenta.")
    resumed = json.loads(last["config_json"])
    if qt.config_hash(resumed) != stored_hash:
        raise qt.TraderError("La configuración activa registrada no pasa su hash.")
    resumed["runtime"] = dict(resumed.get("runtime") or {}, **(requested.get("runtime") or {}))
    return resumed


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=qt.CONFIG_PATH_LIVE, help="default: %(default)s")
    parser.add_argument("--db", default=None, help="base en vivo (default: $QWEN_LIVE_DB o data/qwen-live/live.sqlite)")
    parser.add_argument("--archive-flat-book", action="store_true",
                        help="obsoleto: no permite reiniciar la cuenta; usar --activate-flat-config")
    parser.add_argument("--activate-flat-config", action="store_true",
                        help="activar explícitamente esta configuración en la misma cuenta, solo con el libro plano")
    parser.add_argument("--cache-dir", default=None, help="caché de velas públicas (default: junto a la base)")
    parser.add_argument("--llama-url", default=None, help="default http://127.0.0.1:$LLAMA_PORT (solo loopback)")
    parser.add_argument("--positioning-db", default=None, metavar="RUTA",
                        help="base del colector de posicionamiento, abierta SOLO lectura para el renglón F6 de la ficha (default: "
                             "$POSITIONING_DB_PATH o server/data/dev-live/positioning.sqlite, la que escribe pnpm dev); sin "
                             "base, F6 dice n/d y el proceso sigue")
    parser.add_argument("--export", default=None, metavar="SALIDA.jsonl",
                        help="no corre nada: escribe las decisiones guardadas para reentrenar offline y sale")
    parser.add_argument("--replay-trade", type=int, metavar="NUMERO",
                        help="recalcula una operación solo con sus recibos, sin red ni cambios en la cuenta")
    parser.add_argument("--product", choices=["PF_ETHUSD"], default="PF_ETHUSD",
                        help="producto de --replay-trade")
    return parser


def validate_activation(cfg, *, now_ms):
    if not noticias.priority_enabled(cfg):
        return
    validate_priority_config(cfg)
    spec = (cfg.get("corta") or {}).get("portero_autonomo")
    if not isinstance(spec, dict):
        raise qt.TraderError("No se activa el flujo nuevo: falta entrenar y declarar el Portero autónomo.")
    from . import futures_qwen_corta as corta
    from . import futures_qwen_independent_gate as independent
    teacher, _ = corta.formulas(cfg, now_ms)
    keeper = independent.load(spec)
    provenance = teacher.get("provenance") or {}
    cutoff = keeper["fit_until_ms"]
    last_label = provenance.get("last_label_end_ms")
    if (keeper.get("cold_start") is not True or provenance.get("cold_start") is not True
            or provenance.get("fit_until_ms") != cutoff or cutoff > now_ms
            or type(last_label) is not int or not 0 < last_label < cutoff):
        raise qt.TraderError("No se activa el flujo nuevo: hacen falta los dos candidatos en frío con el mismo corte válido.")
    if (cfg.get("funding_model") != qt.exact_funding.EXACT_MODEL
            or keeper.get("funding_model") != qt.exact_funding.EXACT_MODEL
            or provenance.get("funding_model") != qt.exact_funding.EXACT_MODEL):
        raise qt.TraderError("No se activa el flujo nuevo sin el funding absoluto y las etiquetas corregidas.")


def _run_live_owner(args, cfg, db_path, cache_dir, store, provider):
    account_start = (os.environ.get("QWEN_ACCOUNT_START_USD") or DEFAULT_ACCOUNT_START_USD).strip()
    if args.activate_flat_config:
        validate_activation(cfg, now_ms=int(time.time() * 1000))
        store.activate_flat_config(cfg, account_start_usd=account_start)
    else:
        cfg = active_config(store, cfg)
    store.check_identity(cfg, account_start_usd=account_start)
    if qt.candle_opinions_enabled(cfg) and not provider.health():
        consequence = ("Las fórmulas siguen decidiendo; falta la opinión de Qwen."
                       if cfg.get("decide_by") == "formula" else
                       "Cada despertar quedará omitido; no se opera sin respuesta.")
        print("Qwen en vivo: ATENCIÓN, el modelo local no responde en {}. {}".format(
            provider.base_url, consequence), flush=True)
    print("Qwen en vivo (paper, sin órdenes reales): config {}, base {}, modelo en {}".format(
        args.config, db_path, provider.base_url), flush=True)
    stopping = []
    for name in ("SIGINT", "SIGTERM"):
        signal.signal(getattr(signal, name), lambda *_: stopping.append(1))
    run(LiveOperator(cfg, store, PublicFeed(cache_dir), provider, log=lambda m: print(m, flush=True),
                     account_start_usd=account_start), stop=lambda: bool(stopping))
    print("Qwen en vivo: detenido; lo hecho quedó guardado.", flush=True)


def main(argv=None):
    args = _parser().parse_args(argv)
    db_path = resolve_db(args.db)
    try:
        if args.replay_trade is not None:
            if args.replay_trade <= 0 or args.export or args.activate_flat_config or args.archive_flat_book:
                raise qt.TraderError("El replay de recibos requiere un número positivo y no admite activar ni exportar.")
            if not os.path.isfile(db_path):
                raise qt.TraderError("No existe la cuenta para reproducir sus recibos.")
            store = LiveStore(db_path, readonly=True)
            try:
                print(json.dumps(store.replay_trade(args.product, args.replay_trade), sort_keys=True))
            finally:
                store.close()
            return 0
        if args.archive_flat_book and args.activate_flat_config:
            raise qt.TraderError("Elegí --activate-flat-config; la cuenta no se reinicia archivándola.")
        if args.export:
            if not os.path.exists(db_path):
                raise qt.TraderError("no existe la base {}".format(db_path))
            print("{} decisiones escritas en {}".format(export_dataset(db_path, args.export), args.export))
            return 0
        cfg = apply_overrides(qt.load_config(args.config))
        if args.positioning_db:
            cfg["positioning_db"] = os.path.abspath(args.positioning_db)      # where the file is, not what Qwen is asked: not identity
        cache_dir = args.cache_dir or os.path.join(os.path.dirname(os.path.abspath(db_path)), "cache")
        with ProcessLock(db_path):
            provider = qt._provider(args.llama_url, timeout=float((cfg.get("live") or {}).get("model_timeout_seconds", 60)))
            if args.archive_flat_book:
                archive_other_config(db_path, cfg, funding_for=PublicFeed(cache_dir).funding, log=lambda m: print(m, flush=True))
            store = LiveStore(db_path)
            try:
                _run_live_owner(args, cfg, db_path, cache_dir, store, provider)
            finally:
                store.close()
        return 0
    except KeyboardInterrupt:
        return 130
    except (qt.TraderError, HistoryError, ValueError) as error:
        print("error: {}".format(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
