"""Value comparison of the live capture's own candles against the official series, one fixed window (Issue #183, BAL-PROPUESTA-183-NIVELB-01).

DRAFT, never run on real data. Question of one run: do the values (open, high, low, close, volume in BTC) of the capture's own 1-minute
candles of PF_XBTUSD, aggregated to 5 minutes, equal the official series aggregated the same way, with tolerance 0, inside
``[2026-10-11T12:00Z, 14:00Z)``? Stage 2 could not answer it: its own-candle window fell in the 38-hour gap and returned 0 rows.

It reuses the guards, the file identity check and the validators of ``capture_minimal_read`` and ``capture_validation`` without changing
them (their sha256 is pinned by a test). It adds only a new window and two statements:
- official 1-minute candles, PF_XBTUSD, the window above, at most 300 rows (``LIMIT 301``);
- the capture's own 1-minute candles, PF_XBTUSD, the same window, at most 20 000 rows (``LIMIT 20 001``); the values are returned only for
  CLOSED revisions (a ``CASE`` turns every open revision's values into NULL inside the statement).
Both statements name the primary-key index (``INDEXED BY``) and are planned first: a SCAN or a temporary B-tree stops the run. The window is
inside the one holdout exception the validators already accept (``HOLDOUT_WINDOW``, passed to ``validate_candles`` unchanged);
``HOLDOUT_START_MS`` is not touched. The tolerances are the validator's defaults (0 for prices and for volume): the tool has no parameter
that relaxes them. The CLI takes ``--db`` and ``--prior-rows`` only.

What the result may say (fixed in advance, D-183-NB-01 and D-183-NB-02):
- ``stopped`` (row budget, query plan, time, database or validator error, global cap): the run is consumed; ONLY the reason and the rows read are
  published, with NO per-field verdict, no counts of findings and no fitness: truncated revisions would invent ABSENT or DISCREPANCY;
- ``not_measured``: the window has no own revision at all, or no closed one. Nothing is compared and nothing else is read, tried or retried
  (no other key, window or product);
- ``measured``: the aggregates of the validator for this window: 5-minute buckets judged out of 24, absent buckets and, per field, the
  discrepancies with count, first and last bucket. Zero discrepancies say only that, in this 2-hour window and this product, the values equal.

It does not measure when Kraken publishes, uses no quotes, proves nothing about other windows or products and does not say that the capture is
fit to trade. No price, volume or revision leaves this process.

Usage (stdlib only; Python 3.9 is enough):
    python3 -m balancita_engine.capture_candle_values --db <futures-market.sqlite> --prior-rows N > out.json
"""
import argparse
import json
import os
import sqlite3
import sys
import time
from decimal import Decimal

from . import capture_minimal_read as m
from . import capture_validation as cv

TOOL_VERSION = "capture-candle-values.v1"
DECISIONS = ("BAL-DECISION-185-02", "BAL-DECISION-185-03", "BAL-DECISION-183-15")
PROPOSAL = "BAL-PROPUESTA-183-NIVELB-01"
BTC = m.BTC
MINUTE_MS = m.MINUTE_MS
WINDOW_C = (1_791_720_000_000, 1_791_727_200_000)     # 2026-10-11T12:00Z .. 14:00Z
EXPECTED_MINUTES = (WINDOW_C[1] - WINDOW_C[0]) // MINUTE_MS
EXPECTED_BUCKETS_5M = EXPECTED_MINUTES // 5
CAPS = {"official": 300, "own": 20_000}
MODE_OFFICIAL, MODE_OWN = "2a", "2b"                  # the authorizer modes of capture_minimal_read with the same tables and columns


def need_rows():
    """Worst case of the tool, counting the extra row of each ``LIMIT cap + 1``: 301 + 20 001."""
    return CAPS["official"] + 1 + CAPS["own"] + 1


def _sql_official(limit):
    return ("SELECT product_id, bucket_start, known_at, revision_hash, open_price, high_price, low_price, close_price, "
            "volume_btc FROM %s INDEXED BY %s WHERE product_id = ? AND interval_ms = %d AND bucket_start >= %d AND bucket_start < %d "
            "ORDER BY interval_ms, bucket_start, revision_hash LIMIT %d"
            % (m._OFFICIAL, m.PK_CANDLES, MINUTE_MS, WINDOW_C[0], WINDOW_C[1], limit))


