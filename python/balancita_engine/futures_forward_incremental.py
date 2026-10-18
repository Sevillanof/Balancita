"""Forward incremental, PR 1: estado exacto, núcleo ``step`` y checkpoints encadenados (aún sin usar en el bucle).

Ver ``docs/diseno-forward-incremental.md``. Este módulo NO es llamado por ``futures_forward.run_forward``: el bucle
horario sigue por la ruta completa. Aquí está lo que el diseño pide antes de cambiarlo:

* ``FrameStream``: lo mismo que ``futures_simulator.frames`` pero reanudable (``feed`` por trozos, ``to_state`` /
  ``from_state``). ``frames`` no se toca a propósito: su fuente entra en ``signal_continuity.pipeline_hash`` y cambiarla
  invalidaría las estrategias congeladas; la igualdad con ``frames`` la fija el test de equivalencia.
* Serialización exacta (Decimal como texto) de ``IncrementalFeatures``, del régimen, de la posición abierta, de las
  decisiones vivas y de los contadores del ``Book``.
* ``SeriesRunner.step(velas)``: trozo de velas -> trades nuevos, sin releer historia.
* ``forward_checkpoint`` (solo-añadir, cadena de hashes) y ``commit_cycle``: trades + era + estado + checkpoint en una
  sola transacción ``BEGIN IMMEDIATE``.

Fuera de alcance de este PR: frontera contigua y ``GAP_GRACE`` (cursor), anomalías de velas tardías, vistas derivadas
(``forward_open``/``forward_status``), migración y ``--rebuild``. La percentil de funding ``fundpct`` está descartada
(decisión del dueño, 2026-10-18): un spec que la use se rechaza.
"""

import hashlib
import inspect
import json
import time
from collections import deque
from decimal import Decimal

from . import futures_indicators, futures_simulator
from .futures_forward import _SCHEMA as FORWARD_SCHEMA
from .futures_simulator import (
    DEFAULT_PERIODS,
    FIVE_MINUTES_MS,
    ONE_MINUTE_MS,
    REGIME_PERIODS,
    Book,
    IncrementalFeatures,
    merge_periods,
)
from .futures_spec_strategy import declared_indicators, spec_hash
from .futures_strategies import update_regime

D = Decimal
STATE_VERSION = 1
GENESIS = "0" * 64
ERA_NOW = "actual"  # igual que futures_forward.ERA_NOW (no se importa para no acoplar los módulos)

# Claves de ``Book.position`` que son Decimal; el resto son int/str/None. ``decision`` es una referencia.
_POSITION_DECIMALS = ("entry", "stop", "target", "quantity")

CHECKPOINT_SCHEMA = """
CREATE TABLE IF NOT EXISTS forward_checkpoint(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, spec_hash TEXT NOT NULL, seq INTEGER NOT NULL,
  last_bucket_ms INTEGER, last_5m_ms INTEGER, policy TEXT NOT NULL, era TEXT NOT NULL,
  catalog_version TEXT NOT NULL, state_version INTEGER NOT NULL, origin TEXT NOT NULL,
  state_sha256 TEXT NOT NULL, prev_sha256 TEXT NOT NULL, created_ms INTEGER NOT NULL,
  PRIMARY KEY(strategy_id, product_id, spec_hash, seq)) STRICT;
CREATE TABLE IF NOT EXISTS forward_checkpoint_blob(
  state_sha256 TEXT NOT NULL PRIMARY KEY, json TEXT NOT NULL) STRICT;
CREATE TRIGGER IF NOT EXISTS forward_checkpoint_no_update BEFORE UPDATE ON forward_checkpoint
  BEGIN SELECT RAISE(ABORT, 'forward checkpoints are append-only'); END;
CREATE TRIGGER IF NOT EXISTS forward_checkpoint_no_delete BEFORE DELETE ON forward_checkpoint
  BEGIN SELECT RAISE(ABORT, 'forward checkpoints are append-only'); END;
CREATE TRIGGER IF NOT EXISTS forward_checkpoint_blob_no_update BEFORE UPDATE ON forward_checkpoint_blob
  BEGIN SELECT RAISE(ABORT, 'forward checkpoint blobs are immutable'); END;
"""
_CHECKPOINT_COLUMNS = ("strategy_id", "product_id", "spec_hash", "seq", "last_bucket_ms", "last_5m_ms", "policy", "era",
                       "catalog_version", "state_version", "origin", "state_sha256", "prev_sha256", "created_ms")


