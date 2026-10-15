"""Minimum real read of the live capture for Issue #183 (BAL-DECISION-185-02, stages 2a to 2d; BAL-DECISION-185-03).

One run answers one question: do the live capture's own 1-minute candles and its funding records agree with the official
series and with the provider's units, inside two fixed engineering windows of October 2026? It reads the stored rows with
the fixed statements below, hands them to the validators of #188 (``capture_validation``) and publishes only aggregates:
counts, fitness and findings grouped by check with the first and last time. No series, no price, rate or volume, and no
response body leaves this process.

Fixed by the authorization (the CLI takes only ``--db``; any other window, product, table or column is not reachable):
- 2a  official 1-minute candles, PF_XBTUSD and PF_ETHUSD, ``[2026-10-10T00:00Z, 2026-10-12T00:00Z)``, at most 12 000 rows in all;
- 2b  the capture's own 1-minute candles, PF_XBTUSD, ``[2026-10-11T00:00Z, 06:00Z)``, at most 100 000 rows; the values are
      returned only for CLOSED revisions (a ``CASE`` turns every open revision's values into NULL inside the statement);
- 2c  funding periods that START in the 2a window, both products, at most 400 rows;
- 2d  funding responses RECEIVED in the 2a window, both products, at most 600 rows and 20 MB; each body is parsed in memory
      by ``funding_adapter`` only to take the relative rate, ``serverTime`` and which periods are definitive.

Guards, the same family as ``capture_warmup_availability`` (Etapa 10):
- the file must be a regular file (not a link) called ``futures-market.sqlite`` in a directory called ``dev-live``, at least
  as large as the one identified in BAL-IDENTIFICACION-183-01 (the file only grows); size and mtime are published before and
  after;
- ``mode=ro`` and ``PRAGMA query_only`` read back (must be 1); a SQLite authorizer allows, per statement, only the tables and
  columns of that statement, and denies every write, pragma and attach;
- no pre-count: every statement is bounded by ``LIMIT <cap> + 1`` and the run stops with ``row_budget`` if more than the cap
  comes back (nothing is sampled, truncated or retried). The rows of the whole run are the sum of the caps;
- ``EXPLAIN QUERY PLAN`` runs first: 2a and 2b must show a SEARCH on the primary-key index and no temporary sort (published);
  2c and 2d filter columns that have no index, so SQLite walks those tables (the plan is published) and the bound is the
  returned-row cap plus the time limit, which is said here instead of hidden;
- 60 s per statement and 10 min for the run (progress handler); no retry, no widening; every stop is published and exits 2.

The validators keep refusing every range from the holdout cut: ``HOLDOUT_START_MS`` is not changed. This module gives them
the one engineering window it was authorized for (``holdout_window``), nothing else.

It measures our own recording against the official series; it does not measure when Kraken publishes, does not use the
quotes, and proves nothing about days or products outside these windows.

Usage (stdlib only; Python 3.9 is enough):
    python3 -m balancita_engine.capture_minimal_read --db <futures-market.sqlite> > out.json
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.parse
from decimal import Decimal

from . import capture_validation as cv
from . import funding_adapter

TOOL_VERSION = "capture-minimal-read.v1"
DECISIONS = ("BAL-DECISION-185-02", "BAL-DECISION-185-03")
BTC, ETH = "PF_XBTUSD", "PF_ETHUSD"
PRODUCTS = (BTC, ETH)
MINUTE_MS = 60_000
WINDOW_A = (1_791_590_400_000, 1_791_763_200_000)   # 2026-10-10T00:00Z .. 2026-10-12T00:00Z (2a, 2c, 2d)
WINDOW_B = (1_791_676_800_000, 1_791_698_400_000)   # 2026-10-11T00:00Z .. 06:00Z (2b)
HOLDOUT_WINDOW = WINDOW_A                            # the one exception the validators are given (contains WINDOW_B)
CAPS = {"2a": 12_000, "2b": 100_000, "2c": 400, "2d": 600}
MAX_BODY_BYTES = 20_000_000
QUERY_TIMEOUT_S = 60
RUN_TIMEOUT_S = 600
PROGRESS_OPS = 1000
MAX_REPORTED = 20
DB_NAME, DB_DIR = "futures-market.sqlite", "dev-live"
MIN_SIZE_BYTES = 6_065_790_976                       # BAL-IDENTIFICACION-183-01; the live file only grows
PK_CANDLES = "sqlite_autoindex_paper_futures_official_candles_1"
PK_REVISIONS = "sqlite_autoindex_paper_futures_candle_revisions_1"
EXPECTED_MINUTES_A = (WINDOW_A[1] - WINDOW_A[0]) // MINUTE_MS
EXPECTED_MINUTES_B = (WINDOW_B[1] - WINDOW_B[0]) // MINUTE_MS

_P = ",".join("'%s'" % p for p in PRODUCTS)
_OFFICIAL = "paper_futures_official_candles"
_REVISIONS = "paper_futures_candle_revisions"
_PERIODS = "paper_futures_funding_periods"
_RESPONSES = "paper_futures_funding_responses"

# statement mode -> {table: allowed columns}. The empty name is what SQLite reports for row access without a column.
ALLOWED = {
    "2a": {_OFFICIAL: {"product_id", "interval_ms", "bucket_start", "revision_hash", "known_at", "open_price",
                       "high_price", "low_price", "close_price", "volume_btc"}},
    "2b": {_REVISIONS: {"candle_id", "interval_ms", "bucket_start", "revision", "known_at", "is_closed", "open_price",
                        "high_price", "low_price", "close_price", "volume_btc"}},
    "2c": {_PERIODS: {"product_id", "start_ms", "end_ms", "funding_rate", "known_at", "unit", "response_sha256"}},
    "2d_meta": {_RESPONSES: {"sha256", "received_at", "server_time", "raw_response"},
                _PERIODS: {"response_sha256", "product_id"}},
    "2d_product": {_PERIODS: {"response_sha256", "product_id"}},
    "2d_body": {_RESPONSES: {"sha256", "raw_response"}},
}


def _sql_2a(limit):
    return ("SELECT product_id, bucket_start, known_at, revision_hash, open_price, high_price, low_price, close_price, "
            "volume_btc FROM %s WHERE product_id = ? AND interval_ms = %d AND bucket_start >= %d AND bucket_start < %d "
            "ORDER BY interval_ms, bucket_start, revision_hash LIMIT %d" % (_OFFICIAL, MINUTE_MS, WINDOW_A[0], WINDOW_A[1], limit))


def _sql_2b(limit):
    lo, hi = "%s:%d:%d" % (BTC, MINUTE_MS, WINDOW_B[0]), "%s:%d:%d" % (BTC, MINUTE_MS, WINDOW_B[1])
    cases = ", ".join("CASE WHEN is_closed = 1 THEN %s END" % c for c in
                      ("open_price", "high_price", "low_price", "close_price", "volume_btc"))
    return ("SELECT bucket_start, revision, known_at, is_closed, %s FROM %s WHERE candle_id >= '%s' AND candle_id < '%s' "
            "AND interval_ms = %d AND bucket_start >= %d AND bucket_start < %d ORDER BY candle_id, revision LIMIT %d"
            % (cases, _REVISIONS, lo, hi, MINUTE_MS, WINDOW_B[0], WINDOW_B[1], limit))


def _sql_2c(limit):
    return ("SELECT product_id, start_ms, end_ms, funding_rate, known_at, unit, response_sha256 FROM %s WHERE product_id IN (%s) "
            "AND start_ms >= %d AND start_ms < %d LIMIT %d" % (_PERIODS, _P, WINDOW_A[0], WINDOW_A[1], limit))


def _sql_2d_meta(limit):
    return ("SELECT sha256, received_at, server_time, length(raw_response) FROM %s r WHERE received_at >= %d AND received_at < %d "
            "AND EXISTS (SELECT 1 FROM %s p WHERE p.response_sha256 = r.sha256 AND p.product_id IN (%s)) LIMIT %d"
            % (_RESPONSES, WINDOW_A[0], WINDOW_A[1], _PERIODS, _P, limit))


SQL_2D_PRODUCT = "SELECT product_id FROM %s WHERE response_sha256 = ? LIMIT 1" % _PERIODS
SQL_2D_BODY = "SELECT raw_response FROM %s WHERE sha256 = ?" % _RESPONSES


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
    """Per-statement authorizer and time limit, and the time limit of the whole run."""

    def __init__(self, conn, started):
        self.conn, self.started, self.deadline, self.mode = conn, started, None, None
        conn.set_authorizer(self._authorize)
        conn.set_progress_handler(self._tick, PROGRESS_OPS)

    def _authorize(self, action, arg1, arg2, _db, _source):
        if action == sqlite3.SQLITE_READ:
            allowed = ALLOWED.get(self.mode, {}).get(arg1) if self.mode else None
            return sqlite3.SQLITE_OK if allowed is not None and (arg2 in allowed or arg2 == "") else sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_FUNCTION):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY  # no write, no pragma, no attach, no transaction control

    def _tick(self):
        now = time.monotonic()
        return 1 if (self.deadline is not None and now > self.deadline) or now - self.started > RUN_TIMEOUT_S else 0

    def fetch(self, mode, sql, params=()):
        self.mode = mode
        self.deadline = time.monotonic() + QUERY_TIMEOUT_S
        try:
            return self.conn.execute(sql, params).fetchall()
        except sqlite3.OperationalError as exc:
            if "interrupt" in str(exc).lower():
                raise Stopped("time_limit", mode)
            raise
        finally:
            self.mode = None

    def close(self):
        self.conn.set_progress_handler(None, 0)
        self.conn.set_authorizer(None)


def _plan(guard, mode, sql, params=(), require_search=None):
    rows = guard.fetch(mode, "EXPLAIN QUERY PLAN " + sql, params)
    details = [r[3] for r in rows]
    if require_search is not None:
        ok = any(d.startswith("SEARCH") and require_search in d for d in details) and not any(
            d.startswith("SCAN") or "TEMP B-TREE" in d for d in details)
        if not ok:
            raise Stopped("query_plan", details)
    return details


class Ledger:
    """What was read, per statement, against its cap. The caps are those of BAL-DECISION-185-02."""

    def __init__(self):
        self.entries = []

    def add(self, stage, fetched, limit, plan, **extra):
        entry = {"stage": stage, "rows": fetched, "cap": limit, "plan": plan}
        entry.update(extra)
        self.entries.append(entry)


def read_2a(guard, ledger):
    rows, left, plans = [], CAPS["2a"], []
    for product in PRODUCTS:
        sql = _sql_2a(left + 1)
        plans.append(_plan(guard, "2a", sql, (product,), PK_CANDLES))
        got = guard.fetch("2a", sql, (product,))
        if len(got) > left:
            ledger.add("2a", len(got), CAPS["2a"], plans[-1], product=product, over_budget=True)
            raise Stopped("row_budget", {"stage": "2a", "product": product, "cap": CAPS["2a"]})
        left -= len(got)
        rows.extend(tuple(r) for r in got)
    ledger.add("2a", len(rows), CAPS["2a"], plans[0], products=list(PRODUCTS))
    return rows


def read_2b(guard, ledger):
    sql = _sql_2b(CAPS["2b"] + 1)
    plan = _plan(guard, "2b", sql, (), PK_REVISIONS)
    got = guard.fetch("2b", sql)
    ledger.add("2b", len(got), CAPS["2b"], plan)
    if len(got) > CAPS["2b"]:
        raise Stopped("row_budget", {"stage": "2b", "cap": CAPS["2b"]})
    return [tuple(r) for r in got]


def read_2c(guard, ledger):
    sql = _sql_2c(CAPS["2c"] + 1)
    plan = _plan(guard, "2c", sql)
    got = guard.fetch("2c", sql)
    ledger.add("2c", len(got), CAPS["2c"], plan, index_on_filter=False)
    if len(got) > CAPS["2c"]:
        raise Stopped("row_budget", {"stage": "2c", "cap": CAPS["2c"]})
    return [tuple(r) for r in got]


def read_2d(guard, ledger):
    sql = _sql_2d_meta(CAPS["2d"] + 1)
    plan = _plan(guard, "2d_meta", sql)
    meta = guard.fetch("2d_meta", sql)
    total = sum(int(r[3] or 0) for r in meta)
    ledger.add("2d", len(meta), CAPS["2d"], plan, index_on_filter=False, bytes=total, bytes_cap=MAX_BODY_BYTES)
    if len(meta) > CAPS["2d"]:
        raise Stopped("row_budget", {"stage": "2d", "cap": CAPS["2d"]})
    if total > MAX_BODY_BYTES:
        raise Stopped("byte_budget", {"stage": "2d", "bytes": total, "cap": MAX_BODY_BYTES})
    out = []
    for sha, received_at, server_time, _length in meta:
        prod = guard.fetch("2d_product", SQL_2D_PRODUCT, (sha,))
        body = guard.fetch("2d_body", SQL_2D_BODY, (sha,))
        if len(prod) != 1 or len(body) != 1:
            raise Stopped("response_not_found", {"stage": "2d"})
        out.append((sha, received_at, server_time, prod[0][0], body[0][0]))
    return out


# ------------------------------------------------------------------------------------------------ evaluation

def _current_official(rows):
    """Per (product, minute) the revision with the latest ``known_at`` (ties: the larger hash), plus how many minutes have
    more than one DIFFERENT revision. Rows: (product, bucket_start, known_at, hash, o, h, l, c, v)."""
    best, seen = {}, {}
    for product, bucket, known, rev, o, h, l, c, v in rows:
        key = (product, bucket)
        seen.setdefault(key, set()).add((o, h, l, c, v))
        if key not in best or (known, rev) > (best[key][0], best[key][1]):
            best[key] = (known, rev, o, h, l, c, v)
    differing = {}
    for (product, _b), versions in seen.items():
        if len(versions) > 1:
            differing[product] = differing.get(product, 0) + 1
    return best, differing


def _quantiles(values):
    if not values:
        return None
    xs = sorted(values)
    n = len(xs)

    def q(p):
        return xs[min(n - 1, int(p * n))]
    return {"n": n, "min": xs[0], "p50": q(0.5), "p95": q(0.95), "max": xs[-1]}


def summarize_official(rows):
    best, differing = _current_official(rows)
    out = {}
    for product in PRODUCTS:
        mine = sorted(b for (p, b) in best if p == product)
        present = set(mine)
        runs, cursor = [], WINDOW_A[0]
        for b in mine + [WINDOW_A[1]]:
            if b > cursor:
                runs.append({"start_ms": cursor, "minutes": (b - cursor) // MINUTE_MS})
            cursor = b + MINUTE_MS
        runs.sort(key=lambda r: (-r["minutes"], r["start_ms"]))
        out[product] = {
            "rows": sum(1 for r in rows if r[0] == product), "minutes_present": len(present),
            "expected_minutes": EXPECTED_MINUTES_A, "minutes_missing": EXPECTED_MINUTES_A - len(present),
            "minutes_with_differing_revisions": differing.get(product, 0),
            "missing_runs": {"count": len(runs), "longest": runs[:MAX_REPORTED]},
            "known_at_minus_bucket_end_ms": _quantiles([best[(product, b)][0] - (b + MINUTE_MS) for b in mine])}
    return out


def official_5m(rows):
    """Official 5-minute candles aggregated from the current official 1-minute revisions (BTC, window B), as text."""
    best, _ = _current_official(rows)
    minutes = []
    for (product, bucket), (_k, _r, o, h, l, c, v) in best.items():
        if product == BTC and WINDOW_B[0] <= bucket < WINDOW_B[1]:
            minutes.append({"bucket_start": bucket, "open": o, "high": h, "low": l, "close": c, "volume": v})
    return [{k: (str(x) if isinstance(x, Decimal) else x) for k, x in c.items()}
            for c in cv.aggregate_to_five_minutes(minutes).values()]


def own_minutes(rows):
    """First and last CLOSED revision of every minute of the capture (2b), as validator candles, and a summary. Rows:
    (bucket_start, revision, known_at, is_closed, open, high, low, close, volume)."""
    by_minute, all_revisions = {}, {}
    for b, rev, known, closed, o, h, l, c, v in rows:
        all_revisions[b] = all_revisions.get(b, 0) + 1
        if closed == 1:
            by_minute.setdefault(b, []).append((rev, known, o, h, l, c, v))
    candles, differing = [], 0
    for b, revs in sorted(by_minute.items()):
        revs.sort()
        first, last = revs[0], revs[-1]
        for item in ((first,) if first == last else (first, last)):
            candles.append({"bucket_start": b, "open": item[2], "high": item[3], "low": item[4], "close": item[5], "volume": item[6]})
        if first[2:] != last[2:]:
            differing += 1
    present = set(all_revisions)
    summary = {
        "rows": len(rows), "minutes_with_a_revision": len(present), "minutes_with_a_closed_revision": len(by_minute),
        "expected_minutes": EXPECTED_MINUTES_B, "minutes_missing": EXPECTED_MINUTES_B - len(present),
        "minutes_whose_first_and_last_closed_revision_differ": differing,
        "closed_revision_known_at_minus_bucket_end_ms": _quantiles(
            [r[2] - (r[0] + MINUTE_MS) for r in rows if r[3] == 1])}
    return candles, summary


def references(official_rows):
    """``{product: [(known instant of the candle's close, close price)]}`` from the official 1-minute candles of 2a."""
    best, _ = _current_official(official_rows)
    refs = {p: [] for p in PRODUCTS}
    for (product, bucket), (_k, _r, _o, _h, _l, close, _v) in best.items():
        refs[product].append((bucket + MINUTE_MS, close))
    return {p: sorted(v) for p, v in refs.items()}


def funding_inputs(period_rows, responses):
    """Validator inputs from 2c rows and the 2d responses. ``funding_adapter`` is used only for the relative rate, the
    provider time and which periods are definitive (``strict=False``: the unit check is the validator's, against the
    official candles)."""
    relative, provisional, polls, events = {}, set(), [], {"responses_parsed": 0, "responses_rejected": 0, "rows_rejected": 0}
    for sha, received_at, _server_time, product, body in responses:
        try:
            parsed = funding_adapter.parse_response(body, product, received_at, strict=False)
        except funding_adapter.FundingAdapterError as error:
            events["responses_rejected"] += 1
            events.setdefault("rejection_reasons", {})
            events["rejection_reasons"][error.reason] = events["rejection_reasons"].get(error.reason, 0) + 1
            continue
        events["responses_parsed"] += 1
        events["rows_rejected"] += len(parsed["rejected"])
        finals = sorted(r["start_ms"] for r in parsed["definitive"])
        for r in parsed["definitive"]:
            relative[(sha, r["start_ms"])] = r["relative_rate"]
        for r in parsed["provisional"]:
            provisional.add((sha, r["start_ms"]))
        listed = sorted(set(finals) | {r["start_ms"] for r in parsed["provisional"]})
        polls.append({"product_id": product, "received_at": received_at, "starts": listed, "final_starts": finals})
    periods = []
    for product, start, end, rate, known, unit, sha in period_rows:
        row = {"product_id": product, "start_ms": start, "end_ms": end, "funding_rate": rate, "unit": unit, "known_at": known,
               "response_sha256": sha}
        if (sha, start) in relative:
            row["relative_rate"] = relative[(sha, start)]
        if (sha, start) in provisional:
            row["provisional"] = True
        periods.append(row)
    return periods, polls, events


def _summarize_report(report):
    """Findings grouped by (kind, check, product) with counts and first/last time; the detail text, the values and the rate
    lists of a finding never leave this function."""
    groups = {}
    for f in report["findings"]:
        key = (f["kind"], f["check"].split("[")[0], f.get("product"))
        g = groups.setdefault(key, {"kind": key[0], "check": key[1], "product": key[2], "count": 0, "first_ms": None, "last_ms": None})
        g["count"] += int(f.get("count", 1)) if f.get("count") is not None and key[1] == "funding.publication" else 1
        for name in ("bucket_start", "start_ms", "first_start_ms", "first_missing_ms"):
            if f.get(name) is not None:
                g["first_ms"] = f[name] if g["first_ms"] is None else min(g["first_ms"], f[name])
                g["last_ms"] = f[name] if g["last_ms"] is None else max(g["last_ms"], f[name])
    event_counts = {}
    for e in report["events"]:
        event_counts[e["event"]] = event_counts.get(e["event"], 0) + int(e.get("count", 1))
    return {"fitness": report["fitness"], "counts": report["counts"], "coverage": report["coverage"],
            "parameters": report["parameters"], "findings_by_check": sorted(
                groups.values(), key=lambda g: (g["kind"], g["check"], str(g["product"]))),
            "events": event_counts, "validator_version": report["validator_version"], "report_fingerprint": report["fingerprint"]}


def evaluate(official_rows, own_rows, period_rows, responses):
    """Both reports (candles: BTC, window B; funding: both products, window A) and the aggregates of 2a to 2d."""
    candles_own, own_summary = own_minutes(own_rows)
    sample_b = {"source": "dev-live/%s" % DB_NAME, "version": TOOL_VERSION, "from_ms": WINDOW_B[0], "to_ms": WINDOW_B[1],
                "products": [BTC], "holdout_exception": list(HOLDOUT_WINDOW)}
    candles = cv.validate_candles(BTC, candles_own, official_5m(official_rows), WINDOW_B[0], WINDOW_B[1],
                                  holdout_window=HOLDOUT_WINDOW)
    periods, polls, adapter_events = funding_inputs(period_rows, responses)
    sample_a = {"source": "dev-live/%s" % DB_NAME, "version": TOOL_VERSION, "from_ms": WINDOW_A[0], "to_ms": WINDOW_A[1],
                "products": list(PRODUCTS), "holdout_exception": list(HOLDOUT_WINDOW)}
    funding = cv.validate_funding(periods, WINDOW_A[0], WINDOW_A[1], list(PRODUCTS), references=references(official_rows),
                                  responses=polls, holdout_window=HOLDOUT_WINDOW)
    return {
        "official_1m": summarize_official(official_rows),
        "own_1m": own_summary,
        "funding_rows": {"rows": len(period_rows), "responses_read": len(responses), "adapter": adapter_events},
        "candles_report": _summarize_report(cv.build_report(sample_b, [candles], ("candles"
                                                                                   ,))),
        "funding_report": _summarize_report(cv.build_report(sample_a, [funding], ("funding",))),
    }


# ---------------------------------------------------------------------------------------------------- run

def _identity(path):
    st = os.stat(path)
    return {"db_name": os.path.basename(path), "size_bytes": st.st_size, "mtime_ns": st.st_mtime_ns,
            "regular_file_not_a_link": os.path.isfile(path) and not os.path.islink(path)}


def build_result(conn, started=None):
    started = time.monotonic() if started is None else started
    result = {"tool_version": TOOL_VERSION, "decisions": list(DECISIONS), "products": list(PRODUCTS),
              "window_a_ms": list(WINDOW_A), "window_b_ms": list(WINDOW_B), "caps": CAPS, "body_bytes_cap": MAX_BODY_BYTES,
              "query_time_limit_s": QUERY_TIMEOUT_S, "run_time_limit_s": RUN_TIMEOUT_S, "holdout_exception": list(HOLDOUT_WINDOW),
              "note": "Aggregates only: no series, price, rate, volume or response body is published. Our recording against the "
                      "official series and the provider's units, for these windows and products; not Kraken's timing, not "
                      "quotes, not a session warm-up.", "stopped": None}
    guard = None
    try:
        readback = conn.execute("PRAGMA query_only").fetchone()[0]       # before the authorizer, which denies every pragma
        result["guards"] = {"opened_with": "mode=ro", "query_only_readback": readback}
        if readback != 1:
            raise Stopped("connection_not_query_only")
        guard = _Guard(conn, started)
        ledger = Ledger()
        result["_ledger"] = ledger
        official = read_2a(guard, ledger)
        own = read_2b(guard, ledger)
        periods = read_2c(guard, ledger)
        responses = read_2d(guard, ledger)
        result["reads"] = ledger.entries
        result["evaluation"] = evaluate(official, own, periods, responses)
    except Stopped as stop:
        result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
    except sqlite3.DatabaseError as exc:
        result["stopped"] = {"reason": "database_error", "detail": "%s: %s" % (type(exc).__name__, exc)}
    except ValueError as exc:                       # a validator refused its input: the tool's problem, published
        result["stopped"] = {"reason": "validator_refused", "detail": str(exc)}
    finally:
        if guard is not None:
            guard.close()
    ledger = result.pop("_ledger", None)
    if ledger is not None:
        result["reads"] = ledger.entries
    return result


def fingerprint(result):
    body = {k: v for k, v in result.items() if k != "fingerprint_sha256"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def check_identity(path):
    """Refuse a file that is not the identified live capture. Returns the identity or raises ``Stopped``."""
    identity = _identity(path)
    parent = os.path.basename(os.path.dirname(os.path.abspath(path)))
    if identity["db_name"] != DB_NAME or parent != DB_DIR:
        raise Stopped("identity", "the file must be %s/%s" % (DB_DIR, DB_NAME))
    if not identity["regular_file_not_a_link"]:
        raise Stopped("identity", "not a regular file")
    if identity["size_bytes"] < MIN_SIZE_BYTES:
        raise Stopped("identity", "smaller than the file identified in BAL-IDENTIFICACION-183-01")
    return identity


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True, help="local live-capture database (opened read-only)")
    args = ap.parse_args(argv)
    started = time.monotonic()
    try:
        before = check_identity(args.db)
    except (Stopped, OSError) as error:
        reason = error.reason if isinstance(error, Stopped) else "identity"
        sys.stderr.write("refused: %s %s\n" % (reason, getattr(error, "detail", error)))
        return 2
    conn = _open_readonly(args.db)
    try:
        result = build_result(conn, started)
    finally:
        conn.close()
    result["source"] = {"before": before, "after": _identity(args.db), "elapsed_s": round(time.monotonic() - started, 3)}
    result["fingerprint_sha256"] = fingerprint(result)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 2 if result["stopped"] else 0


if __name__ == "__main__":
    sys.exit(main())
