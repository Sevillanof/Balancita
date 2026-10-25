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
from . import futures_forward
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
STATE_VERSION = 2
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
CREATE TRIGGER IF NOT EXISTS forward_checkpoint_blob_no_delete BEFORE DELETE ON forward_checkpoint_blob
  BEGIN SELECT RAISE(ABORT, 'forward checkpoint blobs are immutable'); END;
CREATE TABLE IF NOT EXISTS forward_checkpoint_head(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, spec_hash TEXT NOT NULL, seq INTEGER NOT NULL,
  row_sha256 TEXT NOT NULL, logged_ms INTEGER NOT NULL,
  PRIMARY KEY(strategy_id, product_id, spec_hash, seq)) STRICT;
CREATE TRIGGER IF NOT EXISTS forward_checkpoint_head_no_update BEFORE UPDATE ON forward_checkpoint_head
  BEGIN SELECT RAISE(ABORT, 'forward checkpoint heads are append-only'); END;
CREATE TRIGGER IF NOT EXISTS forward_checkpoint_head_no_delete BEFORE DELETE ON forward_checkpoint_head
  BEGIN SELECT RAISE(ABORT, 'forward checkpoint heads are append-only'); END;
CREATE TABLE IF NOT EXISTS forward_anomaly(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, spec_hash TEXT NOT NULL, kind TEXT NOT NULL,
  bucket_ms INTEGER NOT NULL, hash TEXT NOT NULL, seen_ms INTEGER NOT NULL, detail TEXT NOT NULL,
  PRIMARY KEY(strategy_id, product_id, spec_hash, kind, bucket_ms, hash)) STRICT;
CREATE TRIGGER IF NOT EXISTS forward_anomaly_no_update BEFORE UPDATE ON forward_anomaly
  BEGIN SELECT RAISE(ABORT, 'forward anomalies are append-only'); END;
CREATE TRIGGER IF NOT EXISTS forward_anomaly_no_delete BEFORE DELETE ON forward_anomaly
  BEGIN SELECT RAISE(ABORT, 'forward anomalies are append-only'); END;
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
    if "valuearea" in features.periods:
        # Su perfil de volumen no se guarda: una estrategia de area de valor no entra al forward hasta que se guarde.
        raise NotImplementedError("el estado de valuearea no se serializa: no se puede reanudar en el forward")
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

# Cuánto se espera una vela que no llega antes de declarar el hueco y cruzarlo (provisional: se ajustará con el retraso
# máximo medido de llegada de velas en el Mac; decisión del dueño 2026-10-18).
GAP_GRACE_MS = 15 * 60_000


