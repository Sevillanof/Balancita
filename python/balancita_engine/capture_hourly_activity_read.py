"""Hourly activity of the capture, 2026-10-08T23:00Z to 2026-10-12T00:00Z: DRAFT, never run on real data.

BAL-RESULTADO-183-CONTROL-01 showed that retention did not empty the XBT window of 2026-10-11T00:00Z to 06:00Z, so it is empty for another
reason. This read tells "the capture process left no trace at all" apart from "it left traces but stored no market events": per hour,
the rows each part of the capture stored. Only timestamps (hour buckets), product ids, feed names and counts are published.

Parts (all in ``dev-live/futures-market.sqlite``, ``mode=ro`` + ``query_only``; BAL-DECISION-183-15):
- ``paper_futures_market_events``: trades and books (total, per product, per feed), written by the capture's sockets (live-capture.ts). Tickers
  (1 s poll) older than 24 h are deleted by design, so ticker counts of this window are NOT informative: they are published apart as
  ``ticker_rows`` with ``ticker_informative`` false and never enter ``rows`` or an inference. Trades and books are deleted by the retention
  (unknown real value; the control showed it did not empty 11-oct) and the retention keeps moving: the oldest surviving event is read in THE SAME RUN
  and every hour that starts before the hour after it is marked ``retention_possible`` and left out of the inferences;
- ``paper_futures_analytics_responses``: Kraken analytics polled over REST every 60 s and written ONLY by live-capture.ts, stored when the content is
  new (``INSERT OR IGNORE`` on the response hash): a count above 0 means that process was alive and fetching; 0 does not prove it was down;
- ``paper_futures_official_candle_responses``: official candle fetches. They are ALSO written by the manual command official-candles-backfill-cli.ts,
  so they are reported but are NOT a sign that the capture was alive and never enter an inference;
- ``paper_futures_candle_revisions``: own XBT 1m candles, counted as DISTINCT BUCKETS per hour (a candle has dozens of revisions, so walking them is
  costly and says nothing more): the next bucket is found by one single-row read on the primary key, at most ``MAX_BUCKETS`` per hour (an hour with
  more is ``over_cap`` and publishes no count). Never deleted by retention; a trigger forbids deleting them.

How it reads, without a scan: the hour boundaries are found by bisection on ``rowid`` (rowid grows with the reception time, which is what the
store's own retention assumes; single-row reads; an empty table counts as zero rows in every hour). Each hour is then one range read over the primary key (``rowid >= a AND rowid < b``, or the
candle primary-key prefix) with ``LIMIT cap + 1``: an hour over the cap is reported as ``over_cap`` and its rows are NOT published as a count.
Rows whose own timestamp falls outside their hour are counted as ``misplaced`` (a non-monotone table); the run never hides them.
Every statement is EXPLAINed once (SEARCH only: a table scan or a temporary B-tree stops the run), 60 s per statement, 10 min per run,
no retry, no widening. Parts run in this order, the ones that answer the question first: events, analytics, own candles, official responses; a stop
keeps every part and hour already finished. Caps are required: events (``--max-events-hour``, ``--max-events-table``) and the small walked parts
analytics and official responses (``--max-small-hour``, ``--max-small-table``); over a table cap the run stops with ``row_budget``. The caps are CEILINGS from rowid ranges (they count insertions, deleted tickers included), not measured counts.

Inferences are printed in ``inferences``: they only say which hours have rows in some part and which in none. They do not say why.

Usage:
    python3 -m balancita_engine.capture_hourly_activity_read --db <futures-market.sqlite> --max-events-hour N --max-events-table M --max-small-hour K --max-small-table L > out.json
"""
import argparse
import json
import sqlite3
import sys
import time

from . import capture_gap_diagnosis as g
from . import capture_minimal_read as m

TOOL_VERSION = "capture-hourly-activity-read.v2"
TICKER_KEEP_MS = 24 * m.HOUR_MS
HOUR_MS = m.HOUR_MS
START_MS = m.WINDOW_B[0] - 49 * HOUR_MS        # 2026-10-08T23:00Z
END_MS = m.WINDOW_B[0] + 24 * HOUR_MS          # 2026-10-12T00:00Z
HOURS = (END_MS - START_MS) // HOUR_MS         # 73
XBT = m.BTC
EVENTS, ANALYTICS, OFFICIAL, REVS = (g.EVENTS, "paper_futures_analytics_responses", "paper_futures_official_candle_responses",
                                     "paper_futures_candle_revisions")
PK_REVS = m.PK_REVISIONS
MAX_BUCKETS = 60                                # 1m buckets in an hour; a 61st read in the same hour means the hour is over_cap
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
ALLOWED["walk_candles"] = {REVS: {"candle_id", "interval_ms", "bucket_start"}}


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


def sql_next_bucket():
    return ("SELECT bucket_start FROM %s INDEXED BY %s WHERE candle_id >= ? AND candle_id < ? AND interval_ms = %d "
            "ORDER BY candle_id LIMIT 1" % (REVS, PK_REVS, m.MINUTE_MS))


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


