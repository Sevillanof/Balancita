"""Descarga velas 1 h (apertura, cierre, volumen) de TODOS los PF_* que el servicio de graficos de Kraken lista,
activos y retirados, hasta el corte reservado. Nada desde 2026-08-02. Uso: python3 -I mr1x_data.py <dir>
"""
import calendar
import concurrent.futures
import json
import os
import subprocess
import sys

BASE = "https://futures.kraken.com/api/charts/v1/trade"
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
    return None


def candles(symbol):
    out, cur = {}, START
    while cur < CUTOFF:
        end = min(cur + 1500 * HOUR, CUTOFF - 1)
        res = get("{}/{}/1h?from={}&to={}".format(BASE, symbol, cur, end))
        if res is None:
            return None
        for c in res.get("candles", []):
            t = c["time"] // 1000
            if t < CUTOFF:
                out[t] = [c["open"], c["close"], c["volume"]]
        cur = end + 1
    return out


def one(args):
    symbol, folder = args
    path = os.path.join(folder, symbol + ".json")
    if os.path.exists(path):
        return symbol, -1
    data = candles(symbol)
    if data is None:
        return symbol, None
    json.dump(data, open(path, "w"))
    return symbol, len(data)


def main(folder):
    os.makedirs(folder, exist_ok=True)
    symbols = [s for s in get(BASE) if s.startswith("PF_")]
    rows = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        for symbol, n in pool.map(one, [(s, folder) for s in symbols]):
            rows[symbol] = n
    json.dump(rows, open(os.path.join(folder, "_resumen.json"), "w"))
    print(len(rows), "simbolos;", sum(1 for v in rows.values() if v), "con velas;", sum(1 for v in rows.values() if v is None), "fallidos")


if __name__ == "__main__":
    main(sys.argv[1])
