"""Report of the Qwen practice (Spanish markdown, no model): does Qwen filter signals better than chance and than a
simple statistical filter on the same features?

Pure Python, stdlib only. The math lives here (metrics, intervals, random-filter percentile, a small logistic
regression, calibration, position bias) so it can be tested on toy sets; ``build_report`` assembles the document from
the signals file (``futures_qwen_practice.build_signals``) and the practice file (``run_practice``).

Rules that keep the comparison honest:

* The label is the net bp of the trade under the strategy's own exit rules; a win is a positive net.
* Qwen's score of a signal is the mean ``p_approve`` of its two option orders. The approval threshold is chosen ONLY
  on the calibration fold (older 60 %) and judged on the validation fold (newer 40 %).
* The random filter keeps the same NUMBER of signals as Qwen's (same rejection rate), 1000 draws; Qwen's result is
  placed in that distribution.
* The logistic regression sees exactly the numbers written in the STATE, is trained on the calibration fold of every
  signal of the strategy (not only the practiced ones) and keeps the same number of signals as Qwen on validation.
* C28 repeats C25/C26 signals bar for bar, so it is shown apart and left out of the totals.
"""

import collections
import json
import math
import random
import re
import sqlite3

from .futures_qwen_practice import (
    DUPLICATE_STRATEGIES, LIGHT_COLUMNS, QWEN3_RELEASE_DATE, read_meta, read_signals, read_state_texts)

DRAWS = 1000
BOOTSTRAP_DRAWS = 500
MIN_VALIDATION_N = 100   # practiced validation signals needed to say anything
MIN_GROUP_N = 30         # kept and rejected signals needed to compare them
LR_TRAIN_MAX = 4000      # calibration signals the logistic regression trains on per strategy (seeded random subsample)
MIN_AGREEMENT = 0.80
MAX_MEAN_SHIFT = 0.10
SIGNIFICANT_PERCENTILE = 95.0
FIXED_THRESHOLDS = (0.5, 0.6, 0.7, 0.8, 0.9)
REJECT_RATES = (0.1, 0.25, 0.4, 0.55)


# --------------------------------------------------------------------------- math


def metrics(values):
    """``n``, hit rate (net > 0), mean net bp and profit factor (gross wins / gross losses, ``None`` without losses)."""
    n = len(values)
    if n == 0:
        return {"n": 0, "wins": 0, "hit_rate": None, "mean_bp": None, "profit_factor": None}
    wins = sum(1 for v in values if v > 0)
    gains = sum(v for v in values if v > 0)
    losses = -sum(v for v in values if v < 0)
    return {"n": n, "wins": wins, "hit_rate": wins / n, "mean_bp": sum(values) / n,
            "profit_factor": gains / losses if losses > 0 else None}


def wilson(wins, n, z=1.96):
    """Wilson interval of a proportion."""
    if n == 0:
        return None, None
    p = wins / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return centre - half, centre + half


def _quantile(sorted_values, q):
    if not sorted_values:
        return None
    position = q * (len(sorted_values) - 1)
    low, high = int(math.floor(position)), int(math.ceil(position))
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (position - low)


def bootstrap_ci(values, *, seed, draws=BOOTSTRAP_DRAWS, level=0.95):
    """Percentile bootstrap interval of the mean; deterministic for a seed."""
    n = len(values)
    if n < 2:
        return None, None
    rng = random.Random(seed)
    means = sorted(sum(rng.choices(values, k=n)) / n for _ in range(draws))
    tail = (1 - level) / 2
    return _quantile(means, tail), _quantile(means, 1 - tail)


def random_filter(values, kept_count, observed_mean, *, draws=DRAWS, seed):
    """Mean net of ``draws`` random filters that keep ``kept_count`` of ``values`` (same rejection rate), and the
    percentile of ``observed_mean`` in that distribution (100: better than every draw)."""
    n = len(values)
    if n == 0 or kept_count <= 0:
        return {"draws": 0, "percentile": None, "p05": None, "p50": None, "p95": None, "mean": None}
    rng = random.Random(seed)
    means = sorted(sum(values[i] for i in rng.sample(range(n), kept_count)) / kept_count for _ in range(draws))
    below = sum(1 for m in means if m < observed_mean - 1e-12)
    equal = sum(1 for m in means if abs(m - observed_mean) <= 1e-12)
    return {"draws": draws, "percentile": 100.0 * (below + 0.5 * equal) / draws, "p05": _quantile(means, 0.05),
            "p50": _quantile(means, 0.5), "p95": _quantile(means, 0.95), "mean": sum(means) / draws}


def _sigmoid(x):
    return 1.0 / (1.0 + math.exp(-x)) if x >= 0 else math.exp(x) / (1.0 + math.exp(x))


