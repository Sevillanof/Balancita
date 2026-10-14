"""Offline validators: can the Kraken capture feed a verifiable paper session? (Issue #183)

Pure functions over plain records. They never open a database, call Kraken or read a capture: the caller hands
them rows already in memory (fixtures today; an authorized sample later). Records follow the capture's stored
shape (``paper_futures_funding_periods``, ``paper_futures_market_events`` ticker payloads, candle rows).

Every check returns ``Finding`` objects of exactly one kind, so the three failure sources never mix:

* ``ABSENT``           the capture has no datum where one is expected (a hole, a missing field);
* ``DISCREPANCY``      data is present but contradicts itself or the reference;
* ``VALIDATOR_ERROR``  the input could not be judged (malformed record, bad parameter): the validator's problem,
                       never evidence about the capture.

Nothing here adopts a threshold: ``calibrate_thresholds`` reports evidence per candidate and never picks one.
"""

import hashlib
import json
from collections import defaultdict
from decimal import Decimal, InvalidOperation

VALIDATOR_VERSION = "capture-validation.v1"
ABSENT = "ABSENT"
DISCREPANCY = "DISCREPANCY"
VALIDATOR_ERROR = "VALIDATOR_ERROR"
KINDS = (ABSENT, DISCREPANCY, VALIDATOR_ERROR)

HOUR_MS = 3_600_000
MINUTE_MS = 60_000
FIVE_MIN_MS = 300_000
# Holdout stays sealed: no validated range may reach it (project memory: holdout from 2026-08-02 UTC).
HOLDOUT_START_MS = 1_785_628_800_000  # 2026-08-02T00:00:00Z
CANDIDATE_THRESHOLDS_MS = (15_000, 25_000, 45_000)  # hypotheses, not approved values
ALLOWED_PRODUCTS = frozenset({
    "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD", "PF_ADAUSD", "PF_NEARUSD", "PF_HYPEUSD", "PF_ZECUSD",
})


class Finding(dict):
    """A dict (so it serializes as is) with a fixed, checked shape."""

    def __init__(self, kind, check, product, detail, **extra):
        if kind not in KINDS:
            raise ValueError("unknown finding kind")
        super().__init__(kind=kind, check=check, product=product, detail=detail, **extra)


def _dec(value, name):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError("{} must be a decimal string".format(name))
    try:
        number = Decimal(value)
    except InvalidOperation as error:
        raise ValueError("{} is not a decimal".format(name)) from error
    if not number.is_finite():
        raise ValueError("{} must be finite".format(name))
    return number


def _int(value, name):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("{} must be an integer".format(name))
    return value


def assert_range_allowed(from_ms, to_ms):
    """Refuse any validation range that touches the sealed holdout or is malformed."""
    _int(from_ms, "from_ms")
    _int(to_ms, "to_ms")
    if to_ms <= from_ms:
        raise ValueError("empty range")
    if to_ms > HOLDOUT_START_MS:
        raise ValueError("range reaches the holdout (>= 2026-08-02T00:00:00Z)")


def _guard(check, product, fn, findings):
    """Run one record's judgement; a malformed record is a validator error, not a capture discrepancy."""
    try:
        fn()
    except (ValueError, KeyError, TypeError) as error:
        findings.append(Finding(VALIDATOR_ERROR, check, product, "malformed input: {}".format(error)))


# ---------------------------------------------------------------- funding

