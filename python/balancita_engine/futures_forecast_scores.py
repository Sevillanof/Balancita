"""Forecast scorer E: how did each strategy's prediction fare against what happened.

Reads the verdicts DB (C) and the official 1m candles of the market DB, both
read-only over persistent connections, and is the single writer of its own
append-only scores DB. Deterministic and replayable: a live incremental run
and a full replay over the same inputs produce identical score rows.

Conventions
-----------
* Entry: a LONG/SHORT proposal (and, separately, the ``selected`` decision) is
  scored as if entered at the CLOSE of the decision 1m bucket, with no spread
  or latency; those frictions are covered by the cost below.
* Exit horizons: the close of the official candle whose bucket starts
  ``horizon`` after the decision bucket (entry time + horizon).
* Costs: round-trip taker 2 x 5 bp plus the 0.02% slippage proxy used by
  ``_risk_plan`` (``Decimal("0.0002")``) = 12 bp, subtracted from the gross
  signed return to get the net one.
* Barrier race: from the minute after entry, up to 24 h, the first 1m candle
  whose high/low touches ``proposed_target`` or ``proposed_stop`` decides. A
  candle touching both counts as the stop (``ambiguous = 1``). ``hit_after_ms``
  is the end of the hit candle relative to entry (k minutes -> k * 60000).
  A missing level records ``no_levels``.
* Excursions: max favorable / adverse move over the first 30 candles after
  entry from their high/low, in bp, floored at 0.
* Each score component is written as soon as the official candles it needs
  exist (and never uses candles beyond its horizon), so shorter horizons are
  scored before the 24 h ones. ``backfill`` marks verdicts whose
  ``knowledge_lag_ms`` exceeds D's 15 s freshness threshold.
"""

import json
import sqlite3
import time
from decimal import ROUND_HALF_EVEN, Decimal

from .canonical import canonical_hash, normalize_decimal
from .futures_verdicts import (
    ONE_MINUTE_MS,
    VERDICT_SCHEMA_VERSION,
    _file_identity,
    _OfficialCandles,
)

SCORE_CONFIG = {
    "version": "futures-forecast-scores-config.v1",
    "verdict_schema": VERDICT_SCHEMA_VERSION,
    "entry_price": "decision_bucket_close",
    "horizons_min": [15, 60, 240, 1440],
    "barrier_horizon_min": 1440,
    "excursion_window_min": 30,
    "taker_rate": "0.0005",
    "slippage_rate": "0.0002",
    "max_verdict_lag_ms": 15_000,
    "same_candle_barrier": "stop_first",
}

SOURCE_PROPOSAL = "proposal"
SOURCE_SELECTED = "selected"
VERDICT_BATCH = 500
BP_QUANTUM = Decimal("0.0001")
TEN_THOUSAND = Decimal(10_000)
CACHE_PRUNE_AT = 20_000
TABLES = (
    "paper_futures_forecast_meta",
    "paper_futures_forecast_verdicts",
    "paper_futures_forecasts",
    "paper_futures_forecast_returns",
    "paper_futures_forecast_barriers",
    "paper_futures_forecast_excursions",
)


def round_trip_cost_bp(config):
    return (2 * Decimal(config["taker_rate"]) + Decimal(config["slippage_rate"])) * TEN_THOUSAND


def _bp(value):
    return normalize_decimal(str(value.quantize(BP_QUANTUM, rounding=ROUND_HALF_EVEN)))


def _decimal(value):
    if value is None:
        return None
    try:
        number = Decimal(str(value))
    except ArithmeticError:
        return None
    return number if number.is_finite() else None


# --------------------------------------------------------------------------- store


