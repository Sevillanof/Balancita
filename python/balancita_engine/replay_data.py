"""Historical data for the replay (stage 9A): read-only access with a hard range gate, and integrity checks.

Everything read from a market database goes through ``ReplayDataGate``:

* the database is opened ``mode=ro`` with ``PRAGMA query_only=ON`` (never ``immutable=1``);
* ``LO_MS`` / ``HI_EXCL_MS`` are constants of this module. A window that starts before ``LO_MS`` or ends after
  ``HI_EXCL_MS`` raises ``RangeGateError`` *before* the file is opened. ``HI_EXCL_MS`` is 2026-08-02T00:00:00Z: the reserved
  period (2026-08-02 .. 2026-10-01) is never read, although the backfilled databases hold it physically;
* every statement is parameterised with the window; funding rates are extracted with SQLite's JSON functions *inside* the
  query and filtered by timestamp there, so periods at or after the cap never reach Python.

Candles are the first-known revision of each bucket. Their ``known_at`` is the time of the backfill (October 2026), so it
says nothing about when a candle was known: the replay fixes availability by rule (``replay_driver``).
"""

import hashlib
import json
import sqlite3
from decimal import Decimal, InvalidOperation

D = Decimal
ONE_MINUTE_MS = 60_000
FIVE_MINUTES_MS = 300_000
HOUR_MS = 3_600_000
LO_MS = 1_760_313_600_000          # 2025-10-13T00:00:00Z: start of the audited range (and of the public funding history)
HI_EXCL_MS = 1_785_628_800_000     # 2026-08-02T00:00:00Z: exclusive; everything from here on is the reserved period
SCHEMA = "balancita-replay-data.v1"
INTERVALS = (ONE_MINUTE_MS, FIVE_MINUTES_MS)


class RangeGateError(ValueError):
    """A window outside the authorised range. Raised before any database is opened."""


class DataError(ValueError):
    """The data fails an integrity check that the replay cannot run without."""


def check_window(lo_ms, hi_excl_ms):
    for value in (lo_ms, hi_excl_ms):
        if isinstance(value, bool) or not isinstance(value, int):
            raise RangeGateError("window bounds must be integer milliseconds")
    if lo_ms < LO_MS:
        raise RangeGateError("window starts before the authorised range ({} < {})".format(lo_ms, LO_MS))
    if hi_excl_ms > HI_EXCL_MS:
        raise RangeGateError("window ends after the cap ({} > {}): the reserved period is not readable".format(hi_excl_ms, HI_EXCL_MS))
    if hi_excl_ms <= lo_ms:
        raise RangeGateError("window is empty")


def _plain(value):
    return json.loads(json.dumps(value, sort_keys=True, default=str))


