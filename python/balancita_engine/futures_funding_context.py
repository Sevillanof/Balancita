"""Funding as one line of Qwen's STATE (FC-02): where the last closed funding period sits against the month before it.

Causal by construction: a funding period counts only once the capture had seen it (its stored ``known_at``, never
earlier than its end plus ``PUBLICATION_LAG_MS``), only while it is at most ``MAX_PERIOD_AGE_MS`` old, and its
percentile is taken against the 30 days of time before it (``WINDOW_MS``), never against the whole history (which, in a
replay, contains the future). Too old, or too many hours missing: unknown, with a reason (``FundingContext.assess``). The rate is Kraken's relative hourly rate, so products are comparable.
"""

import bisect
import json
import sqlite3

from .futures_llm_decisions import sanitize_text

HOUR_MS = 3_600_000
WINDOW = 720  # hourly periods, 30 days
PUBLICATION_LAG_MS = 600_000  # floor: never before the period's end + 10 min; the real moment is the stored known_at
WINDOW_MS = WINDOW * HOUR_MS
# PROVISIONAL (Fran approves): the real listing lag is ~16.8 h median (docs/captura-confirmacion-funding-184.md), so the
# newest usable period is normally 17-20 h old; 36 h is about twice that. A capture gap of 30 h pushes it past the limit.
MAX_PERIOD_AGE_MS = 36 * HOUR_MS
MIN_WINDOW_COVERAGE = 0.9  # PROVISIONAL: share of the 720 hours before the judged period that must be known
HIGH, LOW = 90.0, 10.0  # percentile bands that read "high" / "low"
PLACEBO_SHIFT_MS = 7 * 24 * HOUR_MS
FUNDING_QUESTION_VERSION = 5
BTC_PRODUCT = "PF_XBTUSD"


def _start_ms(rate):
    from datetime import datetime

    return int(datetime.fromisoformat(rate["timestamp"].replace("Z", "+00:00")).timestamp() * 1000)


def periods_from_responses(raw_responses):
    """First-seen rate per period start across Kraken ``historical-funding-rates`` bodies; bad bodies are skipped.

    Pure parsing, no notion of when each body arrived: ``load_periods`` is what dates the periods.
    """
    found = {}
    for raw in raw_responses:
        try:
            for rate in json.loads(raw)["rates"]:
                found.setdefault(_start_ms(rate), float(rate["relativeFundingRate"]))
        except (ValueError, KeyError, TypeError):
            continue
    return sorted(found.items())


_RATE_CACHE = {}  # (market DB path, response sha256, period start) -> relative rate or None; a stored body never changes


def _relative_rates(db, path, sha, starts):
    """``{start: relative_rate}`` of ``starts`` in the stored response ``sha`` (those it does not state are absent)."""
    missing = {s for s in starts if (path, sha, s) not in _RATE_CACHE}
    if missing:
        row = db.execute("SELECT raw_response FROM paper_futures_funding_responses WHERE sha256=?", (sha,)).fetchone()
        found = {}
        try:
            for rate in json.loads(row[0])["rates"]:
                start = _start_ms(rate)
                if start in missing:
                    found[start] = float(rate["relativeFundingRate"])
        except (TypeError, ValueError, KeyError):
            found = {}
        for start in missing:
            _RATE_CACHE[(path, sha, start)] = found.get(start)
    return {s: _RATE_CACHE[(path, sha, s)] for s in starts if _RATE_CACHE[(path, sha, s)] is not None}


def load_periods(market_db_path, product_id, since_ms=None):
    """Sorted ``[(start_ms, relative_rate, known_at_ms)]`` of a product from the market DB (read-only).

    ``known_at_ms`` is when the capture first saw the period *after it had closed* (``paper_futures_funding_periods.known_at``,
    the arrival of the response that carried it): Kraken lists a closed hour hours later (median about 16.8 h,
    docs/captura-confirmacion-funding-184.md), so a period is not known at its end. A row written while the period was
    still open holds a provisional rate and is ignored; the first row from after the close wins ("first seen wins", as in
    the store). Only the stored responses that supplied those rows are parsed, each once per process (``_RATE_CACHE``),
    and ``since_ms`` leaves out periods that start earlier: the cost follows the hours replayed, not the capture's age.
    Periods whose response cannot be read are left out, never guessed.
    """
    db = sqlite3.connect("file:{}?mode=ro".format(market_db_path), uri=True)
    try:
        columns = [row[1] for row in db.execute("PRAGMA table_info(paper_futures_funding_periods)")]
        if not columns:
            return []
        if "product_id" in columns:
            where, args = "product_id=?", [product_id]
        elif product_id == BTC_PRODUCT:  # a market DB written before schema 7 holds the BTC perpetual only
            where, args = "1", []
        else:
            return []
        if since_ms is not None:
            where, args = where + " AND start_ms>=?", args + [since_ms]
        first = {}
        for sha, start, end, known_at in db.execute(
                "SELECT response_sha256, start_ms, end_ms, known_at FROM paper_futures_funding_periods WHERE " + where
                + " ORDER BY known_at, rowid", args):
            if known_at >= end and start not in first:
                first[start] = (sha, known_at)
        by_sha = {}
        for start, (sha, _) in first.items():
            by_sha.setdefault(sha, []).append(start)
        rates = {}
        for sha, starts in by_sha.items():
            rates.update(_relative_rates(db, market_db_path, sha, starts))
    finally:
        db.close()
    return sorted((start, rates[start], first[start][1]) for start in rates)


