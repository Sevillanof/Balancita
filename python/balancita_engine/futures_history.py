"""Kraken's public history (official candles and hourly funding) with a local SQLite cache.

Shared by the Qwen practice (``futures_qwen_practice``) and the strategy gate (``strategy_gate``): one place that
talks to ``futures.kraken.com`` for history. Public endpoints only, no credentials, nothing is ever traded.
"""

import json
import os
import sqlite3
import time
import urllib.request
from . import system_trust

system_trust.install()

MINUTE_MS = 60_000
HOUR_MS = 3_600_000
DAY_MS = 86_400_000
KRAKEN = "https://futures.kraken.com"
WARMUP_MS = 8 * DAY_MS          # indicators (log-volatility of C29/C30/C32 needs about a week) before the first signal


class HistoryError(Exception):
    """A clear, user-facing failure (Kraken unreachable); the CLIs print it and exit 2."""


def _http_get(url, attempts=5):
    last = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "balancita-history"})
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read())
        except Exception as error:  # network, 5xx, bad JSON: wait and try again, then fail loudly
            last = error
            time.sleep(min(30, 2 ** attempt))
    raise HistoryError("Kraken no respondió ({}): {}".format(url, last))


def _convert(row):
    return {"bucket_start": int(row["time"]), "open": str(row["open"]), "high": str(row["high"]),
            "low": str(row["low"]), "close": str(row["close"]), "volume_btc": str(row["volume"])}


def fetch_candles(product, resolution, from_ms, to_ms, *, get=None, now_ms=None):
    """Official trade candles of ``resolution`` (``1m``/``5m``) from Kraken's public charts API, ``[from_ms, to_ms)``.

    Pages of up to 2000 candles; the candle still open at ``now_ms`` is left out. Not gap-filled (``fill_gaps``).
    """
    get = get or _http_get
    step = {"1m": MINUTE_MS, "5m": 5 * MINUTE_MS}[resolution]
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    out, start = {}, from_ms // 1000
    to_s = min(to_ms, now_ms) // 1000
    while True:
        url = "{}/api/charts/v1/trade/{}/{}?from={}&to={}".format(KRAKEN, product, resolution, start, to_s)
        data = get(url)
        rows = data.get("candles") or []
        for row in rows:
            out[int(row["time"])] = _convert(row)
        if not rows or not data.get("more_candles"):
            break
        start = int(rows[-1]["time"]) // 1000 + step // 1000
    return [out[t] for t in sorted(out) if t + step <= now_ms and from_ms <= t < to_ms]


def fill_gaps(candles, step_ms):
    """Quiet minutes are flat candles (previous close, no volume), as the official candles of the market DB are."""
    ordered = sorted({c["bucket_start"]: c for c in candles}.values(), key=lambda c: c["bucket_start"])
    out = []
    for candle in ordered:
        while out and candle["bucket_start"] - out[-1]["bucket_start"] > step_ms:
            close = out[-1]["close"]
            out.append({"bucket_start": out[-1]["bucket_start"] + step_ms, "open": close, "high": close,
                        "low": close, "close": close, "volume_btc": "0"})
        out.append(candle)
    return out


def fetch_funding(product, *, get=None):
    """``[(period_start_ms, relative_hourly_rate)]`` from Kraken's public funding history (about one year)."""
    from .futures_funding_context import periods_from_responses
    get = get or _http_get
    body = get("{}/derivatives/api/v3/historical-funding-rates?symbol={}".format(KRAKEN, product))
    return periods_from_responses([json.dumps(body)])


class CandleCache:
    """Raw candles per product in one SQLite file, so a second run only fetches what is new."""

    def __init__(self, path):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("CREATE TABLE IF NOT EXISTS candles(res TEXT NOT NULL, t INTEGER NOT NULL, o TEXT NOT NULL, "
                        "h TEXT NOT NULL, l TEXT NOT NULL, c TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY(res, t))")

    def ensure(self, product, resolution, from_ms, to_ms, fetch=fetch_candles, **kwargs):
        """Fetches into the cache what is missing of ``[from_ms, to_ms)``; reads nothing back."""
        step = {"1m": MINUTE_MS, "5m": 5 * MINUTE_MS}[resolution]
        have = self.db.execute("SELECT MIN(t), MAX(t) FROM candles WHERE res=?", (resolution,)).fetchone()
        lo, hi = have
        if lo is not None and lo <= from_ms + step and hi is not None:
            fetch_from = hi + step
        else:
            fetch_from = from_ms
        if fetch_from < to_ms:
            new = fetch(product, resolution, fetch_from, to_ms, **kwargs)
            with self.db:
                self.db.executemany("INSERT OR REPLACE INTO candles VALUES(?,?,?,?,?,?,?)",
                                    [(resolution, c["bucket_start"], c["open"], c["high"], c["low"], c["close"],
                                      c["volume_btc"]) for c in new])

    def read(self, product, resolution, from_ms, to_ms):
        """What the cache holds of ``[from_ms, to_ms)``; never touches the network."""
        rows = self.db.execute("SELECT t,o,h,l,c,v FROM candles WHERE res=? AND t>=? AND t<? ORDER BY t",
                               (resolution, from_ms, to_ms)).fetchall()
        return [{"bucket_start": t, "open": o, "high": h, "low": l, "close": c, "volume_btc": v}
                for t, o, h, l, c, v in rows]

    def load(self, product, resolution, from_ms, to_ms, fetch=fetch_candles, **kwargs):
        self.ensure(product, resolution, from_ms, to_ms, fetch=fetch, **kwargs)
        return self.read(product, resolution, from_ms, to_ms)

    def close(self):
        self.db.close()


