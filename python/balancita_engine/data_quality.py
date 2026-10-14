"""Data and execution quality metrics (stage 9B): pure functions over observations, no I/O, no wall clock.

Everything here *measures*; nothing here decides. No threshold in this module is approved: the 120 s silence threshold
(``PaperRunnerConfig.coverage_gap_ms``), the execution policy and the sizing stay experimental hypotheses. The
functions take the candidate threshold as an argument and report what the data says about it, always with the sample
size, and ``threshold_evidence`` refuses to call a threshold validated.

Independent of ``PaperRunner``, ``Portfolio`` and ``ModelledExecutor`` (stage 9A owns them): inputs are plain dicts and
integers (milliseconds), so a collector, a replay or the runner can feed the same functions. Contract:
docs/calidad-datos-ejecucion-9b.md.

Evidence classes (every result carries one so that a modelled number is never read as an observed one; the first four
are the runner's observability classes, 8C section 12):
``observed`` (timestamps and prices that came from the exchange feed), ``modelled`` (produced by the cost model or a
simulated fill, e.g. the replay label ``MODELLED_EXECUTION``), ``estimated`` (derived from observations with a stated
bound), ``uncertain`` (coverage that cannot be shown), plus ``insufficient`` (not enough observations to report a
number). Anything not labelled ``observed`` is never treated as an observation.
"""

import math
from decimal import Decimal

from .futures_costs import side_impact_bps, spread_bps as model_spread_bps

D = Decimal
SCHEMA = "balancita-data-quality.v1"
TEN_THOUSAND = Decimal(10_000)
OBSERVED, MODELLED, ESTIMATED, UNCERTAIN, INSUFFICIENT = "observed", "modelled", "estimated", "uncertain", "insufficient"
P99_MIN_SAMPLES = 100                      # below this the 99th percentile is just the maximum: not reported
DEFAULT_MIN_SAMPLES = 30
SENSITIVITY_THRESHOLDS_MS = (10_000, 30_000, 60_000, 120_000, 300_000, 600_000)


