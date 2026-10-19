"""Informe de «Qwen operador» (Markdown en español claro), a partir de la base de práctica. No usa el modelo.

Las reglas del veredicto se fijaron antes de mirar resultados (``config/qwen-trader.json``, ``rules``; mismos umbrales que la
compuerta de estrategias donde tienen sentido) y se aplican SOLO al tramo de validación (el 40 % más nuevo de los bloques),
con el umbral de entrada elegido en el tramo de calibración (el 60 % más viejo). Así el veredicto no se mide con los mismos
datos con los que se eligió el umbral.
"""

import array
import collections
import json
import math
import os
import random
import statistics

from . import futures_qwen_trader as qt
from .futures_costs import COST_MODEL_VERSION, entry_fill, round_trip_cost_bps
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
                "bin": r["time_bin"], "fold": r["fold"], "wakes": r["wakes"], "seconds": r["seconds"],
                "closes": list(closes)}
        data["trades"] = [dict(r) for r in pdb.db.execute("SELECT * FROM trades ORDER BY exit_ms, entry_ms")]
        data["decisions"] = [dict(r) for r in pdb.db.execute(
            "SELECT block_id, seq, t_ms, kind, product, fold, model_action, p_action, action, override, reason, "
            "orders_json, reason_json, outcome_json, net_bp_now, latency_ms, wake_json, prompt_version FROM decisions")]
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


# --------------------------------------------------------------------------- counterfactuals (report only, no model)
#
# Everything below re-uses the candle cache that ``prefetch`` already stored and the SAME accounting as the practice
# (``qt.settle``: fills, taker fees, funding). It never calls the model and never changes what the practice did.
#
# No-lookahead / holdout rule: a counterfactual path only reads candles that CLOSED before its end. Rule (a) never goes past
# the end of the trade's block. Fixed horizons may go past the block end (the next candles exist in the cache) but a path
# whose end would fall after the holdout date (``meta.holdout_ms``, 2026-04-19 in the real config) is not computed at all
# (``n/d``): it is never truncated, and ``History`` refuses the read anyway.

HORIZONS_H = (4, 8, 24)
SCENARIOS = (("guardrails", "a) Solo los límites automáticos (stop o 24 h, o fin del bloque)"),
             ("h4", "b) Mantener 4 h (o hasta el stop)"), ("h8", "c) Mantener 8 h (o hasta el stop)"),
             ("h24", "d) Mantener 24 h (o hasta el stop)"))
DEGENERATE_SHARE = 0.9
MIN_DIVERSITY_N = 10
_EPS_BP = 1e-9


class ReadOnlyHistory(qt.History):
    """Offline reader of the prefetch cache for the report: never downloads, never creates a cache file."""

    def __init__(self, cache_dir, holdout_ms):
        super().__init__(cache_dir, holdout_ms, offline=True)

    def bars(self, product, from_ms, to_ms):
        self._check(to_ms)
        if not os.path.exists(os.path.join(self.cache_dir, "candles-{}.sqlite".format(product))):
            return []
        return super().bars(product, from_ms, to_ms)


def _stop_pct(cfg, bars_before):
    """The stop distance the practice computed when the position opened (same formula, same clamp)."""
    guard = cfg["guardrails"]
    closes = [math.log(float(b["close"])) for b in bars_before[-(qt.H24 + 1):]]
    sigma = qt._std([y - x for x, y in zip(closes, closes[1:])])
    return min(guard["max_stop_pct"], max(guard["min_stop_pct"], guard["stop_sigma_24h"] * sigma * math.sqrt(qt.H24)))


