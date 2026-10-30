"""Destilar la fórmula en Qwen: que aprenda a LEER la ficha corta como la fórmula vigente (hilo «Enseñar a Qwen a leer la ficha»).

Diseño: ``analisis/qwen-entrenamiento-historico/informe.md``, sección 5. Para ganar más que la fórmula no alcanza (ni un modelo
clásico con los mismos números le gana en los meses que no vio), así que acá la etiqueta es la decisión de la fórmula en vigor
(``LARGO`` / ``CORTO`` / ``ESPERAR`` sin posición, ``CERRAR`` / ``MANTENER`` con posición), que se deduce de lo que dice la ficha:
si Qwen no llega a ~100 % es que no lee. El control de que no repite una costumbre es el ESPEJO (la ficha dada vuelta tiene que dar
la respuesta opuesta).

* ``facts``: fotos cada 15 min de un producto con todos los números de la ficha y los movimientos (para ajustar las fórmulas).
* ``ajustar``: las fórmulas de cada trimestre (maestro y portero con BTC+ETH hasta 48 h antes de que empiece el trimestre).
* ``armar``: el dataset (train / valid / práctica) escrito con el maestro y el portero EN VIGOR en cada trimestre, sin mirar atrás.

Nada de esto lee el holdout (``History`` lo rechaza) ni llama a ningún modelo.
"""

import argparse
import collections
import copy
import gzip
import hashlib
import json
import math
import os
import random
import re

from . import futures_qwen_aprende as ap
from . import futures_qwen_corta as corta
from . import futures_qwen_ficha as fficha
from . import futures_qwen_maestro as maestro
from . import futures_qwen_portero as portero
from . import futures_qwen_trader as qt
from .futures_costs import round_trip_cost_bps

SCHEMA = "balancita-qwen-destila-dataset.v1"
PRODUCT = "PF_ETHUSD"
CONTEXT = ("PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD")
FACTS_FROM = "2022-04-01"                        # primer día con velas para ajustar las fórmulas
TRAIN_FROM, VALID_FROM, VALID_TO = "2023-01-01", "2025-08-01", "2025-10-01"
PRACTICE_FROM, PRACTICE_TO = "2025-10-16", "2026-04-19"
QUARTERS = [(y, q) for y in (2023, 2024, 2025) for q in (1, 2, 3, 4) if (y, q) <= (2025, 3)]
FIT_LAG_MS = 48 * qt.HOUR_MS                     # las fórmulas de un trimestre se ajustan hasta 48 h antes de que empiece
EMBARGO_MS = 36 * qt.HOUR_MS                     # tope de la operación (cierre obligatorio)
QUARTER_CAP = 0.15                               # ningún trimestre aporta más del 15 % de una clase
FLAT_CLASSES = ap.FLAT_OPTIONS
SEED = 20261028


def qname(y, q):
    return "{}Q{}".format(y, q)


def qstart_ms(y, q):
    return qt.date_ms("{}-{:02d}-01".format(y, 3 * (q - 1) + 1))


def qend_ms(y, q):
    return qstart_ms(y + (q == 4), q % 4 + 1)


def _day(ms):
    return qt.stamp(ms)


# --------------------------------------------------------------------------- the formulas of each quarter