class FundingContext:
    """The funding line as of any instant. ``shift_ms`` > 0 is the placebo: same format, data from that long before.

    ``periods`` are ``(start, rate, known_at)``; a pair ``(start, rate)`` is known when it closed plus
    ``PUBLICATION_LAG_MS`` (callers that feed funding as it is published). A period is usable at ``t`` only when
    ``known_at`` (never earlier than its end plus the lag) is <= ``t``; the judged one must also be at most
    ``MAX_PERIOD_AGE_MS`` old and the 30 days before it must be covered at least ``MIN_WINDOW_COVERAGE``.
    """

    def __init__(self, periods, shift_ms=0):
        rows = sorted(periods)
        self.starts = [row[0] for row in rows]
        self.rates = [row[1] for row in rows]
        floor = [s + HOUR_MS + PUBLICATION_LAG_MS for s in self.starts]
        self.known = [floor[i] if len(row) < 3 else max(row[2], floor[i]) for i, row in enumerate(rows)]
        self.shift_ms = shift_ms

    def assess(self, at_ms):
        """``((rate, percentile), "ok")`` or ``(None, reason)``: ``no_history`` / ``stale`` / ``window_gaps``."""
        at_ms -= self.shift_ms
        top = bisect.bisect_right(self.starts, at_ms - HOUR_MS)  # periods that have ended
        judged = None
        for i in range(top - 1, -1, -1):
            if self.starts[i] + HOUR_MS < at_ms - MAX_PERIOD_AGE_MS:
                break
            if self.known[i] <= at_ms:
                judged = i
                break
        if judged is None:
            seen = any(k <= at_ms for k in self.known)
            return None, ("stale" if seen else "no_history")
        low = bisect.bisect_left(self.starts, self.starts[judged] - WINDOW_MS)
        window = [self.rates[i] for i in range(low, judged) if self.known[i] <= at_ms]  # excludes the judged period
        if len(window) < MIN_WINDOW_COVERAGE * WINDOW:
            return None, "window_gaps"
        rate = self.rates[judged]
        below = sum(1 for x in window if x < rate)
        equal = sum(1 for x in window if x == rate)
        return (rate, 100.0 * (below + 0.5 * equal) / len(window)), "ok"

    def percentile(self, at_ms):
        """``(rate, percentile)`` of the newest period usable at ``at_ms``, or ``None`` (see ``assess`` for why)."""
        return self.assess(at_ms)[0]

    def level(self, at_ms):
        """``high`` / ``normal`` / ``low`` / ``None`` (unknown)."""
        found = self.percentile(at_ms)
        if found is None:
            return None
        return "high" if found[1] >= HIGH else "low" if found[1] <= LOW else "normal"

    def line(self, at_ms):
        found = self.percentile(at_ms)
        if found is None:
            return "funding: unknown"
        rate, pct = found
        payer = "longs pay" if rate > 0 else "shorts pay" if rate < 0 else "no payment"
        return sanitize_text("funding: {} (pctl30d={}, {})".format(self.level(at_ms), int(round(pct)), payer))


def funding_question(question):
    """The shipped ``trade_action`` as version 5: the same question with the ``funding`` line added (v4 untouched)."""
    fields = list(question["state_fields"])
    fields.insert(fields.index("lessons") if "lessons" in fields else len(fields), "funding")
    return dict(question, version=FUNDING_QUESTION_VERSION, state_fields=fields)


def funding_periods(context):
    """``[(start_ms, end_ms, relative_rate_per_hour)]`` from a ``FundingContext`` for the simulator's books (accounting).

    ``None`` (no history) gives ``[]``: the books then report ``funding_complete = false`` and an unknown funding.
    """
    return [] if context is None else [(s, s + HOUR_MS, r) for s, r in zip(context.starts, context.rates)]


def funding_known_periods(context):
    """``[(start_ms, end_ms, rate, known_at_ms)]``: the same periods with the moment the capture had them."""
    return [] if context is None else [(s, s + HOUR_MS, r, k) for s, r, k in zip(context.starts, context.rates, context.known)]


def funding_for(market_db_path, product_id, since_ms=None):
    """The product's ``FundingContext`` from the market DB, or ``None`` when it holds no funding history.

    ``since_ms``: skip periods starting earlier (callers pass their first decision time minus ``WINDOW_MS`` and a
    margin); the default reads everything stored.
    """
    try:
        periods = load_periods(market_db_path, product_id, since_ms)
    except sqlite3.Error:
        return None
    return FundingContext(periods) if periods else None