def validate_funding(periods, from_ms, to_ms, references=None, abs_tolerance="0.000001", max_lag_ms=HOUR_MS):
    """Funding periods: units, reference price, period shape, publication, coverage, contradictory revisions.

    ``periods``: dicts with product_id, start_ms, end_ms, funding_rate (absolute, quote per base per hour, string),
    unit (``USD/<BASE>/hour``), known_at (receipt time), response_sha256 and optionally relative_rate (string, the
    provider's relative hourly rate). ``references``: ``{product: [(at_ms, price)]}`` provider prices.
    Relative = absolute / price; the pair is checked, never assumed. ``known_at`` of a backfilled period is the
    fetch time, so its lag says nothing about publication: only periods first seen near their end are judged.
    """
    findings = []
    assert_range_allowed(from_ms, to_ms)
    tolerance = Decimal(abs_tolerance)
    by_key = defaultdict(list)
    for index, row in enumerate(periods):
        def judge(row=row):
            product = row["product_id"]
            if product not in ALLOWED_PRODUCTS:
                raise ValueError("product outside the 8 PF_* perpetuals")
            start, end, known = _int(row["start_ms"], "start_ms"), _int(row["end_ms"], "end_ms"), _int(row["known_at"], "known_at")
            rate = _dec(row["funding_rate"], "funding_rate")
            base = product[3:-3].replace("XBT", "BTC")
            if row["unit"] != "USD/{}/hour".format(base):
                findings.append(Finding(DISCREPANCY, "funding.unit", product,
                                        "unit {!r} != USD/{}/hour".format(row["unit"], base), start_ms=start))
            if end - start != HOUR_MS or start % HOUR_MS:
                findings.append(Finding(DISCREPANCY, "funding.period", product,
                                        "period is not one aligned UTC hour", start_ms=start, end_ms=end))
            by_key[(product, start)].append((rate, row.get("response_sha256"), known))
            relative = row.get("relative_rate")
            if relative is not None:
                price = _reference_price(references, product, start)
                if price is None:
                    findings.append(Finding(ABSENT, "funding.reference_price", product,
                                            "relative rate has no provider price at or before the period",
                                            start_ms=start))
                elif abs(_dec(relative, "relative_rate") * price - rate) > tolerance:
                    findings.append(Finding(DISCREPANCY, "funding.relative_vs_absolute", product,
                                            "relative * price != absolute", start_ms=start))
            if known < end:
                findings.append(Finding(DISCREPANCY, "funding.publication", product,
                                        "known_at precedes the period end (not causal)", start_ms=start))
        _guard("funding.record[{}]".format(index), row.get("product_id") if isinstance(row, dict) else None, judge, findings)
    for (product, start), versions in sorted(by_key.items()):
        if len({rate for rate, _, _ in versions}) > 1:
            findings.append(Finding(DISCREPANCY, "funding.revision", product,
                                    "contradictory rates for one period across responses", start_ms=start,
                                    rates=sorted(str(rate) for rate, _, _ in versions)))
    products = sorted({p for p, _ in by_key})
    first = -(-from_ms // HOUR_MS) * HOUR_MS
    for product in products:
        have = {s for p, s in by_key if p == product}
        missing = [t for t in range(first, to_ms - HOUR_MS + 1, HOUR_MS) if t not in have]
        if missing:
            findings.append(Finding(ABSENT, "funding.coverage", product, "{} hourly periods missing".format(len(missing)),
                                    missing_count=len(missing), first_missing_ms=missing[0], last_missing_ms=missing[-1]))
    for product, versions_of in _lags(by_key).items():
        late = [s for s, lag in versions_of if lag > max_lag_ms and lag < 2 * HOUR_MS]
        if late:
            findings.append(Finding(DISCREPANCY, "funding.publication", product,
                                    "{} live periods published more than {} ms after their end".format(len(late), max_lag_ms),
                                    first_start_ms=late[0]))
    return findings


def _lags(by_key):
    out = defaultdict(list)
    for (product, start), versions in by_key.items():
        first_known = min(known for _, _, known in versions)
        out[product].append((start, first_known - (start + HOUR_MS)))
    return out


def _reference_price(references, product, at_ms):
    series = (references or {}).get(product) or []
    best = None
    for when, price in series:
        if when <= at_ms and (best is None or when > best[0]):
            best = (when, _dec(price, "reference price"))
    return best[1] if best and best[1] > 0 else None


# ------------------------------------------------------------------ quotes

def validate_quotes(quotes, from_ms, to_ms, stale_ms=45_000, skew_ms=5_000):
    """Top-of-book quotes: availability, identity, timestamps, arrival order, freshness, reconnections.

    ``quotes``: dicts in arrival order with product_id, bid, ask (strings or None), event_time, received_at, epoch
    and seq. Only top of book exists in the capture: depth is out of scope and reported as such by the caller.
    """
    findings = []
    assert_range_allowed(from_ms, to_ms)
    last = {}
    seen = defaultdict(int)
    for index, row in enumerate(quotes):
        def judge(row=row):
            product = row["product_id"]
            if product not in ALLOWED_PRODUCTS:
                raise ValueError("product outside the 8 PF_* perpetuals")
            received = _int(row["received_at"], "received_at")
            event = _int(row["event_time"], "event_time")
            if not from_ms <= received < to_ms:
                return
            seen[product] += 1
            if row.get("bid") is None or row.get("ask") is None:
                findings.append(Finding(ABSENT, "quote.bid_ask", product, "bid or ask missing", received_at=received))
            else:
                bid, ask = _dec(row["bid"], "bid"), _dec(row["ask"], "ask")
                if bid <= 0 or ask <= 0 or bid > ask:
                    findings.append(Finding(DISCREPANCY, "quote.bid_ask", product, "non-positive or crossed book",
                                            received_at=received))
            if abs(received - event) > skew_ms:
                findings.append(Finding(DISCREPANCY, "quote.timestamp_skew", product,
                                        "|received_at - event_time| exceeds {} ms".format(skew_ms), received_at=received))
            prev = last.get(product)
            if prev:
                if received < prev["received_at"]:
                    findings.append(Finding(DISCREPANCY, "quote.arrival_order", product,
                                            "received_at went backwards", received_at=received))
                elif row["epoch"] != prev["epoch"]:
                    findings.append(Finding(DISCREPANCY, "quote.reconnect", product, "epoch changed (reconnection)",
                                            received_at=received, from_epoch=prev["epoch"], to_epoch=row["epoch"]))
                elif row["seq"] != prev["seq"] + 1:
                    findings.append(Finding(ABSENT, "quote.sequence", product, "sequence gap inside an epoch",
                                            received_at=received, expected=prev["seq"] + 1, actual=row["seq"]))
                if received - prev["received_at"] > stale_ms:
                    findings.append(Finding(ABSENT, "quote.freshness", product,
                                            "silence of {} ms exceeds {} ms".format(received - prev["received_at"], stale_ms),
                                            from_ms=prev["received_at"], to_ms=received))
            last[product] = {"received_at": received, "epoch": row["epoch"], "seq": row["seq"]}
        _guard("quote.record[{}]".format(index), row.get("product_id") if isinstance(row, dict) else None, judge, findings)
    for product, info in last.items():
        if to_ms - info["received_at"] > stale_ms:
            findings.append(Finding(ABSENT, "quote.freshness", product, "range ends in a silence longer than the limit",
                                    from_ms=info["received_at"], to_ms=to_ms))
    for product in sorted(ALLOWED_PRODUCTS - set(seen)):
        findings.append(Finding(ABSENT, "quote.coverage", product, "no quote in the range"))
    return findings


# ----------------------------------------------------------------- candles

def aggregate_to_five_minutes(candles_1m):
    """Closed 1 m candles -> 5 m. Buckets are UTC-aligned, ``[start, start + 5 min)``; a bucket needs all 5 minutes."""
    buckets = defaultdict(dict)
    for candle in candles_1m:
        start = _int(candle["bucket_start"], "bucket_start")
        if start % MINUTE_MS:
            raise ValueError("1m candle not aligned to a minute")
        buckets[start - start % FIVE_MIN_MS][start] = candle
    out = {}
    for start, minutes in buckets.items():
        if sorted(minutes) != [start + i * MINUTE_MS for i in range(5)]:
            continue
        ordered = [minutes[start + i * MINUTE_MS] for i in range(5)]
        out[start] = {
            "bucket_start": start,
            "open": _dec(ordered[0]["open"], "open"),
            "high": max(_dec(c["high"], "high") for c in ordered),
            "low": min(_dec(c["low"], "low") for c in ordered),
            "close": _dec(ordered[-1]["close"], "close"),
            "volume": sum((_dec(c["volume"], "volume") for c in ordered), Decimal(0)),
        }
    return out


def validate_candles(product, candles_1m, official_5m, from_ms, to_ms, price_tol="0", volume_tol="0"):
    """Compare our 5 m aggregation with an equivalent official 5 m series supplied by the caller.

    Tolerances are explicit parameters (default exact); a nonzero one must be justified by the caller's report.
    Alignment is UTC and the close is the bucket end (exclusive). Quiet-minute candles are flat with zero volume in
    the official series, so a missing minute in ours is ABSENT, not a zero.
    """
    findings = []
    assert_range_allowed(from_ms, to_ms)
    ptol, vtol = Decimal(price_tol), Decimal(volume_tol)
    try:
        ours = aggregate_to_five_minutes(c for c in candles_1m if from_ms <= c["bucket_start"] < to_ms)
    except (ValueError, KeyError, TypeError) as error:
        return [Finding(VALIDATOR_ERROR, "candles.aggregate", product, "malformed input: {}".format(error))]
    official = {}
    for index, candle in enumerate(official_5m):
        def judge(candle=candle):
            start = _int(candle["bucket_start"], "bucket_start")
            if start % FIVE_MIN_MS:
                findings.append(Finding(DISCREPANCY, "candles.alignment", product,
                                        "official bucket not aligned to UTC 5 min", bucket_start=start))
            elif from_ms <= start < to_ms:
                official[start] = {k: _dec(candle[k], k) for k in ("open", "high", "low", "close", "volume")}
        _guard("candles.official[{}]".format(index), product, judge, findings)
    first = -(-from_ms // FIVE_MIN_MS) * FIVE_MIN_MS
    for start in range(first, to_ms - FIVE_MIN_MS + 1, FIVE_MIN_MS):
        mine, ref = ours.get(start), official.get(start)
        if mine is None and ref is None:
            findings.append(Finding(ABSENT, "candles.both", product, "no candle in either series", bucket_start=start))
        elif mine is None:
            findings.append(Finding(ABSENT, "candles.ours", product, "bucket missing or incomplete in the capture",
                                    bucket_start=start))
        elif ref is None:
            findings.append(Finding(ABSENT, "candles.official", product, "bucket missing in the reference series",
                                    bucket_start=start))
        else:
            for field in ("open", "high", "low", "close"):
                if abs(mine[field] - ref[field]) > ptol:
                    findings.append(Finding(DISCREPANCY, "candles." + field, product, "{} != {}".format(mine[field], ref[field]),
                                            bucket_start=start))
            vkey = "volume"
            if abs(mine[vkey] - ref[vkey]) > vtol:
                findings.append(Finding(DISCREPANCY, "candles.volume", product, "{} != {}".format(mine[vkey], ref[vkey]),
                                        bucket_start=start))
    return findings


# --------------------------------------------------------------- thresholds

def calibrate_thresholds(gaps_ms, candidates=CANDIDATE_THRESHOLDS_MS, max_false_alarm_rate=0.001, min_samples=1000):
    """Evidence per candidate silence threshold from observed inter-arrival gaps of a feed that was healthy.

    ``gaps_ms`` must come from intervals the caller knows had no outage (otherwise the rate is meaningless).
    A candidate whose false-alarm rate (share of healthy gaps above it) exceeds ``max_false_alarm_rate`` is
    ``rechazado``; one that does not is ``no_rechazado``, which is NOT approval. Fewer than ``min_samples`` gaps
    gives ``sin_evidencia``. The function never selects a value.
    """
    if not isinstance(max_false_alarm_rate, (int, float)) or not 0 <= max_false_alarm_rate < 1:
        raise ValueError("max_false_alarm_rate must be in [0, 1)")
    gaps = sorted(_int(g, "gap") for g in gaps_ms)
    if any(g < 0 for g in gaps):
        raise ValueError("negative gap")
    n = len(gaps)
    quantiles = {}
    if n:
        for q in (0.5, 0.9, 0.99, 0.999):
            quantiles["p{}".format(q * 100).rstrip("0").rstrip(".")] = gaps[min(n - 1, int(q * n))]
    rows = []
    for threshold in candidates:
        over = sum(1 for g in gaps if g > threshold)
        rate = over / n if n else None
        if n < min_samples:
            verdict = "sin_evidencia"
        elif rate > max_false_alarm_rate:
            verdict = "rechazado"
        else:
            verdict = "no_rechazado"
        rows.append({"threshold_ms": threshold, "samples": n, "over": over, "false_alarm_rate": rate, "verdict": verdict})
    return {"quantiles_ms": quantiles, "candidates": rows, "adopted": None}


# ----------------------------------------------------------------- report

def build_report(sample, findings):
    """Reproducible summary: sample identity + findings split by kind + a fingerprint of both.

    ``sample`` must name the source version/interval/products (and the holdout guard is applied to its range).
    Fitness is ``no_apta`` with any DISCREPANCY, ``bloqueada`` with ABSENT or VALIDATOR_ERROR (the sample cannot
    support a verdict), ``sin_hallazgos`` otherwise (not a claim of validity beyond the measured criteria).
    """
    for key in ("source", "version", "from_ms", "to_ms", "products"):
        if key not in sample:
            raise ValueError("sample is missing {}".format(key))
    assert_range_allowed(sample["from_ms"], sample["to_ms"])
    counts = {kind: sum(1 for f in findings if f["kind"] == kind) for kind in KINDS}
    if counts[DISCREPANCY]:
        fitness = "no_apta"
    elif counts[ABSENT] or counts[VALIDATOR_ERROR]:
        fitness = "bloqueada"
    else:
        fitness = "sin_hallazgos"
    body = {"validator_version": VALIDATOR_VERSION, "sample": sample, "counts": counts, "fitness": fitness,
            "findings": sorted(findings, key=lambda f: json.dumps(f, sort_keys=True))}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return dict(body, fingerprint=digest)