class CheckpointError(Exception):
    """La serie no se puede reanudar: ``code`` estable y ``reason`` legible. La serie se detiene, no calcula."""

    def __init__(self, code, reason):
        super().__init__("{}: {}".format(code, reason))
        self.code, self.reason = code, reason


class ConcurrentCycle(CheckpointError):
    def __init__(self, reason):
        super().__init__("concurrent_cycle", reason)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_json(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def catalog_version():
    """Hash de lo que da significado a un estado guardado: indicadores, régimen y versión del formato."""
    return sha256_json([
        "catalog.v1", STATE_VERSION, futures_indicators.FEATURE_SCHEMA_VERSION, futures_indicators.INDICATOR_PRECISION,
        futures_indicators.MINIMUM_CANDLES, repr(DEFAULT_PERIODS), repr(REGIME_PERIODS), repr(futures_simulator.LOG_KINDS),
        inspect.getsource(IncrementalFeatures), inspect.getsource(update_regime)])


# ---- IncrementalFeatures -------------------------------------------------------------------------------------------

def _dec(value):
    return None if value is None else str(value)


def _undec(value):
    return None if value is None else D(value)


def features_to_state(features):
    """Estado exacto de un ``IncrementalFeatures`` (Decimal como texto, claves de periodo como texto)."""
    return {
        "periods": {kind: list(values) for kind, values in features.periods.items()},
        "count": features.count,
        "closes": [str(v) for v in features.closes], "highs": [str(v) for v in features.highs],
        "lows": [str(v) for v in features.lows], "volumes": [str(v) for v in features.volumes],
        "ema": {str(p): [_dec(s[0]), [str(v) for v in s[1]]] for p, s in features._ema.items()},
        "atr": {str(p): [_dec(s[0]), [str(v) for v in s[1]]] for p, s in features._atr.items()},
        "rsi": {str(p): [_dec(s[0]), _dec(s[1]), [[str(g), str(l)] for g, l in s[2]]] for p, s in features._rsi.items()},
        "prev_close": _dec(features._prev_close),
        "logvol": {str(p): [_dec(s[0]), s[1]] for p, s in features._logvol.items()},
    }


def features_from_state(state):
    features = IncrementalFeatures({kind: tuple(values) for kind, values in state["periods"].items()})
    features.count = state["count"]
    for name in ("closes", "highs", "lows", "volumes"):
        getattr(features, name).extend(D(v) for v in state[name])
    features._ema = {int(p): [_undec(s[0]), [D(v) for v in s[1]]] for p, s in state["ema"].items()}
    features._atr = {int(p): [_undec(s[0]), [D(v) for v in s[1]]] for p, s in state["atr"].items()}
    features._rsi = {int(p): [_undec(s[0]), _undec(s[1]), [(D(g), D(l)) for g, l in s[2]]] for p, s in state["rsi"].items()}
    features._prev_close = _undec(state["prev_close"])
    features._logvol = {int(p): [_undec(s[0]), s[1]] for p, s in state["logvol"].items()}
    return features


# ---- frames reanudables ---------------------------------------------------------------------------------------------

class FrameStream:
    """``futures_simulator.frames`` por trozos. Una vela 1m o 5m que no es posterior al cursor se ignora (no cambia el estado)."""

    def __init__(self, periods=None):
        merged = merge_periods(DEFAULT_PERIODS if periods is None else periods, REGIME_PERIODS)
        self.periods = merged
        self.one, self.five = IncrementalFeatures(merged), IncrementalFeatures(merged)
        self.pending = deque()           # 5m recibidas que aún no cierran antes de la 1m en curso
        self.trend = self.previous = None
        self.regime = "unknown"
        self.last_bucket_ms = None       # última 1m procesada
        self.last_5m_ms = None           # última 5m procesada
        self._last_5m_seen = None        # última 5m aceptada (procesada o pendiente)
        self.ignored = 0

    def feed(self, candles_1m, candles_5m=()):
        for candle in candles_5m:
            if self._last_5m_seen is not None and candle["bucket_start"] <= self._last_5m_seen:
                self.ignored += 1
                continue
            self._last_5m_seen = candle["bucket_start"]
            self.pending.append(candle)
        for candle in candles_1m:
            if self.last_bucket_ms is not None and candle["bucket_start"] <= self.last_bucket_ms:
                self.ignored += 1
                continue
            current = self.one.update(candle)
            close_at = candle["bucket_start"] + ONE_MINUTE_MS
            while self.pending and self.pending[0]["bucket_start"] + FIVE_MINUTES_MS <= close_at:
                waiting = self.pending.popleft()
                self.trend = self.five.update(waiting)
                self.last_5m_ms = waiting["bucket_start"]
            if self.trend is not None:
                self.regime = update_regime(self.regime, self.trend.get("ema9"), self.trend.get("ema21"),
                                            self.trend.get("atr14"))
            frame = (candle["bucket_start"], current, self.previous, self.trend, self.regime)
            self.previous = current
            self.last_bucket_ms = candle["bucket_start"]
            yield frame

    def to_state(self):
        return {
            "periods": {kind: list(values) for kind, values in self.periods.items()},
            "one": features_to_state(self.one), "five": features_to_state(self.five),
            "pending": list(self.pending), "trend": self.trend, "previous": self.previous, "regime": self.regime,
            "last_bucket_ms": self.last_bucket_ms, "last_5m_ms": self.last_5m_ms, "last_5m_seen": self._last_5m_seen,
        }

    @classmethod
    def from_state(cls, state):
        stream = cls({kind: tuple(values) for kind, values in state["periods"].items()})
        stream.one, stream.five = features_from_state(state["one"]), features_from_state(state["five"])
        stream.pending = deque(state["pending"])
        stream.trend, stream.previous, stream.regime = state["trend"], state["previous"], state["regime"]
        stream.last_bucket_ms, stream.last_5m_ms = state["last_bucket_ms"], state["last_5m_ms"]
        stream._last_5m_seen = state["last_5m_seen"]
        return stream


# ---- Book ------------------------------------------------------------------------------------------------------------

def _live_decisions(book):
    """Decisiones que aún pueden cambiar: las que esperan su horizonte y la de la posición abierta, sin duplicar."""
    live = list(book._open_decisions)
    if book.position is not None and not any(book.position["decision"] is d for d in live):
        live.append(book.position["decision"])
    return live


def book_to_state(book):
    """Estado vivo de un ``Book`` (no la salida: trades, fills, skipped, decisiones ya cerradas)."""
    live = _live_decisions(book)
    position = None
    if book.position is not None:
        position = {}
        for key, value in book.position.items():
            if key == "decision":
                position[key] = next(i for i, d in enumerate(live) if d is value)
            elif key in _POSITION_DECIMALS:
                position[key] = str(value)
            else:
                position[key] = value
        position["_decimals"] = [k for k in _POSITION_DECIMALS if k in book.position]
    return {
        "bucket": book.bucket, "stale_cycles": book.stale_cycles,
        "decisions": live, "open_decisions": [i for i, d in enumerate(live) if any(d is o for o in book._open_decisions)],
        "position": position,
    }


def book_apply_state(book, state):
    """Carga ``state`` en un ``Book`` recién construido (mismas referencias entre decisión abierta y posición)."""
    book.bucket, book.stale_cycles = state["bucket"], state["stale_cycles"]
    live = [dict(d) for d in state["decisions"]]
    book.decisions = list(live)
    book._open_decisions = [live[i] for i in state["open_decisions"]]
    saved = state["position"]
    if saved is None:
        book.position = None
        return
    position = {}
    for key, value in saved.items():
        if key == "_decimals":
            continue
        if key == "decision":
            position[key] = live[value]
        elif key in saved["_decimals"]:
            position[key] = D(value)
        else:
            position[key] = value
    book.position = position


def _funding_to_state(periods):
    return [[a, b, str(r)] for a, b, r in periods]


def _funding_merge(persisted, provided):
    """Periodos guardados + nuevos. Un periodo ya guardado manda: nunca se reescribe lo que ya se usó."""
    merged = {(int(a), int(b)): D(str(r)) for a, b, r in provided}
    merged.update({(int(a), int(b)): D(str(r)) for a, b, r in persisted})
    return sorted((a, b, r) for (a, b), r in merged.items())


class SeriesRunner:
    """Una serie (estrategia, producto, spec). ``step`` consume velas nuevas y devuelve lo que se cerró."""

    def __init__(self, spec, *, product_id, tick_size="1", start_ms, warm_start_ms=None, notional_usd="100",
                 stop_policy="level"):
        if "fundpct" in json.dumps(spec):
            raise ValueError("fundpct (percentil de funding a 30 d) está descartada: el forward incremental no la admite")
        self.spec, self.spec_hash = spec, spec_hash(spec)
        self.product_id, self.tick_size, self.notional_usd, self.stop_policy = product_id, tick_size, notional_usd, stop_policy
        self.start_ms = start_ms
        self.warm_start_ms = start_ms if warm_start_ms is None else warm_start_ms
        periods = merge_periods(DEFAULT_PERIODS, declared_indicators(spec))
        self.stream = FrameStream(periods)
        self.book = Book(spec, product_id=product_id, tick_size=tick_size, notional_usd=notional_usd, stop_policy=stop_policy)
        self.funding = []   # [(start_ms, end_ms, Decimal)] que pueden afectar a la posición abierta
        self.fills_total = 0

    @property
    def cursor(self):
        return self.stream.last_bucket_ms

    def step(self, candles_1m, candles_5m=(), funding_periods=()):
        """Procesa velas posteriores al cursor. Devuelve ``{"trades", "decisions", "skipped", "blocked"}`` nuevos.

        ``decisions`` son las ya finalizadas (juzgadas y, si abrieron posición, con la posición cerrada); las vivas
        quedan en el estado. Las velas que no son posteriores al cursor se ignoran.
        """
        self.funding = _funding_merge(self.funding, funding_periods)
        self.book.funding = list(self.funding)
        for frame in self.stream.feed(candles_1m, candles_5m):
            if frame[0] < self.start_ms:
                continue          # calentamiento: alimenta indicadores, nunca abre posiciones (como ``replay``)
            self.book.on_frame(*frame)
        return self._drain()

    def _drain(self):
        book = self.book
        live = _live_decisions(book)
        done = [d for d in book.decisions if not any(d is x for x in live)]
        out = {"trades": book.trades, "decisions": done, "skipped": book.skipped, "blocked": book.blocked,
               "fills": book.fills}
        book.trades, book.fills, book.skipped, book.blocked = [], [], [], []
        book.decisions = [d for d in book.decisions if any(d is x for x in live)]
        return out

    def open_view(self, mark_price=None):
        return self.book.open_position(mark_price)

    # -- estado
    def _prune_funding(self):
        position = self.book.position
        floor = self.book._entry_start_ms(position) if position is not None else (self.cursor or 0)
        return [p for p in self.funding if p[1] > floor]

    def to_state(self):
        self.funding = self._prune_funding()
        return {
            "state_version": STATE_VERSION,
            "meta": {"spec": self.spec, "spec_hash": self.spec_hash, "product_id": self.product_id,
                     "tick_size": self.tick_size, "notional_usd": self.notional_usd, "stop_policy": self.stop_policy,
                     "start_ms": self.start_ms, "warm_start_ms": self.warm_start_ms},
            "stream": self.stream.to_state(), "book": book_to_state(self.book), "funding": _funding_to_state(self.funding),
        }

    @classmethod
    def from_state(cls, state):
        if state.get("state_version") != STATE_VERSION:
            raise CheckpointError("state_version_mismatch", "estado versión {!r}".format(state.get("state_version")))
        meta = state["meta"]
        runner = cls(meta["spec"], product_id=meta["product_id"], tick_size=meta["tick_size"], start_ms=meta["start_ms"],
                     warm_start_ms=meta["warm_start_ms"], notional_usd=meta["notional_usd"], stop_policy=meta["stop_policy"])
        if runner.spec_hash != meta["spec_hash"]:
            raise CheckpointError("spec_hash_mismatch", "el spec guardado no coincide con su hash")
        runner.stream = FrameStream.from_state(state["stream"])
        book_apply_state(runner.book, state["book"])
        runner.funding = _funding_merge(((a, b, r) for a, b, r in state["funding"]), ())
        return runner


# ---- checkpoints -----------------------------------------------------------------------------------------------------

def ensure_schema(db):
    db.executescript(FORWARD_SCHEMA + CHECKPOINT_SCHEMA)


def row_hash(row):
    """Hash de una fila de checkpoint completa (incluida su ``prev_sha256``): el siguiente la enlaza."""
    return sha256_json([row[c] for c in _CHECKPOINT_COLUMNS])


def _rows(db, key):
    cursor = db.execute("SELECT {} FROM forward_checkpoint WHERE strategy_id=? AND product_id=? AND spec_hash=? "
                        "ORDER BY seq".format(", ".join(_CHECKPOINT_COLUMNS)), key)
    return [dict(zip(_CHECKPOINT_COLUMNS, r)) for r in cursor.fetchall()]


def verify_chain(db, key):
    """Devuelve el número de checkpoints; levanta ``CheckpointError`` si la cadena, los saltos de ``seq`` o un blob no cuadran."""
    rows = _rows(db, key)
    previous = GENESIS
    for expected, row in enumerate(rows):
        if row["seq"] != expected:
            raise CheckpointError("chain_gap", "falta el checkpoint {}".format(expected))
        if row["prev_sha256"] != previous:
            raise CheckpointError("chain_broken", "seq {}: prev_sha256 no coincide".format(row["seq"]))
        previous = row_hash(row)
    return len(rows)


def _state_blob(db, digest):
    found = db.execute("SELECT json FROM forward_checkpoint_blob WHERE state_sha256=?", (digest,)).fetchone()
    if found is None:
        raise CheckpointError("blob_missing", "no está el estado {}".format(digest[:12]))
    if hashlib.sha256(found[0].encode("utf-8")).hexdigest() != digest:
        raise CheckpointError("blob_corrupt", "el estado {} no coincide con su hash".format(digest[:12]))
    return found[0]


def _last_seq(db, key):
    found = db.execute("SELECT MAX(seq) FROM forward_checkpoint WHERE strategy_id=? AND product_id=? AND spec_hash=?",
                       key).fetchone()[0]
    return -1 if found is None else found


def _write_checkpoint(db, runner, key, seq, origin, now_ms, fault):
    blob = canonical_json(runner.to_state())
    digest = hashlib.sha256(blob.encode("utf-8")).hexdigest()
    last = db.execute("SELECT {} FROM forward_checkpoint WHERE strategy_id=? AND product_id=? AND spec_hash=? "
                      "ORDER BY seq DESC LIMIT 1".format(", ".join(_CHECKPOINT_COLUMNS)), key).fetchone()
    previous = row_hash(dict(zip(_CHECKPOINT_COLUMNS, last))) if last else GENESIS
    row = {
        "strategy_id": key[0], "product_id": key[1], "spec_hash": key[2], "seq": seq,
        "last_bucket_ms": runner.stream.last_bucket_ms, "last_5m_ms": runner.stream.last_5m_ms,
        "policy": canonical_json({"block_stale_entries": False}), "era": ERA_NOW, "catalog_version": catalog_version(),
        "state_version": STATE_VERSION, "origin": origin, "state_sha256": digest, "prev_sha256": previous,
        "created_ms": now_ms,
    }
    db.execute("INSERT OR IGNORE INTO forward_checkpoint_blob VALUES(?,?)", (digest, blob))
    if fault:
        fault("after_blob")
    db.execute("INSERT INTO forward_checkpoint VALUES({})".format(",".join("?" * len(_CHECKPOINT_COLUMNS))),
               [row[c] for c in _CHECKPOINT_COLUMNS])


def start_series(db, runner, *, now_ms=None, origin="start"):
    """Checkpoint 0 de una serie nueva (spec canónico, ``warm_start_ms`` y ``start_ms`` van dentro del estado)."""
    ensure_schema(db)
    key = (runner.spec["id"], runner.product_id, runner.spec_hash)
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    db.execute("BEGIN IMMEDIATE")
    try:
        if _last_seq(db, key) >= 0:
            raise ConcurrentCycle("la serie {} ya tiene checkpoints".format(key[:2]))
        _write_checkpoint(db, runner, key, 0, origin, now_ms, None)
        db.commit()
    except BaseException:
        db.rollback()
        raise
    return key


def commit_cycle(db, runner, new_trades, *, seq_read, now_ms=None, origin="start", fault=None):
    """Un ciclo de una serie en UNA transacción: trades nuevos + era + estado + checkpoint ``seq_read + 1``.

    ``seq_read`` es el ``seq`` del último checkpoint leído al reanudar: si otro proceso añadió uno, se levanta
    ``ConcurrentCycle`` y no se escribe nada. ``fault(stage)`` permite inyectar una caída en el test.
    Devuelve ``{"seq", "inserted"}``.
    """
    key = (runner.spec["id"], runner.product_id, runner.spec_hash)
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    db.execute("BEGIN IMMEDIATE")
    try:
        if _last_seq(db, key) != seq_read:
            raise ConcurrentCycle("el checkpoint {} dejó de ser el último".format(seq_read))
        inserted = 0
        for trade in new_trades:
            found = db.execute("INSERT OR IGNORE INTO forward_trade VALUES(?,?,?,?,?)", (
                key[0], key[1], trade["entry_bucket_ms"], key[2], json.dumps(trade)))
            inserted += found.rowcount
            if found.rowcount:
                db.execute("INSERT OR IGNORE INTO forward_era VALUES(?,?,?,?,?,?)",
                           (key[0], key[1], trade["entry_bucket_ms"], key[2], ERA_NOW, now_ms))
        if fault:
            fault("after_trades")
        _write_checkpoint(db, runner, key, seq_read + 1, origin, now_ms, fault)
        if fault:
            fault("before_commit")
        db.commit()
    except BaseException:
        db.rollback()
        raise
    return {"seq": seq_read + 1, "inserted": inserted}


def load_series(db, key, *, spec=None):
    """Reanuda una serie: verifica la cadena y el blob del último checkpoint. Devuelve ``(runner, seq)``.

    Cualquier incoherencia levanta ``CheckpointError`` con código estable: la serie se detiene.
    """
    if not _rows(db, key):
        raise CheckpointError("no_checkpoint", "la serie no tiene checkpoints")
    verify_chain(db, key)
    last = _rows(db, key)[-1]
    if last["catalog_version"] != catalog_version():
        raise CheckpointError("catalog_changed", "las definiciones de indicadores cambiaron desde el checkpoint")
    if last["state_version"] != STATE_VERSION:
        raise CheckpointError("state_version_mismatch", "versión de estado {}".format(last["state_version"]))
    runner = SeriesRunner.from_state(json.loads(_state_blob(db, last["state_sha256"])))
    if runner.spec_hash != key[2] or (spec is not None and spec_hash(spec) != key[2]):
        raise CheckpointError("spec_hash_mismatch", "el spec no corresponde a la serie")
    if runner.stream.last_bucket_ms != last["last_bucket_ms"] or runner.stream.last_5m_ms != last["last_5m_ms"]:
        raise CheckpointError("cursor_mismatch", "el cursor del estado no coincide con el del checkpoint")
    return runner, last["seq"]
