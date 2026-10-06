"""Verdict service C: entry verdicts over official Kraken candles.

Pure and replayable. A verdict for 1m bucket B only uses official candles
that closed by B's close and were known by B's ``known_at``, through
fixed-length windows, so the same market DB always yields the same verdicts.
Proposals use the flat-position path only: exits, position ownership and
consumed signals belong to paper execution (D).

Several Kraken ``PF_*`` perpetuals share one verdicts DB: every product is its
own verdict stream, keyed by ``(product_id, bucket_start)`` and chained by its
own regime. The product list and each product's tick size come from the pinned
config (``futures_products``), never from the market at runtime, and a
product's candles never influence another product's verdicts.
"""

import json
import os
import sqlite3
import time

from .canonical import canonical_hash
from .futures_indicators import FEATURE_SCHEMA_VERSION, calculate_features
from .futures_products import is_product_id, resolve_products
from .futures_strategies import (
    CONFIG_VERSION,
    STRATEGY_IDS,
    propose,
    select_proposal,
    update_regime,
)

ONE_MINUTE_MS = 60_000
FIVE_MINUTES_MS = 300_000
VERDICT_SCHEMA_VERSION = "futures-verdict.v1"
CONFIG_MISMATCH = "verdicts DB was written with a different config; use a new DB"

# Base config shared by every product. The per-product part (``product_id`` and
# ``tick_size`` from the pinned catalog values) is added by ``product_config``.
VERDICT_CONFIG = {
    "version": "futures-verdict-config.v3",
    "strategy_config": CONFIG_VERSION,
    "feature_schema": FEATURE_SCHEMA_VERSION,
    # Fixed windows: EMA/RSI depend on their first bar, so the window length
    # is part of the verdict identity.
    "window_1m": 200,
    "window_5m": 200,
    "maker_rate": "0.0002",
    "taker_rate": "0.0005",
}


def product_config(config, product_id, tick_size):
    """The config one product's verdicts are computed (and hashed) with."""
    if not is_product_id(product_id):
        raise ValueError("invalid futures product {!r}".format(product_id))
    return dict(config, product_id=product_id, tick_size=tick_size)


def _feature_candle(candle):
    return {
        "interval_ms": candle["interval_ms"],
        "bucket_start_ms": candle["bucket_start"],
        "close_at_ms": candle["close_at"],
        "known_at_ms": candle["known_at"],
        "received_at_ms": candle["known_at"],
        "closed": True,
        # Official candles are gapless by construction (quiet minutes are flat).
        "coverage": "complete",
        "open": candle["open"],
        "high": candle["high"],
        "low": candle["low"],
        "close": candle["close"],
        "volume_btc": candle["volume_btc"],
    }


def _as_of(candles, close_cutoff, known_cutoff, size):
    eligible = [
        candle for candle in candles
        if candle["close_at"] <= close_cutoff and candle["known_at"] <= known_cutoff
    ]
    eligible.sort(key=lambda candle: candle["bucket_start"])
    return eligible[-size:]


def _input_digest(candles):
    return {
        "count": len(candles),
        "first_bucket_start_ms": candles[0]["bucket_start"] if candles else None,
        "last_bucket_start_ms": candles[-1]["bucket_start"] if candles else None,
        "hash": canonical_hash([[c["bucket_start"], c["revision_hash"]] for c in candles]),
    }


