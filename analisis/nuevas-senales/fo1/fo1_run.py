"""FO-1: desarme de posiciones por Open Interest y liquidaciones. Ejecuta la especificacion congelada.

Uso: PYTHONPATH=python python3 -I fo1_run.py <cache> <salida.json>
Solo lee datos anteriores al corte reservado (ver fo1_data.py). No hay parametros libres: todo esta en fo1_spec.json.
"""
import bisect
import json
import math
import os
import random
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "python"))
from balancita_engine.futures_costs import round_trip_cost_bps  # noqa: E402

HOUR = 3600
WINDOW = 4
LOOKBACK = 90 * 24
MIN_HISTORY = 1500
QUIET = 24
Q_LOW, Q_HIGH = 0.05, 0.95
HORIZONS = (4, 24)
SEED = 20261012
BOOT = 5000
CONTROLS = 200
MIN_CLUSTERS = 100
PRODUCTS = ["PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD", "PF_HYPEUSD", "PF_ZECUSD", "PF_ADAUSD", "PF_NEARUSD"]


def load(cache, product):
    raw = json.load(open(os.path.join(cache, product + ".json")))
    oi = {int(t): float(v[3]) for t, v in raw["oi"].items()}
    liq = {int(t): float(v) for t, v in raw["liq"].items()}
    opn = {int(t): float(v[0]) for t, v in raw["candles"].items()}
    return oi, liq, opn


def features(oi, liq, t):
    """dOI y liq4h del bucket que empieza en t. Solo usa buckets <= t (cerrado en t+1h)."""
    a, b = oi.get(t), oi.get(t - WINDOW * HOUR)
    if a is None or b is None or a <= 0 or b <= 0:
        return None
    return math.log(a / b), sum(liq.get(t - k * HOUR, 0.0) for k in range(WINDOW))


def quantile(sorted_values, q):
    return sorted_values[min(len(sorted_values) - 1, int(q * len(sorted_values)))]


def trailing(values_by_t, grid, extract, q, direction):
    """Para cada t de la rejilla: ¿el valor esta en la cola q de los LOOKBACK previos (sin t)?"""
    window, order, flags = [], [], {}
    for t in grid:
        v = extract(t)
        if v is not None and len(window) >= MIN_HISTORY:
            thr = quantile(window, q)
            flags[t] = (v <= thr) if direction == "low" else (v >= thr)
        else:
            flags[t] = False
        if v is not None:
            bisect.insort(window, v)
            order.append((t, v))
            while order and order[0][0] <= t - LOOKBACK * HOUR:
                old = order.pop(0)
                window.pop(bisect.bisect_left(window, old[1]))
    return flags


def price_move(opn, t):
    a, b = opn.get(t - (WINDOW - 1) * HOUR), opn.get(t + HOUR)
    if a is None or b is None:
        return None
    return math.log(b / a)


def event_hours(product, oi, liq, opn):
    grid = sorted(oi)
    f = {t: features(oi, liq, t) for t in grid}
    low = trailing(f, grid, lambda t: f[t][0] if f[t] else None, Q_LOW, "low")
    high = trailing(f, grid, lambda t: f[t][1] if f[t] else None, Q_HIGH, "high")
    events = [t for t in grid if low[t] and high[t]]
    return events, len(grid)


def onsets(times):
    out, last = [], None
    for t in sorted(times):
        if last is None or t - last > QUIET * HOUR:
            out.append(t)
        last = t
    return out


def make_trade(product, opn, t, side, horizon):
    entry, exit_ = opn.get(t + 2 * HOUR), opn.get(t + (2 + horizon) * HOUR)
    if not entry or not exit_:
        return None
    gross = side * math.log(exit_ / entry) * 1e4
    return {"product": product, "bucket": t, "entry_t": t + 2 * HOUR, "side": side, "gross_bp": gross,
            "cost_bp": float(round_trip_cost_bps(product))}


