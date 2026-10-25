"""Qwen operador EN VIVO (paper): el mismo ``Trader`` de la práctica, alimentado con velas públicas reales.

Sin claves, sin cuenta y sin órdenes reales: solo lee velas de 5 minutos y el funding PÚBLICOS de Kraken Futures
(``futures_history``) y le pregunta al llama-server local (127.0.0.1). Todo lo que "opera" es contabilidad en papel con los
costos reales de Kraken (``futures_costs``: 0,02 % maker / 0,05 % taker) y el funding publicado, calculados con ``settle``,
la misma cuenta que usa la práctica sobre historia (live == replay).

Cómo decide (``config/qwen-live.json``)
    * Cada 15 minutos, con o sin posición, y NUNCA en otro momento: no hay despertares extra (movimiento fuerte, cerca del
      stop, funding, movimiento grande). La clave de cada despertar es (producto, ventana de 15 minutos).
    * Qwen abre y cierra. Guardrails de explorador que no puede cambiar: stop a 1,5 x la volatilidad diaria acotado entre
      0,5 % y 3 %, cierre obligatorio a las 4 h y espera de 15 min después de cerrar. Tamaño fijo de 100 USD.
    * Si el modelo está caído o lento, ese despertar queda anotado como OMITIDO con el motivo y no se reintenta después:
      nunca se inventa una decisión y sin respuesta no se opera.

Una base propia (``data/qwen-live/live.sqlite`` o ``QWEN_LIVE_DB``) y UN solo proceso por base (candado de archivo). Si el
proceso se reinicia, recupera la posición abierta y no repite un despertar ya decidido.

    python -m balancita_engine.futures_qwen_live                      # corre hasta Ctrl+C
    python -m balancita_engine.futures_qwen_live --export datos.jsonl  # decisiones para reentrenar offline (sin modelo)
"""

import argparse
import json
import os
import signal
import sqlite3
import sys
import time
from decimal import Decimal

from . import futures_llm_decisions as llm
from . import futures_qwen_trader as qt
from .futures_products import is_product_id
from .futures_history import (DAY_MS, HOUR_MS, MINUTE_MS, CandleCache, HistoryError, fetch_candles, fetch_funding,
                              fill_gaps)

D = Decimal
BAR_MS = qt.BAR_MS
BUCKET_MS = 15 * MINUTE_MS                      # one wake per product and bucket
DB_ENV = "QWEN_LIVE_DB"
DEFAULT_DIR = os.path.join(qt.ROOT, "data", "qwen-live")
DEFAULT_DB = os.path.join(DEFAULT_DIR, "live.sqlite")
DEFAULT_CACHE = os.path.join(DEFAULT_DIR, "cache")
SCHEMA_VERSION = 1
SOURCE = "live"

