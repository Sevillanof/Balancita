"""Metadata-only inventory of the local Kraken capture (Issue #183, P1 of BAL-DECISION-183-01).

Per table and product, only COUNT / MIN / MAX over temporal columns. It reads no price, rate, OHLC, volume or
``raw_*`` column. Every query carries the holdout cut (``< HOLDOUT_START_MS``) inside its own SQL, so rows from the
holdout are never aggregated, counted or returned. The database is opened read-only and the path is never printed.

Counts and extremes do not prove continuity or quality; the derived hourly/bucket gap counts are arithmetic over
those aggregates and assume the grid the table is supposed to follow.

Usage (stdlib only; Python 3.9 is enough):
    python3 -m balancita_engine.capture_inventory --db <capture.sqlite> [--quotes-db <quote-archive.sqlite>]
"""
import argparse
import json
import os
import re
import sqlite3
import sys

from .capture_validation import ALLOWED_PRODUCTS, HOLDOUT_START_MS, VALIDATOR_VERSION

INVENTORY_VERSION = "capture-inventory.v1"
HOUR_MS = 3_600_000
CANDLE_INTERVALS = (60_000, 300_000)

_PRODUCTS = sorted(ALLOWED_PRODUCTS)
if not all(re.fullmatch(r"PF_[A-Z]+USD", p) for p in _PRODUCTS):  # inlined into SQL below
    raise RuntimeError("unexpected product id")
_IN = ",".join("'%s'" % p for p in _PRODUCTS)
_H = int(HOLDOUT_START_MS)
_INT = ",".join(str(i) for i in CANDLE_INTERVALS)
_CANDLE_PRODUCT = "substr(candle_id, 1, instr(candle_id, ':') - 1)"

# name -> (database, columns, sql). Columns are only identifiers, counts and timestamps.
QUERIES = {
    "funding_periods": (
        "main",
        ("product_id", "rows", "distinct_starts", "min_start_ms", "max_start_ms", "min_end_ms", "max_end_ms",
         "min_known_at", "max_known_at", "starts_off_hour_grid"),
        "SELECT product_id, COUNT(*), COUNT(DISTINCT start_ms), MIN(start_ms), MAX(start_ms), MIN(end_ms), "
        "MAX(end_ms), MIN(known_at), MAX(known_at), SUM(start_ms %% %d <> 0) "
        "FROM paper_futures_funding_periods "
        "WHERE product_id IN (%s) AND start_ms < %d AND end_ms < %d AND known_at < %d "
        "GROUP BY product_id ORDER BY product_id" % (HOUR_MS, _IN, _H, _H, _H),
    ),
    "funding_responses": (
        "main",
        ("product_id", "responses", "min_received_at", "max_received_at"),
        "SELECT p.product_id, COUNT(DISTINCT r.sha256), MIN(r.received_at), MAX(r.received_at) "
        "FROM paper_futures_funding_periods p JOIN paper_futures_funding_responses r ON r.sha256 = p.response_sha256 "
        "WHERE p.product_id IN (%s) AND p.start_ms < %d AND p.end_ms < %d AND p.known_at < %d AND r.received_at < %d "
        "GROUP BY p.product_id ORDER BY p.product_id" % (_IN, _H, _H, _H, _H),
    ),
    "official_candles": (
        "main",
        ("product_id", "interval_ms", "rows", "distinct_buckets", "min_bucket_start", "max_bucket_start",
         "min_known_at", "max_known_at"),
        "SELECT product_id, interval_ms, COUNT(*), COUNT(DISTINCT bucket_start), MIN(bucket_start), "
        "MAX(bucket_start), MIN(known_at), MAX(known_at) FROM paper_futures_official_candles "
        "WHERE product_id IN (%s) AND interval_ms IN (%s) AND bucket_start < %d AND known_at < %d "
        "GROUP BY product_id, interval_ms ORDER BY product_id, interval_ms" % (_IN, _INT, _H, _H),
    ),
    "official_candle_responses": (
        "main",
        ("product_id", "interval_ms", "responses", "min_from_ms", "max_to_ms", "min_received_at",
         "max_received_at"),
        "SELECT product_id, interval_ms, COUNT(*), MIN(from_ms), MAX(to_ms), MIN(received_at), MAX(received_at) "
        "FROM paper_futures_official_candle_responses "
        "WHERE product_id IN (%s) AND interval_ms IN (%s) AND from_ms < %d AND to_ms < %d AND received_at < %d "
        "GROUP BY product_id, interval_ms ORDER BY product_id, interval_ms" % (_IN, _INT, _H, _H, _H),
    ),
    "capture_candles": (
        "main",
        ("product_id", "interval_ms", "rows", "distinct_buckets", "min_bucket_start", "max_bucket_start",
         "min_known_at", "max_known_at"),
        "SELECT %s, interval_ms, COUNT(*), COUNT(DISTINCT bucket_start), MIN(bucket_start), MAX(bucket_start), "
        "MIN(known_at), MAX(known_at) FROM paper_futures_candle_revisions "
        "WHERE %s IN (%s) AND interval_ms IN (%s) AND bucket_start < %d AND known_at < %d "
        "GROUP BY %s, interval_ms ORDER BY %s, interval_ms"
        % (_CANDLE_PRODUCT, _CANDLE_PRODUCT, _IN, _INT, _H, _H, _CANDLE_PRODUCT, _CANDLE_PRODUCT),
    ),
    "ticker_events": (
        "main",
        ("product_id", "rows", "min_received_at", "max_received_at", "min_event_time", "max_event_time"),
        "SELECT product_id, COUNT(*), MIN(received_at), MAX(received_at), MIN(event_time), MAX(event_time) "
        "FROM paper_futures_market_events "
        "WHERE feed = 'ticker' AND product_id IN (%s) AND received_at < %d AND event_time < %d "
        "GROUP BY product_id ORDER BY product_id" % (_IN, _H, _H),
    ),
    "quote_snapshot": (
        "quotes",
        ("product_id", "rows", "min_received_at", "max_received_at"),
        "SELECT product_id, COUNT(*), MIN(received_at), MAX(received_at) FROM quote_snapshot "
        "WHERE product_id IN (%s) AND received_at < %d GROUP BY product_id ORDER BY product_id" % (_IN, _H),
    ),
}


