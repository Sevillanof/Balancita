"""Memoria de casos para Qwen (variante ``memoria`` de la Prueba rápida y del Examen): en cada pregunta se le muestran situaciones
parecidas del pasado con su resultado.

Cada foto del examen ya trae los números de la ficha (``futures_qwen_ficha.numbers``) y el movimiento del precio a cada plazo.
Con eso se arma una biblioteca de casos y, para cada foto elegida, se buscan los ``k`` más parecidos (distancia entre los números de
F1 a F7, cada uno llevado a una escala fija: nada se estandariza con datos del futuro).

Sin fuga, por construcción:

* un caso entra solo si su resultado ya se conocía en el momento de la foto: ``t_caso + plazo <= t_foto`` (estrictamente anterior
  y con el plazo cumplido);
* los casos elegidos van separados por al menos un plazo entre sí (dos fotos consecutivas del mismo episodio cuentan una vez);
* la biblioteca tiene un caso por producto y hora, no todos los despertares.

El espejo usa los MISMOS casos con el resultado dado vuelta: el espejo es un mercado donde todo lo que subió bajó, y buscar el
espejo de la foto en la biblioteca dada vuelta da el mismo conjunto de vecinos con el signo cambiado. Los renglones sin dirección
(F5) no se dan vuelta. Sin casos suficientes el texto lo dice y la foto sigue.
"""

import math

from . import futures_qwen_ficha as fficha

MINUTE_MS = 60_000
HOUR_MS = 3_600_000
# escala fija de cada renglón (valor típico que se lleva a 1) y centro: (centro, escala, tiene dirección)
SCALES = {"F1": (0.0, 2.0, True), "F2": (0.0, 2.0, True), "F3": (0.0, 1.0, True), "F4": (0.0, 1.5, True),
          "F5": (1.0, 1.0, False), "F6": (0.0, 10.0, True), "F7": (0.0, 2.0, True)}
DEFAULTS = {"k": 8, "horizon_min": 240, "min_cases": 5, "library_step_h": 1}


def settings(cfg):
    return dict(DEFAULTS, **(cfg.get("memory") or {}))


def vector(numbers):
    """``{renglón: valor en escala fija, recortado a [-3, 3]}`` de los números de una foto (``None`` si no hay dato)."""
    out = {}
    for factor, (center, scale, _) in SCALES.items():
        value = (numbers or {}).get(factor)
        out[factor] = None if value is None else max(-3.0, min(3.0, (value - center) / scale))
    return out


def distance(a, b):
    """Distancia euclídea media sobre los renglones con dato en los dos; ``None`` si no comparten ninguno."""
    total, n = 0.0, 0
    for factor in SCALES:
        if a[factor] is not None and b[factor] is not None:
            total += (a[factor] - b[factor]) ** 2
            n += 1
    return math.sqrt(total / n) if n else None


def library(photos, cfg):
    """Casos ``{t_ms, product, vec, move}`` (uno por producto y por ``library_step_h`` horas) con el resultado al plazo de la memoria."""
    s = settings(cfg)
    key, step = str(s["horizon_min"]), s["library_step_h"] * HOUR_MS
    seen, cases = set(), []
    for p in sorted(photos, key=lambda p: p["t_ms"]):
        move, numbers = p["moves"].get(key), p.get("ficha")
        slot = (p["product"], p["t_ms"] // step)
        if move is None or numbers is None or slot in seen:
            continue
        seen.add(slot)
        cases.append({"t_ms": p["t_ms"], "product": p["product"], "vec": vector(numbers), "move": move})
    return cases


def neighbors(cases, vec, t_ms, cfg):
    """Los ``k`` casos más parecidos cuyo resultado ya se conocía en ``t_ms`` y que están separados por al menos un plazo."""
    s = settings(cfg)
    horizon = s["horizon_min"] * MINUTE_MS
    scored = []
    for case in cases:
        if case["t_ms"] + horizon > t_ms:
            continue
        d = distance(vec, case["vec"])
        if d is not None:
            scored.append((d, case["t_ms"], case))
    scored.sort(key=lambda x: x[:2])
    chosen = []
    for d, _, case in scored:
        if all(abs(case["t_ms"] - c["t_ms"]) >= horizon for _, c in chosen):
            chosen.append((d, case))
            if len(chosen) == s["k"]:
                break
    return chosen


def _median(values):
    ordered = sorted(values)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def lines(chosen, cfg, sg=1.0):
    """El bloque de texto de la memoria. ``sg`` = -1 en el espejo: mismos casos, resultado dado vuelta."""
    from .futures_qwen_trader import es
    s = settings(cfg)
    hours = s["horizon_min"] / 60
    head = "Memoria de casos: situaciones parecidas del pasado, con su resultado ya conocido, a {} h".format(
        es(hours, 0) if hours == int(hours) else es(hours, 1))
    if len(chosen) < s["min_cases"]:
        return [head + ": todavía no hay casos parecidos suficientes."]
    moves = [sg * case["move"] for _, case in chosen]
    up, down = sum(1 for m in moves if m > 0), sum(1 for m in moves if m < 0)
    return [head + " ({} casos): el precio subió en {} y bajó en {}; movimiento mediano {} % y promedio {} %.".format(
        len(moves), up, down, es(_median(moves) / 100.0, 2, True), es(math.fsum(moves) / len(moves) / 100.0, 2, True))]


def attach(chosen_photos, all_photos, cfg):
    """Agrega la memoria al final del estado real y del espejo de cada foto elegida. Devuelve cuántas tuvieron casos suficientes."""
    s = settings(cfg)
    cases = library(all_photos, cfg)
    enough = 0
    for p in chosen_photos:
        found = neighbors(cases, vector(p.get("ficha")), p["t_ms"], cfg)
        enough += len(found) >= s["min_cases"]
        p["state_text"] += "\n" + "\n".join(lines(found, cfg, 1.0))
        p["mirror_text"] += "\n" + "\n".join(lines(found, cfg, -1.0))
        p["memory_n"] = len(found)
    return enough