# Motivos de un despertar omitido (se guardan tal cual y se muestran en la Terminal).
SKIP_TEXT = {
    "modelo_caido": "el modelo local no respondió",
    "modelo_lento": "el modelo local tardó más de lo permitido",
    "sin_respuesta": "el modelo contestó algo que no se pudo leer",
    "proceso_detenido": "el proceso estaba apagado a esa hora",
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


def apply_overrides(cfg, env=None):
    """The config with what the owner may change by environment: ``QWEN_LIVE_NOTIONAL_USD`` (size per trade, default the
    config's 100), ``QWEN_LIVE_LEVERAGE`` (default 1) and ``QWEN_LIVE_PRODUCTS`` (comma separated, default BTC and ETH) and the opportunity window of the entry search: ``QWEN_LIVE_FORCE_WINDOW_H`` (length, 0 = window off), ``QWEN_LIVE_FORCE_NEUTRAL_LEAN`` (a real lean under it counts as neutral, 0,05) and ``QWEN_LIVE_FORCE_MIN_SCORE`` (minimum score of a candidate, 0,15),
    ``QWEN_LIVE_FORCE_MIN_LOOKS`` and ``QWEN_LIVE_FORCE_SIDE_AFTER_H`` (optional start delay in hours, default 0). The
    only check is that sizes are positive numbers and products look like Kraken ids (``futures_costs`` prices any of them): there are no caps on purpose. A changed
    size, leverage or product list changes the config identity, so a database made with other values is refused; the window
    settings do not (they live in the ``live`` section, outside ``config_hash``)."""
    env = os.environ if env is None else env
    out = copy_config(cfg)
    notional = (env.get("QWEN_LIVE_NOTIONAL_USD") or "").strip()
    leverage = (env.get("QWEN_LIVE_LEVERAGE") or "").strip()
    products = (env.get("QWEN_LIVE_PRODUCTS") or "").strip()
    for name, key in (("QWEN_LIVE_FORCE_SIDE_AFTER_H", "force_side_after_h"), ("QWEN_LIVE_FORCE_WINDOW_H", "force_window_h"),
                      ("QWEN_LIVE_FORCE_MIN_LOOKS", "force_min_looks"),
                      ("QWEN_LIVE_FORCE_NEUTRAL_LEAN", "force_neutral_lean"), ("QWEN_LIVE_FORCE_MIN_SCORE", "force_min_score")):
        raw = (env.get(name) or "").strip()
        if not raw:
            continue
        try:
            number = D(raw)
        except Exception:
            number = None
        if number is None or not number.is_finite() or number < 0:
            raise qt.TraderError("{}: tiene que ser un número, 0 o más; llegó {!r}".format(name, raw))
        out.setdefault("live", {})[key] = float(number)
    out["notional_usd"] = format(_positive(notional or out["notional_usd"], "QWEN_LIVE_NOTIONAL_USD").normalize(), "f")
    out["leverage"] = format(_positive(leverage or out.get("leverage", "1"), "QWEN_LIVE_LEVERAGE").normalize(), "f")
    if products:
        out["products"] = [p.strip() for p in products.split(",") if p.strip()]
    if not out["products"] or len(set(out["products"])) != len(out["products"]):
        raise qt.TraderError("QWEN_LIVE_PRODUCTS: hace falta al menos un producto y sin repetir")
    for product in out["products"]:
        if not is_product_id(product):
            raise qt.TraderError("producto inválido: {!r} (ejemplo: PF_XBTUSD)".format(product))
    return out


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
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)


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

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions(
  product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, decided_at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL, action TEXT NOT NULL, model_action TEXT, p_action REAL, confidence REAL, probs_json TEXT,
  orders_json TEXT, override TEXT, reason TEXT, reason_json TEXT, mirror_action TEXT, mirror_p REAL, wake_json TEXT,
  state_text TEXT, state_hash TEXT, latency_ms INTEGER, threshold REAL, prompt_version TEXT, prompt_hash TEXT, model TEXT,
  config_hash TEXT, position_json TEXT, net_bp_now REAL, trade_no INTEGER,
  lean REAL, lean_m REAL, lean_num REAL, score REAL, best_score REAL, look_n INTEGER, mirror_ok INTEGER,
  PRIMARY KEY(product, bucket_ms));
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
CREATE TABLE IF NOT EXISTS trader_state(
  product TEXT PRIMARY KEY, last_fed_ms INTEGER, trade_seq INTEGER NOT NULL, cooldown_until INTEGER NOT NULL,
  last_call_ms INTEGER, position_json TEXT, updated_ms INTEGER NOT NULL, window_json TEXT);