def _open_readonly(path):
    if not os.path.isfile(path):
        raise FileNotFoundError("database file not found")
    conn = sqlite3.connect("file:%s?mode=ro" % path.replace("?", "%3f").replace("#", "%23"), uri=True, timeout=2.0)
    conn.execute("PRAGMA query_only = ON")
    return conn


def _gaps(rows, columns, count_col, min_col, max_col, step_of):
    """Missing grid slots between the observed min and max (arithmetic over aggregates, not a continuity proof)."""
    out = []
    for row in rows:
        r = dict(zip(columns, row))
        step = step_of(r)
        slots = (r[max_col] - r[min_col]) // step + 1
        out.append({"product_id": r["product_id"], "span_slots": slots, "missing_slots": slots - r[count_col]})
    return out


def _derived(name, columns, rows):
    if name == "funding_periods":
        return _gaps(rows, columns, "distinct_starts", "min_start_ms", "max_start_ms", lambda r: HOUR_MS)
    if name in ("official_candles", "capture_candles"):
        derived = _gaps(rows, columns, "distinct_buckets", "min_bucket_start", "max_bucket_start",
                        lambda r: r["interval_ms"])
        for item, row in zip(derived, rows):
            item["interval_ms"] = dict(zip(columns, row))["interval_ms"]
        return derived
    return None


def build_inventory(main_db, quotes_db=None):
    """Run the fixed queries. ``main_db`` / ``quotes_db`` are sqlite3 connections (or None for the quote archive)."""
    sections = {}
    for name, (which, columns, sql) in QUERIES.items():
        conn = main_db if which == "main" else quotes_db
        if conn is None:
            sections[name] = {"unavailable": "database not provided"}
            continue
        try:
            rows = [list(r) for r in conn.execute(sql).fetchall()]
        except sqlite3.Error as exc:  # absent table/column is information, not a crash
            sections[name] = {"unavailable": "%s: %s" % (type(exc).__name__, exc)}
            continue
        section = {"columns": list(columns), "rows": rows}
        derived = _derived(name, columns, rows)
        if derived is not None:
            section["derived_gaps"] = derived
        section["products_without_rows"] = [p for p in _PRODUCTS if p not in {r[0] for r in rows}]
        sections[name] = section
    return {
        "inventory_version": INVENTORY_VERSION,
        "validator_version": VALIDATOR_VERSION,
        "holdout_start_ms": _H,
        "holdout_excluded_in_sql": True,
        "products": _PRODUCTS,
        "sections": sections,
        "note": "COUNT/MIN/MAX only. Counts and extremes do not prove continuity or quality; "
                "no prices, rates, OHLC, volumes or raw bodies were read.",
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True, help="local capture database (opened read-only)")
    ap.add_argument("--quotes-db", help="quote archive file, if it is part of the same authorized local capture")
    args = ap.parse_args(argv)
    main_db = _open_readonly(args.db)
    quotes_db = _open_readonly(args.quotes_db) if args.quotes_db else None
    try:
        inventory = build_inventory(main_db, quotes_db)
        inventory["source"] = {
            "db_name": os.path.basename(args.db),
            "db_size_bytes": os.path.getsize(args.db),
            "quotes_db_name": os.path.basename(args.quotes_db) if args.quotes_db else None,
        }
    finally:
        main_db.close()
        if quotes_db is not None:
            quotes_db.close()
    json.dump(inventory, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
