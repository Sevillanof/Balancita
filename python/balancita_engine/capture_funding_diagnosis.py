"""Funding publication diagnosis for Issue #183: DRAFT, never run on real data (BAL-COORD-183-FUNDING-DIAG-01, D-212-21).

Stage 2 left two open items in the funding family and could not say more because its summary keeps one line per finding group:
- three ``funding.publication`` DISCREPANCY (PF_ETHUSD 1, PF_XBTUSD 2, 2026-10-11T19:00Z..23:00Z): the validator raises it for two different
  reasons (a response shows the period definitive BEFORE ``end + settle_lag``, or no response shows it definitive by ``end + settle_lag +
  max_lag``) and the summary does not say which;
- three responses rejected as ``server_time_invalid``: the summary keeps the code, not the inner reason nor the shape of the string.

This tool reads the same rows as stages 2c and 2d (``capture_minimal_read.read_2c`` and ``read_2d``, unchanged: same windows, products, caps, guards
and plans) and publishes, in aggregate and without prices, rates, volumes or bodies:
- per publication case, its kind (``early`` or ``late``) and the offsets in ms: how far the receipt was from ``end + settle_lag`` and from the
  deadline, and, for early cases, ``serverTime - received_at`` of the response that showed the period definitive. Offsets quantify; they do not
  say that the validator is wrong, and they do not say anything about Kraken's punctuality;
- per product, the quantiles of ``serverTime - received_at`` over all parsed responses (the clock offset between the two clocks);
- the shape of every ``serverTime`` (every digit replaced by ``d``, at most 40 characters: the digits of a time never leave) and, for rejected responses, the adapter's
  inner reason, the shape and the receipt time;
- the Python version that ran it (``datetime.fromisoformat`` is stricter before 3.11).

The classification of the publication cases copies ``capture_validation._publication`` and is checked in the same run against the validator's own
counts (``consistent_with_validator``); a test compares both on random polls. Nothing is relaxed: the validator, the adapter, the parser, the
tolerances, the settle lag and the finalisation rule are the ones of stage 2 and the fitness stays what the validator says.

Reads: the 2c and 2d stages of stage 2, no 2a/2b; at most ``600 + 1 200`` single reads and 200 MB (the same stage caps), counted against the
173 000 total with a mandatory ``--prior-rows``. The windows are the ones stage 2 already consumed; they are read again only because the details
above were never published.

Usage (stdlib only):
    python3 -m balancita_engine.capture_funding_diagnosis --db <futures-market.sqlite> --prior-rows N > out.json
"""
import argparse
import json
import re
import sqlite3
import sys
import time
from collections import defaultdict

from . import capture_minimal_read as m
from . import capture_validation as cv
from . import funding_adapter

TOOL_VERSION = "capture-funding-diagnosis.v1"
DECISIONS = ("BAL-DECISION-185-02", "BAL-DECISION-185-03", "BAL-DECISION-183-15")
HOUR_MS = cv.HOUR_MS
SETTLE_LAG_MS = 600_000                  # what stage 2 used (validate_funding default)
MAX_LAG_MS = HOUR_MS                     # what stage 2 used (validate_funding default)
MAX_CASES = 20
SHAPE_MAX = 40
# What stage 2 published (BAL-RESULTADO-183-ETAPA2-02), to say whether this run reproduces it. Not a verdict.
STAGE2_PUBLICATION = {m.ETH: {"discrepancy": 1, "not_measurable": 34}, m.BTC: {"discrepancy": 2, "not_measurable": 35}}


def need_rows():
    """Worst case: the 2c and 2d stage caps."""
    return m.CAPS["2c"] + m.CAPS["2d"]


def shape_of(value):
    """The format of a timestamp string: every digit becomes ``d`` (letters and separators stay, they are the format), at most 40 characters."""
    if not isinstance(value, str):
        return "type:" + type(value).__name__
    return re.sub(r"[0-9]", "d", value)[:SHAPE_MAX]


def _server_time_text(raw):
    try:
        body = json.loads(raw)
    except ValueError:
        return "tool:unparseable"
    return body.get("serverTime", "tool:missing") if isinstance(body, dict) else "tool:not_an_object"


def inspect_responses(period_rows, responses):
    """Parses every response as stage 2 did (``funding_inputs``) and keeps what the stage summary dropped.

    Returns ``(polls, per_response, server_by_receipt)``: ``polls`` is the validator's own input; ``per_response`` has one entry per
    response (product, receipt, ``server_ms`` or ``None``, adapter reason and inner reason, shape of ``serverTime``);
    ``server_by_receipt`` maps ``(product, received_at)`` to the ``server_ms`` values seen."""
    _periods, polls, _events = m.funding_inputs(period_rows, responses)
    per_response, server_by_receipt = [], defaultdict(set)
    parsed_index = 0
    for sha, received_at, _server_time, product, body in responses:
        entry = {"product_id": product, "received_at": received_at, "shape": shape_of(_server_time_text(body)),
                 "server_ms": None, "reason": None, "inner_reason": None}
        try:
            parsed = funding_adapter.parse_response(body, product, received_at, strict=False)
            entry["server_ms"] = parsed["server_ms"]
            server_by_receipt[(product, received_at)].add(parsed["server_ms"])
            parsed_index += 1
        except funding_adapter.FundingAdapterError as error:
            entry["reason"] = error.reason
            text = str(error)
            entry["inner_reason"] = text.split(": ", 1)[1] if ": " in text else None
        per_response.append(entry)
    if parsed_index != len(polls):
        raise m.Stopped("poll_alignment", {"parsed": parsed_index, "polls": len(polls)})
    return polls, per_response, server_by_receipt


