"""Report sections that explain HOW Qwen behaves (no model call; they only read the practice database and the candles that
the database itself stores for each block).

* side bias: long or short, against what the market did in the same blocks;
* exit decisions one by one: for every MANTENER / CERRAR, what the other choice would have given at 1 h, 4 h and the block end;
* does Qwen's confidence rank outcomes (AUC, quintiles, isotonic calibration fitted on the calibration fold only);
* a surrogate (shallow tree + standardized logistic regression) that imitates Qwen from the numbers it was shown.

No-lookahead rules: a counterfactual only reads the closes stored with the block (never later than the block end, so never
the holdout); every fitted thing (calibration map, surrogate) is fitted on the calibration fold and judged on validation.
Everything describes Qwen's behaviour and the history of these blocks; none of it is market truth.
"""

import bisect
import collections
import json
import math
import random
import statistics

from . import futures_qwen_trader as qt
from . import futures_qwen_trader_probe as probe
from . import futures_qwen_trader_state as st
from .strategy_gate import _es, _pct_bp, _share, _stable_seed, _table

EPS = 1e-9
MIN_GROUP = 20            # decisions needed in a group before a sentence is built from it
BOOT_DRAWS = 300
HORIZONS = (("1h", "1 h"), ("4h", "4 h"), ("block_end", "fin del bloque"))
PNL_BUCKETS = (("perdida_grande", "pérdida grande (peor que −1σ)"), ("perdida_pequena", "pérdida pequeña (entre −1σ y 0)"),
               ("ganancia_pequena", "ganancia pequeña (entre 0 y +1σ)"), ("ganancia_grande", "ganancia grande (más de +1σ)"))
TIME_BUCKETS = (("menos_1h", "menos de 1 h abierta"), ("1_4h", "entre 1 y 4 h"), ("4_12h", "entre 4 y 12 h"),
                ("mas_12h", "más de 12 h"))


# --------------------------------------------------------------------------- small statistics


def _ranks(values):
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks, i = [0.0] * len(values), 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return ranks


def auc(scores, good):
    """Probability that a random good case has a higher score than a random bad one (ties count half). 0.5 = no
    information, 1 = perfect, 0 = perfectly reversed. ``None`` without both kinds of case."""
    pos = sum(1 for g in good if g)
    neg = len(good) - pos
    if not pos or not neg:
        return None
    ranks = _ranks(scores)
    return (sum(r for r, g in zip(ranks, good) if g) - pos * (pos + 1) / 2.0) / (pos * neg)


def spearman(xs, ys):
    if len(xs) < 3:
        return None
    rx, ry = _ranks(xs), _ranks(ys)
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    sx = math.sqrt(sum((a - mx) ** 2 for a in rx))
    sy = math.sqrt(sum((b - my) ** 2 for b in ry))
    return None if sx == 0 or sy == 0 else sum((a - mx) * (b - my) for a, b in zip(rx, ry)) / (sx * sy)


def auc_ci(rows, seed, draws=BOOT_DRAWS):
    """Percentile 95 % interval of the AUC, resampling whole BLOCKS (decisions of one block are not independent)."""
    by_block = collections.defaultdict(list)
    for r in rows:
        by_block[r["block_id"]].append(r)
    keys = sorted(by_block)
    if len(keys) < 2:
        return None, None
    rng = random.Random(seed)
    values = []
    for _ in range(draws):
        sample = [r for k in rng.choices(keys, k=len(keys)) for r in by_block[k]]
        a = auc([r["score"] for r in sample], [r["good"] for r in sample])
        if a is not None:
            values.append(a)
    if len(values) < draws // 2:
        return None, None
    values.sort()
    return values[int(0.025 * (len(values) - 1))], values[int(math.ceil(0.975 * (len(values) - 1)))]


def top_bottom(rows, share=0.2):
    """Mean result of the top and bottom ``share`` of ``rows`` ranked by score (ties broken by block and time, so the same
    input always gives the same answer). A two-valued score (order agreement) compares its two groups instead."""
    ordered = sorted(rows, key=lambda r: (r["score"], r["block_id"], r["t_ms"]))
    distinct = sorted({r["score"] for r in rows})
    if len(distinct) == 2:
        low = [r["result"] for r in rows if r["score"] == distinct[0]]
        high = [r["result"] for r in rows if r["score"] == distinct[1]]
    else:
        k = max(1, int(len(ordered) * share))
        low, high = [r["result"] for r in ordered[:k]], [r["result"] for r in ordered[-k:]]
    if len(low) < 5 or len(high) < 5:
        return None, None, len(low), len(high)
    return statistics.fmean(high), statistics.fmean(low), len(high), len(low)


def isotonic_fit(xs, ys):
    """Pool-adjacent-violators: non-decreasing step map from score to the share of good cases. ``(knots, values)``."""
    pairs = sorted(zip(xs, ys))
    blocks = []                                  # [sum_y, count, x_low, x_high]
    for x, y in pairs:
        if blocks and blocks[-1][2] == x == blocks[-1][3]:
            blocks[-1][0] += y
            blocks[-1][1] += 1
        else:
            blocks.append([float(y), 1, x, x])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1] + 1e-15:
            top = blocks.pop()
            blocks[-1] = [blocks[-1][0] + top[0], blocks[-1][1] + top[1], blocks[-1][2], top[3]]
    return [b[2] for b in blocks], [b[0] / b[1] for b in blocks]


def isotonic_predict(model, x):
    knots, values = model
    if not knots:
        return None
    i = bisect.bisect_right(knots, x) - 1
    return values[max(0, min(i, len(values) - 1))]


# --------------------------------------------------------------------------- B1: long or short


def block_return(block):
    closes = block["closes"]
    return closes[-1] / closes[0] - 1.0 if len(closes) >= 2 and closes[0] else None


def side_bias(data, products):
    """Per product and fold: long / short entries, their mean result, and what the market did in the same blocks (buy and
    hold from the first to the last close of each block). All entries of the practice (no threshold)."""
    out = []
    groups = [(p, f) for p in [None] + list(products) for f in ("calibration", "validation", None)]
    for product, fold in groups:
        trades = [t for t in data["trades"] if (product is None or t["product"] == product) and (fold is None or t["fold"] == fold)]
        blocks = [b for b in data["blocks"].values() if (product is None or b["product"] == product) and (fold is None or b["fold"] == fold)]
        rets = [x for x in (block_return(b) for b in blocks) if x is not None]
        longs = [t["net_bp"] for t in trades if t["side"] == "LONG"]
        shorts = [t["net_bp"] for t in trades if t["side"] == "SHORT"]
        out.append({"product": product, "fold": fold, "n": len(trades), "long": len(longs), "short": len(shorts),
                    "long_mean": statistics.fmean(longs) if longs else None,
                    "short_mean": statistics.fmean(shorts) if shorts else None, "blocks": len(blocks),
                    "drift": statistics.fmean(rets) if rets else None,
                    "up_share": sum(1 for x in rets if x > 0) / len(rets) if rets else None})
    return out


