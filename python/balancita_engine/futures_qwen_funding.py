"""Observed Kraken absolute funding. Other venues and inferred rates are never payment substitutes."""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
import hashlib
import json
import os
import sqlite3

from .canonical import normalize_decimal
from .futures_funding import HOUR_MS, accrue_interval

LEGACY_MODEL = "kraken-relative-entry-notional.v1"
EXACT_MODEL = "kraken-absolute-quantity.v2"
UNITS = {
    "PF_XBTUSD": "USD/BTC/hour", "PF_ETHUSD": "USD/ETH/hour", "PF_SOLUSD": "USD/SOL/hour",
    "PF_ZECUSD": "USD/ZEC/hour", "PF_XRPUSD": "USD/XRP/hour", "PF_NEARUSD": "USD/NEAR/hour",
    "PF_HYPEUSD": "USD/HYPE/hour", "PF_ADAUSD": "USD/ADA/hour",
}


def _decimal(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError("Kraken funding: rate must be a finite decimal.")
    number = Decimal(str(value))
    if not number.is_finite():
        raise ValueError("Kraken funding: rate must be finite.")
    return normalize_decimal(str(number))


@dataclass(frozen=True)
class FundingPeriod:
    start_ms: int
    end_ms: int
    absolute_rate: str
    relative_rate: str | None
    known_at_ms: int
    source: str
    response_sha256: str
    unit: str


@dataclass(frozen=True)
class FundingHistory:
    product: str
    periods: tuple[FundingPeriod, ...]

    def accrue(self, start_ms, end_ms, quantity, long):
        quantity = Decimal(str(quantity))
        if not quantity.is_finite() or quantity <= 0 or end_ms < start_ms:
            raise ValueError("Kraken funding: invalid quantity or holding interval.")
        total, covered = Decimal(0), 0
        for period in self.periods:
            if period.end_ms <= start_ms:
                continue
            if period.start_ms >= end_ms:
                break
            low, high = max(start_ms, period.start_ms), min(end_ms, period.end_ms)
            if high > low:
                cash = accrue_interval("long" if long else "short", str(quantity), period.absolute_rate, low, high)
                total -= Decimal(cash)
                covered += high - low
        return total, covered


def _history(product, periods):
    if product not in UNITS:
        raise ValueError("Only the configured Kraken PF perpetuals have a funding payment contract.")
    found = {}
    for period in periods:
        if (period.unit != UNITS[product] or type(period.start_ms) is not int
                or type(period.end_ms) is not int or period.end_ms - period.start_ms != HOUR_MS
                or type(period.known_at_ms) is not int or period.known_at_ms < 0):
            raise ValueError("Kraken funding: product, unit or interval is invalid.")
        previous = found.get(period.start_ms)
        if previous is not None and previous.absolute_rate != period.absolute_rate:
            raise ValueError("Kraken funding: conflicting observed rates for the same period.")
        if previous is None:
            found[period.start_ms] = period
    return FundingHistory(product, tuple(found[key] for key in sorted(found)))


def from_public(product, body, *, known_at_ms):
    if product not in UNITS or not isinstance(body, dict) or body.get("result") != "success":
        raise ValueError("Invalid Kraken historical-funding-rates response.")
    rates = body.get("rates")
    if not isinstance(rates, list):
        raise ValueError("Kraken funding: the response has no rates list.")
    sha = hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()
    source = "https://futures.kraken.com/derivatives/api/v3/historical-funding-rates?symbol=" + product
    periods = []
    for row in rates:
        if not isinstance(row, dict) or not {"timestamp", "fundingRate", "relativeFundingRate"} <= row.keys():
            raise ValueError("Kraken funding: an observed period is missing required fields.")
        moment = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))
        if moment.tzinfo is None:
            raise ValueError("Kraken funding: effective time needs a timezone.")
        start = int(moment.timestamp() * 1000)
        periods.append(FundingPeriod(
            start, start + HOUR_MS, _decimal(row["fundingRate"]), _decimal(row["relativeFundingRate"]),
            known_at_ms, source, sha, UNITS[product]))
    return _history(product, periods)


def from_archive(path, product, *, until_ms=None):
    if product not in UNITS:
        raise ValueError("Kraken funding: unsupported product.")
    db = sqlite3.connect("file:{}?mode=ro".format(os.path.abspath(path)), uri=True)
    try:
        rows = db.execute(
            "SELECT start_ms,end_ms,funding_rate,known_at,response_sha256,unit FROM paper_futures_funding_periods "
            "WHERE product_id=?" + (" AND end_ms<=?" if until_ms is not None else "") + " ORDER BY start_ms,known_at",
            (product, until_ms) if until_ms is not None else (product,)).fetchall()
    finally:
        db.close()
    source = "file://" + os.path.abspath(path) + "#paper_futures_funding_periods"
    return _history(product, [
        FundingPeriod(start, end, _decimal(rate), None, known, source, sha, unit)
        for start, end, rate, known, sha, unit in rows
    ])