def fit_logistic(rows, labels, *, l2=0.01, iterations=300, rate=0.5):
    """L2-regularised logistic regression by batch gradient descent on standardised features (pure Python).

    Returns ``{"weights", "bias", "mean", "std"}``. One class only (or no rows): the base rate, no weights.
    """
    n = len(rows)
    if n == 0:
        return {"weights": [], "bias": 0.0, "mean": [], "std": []}
    width = len(rows[0])
    mean = [sum(r[j] for r in rows) / n for j in range(width)]
    std = [math.sqrt(sum((r[j] - mean[j]) ** 2 for r in rows) / n) or 1.0 for j in range(width)]
    positives = sum(labels)
    if positives in (0, n):
        base = min(0.98, max(0.02, positives / n))
        return {"weights": [0.0] * width, "bias": math.log(base / (1 - base)), "mean": mean, "std": std}
    z = [[(r[j] - mean[j]) / std[j] for j in range(width)] for r in rows]
    weights, bias = [0.0] * width, 0.0
    for _ in range(iterations):
        grad_w, grad_b = [0.0] * width, 0.0
        for row, label in zip(z, labels):
            error = _sigmoid(bias + sum(w * x for w, x in zip(weights, row))) - label
            grad_b += error
            for j in range(width):
                grad_w[j] += error * row[j]
        bias -= rate * grad_b / n
        weights = [w - rate * (g / n + l2 * w) for w, g in zip(weights, grad_w)]
    return {"weights": weights, "bias": bias, "mean": mean, "std": std}


def predict_logistic(model, row):
    if not model["weights"]:
        return _sigmoid(model["bias"])
    z = [(x - m) / s for x, m, s in zip(row, model["mean"], model["std"])]
    return _sigmoid(model["bias"] + sum(w * x for w, x in zip(model["weights"], z)))


_NUMBER = r"(-?\d+(?:\.\d+)?|n/a)"
FEATURE_NAMES = (
    "side", "stop_atr", "target_atr", "stop_bp", "target_bp", "max_hold_min", "regime_trend", "regime_range",
    "ret_1m", "ret_5m", "ret_15m", "ret_60m", "dist_ema9", "dist_ema21", "dist_sma50",
    "rsi14", "bollinger_pos", "donchian_pos", "atr_bp", "volume_rel",
    "ret_1m_missing", "ret_5m_missing", "ret_15m_missing", "ret_60m_missing", "dist_ema9_missing",
    "dist_ema21_missing", "dist_sma50_missing", "rsi14_missing", "bollinger_pos_missing", "donchian_pos_missing",
    "atr_bp_missing", "volume_rel_missing",
    "aligned_ret_5m", "aligned_ret_60m", "aligned_dist_ema21", "aligned_rsi")


def state_features(text):
    """``(names, values)``: the numbers of a STATE text, exactly as Qwen read them (rounded), plus missing flags and the
    side-aligned versions of the directional ones. Same names and order for every signal."""
    found = {}

    def number(key, value):
        if value is None or value == "n/a":
            found[key], found[key + "_missing"] = 0.0, 1.0
        else:
            found[key], found[key + "_missing"] = float(value), 0.0

    side = re.search(r"side=(LONG|SHORT)", text)
    found["side"] = 1.0 if side and side.group(1) == "LONG" else -1.0
    for key in ("stop_atr", "target_atr", "stop_bp", "target_bp", "max_hold_min"):
        match = re.search(key + r"=" + _NUMBER, text)
        found[key] = float(match.group(1)) if match and match.group(1) != "n/a" else 0.0
    regime = re.search(r"regime: (\w+)", text)
    found["regime_trend"] = 1.0 if regime and regime.group(1) == "trend" else 0.0
    found["regime_range"] = 1.0 if regime and regime.group(1) == "range" else 0.0
    for minutes in (1, 5, 15, 60):
        match = re.search(r"\b{}m={}".format(minutes, _NUMBER), text)
        number("ret_{}m".format(minutes), match.group(1) if match else None)
    for name in ("ema9", "ema21", "sma50"):
        match = re.search(r"\b{}={}".format(name, _NUMBER), text)
        number("dist_" + name, match.group(1) if match else None)
    for name in ("rsi14", "bollinger_pos", "donchian_pos", "atr_bp", "volume_rel"):
        match = re.search(r"^{}: {}".format(name, _NUMBER), text, re.MULTILINE)
        number(name, match.group(1) if match else None)
    side_value = found["side"]
    found["aligned_ret_5m"] = side_value * found["ret_5m"]
    found["aligned_ret_60m"] = side_value * found["ret_60m"]
    found["aligned_dist_ema21"] = side_value * found["dist_ema21"]
    found["aligned_rsi"] = side_value * (found["rsi14"] - 50.0 if not found["rsi14_missing"] else 0.0)
    return list(FEATURE_NAMES), [found[name] for name in FEATURE_NAMES]