def side_bias_sentence(rows):
    total = next(r for r in rows if r["product"] is None and r["fold"] is None)
    if not total["n"]:
        return "Todavía no hay entradas para medir si prefiere comprar o vender."
    share = total["long"] / total["n"]
    drift = total["drift"]
    text = "Compró (largo) el {} de las veces mientras el mercado {} {} en promedio por bloque en esos bloques".format(
        _share(share), "subió" if (drift or 0) >= 0 else "bajó", _pct_bp((abs(drift) if drift is not None else 0) * 1e4, 2))
    if total["up_share"] is not None:
        text += " (subió en el {} de los bloques)".format(_share(total["up_share"]))
    text += "."
    if total["n"] >= 30 and total["up_share"] is not None:
        if abs(share - 0.5) >= 0.15:
            follows = (share > 0.5) == (total["up_share"] > 0.5)
            text += " Tiene una preferencia clara por {}{}.".format(
                "comprar" if share > 0.5 else "vender", ", que coincide con la tendencia del mercado de esos bloques: puede estar "
                "siguiendo la deriva y no eligiendo momentos" if follows else ", contraria a lo que hizo el mercado")
        else:
            text += " Reparte casi parejo entre comprar y vender."
    return text


def side_bias_lines(data, products):
    rows = side_bias(data, products)
    lines = ["## ¿Prefiere comprar o vender?", "",
             "Todas las entradas de la práctica (sin filtrar por umbral). «Mercado» es lo que habría ganado comprar y mantener "
             "durante cada bloque (del primer al último precio), promediado sobre los bloques del grupo: sirve para saber si "
             "una preferencia por comprar solo refleja que el mercado subía.", "", side_bias_sentence(rows), ""]
    table = []
    for r in rows:
        label = "{} · {}".format("Todo" if r["product"] is None else r["product"],
                                 {"calibration": "calibración", "validation": "validación", None: "todo"}[r["fold"]])
        if not r["n"]:
            table.append([label, 0, "n/d", "n/d", "n/d", "n/d", _pct_bp((r["drift"] or 0) * 1e4, 2, True) if r["drift"] is not None else "n/d", "n/d"])
            continue
        table.append([label, r["n"], "{} ({})".format(r["long"], _share(r["long"] / r["n"])),
                      "{} ({})".format(r["short"], _share(r["short"] / r["n"])), _pct_bp(r["long_mean"], 2, True),
                      _pct_bp(r["short_mean"], 2, True), _pct_bp(r["drift"] * 1e4, 2, True) if r["drift"] is not None else "n/d",
                      _share(r["up_share"])])
    return lines + _table(["Grupo", "Entradas", "Largo", "Corto", "Promedio de los largos", "Promedio de los cortos",
                           "Mercado (promedio por bloque)", "Bloques en que subió"], table) + [""]


# --------------------------------------------------------------------------- B2: exit decisions one by one


def pnl_bucket(pnl_sigma):
    if pnl_sigma is None:
        return None
    return ("perdida_grande" if pnl_sigma < -1 else "perdida_pequena" if pnl_sigma < 0 else
            "ganancia_pequena" if pnl_sigma < 1 else "ganancia_grande")


def time_bucket(minutes):
    if minutes is None:
        return None
    return "menos_1h" if minutes < 60 else "1_4h" if minutes < 240 else "4_12h" if minutes < 720 else "mas_12h"


def position_rows(data, cfg, history=None):
    """One row per in-position decision (MANTENER and CERRAR) with the other choice evaluated: ``gain[h]`` is how much the
    chosen action gave more than the alternative (bp, after costs and funding): MANTENER vs closing now, CERRAR vs keeping
    the position to the horizon and closing there. ``None`` past the end of the block (the block closes are all that is
    read)."""
    trades = {(t["block_id"], t["trade_no"]): t for t in data["trades"]}
    notional, funding, out = qt.D(cfg["notional_usd"]), {}, []
    for d in data["decisions"]:
        if d["kind"] != "position" or d.get("model_action") is None or not d.get("position_json"):
            continue
        block = data["blocks"].get(d["block_id"])
        snapshot = json.loads(d["position_json"])
        if block is None or snapshot is None or d.get("net_bp_now") is None:
            continue
        if d["product"] not in funding:
            funding[d["product"]] = qt.FundingLine(history.funding(d["product"]) if history is not None else [])
        label = qt.exit_labels(d["product"], snapshot, d["t_ms"], d["net_bp_now"], block,
                               trades.get((d["block_id"], snapshot["trade_no"])), funding[d["product"]], notional)
        feats = st.extract(d.get("state_text") or "")
        sigma4 = feats["vol24"] / math.sqrt(6.0) if feats.get("vol24") else None
        pnl_sigma = feats["pnl_pct"] / sigma4 if sigma4 and "pnl_pct" in feats else None
        action = d["action"]
        gains = {}
        for key, _ in HORIZONS:
            better = label.get("hold_better_{}_bp".format(key))
            gains[key] = None if better is None else (better if action == "MANTENER" else -better)
        out.append({"block_id": d["block_id"], "t_ms": d["t_ms"], "fold": d["fold"], "product": d["product"],
                    "action": action, "gain": gains, "pnl_sigma": pnl_sigma, "pnl_bucket": pnl_bucket(pnl_sigma),
                    "open_min": feats.get("open_min"), "time_bucket": time_bucket(feats.get("open_min")),
                    "p_action": d["p_action"], "orders_json": d.get("orders_json")})
    return out


def exit_summary(rows, horizon):
    items = [r["gain"][horizon] for r in rows if r["gain"][horizon] is not None]
    if not items:
        return {"n": 0, "better": None, "mean": None}
    return {"n": len(items), "better": sum(1 for g in items if g > EPS) / len(items), "mean": statistics.fmean(items)}


def _cells(rows, horizons):
    out = []
    for key, _ in horizons:
        s = exit_summary(rows, key)
        out += ["n/d", "n/d"] if not s["n"] else [_share(s["better"]), _pct_bp(s["mean"], 2, True)]
    return out


