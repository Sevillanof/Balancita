"""Timing-only sample of the live capture (Issue #183, P2 level A of BAL-DECISION-183-07).

One fixed engineering window, two products, times and counters only. It reads no price, rate, volume, bid/ask, size
or ``raw_*`` / ``*_json`` column: a SQLite authorizer denies every column that is not on ``ALLOWED_COLUMNS`` while the
statements are prepared, so the promise is enforced, not just documented. The database is opened read-only, each
query has a time limit, and the row budget is checked with COUNT(*) before any row is fetched. The window and the
products are constants of this module (the CLI takes only ``--db``); ``build_sample`` refuses anything else.

This is not part of the validators of #188, which keep rejecting every range from the holdout cut. It measures OUR
reception (coverage, silences, order, delay between the event and our record, clock offset bounded with the funding
``server_time``); it does not measure when Kraken publishes, and it does not validate values.

Both the event time and the receipt time of every ticker row, and the receipt time of every funding response, must fall
inside the window: later responses repeat history and are outside what was authorized (D-207-01), and a receipt range
lets the ticker query use the (product_id, received_at, seq) index (D-207-02). An event recorded after 12:00Z is left out.
The run must happen before 2026-10-16T06:00Z: from then on the 24 h ticker retention starts deleting the window (D-207-03).

Usage (stdlib only; Python 3.9 is enough):
    python3 -m balancita_engine.capture_timing_sample --db <capture.sqlite> > out.json
"""
import argparse
import datetime
import hashlib
import json
import math
import os
import sqlite3
import sys
import time
import urllib.parse

TOOL_VERSION = "capture-timing-sample.v1"
WINDOW_START_MS = 1_792_044_000_000  # 2026-10-15T06:00:00Z, inclusive
WINDOW_END_MS = 1_792_065_600_000  # 2026-10-15T12:00:00Z, exclusive
WINDOW = (WINDOW_START_MS, WINDOW_END_MS)
PRODUCTS = ("PF_XBTUSD", "PF_ETHUSD")
ROW_BUDGET = 300_000
QUERY_TIMEOUT_S = 60
PROGRESS_OPS = 1000  # how often (SQLite VM steps) the time limit is checked
CANDLE_INTERVAL_MS = 300_000
EXPECTED_CANDLES = (WINDOW_END_MS - WINDOW_START_MS) // CANDLE_INTERVAL_MS
EXPECTED_FUNDING_PERIODS = (WINDOW_END_MS - WINDOW_START_MS) // 3_600_000
SILENCE_LIMITS_MS = (15_000, 25_000, 45_000)  # hypotheses, counted only; none is adopted

# The only columns any statement may read. The empty name is what SQLite reports for COUNT(*) / row access.
ALLOWED_COLUMNS = {
    "paper_futures_market_events": {"product_id", "feed", "epoch", "seq", "event_time", "received_at", ""},
    "paper_futures_candle_revisions": {"candle_id", "interval_ms", "bucket_start", "revision", "known_at",
                                       "is_closed", ""},
    "paper_futures_funding_periods": {"product_id", "start_ms", "end_ms", "known_at", "response_sha256", ""},
    "paper_futures_funding_responses": {"sha256", "received_at", "server_time", ""},
    "paper_futures_data_gaps": {"product_id", "reason", "detected_at", ""},
    "paper_futures_official_candles": {"product_id", "interval_ms", "bucket_start", "known_at", ""},
}

_W0, _W1 = WINDOW_START_MS, WINDOW_END_MS
_IN = ",".join("'%s'" % p for p in PRODUCTS)
_CANDLE_PRODUCT = "substr(candle_id, 1, instr(candle_id, ':') - 1)"