class ScoreStore:
    """Single writer of the scores DB; every table is append-only."""

    def __init__(self, path, config):
        self.config = dict(config)
        self.config_hash = canonical_hash(self.config)
        self.db = sqlite3.connect(path)
        script = """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS paper_futures_forecast_meta(
              key TEXT PRIMARY KEY, value TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS paper_futures_forecast_verdicts(
              bucket_start INTEGER PRIMARY KEY, verdict_hash TEXT NOT NULL,
              forecasts INTEGER NOT NULL, written_at INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS paper_futures_forecasts(
              bucket_start INTEGER NOT NULL, source TEXT NOT NULL, strategy_id TEXT NOT NULL,
              side TEXT NOT NULL, regime TEXT NOT NULL, utc_hour INTEGER NOT NULL,
              knowledge_lag_ms INTEGER, backfill INTEGER NOT NULL, entry_price TEXT NOT NULL,
              proposed_stop TEXT, proposed_target TEXT, signal_key TEXT,
              verdict_hash TEXT NOT NULL, written_at INTEGER NOT NULL,
              PRIMARY KEY(bucket_start, source, strategy_id)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS paper_futures_forecast_returns(
              bucket_start INTEGER NOT NULL, source TEXT NOT NULL, strategy_id TEXT NOT NULL,
              horizon_min INTEGER NOT NULL, gross_bp TEXT NOT NULL, net_bp TEXT NOT NULL,
              exit_bucket_start INTEGER NOT NULL, written_at INTEGER NOT NULL,
              PRIMARY KEY(bucket_start, source, strategy_id, horizon_min)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS paper_futures_forecast_barriers(
              bucket_start INTEGER NOT NULL, source TEXT NOT NULL, strategy_id TEXT NOT NULL,
              outcome TEXT NOT NULL, ambiguous INTEGER NOT NULL, hit_after_ms INTEGER,
              written_at INTEGER NOT NULL,
              PRIMARY KEY(bucket_start, source, strategy_id)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS paper_futures_forecast_excursions(
              bucket_start INTEGER NOT NULL, source TEXT NOT NULL, strategy_id TEXT NOT NULL,
              window_min INTEGER NOT NULL, mfe_bp TEXT NOT NULL, mae_bp TEXT NOT NULL,
              written_at INTEGER NOT NULL,
              PRIMARY KEY(bucket_start, source, strategy_id)
            ) STRICT;
            """
        for table in TABLES:
            script += (
                "CREATE TRIGGER IF NOT EXISTS {t}_no_update BEFORE UPDATE ON {t} "
                "BEGIN SELECT RAISE(ABORT, 'forecast scores are immutable'); END;\n"
                "CREATE TRIGGER IF NOT EXISTS {t}_no_delete BEFORE DELETE ON {t} "
                "BEGIN SELECT RAISE(ABORT, 'forecast scores are immutable'); END;\n"
            ).format(t=table)
        self.db.executescript(script)
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO paper_futures_forecast_meta VALUES('config_json', ?)",
                (json.dumps(self.config, sort_keys=True),),
            )
            self.db.execute(
                "INSERT OR IGNORE INTO paper_futures_forecast_meta VALUES('config_hash', ?)",
                (self.config_hash,),
            )
        stored = self.db.execute(
            "SELECT value FROM paper_futures_forecast_meta WHERE key='config_hash'"
        ).fetchone()[0]
        if stored != self.config_hash:
            self.db.close()
            raise ValueError("forecast scores DB was written with a different config; use a new DB")
        self.horizons = [int(h) for h in self.config["horizons_min"]]
        self.barrier_min = int(self.config["barrier_horizon_min"])
        self.excursion_min = int(self.config["excursion_window_min"])
        self.cost_bp = round_trip_cost_bp(self.config)

    def last_verdict_bucket(self):
        row = self.db.execute("SELECT MAX(bucket_start) FROM paper_futures_forecast_verdicts").fetchone()
        return -1 if row[0] is None else row[0]

    def open_forecasts(self):
        """Forecasts that still lack a score component, in bucket order.

        Run once per start: afterwards the service tracks them in memory.
        """
        floor = self.db.execute(
            """
            SELECT MIN(f.bucket_start) FROM paper_futures_forecasts f WHERE
              (SELECT COUNT(*) FROM paper_futures_forecast_returns r WHERE r.bucket_start=f.bucket_start
                 AND r.source=f.source AND r.strategy_id=f.strategy_id) < ?
              OR NOT EXISTS (SELECT 1 FROM paper_futures_forecast_barriers b WHERE b.bucket_start=f.bucket_start
                 AND b.source=f.source AND b.strategy_id=f.strategy_id)
              OR NOT EXISTS (SELECT 1 FROM paper_futures_forecast_excursions e WHERE e.bucket_start=f.bucket_start
                 AND e.source=f.source AND e.strategy_id=f.strategy_id)
            """,
            (len(self.horizons),),
        ).fetchone()[0]
        if floor is None:
            return {}
        done_returns, done_barrier, done_excursion = {}, set(), set()
        for bucket, source, strategy, horizon in self.db.execute(
            "SELECT bucket_start, source, strategy_id, horizon_min FROM paper_futures_forecast_returns "
            "WHERE bucket_start>=?", (floor,)
        ):
            done_returns.setdefault((bucket, source, strategy), set()).add(horizon)
        for bucket, source, strategy in self.db.execute(
            "SELECT bucket_start, source, strategy_id FROM paper_futures_forecast_barriers WHERE bucket_start>=?",
            (floor,),
        ):
            done_barrier.add((bucket, source, strategy))
        for bucket, source, strategy in self.db.execute(
            "SELECT bucket_start, source, strategy_id FROM paper_futures_forecast_excursions WHERE bucket_start>=?",
            (floor,),
        ):
            done_excursion.add((bucket, source, strategy))
        open_forecasts = {}
        for bucket, source, strategy, side, entry, stop, target in self.db.execute(
            "SELECT bucket_start, source, strategy_id, side, entry_price, proposed_stop, proposed_target "
            "FROM paper_futures_forecasts WHERE bucket_start>=? ORDER BY bucket_start, source, strategy_id",
            (floor,),
        ):
            key = (bucket, source, strategy)
            forecast = _OpenForecast(key, side, Decimal(entry), _decimal(stop), _decimal(target))
            forecast.returns_done = done_returns.get(key, set())
            forecast.barrier_done = key in done_barrier
            forecast.excursion_done = key in done_excursion
            if not forecast.complete(len(self.horizons)):
                open_forecasts[key] = forecast
        return open_forecasts

    def append_batch(self, verdicts=(), forecasts=(), returns=(), barriers=(), excursions=()):
        now = int(time.time() * 1000)
        with self.db:
            self.db.executemany(
                "INSERT INTO paper_futures_forecast_verdicts VALUES(?,?,?,?)",
                [row + (now,) for row in verdicts],
            )
            self.db.executemany(
                "INSERT INTO paper_futures_forecasts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [row + (now,) for row in forecasts],
            )
            self.db.executemany(
                "INSERT INTO paper_futures_forecast_returns VALUES(?,?,?,?,?,?,?,?)",
                [row + (now,) for row in returns],
            )
            self.db.executemany(
                "INSERT INTO paper_futures_forecast_barriers VALUES(?,?,?,?,?,?,?)",
                [row + (now,) for row in barriers],
            )
            self.db.executemany(
                "INSERT INTO paper_futures_forecast_excursions VALUES(?,?,?,?,?,?,?)",
                [row + (now,) for row in excursions],
            )

    def close(self):
        self.db.close()