def brier(probabilities, outcomes):
    if not probabilities:
        return None
    return sum((p - y) ** 2 for p, y in zip(probabilities, outcomes)) / len(probabilities)


def reliability_table(probabilities, outcomes, bins=5):
    cells = [{"lo": i / bins, "hi": (i + 1) / bins, "n": 0, "pred": 0.0, "hits": 0} for i in range(bins)]
    for p, y in zip(probabilities, outcomes):
        cell = cells[min(int(p * bins), bins - 1)]
        cell["n"] += 1
        cell["pred"] += p
        cell["hits"] += y
    return [{"lo": c["lo"], "hi": c["hi"], "n": c["n"],
             "predicted": c["pred"] / c["n"] if c["n"] else None,
             "observed": c["hits"] / c["n"] if c["n"] else None} for c in cells]


def position_bias(pairs):
    """``pairs``: ``(p_approve with approve under letter A, p_approve with approve under letter B)`` per signal.

    A model that reads the question gives the same answer in both orders (agreement 100 %, shift 0); one that
    prefers a letter flips with the order. ``letter_a_share``: answers whose most likely option sat under letter A.
    """
    n = len(pairs)
    if n == 0:
        return {"n": 0, "agreement": None, "mean_shift": None, "mean_abs_shift": None, "letter_a_share": None}
    agree = sum(1 for a, b in pairs if (a >= 0.5) == (b >= 0.5))
    letter_a = sum((1 if a >= 0.5 else 0) + (1 if b < 0.5 else 0) for a, b in pairs)
    return {"n": n, "agreement": agree / n, "mean_shift": sum(a - b for a, b in pairs) / n,
            "mean_abs_shift": sum(abs(a - b) for a, b in pairs) / n, "letter_a_share": letter_a / (2 * n)}


def choose_threshold(calibration, *, min_kept=0.3, min_n=10):
    """The approval threshold with the best mean net bp of the approved signals, looking ONLY at ``calibration``
    (``[(score, net_bp)]``). Candidates: fixed thresholds and the ones that reject 10-55 % of the calibration scores.
    Thresholds keeping fewer than ``min_kept`` of the signals (or ``min_n``) are not eligible; none eligible: 0.5."""
    if not calibration:
        return 0.5
    scores = sorted(score for score, _ in calibration)
    candidates = set(FIXED_THRESHOLDS)
    for rate in REJECT_RATES:
        candidates.add(round(scores[min(len(scores) - 1, int(rate * len(scores)))], 4))
    need = max(min_n, int(math.ceil(min_kept * len(calibration))))
    best, best_mean = 0.5, None
    for threshold in sorted(candidates):
        kept = [net for score, net in calibration if score >= threshold]
        if len(kept) < need:
            continue
        mean = sum(kept) / len(kept)
        if best_mean is None or mean > best_mean + 1e-12:
            best, best_mean = threshold, mean
    return best


# --------------------------------------------------------------------------- data


def load_practice(practice_path):
    """``{signal_id: {variant: p_approve}}`` plus the model identities and the question/prompt versions seen."""
    db = sqlite3.connect("file:{}?mode=ro".format(practice_path), uri=True)
    try:
        rows = db.execute("SELECT signal_id, variant, p_approve, model_ref, question_version, prompt_version, "
                          "latency_ms FROM decisions").fetchall()
        errors = db.execute("SELECT COUNT(*) FROM decision_errors").fetchone()[0]
    finally:
        db.close()
    probs = collections.defaultdict(dict)
    seen = {"models": set(), "questions": set(), "prompts": set(), "latency": []}
    for signal_id, variant, p, model, question, prompt, latency in rows:
        probs[signal_id][variant] = p
        seen["models"].add(model)
        seen["questions"].add(question)
        seen["prompts"].add(prompt)
        if latency is not None:
            seen["latency"].append(latency)
    seen["errors"] = errors
    return probs, seen


def _fmt(value, places=1):
    return "n/d" if value is None else ("{:.%df}" % places).format(value).replace(".", ",")


def _pct(value, places=1):
    return "n/d" if value is None else _fmt(100 * value, places) + " %"


def _row(label, values, seed):
    m = metrics(values)
    low, high = wilson(m["wins"], m["n"])
    mlow, mhigh = bootstrap_ci(values, seed=seed)
    hit = "n/d" if m["n"] == 0 else "{} [{} a {}]".format(_pct(m["hit_rate"], 0), _pct(low, 0), _pct(high, 0))
    mean = "n/d" if m["n"] == 0 else "{} [{} a {}]".format(_fmt(m["mean_bp"]), _fmt(mlow), _fmt(mhigh))
    return "| {} | {} | {} | {} | {} |".format(label, m["n"], hit, mean, _fmt(m["profit_factor"], 2))