def _sql_own(limit):
    lo, hi = "%s:%d:%d" % (BTC, MINUTE_MS, WINDOW_C[0]), "%s:%d:%d" % (BTC, MINUTE_MS, WINDOW_C[1])
    cases = ", ".join("CASE WHEN is_closed = 1 THEN %s END" % c for c in
                      ("open_price", "high_price", "low_price", "close_price", "volume_btc"))
    return ("SELECT bucket_start, revision, known_at, is_closed, %s FROM %s INDEXED BY %s WHERE candle_id >= '%s' AND candle_id < '%s' "
            "AND interval_ms = %d AND bucket_start >= %d AND bucket_start < %d ORDER BY candle_id, revision LIMIT %d"
            % (cases, m._REVISIONS, m.PK_REVISIONS, lo, hi, MINUTE_MS, WINDOW_C[0], WINDOW_C[1], limit))


def read_official(guard, ledger):
    sql = _sql_official(CAPS["official"] + 1)
    plan = m._plan(guard, MODE_OFFICIAL, sql, (BTC,), m.PK_CANDLES)
    got = guard.fetch(MODE_OFFICIAL, sql, (BTC,))
    ledger.add("official", len(got), CAPS["official"], plan, product=BTC)
    if len(got) > CAPS["official"]:
        raise m.Stopped("row_budget", {"stage": "official", "cap": CAPS["official"]})
    return [tuple(r) for r in got]


def read_own(guard, ledger):
    sql = _sql_own(CAPS["own"] + 1)
    plan = m._plan(guard, MODE_OWN, sql, (), m.PK_REVISIONS)
    got = guard.fetch(MODE_OWN, sql)
    ledger.add("own", len(got), CAPS["own"], plan, product=BTC)
    if len(got) > CAPS["own"]:
        raise m.Stopped("row_budget", {"stage": "own", "cap": CAPS["own"]})
    return [tuple(r) for r in got]


def official_5m(rows):
    """Official 5-minute candles aggregated from the current official 1-minute revisions of the window, as text."""
    best, _ = m._current_official(rows)
    minutes = []
    for (product, bucket), (_k, _r, o, h, l, c, v) in best.items():
        if product == BTC and WINDOW_C[0] <= bucket < WINDOW_C[1]:
            minutes.append({"bucket_start": bucket, "open": o, "high": h, "low": l, "close": c, "volume": v})
    return [{k: (str(x) if isinstance(x, Decimal) else x) for k, x in c.items()}
            for c in cv.aggregate_to_five_minutes(minutes).values()]


def own_minutes(rows):
    """First and last CLOSED revision of every minute (as validator candles) and a summary. Rows:
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
    summary = {
        "rows": len(rows), "minutes_with_a_revision": len(all_revisions), "minutes_with_a_closed_revision": len(by_minute),
        "expected_minutes": EXPECTED_MINUTES, "minutes_missing": EXPECTED_MINUTES - len(all_revisions),
        "minutes_whose_first_and_last_closed_revision_differ": differing,
        "closed_revision_known_at_minus_bucket_end_ms": m._quantiles(
            [r[2] - (r[0] + MINUTE_MS) for r in rows if r[3] == 1])}
    return candles, summary


def summarize_official(rows):
    best, differing = m._current_official(rows)
    present = {b for (p, b) in best if p == BTC}
    return {"rows": len(rows), "minutes_present": len(present), "expected_minutes": EXPECTED_MINUTES,
            "minutes_missing": EXPECTED_MINUTES - len(present), "minutes_with_differing_revisions": differing.get(BTC, 0)}


READING = {
    "zero_discrepancies": "In this window and this product the values of the own candles equal the official ones with tolerance 0; nothing "
                          "about other windows, products, timing or fitness.",
    "discrepancies": "Reported as counted, per field with the first and last bucket; no cause is attributed, no tolerance is relaxed and "
                     "the window is not widened. An own candle comes from the trades the WebSocket received: a missed trade changes the volume.",
    "not_measured": "No own candle values exist in the window: the comparison is not measured and nothing else is read.",
    "stopped": "The run is consumed. Only the reason and the rows read are published: no verdict per field.",
}


def evaluate(official_rows, own_rows):
    """The result of a COMPLETED read: ``not_measured`` without own values, else the validator's aggregates."""
    candles_own, own_summary = own_minutes(own_rows)
    if not candles_own:
        reason = "no_own_revision_in_window" if not own_rows else "no_closed_own_revision_in_window"
        return {"status": "not_measured", "reason": reason, "own_1m": {"rows": len(own_rows)}, "reading": READING["not_measured"]}
    sample = {"source": "dev-live/%s" % m.DB_NAME, "version": TOOL_VERSION, "from_ms": WINDOW_C[0], "to_ms": WINDOW_C[1],
              "products": [BTC], "holdout_exception": list(m.HOLDOUT_WINDOW)}
    candles = cv.validate_candles(BTC, candles_own, official_5m(official_rows), WINDOW_C[0], WINDOW_C[1],
                                  holdout_window=m.HOLDOUT_WINDOW)
    report = m._summarize_report(cv.build_report(sample, [candles], ("candles",)))
    judged = report["coverage"].get("candles.buckets", {}).get(BTC, 0)
    return {"status": "measured", "buckets_5m_judged": judged, "expected_buckets_5m": EXPECTED_BUCKETS_5M,
            "official_1m": summarize_official(official_rows), "own_1m": own_summary, "candles_report": report,
            "reading": {k: READING[k] for k in ("zero_discrepancies", "discrepancies")}}