def build(data, horizon):
    trades, raw_counts = [], {}
    for p, (oi, liq, opn) in data.items():
        ev, _ = event_hours(p, oi, liq, opn)
        starts = onsets(ev)
        raw_counts[p] = {"hours_event": len(ev), "episodes": len(starts)}
        for t in starts:
            move = price_move(opn, t)
            if move is None or move == 0:
                continue
            tr = make_trade(p, opn, t, -1 if move > 0 else 1, horizon)
            if tr:
                trades.append(tr)
    trades.sort(key=lambda x: x["entry_t"])
    return trades, raw_counts


def clusters(trades):
    groups, last = [], None
    for tr in trades:
        if last is None or tr["entry_t"] - last >= QUIET * HOUR:
            groups.append([])
        groups[-1].append(tr)
        last = tr["entry_t"]
    return groups


def mean(xs):
    return statistics.fmean(xs) if xs else float("nan")


def boot_ci(groups, key, reps=BOOT, seed=SEED):
    rng = random.Random(seed)
    sums = [(sum(t[key] for t in g), len(g)) for g in groups]
    n = len(sums)
    vals = []
    for _ in range(reps):
        s = c = 0
        for _ in range(n):
            a, b = sums[rng.randrange(n)]
            s += a
            c += b
        vals.append(s / c)
    vals.sort()
    return vals[int(0.05 * reps)], vals[int(0.95 * reps) - 1]


def horizon_sigma(data, horizon):
    sig = {}
    for p, (_, _, opn) in data.items():
        ts = sorted(opn)
        rets = [math.log(opn[ts[i + horizon]] / opn[ts[i]]) * 1e4 for i in range(0, len(ts) - horizon, horizon)
                if ts[i + horizon] - ts[i] == horizon * HOUR]
        sig[p] = statistics.pstdev(rets)
    return sig


def summarize(trades, sigma):
    for tr in trades:
        tr["net_bp"] = tr["gross_bp"] - tr["cost_bp"]
    if not trades:
        return {"episodios": 0}
    groups = clusters(trades)
    n = len(groups)
    lo, hi = boot_ci(groups, "gross_bp") if n >= 2 else (float("nan"),) * 2
    cost = mean([t["cost_bp"] for t in trades])
    sig = mean([sigma[t["product"]] for t in trades])
    thr = cost + 3 * sig / math.sqrt(n)
    third = len(trades) // 3
    parts = [trades[:third], trades[third:2 * third], trades[2 * third:]] if third else []
    by_p = {}
    for t in trades:
        by_p.setdefault(t["product"], []).append(t)
    out = {
        "episodios": len(trades), "clusters": n,
        "bruto_medio_bp": round(mean([t["gross_bp"] for t in trades]), 2),
        "neto_medio_bp": round(mean([t["net_bp"] for t in trades]), 2),
        "coste_medio_bp": round(cost, 2), "ic90_bruto_bp": [round(lo, 2), round(hi, 2)],
        "sigma_horizonte_bp": round(sig, 1), "umbral_bruto_bp": round(thr, 2),
        "acierto_bruto": round(mean([1.0 if t["gross_bp"] > 0 else 0.0 for t in trades]), 3),
        "tercios_neto_bp": [round(mean([t["net_bp"] for t in q]), 2) for q in parts],
        "por_producto": {p: {"n": len(v), "bruto_bp": round(mean([t["gross_bp"] for t in v]), 2),
                             "neto_bp": round(mean([t["net_bp"] for t in v]), 2)} for p, v in sorted(by_p.items())},
    }
    if n < MIN_CLUSTERS:
        out["veredicto"] = "evidencia insuficiente"
    elif out["neto_medio_bp"] < 0:
        out["veredicto"] = "evidencia desfavorable"
    elif lo > thr:
        out["veredicto"] = "candidata prometedora (no validada)"
    else:
        out["veredicto"] = "ventaja no demostrada"
    return out


def eligible(data, product, horizon, first_ok):
    oi, _, opn = data[product]
    return [t for t in sorted(oi) if t >= first_ok[product] and opn.get(t + 2 * HOUR) and opn.get(t + (2 + horizon) * HOUR)]