def evaluate_verdict(one_minute, five_minute, *, previous_regime, config, candidate_bucket=None):
    """Entry verdict for one closed 1m bucket (default: the latest given).

    ``config`` is a ``product_config``: the product's tick size shapes its stops.
    """
    if candidate_bucket is None:
        candidate_bucket = max(candle["bucket_start"] for candle in one_minute)
    candidate = next(c for c in one_minute if c["bucket_start"] == candidate_bucket)
    close_cutoff = candidate["close_at"]
    decision = candidate["known_at"]
    ones = _as_of(one_minute, close_cutoff, decision, config["window_1m"])
    fives = _as_of(five_minute, close_cutoff, decision, config["window_5m"])
    one_bars = [_feature_candle(candle) for candle in ones]
    five_bars = [_feature_candle(candle) for candle in fives]

    features = calculate_features(one_bars, interval_ms=ONE_MINUTE_MS, decision_time_ms=decision)
    features["candidate_bucket_start_ms"] = candidate_bucket
    features["candidate_low"] = candidate["low"]
    features["candidate_high"] = candidate["high"]
    previous = None
    if len(one_bars) > 1:
        previous = calculate_features(
            one_bars, interval_ms=ONE_MINUTE_MS, decision_time_ms=decision,
            candidate_index=len(one_bars) - 2,
        )
        previous["candidate_bucket_start_ms"] = ones[-2]["bucket_start"]
        previous["candidate_low"] = ones[-2]["low"]
        previous["candidate_high"] = ones[-2]["high"]
    trend = calculate_features(five_bars, interval_ms=FIVE_MINUTES_MS, decision_time_ms=decision)
    if five_bars:
        trend["candidate_bucket_start_ms"] = fives[-1]["bucket_start"]
    regime = update_regime(previous_regime, trend.get("ema9"), trend.get("ema21"), trend.get("atr14"))

    age_ms = decision - close_cutoff
    cost = {"maker_rate": config["maker_rate"], "taker_rate": config["taker_rate"]}
    proposals = [
        propose(
            strategy_id, features, previous=previous, trend=trend, regime=regime,
            age_ms=age_ms, tick_size=config["tick_size"], cost_config=cost,
        )
        for strategy_id in STRATEGY_IDS
    ]
    selected = select_proposal(proposals, owner_strategy_id=None)
    verdict = {
        "schema_version": VERDICT_SCHEMA_VERSION,
        "config_hash": canonical_hash(config),
        "product_id": config["product_id"],
        "interval_ms": ONE_MINUTE_MS,
        "bucket_start_ms": candidate_bucket,
        "close_at_ms": close_cutoff,
        "decision_known_at_ms": decision,
        # Large for verdicts rebuilt from a backfill; D should only act on fresh ones.
        "knowledge_lag_ms": age_ms,
        "previous_regime": previous_regime,
        "regime": regime,
        "action": selected["action"],
        "reason_code": selected["reason_code"],
        "selected": selected,
        "proposals": proposals,
        "features": {"1m": features, "1m_previous": previous, "5m": trend},
        "inputs": {"1m": _input_digest(ones), "5m": _input_digest(fives)},
    }
    verdict["verdict_hash"] = canonical_hash(verdict)
    return verdict


