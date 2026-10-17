"""Read-only measurement of the captured funding for Issue #184 (BAL-DECISION-184-02; BAL-PROPUESTA-184-LECTURA-02).

One run answers one question: do the funding records of the live capture hold the assumptions of the funding adapter (#167) in
one fixed window? Coverage, revisions and publication, units, price reference and timings, for ``PF_XBTUSD`` and ``PF_ETHUSD`` in
``[2026-10-10T00:00Z, 2026-10-12T00:00Z)``. It measures; it does not set thresholds, it does not turn a difference without a cause
into a product rule and it does not change the adapter, the validator or any parser.

It does not copy a guard: it reuses, unchanged, the statements, the authorizer, the plan gate, the bounded ``rowid`` walks, the order
checks and the identity guard of ``capture_minimal_read`` (stage 2 of #183), and the publication classification of
``capture_funding_diagnosis``. What is new is the aggregation below and the total of the run.

Differences with stage 2, all declared:
- Stage 2a (the price reference: official 1-minute candles, same statement) runs with its own row cap (``CAP_REFERENCE``); 2c and 2d keep
  the caps of stage 2 (``capture_minimal_read.CAPS``). The statement text does not change: only the ``LIMIT`` value.
- The total of the whole run (rows walked + every single-row read, binary-search reads included) is capped at ``TOTAL_ROWS_CAP`` rows
  and ``MAX_BODY_BYTES``; it is checked BEFORE reading, from the stage caps, and again after. The 173 000 of BAL-DECISION-185-02
  neither grows nor is used: ``--prior-rows`` (63 089 on 2026-10-17) is published for transparency only.
- The exception for the protected period is ``capture_minimal_read.HOLDOUT_WINDOW`` = the window itself, the only one that
  ``capture_validation`` accepts; ``HOLDOUT_START_MS`` does not change. The margins of 2c (-1 h / +3 h on ``known_at``) are read
  only as ``rowid`` + time searches and are never validated or published.

Tables and columns (the authorizer lets through exactly these, per statement; ``capture_minimal_read.ALLOWED``):
``paper_futures_official_candles`` (2a), ``paper_futures_funding_periods`` (2c_bound, 2c, 2d_lookup) and
``paper_futures_funding_responses`` (2d_bound, 2d_meta, 2d_size, 2d_body). No other table, no ``2b``.

Aggregates only: no rate, price, volume, digit of a ``serverTime`` or response body is published. The error of the unit check is a
ratio (``|relative * price - absolute| / max``), not a value.

Usage (stdlib only; Python 3.9 is enough, 3.11 or later also interprets a ``serverTime`` with two fractional digits):
    python3 -m balancita_engine.capture_funding_184 --db <dev-live/futures-market.sqlite> --prior-rows N > out.json
"""
import argparse
import json
import os
import sqlite3
import sys
import time
from collections import defaultdict
from decimal import Decimal

from . import capture_funding_diagnosis as diag
from . import capture_minimal_read as m
from . import capture_validation as cv

TOOL_VERSION = "capture-funding-184.v1"
DECISIONS = ("BAL-DECISION-184-02", "BAL-PROPUESTA-184-LECTURA-02")
WINDOW = m.WINDOW_A                     # [2026-10-10T00:00Z, 2026-10-12T00:00Z), the one exception the validators accept
PRODUCTS = m.PRODUCTS
HOUR_MS = m.HOUR_MS
CAP_REFERENCE = 6_000                   # 2a: 2 products x 2 880 one-minute candles = 5 760, and the extra row of LIMIT cap + 1
TOTAL_ROWS_CAP = 8_000                  # the whole run: rows walked + single-row reads (stage 2 counted 6 529)
MAX_BODY_BYTES = m.MAX_BODY_BYTES       # 200 MB
REFERENCE_MAX_AGE_MS = 2 * HOUR_MS      # the validator's default (max_reference_age_ms)
PER_PRODUCT_HOURS = (WINDOW[1] - WINDOW[0]) // HOUR_MS
SERVER_TIME_PY = "3.11"                 # from this version datetime.fromisoformat takes two fractional digits (D-183-DIAG-03)


def need_rows():
    """Worst case, from the stage caps: 2a with its extra row, 2c and 2d as in stage 2 (their caps include the single-row reads)."""
    return CAP_REFERENCE + m.CAPS["2c"] + m.CAPS["2d"]


