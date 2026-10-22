"""Numbers and plain-language sentences of an exploration report (schema ``balancita.vectorbt-exploration.v1``).

Pure functions on the trades of ``generic_sim.simulate_plan``. The sentences in ``works`` / ``fails`` come from a short list
of rules, each with a threshold written here, so any sentence can be checked against the numbers next to it. No jargon:
basis points are written «pb» (1 pb = 0,01 % de lo operado) and the report carries that glossary.

Everything in a report is a HYPOTHESIS on practice data; the gate decides.
"""

import statistics

from .optimize import WARNING  # noqa: F401  (one warning for every lab output, re-exported)

SCHEMA = "balancita.vectorbt-exploration.v1"
GLOSSARY = {"pb": "punto básico: 1 pb = 0,01 % de lo operado (100 pb = 1 %)",
            "neto": "resultado después de comisiones, costo de ejecución, funding real y costo del stop",
            "bruto": "movimiento del precio entre la entrada y la salida, antes de cualquier costo"}

EXIT_ORDER = ("target", "stop", "rule", "time")
EXIT_LEAD = {"target": "Los cierres por objetivo", "stop": "Los cierres por stop", "time": "Los cierres por tiempo"}
EXIT_LABEL = {"target": "Objetivo (se alcanzó la ganancia fijada)", "stop": "Stop (se tocó la pérdida máxima)",
              "time": "Tiempo (venció el plazo de la estrategia)"}
SIDE_LABEL = {"LONG": "Compras (LONG)", "SHORT": "Ventas en corto (SHORT)"}
# Plain names for the exit comparisons the shipped strategies use; an unknown one falls back to a generic label.
RULE_CODE_TEXT = {
    "owner_close_crosses_frozen_donchian_mid": "cruce de la media del canal",
    "owner_close_invalidates_ema21": "el precio cierra del lado contrario de la media EMA21",
    "owner_regime_is_range": "el mercado deja de estar lateral",
    "owner_close_reaches_frozen_middle": "el precio vuelve a la media de las bandas",
}

MIN_GROUP = 10            # trades a group needs before a sentence is written about it
MIN_SIDE_TRADES = 30      # same for a side or a product
FREQUENT_PER_DAY = 5      # entries per day from which frequency is called out when the strategy loses
SKIPPED_SHARE = 0.30      # share of signals dropped for cost from which it is called out
FUNDING_SHARE = 0.95      # the gate's min_funding_complete_share


# ------------------------------------------------------------------------------------------------ formatting
def fmt(value, digits=1):
    return ("{:.%df}" % digits).format(value).replace(".", ",")


def bp(value):
    """«70», «8,5», «-3,2»: no decimals from 10 pb up."""
    return fmt(value, 0 if abs(value) >= 10 else 1)


def signed(value):
    return ("+" if value > 0 else "") + bp(value)


def pct(share):
    return "{:.0f} %".format(share * 100)


def rule_label(codes):
    known = [RULE_CODE_TEXT[c] for c in codes if c in RULE_CODE_TEXT]
    if known:
        return "Salida por regla propia ({})".format("; ".join(known))
    return "Salida por regla propia de la estrategia"


def rule_lead(codes):
    known = [RULE_CODE_TEXT[c] for c in codes if c in RULE_CODE_TEXT]
    if known:
        return "La salida por regla propia ({})".format("; ".join(known))
    return "La salida por regla propia de la estrategia"


# --------------------------------------------------------------------------------------------------- numbers
def group_stats(trades):
    n = len(trades)
    if n == 0:
        return {"trades": 0, "gross_bp_mean": None, "net_bp_mean": None, "hit_rate": None, "funding_complete_share": None,
                "funding_bp_mean": None}
    return {"trades": n,
            "gross_bp_mean": statistics.fmean(t["gross_bp"] for t in trades),
            "net_bp_mean": statistics.fmean(t["net_bp"] for t in trades),
            "hit_rate": sum(1 for t in trades if t["net_bp"] > 0) / n,
            "funding_complete_share": sum(1 for t in trades if t["funding_complete"]) / n,
            "funding_bp_mean": statistics.fmean(t["funding_bp"] for t in trades)}