def facts_file(cache_dir, product, from_day, to_day, out, *, extra_eth=False, on_progress=None):
    """Una foto cada 15 min de ``product`` con los números de la ficha (sin futuro) y los movimientos a 12 / 24 / 48 h (solo caché)."""
    from . import positioning_data
    from .futures_qwen_live import apply_overrides

    cfg = apply_overrides(qt.load_config(qt.CONFIG_PATH_LIVE))
    cfg["practice"] = dict(cfg["practice"], **{"from": from_day})
    holdout = qt.load_holdout_ms()
    to_ms = min(qt.date_ms(to_day), holdout)
    history = qt.History(cache_dir, holdout, offline=True)
    start = qt.date_ms(from_day)
    warm = start - cfg["practice"]["warmup_days"] * qt.DAY_MS
    bars = history.bars(product, warm, to_ms)
    trader = qt.Trader(cfg, product, None, qt.FundingLine(history.funding(product)), key="destila", entry_threshold=cfg["practice_entry_threshold"])
    if extra_eth:
        trader.positioning = positioning_data.PositioningFeed(positioning_data.default_path(), product)
    for other in cfg.get("state_context") or ():
        if other != product:
            trader.context[other] = {int(b["bucket_start"]) + qt.BAR_MS: float(b["close"]) for b in history.bars(other, warm, to_ms)}
    closes, found = {}, []
    cost = float(round_trip_cost_bps(product))
    total_wakes = max(1, (to_ms - start) // (15 * qt.MINUTE_MS))
    for bar in bars:
        trader.feed(bar, trade=False)
        t_ms = int(bar["bucket_start"]) + qt.BAR_MS
        closes[t_ms] = float(bar["close"])
        if t_ms < start or len(trader.c) < qt.MIN_BARS or t_ms % (15 * qt.MINUTE_MS):
            continue
        row = maestro.flat_facts(fficha.facts(trader, t_ms), extra_eth=extra_eth)
        row["hour"] = (t_ms // qt.HOUR_MS) % 24
        found.append((t_ms, row))
        if on_progress is not None and len(found) % 1000 == 0:
            on_progress(len(found), total_wakes)
    n = 0
    with open(out, "w", encoding="utf-8") as handle:
        for t_ms, row in found:
            row.update({"product": product, "t_ms": t_ms, "cost_bp": cost, "close": closes[t_ms]})
            for m in (720, 1440, 2880):
                c1 = closes.get(t_ms + m * qt.MINUTE_MS)
                row["move_{}".format(m)] = None if c1 is None else (c1 / closes[t_ms] - 1) * 1e4
            handle.write(json.dumps(row) + "\n")
            n += 1
    return n


def fit_pairs(facts_paths, cache_dir, out_dir, log=print):
    """El maestro y el portero de cada trimestre de ``QUARTERS``, ajustados con las fotos de BTC+ETH desde ``FACTS_FROM`` hasta 48 h
    antes de que empiece el trimestre. Devuelve ``{trimestre: {maestro, portero, maestro_hash, portero_hash, hasta, fotos}}``."""
    rows = []
    for path in facts_paths:
        rows += maestro.read_facts(path, FACTS_FROM, None)
    history = qt.History(cache_dir, qt.load_holdout_ms(), offline=True)
    os.makedirs(out_dir, exist_ok=True)
    pairs = {}
    for y, q in QUARTERS:
        cutoff = _day(qstart_ms(y, q) - FIT_LAG_MS)
        part = [r for r in rows if r["t_ms"] < qt.date_ms(cutoff)]
        teacher = maestro.fit(part, note="Destilación: ajustado hasta {} (48 h antes de {}).".format(cutoff, qname(y, q)))
        paths = [os.path.join(out_dir, "{}-{}.json".format(kind, qname(y, q))) for kind in ("maestro", "portero")]
        _dump(paths[0], teacher)
        teacher = maestro.load(paths[0])
        keeper = portero.fit(portero.labelled(part, teacher, history), teacher,
                             note="Destilación: ajustado hasta {} (48 h antes de {}).".format(cutoff, qname(y, q)))
        _dump(paths[1], keeper)
        pairs[qname(y, q)] = {"maestro": os.path.abspath(paths[0]), "portero": os.path.abspath(paths[1]),
                              "maestro_hash": maestro.teacher_hash(teacher), "portero_hash": portero.portero_hash(keeper)[:12],
                              "hasta": cutoff, "fotos": len(part), "acierto_signo_ajuste": teacher["ajuste"]["acierto_signo"],
                              "umbral_portero": keeper["umbral"]}
        log("{}: maestro {} portero {} (ajustado hasta {}, {} fotos)".format(
            qname(y, q), pairs[qname(y, q)]["maestro_hash"], pairs[qname(y, q)]["portero_hash"], cutoff, len(part)))
    _dump(os.path.join(out_dir, "pares.json"), pairs)
    return pairs


def _dump(path, obj):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(obj, handle, indent=1, ensure_ascii=False)
        handle.write("\n")


def quarter_cfg(cfg, pair):
    """La config en vivo con el maestro y el portero de ese trimestre (los hashes que declara tienen que coincidir con los archivos)."""
    out = copy.deepcopy(cfg)
    out["corta"] = dict(out["corta"], maestro=pair["maestro"], maestro_hash=pair["maestro_hash"],
                        portero=pair["portero"], portero_hash=pair["portero_hash"])
    return out


# --------------------------------------------------------------------------- what the sheet says (to check that the label is readable)


def formula_from_text(state_text, in_position=False):
    """La decisión de la fórmula leída del TEXTO de la ficha (lo único que ve Qwen). Sin posición: LARGO / CORTO si el maestro dice
    FUERTE y el portero «CONVIENE ENTRAR» o las noticias están «A FAVOR del maestro»; si no, ESPERAR. Con posición: CERRAR si el
    maestro va EN CONTRA (flojo o fuerte)."""
    if in_position:
        return "CERRAR" if "va EN CONTRA de la posición" in state_text else "MANTENER"
    strong = re.search(r"\): (SUBE|BAJA) FUERTE \(puntaje", state_text)
    yes = "): CONVIENE ENTRAR (" in state_text or ": A FAVOR del maestro (" in state_text
    if strong and yes:
        return "LARGO" if strong.group(1) == "SUBE" else "CORTO"
    return "ESPERAR"


# --------------------------------------------------------------------------- collecting the looks

TRAIN_JSONL = "train.jsonl"
VALID_JSONL = "valid.jsonl"
VALID_INFO_JSONL = "valid-info.jsonl"


def _setup_destila_trader(history, cfg, product, from_ms, ahead, warmup):
    trader = qt.Trader(cfg, product, None, qt.FundingLine(history.funding(product)), key="destila", entry_threshold=cfg["practice_entry_threshold"])
    for other in cfg.get("state_context") or ():
        if other != product:
            trader.context[other] = {int(b["bucket_start"]) + qt.BAR_MS: float(b["close"]) for b in history.bars(other, from_ms - warmup, ahead)}
    return trader


def _step_open_position_destila(trader, product, t_ms, reasons, r, closes, hold_ms, open_trade, rows_pos):
    held = t_ms - trader.position.entry_ms
    now = qt.settle(product, trader.position, closes[t_ms], "strategy_exit", t_ms, trader.funding, trader.notional)["net_bp"]
    side = 1 if trader.position.side == "LONG" else -1
    act, _ = corta.formula_action(r, side)
    timed_out = bool(hold_ms) and held >= hold_ms
    if timed_out or act == "CERRAR":
        open_trade["final_bp"] = now
        for row in open_trade["rows"]:
            row["final_bp"] = now
            row["por_tiempo"] = timed_out
            row["vivida"] = ap.position_label(row["net_now_bp"], now)
        if act == "CERRAR" and not timed_out:
            row = ap._position_row(trader, t_ms, reasons, r, now, open_trade)
            row.update(final_bp=now, vivida=ap.position_label(now, now), formula="CERRAR", label="CERRAR",
                       held_min=int(held // qt.MINUTE_MS))
            rows_pos.append(row)
        trader.position = None
        trader.cooldown_until = t_ms + trader.cfg["guardrails"]["cooldown_min"] * qt.MINUTE_MS
        return None, False
    row = ap._position_row(trader, t_ms, reasons, r, now, open_trade)
    row.update(label=row["formula"], held_min=int(held // qt.MINUTE_MS))
    open_trade["rows"].append(row)
    rows_pos.append(row)
    return open_trade, True


def _sample_flat_look(trader, t_ms, reasons, flat_found):
    held_position, trader.position = trader.position, None
    try:
        flat_found.append((t_ms, trader.state_text(t_ms, reasons), trader.state_text(t_ms, reasons, mirror=True),
                           held_position is not None))
    finally:
        trader.position = held_position


def _build_flat_rows_destila(cfg, product, flat_found, readings, closes, cost, weak):
    rows_flat = []
    for t_ms, state, mirror, was_in_position in flat_found:
        op = ap.operation(cfg, t_ms, readings, closes, cost, weak)
        if op is None:
            continue
        formula = ap.formula_flat(op["maestro"], op["portero_si"], op.get("noticias_si", False))
        rows_flat.append({"kind": "flat", "product": product, "t_ms": t_ms, "month": ap._month(t_ms), "state_text": state,
                          "mirror_text": mirror, "maestro": op["maestro"], "portero_si": op["portero_si"], "portero_p": op["portero_p"],
                          "largo_bp": op["largo"]["neto_bp"], "corto_bp": op["corto"]["neto_bp"], "formula": formula, "label": formula,
                          "vivida": ap.flat_label(op["largo"]["neto_bp"], op["corto"]["neto_bp"]), "con_posicion_real": was_in_position})
    return rows_flat


def _wake_reading_destila(trader, t_ms):
    if len(trader.c) < qt.MIN_BARS:
        return None, None
    reasons = trader.wake_reasons(t_ms)
    if not reasons:
        return None, None
    facts = fficha.facts(trader, t_ms)
    if corta.missing(facts):
        return None, None
    return reasons, corta.readings(trader, t_ms, facts)


def _step_window_destila(trader, product, t_ms, reasons, r, closes, hold_ms, open_trade, rows_pos, flat_found, rng, entry_rate, wait_rate):
    action = ap.formula_flat(r["veredicto"], r["portero_si"], r.get("noticias_si", False))
    rate = entry_rate if action != "ESPERAR" else wait_rate
    if rng.random() < rate:  # NOSONAR
        _sample_flat_look(trader, t_ms, reasons, flat_found)
    if trader.position is not None:
        open_trade, keep_going = _step_open_position_destila(trader, product, t_ms, reasons, r, closes, hold_ms, open_trade, rows_pos)
        if keep_going:
            return open_trade
    if t_ms >= trader.cooldown_until and action in ("LARGO", "CORTO"):
        trader._open(t_ms, "LONG" if action == "LARGO" else "SHORT", r["portero_p"], "formula")
        open_trade = {"trade_no": trader.position.trade_no, "rows": []}
    return open_trade


def collect_formula(history, cfg, product, from_ms, to_ms, *, entry_rate=1.0, wait_rate=0.03, seed=SEED):
    """Como ``futures_qwen_aprende.collect`` pero con la etiqueta = la decisión de la fórmula y sin esperar a estar sin posición:
    cada mirada con ficha completa se juzga como si no hubiera posición (``formula`` LARGO / CORTO / ESPERAR; es lo que dice la
    ficha, y hay muchas más entradas que operaciones). ``entry_rate`` / ``wait_rate`` = fracción que se guarda de las miradas con
    / sin entrada. Con posición real (la que las fórmulas abrirían): una fila por mirada con ``formula`` CERRAR / MANTENER."""
    warmup = cfg["practice"]["warmup_days"] * qt.DAY_MS
    rng = random.Random("{}:{}:{}".format(seed, product, from_ms))  # NOSONAR
    hold = cfg["guardrails"]["max_hold_min"]
    hold_ms = hold * qt.MINUTE_MS if hold else None
    ahead = min(to_ms + (hold or 0) * qt.MINUTE_MS, history.holdout_ms)
    bars = history.bars(product, from_ms - warmup, ahead)
    trader = _setup_destila_trader(history, cfg, product, from_ms, ahead, warmup)
    weak = corta.formulas(cfg)[0]["umbrales"]["flojo"]
    cost = float(round_trip_cost_bps(product))
    closes, readings, flat_found, rows_pos = {}, {}, [], []
    open_trade = None
    for bar in bars:
        trader.feed(bar, trade=False)
        t_ms = int(bar["bucket_start"]) + qt.BAR_MS
        closes[t_ms] = float(bar["close"])
        reasons, r = _wake_reading_destila(trader, t_ms)
        if r is None:
            continue
        readings[t_ms] = r
        if from_ms <= t_ms < to_ms:
            open_trade = _step_window_destila(
                trader, product, t_ms, reasons, r, closes, hold_ms, open_trade, rows_pos, flat_found, rng, entry_rate, wait_rate
            )
    rows_flat = _build_flat_rows_destila(cfg, product, flat_found, readings, closes, cost, weak)
    rows_pos = [r for r in rows_pos if r.get("final_bp") is not None]
    return {"flat": rows_flat, "position": rows_pos}


# --------------------------------------------------------------------------- balance


def _quarter_of(row):
    y, m = int(row["month"][:4]), int(row["month"][5:])
    return qname(y, (m - 1) // 3 + 1)


def _fill_group(group, want, limit, taken, used):
    got = 0
    for row in group:
        if got >= want:
            break
        qtr = _quarter_of(row)
        if used[qtr] < limit and row not in taken:
            taken.append(row)
            used[qtr] += 1
            got += 1


def pick(rows, n, rng, cap=QUARTER_CAP, half_long=False):
    """``n`` filas al azar con cupo por trimestre (ninguno más del ``cap`` de ``n``); con ``half_long`` la mitad, si hay, de miradas con
    más de 12 h de posición (ahí se decide algo). Menos de ``n`` si no hay."""
    limit = max(1, int(math.ceil(cap * n)))
    rows = list(rows)
    rng.shuffle(rows)  # NOSONAR
    taken, used = [], collections.Counter()
    groups = [[r for r in rows if r.get("held_min", 0) > 720], [r for r in rows if r.get("held_min", 0) <= 720]] if half_long else [rows]
    wants = [n // 2, n - n // 2] if half_long else [n]
    for want, group in zip(wants, groups):
        _fill_group(group, want, limit, taken, used)
    _fill_group(rows, n - len(taken), limit, taken, used)
    return taken


def build_split(cfg, flat, position, flat_n, close_n, seed, out_path, info_path, *, cap=QUARTER_CAP, position_cap=0.25):
    """Escribe un archivo mlx-lm (formato chat) y, al lado, lo que vale cada ejemplo. Sin posición: ``flat_n`` de cada clase con su
    espejo y las dos órdenes de letras. Con posición: todas las CERRAR (hasta ``close_n``) y otras tantas MANTENER. Devuelve el reparto."""
    rng = random.Random(seed)  # NOSONAR
    chosen_flat = []
    for name in FLAT_CLASSES:
        chosen_flat += pick([r for r in flat if r["formula"] == name], flat_n, rng, cap)
    closes = pick([r for r in position if r["formula"] == "CERRAR"], close_n, rng, position_cap)
    keeps = pick([r for r in position if r["formula"] == "MANTENER"], len(closes), rng, position_cap, half_long=True)
    pairs = []
    for row in chosen_flat:
        group = "{}:{}".format(row["product"], row["t_ms"])
        for mirror in (False, True):
            for order, example in enumerate(ap.chat_examples(cfg, row, mirror)):
                pairs.append((example, dict(ap.info_of(row, mirror), grupo=group, espejo=mirror, orden=order, mes=row["month"])))
    for row in closes + keeps:
        group = "{}:{}".format(row["trade"], row["t_ms"])
        for order, example in enumerate(ap.chat_examples(cfg, row)):
            pairs.append((example, dict(ap.info_of(row), grupo=group, espejo=False, orden=order, mes=row["month"])))
    random.Random(seed + 1).shuffle(pairs)  # NOSONAR
    ap.write_jsonl(out_path, [e for e, _ in pairs])
    ap.write_jsonl(info_path, [i for _, i in pairs])
    return {"ejemplos": len(pairs), "sin_posicion": dict(collections.Counter(r["formula"] for r in chosen_flat)),
            "con_posicion": dict(collections.Counter(r["formula"] for r in closes + keeps)),
            "por_trimestre_sin_posicion": dict(sorted(collections.Counter(_quarter_of(r) for r in chosen_flat).items()))}


def check_readable(rows):
    """La etiqueta se deduce del texto de la ficha (100 %) y la ficha dada vuelta lleva la etiqueta opuesta. Devuelve los fallos."""
    bad = []
    for row in rows:
        if row["kind"] == "flat":
            if formula_from_text(row["state_text"]) != row["formula"]:
                bad.append(("ficha", row["t_ms"], row["formula"], formula_from_text(row["state_text"])))
            if formula_from_text(row["mirror_text"]) != ap.MIRROR_LABEL[row["formula"]]:
                bad.append(("espejo", row["t_ms"], ap.MIRROR_LABEL[row["formula"]], formula_from_text(row["mirror_text"])))
        elif formula_from_text(row["state_text"], True) != row["formula"]:
            bad.append(("posicion", row["t_ms"], row["formula"], formula_from_text(row["state_text"], True)))
    return bad


# --------------------------------------------------------------------------- measuring (pure; the model calls are in ops/qwen-lora/destila_eval.py)


def _action_net(info, action):
    if action == "LARGO":
        return info["largo_bp"]
    if action == "CORTO":
        return info["corto_bp"]
    return None


def _mean_or_none(xs):
    return round(sum(xs) / len(xs), 2) if xs else None


def valid_report(records):
    """``records``: ``[{info, options{letra: id}, answer(id), gold(id)}]`` sobre ejemplos de ``valid.jsonl`` (con espejo y órdenes).
    Devuelve acuerdo con la fórmula, por clase, costumbre (parte de la respuesta más repetida), espejo (de las respuestas LARGO / CORTO
    a la ficha real, qué parte contesta lo opuesto a la ficha dada vuelta, mismo orden de letras) y el neto por entrada de seguir la
    opinión contra la fórmula sola."""
    n = len(records)
    hits = sum(1 for r in records if r["answer"] == r["gold"])
    by_class = collections.defaultdict(lambda: [0, 0])
    said = collections.Counter(r["answer"] for r in records)
    for r in records:
        by_class[r["gold"]][0] += r["answer"] == r["gold"]
        by_class[r["gold"]][1] += 1
    real = {(r["info"]["grupo"], r["info"]["orden"]): r for r in records if r["info"]["kind"] == "flat" and not r["info"]["espejo"]}
    mirror = {(r["info"]["grupo"], r["info"]["orden"]): r for r in records if r["info"]["kind"] == "flat" and r["info"]["espejo"]}
    sided = sum(1 for key, r in real.items() if r["answer"] in ("LARGO", "CORTO") and key in mirror)
    flips = sum(1 for key, r in real.items() if r["answer"] in ("LARGO", "CORTO") and key in mirror
                and mirror[key]["answer"] == ap.MIRROR_LABEL[r["answer"]])
    own = [val for r in real.values() for val in (_action_net(r["info"], r["answer"]),) if val is not None]
    formula = [val for r in real.values() for val in (_action_net(r["info"], r["gold"]),) if val is not None]
    return {"n": n, "acuerdo": round(hits / n, 4) if n else None,
            "acuerdo_por_clase": {k: round(v[0] / v[1], 3) for k, v in sorted(by_class.items())},
            "reparto": dict(said), "costumbre_parte": round(max(said.values()) / n, 3) if n else None,
            "espejo_da_vuelta": round(flips / sided, 3) if sided else None, "espejo_n": sided,
            "entradas": len(own), "neto_por_entrada_bp": _mean_or_none(own), "formula_entradas": len(formula), "formula_neto_por_entrada_bp": _mean_or_none(formula)}


def sample_groups(infos, n_examples):
    """Los índices de una muestra fija de ``n_examples`` ejemplos de ``valid.jsonl`` repartida por grupos completos (una ficha con su
    espejo y sus dos órdenes, o una posición con sus dos órdenes), para poder medir el espejo."""
    groups = collections.OrderedDict()
    for i, info in enumerate(infos):
        groups.setdefault((info["kind"], info["grupo"]), []).append(i)
    flat = [v for (k, _), v in groups.items() if k == "flat"]
    pos = [v for (k, _), v in groups.items() if k == "position"]
    take = lambda items, want: [items[int(j * len(items) / want)] for j in range(want)] if want < len(items) else items
    want_pos = min(len(pos), max(1, (n_examples // 4) // 2))        # un cuarto de los ejemplos con posición
    want_flat = min(len(flat), (n_examples - 2 * want_pos) // 4)
    chosen = take(flat, want_flat) + take(pos, want_pos)
    return sorted(i for g in chosen for i in g)


def verdict(report):
    """PASA la destilación (reglas fijas del diseño): acuerdo ≥ 85 %, espejo ≥ 90 %, ninguna respuesta > 70 %."""
    checks = {"acuerdo con la fórmula ≥ 85 %": (report["acuerdo"] or 0) >= 0.85,
              "el espejo da vuelta ≥ 90 %": (report["espejo_da_vuelta"] or 0) >= 0.90,
              "ninguna respuesta > 70 % (no es una costumbre)": (report["costumbre_parte"] or 1) <= 0.70}
    return checks, all(checks.values())


# --------------------------------------------------------------------------- the night: when to go on, when to stop, which checkpoint

PILOT_MIRROR = 0.5                               # tras el primer tramo (250 pasos) el espejo tiene que superar esto: si no, la receta no lee
DONE_AGREEMENT, DONE_MIRROR, HABIT = 0.90, 0.90, 0.70
STALE_STEP = 0.005                               # un tramo «sube» el acuerdo si lo mejora en más de medio punto


def _is_stalled(history, patience_best):
    if patience_best:
        if len(history) <= patience_best:
            return False, ""
        before = max(h["acuerdo"] or 0 for h in history[:-patience_best])
        stalled = all((h["acuerdo"] or 0) <= before + STALE_STEP for h in history[-patience_best:])
        return stalled, "{} mediciones seguidas sin superar la mejor".format(patience_best)
    stalled = len(history) >= 3 and all(history[-i]["acuerdo"] <= history[-i - 1]["acuerdo"] + STALE_STEP for i in (1, 2))
    return stalled, "dos tramos seguidos no suben el acuerdo"


def decide(history, patience_best=None):
    """``history``: una medición de validación por tramo (``paso``, ``acuerdo``, ``espejo_da_vuelta``, ``costumbre_parte``), en orden.
    Devuelve ``(acción, motivo)``: ``piloto_falla`` (corta la noche), ``listo`` (acuerdo y espejo ≥ 90 %), ``sin_mejora`` (dos tramos
    seguidos no suben el acuerdo) o ``sigue``."""
    last = history[-1]
    mirror = last.get("espejo_da_vuelta")
    if len(history) == 1 and (mirror is None or mirror < PILOT_MIRROR):
        return "piloto_falla", "tras {} pasos el espejo da vuelta {} (hace falta más de {} %): la receta no lee la ficha".format(
            last["paso"], "n/d" if mirror is None else "{:.0f} %".format(100 * mirror), int(100 * PILOT_MIRROR))
    if (last["acuerdo"] or 0) >= DONE_AGREEMENT and (mirror or 0) >= DONE_MIRROR and (last["costumbre_parte"] or 1) <= HABIT:
        return "listo", "acuerdo y espejo ≥ 90 %"
    stalled, reason = _is_stalled(history, patience_best)
    if stalled:
        return "sin_mejora", reason
    return "sigue", ""


def best_step(history):
    """El mejor checkpoint: mayor acuerdo entre los que no son una costumbre y tienen espejo ≥ 90 %; si ninguno lo tiene, el de mayor
    acuerdo entre los que no son costumbre; si todos lo son, el último. Devuelve el ``paso``."""
    ok = [h for h in history if (h["costumbre_parte"] or 1) <= HABIT]
    firm = [h for h in ok if (h.get("espejo_da_vuelta") or 0) >= DONE_MIRROR]
    pool = firm or ok or history[-1:]
    return max(pool, key=lambda h: (h["acuerdo"] or 0, -h["paso"]))["paso"]


def night_report(base, history, best, practice, meta=None, valid_label="2025-08/09"):
    """El informe de la mañana (Markdown): PASA / NO pasa de la destilación y las tablas."""
    top = next(h for h in history if h["paso"] == best)
    checks, passes = verdict(top)
    pct = lambda x: "n/d" if x is None else "{:.0f} %".format(100 * x)
    pb = lambda x: "n/d" if x is None else "{:+.1f} pb".format(x)
    lines = ["# Qwen aprende a leer la ficha: qué dejó la noche", "",
             "**Veredicto de la destilación: {}** (checkpoint del paso {}, elegido en la validación {}, no en la práctica).".format(
                 "PASA" if passes else "NO pasa", best, valid_label), ""]
    lines += ["- {} {}".format("✓" if ok else "✗", name) for name, ok in checks.items()]
    lines += ["", "Esto mide si Qwen LEE la ficha como la fórmula. No mide si gana más plata: el objetivo de esta corrida no es ganarle a la fórmula.", "",
              "## Validación en cada tramo", "", "| Paso | Acuerdo con la fórmula | Espejo da vuelta | Respuesta más repetida | Neto por entrada | Neto de la fórmula |",
              "|---|---|---|---|---|---|"]
    if base:
        lines.append("| 0 (sin entrenar) | {} | {} | {} | {} | {} |".format(pct(base["acuerdo"]), pct(base["espejo_da_vuelta"]), pct(base["costumbre_parte"]),
                                                                       pb(base["neto_por_entrada_bp"]), pb(base["formula_neto_por_entrada_bp"])))
    for h in history:
        lines.append("| {} | {} | {} | {} | {} | {} |".format(h["paso"], pct(h["acuerdo"]), pct(h["espejo_da_vuelta"]), pct(h["costumbre_parte"]),
                                                         pb(h["neto_por_entrada_bp"]), pb(h["formula_neto_por_entrada_bp"])))
    if practice:
        e, f = practice["entradas"], practice["formula_entradas"]
        lines += ["", "## Práctica 2025-10-16 a 2026-04-18 (una sola vez, con el mejor checkpoint)", "",
                  "| | Entradas | Neto por entrada | Ganadoras |", "|---|---|---|---|",
                  "| Fórmula sola | {} | {} | {} |".format(f["n"], pb(f["neto_bp"]), pct(f["ganadoras"])),
                  "| Qwen entrenado | {} | {} | {} |".format(e["n"], pb(e["neto_bp"]), pct(e["ganadoras"])), "",
                  "Acuerdo con la fórmula: sin posición {}, con posición {}. Espejo da vuelta {}. Reparto de respuestas: {}.".format(
                      pct(practice["acierto_sin_posicion"]), pct(practice["acierto_con_posicion"]), pct(practice.get("espejo_da_vuelta")),
                      practice.get("reparto")), "", "Por mes (neto por entrada de Qwen): " + (", ".join(
                          "{} {} ({})".format(m, pb(v["neto_bp"]), v["n"]) for m, v in practice["por_mes"].items()) or "sin entradas")]
        gains = e["neto_bp"] is not None and f["neto_bp"] is not None and e["neto_bp"] > f["neto_bp"]
        lines += ["", "¿Le gana a la fórmula sola en la práctica? **{}** (era lo esperado: imita a la fórmula, no la supera).".format("Sí" if gains else "No")]
    if meta:
        lines += ["", "Dataset: {}".format(json.dumps(meta.get("balance", meta), ensure_ascii=False))]
    lines += ["", "Un PASA no cambia nada en vivo: el adaptador no se carga solo; se decide aparte."]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- one night per quarter (walk-forward)


def parse_quarter(text):
    """``2024Q1`` -> (2024, 1)."""
    m = re.fullmatch(r"(\d{4})Q([1-4])", text or "")
    if not m:
        raise SystemExit("el trimestre se escribe así: 2024Q1")
    return int(m.group(1)), int(m.group(2))


def previous_quarter(y, q):
    return (y - 1, 4) if q == 1 else (y, q - 1)


def quarter_rows(history, cfg, y, q, rows_dir, wait_rate):
    """Las miradas del trimestre (sin y con posición), con la etiqueta de la fórmula que regía ESE trimestre. Se juntan una sola vez y
    quedan en ``rows_dir`` (la etiqueta de un trimestre no cambia cuando llega el siguiente)."""
    path = os.path.join(rows_dir, "filas-{}.jsonl.gz".format(qname(y, q)))
    if os.path.exists(path):
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            rows = [json.loads(x) for x in handle if x.strip()]
        return {"flat": [r for r in rows if r["kind"] == "flat"], "position": [r for r in rows if r["kind"] != "flat"]}
    part = collect_formula(history, cfg, PRODUCT, qstart_ms(y, q), qend_ms(y, q), entry_rate=1.0, wait_rate=wait_rate)
    os.makedirs(rows_dir, exist_ok=True)
    with gzip.open(path + ".tmp", "wt", encoding="utf-8") as handle:
        for row in part["flat"] + part["position"]:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    os.replace(path + ".tmp", path)
    return part


def _partition_by_cutoff(part, cut, train_flat, train_pos, valid_flat, valid_pos):
    for row in part["flat"]:
        if row["t_ms"] >= cut:
            valid_flat.append(row)
        elif row["t_ms"] + EMBARGO_MS <= cut:
            train_flat.append(row)
    for row in part["position"]:
        if row["t_ms"] >= cut:
            valid_pos.append(row)
        elif row["t_ms"] + EMBARGO_MS <= cut:
            train_pos.append(row)


def _file_hashes(out_dir, names):
    out = {}
    for n in names:
        with open(os.path.join(out_dir, n), "rb") as handle:
            out[n] = hashlib.sha256(handle.read()).hexdigest()[:16]
    return out


def _build_quarter(args):
    """El dataset de la noche del trimestre T: entrena con los trimestres 2023T1 .. T-1 (cada fila con la fórmula de su trimestre, ningún
    trimestre pasa del 15 % de una clase) y mide en T, que ese adaptador no vio. Un embargo de 36 h separa los dos. Sin práctica ni holdout."""
    from . import futures_walkforward as wf
    y, q = parse_quarter(args.trimestre)
    first = (2023, 1)
    if (y, q) <= first:
        raise SystemExit("el primer trimestre que se puede medir es 2023Q2 (antes no hay con qué entrenar)")
    cut = qstart_ms(y, q)
    if cut >= qt.load_holdout_ms():
        raise SystemExit("ese trimestre llega al holdout: no se toca")
    cfg = wf.with_pairs(qt.load_config(args.config or qt.CONFIG_PATH_LIVE), args.pares)
    history = qt.History(args.cache_dir, qt.load_holdout_ms(), offline=True)
    os.makedirs(args.out, exist_ok=True)
    train_flat, train_pos, valid_flat, valid_pos = [], [], [], []
    cur = first
    while cur <= (y, q):
        part = quarter_rows(history, cfg, cur[0], cur[1], args.rows_dir, args.wait_rate)
        _partition_by_cutoff(part, cut, train_flat, train_pos, valid_flat, valid_pos)
        print("{}: {} miradas sin posición, {} con posición".format(qname(*cur), len(part["flat"]), len(part["position"])), flush=True)
        cur = (cur[0] + (cur[1] == 4), cur[1] % 4 + 1)
    bad = check_readable(train_flat + train_pos + valid_flat + valid_pos)
    if bad:
        raise SystemExit("la etiqueta NO se deduce de la ficha en {} filas (primeras: {}): hay un error".format(len(bad), bad[:5]))
    pairs = wf.load_pairs(args.pares or wf.PARES_PATH)["trimestres"]
    meta = {"schema": SCHEMA + "-trimestre", "trimestre": qname(y, q), "producto": PRODUCT, "semilla": SEED,
            "prompt_version": cfg["prompt"]["version"], "tope_h": cfg["guardrails"]["max_hold_min"] // 60,
            "entrena": [qname(*first), qname(*previous_quarter(y, q))], "mide": qname(y, q), "embargo_h": EMBARGO_MS // qt.HOUR_MS,
            "cupo_trimestre": QUARTER_CAP, "pares": {k: v for k, v in pairs.items() if (int(k[:4]), int(k[5])) <= (y, q)}}
    meta["train"] = build_split(cfg, train_flat, train_pos, args.flat_n, args.close_n, SEED, os.path.join(args.out, TRAIN_JSONL),
                                os.path.join(args.out, "train-info.jsonl"))
    meta["valid"] = build_split(cfg, valid_flat, valid_pos, args.valid_flat_n, args.close_n, SEED + 7, os.path.join(args.out, VALID_JSONL),
                                os.path.join(args.out, VALID_INFO_JSONL), cap=1.0, position_cap=1.0)
    meta["sha256"] = _file_hashes(args.out, (TRAIN_JSONL, VALID_JSONL, VALID_INFO_JSONL))
    _dump(os.path.join(args.out, "meta.json"), meta)
    print(json.dumps({k: meta[k] for k in ("trimestre", "entrena", "mide", "train", "valid")}, ensure_ascii=False, indent=1))


def night_plan(last_done=None):
    """Las noches en orden: una por trimestre, de 2023Q2 al último que no llega al holdout. ``last_done`` = el último ya entrenado."""
    from . import futures_walkforward as wf
    names = [qname(*k) for k in wf.quarters(qt.load_holdout_ms())][1:]
    names = [n for n in names if qend_ms(int(n[:4]), int(n[5])) <= qt.load_holdout_ms()]
    if last_done:
        names = [n for n in names if (int(n[:4]), int(n[5])) > parse_quarter(last_done)]
    return names


# --------------------------------------------------------------------------- CLI


def _collect_all_quarters(history, cfg, pairs, wait_rate):
    train_flat, train_pos, valid_flat, valid_pos = [], [], [], []
    cut = qt.date_ms(VALID_FROM)
    for y, q in QUARTERS:
        name = qname(y, q)
        lo, hi = qstart_ms(y, q), min(qend_ms(y, q), qt.date_ms(VALID_TO))
        if lo < qt.date_ms(TRAIN_FROM):
            continue
        part = collect_formula(history, quarter_cfg(cfg, pairs[name]), PRODUCT, lo, hi, entry_rate=1.0, wait_rate=wait_rate)
        _partition_by_cutoff(part, cut, train_flat, train_pos, valid_flat, valid_pos)
        print("{}: {} miradas sin posición ({} entradas), {} con posición".format(
            name, len(part["flat"]), sum(1 for r in part["flat"] if r["formula"] != "ESPERAR"), len(part["position"])), flush=True)
    return train_flat, train_pos, valid_flat, valid_pos


def _write_gzip_rows(out_dir, name, rows):
    with gzip.open(os.path.join(out_dir, "filas-{}.jsonl.gz".format(name)), "wt", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def _build(args):
    cfg = qt.load_config(args.config or qt.CONFIG_PATH_LIVE)
    with open(os.path.join(args.pairs_dir, "pares.json"), encoding="utf-8") as handle:
        pairs = json.load(handle)
    history = qt.History(args.cache_dir, qt.load_holdout_ms(), offline=True)
    os.makedirs(args.out, exist_ok=True)
    train_flat, train_pos, valid_flat, valid_pos = _collect_all_quarters(history, cfg, pairs, args.wait_rate)
    live_pair = {"maestro": os.path.join(qt.ROOT, "config", cfg["corta"]["maestro"]), "maestro_hash": cfg["corta"]["maestro_hash"],
                 "portero": os.path.join(qt.ROOT, "config", cfg["corta"]["portero"]), "portero_hash": cfg["corta"]["portero_hash"]}
    practice = collect_formula(history, cfg, PRODUCT, qt.date_ms(PRACTICE_FROM), qt.date_ms(PRACTICE_TO), entry_rate=1.0, wait_rate=args.wait_rate)
    bad = check_readable(train_flat + train_pos + valid_flat + valid_pos + practice["flat"] + practice["position"])
    print("práctica: {} sin posición, {} con posición".format(len(practice["flat"]), len(practice["position"])))
    if bad:
        raise SystemExit("la etiqueta NO se deduce de la ficha en {} filas (primeras: {}): hay un error".format(len(bad), bad[:5]))
    for name, rows in (("train", train_flat + train_pos), ("valid", valid_flat + valid_pos)):
        _write_gzip_rows(args.out, name, rows)
    meta = {"schema": SCHEMA, "producto": PRODUCT, "semilla": SEED, "prompt_version": cfg["prompt"]["version"],
            "config_hash": qt.config_hash(cfg), "tope_h": cfg["guardrails"]["max_hold_min"] // 60,
            "cortes": {"train": [TRAIN_FROM, VALID_FROM], "valid": [VALID_FROM, VALID_TO], "practica": [PRACTICE_FROM, PRACTICE_TO],
                       "embargo_h": EMBARGO_MS // qt.HOUR_MS}, "cupo_trimestre": QUARTER_CAP,
            "pares": {k: {x: v[x] for x in ("maestro_hash", "portero_hash", "hasta", "fotos")} for k, v in pairs.items()},
            "par_practica": {x: live_pair[x] for x in ("maestro_hash", "portero_hash")},
            "balance": {"sin_posicion_por_clase_train": args.flat_n, "sin_posicion_por_clase_valid": args.valid_flat_n,
                        "con_posicion_cerrar_max_train": args.close_n}}
    meta["train"] = build_split(cfg, train_flat, train_pos, args.flat_n, args.close_n, SEED, os.path.join(args.out, TRAIN_JSONL),
                                os.path.join(args.out, "train-info.jsonl"))
    meta["valid"] = build_split(cfg, valid_flat, valid_pos, args.valid_flat_n, args.close_n, SEED + 7, os.path.join(args.out, VALID_JSONL),
                                os.path.join(args.out, VALID_INFO_JSONL), cap=1.0, position_cap=1.0)
    entries = [r for r in practice["flat"] if r["formula"] != "ESPERAR"]
    waits = [r for r in practice["flat"] if r["formula"] == "ESPERAR"]
    random.Random(SEED + 11).shuffle(waits)  # NOSONAR
    closes = [r for r in practice["position"] if r["formula"] == "CERRAR"]        # every close, and four times as many holds
    holds = [r for r in practice["position"] if r["formula"] == "MANTENER"]
    random.Random(SEED + 13).shuffle(holds)  # NOSONAR
    practice["position"] = sorted(closes + holds[:4 * len(closes)], key=lambda r: r["t_ms"])
    ap.write_jsonl(os.path.join(args.out, "practica.jsonl"), sorted(entries + waits[:2 * len(entries)], key=lambda r: r["t_ms"]) + practice["position"])
    meta["practica"] = {"sin_posicion": dict(collections.Counter(r["formula"] for r in entries + waits[:2 * len(entries)])),
                        "con_posicion": dict(collections.Counter(r["formula"] for r in practice["position"]))}
    # the net of the formula alone in each split (to compare an opinion against)
    meta["formula_sola_practica"] = ap.score_opinions(practice["flat"], practice["position"], lambda r: r["formula"])["formula_entradas"]
    meta["sha256"] = _file_hashes(args.out, (TRAIN_JSONL, VALID_JSONL, VALID_INFO_JSONL, "practica.jsonl"))
    _dump(os.path.join(args.out, "meta.json"), meta)
    print(json.dumps(meta, ensure_ascii=False, indent=1))


def _parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    f = sub.add_parser("facts")
    f.add_argument("--cache-dir", required=True)
    f.add_argument("--product", required=True)
    f.add_argument("--from", dest="from_day", default=FACTS_FROM)
    f.add_argument("--to", dest="to_day", default=PRACTICE_TO)
    f.add_argument("--out", required=True)
    a = sub.add_parser("ajustar")
    a.add_argument("--facts", nargs="+", required=True)
    a.add_argument("--cache-dir", required=True)
    a.add_argument("--out", required=True)
    r = sub.add_parser("informe")
    r.add_argument("--dir", required=True, help="carpeta de la noche: base-valid.json, historia.jsonl, best.json, best-practica.json")
    r.add_argument("--out", required=True)
    r.add_argument("--valid", default="2025-08/09", help="qué se midió (p. ej. el trimestre 2024Q1)")
    b = sub.add_parser("armar")
    b.add_argument("--cache-dir", required=True)
    b.add_argument("--pairs-dir", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--config", default=None)
    b.add_argument("--flat-n", type=int, default=600)
    b.add_argument("--valid-flat-n", type=int, default=120)
    b.add_argument("--close-n", type=int, default=400)
    b.add_argument("--wait-rate", type=float, default=0.03)
    t = sub.add_parser("armar-trimestre", help="el dataset de la noche de un trimestre (entrena con los anteriores, mide en ese)")
    t.add_argument("--trimestre", required=True, help="p. ej. 2024Q1")
    t.add_argument("--cache-dir", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--rows-dir", required=True, help="donde quedan las miradas ya juntadas de cada trimestre (se reutilizan)")
    t.add_argument("--pares", default=None, help="tabla de pares trimestrales (por defecto config/walkforward/pares.json)")
    t.add_argument("--config", default=None)
    t.add_argument("--flat-n", type=int, default=600)
    t.add_argument("--valid-flat-n", type=int, default=120)
    t.add_argument("--close-n", type=int, default=400)
    t.add_argument("--wait-rate", type=float, default=0.03)
    n = sub.add_parser("plan-noches", help="las noches que faltan, en orden")
    n.add_argument("--ultima", default=None, help="el último trimestre ya entrenado")
    return p


def main(argv=None):
    args = _parser().parse_args(argv)
    if args.command == "facts":
        print(facts_file(args.cache_dir, args.product, args.from_day, args.to_day, args.out), "fotos")
    elif args.command == "informe":
        load = lambda name: json.load(open(os.path.join(args.dir, name), encoding="utf-8"))
        history = [json.loads(x) for x in open(os.path.join(args.dir, "historia.jsonl"), encoding="utf-8") if x.strip()]
        path = lambda name: os.path.join(args.dir, name)
        text = night_report(load("base-valid.json") if os.path.exists(path("base-valid.json")) else None, history, load("best.json")["paso"],
                            load("best-practica.json") if os.path.exists(path("best-practica.json")) else None, valid_label=args.valid)
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
        print(text)
    elif args.command == "armar-trimestre":
        _build_quarter(args)
    elif args.command == "plan-noches":
        for name in night_plan(args.ultima):
            print(name)
    elif args.command == "ajustar":
        fit_pairs(args.facts, args.cache_dir, args.out)
    else:
        _build(args)


if __name__ == "__main__":
    main()
