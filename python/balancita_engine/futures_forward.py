"""Forward paper measurement of strategies found by searching past data.

``config/forward-strategies.json`` registers a strategy with a start time. From then on this runner replays
it over the official candles of the market DB (``futures_replay.load_range``, indicators warmed up with the
week before the start), takes only the decisions from ``start_ms`` on, and keeps its own append-only DB of the
trades that happened after registration. Nothing in it can be fitted to: every trade was decided on candles
that closed before it, by a spec whose hash is recorded. Closed trades are never rewritten; re-running only
adds the ones that have closed since.

Holes in the capture (the process was down) are filled afterwards from Kraken's public charts API by the
capture itself, with the candle's real ``known_at``. Because the replay is a pure function of the candles, a
filled hole is simply replayed in order: entries at the close of the signal candle, stop and target against each
candle's high and low (stop first when both fall in one candle), the time stop counted from the real entry. A
trade whose entry-to-exit span contains a candle learned more than ``LATE_KNOWN_MS`` after it closed is labelled
``recovered`` (it could not have been seen live) and still counts; the summary also gives the figures without
them. See docs/strategy-reliability.md.

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

from .futures_funding_context import funding_for, funding_periods
from .futures_funding_reconcile import load_reconciled, reconcile
from .futures_products import resolve_products
from .futures_replay import load_range, replay
from .futures_spec_strategy import DEFAULT_SPEC_DIR, load_specs, spec_hash
from .futures_strategy_reliability import (
    FORWARD_SCHEMA,
    FORWARD_STRATEGIES_PATH,
    summarize_trades,
)

ONE_MINUTE_MS = 60_000
FIVE_MINUTES_MS = 300_000
# The live poll learns a candle seconds after it closes; later than this means the capture was down.
LATE_KNOWN_MS = 5 * 60_000
# What the candles decide. ``net_bp`` is left out: it also depends on the funding known when the trade was stored,
# which is completed beside the original (futures_funding_reconcile), not by a hole in the candles.
_CORE_KEYS = ("entry_price", "exit_bucket_ms", "exit_price", "exit_reason", "side")
_SCHEMA = """
CREATE TABLE IF NOT EXISTS forward_trade(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL,
  spec_hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(strategy_id, product_id, entry_bucket_ms)) STRICT;
CREATE TABLE IF NOT EXISTS forward_open(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, spec_hash TEXT NOT NULL, payload TEXT,
  PRIMARY KEY(strategy_id, product_id)) STRICT;
CREATE TABLE IF NOT EXISTS forward_recovered(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL,
  PRIMARY KEY(strategy_id, product_id, entry_bucket_ms)) STRICT;
