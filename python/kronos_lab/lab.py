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
import fcntl
import json
import math
import os
import sqlite3
import statistics
import time
import urllib.request
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
CHARTS_URL = "https://futures.kraken.com/api/charts/v1/trade/{product}/1h?from={start}&to={end}"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS decision(
  product_id TEXT NOT NULL, decision_ms INTEGER NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL,
  expected_bp REAL NOT NULL, threshold_bp REAL NOT NULL, side TEXT, PRIMARY KEY(product_id, decision_ms)) STRICT;
CREATE TABLE IF NOT EXISTS trade(
  product_id TEXT NOT NULL, decision_ms INTEGER NOT NULL, mode TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(product_id, decision_ms)) STRICT;
CREATE TABLE IF NOT EXISTS segment(
  segment_id INTEGER PRIMARY KEY AUTOINCREMENT, start_ms INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT,
  created_ms INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS interruption(
  interruption_id INTEGER PRIMARY KEY AUTOINCREMENT, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL,
  reason TEXT NOT NULL, recorded_ms INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS run_log(at_ms INTEGER PRIMARY KEY) STRICT;
CREATE TRIGGER IF NOT EXISTS segment_no_update BEFORE UPDATE ON segment BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS interruption_no_update BEFORE UPDATE ON interruption BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS decision_no_update BEFORE UPDATE ON decision BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS trade_no_update BEFORE UPDATE ON trade BEGIN SELECT RAISE(ABORT, 'append-only'); END;
"""


# A run that was down longer than this did not see every closed hour: it resumes in a new segment.
MAX_SILENCE_MS = 2 * HOUR_MS


def plan_segments(db, original_start_ms, now_ms, max_silence_ms=MAX_SILENCE_MS):
    """Keeps the experiment's original start and returns the first hour allowed to decide in the current segment.

    The first call records segment 1 at ``original_start_ms``. If the last recorded activity (the last pass, else
    the end of the last decision) is more than ``max_silence_ms`` before ``now_ms``, the silence is written as an
    interruption and a ``resume`` segment starts at the first hour boundary after ``now_ms``: no decision is ever
    made retroactively for the hours the process was not running. The earlier history is still loaded to warm the
    model up, but it produces no trades.
    """
    with db:
        if db.execute("SELECT COUNT(*) FROM segment").fetchone()[0] == 0:
            db.execute("INSERT INTO segment(start_ms, kind, note, created_ms) VALUES(?,?,?,?)",
                       (original_start_ms, "original", "registration of the experiment", now_ms))
        last_run = db.execute("SELECT MAX(at_ms) FROM run_log").fetchone()[0]
        last_decision = db.execute("SELECT MAX(decision_ms) FROM decision WHERE mode='forward'").fetchone()[0]
        last_seen = last_run if last_run is not None else (
            last_decision + HOUR_MS if last_decision is not None else None)
        current = db.execute("SELECT MAX(start_ms) FROM segment").fetchone()[0]
        if last_seen is not None and now_ms - last_seen > max_silence_ms:
            resume = (now_ms // HOUR_MS + 1) * HOUR_MS
            db.execute("INSERT INTO interruption(from_ms, to_ms, reason, recorded_ms) VALUES(?,?,?,?)",
                       (last_seen, now_ms, "process not running (no clean stop recorded)", now_ms))
            db.execute("INSERT INTO segment(start_ms, kind, note, created_ms) VALUES(?,?,?,?)",
                       (resume, "resume", "first closed hour after the restart; no retroactive decisions", now_ms))
            current = resume
        db.execute("INSERT OR IGNORE INTO run_log VALUES(?)", (now_ms,))
    return max(original_start_ms, current)


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


def _fetch_candles(url, retries=4):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                return json.load(response)["candles"]
        except Exception:  # network and rate-limit errors alike: back off and retry
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def official_hours(product_id, start_ms, now_ms, fetch=_fetch_candles):
    """Closed official 1h trade candles from Kraken's public charts API (the market DB keeps only days of 1m)."""
    out, cursor = {}, start_ms // 1000
    while cursor < now_ms // 1000:
        end = min(cursor + 1500 * 3600, now_ms // 1000)  # the API returns at most 2000 candles per call
        for c in fetch(CHARTS_URL.format(product=product_id, start=cursor, end=end)):
            if c["time"] + HOUR_MS <= now_ms:  # the current hour is still forming
                out[c["time"]] = {"bucket_start": c["time"], "open": float(c["open"]), "high": float(c["high"]),
                                  "low": float(c["low"]), "close": float(c["close"]), "volume_btc": float(c["volume"])}
        cursor = end
    return [out[k] for k in sorted(out)]


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
        if i % stride:
            continue
        existing = db.execute("SELECT side FROM decision WHERE product_id=? AND decision_ms=?",
                              (product_id, decision_ms)).fetchone()
        if existing is not None:  # decided before (even before this segment): keeps one position at a time
            if existing[0]:
                busy_until = decision_ms + HORIZON * HOUR_MS
            continue
        if decision_ms < first_decision_ms or decision_ms < busy_until:
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
        out["segments"] = [
            {"start_ms": a, "kind": k, "note": n, "forward_trades": db.execute(
                "SELECT COUNT(*) FROM trade WHERE mode='forward' AND decision_ms>=? AND decision_ms<COALESCE("
                "(SELECT MIN(start_ms) FROM segment WHERE start_ms>?), 1e18)", (a, a)).fetchone()[0]}
            for a, k, n in [(r[0], r[1], r[2]) for r in db.execute(
                "SELECT start_ms, kind, note FROM segment ORDER BY segment_id")]]
        out["interruptions"] = [{"from_ms": a, "to_ms": b, "reason": r} for a, b, r in db.execute(
            "SELECT from_ms, to_ms, reason FROM interruption ORDER BY interruption_id")]
        out["decisions"] = db.execute("SELECT mode, COUNT(*), SUM(side IS NOT NULL) FROM decision GROUP BY mode").fetchall()
        return out
    finally:
        db.close()


def main(argv=None, predictor=None):
    parser = argparse.ArgumentParser(description="Run the isolated Kronos-small strategy on the market DB candles.")
    parser.add_argument("--source", choices=("kraken", "market-db"), default="kraken",
                        help="kraken: official 1h candles from the public charts API; market-db: 1h built from 1m")
    parser.add_argument("--market-db", default=None, help="required with --source market-db")
    parser.add_argument("--out", required=True, help="directory for kronos.sqlite and kronos-summary.json")
    parser.add_argument("--mode", choices=("forward", "backtest"), default="forward")
    parser.add_argument("--days", type=float, default=30, help="backtest: how many past days to decide over")
    parser.add_argument("--stride", type=int, default=4, help="backtest: decide every N hours")
    parser.add_argument("--samples", type=int, default=8)
    parser.add_argument("--kronos-repo", default=None)
    parser.add_argument("--loop-seconds", type=float, default=0, help="forward: repeat every N seconds")
    args = parser.parse_args(argv)
    if args.source == "market-db" and not args.market_db:
        parser.error("--source market-db needs --market-db")
    os.makedirs(args.out, exist_ok=True)
    db_path = os.path.join(args.out, "kronos.sqlite")
    if predictor is None:
        from .predictor import KronosSmall
        predictor = KronosSmall(repo=args.kronos_repo, samples=args.samples)
    start_file = os.path.join(args.out, "forward-start-ms")
    lock_handle = None
    if args.mode == "forward":  # one writer at a time, however it was started (launchd, nohup, by hand)
        lock_handle = open(os.path.join(args.out, "kronos.lock"), "w")
        try:
            fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise SystemExit("another Kronos forward process holds {}; not starting".format(lock_handle.name))
    while True:
        now = int(time.time() * 1000)
        if args.mode == "forward":
            if not os.path.exists(start_file):  # the registration moment: later hours are real out-of-sample
                with open(start_file, "w", encoding="utf-8") as handle:
                    handle.write(str(now))
            with open(start_file, encoding="utf-8") as handle:
                original_start = int(handle.read())
            first = original_start  # replaced below by the current segment's start
        else:
            first = now - int(args.days * 86_400_000)
        db = sqlite3.connect(db_path)
        db.executescript(_SCHEMA)
        try:
            if args.mode == "forward":
                first = plan_segments(db, original_start, now)
                print("segment starts {}".format(first), flush=True)
            for product_id, _tick in resolve_products():
                since = first - (MIN_CONTEXT + HORIZON) * HOUR_MS
                if args.source == "kraken":
                    try:
                        candles = official_hours(product_id, since, now)
                    except Exception as error:  # one product's outage must not stop the others
                        print("{} skipped: {}".format(product_id, error), flush=True)
                        continue
                else:
                    try:
                        ones, _fives = load_range(args.market_db, product_id, since, now)
                    except ValueError:
                        continue
                    candles = hourly(ones)
                added = run_product(db, predictor, product_id, candles, mode=args.mode,
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