def controls(data, trades, horizon, first_ok):
    """R1: mismos productos, mismo numero y reparto de lados, horas al azar."""
    counts = {}
    for t in trades:
        c = counts.setdefault(t["product"], [0, 0])
        c[0 if t["side"] > 0 else 1] += 1
    pool = {p: eligible(data, p, horizon, first_ok) for p in counts}
    means_g, means_n = [], []
    for seed in range(CONTROLS):
        rng = random.Random("{}:{}:{}".format(SEED, horizon, seed))
        gs, ns = [], []
        for p, (nl, ns_) in counts.items():
            for side, k in ((1, nl), (-1, ns_)):
                for _ in range(k):
                    tr = make_trade(p, data[p][2], rng.choice(pool[p]) - 2 * HOUR, side, horizon)
                    if tr:
                        gs.append(tr["gross_bp"])
                        ns.append(tr["gross_bp"] - tr["cost_bp"])
        means_g.append(mean(gs))
        means_n.append(mean(ns))
    return means_g, means_n


def price_only(data, trades, horizon, first_ok):
    """R2: por producto, los n mayores |retorno 4h| (z causal) con exclusion de 24 h, direccion contraria."""
    counts = {}
    for t in trades:
        counts[t["product"]] = counts.get(t["product"], 0) + 1
    out = []
    for p, k in counts.items():
        oi, _, opn = data[p]
        cand = []
        hist = []
        for t in sorted(oi):
            m = price_move(opn, t)
            if m is None:
                continue
            if len(hist) >= MIN_HISTORY and t >= first_ok[p]:
                sd = statistics.pstdev(hist[-LOOKBACK:])
                if sd > 0:
                    cand.append((abs(m) / sd, t, m))
            hist.append(m)
        cand.sort(reverse=True)
        taken = []
        for z, t, m in cand:
            if all(abs(t - u) > QUIET * HOUR for u in taken):
                tr = make_trade(p, opn, t, -1 if m > 0 else 1, horizon)
                if tr:
                    taken.append(t)
                    out.append(tr)
            if len(taken) >= k:
                break
    out.sort(key=lambda x: x["entry_t"])
    return out


def main(cache, out_path):
    data = {p: load(cache, p) for p in PRODUCTS}
    first_ok = {}
    for p, (oi, _, _) in data.items():
        ts = sorted(oi)
        first_ok[p] = ts[MIN_HISTORY] if len(ts) > MIN_HISTORY else ts[-1]
    result = {"spec": "FO-1 v1", "horizontes": {}}
    for h in HORIZONS:
        sigma = horizon_sigma(data, h)
        trades, raw = build(data, h)
        main_sum = summarize(trades, sigma)
        sub = [t for t in trades if t["product"] not in ("PF_HYPEUSD", "PF_ZECUSD")]
        mirror = [dict(t, gross_bp=-t["gross_bp"]) for t in trades]
        cg, cn = controls(data, trades, h, first_ok)
        net = main_sum.get("neto_medio_bp")
        r2 = price_only(data, trades, h, first_ok)
        entry = {
            "episodios_crudos": raw,
            "principal": main_sum,
            "sin_HYPE_ZEC": summarize(sub, sigma),
            "R1_azar": {"bruto_medio_bp": round(mean(cg), 2), "neto_medio_bp": round(mean(cn), 2),
                        "p95_neto_bp": round(sorted(cn)[int(0.95 * len(cn)) - 1], 2),
                        "fraccion_sorteos_con_neto_ge_FO1": round(sum(1 for x in cn if x >= net) / len(cn), 3) if net is not None else None},
            "R2_solo_precio": summarize(r2, sigma),
            "R3_espejo": summarize(mirror, sigma),
        }
        result["horizontes"][str(h)] = entry
        print("H", h, json.dumps(main_sum["veredicto"] if "veredicto" in main_sum else main_sum), flush=True)
    json.dump(result, open(out_path, "w"), indent=1, sort_keys=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