# ---- small helpers --------------------------------------------------------------------------------------------
def percentile(sorted_values, q):
    """Nearest-rank percentile of an ascending list (q in 0..100); ``None`` on an empty list. No interpolation, so the
    result is always an observed value."""
    if not sorted_values:
        return None
    rank = max(1, -(-len(sorted_values) * q // 100))      # ceil(n * q / 100)
    return sorted_values[int(rank) - 1]


def summary(values, min_samples=DEFAULT_MIN_SAMPLES):
    values = sorted(values)
    n = len(values)
    out = {"n": n, "evidence": OBSERVED if n >= min_samples else INSUFFICIENT, "min_samples": min_samples}
    if n:
        out.update(min=values[0], p50=percentile(values, 50), p90=percentile(values, 90),
                   p99=percentile(values, 99) if n >= P99_MIN_SAMPLES else None, max=values[-1])
    return out


def rule_of_three_n(rate, confidence=0.95):
    """Observations needed so that *zero* events in ``n`` puts the true rate below ``rate`` at ``confidence``
    (n >= ln(1 - confidence) / ln(1 - rate); ~3/rate for 95 %). Used to size the evidence for a threshold."""
    if not 0 < rate < 1 or not 0 < confidence < 1:
        raise ValueError("rate and confidence must be in (0, 1)")
    return math.ceil(math.log(1 - confidence) / math.log(1 - rate))


# ---- 1. receive latency ---------------------------------------------------------------------------------------
def receive_latency(quotes, *, min_samples=DEFAULT_MIN_SAMPLES):
    """Per product: ``received_ms - time_ms`` (exchange timestamp to our receipt), in ms.

    Needs both stamps. A quote with only one is counted in ``missing_stamp`` and never guessed. A negative latency is
    clock skew or a bad stamp: it is counted in ``negative`` and excluded from the percentiles. The archive
    ``quote_snapshot`` keeps only ``received_at``, so it cannot feed this metric (see the contract, section 2.1).
    """
    per = {}
    for q in quotes:
        p = per.setdefault(q.get("product_id"), {"values": [], "missing_stamp": 0, "negative": 0})
        t, r = q.get("time_ms"), q.get("received_ms")
        if t is None or r is None:
            p["missing_stamp"] += 1
        elif r < t:
            p["negative"] += 1
        else:
            p["values"].append(int(r) - int(t))
    return {product: dict(summary(p["values"], min_samples), missing_stamp=p["missing_stamp"], negative=p["negative"])
            for product, p in sorted(per.items(), key=lambda kv: str(kv[0]))}


# ---- 2. silences and coverage ---------------------------------------------------------------------------------
def quote_gaps(times_ms, start_ms, end_ms, *, threshold_ms):
    """Silences in ``[start_ms, end_ms]`` given the instants at which a usable quote arrived.

    Each gap is the time between two consecutive evidence instants, plus the leading gap (window start to the first
    one) and the trailing gap (the last one to the window end); a window with no quote at all is one gap. Only gaps
    strictly longer than ``threshold_ms`` are listed, the same rule as the runner's ``coverage_gap_ms`` (silence
    ``> threshold``). Instants outside the window are ignored; duplicates collapse.
    """
    if end_ms < start_ms or threshold_ms < 0:
        raise ValueError("invalid window or threshold")
    points = sorted({int(t) for t in times_ms if start_ms <= t <= end_ms})
    edges = [start_ms] + points + [end_ms]
    gaps = []
    for i in range(len(edges) - 1):
        lo, hi = edges[i], edges[i + 1]
        if hi - lo > threshold_ms:
            kind = "no_quotes" if not points else "leading" if i == 0 else "trailing" if i == len(edges) - 2 else "internal"
            gaps.append({"from_ms": lo, "to_ms": hi, "duration_ms": hi - lo, "kind": kind})
    window = end_ms - start_ms
    silent = sum(g["duration_ms"] for g in gaps)
    return {"window_ms": window, "quotes": len(points), "threshold_ms": threshold_ms, "gaps": gaps,
            "silent_ms": silent, "max_gap_ms": max([g["duration_ms"] for g in gaps], default=0),
            "coverage_ratio": None if window == 0 else 1 - silent / window}


def gap_sensitivity(times_ms, start_ms, end_ms, thresholds_ms=SENSITIVITY_THRESHOLDS_MS):
    """The same window read at several thresholds: how much of the time would be called unobserved at each."""
    rows = []
    for threshold in thresholds_ms:
        r = quote_gaps(times_ms, start_ms, end_ms, threshold_ms=threshold)
        rows.append({"threshold_ms": threshold, "gaps": len(r["gaps"]), "silent_ms": r["silent_ms"],
                     "coverage_ratio": r["coverage_ratio"]})
    return rows


def stop_watch_coverage(entry_ms, exit_ms, quote_times_ms, candle_ranges=(), *, threshold_ms):
    """How well a position's stop was watched between entry and exit.

    ``quote_times_ms``: instants of quotes accepted *after* the entry (the quote that opened the position proves
    nothing and must not be passed). ``candle_ranges``: ``[from_ms, to_ms]`` spans of closed candles processed after
    the entry minute. Class (same vocabulary as ``closed_trade_coverage`` of the runner):

    * ``continuous``: no silence longer than the threshold;
    * ``gaps_covered_by_candles``: every silence lies inside processed candle ranges;
    * ``gaps_without_evidence``: at least one stretch longer than the threshold has neither quote nor candle;
    * ``insufficient_evidence``: the position never had a watched quote (not even a candle): never ``continuous``
      for being short.
    Open positions: pass the current instant as ``exit_ms``.
    """
    ranges = sorted([int(a), int(b)] for a, b in candle_ranges)
    base = quote_gaps(quote_times_ms, entry_ms, exit_ms, threshold_ms=threshold_ms)
    uncovered = []
    for gap in base["gaps"]:
        uncovered += [s for s in _subtract(gap["from_ms"], gap["to_ms"], ranges) if s[1] - s[0] > threshold_ms]
    if base["quotes"] == 0 and not ranges:
        cls = "insufficient_evidence"
    elif not base["gaps"]:
        cls = "continuous"
    elif not uncovered:
        cls = "gaps_covered_by_candles"
    else:
        cls = "gaps_without_evidence"
    evidence = {"continuous": OBSERVED, "gaps_covered_by_candles": ESTIMATED, "gaps_without_evidence": UNCERTAIN}
    return {"class": cls, "evidence": evidence.get(cls, INSUFFICIENT),
            "duration_ms": exit_ms - entry_ms, "quotes_watched": base["quotes"], "silences": base["gaps"],
            "uncovered": [{"from_ms": a, "to_ms": b, "duration_ms": b - a} for a, b in uncovered],
            "uncovered_ms": sum(b - a for a, b in uncovered), "threshold_ms": threshold_ms}


def _subtract(lo, hi, ranges):
    """The parts of ``[lo, hi]`` not covered by the (sorted) ranges."""
    out, cursor = [], lo
    for a, b in ranges:
        if b <= cursor or a >= hi:
            continue
        if a > cursor:
            out.append((cursor, a))
        cursor = max(cursor, b)
    if cursor < hi:
        out.append((cursor, hi))
    return out


# ---- 3. spread and impact -------------------------------------------------------------------------------------
def spread_bps(bid, ask):
    bid, ask = D(str(bid)), D(str(ask))
    if bid <= 0 or ask < bid:
        raise ValueError("invalid quote")
    return (ask - bid) / ((ask + bid) / 2) * TEN_THOUSAND


def spread_report(product_id, quotes, *, min_samples=DEFAULT_MIN_SAMPLES):
    """Observed spread of one product against the cost model's median.

    ``repeat_ratio``: share of consecutive quotes with the same bid and ask. A high value (the public
    ``analytics/spreads`` series repeats ~80 % of the minutes) means a forward-filled series and the percentiles
    describe it badly; this is reported, not corrected. Invalid quotes (crossed, non-positive) are counted apart.
    """
    values, invalid, repeats, previous = [], 0, 0, None
    for q in quotes:
        try:
            values.append(spread_bps(q["bid"], q["ask"]))
        except (KeyError, ValueError, ArithmeticError):
            invalid += 1
            continue
        pair = (str(q["bid"]), str(q["ask"]))
        repeats += pair == previous
        previous = pair
    out = summary(values, min_samples)
    out.update(product_id=product_id, invalid=invalid, model_median_bps=model_spread_bps(product_id),
               repeat_ratio=None if len(values) < 2 else repeats / (len(values) - 1))
    if values:
        out["observed_over_model"] = out["p50"] / model_spread_bps(product_id) if model_spread_bps(product_id) else None
    return out


def book_impact_bps(levels, side, notional_usd, mid):
    """Average slippage against ``mid`` (bp, positive = worse) of a market order of ``notional_usd`` that walks the
    book. ``levels``: the side being consumed, best first, ``[(price, size_in_base_units)]`` (asks for a buy, bids for
    a sell). ``None`` when the visible depth does not cover the notional (never extrapolated)."""
    remaining, cost, size = D(str(notional_usd)), D(0), D(0)
    for price, qty in levels:
        price, qty = D(str(price)), D(str(qty))
        if price <= 0 or qty <= 0:
            continue
        take = min(qty, remaining / price)
        cost += take * price
        size += take
        remaining -= take * price
        if remaining <= 0:
            break
    if remaining > 0 or size == 0:
        return None
    avg = cost / size
    mid = D(str(mid))
    move = (avg - mid) / mid * TEN_THOUSAND
    return move if side == "LONG" else -move


# ---- 4. modelled execution against observed evidence ----------------------------------------------------------
def execution_vs_model(fills, *, min_samples=DEFAULT_MIN_SAMPLES):
    """Compares the cost model with fills for which the quote is known.

    Each fill: ``{product_id, side, mid, price, execution}`` with ``mid`` the mid of the quote at the decision and
    ``price`` the price paid. ``execution`` says where the price came from: ``"observed"`` (real or captured
    quote-based fill) or ``"modelled"`` (a simulated fill). Only ``observed`` fills measure anything: the modelled
    ones are returned in ``excluded_modelled`` because comparing the model with itself proves nothing.

    ``residual_bps = observed slippage - model impact``; positive means the model was too optimistic.
    """
    per, excluded = {}, 0
    for f in fills:
        if f.get("execution") != OBSERVED:
            excluded += 1
            continue
        mid, price = D(str(f["mid"])), D(str(f["price"]))
        slip = (price - mid) / mid * TEN_THOUSAND
        slip = slip if f["side"] == "LONG" else -slip
        per.setdefault(f["product_id"], []).append((slip, slip - side_impact_bps(f["product_id"])))
    out = {}
    for product, rows in sorted(per.items()):
        residuals = [r for _, r in rows]
        s = summary(residuals, min_samples)
        mean = sum(residuals) / len(residuals)
        s.update(model_impact_bps=side_impact_bps(product), mean_residual_bps=mean,
                 observed_slippage=summary([x for x, _ in rows], min_samples),
                 optimistic_share=sum(1 for r in residuals if r > 0) / len(residuals))
        out[product] = s
    return {"products": out, "excluded_modelled": excluded, "schema": SCHEMA}


# ---- 5. evidence for the silence threshold --------------------------------------------------------------------
def gap_stop_exposure(gaps, candles, *, stop, side):
    """For each silence, was the stop price reached inside it according to the candles (the only dense source)?

    ``candles``: closed candles ``{open_ms, close_ms, low, high}``. A candle overlapping the gap counts if its range
    touched the stop (``low <= stop`` for LONG, ``high >= stop`` for SHORT). An overlapping candle is an upper bound:
    the touch could have been before or after the gap, so this is ``possible_breach``, never a confirmed miss.
    """
    stop = D(str(stop))
    out = []
    for g in gaps:
        touched = None
        overlapping = [c for c in candles if c["open_ms"] < g["to_ms"] and c["close_ms"] > g["from_ms"]]
        if overlapping:
            touched = any((D(str(c["low"])) <= stop) if side == "LONG" else (D(str(c["high"])) >= stop)
                          for c in overlapping)
        out.append(dict(g, possible_breach=touched, candles_overlapping=len(overlapping), evidence=ESTIMATED))
    return out


def threshold_evidence(silences_ms, observed_ms, *, threshold_ms, possible_breaches=None, max_breach_rate=0.01,
                       confidence=0.95):
    """What the data supports about one candidate threshold. Never returns an approval.

    ``silences_ms``: durations of every silence seen in ``observed_ms`` of watched position-time (all products
    pooled; do the per-product run too). ``possible_breaches``: for the silences above the threshold, how many had a
    candle that touched the stop (``gap_stop_exposure``), or ``None`` when not computed.

    ``verdict`` is ``insufficient_evidence`` unless the sample is large enough for the rule of three at
    ``max_breach_rate``; even then it is ``supports_review`` (a person decides), never ``approved``.
    """
    above = [s for s in silences_ms if s > threshold_ms]
    needed = rule_of_three_n(max_breach_rate, confidence)
    n_exposed = len(above)
    if possible_breaches is not None and not 0 <= possible_breaches <= n_exposed:
        raise ValueError("possible_breaches must be between 0 and the number of silences above the threshold")
    out = {"threshold_ms": threshold_ms, "silences_total": len(silences_ms), "silences_above": len(above),
           "observed_ms": observed_ms, "silent_share": None if not observed_ms else sum(above) / observed_ms,
           "possible_breaches": possible_breaches, "needed_observations": needed, "max_breach_rate": max_breach_rate,
           "confidence": confidence}
    if possible_breaches is None or n_exposed < needed:
        out["verdict"] = "insufficient_evidence"
        out["reason"] = "breach rate not computed" if possible_breaches is None else \
            "{} silences above threshold, {} needed".format(n_exposed, needed)
    elif possible_breaches > 0:
        out["verdict"] = "breaches_observed"
        out["reason"] = "{} of {} silences above the threshold had a candle touching the stop".format(possible_breaches, n_exposed)
    else:
        out["verdict"] = "supports_review"
        out["reason"] = "no possible breach in {} silences; a person must still decide".format(n_exposed)
    out["approved"] = False
    out["evidence"] = ESTIMATED if out["verdict"] != "insufficient_evidence" else INSUFFICIENT
    return out
