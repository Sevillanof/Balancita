#!/usr/bin/env python3
"""Download official Kraken Futures trade candles (1m and 5m) for the pinned products.

Public charts API only, no credentials. Writes ``<PRODUCT>_1m.json`` and ``<PRODUCT>_5m.json``
(the API's ``candles`` arrays, oldest first) into ``--out``, the input of
``python -m balancita_engine.futures_strategy_reliability --charts-dir``.

    python3 scripts/fetch-kraken-charts.py --days 240 --out /tmp/charts
"""

import argparse
import concurrent.futures
import json
import os
import time
import urllib.request

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
BASE = "https://futures.kraken.com/api/charts/v1/trade/{product}/{resolution}?from={start}&to={end}"
STEP_SECONDS = {"1m": 60, "5m": 300}
PER_REQUEST = 1700  # the API returns at most 2000 candles per call


def fetch(url, retries=5):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                return json.load(response)["candles"]
        except Exception:  # network and rate-limit errors alike: back off and retry
            time.sleep(1 + attempt)
    raise RuntimeError("could not fetch " + url)


def download(product, resolution, days, now):
    step = STEP_SECONDS[resolution]
    candles, cursor = {}, now - days * 86_400
    while cursor < now:
        end = min(cursor + step * PER_REQUEST, now)
        for candle in fetch(BASE.format(product=product, resolution=resolution, start=cursor, end=end)):
            candles[candle["time"]] = candle
        cursor = end
    return [candles[key] for key in sorted(candles)]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--days", type=int, default=240)
    parser.add_argument("--out", required=True)
    parser.add_argument("--products", default=None, help="comma list; default: config/futures-products.json")
    args = parser.parse_args()
    if args.products:
        products = args.products.split(",")
    else:
        with open(os.path.join(ROOT, "config", "futures-products.json"), encoding="utf-8") as handle:
            products = [p["product_id"] for p in json.load(handle)["products"]]
    os.makedirs(args.out, exist_ok=True)
    now = int(time.time())

    def job(item):
        product, resolution = item
        rows = download(product, resolution, args.days, now)
        with open(os.path.join(args.out, "{}_{}.json".format(product, resolution)), "w", encoding="utf-8") as handle:
            json.dump(rows, handle)
        return product, resolution, len(rows)

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        for product, resolution, count in pool.map(job, [(p, r) for p in products for r in STEP_SECONDS]):
            print(product, resolution, count, flush=True)


if __name__ == "__main__":
    main()
