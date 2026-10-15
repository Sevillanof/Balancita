"""Control read for the empty XBT window of 2026-10-11T00:00Z to 06:00Z: DRAFT, never run on real data.

The first diagnosis (capture_gap_diagnosis, BAL-RESULTADO-183-VELAS-PROPIAS-01) found 0 events and 0 gaps in the window, which
does not tell "never recorded" from "already deleted" (events are deleted by ``received_at`` after
``FUTURES_EVENT_RETENTION_DAYS``, default 7). This control gives the facts that tell them apart. Only timestamps and hourly counts
are published; no price, quantity, body or id.

Scope (BAL-DECISION-183-15; each real run is published here BEFORE it runs, with D's review and a green CI on the exact head):
- ``dev-live/futures-market.sqlite`` only, ``mode=ro`` + ``query_only`` read back, identity before/after, no copy, no Kraken;
- BOUNDS (single-row reads, every one counted): the oldest and newest ``received_at`` of ``paper_futures_market_events`` overall
  (by ``rowid``, which retention deletes in order), of XBT and of ETH (by ``paper_futures_market_received``); the oldest and newest
  ``detected_at`` of ``paper_futures_data_gaps``; the oldest and newest own XBT 1m candle bucket (``paper_futures_candle_revisions``
  primary key, ``candle_id`` range, ``bucket_start`` only). If events older than the window still exist, retention did not purge it;
- WITNESSES: events per hour and feed of XBT in [2026-10-11T06:00Z, 12:00Z) and of ETH in [2026-10-11T00:00Z, 06:00Z) (ETH has no own
  trades or candles by design, so an empty ETH witness proves nothing), and the number of own XBT 1m candles per hour in
  [2026-10-11T06:00Z, 12:00Z). Each witness walks every event of the product in its window (books included) and is bounded by
  ``--max-events`` (``LIMIT max + 1`` inside the statement; over the cap stops the run with ``row_budget`` and publishes the bounds
  already read); candles by ``--max-candles``. Counting is done in memory, no GROUP BY;
- every statement is EXPLAINed first (SEARCH only: any table SCAN or temporary B-tree stops the run), 60 s per statement, 10 min per
  run, no retry, no sampling, no widening; total rows read are counted and published.

Retention itself is confirmed from the code (``capture-main.ts``: ``eventRetentionMs`` from ``FUTURES_EVENT_RETENTION_DAYS``, default 7,
cutoff on ``received_at``); the real environment value is not readable from the database and is not assumed.

Usage:
    python3 -m balancita_engine.capture_control_read --db <futures-market.sqlite> --max-events N --max-candles M > out.json
"""
import argparse
import json
import sqlite3
import sys
import time

from . import capture_gap_diagnosis as g
from . import capture_minimal_read as m

TOOL_VERSION = "capture-control-read.v1"
HOUR_MS = m.HOUR_MS
DAY0 = m.WINDOW_B[0]                                         # 2026-10-11T00:00Z
WINDOW_XBT_AFTER = (DAY0 + 6 * HOUR_MS, DAY0 + 12 * HOUR_MS)  # [06:00Z, 12:00Z)
WINDOW_ETH_SAME = m.WINDOW_B                                  # [00:00Z, 06:00Z)
XBT, ETH = m.BTC, m.ETH
EVENTS, GAPS, REVS = g.EVENTS, g.GAPS, "paper_futures_candle_revisions"
IDX_EVENTS, IDX_GAPS = g.IDX_EVENTS, g.IDX_GAPS
PK_REVS = m.PK_REVISIONS

ALLOWED = {
    "bound_rowid": {EVENTS: {"rowid", "received_at"}},
    "bound_product": {EVENTS: {"product_id", "received_at"}},
    "bound_gaps": {GAPS: {"detected_at"}},
    "bound_candles": {REVS: {"candle_id", "interval_ms", "bucket_start", "revision"}},
    "witness_events": {EVENTS: {"feed", "product_id", "received_at", "seq"}},
    "witness_candles": {REVS: {"candle_id", "interval_ms", "bucket_start", "revision"}},
}


class _Guard(m._Guard):
    def _authorize(self, action, arg1, arg2, _db, _source):
        if action == sqlite3.SQLITE_READ:
            allowed = ALLOWED.get(self.mode, {}).get(arg1) if self.mode else None
            ok = allowed is not None and (arg2 in allowed or arg2 == "" or (arg2.lower() == "rowid" and "rowid" in allowed))
            return sqlite3.SQLITE_OK if ok else sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_FUNCTION):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY


