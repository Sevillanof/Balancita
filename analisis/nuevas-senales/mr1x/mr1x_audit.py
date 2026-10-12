"""Auditoria del universo: cobertura, fechas, huecos, liquidez. NO calcula ningun retorno.

Uso: python3 -I mr1x_audit.py <cache_velas> <instruments.json> <salida.json>
"""
import json
import os
import statistics
import sys

HOUR = 3600
DAY = 24 * HOUR


def audit(folder, instruments):
    active = {i["symbol"]: i for i in json.load(open(instruments))["instruments"]}
    rows = {}
    for name in sorted(os.listdir(folder)):
        if not name.startswith("PF_"):
            continue
        sym = name[:-5]
        c = json.load(open(os.path.join(folder, name)))
        if not c:
            rows[sym] = {"velas": 0, "activo": sym in active}
            continue
        ts = sorted(int(t) for t in c)
        gaps = [b - a for a, b in zip(ts, ts[1:]) if b - a > HOUR]
        usd = {}
        for t in ts:
            o, cl, v = c[str(t)]
            usd[t // DAY] = usd.get(t // DAY, 0.0) + float(v) * float(cl)
        days = sorted(usd)
        med = statistics.median([usd[d] for d in days[-28:]]) if len(days) >= 28 else None
        rows[sym] = {"velas": len(ts), "primera": ts[0], "ultima": ts[-1], "activo": sym in active,
                     "categoria": active.get(sym, {}).get("category"), "tradfi": active.get(sym, {}).get("tradfi"),
                     "huecos_gt1h": len(gaps), "hueco_max_h": round(max(gaps) / HOUR, 1) if gaps else 0,
                     "volumen_usd_diario_mediana_total": round(statistics.median(usd.values()), 0),
                     "volumen_usd_diario_ult28d_en_muestra": round(med, 0) if med else None}
    return rows


if __name__ == "__main__":
    out = audit(sys.argv[1], sys.argv[2])
    json.dump(out, open(sys.argv[3], "w"), indent=1, sort_keys=True)
    print(len(out), "simbolos")
