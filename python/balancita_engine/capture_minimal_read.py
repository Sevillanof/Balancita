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
- 2c  funding periods that START in the 2a window, both products, at most 600 reads of the stage (rows of 2c itself: at most 400 returned);
- 2d  funding responses RECEIVED in the 2a window, both products, at most 1 200 reads of the stage and 200 MB; each body is parsed in memory
      by ``funding_adapter`` only to take the relative rate, ``serverTime`` and which periods are definitive.

Guards, the same family as ``capture_warmup_availability`` (Etapa 10):
- the file must be a regular file (not a link) called ``futures-market.sqlite`` in a directory called ``dev-live``, at least
  as large as the one identified in BAL-IDENTIFICACION-183-01 (the file only grows); size and mtime are published before and
  after;
- ``mode=ro`` and ``PRAGMA query_only`` read back (must be 1); a SQLite authorizer allows, per statement, only the tables and
  columns of that statement, and denies every write, pragma and attach;
- no COUNT pre-count: every statement is bounded by ``LIMIT <cap> + 1`` and the run stops with ``row_budget`` if more than the
  cap comes back (nothing is sampled, truncated or retried);
- 2c and 2d filter columns without an index, so they do not walk the tables: the tables are append-only and immutable and their
  time columns are written at insertion, so ``rowid`` order is time order. A binary search over ``rowid`` (single-row reads,
  all counted and published) finds the rowid range of the window, its width is an upper bound of what the read walks and is
  checked against the cap BEFORE any row is read, and the read is ``WHERE rowid >= ? AND rowid < ?`` with the ``LIMIT`` inside
  the subquery. The border rows are checked (the one at the bound qualifies, the one before does not); if the order did not
  hold, the run stops with ``rowid_order``. 2c's range covers ``known_at`` from one hour before the window to three after
  (declared margins); rows outside the window are dropped in memory and counted;
- ``EXPLAIN QUERY PLAN`` runs first: every statement must show a SEARCH on the primary key (or rowid) and no temporary sort;
- the size of each response is read with ``octet_length`` (SQLite >= 3.43, else the run stops) so the 200 MB cap is checked
  without reading the bodies; each stage that was read is evaluated and published even if a later one stops the run;
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
# 2c and 2d: reads of the whole stage (BAL-DECISION-183-11, Fran 2026-10-15 20:03:52Z); 2a and 2b: BAL-DECISION-185-02
CAPS = {"2a": 12_000, "2b": 100_000, "2c": 600, "2d": 1_200}
MAX_BODY_BYTES = 200_000_000
TOTAL_ROWS_CAP = 173_000
HOUR_MS = 3_600_000
FUNDING_MARGIN_BEFORE_MS = HOUR_MS        # a period is first seen no earlier than the hour before it starts
FUNDING_MARGIN_AFTER_MS = 3 * HOUR_MS     # and, for the last hour of the window, up to its end + settle lag + one poll
MIN_SQLITE = (3, 43, 0)                   # octet_length() reads the size without reading the body
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

# statement mode -> {table: allowed columns}. The empty name is what SQLite reports for row access without a column; ``rowid``
# is the integer primary key SQLite walks for the bounded 2c/2d reads.
ALLOWED = {
    "2a": {_OFFICIAL: {"product_id", "interval_ms", "bucket_start", "revision_hash", "known_at", "open_price",
                       "high_price", "low_price", "close_price", "volume_btc"}},
    "2b": {_REVISIONS: {"candle_id", "interval_ms", "bucket_start", "revision", "known_at", "is_closed", "open_price",
                        "high_price", "low_price", "close_price", "volume_btc"}},
    "2c_bound": {_PERIODS: {"rowid", "known_at"}},
    "2c": {_PERIODS: {"rowid", "product_id", "start_ms", "end_ms", "funding_rate", "known_at", "unit", "response_sha256"}},
    "2d_bound": {_RESPONSES: {"rowid", "received_at"}},
    "2d_meta": {_RESPONSES: {"rowid", "sha256", "received_at"}},
    "2d_lookup": {_PERIODS: {"response_sha256", "product_id"}},
    "2d_size": {_RESPONSES: {"sha256", "raw_response"}},
    "2d_body": {_RESPONSES: {"sha256", "raw_response"}},
}