def hold_outcome(cfg, trade, bars, funding, *, horizon_ms, limit_ms):
    """Net result if ``trade`` had been held instead of closed by Qwen: until the stop is touched, ``horizon_ms`` passed, or
    ``limit_ms`` (block end for rule (a)). ``bars``: gap-filled 5m candles that include the 289 before the entry. Returns
    ``{net_bp, gross_bp, closed_by, exit_ms}`` or ``None`` when the candles do not cover the path."""
    entry_ms = trade["entry_ms"]
    before = [b for b in bars if b["bucket_start"] < entry_ms]
    after = [b for b in bars if entry_ms <= b["bucket_start"] and b["bucket_start"] + qt.BAR_MS <= limit_ms]
    if len(before) < qt.H24 + 1 or before[-1]["bucket_start"] != entry_ms - qt.BAR_MS:
        return None
    side = trade["side"]
    long = side == "LONG"
    ref = float(before[-1]["close"])
    stop_pct = _stop_pct(cfg, before)
    stop_px = ref * (1 - stop_pct) if long else ref * (1 + stop_pct)
    notional = qt.D(cfg["notional_usd"])
    entry = entry_fill(qt.D(repr(ref)), side, trade["product"])
    position = qt.Position(side=side, entry_ms=entry_ms, entry_px=entry, qty=notional / entry)
    expected = entry_ms
    for bar in after:
        if bar["bucket_start"] != expected:
            return None                      # a hole in the cache: do not guess
        expected += qt.BAR_MS
        t_ms = bar["bucket_start"] + qt.BAR_MS
        high, low, open_, close = (float(bar[k]) for k in ("high", "low", "open", "close"))
        if (low <= stop_px) if long else (high >= stop_px):
            level = min(stop_px, open_) if long else max(stop_px, open_)
            how, price, reason = "stop", level, "stop"
        elif t_ms - entry_ms >= horizon_ms or t_ms == limit_ms:
            how = "tiempo" if t_ms - entry_ms >= horizon_ms else "fin_de_bloque"
            price, reason = close, "strategy_exit"
        else:
            continue
        done = qt.settle(trade["product"], position, price, reason, t_ms, funding, notional)
        return {"net_bp": done["net_bp"], "gross_bp": done["gross_bp"], "closed_by": how, "exit_ms": t_ms}
    return None


def _holdout_of(meta):
    return meta.get("holdout_ms") or qt.load_holdout_ms()


def counterfactuals(data, cfg, history):
    """For every trade Qwen closed: the four held-on outcomes. Pure given the candles. Returns
    ``(rows, notes)``; each row is ``{trade, scenarios: {id: result|None}}``."""
    holdout = _holdout_of(data["meta"])
    blocks, rows, funding_cache = data["blocks"], [], {}
    for t in data["trades"]:
        if t["closed_by"] != "qwen":
            continue
        block = blocks.get(t["block_id"])
        if block is None or history is None:
            continue
        if t["product"] not in funding_cache:
            funding_cache[t["product"]] = qt.FundingLine(history.funding(t["product"]))
        funding = funding_cache[t["product"]]
        reach = min(t["entry_ms"] + qt.DAY_MS, holdout)
        try:
            bars = history.bars(t["product"], t["entry_ms"] - (qt.H24 + 1) * qt.BAR_MS, reach)
        except (qt.HoldoutError, qt.HistoryError):
            bars = []
        out = {}
        out["guardrails"] = hold_outcome(cfg, t, bars, funding, horizon_ms=cfg["guardrails"]["max_hold_min"] * qt.MINUTE_MS,
                                         limit_ms=min(block["end_ms"], holdout))
        for hours in HORIZONS_H:
            end = t["entry_ms"] + hours * qt.HOUR_MS
            out["h{}".format(hours)] = None if end > holdout else hold_outcome(
                cfg, t, bars, funding, horizon_ms=hours * qt.HOUR_MS, limit_ms=end)
        rows.append({"trade": t, "scenarios": out})
    return rows


