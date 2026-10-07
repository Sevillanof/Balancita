"""Historical replay (SS-08): every strategy decides blind over a date range of official candles.

Reads the market DB read-only and writes one self-contained run DB per replay
(summaries, trades, decisions); the live DBs are never touched. Strategies only
see candles that closed before each decision (``frames``), so the result is
deterministic for a given range and spec set.
"""

import argparse
import json
import os
import sqlite3
import sys
import time

from .futures_simulator import Book, frames
from .futures_spec_strategy import DEFAULT_SPEC_DIR, load_specs
from .futures_verdicts import FIVE_MINUTES_MS, ONE_MINUTE_MS, _OfficialCandles

WARMUP_MS = 300 * FIVE_MINUTES_MS  # enough history for the slowest indicators
REPLAY_SCHEMA = "futures-replay.v1"

_RUN_SCHEMA = """
CREATE TABLE replay_run(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE replay_summary(strategy_id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
CREATE TABLE replay_trade(id INTEGER PRIMARY KEY, strategy_id TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE TABLE replay_decision(id INTEGER PRIMARY KEY, strategy_id TEXT NOT NULL, bucket_ms INTEGER NOT NULL,
  payload TEXT NOT NULL) STRICT;
"""


def load_range(market_db_path, product_id, start_ms, end_ms):
    """Official 1m and 5m candles (first-known revision) from ``start_ms - warmup`` to ``end_ms``."""
    market = _OfficialCandles(market_db_path)
    try:
        if not market.available:
            raise ValueError("market DB has no per-product official candles")
        lo, cutoff = max(0, start_ms - WARMUP_MS), 2 ** 62
        rows = {}
        for interval in (ONE_MINUTE_MS, FIVE_MINUTES_MS):
            rows[interval] = market._candles(market.db.execute(
                market._ROWS_SQL.format(market._WINDOW_WHERE), (product_id, interval, lo, end_ms, cutoff)
            ).fetchall())
        return rows[ONE_MINUTE_MS], rows[FIVE_MINUTES_MS]
    finally:
        market.db.close()


def replay(specs, candles_1m, candles_5m, *, start_ms, product_id, tick_size="1", notional_usd="100"):
    """Books of every spec; warm-up candles feed indicators but never open positions."""
    books = [Book(spec, product_id=product_id, tick_size=tick_size, notional_usd=notional_usd) for spec in specs]
    for frame in frames(candles_1m, candles_5m):
        if frame[0] < start_ms:
            continue
        for book in books:
            book.on_frame(*frame)
    return books


def write_run(path, meta, books):
    if os.path.exists(path):
        raise FileExistsError("replay run already exists: " + path)
    db = sqlite3.connect(path)
    try:
        db.executescript(_RUN_SCHEMA)
        db.executemany("INSERT INTO replay_run VALUES(?,?)", [(k, json.dumps(v)) for k, v in meta.items()])
        for book in books:
            sid = book.spec["id"]
            db.execute("INSERT INTO replay_summary VALUES(?,?)", (sid, json.dumps(book.summary())))
            db.executemany("INSERT INTO replay_trade(strategy_id, payload) VALUES(?,?)",
                           [(sid, json.dumps(t)) for t in book.trades])
            db.executemany("INSERT INTO replay_decision(strategy_id, bucket_ms, payload) VALUES(?,?,?)",
                           [(sid, d["bucket_ms"], json.dumps(d)) for d in book.decisions])
        db.commit()
    finally:
        db.close()


def run(market_db, out_path, product_id, start_ms, end_ms, specs, tick_size="1"):
    if end_ms <= start_ms:
        raise ValueError("replay range is empty")
    ones, fives = load_range(market_db, product_id, start_ms, end_ms)
    if not any(c["bucket_start"] >= start_ms for c in ones):
        raise ValueError("no official candles in the requested range")
    books = replay(specs, ones, fives, start_ms=start_ms, product_id=product_id, tick_size=tick_size)
    meta = {
        "schema": REPLAY_SCHEMA, "product_id": product_id, "start_ms": start_ms, "end_ms": end_ms,
        "strategies": [s["id"] for s in specs], "candles_1m": len(ones), "created_ms": int(time.time() * 1000),
    }
    write_run(out_path, meta, books)
    return [book.summary() for book in books]


def _ms(text):
    return int(time.mktime(time.strptime(text, "%Y-%m-%d")) - time.timezone) * 1000


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--out", required=True, help="new run DB (must not exist)")
    parser.add_argument("--product", default="PF_XBTUSD")
    parser.add_argument("--from", dest="start", required=True, help="UTC date YYYY-MM-DD (inclusive)")
    parser.add_argument("--to", dest="end", required=True, help="UTC date YYYY-MM-DD (exclusive)")
    parser.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR)
    args = parser.parse_args(argv)
    specs = list(load_specs(args.specs_dir).values())
    summaries = run(args.market_db, args.out, args.product, _ms(args.start), _ms(args.end), specs)
    json.dump(summaries, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
