"""Diagnosis of the missing own 1m candles of PF_XBTUSD, 2026-10-11T00:00Z to 06:00Z: DRAFT, never run on real data.

Question (#183): the own candles of that window are 0 of 360. Did the capture receive events for XBT in those six hours
(and of which feed), and did it register gaps? Only hourly COUNTS are published; no price, quantity, body or id.

Status: written and tested with invented data only. Running it on the real base needs a new, explicit authorization of Fran
with the caps below (they have NO default on purpose), the GO of D and a green CI on the exact head.

Fixed scope (the authorization to ask for must name exactly this):
- source: ``dev-live/futures-market.sqlite`` only, opened ``mode=ro`` with ``PRAGMA query_only`` read back, identity checked
  before and after (same checks as capture_minimal_read);
- statement EVENTS: ``paper_futures_market_events`` columns ``feed``, ``received_at`` (filters ``product_id``, ``seq`` for the
  order); product ``PF_XBTUSD``; ``received_at`` in [2026-10-11T00:00Z, 2026-10-11T06:00Z); the index
  ``paper_futures_market_received (product_id, received_at, seq)`` is named with INDEXED BY, so the walk is a SEARCH in index
  order and needs no sort. It walks EVERY event of the product in the window (books and tickers included, not only trades):
  that is what ``--max-events`` bounds, counted over the walked rows (``LIMIT max-events + 1`` ... stop with ``row_budget``);
- statement GAPS: ``paper_futures_data_gaps`` columns ``detected_at``, ``product_id``, ``feed``, ``reason`` through
  ``paper_futures_data_gaps_detected_at``; the ``LIMIT`` is inside a subquery so it bounds the rows WALKED (all products),
  and the product filter is applied in the outer query, so other products' values never leave SQLite (``--max-gaps``);
- counting is done in memory over the ordered walk (no GROUP BY: it would need a temporary B-tree and the gate refuses it);
- every statement is EXPLAINed first: a table SCAN or a temporary B-tree stops the run (``query_plan``); 60 s per statement,
  10 min per run; no retry, no sampling, no widening; every stop is published and exits 2;
- no candle, quote, funding, price or body column is read.

Reading the result: events of the product by hour and feed, and gaps by hour and reason.
- ``no_events``: no event of the product in the window. Most likely the capture was not running or not receiving, but this is
  NOT direct proof (see the retention caveat).
- ``events_without_trades``: events arrived but none was a trade, so no candle could be built from trades.
- ``trades_received``: trades arrived; since the own candles were 0 of 360 this would point to the candle step, not to the feed.
Retention caveat: events are deleted after ``FUTURES_EVENT_RETENTION_DAYS`` (default 7, depends on the real configuration). An
empty window read AFTER that point cannot tell "never recorded" from "already deleted"; the result carries the read date and
this caveat.

Usage:
    python3 -m balancita_engine.capture_gap_diagnosis --db <futures-market.sqlite> --max-events N --max-gaps M > out.json
"""
import argparse
import json
import sqlite3
import sys
import time

from . import capture_minimal_read as m

TOOL_VERSION = "capture-gap-diagnosis.v1"
PRODUCT = m.BTC
WINDOW = m.WINDOW_B                                    # [2026-10-11T00:00Z, 06:00Z) in epoch ms
HOUR_MS = m.HOUR_MS
HOURS = (WINDOW[1] - WINDOW[0]) // HOUR_MS
IDX_EVENTS = "paper_futures_market_received"
IDX_GAPS = "paper_futures_data_gaps_detected_at"
EVENTS, GAPS = "paper_futures_market_events", "paper_futures_data_gaps"

DIAG_ALLOWED = {
    "events": {EVENTS: {"feed", "product_id", "received_at", "seq"}},
    "gaps": {GAPS: {"detected_at", "product_id", "feed", "reason"}},
}


def sql_events(limit):
    return ("SELECT feed, received_at FROM %s INDEXED BY %s WHERE product_id = '%s' AND received_at >= %d AND received_at < %d "
            "ORDER BY received_at, seq LIMIT %d" % (EVENTS, IDX_EVENTS, PRODUCT, WINDOW[0], WINDOW[1], limit))


def sql_gaps(limit):
    return ("SELECT detected_at, CASE WHEN product_id = '%s' THEN feed END, CASE WHEN product_id = '%s' THEN reason END "
            "FROM (SELECT detected_at, product_id, feed, reason FROM %s INDEXED BY %s WHERE detected_at >= %d AND detected_at < %d "
            "ORDER BY detected_at LIMIT %d) w" % (PRODUCT, PRODUCT, GAPS, IDX_GAPS, WINDOW[0], WINDOW[1], limit))


