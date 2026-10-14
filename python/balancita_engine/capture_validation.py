"""Offline validators: can the Kraken capture feed a verifiable paper session? (Issue #183)

Pure functions over plain records. They never open a database, call Kraken or read a capture: the caller hands
them rows already in memory (fixtures today; an authorized sample later). Records follow the capture's stored
shape (``paper_futures_funding_periods`` plus the response table, ticker events, candle rows). The adapter that
loads a real sample must take ``relative_rate`` (the provider's ``relativeFundingRate``) and ``product_id`` from
``raw_response``/the period row; the stored ``funding_rate`` alone cannot show the relative unit.

Every check returns ``Finding`` objects of exactly one kind, so the three failure sources never mix:

* ``ABSENT``           the capture has no datum where one is expected, or the sample cannot measure the
                       criterion (``not_measurable``: nothing was judged);
* ``DISCREPANCY``      data is present but contradicts itself or the reference;
* ``VALIDATOR_ERROR``  the input could not be judged (malformed record, bad parameter, a row that reaches the
                       holdout): the validator's problem, never evidence about the capture.

Each validator returns a ``Result``: findings, ``coverage`` (how many records each check actually judged, per
expected product) and ``events`` (facts that are not defects, such as reconnections). A check that judged zero
records is ``ABSENT``/``not_measurable``, never silent success. Nothing here adopts a threshold:
``calibrate_thresholds`` reports evidence per candidate and never picks one.
"""

import hashlib
import json
from collections import defaultdict
from decimal import Decimal, InvalidOperation

VALIDATOR_VERSION = "capture-validation.v2"
ABSENT = "ABSENT"
DISCREPANCY = "DISCREPANCY"
VALIDATOR_ERROR = "VALIDATOR_ERROR"
KINDS = (ABSENT, DISCREPANCY, VALIDATOR_ERROR)

HOUR_MS = 3_600_000
MINUTE_MS = 60_000
FIVE_MIN_MS = 300_000
# Holdout stays sealed: no validated range may reach it (project memory: holdout from 2026-08-02 UTC).
HOLDOUT_START_MS = 1_785_628_800_000  # 2026-08-02T00:00:00Z, exclusive end of what may be validated
CANDIDATE_THRESHOLDS_MS = (15_000, 25_000, 45_000)  # hypotheses, not approved values
ALLOWED_PRODUCTS = frozenset({
    "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD", "PF_ADAUSD", "PF_NEARUSD", "PF_HYPEUSD", "PF_ZECUSD",
})
# What a report must have judged, per family, for every expected product, before it can say "sin_hallazgos".
REQUIRED_CHECKS = {
    "funding": ("funding.rows", "funding.publication", "funding.relative"),
    "quotes": ("quote.records", "quote.intervals"),
    "candles": ("candles.buckets",),
}


class Finding(dict):
    """A dict (so it serializes as is) with a fixed, checked shape."""

    def __init__(self, kind, check, product, detail, **extra):
        if kind not in KINDS:
            raise ValueError("unknown finding kind")
        super().__init__(kind=kind, check=check, product=product, detail=detail, **extra)


class Result:
    """Findings + what was actually judged + non-defect events of one validator run."""

    def __init__(self, family, products, from_ms=None, to_ms=None, params=None):
        if family not in REQUIRED_CHECKS:
            raise ValueError("unknown validator family")
        self.family = family
        self.products = _products(products)
        self.from_ms, self.to_ms = from_ms, to_ms  # the range this run judged; build_report compares it to the sample
        self.params = dict(params or {})  # every threshold/tolerance used, so the report declares them
        self.findings = []
        self.events = []
        self.coverage = {check: {p: 0 for p in self.products} for check in REQUIRED_CHECKS[family]}

    def judged(self, check, product, count=1):
        if product in self.coverage[check]:
            self.coverage[check][product] += count

    def close(self):
        """Every expected product with zero judged records of a check is reported, never skipped."""
        for check, per_product in self.coverage.items():
            for product, count in per_product.items():
                if count == 0 and not any(f["check"] == check and f["product"] == product and f["kind"] == ABSENT
                                          for f in self.findings):
                    self.findings.append(Finding(ABSENT, check, product, "not_measurable: no record was judged",
                                                 not_measurable=True))
        return self


