"""Funding for Kronos' trades, as a correction written *next to* the experiment, never inside it.

``kronos.sqlite`` is append-only evidence: ``trade.payload`` was settled with taker fees but no funding, and it stays
that way. This module opens that file read-only, computes for every trade whose whole holding time is covered by
the stored funding periods the funding and the net it implies (the same ``futures_funding_reconcile`` accounting the
forward measurement uses: unknown funding is never zero, a hole means no row) and writes them to a separate
``kronos-funding.sqlite``. The summary it writes (``kronos-funding-summary.json``) is also separate; ``kronos-summary.json``
and the running lab are untouched.

    PYTHONPATH=python python3 -m kronos_lab.funding --out server/data/kronos --market-db <futures-market.sqlite>
"""

import argparse
import json
import os
import sqlite3
import time

from balancita_engine.futures_funding_context import funding_for, funding_periods
from balancita_engine.futures_funding_reconcile import METHOD_VERSION, reconcile_trade
from balancita_engine.futures_strategy_reliability import summarize_trades

NOTIONAL_USD = "100"  # lab.NOTIONAL, fixed per trade (ADR 0001)
SCHEMA = """
CREATE TABLE IF NOT EXISTS trade_funding(
  product_id TEXT NOT NULL, decision_ms INTEGER NOT NULL, method_version TEXT NOT NULL, funding_usd REAL NOT NULL,
  pnl_usd REAL NOT NULL, net_bp REAL NOT NULL, periods_sha256 TEXT NOT NULL, held_ms INTEGER NOT NULL,
  computed_ms INTEGER NOT NULL, PRIMARY KEY(product_id, decision_ms, method_version)) STRICT;
CREATE TRIGGER IF NOT EXISTS trade_funding_no_update BEFORE UPDATE ON trade_funding
  BEGIN SELECT RAISE(ABORT, 'funding corrections are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trade_funding_no_delete BEFORE DELETE ON trade_funding
  BEGIN SELECT RAISE(ABORT, 'funding corrections are append-only'); END;
"""


def read_trades(kronos_db_path):
    """Every stored trade (read-only connection) with its segment and whether it was held through an interruption."""
    db = sqlite3.connect("file:{}?mode=ro".format(kronos_db_path), uri=True)
    try:
        rows = db.execute("SELECT product_id, decision_ms, mode, payload FROM trade ORDER BY decision_ms, product_id").fetchall()
        segments = db.execute("SELECT start_ms, kind FROM segment ORDER BY start_ms").fetchall() \
            if _has(db, "segment") else []
        gaps = db.execute("SELECT from_ms, to_ms FROM interruption").fetchall() if _has(db, "interruption") else []
    finally:
        db.close()
    trades = []
    for product_id, decision_ms, mode, payload in rows:
        trade = json.loads(payload)
        kinds = [kind for start, kind in segments if start <= decision_ms]
        trade.update(
            product_id=product_id, decision_ms=decision_ms, mode=mode, segment=kinds[-1] if kinds else "unknown",
            # a position whose holding time overlaps a recorded interruption (decided before it, settled after)
            crosses_interruption=any(a < trade["exit_time_ms"] and trade["entry_time_ms"] < b for a, b in gaps),
            notional_usd=NOTIONAL_USD, funding_usd=None, funding_complete=False)
        trades.append(trade)
    return trades


def _has(db, table):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def reconcile(trades, funding_db, periods_by_product, now_ms=None):
    """Adds a correction row for each trade not yet corrected whose holding time the periods cover; returns how many."""
    funding_db.executescript(SCHEMA)
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    done = {(p, d) for p, d in funding_db.execute(
        "SELECT product_id, decision_ms FROM trade_funding WHERE method_version=?", (METHOD_VERSION,))}
    added = 0
    for trade in trades:
        if (trade["product_id"], trade["decision_ms"]) in done:
            continue
        result = reconcile_trade(trade, periods_by_product.get(trade["product_id"], []))
        if result is None:
            continue
        with funding_db:
            added += funding_db.execute(
                "INSERT OR IGNORE INTO trade_funding VALUES(?,?,?,?,?,?,?,?,?)",
                (trade["product_id"], trade["decision_ms"], METHOD_VERSION, result["funding_usd"], result["pnl_usd"],
                 result["net_bp"], result["periods_sha256"], result["held_ms"], now_ms)).rowcount
    return added