class _DiagGuard(m._Guard):
    def _authorize(self, action, arg1, arg2, _db, _source):
        if action == sqlite3.SQLITE_READ:
            allowed = DIAG_ALLOWED.get(self.mode, {}).get(arg1) if self.mode else None
            return sqlite3.SQLITE_OK if allowed is not None and (arg2 in allowed or arg2 == "") else sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_FUNCTION):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY


def _valid_cap(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise m.Stopped("cap", "%s must be a positive integer" % name)
    return value


def read_events(guard, max_events):
    sql = sql_events(max_events + 1)
    rows = guard.fetch("events", sql)
    if len(rows) > max_events:
        raise m.Stopped("row_budget", {"stage": "events", "cap": max_events})
    per_hour = [dict() for _ in range(HOURS)]
    last = None
    for feed, received_at in rows:
        if last is not None and received_at < last:
            raise m.Stopped("order", "received_at went backwards")
        last = received_at
        hour = per_hour[(received_at - WINDOW[0]) // HOUR_MS]
        hour[feed] = hour.get(feed, 0) + 1
    return len(rows), per_hour, guard.planned[("events", sql)]


def read_gaps(guard, max_gaps):
    sql = sql_gaps(max_gaps + 1)
    rows = guard.fetch("gaps", sql)
    if len(rows) > max_gaps:
        raise m.Stopped("row_budget", {"stage": "gaps", "cap": max_gaps})
    per_hour = [dict() for _ in range(HOURS)]
    mine = 0
    for detected_at, feed, reason in rows:
        if feed is None and reason is None:               # another product: counted as walked, nothing else leaves SQLite
            continue
        mine += 1
        hour = per_hour[(detected_at - WINDOW[0]) // HOUR_MS]
        key = "%s:%s" % (feed, reason)
        hour[key] = hour.get(key, 0) + 1
    return len(rows), mine, per_hour, guard.planned[("gaps", sql)]


def classify(event_hours):
    total = sum(sum(h.values()) for h in event_hours)
    trades = sum(h.get("trade", 0) for h in event_hours)
    if total == 0:
        return "no_events"
    if trades == 0:
        return "events_without_trades"
    return "trades_received"


def build_result(conn, *, max_events, max_gaps, read_date_ms, started=None):
    started = started if started is not None else time.monotonic()
    _valid_cap(max_events, "max_events")
    _valid_cap(max_gaps, "max_gaps")
    result = {"tool_version": TOOL_VERSION, "product": PRODUCT, "window_ms": list(WINDOW), "sqlite_version": sqlite3.sqlite_version,
              "caps": {"events": max_events, "gaps": max_gaps}, "read_date_ms": read_date_ms, "stopped": None,
              "retention_caveat": "Events are deleted after FUTURES_EVENT_RETENTION_DAYS (default 7, real configuration unknown): an empty "
                                  "window read after that point cannot tell 'never recorded' from 'already deleted'.",
              "note": "Aggregates only: hourly counts. Not a measure of Kraken's timing; says nothing about other days or products."}
    if conn.execute("PRAGMA query_only").fetchone()[0] != 1:
        raise m.Stopped("guard", "query_only was not on")
    result["guards"] = {"opened_with": "mode=ro", "query_only_readback": 1}
    if sqlite3.sqlite_version_info < m.MIN_SQLITE:
        raise m.Stopped("sqlite_version", sqlite3.sqlite_version)
    guard = _DiagGuard(conn, started)
    try:
        try:
            n_events, event_hours, plan_e = read_events(guard, max_events)
            n_walked, n_mine, gap_hours, plan_g = read_gaps(guard, max_gaps)
        except m.Stopped as stop:
            result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
            return result
    finally:
        guard.close()
    result["reads"] = {"events": {"rows": n_events, "cap": max_events, "plan": plan_e},
                       "gaps": {"rows_walked": n_walked, "rows_of_the_product": n_mine, "cap": max_gaps, "plan": plan_g}}
    result["hours"] = [{"start_ms": WINDOW[0] + i * HOUR_MS, "events_by_feed": event_hours[i], "gaps_by_feed_reason": gap_hours[i]}
                       for i in range(HOURS)]
    result["classification"] = classify(event_hours)
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True)
    ap.add_argument("--max-events", required=True, type=int, help="cap on the events WALKED (books and tickers included); no default")
    ap.add_argument("--max-gaps", required=True, type=int, help="cap on the gap rows WALKED (all products); no default")
    args = ap.parse_args(argv)
    started = time.monotonic()
    try:
        before = m.check_identity(args.db)
        _valid_cap(args.max_events, "max_events")
        _valid_cap(args.max_gaps, "max_gaps")
    except (m.Stopped, OSError) as error:
        sys.stderr.write("refused: %s %s\n" % (getattr(error, "reason", "identity"), getattr(error, "detail", error)))
        return 2
    conn = m._open_readonly(args.db)
    try:
        result = build_result(conn, max_events=args.max_events, max_gaps=args.max_gaps,
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