# 2a and 2b name the primary-key index: on the Mac (SQLite 3.51) the planner picked the secondary ``..._bucket`` index for 2b and
# needed a temporary sort (run of 2026-10-15 20:38Z stopped with ``query_plan``). With INDEXED BY the plan is the one reviewed, or the
# statement fails (fail closed) if that index is not there.
def _sql_2a(limit):
    return ("SELECT product_id, bucket_start, known_at, revision_hash, open_price, high_price, low_price, close_price, "
            "volume_btc FROM %s INDEXED BY %s WHERE product_id = ? AND interval_ms = %d AND bucket_start >= %d AND bucket_start < %d "
            "ORDER BY interval_ms, bucket_start, revision_hash LIMIT %d" % (_OFFICIAL, PK_CANDLES, MINUTE_MS, WINDOW_A[0], WINDOW_A[1], limit))


def _sql_2b(limit):
    lo, hi = "%s:%d:%d" % (BTC, MINUTE_MS, WINDOW_B[0]), "%s:%d:%d" % (BTC, MINUTE_MS, WINDOW_B[1])
    cases = ", ".join("CASE WHEN is_closed = 1 THEN %s END" % c for c in
                      ("open_price", "high_price", "low_price", "close_price", "volume_btc"))
    return ("SELECT bucket_start, revision, known_at, is_closed, %s FROM %s INDEXED BY %s WHERE candle_id >= '%s' AND candle_id < '%s' "
            "AND interval_ms = %d AND bucket_start >= %d AND bucket_start < %d ORDER BY candle_id, revision LIMIT %d"
            % (cases, _REVISIONS, PK_REVISIONS, lo, hi, MINUTE_MS, WINDOW_B[0], WINDOW_B[1], limit))


def _sql_2c(limit):
    """ONE pass over the rowid range, the LIMIT inside the subquery so it bounds what is WALKED. Every walked row gives its
    rowid and receipt time (for the order check); the other columns are NULL unless the row is XBT/ETH and starts in the
    window, decided in the OUTER query, so values of the other products never leave SQLite (D-212-05, D-212-08)."""
    keep = "w.product_id IN (%s) AND w.start_ms >= %d AND w.start_ms < %d" % (_P, WINDOW_A[0], WINDOW_A[1])
    cols = ", ".join("CASE WHEN %s THEN w.%s END" % (keep, c) for c in
                     ("product_id", "start_ms", "end_ms", "funding_rate", "unit", "response_sha256"))
    return ("SELECT w.rowid_, w.known_at, %s FROM (SELECT rowid AS rowid_, product_id, start_ms, end_ms, funding_rate, known_at, unit, "
            "response_sha256 FROM %s WHERE rowid >= ? AND rowid < ? ORDER BY rowid LIMIT %d) w" % (cols, _PERIODS, limit))


def _sql_2d_meta(limit):
    """ONE pass over the responses' rowid range, with no inner lookups: every walked row gives rowid and received_at, and the
    hash only when the response was received in the window. Product and size come from counted single-row reads."""
    return ("SELECT w.rowid_, w.received_at, CASE WHEN w.received_at >= %d AND w.received_at < %d THEN w.sha256 END FROM "
            "(SELECT rowid AS rowid_, sha256, received_at FROM %s WHERE rowid >= ? AND rowid < ? ORDER BY rowid LIMIT %d) w"
            % (WINDOW_A[0], WINDOW_A[1], _RESPONSES, limit))