def _candle_range(day_from, day_to):
    return ("%s:%d:%d" % (XBT, m.MINUTE_MS, day_from), "%s:%d:%d" % (XBT, m.MINUTE_MS, day_to))


SQL_BOUND_ROWID = {
    "oldest": "SELECT received_at FROM %s WHERE rowid >= 0 ORDER BY rowid LIMIT 1" % EVENTS,
    "newest": "SELECT received_at FROM %s WHERE rowid >= 0 ORDER BY rowid DESC LIMIT 1" % EVENTS,
}


def _sql_bound_product(direction):
    order = "" if direction == "oldest" else " DESC"
    return ("SELECT received_at FROM %s INDEXED BY %s WHERE product_id = ? ORDER BY received_at%s LIMIT 1"
            % (EVENTS, IDX_EVENTS, order))


def _sql_bound_gaps(direction):
    order = "" if direction == "oldest" else " DESC"
    return ("SELECT detected_at FROM %s INDEXED BY %s WHERE detected_at >= 0 ORDER BY detected_at%s LIMIT 1"
            % (GAPS, IDX_GAPS, order))


def _sql_bound_candles(direction):
    lo, hi = "%s:%d:" % (XBT, m.MINUTE_MS), "%s:%d;" % (XBT, m.MINUTE_MS)      # ';' follows ':' so this is the whole prefix
    order = "candle_id, revision" if direction == "oldest" else "candle_id DESC, revision DESC"
    return ("SELECT bucket_start FROM %s INDEXED BY %s WHERE candle_id >= '%s' AND candle_id < '%s' ORDER BY %s LIMIT 1"
            % (REVS, PK_REVS, lo, hi, order))


def _sql_witness_events(window, limit):
    return ("SELECT feed, received_at FROM %s INDEXED BY %s WHERE product_id = ? AND received_at >= %d AND received_at < %d "
            "ORDER BY received_at, seq LIMIT %d" % (EVENTS, IDX_EVENTS, window[0], window[1], limit))


def _sql_witness_candles(window, limit):
    lo, hi = _candle_range(*window)
    return ("SELECT bucket_start FROM %s INDEXED BY %s WHERE candle_id >= '%s' AND candle_id < '%s' AND interval_ms = %d "
            "AND bucket_start >= %d AND bucket_start < %d ORDER BY candle_id, revision LIMIT %d"
            % (REVS, PK_REVS, lo, hi, m.MINUTE_MS, window[0], window[1], limit))


class Count:
    """Rows read, single-row reads included."""

    def __init__(self):
        self.single, self.walked = 0, 0

    @property
    def total(self):
        return self.single + self.walked


def _one(guard, mode, sql, params, count):
    rows = guard.fetch(mode, sql, params)
    count.single += 1
    return rows[0][0] if rows else None


def read_bounds(guard, count):
    out = {"events_overall": {}, "events_xbt": {}, "events_eth": {}, "gaps": {}, "candles_xbt": {}}
    for d in ("oldest", "newest"):
        out["events_overall"][d] = _one(guard, "bound_rowid", SQL_BOUND_ROWID[d], (), count)
        out["events_xbt"][d] = _one(guard, "bound_product", _sql_bound_product(d), (XBT,), count)
        out["events_eth"][d] = _one(guard, "bound_product", _sql_bound_product(d), (ETH,), count)
        out["gaps"][d] = _one(guard, "bound_gaps", _sql_bound_gaps(d), (), count)
        out["candles_xbt"][d] = _one(guard, "bound_candles", _sql_bound_candles(d), (), count)
    return out


