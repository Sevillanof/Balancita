"""Control read for the empty XBT window of 2026-10-11T00:00Z to 06:00Z: DRAFT, never run on real data (v2, after BAL-COORD-183-CONTROL-INFERENCIAS-01).

The first diagnosis (capture_gap_diagnosis, BAL-RESULTADO-183-VELAS-PROPIAS-01) found 0 events and 0 gaps in the window, which does not
tell "never recorded" from "already deleted". Only timestamps, rowids and hourly counts are published; no price, quantity, body or id.

What the code does (read, not assumed; the real environment value of ``FUTURES_EVENT_RETENTION_DAYS`` is unknown and is NOT assumed):
``trimRawEvents`` (futures-market-store.ts) takes ``now - eventRetentionMs`` (``now`` is the capture process wall clock), bisects the
largest ``rowid`` whose ``received_at`` is below that cutoff (it ASSUMES rowid grows with received_at) and deletes ``rowid <= bound``,
every product and feed. ``received_at`` is the local reception time; ``event_time`` is the provider's. Tickers go earlier (24 h).
Candles, funding and gaps are never deleted. A previous offline ``market:prune`` could have run with another ``now``.

Scope (BAL-DECISION-183-15; each real run is published here BEFORE it runs, with D's review and a green CI on the exact head):
- ``dev-live/futures-market.sqlite`` only, ``mode=ro`` + ``query_only`` read back, identity before/after, no copy, no Kraken;
- BOUNDS (single-row reads, all counted): the oldest and newest event by ``rowid`` (rowid, received_at, event_time, persisted_at), the oldest and newest
  ``received_at`` of XBT and of ETH (with event_time), oldest/newest ``detected_at`` of gaps, oldest/newest own XBT 1m candle bucket;
- MONOTONICITY PROBE: ``PROBES`` evenly spaced rowids between the min and max rowid, one single-row read each (rowid, received_at), to check
  the assumption retention relies on (rowid grows with received_at) and to expose late loads. It is a probe, not a proof;
- WITNESSES: events per hour and feed of XBT in [2026-10-11T06:00Z, 12:00Z) and of ETH in [00:00Z, 06:00Z) (ETH has no own trades or candles
  by design: empty ETH proves nothing); own XBT 1m candles per hour in [10-oct 18:00Z, 11-oct 00:00Z) and [11-oct 06:00Z, 12:00Z). Each
  walks every row of its window under its cap (``LIMIT cap + 1``; over the cap stops with ``row_budget`` and keeps what was already read);
- every statement is EXPLAINed first (SEARCH only), 60 s per statement, 10 min per run, no retry, no sampling beyond the probe, no widening.

Inferences: the output carries ``inferences`` with what each result allows to say and what it does not. It never says "purged" or "never
recorded" on its own; when a condition fails the entry says "undetermined".

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

TOOL_VERSION = "capture-control-read.v2"
PROBES = 64
SINGLE_MAX = 10 + PROBES
HOUR_MS = m.HOUR_MS
DAY0 = m.WINDOW_B[0]                                         # 2026-10-11T00:00Z
WINDOW_XBT_AFTER = (DAY0 + 6 * HOUR_MS, DAY0 + 12 * HOUR_MS)  # [06:00Z, 12:00Z)
WINDOW_CANDLES_BEFORE = (DAY0 - 6 * HOUR_MS, DAY0)           # [10-oct 18:00Z, 00:00Z)
WINDOW_ETH_SAME = m.WINDOW_B                                  # [00:00Z, 06:00Z)
XBT, ETH = m.BTC, m.ETH
EVENTS, GAPS, REVS = g.EVENTS, g.GAPS, "paper_futures_candle_revisions"
IDX_EVENTS, IDX_GAPS = g.IDX_EVENTS, g.IDX_GAPS
PK_REVS = m.PK_REVISIONS

ALLOWED = {
    "bound_rowid": {EVENTS: {"rowid", "received_at", "event_time", "persisted_at"}},
    "probe": {EVENTS: {"rowid", "received_at"}},
    "bound_product": {EVENTS: {"product_id", "received_at", "event_time", "persisted_at"}},
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
    "oldest": "SELECT rowid, received_at, event_time, persisted_at FROM %s WHERE rowid >= 0 ORDER BY rowid LIMIT 1" % EVENTS,
    "newest": "SELECT rowid, received_at, event_time, persisted_at FROM %s WHERE rowid >= 0 ORDER BY rowid DESC LIMIT 1" % EVENTS,
}
SQL_PROBE = "SELECT rowid, received_at FROM %s WHERE rowid >= ? ORDER BY rowid LIMIT 1" % EVENTS


def _sql_bound_product(direction):
    order = "" if direction == "oldest" else " DESC"
    return ("SELECT received_at, event_time, persisted_at FROM %s INDEXED BY %s WHERE product_id = ? ORDER BY received_at%s LIMIT 1"
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


def _row(guard, mode, sql, params, count, names):
    rows = guard.fetch(mode, sql, params)
    count.single += 1
    return dict(zip(names, rows[0])) if rows else None


def read_bounds(guard, count):
    out = {"events_overall": {}, "events_xbt": {}, "events_eth": {}, "gaps": {}, "candles_xbt": {}}
    for d in ("oldest", "newest"):
        out["events_overall"][d] = _row(guard, "bound_rowid", SQL_BOUND_ROWID[d], (), count, ("rowid", "received_at", "event_time", "persisted_at"))
        out["events_xbt"][d] = _row(guard, "bound_product", _sql_bound_product(d), (XBT,), count, ("received_at", "event_time", "persisted_at"))
        out["events_eth"][d] = _row(guard, "bound_product", _sql_bound_product(d), (ETH,), count, ("received_at", "event_time", "persisted_at"))
        out["gaps"][d] = _one(guard, "bound_gaps", _sql_bound_gaps(d), (), count)
        out["candles_xbt"][d] = _one(guard, "bound_candles", _sql_bound_candles(d), (), count)
    return out


def read_probe(guard, bounds, count):
    """PROBES single-row reads spread over the rowid range: does received_at grow with rowid (what retention assumes)?"""
    first, last = bounds["events_overall"]["oldest"], bounds["events_overall"]["newest"]
    if first is None or last is None:
        return {"points": [], "monotone_nondecreasing": None, "first_inversion": None}
    lo, hi = first["rowid"], last["rowid"]
    points, inversion = [], None
    for i in range(PROBES):
        target = lo + (hi - lo) * i // (PROBES - 1)
        row = _row(guard, "probe", SQL_PROBE, (target,), count, ("rowid", "received_at"))
        if row is None:
            continue
        if points and inversion is None and row["received_at"] < points[-1]["received_at"]:
            inversion = {"previous": points[-1], "current": row}
        points.append(row)
    return {"points": points, "monotone_nondecreasing": inversion is None, "first_inversion": inversion}


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


def inferences(bounds, probe, witnesses):
    """What the results allow to say and what they do not. Never a verdict by itself; failing conditions give ``undetermined``."""
    oldest = (bounds or {}).get("events_overall", {}).get("oldest")
    out = {"window_start_ms": DAY0}
    obs = {"oldest_event_received_at_ms": oldest and oldest["received_at"], "oldest_event_event_time_ms": oldest and oldest["event_time"],
           "oldest_event_persisted_at_ms": oldest and oldest["persisted_at"],
           "xbt_oldest_persisted_at_ms": ((bounds or {}).get("events_xbt", {}).get("oldest") or {}).get("persisted_at"),
           "oldest_rowid": oldest and oldest["rowid"], "oldest_rowid_above_1": oldest is not None and oldest["rowid"] > 1,
           "rowid_probe_monotone": probe["monotone_nondecreasing"] if probe else None}
    out["observations"] = obs
    cond = oldest is not None and probe is not None and probe["monotone_nondecreasing"] is True
    if cond and oldest["received_at"] <= DAY0 and oldest["persisted_at"] <= DAY0:
        retention = {"holds": True, "says": "the event with the lowest rowid was received AND stored (persisted_at) at or before the window start "
                     "and the probe found rowid monotone with received_at, so a prefix deletion (what retention does) cannot have removed the "
                     "window; the empty window was not emptied by retention under the code's rule", "does_not_say": "why it is empty (never "
                     "captured, not loaded, other tool); persisted_at is set by the caller of the store, not by the database; late loads "
                     "between probes are not excluded"}
    elif cond and oldest["received_at"] <= DAY0:
        retention = {"holds": None, "says": "undetermined: the event with the lowest rowid has an old received_at but was stored after the window "
                     "start (a late load): a prefix deletion could have removed the window before it", "does_not_say": "retention happened; "
                     "never having been captured"}
    elif cond:
        retention = {"holds": None, "says": "undetermined: the oldest surviving event is newer than the window start; that is compatible with "
                     "retention having deleted the window AND with the window never having been captured", "does_not_say": "retention happened; "
                     "never captured"}
    else:
        retention = {"holds": None, "says": "undetermined: no events, a stop, or rowid not monotone with received_at (the assumption retention "
                     "uses is not met on the probed points)", "does_not_say": "anything about the cause"}
    out["window_not_trimmed_by_retention"] = retention
    before, after = witnesses.get("xbt_candles_before"), witnesses.get("xbt_candles_after")
    if before is not None and after is not None:
        candles = {"holds": before["rows"] > 0 and after["rows"] > 0,
                   "says": "own candles exist before and after the window and none inside it; retention never deletes candles, so retention does "
                   "not explain their absence" if before["rows"] > 0 and after["rows"] > 0 else "undetermined: own candles are missing before "
                   "and/or after the window (capture of own candles not continuous around it)",
                   "does_not_say": "why the capture did not build them"}
    else:
        candles = {"holds": None, "says": "undetermined: candle witnesses were not read", "does_not_say": "anything"}
    out["own_candles_absence_not_explained_by_retention"] = candles
    out["not_concluded"] = ["retention config of the real environment (unknown)", "that the oldest surviving event proves purge or absence",
                            "cause of the capture gap", "Kraken timing"]
    return out


def build_result(conn, *, max_events, max_candles, read_date_ms, started=None):
    started = started if started is not None else time.monotonic()
    g._valid_cap(max_events, "max_events")
    g._valid_cap(max_candles, "max_candles")
    result = {"tool_version": TOOL_VERSION, "sqlite_version": sqlite3.sqlite_version, "read_date_ms": read_date_ms,
              "caps": {"events_per_witness": max_events, "candles": max_candles}, "stopped": None,
              "windows_ms": {"xbt_after": list(WINDOW_XBT_AFTER), "eth_same": list(WINDOW_ETH_SAME),
                             "candles_before": list(WINDOW_CANDLES_BEFORE)},
              "note": "Aggregates only: timestamps and hourly counts. Observations and bounded inferences, not a verdict; says nothing about Kraken's timing."}
    if conn.execute("PRAGMA query_only").fetchone()[0] != 1:
        raise m.Stopped("guard", "query_only was not on")
    result["guards"] = {"opened_with": "mode=ro", "query_only_readback": 1}
    if sqlite3.sqlite_version_info < m.MIN_SQLITE:
        raise m.Stopped("sqlite_version", sqlite3.sqlite_version)
    guard, count, witnesses = _Guard(conn, started), Count(), {}
    try:
        try:
            result["bounds"] = read_bounds(guard, count)
            result["probe"] = read_probe(guard, result["bounds"], count)
            witnesses["xbt_candles_before"] = read_witness_candles(guard, WINDOW_CANDLES_BEFORE, max_candles, count)
            witnesses["xbt_candles_after"] = read_witness_candles(guard, WINDOW_XBT_AFTER, max_candles, count)
            witnesses["eth_same"] = read_witness_events(guard, ETH, WINDOW_ETH_SAME, max_events, count)
            witnesses["xbt_after"] = read_witness_events(guard, XBT, WINDOW_XBT_AFTER, max_events, count)
        except m.Stopped as stop:
            result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
    finally:
        guard.close()
    result["witnesses"] = witnesses
    result["inferences"] = inferences(result.get("bounds"), result.get("probe"), witnesses)
    result["rows_read"] = {"single_row_reads": count.single, "rows_walked": count.walked, "total": count.total,
                           "total_cap": 2 * (max_events + 1) + 2 * (max_candles + 1) + SINGLE_MAX}
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