def _sql_bound(table, column):
    return "SELECT rowid, %s FROM %s WHERE rowid >= ? ORDER BY rowid LIMIT 1" % (column, table)


SQL_2D_PRODUCT = "SELECT product_id FROM %s WHERE response_sha256 = ? LIMIT 1" % _PERIODS
SQL_2D_BODY = "SELECT raw_response FROM %s WHERE sha256 = ?" % _RESPONSES
# product of one response (primary key of the periods table) and, for XBT/ETH only, the size of its body (primary key of responses)
SQL_2D_PRODUCT = "SELECT product_id FROM %s WHERE response_sha256 = ? LIMIT 1" % _PERIODS
SQL_2D_SIZE = "SELECT octet_length(raw_response) FROM %s WHERE sha256 = ?" % _RESPONSES


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
        self.planned = {}
        conn.set_authorizer(self._authorize)
        conn.set_progress_handler(self._tick, PROGRESS_OPS)

    def _authorize(self, action, arg1, arg2, _db, _source):
        if action == sqlite3.SQLITE_READ:
            allowed = ALLOWED.get(self.mode, {}).get(arg1) if self.mode else None
            return sqlite3.SQLITE_OK if allowed is not None and (arg2 in allowed or arg2.lower() == "rowid" and "rowid" in allowed or arg2 == "") else sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_FUNCTION):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY  # no write, no pragma, no attach, no transaction control

    def _tick(self):
        now = time.monotonic()
        return 1 if (self.deadline is not None and now > self.deadline) or now - self.started > RUN_TIMEOUT_S else 0

    def _gate(self, mode, sql, params):
        """Every statement is planned once before it first runs: any SCAN of a table or temporary B-tree stops the run
        (D-212-13). A scan of the bounded subquery itself (``w``, a co-routine) is fine."""
        key = (mode, sql)
        if key in self.planned:
            return
        self.deadline = time.monotonic() + QUERY_TIMEOUT_S
        details = [r[3] for r in self.conn.execute("EXPLAIN QUERY PLAN " + sql, params).fetchall()]
        bad = [d for d in details if (d.startswith("SCAN") and "subquery" not in d and d.strip() not in ("SCAN w", "SCAN w1"))
               or "TEMP B-TREE" in d]
        if bad:
            raise Stopped("query_plan", {"stage": mode, "plan": details})
        self.planned[key] = details

    def fetch(self, mode, sql, params=()):
        self.mode = mode
        self.deadline = time.monotonic() + QUERY_TIMEOUT_S
        try:
            if not sql.startswith("EXPLAIN"):
                self._gate(mode, sql, params)
                self.deadline = time.monotonic() + QUERY_TIMEOUT_S
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
    """``EXPLAIN QUERY PLAN`` first. Required: a SEARCH using ``require_search``; forbidden: any table SCAN (a scan of the
    bounded subquery itself is fine) and any temporary B-tree."""
    rows = guard.fetch(mode, "EXPLAIN QUERY PLAN " + sql, params)
    details = [r[3] for r in rows]
    if require_search is not None:
        scans = [d for d in details if d.startswith("SCAN") and "subquery" not in d and d.strip() not in ("SCAN w", "SCAN w1")]
        ok = any(d.startswith("SEARCH") and require_search in d for d in details) and not scans and not any(
            "TEMP B-TREE" in d for d in details)
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