def exit_lines(rows):
    lines = ["## Decisiones de salida, una por una", "",
             "Cada vez que Qwen estaba dentro de una posición y contestó MANTENER o CERRAR se calcula qué habría dado la **otra** "
             "opción: si mantuvo, qué habría dado cerrar en ese momento; si cerró, qué habría dado seguir hasta 1 h, 4 h o el fin "
             "del bloque (y cerrar ahí). Siempre con costos y funding, solo con las velas guardadas del bloque (nunca después "
             "de su final). «Mejor» = la opción que eligió Qwen dio más que la otra; «Ganancia media» = cuánto más (o menos, "
             "si es negativa) dio lo que eligió frente a la alternativa. Las decisiones de una misma operación se parecen "
             "entre sí: son menos evidencia independiente de lo que parece.", ""]
    if not rows:
        return lines + ["Todavía no hay decisiones dentro de una posición para evaluar.", ""]
    head = ["Grupo", "Decisiones"] + sum([["Mejor ({})".format(label), "Ganancia media ({})".format(label)] for _, label in HORIZONS], [])
    table = []
    for label, pred in (("Todas · calibración", lambda r: r["fold"] == "calibration"), ("Todas · validación", lambda r: r["fold"] == "validation"),
                        ("**Todas**", lambda r: True), ("Solo MANTENER", lambda r: r["action"] == "MANTENER"),
                        ("Solo CERRAR", lambda r: r["action"] == "CERRAR")):
        sub = [r for r in rows if pred(r)]
        table.append([label, len(sub)] + _cells(sub, HORIZONS))
    lines += _table(head, table) + [""]
    for title, key, buckets in (("Según cuánto va ganando o perdiendo (en σ de 4 h: la volatilidad diaria dividida por √6)", "pnl_bucket", PNL_BUCKETS),
                                ("Según cuánto tiempo lleva abierta", "time_bucket", TIME_BUCKETS)):
        table = []
        for bid, blabel in buckets:
            sub = [r for r in rows if r[key] == bid]
            hold = sum(1 for r in sub if r["action"] == "MANTENER")
            table.append([blabel, len(sub), _share(hold / len(sub)) if sub else "n/d"] + _cells(sub, HORIZONS[:2]))
        lines += ["**{}**".format(title), ""]
        lines += _table(["Situación", "Decisiones", "Mantuvo"] + sum([["Mejor ({})".format(l), "Ganancia media ({})".format(l)] for _, l in HORIZONS[:2]], []), table) + [""]
    lines += [exit_conclusion(rows), ""]
    return lines


def exit_conclusion(rows):
    allr = exit_summary(rows, "4h")
    if not allr["n"]:
        return "No hay decisiones con 4 h de futuro dentro del bloque para concluir."
    parts = ["En conjunto, lo que eligió fue mejor que la alternativa en el {} de las decisiones a 4 h (ganancia media {}).".format(
        _share(allr["better"]), _pct_bp(allr["mean"], 2, True))]
    cands = []
    for key, buckets in (("pnl_bucket", PNL_BUCKETS), ("time_bucket", TIME_BUCKETS)):
        for bid, blabel in buckets:
            for action in ("MANTENER", "CERRAR"):
                sub = [r for r in rows if r[key] == bid and r["action"] == action]
                s = exit_summary(sub, "4h")
                if s["n"] >= MIN_GROUP:
                    cands.append((s["mean"], action, blabel, s))
    if not cands:
        return " ".join(parts + ["Con tan pocas decisiones por grupo todavía no se puede decir dónde sale o mantiene bien o mal."])
    best, worst = max(cands, key=lambda c: c[0]), min(cands, key=lambda c: c[0])
    verb = {"MANTENER": "mantener", "CERRAR": "cerrar"}
    if best[0] > 0:
        parts.append("Donde mejor decide: {} cuando está en «{}» ({} decisiones; acertó el {} y ganó {} más que la alternativa a 4 h).".format(
            verb[best[1]], best[2], best[3]["n"], _share(best[3]["better"]), _pct_bp(best[0], 2)))
    if worst[0] < 0:
        parts.append("Donde peor decide: {} cuando está en «{}» ({} decisiones; acertó el {} y perdió {} frente a la alternativa a 4 h).".format(
            verb[worst[1]], worst[2], worst[3]["n"], _share(worst[3]["better"]), _pct_bp(-worst[0], 2)))
    if best[0] <= 0:
        parts.append("En ningún grupo con datos suficientes lo que eligió superó a la alternativa.")
    return " ".join(parts)


# --------------------------------------------------------------------------- B3: does confidence rank outcomes


def order_signals(orders_json):
    """``(margin, agree)``: the logit margin between the two most likely options (mean over the orders asked) and 1.0 / 0.0
    for both orders picking the same option (``None`` with a single order)."""
    orders = json.loads(orders_json) if isinstance(orders_json, str) else orders_json
    if not orders:
        return None, None
    margins, picks = [], []
    for o in orders:
        probs = o.get("probabilities")
        if not probs:
            continue
        ranked = sorted(probs.values(), reverse=True)
        top2 = max(ranked[1], 1e-9) if len(ranked) > 1 else 1e-9
        margins.append(math.log(max(ranked[0], 1e-9)) - math.log(top2))
        picks.append(max(probs, key=lambda k: (probs[k], k in qt.SAFE_FIRST)))
    if not margins:
        return None, None
    return statistics.fmean(margins), (None if len(picks) < 2 else float(picks[0] == picks[1]))


SIGNALS = (("p", "Probabilidad de lo que eligió"), ("margin", "Margen entre las dos primeras opciones"),
           ("agree", "Acuerdo entre los dos órdenes"))


def confidence_samples(data, prows):
    """Outcome groups: entries (net result of the trade it opened) and exits at 1 h / 4 h (gain of the choice over the
    alternative), the latter also split by MANTENER / CERRAR because the action itself changes both the confidence and the
    result."""
    trades = {(t["block_id"], t["trade_no"]): t for t in data["trades"]}
    groups = collections.OrderedDict()

    def add(name, row, result):
        if result is None:
            return
        margin, agree = order_signals(row["orders_json"])
        groups.setdefault(name, []).append({"block_id": row["block_id"], "t_ms": row["t_ms"], "fold": row["fold"], "result": result,
                                            "good": result > EPS, "p": row["p_action"], "margin": margin, "agree": agree})
    entry_rows = [d for d in data["decisions"] if d["kind"] == "flat" and d.get("action") in ("LARGO", "CORTO") and d.get("trade_no")
                  and d.get("p_action") is not None]
    groups["Entradas (resultado de la operación)"] = []
    for d in entry_rows:
        t = trades.get((d["block_id"], d["trade_no"]))
        add("Entradas (resultado de la operación)", {"block_id": d["block_id"], "t_ms": d["t_ms"], "fold": d["fold"],
                                                       "p_action": d["p_action"], "orders_json": d["orders_json"]},
            None if t is None else t["net_bp"])
    for horizon, label in (("1h", "1 h"), ("4h", "4 h")):
        for suffix, pred in ((" (todas)", lambda r: True), (" · solo MANTENER", lambda r: r["action"] == "MANTENER"),
                             (" · solo CERRAR", lambda r: r["action"] == "CERRAR")):
            if horizon == "1h" and suffix != " (todas)":
                continue
            name = "Salidas a {}{}".format(label, suffix)
            groups.setdefault(name, [])
            for r in prows:
                if r["p_action"] is not None and pred(r):
                    add(name, r, r["gain"][horizon])
    return groups


