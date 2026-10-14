"""Parity of two funding sources for the replay (stage 9A, decision of Fran 2026-10-14, option B). Read-only.

Compares the funding that the forward reads (``futures_funding_context.load_periods``: the oldest and the two newest stored
responses, first seen wins) with another market database (the replay's source), inside ``[LO, cap)`` only:

* both are read with ``ReplayDataGate`` (``mode=ro``, ``query_only``), as a bounded stream that stops at the first period at
  or after the cap, so the reserved period is not processed. A response that is not in increasing order stops the audit
  (``DataError``): the bound could not be guaranteed;
* per source: the responses selected (sha, received_at, bytes read), the periods, the missing hours, and the periods each
  response contributes;
* between sources: hours present in only one, rates that differ (text and the float the forward uses), and for each of
  them whether the hour is recorded elsewhere in the source's ``paper_futures_funding_periods`` (metadata only: start and
  response; the absolute rate is neither read nor converted);
* ``FundingContext.percentile`` (reused, not reimplemented) at every instant a new hour is published, from both sources:
  the funding percentile is what C32 reads, so equal percentiles mean equal C32 funding conditions. The strict reading
  (720 consecutive natural hours, ``unknown`` otherwise) is reported separately and never replaces anything.

Nothing is written except the report the command line is asked for.
"""

import json
import os
import sys

from . import replay_data as RD
from . import replay_funding_audit as RFA
from .futures_funding_context import FundingContext

HOUR_MS = RD.HOUR_MS
LAG_MS = RFA.LAG_MS


def _source(path, product, lo_ms, hi_ms):
    gate = RD.ReplayDataGate(path, lo_ms, hi_ms)
    try:
        shas = gate._response_shas(product)
        meta = {r[0]: r[1] for r in gate.db.execute(
            "SELECT sha256, received_at FROM paper_futures_funding_responses WHERE sha256 IN ({})".format(",".join("?" * len(shas))),
            shas)} if shas else {}
        per_response, merged = [], {}
        for sha in shas:
            gate.funding_bytes_read, gate.funding_stopped_at = 0, None
            rows = {}
            for start_ms, rate in gate._stream_rates(sha):
                rows[start_ms] = RD._decimal_text(rate)
            size = gate.db.execute("SELECT length(CAST(raw_response AS BLOB)) FROM paper_futures_funding_responses WHERE sha256=?",
                                   (sha,)).fetchone()[0]
            per_response.append({"sha256": sha, "received_at": meta.get(sha), "periods": len(rows),
                                 "first": min(rows) if rows else None, "last": max(rows) if rows else None,
                                 "bytes_read": gate.funding_bytes_read, "bytes_stored": size,
                                 "stopped_at_ms": gate.funding_stopped_at})
            for start_ms, rate in rows.items():
                merged.setdefault(start_ms, rate)
        revisions = _revisions(shas, gate, product, lo_ms, hi_ms)
        columns = [r[1] for r in gate.db.execute("PRAGMA table_info(paper_futures_funding_periods)")]
        return {"path_name": os.path.basename(path), "responses": per_response, "periods": sorted(merged.items()),
                "revision_differences_between_selected_responses": revisions, "periods_table_columns": columns,
                "reader": "blobopen" if hasattr(gate.db, "blobopen") else "substr_blob"}, gate
    except Exception:
        gate.close()
        raise


def _revisions(shas, gate, product, lo_ms, hi_ms):
    """Hours that two selected responses report with different rates (the forward keeps the first)."""
    seen, diffs = {}, []
    for sha in shas:
        for start_ms, rate in gate._stream_rates(sha):
            if start_ms in seen and seen[start_ms][1] != rate:
                diffs.append({"start_ms": start_ms, "first": seen[start_ms][1], "later": rate})
            seen.setdefault(start_ms, (sha, rate))
    return diffs[:200]


def _hour_records(gate, product, hours):
    """Metadata only: which responses record each of these hours in ``paper_futures_funding_periods``."""
    out = {}
    for h in hours[:200]:
        rows = gate.db.execute("SELECT COUNT(*), COUNT(DISTINCT response_sha256) FROM paper_futures_funding_periods "
                               "WHERE product_id=? AND start_ms=?", (product, h)).fetchone() \
            if "product_id" in [r[1] for r in gate.db.execute("PRAGMA table_info(paper_futures_funding_periods)")] else (None, None)
        out[str(h)] = {"rows": rows[0], "responses": rows[1]}
    return out


def _publication_instants(periods, lo_ms, hi_ms):
    starts = [s for s, _ in periods]
    return [s + HOUR_MS + LAG_MS for s in starts if lo_ms <= s + HOUR_MS + LAG_MS < hi_ms]