class Reads:
    """Every read of 2c and 2d, counted against its stage's cap BEFORE it is executed (BAL-REV-212-TOPE-EXACTO-01): the walk
    of the range, the bound searches and every single-row read (product, size, body). ``spend`` stops the run before the read
    that would exceed the cap; ``reserve`` holds back a read that is certain to follow (the body after its size)."""

    KINDS = ("2c_bound", "2d_bound", "2d_lookup", "2d_size", "2d_body")

    def __init__(self):
        self.count = {k: 0 for k in self.KINDS}
        self.used = {"2c": 0, "2d": 0}
        self.reserved = {"2c": 0, "2d": 0}

    def total(self):
        return sum(self.count.values())

    def _refuse(self, stage, kind, n):
        raise Stopped("row_budget", {"stage": stage, "cap": CAPS[stage], "used": self.used[stage], "reserved": self.reserved[stage],
                                     "next_read": kind, "next_reads": n})

    def fits(self, stage, n):
        if self.used[stage] + self.reserved[stage] + n > CAPS[stage]:
            self._refuse(stage, "precheck", n)

    def spend(self, stage, kind, n=1, reserve=0):
        if self.used[stage] + self.reserved[stage] + n + reserve > CAPS[stage]:
            self._refuse(stage, kind, n + reserve)
        self.used[stage] += n
        self.reserved[stage] += reserve
        if kind is not None:                  # the walk is counted by the ledger (rows walked), not as a single-row read
            self.count[kind] += n

    def spend_reserved(self, stage, kind):
        self.reserved[stage] -= 1
        self.used[stage] += 1
        self.count[kind] += 1


def _lower_bound(guard, mode, table, column, target, reads):
    """Smallest ``rowid`` whose ``column`` is >= ``target``, by binary search over the rowids (the tables are append-only,
    immutable and their time columns are written at insertion, so ``rowid`` order is time order). Returns
    ``(rowid, evidence)``; ``rowid`` is ``max + 1`` when no row qualifies."""
    stage = mode[:2]
    reads.spend(stage, mode, 2)                      # two one-row reads: the first and the last rowid (never both in one SELECT)
    lo_row = guard.fetch(mode, "SELECT min(rowid) FROM %s" % table)[0][0]
    hi_row = guard.fetch(mode, "SELECT max(rowid) FROM %s" % table)[0][0]
    if lo_row is None:
        return 0, {"empty": True}
    lo, hi = lo_row, hi_row + 1
    steps = 0
    while lo < hi:
        mid = (lo + hi) // 2
        reads.spend(stage, mode)
        row = guard.fetch(mode, _sql_bound(table, column), (mid,))
        steps += 1
        if not row:
            hi = mid
        elif row[0][1] >= target:
            hi = mid
        else:
            lo = row[0][0] + 1
        if steps > 64:
            raise Stopped("bound_search", {"table": table})
    # border check: the row at the bound qualifies and the one before it does not
    reads.spend(stage, mode, 2)
    before = guard.fetch(mode, "SELECT rowid, %s FROM %s WHERE rowid < ? ORDER BY rowid DESC LIMIT 1" % (column, table), (lo,))
    at = guard.fetch(mode, _sql_bound(table, column), (lo,))
    if (before and before[0][1] >= target) or (at and at[0][1] < target):
        raise Stopped("rowid_order", {"table": table, "column": column})
    return lo, {"bound_rowid": lo, "table_min_rowid": lo_row, "table_max_rowid": hi_row, "search_reads": steps + 4}


def _span(guard, mode, table, column, lo_ms, hi_ms, reads, stage, cap, ledger):
    """The rowid range [lo, hi) whose ``column`` covers ``[lo_ms, hi_ms)``. Its width is what the walk reads and is spent
    against the stage's cap BEFORE any row is read."""
    lo, ev_lo = _lower_bound(guard, mode, table, column, lo_ms, reads)
    hi, ev_hi = _lower_bound(guard, mode, table, column, hi_ms, reads)
    width = max(0, hi - lo)
    searches = reads.count[mode]
    evidence = {"rowid_from": lo, "rowid_to": hi, "walk_upper_bound": width, "search_reads": searches, "search": [ev_lo, ev_hi]}
    try:
        reads.spend(stage, None, width)
    except Stopped as stop:
        ledger.add(stage, 0, cap, None, **evidence, over_budget=True)
        stop.detail.update({"walk_upper_bound": width, "search_reads": searches, "rowid_span": [lo, hi]})
        raise
    return lo, hi, evidence


