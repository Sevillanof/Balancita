"""Lectura 2: ¿la información entre activos (correlación) predice el siguiente movimiento, neta de costes?
Sin Qwen. Velas de 15 min de los 8 perpetuos (fetch15.py), 2 años. Uso: python3 study.py DIR_CON_*_15m.json
Todas las variables se calculan con datos hasta el cierre de la barra t; el objetivo son las barras t+1..t+h.
"""
import json, sys, math, glob, os
import numpy as np, pandas as pd

D = sys.argv[1]; COST = 10.0  # pb ida y vuelta (PF_XBTUSD 10,1)
P = ["XBT", "ETH", "SOL", "ZEC", "XRP", "NEAR", "HYPE", "ADA"]
cl = {}
for p in P:
    c = json.load(open(f"{D}/PF_{p}USD_15m.json"))
    cl[p] = pd.Series({int(k["time"]): float(k["close"]) for k in c})
px = pd.DataFrame(cl).sort_index()
r = np.log(px).diff()
r = r.where(r.abs() < 0.5)
sig = r.rolling(96, min_periods=48).std()
m_oth = {p: r.drop(columns=p).mean(axis=1, skipna=True) for p in P}
frames = []
for p in P:
    ra, m = r[p], m_oth[p]
    beta = ra.rolling(672, min_periods=300).cov(m) / m.rolling(672, min_periods=300).var()
    corr = ra.rolling(96, min_periods=60).corr(m)
    res = ra - beta * m
    s = sig[p]
    f = pd.DataFrame({
        "z1": ra / s, "z4": ra.rolling(4).sum() / (s * 2), "z16": ra.rolling(16).sum() / (s * 4),
        "m1": m / s, "m4": m.rolling(4).sum() / (s * 2),
        "res1": res / s, "res4": res.rolling(4).sum() / (s * 2),
        "corr24": corr,
    })
    f["rel4"] = f["z4"] - f["m4"]
    f["z1xcorr"] = f["z1"] * f["corr24"]
    f["z4xcorr"] = f["z4"] * f["corr24"]
    f["fwd1"] = ra.shift(-1) * 1e4
    f["fwd4"] = ra[::-1].rolling(4).sum()[::-1].shift(-1) * 1e4
    f["sig_bp"] = s * 1e4
    f["asset"] = p
    frames.append(f)
mc = pd.concat([r[p].rolling(96, min_periods=60).corr(m_oth[p]) for p in P], axis=1).mean(axis=1)
D_ = pd.concat(frames)
D_["mktcorr"] = mc.reindex(D_.index).values
D_["hicorr"] = (D_["mktcorr"] > D_["mktcorr"].quantile(0.75)).astype(float)  # umbral en toda la muestra solo para describir
D_["z4xhi"] = D_["z4"] * D_["hicorr"]
D_["res4xhi"] = D_["res4"] * D_["hicorr"]
D_["t"] = D_.index // 1000; D_["day"] = D_["t"] // 86400
D_ = D_.reset_index(drop=True)
FEAT_OWN = ["z1", "z4", "z16"]
FEAT_CORR = ["m1", "m4", "res1", "res4", "corr24", "rel4", "z1xcorr", "z4xcorr", "mktcorr", "z4xhi", "res4xhi"]
need = FEAT_OWN + FEAT_CORR + ["fwd1", "fwd4", "sig_bp"]
D_ = D_.dropna(subset=need).copy()
print("filas", len(D_), "días", D_.day.nunique(), file=sys.stderr)

def cl_t(prod, day):
    """t-stat agrupado por día del promedio de prod."""
    g = pd.Series(prod).groupby(np.asarray(day)).mean()
    return g.mean() / (g.std(ddof=1) / math.sqrt(len(g))), len(g)

def normp(t): return math.erfc(abs(t) / math.sqrt(2))

# ---------- A) IC univariante (Spearman pooled), t agrupado por día, Holm ----------
def zr(v): 
    rk = pd.Series(v).rank().values; return (rk - rk.mean()) / rk.std()
out = {"A_ic": [], "B_wf": {}}
tests = []
for h in ("fwd1", "fwd4"):
    y = zr(D_[h].values)
    for f in FEAT_OWN + FEAT_CORR:
        x = zr(D_[f].values)
        t, nd = cl_t(x * y, D_.day.values)
        ic = float((x * y).mean())
        tests.append((f, h, ic, t, normp(t)))
order = sorted(range(len(tests)), key=lambda i: tests[i][4]); K = len(tests); holm = {}
run = 0.0
for rank_i, i in enumerate(order):
    run = max(run, min(1.0, (K - rank_i) * tests[i][4])); holm[i] = run