def entry_moves(data, history):
    """Gross price move from the entry (last close before it) to 4 h and 24 h later, in the trade's direction and before
    any cost, for every trade (whoever closed it). ``None`` when the candles are missing or would pass the holdout."""
    holdout = _holdout_of(data["meta"])
    rows = []
    for t in data["trades"]:
        out = {"h4": None, "h24": None}
        if history is not None:
            end = t["entry_ms"] + 24 * qt.HOUR_MS
            try:
                bars = history.bars(t["product"], t["entry_ms"] - qt.BAR_MS, min(end, holdout))
            except (qt.HoldoutError, qt.HistoryError):
                bars = []
            by_t = {b["bucket_start"]: float(b["close"]) for b in bars}
            ref = by_t.get(t["entry_ms"] - qt.BAR_MS)
            sign = 1.0 if t["side"] == "LONG" else -1.0
            for hours in (4, 24):
                last = by_t.get(t["entry_ms"] + hours * qt.HOUR_MS - qt.BAR_MS)
                if ref and last and t["entry_ms"] + hours * qt.HOUR_MS <= holdout:
                    out["h{}".format(hours)] = sign * (last / ref - 1.0) * 10_000
        rows.append({"trade": t, "moves": out, "cost_bp": float(round_trip_cost_bps(t["product"]))})
    return rows


def _groups(products):
    out = [("Calibración", None, "calibration"), ("Validación", None, "validation"), ("**Todo**", None, None)]
    for p in products:
        out += [("{} · calibración".format(p), p, "calibration"), ("{} · validación".format(p), p, "validation"),
                ("**{} · todo**".format(p), p, None)]
    return out


def _pick(rows, product, fold):
    return [r for r in rows if (product is None or r["trade"]["product"] == product)
            and (fold is None or r["trade"]["fold"] == fold)]


def counterfactual_summary(rows, scenario, product=None, fold=None):
    """``n`` comparable trades, mean real / counterfactual net bp, how many Qwen exits were better / worse, and the total
    difference (counterfactual minus real: positive means closing cost money)."""
    chosen = [r for r in _pick(rows, product, fold) if r["scenarios"].get(scenario) is not None]
    real = [r["trade"]["net_bp"] for r in chosen]
    cf = [r["scenarios"][scenario]["net_bp"] for r in chosen]
    n = len(chosen)
    return {"n": n, "mean_real_bp": statistics.fmean(real) if n else None, "mean_cf_bp": statistics.fmean(cf) if n else None,
            "better": sum(1 for a, b in zip(real, cf) if a > b + _EPS_BP), "worse": sum(1 for a, b in zip(real, cf) if a < b - _EPS_BP),
            "diff_bp": sum(b - a for a, b in zip(real, cf)), "total": len(_pick(rows, product, fold))}


def counterfactual_sentence(rows):
    """One plain sentence from the numbers (all trades Qwen closed)."""
    if not rows:
        return "Qwen no cerró ninguna operación todavía: no hay nada que comparar."
    parts, ok = [], False
    for scenario, text in (("guardrails", "dejar correr hasta los límites automáticos"), ("h4", "mantener 4 h"),
                           ("h8", "mantener 8 h"), ("h24", "mantener 24 h")):
        s = counterfactual_summary(rows, scenario)
        if not s["n"]:
            continue
        ok = True
        lead = "Cerrar antes le {} {} frente a {}".format("costó" if s["diff_bp"] > 0 else "ahorró",
                                                           _usd(abs(s["diff_bp"])).replace("+", ""), text) \
            if scenario == "guardrails" else "{} {} ({})".format("costó" if s["diff_bp"] > 0 else "ahorró",
                                                                  _usd(abs(s["diff_bp"])).replace("+", ""), text)
        parts.append(lead)
    if not ok:
        return ("No se pudo calcular: faltan velas en la caché para las operaciones que cerró Qwen (ejecutá `prefetch` "
                "con la misma configuración).")
    first, rest = parts[0], parts[1:]
    n = counterfactual_summary(rows, "guardrails")["n"] or max(counterfactual_summary(rows, k)["n"] for k in
                                                                ("h4", "h8", "h24"))
    return "{}{} (sobre {} operaciones que cerró Qwen, posiciones de 100 USD y mismos costos).".format(
        first, "; en los otros casos " + ", ".join(rest) if rest else "", n)