# name -> (count SQL, row SQL). Fixed text: no value from the caller reaches the SQL.
SQL = {
    "ticker": (
        "SELECT COUNT(*) FROM paper_futures_market_events WHERE feed = 'ticker' AND product_id IN (%s) "
        "AND event_time >= %d AND event_time < %d AND received_at >= %d AND received_at < %d"
        % (_IN, _W0, _W1, _W0, _W1),
        "SELECT product_id, epoch, seq, event_time, received_at FROM paper_futures_market_events "
        "WHERE feed = 'ticker' AND product_id IN (%s) AND received_at >= %d AND received_at < %d "
        "AND event_time >= %d AND event_time < %d ORDER BY product_id, received_at, seq"
        % (_IN, _W0, _W1, _W0, _W1),
    ),
    "candles_5m": (
        "SELECT COUNT(*) FROM paper_futures_candle_revisions WHERE %s IN (%s) AND interval_ms = %d "
        "AND bucket_start >= %d AND bucket_start < %d" % (_CANDLE_PRODUCT, _IN, CANDLE_INTERVAL_MS, _W0, _W1),
        "SELECT %s, bucket_start, revision, known_at, is_closed FROM paper_futures_candle_revisions "
        "WHERE %s IN (%s) AND interval_ms = %d AND bucket_start >= %d AND bucket_start < %d "
        "ORDER BY 1, bucket_start, revision" % (_CANDLE_PRODUCT, _CANDLE_PRODUCT, _IN, CANDLE_INTERVAL_MS, _W0, _W1),
    ),
    "funding": (
        "SELECT COUNT(*) FROM paper_futures_funding_periods p JOIN paper_futures_funding_responses r "
        "ON r.sha256 = p.response_sha256 WHERE p.product_id IN (%s) AND p.start_ms >= %d AND p.start_ms < %d "
        "AND r.received_at >= %d AND r.received_at < %d" % (_IN, _W0, _W1, _W0, _W1),
        "SELECT p.product_id, p.start_ms, p.end_ms, p.known_at, r.sha256, r.received_at, r.server_time "
        "FROM paper_futures_funding_periods p JOIN paper_futures_funding_responses r ON r.sha256 = p.response_sha256 "
        "WHERE p.product_id IN (%s) AND p.start_ms >= %d AND p.start_ms < %d AND r.received_at >= %d "
        "AND r.received_at < %d ORDER BY p.product_id, p.start_ms" % (_IN, _W0, _W1, _W0, _W1),
    ),
    "data_gaps": (
        "SELECT COUNT(*) FROM paper_futures_data_gaps WHERE product_id IN (%s) AND detected_at >= %d "
        "AND detected_at < %d" % (_IN, _W0, _W1),
        "SELECT product_id, reason, detected_at FROM paper_futures_data_gaps WHERE product_id IN (%s) "
        "AND detected_at >= %d AND detected_at < %d ORDER BY product_id, reason, detected_at" % (_IN, _W0, _W1),
    ),
    "official_candles_5m": (
        "SELECT COUNT(*) FROM paper_futures_official_candles WHERE product_id IN (%s) AND interval_ms = %d "
        "AND bucket_start >= %d AND bucket_start < %d" % (_IN, CANDLE_INTERVAL_MS, _W0, _W1),
        "SELECT product_id, bucket_start, known_at FROM paper_futures_official_candles WHERE product_id IN (%s) "
        "AND interval_ms = %d AND bucket_start >= %d AND bucket_start < %d ORDER BY product_id, bucket_start"
        % (_IN, CANDLE_INTERVAL_MS, _W0, _W1),
    ),
}


class Stopped(Exception):
    """The run was stopped by a guard (budget, time limit, identity). The reason goes into the output."""

    def __init__(self, reason, detail=None):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def _open_readonly(path):
    if not os.path.isfile(path) or os.path.islink(path):
        raise FileNotFoundError("database file not found or is a link")
    conn = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(path), uri=True, timeout=2.0)
    conn.execute("PRAGMA query_only = ON")
    return conn


def _authorizer(action, arg1, arg2, _db, _source):
    if action == sqlite3.SQLITE_READ:
        allowed = ALLOWED_COLUMNS.get(arg1)
        return sqlite3.SQLITE_OK if allowed is not None and arg2 in allowed else sqlite3.SQLITE_DENY
    if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_FUNCTION):
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY  # no write, no pragma, no attach, no transaction control