def read_reference(guard, ledger, cap=None):
    """``capture_minimal_read.read_2a`` with a different cap: same statement, same plan gate, same row-budget stop."""
    cap = CAP_REFERENCE if cap is None else cap
    rows, left, plans = [], cap, []
    for product in PRODUCTS:
        sql = m._sql_2a(left + 1)
        plans.append(m._plan(guard, "2a", sql, (product,), m.PK_CANDLES))
        got = guard.fetch("2a", sql, (product,))
        if len(got) > left:
            ledger.add("2a", len(got), cap, plans[-1], product=product, over_budget=True)
            raise m.Stopped("row_budget", {"stage": "2a", "product": product, "cap": cap})
        left -= len(got)
        rows.extend(tuple(r) for r in got)
    ledger.add("2a", len(rows), cap, plans[0], products=list(PRODUCTS))
    return rows


# ------------------------------------------------------------------------------------------------ measurements

def _ratio_quantiles(values):
    """Quantiles of a list of Decimals, as strings."""
    q = m._quantiles(sorted(values))
    return None if q is None else {k: (v if k == "n" else str(v)) for k, v in q.items()}


def coverage(period_rows):
    """Per product and per hour of the window: is there a definitive period row? ``mask`` is one character per hour."""
    out = {}
    for product in PRODUCTS:
        starts = {r[1] for r in period_rows if r[0] == product}
        hours = range(WINDOW[0], WINDOW[1], HOUR_MS)
        missing = [h for h in hours if h not in starts]
        out[product] = {"expected_hours": PER_PRODUCT_HOURS, "hours_with_a_period": PER_PRODUCT_HOURS - len(missing),
                        "missing_hours": len(missing), "first_missing_ms": missing[0] if missing else None,
                        "last_missing_ms": missing[-1] if missing else None,
                        "mask": "".join("0" if h in missing else "1" for h in hours)}
    return out


def revisions(periods):
    """Per product: how many period rows and how many distinct rates each (product, start) has. Rates are never published."""
    by_key = defaultdict(list)
    for row in periods:
        if row.get("provisional") is True:
            continue
        by_key[(row["product_id"], row["start_ms"])].append(row["funding_rate"])
    out = {}
    for product in PRODUCTS:
        keys = [k for k in by_key if k[0] == product]
        rows_per_period = defaultdict(int)
        for k in keys:
            rows_per_period[len(by_key[k])] += 1
        out[product] = {"periods": len(keys), "periods_by_number_of_rows": {str(n): c for n, c in sorted(rows_per_period.items())},
                        "periods_with_distinct_rates": sum(1 for k in keys if len({Decimal(str(r)) for r in by_key[k]}) > 1)}
    return out


def first_definitive(periods, polls):
    """For each judged period, how long after its end the first stored response that shows it definitive was received. Only
    periods that some stored response shows definitive are measurable; the others are counted, not guessed."""
    out = {}
    for product in PRODUCTS:
        starts = sorted({r["start_ms"] for r in periods if r["product_id"] == product and not r.get("provisional")
                         and WINDOW[0] <= r["start_ms"] and r["end_ms"] <= WINDOW[1]})
        mine = [p for p in polls if p["product_id"] == product]
        offsets = []
        for s in starts:
            seen = [p["received_at"] for p in mine if s in (p.get("final_starts") or ())]
            if seen:
                offsets.append(min(seen) - (s + HOUR_MS))
        out[product] = {"periods": len(starts), "with_a_definitive_response": len(offsets),
                        "without": len(starts) - len(offsets), "received_minus_end_ms": m._quantiles(offsets)}
    return out