SMALL = ("analytics", "official", "candles")


def retention_boundary(oldest_ms):
    """Start of the hour after the hour of the oldest surviving event: an hour that starts before it may have been trimmed by retention."""
    return END_MS if oldest_ms is None else (oldest_ms // HOUR_MS + 1) * HOUR_MS


def read_part(guard, part, cuts, hour_cap, table_cap, counter, hours, flags):
    """One range read per hour. Hours are appended as they finish, so a stop keeps every hour already done."""
    if cuts is None:                        # an empty table has zero rows in every hour: that is a finding, not a missing read
        cuts = [0] * (HOURS + 1)
    sql = sql_walk(part, hour_cap + 1)
    for k in range(HOURS):
        lo, hi = cuts[k], cuts[k + 1]
        h0, h1 = START_MS + k * HOUR_MS, START_MS + (k + 1) * HOUR_MS
        entry = {"start_ms": h0, "rows": 0, "over_cap": False, "misplaced": 0, "by_product": {}}
        if part == "events":
            entry.update(by_feed={}, ticker_rows=0, ticker_informative=flags["ticker_informative"](h1),
                         retention_possible=h0 < flags["retention_boundary_ms"])
        if hi > lo:
            rows = guard.fetch("walk_" + part, sql, (lo, hi))
            counter.walk(part, len(rows))
            if len(rows) > hour_cap:
                entry["over_cap"] = True
                for key in ("by_product", "by_feed", "ticker_rows"):
                    entry.pop(key, None)
                hours[part].append(entry)
                if counter.walked.get(part, 0) > table_cap:
                    raise m.Stopped("row_budget", {"stage": part, "cap": table_cap, "after_hour": h0})
                continue
            for row in rows:
                at, product = row[0], row[1]
                if not h0 <= at < h1:
                    entry["misplaced"] += 1
                    continue
                if part == "events" and row[2] == "ticker":
                    entry["ticker_rows"] += 1            # kept apart: tickers older than 24 h are deleted by design
                    continue
                entry["rows"] += 1
                entry["by_product"][product] = entry["by_product"].get(product, 0) + 1
                if part == "events":
                    entry["by_feed"][row[2]] = entry["by_feed"].get(row[2], 0) + 1
        hours[part].append(entry)
        if counter.walked.get(part, 0) > table_cap:
            raise m.Stopped("row_budget", {"stage": part, "cap": table_cap, "after_hour": h0})


def read_candles(guard, counter, hours):
    """Distinct own XBT 1m buckets per hour, by seeking the next bucket on the primary key (one single-row read each)."""
    sql = sql_next_bucket()
    for k in range(HOURS):
        h0, h1 = START_MS + k * HOUR_MS, START_MS + (k + 1) * HOUR_MS
        seen, key, over = 0, candle_key(h0), False
        while True:
            rows = guard.fetch("walk_candles", sql, (key, candle_key(h1)))
            counter.one()
            if not rows:
                break
            seen += 1
            if seen > MAX_BUCKETS:
                over = True
                break
            key = candle_key(rows[0][0] + 1)
        hours["candles"].append({"start_ms": h0, "distinct_buckets": None if over else seen, "over_cap": over})


def _has(entry):
    """True / False when the hour has rows in this part; an hour over its cap has (more than the cap)."""
    if entry is None:
        return None
    if entry.get("over_cap"):
        return True
    return (entry["distinct_buckets"] if "distinct_buckets" in entry else entry["rows"]) > 0


def inferences(hours):
    """Which hours have rows in which part. Never why. Hours that retention may have trimmed are left out; official responses never count."""
    by_start = {}
    for part, entries in hours.items():
        for e in entries:
            by_start.setdefault(e["start_ms"], {})[part] = e
    out = {"hours_without_events_with_analytics": [], "hours_without_any_row": [], "hours_retention_possible": [], "hours_with_misplaced_rows": []}
    for start in sorted(by_start):
        parts = by_start[start]
        if not all(p in parts for p in ("events", "analytics", "candles")):
            continue
        if parts["events"].get("retention_possible"):
            out["hours_retention_possible"].append(start)          # not informative about events: retention may have deleted them
            continue
        no_events = _has(parts["events"]) is False
        if no_events and _has(parts["analytics"]) is True:
            out["hours_without_events_with_analytics"].append(start)
        if no_events and _has(parts["analytics"]) is False and _has(parts["candles"]) is False:
            out["hours_without_any_row"].append(start)
    out["hours_with_misplaced_rows"] = [s for s in sorted(by_start) if any(e.get("misplaced") for e in by_start[s].values())]
    out["says"] = {
        "hours_without_events_with_analytics": "live-capture.ts stored new analytics responses in an hour with no stored trades or books (retention cannot "
                                               "explain it: the hour starts after the oldest surviving event's hour): that process was running and its "
                                               "market-event stream stored nothing",
        "hours_without_any_row": "no trade, book, analytics or own-candle row in the hour (retention cannot explain the events): no trace of the capture "
                                 "process; consistent with it being down, not proof (unchanged analytics responses are not stored)",
        "hours_retention_possible": "the hour starts before the hour after the oldest surviving event: retention may have trimmed its events, so it says "
                                    "nothing about the capture",
        "hours_with_misplaced_rows": "rows whose timestamp is outside the hour found by rowid: the table is not monotone there, so its counts are not reliable",
    }
    out["does_not_say"] = ["why the stream stored nothing", "whether Kraken or the network was at fault", "the real retention configuration",
                           "anything from ticker counts (older than 24 h, deleted by design)",
                           "anything from official candle responses (also written by the manual command official-candles-backfill-cli.ts)"]
    return out


def build_result(conn, *, max_events_hour, max_events_table, max_small_hour, max_small_table, read_date_ms, started=None):
    started = started if started is not None else time.monotonic()
    for value, name in ((max_events_hour, "max_events_hour"), (max_events_table, "max_events_table"),
                        (max_small_hour, "max_small_hour"), (max_small_table, "max_small_table")):
        g._valid_cap(value, name)
    result = {"tool_version": TOOL_VERSION, "sqlite_version": sqlite3.sqlite_version, "read_date_ms": read_date_ms,
              "caps": {"events_hour": max_events_hour, "events_table": max_events_table, "small_hour": max_small_hour,
                       "small_table": max_small_table},
              "stopped": None, "window_ms": [START_MS, END_MS], "hours": HOURS,
              "note": "Aggregates only: hour buckets, product ids, feed names and counts. Inferences say which hours have rows, never why."}
    if conn.execute("PRAGMA query_only").fetchone()[0] != 1:
        raise m.Stopped("guard", "query_only was not on")
    result["guards"] = {"opened_with": "mode=ro", "query_only_readback": 1}
    if sqlite3.sqlite_version_info < m.MIN_SQLITE:
        raise m.Stopped("sqlite_version", sqlite3.sqlite_version)
    max_single = len(TABLE) * (2 + (HOURS + 1) * SINGLE_PER_BOUNDARY) + 1 + HOURS * (MAX_BUCKETS + 2)
    guard, counter = _Guard(conn, started), Counter(max_single)
    hours = {"events": [], "analytics": [], "official": [], "candles": []}
    flags = {"retention_boundary_ms": END_MS, "ticker_informative": lambda hour_end: hour_end > read_date_ms - TICKER_KEEP_MS}
    try:
        try:
            oldest = guard.fetch("bisect_events", sql_bisect("events"), (0,))      # the oldest surviving event, in THIS run
            counter.one()
            result["oldest_event"] = {"rowid": oldest[0][0], "received_at": oldest[0][1]} if oldest else None
            flags["retention_boundary_ms"] = retention_boundary(oldest[0][1] if oldest else None)
            result["retention_boundary_ms"] = flags["retention_boundary_ms"]
            # the parts that answer the question first; a stop keeps everything already finished
            cuts = boundaries(guard, "events", counter)
            read_part(guard, "events", cuts, max_events_hour, max_events_table, counter, hours, flags)
            cuts = boundaries(guard, "analytics", counter)
            read_part(guard, "analytics", cuts, max_small_hour, max_small_table, counter, hours, flags)
            read_candles(guard, counter, hours)
            cuts = boundaries(guard, "official", counter)
            read_part(guard, "official", cuts, max_small_hour, max_small_table, counter, hours, flags)
        except m.Stopped as stop:
            result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
    finally:
        guard.close()
    result["hours_by_part"] = hours
    result["inferences"] = inferences(hours)
    result["rows_read"] = {"single_row_reads": counter.single, "single_row_cap": max_single, "walked_by_part": counter.walked,
                           "total_cap": max_single + max_events_table + max_events_hour + 1 + 2 * (max_small_table + max_small_hour + 1)}
    result["plans"] = sorted({d for details in guard.planned.values() for d in details})
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True)
    ap.add_argument("--max-events-hour", required=True, type=int, help="cap on events per hour; an hour over it is reported as over_cap; no default")
    ap.add_argument("--max-events-table", required=True, type=int, help="cap on the events walked in total; no default")
    ap.add_argument("--max-small-hour", required=True, type=int, help="cap per hour of analytics and official responses; no default")
    ap.add_argument("--max-small-table", required=True, type=int, help="cap walked in total per small part (analytics, official); no default")
    args = ap.parse_args(argv)
    started = time.monotonic()
    try:
        before = m.check_identity(args.db)
        for value, name in ((args.max_events_hour, "max_events_hour"), (args.max_events_table, "max_events_table"),
                            (args.max_small_hour, "max_small_hour"), (args.max_small_table, "max_small_table")):
            g._valid_cap(value, name)
    except (m.Stopped, OSError) as error:
        sys.stderr.write("refused: %s %s\n" % (getattr(error, "reason", "identity"), getattr(error, "detail", error)))
        return 2
    conn = m._open_readonly(args.db)
    try:
        result = build_result(conn, max_events_hour=args.max_events_hour, max_events_table=args.max_events_table,
                              max_small_hour=args.max_small_hour, max_small_table=args.max_small_table,
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