def entries_per_day(trade_count, days):
    return trade_count / days if days else 0.0


def build_diagnostic(trades, days_by_product, signals, exit_codes, min_trades):
    """The ``diagnostic`` block: totals, by product / exit / side, and the sentences.

    ``days_by_product``: {product: days of its window}. ``signals``: {"raw": entries the strategy proposed,
    "skipped_by_cost": those the engine drops because the target does not clear the cost}.
    """
    total = group_stats(trades)
    per_day = sum(entries_per_day(sum(1 for t in trades if t["product"] == p), d) for p, d in days_by_product.items())
    totals = dict(total, entries_per_day=per_day)
    by_product = []
    for product, days in days_by_product.items():
        mine = [t for t in trades if t["product"] == product]
        by_product.append(dict(group_stats(mine), product=product, days=round(days, 2),
                               entries_per_day=entries_per_day(len(mine), days)))
    by_exit = []
    for reason in EXIT_ORDER:
        mine = [t for t in trades if t["exit_reason"] == reason]
        if mine:
            label = rule_label(exit_codes) if reason == "rule" else EXIT_LABEL[reason]
            by_exit.append(dict(group_stats(mine), reason=reason, label=label, share=len(mine) / len(trades)))
    other = [t for t in trades if t["exit_reason"] not in EXIT_ORDER]
    if other:
        by_exit.append(dict(group_stats(other), reason="unknown", label="Salida no clasificada", share=len(other) / len(trades)))
    by_side = []
    for side in ("LONG", "SHORT"):
        mine = [t for t in trades if t["side"] == side]
        if mine:
            by_side.append(dict(group_stats(mine), side=side, label=SIDE_LABEL[side], share=len(mine) / len(trades)))
    diagnostic = {"totals": totals, "by_product": by_product, "by_exit": by_exit, "by_side": by_side,
                  "signals": dict(signals), "open_at_end": 0}
    diagnostic["works"], diagnostic["fails"], diagnostic["notes"] = sentences(diagnostic, exit_codes, min_trades)
    return diagnostic


