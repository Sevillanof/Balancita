"""Hourly activity of the capture, 2026-10-08T23:00Z to 2026-10-12T00:00Z: DRAFT, never run on real data.

BAL-RESULTADO-183-CONTROL-01 showed that retention did not empty the XBT window of 2026-10-11T00:00Z to 06:00Z, so it is empty for another
reason. This read tells "the capture process left no trace at all" apart from "it left traces but stored no market events": per hour,
the rows each part of the capture stored. Only timestamps (hour buckets), product ids, feed names and counts are published.

Parts (all in ``dev-live/futures-market.sqlite``, ``mode=ro`` + ``query_only``; BAL-DECISION-183-15):
- ``paper_futures_market_events``: websocket and ticker events (total, per product, per feed). Written by the capture's sockets and 1 s ticker poll;
  tickers older than 24 h and trades/books older than the retention are deleted (retention did not empty 11-oct, see the control result);
- ``paper_futures_analytics_responses``: Kraken analytics polled by the capture over REST every 60 s, stored when the content is new
  (``INSERT OR IGNORE`` on the response hash), so a count above 0 means the capture process was alive and fetching; 0 does not prove it was down;
- ``paper_futures_official_candle_responses``: official candle fetches, including the repair after a restart (``officialRepairMs``);
- ``paper_futures_candle_revisions``: own XBT 1m candle revisions (revisions and distinct buckets). Never deleted.

How it reads, without a scan: the hour boundaries are found by bisection on ``rowid`` (rowid grows with the reception time, which is what the
store's own retention assumes; single-row reads; an empty table counts as zero rows in every hour). Each hour is then one range read over the primary key (``rowid >= a AND rowid < b``, or the
candle primary-key prefix) with ``LIMIT cap + 1``: an hour over the cap is reported as ``over_cap`` and its rows are NOT published as a count.
Rows whose own timestamp falls outside their hour are counted as ``misplaced`` (a non-monotone table); the run never hides them.
Every statement is EXPLAINed once (SEARCH only: a table scan or a temporary B-tree stops the run), 60 s per statement, 10 min per run,
no retry, no widening. Caps are required: ``--max-hour-rows`` (per hour and part) and ``--max-table-rows`` (total walked per part; over it the
run stops with ``row_budget`` and keeps every hour already finished).

Inferences are printed in ``inferences``: they only say which hours have rows in some part and which in none. They do not say why.

Usage:
    python3 -m balancita_engine.capture_hourly_activity_read --db <futures-market.sqlite> --max-hour-rows N --max-table-rows M > out.json
"""
import argparse
import json
import sqlite3
import sys
import time

from . import capture_gap_diagnosis as g
from . import capture_minimal_read as m

TOOL_VERSION = "capture-hourly-activity-read.v1"
HOUR_MS = m.HOUR_MS
START_MS = m.WINDOW_B[0] - 49 * HOUR_MS        # 2026-10-08T23:00Z
END_MS = m.WINDOW_B[0] + 24 * HOUR_MS          # 2026-10-12T00:00Z
HOURS = (END_MS - START_MS) // HOUR_MS         # 73
XBT = m.BTC
EVENTS, ANALYTICS, OFFICIAL, REVS = (g.EVENTS, "paper_futures_analytics_responses", "paper_futures_official_candle_responses",
                                     "paper_futures_candle_revisions")
PK_REVS = m.PK_REVISIONS
BISECT_STEPS = 26                               # 2**26 > 67 million rowids: a bisection never needs more
SINGLE_PER_BOUNDARY = BISECT_STEPS + 1
PARTS = ("events", "analytics", "official")     # the three rowid tables; candles are read by primary-key prefix

TABLE = {"events": EVENTS, "analytics": ANALYTICS, "official": OFFICIAL}
WALK_COLUMNS = {"events": "received_at, product_id, feed", "analytics": "received_at, product_id", "official": "received_at, product_id"}