def _check_order(rows, table, column):
    """The receipt time must not decrease along the walked range (D-212-07); ``rows`` carry (rowid, time, ...)."""
    if any(b[1] < a[1] for a, b in zip(rows, rows[1:])):
        raise Stopped("rowid_order", {"table": table, "column": column, "inside_range": True})


def read_2c(guard, ledger, reads):
    """Funding periods that START in the window. Receipt time (``known_at``) of a period is the poll that first showed it, so
    the rowid range covers ``[A0 - FUNDING_MARGIN_BEFORE_MS, A1 + FUNDING_MARGIN_AFTER_MS)`` of ``known_at`` (declared margins).
    One pass: ``rows_walked`` is every row of the range, ``rows_returned`` only those of XBT/ETH starting in the window."""
    lo, hi, evidence = _span(guard, "2c_bound", _PERIODS, "known_at", WINDOW_A[0] - FUNDING_MARGIN_BEFORE_MS,
                             WINDOW_A[1] + FUNDING_MARGIN_AFTER_MS, reads, "2c", CAPS["2c"], ledger)
    width = evidence["walk_upper_bound"]
    sql = _sql_2c(width + 1)
    plan = _plan(guard, "2c", sql, (lo, hi), "INTEGER PRIMARY KEY")
    got = [tuple(r) for r in guard.fetch("2c", sql, (lo, hi))]
    out = [(r[2], r[3], r[4], r[5], r[1], r[6], r[7]) for r in got if r[2] is not None]
    ledger.add("2c", reads.used["2c"], CAPS["2c"], plan, rows_walked=len(got), rows_returned=len(out), **evidence)
    if len(got) > width:
        raise Stopped("row_budget", {"stage": "2c", "walked": len(got), "walk_upper_bound": width})
    _check_order(got, _PERIODS, "known_at")
    return out


def read_2d(guard, ledger, reads):
    """Responses of XBT/ETH received in the window. The stage's reads are counted together against the cap: the walk, the
    searches, one product read per response received in the window, and a size read and a body read per XBT/ETH response."""
    lo, hi, evidence = _span(guard, "2d_bound", _RESPONSES, "received_at", WINDOW_A[0], WINDOW_A[1], reads, "2d", CAPS["2d"], ledger)
    width = evidence["walk_upper_bound"]
    sql = _sql_2d_meta(width + 1)
    plan = _plan(guard, "2d_meta", sql, (lo, hi), "INTEGER PRIMARY KEY")
    got = [tuple(r) for r in guard.fetch("2d_meta", sql, (lo, hi))]
    if len(got) > width:
        raise Stopped("row_budget", {"stage": "2d", "walked": len(got), "walk_upper_bound": width})
    inside = [r for r in got if r[2] is not None]
    entry = dict(rows_walked=len(got), rows_in_window=len(inside), bytes_cap=MAX_BODY_BYTES, **evidence)
    try:
        reads.fits("2d", len(inside))                  # at least one product read for each response in the window
    except Stopped:
        ledger.add("2d", reads.used["2d"], CAPS["2d"], plan, rows_returned=0, **entry)
        raise
    _check_order(got, _RESPONSES, "received_at")
    targets, total = [], 0
    try:
        for _rowid, received_at, sha in inside:
            reads.spend("2d", "2d_lookup")
            row = guard.fetch("2d_lookup", SQL_2D_PRODUCT, (sha,))
            if len(row) != 1:
                raise Stopped("response_not_found", {"stage": "2d"})
            if row[0][0] in PRODUCTS:
                reads.spend("2d", "2d_size", 1, reserve=1)    # the size now, and the body read is held back
                size = guard.fetch("2d_size", SQL_2D_SIZE, (sha,))
                if len(size) != 1:
                    raise Stopped("response_not_found", {"stage": "2d"})
                targets.append((sha, received_at, row[0][0]))
                total += int(size[0][0] or 0)
    except Stopped:
        ledger.add("2d", reads.used["2d"], CAPS["2d"], plan, rows_returned=len(targets), bytes=total, **entry)
        raise
    ledger.add("2d", reads.used["2d"] + reads.reserved["2d"], CAPS["2d"], plan, rows_returned=len(targets), bytes=total, **entry)
    if total > MAX_BODY_BYTES:
        raise Stopped("byte_budget", {"stage": "2d", "bytes": total, "cap": MAX_BODY_BYTES})
    out = []
    for sha, received_at, product in targets:
        reads.spend_reserved("2d", "2d_body")
        body = guard.fetch("2d_body", SQL_2D_BODY, (sha,))
        if len(body) != 1:
            raise Stopped("response_not_found", {"stage": "2d"})
        out.append((sha, received_at, "", product, body[0][0]))
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