class _Guard:
    """Time limit per statement: the progress handler aborts it once the deadline passes."""

    def __init__(self, conn):
        self.conn = conn
        self.deadline = None
        conn.set_progress_handler(self._tick, PROGRESS_OPS)

    def _tick(self):
        return 1 if self.deadline is not None and time.monotonic() > self.deadline else 0

    def run(self, name, sql):
        self.deadline = time.monotonic() + QUERY_TIMEOUT_S
        try:
            return self.conn.execute(sql)
        except sqlite3.OperationalError as exc:
            if "interrupt" in str(exc).lower():
                raise Stopped("query_time_limit", name)
            raise

    def fetch(self, name, sql):
        cur = self.run(name, sql)
        try:
            return cur.fetchall()
        except sqlite3.OperationalError as exc:
            if "interrupt" in str(exc).lower():
                raise Stopped("query_time_limit", name)
            raise


def _quantiles(values):
    if not values:
        return None
    xs = sorted(values)
    n = len(xs)

    def q(p):
        return xs[max(0, math.ceil(p * n) - 1)]
    return {"n": n, "min": xs[0], "p50": q(0.5), "p95": q(0.95), "p99": q(0.99), "max": xs[-1]}


def _parse_server_time(text):
    """Funding ``server_time`` as epoch ms, or None when it is not an ISO timestamp."""
    try:
        value = str(text).strip().replace("Z", "+00:00")
        parsed = datetime.datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        return int(round(parsed.timestamp() * 1000))
    except (ValueError, TypeError, OverflowError):
        return None


def _ticker(rows):
    out = {}
    for product in PRODUCTS:
        mine = [r for r in rows if r[0] == product]
        silences, lags, epochs = [], [], set()
        non_increasing_seq = 0
        prev = None
        for _p, epoch, seq, event_time, received_at in mine:
            epochs.add(epoch)
            lags.append(received_at - event_time)
            if prev is not None:
                silences.append(received_at - prev[2])
                if prev[0] == epoch and seq <= prev[1]:
                    non_increasing_seq += 1
            prev = (epoch, seq, received_at)
        out[product] = {
            "rows": len(mine),
            "epochs": len(epochs),
            "min_event_time": min((r[3] for r in mine), default=None),
            "max_event_time": max((r[3] for r in mine), default=None),
            "min_received_at": min((r[4] for r in mine), default=None),
            "max_received_at": max((r[4] for r in mine), default=None),
            "seq_not_increasing_within_epoch": non_increasing_seq,
            "max_silence_ms": max(silences, default=None),
            "silences_over_ms": {str(limit): sum(1 for s in silences if s > limit) for limit in SILENCE_LIMITS_MS},
            "received_minus_event_ms": _quantiles(lags),
            "negative_received_minus_event": sum(1 for v in lags if v < 0),
        }
    return out


def _candles(rows):
    out = {}
    for product in PRODUCTS:
        mine = [r for r in rows if r[0] == product]
        buckets = {r[1] for r in mine}
        closed = {r[1] for r in mine if r[4] == 1}
        out[product] = {
            "revisions": len(mine),
            "distinct_buckets": len(buckets),
            "expected_buckets": EXPECTED_CANDLES,
            "missing_buckets": EXPECTED_CANDLES - len(buckets),
            "buckets_with_a_closed_revision": len(closed),
            "known_at_minus_bucket_end_ms": _quantiles([r[3] - (r[1] + CANDLE_INTERVAL_MS) for r in mine]),
        }
    return out


