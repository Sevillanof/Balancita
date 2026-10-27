"""El PORTERO de Qwen en vivo (versión 8): una fórmula fija, en CPU, que dice si conviene tomar AHORA la señal del maestro.

El maestro (``futures_qwen_maestro``) da la dirección y su claridad. El portero mira la misma ficha de hechos orientada hacia el lado
del maestro (lo que tiene dirección se multiplica por el lado: «la tendencia va con la operación» vale lo mismo para un largo con
subida que para un corto con caída), los tamaños sin dirección (volumen, volatilidad, rangos) y la claridad del maestro
(|puntaje|), y estima la probabilidad de que la operación en el lado del maestro GANE TRAS COSTOS con la salida de la versión 8
(se sale cuando el maestro se da vuelta al menos flojo, o a las 48 h; sin stop). Es una regresión logística con intercepto sobre
esos números estandarizados (meta-etiquetado, López de Prado): auditable en un JSON de 20 coeficientes, y EXACTAMENTE igual en el
espejo (orientar por el lado deja los números iguales cuando se dan vuelta el mercado y el lado).

Dice «conviene entrar» cuando la probabilidad llega al umbral del archivo (el cuantil 80 % de las fotos fuertes del ajuste: se
toma una de cada cinco señales fuertes). Medido hacia adelante en analisis/qwen-v8/ (ver docs). El archivo
(``config/qwen-portero.json``) es parte de la identidad de la config en vivo: ``corta.portero_hash`` tiene que coincidir.

    python -m balancita_engine.futures_qwen_portero fit --facts hechos.jsonl --cache-dir CACHE [--maestro ARCHIVO] --out config/qwen-portero.json
    python -m balancita_engine.futures_qwen_portero medir --facts hechos.jsonl --cache-dir CACHE [--portero ARCHIVO]
"""

import argparse
import hashlib
import json
import math
import os
import sys

from . import futures_qwen_maestro as maestro
from . import futures_qwen_trader as qt

SCHEMA = "balancita-qwen-portero.v1"
DEFAULT_PATH = os.path.join(qt.ROOT, "config", "qwen-portero.json")
ORIENTED = maestro.DIRECTIONAL                   # cada uno multiplicado por el lado del maestro (+1 largo, -1 corto)
SYMMETRIC = maestro.SYMMETRIC
FEATURES = tuple("lado_x_" + f for f in ORIENTED) + tuple(SYMMETRIC) + ("claridad",)
L2 = 10.0
YES_SHARE = 0.20                                 # «conviene» = el 20 % de señales fuertes con más probabilidad, en el ajuste
MAX_HOLD_MIN = 2880                              # la salida de la versión 8: 48 h como máximo
STEP_MIN = 15                                    # las fotos van cada 15 min


def features(row, side, s):
    """Los números del portero para una foto: los direccionales orientados por ``side`` (+1 / -1), los tamaños y |puntaje|."""
    out = {"lado_x_" + f: side * float(row.get(f) or 0.0) for f in ORIENTED}
    for f in SYMMETRIC:
        out[f] = float(row.get(f) or 0.0)
    out["claridad"] = abs(float(s))
    return out


def load(path=DEFAULT_PATH):
    with open(path, encoding="utf-8") as handle:
        portero = json.load(handle)
    if portero.get("schema") != SCHEMA:
        raise qt.TraderError("{}: no es un portero ({!r})".format(path, portero.get("schema")))
    for key in ("media", "sd", "coeficientes", "intercepto", "umbral"):
        if key not in portero:
            raise qt.TraderError("{}: al portero le falta {!r}".format(path, key))
    portero["_path"] = path
    return portero


def portero_hash(portero):
    """Identidad del archivo: lo que decide (números y umbral), sin las notas."""
    body = {k: portero[k] for k in ("schema", "media", "sd", "coeficientes", "intercepto", "umbral")}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode("utf-8")).hexdigest()


def logit(portero, row, side, s):
    x = features(row, side, s)
    coef, mean, sd = portero["coeficientes"], portero["media"], portero["sd"]
    return portero["intercepto"] + math.fsum(coef[f] * (x[f] - mean[f]) / sd[f] for f in FEATURES if sd[f] > 0)


def probability(portero, row, side, s):
    """Probabilidad de que la operación en el lado ``side`` gane tras costos con la salida de la versión 8."""
    z = logit(portero, row, side, s)
    return 1.0 / (1.0 + math.exp(-z)) if z > -700 else 0.0