"""

_ADDED_COLUMNS = {
    "decisions": (("lean", "REAL"), ("lean_m", "REAL"), ("lean_num", "REAL"), ("score", "REAL"), ("best_score", "REAL"),
                  ("look_n", "INTEGER"), ("mirror_ok", "INTEGER")),
    "trader_state": (("window_json", "TEXT"),),
}

_TRADE_COLUMNS = ("status", "side", "entry_ms", "exit_ms", "entry_px", "exit_px", "qty", "notional_usd", "gross_usd",
                  "fees_usd", "funding_usd", "net_usd", "net_bp", "funding_status", "closed_by", "exit_reason",
                  "entry_reason", "entry_p", "hold_min", "mfe_bp", "mae_bp", "stop_px", "max_hold_ms", "mark_px",
                  "mark_ms", "net_now_usd", "opened_at_ms", "closed_at_ms", "leverage", "margin_usd")


def position_to_json(position):
    return json.dumps({"side": position.side, "entry_ms": position.entry_ms, "entry_ref": position.entry_ref,
                       "entry_px": str(position.entry_px), "qty": str(position.qty), "stop_px": position.stop_px,
                       "stop_pct": position.stop_pct, "max_hold_ms": position.max_hold_ms, "entry_p": position.entry_p,
                       "entry_reason": position.entry_reason, "trade_no": position.trade_no, "mfe_bp": position.mfe_bp,
                       "mae_bp": position.mae_bp}, sort_keys=True)


def position_from_json(text):
    raw = json.loads(text)
    raw["entry_px"], raw["qty"] = D(raw["entry_px"]), D(raw["qty"])
    return qt.Position(**raw)


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

    def check_identity(self, cfg):
        """A live database belongs to one config: a position opened under other rules must not be judged under these."""
        wanted = {"schema_version": SCHEMA_VERSION, "config_hash": qt.config_hash(cfg),
                  "prompt_version": cfg["prompt"]["version"], "products": list(cfg["products"])}
        stored = self.meta()
        for key, value in wanted.items():
            if key in stored and stored[key] != value:
                raise qt.TraderError(
                    "Qwen en vivo: esta base se hizo con otra configuración ({} era {!r} y ahora es {!r}). Usá una base nueva "
                    "con QWEN_LIVE_DB o --db; la actual no se toca.".format(key, stored[key], value))
        for key, value in wanted.items():
            if key not in stored:
                self.set_meta(key, value)

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
            "trade_no, lean, lean_m, lean_num, score, best_score, look_n, mirror_ok) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (product, event["t_ms"] - BUCKET_MS, event["t_ms"], now_ms, event["kind"], event["action"],
             event.get("model_action"), event.get("p_action"), answer.get("confidence"),
             json.dumps(answer.get("probabilities")), json.dumps(orders), event.get("override"), event.get("reason"),
             json.dumps(reason_answer), event.get("mirror_action"), event.get("mirror_p"), json.dumps(event.get("wake")),
             event.get("state_text"), event.get("state_hash"), answer.get("latency_ms"), event.get("threshold"),
             str(meta["prompt_version"]), orders[0].get("prompt_hash"), meta["model"], meta["config_hash"],
             json.dumps(event.get("position")), event.get("net_bp_now"), event.get("trade_no"), event.get("lean"),
             event.get("lean_m"), event.get("lean_num"), event.get("score"), event.get("best_score"), event.get("look_n"),
             None if event.get("mirror_ok") is None else int(event["mirror_ok"])))

    def put_skipped(self, product, t_ms, kind, detail, wake, now_ms):
        self.db.execute("INSERT OR IGNORE INTO skipped VALUES(?,?,?,?,?,?,?)",
                        (product, t_ms - BUCKET_MS, t_ms, now_ms, kind, detail, json.dumps(wake)))

    # ---- trades

    def put_trade(self, product, trade_no, **fields):
        """Insert or update one trade; a field given as ``None`` keeps what is already there."""
        values = {name: fields.get(name) for name in _TRADE_COLUMNS}
        names = ("product", "trade_no") + _TRADE_COLUMNS
        sets = ", ".join("{0}=COALESCE(excluded.{0}, {0})".format(c) for c in _TRADE_COLUMNS)
        self.db.execute(
            "INSERT INTO trades({}) VALUES({}) ON CONFLICT(product, trade_no) DO UPDATE SET {}".format(
                ", ".join(names), ",".join("?" * len(names)), sets),
            (product, trade_no) + tuple(values[c] for c in _TRADE_COLUMNS))

    def update_trade(self, product, trade_no, **fields):
        """Changes some fields of a trade that already exists."""
        names = sorted(fields)
        self.db.execute("UPDATE trades SET {} WHERE product=? AND trade_no=?".format(", ".join(n + "=?" for n in names)),
                        tuple(fields[n] for n in names) + (product, trade_no))

    def last_entry_ms(self, product):
        row = self.db.execute("SELECT MAX(entry_ms) AS m FROM trades WHERE product=?", (product,)).fetchone()
        return row["m"]

    def incomplete_funding(self, product):
        return [dict(r) for r in self.db.execute(
            "SELECT * FROM trades WHERE product=? AND status='closed' AND funding_status != 'complete'", (product,))]


# --------------------------------------------------------------------------- the public feed


class PublicFeed:
    """Kraken's PUBLIC 5m candles (through the candle cache) and hourly funding. No account, no keys.

    The history layer of the practice refuses anything after the holdout; this feed lives in the present on purpose, so it
    uses the cache and the fetchers directly."""

    def __init__(self, cache_dir, fetch=fetch_candles, fetch_funding_fn=fetch_funding):
        self.cache_dir, self._fetch, self._fetch_funding = cache_dir, fetch, fetch_funding_fn

    def bars(self, product, from_ms, to_ms):
        """Closed 5m candles of ``[from_ms, to_ms)``; downloads only what the cache lacks."""
        cache = CandleCache(os.path.join(self.cache_dir, "candles-{}.sqlite".format(product)))
        try:
            cache.ensure(product, "5m", from_ms, to_ms, fetch=self._fetch)
            return cache.read(product, "5m", from_ms, to_ms)
        finally:
            cache.close()

    def funding(self, product):
        return [(int(s), float(r)) for s, r in self._fetch_funding(product)]


# --------------------------------------------------------------------------- the decider the Trader sees


class WakeGate:
    """Sits between ``Trader`` and ``LlmDecider``. It turns "the model cannot answer" into ``WakeSkipped`` (the wake is
    recorded as omitted and never retried) and refuses to ask at all for wakes that are too old or already decided."""

    def __init__(self, inner, provider, budget_s, clock=time.monotonic):
        self.inner, self.provider, self.budget_s, self.clock = inner, provider, budget_s, clock
        self.mode = "live"
        self._healthy = None

    def begin(self, mode):
        """``live``: ask the model. ``late``: this wake is older than allowed. ``done``: this bucket was already decided."""
        self.mode, self._healthy = mode, None
        if mode == "live":
            self.inner.deadline = self.clock() + self.budget_s
            self.inner.down = 0

    def ask(self, key, t_ms, step, question, state_text, *, single=False):
        if self.mode == "late":
            raise qt.WakeSkipped("proceso_detenido", SKIP_TEXT["proceso_detenido"])
        if self.mode == "done":
            raise qt.WakeSkipped("ya_decidido", "")
        if self._healthy is None:
            self._healthy = bool(self.provider.health())
        if not self._healthy:
            raise qt.WakeSkipped("modelo_caido", SKIP_TEXT["modelo_caido"])
        try:
            return self.inner.ask(key, t_ms, step, question, state_text, single=single)
        except qt.ModelDown:
            raise qt.WakeSkipped("modelo_caido", SKIP_TEXT["modelo_caido"]) from None
        except qt.BudgetExhausted:
            raise qt.WakeSkipped("modelo_lento", SKIP_TEXT["modelo_lento"]) from None


# --------------------------------------------------------------------------- the operator


def _hhmm(ms):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(ms / 1000)) + " UTC"


def _usd(value):
    return "{:+.2f}".format(float(value))


def _flat_candle(close_text, bucket):
    return {"bucket_start": bucket, "open": close_text, "high": close_text, "low": close_text, "close": close_text,
            "volume_btc": "0"}


class LiveOperator:
    """Feeds one ``Trader`` per product with closed public candles and records what happens.

    ``feed`` (``PublicFeed`` or a fake in tests), ``provider`` (llama-server on loopback or a fake), ``now_ms`` (the wall clock
    in milliseconds)."""

    def __init__(self, cfg, store, feed, provider, *, now_ms=lambda: int(time.time() * 1000), clock=time.monotonic,
                 log=print, model=None):
        self.cfg, self.store, self.feed, self.provider = cfg, store, feed, provider
        self.now_ms, self.clock, self.log = now_ms, clock, log
        live = cfg.get("live") or {}
        self.warmup_ms = int(live.get("warmup_days", 8)) * DAY_MS
        self.poll_s = float(live.get("poll_seconds", 30))
        self.max_late_ms = int(float(live.get("max_late_seconds", 240)) * 1000)
        self.funding_every_ms = int(float(live.get("funding_refresh_minutes", 30)) * MINUTE_MS)
        self.notional = D(cfg["notional_usd"])
        self.leverage = D(str(cfg.get("leverage", "1")))
        self.margin = self.notional / self.leverage           # money set aside; costs and funding run on the notional
        served = getattr(provider, "served_model", None)
        self.model = model or (served() if callable(served) else None) or getattr(provider, "model_ref", None) or "unknown"
        inner = qt.LlmDecider(provider, cfg, clock=clock, model=self.model)
        self.gate = WakeGate(inner, provider, float(live.get("wake_budget_seconds", 240)), clock)
        self.config_hash = qt.config_hash(cfg)
        self.traders = {}
        self.funding_checked_ms = 0
        self.ready = False
        self.model_ok = None                              # None: not probed yet
        self._probe_failures, self._next_probe = 0, 0.0
        self._errors = {}
        self.failed_cycle = False

    # ---- start

    def start(self):
        """Warm up every product with ~8 days of candles (never traded) and restore the open position, if any."""
        self.store.check_identity(self.cfg)
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
        last_open = self.store.last_entry_ms(product)
        trader.last_open_ms = last_open
        trader.idle_since_ms = now                    # no opening on record: counted from this start
        self.traders[product] = trader
        bars = fill_gaps(self.feed.bars(product, (now // BAR_MS) * BAR_MS - self.warmup_ms, now), BAR_MS)
        bars = [b for b in bars if b["bucket_start"] + BAR_MS <= now]
        warm = [b for b in bars if (b["bucket_start"] <= last_fed if last_fed is not None
                                    else now - (b["bucket_start"] + BAR_MS) > self.max_late_ms)]
        for bar in warm:
            trader.feed(bar, trade=False)
        self.log("Qwen en vivo: {} calentado con {} velas de 5 min{}.".format(
            product, len(warm), "" if trader.position is None else
            " (posición {} recuperada, abierta desde {})".format(
                "LARGO" if trader.position.side == "LONG" else "CORTO", _hhmm(trader.position.entry_ms))))
        for bar in bars[len(warm):]:
            self._process(product, bar)

    # ---- one poll

    def poll(self):
        """Looks for newly closed candles and feeds them in order. Nothing that goes wrong in here ends the process: a
        failure of one product is recorded in ``errors`` and that product is rebuilt from the database on the next poll
        (what was not written is asked again; what was written is never asked twice)."""
        now = self.now_ms()
        self.failed_cycle = False
        self._check_model()
        try:
            if now - self.funding_checked_ms >= self.funding_every_ms:
                self._refresh_funding(now)
                self._recovered("funding", None)
        except Exception as error:                        # noqa: BLE001
            self._failure("funding", None, error)
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
        self._heartbeat()

    def _poll_product(self, product, now):
        trader = self.traders[product]
        try:
            fresh = self.feed.bars(product, trader.t[-1] + BAR_MS if trader.t else now - self.warmup_ms, now)
        except (HistoryError, OSError, ValueError) as error:
            self.log("Qwen en vivo: no se pudieron leer las velas de {} ({}); se reintenta en el próximo ciclo."
                     .format(product, error))
            return
        for bar in fresh:
            if bar["bucket_start"] + BAR_MS > now or (trader.t and bar["bucket_start"] <= trader.t[-1]):
                continue
            while trader.t and bar["bucket_start"] > trader.t[-1] + BAR_MS:
                self._process(product, _flat_candle(repr(trader.c[-1]), trader.t[-1] + BAR_MS))
            self._process(product, bar)

    # ---- resilience: model state, unexpected failures, heartbeat

    def _check_model(self):
        """Tracks whether llama-server answers /health. One log line per change of state; while it is down the probe backs
        off (5 s, 10 s ... 60 s). Does not decide anything: each wake still asks for itself."""
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
        self._meta("heartbeat_ms", self.now_ms())

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
        """Funding of the last hour is published after it ends: a trade closed meanwhile is settled again, with the same
        formula as ``settle``, once the periods it touched are known. Never changes anything else."""
        line = self.traders[product].funding
        with self.store.db:
            for row in self.store.incomplete_funding(product):
                long = row["side"] == "LONG"
                paid, covered = line.accrue(row["entry_ms"], row["exit_ms"], D(row["entry_px"]) * D(row["qty"]), long)
                held = max(0, row["exit_ms"] - row["entry_ms"])
                status = "complete" if held and covered >= held else ("partial" if covered > 0 else "unknown")
                if status == row["funding_status"] and str(paid) == row["funding_usd"]:
                    continue
                net = D(row["gross_usd"]) - D(row["fees_usd"]) - paid
                self.store.update_trade(product, row["trade_no"], funding_usd=str(paid), funding_status=status,
                                        net_usd=str(net), net_bp=float(net / self.notional * 10_000))

    # ---- one candle

    def _process(self, product, bar):
        trader = self.traders[product]
        t_ms = int(bar["bucket_start"]) + BAR_MS
        now = self.now_ms()
        if self.store.bucket_done(product, t_ms):
            self.gate.begin("done")
        else:
            self.gate.begin("late" if now - t_ms > self.max_late_ms else "live")
        events = trader.feed(bar)
        self._record(product, trader, t_ms, events, now)

    def _record(self, product, trader, t_ms, events, now):
        meta = {"prompt_version": self.cfg["prompt"]["version"], "model": self.model, "config_hash": self.config_hash}
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
                    if event.get("answer") is None:               # DecisionError: the model gave nothing usable
                        self.store.put_skipped(product, event["t_ms"], "sin_respuesta", SKIP_TEXT["sin_respuesta"],
                                               event["wake"], now)
                        self.log("{} {}: despertar omitido ({}); no se reintenta.".format(
                            _hhmm(event["t_ms"]), product, SKIP_TEXT["sin_respuesta"]))
                        continue
                    self.store.put_decision(product, event, meta, now)
                    self.log("{} {}: {}{} (p {:.2f}, confianza {:.2f}){}".format(
                        _hhmm(event["t_ms"]), product, event["action"],
                        "" if event["action"] == event.get("model_action") or not event.get("model_action")
                        else " [el modelo dijo {}]".format(event["model_action"]),
                        event.get("p_action") or 0.0, event["answer"]["confidence"],
                        " — entró en la mejor ocasión de la ventana (puntaje {:.3f}, chequeo {})".format(
                            event["score"], event["look_n"]) if event.get("forced")
                        else " — mirando la mejor ocasión (chequeo {}: puntaje {:.3f}, mejor {:.3f}, espejo {})".format(
                            event["look_n"], event["score"], event["best_score"], "coincide" if event["mirror_ok"] else "no coincide")
                        if event.get("override") == "ventana_mirando"
                        else "" if not event.get("override") else " — sin operar: " + str(event["override"])))
            position = trader.position
            if position is not None:
                self._write_open(product, trader, position, t_ms, now)
            self.store.save_state(product, trader, t_ms - BAR_MS, now)

    def _write_open(self, product, trader, position, t_ms, now):
        mark = qt.settle(product, position, trader.c[-1], "strategy_exit", t_ms, trader.funding, self.notional)
        self.store.put_trade(
            product, position.trade_no, status="open", side=position.side, entry_ms=position.entry_ms,
            entry_px=str(position.entry_px), qty=str(position.qty), notional_usd=str(self.notional),
            leverage=str(self.leverage), margin_usd=str(self.margin), entry_reason=position.entry_reason, entry_p=position.entry_p, mfe_bp=round(position.mfe_bp, 2),
            mae_bp=round(position.mae_bp, 2), stop_px=position.stop_px, max_hold_ms=position.max_hold_ms,
            mark_px=trader.c[-1], mark_ms=t_ms, net_now_usd=str(mark["net_usd"]), opened_at_ms=now)

    def _write_closed(self, product, trade, now):
        self.store.put_trade(
            product, trade["trade_no"], status="closed", side=trade["side"], entry_ms=trade["entry_ms"],
            exit_ms=trade["exit_ms"], entry_px=trade["entry_fill"], exit_px=repr(trade["exit_px"]), qty=trade["qty"],
            notional_usd=str(self.notional), leverage=str(self.leverage), margin_usd=str(self.margin),
            gross_usd=trade["gross_usd"], fees_usd=trade["fees_usd"],
            funding_usd=trade["funding_usd"], net_usd=trade["net_usd"], net_bp=trade["net_bp"],
            funding_status=trade["funding_status"], closed_by=trade["closed_by"], exit_reason=trade["exit_reason"],
            entry_reason=trade["entry_reason"], entry_p=trade["entry_p"], hold_min=trade["hold_min"],
            mfe_bp=trade["mfe_bp"], mae_bp=trade["mae_bp"], closed_at_ms=now)
        self.log("{} {}: cierre {} por {} — neto {} USD (costos {} USD, funding {} USD, {})".format(
            _hhmm(trade["exit_ms"]), product, "LARGO" if trade["side"] == "LONG" else "CORTO", trade["closed_by"],
            _usd(trade["net_usd"]), _usd(trade["fees_usd"]), _usd(trade["funding_usd"]), trade["funding_status"]))


# --------------------------------------------------------------------------- learning data


def export_dataset(db_path, out_path, cfg=None):
    """One JSON line per live decision in the format of ``futures_qwen_trader.export_dataset`` (same schema), with
    ``source = live``: the state text exactly as prompted, the answer, the guardrail info and, when the trade is known,
    its result. The 60-minute labels are filled offline from the candles (``outcome`` / ``exit_labels`` stay null here).
    Read-only; returns the number of lines."""
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
                snapshot = json.loads(r["position_json"] or "null")
                trade_no = snapshot["trade_no"] if snapshot else r["trade_no"]
                trade = trades.get((product, trade_no)) if trade_no else None
                closed = trade if trade is not None and trade["status"] == "closed" else None
                outcome = None
                if closed is not None and r["kind"] == "flat" and r["action"] in ("LARGO", "CORTO"):
                    outcome = {"type": "entry", "net_bp": closed["net_bp"], "closed_by": closed["closed_by"],
                               "hold_min": closed["hold_min"]}
                line = {
                    "schema": qt.DATASET_SCHEMA, "source": SOURCE, "fold": SOURCE, "block_id": "live:" + product,
                    "seq": seq[product], "product": product, "t_ms": r["t_ms"], "kind": r["kind"],
                    "state_text": r["state_text"], "state_hash": r["state_hash"],
                    "wake": json.loads(r["wake_json"] or "null"), "orders": json.loads(r["orders_json"] or "null"),
                    "probabilities": json.loads(r["probs_json"] or "null"), "confidence": r["confidence"],
                    "model_action": r["model_action"], "action": r["action"], "p_action": r["p_action"],
                    "entry_threshold": r["threshold"], "guardrail": {"override": r["override"], "forced": False},
                    "reason": r["reason"], "reason_probabilities": (json.loads(r["reason_json"] or "null") or {}).get(
                        "probabilities"),
                    "mirror_action": r["mirror_action"], "mirror_p": r["mirror_p"],
                    "position": snapshot, "net_bp_now": r["net_bp_now"], "exit_labels": None, "outcome": outcome,
                    "trade": None if closed is None else {k: closed[k] for k in (
                        "side", "entry_ms", "exit_ms", "net_bp", "funding_status", "closed_by", "hold_min", "mfe_bp",
                        "mae_bp", "net_usd", "fees_usd", "funding_usd")},
                    "prompt_version": r["prompt_version"], "prompt_hash": r["prompt_hash"], "model": r["model"],
                    "config_hash": r["config_hash"], "latency_ms": r["latency_ms"]}
                out.write(json.dumps(line, sort_keys=True, ensure_ascii=False) + "\n")
                count += 1
        return count
    finally:
        store.close()


# --------------------------------------------------------------------------- CLI


def resolve_db(path=None, env=None):
    env = os.environ if env is None else env
    return path or (env.get(DB_ENV) or "").strip() or DEFAULT_DB


def run(operator, *, stop=None, sleep=time.sleep, max_polls=None):
    """Start, then poll every ``poll_s`` seconds until ``stop()`` is true (or ``max_polls``). Only a signal, the lock or a
    wrong database identity end it: an unexpected failure of a cycle is recorded and the loop goes on, with a bounded
    backoff (poll_s doubling, at most 60 s) while cycles keep failing."""
    failures = 0
    while not operator.ready and not (stop and stop()):
        try:
            operator.start()
        except qt.TraderError:
            raise
        except Exception as error:                        # noqa: BLE001 - e.g. a busy database at start
            failures += 1
            operator.log("Qwen en vivo: no pudo arrancar ({}: {}); reintento.".format(type(error).__name__, error))
            sleep(min(60.0, operator.poll_s * 2 ** min(failures, 6)))
    operator.log("Qwen en vivo: en marcha. Pregunta al modelo cada 15 minutos (productos: {}).".format(
        ", ".join(operator.cfg["products"])))
    polls, failures = 0, 0
    while not (stop and stop()):
        try:
            operator.poll()
            bad = operator.failed_cycle
        except Exception as error:                        # noqa: BLE001 - nothing may end the loop
            operator._failure("ciclo", None, error)
            bad = True
        failures = failures + 1 if bad else 0
        polls += 1
        if max_polls is not None and polls >= max_polls:
            break
        sleep(min(60.0, operator.poll_s * 2 ** min(failures, 6)) if failures else operator.poll_s)


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=qt.CONFIG_PATH_LIVE, help="default: %(default)s")
    parser.add_argument("--db", default=None, help="base en vivo (default: $QWEN_LIVE_DB o data/qwen-live/live.sqlite)")
    parser.add_argument("--cache-dir", default=None, help="caché de velas públicas (default: junto a la base)")
    parser.add_argument("--llama-url", default=None, help="default http://127.0.0.1:$LLAMA_PORT (solo loopback)")
    parser.add_argument("--export", default=None, metavar="SALIDA.jsonl",
                        help="no corre nada: escribe las decisiones guardadas para reentrenar offline y sale")
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    db_path = resolve_db(args.db)
    try:
        if args.export:
            if not os.path.exists(db_path):
                raise qt.TraderError("no existe la base {}".format(db_path))
            print("{} decisiones escritas en {}".format(export_dataset(db_path, args.export), args.export))
            return 0
        cfg = apply_overrides(qt.load_config(args.config))
        cache_dir = args.cache_dir or os.path.join(os.path.dirname(os.path.abspath(db_path)), "cache")
        with ProcessLock(db_path):
            provider = qt._provider(args.llama_url, timeout=float((cfg.get("live") or {}).get("model_timeout_seconds", 60)))
            store = LiveStore(db_path)
            try:
                if not provider.health():
                    print("Qwen en vivo: ATENCIÓN, el modelo local no responde en {}. Cada despertar quedará anotado como "
                          "omitido hasta que vuelva; no se opera sin respuesta.".format(provider.base_url), flush=True)
                print("Qwen en vivo (paper, sin órdenes reales): config {}, base {}, modelo en {}".format(
                    args.config, db_path, provider.base_url), flush=True)
                stopping = []
                for name in ("SIGINT", "SIGTERM"):
                    signal.signal(getattr(signal, name), lambda *_: stopping.append(1))
                run(LiveOperator(cfg, store, PublicFeed(cache_dir), provider, log=lambda m: print(m, flush=True)),
                    stop=lambda: bool(stopping))
                print("Qwen en vivo: detenido; lo hecho quedó guardado.", flush=True)
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