def counterfactual_lines(rows, products):
    lines = ["## ¿Qué habría pasado si no cerraba?", "",
             "Para cada operación que cerró Qwen se recalcula, con el mismo simulador, costos y funding, qué habría ocurrido "
             "si la hubiera dejado abierta. **Diferencia** = lo que habría dado dejarla menos lo que dio cerrarla: un número "
             "positivo significa que cerrar costó dinero. «Qwen mejor / peor» cuenta las operaciones donde cerrar fue mejor o "
             "peor que seguir.", "", counterfactual_sentence(rows), ""]
    for scenario, title in SCENARIOS:
        table = []
        for label, product, fold in _groups(products):
            s = counterfactual_summary(rows, scenario, product, fold)
            if not s["total"]:
                table.append([label, 0, "n/d", "n/d", "n/d", "n/d", "n/d"])
                continue
            table.append([label, "{} de {}".format(s["n"], s["total"]) if s["n"] != s["total"] else s["n"],
                          _pct_bp(s["mean_real_bp"], 2, True), _pct_bp(s["mean_cf_bp"], 2, True),
                          s["better"] if s["n"] else "n/d", s["worse"] if s["n"] else "n/d",
                          _usd(s["diff_bp"]) if s["n"] else "n/d"])
        lines += ["**{}**".format(title), ""]
        lines += _table(["Grupo", "Operaciones", "Promedio real", "Promedio si seguía", "Qwen mejor", "Qwen peor", "Diferencia"],
                        table) + [""]
    lines += ["_Notas: se usan solo velas cerradas. La opción a) no pasa del final del bloque (la operación se cierra al último "
              "precio, como en la práctica). Los horizontes fijos pueden pasar del fin del bloque usando las velas siguientes "
              "de la caché, pero solo si terminan antes de la fecha de reserva (holdout); si no, la operación no cuenta "
              "(«n de total»). En todos los casos sigue activo el stop de la práctica. No se llamó al modelo._", ""]
    return lines


def entry_quality_lines(moves, products):
    lines = ["## Calidad de las entradas (sin contar las salidas)", "",
             "¿Entrar donde entró Qwen tenía ventaja por sí solo? Se mide cuánto se movió el precio a favor (o en contra) de la "
             "posición 4 h y 24 h después de entrar, **antes de costos**, y se compara con el costo de ida y vuelta. Si el "
             "movimiento bruto no supera el costo, la entrada no tenía ventaja, sea cual sea la salida.", ""]
    table, cells = [], {}
    for label, product, fold in _groups(products):
        sub = _pick(moves, product, fold)
        row = [label, len(sub)]
        for key in ("h4", "h24"):
            vals = [m["moves"][key] for m in sub if m["moves"][key] is not None]
            row.append(_pct_bp(statistics.fmean(vals), 2, True) if vals else "n/d")
            if vals:
                cost = statistics.fmean([m["cost_bp"] for m in sub if m["moves"][key] is not None])
                row.append(_pct_bp(statistics.fmean(vals) - cost, 2, True))
                cells[(label, key)] = (statistics.fmean(vals), cost, len(vals))
            else:
                row.append("n/d")
        costs = [m["cost_bp"] for m in sub]
        row.append(_pct_bp(statistics.fmean(costs), 2) if costs else "n/d")
        table.append(row)
    lines += _table(["Grupo", "Operaciones", "Movimiento a 4 h (bruto)", "A 4 h menos costo", "Movimiento a 24 h (bruto)",
                     "A 24 h menos costo", "Costo ida y vuelta"], table) + [""]
    key = ("**Todo**", "h24")
    k4 = ("**Todo**", "h4")
    if key in cells or k4 in cells:
        sentence = []
        for name, k, h in (("4 h", k4, "h4"), ("24 h", key, "h24")):
            if k in cells:
                move, cost, n = cells[k]
                sentence.append("a {} el precio se movió {} a favor de la posición contra un costo de {} ({} operaciones)"
                                .format(name, _pct_bp(move, 2, True), _pct_bp(cost, 2), n))
        edge = cells.get(key, cells.get(k4))
        verdict = ("las entradas, por sí solas, **sí** superan el costo" if edge[0] > edge[1] else
                   "las entradas, por sí solas, **no** superan el costo: no se ve ventaja en cuándo entra")
        lines += ["En resumen: {}; {}.".format("; ".join(sentence), verdict), ""]
    else:
        lines += ["No hay velas en la caché para medirlo (ejecutá `prefetch`).", ""]
    return lines