def says_yes(portero, p):
    return p >= portero["umbral"]


def verdict(portero, row, s):
    """``(conviene, probabilidad)`` para la foto ``row`` con el puntaje ``s`` del maestro (el lado es el signo de ``s``). Con
    puntaje 0 no hay lado: se evalúa el largo (los números orientados dan lo mismo que para el corto solo si son 0)."""
    side = -1 if s < 0 else 1
    p = probability(portero, row, side, s)
    return says_yes(portero, p), p


# --------------------------------------------------------------------------- the label: did the maestro's trade win?


def closes_by_time(history, product, from_ms, to_ms):
    """Cierre de cada vela de 5 min por su hora de cierre, del caché (solo lectura). Nunca pasa el holdout: una foto cuya
    salida caería después de él se queda sin etiqueta."""
    to_ms = min(to_ms, history.holdout_ms)
    return {int(b["bucket_start"]) + qt.BAR_MS: float(b["close"]) for b in history.bars(product, from_ms, to_ms)}


def trade_results(rows, teacher, closes, cost_bp):
    """Para cada foto (de UN producto, ordenadas por tiempo, cada 15 min): el neto en pb de entrar en el lado del maestro y
    salir en la primera foto posterior donde el maestro dice al menos flojo del lado opuesto, o a las 48 h (al cierre de esa
    vela). ``None`` cuando faltan velas. Es la regla de salida de la versión 8, mirada hacia atrás."""
    scores = [maestro.score(teacher, r) for r in rows]
    weak = teacher["umbrales"]["flojo"]
    max_steps = MAX_HOLD_MIN // STEP_MIN
    out = []
    for i, r in enumerate(rows):
        side = -1 if scores[i] < 0 else 1
        c0 = closes.get(r["t_ms"])
        exit_ms = r["t_ms"] + MAX_HOLD_MIN * qt.MINUTE_MS
        for k in range(1, max_steps + 1):
            j = i + k
            if j >= len(rows) or rows[j]["t_ms"] != r["t_ms"] + k * STEP_MIN * qt.MINUTE_MS:
                break                                              # hueco en las fotos: hasta aquí se puede juzgar
            if side * scores[j] <= -weak:
                exit_ms = rows[j]["t_ms"]
                break
        c1 = closes.get(exit_ms)
        out.append(None if c0 is None or c1 is None else side * (c1 / c0 - 1) * 1e4 - cost_bp)
    return out


def labelled(rows, teacher, history):
    """``(fila, puntaje, neto)`` de cada foto con velas suficientes, por producto y en orden de tiempo."""
    out = []
    for product in sorted({r["product"] for r in rows}):
        mine = sorted((r for r in rows if r["product"] == product), key=lambda r: r["t_ms"])
        closes = closes_by_time(history, product, mine[0]["t_ms"] - qt.BAR_MS, mine[-1]["t_ms"] + (MAX_HOLD_MIN + 5) * qt.MINUTE_MS)
        nets = trade_results(mine, teacher, closes, float(mine[0]["cost_bp"]))
        out.extend((r, maestro.score(teacher, r), n) for r, n in zip(mine, nets) if n is not None)
    return out


# --------------------------------------------------------------------------- fitting (numpy only here)


def _design(items):
    import numpy as np

    X = np.array([[features(r, -1 if s < 0 else 1, s)[f] for f in FEATURES] for r, s, _ in items])
    return X


def logistic(X, y, l2=L2, iters=100):
    """Logística con intercepto (sin penalizar) y L2 sobre los coeficientes, por Newton. Devuelve ``(w, b)``."""
    import numpy as np

    n, k = X.shape
    Z = np.column_stack([np.ones(n), X])
    w = np.zeros(k + 1)
    pen = np.full(k + 1, l2)
    pen[0] = 0.0
    for _ in range(iters):
        p = 1.0 / (1.0 + np.exp(-(Z @ w)))
        grad = Z.T @ (p - y) + pen * w
        H = (Z * (p * (1 - p))[:, None]).T @ Z + np.diag(pen)
        step = np.linalg.solve(H, grad)
        w -= step
        if np.max(np.abs(step)) < 1e-8:
            break
    return w[1:], w[0]