TABLE_HEAD = ("| Filtro | N | Acierto [IC95] | bp neto medio [IC95] | Factor de beneficio |\n"
              "|---|---:|---|---|---:|")


def _lr_scores(signals_path, universe_by_strategy, items_by_strategy):
    """Per-strategy logistic regression trained on the calibration fold of ALL its labelled signals (a seeded subsample
    of at most ``LR_TRAIN_MAX``: pure-Python gradient descent, ~34 features)."""
    trains = {}
    for strategy, signals in universe_by_strategy.items():
        train = [s for s in signals if s["fold"] == "calibration"]
        if len(train) < MIN_GROUP_N:
            continue
        if len(train) > LR_TRAIN_MAX:
            train = random.Random(7).sample(train, LR_TRAIN_MAX)
        trains[strategy] = train
    needed = {s["signal_id"] for rows in trains.values() for s in rows}
    needed |= {i["signal_id"] for rows in items_by_strategy.values() for i in rows}
    texts = read_state_texts(signals_path, needed)
    scores = {}
    for strategy, train in trains.items():
        rows = [state_features(texts[s["signal_id"]])[1] for s in train]
        model = fit_logistic(rows, [1 if s["own_net_bp"] > 0 else 0 for s in train])
        for item in items_by_strategy.get(strategy, []):
            scores[item["signal_id"]] = predict_logistic(model, state_features(texts[item["signal_id"]])[1])
    return scores


def _evaluate(items, threshold, lr, seed):
    """Qwen kept/rejected, random filter and rate-matched LR on ``items`` (dicts with ``score``, ``net``)."""
    nets = [i["net"] for i in items]
    kept = [i for i in items if i["score"] >= threshold]
    rejected = [i for i in items if i["score"] < threshold]
    kept_nets = [i["net"] for i in kept]
    out = {"items": len(items), "all": nets, "kept": kept_nets, "rejected": [i["net"] for i in rejected],
           "fixed": [i["net"] for i in items if i["score"] >= 0.5]}
    mean_all = sum(nets) / len(nets) if nets else None
    mean_kept = sum(kept_nets) / len(kept_nets) if kept_nets else None
    out["lift"] = None if mean_all is None or mean_kept is None else mean_kept - mean_all
    out["random"] = (random_filter(nets, len(kept_nets), mean_kept, seed=seed)
                     if kept_nets and len(kept_nets) < len(nets) else None)
    out["lr"], out["lr_lift"] = None, None
    have = [i for i in items if i["signal_id"] in lr]
    if have and len(kept_nets) < len(nets):
        by_strategy = collections.defaultdict(list)
        for item in items:
            by_strategy[item["strategy_id"]].append(item)
        chosen = []
        for group in by_strategy.values():
            k = sum(1 for i in group if i["score"] >= threshold)
            ranked = sorted((i for i in group if i["signal_id"] in lr), key=lambda i: -lr[i["signal_id"]])
            chosen += ranked[:k]
        out["lr"] = [i["net"] for i in chosen]
        if chosen and mean_all is not None:
            out["lr_lift"] = sum(out["lr"]) / len(out["lr"]) - mean_all
    return out


def _block(title, ev, threshold, seed):
    lines = [title, "", TABLE_HEAD, _row("(a) todas las señales practicadas", ev["all"], seed),
             _row("(b) Qwen aprueba, umbral 0,5", ev["fixed"], seed + 1),
             _row("(b) Qwen aprueba, umbral {} (elegido en calibración)".format(_fmt(threshold, 3)), ev["kept"], seed + 2),
             _row("    Qwen rechaza (umbral {})".format(_fmt(threshold, 3)), ev["rejected"], seed + 3)]
    if ev["random"]:
        rnd = ev["random"]
        lines.append("| (c) filtro aleatorio, misma tasa de rechazo ({} sorteos) | {} | media {} bp, P5 a P95 [{} a {}] | | |".format(
            rnd["draws"], len(ev["kept"]), _fmt(rnd["mean"]), _fmt(rnd["p05"]), _fmt(rnd["p95"])))
    if ev["lr"] is not None:
        lines.append(_row("(d) regresión logística, mismo nº de aprobadas", ev["lr"], seed + 4))
    lines.append("")
    if ev["random"]:
        lines.append("Percentil de Qwen frente al filtro aleatorio: **{}** (100 = mejor que todos los sorteos). "
                     "Mejora de Qwen sobre «todas»: {} bp{}.".format(
                         _fmt(ev["random"]["percentile"], 1), _fmt(ev["lift"]),
                         "" if ev["lr_lift"] is None else "; de la regresión logística: {} bp".format(_fmt(ev["lr_lift"]))))
    else:
        lines.append("Qwen aprueba todo o casi todo con este umbral: no hay filtro que comparar con el azar.")
    lines.append("")
    return lines