def _letter(order_ids, option):
    return chr(ord("A") + order_ids.index(option)) if order_ids and option in order_ids else None


def reason_diversity(decisions):
    """Distribution of the reasons Qwen chose (entry / exit), the letter each one had in the prompt, and the letter
    positions of the action question in both option orders."""
    reasons = {"Entrada": collections.Counter(), "Cierre de Qwen": collections.Counter()}
    letters = {"Entrada": collections.Counter(), "Cierre de Qwen": collections.Counter()}
    for d in decisions:
        if not d["reason"] or d["action"] not in ("LARGO", "CORTO", "CERRAR"):
            continue
        kind = "Cierre de Qwen" if d["action"] == "CERRAR" else "Entrada"
        reasons[kind][d["reason"]] += 1
        try:
            answer = json.loads(d["reason_json"]) if d.get("reason_json") else None
            order = (answer or {}).get("orders", [{}])[0].get("order")
        except (ValueError, AttributeError, IndexError):
            order = None
        letters[kind][_letter(order, d["reason"]) or "?"] += 1
    action_letters = collections.defaultdict(lambda: {"n": 0, "same_letter": 0, "same_option": 0,
                                                       "letters": [collections.Counter(), collections.Counter()]})
    for d in decisions:
        orders = json.loads(d["orders_json"]) if d["orders_json"] else None
        if not orders or len(orders) < 2 or "probabilities" not in orders[0] or "order" not in orders[0]:
            continue
        picks = []
        for o in orders[:2]:
            probs = o["probabilities"]
            best = max(probs, key=lambda k: (probs[k], k in qt.SAFE_FIRST))
            picks.append((best, _letter(o["order"], best)))
        row = action_letters[d["kind"]]
        row["n"] += 1
        row["same_letter"] += int(picks[0][1] == picks[1][1])
        row["same_option"] += int(picks[0][0] == picks[1][0])
        for i in (0, 1):
            row["letters"][i][picks[i][1] or "?"] += 1
    return {"reasons": reasons, "letters": letters, "action": action_letters}


def reason_diversity_lines(decisions):
    div = reason_diversity(decisions)
    lines = ["## ¿Elige motivos distintos o siempre el mismo?", "",
             "Si Qwen contesta casi siempre lo mismo (más del {} %), la pregunta del motivo no aporta información: se marca "
             "«motivo degenerado». El motivo se pregunta en un solo orden, así que cada opción tiene siempre la misma letra."
             .format(_es(DEGENERATE_SHARE * 100, 0)), ""]
    table, flags = [], []
    for kind in ("Entrada", "Cierre de Qwen"):
        counter = div["reasons"][kind]
        total = sum(counter.values())
        if not total:
            table.append([kind, 0, "n/d", "n/d", "n/d", "sin datos"])
            continue
        top, top_n = counter.most_common(1)[0]
        share = top_n / total
        degenerate = share > DEGENERATE_SHARE and total >= MIN_DIVERSITY_N
        letter = div["letters"][kind].most_common(1)[0][0]
        spread = ", ".join("{} {}".format(r.replace("_", " "), n) for r, n in counter.most_common())
        table.append([kind, total, top.replace("_", " "), "{} (letra {})".format(_share(share), letter), spread,
                      "**motivo degenerado**" if degenerate else ("pocos datos" if total < MIN_DIVERSITY_N else "variado")])
        if degenerate:
            flags.append("{}: {} de {} veces «{}»".format(kind.lower(), top_n, total, top.replace("_", " ")))
    lines += _table(["Cuándo", "Veces", "Más elegido", "Su parte", "Reparto", "Veredicto"], table) + [""]
    if flags:
        lines += ["> **Motivo degenerado**: " + "; ".join(flags) + ". El motivo que se guarda no distingue operaciones buenas "
                  "de malas: no se debe usar como señal ni como dato de aprendizaje sin revisar la pregunta.", ""]
    rows = []
    for kind, label in (("flat", "Sin posición"), ("position", "Con posición")):
        row = div["action"].get(kind)
        if row and row["n"]:
            top = lambda c: ", ".join("{} {}".format(k, v) for k, v in c.most_common()) or "n/d"
            rows.append([label, row["n"], _share(row["same_letter"] / row["n"]), _share(row["same_option"] / row["n"]),
                         top(row["letters"][0]), top(row["letters"][1])])
    if rows:
        lines += ["**Letra elegida en la pregunta de acción, en cada orden de opciones**", ""]
        lines += _table(["Momento", "Preguntas", "Misma letra en los dos órdenes", "Misma opción", "Letras (orden 1)",
                         "Letras (orden 2)"], rows) + [""]
        lines += ["_Si la misma letra sale en los dos órdenes pero la opción cambia, Qwen está contestando por la posición y "
                  "no por el contenido._", ""]
    return lines