def classify_publication(starts, polls, settle_lag_ms=SETTLE_LAG_MS, max_lag_ms=MAX_LAG_MS):
    """The classification of ``capture_validation._publication``: per period ``early`` (a poll shows it definitive before
    ``end + settle``), ``late`` (a poll after the deadline still does not show it definitive) or ``unknown`` (not measurable); otherwise
    timely. ``polls``: ``[(received_at, starts, finals)]`` sorted by ``received_at``."""
    early, late, unknown = [], [], []
    for start in starts:
        end, deadline = start + HOUR_MS, start + HOUR_MS + settle_lag_ms + max_lag_ms
        definitive = [at for at, _, finals in polls if finals is not None and start in finals]
        first = definitive[0] if definitive else None
        if first is not None and first < end + settle_lag_ms:
            early.append(start)
        elif first is not None and first <= deadline:
            pass
        elif any(deadline < at and (first is None or at < first) and (start not in held if finals is None else True)
                 for at, held, finals in polls):
            late.append(start)
        else:
            unknown.append(start)
    return {"early": early, "late": late, "unknown": unknown}


def _clock_gap(server_by_receipt, product, at):
    seen = server_by_receipt.get((product, at), ())
    return (next(iter(seen)) - at) if len(seen) == 1 else None


def early_case(start, polls, server_by_receipt, product, settle_lag_ms=SETTLE_LAG_MS):
    end = start + HOUR_MS
    first = min(at for at, _, finals in polls if finals is not None and start in finals)
    return {"start_ms": start, "first_definitive_received_ms": first, "receipt_minus_end_plus_settle_ms": first - (end + settle_lag_ms),
            "server_minus_receipt_ms": _clock_gap(server_by_receipt, product, first)}


def late_case(start, polls, settle_lag_ms=SETTLE_LAG_MS, max_lag_ms=MAX_LAG_MS):
    end = start + HOUR_MS
    deadline = end + settle_lag_ms + max_lag_ms
    definitive = [at for at, _, finals in polls if finals is not None and start in finals]
    first = definitive[0] if definitive else None
    after = [at for at, _, finals in polls if deadline < at and (first is None or at < first)]
    before = [at for at, _, _ in polls if at <= deadline]
    return {"start_ms": start, "first_definitive_received_ms": first,
            "first_poll_after_deadline_minus_deadline_ms": (after[0] - deadline) if after else None,
            "stored_polls_between_end_and_deadline": sum(1 for at, _, _ in polls if end <= at <= deadline),
            "deadline_minus_last_poll_before_deadline_ms": (deadline - before[-1]) if before else None}