def units_and_reference(periods, official_rows):
    """The relative * price vs absolute check and the age of the price reference, one pass over the judged period rows.
    The tolerance is the validator's (``cv.validate_funding`` default), which this tool does not choose: the counts of
    discrepancies come from the validator report; here only the ratio is measured."""
    refs = m.references(official_rows)
    out = {}
    for product in PRODUCTS:
        errors, ages, units = [], [], defaultdict(int)
        with_relative = no_reference = 0
        for row in periods:
            if row["product_id"] != product or row.get("provisional") is True:
                continue
            if not (WINDOW[0] <= row["start_ms"] and row["end_ms"] <= WINDOW[1]):
                continue
            units[str(row["unit"])] += 1
            relative = row.get("relative_rate")
            if relative is None:
                continue
            with_relative += 1
            price, at = cv._reference_price(refs, product, row["start_ms"], REFERENCE_MAX_AGE_MS)
            if price is None:
                no_reference += 1
                continue
            ages.append(row["start_ms"] - at)
            implied, absolute = Decimal(str(relative)) * price, Decimal(str(row["funding_rate"]))
            scale = max(abs(implied), abs(absolute))
            errors.append(abs(implied - absolute) / scale if scale else Decimal(0))
        out[product] = {"units": dict(sorted(units.items())), "rows_with_relative_rate": with_relative,
                        "rows_without_fresh_reference": no_reference, "rows_checked": len(errors),
                        "relative_error": _ratio_quantiles(errors), "reference_age_ms": m._quantiles(ages),
                        "reference_source": "paper_futures_official_candles, interval 1 minute, close of the latest candle at or before the period start",
                        "reference_max_age_ms": REFERENCE_MAX_AGE_MS}
    return out


def verdict(count_against, measured):
    """Mechanical, with no threshold: ``no_medible`` when nothing was measured, ``contradicha`` when any measured case goes
    against the assumption, ``sostenida`` when every measured case holds. The counts are published next to it."""
    if not measured:
        return "no_medible"
    return "contradicha" if count_against else "sostenida"


def hypotheses(fd, units, rev, diagnosis, validator_counts):
    """One entry per assumption of the adapter (#167, ``docs/etapa-10-funding-contable.md``). Not a rule of product."""
    out = {}
    against = sum(validator_counts[p]["relative_vs_absolute"] for p in PRODUCTS)
    checked = sum(units[p]["rows_checked"] for p in PRODUCTS)
    out["relativo_por_precio_igual_al_absoluto"] = {"verdict": verdict(against, checked), "rows_checked": checked, "against": against}
    early = sum(diagnosis["per_product"][p]["publication"]["early_count"] for p in PRODUCTS)
    not_causal = sum(diagnosis["per_product"][p]["publication"]["not_causal_count"] for p in PRODUCTS)
    late = sum(diagnosis["per_product"][p]["publication"]["late_count"] for p in PRODUCTS)
    measured = sum(fd[p]["with_a_definitive_response"] for p in PRODUCTS)
    out["definitivo_a_los_10_min"] = {"verdict": verdict(early + not_causal, measured), "periods_measured": measured,
                                      "against_early": early, "against_not_causal": not_causal, "late": late,
                                      "periods_not_measurable": sum(fd[p]["without"] for p in PRODUCTS)}
    periods = sum(rev[p]["periods"] for p in PRODUCTS)
    conflicts = sum(rev[p]["periods_with_distinct_rates"] for p in PRODUCTS)
    out["primero_visto_gana"] = {"verdict": verdict(conflicts, periods), "periods": periods, "periods_with_distinct_rates": conflicts}
    return out


def validator_counts(report):
    """Counts of the validator findings that the hypotheses need, per product (``funding.relative_vs_absolute``)."""
    out = {p: {"relative_vs_absolute": 0} for p in PRODUCTS}
    for f in report.get("findings", ()):
        if f.get("check") == "funding.relative_vs_absolute" and f.get("product") in out:
            out[f["product"]]["relative_vs_absolute"] += int(f.get("count", 1))
    return out


def measure(official_rows, period_rows, responses):
    """All the aggregates from the rows read. Pure: no database."""
    periods, polls, adapter_events = m.funding_inputs(period_rows, responses)
    funding = m.evaluate_funding(official_rows, period_rows, responses)
    sample = {"source": "dev-live/%s" % m.DB_NAME, "version": TOOL_VERSION, "from_ms": WINDOW[0], "to_ms": WINDOW[1],
              "products": list(PRODUCTS), "holdout_exception": list(m.HOLDOUT_WINDOW)}
    refs = m.references(official_rows)
    raw = cv.validate_funding(periods, WINDOW[0], WINDOW[1], list(PRODUCTS), references=refs, responses=polls,
                              holdout_window=m.HOLDOUT_WINDOW)
    counts = validator_counts({"findings": raw.findings})
    diagnosis = diag.diagnose(period_rows, responses)
    cov, rev = coverage(period_rows), revisions(periods)
    first = first_definitive(periods, polls)
    units = units_and_reference(periods, official_rows)
    return {"coverage": cov, "revisions": rev, "publication": {"first_definitive_response": first, "classification": diagnosis},
            "units_and_reference": units, "timings": {"server_minus_receipt_ms": {p: diagnosis["per_product"][p]["server_minus_receipt_ms"]
                                                      for p in PRODUCTS},
                                                      "server_time_rejected": diagnosis["server_time_rejected"],
                                                      "server_time_shapes_parsed": diagnosis["server_time_shapes_parsed"]},
            "adapter": adapter_events, "validator_report": funding["funding_report"],
            "hypotheses": hypotheses(first, units, rev, diagnosis, counts)}