class FrameStream:
    """``futures_simulator.frames`` por trozos, con la misma semántica que el replay completo.

    El replay completo ve todas las velas desde el principio. Para que un trozo con velas que llegan tarde o desordenadas
    dé lo mismo, el cursor 1m solo avanza por la frontera contigua: no pasa una 1m ausente ni una 1m cuya 5m (la última
    que cierra a su cierre) no ha llegado, hasta que pasa ``GAP_GRACE_MS`` desde el cierre de la vela esperada; entonces
    se declara el hueco (``holes``, solo informe aquí) y se cruza igual que el replay. Una vela que llega cuando ya no es
    posterior al cursor se ignora (no cambia el estado; su anomalía se registrará en el PR de anomalías).
    """

    def __init__(self, periods=None):
        merged = merge_periods(DEFAULT_PERIODS if periods is None else periods, REGIME_PERIODS)
        self.periods = merged
        self.one, self.five = IncrementalFeatures(merged, series="1m"), IncrementalFeatures(merged, series="5m")
        self.waiting_ones = {}           # 1m recibidas aún no procesadas (bucket -> vela)
        self.pending = {}                # 5m recibidas aún no consumidas (bucket -> vela)
        self.trend = self.previous = None
        self.regime = "unknown"
        self.first_one_ms = None         # primera 1m procesada: desde su ventana de 5m se exige la 5m
        self.last_bucket_ms = None       # última 1m procesada
        self.last_5m_ms = None           # última 5m procesada
        self.declared_5m_ms = None       # última 5m ausente ya declarada
        self.holes = []                  # huecos declarados desde el último ``drain_holes``
        self.ignored = 0

    def drain_holes(self):
        holes, self.holes = self.holes, []
        return holes

    def feed(self, candles_1m, candles_5m=(), *, now_ms):
        for candle in candles_5m:
            bucket = candle["bucket_start"]
            if (self.last_5m_ms is not None and bucket <= self.last_5m_ms) or bucket in self.pending:
                self.ignored += 1
                continue
            self.pending[bucket] = candle
        for candle in candles_1m:
            bucket = candle["bucket_start"]
            if (self.last_bucket_ms is not None and bucket <= self.last_bucket_ms) or bucket in self.waiting_ones:
                self.ignored += 1
                continue
            self.waiting_ones[bucket] = candle
        while self.waiting_ones:
            bucket = min(self.waiting_ones)
            if self.last_bucket_ms is not None and bucket != self.last_bucket_ms + ONE_MINUTE_MS:
                expected = self.last_bucket_ms + ONE_MINUTE_MS
                if now_ms < expected + ONE_MINUTE_MS + GAP_GRACE_MS:
                    break                # la 1m esperada puede llegar todavía
                self.holes.append({"kind": "1m", "first_ms": expected, "last_ms": bucket - ONE_MINUTE_MS,
                                   "declared_ms": now_ms})
            close_at = bucket + ONE_MINUTE_MS
            first = bucket if self.first_one_ms is None else self.first_one_ms
            required = close_at // FIVE_MINUTES_MS * FIVE_MINUTES_MS - FIVE_MINUTES_MS
            present = required in self.pending or (self.last_5m_ms is not None and required <= self.last_5m_ms)
            if required >= first // FIVE_MINUTES_MS * FIVE_MINUTES_MS and not present:
                if now_ms < required + FIVE_MINUTES_MS + GAP_GRACE_MS:
                    break                # la 5m que esta 1m necesita puede llegar todavía
                if self.declared_5m_ms != required:
                    self.declared_5m_ms = required
                    self.holes.append({"kind": "5m", "first_ms": required, "last_ms": required, "declared_ms": now_ms})
            candle = self.waiting_ones.pop(bucket)
            self.first_one_ms = first
            current = self.one.update(candle)
            while self.pending and min(self.pending) + FIVE_MINUTES_MS <= close_at:
                waiting = self.pending.pop(min(self.pending))
                self.trend = self.five.update(waiting)
                self.last_5m_ms = waiting["bucket_start"]
            if self.trend is not None:
                self.regime = update_regime(self.regime, self.trend.get("ema9"), self.trend.get("ema21"),
                                            self.trend.get("atr14"))
            frame = (bucket, current, self.previous, self.trend, self.regime)
            self.previous = current
            self.last_bucket_ms = bucket
            yield frame

    def to_state(self):
        return {
            "periods": {kind: list(values) for kind, values in self.periods.items()},
            "one": features_to_state(self.one), "five": features_to_state(self.five),
            "waiting_ones": [self.waiting_ones[b] for b in sorted(self.waiting_ones)],
            "pending": [self.pending[b] for b in sorted(self.pending)],
            "trend": self.trend, "previous": self.previous, "regime": self.regime,
            "first_one_ms": self.first_one_ms, "last_bucket_ms": self.last_bucket_ms, "last_5m_ms": self.last_5m_ms,
            "declared_5m_ms": self.declared_5m_ms,
        }

    @classmethod
    def from_state(cls, state):
        stream = cls({kind: tuple(values) for kind, values in state["periods"].items()})
        stream.one, stream.five = features_from_state(state["one"]), features_from_state(state["five"])
        stream.waiting_ones = {c["bucket_start"]: c for c in state["waiting_ones"]}
        stream.pending = {c["bucket_start"]: c for c in state["pending"]}
        stream.trend, stream.previous, stream.regime = state["trend"], state["previous"], state["regime"]
        stream.first_one_ms, stream.last_bucket_ms = state["first_one_ms"], state["last_bucket_ms"]
        stream.last_5m_ms, stream.declared_5m_ms = state["last_5m_ms"], state["declared_5m_ms"]
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
    return [[a, b, str(r), int(final)] for a, b, r, final in periods]


