"""Offline study: does the funding percentile predict the next return? No model involved.

Usage: python3 scripts/funding_signal_study.py --funding-dir DIR --candles-dir DIR [--fetch]
DIR/f_<PRODUCT>.json is the public historical-funding-rates response; DIR/c_<PRODUCT>.json the
hourly trade candles ({"candles": [...]}). --fetch downloads both from Kraken's public API.
Rule fixed before running: percentile of the last closed funding period against the 720 periods
before it; extreme = pctl >= 90 or <= 10; forward return from the next hour open, horizons 1/8/24 h.
"""
import argparse, json, math, os, statistics, urllib.request

PRODUCTS = ["PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_ZECUSD", "PF_XRPUSD", "PF_NEARUSD", "PF_HYPEUSD", "PF_ADAUSD"]
HOUR = 3_600_000
WINDOW = 720


def fetch(funding_dir, candles_dir):
    for p in PRODUCTS:
        url = "https://futures.kraken.com/derivatives/api/v3/historical-funding-rates?symbol=" + p
        open(os.path.join(funding_dir, "f_%s.json" % p), "wb").write(urllib.request.urlopen(url, timeout=60).read())
        out, start = [], 1759700000
        while True:
            url = "https://futures.kraken.com/api/charts/v1/trade/%s/1h?from=%d&to=1999999999" % (p, start)
            d = json.load(urllib.request.urlopen(url, timeout=60))
            out += d["candles"]
            if not d.get("more_candles") or not d["candles"]:
                break
            start = d["candles"][-1]["time"] // 1000 + 1
        json.dump({"candles": out}, open(os.path.join(candles_dir, "c_%s.json" % p), "w"))


def pctl(window, value):
    return 100.0 * sum(1 for x in window if x < value) / len(window)


def ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    for k, i in enumerate(order):
        r[i] = k
    return r


def spearman(a, b):
    if len(a) < 10:
        return None
    ra, rb = ranks(a), ranks(b)
    ma, mb = statistics.mean(ra), statistics.mean(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    den = math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    return num / den if den else None


def study(funding_dir, candles_dir, horizons=(1, 8, 24), cost_bp=10.0):
    rows = []  # (product, t, pctl, {h: gross_bp})
    for p in PRODUCTS:
        fr = {int(__import__("datetime").datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00")).timestamp() * 1000): r["relativeFundingRate"]
              for r in json.load(open(os.path.join(funding_dir, "f_%s.json" % p)))["rates"]}
        opens = {c["time"]: float(c["open"]) for c in json.load(open(os.path.join(candles_dir, "c_%s.json" % p)))["candles"]}
        starts = sorted(fr)
        for i in range(WINDOW, len(starts)):
            s = starts[i]  # period [s, s+1h) closes at s+1h; decision at s+1h, enter at open of hour s+1h
            t = s + HOUR
            window = [fr[x] for x in starts[i - WINDOW:i]]  # excludes the period being judged
            if t not in opens:
                continue
            fwd = {}
            for h in horizons:
                end = opens.get(t + h * HOUR)
                if end:
                    fwd[h] = (end / opens[t] - 1) * 1e4
            rows.append((p, t, pctl(window, fr[s]), fwd, fr[s]))
    return rows


def report(rows, horizons=(1, 8, 24), cost_bp=10.0):
    print("periods:", len(rows))
    for h in horizons:
        sel = [(r[2], r[3][h]) for r in rows if h in r[3]]
        rho = spearman([a for a, _ in sel], [b for _, b in sel])
        print("\nhorizon %dh  n=%d  spearman(pctl, fwd return)=%s" % (h, len(sel), None if rho is None else round(rho, 4)))
        for lo, hi in ((0, 10), (10, 30), (30, 70), (70, 90), (90, 100.01)):
            g = [b for a, b in sel if lo <= a < hi]
            if g:
                m = statistics.mean(g)
                se = statistics.pstdev(g) / math.sqrt(len(g))
                print("  pctl %5.1f-%5.1f n=%5d mean=%7.2f bp  t=%5.2f" % (lo, min(hi, 100), len(g), m, m / se if se else 0))
        hi_ = [b for a, b in sel if a >= 90]
        lo_ = [b for a, b in sel if a <= 10]
        if hi_ and lo_:
            net = statistics.mean(lo_) - statistics.mean(hi_)
            print("  contrarian (short pctl>=90, long pctl<=10): gross %.2f bp/trade, minus %.0f bp cost = %.2f" % (net / 2 * 1, cost_bp, net / 2 - cost_bp))
    print("\nper-product contrarian gross (24h): see below")
    for p in PRODUCTS:
        sel = [(r[2], r[3][24]) for r in rows if r[0] == p and 24 in r[3]]
        hi_ = [b for a, b in sel if a >= 90]
        lo_ = [b for a, b in sel if a <= 10]
        if hi_ and lo_:
            print("  %s n_hi=%d n_lo=%d  gross %.1f bp" % (p, len(hi_), len(lo_), (statistics.mean(lo_) - statistics.mean(hi_)) / 2))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--funding-dir", required=True)
    ap.add_argument("--candles-dir", required=True)
    ap.add_argument("--fetch", action="store_true")
    a = ap.parse_args()
    if a.fetch:
        fetch(a.funding_dir, a.candles_dir)
    report(study(a.funding_dir, a.candles_dir))