class _OpenForecast:
    __slots__ = ("key", "side", "entry", "stop", "target", "returns_done", "barrier_done",
                 "excursion_done", "scanned")

    def __init__(self, key, side, entry, stop, target):
        self.key = key
        self.side = side
        self.entry = entry
        self.stop = stop
        self.target = target
        self.returns_done = set()
        self.barrier_done = False
        self.excursion_done = False
        self.scanned = 0  # barrier candles already examined without a hit

    def complete(self, horizons):
        return len(self.returns_done) >= horizons and self.barrier_done and self.excursion_done


# --------------------------------------------------------------------------- readers


class _MarketCandles(_OfficialCandles):
    """The verdict service's official-candle reader plus a PK-bounded range."""

    _RANGE_WHERE = "interval_ms=? AND bucket_start>=? AND bucket_start<=?"

    def range(self, first_bucket, last_bucket):
        rows = self.db.execute(self._ROWS_SQL.format(self._RANGE_WHERE),
                               (ONE_MINUTE_MS, first_bucket, last_bucket))
        return self._candles(rows.fetchall())


class _VerdictReader:
    """Persistent read-only view of the verdicts DB, bounded by its integer primary key."""

    def __init__(self, path):
        self.path = path
        self.db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
        self.identity = _file_identity(path)
        self._available = False

    @property
    def available(self):
        if not self._available:
            self._available = self.db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_futures_verdicts'"
            ).fetchone() is not None
        return self._available

    def replaced(self):
        return _file_identity(self.path) != self.identity

    def latest_bucket(self):
        return self.db.execute("SELECT MAX(bucket_start) FROM paper_futures_verdicts").fetchone()[0]

    def after(self, bucket, limit):
        return self.db.execute(
            "SELECT bucket_start, verdict_hash, payload_json FROM paper_futures_verdicts "
            "WHERE bucket_start>? ORDER BY bucket_start LIMIT ?",
            (bucket, limit),
        ).fetchall()

    def close(self):
        self.db.close()


