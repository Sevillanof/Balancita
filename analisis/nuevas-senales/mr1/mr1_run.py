"""MR-1: momentum relativo semanal long/short. Ejecuta la especificacion congelada (mr1_spec.json).

Uso: PYTHONPATH=python python3 -I mr1_run.py <cache_fo1> <salida.json>
"""
import calendar
import json
import math
import os
import random
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "fo1"))
sys.path.insert(0, os.path.join(HERE, "..", "re1"))
import fo1_run as f  # noqa: E402
import re1_run as r  # noqa: E402

HOUR = 3600
DAY = 24 * HOUR
LOOKBACK_D = 28
MIN_PRODUCTS = 4
MIN_WEEKS = 100
SEED, BOOT, CONTROLS = f.SEED, f.BOOT, f.CONTROLS
BLOCK = 4
START = calendar.timegm((2023, 3, 1, 0, 0, 0))
CUTOFF = calendar.timegm((2026, 8, 2, 0, 0, 0))


def mondays():
    t = START
    while t < CUTOFF - 8 * DAY:
        if time.gmtime(t).tm_wday == 0:
            yield t
        t += DAY


def legs_for(week_t, opn_by_p, products):
    """Productos elegibles con retorno 28 d, entrada y salida disponibles."""
    out = []
    for p in products:
        opn = opn_by_p[p]
        a, b = opn.get(week_t), opn.get(week_t - LOOKBACK_D * DAY)
        e, x = opn.get(week_t + 2 * HOUR), opn.get(week_t + 7 * DAY + 2 * HOUR)
        if a and b and e and x:
            out.append({"p": p, "mom": math.log(a / b), "lr": math.log(x / e) * 1e4,
                        "cost": float(f.round_trip_cost_bps(p))})
    return out


def pick(legs):
    n = len(legs)
    k = n // 4
    order = sorted(legs, key=lambda d: (-d["mom"], d["p"]))
    return order[:k], order[n - k:], k


def week_result(week_t, legs, longs, shorts, k, held=None):
    gross = f.mean([d["lr"] for d in longs]) - f.mean([d["lr"] for d in shorts])
    cost = f.mean([d["cost"] for d in longs]) + f.mean([d["cost"] for d in shorts])
    cost_net = None
    if held is not None:
        cost_net = sum(d["cost"] for d in longs if (d["p"], 1) not in held) / k + sum(d["cost"] for d in shorts if (d["p"], -1) not in held) / k
    mkt = f.mean([d["lr"] for d in legs])
    return {"t": week_t, "gross": gross, "cost": cost, "net": gross - cost, "cost_netting": cost_net, "mkt": mkt, "k": k, "n": len(legs)}


