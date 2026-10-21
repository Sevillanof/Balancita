"""Synthetic Kraken-like candles in a cache file, so the tests need no network and no real data."""

import os
import random

from research.vectorbt.engine import CandleCache

MINUTE_MS = 60_000
START_MS = 1_740_787_200_000          # 2025-03-01T00:00:00Z


def synthetic_minutes(count, seed=7, start_ms=START_MS, start_price=90_000):
    """A random walk with integer prices and volume bursts: it produces C27 breakouts of both sides."""
    rng = random.Random(seed)
    price, rows = start_price, []
    for i in range(count):
        drift = rng.gauss(0, 18)
        if rng.random() < 0.02:
            drift *= 6
        close = max(1000, int(round(price + drift)))
        high = max(price, close) + int(abs(rng.gauss(0, 6)))
        low = min(price, close) - int(abs(rng.gauss(0, 6)))
        volume = rng.lognormvariate(0.5, 0.6) * (5 if rng.random() < 0.05 else 1)
        rows.append({"bucket_start": start_ms + i * MINUTE_MS, "open": str(price), "high": str(high),
                     "low": str(low), "close": str(close), "volume_btc": "{:.4f}".format(volume)})
        price = close
    return rows


def five_minutes(minutes):
    out = []
    for k in range(0, len(minutes) - len(minutes) % 5, 5):
        chunk = minutes[k:k + 5]
        out.append({"bucket_start": chunk[0]["bucket_start"], "open": chunk[0]["open"],
                    "high": str(max(int(c["high"]) for c in chunk)), "low": str(min(int(c["low"]) for c in chunk)),
                    "close": chunk[-1]["close"], "volume_btc": "{:.4f}".format(sum(float(c["volume_btc"]) for c in chunk))})
    return out


def write_cache(cache_dir, product, minutes):
    os.makedirs(cache_dir, exist_ok=True)
    cache = CandleCache(os.path.join(cache_dir, "candles-{}.sqlite".format(product)))
    try:
        with cache.db:
            for res, rows in (("1m", minutes), ("5m", five_minutes(minutes))):
                cache.db.executemany("INSERT OR REPLACE INTO candles VALUES(?,?,?,?,?,?,?)",
                                     [(res, c["bucket_start"], c["open"], c["high"], c["low"], c["close"],
                                       c["volume_btc"]) for c in rows])
    finally:
        cache.close()
