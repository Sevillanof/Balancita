"""Kronos-small as one more, fully independent paper strategy.

Rule, fixed before looking at any result: at each closed hour, show Kronos the last 400 1h candles, sample its
next ``HORIZON`` hours ``samples`` times, and take the mean predicted ln-return. If it exceeds ``K`` times the
product's round-trip cost, go long (short if below minus that) with 100 USD at the next open, and exit at the
close of the ``HORIZON``-th hour. One position per product at a time, taker fills with the shared cost model
(``futures_costs``, no funding yet). Results go to its own SQLite and are summarised with the same reliability
figures as every other strategy, but are not fed into the registry, the forward table or Qwen.

Warning: Kronos was pre-trained on exchange history that includes this period, so ``mode=backtest`` rows are
contaminated and only show plumbing. Only ``mode=forward`` rows (hours that closed after the run started) count.
"""

import argparse
import json
import math
import os
import sqlite3
import statistics
import time
from decimal import Decimal

from balancita_engine.futures_costs import entry_fill, exit_fill, fee_rate, round_trip_cost_bps
from balancita_engine.futures_products import resolve_products
from balancita_engine.futures_replay import load_range
from balancita_engine.futures_strategy_reliability import summarize_trades

HOUR_MS = 3_600_000
HORIZON = 4          # hours held
K = 2.0              # required |expected move| as a multiple of the round-trip cost
MIN_CONTEXT = 200    # hours of history required before predicting
NOTIONAL = Decimal(100)
STRATEGY_ID = "kronos-small-1h-h4-v1"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS decision(
  product_id TEXT NOT NULL, decision_ms INTEGER NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL,
  expected_bp REAL NOT NULL, threshold_bp REAL NOT NULL, side TEXT, PRIMARY KEY(product_id, decision_ms)) STRICT;
CREATE TABLE IF NOT EXISTS trade(
  product_id TEXT NOT NULL, decision_ms INTEGER NOT NULL, mode TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(product_id, decision_ms)) STRICT;