def _signal_rows(samples, signal):
    return [dict(r, score=r[signal]) for r in samples if r.get(signal) is not None]


MIN_RANK_N = 30


def confidence_analysis(data, prows, *, seed):
    """For each outcome group and signal: validation AUC with its block-bootstrap interval, rank correlation, top-vs-bottom
    quintile, and the verdict. Pure: same input, same output."""
    groups = confidence_samples(data, prows)
    out = []
    for name, samples in groups.items():
        for signal, slabel in SIGNALS:
            val = _signal_rows([r for r in samples if r["fold"] == "validation"], signal)
            allr = _signal_rows(samples, signal)
            row = {"group": name, "signal": signal, "label": slabel, "n_val": len(val), "n_all": len(allr), "auc": None,
                   "lo": None, "hi": None, "rho": None, "top": None, "bottom": None, "verdict": "pocos datos", "auc_all": None}
            row["auc_all"] = auc([r["score"] for r in allr], [r["good"] for r in allr]) if allr else None
            if len(val) >= MIN_RANK_N and len({r["good"] for r in val}) == 2:
                row["auc"] = auc([r["score"] for r in val], [r["good"] for r in val])
                row["lo"], row["hi"] = auc_ci(val, _stable_seed(seed, "auc", name, signal))
                row["rho"] = spearman([r["score"] for r in val], [r["result"] for r in val])
                row["top"], row["bottom"], _, _ = top_bottom(val)
                if row["lo"] is None:
                    row["verdict"] = "pocos bloques"
                elif row["lo"] > 0.5:
                    row["verdict"] = "ordena"
                elif row["hi"] < 0.5:
                    row["verdict"] = "ordena al revés"
                else:
                    row["verdict"] = "no ordena"
            out.append(row)
    return out


def calibration_map(samples, signal="p"):
    """Isotonic map from the signal to the share of good outcomes, fitted on the CALIBRATION fold only."""
    fit = [r for r in samples if r["fold"] == "calibration" and r.get(signal) is not None]
    if len(fit) < MIN_RANK_N or len({r["good"] for r in fit}) < 2:
        return None
    return isotonic_fit([r[signal] for r in fit], [1.0 if r["good"] else 0.0 for r in fit])


