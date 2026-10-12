"""Lectura 1: credibilidad de Qwen = correlación (IC) entre su señal y el retorno posterior.

Solo lectura. Se corre en la Mac sobre un run de replay ya guardado (no llama al modelo):
  PYTHONPATH=python python3 analisis/correlacion-qwen/ic_qwen.py --run RUN.sqlite --market-db MARKET.sqlite
Señal = p(buy) - p(sell); retorno = retorno bruto a HORIZON_MIN desde bucket_start (pb).
Da Pearson y Spearman con IC 95 % por bootstrap de bloques de 1 día (las decisiones vecinas se parecen).
"""
import argparse, json, math, random, sqlite3
from collections import defaultdict

def rank(v):
    o = sorted(range(len(v)), key=lambda i: v[i]); r = [0.0] * len(v); i = 0
    while i < len(o):
        j = i
        while j + 1 < len(o) and v[o[j + 1]] == v[o[i]]: j += 1
        for k in range(i, j + 1): r[o[k]] = (i + j) / 2
        i = j + 1
    return r

def pearson(x, y):
    n = len(x); mx, my = sum(x) / n, sum(y) / n
    sxx = sum((a - mx) ** 2 for a in x); syy = sum((b - my) ** 2 for b in y)
    return 0.0 if sxx == 0 or syy == 0 else sum((a - mx) * (b - my) for a, b in zip(x, y)) / math.sqrt(sxx * syy)

def block_ci(rows, fn, n_boot=2000, seed=1):
    days = defaultdict(list)
    for t, x, y in rows: days[t // 86_400_000].append((x, y))
    keys = list(days); rnd = random.Random(seed); out = []
    for _ in range(n_boot):
        s = [p for k in (rnd.choice(keys) for _ in keys) for p in days[k]]
        if len(s) > 10: out.append(fn([p[0] for p in s], [p[1] for p in s]))
    out.sort()
    return out[int(.025 * len(out))], out[int(.975 * len(out))]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--market-db", required=True)
    ap.add_argument("--horizon-min", type=int, default=15)
    a = ap.parse_args()
    from balancita_engine.futures_replay import load_range
    from balancita_engine.futures_replay_compare import read_run
    meta, _ = read_run(a.run)
    db = sqlite3.connect("file:%s?mode=ro" % a.run, uri=True)
    dec = [json.loads(p) for (p,) in db.execute("SELECT payload FROM replay_qwen_decision ORDER BY id")]
    ones, _ = load_range(a.market_db, meta["product_id"], meta["start_ms"], meta["end_ms"] + a.horizon_min * 60_000)
    cl = {c["bucket_start"]: float(c["close"]) for c in ones}
    rows = []
    for d in dec:
        e, l = cl.get(d["bucket_start"]), cl.get(d["bucket_start"] + a.horizon_min * 60_000)
        p = d.get("probabilities") or {}
        if e and l and "buy" in p and "sell" in p:
            rows.append((d["bucket_start"], p["buy"] - p["sell"], (l - e) / e * 1e4))
    if len(rows) < 30: raise SystemExit("muestra insuficiente: %d" % len(rows))
    x = [r[1] for r in rows]; y = [r[2] for r in rows]
    sp = lambda u, v: pearson(rank(u), rank(v))
    res = {"n": len(rows), "horizon_min": a.horizon_min}
    for name, fn in (("pearson", pearson), ("spearman", sp)):
        lo, hi = block_ci(rows, fn)
        res[name] = {"ic": round(fn(x, y), 4), "ic95": [round(lo, 4), round(hi, 4)]}
    print(json.dumps(res, indent=1))

if __name__ == "__main__": main()