def _funding_merge(persisted, provided):
    """Periodos guardados ``(inicio, fin, tasa, final)`` + nuevos ``(inicio, fin, tasa)``.

    Un periodo guardado como ``final`` (ya había cerrado cuando se guardó) manda: nunca se reescribe lo que ya se usó, como
    el cargador de funding (primera tasa vista tras el cierre). Uno guardado como provisional (aún abierto al guardarlo) cede
    ante el valor nuevo: la tasa de una hora abierta no es la que cuenta.
    """
    merged = {(int(a), int(b)): (D(str(r)), False) for a, b, r in provided}
    for a, b, r, final in persisted:
        key = (int(a), int(b))
        if final or key not in merged:
            merged[key] = (D(str(r)), bool(final))
    return sorted((a, b, r, final) for (a, b), (r, final) in merged.items())


def require_supported_policy():
    """La puerta de entradas obsoletas (``BLOCK_STALE_ENTRIES``) necesita la frescura de cada vela y aún no está en el
    estado incremental (PR de cursor/anomalías): si estuviera activa, el resultado divergiría del replay en silencio."""
    if futures_forward.BLOCK_STALE_ENTRIES:
        raise CheckpointError("unsupported_policy", "BLOCK_STALE_ENTRIES activa: el forward incremental no la soporta aún")


class SeriesRunner:
    """Una serie (estrategia, producto, spec). ``step`` consume velas nuevas y devuelve lo que se cerró."""

    def __init__(self, spec, *, product_id, tick_size="1", start_ms, warm_start_ms=None, notional_usd="100",
                 stop_policy="level"):
        require_supported_policy()
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

    def step(self, candles_1m, candles_5m=(), funding_periods=(), *, now_ms):
        """Procesa velas por la frontera contigua. Devuelve ``{"trades", "decisions", "skipped", "blocked", "fills", "holes"}``.

        ``now_ms`` es el reloj del llamador (la hora real del ciclo): decide cuándo una vela ausente pasa a hueco
        declarado (``GAP_GRACE_MS``). Obligatorio: sin reloj no se puede decidir si esperar.

        ``decisions`` son las ya finalizadas (juzgadas y, si abrieron posición, con la posición cerrada); las vivas
        quedan en el estado. Las velas que no son posteriores al cursor se ignoran.
        """
        self.funding = _funding_merge(self.funding, funding_periods)
        self.book.funding = [(a, b, r) for a, b, r, _ in self.funding]
        for frame in self.stream.feed(candles_1m, candles_5m, now_ms=now_ms):
            if frame[0] < self.start_ms:
                continue          # calentamiento: alimenta indicadores, nunca abre posiciones (como ``replay``)
            self.book.on_frame(*frame)
        if self.cursor is not None:   # lo que ya cerró al llegar al cursor deja de ser provisional
            edge = self.cursor + ONE_MINUTE_MS
            self.funding = [(a, b, r, final or b <= edge) for a, b, r, final in self.funding]
        out = self._drain()
        out["holes"] = self.stream.drain_holes()
        return out

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
        runner.funding = _funding_merge(((a, b, r, final) for a, b, r, final in state["funding"]), ())
        runner.book.funding = [(a, b, r) for a, b, r, _ in runner.funding]
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
    # Registro de cabezas: cada checkpoint deja también su hash en otra tabla solo-añadir. Si se recorta la cola de la
    # cadena (o se reescribe una fila) la cabeza registrada lo delata. LIMITACIÓN: sin un ancla externa (p. ej. la cabeza
    # publicada fuera de este fichero) quien reescriba a la vez la cadena y el registro no es detectable.
    heads = dict(db.execute("SELECT seq, row_sha256 FROM forward_checkpoint_head WHERE strategy_id=? AND product_id=? "
                            "AND spec_hash=?", key))
    for row in rows:
        if heads.get(row["seq"]) is None:
            raise CheckpointError("head_missing", "seq {}: sin cabeza registrada".format(row["seq"]))
        if heads[row["seq"]] != row_hash(row):
            raise CheckpointError("head_mismatch", "seq {}: la fila no es la que se registró".format(row["seq"]))
    if heads and max(heads) >= len(rows):
        raise CheckpointError("chain_truncated", "la cabeza registrada llega al seq {} y la cadena a {}".format(max(heads), len(rows) - 1))
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
        "policy": canonical_json({"block_stale_entries": bool(futures_forward.BLOCK_STALE_ENTRIES)}), "era": ERA_NOW, "catalog_version": catalog_version(),
        "state_version": STATE_VERSION, "origin": origin, "state_sha256": digest, "prev_sha256": previous,
        "created_ms": now_ms,
    }
    db.execute("INSERT OR IGNORE INTO forward_checkpoint_blob VALUES(?,?)", (digest, blob))
    if fault:
        fault("after_blob")
    db.execute("INSERT INTO forward_checkpoint VALUES({})".format(",".join("?" * len(_CHECKPOINT_COLUMNS))),
               [row[c] for c in _CHECKPOINT_COLUMNS])
    db.execute("INSERT INTO forward_checkpoint_head VALUES(?,?,?,?,?,?)", (*key, seq, row_hash(row), now_ms))


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