def build_report(signals_path, practice_path, cutoff_date=None):
    """The Spanish markdown report; raises ``ValueError`` when the practice file holds no complete signal."""
    meta = read_meta(signals_path)
    probs, seen = load_practice(practice_path)
    cutoff_ms = meta.get("cutoff_ms", 0)
    cutoff_text = meta.get("cutoff_date", QWEN3_RELEASE_DATE)
    if cutoff_date:
        import calendar
        import time
        cutoff_ms = calendar.timegm(time.strptime(cutoff_date, "%Y-%m-%d")) * 1000
        cutoff_text = cutoff_date
    signals = [dict(s, period="pre_cutoff" if s["decision_ms"] < cutoff_ms else "post_cutoff")
               for s in read_signals(signals_path, LIGHT_COLUMNS, "WHERE tradable=1 AND own_net_bp IS NOT NULL")]
    universe = [s for s in signals if s["strategy_id"] not in DUPLICATE_STRATEGIES]
    practiced = []
    for s in signals:
        got = probs.get(s["signal_id"], {})
        if 0 in got and 1 in got:
            practiced.append(dict(s, net=s["own_net_bp"], p0=got[0], p1=got[1], score=(got[0] + got[1]) / 2))
    if not practiced:
        raise ValueError("el fichero de práctica no tiene ninguna señal con las dos órdenes: ejecuta `practice` primero")
    pooled = [i for i in practiced if i["strategy_id"] not in DUPLICATE_STRATEGIES]
    cal = [i for i in pooled if i["fold"] == "calibration"]
    val = [i for i in pooled if i["fold"] == "validation"]
    threshold = choose_threshold([(i["score"], i["net"]) for i in cal])
    by_strategy_universe = collections.defaultdict(list)
    for s in universe:
        by_strategy_universe[s["strategy_id"]].append(s)
    by_strategy_pooled = collections.defaultdict(list)
    for i in pooled:
        by_strategy_pooled[i["strategy_id"]].append(i)
    lr = _lr_scores(signals_path, by_strategy_universe, by_strategy_pooled)

    ev_val = _evaluate(val, threshold, lr, seed=101)
    ev_cal = _evaluate(cal, threshold, {}, seed=201)
    verdict, reasons = _verdict(pooled, cal, val, ev_val, threshold, lr)

    pairs = [(i["p0"], i["p1"]) for i in pooled]
    bias = position_bias(pairs)
    wins = [1 if i["net"] > 0 else 0 for i in pooled]
    base_rate = (sum(1 if i["net"] > 0 else 0 for i in cal) / len(cal)) if cal else None

    out = ["# Informe de la práctica de Qwen como filtro de señales", ""]
    out += ["Qué pregunta responde: si a cada señal de compra/venta de una estrategia (C25-C32) le preguntamos a Qwen "
            "«¿apruebas o rechazas?», sin que conozca el resultado, ¿se queda con las mejores mejor que el azar y "
            "mejor que un filtro estadístico simple sobre los mismos datos?", ""]
    out += ["- Señales: `{}` (build `{}`), {} productos {}, desde {}. Con resultado propio: {}; practicadas por Qwen "
            "(con las dos órdenes): {} ({} sin contar C28).".format(
                signals_path, meta["build_id"], len(meta.get("products", [])), ", ".join(meta.get("products", [])), meta.get("from", "?"),
                len(signals), len(practiced), len(pooled)),
            "- Modelo: {}; pregunta `signal_filter` v{}; prompt v{}; {} llamadas con error sin respuesta; latencia media {} ms.".format(
                ", ".join(sorted(m for m in seen["models"] if m)), ", ".join(map(str, sorted(seen["questions"]))),
                ", ".join(map(str, sorted(seen["prompts"]))), seen["errors"],
                _fmt(sum(seen["latency"]) / len(seen["latency"]), 0) if seen["latency"] else "n/d"),
            "- Etiqueta principal: bp netos de la operación con las salidas propias de la estrategia (comisiones taker e "
            "impacto de `futures_costs`; funding solo donde Kraken lo publica, desde oct-2025). Acierto = neto > 0.",
            "- Corte pre/post: {} (Qwen3 se publicó el {}; no hay corte de conocimiento oficial verificable, es una cota "
            "conservadora: si el modelo es posterior (Qwen3.5 es de 2026), ninguna señal es limpia con seguridad).".format(
                cutoff_text, QWEN3_RELEASE_DATE),
            "- Pliegues por tiempo: calibración = 60 % más antiguo, validación = 40 % más reciente. El umbral de Qwen se "
            "elige solo en calibración. El prompt no se ajustó con estos datos; cambiarlo obliga a validar con señales nuevas "
            "(forward), no con éstas.", ""]
    out += ["## Veredicto", "", "**{}**".format(verdict), ""]
    out += ["- " + reason for reason in reasons]
    out += ["", "Criterios del veredicto, fijados antes de ver resultados: sobre la validación (sin C28), N ≥ {} señales y ≥ {} "
            "aprobadas y rechazadas; mejora sobre «todas» > 0 con percentil ≥ {} frente al filtro aleatorio; mejor que la "
            "regresión logística con el mismo nº de aprobadas; acuerdo entre órdenes ≥ {} y desplazamiento medio ≤ {}; "
            "Brier mejor que predecir la tasa base; sin ventaja solo pre-cutoff.".format(
                MIN_VALIDATION_N, MIN_GROUP_N, int(SIGNIFICANT_PERCENTILE), _pct(MIN_AGREEMENT, 0), _fmt(MAX_MEAN_SHIFT, 2)), ""]

    out += ["## Resumen", ""]
    out += _block("### Validación (fuera de muestra: umbral y regresión se fijaron en calibración)", ev_val, threshold, 1000)
    out += _block("### Calibración (el umbral se eligió aquí: optimista)", ev_cal, threshold, 2000)
    out += ["Aprobadas en validación al umbral 0,5: {} de {}.".format(len(ev_val["fixed"]), ev_val["items"]), ""]

    out += ["## Por estrategia", "",
            "Validación, con el umbral elegido en calibración con todas las estrategias juntas. N pequeño = indicativo, no concluyente.", ""]
    for strategy in sorted(by_strategy_pooled):
        group = [i for i in by_strategy_pooled[strategy] if i["fold"] == "validation"]
        total = len(by_strategy_pooled[strategy])
        out.append("### {} ({} practicadas, {} en validación{})".format(
            strategy, total, len(group), "; N<30: indicativo" if len(group) < 30 else ""))
        out.append("")
        if not group:
            out += ["Sin señales practicadas en validación.", ""]
            continue
        ev = _evaluate(group, threshold, lr, seed=3000 + len(strategy))
        out += [TABLE_HEAD, _row("(a) todas", ev["all"], 11), _row("(b) Qwen aprueba (umbral {})".format(_fmt(threshold, 3)), ev["kept"], 12)]
        if ev["random"]:
            out.append("| (c) aleatorio, misma tasa | {} | percentil de Qwen: {} | media {} bp | |".format(
                len(ev["kept"]), _fmt(ev["random"]["percentile"], 1), _fmt(ev["random"]["mean"])))
        if ev["lr"] is not None:
            out.append(_row("(d) regresión logística", ev["lr"], 13))
        out.append("")
    dups = [i for i in practiced if i["strategy_id"] in DUPLICATE_STRATEGIES]
    if dups:
        out += ["C28 practicada ({} señales) repite señales de C25/C26 y no entra en los totales.".format(len(dups)), ""]

    out += ["## Calibración de Qwen", "",
            "Probabilidad de aprobar (media de las dos órdenes) frente a la frecuencia real de acierto (todas las practicadas, sin C28).", "",
            "| Probabilidad de aprobar | N | Predicha | Observada |", "|---|---:|---:|---:|"]
    table = reliability_table([i["score"] for i in pooled], wins)
    for cell in table:
        out.append("| {}–{} | {} | {} | {} |".format(_fmt(cell["lo"], 1), _fmt(cell["hi"], 1), cell["n"],
                                                      _pct(cell["predicted"], 0), _pct(cell["observed"], 0)))
    scores = [i["score"] for i in pooled]
    q_brier = brier(scores, wins)
    base = [base_rate] * len(wins) if base_rate is not None else None
    out += ["", "Brier de Qwen: **{}**; Brier de predecir siempre la tasa base de calibración ({}): {}; "
                "habilidad = {}. Una calibración útil necesita Brier menor que la tasa base.".format(
                    _fmt(q_brier, 4), _pct(base_rate, 1), _fmt(brier(base, wins) if base else None, 4),
                    _fmt(None if not base else 1 - q_brier / brier(base, wins), 3)),
            "Aprueba (≥ 0,5) el {} de las señales; la tasa real de acierto es {}: si aprueba casi todo es exceso de confianza.".format(
                _pct(sum(1 for s in scores if s >= 0.5) / len(scores), 0), _pct(sum(wins) / len(wins), 0)), ""]

    out += ["## Sesgo de posición", "",
            "Cada señal se pregunta dos veces con las opciones intercambiadas (aprobar/rechazar en A o en B).", "",
            "| Grupo | N | Acuerdo entre órdenes | Desplazamiento medio de p(aprobar) | Desplazamiento absoluto medio | Respuestas bajo la letra A |",
            "|---|---:|---:|---:|---:|---:|"]
    groups = [("todas", pairs)] + [(s, [(i["p0"], i["p1"]) for i in g]) for s, g in sorted(by_strategy_pooled.items())]
    for label, group_pairs in groups:
        b = position_bias(group_pairs)
        out.append("| {} | {} | {} | {} | {} | {} |".format(label, b["n"], _pct(b["agreement"], 0), _fmt(b["mean_shift"], 3),
                                                            _fmt(b["mean_abs_shift"], 3), _pct(b["letter_a_share"], 0)))
    out += ["", "Si lee la pregunta el acuerdo es ~100 % y el desplazamiento ~0; un acuerdo bajo o un 100 % bajo la letra A "
                "es preferencia por una letra (sesgo de posición), no una decisión.", ""]

    out += ["## Por periodo y pliegue", "",
            "Con corte {}; el pliegue es por tiempo, así que periodo y pliegue están muy correlacionados (las celdas vacías son reales).".format(cutoff_text), "",
            "| Periodo | Pliegue | N | bp medio de todas | bp medio de aprobadas | Mejora | Percentil vs aleatorio |",
            "|---|---|---:|---:|---:|---:|---:|"]
    for period in ("pre_cutoff", "post_cutoff"):
        for fold in ("calibration", "validation"):
            cell = [i for i in pooled if i["period"] == period and i["fold"] == fold]
            ev = _evaluate(cell, threshold, {}, seed=4000 + len(cell))
            mean_all = sum(ev["all"]) / len(ev["all"]) if ev["all"] else None
            mean_kept = sum(ev["kept"]) / len(ev["kept"]) if ev["kept"] else None
            out.append("| {} | {} | {} | {} | {} | {} | {} |".format(
                period, "calibración" if fold == "calibration" else "validación", len(cell), _fmt(mean_all),
                _fmt(mean_kept), _fmt(ev["lift"]), _fmt(ev["random"]["percentile"], 1) if ev["random"] else "n/d"))
    out.append("")

    out += ["## Línea base", "",
            "- (a) todas las señales: lo que haría la estrategia sin filtro.",
            "- (b) Qwen: aprueba si la media de p(aprobar) de las dos órdenes ≥ umbral. Umbral elegido solo en calibración "
            "entre {{0,5; 0,6; 0,7; 0,8; 0,9}} y los que rechazan 10-55 % de las puntuaciones; elegido: **{}**.".format(_fmt(threshold, 3)),
            "- (c) filtro aleatorio con la misma tasa de rechazo: {} sorteos; se da el percentil de Qwen.".format(DRAWS),
            "- (d) regresión logística propia (Python puro, L2, características estandarizadas) con los números del STATE "
            "({} características), entrenada por estrategia en el pliegue de calibración de TODAS sus señales y evaluada "
            "en validación conservando el mismo nº de aprobadas que Qwen.".format(len(FEATURE_NAMES)), ""]
    secondary = []
    for label, key in (("1 h", "net_bp_1h"), ("4 h", "net_bp_4h")):
        rows_all = [i[key] for i in val if i[key] is not None]
        rows_kept = [i[key] for i in val if i[key] is not None and i["score"] >= threshold]
        secondary.append("| {} | {} | {} | {} | {} |".format(label, len(rows_all), _fmt(sum(rows_all) / len(rows_all) if rows_all else None),
                                                           len(rows_kept), _fmt(sum(rows_kept) / len(rows_kept) if rows_kept else None)))
    out += ["## Etiquetas a horizonte fijo (validación)", "",
            "Entrada al cierre de la señal, salida a horizonte fijo, mismos costes (sin funding).", "",
            "| Horizonte | N todas | bp medio todas | N aprobadas | bp medio aprobadas |", "|---|---:|---:|---:|---:|"] + secondary + [""]
    out += ["## Límites", "",
            "- Las señales se solapan en el tiempo (varias estrategias y productos a la vez): los IC son optimistas.",
            "- Cada señal se evalúa como si se hubiera tomado, aunque el libro real estuviera ocupado (`taken_by_book` lo distingue).",
            "- C31 (Qwen cierra) y Kronos no tienen señales propias; C28 repite C25/C26.",
            "- Un resultado favorable aquí es una razón para medirlo hacia delante, no una promoción: la regla del repo "
            "(100 operaciones forward) sigue mandando.", ""]
    return "\n".join(out)


