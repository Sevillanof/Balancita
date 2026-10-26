"""Pesos aprendidos sobre los votos de Qwen por renglón (F1, F2, F3, F4, F6, F7).

Hoy la inclinación de Qwen es la suma pareja de lo que lee en cada renglón (``lectura_i``, entre -2 y +2). Acá se aprende cuánto
vale cada voto: una regresión ridge de la lectura de los seis renglones contra el movimiento del precio a un plazo. Un peso
negativo es información: dice que ese renglón, leído como lo lee Qwen, anticipa el movimiento al revés.

Sin fuga:

* walk-forward por bloques de tiempo: cada bloque se predice con un modelo entrenado SOLO con bloques anteriores;
* embargo: de lo que se entrena se sacan las fotos cuyo plazo llega hasta el inicio del bloque que se predice;
* el ridge usa un lambda fijo (``LAMBDA_PER_ROW`` x filas): ningún parámetro se elige mirando el resultado;
* el holdout (desde 2026-04-19) no está en las fotos: el examen no lo lee.

Salida: Spearman y neto de los extremos fuera de muestra, contra la suma pareja y contra la regla sin Qwen, sobre las mismas fotos;
y los pesos finales (entrenados con todo) en ``config/qwen-weights.json``. Usarlos en vivo es una decisión aparte.
Uso: ``python -m balancita_engine.futures_qwen_weights --exam-db RUTA --horizon 240 [--out informe.md] [--weights-out pesos.json]``.
"""

import argparse
import json
import math
import os

from . import futures_qwen_factors as fq
from . import futures_qwen_trader_exam as ex
from .futures_qwen_ficha import VOTING, VOTING_INDEX

MINUTE_MS = 60_000
BLOCKS = 5
MIN_TRAIN = 60
LAMBDA_PER_ROW = 0.5          # ridge sobre variables estandarizadas: lambda = LAMBDA_PER_ROW x filas de entrenamiento
CLIP = 3.0                    # el objetivo se recorta a ±3 desvíos de lo que se entrena (los saltos raros no mandan)
SCHEMA = "balancita-qwen-weights.v1"


def rows_for(rows, horizon):
    """Fotos con lectura de los 6 votantes y movimiento al plazo, ordenadas por tiempo: ``[(t_ms, x[6], move_bp, row)]``."""
    out = []
    for r in rows:
        f = r.get("factors")
        if not f or f.get("lectura") is None or str(horizon) not in r["moves"]:
            continue
        out.append((r["t_ms"], [f["lectura"][i] for i in VOTING_INDEX], r["moves"][str(horizon)], r))
    out.sort(key=lambda x: x[0])
    return out