class VerdictStore:
    """Single writer of the verdicts DB; append-only verdicts per product, chained by regime."""

    def __init__(self, path, config):
        self.config = dict(config)
        self.config_hash = canonical_hash(self.config)
        self.db = sqlite3.connect(path)
        # The config is checked before anything else is created: a DB written
        # for another config (such as the single-product one) is refused untouched.
        self.db.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS paper_futures_verdict_meta(
              key TEXT PRIMARY KEY, value TEXT NOT NULL
            ) STRICT;
            CREATE TRIGGER IF NOT EXISTS paper_futures_verdict_meta_no_update
              BEFORE UPDATE ON paper_futures_verdict_meta BEGIN SELECT RAISE(ABORT, 'verdicts are immutable'); END;
            """
        )
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO paper_futures_verdict_meta VALUES('config_json', ?)",
                (json.dumps(self.config, sort_keys=True),),
            )
            self.db.execute(
                "INSERT OR IGNORE INTO paper_futures_verdict_meta VALUES('config_hash', ?)",
                (self.config_hash,),
            )
        stored = self.db.execute(
            "SELECT value FROM paper_futures_verdict_meta WHERE key='config_hash'"
        ).fetchone()[0]
        if stored != self.config_hash:
            self.db.close()
            raise ValueError(CONFIG_MISMATCH)
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS paper_futures_verdict_products(
              product_id TEXT PRIMARY KEY, tick_size TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS paper_futures_verdicts(
              product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
              decision_known_at INTEGER NOT NULL, regime TEXT NOT NULL,
              action TEXT NOT NULL, reason_code TEXT NOT NULL,
              verdict_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
              written_at INTEGER NOT NULL,
              PRIMARY KEY(product_id, bucket_start)
            ) STRICT;
            CREATE TRIGGER IF NOT EXISTS paper_futures_verdicts_no_update
              BEFORE UPDATE ON paper_futures_verdicts BEGIN SELECT RAISE(ABORT, 'verdicts are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS paper_futures_verdicts_no_delete
              BEFORE DELETE ON paper_futures_verdicts BEGIN SELECT RAISE(ABORT, 'verdicts are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS paper_futures_verdict_products_no_update
              BEFORE UPDATE ON paper_futures_verdict_products BEGIN SELECT RAISE(ABORT, 'verdicts are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS paper_futures_verdict_products_no_delete
              BEFORE DELETE ON paper_futures_verdict_products BEGIN SELECT RAISE(ABORT, 'verdicts are immutable'); END;
            """
        )
        self.products = {}

    def register_product(self, product_id, tick_size):
        """Records a product's pinned tick size; a different one for a known product is refused."""
        if self.products.get(product_id) == tick_size:
            return
        if not is_product_id(product_id):
            raise ValueError("invalid futures product {!r}".format(product_id))
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO paper_futures_verdict_products VALUES(?, ?)", (product_id, tick_size)
            )
        stored = self.db.execute(
            "SELECT tick_size FROM paper_futures_verdict_products WHERE product_id=?", (product_id,)
        ).fetchone()[0]
        if stored != tick_size:
            raise ValueError("{} (tick size of {})".format(CONFIG_MISMATCH, product_id))
        self.products[product_id] = tick_size

    def last_verdict(self, product_id):
        row = self.db.execute(
            "SELECT bucket_start, regime FROM paper_futures_verdicts WHERE product_id=? "
            "ORDER BY bucket_start DESC LIMIT 1",
            (product_id,),
        ).fetchone()
        return None if row is None else (row[0], row[1])

    def append(self, verdict):
        with self.db:
            self.db.execute(
                "INSERT INTO paper_futures_verdicts VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    verdict["product_id"], verdict["bucket_start_ms"], verdict["interval_ms"],
                    verdict["decision_known_at_ms"], verdict["regime"], verdict["action"],
                    verdict["reason_code"], verdict["verdict_hash"],
                    json.dumps(verdict, sort_keys=True, separators=(",", ":")),
                    int(time.time() * 1000),
                ),
            )

    def close(self):
        self.db.close()


