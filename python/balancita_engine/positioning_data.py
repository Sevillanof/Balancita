"""Read-only access to the positioning collector's database for strategies.

Two public Kraken Futures series, one row per closed bucket:
- positioning (hourly, from 2024-01): % of accounts long, and the same for the top 20 % by size.
- premium (perpetual mark over spot index, basis points; hourly from 2022-03, minute for the last days).

Nothing here looks ahead: a bucket is usable only from its END (bucket start + interval).
"""
import json
import sqlite3

HOUR_MS = 3600000
MINUTE_MS = 60000


def _connect(db_path):
    return sqlite3.connect("file:{}?mode=ro".format(db_path), uri=True)


def load_positioning(db_path, product_id, from_ms=0, to_ms=None):
    """Rows (bucket_ms, long_percent, top_long_percent, top_open_interest), oldest first."""
    to_ms = 2 ** 62 if to_ms is None else to_ms
    db = _connect(db_path)
    try:
        return db.execute(
            "SELECT bucket_ms, long_percent, top_long_percent, top_open_interest FROM positioning "
            "WHERE product_id=? AND bucket_ms>=? AND bucket_ms<=? ORDER BY bucket_ms",
            (product_id, from_ms, to_ms),
        ).fetchall()
    finally:
        db.close()


def load_premium(db_path, product_id, interval_ms=HOUR_MS, from_ms=0, to_ms=None):
    """Rows (bucket_ms, premium_bp), oldest first, for the hourly or the minute series."""
    if interval_ms not in (HOUR_MS, MINUTE_MS):
        raise ValueError("interval_ms must be 3600000 or 60000")
    to_ms = 2 ** 62 if to_ms is None else to_ms
    db = _connect(db_path)
    try:
        return db.execute(
            "SELECT bucket_ms, premium_bp FROM premium "
            "WHERE product_id=? AND interval_ms=? AND bucket_ms>=? AND bucket_ms<=? ORDER BY bucket_ms",
            (product_id, interval_ms, from_ms, to_ms),
        ).fetchall()
    finally:
        db.close()


def as_of(rows, at_ms, interval_ms=HOUR_MS):
    """Latest row known at `at_ms` (its bucket already closed), or None. `rows` sorted by bucket."""
    found = None
    for row in rows:
        if row[0] + interval_ms > at_ms:
            break
        found = row
    return found


def active_indicators(catalog_path):
    """Cards of config/indicators.json that are active, as dicts (id, series, resolution, products)."""
    with open(catalog_path) as handle:
        body = json.load(handle)
    return [card for card in body["indicators"] if card.get("state") == "active"]


def is_available(catalog_path, series, resolution, product_id):
    """True when an active card keeps this series for this product ("pinned" covers every product)."""
    return any(
        card["series"] == series
        and card["resolution"] == resolution
        and (card["products"] == "pinned" or product_id in card["products"])
        for card in active_indicators(catalog_path)
    )
