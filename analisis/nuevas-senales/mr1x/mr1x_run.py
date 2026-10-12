"""MR-1X (prueba 8): MR-1 con universo historico ampliado. Ejecuta mr1x_spec.json, una sola vez.

Uso: PYTHONPATH=python python3 -I mr1x_run.py <cache_velas_PF> <cache_fo1> <instruments.json> <salida.json>
"""
import json
import math
import os
import random
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
for sub in ("fo1", "mr1"):
    sys.path.insert(0, os.path.join(HERE, "..", sub))
import fo1_run as f  # noqa: E402
import mr1_run as m  # noqa: E402

HOUR, DAY = m.HOUR, m.DAY
ORIG = f.PRODUCTS
THRESHOLD = 1_000_000.0
TIER_HIGH = 5_000_000.0
MIN_N = 8
K_CAP = 5
FEE_BP = 10.0
NEAR_IMPACT = 3.55
CONTROLS = f.CONTROLS
TRIALS = 8


def load_all(folder):
    opn, last, vol = {}, {}, {}
    for name in os.listdir(folder):
        if not name.startswith("PF_") or not name.endswith(".json"):
            continue
        sym = name[:-5]
        c = json.load(open(os.path.join(folder, name)))
        if not c:
            continue
        opn[sym] = {int(t): float(v[0]) for t, v in c.items()}
        last[sym] = max(opn[sym])
        d = {}
        for t, v in c.items():
            d[int(t) // DAY] = d.get(int(t) // DAY, 0.0) + float(v[2]) * float(v[1])
        vol[sym] = d
    return opn, last, vol


def trailing_volume(vol, sym, t):
    d = t // DAY
    return statistics.median([vol[sym].get(x, 0.0) for x in range(d - 28, d)])


def cost_for(sym, volume, impact_mult):
    if sym in ORIG:
        return float(f.round_trip_cost_bps(sym))
    impact = NEAR_IMPACT * (1.0 if volume >= TIER_HIGH else 2.0) * impact_mult
    return FEE_BP + 2 * impact


def exit_price(opn, last, sym, entry_t, exit_t):
    x = opn[sym].get(exit_t)
    if x:
        return x
    if last[sym] < exit_t and last[sym] > entry_t:
        return opn[sym][last[sym]]
    return None


def expanded_legs(t, opn, last, vol, excluded, retired, thr, impact_mult):
    legs = []
    for sym in opn:
        if sym in excluded:
            continue
        o = opn[sym]
        a, b, e = o.get(t), o.get(t - 28 * DAY), o.get(t + 2 * HOUR)
        if not (a and b and e):
            continue
        v = trailing_volume(vol, sym, t)
        if v < thr:
            continue
        x = exit_price(opn, last, sym, t + 2 * HOUR, t + 7 * DAY + 2 * HOUR)
        if not x:
            continue
        legs.append({"p": sym, "mom": math.log(a / b), "lr": math.log(x / e) * 1e4, "cost": cost_for(sym, v, impact_mult),
                     "retired": sym in retired})
    return legs


def pick_expanded(legs):
    n = len(legs)
    k = min(K_CAP, n // 4)
    order = sorted(legs, key=lambda d: (-d["mom"], d["p"]))
    return order[:k], order[n - k:], k


def run(opn, last, vol, excluded, retired, thr, impact_mult, only=None, only_weeks=None):
    weeks, ics, contrib, ret_pnl = [], [], {}, 0.0
    for t in m.mondays():
        if only_weeks is not None and t not in only_weeks:
            continue
        legs = expanded_legs(t, opn, last, vol, excluded, retired, thr, impact_mult)
        if only is not None:
            legs = [d for d in legs if d["p"] in only]
        if len(legs) < MIN_N:
            continue
        longs, shorts, k = pick_expanded(legs)
        w = m.week_result(t, legs, longs, shorts, k)
        weeks.append(w)
        ics.append(m.spearman(legs))
        for d in longs:
            contrib[d["p"]] = contrib.get(d["p"], 0.0) + d["lr"] / k
            ret_pnl += d["lr"] / k if d["retired"] else 0.0
        for d in shorts:
            contrib[d["p"]] = contrib.get(d["p"], 0.0) - d["lr"] / k
            ret_pnl -= d["lr"] / k if d["retired"] else 0.0
    return weeks, ics, contrib, ret_pnl


def original(opn_orig, only_weeks=None):
    weeks, ics, contrib = [], [], {}
    for t in m.mondays():
        if only_weeks is not None and t not in only_weeks:
            continue
        legs = m.legs_for(t, opn_orig, ORIG)
        if len(legs) < m.MIN_PRODUCTS:
            continue
        longs, shorts, k = m.pick(legs)
        weeks.append(m.week_result(t, legs, longs, shorts, k))
        ics.append(m.spearman(legs))
        for d in longs:
            contrib[d["p"]] = contrib.get(d["p"], 0.0) + d["lr"] / k
        for d in shorts:
            contrib[d["p"]] = contrib.get(d["p"], 0.0) - d["lr"] / k
    return weeks, ics, contrib


def concentration(contrib, ret_pnl=None):
    tot = sum(abs(v) for v in contrib.values()) or 1.0
    ordered = sorted(contrib.values(), key=abs, reverse=True)
    out = {"productos_con_aporte": len(contrib), "peso_max_producto": round(abs(ordered[0]) / tot, 3),
           "peso_3_primeros": round(sum(abs(x) for x in ordered[:3]) / tot, 3),
           "top5_productos": [(p, round(v)) for p, v in sorted(contrib.items(), key=lambda kv: -abs(kv[1]))[:5]]}
    if ret_pnl is not None:
        out["pnl_en_productos_no_listados_hoy_bp"] = round(ret_pnl)
        out["pnl_total_bp"] = round(sum(contrib.values()))
    return out


def control(opn, last, vol, excluded, retired, thr, impact_mult, net_ref):
    pools = {}
    for t in m.mondays():
        legs = expanded_legs(t, opn, last, vol, excluded, retired, thr, impact_mult)
        if len(legs) >= MIN_N:
            pools[t] = legs
    ns = []
    for seed in range(CONTROLS):
        rng = random.Random("{}:mr1x:{}".format(f.SEED, seed))
        net = []
        for t, legs in pools.items():
            k = min(K_CAP, len(legs) // 4)
            sel = rng.sample(legs, 2 * k)
            lo, sh = sel[:k], sel[k:]
            g = f.mean([d["lr"] for d in lo]) - f.mean([d["lr"] for d in sh])
            c = f.mean([d["cost"] for d in lo]) + f.mean([d["cost"] for d in sh])
            net.append(g - c)
        ns.append(f.mean(net))
    frac = sum(1 for x in ns if x >= net_ref) / CONTROLS
    return {"neto_medio_bp": round(f.mean(ns), 2), "p95_neto_bp": round(sorted(ns)[int(0.95 * CONTROLS) - 1], 2),
            "p_una_cola": round(max(frac, 1.0 / (CONTROLS + 1)), 4), "p_corregido_bonferroni_8": round(min(1.0, TRIALS * max(frac, 1.0 / (CONTROLS + 1))), 4)}


def block(weeks, ics, contrib, ret_pnl=None):
    s = m.summarize(weeks, ics, contrib)
    s.pop("aporte_por_producto_bp", None)
    s.pop("peso_max_producto", None)
    s["concentracion"] = concentration(contrib, ret_pnl)
    return s


def main(candles, cache_fo1, instruments, out_path):
    opn, last, vol = load_all(candles)
    ins = {i["symbol"]: i for i in json.load(open(instruments))["instruments"]}
    active = set(ins)
    retired = {s for s in opn if s not in active}
    excluded = {s for s, i in ins.items() if i.get("tradfi") or i.get("category") == "xStocks"}
    opn_orig = {p: f.load(cache_fo1, p)[2] for p in ORIG}

    wk, ic, co, rp = run(opn, last, vol, excluded, retired, THRESHOLD, 1.0)
    exp_weeks = {w["t"] for w in wk}
    a_all = original(opn_orig)
    a_common = original(opn_orig, exp_weeks)
    common = {x["t"] for x in a_common[0]}
    b_common = run(opn, last, vol, excluded, retired, THRESHOLD, 1.0, only_weeks=common)
    net_ref = statistics.fmean(w["net"] for w in wk)
    result = {
        "spec": "MR-1X v1 (prueba 8)",
        "universo": {"simbolos_con_velas": len(opn), "no_listados_hoy": len(retired), "excluidos_tradfi_xstocks": len(excluded & set(opn)),
                     "semanas_ampliado": len(wk), "semanas_8_originales": len(a_all[0]), "semanas_comunes": len(a_common[0])},
        "ampliado_todas_sus_semanas": block(wk, ic, co, rp),
        "originales_todas_sus_semanas": block(*a_all),
        "originales_en_semanas_del_ampliado": block(*a_common),
        "ampliado_en_semanas_comunes": block(*b_common),
        "control_azar": control(opn, last, vol, excluded, retired, THRESHOLD, 1.0, net_ref),
        "numero_de_productos_por_semana": {"min": min(w["n"] for w in wk), "mediana": statistics.median(w["n"] for w in wk), "max": max(w["n"] for w in wk)},
    }
    top3 = {p for p, _ in sorted(co.items(), key=lambda kv: -abs(kv[1]))[:3]}
    for name, args in (("sens_volumen_5M", dict(thr=TIER_HIGH, impact_mult=1.0, excl=excluded)),
                       ("sens_costes_impacto_x2", dict(thr=THRESHOLD, impact_mult=2.0, excl=excluded)),
                       ("sens_sin_top3_aportantes", dict(thr=THRESHOLD, impact_mult=1.0, excl=excluded | top3)),
                       ("sens_solo_vivos_hoy", dict(thr=THRESHOLD, impact_mult=1.0, excl=excluded | retired))):
        w2, i2, c2, r2 = run(opn, last, vol, args["excl"], retired, args["thr"], args["impact_mult"])
        result[name] = block(w2, i2, c2, r2) if w2 else {"semanas": 0}
    result["top3_excluidos_en_sens"] = sorted(top3)
    result["espejo_ampliado_neto_medio_bp"] = round(statistics.fmean(-w["gross"] - w["cost"] for w in wk), 2)
    json.dump(result, open(out_path, "w"), indent=1, sort_keys=True, default=str)
    print(json.dumps({k: result[k].get("neto_medio_bp") for k in result if isinstance(result[k], dict) and "neto_medio_bp" in result[k]}))


if __name__ == "__main__":
    main(*sys.argv[1:5])