class ReplayDataGate:
    def __init__(self, path, lo_ms, hi_excl_ms):
        check_window(lo_ms, hi_excl_ms)
        self.path, self.lo_ms, self.hi_excl_ms = path, lo_ms, hi_excl_ms
        self.db = sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
        self.db.execute("PRAGMA query_only=ON")
        self.statements = []            # every statement executed with its bounds: the audit trail of what was read

    def close(self):
        self.db.close()

    def _run(self, name, sql, params):
        self.statements.append({"name": name, "params": [p for p in params]})
        return self.db.execute(sql, params).fetchall()

    # ---- candles --------------------------------------------------------------------------------------------------
    _CANDLES = """
        WITH ranked AS (
          SELECT bucket_start, known_at, open_price, high_price, low_price, close_price, volume_btc,
                 ROW_NUMBER() OVER (PARTITION BY bucket_start ORDER BY known_at, rowid) AS revision_rank
          FROM paper_futures_official_candles
          WHERE product_id=? AND interval_ms=? AND bucket_start>=? AND bucket_start<?)
        SELECT bucket_start, known_at, open_price, high_price, low_price, close_price, volume_btc
        FROM ranked WHERE revision_rank=1 ORDER BY bucket_start"""

    def candles(self, product_id, interval_ms):
        """First-known revision of every stored bucket of the window, ordered. The same shape ``futures_simulator.frames``
        reads (``bucket_start``, ``open/high/low/close/volume_btc`` as text)."""
        if interval_ms not in INTERVALS:
            raise ValueError("interval must be 1m or 5m")
        rows = self._run("candles", self._CANDLES, (product_id, interval_ms, self.lo_ms, self.hi_excl_ms))
        out = [{"bucket_start": int(r[0]), "known_at": int(r[1]), "open": r[2], "high": r[3], "low": r[4], "close": r[5],
                "volume_btc": r[6]} for r in rows]
        if out and out[-1]["bucket_start"] + interval_ms > self.hi_excl_ms:
            raise RangeGateError("a candle crosses the cap")      # defence in depth: the query already excludes it
        return out

    def conflicting_revisions(self, product_id, interval_ms):
        """Buckets of the window with more than one revision whose OHLCV differ (the replay refuses to start on any)."""
        rows = self._run("conflicts", """
            SELECT bucket_start FROM paper_futures_official_candles
            WHERE product_id=? AND interval_ms=? AND bucket_start>=? AND bucket_start<?
            GROUP BY bucket_start HAVING COUNT(DISTINCT open_price||high_price||low_price||close_price||volume_btc)>1""",
                         (product_id, interval_ms, self.lo_ms, self.hi_excl_ms))
        return [int(r[0]) for r in rows]

    # ---- funding --------------------------------------------------------------------------------------------------
    def relative_funding(self, product_id):
        """``[(start_ms, relative_rate_text)]`` of the hourly funding periods inside the window, first-seen response wins.

        The rate is Kraken's ``relativeFundingRate`` (what ``accrue_funding`` and ``FundingContext`` use), taken from the
        stored raw response. The JSON is parsed and filtered by SQLite; rows outside ``[lo, hi_excl)`` are never returned."""
        rows = self._run("funding", """
            SELECT CAST(strftime('%s', json_extract(j.value,'$.timestamp')) AS INTEGER)*1000 AS start_ms,
                   json_extract(j.value,'$.relativeFundingRate') AS rate, r.received_at, r.sha256
            FROM paper_futures_funding_responses r, json_each(r.raw_response,'$.rates') j
            WHERE r.sha256 IN (SELECT DISTINCT response_sha256 FROM paper_futures_funding_periods WHERE product_id=?)
              AND CAST(strftime('%s', json_extract(j.value,'$.timestamp')) AS INTEGER)*1000 >= ?
              AND CAST(strftime('%s', json_extract(j.value,'$.timestamp')) AS INTEGER)*1000 < ?
            ORDER BY start_ms, r.received_at, r.sha256""", (product_id, self.lo_ms, self.hi_excl_ms))
        found = {}
        for start_ms, rate, _received, _sha in rows:
            if start_ms is None or rate is None:
                continue
            found.setdefault(int(start_ms), _decimal_text(rate))
        return sorted(found.items())


def _decimal_text(value):
    try:
        d = D(repr(value)) if isinstance(value, float) else D(str(value))
    except InvalidOperation:
        raise DataError("funding rate is not a number: {!r}".format(value))
    if not d.is_finite():
        raise DataError("funding rate is not finite")
    return format(d, "f")