# ------------------------------------------------------------------------------------------------- sentences
def sentences(diagnostic, exit_codes, min_trades):
    """(works, fails, notes): plain sentences from fixed rules; each threshold is a constant of this module."""
    works, fails, notes = [], [], []
    totals = diagnostic["totals"]
    n = totals["trades"]
    signals = diagnostic["signals"]
    if n == 0:
        if signals["raw"] and signals["skipped_by_cost"] == signals["raw"]:
            fails.append("Detecta {} entradas pero todas se descartan: el objetivo nunca alcanza a cubrir el costo de "
                         "operar.".format(signals["raw"]))
        else:
            fails.append("No operó nunca en esta ventana: las condiciones de entrada no se cumplen.")
        return works, fails, notes
    net, gross, per_day = totals["net_bp_mean"], totals["gross_bp_mean"], totals["entries_per_day"]
    if net > 0:
        works.append("En total gana {} pb por operación después de costos, en {} operaciones.".format(signed(net), n))
    else:
        fails.append("En total pierde {} pb por operación después de costos, en {} operaciones.".format(bp(-net), n))
    if net <= 0 and gross > 0:
        fails.append("Antes de costos gana {} pb por operación, pero las comisiones, el costo de ejecución y el funding "
                     "se llevan {} pb: queda {} pb.".format(bp(gross), bp(gross - net), signed(net)))
    elif net <= 0:
        fails.append("Ni antes de costos gana: el movimiento del precio le da {} pb por operación.".format(signed(gross)))
    if net <= 0 and per_day >= FREQUENT_PER_DAY:
        fails.append("Entra {} veces por día y cada entrada paga costos: operar tanto le juega en contra.".format(fmt(per_day, 0)))
    for item in diagnostic["by_exit"]:
        if item["trades"] < MIN_GROUP:
            continue
        reason, mean, share = item["reason"], item["net_bp_mean"], item["share"]
        lead = rule_lead(exit_codes) if reason == "rule" else EXIT_LEAD.get(reason, "Las salidas no clasificadas")
        if mean > 0:
            works.append("{} ganan {} pb en promedio (son el {} de las operaciones).".format(
                lead, signed(mean), pct(share)) if reason != "rule" else
                "{} cierra el {} de las operaciones y gana {} pb en promedio.".format(lead, pct(share), signed(mean)))
        else:
            if reason == "rule":
                text = "{} cierra el {} de las operaciones y {}.".format(
                    lead, pct(share), "siempre pierde" if item["hit_rate"] == 0 else "pierde {} pb en promedio".format(bp(-mean)))
                if item["gross_bp_mean"] > 0:
                    text += " Antes de costos gana {} pb: los costos se llevan el resultado.".format(bp(item["gross_bp_mean"]))
            else:
                text = "{} pierden {} pb en promedio (son el {} de las operaciones).".format(lead, bp(-mean), pct(share))
            fails.append(text)
    sides = [s for s in diagnostic["by_side"] if s["trades"] >= MIN_SIDE_TRADES]
    if len(sides) == 2 and (sides[0]["net_bp_mean"] > 0) != (sides[1]["net_bp_mean"] > 0):
        good, bad = sorted(sides, key=lambda s: -s["net_bp_mean"])
        works.append("{} ganan {} pb por operación.".format(good["label"], signed(good["net_bp_mean"])))
        fails.append("{} pierden {} pb por operación.".format(bad["label"], bp(-bad["net_bp_mean"])))
    products = [p for p in diagnostic["by_product"] if p["trades"] >= MIN_SIDE_TRADES]
    if len(products) >= 2:
        winners = [p for p in products if p["net_bp_mean"] > 0]
        for p in products:
            sentence = "En {} {} {} pb por operación.".format(
                p["product"], "gana" if p["net_bp_mean"] > 0 else "pierde",
                signed(p["net_bp_mean"]) if p["net_bp_mean"] > 0 else bp(-p["net_bp_mean"]))
            (works if p["net_bp_mean"] > 0 else fails).append(sentence)
        if 0 < len(winners) < len(products):
            fails.append("No funciona en todos los productos: gana en {} de {}.".format(len(winners), len(products)))
    if signals["raw"] and signals["skipped_by_cost"] / signals["raw"] >= SKIPPED_SHARE:
        fails.append("El {} de las entradas que detecta se descartan porque el objetivo no alcanza a cubrir el costo de "
                     "operar.".format(pct(signals["skipped_by_cost"] / signals["raw"])))
    if n < min_trades:
        fails.append("Con solo {} operaciones no alcanza para sacar conclusiones (la compuerta pide al menos {}).".format(n, min_trades))
    if totals["funding_complete_share"] == 0:
        notes.append("Estos datos no traen funding: el resultado neto no lo descuenta.")
    elif totals["funding_complete_share"] < FUNDING_SHARE:
        notes.append("Solo el {} de las operaciones tiene el funding completo en los datos; el resultado neto puede estar "
                     "algo sesgado.".format(pct(totals["funding_complete_share"])))
    unknown = [x for x in diagnostic["by_exit"] if x["reason"] == "unknown"]
    if unknown:
        notes.append("{} operaciones cerraron de una forma que el laboratorio no pudo clasificar.".format(unknown[0]["trades"]))
    return works, fails, notes


def variants_headline(rows, vary_label, min_trades):
    """One or two plain sentences about a set of variants."""
    ok = [r for r in rows if r["status"] == "ok"]
    out = []
    if not ok:
        return ["Ninguna de las variantes llegó a operar."]
    winners = [r for r in ok if r["net_bp_mean"] > 0]
    if not winners:
        out.append("Ninguna de las {} variantes gana después de costos.".format(len(ok)))
    else:
        best = ok[0]
        out.append("{} de {} variantes ganan después de costos; la mejor es {} con {} pb por operación en {} operaciones "
                   "({} entradas por día).".format(len(winners), len(ok), best["label"], signed(best["net_bp_mean"]),
                                                   best["trades"], fmt(best["entries_per_day"], 1)))
        if len(winners) == 1 or best["trades"] < min_trades:
            out.append("Es una hipótesis débil: " + ("solo una variante gana" if len(winners) == 1 else
                                                    "tiene menos de {} operaciones".format(min_trades)) + ".")
    return out