def build_result(conn, started=None, *, prior_rows):
    started = time.monotonic() if started is None else started
    result = {"tool_version": TOOL_VERSION, "decisions": list(DECISIONS), "proposal": PROPOSAL, "product": BTC,
              "window_ms": list(WINDOW_C), "caps": CAPS, "query_time_limit_s": m.QUERY_TIMEOUT_S, "run_time_limit_s": m.RUN_TIMEOUT_S,
              "holdout_exception": list(m.HOLDOUT_WINDOW), "python_version": sys.version.split()[0], "run_consumed": True,
              "note": "Aggregates only: no price, volume or revision is published. Our recording against the official series for this "
                      "window and product; not Kraken's timing, not quotes, not a session warm-up.", "stopped": None}
    guard = None
    try:
        readback = conn.execute("PRAGMA query_only").fetchone()[0]
        result["guards"] = {"opened_with": "mode=ro", "query_only_readback": readback}
        if readback != 1:
            raise m.Stopped("connection_not_query_only")
        need = need_rows()
        result["global_rows"] = {"cap": m.TOTAL_ROWS_CAP, "prior_rows_counted": prior_rows, "stage_rows_needed": need}
        if isinstance(prior_rows, bool) or not isinstance(prior_rows, int) or prior_rows < 0:
            raise m.Stopped("prior_rows", "prior_rows must be a non-negative integer")
        if prior_rows + need > m.TOTAL_ROWS_CAP:
            raise m.Stopped("global_cap", {"cap": m.TOTAL_ROWS_CAP, "prior_rows": prior_rows, "stage_rows_needed": need,
                                           "remaining": m.TOTAL_ROWS_CAP - prior_rows})
        result["sqlite_version"] = sqlite3.sqlite_version
        guard = m._Guard(conn, started)
        ledger = m.Ledger()
        result["_ledger"] = ledger
        official = read_official(guard, ledger)
        own = read_own(guard, ledger)
        result["outcome"] = evaluate(official, own)     # only after BOTH reads completed: a stop never leaves a verdict (D-183-NB-02)
    except m.Stopped as stop:
        result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
    except sqlite3.DatabaseError as exc:
        result["stopped"] = {"reason": "database_error", "detail": "%s: %s" % (type(exc).__name__, exc)}
    except ValueError as exc:
        result["stopped"] = {"reason": "validator_refused", "detail": str(exc)}
    finally:
        if guard is not None:
            guard.close()
    ledger = result.pop("_ledger", None)
    if ledger is not None:
        result["reads"] = ledger.entries
        result["rows_total"] = {"rows_read": sum(e["rows"] for e in ledger.entries), "cap": m.TOTAL_ROWS_CAP}
    if result["stopped"]:
        result.pop("outcome", None)
        result["outcome"] = {"status": "stopped", "reading": READING["stopped"]}
    return result


def _stat_pair(path):
    st = os.stat(path)
    return st.st_dev, st.st_ino


def _device_inode(path, before):
    after = _stat_pair(path)
    return {"device_inode_before": list(before), "device_inode_after": list(after), "same_device_and_inode": tuple(before) == tuple(after)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True, help="local live-capture database (opened read-only)")
    ap.add_argument("--prior-rows", required=True, type=int,
                    help="rows already counted against the 173 000 of BAL-DECISION-185-02 (all earlier stages and runs)")
    args = ap.parse_args(argv)
    if args.prior_rows < 0:
        sys.stderr.write("refused: --prior-rows must be >= 0\n")
        return 2
    started = time.monotonic()
    try:
        before = m.check_identity(args.db)
    except (m.Stopped, OSError) as error:
        reason = error.reason if isinstance(error, m.Stopped) else "identity"
        sys.stderr.write("refused: %s %s\n" % (reason, getattr(error, "detail", error)))
        return 2
    dev_inode_before = _stat_pair(args.db)
    conn = m._open_readonly(args.db)
    try:
        result = build_result(conn, started, prior_rows=args.prior_rows)
    finally:
        conn.close()
    result["source"] = {"before": before, "after": m._identity(args.db), "elapsed_s": round(time.monotonic() - started, 3)}
    result["source"].update(_device_inode(args.db, dev_inode_before))
    result["exit_code"] = 2 if result["stopped"] else 0
    result["fingerprint_sha256"] = m.fingerprint(result)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return result["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