# ---------------------------------------------------------------------------------------------------- integrity
def series_report(candles, interval_ms, lo_ms, hi_excl_ms):
    """Order, alignment, gaps and OHLC consistency of one series over ``[lo_ms, hi_excl_ms)``. Nothing is corrected."""
    first = -(-lo_ms // interval_ms) * interval_ms
    last = (hi_excl_ms // interval_ms) * interval_ms - interval_ms
    present = [c["bucket_start"] for c in candles]
    unordered = sum(1 for a, b in zip(present, present[1:]) if b <= a)
    misaligned = sum(1 for b in present if b % interval_ms)
    outside = sum(1 for b in present if b < first or b > last)
    have = set(present)
    gaps, start = [], None
    expected = (last - first) // interval_ms + 1 if last >= first else 0
    missing = 0
    bucket = first
    while bucket <= last:
        if bucket not in have:
            missing += 1
            start = bucket if start is None else start
        elif start is not None:
            gaps.append([start, bucket - interval_ms])
            start = None
        bucket += interval_ms
    if start is not None:
        gaps.append([start, last])
    invalid = 0
    zero_volume = 0
    for c in candles:
        try:
            o, h, l, cl, v = (D(str(c[k])) for k in ("open", "high", "low", "close", "volume_btc"))   # noqa: E741
        except InvalidOperation:
            invalid += 1
            continue
        if not all(x.is_finite() for x in (o, h, l, cl, v)) or min(o, h, l, cl) <= 0 or l > min(o, cl) or h < max(o, cl) or v < 0:
            invalid += 1
        if v == 0:
            zero_volume += 1
    return {"interval_ms": interval_ms, "n": len(candles), "expected": expected, "missing": missing,
            "gaps": gaps[:50], "gap_count": len(gaps), "unordered": unordered, "misaligned": misaligned,
            "outside_window": outside, "invalid_ohlc": invalid, "zero_volume": zero_volume,
            "first": present[0] if present else None, "last": present[-1] if present else None}


def consistency_5m_vs_1m(candles_1m, candles_5m):
    """Each 5m bar against the five 1m bars it covers (high, low, close, volume). Counted and reported, never corrected."""
    by_minute = {c["bucket_start"]: c for c in candles_1m}
    compared = mismatched = incomplete = 0
    examples = []
    for bar in candles_5m:
        minutes = [by_minute.get(bar["bucket_start"] + i * ONE_MINUTE_MS) for i in range(5)]
        if any(m is None for m in minutes):
            incomplete += 1
            continue
        compared += 1
        try:
            high, low = max(D(m["high"]) for m in minutes), min(D(m["low"]) for m in minutes)
            close, volume = D(minutes[-1]["close"]), sum((D(m["volume_btc"]) for m in minutes), D(0))
            ok = (high == D(bar["high"]) and low == D(bar["low"]) and close == D(bar["close"])
                  and abs(volume - D(bar["volume_btc"])) <= max(D("0.000001"), volume * D("0.000001")))
        except InvalidOperation:
            ok = False
        if not ok:
            mismatched += 1
            if len(examples) < 5:
                examples.append(bar["bucket_start"])
    return {"compared": compared, "mismatched": mismatched, "incomplete": incomplete, "examples": examples}


def funding_report(periods, lo_ms, hi_excl_ms):
    """Hours of the window with no funding row. They are *unknown*, never zero."""
    first = -(-lo_ms // HOUR_MS) * HOUR_MS
    last = (hi_excl_ms // HOUR_MS) * HOUR_MS - HOUR_MS
    have = {s for s, _ in periods}
    starts = sorted(have)
    lo_seen = starts[0] if starts else None
    missing = [h for h in range(max(first, lo_seen if lo_seen is not None else first), last + 1, HOUR_MS) if h not in have]
    return {"n": len(periods), "first": lo_seen, "last": starts[-1] if starts else None, "missing_hours": missing[:200],
            "missing_count": len(missing), "outside_window": sum(1 for s in starts if s < lo_ms or s >= hi_excl_ms)}


def data_hash(candles_1m, candles_5m, funding):
    """Identity of the data a run used: the candles' OHLCV and the funding rates, not their ``known_at`` (a backfill time)."""
    digest = hashlib.sha256()
    for name, rows in (("1m", candles_1m), ("5m", candles_5m)):
        digest.update(name.encode())
        for c in rows:
            digest.update("|{}|{}|{}|{}|{}|{}".format(c["bucket_start"], c["open"], c["high"], c["low"], c["close"],
                                                       c["volume_btc"]).encode())
    digest.update(b"funding")
    for start, rate in funding:
        digest.update("|{}|{}".format(start, rate).encode())
    return digest.hexdigest()