def evaluate_candles(official_rows, own_rows):
    """Candle report (BTC, window B, from 2a and 2b) and the aggregates of those two stages. Independent of funding."""
    candles_own, own_summary = own_minutes(own_rows)
    sample = {"source": "dev-live/%s" % DB_NAME, "version": TOOL_VERSION, "from_ms": WINDOW_B[0], "to_ms": WINDOW_B[1],
              "products": [BTC], "holdout_exception": list(HOLDOUT_WINDOW)}
    candles = cv.validate_candles(BTC, candles_own, official_5m(official_rows), WINDOW_B[0], WINDOW_B[1],
                                  holdout_window=HOLDOUT_WINDOW)
    return {"official_1m": summarize_official(official_rows), "own_1m": own_summary,
            "candles_report": _summarize_report(cv.build_report(sample, [candles], ("candles",)))}


def evaluate_funding(official_rows, period_rows, responses):
    """Funding report (both products, window A, from 2a, 2c and 2d)."""
    periods, polls, adapter_events = funding_inputs(period_rows, responses)
    sample = {"source": "dev-live/%s" % DB_NAME, "version": TOOL_VERSION, "from_ms": WINDOW_A[0], "to_ms": WINDOW_A[1],
              "products": list(PRODUCTS), "holdout_exception": list(HOLDOUT_WINDOW)}
    funding = cv.validate_funding(periods, WINDOW_A[0], WINDOW_A[1], list(PRODUCTS), references=references(official_rows),
                                  responses=polls, holdout_window=HOLDOUT_WINDOW)
    return {"funding_rows": {"rows": len(period_rows), "responses_read": len(responses), "adapter": adapter_events},
            "funding_report": _summarize_report(cv.build_report(sample, [funding], ("funding",)))}


def evaluate(official_rows, own_rows, period_rows, responses):
    out = evaluate_candles(official_rows, own_rows)
    out.update(evaluate_funding(official_rows, period_rows, responses))
    return out


# ---------------------------------------------------------------------------------------------------- run

def _identity(path):
    st = os.stat(path)
    return {"db_name": os.path.basename(path), "size_bytes": st.st_size, "mtime_ns": st.st_mtime_ns,
            "regular_file_not_a_link": os.path.isfile(path) and not os.path.islink(path)}


def stage_rows_needed():
    """Worst case of this tool, counting the extra row of ``LIMIT cap + 1`` in 2a and 2b: 12 001 + 100 001 + 600 + 1 200."""
    return CAPS["2a"] + 1 + CAPS["2b"] + 1 + CAPS["2c"] + CAPS["2d"]


