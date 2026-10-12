"""Versioned, auditable funding reconciliation for the forward measurement.

``forward_trade`` is append-only: a trade stored while the funding history did not cover its holding time keeps its
original payload (``funding_complete = false``) for ever. This module adds *next to it* a row in
``forward_trade_funding`` once the funding periods on disk cover the whole holding time, with the funding, the net it
implies and a hash of the periods used. It never edits the original and never writes a number it cannot verify:
a trade whose holding time is not fully covered gets no row and stays incomplete.
"""

import hashlib
import json
import sqlite3
import time
from decimal import Decimal

from .futures_simulator import accrue_funding

METHOD_VERSION = "funding-reconcile.v1"
SCHEMA = """
CREATE TABLE IF NOT EXISTS forward_trade_funding(
  strategy_id TEXT NOT NULL, product_id TEXT NOT NULL, entry_bucket_ms INTEGER NOT NULL,
  method_version TEXT NOT NULL, funding_usd REAL NOT NULL, pnl_usd REAL NOT NULL, net_bp REAL NOT NULL,
  periods_sha256 TEXT NOT NULL, held_ms INTEGER NOT NULL, computed_ms INTEGER NOT NULL,
  PRIMARY KEY(strategy_id, product_id, entry_bucket_ms, method_version)) STRICT;
CREATE TRIGGER IF NOT EXISTS forward_trade_funding_no_update BEFORE UPDATE ON forward_trade_funding
  BEGIN SELECT RAISE(ABORT, 'funding reconciliations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS forward_trade_funding_no_delete BEFORE DELETE ON forward_trade_funding
  BEGIN SELECT RAISE(ABORT, 'funding reconciliations are append-only'); END;
"""


def reconcile_trade(trade, periods):
    """``None`` unless the periods cover the trade's whole holding time; else the funding and the net it implies.

    The net is the stored one corrected for the funding it contained (0 for trades stored before the books were
    given periods) and the funding now verified.
    """
    start, end = int(trade["entry_time_ms"]), int(trade["exit_time_ms"])
    notional = Decimal(str(trade["notional_usd"]))
    total, covered = accrue_funding(periods, start, end, notional)
    if end <= start or covered < end - start:
        return None
    funding = total if trade["side"] == "LONG" else -total
    included = Decimal(str(trade.get("funding_usd") or 0))
    pnl = Decimal(str(trade["pnl_usd"])) + included - funding
    used = sorted((left, right, str(rate)) for left, right, rate in periods if min(end, right) > max(start, left))
    return {"funding_usd": float(round(funding, 6)), "pnl_usd": float(round(pnl, 4)),
            "net_bp": float(round(pnl / notional * 10_000, 4)), "held_ms": end - start,
            "periods_sha256": hashlib.sha256(json.dumps(used).encode()).hexdigest()}


def reconcile(db, strategy_id, product_id, digest, periods, now_ms=None):
    """Adds the reconciliation of every stored trade of this spec that is still incomplete and is now verifiable.

    ``db`` is an open connection to ``forward.sqlite``. Idempotent: a trade already reconciled under this method
    version is skipped. Returns the number of rows added.
    """
    db.executescript(SCHEMA)
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    added = 0
    rows = db.execute(
        "SELECT t.entry_bucket_ms, t.payload FROM forward_trade t WHERE t.strategy_id=? AND t.product_id=? AND t.spec_hash=? "
        "AND NOT EXISTS (SELECT 1 FROM forward_trade_funding f WHERE f.strategy_id=t.strategy_id AND f.product_id=t.product_id "
        "AND f.entry_bucket_ms=t.entry_bucket_ms AND f.method_version=?)",
        (strategy_id, product_id, digest, METHOD_VERSION)).fetchall()
    for bucket, payload in rows:
        trade = json.loads(payload)
        if trade.get("funding_complete") is True:
            continue
        result = reconcile_trade(trade, periods)
        if result is None:
            continue
        with db:
            added += db.execute(
                "INSERT OR IGNORE INTO forward_trade_funding VALUES(?,?,?,?,?,?,?,?,?,?)",
                (strategy_id, product_id, bucket, METHOD_VERSION, result["funding_usd"], result["pnl_usd"],
                 result["net_bp"], result["periods_sha256"], result["held_ms"], now_ms)).rowcount
    return added


def load_reconciled(db, strategy_id):
    """``{(product_id, entry_bucket_ms): row}`` of the reconciliations on file (empty when the table is absent)."""
    try:
        rows = db.execute(
            "SELECT product_id, entry_bucket_ms, funding_usd, pnl_usd, net_bp, method_version, periods_sha256 "
            "FROM forward_trade_funding WHERE strategy_id=? ORDER BY method_version", (strategy_id,)).fetchall()
    except sqlite3.OperationalError:
        return {}
    return {(p, b): {"funding_usd": f, "pnl_usd": u, "net_bp": n, "method_version": m, "periods_sha256": h}
            for p, b, f, u, n, m, h in rows}