# ---------------------------------------------------------------------------------------------------- markdown
def _row(cells):
    return "| " + " | ".join(str(c) for c in cells) + " |"


def render_markdown(report):
    lines = ["# Exploración con VectorBT: {}".format(report["strategy_name"] or report["strategy_id"]), ""]
    lines += ["**Advertencia:** " + report["warning"], ""]
    window = report["window"]
    lines += ["Estrategia `{}` (spec `{}`), modo **{}**, del {} al {}, productos: {}.".format(
        report["strategy_id"], report["spec_hash"][:12], "diagnóstico" if report["mode"] == "diagnostic" else "variantes",
        window["from"][:10] if window["from"] else "-", window["to"][:10] if window["to"] else "-",
        ", ".join(report["products"])), ""]
    if report["unsupported"]:
        lines += ["## No se pudo evaluar", "", report["unsupported"]["reason"], ""]
        return "\n".join(lines) + "\n"
    diag = report["diagnostic"]
    if diag["works"]:
        lines += ["## Qué funciona", ""] + ["- " + s for s in diag["works"]] + [""]
    if diag["fails"]:
        lines += ["## Qué falla", ""] + ["- " + s for s in diag["fails"]] + [""]
    if diag["notes"]:
        lines += ["## Avisos", ""] + ["- " + s for s in diag["notes"]] + [""]
    t = diag["totals"]
    lines += ["## Números", "",
              "{} operaciones, {} entradas por día, bruto {} pb, neto {} pb, aciertan el {}.".format(
                  t["trades"], fmt(t["entries_per_day"], 1), signed(t["gross_bp_mean"] or 0.0), signed(t["net_bp_mean"] or 0.0),
                  pct(t["hit_rate"] or 0.0)), ""]
    if diag["by_exit"]:
        lines += ["### Por forma de salida", "", _row(["Salida", "Operaciones", "Parte", "Bruto (pb)", "Neto (pb)"]),
                  _row(["---"] * 5)]
        lines += [_row([x["label"], x["trades"], pct(x["share"]), signed(x["gross_bp_mean"]), signed(x["net_bp_mean"])])
                  for x in diag["by_exit"]]
        lines.append("")
    if diag["by_product"]:
        lines += ["### Por producto", "", _row(["Producto", "Operaciones", "Entradas por día", "Bruto (pb)", "Neto (pb)"]),
                  _row(["---"] * 5)]
        lines += [_row([x["product"], x["trades"], fmt(x["entries_per_day"], 1), signed(x["gross_bp_mean"] or 0.0),
                        signed(x["net_bp_mean"] or 0.0)]) for x in diag["by_product"]]
        lines.append("")
    if report.get("variants"):
        vary = report["vary"]
        lines += ["## Variantes de {}".format(vary["label"]), ""]
        lines += ["- " + s for s in report["variants_headline"]] + [""]
        lines += [_row(["#", "Valor", "Estado", "Operaciones", "Entradas por día", "Bruto (pb)", "Neto (pb)", "Acierto"]),
                  _row(["---"] * 8)]
        for v in report["variants"]:
            ok = v["status"] == "ok"
            lines.append(_row([v.get("rank", "-"), v["value"] + (" (actual)" if v["is_base"] else ""),
                               v["status"] if not v.get("error") else "error: " + v["error"], v["trades"],
                               fmt(v["entries_per_day"], 1) if ok else "-", signed(v["gross_bp_mean"]) if ok else "-",
                               signed(v["net_bp_mean"]) if ok else "-", pct(v["hit_rate"]) if ok else "-"]))
        lines += ["", "Intentos de la familia `{}` en el registro: **{}** variantes distintas. Cuantas más se prueban, más se "
                  "infla el mejor resultado.".format(report["family"], report["attempts_in_family"]), ""]
    lines += ["## Glosario", ""] + ["- **{}**: {}".format(k, v) for k, v in GLOSSARY.items()]
    return "\n".join(lines) + "\n"
