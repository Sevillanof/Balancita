"""Informe de «Qwen operador» (Markdown en español claro), a partir de la base de práctica. No usa el modelo.

Las reglas del veredicto se fijaron antes de mirar resultados (``config/qwen-trader.json``, ``rules``; mismos umbrales que la
compuerta de estrategias donde tienen sentido) y se aplican SOLO al tramo de validación (el 40 % más nuevo de los bloques),
con el umbral de entrada elegido en el tramo de calibración (el 60 % más viejo). Así el veredicto no se mide con los mismos
datos con los que se eligió el umbral.
"""

import array
import collections
import json
import random
import statistics

from . import futures_qwen_trader as qt
from .futures_costs import COST_MODEL_VERSION
from .futures_qwen_practice_report import bootstrap_ci
from .strategy_gate import (
    FAIL, INCONCLUSIVE, PASS, _es, _factor, _mark, _pct_bp, _share, _stable_seed, _table, _usd, percentile_in,
    summarize, trade_cost_bp, _quantile)

BIN_EDGES = (0.0, 0.5, 0.6, 0.7, 0.8, 1.01)


# --------------------------------------------------------------------------- reading


def load(db_path):
    """Everything the report needs, read-only."""
    pdb = qt.PracticeDB(db_path, readonly=True)
    try:
        data = {"meta": pdb.meta()}
        data["blocks"] = {}
        for r in pdb.db.execute("SELECT * FROM blocks WHERE status='done'"):
            closes = array.array("d")
            closes.frombytes(r["closes"] or b"")
            data["blocks"][r["block_id"]] = {
                "block_id": r["block_id"], "product": r["product"], "start_ms": r["start_ms"], "end_ms": r["end_ms"],
                "bin": r["time_bin"], "fold": r["fold"], "wakes": r["wakes"], "closes": list(closes)}
        data["trades"] = [dict(r) for r in pdb.db.execute("SELECT * FROM trades ORDER BY exit_ms, entry_ms")]
        data["decisions"] = [dict(r) for r in pdb.db.execute(
            "SELECT block_id, seq, t_ms, kind, product, fold, model_action, p_action, action, override, reason, "
            "orders_json, outcome_json, net_bp_now, latency_ms, wake_json, prompt_version FROM decisions")]
        data["calls"] = dict(pdb.db.execute("SELECT COUNT(*) AS n, AVG(latency_ms) AS mean_ms FROM calls").fetchone())
        data["runs"] = [dict(r) for r in pdb.db.execute("SELECT * FROM runs ORDER BY id")]
        return data
    finally:
        pdb.close()


# --------------------------------------------------------------------------- the judgement


def random_means(trades, blocks, *, draws, seed):
    """Mean net bp (before funding) of ``draws`` books that enter at a random moment of the SAME block, same side and holding
    time as each trade, with the same costs. Returns ``(means, skipped)``."""
    prepared, skipped = collections.defaultdict(list), 0
    for t in trades:
        block = blocks.get(t["block_id"])
        hold = max(1, int(round(t["hold_min"] / 5.0)))
        if block is None or len(block["closes"]) - 1 - hold < 0:
            skipped += 1
            continue
        prepared[t["block_id"]].append((1.0 if t["side"] == "LONG" else -1.0, hold, trade_cost_bp(t["product"], "time_stop")))
    count = sum(len(v) for v in prepared.values())
    if count == 0:
        return [], skipped
    sums = [0.0] * draws
    for block_id in sorted(prepared):
        closes = blocks[block_id]["closes"]
        rng = random.Random(_stable_seed(seed, "random", block_id))
        for sign, hold, cost in prepared[block_id]:
            span = len(closes) - hold
            for d in range(draws):
                i = int(rng.random() * span)
                sums[d] += sign * (closes[i + hold] / closes[i] - 1.0) * 10_000 - cost
    return [s / count for s in sums], skipped


def _cost_reason(trade):
    return "stop" if trade["closed_by"] == "stop" else "time_stop"