ALLOWED = {}
for _part, _table in TABLE.items():
    _walk = {"rowid", "received_at", "product_id"} | ({"feed"} if _part == "events" else set())
    ALLOWED["edge_" + _part] = {_table: {"rowid"}}
    ALLOWED["bisect_" + _part] = {_table: {"rowid", "received_at"}}
    ALLOWED["walk_" + _part] = {_table: _walk}
ALLOWED["walk_candles"] = {REVS: {"candle_id", "interval_ms", "bucket_start", "revision"}}


class _Guard(m._Guard):
    def _authorize(self, action, arg1, arg2, _db, _source):
        if action == sqlite3.SQLITE_READ:
            allowed = ALLOWED.get(self.mode, {}).get(arg1) if self.mode else None
            ok = allowed is not None and (arg2 in allowed or arg2 == "" or (arg2.lower() == "rowid" and "rowid" in allowed))
            return sqlite3.SQLITE_OK if ok else sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_FUNCTION):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY


def sql_edge(part, direction):
    order = "" if direction == "first" else " DESC"
    return "SELECT rowid FROM %s WHERE rowid >= 0 ORDER BY rowid%s LIMIT 1" % (TABLE[part], order)


def sql_bisect(part):
    return "SELECT rowid, received_at FROM %s WHERE rowid >= ? ORDER BY rowid LIMIT 1" % TABLE[part]


def sql_walk(part, limit):
    return ("SELECT %s FROM %s WHERE rowid >= ? AND rowid < ? ORDER BY rowid LIMIT %d" % (WALK_COLUMNS[part], TABLE[part], limit))


def sql_candles(limit):
    return ("SELECT bucket_start FROM %s INDEXED BY %s WHERE candle_id >= ? AND candle_id < ? AND interval_ms = %d "
            "ORDER BY candle_id, revision LIMIT %d" % (REVS, PK_REVS, m.MINUTE_MS, limit))


def candle_key(bucket_ms):
    return "%s:%d:%d" % (XBT, m.MINUTE_MS, bucket_ms)


class Counter:
    def __init__(self, max_single):
        self.single, self.walked, self.max_single = 0, {}, max_single

    def one(self):
        self.single += 1
        if self.single > self.max_single:
            raise m.Stopped("single_budget", {"cap": self.max_single})

    def walk(self, part, n):
        self.walked[part] = self.walked.get(part, 0) + n


def boundaries(guard, part, counter):
    """rowid of the first row received at or after each hour boundary (HOURS + 1 values), by bisection; None when the table is empty."""
    first = guard.fetch("edge_" + part, sql_edge(part, "first"))
    last = guard.fetch("edge_" + part, sql_edge(part, "last"))
    counter.single += 2
    if not first or not last:
        return None
    lo_all, hi_all = first[0][0], last[0][0] + 1
    out, lo = [], lo_all
    for k in range(HOURS + 1):
        target = START_MS + k * HOUR_MS
        hi = hi_all
        steps = 0
        while lo < hi:
            steps += 1
            if steps > BISECT_STEPS:
                raise m.Stopped("bisect", "more steps than the rowid range allows")
            mid = (lo + hi) // 2
            rows = guard.fetch("bisect_" + part, sql_bisect(part), (mid,))
            counter.one()
            if not rows or rows[0][1] >= target:
                hi = mid
            else:
                lo = max(mid, rows[0][0]) + 1
        out.append(lo)
    return out


def _hour_of(at):
    return (at - START_MS) // HOUR_MS