def compare_sources(forward_db, other_db, product, lo_ms=RD.LO_MS, hi_ms=RD.HI_EXCL_MS):
    RD.check_window(lo_ms, hi_ms)
    a, gate_a = _source(forward_db, product, lo_ms, hi_ms)
    try:
        b, gate_b = _source(other_db, product, lo_ms, hi_ms)
    except Exception:
        gate_a.close()
        raise
    try:
        pa, pb = dict(a["periods"]), dict(b["periods"])
        only_a, only_b = sorted(set(pa) - set(pb)), sorted(set(pb) - set(pa))
        both = sorted(set(pa) & set(pb))
        differing = [{"start_ms": s, "forward": pa[s], "other": pb[s]} for s in both if pa[s] != pb[s]]
        float_diff = [d for d in differing if float(d["forward"]) != float(d["other"])]
        first = min(list(pa) + list(pb), default=lo_ms)
        last = max(list(pa) + list(pb), default=lo_ms)
        expected = range((first // HOUR_MS) * HOUR_MS, last + HOUR_MS, HOUR_MS)
        missing_a = [h for h in expected if h not in pa]
        missing_b = [h for h in expected if h not in pb]
        ca = FundingContext([(s, float(r)) for s, r in a["periods"]])
        cb = FundingContext([(s, float(r)) for s, r in b["periods"]])
        instants = sorted(set(_publication_instants(a["periods"], lo_ms, hi_ms)) | set(_publication_instants(b["periods"], lo_ms, hi_ms)))
        compared = unequal = unknown_a = unknown_b = 0
        signal_differences, examples = 0, []
        strict = {"forward_unknown": 0, "other_unknown": 0, "instants": 0}
        for at in instants:
            fa, fb = ca.percentile(at), cb.percentile(at)
            unknown_a += fa is None
            unknown_b += fb is None
            if fa is None or fb is None:
                if (fa is None) != (fb is None):
                    unequal += 1
                continue
            compared += 1
            if fa != fb:
                unequal += 1
                if len(examples) < 10:
                    examples.append({"at_ms": at, "forward": fa, "other": fb})
            sig = lambda f: "SELL" if f[1] >= 90 else "BUY" if f[1] <= 10 else "WAIT"   # noqa: E731  C32's bands
            signal_differences += sig(fa) != sig(fb)
            ra, rb = RFA.audit_record(ca, at, (10.0, 90.0)), RFA.audit_record(cb, at, (10.0, 90.0))
            strict["instants"] += 1
            strict["forward_unknown"] += ra["strict_unknown"]
            strict["other_unknown"] += rb["strict_unknown"]
        report = {
            "schema": "balancita-replay-funding-parity.v1", "product": product,
            "range": {"lo_ms": lo_ms, "hi_excl_ms": hi_ms},
            "forward_source": {k: v for k, v in a.items() if k != "periods"} | {"periods": len(a["periods"]), "missing_hours": len(missing_a),
                                                                               "missing_hours_list": missing_a[:50]},
            "other_source": {k: v for k, v in b.items() if k != "periods"} | {"periods": len(b["periods"]), "missing_hours": len(missing_b),
                                                                              "missing_hours_list": missing_b[:50]},
            "periods": {"only_in_forward": only_a[:100], "only_in_other": only_b[:100], "count_only_in_forward": len(only_a),
                        "count_only_in_other": len(only_b), "in_both": len(both), "rate_text_differences": differing[:100],
                        "count_rate_text_differences": len(differing), "count_rate_float_differences": len(float_diff)},
            "missing_hours_forward_recorded_in_periods_table": _hour_records(gate_a, product, missing_a),
            "missing_hours_other_recorded_in_periods_table": _hour_records(gate_b, product, missing_b),
            "percentile": {"instants_compared": compared, "unequal": unequal, "unknown_forward": unknown_a, "unknown_other": unknown_b,
                           "examples": examples, "c32_signal_differences": signal_differences},
            "strict_reading_diagnostic": strict,
        }
        equivalent = (not only_a and not only_b and not differing and unequal == 0 and signal_differences == 0
                      and missing_a == missing_b)
        report["verdict"] = {"equivalent": equivalent, "verdict": "GO" if equivalent else "NO-GO",
                             "reason": "same periods, same rates, same missing hours, same percentile at every publication instant"
                             if equivalent else "the sources differ: see periods / percentile / missing hours",
                             "scope": "inside the authorised range only; nothing at or after the cap was processed beyond the first "
                                      "reserved period needed to detect the limit"}
        return report
    finally:
        gate_a.close()
        gate_b.close()


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 4:
        print("usage: replay_funding_parity FORWARD_MARKET_DB OTHER_MARKET_DB PRODUCT OUT.json", file=sys.stderr)
        return 2
    try:
        report = compare_sources(argv[0], argv[1], argv[2])
    except (RD.DataError, RD.RangeGateError) as error:
        print("funding parity stopped: {}".format(error), file=sys.stderr)
        return 3
    partial = argv[3] + ".partial"
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=1, sort_keys=True)
    os.replace(partial, argv[3])
    print(json.dumps({"verdict": report["verdict"], "percentile": report["percentile"], "periods": {
        k: v for k, v in report["periods"].items() if k.startswith("count")}}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
