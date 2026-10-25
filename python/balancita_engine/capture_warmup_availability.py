"""Warm-up availability of the live capture (Issues #185 and #183, BAL-DECISION-185-02, stage 1).

One question: does the live capture hold the 1-minute official candles of PF_XBTUSD that the frozen strategies need to warm
up (``required_warmup_ms`` = 1 037 400 000 ms = 3 458 five-minute bars = 17 290 one-minute candles = 288 h 10 min) in the
fixed window [2026-10-01T19:50Z, 2026-10-13T21:00Z), 17 350 minutes (the first window, from
2026-10-01T00:00Z, started 19 h 50 min before the capture begins and came back ``bloqueada``)? It reads times and counters only: ``bucket_start`` and
``known_at`` of every candle, plus a 0/1 flag per row that says whether a price/volume field is empty (never the value). No price,
rate, volume or raw body leaves the database.

Guards (the authorization is the contract, not this file; any other window, product, interval, table or column is refused):
- read-only connection (``mode=ro``) and ``PRAGMA query_only`` read back (must be 1); a link or a missing file is refused;
- a SQLite authorizer that denies every column not on the allow-list; the price and volume columns can only be read inside the
  fixed statement's ``CASE`` that turns them into a 0/1 flag, so nothing but an integer leaves the database;
- ONE statement, no pre-count: it is bounded by ``LIMIT 60000`` and ordered by ``bucket_start`` (the primary-key order), so
  the database never walks more than 60 000 rows. If 60 000 rows come back the window may hold more: the tool stops with
  ``row_budget`` and analyses nothing (nothing is sampled; exactly 60 000 rows is also refused, on purpose);
- before it runs, ``EXPLAIN QUERY PLAN`` must show a SEARCH on the primary-key index with no scan and no temporary sort;
  otherwise it stops with ``query_plan`` and the published plan is the proof of what "scanned" means;
- 60 s per statement (progress handler) and 10 min for the whole run; no retry, no widening.
It measures our own recording, not when Kraken published, and says nothing about the values.

Usage (stdlib only; Python 3.9 is enough):
    python3 -m balancita_engine.capture_warmup_availability --db <futures-market.sqlite> > out.json
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.parse

TOOL_VERSION = "capture-warmup-availability.v2"
PRODUCT = "PF_XBTUSD"
INTERVAL_MS = 60_000
WINDOW_START_MS = 1_790_884_200_000  # 2026-10-01T19:50:00Z, inclusive: the first minute the capture recorded
WINDOW_END_MS = 1_791_925_200_000  # 2026-10-13T21:00:00Z, exclusive: 60 minutes after 17 290 minutes from the start
WINDOW = (WINDOW_START_MS, WINDOW_END_MS)
EXPECTED_MINUTES = (WINDOW_END_MS - WINDOW_START_MS) // INTERVAL_MS  # 17 350
REQUIRED_MINUTES = 1_037_400_000 // INTERVAL_MS  # 17 290: required_warmup_ms of the frozen strategies
REQUIRED_SPAN_START_MS = WINDOW_END_MS - REQUIRED_MINUTES * INTERVAL_MS  # the 17 290 minutes that end the window
ROW_BUDGET = 60_000
QUERY_TIMEOUT_S = 60
RUN_TIMEOUT_S = 600
PROGRESS_OPS = 1000
MAX_REPORTED_RUNS = 20
TABLE = "paper_futures_official_candles"
DB_NAME = "futures-market.sqlite"

TIME_COLUMNS = {"product_id", "interval_ms", "bucket_start", "known_at"}
VALUE_COLUMNS = {"open_price", "high_price", "low_price", "close_price", "volume_btc"}
# One mode only: the value columns are read by the fixed CASE of SQL_FETCH and by nothing else (tests pin the statement).
_ALLOWED = {"fetch": TIME_COLUMNS | VALUE_COLUMNS}
PK_INDEX = "sqlite_autoindex_paper_futures_official_candles_1"

_WHERE = "product_id = '%s' AND interval_ms = %d AND bucket_start >= %d AND bucket_start < %d" % (
    PRODUCT, INTERVAL_MS, WINDOW_START_MS, WINDOW_END_MS)
_EMPTY = "(%s IS NULL OR trim(%s) = '')"
SQL_FETCH = (
    "SELECT bucket_start, known_at, CASE WHEN %s THEN 1 ELSE 0 END FROM %s WHERE %s ORDER BY bucket_start LIMIT %d" % (
        " OR ".join(_EMPTY % (c, c) for c in sorted(VALUE_COLUMNS)), TABLE, _WHERE, ROW_BUDGET))
SQL_PLAN = "EXPLAIN QUERY PLAN " + SQL_FETCH


class Stopped(Exception):
    def __init__(self, reason, detail=None):
        super().__init__(reason)
        self.reason, self.detail = reason, detail


def _open_readonly(path):
    if not os.path.isfile(path) or os.path.islink(path):
        raise FileNotFoundError("database file not found or is a link")
    conn = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(path), uri=True, timeout=2.0)
    conn.execute("PRAGMA query_only = ON")
    return conn


class _Guard:
    """Authorizer per statement and a time limit per statement and for the whole run."""

    def __init__(self, conn, started):
        self.conn, self.started, self.deadline, self.mode = conn, started, None, None
        conn.set_authorizer(self._authorize)
        conn.set_progress_handler(self._tick, PROGRESS_OPS)

    def _authorize(self, action, arg1, arg2, _db, _source):
        if action == sqlite3.SQLITE_READ:
            ok = arg1 == TABLE and self.mode is not None and arg2 in _ALLOWED[self.mode]
            return sqlite3.SQLITE_OK if ok else sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_FUNCTION):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY  # no write, no pragma, no attach, no transaction control

    def _tick(self):
        now = time.monotonic()
        return 1 if (self.deadline is not None and now > self.deadline) or now - self.started > RUN_TIMEOUT_S else 0

    def fetch(self, mode, sql):
        self.mode = mode
        self.deadline = time.monotonic() + QUERY_TIMEOUT_S
        try:
            return self.conn.execute(sql).fetchall()
        except sqlite3.OperationalError as exc:
            if "interrupt" in str(exc).lower():
                raise Stopped("time_limit", mode)
            raise
        finally:
            self.mode = None

    def close(self):
        self.conn.set_progress_handler(None, 0)
        self.conn.set_authorizer(None)


def _quantiles(values):
    if not values:
        return None
    ordered = sorted(values)

    def q(p):
        return ordered[min(len(ordered) - 1, int(p * len(ordered)))]
    return {"n": len(ordered), "min": ordered[0], "p50": q(0.50), "p95": q(0.95), "max": ordered[-1]}


def analyse(rows):
    """Availability of the minutes from the (bucket_start, known_at) rows. Pure: tested without a database."""
    grid = {b for b, _k in rows if WINDOW_START_MS <= b < WINDOW_END_MS and (b - WINDOW_START_MS) % INTERVAL_MS == 0}
    off_grid = len({b for b, _k in rows}) - len(grid)
    per_bucket = {}
    for b, k in rows:
        per_bucket[b] = per_bucket.get(b, 0) + 1
    runs, cursor = [], WINDOW_START_MS
    for b in sorted(grid) + [WINDOW_END_MS]:
        if b > cursor:
            runs.append({"start_ms": cursor, "minutes": (b - cursor) // INTERVAL_MS})
        cursor = b + INTERVAL_MS
    tail = 0
    last = WINDOW_END_MS - INTERVAL_MS
    while last - tail * INTERVAL_MS in grid:
        tail += 1
    runs.sort(key=lambda r: (-r["minutes"], r["start_ms"]))
    return {
        "expected_minutes": EXPECTED_MINUTES,
        "minutes_present": len(grid),
        "minutes_missing": EXPECTED_MINUTES - len(grid),
        "off_grid_buckets": off_grid,
        "consecutive_minutes_up_to_the_end": tail,
        "missing_runs": {"count": len(runs), "longest": runs[:MAX_REPORTED_RUNS]},
        "revisions": {"rows": len(rows), "buckets_with_more_than_one": sum(1 for n in per_bucket.values() if n > 1),
                      "max_per_bucket": max(per_bucket.values()) if per_bucket else 0},
        "known_at_minus_bucket_end_ms": _quantiles([k - (b + INTERVAL_MS) for b, k in rows]),
    }


def verdict(counts, availability):
    """``apta``: at least REQUIRED_MINUTES consecutive minutes up to the end of the window and no empty field in the
    17 290 minutes that end the window (an empty field earlier in the window, or in a revision, is reported, not blocking)."""
    reasons = []
    if availability["consecutive_minutes_up_to_the_end"] < REQUIRED_MINUTES:
        reasons.append("only %d consecutive minutes up to the end of the window, %d are required" % (
            availability["consecutive_minutes_up_to_the_end"], REQUIRED_MINUTES))
    if counts["empty_fields_rows_in_required_span"]:
        reasons.append("%d rows with an empty price or volume field in the %d minutes that end the window" % (
            counts["empty_fields_rows_in_required_span"], REQUIRED_MINUTES))
    return {"fitness": "bloqueada" if reasons else "apta", "required_consecutive_minutes": REQUIRED_MINUTES,
            "reasons": reasons}


def _plan_ok(plan):
    """The plan must be a SEARCH on the primary-key index: no table scan and no temporary sort."""
    details = [row[3] for row in plan]
    searches = [d for d in details if d.startswith("SEARCH") and PK_INDEX in d]
    return bool(searches) and not any(d.startswith("SCAN") or "TEMP B-TREE" in d for d in details), details


def build_report(conn, window=WINDOW, product=PRODUCT, started=None):
    """Run the one fixed statement. Anything other than the approved window and product is refused."""
    if tuple(window) != WINDOW or product != PRODUCT:
        raise ValueError("only the approved window and product are allowed")
    started = time.monotonic() if started is None else started
    result = {
        "tool_version": TOOL_VERSION, "product": PRODUCT, "interval_ms": INTERVAL_MS,
        "window_start_ms": WINDOW_START_MS, "window_end_ms": WINDOW_END_MS,
        "row_budget_scanned": ROW_BUDGET, "query_time_limit_s": QUERY_TIMEOUT_S, "run_time_limit_s": RUN_TIMEOUT_S,
        "note": "Times and counters only. No price, rate or volume was returned; empty fields are only counted. "
                "Availability of the live capture's own recording, not a statement about the values or about Kraken. "
                "It is not the warm-up of a session.",
        "stopped": None,
    }
    guard = None
    try:
        readback = conn.execute("PRAGMA query_only").fetchone()[0]       # before the authorizer, which denies every pragma
        result["guards"] = {"opened_with": "mode=ro", "query_only_readback": readback}
        if readback != 1:
            raise Stopped("connection_not_query_only")
        guard = _Guard(conn, started)
        plan = guard.fetch("fetch", SQL_PLAN)
        ok, details = _plan_ok(plan)
        result["query_plan"] = details
        if not ok:
            raise Stopped("query_plan", details)
        raw = guard.fetch("fetch", SQL_FETCH)
        result["rows_scanned"] = {"fetched": len(raw), "limit": ROW_BUDGET}
        if len(raw) >= ROW_BUDGET:
            raise Stopped("row_budget", {"fetched": len(raw), "limit": ROW_BUDGET})
        if any(r[2] not in (0, 1) for r in raw):
            raise Stopped("unexpected_flag")
        rows = [(r[0], r[1]) for r in raw]
        buckets = [r[0] for r in rows]
        result["counts"] = {
            "rows": len(rows), "distinct_buckets": len(set(buckets)),
            "min_bucket_start": min(buckets) if buckets else None, "max_bucket_start": max(buckets) if buckets else None,
            "empty_fields_rows": sum(r[2] for r in raw),
            "empty_fields_rows_in_required_span": sum(r[2] for r in raw if r[0] >= REQUIRED_SPAN_START_MS)}
        result["availability"] = analyse(rows)
        result["verdict"] = verdict(result["counts"], result["availability"])
    except Stopped as stop:
        result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
    except sqlite3.DatabaseError as exc:
        result["stopped"] = {"reason": "database_error", "detail": "%s: %s" % (type(exc).__name__, exc)}
    finally:
        if guard is not None:
            guard.close()
    return result


def fingerprint(result):
    body = {k: v for k, v in result.items() if k != "fingerprint_sha256"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _identity(path):
    st = os.stat(path)
    return {"db_name": os.path.basename(path), "size_bytes": st.st_size, "mtime_ns": st.st_mtime_ns,
            "regular_file_not_a_link": os.path.isfile(path) and not os.path.islink(path)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True, help="local live-capture database (opened read-only)")
    args = ap.parse_args(argv)
    if os.path.basename(args.db) != DB_NAME:
        sys.stderr.write("refused: the file must be called %s\n" % DB_NAME)
        return 2
    started = time.monotonic()
    before = _identity(args.db)
    conn = _open_readonly(args.db)
    try:
        result = build_report(conn, started=started)
    finally:
        conn.close()
    result["source"] = {"before": before, "after": _identity(args.db),
                        "elapsed_s": round(time.monotonic() - started, 3)}
    result["fingerprint_sha256"] = fingerprint(result)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 2 if result["stopped"] else 0


if __name__ == "__main__":
    sys.exit(main())