def spearman(legs):
    def ranks(xs):
        order = sorted(range(len(xs)), key=lambda i: xs[i])
        rk = [0.0] * len(xs)
        for pos, i in enumerate(order):
            rk[i] = pos
        return rk
    a, b = ranks([d["mom"] for d in legs]), ranks([d["lr"] for d in legs])
    ma, mb = f.mean(a), f.mean(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    den = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
    return num / den if den else 0.0


def run_weeks(opn_by_p, products, with_funding=None):
    weeks, held, ics, contrib = [], None, [], {}
    for t in mondays():
        legs = legs_for(t, opn_by_p, products)
        if len(legs) < MIN_PRODUCTS:
            held = None
            continue
        longs, shorts, k = pick(legs)
        w = week_result(t, legs, longs, shorts, k, held)
        if with_funding is not None and t + 2 * HOUR >= r.FUNDING_START:
            pay = 0.0
            for d in longs:
                pay += sum(with_funding[d["p"]].get(t + 2 * HOUR + j * HOUR, 0.0) for j in range(1, 169)) * 1e4 / k
            for d in shorts:
                pay -= sum(with_funding[d["p"]].get(t + 2 * HOUR + j * HOUR, 0.0) for j in range(1, 169)) * 1e4 / k
            w["funding"] = pay
        weeks.append(w)
        ics.append(spearman(legs))
        for d in longs:
            contrib[d["p"]] = contrib.get(d["p"], 0.0) + d["lr"] / k
        for d in shorts:
            contrib[d["p"]] = contrib.get(d["p"], 0.0) - d["lr"] / k
        held = {(d["p"], 1) for d in longs} | {(d["p"], -1) for d in shorts}
    return weeks, ics, contrib


def stationary_ci(series, reps=BOOT, seed=SEED):
    rng = random.Random(seed)
    n = len(series)
    vals = []
    for _ in range(reps):
        i, tot = rng.randrange(n), 0.0
        for _ in range(n):
            tot += series[i]
            i = rng.randrange(n) if rng.random() < 1 / BLOCK else (i + 1) % n
        vals.append(tot / n)
    vals.sort()
    return vals[int(0.05 * reps)], vals[int(0.95 * reps) - 1]


def max_drawdown(series):
    peak = cum = dd = 0.0
    for x in series:
        cum += x
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return dd


def summarize(weeks, ics, contrib):
    n = len(weeks)
    if n == 0:
        return {"semanas": 0}
    g, c, nt = [w["gross"] for w in weeks], [w["cost"] for w in weeks], [w["net"] for w in weeks]
    lo, hi = stationary_ci(g)
    sig = statistics.pstdev(g)
    cost = f.mean(c)
    thr = cost + 3 * sig / math.sqrt(n)
    third = n // 3
    parts = [nt[:third], nt[third:2 * third], nt[2 * third:]]
    beta_den = sum((w["mkt"] - f.mean([x["mkt"] for x in weeks])) ** 2 for w in weeks)
    mm = f.mean([w["mkt"] for w in weeks])
    beta = sum((w["mkt"] - mm) * (w["gross"] - f.mean(g)) for w in weeks) / beta_den if beta_den else 0.0
    alpha = f.mean(g) - beta * mm
    resid = [w["gross"] - alpha - beta * w["mkt"] for w in weeks]
    se = statistics.pstdev(resid) / math.sqrt(n)
    ic_t = f.mean(ics) / (statistics.pstdev(ics) / math.sqrt(len(ics))) if len(ics) > 1 else 0.0
    total = sum(abs(v) for v in contrib.values()) or 1.0
    out = {
        "semanas": n, "bruto_medio_bp": round(f.mean(g), 2), "neto_medio_bp": round(f.mean(nt), 2), "coste_semanal_medio_bp": round(cost, 2),
        "ic90_bruto_bp": [round(lo, 2), round(hi, 2)], "sigma_semanal_bp": round(sig, 1), "umbral_bruto_bp": round(thr, 2),
        "semanas_positivas_neto": round(f.mean([1.0 if x > 0 else 0.0 for x in nt]), 3),
        "tercios_neto_bp": [round(f.mean(p), 2) for p in parts],
        "drawdown_maximo_neto_bp": round(max_drawdown(nt), 1),
        "IC_spearman_medio": round(f.mean(ics), 4), "IC_spearman_t": round(ic_t, 2),
        "beta_mercado": round(beta, 3), "alfa_bruto_bp": round(alpha, 2), "alfa_ic90_bp": [round(alpha - 1.645 * se, 2), round(alpha + 1.645 * se, 2)],
        "aporte_por_producto_bp": {p: round(v, 0) for p, v in sorted(contrib.items())},
        "peso_max_producto": round(max(abs(v) for v in contrib.values()) / total, 3),
    }
    pairs = [(w["gross"], w["cost_netting"]) for w in weeks if w["cost_netting"] is not None]
    if pairs:
        out["neto_medio_con_costes_solo_en_cambios_bp"] = round(f.mean([a - b for a, b in pairs]), 2)
    if n < MIN_WEEKS:
        out["veredicto"] = "evidencia insuficiente"
    elif out["neto_medio_bp"] < 0:
        out["veredicto"] = "evidencia desfavorable"
    elif lo > thr:
        out["veredicto"] = "candidata prometedora (no validada)"
    else:
        out["veredicto"] = "ventaja no demostrada"
    return out


def random_control(opn_by_p, products, net_ref):
    gs, ns = [], []
    for seed in range(CONTROLS):
        rng = random.Random("{}:mr1:{}".format(SEED, seed))
        g, n = [], []
        for t in mondays():
            legs = legs_for(t, opn_by_p, products)
            if len(legs) < MIN_PRODUCTS:
                continue
            k = len(legs) // 4
            sel = rng.sample(legs, 2 * k)
            lo, sh = sel[:k], sel[k:]
            gross = f.mean([d["lr"] for d in lo]) - f.mean([d["lr"] for d in sh])
            cost = f.mean([d["cost"] for d in lo]) + f.mean([d["cost"] for d in sh])
            g.append(gross)
            n.append(gross - cost)
        gs.append(f.mean(g))
        ns.append(f.mean(n))
    return {"bruto_medio_bp": round(f.mean(gs), 2), "neto_medio_bp": round(f.mean(ns), 2), "p95_neto_bp": round(sorted(ns)[int(0.95 * CONTROLS) - 1], 2),
            "fraccion_sorteos_con_neto_ge_MR1": round(sum(1 for x in ns if x >= net_ref) / CONTROLS, 3)}


def main(cache, out_path):
    data = {p: f.load(cache, p) for p in f.PRODUCTS}
    opn_by_p = {p: v[2] for p, v in data.items()}
    fund = {p: r.funding_rates(p) for p in f.PRODUCTS}
    weeks, ics, contrib = run_weeks(opn_by_p, f.PRODUCTS, with_funding=fund)
    main_sum = summarize(weeks, ics, contrib)
    fw = [w for w in weeks if "funding" in w]
    fund_sum = {"semanas": len(fw)}
    if fw:
        fund_sum.update({"neto_medio_sin_funding_bp": round(f.mean([w["net"] for w in fw]), 2),
                         "funding_medio_bp": round(f.mean([w["funding"] for w in fw]), 2),
                         "neto_medio_con_funding_bp": round(f.mean([w["net"] - w["funding"] for w in fw]), 2),
                         "veredicto": "evidencia insuficiente" if len(fw) < MIN_WEEKS else "ver neto"})
    sub = [p for p in f.PRODUCTS if p not in ("PF_HYPEUSD", "PF_ZECUSD")]
    w2, i2, c2 = run_weeks(opn_by_p, sub)
    mirror_weeks = []
    for w in weeks:
        mirror_weeks.append(dict(w, gross=-w["gross"], net=-w["gross"] - w["cost"]))
    result = {
        "spec": "MR-1 v1", "principal": main_sum, "funding_ventana_2025-10": fund_sum,
        "sin_HYPE_ZEC": summarize(w2, i2, c2),
        "C1_seleccion_aleatoria": random_control(opn_by_p, f.PRODUCTS, main_sum["neto_medio_bp"]),
        "C3_espejo": summarize(mirror_weeks, [-x for x in ics], {p: -v for p, v in contrib.items()}),
    }
    json.dump(result, open(out_path, "w"), indent=1, sort_keys=True)
    print(main_sum.get("veredicto"), main_sum["semanas"], flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
