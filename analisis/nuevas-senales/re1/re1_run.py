"""RE-1: reversion tras movimientos extremos de 4 h. Ejecuta la especificacion congelada (re1_spec.json).

Uso: PYTHONPATH=python python3 -I re1_run.py <cache_fo1> <salida.json>
"""
import bisect
import calendar
import json
import math
import os
import random
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "fo1"))
import fo1_run as f  # noqa: E402

HOUR, LOOKBACK, MIN_HISTORY, QUIET = f.HOUR, f.LOOKBACK, f.MIN_HISTORY, f.QUIET
PCT = 0.99
HORIZONS = (24, 4)
SEED, BOOT, CONTROLS = f.SEED, f.BOOT, f.CONTROLS
VOL_HOURS = 168
FUNDING_START = calendar.timegm((2025, 10, 6, 8, 0, 0))


def r4_series(opn, grid):
    return {t: f.price_move(opn, t) for t in grid}


def extremes(r4, grid):
    window, order, out = [], [], []
    for t in grid:
        v = r4[t]
        if v is None:
            continue
        a = abs(v)
        if len(window) >= MIN_HISTORY and a >= f.quantile(window, PCT):
            out.append(t)
        bisect.insort(window, a)
        order.append((t, a))
        while order and order[0][0] <= t - LOOKBACK * HOUR:
            old = order.pop(0)
            window.pop(bisect.bisect_left(window, old[1]))
    return out


def vol168(opn, t):
    xs = []
    for k in range(VOL_HOURS):
        a, b = opn.get(t + HOUR - k * HOUR), opn.get(t - (k + 1) * HOUR + HOUR)
        if a and b:
            xs.append(math.log(a / b))
    return statistics.pstdev(xs) if len(xs) > 100 else None


def quarter(t):
    import time
    s = time.gmtime(t)
    return (s.tm_year, (s.tm_mon - 1) // 3)


def funding_rates(product):
    out = subprocess.run(["curl", "-sS", "-m", "60", "https://futures.kraken.com/derivatives/api/v4/historicalfundingrates?symbol=" + product],
                         capture_output=True, text=True).stdout
    rates = {}
    for r in json.loads(out)["rates"]:
        ts = calendar.timegm(__import__("time").strptime(r["timestamp"], "%Y-%m-%dT%H:%M:%SZ"))
        rates[ts] = float(r["relativeFundingRate"])
    return rates


def build(data, horizon):
    trades = []
    meta = {}
    for p, (oi, _, opn) in data.items():
        grid = sorted(opn)
        r4 = r4_series(opn, grid)
        ev = extremes(r4, grid)
        starts = f.onsets(ev)
        meta[p] = {"horas_extremas": len(ev), "episodios": len(starts)}
        for t in starts:
            m = r4[t]
            if not m:
                continue
            tr = f.make_trade(p, opn, t, -1 if m > 0 else 1, horizon)
            if tr:
                tr["bucket_vol"] = vol168(opn, t)
                trades.append(tr)
    trades.sort(key=lambda x: x["entry_t"])
    return trades, meta


def add_funding(trades, fund, horizon):
    sens = []
    for tr in trades:
        rates = fund.get(tr["product"])
        if not rates or tr["entry_t"] < FUNDING_START:
            continue
        paid = sum(rates.get(tr["entry_t"] + k * HOUR, 0.0) for k in range(1, horizon + 1)) * tr["side"] * 1e4
        sens.append(dict(tr, cost_bp=tr["cost_bp"] + paid))
    return sens


def control(data, trades, horizon):
    """C1: mismo producto, trimestre, tercil de volatilidad, lado y horizonte."""
    pools, cuts = {}, {}
    for p, (oi, _, opn) in data.items():
        elig = [t for t in sorted(opn) if opn.get(t + 2 * HOUR) and opn.get(t + (2 + horizon) * HOUR)]
        vols = []
        for t in elig[MIN_HISTORY::6]:
            v = vol168(opn, t)
            if v:
                vols.append(v)
        vols.sort()
        cuts[p] = (vols[len(vols) // 3], vols[2 * len(vols) // 3]) if vols else (0, 0)
        pools[p] = {}
        for t in elig[MIN_HISTORY:]:
            v = vol168(opn, t) if t % (6 * HOUR) == 0 else None
            if v is None:
                continue
            ter = 0 if v < cuts[p][0] else (1 if v < cuts[p][1] else 2)
            pools[p].setdefault((quarter(t), ter), []).append(t)
    spec = []
    for tr in trades:
        v = tr["bucket_vol"]
        if not v:
            continue
        c = cuts[tr["product"]]
        ter = 0 if v < c[0] else (1 if v < c[1] else 2)
        pool = pools[tr["product"]].get((quarter(tr["bucket"]), ter))
        if pool:
            spec.append((tr, pool))
    gs, ns = [], []
    for seed in range(CONTROLS):
        rng = random.Random("{}:re1:{}:{}".format(SEED, horizon, seed))
        g, n = [], []
        for tr, pool in spec:
            nt = f.make_trade(tr["product"], data[tr["product"]][2], rng.choice(pool), tr["side"], horizon)
            if nt:
                g.append(nt["gross_bp"])
                n.append(nt["gross_bp"] - nt["cost_bp"])
        gs.append(f.mean(g))
        ns.append(f.mean(n))
    return gs, ns, len(spec)


def tails(trades):
    g = sorted(t["gross_bp"] for t in trades)
    k = int(0.05 * len(g))
    trimmed = g[k:len(g) - k] if k else g
    top = sorted(g, reverse=True)[:10]
    tot = sum(g)
    return {"mediana_bruto_bp": round(statistics.median(g), 2), "media_recortada_5pc_bp": round(f.mean(trimmed), 2),
            "suma_10_mayores_bp": round(sum(top), 1), "suma_total_bp": round(tot, 1)}


def main(cache, out_path):
    data = {p: f.load(cache, p) for p in f.PRODUCTS}
    fund = {p: funding_rates(p) for p in f.PRODUCTS}
    result = {"spec": "RE-1 v1", "horizontes": {}}
    for h in HORIZONS:
        sigma = f.horizon_sigma(data, h)
        trades, meta = build(data, h)
        main_sum = f.summarize(trades, sigma)
        main_sum.update(tails(trades))
        sub = [t for t in trades if t["product"] not in ("PF_HYPEUSD", "PF_ZECUSD")]
        sens = add_funding(trades, fund, h)
        mirror = [dict(t, gross_bp=-t["gross_bp"]) for t in trades]
        cg, cn, nctl = control(data, trades, h)
        net = main_sum["neto_medio_bp"]
        result["horizontes"][str(h)] = {
            "episodios_crudos": meta, "principal": main_sum,
            "sin_HYPE_ZEC": f.summarize(sub, sigma),
            "con_funding_ventana_2025-10_en_adelante": f.summarize(sens, sigma),
            "C1_azar_equivalente": {"episodios_emparejados": nctl, "bruto_medio_bp": round(f.mean(cg), 2),
                                    "neto_medio_bp": round(f.mean(cn), 2), "p95_neto_bp": round(sorted(cn)[int(0.95 * len(cn)) - 1], 2),
                                    "fraccion_sorteos_con_neto_ge_RE1": round(sum(1 for x in cn if x >= net) / len(cn), 3)},
            "C2_espejo": f.summarize(mirror, sigma),
        }
        print("H", h, main_sum.get("veredicto"), main_sum.get("clusters"), flush=True)
    json.dump(result, open(out_path, "w"), indent=1, sort_keys=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