def calibration_table(samples, bins=5):
    """Validation quintiles of Qwen's probability: what it says, the calibrated value and what happened."""
    model = calibration_map(samples)
    val = sorted((r for r in samples if r["fold"] == "validation" and r.get("p") is not None), key=lambda r: (r["p"], r["block_id"], r["t_ms"]))
    if model is None or len(val) < bins * 5:
        return None
    rows = []
    for i in range(bins):
        chunk = val[i * len(val) // bins:(i + 1) * len(val) // bins]
        rows.append({"low": chunk[0]["p"], "high": chunk[-1]["p"], "n": len(chunk), "said": statistics.fmean(r["p"] for r in chunk),
                     "calibrated": statistics.fmean(isotonic_predict(model, r["p"]) for r in chunk),
                     "observed": sum(1 for r in chunk if r["good"]) / len(chunk)})
    return rows


def confidence_conclusion(results):
    usable = [r for r in results if r["auc"] is not None]
    if not usable:
        return ("Todavía no hay suficientes decisiones en el tramo de validación para saber si su seguridad ordena los "
                "resultados.")
    ordering = [r for r in usable if r["verdict"] == "ordena"]
    reverse = [r for r in usable if r["verdict"] == "ordena al revés"]
    if not ordering:
        text = ("**Su seguridad no ordena los resultados: en ninguna de las {} pruebas el intervalo de confianza del AUC deja "
                "de incluir 0,5. La confianza de Qwen no lleva información y no debe usarse como filtro** (ni la probabilidad, "
                "ni el margen, ni el acuerdo entre órdenes).".format(len(usable)))
        if reverse:
            text += " Incluso en {} caso(s) va al revés ({}).".format(len(reverse), "; ".join("{} · {}".format(r["group"], r["label"].lower()) for r in reverse))
        return text
    best = max(ordering, key=lambda r: r["auc"])
    return ("Su seguridad **ordena** en {} de las {} pruebas. La mejor señal es «{}» para «{}»: AUC {} (IC 95 % {} a {}). Ojo: con "
            "tantas pruebas, alguna puede salir bien por casualidad; mirar si se repite en los otros horizontes antes de usarla "
            "como filtro.".format(len(ordering), len(usable), best["label"].lower(), best["group"], _es(best["auc"], 2),
                                  _es(best["lo"], 2), _es(best["hi"], 2)))


def confidence_lines(data, prows, *, seed, results=None):
    results = results if results is not None else confidence_analysis(data, prows, seed=seed)
    samples = confidence_samples(data, prows)
    lines = ["## ¿Sirve su seguridad para ordenar los resultados?", "",
             "Se mira si, cuando Qwen está más seguro, le va mejor. Tres señales de seguridad: la probabilidad que le da a lo "
             "que eligió, el margen entre sus dos primeras opciones (diferencia de logaritmos de probabilidad, promedio de los dos "
             "órdenes) y si los dos órdenes de opciones coinciden. Para cada una: **AUC** (probabilidad de que una decisión buena "
             "tenga más seguridad que una mala; 0,5 = no ordena nada, 1 = ordena perfecto), su intervalo de confianza de 95 % "
             "(remuestreando bloques enteros), la correlación de rangos con el resultado y el promedio del 20 % más seguro frente "
             "al 20 % menos seguro. Todo en el tramo de validación; «bueno» = resultado mayor que cero (entradas) o la elección "
             "dio más que la alternativa (salidas).", "", confidence_conclusion(results), ""]
    table = []
    for r in results:
        if r["auc"] is None:
            table.append([r["group"], r["label"], r["n_val"], "n/d", "n/d", "n/d", "n/d", "n/d", r["verdict"]])
            continue
        table.append([r["group"], r["label"], r["n_val"], "{} [{} a {}]".format(_es(r["auc"], 2), _es(r["lo"], 2), _es(r["hi"], 2)),
                      _es(r["rho"], 2, True), _pct_bp(r["top"], 2, True) if r["top"] is not None else "n/d",
                      _pct_bp(r["bottom"], 2, True) if r["bottom"] is not None else "n/d",
                      _es(r["auc_all"], 2), "**{}**".format(r["verdict"])])
    lines += _table(["Resultado", "Señal", "Decisiones (validación)", "AUC [IC 95 %]", "Correlación de rangos", "Promedio del 20 % más seguro",
                     "Promedio del 20 % menos seguro", "AUC con todo", "Veredicto"], table) + [""]
    lines += ["**Calibración con isotónica** (ajustada solo con el tramo de calibración y comparada con lo observado en validación): "
              "para cada quinto de las decisiones de validación, ordenadas por la probabilidad de Qwen.", ""]
    for name in ("Entradas (resultado de la operación)", "Salidas a 4 h (todas)"):
        table = calibration_table(samples.get(name, []))
        lines += ["**{}**".format(name), ""]
        if table is None:
            lines += ["Sin datos suficientes en calibración o validación.", ""]
            continue
        lines += _table(["Probabilidad de Qwen", "Decisiones", "Qwen decía", "Calibrada", "Observado (fueron buenas)"],
                        [["{}–{}".format(_es(t["low"], 3), _es(t["high"], 3)), t["n"], _share(t["said"]), _share(t["calibrated"]),
                          _share(t["observed"])] for t in table]) + [""]
    return lines


# --------------------------------------------------------------------------- C1: surrogate model of Qwen

FEATURE_TEXT = {
    "ret_1h": ("el retorno de 1 h", "{} %"), "ret_4h": ("el retorno de 4 h", "{} %"), "ret_24h": ("el retorno de 24 h", "{} %"),
    "ret_7d": ("el retorno de 7 d", "{} %"), "z_1h": ("la tendencia de 1 h (en ruidos normales)", "{}"),
    "z_4h": ("la tendencia de 4 h (en ruidos normales)", "{}"), "z_24h": ("la tendencia de 24 h (en ruidos normales)", "{}"),
    "z_7d": ("la tendencia de 7 d (en ruidos normales)", "{}"), "vol24": ("la volatilidad diaria", "{} %"),
    "mov15_z": ("el movimiento de 15 min (en ruidos normales)", "{}"), "dist_max24": ("la distancia al máximo de 24 h", "{} %"),
    "dist_min24": ("la distancia al mínimo de 24 h", "{} %"), "dist_max7": ("la distancia al máximo de 7 d", "{} %"),
    "dist_min7": ("la distancia al mínimo de 7 d", "{} %"), "vol_1h_rel": ("el volumen de la última hora (x el promedio)", "{}"),
    "funding_rate": ("el funding por hora", "{} %"), "funding_pct": ("el percentil del funding", "{}"),
    "side": ("la posición", ""), "open_h": ("el tiempo abierta", "{} h"), "pnl_pct": ("el resultado actual", "{} %"),
    "pnl_sigma": ("el resultado actual en σ de 4 h", "{}"), "favor": ("el movimiento a favor desde que abrió", "{} %"),
    "wake_fuerte": ("despertó por un movimiento fuerte", ""), "wake_grande": ("despertó por un movimiento grande en la posición", ""),
}
FLAT_FEATURES = ("ret_1h", "ret_4h", "ret_24h", "ret_7d", "z_1h", "z_4h", "z_24h", "z_7d", "vol24", "mov15_z", "dist_max24",
                 "dist_min24", "dist_max7", "dist_min7", "vol_1h_rel", "funding_rate", "funding_pct", "wake_fuerte")
POSITION_FEATURES = FLAT_FEATURES + ("side", "open_h", "pnl_pct", "pnl_sigma", "favor", "wake_grande")
SURROGATE_KINDS = (("flat", "Sin posición (LARGO, CORTO o ESPERAR)", FLAT_FEATURES, ("ESPERAR", "LARGO", "CORTO")),
                   ("position", "Con posición (MANTENER o CERRAR)", POSITION_FEATURES, ("MANTENER", "CERRAR")))


def feature_vector(text):
    f = st.extract(text or "")
    out = dict(f)
    if f.get("norm15"):
        out["mov15_z"] = f.get("mov15", 0.0) / f["norm15"]
    if "open_min" in f:
        out["open_h"] = f["open_min"] / 60.0
    if f.get("vol24") and "pnl_pct" in f:
        out["pnl_sigma"] = f["pnl_pct"] / (f["vol24"] / math.sqrt(6.0))
    out["wake_fuerte"] = 1.0 if "movimiento_fuerte" in f["wake"] else 0.0
    out["wake_grande"] = 1.0 if "movimiento_grande_en_posicion" in f["wake"] else 0.0
    return out


def surrogate_rows(data, kind):
    rows = []
    for d in data["decisions"]:
        if d["kind"] != kind or d.get("model_action") is None or not d.get("state_text"):
            continue
        rows.append({"fold": d["fold"], "y": d["model_action"], "x": feature_vector(d["state_text"]), "block_id": d["block_id"], "t_ms": d["t_ms"]})
    return rows


def _gini(counts):
    n = sum(counts.values())
    return 1.0 - sum((c / n) ** 2 for c in counts.values()) if n else 0.0


def fit_tree(xs, ys, features, *, depth=3, min_leaf=8):
    """CART with Gini impurity and candidate cuts at the quantiles of each feature. Missing values count as the feature's
    median of the training rows (the same one is used to predict). Returns a nested dict."""
    medians = {}
    for f in features:
        vals = sorted(x[f] for x in xs if f in x)
        medians[f] = vals[len(vals) // 2] if vals else 0.0
    data = [([x.get(f, medians[f]) for f in features], y) for x, y in zip(xs, ys)]

    def build(items, level):
        counts = collections.Counter(y for _, y in items)
        node = {"counts": dict(counts), "n": len(items)}
        if level >= depth or len(items) < 2 * min_leaf or len(counts) == 1:
            return node
        base, best = _gini(counts), None
        for j, f in enumerate(features):
            values = sorted({row[j] for row, _ in items})
            if len(values) < 2:
                continue
            cuts = sorted({(values[int(q * (len(values) - 1))] + values[min(len(values) - 1, int(q * (len(values) - 1)) + 1)]) / 2.0
                           for q in [i / 16.0 for i in range(1, 16)]})
            for cut in cuts:
                left = [it for it in items if it[0][j] <= cut]
                right = [it for it in items if it[0][j] > cut]
                if len(left) < min_leaf or len(right) < min_leaf:
                    continue
                score = base - (len(left) * _gini(collections.Counter(y for _, y in left)) +
                                len(right) * _gini(collections.Counter(y for _, y in right))) / len(items)
                if best is None or score > best[0] + 1e-12:
                    best = (score, j, cut, left, right)
        if best is None or best[0] <= 1e-9:
            return node
        node.update(feature=features[best[1]], cut=best[2], left=build(best[3], level + 1), right=build(best[4], level + 1))
        return node
    return {"root": build(data, 0), "features": list(features), "medians": medians}


def tree_predict(tree, x):
    node = tree["root"]
    while "feature" in node:
        v = x.get(node["feature"], tree["medians"][node["feature"]])
        node = node["left"] if v <= node["cut"] else node["right"]
    return max(node["counts"], key=lambda k: (node["counts"][k], k in qt.SAFE_FIRST))


def tree_rules(tree):
    """Leaves as ``(conditions, action, share, n)``; a condition is ``(feature, '≤' | '>', cut)``."""
    out = []

    def walk(node, path):
        if "feature" not in node:
            action = max(node["counts"], key=lambda k: (node["counts"][k], k in qt.SAFE_FIRST))
            out.append((path, action, node["counts"][action] / node["n"], node["n"]))
            return
        walk(node["left"], path + [(node["feature"], "≤", node["cut"])])
        walk(node["right"], path + [(node["feature"], ">", node["cut"])])
    walk(tree["root"], [])
    return out


def _num_text(feature, cut):
    template = FEATURE_TEXT[feature][1]
    places = 2 if feature in ("ret_1h", "ret_4h", "ret_24h", "ret_7d", "pnl_pct", "favor", "vol24") else 4 if feature == "funding_rate" else 0 if feature == "funding_pct" else 1
    return template.format(qt.es(cut, places, feature not in ("vol24", "open_h", "funding_pct", "vol_1h_rel")))


def condition_text(feature, op, cut):
    label = FEATURE_TEXT[feature][0]
    if feature == "side":
        return "es un largo" if op == ">" else "es un corto"
    if feature.startswith("wake_"):
        return label if op == ">" else "no " + label
    if feature == "open_h":
        return "lleva abierta {} {}".format("más de" if op == ">" else "hasta", _num_text(feature, cut))
    return "{} {} {}".format(label, "es mayor que" if op == ">" else "no pasa de", _num_text(feature, cut))


def rule_sentence(rule):
    path, action, share, n = rule
    merged = {}
    for f, op, cut in path:                       # keep the tightest bound of each feature and direction
        key = (f, op)
        merged[key] = max(merged.get(key, cut), cut) if op == ">" else min(merged.get(key, cut), cut)
    conds = " y ".join(condition_text(f, op, cut) for (f, op), cut in merged.items()) or "siempre"
    return "Cuando {}, elige **{}** ({} de {} decisiones).".format(conds, action, _share(share), n)


def fit_logistic(rows, features, positive, *, ridge=1.0, iterations=12):
    """Standardized logistic regression for ``y == positive`` (Newton steps, L2 on the slopes). Returns
    ``{means, stds, coef, bias}`` or ``None`` when one class is missing."""
    ys = [1.0 if r["y"] == positive else 0.0 for r in rows]
    if not 0 < sum(ys) < len(ys):
        return None
    medians = {}
    for f in features:
        vals = sorted(r["x"][f] for r in rows if f in r["x"])
        medians[f] = vals[len(vals) // 2] if vals else 0.0
    raw = [[r["x"].get(f, medians[f]) for f in features] for r in rows]
    means = [statistics.fmean(c) for c in zip(*raw)]
    stds = [(statistics.pstdev(c) or 1.0) for c in zip(*raw)]
    z = [[1.0] + [(v - m) / s for v, m, s in zip(row, means, stds)] for row in raw]
    k = len(features) + 1
    w = [0.0] * k
    for _ in range(iterations):
        grad, hess = [0.0] * k, [[0.0] * k for _ in range(k)]
        for row, y in zip(z, ys):
            p = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, sum(a * b for a, b in zip(w, row))))))
            for i in range(k):
                grad[i] += (p - y) * row[i]
                for j in range(i, k):
                    hess[i][j] += p * (1 - p) * row[i] * row[j]
        for i in range(1, k):
            grad[i] += ridge * w[i]
            hess[i][i] += ridge
        for i in range(k):
            hess[i][i] += 1e-6
            for j in range(i):
                hess[i][j] = hess[j][i]
        step = _solve(hess, grad)
        if step is None:
            break
        w = [a - b for a, b in zip(w, step)]
        if max(abs(s) for s in step) < 1e-6:
            break
    return {"means": means, "stds": stds, "coef": dict(zip(features, w[1:])), "bias": w[0], "medians": medians, "features": list(features)}