# ---------------------------------------------------------------------------------------------------- run

def build_result(conn, started=None, *, prior_rows):
    started = time.monotonic() if started is None else started
    result = {"tool_version": TOOL_VERSION, "decisions": list(DECISIONS), "products": list(PRODUCTS), "window_ms": list(WINDOW),
              "caps": {"2a": CAP_REFERENCE, "2c": m.CAPS["2c"], "2d": m.CAPS["2d"]}, "total_rows_cap": TOTAL_ROWS_CAP,
              "body_bytes_cap": MAX_BODY_BYTES, "query_time_limit_s": m.QUERY_TIMEOUT_S, "run_time_limit_s": m.RUN_TIMEOUT_S,
              "holdout_exception": list(m.HOLDOUT_WINDOW), "python_version": sys.version.split()[0],
              "note": "Aggregates only: no rate, price, volume, digit of a serverTime or response body is published. It measures what "
                      "the capture holds against the adapter's assumptions; it does not set thresholds and it is not a product rule.",
              "stopped": None}
    guard = None
    try:
        readback = conn.execute("PRAGMA query_only").fetchone()[0]       # before the authorizer, which denies every pragma
        result["guards"] = {"opened_with": "mode=ro", "query_only_readback": readback}
        if readback != 1:
            raise m.Stopped("connection_not_query_only")
        if isinstance(prior_rows, bool) or not isinstance(prior_rows, int) or prior_rows < 0:
            raise m.Stopped("prior_rows", "prior_rows must be a non-negative integer")
        need = need_rows()
        result["global_rows"] = {"cap": TOTAL_ROWS_CAP, "stage_rows_needed": need, "prior_rows_published_not_counted": prior_rows}
        if need > TOTAL_ROWS_CAP:
            raise m.Stopped("global_cap", {"cap": TOTAL_ROWS_CAP, "stage_rows_needed": need})
        result["sqlite_version"] = sqlite3.sqlite_version
        if sqlite3.sqlite_version_info < m.MIN_SQLITE:
            raise m.Stopped("sqlite_version", "octet_length() needs SQLite >= 3.43")
        guard = m._Guard(conn, started)
        ledger, reads = m.Ledger(), m.Reads()
        result["_ledger"], result["_reads"] = ledger, reads
        official = read_reference(guard, ledger)
        periods = m.read_2c(guard, ledger, reads)
        responses = m.read_2d(guard, ledger, reads)
        result["measurements"] = measure(official, periods, responses)
    except m.Stopped as stop:
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
        walked = sum(e.get("rows_walked", e["rows"]) for e in ledger.entries)
        total = walked + reads.total()
        result["rows_total"] = {"statement_rows_walked": walked, "single_row_reads": reads.total(),
                                "single_row_reads_by_kind": reads.count, "total": total, "cap": TOTAL_ROWS_CAP}
        if total > TOTAL_ROWS_CAP and result["stopped"] is None:     # cannot happen from the stage caps; checked, not assumed
            result["stopped"] = {"reason": "total_rows", "detail": {"total": total, "cap": TOTAL_ROWS_CAP}}
            result.pop("measurements", None)
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True, help="local live-capture database (opened read-only)")
    ap.add_argument("--prior-rows", required=True, type=int,
                    help="rows counted before this run against the 173 000 of BAL-DECISION-185-02; published, not added to this run's cap")
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
    dev_inode_before = diag._stat_pair(args.db)
    conn = m._open_readonly(args.db)
    try:
        result = build_result(conn, started, prior_rows=args.prior_rows)
    finally:
        conn.close()
    result["source"] = {"before": before, "after": m._identity(args.db), "elapsed_s": round(time.monotonic() - started, 3)}
    result["source"].update(diag._device_inode(args.db, dev_inode_before))
    result["exit_code"] = 2 if result["stopped"] else 0
    result["fingerprint_sha256"] = m.fingerprint(result)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return result["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