def fit(items, teacher, *, yes_share=YES_SHARE, l2=L2, note=None):
    """El portero ajustado con ``items`` (de ``labelled``): etiqueta = la operación del maestro ganó tras costos."""
    import numpy as np

    if len(items) < 1000:
        raise qt.TraderError("portero: hacen falta al menos 1.000 fotos juzgadas, hay {}".format(len(items)))
    X = _design(items)
    y = np.array([1.0 if n > 0 else 0.0 for _, _, n in items])
    mean, sd = X.mean(axis=0), X.std(axis=0)
    sd[sd == 0] = 1.0
    w, b = logistic((X - mean) / sd, y, l2=l2)
    p = 1.0 / (1.0 + np.exp(-(((X - mean) / sd) @ w + b)))
    strong = np.array([abs(s) >= teacher["umbrales"]["fuerte"] for _, s, _ in items])
    threshold = float(np.quantile(p[strong], 1 - yes_share)) if strong.any() else float(np.quantile(p, 1 - yes_share))
    t_values = [r["t_ms"] for r, _, _ in items]
    return {"schema": SCHEMA, "tipo": "logistica",
            "etiqueta": "la operación en el lado del maestro gana tras costos saliendo cuando el maestro se da vuelta (flojo) o a las 48 h, sin stop",
            "maestro_hash": maestro.teacher_hash(teacher),
            "ajuste": {"fotos": len(items), "desde": qt.stamp(min(t_values)), "hasta": qt.stamp(max(t_values)),
                       "productos": sorted({r["product"] for r, _, _ in items}), "l2": l2, "ganadoras": round(float(y.mean()), 4),
                       "si_share_fuertes": yes_share},
            "media": {f: round(float(v), 8) for f, v in zip(FEATURES, mean)}, "sd": {f: round(float(v), 8) for f, v in zip(FEATURES, sd)},
            "coeficientes": {f: round(float(v), 6) for f, v in zip(FEATURES, w)}, "intercepto": round(float(b), 6),
            "umbral": round(threshold, 6),
            "nota": note or "Ajustado con `futures_qwen_portero fit`; medición hacia adelante en analisis/qwen-v8/informe.md."}


def measure(portero, items, teacher):
    """Fuera de muestra: neto de las señales fuertes del maestro con y sin el portero, y cuánto dice que sí."""
    strong = [(r, s, n) for r, s, n in items if abs(s) >= teacher["umbrales"]["fuerte"]]
    taken = [(r, s, n) for r, s, n in strong if verdict(portero, r, s)[0]]
    mean = lambda xs: round(math.fsum(n for _, _, n in xs) / len(xs), 2) if xs else None
    hit = lambda xs: round(sum(1 for _, _, n in xs if n > 0) / len(xs), 4) if xs else None
    mirror_ok = all(abs(probability(portero, maestro.mirror_facts(r), -(-1 if s < 0 else 1), -s) - probability(portero, r, -1 if s < 0 else 1, s))
                    < 1e-9 for r, s, _ in items[:2000])
    return {"fotos": len(items), "fuertes": len(strong), "fuertes_neto_pb": mean(strong), "fuertes_acierto": hit(strong),
            "con_portero": len(taken), "con_portero_neto_pb": mean(taken), "con_portero_acierto": hit(taken),
            "share_si_entre_fuertes": round(len(taken) / len(strong), 4) if strong else None, "espejo_identico": mirror_ok}


# --------------------------------------------------------------------------- CLI


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("fit", "medir"):
        p = sub.add_parser(name)
        p.add_argument("--facts", required=True, help="filas de `futures_qwen_lora facts`")
        p.add_argument("--cache-dir", default=qt.DEFAULT_CACHE, help="caché de velas para leer los cierres de salida")
        p.add_argument("--maestro", default=maestro.DEFAULT_PATH)
        p.add_argument("--from", dest="from_day")
        p.add_argument("--to", dest="to_day")
        p.add_argument("--products")
        if name == "fit":
            p.add_argument("--out", default=DEFAULT_PATH)
            p.add_argument("--note")
        else:
            p.add_argument("--portero", default=DEFAULT_PATH)
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    teacher = maestro.load(args.maestro)
    rows = maestro.read_facts(args.facts, args.from_day, args.to_day, args.products.split(",") if args.products else None)
    history = qt.History(args.cache_dir, qt.load_holdout_ms(), offline=True)
    items = labelled(rows, teacher, history)
    if args.command == "fit":
        portero = fit(items, teacher, note=args.note)
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(portero, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print("portero escrito en {} ({} fotos, hash {})".format(args.out, len(items), portero_hash(portero)[:12]))
        print(json.dumps(measure(portero, items, teacher), ensure_ascii=False))
    else:
        print(json.dumps(measure(load(args.portero), items, teacher), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    try:
        main()
    except qt.TraderError as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
