"""Candle and trade timing sample of the live capture (Issue #183, follow-up of P2 level A).

Same fixed window, same two products and same guards as ``capture_timing_sample`` (read-only connection, SQLite
authorizer that denies every column not on its allow-list, COUNT(*) row budget, per-query time limit, receipt and
event time both inside the window). It only answers why the 5 m capture candles came back empty: how many candles the
capture has, and how many official candles are stored, for each interval present (which buckets are missing, how long after closing each was recorded) and how
many trade events arrived (the capture builds its candles from trades). Times and counters only: no price, volume,
size or ``raw_*`` / ``*_json`` column is read. It measures our reception, not Kraken, and does not compare values.

It reuses the guards of ``capture_timing_sample`` so there is a single allow-list to review.

Usage (stdlib only; Python 3.9 is enough):
    python3 -m balancita_engine.capture_candle_sample --db <capture.sqlite> > out.json
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys

from . import capture_timing_sample as cts

TOOL_VERSION = "capture-candle-sample.v1"
WINDOW_START_MS, WINDOW_END_MS, WINDOW, PRODUCTS = cts.WINDOW_START_MS, cts.WINDOW_END_MS, cts.WINDOW, cts.PRODUCTS
MAX_REPORTED_RUNS = 20

_W0, _W1 = WINDOW_START_MS, WINDOW_END_MS
_IN = cts._IN
_PRODUCT = cts._CANDLE_PRODUCT

SQL = {
    "candles": (
        "SELECT COUNT(*) FROM paper_futures_candle_revisions WHERE %s IN (%s) AND interval_ms > 0 "
        "AND bucket_start >= %d AND bucket_start < %d" % (_PRODUCT, _IN, _W0, _W1),
        "SELECT %s, interval_ms, bucket_start, revision, known_at, is_closed FROM paper_futures_candle_revisions "
        "WHERE %s IN (%s) AND interval_ms > 0 AND bucket_start >= %d AND bucket_start < %d "
        "ORDER BY 1, interval_ms, bucket_start, revision" % (_PRODUCT, _PRODUCT, _IN, _W0, _W1),
    ),
    "official_candles": (
        "SELECT COUNT(*) FROM paper_futures_official_candles WHERE product_id IN (%s) AND interval_ms > 0 "
        "AND bucket_start >= %d AND bucket_start < %d" % (_IN, _W0, _W1),
        "SELECT product_id, interval_ms, bucket_start, 0, known_at, 0 FROM paper_futures_official_candles "
        "WHERE product_id IN (%s) AND interval_ms > 0 AND bucket_start >= %d AND bucket_start < %d "
        "ORDER BY product_id, interval_ms, bucket_start, known_at" % (_IN, _W0, _W1),
    ),
    "trades": (
        "SELECT COUNT(*) FROM paper_futures_market_events WHERE feed = 'trade' AND product_id IN (%s) "
        "AND event_time >= %d AND event_time < %d AND received_at >= %d AND received_at < %d"
        % (_IN, _W0, _W1, _W0, _W1),
        "SELECT product_id, epoch, seq, event_time, received_at FROM paper_futures_market_events "
        "WHERE feed = 'trade' AND product_id IN (%s) AND received_at >= %d AND received_at < %d "
        "AND event_time >= %d AND event_time < %d ORDER BY product_id, received_at, seq"
        % (_IN, _W0, _W1, _W0, _W1),
    ),
}


def _missing_runs(buckets, interval):
    """Runs of consecutive missing buckets inside the window (arithmetic over the bucket starts that exist)."""
    if (_W1 - _W0) // interval < 1:
        return None
    expected_last = _W0 + ((_W1 - _W0) // interval - 1) * interval
    present = sorted(b for b in buckets if _W0 <= b <= expected_last and (b - _W0) % interval == 0)
    runs, cursor = [], _W0
    for b in present + [expected_last + interval]:
        if b > cursor:
            runs.append({"start_ms": cursor, "buckets": (b - cursor) // interval})
        cursor = b + interval
    runs.sort(key=lambda r: (-r["buckets"], r["start_ms"]))
    return {"count": len(runs), "longest": runs[:MAX_REPORTED_RUNS]}


def _candles(rows, with_closed=True):
    out = {}
    for product in PRODUCTS:
        mine = [r for r in rows if r[0] == product]
        per_interval = {}
        for interval in sorted({r[1] for r in mine}):
            part = [r for r in mine if r[1] == interval]
            buckets = {r[2] for r in part}
            expected = (_W1 - _W0) // interval
            on_grid = {b for b in buckets if _W0 <= b < _W1 and (b - _W0) % interval == 0}
            per_interval[str(interval)] = {
                "revisions": len(part),
                "distinct_buckets": len(buckets),
                "expected_buckets": expected,
                "missing_buckets": max(0, expected - len(on_grid)),
                "off_grid_buckets": len(buckets) - len(on_grid),
                **({"buckets_with_a_closed_revision": len({r[2] for r in part if r[5] == 1})} if with_closed else {}),
                "min_bucket_start": min(buckets),
                "max_bucket_start": max(buckets),
                "known_at_minus_bucket_end_ms": cts._quantiles([r[4] - (r[2] + interval) for r in part]),
                "missing_runs": _missing_runs(buckets, interval),
            }
        out[product] = {"intervals_present": sorted(int(i) for i in per_interval), "by_interval_ms": per_interval}
    return out


_SECTIONS = {"candles": _candles, "official_candles": lambda rows: _candles(rows, with_closed=False),
             "trades": cts._ticker}


def build_sample(conn, window=WINDOW, products=PRODUCTS):
    """Run the fixed queries. Anything other than the approved window and products is refused."""
    if tuple(window) != WINDOW or tuple(products) != PRODUCTS:
        raise ValueError("only the approved window and products are allowed")
    result = {
        "tool_version": TOOL_VERSION,
        "window_start_ms": WINDOW_START_MS,
        "window_end_ms": WINDOW_END_MS,
        "products": list(PRODUCTS),
        "row_budget": cts.ROW_BUDGET,
        "query_time_limit_s": cts.QUERY_TIMEOUT_S,
        "silence_limits_ms_counted_not_adopted": list(cts.SILENCE_LIMITS_MS),
        "edge_limits": [
            "The last candle closes at 12:00Z and its closing revision can be recorded after the window; candle "
            "buckets are selected by bucket start, so it is read, but a ticker or trade recorded after 12:00Z is not.",
            "A candle bucket missing here is not by itself a defect: the capture builds candles from trades, so a "
            "bucket without trades has no candle; compare with the trade counters below.",
            "After a capture outage the capture reports candles recovered from the public charts API; this tool "
            "does not know where they are stored and reads no price to find out.",
        ],
        "sections": {},
        "stopped": None,
        "note": "Times and counters only. No price, volume, size or raw body was read. Measures our reception, not "
                "when Kraken publishes, and does not compare values.",
    }
    guard = None
    try:
        result["guards"] = {"opened_with": "mode=ro",
                            "query_only_readback": conn.execute("PRAGMA query_only").fetchone()[0]}
        if result["guards"]["query_only_readback"] != 1:
            raise cts.Stopped("connection_not_query_only")
        conn.set_authorizer(cts._authorizer)
        guard = cts._Guard(conn)
        counts = {name: guard.fetch(name, count_sql)[0][0] for name, (count_sql, _r) in SQL.items()}
        result["row_counts"] = counts
        if sum(counts.values()) > cts.ROW_BUDGET:
            raise cts.Stopped("row_budget", {"total": sum(counts.values()), "limit": cts.ROW_BUDGET})
        for name, (_c, rows_sql) in SQL.items():
            result["sections"][name] = _SECTIONS[name]([tuple(r) for r in guard.fetch(name, rows_sql)])
    except cts.Stopped as stop:
        result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
        result["sections"] = {}
    except sqlite3.DatabaseError as exc:
        result["stopped"] = {"reason": "database_error", "detail": "%s: %s" % (type(exc).__name__, exc)}
        result["sections"] = {}
    finally:
        if guard is not None:
            conn.set_progress_handler(None, 0)
            conn.set_authorizer(None)
    return result


def fingerprint(result):
    body = {k: v for k, v in result.items() if k != "fingerprint_sha256"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True, help="local capture database (opened read-only)")
    args = ap.parse_args(argv)
    conn = cts._open_readonly(args.db)
    try:
        result = build_sample(conn)
        result["source"] = {"db_name": os.path.basename(args.db), "db_size_bytes": os.path.getsize(args.db)}
    finally:
        conn.close()
    result["fingerprint_sha256"] = fingerprint(result)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 2 if result["stopped"] else 0


if __name__ == "__main__":
    sys.exit(main())