for i, (f, h, ic, t, p) in enumerate(tests):
    out["A_ic"].append({"feat": f, "h": h, "ic": round(ic, 4), "t": round(t, 2), "holm_p": round(holm[i], 4)})

# ---------- B) walk-forward ridge: propios vs propios+correlación ----------
D_["month"] = (D_["t"] // (30 * 86400)).astype(int)
months = sorted(D_.month.unique()); first = months[0] + 6  # 180 d solo para entrenar
PURGE = 6 * 3600
def ridge(X, y, lam=1000.0):
    X1 = np.c_[np.ones(len(X)), X]; I = np.eye(X1.shape[1]) * lam; I[0, 0] = 0
    return np.linalg.solve(X1.T @ X1 + I, X1.T @ y)
def wf(feats, h):
    parts = []
    for mo in months:
        if mo < first: continue
        tr = D_[(D_.month < mo) & (D_.t < mo * 30 * 86400 - PURGE)]
        te = D_[D_.month == mo]
        if len(tr) < 50000 or len(te) == 0: continue
        mu, sd = tr[feats].mean(), tr[feats].std()
        Xtr = ((tr[feats] - mu) / sd).values; Xte = ((te[feats] - mu) / sd).values
        ytr = np.clip(tr[h].values / tr.sig_bp.values, -5, 5)
        b = ridge(Xtr, ytr)
        ptr = np.c_[np.ones(len(Xtr)), Xtr] @ b; thr = np.quantile(np.abs(ptr), 0.90)
        pte = np.c_[np.ones(len(Xte)), Xte] @ b
        d = te[["t", "day", "asset", h, "sig_bp"]].copy(); d["pred"] = pte; d["thr"] = thr
        parts.append(d)
    return pd.concat(parts)
for h, step in (("fwd1", 1), ("fwd4", 4)):
    A = wf(FEAT_OWN, h); B = wf(FEAT_OWN + FEAT_CORR, h)
    res = {}
    for name, d in (("propios", A), ("propios+corr", B)):
        x = zr(d.pred.values); y = zr(d[h].values)
        t, _ = cl_t(x * y, d.day.values)
        sel = d[(d.pred.abs() >= d.thr) & ((d.t // 900) % step == 0)]
        net = np.sign(sel.pred) * sel[h] - COST
        tn, nd = cl_t(net.values, sel.day.values)
        res[name] = {"ic": round(float((x * y).mean()), 4), "t_ic": round(t, 2),
                     "top10_n": int(len(sel)), "acierto": round(float((np.sign(sel.pred) == np.sign(sel[h])).mean()), 4),
                     "bruto_pb": round(float((np.sign(sel.pred) * sel[h]).mean()), 2),
                     "neto_pb": round(float(net.mean()), 2), "t_neto": round(tn, 2)}
    # diferencia B - A del IC (misma muestra)
    xa, xb, y = zr(A.pred.values), zr(B.pred.values), zr(A[h].values)
    t, _ = cl_t(xb * y - xa * y, A.day.values)
    res["delta_ic"] = {"valor": round(float((xb * y - xa * y).mean()), 4), "t": round(t, 2), "p": round(normp(t), 4)}
    out["B_wf"][h] = res
# ---------- C) ¿la señal cambia con el régimen de correlación? IC de z4 (reversión) en alta vs baja ----------
rc = []
for lab, mask in (("corr_alta", D_.hicorr == 1), ("corr_baja", D_.hicorr == 0)):
    d = D_[mask]; x = zr(d["z4"].values); y = zr(d["fwd4"].values)
    t, _ = cl_t(x * y, d.day.values); rc.append({"reg": lab, "n": len(d), "ic_z4_fwd4": round(float((x * y).mean()), 4), "t": round(t, 2)})
out["C_regimen"] = rc
# ---------- D) correlación media por régimen de mercado (la intuición del video) ----------
ret_m = r.mean(axis=1)
dd = pd.DataFrame({"mkt": ret_m.rolling(96).sum(), "corr": mc}).dropna()
q = dd["mkt"].quantile([.1, .9])
out["D_corr_en_caidas"] = {"corr_media_todo": round(float(dd["corr"].mean()), 3),
    "corr_tras_10pct_peor_dia": round(float(dd[dd.mkt <= q[.1]]["corr"].mean()), 3),
    "corr_tras_10pct_mejor_dia": round(float(dd[dd.mkt >= q[.9]]["corr"].mean()), 3)}
json.dump(out, open("res_correlacion.json", "w"), indent=1)
print(json.dumps(out, indent=1))