def judge(trades, blocks, rules, products, *, seed):
    """Applies the predeclared rules to ``trades`` (validation, selected threshold). Pure: same input, same verdict."""
    ordered = sorted(trades, key=lambda t: (t["exit_ms"], t["entry_ms"], t["product"]))
    values = [t["net_bp"] for t in ordered]
    overall = summarize(ordered)
    n = overall["n"]
    ci = bootstrap_ci(values, seed=_stable_seed(seed, "ci"), draws=rules["bootstrap_draws"], level=rules["ci_level"]) \
        if n >= 2 else (None, None)
    means, skipped = random_means(ordered, blocks, draws=rules["random_draws"], seed=seed)
    observed = statistics.fmean([t["net_bp"] + t["funding_bp"] for t in ordered]) if ordered else None
    percentile = percentile_in(means, observed) if means and observed is not None else None
    baseline = None
    if means:
        srt = sorted(means)
        baseline = {"draws": len(means), "p05": _quantile(srt, 0.05), "p50": _quantile(srt, 0.5),
                    "p95": _quantile(srt, 0.95), "mean": statistics.fmean(means), "skipped": skipped,
                    "observed_ex_funding": observed}
    groups = collections.defaultdict(float)
    for t in ordered:
        groups[t["time_bin"]] += t["net_bp"]
    positive_groups = sum(1 for v in groups.values() if v > 0)
    per_product = {p: summarize([t for t in ordered if t["product"] == p]) for p in products}
    positive_products = sum(1 for s in per_product.values() if s["n"] and s["mean_bp"] > 0)
    mult = rules["cost_stress_multiplier"]
    stressed = [t["net_bp"] - (mult - 1.0) * trade_cost_bp(t["product"], _cost_reason(t)) for t in ordered]
    stress_mean = statistics.fmean(stressed) if stressed else None

    def rule(rid, label, value, threshold, ok):
        return {"id": rid, "label": label, "value": value, "threshold": threshold, "ok": bool(ok)}

    checks = [
        rule("n_trades", "Al menos {} operaciones".format(rules["min_trades"]), n, rules["min_trades"],
             n >= rules["min_trades"]),
        rule("mean_net_positive", "Media neta > 0 con el límite inferior del IC {:.0f}% > 0".format(rules["ci_level"] * 100),
             {"mean": overall["mean_bp"], "ci_low": ci[0], "ci_high": ci[1]}, 0,
             overall["mean_bp"] is not None and overall["mean_bp"] > 0 and ci[0] is not None and ci[0] > 0),
        rule("percentile_random", "Percentil frente a entradas al azar >= {}".format(rules["min_percentile_vs_random"]),
             percentile, rules["min_percentile_vs_random"],
             percentile is not None and percentile >= rules["min_percentile_vs_random"]),
        rule("positive_groups", "Positiva en >= {:.0f}% de los grupos de tiempo".format(rules["min_positive_group_share"] * 100),
             {"positive": positive_groups, "total": len(groups)}, rules["min_positive_group_share"],
             len(groups) > 0 and positive_groups >= rules["min_positive_group_share"] * len(groups) - 1e-9),
        rule("positive_products", "Positiva en >= {:.0f}% de los productos".format(rules["min_positive_product_share"] * 100),
             {"positive": positive_products, "total": len(products)}, rules["min_positive_product_share"],
             len(products) > 0 and positive_products >= rules["min_positive_product_share"] * len(products) - 1e-9),
        rule("cost_stress", "Sigue positiva con costos x{}".format(mult), stress_mean, 0,
             stress_mean is not None and stress_mean > 0),
    ]
    others_ok = all(c["ok"] for c in checks if c["id"] != "n_trades")
    note = None
    if n < rules["min_trades"] and others_ok:
        verdict = INCONCLUSIVE
    elif n < rules["min_trades"]:
        verdict, note = FAIL, "(pocas operaciones)"
    else:
        verdict = PASS if all(c["ok"] for c in checks) else FAIL
    return {"verdict": verdict, "verdict_note": note, "rules": checks, "overall": overall, "ci": ci,
            "per_product": per_product, "baseline": baseline, "percentile": percentile, "stress_mean_bp": stress_mean,
            "stress_multiplier": mult, "groups": dict(groups)}


# --------------------------------------------------------------------------- tables


def closed_by_shares(trades):
    counts = collections.Counter(t["closed_by"] for t in trades)
    n = len(trades)
    return {k: (counts[k] / n if n else None) for k in qt.CLOSED_BY}