CREATE TABLE IF NOT EXISTS forward_status(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, payload TEXT NOT NULL,
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


def effective_registration(db_path, registration, specs, candidates, now_ms):
    """What to measure now: the registered file plus every strategy switched on in the registry.

    ``candidates`` is ``futures_strategy_registry.forward_candidates`` (``None``: no registry, the file alone).
    C25-C28 trade in D's own books and are never measured here. A strategy of the registered file keeps its
    ``start_ms`` and runs unless the registry says it is not active. Any other active strategy starts when it
    was activated (a shipped one nobody ever switched on: the first time this runner saw it, written down once
    and never moved). A strategy that is switched off or deleted adds no more trades; its history stays.
    Returns ``(registration, specs)``; the inputs are not modified.
    """
    registered = dict(registration["strategies"])
    specs = dict(specs)
    if candidates is None:
        return registration, specs
    for strategy_id in list(registered):
        if strategy_id in candidates and candidates[strategy_id]["state"] != "active":
            del registered[strategy_id]
    db = sqlite3.connect(db_path)
    try:
        db.executescript("CREATE TABLE IF NOT EXISTS forward_first_seen("
                         "strategy_id TEXT NOT NULL, spec_hash TEXT NOT NULL, seen_ms INTEGER NOT NULL, "
                         "PRIMARY KEY(strategy_id, spec_hash)) STRICT;")
        for strategy_id, info in candidates.items():
            if info["state"] != "active" or strategy_id in registered:
                continue
            spec = info["spec"]
            start = info["active_since_ms"] or 0
            if start <= 0:
                digest = spec_hash(spec)
                with db:
                    db.execute("INSERT OR IGNORE INTO forward_first_seen VALUES(?,?,?)",
                               (strategy_id, digest, now_ms))
                start = db.execute("SELECT seen_ms FROM forward_first_seen WHERE strategy_id=? AND spec_hash=?",
                                   (strategy_id, digest)).fetchone()[0]
            registered[strategy_id] = {"start_ms": start, "registered": "registry",
                                       "why": "active in the strategy registry"}
            specs[strategy_id] = spec
    finally:
        db.close()
    return dict(registration, strategies=registered), specs


def candle_coverage(ones, fives, start_ms, end_ms):
    """Candles learned late and 1m buckets still missing between ``start_ms`` and ``end_ms``.

    Returns ``(late_ones, late_fives, missing_ones)`` where the first two are sets of bucket starts whose first
    known revision arrived more than ``LATE_KNOWN_MS`` after the bucket closed, and ``missing_ones`` counts the
    1m buckets absent from the first stored candle of the range to ``end_ms`` (holes the capture left).
    """
    late_ones = {c["bucket_start"] for c in ones if c["known_at"] - c["close_at"] > LATE_KNOWN_MS}
    late_fives = {c["bucket_start"] for c in fives if c["known_at"] - c["close_at"] > LATE_KNOWN_MS}
    inside = [c["bucket_start"] for c in ones if c["bucket_start"] >= start_ms]
    missing = 0
    if inside:
        last = min(max(inside), (end_ms // ONE_MINUTE_MS) * ONE_MINUTE_MS)
        missing = max(0, (last - inside[0]) // ONE_MINUTE_MS + 1 - len(inside))
    return late_ones, late_fives, missing


def is_recovered(trade, late_ones, late_fives):
    """True when a candle between the signal candle and the exit candle was learned late (a capture hole)."""
    first, last = trade["entry_bucket_ms"], trade["exit_bucket_ms"]
    if any(first <= bucket <= last for bucket in late_ones):
        return True
    return any(first - FIVE_MINUTES_MS < bucket <= last for bucket in late_fives)


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
                context = funding_for(market_db, product_id)
                (book,) = replay([spec], ones, fives, start_ms=info["start_ms"], product_id=product_id,
                                 tick_size=tick_size, funding=context, funding_periods=funding_periods(context))
                late_ones, late_fives, missing = candle_coverage(ones, fives, info["start_ms"], now)
                recovered = {t["entry_bucket_ms"] for t in book.trades if is_recovered(t, late_ones, late_fives)}
                with db:
                    added[(strategy_id, product_id)] = 0
                    stored = {bucket: json.loads(payload) for bucket, payload in db.execute(
                        "SELECT entry_bucket_ms, payload FROM forward_trade WHERE strategy_id=? AND product_id=? "
                        "AND spec_hash=? AND entry_bucket_ms>=?", (strategy_id, product_id, digest, info["start_ms"]))}
                    by_entry = {t["entry_bucket_ms"]: t for t in book.trades}
                    for trade in book.trades:
                        cursor = db.execute(
                            "INSERT OR IGNORE INTO forward_trade VALUES(?,?,?,?,?)",
                            (strategy_id, product_id, trade["entry_bucket_ms"], digest, json.dumps(trade)))
                        added[(strategy_id, product_id)] += cursor.rowcount
                    # Trades stored earlier that the candles now on disk no longer reproduce (they were computed
                    # across a hole): never rewritten, only counted, so ``--rebuild`` can recompute them.
                    diverged = sum(1 for bucket, old in stored.items() if bucket not in by_entry or any(
                        old.get(key) != by_entry[bucket].get(key) for key in _CORE_KEYS))
                    db.execute("DELETE FROM forward_recovered WHERE strategy_id=? AND product_id=?",
                               (strategy_id, product_id))
                    db.executemany("INSERT INTO forward_recovered VALUES(?,?,?)",
                                   [(strategy_id, product_id, bucket) for bucket in sorted(recovered)])
                    db.execute("INSERT OR REPLACE INTO forward_status VALUES(?,?,?)", (
                        strategy_id, product_id, json.dumps({
                            "checked_ms": now, "missing_1m": missing, "late_1m": len(late_ones),
                            "diverged_trades": diverged})))
                    position = None if book.position is None else {
                        key: str(book.position[key]) for key in ("side", "entry", "stop", "target", "opened_at")}
                    db.execute("INSERT OR REPLACE INTO forward_open VALUES(?,?,?,?)",
                               (strategy_id, product_id, digest, json.dumps(position)))
                # Trades stored while the funding history did not reach them are completed beside the original.
                reconcile(db, strategy_id, product_id, digest, funding_periods(context))
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
            recovered = {(product, bucket) for product, bucket in db.execute(
                "SELECT product_id, entry_bucket_ms FROM forward_recovered WHERE strategy_id=?", (strategy_id,))}
            trades = [dict(json.loads(payload), product_id=product) for product, payload in rows]
            reconciled = load_reconciled(db, strategy_id)
            for trade in trades:
                trade["recovered"] = (trade["product_id"], trade["entry_bucket_ms"]) in recovered
                row = reconciled.get((trade["product_id"], trade["entry_bucket_ms"]))
                if row is not None and not trade.get("funding_complete"):
                    trade.update(funding_usd=row["funding_usd"], funding_complete=True, funding_status="complete",
                                 pnl_usd=row["pnl_usd"], net_bp=row["net_bp"], funding_source=row["method_version"])
            live_only = [t for t in trades if not t["recovered"]]
            statuses = [json.loads(payload) for (payload,) in db.execute(
                "SELECT payload FROM forward_status WHERE strategy_id=?", (strategy_id,))]
            open_positions = sum(1 for (payload,) in db.execute(
                "SELECT payload FROM forward_open WHERE strategy_id=? AND spec_hash=?", (strategy_id, digest))
                if json.loads(payload) is not None)
            by_product = {}
            for trade in trades:
                by_product.setdefault(trade["product_id"], []).append(trade)
            strategies[strategy_id] = {
                "spec_hash": digest, "start_ms": info["start_ms"], "open_positions": open_positions,
                "summary": summarize_trades(trades, first_ms=info["start_ms"], last_ms=max(now, info["start_ms"] + 1)),
                "recovered_trades": len(trades) - len(live_only),
                "summary_without_recovered": summarize_trades(
                    live_only, first_ms=info["start_ms"], last_ms=max(now, info["start_ms"] + 1)),
                "missing_candles_1m": sum(st["missing_1m"] for st in statuses),
                "diverged_trades": sum(st["diverged_trades"] for st in statuses),
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
    parser.add_argument("--strategies-db", help="the strategy registry (read-only): every strategy active there "
                                                "is measured too, from the moment it was switched on")
    parser.add_argument("--rebuild", action="store_true",
                        help="keep the current forward.sqlite aside and recompute every trade from the candles "
                             "now on disk (after a hole was filled)")
    parser.add_argument("--loop-seconds", type=float, default=0, help="repeat every N seconds (0: once)")
    args = parser.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    if args.rebuild:
        current = os.path.join(args.out, "forward.sqlite")
        if os.path.exists(current):
            os.rename(current, "{}.before-rebuild-{}".format(current, int(time.time())))
    specs = load_specs(args.specs_dir)
    registration = load_registration(args.registration)
    products = resolve_products()
    base_specs, base_registration = specs, registration
    while True:
        db_path = os.path.join(args.out, "forward.sqlite")
        if args.strategies_db:
            from .futures_strategy_registry import forward_candidates
            registration, specs = effective_registration(
                db_path, base_registration, base_specs, forward_candidates(args.strategies_db),
                int(time.time() * 1000))
        added = run_forward(args.market_db, db_path, specs, registration, products)
        body = write_summary(os.path.join(args.out, "forward.sqlite"), specs, registration,
                             os.path.join(args.out, "forward-reliability.json"))
        for strategy_id, entry in body["strategies"].items():
            print("{} forward trades={} (recovered {}) open={} +{} missing 1m={} diverged={}".format(
                strategy_id, entry["summary"]["trades"], entry["recovered_trades"], entry["open_positions"],
                sum(n for (s, _), n in added.items() if s == strategy_id), entry["missing_candles_1m"],
                entry["diverged_trades"]), flush=True)
        if not args.loop_seconds:
            return
        time.sleep(args.loop_seconds)


if __name__ == "__main__":
    main()