CREATE TRIGGER IF NOT EXISTS decision_no_update BEFORE UPDATE ON decision BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS trade_no_update BEFORE UPDATE ON trade BEGIN SELECT RAISE(ABORT, 'append-only'); END;
"""


def hourly(candles_1m):
    """Complete, aligned 1h candles from 1m candles (an hour with a missing minute is dropped)."""
    hours = {}
    for c in candles_1m:
        hours.setdefault(c["bucket_start"] - c["bucket_start"] % HOUR_MS, []).append(c)
    out = []
    for start in sorted(hours):
        group = hours[start]
        if len(group) != 60:
            continue
        out.append({
            "bucket_start": start, "open": group[0]["open"], "close": group[-1]["close"],
            "high": max(float(c["high"]) for c in group), "low": min(float(c["low"]) for c in group),
            "volume_btc": sum(float(c["volume_btc"]) for c in group)})
    return out


def settle(product_id, side, candles, index):
    """Trade entered at the open of ``candles[index]`` and exited at the close of ``candles[index+HORIZON-1]``."""
    entry_c, exit_c = candles[index], candles[index + HORIZON - 1]
    sign = 1 if side == "LONG" else -1
    entry = entry_fill(Decimal(str(entry_c["open"])), side, product_id)
    leave = exit_fill(Decimal(str(exit_c["close"])), side, product_id)
    gross_bp = sign * (leave - entry) / entry * 10_000
    net_bp = gross_bp - (fee_rate("taker") * 2) * 10_000
    return {"side": side, "entry_time_ms": entry_c["bucket_start"], "entry_bucket_ms": entry_c["bucket_start"],
            "exit_time_ms": exit_c["bucket_start"] + HOUR_MS, "entry": str(entry), "exit": str(leave),
            "net_bp": float(round(net_bp, 4)), "pnl_usd": float(round(NOTIONAL * net_bp / 10_000, 4))}


def run_product(db, predictor, product_id, candles, *, mode, first_decision_ms, stride=1):
    """Decides at every closed hour from ``first_decision_ms`` and settles each trade once its exit hour has closed."""
    threshold = float(round_trip_cost_bps(product_id)) * K
    busy_until, added = 0, 0
    for i in range(MIN_CONTEXT, len(candles)):
        decision_ms = candles[i - 1]["bucket_start"] + HOUR_MS  # candle i-1 just closed
        if decision_ms < first_decision_ms or decision_ms < busy_until or (i % stride):
            continue
        if db.execute("SELECT 1 FROM decision WHERE product_id=? AND decision_ms=?", (product_id, decision_ms)).fetchone():
            if db.execute("SELECT side FROM decision WHERE product_id=? AND decision_ms=?",
                          (product_id, decision_ms)).fetchone()[0]:
                busy_until = decision_ms + HORIZON * HOUR_MS
            continue
        expected_bp = predictor.expected_log_return(candles[:i], HORIZON) * 10_000
        side = "LONG" if expected_bp > threshold else "SHORT" if expected_bp < -threshold else None
        with db:
            db.execute("INSERT INTO decision VALUES(?,?,?,?,?,?,?)", (
                product_id, decision_ms, mode, getattr(predictor, "name", "?"), expected_bp, threshold, side))
        if side:
            busy_until = decision_ms + HORIZON * HOUR_MS
    # Settle every traded decision whose exit hour is now in the data (trades are inserted once, never rewritten).
    for decision_ms, side, trade_mode in db.execute(
            "SELECT decision_ms, side, mode FROM decision WHERE product_id=? AND side IS NOT NULL", (product_id,)).fetchall():
        index = next((j for j, c in enumerate(candles) if c["bucket_start"] == decision_ms), None)
        if index is None or index + HORIZON > len(candles):
            continue
        with db:
            added += db.execute("INSERT OR IGNORE INTO trade VALUES(?,?,?,?)", (
                product_id, decision_ms, trade_mode, json.dumps(settle(product_id, side, candles, index)))).rowcount
    return added


def summary(db_path):
    db = sqlite3.connect(db_path)
    try:
        out = {}
        for mode in ("forward", "backtest"):
            rows = db.execute("SELECT product_id, payload FROM trade WHERE mode=?", (mode,)).fetchall()
            trades = [dict(json.loads(p), product_id=pid) for pid, p in rows]
            out[mode] = {"all": summarize_trades(trades), "by_product": {}}
            for pid in sorted({t["product_id"] for t in trades}):
                part = [t for t in trades if t["product_id"] == pid]
                s = summarize_trades(part)
                out[mode]["by_product"][pid] = {k: s[k] for k in ("trades", "hit_rate", "mean_net_bp", "pnl_usd")}
            # Gross direction accuracy of all decisions (traded or not) is not stored: only traded ones are scored.
        out["decisions"] = db.execute("SELECT mode, COUNT(*), SUM(side IS NOT NULL) FROM decision GROUP BY mode").fetchall()
        return out
    finally:
        db.close()


def main(argv=None, predictor=None):
    parser = argparse.ArgumentParser(description="Run the isolated Kronos-small strategy on the market DB candles.")
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--out", required=True, help="directory for kronos.sqlite and kronos-summary.json")
    parser.add_argument("--mode", choices=("forward", "backtest"), default="forward")
    parser.add_argument("--days", type=float, default=30, help="backtest: how many past days to decide over")
    parser.add_argument("--stride", type=int, default=4, help="backtest: decide every N hours")
    parser.add_argument("--samples", type=int, default=8)
    parser.add_argument("--kronos-repo", default=None)
    parser.add_argument("--loop-seconds", type=float, default=0, help="forward: repeat every N seconds")
    args = parser.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    db_path = os.path.join(args.out, "kronos.sqlite")
    if predictor is None:
        from .predictor import KronosSmall
        predictor = KronosSmall(repo=args.kronos_repo, samples=args.samples)
    start_file = os.path.join(args.out, "forward-start-ms")
    while True:
        now = int(time.time() * 1000)
        if args.mode == "forward":
            if not os.path.exists(start_file):  # the registration moment: later hours are real out-of-sample
                with open(start_file, "w", encoding="utf-8") as handle:
                    handle.write(str(now))
            with open(start_file, encoding="utf-8") as handle:
                first = int(handle.read())
        else:
            first = now - int(args.days * 86_400_000)
        db = sqlite3.connect(db_path)
        db.executescript(_SCHEMA)
        try:
            for product_id, _tick in resolve_products():
                try:
                    ones, _fives = load_range(args.market_db, product_id, first - MIN_CONTEXT * HOUR_MS, now)
                except ValueError:
                    continue
                added = run_product(db, predictor, product_id, hourly(ones), mode=args.mode,
                                    first_decision_ms=first, stride=args.stride if args.mode == "backtest" else 1)
                print("{} +{} trades".format(product_id, added), flush=True)
        finally:
            db.close()
        body = summary(db_path)
        with open(os.path.join(args.out, "kronos-summary.json"), "w", encoding="utf-8") as handle:
            json.dump({"strategy_id": STRATEGY_ID, "horizon_h": HORIZON, "k": K, **body}, handle, indent=2, sort_keys=True)
        print(json.dumps(body[args.mode]["all"]), flush=True)
        if not args.loop_seconds or args.mode != "forward":
            return
        time.sleep(args.loop_seconds)


if __name__ == "__main__":
    main()