def read_part(guard, part, cuts, hour_cap, table_cap, counter, hours):
    """One range read per hour. Hours are appended as they finish, so a stop keeps every hour already done."""
    if cuts is None:                        # an empty table has zero rows in every hour: that is a finding, not a missing read
        cuts = [0] * (HOURS + 1)
    sql = sql_walk(part, hour_cap + 1)
    for k in range(HOURS):
        lo, hi = cuts[k], cuts[k + 1]
        h0, h1 = START_MS + k * HOUR_MS, START_MS + (k + 1) * HOUR_MS
        entry = {"start_ms": h0, "rows": 0, "over_cap": False, "misplaced": 0, "by_product": {}}
        if part == "events":
            entry["by_feed"] = {}
        if hi > lo:
            rows = guard.fetch("walk_" + part, sql, (lo, hi))
            counter.walk(part, len(rows))
            if len(rows) > hour_cap:
                entry["over_cap"] = True
                entry.pop("by_product")
                entry.pop("by_feed", None)
                hours[part].append(entry)
                if counter.walked.get(part, 0) > table_cap:
                    raise m.Stopped("row_budget", {"stage": part, "cap": table_cap, "after_hour": h0})
                continue
            for row in rows:
                at, product = row[0], row[1]
                if not h0 <= at < h1:
                    entry["misplaced"] += 1
                    continue
                entry["rows"] += 1
                entry["by_product"][product] = entry["by_product"].get(product, 0) + 1
                if part == "events":
                    entry["by_feed"][row[2]] = entry["by_feed"].get(row[2], 0) + 1
        hours[part].append(entry)
        if counter.walked.get(part, 0) > table_cap:
            raise m.Stopped("row_budget", {"stage": part, "cap": table_cap, "after_hour": h0})


def read_candles(guard, hour_cap, table_cap, counter, hours):
    sql = sql_candles(hour_cap + 1)
    for k in range(HOURS):
        h0, h1 = START_MS + k * HOUR_MS, START_MS + (k + 1) * HOUR_MS
        rows = guard.fetch("walk_candles", sql, (candle_key(h0), candle_key(h1)))
        counter.walk("candles", len(rows))
        entry = {"start_ms": h0, "revisions": len(rows), "distinct_buckets": len({b for (b,) in rows}), "over_cap": len(rows) > hour_cap,
                 "misplaced": sum(1 for (b,) in rows if not h0 <= b < h1)}
        if entry["over_cap"]:
            entry["revisions"] = entry["distinct_buckets"] = None
        hours["candles"].append(entry)
        if counter.walked.get("candles", 0) > table_cap:
            raise m.Stopped("row_budget", {"stage": "candles", "cap": table_cap, "after_hour": h0})


def _rows(entry):
    """Rows of an hour in any part, or None when it is unknown (over cap)."""
    if entry.get("over_cap"):
        return None
    return entry["revisions"] if "revisions" in entry else entry["rows"]


def inferences(hours):
    """Which hours have rows in which part. Never why. ``over_cap`` hours count as 'has rows' (more than the cap)."""
    by_start = {}
    for part, entries in hours.items():
        for e in entries:
            by_start.setdefault(e["start_ms"], {})[part] = e
    def has(entry):
        if entry is None:
            return None
        return True if entry.get("over_cap") else _rows(entry) > 0
    complete = [s for s in sorted(by_start) if all(p in by_start[s] for p in ("events", "analytics", "official"))]
    out = {"hours_without_events_with_analytics": [], "hours_without_any_row": [], "hours_with_misplaced_rows": []}
    for s in complete:
        parts = by_start[s]
        if has(parts["events"]) is False and has(parts["analytics"]) is True:
            out["hours_without_events_with_analytics"].append(s)
        if all(has(parts[p]) is False for p in ("events", "analytics", "official")) and (parts.get("candles") is None or has(parts["candles"]) is False):
            out["hours_without_any_row"].append(s)
    out["hours_with_misplaced_rows"] = [s for s in sorted(by_start) if any(e.get("misplaced") for e in by_start[s].values())]
    out["says"] = {
        "hours_without_events_with_analytics": "the capture's REST pollers stored new responses in an hour with no stored market events: the process was "
                                               "running then, and the websocket/ticker stream stored nothing (or all of it was deleted, which the control result "
                                               "excludes for 11-oct)",
        "hours_without_any_row": "no trace of the capture in any of these parts; consistent with the process being down, not proof (unchanged responses are "
                                 "not stored)",
        "hours_with_misplaced_rows": "rows whose timestamp is outside the hour found by rowid: the table is not monotone there, so its counts are not reliable",
    }
    out["does_not_say"] = ["why the stream stored nothing", "whether Kraken or the network was at fault", "the real retention configuration",
                           "anything about trades the capture never received"]
    return out