def corrected(trades, funding_db):
    """The trades with the verified funding applied where a correction exists; the rest keep the stored, funding-free net."""
    rows = {(p, d): (f, u, n) for p, d, f, u, n in funding_db.execute(
        "SELECT product_id, decision_ms, funding_usd, pnl_usd, net_bp FROM trade_funding WHERE method_version=?",
        (METHOD_VERSION,))}
    out = []
    for trade in trades:
        row = rows.get((trade["product_id"], trade["decision_ms"]))
        item = dict(trade, net_bp_before=trade["net_bp"], pnl_usd_before=trade["pnl_usd"])
        if row is not None:
            item.update(funding_usd=row[0], pnl_usd=row[1], net_bp=row[2], funding_complete=True)
        out.append(item)
    return out


def _gated(stats):
    """No verdict is definitive while any trade of the group lacks verified funding: the raw one is kept apart."""
    if stats["net_is_definitive"]:
        return dict(stats, verdict_definitive=True)
    return dict(stats, verdict_definitive=False, verdict_raw=stats["verdict"], verdict="provisional_funding_pending")


def _group(trades):
    """One group, three views: the stored funding-free net (before), the verified-funding trades alone, and the mix."""
    verified = [t for t in trades if t["funding_complete"]]
    before = [dict(t, net_bp=t["net_bp_before"], pnl_usd=t["pnl_usd_before"], funding_complete=False) for t in trades]
    return {
        "before_funding": _gated(summarize_trades(before)),                  # the stored nets, as Kronos wrote them
        "after_funding_all": _gated(summarize_trades(trades)),               # verified funding where it exists, else stored
        "funding_verified_only": _gated(summarize_trades(verified)),         # only trades whose funding is verified
        "trades": len(trades), "funding_verified": len(verified), "funding_pending": len(trades) - len(verified),
        "pending_keys": [[t["product_id"], t["decision_ms"]] for t in trades if not t["funding_complete"]],
        "mean_funding_bp_verified": round(sum(t["net_bp"] - t["net_bp_before"] for t in verified) / len(verified), 3)
        if verified else None}


def summarize(trades):
    """Forward evidence only (backtest rows are contaminated). Positions held through a recorded interruption are a
    group of their own, and the totals are given with and without them."""
    forward = [t for t in trades if t["mode"] == "forward"]
    crossing = [t for t in forward if t["crosses_interruption"]]
    return {
        "method_version": METHOD_VERSION,
        "forward_all": _group(forward),
        "forward_without_interruption_crossers": _group([t for t in forward if not t["crosses_interruption"]]),
        "interruption_crossers": _group(crossing),
        "backtest_note": "mode=backtest rows are contaminated and are not summarised here",
    }


def write_json_atomic(path, body):
    """Writes the whole file or leaves the previous one: temp file in the same folder, fsync, then rename."""
    temp = "{}.tmp-{}".format(path, os.getpid())
    try:
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(body, handle, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except BaseException:
        if os.path.exists(temp):
            os.unlink(temp)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description="Write Kronos' funding corrections next to, not into, kronos.sqlite.")
    parser.add_argument("--out", required=True, help="the Kronos output directory (kronos.sqlite is opened read-only)")
    parser.add_argument("--write-dir", default=None,
                        help="where kronos-funding.sqlite and kronos-funding-summary.json go; default: --out. "
                             "Use a separate folder to leave the live Kronos directory without a single new file")
    parser.add_argument("--market-db", required=True, help="market DB holding the stored Kraken funding periods")
    parser.add_argument("--funding-db", default=None, help="default: <out>/kronos-funding.sqlite")
    args = parser.parse_args(argv)
    kronos_db = os.path.join(args.out, "kronos.sqlite")
    trades = read_trades(kronos_db)
    periods = {}
    for product_id in sorted({t["product_id"] for t in trades}):
        periods[product_id] = funding_periods(funding_for(args.market_db, product_id))
    write_dir = args.write_dir or args.out
    os.makedirs(write_dir, exist_ok=True)
    funding_db = sqlite3.connect(args.funding_db or os.path.join(write_dir, "kronos-funding.sqlite"))
    try:
        added = reconcile(trades, funding_db, periods)
        body = summarize(corrected(trades, funding_db))
    finally:
        funding_db.close()
    write_json_atomic(os.path.join(write_dir, "kronos-funding-summary.json"), dict(body, corrections_added=added))
    group = body["forward_all"]
    print("corrections added: {}; forward trades {} (verified {}, pending {}); definitive: {}".format(
        added, group["trades"], group["funding_verified"], group["funding_pending"],
        group["after_funding_all"]["verdict_definitive"]), flush=True)


if __name__ == "__main__":
    main()
