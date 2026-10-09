"""Funding as one line of Qwen's STATE (FC-02): where the last closed funding period sits against the month before it.

Causal by construction: a funding period counts only once it closed and ``PUBLICATION_LAG_MS`` passed, and its
percentile is taken against the ``WINDOW`` periods before it, never against the whole history (which, in a
replay, contains the future). The rate is Kraken's relative hourly rate, so products are comparable.
"""

import bisect
import json
import sqlite3

from .futures_llm_decisions import sanitize_text

HOUR_MS = 3_600_000
WINDOW = 720  # hourly periods, 30 days
PUBLICATION_LAG_MS = 600_000  # Kraken lists the closed period within minutes; wait 10
HIGH, LOW = 90.0, 10.0  # percentile bands that read "high" / "low"
PLACEBO_SHIFT_MS = 7 * 24 * HOUR_MS
FUNDING_QUESTION_VERSION = 5
BTC_PRODUCT = "PF_XBTUSD"


def load_periods(market_db_path, product_id):
    """Sorted ``[(start_ms, relative_rate)]`` of a product from the market DB's stored Kraken responses (read-only)."""
    db = sqlite3.connect("file:{}?mode=ro".format(market_db_path), uri=True)
    try:
        columns = [row[1] for row in db.execute("PRAGMA table_info(paper_futures_funding_periods)")]
        if not columns:
            return []
        if "product_id" in columns:
            rows = db.execute(
                "SELECT raw_response FROM paper_futures_funding_responses WHERE sha256 IN "
                "(SELECT DISTINCT response_sha256 FROM paper_futures_funding_periods WHERE product_id=?) "
                "ORDER BY received_at, rowid", (product_id,)).fetchall()
        elif product_id == BTC_PRODUCT:  # a market DB written before schema 7 holds the BTC perpetual only
            rows = db.execute("SELECT raw_response FROM paper_futures_funding_responses ORDER BY received_at, rowid").fetchall()
        else:
            rows = []
    finally:
        db.close()
    return periods_from_responses(r[0] for r in rows)


def periods_from_responses(raw_responses):
    """First-seen rate per period start across Kraken ``historical-funding-rates`` bodies; bad bodies are skipped."""
    from datetime import datetime

    found = {}
    for raw in raw_responses:
        try:
            rates = json.loads(raw)["rates"]
            for rate in rates:
                start = int(datetime.fromisoformat(rate["timestamp"].replace("Z", "+00:00")).timestamp() * 1000)
                found.setdefault(start, float(rate["relativeFundingRate"]))
        except (ValueError, KeyError, TypeError):
            continue
    return sorted(found.items())


class FundingContext:
    """The funding line as of any instant. ``shift_ms`` > 0 is the placebo: same format, data from that long before."""

    def __init__(self, periods, shift_ms=0):
        self.starts = [s for s, _ in periods]
        self.rates = [r for _, r in periods]
        self.shift_ms = shift_ms

    def percentile(self, at_ms):
        """``(rate, percentile)`` of the newest period usable at ``at_ms``, or ``None`` before 30 days of history."""
        at_ms -= self.shift_ms
        index = bisect.bisect_right(self.starts, at_ms - HOUR_MS - PUBLICATION_LAG_MS) - 1  # end + lag <= at
        if index < WINDOW:
            return None
        rate, window = self.rates[index], self.rates[index - WINDOW:index]  # window excludes the judged period
        below = sum(1 for x in window if x < rate)
        equal = sum(1 for x in window if x == rate)
        return rate, 100.0 * (below + 0.5 * equal) / WINDOW

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