def _verdict(pooled, cal, val, ev_val, threshold, lr):
    """``(line, reasons)``. Rules fixed in advance (see the report's own text)."""
    reasons = []
    kept, rejected = len(ev_val["kept"]), len(ev_val["rejected"])
    if len(val) < MIN_VALIDATION_N or kept < MIN_GROUP_N or rejected < MIN_GROUP_N:
        reasons.append("muestra insuficiente: {} señales practicadas en validación ({} aprobadas, {} rechazadas); hacen falta "
                       "≥ {} y ≥ {} de cada grupo. No se puede concluir nada: practicar más señales.".format(
                           len(val), kept, rejected, MIN_VALIDATION_N, MIN_GROUP_N))
        bias = position_bias([(i["p0"], i["p1"]) for i in pooled])
        if bias["agreement"] < MIN_AGREEMENT or bias["mean_abs_shift"] > MAX_MEAN_SHIFT:
            reasons.append("sesgo de posición alto: acuerdo entre órdenes {} (mínimo {}), desplazamiento absoluto medio {}.".format(
                _pct(bias["agreement"], 0), _pct(MIN_AGREEMENT, 0), _fmt(bias["mean_abs_shift"], 3)))
        return "Qwen necesita configuración (no concluyente: muestra insuficiente)", reasons
    lift = ev_val["lift"]
    percentile = ev_val["random"]["percentile"] if ev_val["random"] else None
    significant = lift is not None and lift > 0 and percentile is not None and percentile >= SIGNIFICANT_PERCENTILE
    reasons.append("mejora sobre «todas» en validación: {} bp; percentil frente al filtro aleatorio: {}.".format(
        _fmt(lift), _fmt(percentile, 1)))
    lr_lift = ev_val["lr_lift"]
    beats_lr = lr_lift is None or lift > lr_lift
    if lr_lift is None:
        reasons.append("no hay regresión logística comparable (pocas señales de entrenamiento): sin esa comparación.")
    else:
        reasons.append("regresión logística con el mismo nº de aprobadas: {} bp de mejora ({}).".format(
            _fmt(lr_lift), "Qwen la supera" if beats_lr else "iguala o supera a Qwen"))
    bias = position_bias([(i["p0"], i["p1"]) for i in pooled])
    bias_ok = bias["agreement"] >= MIN_AGREEMENT and bias["mean_abs_shift"] <= MAX_MEAN_SHIFT
    if not bias_ok:
        reasons.append("sesgo de posición alto: acuerdo entre órdenes {} (mínimo {}), desplazamiento absoluto medio {} (máximo {}).".format(
            _pct(bias["agreement"], 0), _pct(MIN_AGREEMENT, 0), _fmt(bias["mean_abs_shift"], 3), _fmt(MAX_MEAN_SHIFT, 2)))
    base_rate = sum(1 for i in cal if i["net"] > 0) / len(cal) if cal else None
    wins = [1 if i["net"] > 0 else 0 for i in val]
    q_brier = brier([i["score"] for i in val], wins)
    calibrated = base_rate is not None and q_brier < brier([base_rate] * len(wins), wins)
    if not calibrated:
        reasons.append("mala calibración: Brier {} no mejora la tasa base.".format(_fmt(q_brier, 4)))
    pre = [i for i in cal if i["period"] == "pre_cutoff"]
    post = [i for i in cal if i["period"] == "post_cutoff"]
    memo = False
    if len(pre) >= MIN_GROUP_N and len(post) >= MIN_GROUP_N:
        lifts = []
        for part in (pre, post):
            ev = _evaluate(part, threshold, {}, seed=5)
            lifts.append(ev["lift"])
        if lifts[0] is not None and lifts[1] is not None:
            memo = lifts[0] > 0 and lifts[1] < lifts[0] / 2
            reasons.append("mejora en calibración: pre_cutoff {} bp, post_cutoff {} bp{}.".format(
                _fmt(lifts[0]), _fmt(lifts[1]), "; la ventaja está sobre todo antes del corte: posible memoria del modelo" if memo else ""))
    if significant and beats_lr and bias_ok and calibrated and not memo:
        return "Qwen agrega valor (sobre estos datos; falta confirmarlo hacia delante)", reasons
    if significant and not beats_lr:
        reasons.append("un filtro estadístico simple sobre los mismos datos hace lo mismo o más: el modelo no aporta.")
        return "Qwen no agrega valor", reasons
    if significant or (lift is not None and lift > 0 and percentile is not None and percentile >= 80):
        return "Qwen necesita configuración (hay señal pero falla: {})".format(
            ", ".join(name for name, ok in (("sesgo de posición", bias_ok), ("calibración", calibrated),
                                            ("posible memoria pre-cutoff", not memo),
                                            ("significación", significant)) if not ok)), reasons
    reasons.append("no discrimina ganadoras de perdedoras mejor que el azar.")
    return "Qwen no agrega valor", reasons
