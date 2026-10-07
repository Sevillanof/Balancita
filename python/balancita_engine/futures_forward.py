"""Forward paper measurement of strategies found by searching past data.

``config/forward-strategies.json`` registers a strategy with a start time. From then on this runner replays
it over the official candles of the market DB (``futures_replay.load_range``, indicators warmed up with the
week before the start), takes only the decisions from ``start_ms`` on, and keeps its own append-only DB of the
trades that happened after registration. Nothing in it can be fitted to: every trade was decided on candles
that closed before it, by a spec whose hash is recorded. Closed trades are never rewritten; re-running only
adds the ones that have closed since.

``write_summary`` turns that DB into ``futures-strategy-forward.v1`` JSON (per strategy: the reliability
figures of its forward trades, per product, and the open positions), which
``futures_strategy_reliability.effective_reliability`` uses: the backtest verdict stands until the strategy has
``FORWARD_MIN_TRADES`` forward trades, then the forward trades alone decide.

    python -m balancita_engine.futures_forward --market-db data/market.sqlite --out data/forward \\
        [--loop-seconds 3600]
"""

import argparse
import json
import os
import sqlite3
import time

from .futures_products import resolve_products
from .futures_replay import load_range, replay
from .futures_spec_strategy import DEFAULT_SPEC_DIR, load_specs, spec_hash
from .futures_strategy_reliability import (
    FORWARD_SCHEMA,
    FORWARD_STRATEGIES_PATH,
    summarize_trades,
)

ONE_MINUTE_MS = 60_000
_SCHEMA = """
CREATE TABLE IF NOT EXISTS forward_trade(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL,
  spec_hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(strategy_id, product_id, entry_bucket_ms)) STRICT;
CREATE TABLE IF NOT EXISTS forward_open(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, spec_hash TEXT NOT NULL, payload TEXT,
  PRIMARY KEY(strategy_id, product_id)) STRICT;
CREATE TRIGGER IF NOT EXISTS forward_trade_no_update BEFORE UPDATE ON forward_trade
  BEGIN SELECT RAISE(ABORT, 'forward trades are append-only'); END;
CREATE TRIGGER IF NOT EXISTS forward_trade_no_delete BEFORE DELETE ON forward_trade
  BEGIN SELECT RAISE(ABORT, 'forward trades are append-only'); END;
"""


def load_registration(path=None):
    with open(path or FORWARD_STRATEGIES_PATH, encoding="utf-8") as handle:
        body = json.load(handle)
    if body.get("schema") != "futures-forward-strategies.v1":
        raise ValueError("not a forward strategies file")
    return body


def run_forward(market_db, db_path, specs, registration, products):
    """Replays every registered spec over every product and stores the trades closed since its start.

    Returns ``{(strategy_id, product_id): number of new trades}``.
    """
    db = sqlite3.connect(db_path)
    db.executescript(_SCHEMA)
    added = {}
    try:
        now = int(time.time() * 1000)
        for strategy_id, info in registration["strategies"].items():
            spec = specs.get(strategy_id)
            if spec is None:
                continue
            digest = spec_hash(spec)
            for product_id, tick_size in products:
                try:
                    ones, fives = load_range(market_db, product_id, info["start_ms"], now + ONE_MINUTE_MS)
                except ValueError:
                    continue
                (book,) = replay([spec], ones, fives, start_ms=info["start_ms"], product_id=product_id,
                                 tick_size=tick_size)
                with db:
                    added[(strategy_id, product_id)] = 0
                    for trade in book.trades:
                        cursor = db.execute(
                            "INSERT OR IGNORE INTO forward_trade VALUES(?,?,?,?,?)",
                            (strategy_id, product_id, trade["entry_bucket_ms"], digest, json.dumps(trade)))
                        added[(strategy_id, product_id)] += cursor.rowcount
                    position = None if book.position is None else {
                        key: str(book.position[key]) for key in ("side", "entry", "stop", "target", "opened_at")}
                    db.execute("INSERT OR REPLACE INTO forward_open VALUES(?,?,?,?)",
                               (strategy_id, product_id, digest, json.dumps(position)))
    finally:
        db.close()
    return added


def write_summary(db_path, specs, registration, out_path):
    """The forward reliability JSON for every registered strategy, written atomically."""
    db = sqlite3.connect(db_path)
    try:
        now = int(time.time() * 1000)
        strategies = {}
        for strategy_id, info in registration["strategies"].items():
            spec = specs.get(strategy_id)
            if spec is None:
                continue
            digest = spec_hash(spec)
            rows = db.execute("SELECT product_id, payload FROM forward_trade WHERE strategy_id=? AND spec_hash=?",
                              (strategy_id, digest)).fetchall()
            trades = [dict(json.loads(payload), product_id=product) for product, payload in rows]
            open_positions = sum(1 for (payload,) in db.execute(
                "SELECT payload FROM forward_open WHERE strategy_id=? AND spec_hash=?", (strategy_id, digest))
                if json.loads(payload) is not None)
            by_product = {}
            for trade in trades:
                by_product.setdefault(trade["product_id"], []).append(trade)
            strategies[strategy_id] = {
                "spec_hash": digest, "start_ms": info["start_ms"], "open_positions": open_positions,
                "summary": summarize_trades(trades, first_ms=info["start_ms"], last_ms=max(now, info["start_ms"] + 1)),
                "by_product": {p: {k: v for k, v in summarize_trades(t).items()
                                   if k in ("trades", "hit_rate", "mean_net_bp", "pnl_usd")}
                               for p, t in sorted(by_product.items())},
            }
    finally:
        db.close()
    body = {"schema": FORWARD_SCHEMA, "updated_ms": now, "min_forward_trades": registration["min_forward_trades"],
            "strategies": strategies}
    temporary = out_path + ".partial"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(body, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, out_path)
    return body


def main(argv=None):
    parser = argparse.ArgumentParser(description="Measure registered strategies forward, in paper.")
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--out", required=True, help="directory for forward.sqlite and forward-reliability.json")
    parser.add_argument("--specs-dir", default=DEFAULT_SPEC_DIR)
    parser.add_argument("--registration", default=FORWARD_STRATEGIES_PATH)
    parser.add_argument("--loop-seconds", type=float, default=0, help="repeat every N seconds (0: once)")
    args = parser.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    specs = load_specs(args.specs_dir)
    registration = load_registration(args.registration)
    products = resolve_products()
    while True:
        added = run_forward(args.market_db, os.path.join(args.out, "forward.sqlite"), specs, registration, products)
        body = write_summary(os.path.join(args.out, "forward.sqlite"), specs, registration,
                             os.path.join(args.out, "forward-reliability.json"))
        for strategy_id, entry in body["strategies"].items():
            print("{} forward trades={} open={} +{}".format(
                strategy_id, entry["summary"]["trades"], entry["open_positions"],
                sum(n for (s, _), n in added.items() if s == strategy_id)), flush=True)
        if not args.loop_seconds:
            return
        time.sleep(args.loop_seconds)


if __name__ == "__main__":
    main()