# --------------------------------------------------------------------------- scoring


def _signed_bp(side, entry, price):
    move = (price - entry) / entry * TEN_THOUSAND
    return move if side == "LONG" else -move


def _forecast_rows(bucket, verdict_hash, payload, entry_price, config):
    """Forecast rows for one verdict: each LONG/SHORT proposal and the selected decision."""
    lag = payload.get("knowledge_lag_ms")
    lag = lag if isinstance(lag, int) and not isinstance(lag, bool) else None
    backfill = 1 if lag is None or lag > config["max_verdict_lag_ms"] else 0
    hour = ((bucket + ONE_MINUTE_MS) // 3_600_000) % 24
    regime = payload.get("regime") if isinstance(payload.get("regime"), str) else "unknown"
    rows = []
    candidates = [(SOURCE_PROPOSAL, item) for item in payload.get("proposals") or []]
    candidates.append((SOURCE_SELECTED, payload.get("selected")))
    for source, item in candidates:
        if not isinstance(item, dict) or item.get("action") not in ("LONG", "SHORT"):
            continue
        strategy = item.get("strategy_id")
        if not isinstance(strategy, str):
            continue
        stop, target = item.get("proposed_stop"), item.get("proposed_target")
        signal = item.get("signal_key")
        rows.append((
            bucket, source, strategy, item["action"], regime, hour, lag, backfill, entry_price,
            None if stop is None else str(stop), None if target is None else str(target),
            signal if isinstance(signal, str) else None, verdict_hash,
        ))
    return rows


class ForecastScoreService:
    """Poll loop state: persistent readers, in-memory open forecasts and candle cache.

    ``poll`` never raises; it returns the number of rows it appended.
    """

    def __init__(self, market_db_path, verdicts_db_path, store, log=print):
        self.market_db_path = market_db_path
        self.verdicts_db_path = verdicts_db_path
        self.store = store
        self.log = log
        self.market = None
        self.verdicts = None
        self._unavailable = None
        self._missing_entry = None
        self._seen = None
        self._open = None
        self._cache = {}
        self._cache_from = None
        self._cache_to = None

    # -- connections -------------------------------------------------------

    def _drop(self):
        for name in ("market", "verdicts"):
            reader = getattr(self, name)
            if reader is not None:
                try:
                    reader.close()
                except sqlite3.Error:
                    pass
                setattr(self, name, None)
        self._seen = None

    def _reset_state(self):
        self._open = None
        self._cache = {}
        self._cache_from = self._cache_to = None
        self._seen = None

    # -- polling -----------------------------------------------------------

    def poll(self):
        try:
            written = self._poll()
        except Exception as error:  # noqa: BLE001 - the loop must survive anything
            self._drop()
            self._reset_state()
            message = "{}: {}".format(type(error).__name__, error)
            if message != self._unavailable:
                self.log("inputs unavailable: {}".format(message))
                self._unavailable = message
            return 0
        self._unavailable = None
        if written:
            self.log("forecast scores +{} rows".format(written))
        return written

    def _poll(self):
        if self.market is not None and self.market.replaced():
            self._drop()
        if self.verdicts is not None and self.verdicts.replaced():
            self._drop()
        if self.market is None:
            self.market = _MarketCandles(self.market_db_path)
        if self.verdicts is None:
            self.verdicts = _VerdictReader(self.verdicts_db_path)
        if not (self.market.available and self.verdicts.available):
            return 0
        verdict_latest = self.verdicts.latest_bucket()
        market_latest = self.market.latest_bucket()
        if market_latest is None or verdict_latest is None:
            return 0
        if self._seen == (verdict_latest, market_latest):
            return 0
        if self._open is None:
            self._open = self.store.open_forecasts()
        written = 0
        complete = True
        while True:
            batch = self.verdicts.after(self.store.last_verdict_bucket(), VERDICT_BATCH)
            if not batch:
                break
            ingested, complete = self._ingest(batch)
            written += ingested
            if not complete:
                break
            written += self._resolve(market_latest)
        written += self._resolve(market_latest)
        if complete:
            self._seen = (verdict_latest, market_latest)
        return written

    def _ingest(self, batch):
        entries = {
            candle["bucket_start"]: candle
            for candle in self.market.range(batch[0][0], batch[-1][0])
        }
        verdict_rows, forecast_rows, complete = [], [], True
        for bucket, verdict_hash, payload_json in batch:
            entry = entries.get(bucket)
            if entry is None:
                complete = False
                message = "entry candle {} missing from the market DB".format(bucket)
                if message != self._missing_entry:
                    self.log(message)
                    self._missing_entry = message
                break
            payload = json.loads(payload_json, parse_float=str)
            rows = _forecast_rows(bucket, verdict_hash, payload, entry["close"], self.store.config)
            verdict_rows.append((bucket, verdict_hash, len(rows)))
            forecast_rows.extend(rows)
        if verdict_rows:
            self.store.append_batch(verdicts=verdict_rows, forecasts=forecast_rows)
            for row in forecast_rows:
                key = (row[0], row[1], row[2])
                self._open[key] = _OpenForecast(
                    key, row[3], Decimal(row[8]), _decimal(row[9]), _decimal(row[10])
                )
        return len(verdict_rows) + len(forecast_rows), complete

    def _refresh_cache(self, first_needed, latest):
        if (self._cache_to is None or first_needed < self._cache_from
                or first_needed > self._cache_to + ONE_MINUTE_MS):
            self._cache = {}
            self._cache_from = first_needed
            self._cache_to = first_needed - ONE_MINUTE_MS
        if latest > self._cache_to:
            for candle in self.market.range(self._cache_to + ONE_MINUTE_MS, latest):
                self._cache[candle["bucket_start"]] = (
                    Decimal(candle["high"]), Decimal(candle["low"]), Decimal(candle["close"]),
                )
            self._cache_to = latest
        if len(self._cache) > CACHE_PRUNE_AT and first_needed > self._cache_from:
            self._cache = {bucket: value for bucket, value in self._cache.items() if bucket >= first_needed}
            self._cache_from = first_needed

    def _resolve(self, latest):
        if not self._open:
            return 0
        store = self.store
        first_needed = min(key[0] for key in self._open) + ONE_MINUTE_MS
        self._refresh_cache(first_needed, latest)
        cache = self._cache
        cost = store.cost_bp
        returns, barriers, excursions = [], [], []
        for key, forecast in self._open.items():
            bucket, source, strategy = key
            side, entry = forecast.side, forecast.entry
            for horizon in store.horizons:
                if horizon in forecast.returns_done:
                    continue
                exit_bucket = bucket + horizon * ONE_MINUTE_MS
                candle = cache.get(exit_bucket)
                if candle is None:
                    continue
                gross = _signed_bp(side, entry, candle[2])
                returns.append((bucket, source, strategy, horizon, _bp(gross), _bp(gross - cost), exit_bucket))
                forecast.returns_done.add(horizon)
            if not forecast.excursion_done:
                window = [cache.get(bucket + step * ONE_MINUTE_MS) for step in range(1, store.excursion_min + 1)]
                if all(candle is not None for candle in window):
                    best = max(candle[0] for candle in window)
                    worst = min(candle[1] for candle in window)
                    favorable = _signed_bp("LONG", entry, best) if side == "LONG" else _signed_bp("SHORT", entry, worst)
                    adverse = -_signed_bp("LONG", entry, worst) if side == "LONG" else -_signed_bp("SHORT", entry, best)
                    excursions.append((bucket, source, strategy, store.excursion_min,
                                       _bp(max(favorable, Decimal(0))), _bp(max(adverse, Decimal(0)))))
                    forecast.excursion_done = True
            if not forecast.barrier_done:
                self._race(forecast, cache, barriers)
        for key in [key for key, forecast in self._open.items() if forecast.complete(len(store.horizons))]:
            del self._open[key]
        if returns or barriers or excursions:
            store.append_batch(returns=returns, barriers=barriers, excursions=excursions)
        return len(returns) + len(barriers) + len(excursions)

    def _race(self, forecast, cache, barriers):
        bucket, source, strategy = forecast.key
        horizon = self.store.barrier_min
        if forecast.stop is None or forecast.target is None:
            barriers.append((bucket, source, strategy, "no_levels", 0, None))
            forecast.barrier_done = True
            return
        long = forecast.side == "LONG"
        stop, target = forecast.stop, forecast.target
        while forecast.scanned < horizon:
            candle = cache.get(bucket + (forecast.scanned + 1) * ONE_MINUTE_MS)
            if candle is None:
                return
            forecast.scanned += 1
            high, low = candle[0], candle[1]
            stop_hit = low <= stop if long else high >= stop
            target_hit = high >= target if long else low <= target
            if stop_hit or target_hit:
                outcome = "stop" if stop_hit else "target"
                barriers.append((bucket, source, strategy, outcome, 1 if stop_hit and target_hit else 0,
                                 forecast.scanned * ONE_MINUTE_MS))
                forecast.barrier_done = True
                return
        barriers.append((bucket, source, strategy, "neither", 0, None))
        forecast.barrier_done = True

    def close(self):
        self._drop()


def process_available(market_db_path, verdicts_db_path, store, log=lambda line: None):
    """Scores everything the inputs already allow (replay); returns rows appended."""
    service = ForecastScoreService(market_db_path, verdicts_db_path, store, log=log)
    try:
        return service.poll()
    finally:
        service.close()


# --------------------------------------------------------------------------- aggregates


def _quantized(value, places="0.0001"):
    return normalize_decimal(str(value.quantize(Decimal(places), rounding=ROUND_HALF_EVEN)))


def summarize_net(values):
    """N, hit rate, mean/median, 95% CI (normal approximation), profit factor of net bp."""
    values = sorted(values)
    n = len(values)
    if n == 0:
        return {"n": 0, "hit_rate": None, "mean_net_bp": None, "median_net_bp": None,
                "ci95_low": None, "ci95_high": None, "profit_factor": None}
    mean = sum(values) / n
    middle = n // 2
    median = values[middle] if n % 2 else (values[middle - 1] + values[middle]) / 2
    wins = sum(1 for value in values if value > 0)
    gains = sum((value for value in values if value > 0), Decimal(0))
    losses = -sum((value for value in values if value < 0), Decimal(0))
    low = high = None
    if n > 1:
        variance = sum(((value - mean) ** 2 for value in values), Decimal(0)) / (n - 1)
        half = Decimal("1.96") * variance.sqrt() / Decimal(n).sqrt()
        low, high = mean - half, mean + half
    if losses > 0:
        factor = gains / losses
    else:
        factor = None
    return {
        "n": n,
        "hit_rate": _quantized(Decimal(wins) / n),
        "mean_net_bp": _quantized(mean),
        "median_net_bp": _quantized(median),
        "ci95_low": None if low is None else _quantized(low),
        "ci95_high": None if high is None else _quantized(high),
        "profit_factor": None if factor is None else _quantized(factor),
    }


def _hours_label(hour, size):
    if size >= 24:
        return "all"
    start = hour // size * size
    return "{:02d}-{:02d}".format(start, min(start + size, 24) - 1)


def forecast_score_report(scores_db_path, hour_bucket=24, live_only=False):
    """Deterministic aggregates recomputed from the stored scores (gateway-callable).

    One row per (strategy, side, regime, hour bucket, horizon), sorted. Each row
    holds the forecast's own stats (``model``), a buy & hold ``baseline`` over the
    same windows (always long, same round-trip cost), an always-opposite-side
    ``inverse`` control and the barrier race counts. The barrier race is
    horizon independent (24 h); the inverse control wins when the original stop
    was hit first without a same-candle ambiguity (swapped levels). The baseline
    has no barrier.
    """
    size = max(1, min(24, int(hour_bucket)))
    db = sqlite3.connect("file:{}?mode=ro".format(scores_db_path), uri=True)
    try:
        config = json.loads(db.execute(
            "SELECT value FROM paper_futures_forecast_meta WHERE key='config_json'").fetchone()[0])
        cost = round_trip_cost_bp(config)
        where = " WHERE f.backfill=0" if live_only else ""
        returns = {}
        for strategy, source, side, regime, hour, horizon, gross in db.execute(
            "SELECT f.strategy_id, f.source, f.side, f.regime, f.utc_hour, r.horizon_min, r.gross_bp "
            "FROM paper_futures_forecasts f JOIN paper_futures_forecast_returns r "
            "ON r.bucket_start=f.bucket_start AND r.source=f.source AND r.strategy_id=f.strategy_id"
            + where + " ORDER BY f.bucket_start, f.source, f.strategy_id, r.horizon_min"
        ):
            label = SOURCE_SELECTED if source == SOURCE_SELECTED else strategy
            gross = Decimal(gross)
            long_gross = gross if side == "LONG" else -gross
            cell = returns.setdefault(
                (label, side, regime, _hours_label(hour, size), horizon), ([], [], []))
            cell[0].append(gross - cost)
            cell[1].append(long_gross - cost)
            cell[2].append(-gross - cost)
        barriers = {}
        for strategy, source, side, regime, hour, outcome, ambiguous in db.execute(
            "SELECT f.strategy_id, f.source, f.side, f.regime, f.utc_hour, b.outcome, b.ambiguous "
            "FROM paper_futures_forecasts f JOIN paper_futures_forecast_barriers b "
            "ON b.bucket_start=f.bucket_start AND b.source=f.source AND b.strategy_id=f.strategy_id"
            + where + " ORDER BY f.bucket_start, f.source, f.strategy_id"
        ):
            if outcome == "no_levels":
                continue
            label = SOURCE_SELECTED if source == SOURCE_SELECTED else strategy
            cell = barriers.setdefault((label, side, regime, _hours_label(hour, size)),
                                       {"n": 0, "target": 0, "stop": 0, "neither": 0, "inverse_wins": 0})
            cell["n"] += 1
            cell[outcome] += 1
            if outcome == "stop" and not ambiguous:
                cell["inverse_wins"] += 1
    finally:
        db.close()
    report = []
    for key in sorted(returns):
        strategy, side, regime, hours, horizon = key
        model, baseline, inverse = returns[key]
        race = barriers.get((strategy, side, regime, hours), {"n": 0, "target": 0, "stop": 0,
                                                              "neither": 0, "inverse_wins": 0})
        n = race["n"]
        report.append({
            "strategy": strategy, "side": side, "regime": regime, "hours": hours,
            "horizon_min": horizon,
            "model": summarize_net(model),
            "baseline": summarize_net(baseline),
            "inverse": summarize_net(inverse),
            "barrier": {
                "n": n, "target": race["target"], "stop": race["stop"], "neither": race["neither"],
                "win_rate": _quantized(Decimal(race["target"]) / n) if n else None,
                "inverse_win_rate": _quantized(Decimal(race["inverse_wins"]) / n) if n else None,
            },
        })
    return report


def _horizon_label(minutes):
    return "{}h".format(minutes // 60) if minutes % 60 == 0 else "{}m".format(minutes)


def format_report(report):
    def cell(value, width):
        return ("-" if value is None else str(value)).rjust(width)

    header = (
        "strategy                    side  regime  hours  hor |    n   hit%   mean    med   ci95_lo   ci95_hi     pf"
        " |  bh_mean  bh_hit | inv_mean inv_hit | bar_n tgt/stp/nei  win%"
    )
    lines = [header, "-" * len(header)]
    for row in report:
        model = row["model"]
        barrier = row["barrier"]
        hit = None if model["hit_rate"] is None else _quantized(Decimal(model["hit_rate"]) * 100, "0.1")
        win = None if barrier["win_rate"] is None else _quantized(Decimal(barrier["win_rate"]) * 100, "0.1")
        base_hit = row["baseline"]["hit_rate"]
        inverse_hit = row["inverse"]["hit_rate"]
        lines.append(
            "{:<27} {:<5} {:<7} {:<5}  {:>3} |{} {} {} {} {} {} {} | {} {} | {} {} | {} {:>12} {}".format(
                row["strategy"][:27], row["side"], row["regime"][:7], row["hours"],
                _horizon_label(row["horizon_min"]),
                cell(model["n"], 5), cell(hit, 6), cell(model["mean_net_bp"], 7),
                cell(model["median_net_bp"], 6), cell(model["ci95_low"], 9), cell(model["ci95_high"], 9),
                cell(model["profit_factor"], 6),
                cell(row["baseline"]["mean_net_bp"], 8),
                cell(None if base_hit is None else _quantized(Decimal(base_hit) * 100, "0.1"), 7),
                cell(row["inverse"]["mean_net_bp"], 8),
                cell(None if inverse_hit is None else _quantized(Decimal(inverse_hit) * 100, "0.1"), 7),
                cell(barrier["n"], 5),
                "{}/{}/{}".format(barrier["target"], barrier["stop"], barrier["neither"]),
                cell(win, 5),
            )
        )
    lines.append("net bp = gross - round-trip cost; bh = long buy & hold over the same windows; "
                 "inv = always the opposite side")
    return "\n".join(lines)


# --------------------------------------------------------------------------- service


def run(market_db_path, verdicts_db_path, scores_db_path, poll_seconds=1.0, log=print):
    """Long-running loop: score forecasts as their future candles become official."""
    store = ScoreStore(scores_db_path, SCORE_CONFIG)
    log("forecast scores writing to {} (config {})".format(scores_db_path, store.config_hash[:12]))
    service = ForecastScoreService(market_db_path, verdicts_db_path, store, log)
    try:
        while True:
            service.poll()
            time.sleep(poll_seconds)
    finally:
        service.close()
        store.close()


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="Balancita futures forecast scorer (E)")
    parser.add_argument("--market-db")
    parser.add_argument("--verdicts-db")
    parser.add_argument("--scores-db", required=True)
    parser.add_argument("--once", action="store_true", help="score everything available and exit (replay)")
    parser.add_argument("--report", action="store_true", help="print the aggregate table and exit")
    parser.add_argument("--hour-bucket", type=int, default=24, help="UTC hours per bucket in the report (24 = all)")
    parser.add_argument("--live-only", action="store_true", help="report only non-backfilled verdicts")
    parser.add_argument("--poll-seconds", type=float, default=1.0)
    args = parser.parse_args(argv)
    needs_inputs = args.once or not args.report
    if needs_inputs and not (args.market_db and args.verdicts_db):
        parser.error("--market-db and --verdicts-db are required to score")
    if args.once:
        store = ScoreStore(args.scores_db, SCORE_CONFIG)
        try:
            print("forecast scores written {} rows".format(
                process_available(args.market_db, args.verdicts_db, store, log=print)))
        finally:
            store.close()
    if args.report:
        print(format_report(forecast_score_report(
            args.scores_db, hour_bucket=args.hour_bucket, live_only=args.live_only)))
    if args.once or args.report:
        return 0
    try:
        run(args.market_db, args.verdicts_db, args.scores_db, args.poll_seconds,
            log=lambda line: print(line, flush=True))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