def _funding(rows):
    out = {}
    for product in PRODUCTS:
        mine = [r for r in rows if r[0] == product]
        starts = {r[1] for r in mine}
        responses = {}
        for _p, _s, _e, _k, sha, received_at, server_time in mine:
            responses[sha] = (received_at, _parse_server_time(server_time))
        parsed = [(rec, srv) for rec, srv in responses.values() if srv is not None]
        offsets = [rec - srv for rec, srv in parsed]
        out[product] = {
            "periods": len(starts),
            "expected_periods": EXPECTED_FUNDING_PERIODS,
            "missing_periods": EXPECTED_FUNDING_PERIODS - len(starts),
            "responses": len(responses),
            "min_received_at": min((v[0] for v in responses.values()), default=None),
            "max_received_at": max((v[0] for v in responses.values()), default=None),
            "responses_with_unparseable_server_time": len(responses) - len(parsed),
            "received_minus_server_time_ms": {"min": min(offsets), "max": max(offsets)} if offsets else None,
            "min_known_at_minus_period_end_ms": min((r[3] - r[2] for r in mine), default=None),
            "max_known_at_minus_period_end_ms": max((r[3] - r[2] for r in mine), default=None),
        }
    return out


def _gaps(rows):
    out = {}
    for product, reason, detected_at in rows:
        entry = out.setdefault(product, {}).setdefault(reason, {"count": 0, "min_detected_at": detected_at,
                                                                  "max_detected_at": detected_at})
        entry["count"] += 1
        entry["min_detected_at"] = min(entry["min_detected_at"], detected_at)
        entry["max_detected_at"] = max(entry["max_detected_at"], detected_at)
    return {product: out.get(product, {}) for product in PRODUCTS}


def _official(rows):
    out = {}
    for product in PRODUCTS:
        mine = [r for r in rows if r[0] == product]
        out[product] = {
            "rows": len(mine),
            "min_bucket_start": min((r[1] for r in mine), default=None),
            "max_bucket_start": max((r[1] for r in mine), default=None),
            "min_known_at": min((r[2] for r in mine), default=None),
            "max_known_at": max((r[2] for r in mine), default=None),
        }
    return out


_SECTIONS = {"ticker": _ticker, "candles_5m": _candles, "funding": _funding, "data_gaps": _gaps,
             "official_candles_5m": _official}


def build_sample(conn, window=WINDOW, products=PRODUCTS):
    """Run the fixed queries. Anything other than the approved window and products is refused."""
    if tuple(window) != WINDOW or tuple(products) != PRODUCTS:
        raise ValueError("only the approved window and products are allowed")
    result = {
        "tool_version": TOOL_VERSION,
        "window_start_ms": WINDOW_START_MS,
        "window_end_ms": WINDOW_END_MS,
        "products": list(PRODUCTS),
        "row_budget": ROW_BUDGET,
        "query_time_limit_s": QUERY_TIMEOUT_S,
        "silence_limits_ms_counted_not_adopted": list(SILENCE_LIMITS_MS),
        "sections": {},
        "stopped": None,
        "note": "Times and counters only. No price, rate, volume, bid/ask, size or raw body was read. Measures our "
                "reception, not when Kraken publishes; received-minus-event includes network delay and local clock "
                "offset. Counts and quantiles do not prove quality.",
    }
    conn.set_authorizer(_authorizer)
    guard = _Guard(conn)
    try:
        counts = {}
        for name, (count_sql, _rows_sql) in SQL.items():
            counts[name] = guard.fetch(name, count_sql)[0][0]
        result["row_counts"] = counts
        if sum(counts.values()) > ROW_BUDGET:
            raise Stopped("row_budget", {"total": sum(counts.values()), "limit": ROW_BUDGET})
        for name, (_count_sql, rows_sql) in SQL.items():
            result["sections"][name] = _SECTIONS[name]([tuple(r) for r in guard.fetch(name, rows_sql)])
    except Stopped as stop:
        result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
        result["sections"] = {}
    except sqlite3.DatabaseError as exc:  # absent table, denied column, locked base: information, then stop
        result["stopped"] = {"reason": "database_error", "detail": "%s: %s" % (type(exc).__name__, exc)}
        result["sections"] = {}
    finally:
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
    conn = _open_readonly(args.db)
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
