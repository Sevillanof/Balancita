"""Research export: aligned official candles of every product, one CSV per product.

Reads the market DB read-only (first-known revision of each bucket, optionally
as of a ``known_at`` cutoff) and writes ``<out-dir>/<PRODUCT>_<1m|5m>.csv``. All
files share the same bucket grid: the buckets present for every product between
the latest first bucket and the earliest last bucket. For cross-sectional
studies (e.g. momentum) where every row must have every product. ``volume`` is
the base-asset volume of each product.
"""

import csv
import os
import sqlite3
import time

from .futures_products import resolve_products
from .futures_verdicts import _OfficialCandles

INTERVALS = {"1m": 60_000, "5m": 300_000}
COLUMNS = ["bucket_start_ms", "time_utc", "open", "high", "low", "close", "volume", "known_at_ms"]
_WHERE = "product_id=? AND interval_ms=? AND known_at<=?"


def _utc(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms // 1000))


def export_aligned(market_db_path, out_dir, products, interval_ms, as_of_ms=None):
    """Writes the CSVs; returns ``{"rows", "first_bucket_ms", "last_bucket_ms", "dropped", "files"}``."""
    if interval_ms not in INTERVALS.values():
        raise ValueError("interval must be 1m or 5m")
    label = {value: key for key, value in INTERVALS.items()}[interval_ms]
    cutoff = 2 ** 62 if as_of_ms is None else as_of_ms
    market = _OfficialCandles(market_db_path)
    try:
        if not market.available:
            raise ValueError("market DB has no per-product official candles (product_id); "
                             "start the capture process to migrate it")
        series = {}
        for product in products:
            rows = market.db.execute(market._ROWS_SQL.format(_WHERE), (product, interval_ms, cutoff)).fetchall()
            if not rows:
                raise ValueError("no official {} candles for {}".format(label, product))
            series[product] = {row[1]: row for row in rows}
    finally:
        market.close()
    first = max(min(rows) for rows in series.values())
    last = min(max(rows) for rows in series.values())
    common = sorted(bucket for bucket in series[products[0]]
                    if first <= bucket <= last and all(bucket in rows for rows in series.values()))
    os.makedirs(out_dir, exist_ok=True)
    files = []
    for product in products:
        path = os.path.join(out_dir, "{}_{}.csv".format(product, label))
        with open(path, "w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(COLUMNS)
            for bucket in common:
                _, _, known_at, open_, high, low, close, volume, _hash = series[product][bucket]
                writer.writerow([bucket, _utc(bucket), open_, high, low, close, volume, known_at])
        files.append(path)
    return {
        "rows": len(common),
        "first_bucket_ms": common[0] if common else None,
        "last_bucket_ms": common[-1] if common else None,
        "dropped": {product: len(series[product]) - len(common) for product in products},
        "files": files,
    }


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="Export aligned official candles, one CSV per product")
    parser.add_argument("--market-db", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--interval", choices=sorted(INTERVALS), default="1m")
    parser.add_argument("--products", help="comma-separated PF_X[:tickSize] list "
                        "(default: FUTURES_PRODUCTS or config/futures-products.json)")
    parser.add_argument("--as-of-ms", type=int, help="only candles known by this time")
    args = parser.parse_args(argv)
    products = [product_id for product_id, _ in resolve_products(args.products)]
    try:
        result = export_aligned(args.market_db, args.out_dir, products, INTERVALS[args.interval], args.as_of_ms)
    except (ValueError, sqlite3.Error) as error:
        print("export failed: {}".format(error))
        return 1
    print("exported {} aligned rows ({} .. {}) for {} products to {}".format(
        result["rows"], result["first_bucket_ms"], result["last_bucket_ms"], len(products), args.out_dir))
    for product, dropped in result["dropped"].items():
        print("  {} dropped {} unaligned buckets".format(product, dropped))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