class _OfficialCandles:
    """Read-only view of the market DB's official candles (first-known revisions).

    Every query is bounded by the (product_id, interval_ms, bucket_start) primary
    key range, so its cost does not grow with the stored history. The connection is kept
    open across polls.
    """

    def __init__(self, path):
        self.path = path
        self.db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
        self.identity = _file_identity(path)
        self._available = False

    @property
    def available(self):
        # A market DB the writer has not migrated yet (schema 4, no product_id)
        # counts as unavailable until the capture process rebuilds it.
        if not self._available:
            self._available = any(
                row[1] == "product_id"
                for row in self.db.execute("PRAGMA table_info(paper_futures_official_candles)")
            )
        return self._available

    def replaced(self):
        """True when the file at the path is no longer the one this connection opened."""
        return _file_identity(self.path) != self.identity

    def latest_bucket(self, product_id):
        """Newest stored 1m bucket of a product (None when there is none): one index probe."""
        return self.db.execute(
            "SELECT MAX(bucket_start) FROM paper_futures_official_candles WHERE product_id=? AND interval_ms=?",
            (product_id, ONE_MINUTE_MS),
        ).fetchone()[0]

    _ROWS_SQL = """
        WITH ranked AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY product_id, interval_ms, bucket_start ORDER BY known_at, rowid
          ) AS revision_rank
          FROM paper_futures_official_candles WHERE {}
        )
        SELECT interval_ms, bucket_start, known_at, open_price, high_price,
          low_price, close_price, volume_btc, revision_hash
        FROM ranked WHERE revision_rank=1 ORDER BY bucket_start
        """
    # Bounds are on bucket_start itself (not bucket_start+interval_ms) so the
    # primary key range applies.
    _PENDING_WHERE = "product_id=? AND interval_ms=? AND bucket_start>?"
    _WINDOW_FLOOR_SQL = """
        SELECT bucket_start FROM paper_futures_official_candles
        WHERE product_id=? AND interval_ms=? AND bucket_start<=? AND known_at<=?
        GROUP BY bucket_start ORDER BY bucket_start DESC LIMIT 1 OFFSET ?
        """
    _WINDOW_WHERE = "product_id=? AND interval_ms=? AND bucket_start>=? AND bucket_start<=? AND known_at<=?"

    @staticmethod
    def _candles(rows):
        return [
            {
                "interval_ms": row[0], "bucket_start": row[1], "close_at": row[1] + row[0],
                "known_at": row[2], "open": row[3], "high": row[4], "low": row[5],
                "close": row[6], "volume_btc": row[7], "revision_hash": row[8],
            }
            for row in rows
        ]

    def pending(self, product_id, after_bucket):
        """1m buckets of a product after its last verdict, each with its first-known revision."""
        rows = self.db.execute(
            self._ROWS_SQL.format(self._PENDING_WHERE), (product_id, ONE_MINUTE_MS, after_bucket)
        )
        return self._candles(rows.fetchall())

    def window(self, product_id, interval_ms, close_cutoff, known_cutoff, size):
        last_start = close_cutoff - interval_ms
        row = self.db.execute(
            self._WINDOW_FLOOR_SQL, (product_id, interval_ms, last_start, known_cutoff, size - 1)
        ).fetchone()
        floor = 0 if row is None else row[0]
        rows = self.db.execute(
            self._ROWS_SQL.format(self._WINDOW_WHERE),
            (product_id, interval_ms, floor, last_start, known_cutoff),
        )
        return self._candles(rows.fetchall())[-size:]

    def query_plans(self, product_id, close_cutoff, known_cutoff):
        """EXPLAIN QUERY PLAN detail lines of each query, for regression tests."""
        plans = []
        for sql, params in (
            (self._ROWS_SQL.format(self._PENDING_WHERE), (product_id, ONE_MINUTE_MS, close_cutoff)),
            (self._WINDOW_FLOOR_SQL, (product_id, ONE_MINUTE_MS, close_cutoff, known_cutoff, 199)),
            (self._ROWS_SQL.format(self._WINDOW_WHERE), (product_id, ONE_MINUTE_MS, 0, close_cutoff, known_cutoff)),
            (self._ROWS_SQL.format(self._WINDOW_WHERE), (product_id, FIVE_MINUTES_MS, 0, close_cutoff, known_cutoff)),
        ):
            plans.append([row[3] for row in self.db.execute("EXPLAIN QUERY PLAN " + sql, params)])
        return plans

    def close(self):
        self.db.close()


def _file_identity(path):
    try:
        info = os.stat(path)
    except OSError:
        return None
    return (info.st_dev, info.st_ino)


