"""Funding audit of the funding-dependent strategy (C32) in the replay (stage 9A, decision of Fran 2026-10-14).

The replay reproduces ``FundingContext.percentile`` exactly (it is reused, not reimplemented). This module only *describes*
what that calculation did at each evaluation and computes, on the side, what a strict reading would have said. Nothing here
feeds a decision, a trade or the accounting: it is analysis.

What ``FundingContext.percentile`` does (shared with the forward, frozen): it takes the newest stored period that is published
(its end + 10 min <= now) by *row index*, and as reference the 720 rows before it. So (a) if the latest due hour is missing it
silently uses an older one (implicit carry-forward) and (b) with holes the 720 rows span more than 30 natural days.

Strict reading (diagnostic only): the latest due hour must be present, the 720 natural hours before it must all be present, no
unknown hour is read as zero and nothing is carried forward. If that evidence is missing the strict result is ``unknown``,
never an alternative signal invented.
"""

import bisect

HOUR_MS = 3_600_000
WINDOW = 720
LAG_MS = 600_000


def _percentile(rate, window):
    below = sum(1 for x in window if x < rate)
    equal = sum(1 for x in window if x == rate)
    return 100.0 * (below + 0.5 * equal) / len(window)


def _signal(pct, bands):
    if pct is None or bands is None:
        return None
    low, high = bands
    return "SELL" if pct >= high else "BUY" if pct <= low else "WAIT"


def audit_record(context, at_ms, bands=None):
    """What the forward's funding line is at ``at_ms`` and what the strict reading says. ``bands`` = (low, high) percentiles."""
    starts = context.starts
    due = ((at_ms - LAG_MS - HOUR_MS) // HOUR_MS) * HOUR_MS          # the latest hour that is published at ``at_ms``
    index = bisect.bisect_right(starts, at_ms - HOUR_MS - LAG_MS) - 1
    record = {"decision_ms": at_ms, "due_hour_ms": due}
    if index < WINDOW:
        record.update(unknown=True, stale=False, long_window=False, strict_unknown=True, forward_percentile=None,
                      strict_percentile=None, forward_signal=None, strict_signal=None)
        return record
    used = starts[index]
    first, last = starts[index - WINDOW], starts[index - 1]
    span_hours = (last + HOUR_MS - first) // HOUR_MS
    carry = used < due
    pending = at_ms >= due + 2 * HOUR_MS                             # clock only: the next hour has ended but is still in its wait
    rate = context.rates[index]
    forward_pct = _percentile(rate, context.rates[index - WINDOW:index])
    present = context_set(context)
    strict_pct = None
    if not carry and all((due - n * HOUR_MS) in present for n in range(1, WINDOW + 1)):
        strict_pct = _percentile(rate, [context.rates[bisect.bisect_left(starts, due - n * HOUR_MS)] for n in range(WINDOW, 0, -1)])
    record.update(
        unknown=False, last_hour_used_ms=used, age_of_last_hour_ms=at_ms - (used + HOUR_MS), records_used=WINDOW,
        missing_hours_since_due=(due - used) // HOUR_MS, missing_hours_in_window=span_hours - WINDOW,
        window_hours=span_hours, carry_forward=carry, carry_forward_reason="data_gap" if carry else None,
        in_publication_wait=pending, stale=carry, long_window=span_hours > WINDOW,
        forward_percentile=forward_pct, strict_percentile=strict_pct, strict_unknown=strict_pct is None,
        forward_signal=_signal(forward_pct, bands), strict_signal=_signal(strict_pct, bands))
    return record


def context_set(context):
    cached = getattr(context, "_audit_set", None)
    if cached is None:
        cached = set(context.starts)
        context._audit_set = cached
    return cached


def classify(original, strict):
    """How the strict reading relates to the signal that was actually produced (BUY / SELL / WAIT; strict may be None)."""
    if original == "WAIT" and strict in ("WAIT", None):
        return "both_wait" if strict == "WAIT" else "wait_strict_unknown"
    if original == "WAIT":
        return "additional_in_strict"
    if strict is None:
        return "disappears_unknown"
    if strict == "WAIT":
        return "disappears_wait"
    return "same_entry" if strict == original else "different_direction"


def summarize(records):
    """Counts over the evaluations of the funding-dependent strategy. ``records``: dicts with ``original`` and the audit."""
    total = len(records)
    known = [r for r in records if not r["unknown"]]
    entries = [r for r in records if r["original"] != "WAIT"]
    classes = {}
    for r in records:
        classes[r["strict_class"]] = classes.get(r["strict_class"], 0) + 1
    diverging = sum(classes.get(k, 0) for k in ("additional_in_strict", "disappears_unknown", "disappears_wait", "different_direction"))
    return {
        "evaluations": total, "unknown_under_30_days": total - len(known),
        "with_carry_forward": sum(1 for r in known if r["carry_forward"]),
        "with_carry_forward_data_gap": sum(1 for r in known if r["carry_forward_reason"] == "data_gap"),
        "in_publication_wait": sum(1 for r in known if r["in_publication_wait"]),
        "with_incomplete_window": sum(1 for r in known if r["long_window"]),
        "max_window_hours": max((r["window_hours"] for r in known), default=None),
        "original_entries": len(entries),
        "original_entries_on_incomplete_evidence": sum(1 for r in entries if r["incomplete_evidence"]),
        "strict_unknown": sum(1 for r in known if r["strict_unknown"]),
        "strict_classes": dict(sorted(classes.items())),
        "original_entries_that_disappear_strict": classes.get("disappears_unknown", 0) + classes.get("disappears_wait", 0),
        "additional_or_different_in_strict": classes.get("additional_in_strict", 0) + classes.get("different_direction", 0),
        "divergence_pct_of_evaluations": None if not total else round(100.0 * diverging / total, 4),
        "divergence_pct_of_original_entries": None if not entries else round(
            100.0 * (classes.get("disappears_unknown", 0) + classes.get("disappears_wait", 0) + classes.get("different_direction", 0))
            / len(entries), 4),
        "note": "analysis only: the strict reading changes no decision, trade or accounting; it is not evidence of profitability"}