def _anomaly(db, key, kind, bucket_ms, detail, now_ms):
    text = canonical_json(detail)
    db.execute("INSERT OR IGNORE INTO forward_anomaly VALUES(?,?,?,?,?,?,?,?)",
               (*key, kind, bucket_ms, hashlib.sha256(text.encode("utf-8")).hexdigest(), now_ms, text))


def commit_cycle(db, runner, result, *, seq_read, now_ms=None, origin="start", fault=None):
    """Un ciclo de una serie en UNA transacción: trades nuevos + era + huecos/anomalías + estado + checkpoint ``seq_read + 1``.

    ``result`` es lo que devolvió ``runner.step`` (o la lista de trades). Un trade cuya clave ya existe con el MISMO
    contenido es idempotente (reintento tras una caída); con contenido distinto no se sobrescribe ni se calla: queda una
    fila ``forward_anomaly`` ``trade_conflict`` con el hash de ambos.

    ``seq_read`` es el ``seq`` del último checkpoint leído al reanudar: si otro proceso añadió uno, se levanta
    ``ConcurrentCycle`` y no se escribe nada. ``fault(stage)`` permite inyectar una caída en el test.
    Devuelve ``{"seq", "inserted"}``.
    """
    require_supported_policy()
    new_trades, holes = (result, []) if isinstance(result, list) else (result["trades"], result.get("holes", []))
    key = (runner.spec["id"], runner.product_id, runner.spec_hash)
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    db.execute("BEGIN IMMEDIATE")
    try:
        if _last_seq(db, key) != seq_read:
            raise ConcurrentCycle("el checkpoint {} dejó de ser el último".format(seq_read))
        inserted = 0
        for trade in new_trades:
            payload = json.dumps(trade)
            found = db.execute("INSERT OR IGNORE INTO forward_trade VALUES(?,?,?,?,?)", (
                key[0], key[1], trade["entry_bucket_ms"], key[2], payload))
            inserted += found.rowcount
            if found.rowcount:
                db.execute("INSERT OR IGNORE INTO forward_era VALUES(?,?,?,?,?,?)",
                           (key[0], key[1], trade["entry_bucket_ms"], key[2], ERA_NOW, now_ms))
                continue
            (stored,) = db.execute("SELECT payload FROM forward_trade WHERE strategy_id=? AND product_id=? AND "
                                   "entry_bucket_ms=? AND spec_hash=?", (key[0], key[1], trade["entry_bucket_ms"], key[2])).fetchone()
            if stored != payload:
                _anomaly(db, key, "trade_conflict", trade["entry_bucket_ms"],
                         {"stored_sha256": hashlib.sha256(stored.encode("utf-8")).hexdigest(),
                          "new_sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest()}, now_ms)
        for hole in holes:
            _anomaly(db, key, "hole_" + hole["kind"], hole["first_ms"], hole, now_ms)
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