def _solve(a, b):
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[piv][c]) < 1e-12:
            return None
        m[c], m[piv] = m[piv], m[c]
        for r in range(n):
            if r != c:
                factor = m[r][c] / m[c][c]
                for j in range(c, n + 1):
                    m[r][j] -= factor * m[c][j]
    return [m[i][n] / m[i][i] for i in range(n)]


def logistic_prob(model, x):
    s = model["bias"] + sum(model["coef"][f] * (x.get(f, model["medians"][f]) - m) / sd
                            for f, m, sd in zip(model["features"], model["means"], model["stds"]))
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, s))))


def surrogate(data, kind, features, classes):
    """Fits tree and logistic regression on the CALIBRATION fold and measures how often each one picks what Qwen picked on
    the VALIDATION fold, against always saying the most common action."""
    rows = surrogate_rows(data, kind)
    cal = [r for r in rows if r["fold"] == "calibration"]
    val = [r for r in rows if r["fold"] == "validation"]
    out = {"kind": kind, "n_cal": len(cal), "n_val": len(val), "counts": collections.Counter(r["y"] for r in rows)}
    if len(cal) < 40 or len({r["y"] for r in cal}) < 2:
        out["status"] = "pocos datos"
        return out
    present = [c for c in classes if any(r["y"] == c for r in cal)]
    tree = fit_tree([r["x"] for r in cal], [r["y"] for r in cal], features, depth=3, min_leaf=max(8, len(cal) // 50))
    positives = present[1:] if len(present) == 2 else present
    models = {c: fit_logistic(cal, features, c) for c in positives}
    models = {c: m for c, m in models.items() if m is not None}

    def logit_pick(x):
        if len(present) == 2 and present[1] in models:
            return present[1] if logistic_prob(models[present[1]], x) > 0.5 else present[0]
        if not models:
            return present[0]
        return max(models, key=lambda c: logistic_prob(models[c], x))
    majority = collections.Counter(r["y"] for r in cal).most_common(1)[0][0]
    judged, label = (val, "validación") if len(val) >= 20 else (cal, "calibración (sin validación suficiente: es el ajuste, no una prueba)")
    out.update(status="ok", tree=tree, models=models, present=present, judged=label, n_judged=len(judged), majority=majority,
               agree_tree=sum(1 for r in judged if tree_predict(tree, r["x"]) == r["y"]) / len(judged),
               agree_logit=sum(1 for r in judged if logit_pick(r["x"]) == r["y"]) / len(judged),
               agree_base=sum(1 for r in judged if r["y"] == majority) / len(judged), rules=tree_rules(tree))
    return out


def direction_sentences(result, top=5):
    sentences = []
    for cls, model in result["models"].items():
        ranked = sorted(model["coef"].items(), key=lambda kv: -abs(kv[1]))[:top]
        for f, c in ranked:
            if abs(c) < 0.05:
                continue
            label = FEATURE_TEXT[f][0]
            if f == "side":
                sentences.append("Es más probable que elija {} si es un {}".format(cls, "largo" if c > 0 else "corto"))
            elif f.startswith("wake_"):
                sentences.append("Es {} probable que elija {} cuando {}".format("más" if c > 0 else "menos", cls, label))
            else:
                sentences.append("Es {} probable que elija {} cuanto mayor es {} (peso {})".format(
                    "más" if c > 0 else "menos", cls, label, _es(c, 2, True)))
    return sentences


def surrogate_lines(data):
    lines = ["## ¿Por qué decide lo que decide? (modelo que lo imita)", "",
             "Sin llamar al modelo: se ajusta un árbol de decisión (profundidad máxima 3) y una regresión logística estandarizada "
             "que intentan adivinar la elección de Qwen solo con los números que vio en el prompt. Se ajustan con el tramo de "
             "calibración y se juzgan en el de validación. **Describe la conducta de Qwen, no la verdad del mercado**: que una regla "
             "explique sus decisiones no significa que sea una buena regla para operar.", ""]
    for kind, title, features, classes in SURROGATE_KINDS:
        r = surrogate(data, kind, features, classes)
        lines += ["### {}".format(title), ""]
        if r["status"] != "ok":
            lines += ["Todavía no hay decisiones suficientes ({} de calibración) para ajustar un modelo.".format(r["n_cal"]), ""]
            continue
        lines += ["Reparto de lo que eligió: {}. En {} ({} decisiones) el árbol acierta lo que eligió Qwen en el **{}**, la regresión "
                  "logística en el **{}**, y decir siempre «{}» acertaría el {}.".format(
                      ", ".join("{} {}".format(k, v) for k, v in r["counts"].most_common()), r["judged"], r["n_judged"],
                      _share(r["agree_tree"]), _share(r["agree_logit"]), r["majority"], _share(r["agree_base"])), ""]
        gain = max(r["agree_tree"], r["agree_logit"]) - r["agree_base"]
        lines += [("Los modelos imitan a Qwen {} que la respuesta fija: {}.".format(
            "claramente mejor" if gain > 0.05 else "apenas mejor" if gain > 0.01 else "igual o peor",
            "sus decisiones dependen de los números que ve" if gain > 0.05 else "con estos números no se explica bien qué lo mueve")), ""]
        lines += ["**Reglas del árbol** (cada hoja es lo que más eligió Qwen en ese caso):", ""]
        lines += ["- " + rule_sentence(rule) for rule in sorted(r["rules"], key=lambda x: -x[3]) if rule[3] >= 5] + [""]
        sentences = direction_sentences(r)
        if sentences:
            lines += ["**Lo que más pesa en la regresión** (los cinco rasgos de mayor peso por acción):", ""]
            lines += ["- " + s for s in sentences] + [""]
    return lines


# --------------------------------------------------------------------------- v2 against v2.1 on identical states


def prompt_comparison(data, other):
    """Decisions that both runs took on the SAME state text (same block, time, kind and state hash): how often the choice is
    the same. Runs whose trajectories diverged no longer share states, so this is a floor of the real overlap."""
    mine = {(d["block_id"], d["t_ms"], d["kind"], d["state_hash"]): d for d in data["decisions"] if d.get("model_action")}
    out = {k: {"n": 0, "same": 0, "flips": collections.Counter(), "dp": []} for k in ("flat", "position")}
    for d in other["decisions"]:
        key = (d["block_id"], d["t_ms"], d["kind"], d["state_hash"])
        if key not in mine or not d.get("model_action"):
            continue
        row = out[d["kind"]]
        row["n"] += 1
        row["same"] += int(mine[key]["model_action"] == d["model_action"])
        if mine[key]["model_action"] != d["model_action"]:
            row["flips"]["{} → {}".format(d["model_action"], mine[key]["model_action"])] += 1
    return out


def prompt_comparison_lines(data, cfg, other, other_cfg):
    res = prompt_comparison(data, other)
    label, old = "v{}".format(cfg.get("version")), "v{}".format(other_cfg.get("version"))
    lines = ["## {} contra {}: ¿cambió lo que decide al cambiar el orden del prompt?".format(old, label), "",
             "{} solo cambia el orden del texto (lo fijo primero, el estado al final) y «de arriba» por «de abajo»: es un cambio de "
             "rendimiento, no de criterio. Aquí se comparan las decisiones que las dos corridas tomaron con **el mismo estado** "
             "(mismo bloque, hora y números). Cuando las operaciones empiezan a diferir, los estados dejan de coincidir y esas "
             "decisiones ya no se comparan. Para una prueba directa y barata: `compare-prompts`.".format(label), ""]
    total = sum(r["n"] for r in res.values())
    if not total:
        return lines + ["Todavía no hay decisiones con el mismo estado en las dos bases.", ""]
    rows = [[{"flat": "Sin posición", "position": "Con posición"}[k], r["n"], _share(r["same"] / r["n"]),
             ", ".join("{} ({})".format(a, b) for a, b in r["flips"].most_common()) or "ninguno"] for k, r in res.items() if r["n"]]
    lines += _table(["Momento", "Decisiones con el mismo estado", "Misma elección", "Cambios"], rows) + [""]
    same = sum(r["same"] for r in res.values())
    lines += ["Coincidieron en el **{}** de {} decisiones.".format(_share(same / total, 1), total), ""]
    return lines


# --------------------------------------------------------------------------- probes


def probe_summary(results):
    """``(rows, sentence)`` from ``probe.probe_results``; a feature counts as «mira» when its flips clearly exceed those of
    simply asking the same thing again."""
    control = results.get(probe.CONTROL, {"levels": {}})
    base_flip = max([v["flip"] for v in control["levels"].values()] or [0.0])
    base_shift = max([v["shift"] for v in control["levels"].values()] or [0.0])
    rows = []
    for name, entry in results.items():
        if name == probe.CONTROL:
            continue
        lv = entry["levels"]
        flips = [lv[k]["flip"] for k in ("bajo", "alto") if k in lv]
        shifts = [lv[k]["shift"] for k in ("bajo", "alto") if k in lv]
        rows.append({"name": name, "entry": entry, "flip": max(flips) if flips else 0.0, "shift": max(shifts) if shifts else 0.0})
    rows.sort(key=lambda r: (-r["flip"], -r["shift"], r["name"]))
    looks = [r for r in rows if r["flip"] > base_flip + 0.05 or r["shift"] > base_shift + 0.05]
    ignores = [r for r in rows if r["flip"] <= base_flip + 0.02 and r["shift"] <= base_shift + 0.02]
    parts = []
    if looks:
        parts.append("Los datos que realmente mira (su decisión cambia o su probabilidad se mueve claramente más que al repetir la "
                     "misma pregunta): " + ", ".join(probe.FEATURES[r["name"]][0] for r in looks[:5]) + ".")
    else:
        parts.append("Ningún dato movió su decisión más que el ruido de repetir la pregunta: con estos cambios no se ve qué mira.")
    if ignores:
        parts.append("Los que casi no mira: " + ", ".join(probe.FEATURES[r["name"]][0] for r in ignores[:5]) + ".")
    return rows, base_flip, base_shift, " ".join(parts)


def probe_lines(db_path):
    results = probe.probe_results(db_path)
    if not results:
        return []
    rows, base_flip, base_shift, sentence = probe_summary(results)
    lines = ["## ¿Qué datos mira de verdad? (sondas)", "",
             "Se tomó una muestra de decisiones guardadas y se volvió a preguntar el **mismo prompt** cambiando **un solo número** del "
             "estado a la vez (los demás quedan idénticos): primero a un valor bajo (percentil 10 de las decisiones guardadas del mismo "
             "producto y tipo) y luego a uno alto (percentil 90), así los valores son realistas. «Cambia de decisión» es el porcentaje de "
             "decisiones cuya elección final se da vuelta; «Cambio de probabilidad» es cuánto se mueve la probabilidad de lo que había "
             "elegido. La fila «repetir sin cambiar nada» es el piso de ruido. Cada retorno cambia también su «tendencia»; el resultado "
             "de la posición, en % y en USD.", "", sentence, ""]
    ctl = results.get(probe.CONTROL)
    table = []
    if ctl:
        c = next(iter(ctl["levels"].values()))
        table.append(["_repetir sin cambiar nada_", ctl["decisions"], _share(c["flip"]), "—", _es(c["shift"] * 100, 1) + " pts", "—", "ruido"])

    def effect(entry):
        alto = entry["levels"].get("alto") or entry["levels"].get("bajo")
        o, v = max(alto["delta"].items(), key=lambda kv: abs(kv[1]))
        if abs(v) < 0.005:
            return "sin efecto"
        return "con valor alto, {} {} {} pts".format(o, "sube" if v > 0 else "baja", _es(abs(v) * 100, 1))
    for r in rows:
        lv = r["entry"]["levels"]
        table.append([probe.FEATURES[r["name"]][0], r["entry"]["decisions"], _share(lv["bajo"]["flip"]) if "bajo" in lv else "n/d",
                      _share(lv["alto"]["flip"]) if "alto" in lv else "n/d",
                      "{} / {} pts".format(*(_es(lv[k]["shift"] * 100, 1) if k in lv else "n/d" for k in ("bajo", "alto"))),
                      effect(r["entry"]), "**mira**" if r["flip"] > base_flip + 0.05 or r["shift"] > base_shift + 0.05 else ""])
    lines += _table(["Dato", "Decisiones", "Cambia de decisión (valor bajo)", "Cambia de decisión (valor alto)",
                     "Cambio de probabilidad (bajo / alto)", "Efecto principal", ""], table) + [""]
    lines += ["_Las sondas describen cómo reacciona Qwen a un número aislado; los números reales vienen juntos, así que un cambio "
              "aislado puede ser algo que nunca ocurre exactamente así._", ""]
    return lines


GLOSSARY = [
    "- **AUC**: la probabilidad de que, tomando una decisión buena y una mala al azar, la buena tenga más seguridad. 0,5 es lo "
    "mismo que tirar una moneda (la seguridad no sirve), 1 es perfecto y por debajo de 0,5 la seguridad va al revés.",
    "- **IC 95 %**: el rango donde, con 95 % de confianza, está el valor verdadero; si el AUC puede ser 0,5 dentro del rango, no se "
    "puede afirmar que ordene.",
    "- **Margen entre las dos primeras opciones**: cuánto más probable es lo que eligió que su segunda opción, en logaritmo de la "
    "probabilidad; es otra forma de medir la seguridad.",
    "- **Acuerdo entre órdenes**: si al preguntar con las opciones en dos órdenes distintos Qwen elige lo mismo.",
    "- **Calibración isotónica**: una escala que convierte la probabilidad de Qwen en el porcentaje de veces que de verdad salió bien, "
    "aprendida solo con el tramo de calibración y comprobada en validación.",
    "- **σ de 4 h**: lo que suele moverse el precio en 4 horas (la volatilidad diaria dividida por √6); mide si una ganancia o pérdida "
    "es pequeña o grande.",
    "- **Qué habría pasado con la otra opción**: se recalcula, con costos y funding, lo que habría dado la elección contraria con las "
    "velas del mismo bloque; no es una predicción.",
    "- **Modelo que lo imita (árbol / regresión)**: un modelo simple que intenta adivinar lo que elegirá Qwen mirando los números del "
    "prompt; describe su conducta, no el mercado.",
    "- **Sonda**: volver a hacerle a Qwen la misma pregunta cambiando un solo número del estado, para ver si eso cambia su decisión.",
]