def stats_row(trades, days):
    s = summarize(trades)
    s["days"] = days
    s["per_day"] = s["n"] / days if days else None
    s["avg_hold_min"] = statistics.fmean([t["hold_min"] for t in trades]) if trades else None
    s["closed"] = closed_by_shares(trades)
    return s


def _hm(minutes):
    return "n/d" if minutes is None else ("{} h {:02d} min".format(int(minutes) // 60, int(minutes) % 60)
                                           if minutes >= 60 else "{} min".format(int(round(minutes))))


MAIN_HEADER = ["Operaciones", "Por día", "Acierto", "Promedio por operación", "Resultado total", "Factor de beneficio",
               "Caída máxima", "Duración media", "Cerró Qwen", "Cerró el stop", "Cerró el límite de 24 h",
               "Cerró el fin del bloque"]


def _main_row(label, s):
    if not s["n"]:
        return [label, 0] + ["n/d"] * (len(MAIN_HEADER) - 1)
    c = s["closed"]
    return [label, s["n"], _es(s["per_day"], 2), _share(s["hit_rate"]), _pct_bp(s["mean_bp"], 2, True),
            _usd(s["total_bp"]), _factor(s["profit_factor"]), _usd(-s["max_drawdown_bp"]), _hm(s["avg_hold_min"]),
            _share(c["qwen"]), _share(c["stop"]), _share(c["tiempo"]), _share(c["fin_de_bloque"])]


def _days(blocks, fold=None, product=None):
    return sum((b["end_ms"] - b["start_ms"]) / qt.DAY_MS for b in blocks.values()
               if (fold is None or b["fold"] == fold) and (product is None or b["product"] == product))


def calibration_tables(decisions):
    """Predicted probability of the chosen action vs how often it was the best of the 1 h window.

    Flat: best = the action with the highest net of {LARGO, CORTO, ESPERAR = 0}. In a position: best = MANTENER when holding
    ended up above closing at that moment."""
    out = {"flat": collections.defaultdict(list), "position": collections.defaultdict(list)}
    for d in decisions:
        if d["p_action"] is None or not d["outcome_json"]:
            continue
        outcome = json.loads(d["outcome_json"])
        if d["kind"] == "flat":
            if outcome.get("long_net_bp") is None:
                continue
            nets = {"LARGO": outcome["long_net_bp"], "CORTO": outcome["short_net_bp"], "ESPERAR": 0.0}
            best = max(nets, key=lambda k: (nets[k], k == "ESPERAR"))
            hit = d["model_action"] == best
            gain = nets[d["model_action"]]
        elif d["kind"] == "position" and outcome.get("hold_better_bp") is not None:
            best = "MANTENER" if outcome["hold_better_bp"] >= 0 else "CERRAR"
            hit = d["model_action"] == best
            gain = outcome["hold_better_bp"] if d["model_action"] == "MANTENER" else -outcome["hold_better_bp"]
        else:
            continue
        slot = max(i for i, edge in enumerate(BIN_EDGES[:-1]) if d["p_action"] >= edge)
        out[d["kind"]][slot].append((d["p_action"], hit, gain))
    return out


def order_agreement(decisions):
    """How often the two option orders pick the same option, and how far apart their probabilities are."""
    by_kind = collections.defaultdict(lambda: {"n": 0, "same": 0, "gap": 0.0})
    for d in decisions:
        orders = json.loads(d["orders_json"]) if d["orders_json"] else None
        if not orders or len(orders) < 2 or "probabilities" not in orders[0]:
            continue
        a, b = orders[0]["probabilities"], orders[1]["probabilities"]
        pick_a = max(a, key=lambda k: (a[k], k in qt.SAFE_FIRST))
        pick_b = max(b, key=lambda k: (b[k], k in qt.SAFE_FIRST))
        row = by_kind[d["kind"]]
        row["n"] += 1
        row["same"] += int(pick_a == pick_b)
        row["gap"] += max(abs(a[k] - b[k]) for k in a)
    return by_kind


def reasons_table(trades):
    rows = collections.defaultdict(list)
    for t in trades:
        rows[("Entrada", t["entry_reason"] or "sin motivo")].append(t["net_bp"])
        if t["closed_by"] == "qwen":
            rows[("Cierre de Qwen", t["exit_reason"] or "sin motivo")].append(t["net_bp"])
    out = []
    for (kind, reason) in sorted(rows):
        vals = rows[(kind, reason)]
        wins = sum(1 for v in vals if v > 0)
        out.append([kind, reason.replace("_", " "), len(vals), _share(wins / len(vals)),
                    _pct_bp(sum(vals) / len(vals), 2, True), _usd(sum(vals))])
    return out


# --------------------------------------------------------------------------- the text


def _checklist(r, rules):
    c = {x["id"]: x for x in r["rules"]}
    items = []
    v = c["n_trades"]
    items.append((v["ok"], "**Operaciones suficientes**: {} de las {} que se piden como mínimo. _Con pocas operaciones el "
                  "resultado puede ser casualidad._".format(v["value"], rules["min_trades"])))
    v = c["mean_net_positive"]
    m = v["value"]
    items.append((v["ok"], "**Gana dinero después de costos**: promedio {} por operación; con un 95 % de confianza el "
                  "verdadero promedio está entre {} y {}. _Para pasar, todo ese rango debe quedar por encima de cero._"
                  .format(_pct_bp(m["mean"], 2, True), _pct_bp(m["ci_low"], 2, True), _pct_bp(m["ci_high"], 2, True))))
    v = c["percentile_random"]
    items.append((v["ok"], "**Mejor que entrar al azar**: " + (
        "no hay operaciones para comparar." if v["value"] is None else
        "superó al {} % de {} sorteos de entradas al azar dentro de los mismos bloques (se pide al menos {} %).".format(
            _es(v["value"], 0), rules["random_draws"], _es(rules["min_percentile_vs_random"], 0)))))
    v = c["positive_groups"]
    items.append((v["ok"], "**Gana de forma constante en el tiempo**: ganó en {} de {} grupos de tiempo (se pide al menos el "
                  "{} %). _Un buen resultado no debe venir de un solo mes afortunado._".format(
                      v["value"]["positive"], v["value"]["total"], _es(rules["min_positive_group_share"] * 100, 0))))
    v = c["positive_products"]
    items.append((v["ok"], "**Funciona en los dos productos**: ganó en {} de {} (se pide al menos el {} %).".format(
        v["value"]["positive"], v["value"]["total"], _es(rules["min_positive_product_share"] * 100, 0))))
    v = c["cost_stress"]
    items.append((v["ok"], "**Aguanta costos más altos**: con comisiones y deslizamiento x{} el promedio sería {} por "
                  "operación. _Debe seguir siendo positivo._".format(_es(r["stress_multiplier"], 1),
                                                                      _pct_bp(v["value"], 2, True))))
    return items


def _verdict_line(r, rules):
    v = r["verdict"]
    if v == PASS:
        return "## ✅ PASA\n\nCumplió todas las reglas que se fijaron de antemano, en el tramo de validación."
    if v == INCONCLUSIVE:
        return ("## ⚠️ INCONCLUSO\n\nHay muy pocas operaciones (menos de {}) en el tramo de validación para decidir, pero "
                "ninguna otra regla falló. Hace falta correr más bloques.".format(rules["min_trades"]))
    failed = [c for c in r["rules"] if not c["ok"]]
    return "## ❌ NO PASA{}\n\nNo cumplió {} de {} reglas, en el tramo de validación.{}".format(
        " (pocas operaciones)" if r["verdict_note"] else "", len(failed), len(r["rules"]),
        " Además tuvo menos de {} operaciones, por eso la evidencia es escasa.".format(rules["min_trades"])
        if r["verdict_note"] else "")


def _points(r, sel, ov, coverage_text, cal_s):
    points = []
    if ov["n"] == 0:
        return ["En el tramo de validación no hubo ninguna operación con el umbral elegido ({}), así que no hay nada que "
                "juzgar todavía. {}".format(_es(sel["threshold"], 2), coverage_text)]
    mean = ov["mean_bp"]
    points.append("En validación {} en promedio **{} por operación** después de costos ({} operaciones; resultado total {} "
                  "sobre posiciones de 100 USD).".format("ganó" if mean > 0 else "perdió", _pct_bp(abs(mean)), ov["n"],
                                                         _usd(ov["total_bp"])))
    if r["percentile"] is not None:
        pc = r["percentile"]
        points.append("Le fue {} que entrar al azar en los mismos bloques ({} que el {} % de los sorteos).".format(
            "mejor" if pc >= 50 else "peor", "mejor" if pc >= 50 else "peor", _es(pc if pc >= 50 else 100 - pc, 0)))
    points.append("Umbral de entrada elegido en calibración: **{}** ({}).".format(_es(sel["threshold"], 2), sel["reason"]))
    points.append(coverage_text)
    if ov["n"] < 100:
        points.append("Son pocas operaciones para sacar conclusiones firmes.")
    return points[:5]


def build_report(db_path, cfg):
    data = load(db_path)
    return render(data, cfg)


def render(data, cfg):
    rules = cfg["rules"]
    blocks, meta, trades = data["blocks"], data["meta"], data["trades"]
    products = cfg["products"]
    target = meta.get("target_blocks", len(blocks))
    cal_trades = [t for t in trades if t["fold"] == "calibration"]
    sel = qt.select_threshold(cal_trades, cfg)
    thr = sel["threshold"]
    chosen = [t for t in trades if t["entry_p"] is not None and t["entry_p"] >= thr - 1e-12]
    val = [t for t in chosen if t["fold"] == "validation"]
    cal = [t for t in chosen if t["fold"] == "calibration"]
    seed = meta.get("seed", cfg["practice"]["seed"])
    r = judge(val, {k: b for k, b in blocks.items() if b["fold"] == "validation"}, rules, products, seed=seed)
    ov = r["overall"]
    days_total = _days(blocks)
    period_days = max(1.0, (meta.get("holdout_ms", 0) - qt.date_ms(cfg["practice"]["from"])) / qt.DAY_MS)
    coverage = days_total / (period_days * len(products)) if products else 0
    coverage_text = ("Se evaluaron **{} días** en {} de {} bloques planeados (cobertura {} % del periodo de {} días por "
                     "producto).".format(_es(days_total, 0), len(blocks), target, _es(coverage * 100, 1), _es(period_days, 0)))
    lines = ["# Qwen operador: práctica histórica", "",
             "<sub>`{}` · prompt `{}` v{} · práctica sobre bloques al azar, nunca desde el {}</sub>".format(
                 qt.SCHEMA, cfg["prompt"]["name"], cfg["prompt"]["version"],
                 qt.stamp(meta["holdout_ms"]) if meta.get("holdout_ms") else "corte"), "", _verdict_line(r, rules), ""]
    lines += ["### En pocas palabras", ""] + ["- " + p for p in _points(r, sel, ov, coverage_text, None)] + [""]
    lines += ["## Qué revisamos", "",
              "Reglas fijadas antes de mirar resultados y aplicadas solo al tramo de validación (el 40 % más nuevo de los "
              "bloques). Para pasar hay que cumplir **todas**.", ""]
    lines += ["- {} {}".format(_mark(ok), text) for ok, text in _checklist(r, rules)] + [""]

    lines += ["## Resultado general", "", "Con el umbral elegido ({}), posiciones fijas de 100 USD, comisiones y deslizamiento "
              "incluidos. «Por día» cuenta los días de los bloques evaluados.".format(_es(thr, 2)), ""]
    rows = []
    for fold, label in (("calibration", "Calibración (60 % más viejo)"), ("validation", "Validación (40 % más nuevo)")):
        sub = [t for t in chosen if t["fold"] == fold]
        rows.append(_main_row(label, stats_row(sub, _days(blocks, fold))))
    rows.append(_main_row("**Todo**", stats_row(chosen, days_total)))
    lines += _table([""] + MAIN_HEADER, rows)
    lines += ["", "### Por producto", ""]
    prows = []
    for p in products:
        for fold, label in (("calibration", "calibración"), ("validation", "validación")):
            sub = [t for t in chosen if t["product"] == p and t["fold"] == fold]
            prows.append(_main_row("{} · {}".format(p, label), stats_row(sub, _days(blocks, fold, p))))
        sub = [t for t in chosen if t["product"] == p]
        prows.append(_main_row("**{} · todo**".format(p), stats_row(sub, _days(blocks, None, p))))
    lines += _table(["Producto"] + MAIN_HEADER, prows)
    if sum(1 for t in chosen if t["closed_by"] == "fin_de_bloque"):
        lines += ["", "> Las operaciones abiertas al terminar un bloque se cierran al último precio, con costos (no las cerró "
                  "Qwen): se cuentan en «Cerró el fin del bloque»."]

    lines += ["", "## Comparación con otras opciones, en los mismos bloques", "",
              "Sobre las operaciones de validación. Todas las cifras son el promedio por operación, sin funding para "
              "comparar parejo con las entradas al azar.", ""]
    b = r["baseline"]
    base_rows = [["**Qwen operador**", _pct_bp(b["observed_ex_funding"], 2, True) if b else "n/d"],
                 ["No operar", _pct_bp(0, 2, True)]]
    if b:
        base_rows += [["Entradas al azar (mismo lado, duración y bloque), promedio", _pct_bp(b["mean"], 2, True)],
                      ["Al azar, caso malo (5 % peores)", _pct_bp(b["p05"], 2, True)],
                      ["Al azar, caso típico (mediana)", _pct_bp(b["p50"], 2, True)],
                      ["Al azar, caso bueno (5 % mejores)", _pct_bp(b["p95"], 2, True)]]
    else:
        base_rows += [["Entradas al azar", "n/d (sin operaciones de validación)"]]
    base_rows += [["Kronos", "n/d"]]
    lines += _table(["", "Promedio por operación"], base_rows)
    if b:
        lines += ["", "Qwen quedó en el **puesto {} de 100** entre los {} sorteos (100 = mejor que todos).".format(
            _es(r["percentile"], 0), b["draws"])]
        if b["skipped"]:
            lines += ["", "{} operaciones cuya duración no cabía en su bloque quedaron fuera de los sorteos.".format(b["skipped"])]
    lines += ["", "_Kronos: n/d. Sus pronósticos históricos requieren correr el modelo de series de tiempo vela por vela; no "
              "se pueden derivar barato de los datos que ya hay, así que no se compara aquí._"]

    lines += ["", "## Calibración: ¿lo que dice Qwen coincide con lo que pasa?", "",
              "Para cada decisión se compara la probabilidad que Qwen le dio a su elección con cuántas veces esa elección fue "
              "de verdad la mejor en la hora siguiente (con costos). Si Qwen está bien calibrado, las dos columnas se parecen.",
              ""]
    cal_tables = calibration_tables(data["decisions"])
    for kind, title in (("flat", "Sin posición (largo, corto o esperar)"), ("position", "Con posición (mantener o cerrar)")):
        rows = []
        for slot in sorted(cal_tables[kind]):
            items = cal_tables[kind][slot]
            rows.append(["{}–{}".format(_es(BIN_EDGES[slot], 1), _es(min(BIN_EDGES[slot + 1], 1.0), 1)), len(items),
                         _share(statistics.fmean(i[0] for i in items)), _share(sum(1 for i in items if i[1]) / len(items)),
                         _pct_bp(statistics.fmean(i[2] for i in items), 2, True)])
        lines += ["**{}**".format(title), ""]
        lines += _table(["Probabilidad de Qwen", "Decisiones", "Lo que predijo", "Lo que pasó", "Resultado medio de elegir eso"],
                        rows) if rows else ["Sin decisiones evaluables todavía."]
        lines += [""]

    lines += ["## Sesgo por el orden de las opciones", "",
              "Cada pregunta se hace dos veces con las opciones en distinto orden. Si las dos respuestas coinciden casi "
              "siempre, el orden no manda; si no, la letra pesa más que el contenido.", ""]
    agree = order_agreement(data["decisions"])
    rows = [[{"flat": "Sin posición", "position": "Con posición"}[k], v["n"], _share(v["same"] / v["n"]),
             _es(v["gap"] / v["n"], 2)] for k, v in sorted(agree.items()) if v["n"]]
    lines += _table(["Momento", "Preguntas", "Eligieron lo mismo", "Diferencia media de probabilidad"], rows) if rows \
        else ["Sin datos."]

    lines += ["", "## Motivos que dio Qwen", "",
              "Cada vez que entra o cierra, Qwen elige un motivo de una lista fija. Aquí se ve cómo le fue a cada uno.", ""]
    rr = reasons_table(chosen)
    lines += _table(["Cuándo", "Motivo", "Operaciones", "Acierto", "Promedio por operación", "Resultado total"], rr) \
        if rr else ["Sin operaciones."]

    lines += ["", "## Umbral de entrada", "",
              "Se prueba una grilla fijada de antemano en el tramo de calibración y se elige el umbral con mayor resultado "
              "total (con al menos {} operaciones). El tramo de validación no participa en la elección.".format(
                  cfg["threshold_rule"]["min_calibration_trades"]), ""]
    lines += _table(["Umbral", "Operaciones en calibración", "Promedio", "Resultado total", ""], [
        [_es(x["threshold"], 2), x["n"], _pct_bp(x["mean_bp"], 2, True) if x["n"] else "n/d",
         _usd(x["total_bp"]) if x["n"] else "n/d", "← elegido" if x["threshold"] == thr else ""] for x in sel["rows"]])
    lines += ["", "Elegido: **{}** ({}). _Aproximación: se filtran a posteriori las operaciones de la práctica (que entró desde "
              "{}); una entrada descartada habría dejado la posición libre para otra, algo que aquí no se simula._".format(
                  _es(thr, 2), sel["reason"], _es(cfg["practice_entry_threshold"], 2))]

    lines += ["", "## Cobertura", ""]
    cov_rows = []
    for p in products:
        for fold in ("calibration", "validation"):
            sub = {k: x for k, x in blocks.items() if x["product"] == p and x["fold"] == fold}
            cov_rows.append([p, "calibración" if fold == "calibration" else "validación", len(sub), _es(_days(sub), 0)])
    lines += _table(["Producto", "Tramo", "Bloques", "Días evaluados"], cov_rows)
    complete = sum(1 for t in chosen if t["funding_status"] == "complete")
    lines += ["", coverage_text, "", "Funding completo en {} de {} operaciones (el historial público de Kraken solo empieza a "
              "mediados de octubre de 2025; antes se cuenta sin funding y se marca).".format(complete, len(chosen))]

    lines += ["", "## Glosario", "",
              "- **Bloque**: un tramo continuo de 3 días de historia que Qwen opera de principio a fin, empezando sin posición.",
              "- **Calibración / validación**: el 60 % más viejo de los bloques sirve para elegir el umbral; el 40 % más "
              "nuevo, para el veredicto.",
              "- **Umbral de entrada**: la probabilidad mínima que Qwen debe darle a LARGO o CORTO para que se abra la "
              "posición.",
              "- **Stop**: pérdida máxima automática (1,5 veces la volatilidad diaria); Qwen no puede cambiarla.",
              "- **Factor de beneficio**: lo ganado en las operaciones buenas dividido por lo perdido en las malas.",
              "- **Caída máxima**: la mayor pérdida acumulada desde un pico hasta el punto más bajo siguiente.",
              "- **Entradas al azar**: operar lo mismo (lado, duración, bloque) pero en momentos elegidos a la suerte.", ""]
    served = ", ".join(meta.get("served_models", [])) or "n/d"
    runs = data["runs"]
    lines += ["## Detalles técnicos", "",
              "- Configuración `{}` (sha {}), semilla {}, bloques de {} días, desde {} hasta el corte {}.".format(
                  qt.SCHEMA, str(meta.get("config_hash", ""))[:12], seed, cfg["practice"]["block_days"],
                  cfg["practice"]["from"], qt.stamp(meta["holdout_ms"]) if meta.get("holdout_ms") else "n/d"),
              "- Corte entre calibración y validación: {}.".format(qt.stamp(meta["fold_cut_ms"]) if meta.get("fold_cut_ms") else "n/d"),
              "- Modelo servido por llama-server: {}.".format(served),
              "- Llamadas guardadas: {} (latencia media {} ms) en {} corridas.".format(
                  data["calls"]["n"], _es(data["calls"]["mean_ms"] or 0, 0), len(runs)),
              "- Despertares con decisión: {}; entradas permitidas con probabilidad >= {} en la práctica.".format(
                  sum(1 for d in data["decisions"] if d["kind"] in ("flat", "position")), _es(cfg["practice_entry_threshold"], 2)),
              "- Modelo de costos: {}; funding de Kraken (público) cuando existe.".format(COST_MODEL_VERSION),
              "- Reglas: `{}`".format(json.dumps(rules, sort_keys=True)), ""]
    return "\n".join(lines)