def _solve(a, b):
    """Gauss con pivoteo para un sistema chico."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        m[col], m[piv] = m[piv], m[col]
        if abs(m[col][col]) < 1e-12:
            continue
        for r in range(col + 1, n):
            k = m[r][col] / m[col][col]
            for c in range(col, n + 1):
                m[r][c] -= k * m[col][c]
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        x[i] = 0.0 if abs(m[i][i]) < 1e-12 else (m[i][n] - sum(m[i][j] * x[j] for j in range(i + 1, n))) / m[i][i]
    return x


def fit(xs, ys, lam_per_row=LAMBDA_PER_ROW):
    """Ridge con variables estandarizadas y objetivo recortado. Devuelve los pesos en la escala original de ``lectura``
    (``score = sum(w_i x_i)``, sin término constante: la dirección no tiene sesgo propio) o ``None`` si no hay filas."""
    n = len(xs)
    if n < MIN_TRAIN:
        return None
    d = len(xs[0])
    mu_y = math.fsum(ys) / n
    sd_y = math.sqrt(math.fsum((y - mu_y) ** 2 for y in ys) / n) or 1.0
    yc = [max(-CLIP, min(CLIP, (y - mu_y) / sd_y)) for y in ys]
    sd = [math.sqrt(math.fsum(x[j] ** 2 for x in xs) / n) or 1.0 for j in range(d)]    # sin restar la media: 0 es «no opina»
    z = [[x[j] / sd[j] for j in range(d)] for x in xs]
    a = [[math.fsum(row[i] * row[j] for row in z) + (lam_per_row * n if i == j else 0.0) for j in range(d)] for i in range(d)]
    b = [math.fsum(row[i] * y for row, y in zip(z, yc)) for i in range(d)]
    beta = _solve(a, b)
    return [beta[j] / sd[j] for j in range(d)]


def score(weights, x):
    return math.fsum(w * v for w, v in zip(weights, x))


def weighted_lean(lectura, weights):
    """Inclinación entre -1 y +1 de las 8 lecturas de una foto con los pesos aprendidos (para usar cuando Fran lo decida)."""
    total = math.fsum(abs(w) for w in weights) or 1.0
    return max(-1.0, min(1.0, math.fsum(w * lectura[i] for w, i in zip(weights, VOTING_INDEX)) / (2.0 * total)))


def walk_forward(items, horizon, blocks=BLOCKS):
    """Predice cada bloque (menos el primero) con un modelo entrenado en los anteriores. ``[(item, pred)]``."""
    n = len(items)
    edges = [n * k // blocks for k in range(blocks + 1)]
    out = []
    for b in range(1, blocks):
        start_t = items[edges[b]][0]
        train = [it for it in items[:edges[b]] if it[0] + horizon * MINUTE_MS <= start_t]
        w = fit([it[1] for it in train], [it[2] for it in train])
        if w is None:
            continue
        out += [(it, score(w, it[1])) for it in items[edges[b]:edges[b + 1]]]
    return out


def _extremes(pairs, key, horizon, quantile=0.2):
    """Neto medio (bp, costo descontado) de operar el 20 % de más inclinación a cada lado según ``key``."""
    ranked = sorted(pairs, key=lambda p: key(p))
    k = max(1, int(len(ranked) * quantile))
    shorts, longs = ranked[:k], ranked[-k:]
    nets = [ex.net(p[0][3], -1, horizon) for p in shorts] + [ex.net(p[0][3], 1, horizon) for p in longs]
    return ex.mean(nets), len(nets)


def evaluate(rows, horizon):
    items = rows_for(rows, horizon)
    pairs = walk_forward(items, horizon)
    if len(pairs) < 30:
        return {"horizon_min": horizon, "n": len(pairs), "verdict": "INCONCLUSO"}
    moves = [p[0][2] for p in pairs]
    equal = [(it, math.fsum(it[1]) / (2.0 * len(VOTING))) for it, _ in pairs]
    from .futures_qwen_factors import rule_scores
    rule = dict((id(r), s) for r, s in rule_scores([it[3] for it, _ in pairs]))
    res = {"horizon_min": horizon, "n": len(pairs),
           "learned": {"spearman": ex.spearman([p for _, p in pairs], moves), "ext_net_bp": _extremes(pairs, lambda p: p[1], horizon)[0]},
           "equal": {"spearman": ex.spearman([p for _, p in equal], moves), "ext_net_bp": _extremes(equal, lambda p: p[1], horizon)[0]},
           "rule": {"spearman": ex.spearman([rule[id(it[3])] for it, _ in pairs], moves),
                    "ext_net_bp": _extremes([(it, rule[id(it[3])]) for it, _ in pairs], lambda p: p[1], horizon)[0]}}
    final = fit([it[1] for it in items], [it[2] for it in items])
    res["weights"] = None if final is None else dict(zip(VOTING, final))
    res["verdict"] = "INCONCLUSO" if len(pairs) < 500 else "MEDIDO"
    return res


def report_lines(res):
    from .futures_qwen_trader_exam import _bp, _h, _rho
    lines = ["## Pesos aprendidos (walk-forward) a {}".format(_h(res["horizon_min"])), ""]
    if res["verdict"] == "INCONCLUSO" and "learned" not in res:
        return lines + ["Fotos fuera de muestra: {}. No alcanzan para medir.".format(res["n"]), ""]
    lines += ["Fotos fuera de muestra: {} ({}).".format(res["n"], "pocas: orientativo" if res["verdict"] == "INCONCLUSO" else "alcanzan"),
              "", "| Regla | Spearman | Neto de los extremos |", "|---|---|---|"]
    for name, key in (("Pesos aprendidos", "learned"), ("Suma pareja (Qwen hoy)", "equal"), ("Regla sin Qwen", "rule")):
        lines.append("| {} | {} | {} |".format(name, _rho(res[key]["spearman"]), _bp(res[key]["ext_net_bp"])))
    if res.get("weights"):
        lines += ["", "Pesos finales (entrenados con todo; negativo = ese renglón, leído por Qwen, anticipa al revés): " +
                  ", ".join("{} {:+.4f}".format(k, v) for k, v in res["weights"].items()) + "."]
    return lines + [""]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--exam-db", required=True)
    ap.add_argument("--horizon", type=int, default=240)
    ap.add_argument("--out")
    ap.add_argument("--weights-out")
    args = ap.parse_args(argv)
    rows, _ = ex.load_answers(args.exam_db)
    res = evaluate(rows, args.horizon)
    text = "\n".join(report_lines(res))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
    print(text)
    if args.weights_out and res.get("weights"):
        with open(args.weights_out, "w", encoding="utf-8") as handle:
            json.dump({"schema": SCHEMA, "horizon_min": args.horizon, "photos": res["n"], "weights": res["weights"],
                       "verdict": res["verdict"]}, handle, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
