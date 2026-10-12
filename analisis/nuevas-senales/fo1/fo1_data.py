"""Descarga OI, liquidaciones y velas 1 h de Kraken Futures (API publica) hasta el corte reservado.

Nada desde CUTOFF se pide ni se guarda. Uso: python3 fo1_data.py <directorio_cache>
"""
import calendar
import json
import os
import subprocess
import sys

BASE = "https://futures.kraken.com/api/charts/v1"
PRODUCTS = ["PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD", "PF_HYPEUSD", "PF_ZECUSD", "PF_ADAUSD", "PF_NEARUSD"]
CUTOFF = calendar.timegm((2026, 8, 2, 0, 0, 0))
START = calendar.timegm((2023, 3, 1, 0, 0, 0))
HOUR = 3600


def get(url):
    for _ in range(4):
        out = subprocess.run(["curl", "-sS", "-m", "60", url], capture_output=True, text=True).stdout
        try:
            return json.loads(out)
        except ValueError:
            continue
    raise RuntimeError("sin respuesta: " + url)


def analytics(product, metric):
    out, cur = {}, START
    while cur < CUTOFF:
        res = get("{}/analytics/{}/{}?since={}&interval={}".format(BASE, product, metric, cur, HOUR)).get("result")
        if not res or not res["timestamp"]:
            break
        for i, t in enumerate(res["timestamp"]):
            if t < CUTOFF:
                out[t] = res["data"][i]
        nxt = max(res["timestamp"]) + HOUR
        if nxt <= cur or not res.get("more"):
            break
        cur = nxt
    return out


def candles(product):
    out, cur = {}, START
    while cur < CUTOFF:
        end = min(cur + 1500 * HOUR, CUTOFF - 1)
        res = get("{}/trade/{}/1h?from={}&to={}".format(BASE, product, cur, end))
        for c in res.get("candles", []):
            t = c["time"] // 1000
            if t < CUTOFF:
                out[t] = [c["open"], c["close"]]
        cur = end + 1
    return out


def main(cache):
    os.makedirs(cache, exist_ok=True)
    for p in PRODUCTS:
        data = {"oi": analytics(p, "open-interest"), "liq": analytics(p, "liquidation-volume"), "candles": candles(p)}
        json.dump(data, open(os.path.join(cache, p + ".json"), "w"))
        print(p, {k: len(v) for k, v in data.items()}, flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