def process_available(market_db_path, store, products=None, limit=None, market=None):
    """Writes a verdict for every pending official 1m bucket of every product, in order.

    ``products`` is the pinned ``[(product_id, tick_size)]`` list (default: the
    pinned config / ``FUTURES_PRODUCTS``). ``market`` is an already open reader
    (kept by the service loop); without one a reader is opened and closed for
    this call. ``limit`` caps the verdicts written by this call.
    """
    products = resolve_products() if products is None else products
    owned = market is None
    if owned:
        market = _OfficialCandles(market_db_path)
    try:
        if not market.available:
            return 0
        processed = 0
        for product_id, tick_size in products:
            store.register_product(product_id, tick_size)
            config = product_config(store.config, product_id, tick_size)
            last = store.last_verdict(product_id)
            after = -1 if last is None else last[0]
            latest = market.latest_bucket(product_id)
            if latest is None or latest <= after:
                continue
            regime = "unknown" if last is None else last[1]
            for candidate in market.pending(product_id, after):
                if limit is not None and processed >= limit:
                    return processed
                decision = candidate["known_at"]
                ones = market.window(product_id, ONE_MINUTE_MS, candidate["close_at"], decision,
                                     config["window_1m"])
                # The candidate's own first-known revision is the one in `pending`.
                ones = [c for c in ones if c["bucket_start"] != candidate["bucket_start"]] + [candidate]
                fives = market.window(product_id, FIVE_MINUTES_MS, candidate["close_at"], decision,
                                      config["window_5m"])
                verdict = evaluate_verdict(ones, fives, previous_regime=regime, config=config,
                                           candidate_bucket=candidate["bucket_start"])
                store.append(verdict)
                regime = verdict["regime"]
                processed += 1
        return processed
    finally:
        if owned:
            market.close()


class VerdictService:
    """Poll loop state: one persistent market reader that survives a missing,
    locked or recreated market DB without ever raising."""

    def __init__(self, market_db_path, store, products=None, log=print):
        self.market_db_path = market_db_path
        self.store = store
        self.products = resolve_products() if products is None else list(products)
        self.log = log
        self.market = None
        self._unavailable = None

    def _drop(self):
        if self.market is not None:
            try:
                self.market.close()
            except sqlite3.Error:
                pass
            self.market = None

    def poll(self):
        """Processes pending buckets; returns the number of verdicts written."""
        try:
            if self.market is not None and self.market.replaced():
                self._drop()
            if self.market is None:
                self.market = _OfficialCandles(self.market_db_path)
            count = process_available(self.market_db_path, self.store, self.products, market=self.market)
        except sqlite3.OperationalError as error:
            self._drop()
            # Log a given condition once, not on every poll.
            if str(error) != self._unavailable:
                self.log("market DB unavailable: {}".format(error))
                self._unavailable = str(error)
            return 0
        self._unavailable = None
        if count:
            self.log("verdicts +{} ({})".format(count, ", ".join(
                "{} {}".format(product_id, self.store.last_verdict(product_id)[0])
                for product_id, _ in self.products if self.store.last_verdict(product_id) is not None)))
        return count

    def close(self):
        self._drop()


def run(market_db_path, verdicts_db_path, products=None, poll_seconds=1.0, log=print):
    """Long-running service loop: one verdict per product per newly closed official 1m candle."""
    products = resolve_products() if products is None else products
    store = VerdictStore(verdicts_db_path, VERDICT_CONFIG)
    log("verdicts writing to {} (config {}) for {}".format(
        verdicts_db_path, store.config_hash[:12],
        ", ".join("{} (tick {})".format(*product) for product in products)))
    service = VerdictService(market_db_path, store, products, log)
    try:
        while True:
            service.poll()
            time.sleep(poll_seconds)
    finally:
        service.close()
        store.close()


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="Balancita futures verdict service (C)")
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--verdicts-db", required=True)
    parser.add_argument("--once", action="store_true", help="process pending buckets and exit (replay)")
    parser.add_argument("--products", help="comma-separated PF_X[:tickSize] list "
                        "(default: FUTURES_PRODUCTS or config/futures-products.json)")
    parser.add_argument("--poll-seconds", type=float, default=1.0)
    args = parser.parse_args(argv)
    products = resolve_products(args.products)
    if args.once:
        store = VerdictStore(args.verdicts_db, VERDICT_CONFIG)
        try:
            print("verdicts processed {}".format(process_available(args.market_db, store, products)))
        finally:
            store.close()
        return 0
    try:
        run(args.market_db, args.verdicts_db, products, args.poll_seconds,
            log=lambda line: print(line, flush=True))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