def diagnose(period_rows, responses):
    """The whole diagnosis from the stage rows. Pure: no database."""
    polls_for_validator, per_response, server_by_receipt = inspect_responses(period_rows, responses)
    periods, _polls, _events = m.funding_inputs(period_rows, responses)
    exception = cv.holdout_exception(m.HOLDOUT_WINDOW)
    holder = cv.Result("funding", list(m.PRODUCTS), m.WINDOW_A[0], m.WINDOW_A[1])
    polls = cv._parse_responses(holder, polls_for_validator, exception)
    validator = cv.validate_funding(periods, m.WINDOW_A[0], m.WINDOW_A[1], list(m.PRODUCTS), references=None,
                                    responses=polls_for_validator, holdout_window=m.HOLDOUT_WINDOW)
    per_product = {}
    for product in m.PRODUCTS:
        starts = [r["start_ms"] for r in periods if r["product_id"] == product and not r.get("provisional")
                  and m.WINDOW_A[0] <= r["start_ms"] and r["end_ms"] <= m.WINDOW_A[1]]
        starts = sorted(set(starts))
        product_polls = sorted(polls.get(product, []), key=lambda p: p[0])
        classes = classify_publication(starts, product_polls)
        ours = {"discrepancy": len(classes["early"]) + len(classes["late"]), "not_measurable": len(classes["unknown"])}
        theirs = {"discrepancy": 0, "not_measurable": 0}
        for f in validator.findings:
            if f["check"] == "funding.publication" and f["product"] == product and f.get("count") is not None:
                if f["kind"] == cv.DISCREPANCY:
                    theirs["discrepancy"] += int(f.get("count", 1))
                elif f["kind"] == cv.ABSENT:
                    theirs["not_measurable"] += int(f.get("count", 1))
        offsets = [e["server_ms"] - e["received_at"] for e in per_response if e["product_id"] == product and e["server_ms"] is not None]
        per_product[product] = {
            "periods_judged": len(starts),
            "stored_polls": len(product_polls),
            "publication": {
                "early_count": len(classes["early"]), "late_count": len(classes["late"]), "not_measurable_count": len(classes["unknown"]),
                "early_cases": [early_case(s, product_polls, server_by_receipt, product) for s in classes["early"][:MAX_CASES]],
                "late_cases": [late_case(s, product_polls) for s in classes["late"][:MAX_CASES]]},
            "server_minus_receipt_ms": m._quantiles(offsets),
            "consistent_with_validator": ours == theirs,
            "validator_publication_counts": theirs,
            "matches_stage2": theirs == STAGE2_PUBLICATION[product]}
    shapes, rejected = defaultdict(int), defaultdict(lambda: {"count": 0, "received_at_ms": []})
    for e in per_response:
        if e["reason"] is None:
            shapes[e["shape"]] += 1
        else:
            key = (e["reason"], e["inner_reason"], e["shape"])
            rejected[key]["count"] += 1
            if len(rejected[key]["received_at_ms"]) < MAX_CASES:
                rejected[key]["received_at_ms"].append(e["received_at"])
    return {
        "settle_lag_ms": SETTLE_LAG_MS, "max_lag_ms": MAX_LAG_MS,
        "responses": {"read": len(per_response), "parsed": sum(1 for e in per_response if e["reason"] is None),
                      "rejected": sum(1 for e in per_response if e["reason"] is not None)},
        "server_time_shapes_parsed": dict(sorted(shapes.items())),
        "server_time_rejected": [{"reason": k[0], "inner_reason": k[1], "shape": k[2], **v} for k, v in sorted(rejected.items(), key=str)],
        "per_product": per_product,
        "consistent_with_validator": all(p["consistent_with_validator"] for p in per_product.values()),
        "matches_stage2": all(p["matches_stage2"] for p in per_product.values()),
        "says": "kind (early or late) and offsets in ms of the three publication cases; shapes and inner reason of the rejected serverTime; "
                "the clock offset serverTime - received_at of the parsed responses",
        "does_not_say": "that the validator or the adapter is wrong (an offset quantifies, it does not judge); why the process was or was not "
                        "polling; anything about Kraken's punctuality; the fitness, which stays what the validator says"}


def build_result(conn, started=None, *, prior_rows):
    started = time.monotonic() if started is None else started
    result = {"tool_version": TOOL_VERSION, "decisions": list(DECISIONS), "products": list(m.PRODUCTS), "window_a_ms": list(m.WINDOW_A),
              "caps": {k: m.CAPS[k] for k in ("2c", "2d")}, "body_bytes_cap": m.MAX_BODY_BYTES, "query_time_limit_s": m.QUERY_TIMEOUT_S,
              "run_time_limit_s": m.RUN_TIMEOUT_S, "holdout_exception": list(m.HOLDOUT_WINDOW), "python_version": sys.version.split()[0],
              "note": "Aggregates only: no price, rate, volume, digit of a serverTime or response body is published.", "stopped": None}
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
        if sqlite3.sqlite_version_info < m.MIN_SQLITE:
            raise m.Stopped("sqlite_version", "octet_length() needs SQLite >= 3.43")
        guard = m._Guard(conn, started)
        ledger, reads = m.Ledger(), m.Reads()
        result["_ledger"], result["_reads"] = ledger, reads
        periods = m.read_2c(guard, ledger, reads)
        responses = m.read_2d(guard, ledger, reads)
        result["diagnosis"] = diagnose(periods, responses)
    except m.Stopped as stop:
        result["stopped"] = {"reason": stop.reason, "detail": stop.detail}
    except sqlite3.DatabaseError as exc:
        result["stopped"] = {"reason": "database_error", "detail": "%s: %s" % (type(exc).__name__, exc)}
    except ValueError as exc:
        result["stopped"] = {"reason": "validator_refused", "detail": str(exc)}
    finally:
        if guard is not None:
            guard.close()
    ledger, reads = result.pop("_ledger", None), result.pop("_reads", None)
    if ledger is not None:
        result["reads"] = ledger.entries
        walked = sum(e.get("rows_walked", e["rows"]) for e in ledger.entries)
        result["rows_total"] = {"statement_rows_walked": walked, "single_row_reads": reads.total(),
                                "single_row_reads_by_kind": reads.count, "total": walked + reads.total(), "cap": m.TOTAL_ROWS_CAP}
    return result


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
    conn = m._open_readonly(args.db)
    try:
        result = build_result(conn, started, prior_rows=args.prior_rows)
    finally:
        conn.close()
    result["source"] = {"before": before, "after": m._identity(args.db), "elapsed_s": round(time.monotonic() - started, 3)}
    result["fingerprint_sha256"] = m.fingerprint(result)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 2 if result["stopped"] else 0


if __name__ == "__main__":
    sys.exit(main())