def _by_hour(window, hits):
    hours = [dict() for _ in range((window[1] - window[0]) // HOUR_MS)]
    for key, at in hits:
        slot = hours[(at - window[0]) // HOUR_MS]
        slot[key] = slot.get(key, 0) + 1
    return [{"start_ms": window[0] + i * HOUR_MS, "count_by_feed": hours[i]} for i in range(len(hours))]


def read_witness_events(guard, product, window, cap, count):
    rows = guard.fetch("witness_events", _sql_witness_events(window, cap + 1), (product,))
    if len(rows) > cap:
        count.walked += len(rows)
        raise m.Stopped("row_budget", {"stage": "witness_events:%s" % product, "cap": cap})
    count.walked += len(rows)
    last = None
    for _, at in rows:
        if last is not None and at < last:
            raise m.Stopped("order", "received_at went backwards")
        last = at
    return {"rows": len(rows), "cap": cap, "by_hour": _by_hour(window, [(feed, at) for feed, at in rows])}


def read_witness_candles(guard, window, cap, count):
    rows = guard.fetch("witness_candles", _sql_witness_candles(window, cap + 1))
    count.walked += len(rows)
    if len(rows) > cap:
        raise m.Stopped("row_budget", {"stage": "witness_candles", "cap": cap})
    return {"rows": len(rows), "cap": cap, "by_hour": _by_hour(window, [("revisions", b) for (b,) in rows])}


def facts(bounds, witnesses):
    """Facts, not a verdict. ``purge_ruled_out``: events older than the empty window still exist."""
    oldest = bounds["events_overall"]["oldest"]
    out = {"window_start_ms": DAY0, "purge_ruled_out": oldest is not None and oldest <= DAY0}
    xbt_after = witnesses.get("xbt_after")
    eth_same = witnesses.get("eth_same")
    out["xbt_events_after_window"] = None if xbt_after is None else xbt_after["rows"] > 0
    out["eth_events_in_window"] = None if eth_same is None else eth_same["rows"] > 0
    candles = witnesses.get("xbt_candles_after")
    out["xbt_candles_after_window"] = None if candles is None else candles["rows"] > 0
    return out


def build_result(conn, *, max_events, max_candles, read_date_ms, started=None):
    started = started if started is not None else time.monotonic()
    g._valid_cap(max_events, "max_events")
    g._valid_cap(max_candles, "max_candles")
    result = {"tool_version": TOOL_VERSION, "sqlite_version": sqlite3.sqlite_version, "read_date_ms": read_date_ms,
              "caps": {"events_per_witness": max_events, "candles": max_candles}, "stopped": None,
              "windows_ms": {"xbt_after": list(WINDOW_XBT_AFTER), "eth_same": list(WINDOW_ETH_SAME)},
              "note": "Aggregates only: timestamps and hourly counts. Facts, not a verdict; says nothing about Kraken's timing."}
    if conn.execute("PRAGMA query_only").fetchone()[0] != 1:
        raise m.Stopped("guard", "query_only was not on")
    result["guards"] = {"opened_with": "mode=ro", "query_only_readback": 1}
    if sqlite3.sqlite_version_info < m.MIN_SQLITE:
        raise m.Stopped("sqlite_version", sqlite3.sqlite_version)
    guard, count, witnesses = _Guard(conn, started), Count(), {}
    try:
        try:
            result["bounds"] = read_bounds(guard, count)
            witnesses["xbt_after"] = read_witness_events(guard, XBT, WINDOW_XBT_AFTER, max_events, count)
            witnesses["eth_same"] = read_witness_events(guard, ETH, WINDOW_ETH_SAME, max_events, count)
            witnesses["xbt_candles_after"] = read_witness_candles(guard, WINDOW_XBT_AFTER, max_candles, count)
        except m.Stopped as stop:
            result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
    finally:
        guard.close()
    result["witnesses"] = witnesses
    result["facts"] = facts(result.get("bounds", {"events_overall": {"oldest": None}}), witnesses)
    result["rows_read"] = {"single_row_reads": count.single, "rows_walked": count.walked, "total": count.total,
                           "total_cap": 2 * (max_events + 1) + (max_candles + 1) + 10}
    result["plans"] = sorted({d for details in guard.planned.values() for d in details})
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True)
    ap.add_argument("--max-events", required=True, type=int, help="cap on the events walked by EACH witness; no default")
    ap.add_argument("--max-candles", required=True, type=int, help="cap on the candle rows walked; no default")
    args = ap.parse_args(argv)
    started = time.monotonic()
    try:
        before = m.check_identity(args.db)
        g._valid_cap(args.max_events, "max_events")
        g._valid_cap(args.max_candles, "max_candles")
    except (m.Stopped, OSError) as error:
        sys.stderr.write("refused: %s %s\n" % (getattr(error, "reason", "identity"), getattr(error, "detail", error)))
        return 2
    conn = m._open_readonly(args.db)
    try:
        result = build_result(conn, max_events=args.max_events, max_candles=args.max_candles,
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