def build_result(conn, *, max_hour_rows, max_table_rows, read_date_ms, started=None):
    started = started if started is not None else time.monotonic()
    g._valid_cap(max_hour_rows, "max_hour_rows")
    g._valid_cap(max_table_rows, "max_table_rows")
    result = {"tool_version": TOOL_VERSION, "sqlite_version": sqlite3.sqlite_version, "read_date_ms": read_date_ms,
              "caps": {"hour_rows": max_hour_rows, "table_rows": max_table_rows}, "stopped": None,
              "window_ms": [START_MS, END_MS], "hours": HOURS,
              "note": "Aggregates only: hour buckets, product ids, feed names and counts. Inferences say which hours have rows, never why."}
    if conn.execute("PRAGMA query_only").fetchone()[0] != 1:
        raise m.Stopped("guard", "query_only was not on")
    result["guards"] = {"opened_with": "mode=ro", "query_only_readback": 1}
    if sqlite3.sqlite_version_info < m.MIN_SQLITE:
        raise m.Stopped("sqlite_version", sqlite3.sqlite_version)
    max_single = len(TABLE) * (2 + (HOURS + 1) * SINGLE_PER_BOUNDARY)
    guard, counter = _Guard(conn, started), Counter(max_single)
    hours = {"events": [], "analytics": [], "official": [], "candles": []}
    try:
        try:
            read_candles(guard, max_hour_rows, max_table_rows, counter, hours)          # small parts first
            for part in ("official", "analytics", "events"):
                cuts = boundaries(guard, part, counter)
                read_part(guard, part, cuts, max_hour_rows, max_table_rows, counter, hours)
        except m.Stopped as stop:
            result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
    finally:
        guard.close()
    result["hours_by_part"] = hours
    result["inferences"] = inferences(hours)
    result["rows_read"] = {"single_row_reads": counter.single, "single_row_cap": max_single, "walked_by_part": counter.walked,
                           "total_cap": max_single + 4 * (max_table_rows + max_hour_rows + 1)}
    result["plans"] = sorted({d for details in guard.planned.values() for d in details})
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True)
    ap.add_argument("--max-hour-rows", required=True, type=int, help="cap per hour and part; an hour over it is reported as over_cap; no default")
    ap.add_argument("--max-table-rows", required=True, type=int, help="cap on the rows walked per part; no default")
    args = ap.parse_args(argv)
    started = time.monotonic()
    try:
        before = m.check_identity(args.db)
        g._valid_cap(args.max_hour_rows, "max_hour_rows")
        g._valid_cap(args.max_table_rows, "max_table_rows")
    except (m.Stopped, OSError) as error:
        sys.stderr.write("refused: %s %s\n" % (getattr(error, "reason", "identity"), getattr(error, "detail", error)))
        return 2
    conn = m._open_readonly(args.db)
    try:
        result = build_result(conn, max_hour_rows=args.max_hour_rows, max_table_rows=args.max_table_rows,
                              read_date_ms=int(time.time() * 1000), started=started)
    finally:
        conn.close()
    result["source"] = {"before": before, "after": m._identity(args.db), "elapsed_s": round(time.monotonic() - started, 3)}
    result["fingerprint_sha256"] = m.fingerprint(result)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 2 if result["stopped"] else 0


if __name__ == "__main__":
    sys.exit(main())