def throughput(data, cfg):
    """Measured latency and how many more batches the planned blocks need at that latency."""
    done = len(data["blocks"])
    target = data["meta"].get("target_blocks", done)
    calls, mean_ms = data["calls"]["n"], data["calls"]["mean_ms"]
    max_minutes = 55.0
    for run in reversed(data["runs"]):
        try:
            max_minutes = float(json.loads(run["args"]).get("max_minutes", max_minutes))
            break
        except (TypeError, ValueError, AttributeError):
            continue
    remaining = max(0, target - done)
    out = {"done": done, "target": target, "remaining": remaining, "calls": calls, "mean_ms": mean_ms,
           "max_minutes": max_minutes, "calls_per_block": calls / done if done else None, "batches": None,
           "remaining_minutes": None, "sec_per_block": None}
    secs = [b["seconds"] for b in data["blocks"].values() if b.get("seconds")]
    out["sec_per_block"] = statistics.fmean(secs) if secs else None
    if done and calls and mean_ms is not None:
        out["remaining_minutes"] = remaining * out["calls_per_block"] * mean_ms / 60_000.0
        out["batches"] = math.ceil(out["remaining_minutes"] / max_minutes - 1e-9) if remaining else 0
    return out


def throughput_lines(data, cfg):
    t = throughput(data, cfg)
    lines = ["## Velocidad de la práctica", ""]
    if t["batches"] is None:
        return lines + ["Todavía no hay llamadas guardadas para estimar la velocidad.", ""]
    lines += ["- Latencia medida: **{} ms por llamada** ({} llamadas, unas {} por bloque).".format(
        _es(t["mean_ms"], 0), t["calls"], _es(t["calls_per_block"], 0)),
        "- Bloques hechos: {} de {}; faltan {}.".format(t["done"], t["target"], t["remaining"])]
    if t["sec_per_block"]:
        lines += ["- Tiempo medido por bloque: {} min (incluye el cálculo de velas).".format(_es(t["sec_per_block"] / 60.0, 1))]
    if t["remaining"]:
        lines += ["- Al ritmo medido faltan unos **{} min** de modelo: unas **{} tandas** de {} min.".format(
            _es(t["remaining_minutes"], 0), t["batches"], _es(t["max_minutes"], 0))]
    else:
        lines += ["- Todos los bloques planeados están hechos."]
    return lines + [""]


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


def build_report(db_path, cfg, cache_dir=None, history=None):
    """``cache_dir``: the prefetch cache (default ``qt.DEFAULT_CACHE``), read-only, for the counterfactual sections."""
    data = load(db_path)
    if history is None:
        history = ReadOnlyHistory(cache_dir or qt.DEFAULT_CACHE, _holdout_of(data["meta"]))
    return render(data, cfg, history)


def render(data, cfg, history=None):
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

    lines += [""] + counterfactual_lines(counterfactuals(dict(data, trades=chosen), cfg, history), products)
    lines += entry_quality_lines(entry_moves(dict(data, trades=chosen), history), products)
    lines += reason_diversity_lines(data["decisions"])
    lines += throughput_lines(data, cfg)

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