def _products(products):
    if isinstance(products, (str, bytes)) or not products:
        raise ValueError("products must be a non-empty list")
    out = sorted(set(products))
    if any(p not in ALLOWED_PRODUCTS for p in out):
        raise ValueError("product outside the 8 PF_* perpetuals")
    return out


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


def _guard(result, check, product, fn):
    """Run one record's judgement; a malformed record is a validator error, not a capture discrepancy."""
    try:
        fn()
    except (ValueError, KeyError, TypeError) as error:
        result.findings.append(Finding(VALIDATOR_ERROR, check, product, "malformed input: {}".format(error)))


MAX_TOLERANCE = Decimal("0.5")


def _check_tolerance(*tolerances):
    """A tolerance is a fraction of the magnitude; at 50 % or more (or negative) it would excuse any unit error."""
    for tolerance in tolerances:
        if tolerance < 0 or tolerance >= MAX_TOLERANCE:
            raise ValueError("effective tolerance must be in [0, 0.5)")


def _holdout_error(result, check, product):
    # Deliberately no values from the row: a holdout record is dropped, never judged or echoed.
    result.findings.append(Finding(VALIDATOR_ERROR, check, product, "record reaches the holdout: dropped, not judged"))


# ---------------------------------------------------------------- funding

def validate_funding(periods, from_ms, to_ms, products, references=None, responses=None, rel_tolerance="0.0001",
                     max_lag_ms=HOUR_MS, max_reference_age_ms=2 * HOUR_MS, max_price_drift_per_hour="0.01"):
    """Funding periods: units, reference price, period shape, publication, coverage, contradictory revisions.

    ``periods``: dicts with product_id, start_ms, end_ms, funding_rate (absolute, quote per base per hour, string),
    unit (``USD/<BASE>/hour``), known_at (receipt time), response_sha256, optionally relative_rate (string).
    ``references``: ``{product: [(at_ms, price)]}``; a price older than ``max_reference_age_ms`` before the period
    does not count. ``rel_tolerance`` is relative (error / magnitude), so it scales with the price, and it grows by
    ``max_price_drift_per_hour`` per hour of reference age (counted to the period end, the later of the two
    instants Kraken could use), so an ordinary price move is not read as a unit error. The instant of the price
    Kraken itself used is NOT established (open question of #167): a ``funding.relative_vs_absolute`` finding is
    evidence of a unit/magnitude mismatch only, never of a capture defect at the tolerance's resolution.
    ``responses``: ``[{product_id, received_at, starts: [period starts it contains]}]``, the polls that fetched
    funding. ``known_at`` is OUR receipt time, not Kraken's publication time, so publication is judged only with
    responses: a period is timely if the first response holding it arrived by ``end + max_lag_ms``; late only if
    a response after that deadline still lacked it; otherwise ``not_measurable`` (the collector was not looking).
    """
    assert_range_allowed(from_ms, to_ms)
    result = Result("funding", products, from_ms, to_ms, {
        "rel_tolerance": rel_tolerance, "max_lag_ms": max_lag_ms, "max_reference_age_ms": max_reference_age_ms,
        "max_price_drift_per_hour": max_price_drift_per_hour})
    rel_tol, drift = Decimal(rel_tolerance), Decimal(max_price_drift_per_hour)
    _check_tolerance(rel_tol, drift, rel_tol + drift * Decimal(max_reference_age_ms + HOUR_MS) / Decimal(HOUR_MS))
    no_relative = defaultdict(list)
    by_key = defaultdict(list)
    judged_starts = defaultdict(set)
    for index, row in enumerate(periods):
        def judge(row=row):
            product = row["product_id"]
            if product not in result.products:
                raise ValueError("product not in the expected list")
            start, end, known = _int(row["start_ms"], "start_ms"), _int(row["end_ms"], "end_ms"), _int(row["known_at"], "known_at")
            if start >= HOLDOUT_START_MS or end > HOLDOUT_START_MS:
                return _holdout_error(result, "funding.rows", product)
            if start < from_ms or end > to_ms:
                return
            rate = _dec(row["funding_rate"], "funding_rate")
            base = product[3:-3].replace("XBT", "BTC")
            result.judged("funding.rows", product)
            judged_starts[product].add(start)
            if row["unit"] != "USD/{}/hour".format(base):
                result.findings.append(Finding(DISCREPANCY, "funding.unit", product,
                                               "unit {!r} != USD/{}/hour".format(row["unit"], base), start_ms=start))
            if end - start != HOUR_MS or start % HOUR_MS:
                result.findings.append(Finding(DISCREPANCY, "funding.period", product,
                                               "period is not one aligned UTC hour", start_ms=start, end_ms=end))
            by_key[(product, start)].append((rate, known))
            relative = row.get("relative_rate")
            if relative is None:
                no_relative[product].append(start)
            else:
                price, price_at = _reference_price(references, product, start, max_reference_age_ms)
                if price is None:
                    result.findings.append(Finding(ABSENT, "funding.reference_price", product,
                                                   "relative rate has no fresh provider price at or before the period",
                                                   start_ms=start))
                else:
                    result.judged("funding.relative", product)
                    implied = _dec(relative, "relative_rate") * price
                    age_h = Decimal(end - price_at) / Decimal(HOUR_MS)
                    tolerance = rel_tol + drift * age_h
                    if abs(implied - rate) > tolerance * max(abs(implied), abs(rate)):
                        result.findings.append(Finding(DISCREPANCY, "funding.relative_vs_absolute", product,
                                                       "relative * price differs from absolute beyond the age-scaled tolerance",
                                                       start_ms=start, tolerance=str(tolerance)))
            if known < end:
                result.findings.append(Finding(DISCREPANCY, "funding.publication", product,
                                               "known_at precedes the period end (not causal)", start_ms=start))
        _guard(result, "funding.record[{}]".format(index), row.get("product_id") if isinstance(row, dict) else None, judge)
    for (product, start), versions in sorted(by_key.items()):
        if len({rate for rate, _ in versions}) > 1:
            result.findings.append(Finding(DISCREPANCY, "funding.revision", product,
                                           "contradictory rates for one period across responses", start_ms=start,
                                           rates=sorted(str(rate) for rate, _ in versions)))
    polls = _parse_responses(result, responses)
    first = -(-from_ms // HOUR_MS) * HOUR_MS
    for product in result.products:
        if no_relative[product]:
            result.findings.append(Finding(ABSENT, "funding.relative", product,
                                           "{} judged rows carry no relative_rate: unit not checked for them".format(len(no_relative[product])),
                                           count=len(no_relative[product]), first_start_ms=min(no_relative[product])))
        missing = [t for t in range(first, to_ms - HOUR_MS + 1, HOUR_MS) if t not in judged_starts[product]]
        if missing:
            result.findings.append(Finding(ABSENT, "funding.coverage", product, "{} hourly periods missing".format(len(missing)),
                                           missing_count=len(missing), first_missing_ms=missing[0], last_missing_ms=missing[-1]))
        _publication(result, product, sorted(judged_starts[product]), polls.get(product, []), max_lag_ms)
    return result.close()


def _parse_responses(result, responses):
    """Group the collector polls by product once; a poll inside the holdout is dropped, a malformed one reported once."""
    polls = defaultdict(list)
    for index, resp in enumerate(responses or []):
        def parse(resp=resp):
            product = resp["product_id"]
            at = _int(resp["received_at"], "received_at")
            starts = frozenset(_int(s, "start") for s in resp["starts"])
            if at >= HOLDOUT_START_MS:
                return _holdout_error(result, "funding.response", product)
            polls[product].append((at, starts))
        _guard(result, "funding.response[{}]".format(index), resp.get("product_id") if isinstance(resp, dict) else None, parse)
    for product in polls:
        polls[product].sort(key=lambda p: p[0])
    return polls


def _publication(result, product, starts, polls, max_lag_ms):
    late, unknown = [], []
    for start in starts:
        deadline = start + HOUR_MS + max_lag_ms
        holders = [at for at, held in polls if start in held]
        first = holders[0] if holders else None
        if first is not None and first < start + HOUR_MS:
            result.findings.append(Finding(DISCREPANCY, "funding.publication", product,
                                           "a response taken before the period ended already holds it (not causal)", start_ms=start))
        elif first is not None and first <= deadline:
            result.judged("funding.publication", product)
        elif any(deadline < at and (first is None or at < first) for at, _ in polls):
            result.judged("funding.publication", product)
            late.append(start)
        else:
            unknown.append(start)
    if late:
        result.findings.append(Finding(DISCREPANCY, "funding.publication", product,
                                       "{} periods still missing from a response taken more than {} ms after their end".format(
                                           len(late), max_lag_ms), first_start_ms=late[0], count=len(late)))
    if unknown:
        result.findings.append(Finding(ABSENT, "funding.publication", product,
                                       "not_measurable: {} periods have no response proving timely or late publication "
                                       "(known_at is our receipt time, not Kraken's)".format(len(unknown)),
                                       not_measurable=True, first_start_ms=unknown[0], last_start_ms=unknown[-1], count=len(unknown)))


def _reference_price(references, product, at_ms, max_age_ms):
    best = None
    for when, price in (references or {}).get(product) or []:
        if when <= at_ms and at_ms - when <= max_age_ms and (best is None or when > best[0]):
            best = (when, _dec(price, "reference price"))
    return (best[1], best[0]) if best and best[1] > 0 else (None, None)


# ------------------------------------------------------------------ quotes

def validate_quotes(quotes, from_ms, to_ms, products, stale_ms=45_000, skew_ms=5_000, contiguous_seq=False):
    """Top-of-book quotes: availability, identity, timestamps, arrival order, freshness, reconnections.

    ``quotes``: dicts in arrival order with product_id, bid, ask (strings or None), event_time, received_at, epoch
    and seq. The REST ticker poll stores ``seq = received_at``, so the default only requires seq to increase
    inside an epoch; ``contiguous_seq=True`` is for a feed whose seq counts messages. A new epoch is a
    reconnection: it goes to ``events``, not to findings. Only top of book exists: depth is out of scope.
    A product needs at least two quotes before any interval (order, freshness) is judged; the silence before
    the first quote and after the last counts.
    """
    assert_range_allowed(from_ms, to_ms)
    result = Result("quotes", products, from_ms, to_ms, {"stale_ms": stale_ms, "skew_ms": skew_ms, "contiguous_seq": contiguous_seq})
    last = {}
    for index, row in enumerate(quotes):
        def judge(row=row):
            product = row["product_id"]
            if product not in result.products:
                raise ValueError("product not in the expected list")
            received = _int(row["received_at"], "received_at")
            event = _int(row["event_time"], "event_time")
            if received >= HOLDOUT_START_MS:
                return _holdout_error(result, "quote.records", product)
            if not from_ms <= received < to_ms:
                return
            result.judged("quote.records", product)
            if row.get("bid") is None or row.get("ask") is None:
                result.findings.append(Finding(ABSENT, "quote.bid_ask", product, "bid or ask missing", received_at=received))
            else:
                bid, ask = _dec(row["bid"], "bid"), _dec(row["ask"], "ask")
                if bid <= 0 or ask <= 0 or bid > ask:
                    result.findings.append(Finding(DISCREPANCY, "quote.bid_ask", product, "non-positive or crossed book",
                                                   received_at=received))
            if abs(received - event) > skew_ms:
                result.findings.append(Finding(DISCREPANCY, "quote.timestamp_skew", product,
                                               "received_at and event_time differ by more than {} ms".format(skew_ms),
                                               received_at=received))
            prev = last.get(product)
            if prev is None:
                if received - from_ms > stale_ms:
                    result.findings.append(Finding(ABSENT, "quote.freshness", product,
                                                   "initial silence of {} ms exceeds {} ms".format(received - from_ms, stale_ms),
                                                   from_ms=from_ms, to_ms=received))
            else:
                result.judged("quote.intervals", product)
                if received < prev["received_at"]:
                    result.findings.append(Finding(DISCREPANCY, "quote.arrival_order", product,
                                                   "received_at went backwards", received_at=received))
                elif row["epoch"] != prev["epoch"]:
                    result.events.append({"event": "reconnect", "product": product, "received_at": received,
                                          "from_epoch": prev["epoch"], "to_epoch": row["epoch"]})
                elif row["seq"] <= prev["seq"]:
                    result.findings.append(Finding(DISCREPANCY, "quote.arrival_order", product,
                                                   "seq did not increase inside an epoch", received_at=received))
                elif contiguous_seq and row["seq"] != prev["seq"] + 1:
                    result.findings.append(Finding(ABSENT, "quote.sequence", product, "sequence gap inside an epoch",
                                                   received_at=received, expected=prev["seq"] + 1, actual=row["seq"]))
                if received - prev["received_at"] > stale_ms:
                    result.findings.append(Finding(ABSENT, "quote.freshness", product,
                                                   "silence of {} ms exceeds {} ms".format(received - prev["received_at"], stale_ms),
                                                   from_ms=prev["received_at"], to_ms=received))
            last[product] = {"received_at": received, "epoch": row["epoch"], "seq": row["seq"]}
        _guard(result, "quote.record[{}]".format(index), row.get("product_id") if isinstance(row, dict) else None, judge)
    for product in result.products:
        info = last.get(product)
        if info is None:
            result.findings.append(Finding(ABSENT, "quote.coverage", product, "no quote in the range"))
        elif to_ms - info["received_at"] > stale_ms:
            result.findings.append(Finding(ABSENT, "quote.freshness", product, "range ends in a silence longer than the limit",
                                           from_ms=info["received_at"], to_ms=to_ms))
    return result.close()


# ----------------------------------------------------------------- candles

def _candle_key(candle, fields):
    return tuple(str(_dec(candle[k], k)) for k in fields)


def aggregate_to_five_minutes(candles_1m):
    """Closed 1 m candles -> 5 m. Buckets are UTC-aligned, ``[start, start + 5 min)``; a bucket needs all 5 minutes.

    Two rows for one minute with different content are a conflict and raise: callers decide what to do with it
    (``validate_candles`` reports them and leaves the bucket out).
    """
    buckets = defaultdict(dict)
    for candle in candles_1m:
        start = _int(candle["bucket_start"], "bucket_start")
        if start % MINUTE_MS:
            raise ValueError("1m candle not aligned to a minute")
        slot = buckets[start - start % FIVE_MIN_MS]
        if start in slot and _candle_key(slot[start], ("open", "high", "low", "close", "volume")) != \
                _candle_key(candle, ("open", "high", "low", "close", "volume")):
            raise ValueError("conflicting revisions of one minute")
        slot[start] = candle
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

    Tolerances are explicit RELATIVE fractions of the magnitude (default exact, 0; must stay below 0.5); a nonzero
    one must be justified by the caller's report.
    Alignment is UTC and the close is the bucket end (exclusive). A misaligned or conflicting row in the OFFICIAL
    series is the reference's problem (``VALIDATOR_ERROR``); conflicting revisions of one of OUR minutes are a
    ``DISCREPANCY`` of the capture and that bucket is not compared.
    """
    assert_range_allowed(from_ms, to_ms)
    result = Result("candles", [product], from_ms, to_ms, {"price_tol": price_tol, "volume_tol": volume_tol})
    ptol, vtol = Decimal(price_tol), Decimal(volume_tol)
    _check_tolerance(ptol, vtol)
    fields = ("open", "high", "low", "close", "volume")
    ours_rows, bad = {}, set()
    for index, candle in enumerate(candles_1m):
        def mine(candle=candle):
            start = _int(candle["bucket_start"], "bucket_start")
            if start >= HOLDOUT_START_MS:
                return _holdout_error(result, "candles.buckets", product)
            if not from_ms <= start < to_ms:
                return
            if start in ours_rows and _candle_key(ours_rows[start], fields) != _candle_key(candle, fields):
                bad.add(start - start % FIVE_MIN_MS)
                result.findings.append(Finding(DISCREPANCY, "candles.revision_conflict", product,
                                               "two different rows for one minute", bucket_start=start))
            ours_rows.setdefault(start, candle)
        _guard(result, "candles.ours[{}]".format(index), product, mine)
    try:
        ours = aggregate_to_five_minutes(ours_rows.values())
    except (ValueError, KeyError, TypeError) as error:
        result.findings.append(Finding(VALIDATOR_ERROR, "candles.aggregate", product, "malformed input: {}".format(error)))
        return result.close()
    official, official_bad = {}, set()
    for index, candle in enumerate(official_5m):
        def ref(candle=candle):
            start = _int(candle["bucket_start"], "bucket_start")
            if start >= HOLDOUT_START_MS:
                return _holdout_error(result, "candles.official", product)
            if start % FIVE_MIN_MS:
                result.findings.append(Finding(VALIDATOR_ERROR, "candles.alignment", product,
                                               "official bucket not aligned to UTC 5 min (reference or timezone input)",
                                               bucket_start=start))
            elif from_ms <= start < to_ms:
                row = {k: _dec(candle[k], k) for k in fields}
                if start in official and official[start] != row:
                    official_bad.add(start)
                    result.findings.append(Finding(VALIDATOR_ERROR, "candles.official", product,
                                                   "conflicting official rows for one bucket: bucket not compared", bucket_start=start))
                official[start] = row
        _guard(result, "candles.official[{}]".format(index), product, ref)
    first = -(-from_ms // FIVE_MIN_MS) * FIVE_MIN_MS
    for start in range(first, to_ms - FIVE_MIN_MS + 1, FIVE_MIN_MS):
        if start in bad or start in official_bad:
            continue
        mine_, ref_ = ours.get(start), official.get(start)
        if mine_ is None and ref_ is None:
            result.findings.append(Finding(ABSENT, "candles.both", product, "no candle in either series", bucket_start=start))
        elif mine_ is None:
            result.findings.append(Finding(ABSENT, "candles.ours", product, "bucket missing or incomplete in the capture",
                                           bucket_start=start))
        elif ref_ is None:
            result.findings.append(Finding(ABSENT, "candles.official", product, "bucket missing in the reference series",
                                           bucket_start=start))
        else:
            result.judged("candles.buckets", product)
            for field in ("open", "high", "low", "close"):
                if abs(mine_[field] - ref_[field]) > ptol * max(abs(mine_[field]), abs(ref_[field])):
                    result.findings.append(Finding(DISCREPANCY, "candles." + field, product,
                                                   "{} != {}".format(mine_[field], ref_[field]), bucket_start=start))
            if abs(mine_["volume"] - ref_["volume"]) > vtol * max(abs(mine_["volume"]), abs(ref_["volume"])):
                result.findings.append(Finding(DISCREPANCY, "candles.volume", product,
                                               "{} != {}".format(mine_["volume"], ref_["volume"]), bucket_start=start))
    return result.close()


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

def build_report(sample, results, required):
    """Reproducible summary: sample identity + what each validator judged + findings split by kind + a fingerprint.

    ``required``: the families that must have run (subset of ``REQUIRED_CHECKS``, never empty). A required
    family that did not run, or a required check with no coverage entry for some expected product, becomes an
    ``ABSENT`` ``validator_not_run`` finding, so a report cannot read clean on evidence that was never gathered.
    Fitness is ``no_apta`` with any DISCREPANCY, ``bloqueada`` with ABSENT or VALIDATOR_ERROR (the sample cannot
    support a verdict), ``sin_hallazgos`` only if everything required was judged and nothing was found (not a
    claim of validity beyond the measured criteria).
    """
    for key in ("source", "version", "from_ms", "to_ms", "products"):
        if key not in sample:
            raise ValueError("sample is missing {}".format(key))
    assert_range_allowed(sample["from_ms"], sample["to_ms"])
    expected = _products(sample["products"])
    required = tuple(required)
    if not required or any(r not in REQUIRED_CHECKS for r in required):
        raise ValueError("required must be a non-empty subset of {}".format(sorted(REQUIRED_CHECKS)))
    findings, events, coverage = [], [], {}
    parameters = []
    for result in results:
        if result.from_ms != sample["from_ms"] or result.to_ms != sample["to_ms"]:
            findings.append(Finding(ABSENT, result.family, None,
                                    "partial_range: validated {}..{} but the sample declares {}..{}".format(
                                        result.from_ms, result.to_ms, sample["from_ms"], sample["to_ms"]),
                                    partial_range=True))
        parameters.append({"family": result.family, "products": result.products, "params": result.params})
        findings.extend(result.findings)
        events.extend(result.events)
        for check, per_product in result.coverage.items():
            for product, count in per_product.items():
                coverage.setdefault(check, {})[product] = coverage.get(check, {}).get(product, 0) + count
    for family in required:
        for check in REQUIRED_CHECKS[family]:
            for product in expected:
                if product not in coverage.get(check, {}):
                    findings.append(Finding(ABSENT, check, product, "validator_not_run: no coverage reported",
                                            validator_not_run=True))
    counts = {kind: sum(1 for f in findings if f["kind"] == kind) for kind in KINDS}
    if counts[DISCREPANCY]:
        fitness = "no_apta"
    elif counts[ABSENT] or counts[VALIDATOR_ERROR]:
        fitness = "bloqueada"
    else:
        fitness = "sin_hallazgos"
    body = {"validator_version": VALIDATOR_VERSION, "sample": sample, "required": list(required), "parameters": sorted(parameters, key=lambda p: json.dumps(p, sort_keys=True)), "coverage": coverage,
            "events": sorted(events, key=lambda e: json.dumps(e, sort_keys=True)), "counts": counts, "fitness": fitness,
            "findings": sorted(findings, key=lambda f: json.dumps(f, sort_keys=True))}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return dict(body, fingerprint=digest)