def build_result(conn, started=None, *, prior_rows):
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
        need = stage_rows_needed()
        result["global_rows"] = {"cap": TOTAL_ROWS_CAP, "prior_rows_counted": prior_rows, "stage_rows_needed": need}
        if isinstance(prior_rows, bool) or not isinstance(prior_rows, int) or prior_rows < 0:
            raise Stopped("prior_rows", "prior_rows must be a non-negative integer")
        if prior_rows + need > TOTAL_ROWS_CAP:        # D-212-14: the total of 185-02 cannot be exceeded in any case; stop without reading
            raise Stopped("global_cap", {"cap": TOTAL_ROWS_CAP, "prior_rows": prior_rows, "stage_rows_needed": need,
                                         "remaining": TOTAL_ROWS_CAP - prior_rows})
        result["sqlite_version"] = sqlite3.sqlite_version
        if sqlite3.sqlite_version_info < MIN_SQLITE:
            raise Stopped("sqlite_version", "octet_length() needs SQLite >= 3.43")
        guard = _Guard(conn, started)
        ledger, reads = Ledger(), Reads()
        result["_ledger"], result["_reads"] = ledger, reads
        evaluation = result["evaluation"] = {}          # each stage's result is kept even if a later stage stops the run
        official = read_2a(guard, ledger)
        own = read_2b(guard, ledger)
        evaluation.update(evaluate_candles(official, own))
        periods = read_2c(guard, ledger, reads)
        responses = read_2d(guard, ledger, reads)
        evaluation.update(evaluate_funding(official, periods, responses))
    except Stopped as stop:
        result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
    except sqlite3.DatabaseError as exc:
        result["stopped"] = {"reason": "database_error", "detail": "%s: %s" % (type(exc).__name__, exc)}
    except ValueError as exc:                       # a validator refused its input: the tool's problem, published
        result["stopped"] = {"reason": "validator_refused", "detail": str(exc)}
    finally:
        if guard is not None:
            guard.close()
    ledger, reads = result.pop("_ledger", None), result.pop("_reads", None)
    if ledger is not None:
        result["reads"] = ledger.entries
        stage_rows = sum(e.get("rows_walked", e["rows"]) for e in ledger.entries)
        result["rows_total"] = {"statement_rows_walked": stage_rows, "statement_rows_returned": sum(e.get("rows_returned", e["rows"]) for e in ledger.entries), "single_row_reads": reads.total(), "single_row_reads_by_kind": reads.count,
                                "total": stage_rows + reads.total(), "cap": TOTAL_ROWS_CAP}
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
    ap.add_argument("--prior-first-rows", required=True, type=int,
                    help="rows counted by the first stage-1 run, as published in #185 (the 173 000 total is shared)")
    ap.add_argument("--prior-stage2-rows", required=True, type=int,
                    help="rows already counted by earlier attempts of THIS stage 2 (5760 for the run of 2026-10-15 20:38Z)")
    ap.add_argument("--prior-v2-rows", required=True, type=int,
                    help="rows counted by the repeated (v2) stage-1 run, as published in #185; it must run BEFORE this stage")
    args = ap.parse_args(argv)
    priors = {"prior-first-rows": args.prior_first_rows, "prior-v2-rows": args.prior_v2_rows,
              "prior-stage2-rows": args.prior_stage2_rows}
    bad = sorted(name for name, value in priors.items() if value < 0)
    if bad:                                    # D-212-16: a negative value could cancel another and hide consumed rows
        sys.stderr.write("refused: prior_rows each --%s must be >= 0\n" % ", --".join(bad))
        return 2
    started = time.monotonic()
    try:
        before = check_identity(args.db)
    except (Stopped, OSError) as error:
        reason = error.reason if isinstance(error, Stopped) else "identity"
        sys.stderr.write("refused: %s %s\n" % (reason, getattr(error, "detail", error)))
        return 2
    conn = _open_readonly(args.db)
    try:
        result = build_result(conn, started, prior_rows=args.prior_first_rows + args.prior_v2_rows + args.prior_stage2_rows)
    finally:
        conn.close()
    result["source"] = {"before": before, "after": _identity(args.db), "elapsed_s": round(time.monotonic() - started, 3)}
    result["fingerprint_sha256"] = fingerprint(result)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 2 if result["stopped"] else 0


if __name__ == "__main__":
    sys.exit(main())
