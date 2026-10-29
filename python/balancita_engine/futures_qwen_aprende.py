"""Que Qwen aprenda junto al maestro (versión 9 de Qwen en vivo, hilo «Que Qwen aprenda junto al maestro»).

Deciden las fórmulas (maestro y portero); Qwen mira la MISMA ficha corta y opina. Aquí se arma lo que hace falta para que su opinión
mejore con cada decisión:

* ``collect``: recorre el pasado con las fórmulas como en vivo (entran con maestro FUERTE y portero SÍ, salen cuando el maestro se
  da vuelta o a las 48 h) y junta EJEMPLOS: cada mirada sin posición (``flat``) y cada mirada con la posición que las fórmulas
  habrían abierto (``position``), con el texto de la ficha exactamente como lo ve Qwen y con lo que pasó después.
* Etiqueta = la acción correcta mirando el resultado NETO tras costos (nada de acierto de signo): sin posición, LARGO o CORTO si la
  operación de la versión 8 en ese lado termina positiva (el lado que más), ESPERAR si ninguna; con posición, CERRAR si cerrar ahora
  deja al menos lo que dejó la operación de las fórmulas hasta su final, MANTENER si no.
* ``dataset``: ejemplos de chat (mlx-lm) con la pregunta REAL de la config en vivo en las dos órdenes de letras, el espejo de las
  miradas sin posición (LARGO <-> CORTO) y las clases balanceadas.
* ``score_opinions``: dado lo que contestó una opinión en cada ejemplo, el neto por operación si se hubiera seguido esa opinión
  contra la fórmula sola, ganadoras y por mes. Sirve igual para un Qwen real, para la fórmula, para el azar o para el oráculo.
* ``resolve_live``: lo mismo en vivo: a cada mirada guardada en la base en vivo le pone su etiqueta cuando el resultado se conoce
  (tabla ``examples``), y ``export_live`` los saca en el mismo formato del dataset para el reentreno.

Nada de esto lee el holdout (``History`` lo rechaza) ni llama a ningún modelo.
"""

import argparse
import collections
import copy
import json
import os
import random
import time

from . import futures_qwen_corta as corta
from . import futures_qwen_ficha as fficha
from . import futures_qwen_trader as qt
from . import futures_qwen_trader_exam as ex
from . import futures_llm_decisions as llm
from .futures_costs import round_trip_cost_bps

DATASET_SCHEMA = "balancita-qwen-aprende-dataset.v1"
FLAT_OPTIONS = ("LARGO", "CORTO", "ESPERAR")
POSITION_OPTIONS = ("MANTENER", "CERRAR")
MIRROR_LABEL = {"LARGO": "CORTO", "CORTO": "LARGO", "ESPERAR": "ESPERAR"}
TRAIN_FROM, TRAIN_TO = "2022-04-01", "2025-10-01"
PRACTICE_FROM, PRACTICE_TO = "2025-10-16", "2026-04-19"
VALID_MONTHS = 2
WORTH_BP = 25.0                  # entrar solo vale la pena si el mejor lado deja al menos esto neto (~2,5 veces el costo de ida y vuelta)
DAY_MS, HOUR_MS, MINUTE_MS = qt.DAY_MS, qt.HOUR_MS, qt.MINUTE_MS
LETTERS = llm.LETTERS


# --------------------------------------------------------------------------- labels (pure)


def flat_label(largo_bp, corto_bp, worth_bp=WORTH_BP):
    """La acción correcta sin posición, mirando el neto tras costos de la operación en cada lado: el lado que más deja si deja al
    menos ``worth_bp``; si no, ESPERAR (con 0 casi nunca se espera: algún lado termina positivo ~86 % de las veces)."""
    best = max(largo_bp, corto_bp)
    if best < worth_bp:
        return "ESPERAR"
    return "LARGO" if largo_bp >= corto_bp else "CORTO"


def position_label(net_now_bp, final_bp):
    """Con posición: CERRAR si cerrar ahora deja al menos lo que dejó la operación de las fórmulas hasta su final."""
    return "CERRAR" if net_now_bp >= final_bp else "MANTENER"


def formula_flat(maestro, portero_si, noticias_si=False):
    """Lo que hacen las fórmulas sin posición (``futures_qwen_corta.formula_action`` con el portero o el analista de noticias)."""
    if abs(maestro) == 2 and (portero_si or noticias_si):
        return "LARGO" if maestro > 0 else "CORTO"
    return "ESPERAR"


# --------------------------------------------------------------------------- collect (the past, as the formulas would live it)

FORMULA_SOLA = "Fórmula sola"


def _month(t_ms):
    return time.strftime("%Y-%m", time.gmtime(t_ms / 1000))


def _setup_aprende_trader(history, cfg, product, from_ms, end_ms, warmup):
    funding = qt.FundingLine(history.funding(product))
    trader = qt.Trader(cfg, product, None, funding, key="aprende", entry_threshold=cfg["practice_entry_threshold"])
    for other in cfg.get("state_context") or ():
        if other != product:
            trader.context[other] = {int(b["bucket_start"]) + qt.BAR_MS: float(b["close"]) for b in history.bars(
                other, from_ms - warmup, end_ms)}
    return trader, funding


def _wake_reading_aprende(trader, t_ms):
    if len(trader.c) < qt.MIN_BARS:
        return None, None
    reasons = trader.wake_reasons(t_ms)
    if not reasons:
        return None, None
    facts = fficha.facts(trader, t_ms)
    if corta.missing(facts):
        return None, None
    return reasons, corta.readings(trader, t_ms, facts)


def _step_open_position_aprende(trader, t_ms, reasons, r, closes, hold_ms, open_trade, rows_pos):
    held = t_ms - trader.position.entry_ms
    now = qt.settle(trader.product, trader.position, closes[t_ms], "strategy_exit", t_ms, trader.funding, trader.notional)["net_bp"]
    side = 1 if trader.position.side == "LONG" else -1
    action, _ = corta.formula_action(r, side)
    timed_out = bool(hold_ms) and held >= hold_ms
    if timed_out or action == "CERRAR":
        open_trade["final_bp"] = now
        for row in open_trade["rows"]:
            row["final_bp"] = now
            row["por_tiempo"] = timed_out
            row["salida_ms"] = t_ms
            row["label"] = position_label(row["net_now_bp"], now)
        if not timed_out:
            rows_pos.append(dict(_position_row(trader, t_ms, reasons, r, now, open_trade), final_bp=now,
                                 label="CERRAR", salida_ms=t_ms))
        trader.position = None
        trader.cooldown_until = t_ms + trader.cfg["guardrails"]["cooldown_min"] * MINUTE_MS
        return None, False
    row = _position_row(trader, t_ms, reasons, r, now, open_trade)
    open_trade["rows"].append(row)
    rows_pos.append(row)
    return open_trade, True


def _step_window_aprende(trader, t_ms, reasons, r, closes, hold_ms, open_trade, rows_pos, flat_found, trades, rng, flat_rate):
    if trader.position is not None:
        open_trade, keep_going = _step_open_position_aprende(trader, t_ms, reasons, r, closes, hold_ms, open_trade, rows_pos)
        if keep_going:
            return open_trade
    if t_ms < trader.cooldown_until:
        return open_trade
    if rng.random() < flat_rate:  # NOSONAR
        flat_found.append((t_ms, reasons, trader.state_text(t_ms, reasons), trader.state_text(t_ms, reasons, mirror=True)))
    action = formula_flat(r["veredicto"], r["portero_si"], r.get("noticias_si", False))
    if action in ("LARGO", "CORTO"):
        trader._open(t_ms, "LONG" if action == "LARGO" else "SHORT", r["portero_p"], "formula")
        open_trade = {"trade_no": trader.position.trade_no, "rows": [], "entry_ms": t_ms, "side": action}
        trades.append(open_trade)
    return open_trade


def _build_flat_rows_aprende(cfg, product, flat_found, readings, closes, cost, weak):
    rows_flat = []
    for t_ms, _reasons, state, mirror in flat_found:
        op = operation(cfg, t_ms, readings, closes, cost, weak)
        if op is None:
            continue
        rows_flat.append({"kind": "flat", "product": product, "t_ms": t_ms, "month": _month(t_ms), "state_text": state,
                          "mirror_text": mirror, "maestro": op["maestro"], "portero_si": op["portero_si"],
                          "portero_p": op["portero_p"], "largo_bp": op["largo"]["neto_bp"], "corto_bp": op["corto"]["neto_bp"],
                          "largo_h": op["largo"]["horas"], "corto_h": op["corto"]["horas"],
                          "label": flat_label(op["largo"]["neto_bp"], op["corto"]["neto_bp"]),
                          "formula": formula_flat(op["maestro"], op["portero_si"], op.get("noticias_si", False))})
    return rows_flat


def collect(history, cfg, product, from_ms, to_ms, *, flat_rate=0.15, seed=20261027):
    """Recorre ``[from_ms, to_ms)`` de ``product`` wake a wake y devuelve ``{"flat": [...], "position": [...]}``.

    ``flat``: una fila por mirada muestreada (``flat_rate`` de las miradas) con ``state_text``, ``mirror_text``, la lectura de las
    fórmulas, el neto de la operación en cada lado (``largo_bp`` / ``corto_bp``) y ``label``. ``position``: una fila por mirada con la
    posición que las fórmulas habrían abierto, con ``state_text``, ``net_now_bp``, ``final_bp``, ``trade`` y ``label``. Una mirada
    sin ficha completa no existe (en vivo se omite)."""
    warmup = cfg["practice"]["warmup_days"] * DAY_MS
    rng = random.Random("{}:{}".format(seed, product))  # NOSONAR
    hold = cfg["guardrails"]["max_hold_min"]
    ahead = to_ms + hold * MINUTE_MS if hold else history.holdout_ms
    end_ms = min(ahead, history.holdout_ms)
    bars = history.bars(product, from_ms - warmup, end_ms)
    trader, _funding = _setup_aprende_trader(history, cfg, product, from_ms, end_ms, warmup)
    weak = corta.formulas(cfg)[0]["umbrales"]["flojo"]
    cost = float(round_trip_cost_bps(product))
    hold_ms = hold * MINUTE_MS if hold else None
    closes, readings, flat_found, trades, rows_pos = {}, {}, [], [], []
    open_trade = None
    for bar in bars:
        trader.feed(bar, trade=False)
        t_ms = int(bar["bucket_start"]) + qt.BAR_MS
        closes[t_ms] = float(bar["close"])
        reasons, r = _wake_reading_aprende(trader, t_ms)
        if r is None:
            continue
        readings[t_ms] = r
        if from_ms <= t_ms < to_ms:
            open_trade = _step_window_aprende(
                trader, t_ms, reasons, r, closes, hold_ms, open_trade, rows_pos, flat_found, trades, rng, flat_rate
            )
    rows_flat = _build_flat_rows_aprende(cfg, product, flat_found, readings, closes, cost, weak)
    rows_pos = [r for r in rows_pos if r.get("final_bp") is not None]
    return {"flat": rows_flat, "position": rows_pos}


def operation(cfg, t_ms, readings, closes, cost, weak):
    """Lo que dijeron las fórmulas en la mirada y el resultado de la operación (sale cuando el maestro se da vuelta; sin límite de
    tiempo) en cada lado. ``None`` si alguno de los lados todavía no salió."""
    r = readings.get(t_ms)
    if r is None:
        return None
    sides = {name: ex._v8_exit(cfg, t_ms, side, readings, closes, cost, weak) for name, side in (("largo", 1), ("corto", -1))}
    if None in sides.values():
        return None
    return {"maestro": r["veredicto"], "puntaje": r["puntaje"], "portero_si": bool(r["portero_si"]), "portero_p": r["portero_p"],
            "noticias_si": bool(r.get("noticias_si")), "volatilidad": r["volatilidad"], **sides}


def _position_row(trader, t_ms, reasons, r, net_now_bp, trade):
    position = trader.position
    side = 1 if position.side == "LONG" else -1
    act = corta.formula_action(r, side)[0]
    formula_label = "CERRAR" if act == "CERRAR" else "MANTENER"
    return {"kind": "position", "product": trader.product, "t_ms": t_ms, "month": _month(t_ms),
            "state_text": trader.state_text(t_ms, reasons), "maestro": r["veredicto"], "portero_si": bool(r["portero_si"]),
            "net_now_bp": net_now_bp, "final_bp": None, "label": None, "trade": "{}:{}".format(trader.product, trade["trade_no"]),
            "side": position.side, "entry_ms": position.entry_ms,
            "por_tiempo": False,
            "formula": formula_label}


# --------------------------------------------------------------------------- the dataset


def balance(rows, key, per_class, seed):
    """``per_class`` filas de cada clase (todas si hay menos), mezcladas con la semilla."""
    rng = random.Random(seed)  # NOSONAR
    by = collections.defaultdict(list)
    for row in rows:
        by[row[key]].append(row)
    out = []
    for items in by.values():
        rng.shuffle(items)  # NOSONAR
        out += items[:per_class]
    rng.shuffle(out)  # NOSONAR
    return out


def balance_position(rows, per_class, seed, late_share=0.5):
    """Con posición: ``per_class`` de cada etiqueta, y la mitad de las CERRAR (``late_share``) de operaciones que llegaron a las 48 h
    sin que el maestro se diera vuelta: ahí está toda la pérdida de la v8 (la cola de −420 a −560 pb) y cortarlas a tiempo es lo
    que Qwen puede agregar. Sin suficientes de ese tipo, se completa con las demás."""
    rng = random.Random(seed)  # NOSONAR
    close = [r for r in rows if r["label"] == "CERRAR"]
    keep = [r for r in rows if r["label"] == "MANTENER"]
    late = [r for r in close if r.get("por_tiempo")]
    other = [r for r in close if not r.get("por_tiempo")]
    for items in (late, other, keep):
        rng.shuffle(items)  # NOSONAR
    want_late = min(len(late), int(per_class * late_share))
    chosen = late[:want_late] + other[:per_class - want_late]
    chosen += late[want_late:][:max(0, per_class - len(chosen))]
    out = chosen + keep[:per_class]
    rng.shuffle(out)  # NOSONAR
    return out


def questions(cfg, product):
    return qt.questions_for(cfg, product)


def prompts_for(cfg, row, mirror=False):
    """Lo que ve Qwen para una fila: ``[(mensajes de sistema y usuario, ids de las opciones en el orden de letras)]``, una vez por
    orden de letras de la config (la pregunta REAL de la config en vivo)."""
    question = questions(cfg, row["product"])["flat" if row["kind"] == "flat" else "position"]
    template = qt.template_of(cfg)
    state = row["mirror_text"] if mirror else row["state_text"]
    out = []
    for order in cfg["prompt"]["orders"][str(len(question["options"]))]:
        asked = llm.permuted(question, order)
        out.append(([{"role": "system", "content": cfg["prompt"]["system"]},
                     {"role": "user", "content": qt.build_prompt(state, asked, template)}], [o["id"] for o in asked["options"]]))
    return out


def chat_examples(cfg, row, mirror=False):
    """Los ejemplos de chat de una fila: ``prompts_for`` más la letra de la acción correcta (la del espejo si ``mirror``)."""
    label = MIRROR_LABEL[row["label"]] if mirror else row["label"]
    return [{"messages": messages + [{"role": "assistant", "content": LETTERS[ids.index(label)]}]}
            for messages, ids in prompts_for(cfg, row, mirror)]


EMBARGO_MS = 48 * HOUR_MS        # la etiqueta mira hasta 48 h adelante: las filas de entrenamiento no pueden llegar a la validación


def info_of(row, mirror=False):
    """Lo que vale cada respuesta a un ejemplo (para medir en la validación el NETO de seguir una respuesta, no solo si acertó la letra).
    En el espejo el mercado está dado vuelta: lo que dejaba el largo lo deja el corto."""
    if row["kind"] == "flat":
        largo, corto = (row["corto_bp"], row["largo_bp"]) if mirror else (row["largo_bp"], row["corto_bp"])
        return {"kind": "flat", "label": MIRROR_LABEL[row["label"]] if mirror else row["label"], "largo_bp": largo, "corto_bp": corto}
    return {"kind": "position", "label": row["label"], "net_now_bp": row["net_now_bp"], "final_bp": row["final_bp"]}


def split_valid(rows, months):
    """Los últimos ``months`` meses van a validación. Las filas de entrenamiento que caen en las 48 h anteriores se descartan
    (embargo): su etiqueta mira hasta 48 h adelante y se superpondría con lo que se mide."""
    names = sorted({r["month"] for r in rows})
    keep = set(names[-months:]) if len(names) > months else set()
    valid = [r for r in rows if r["month"] in keep]
    if not valid:
        return list(rows), []
    start = min(r["t_ms"] for r in valid)
    return [r for r in rows if r["month"] not in keep and r["t_ms"] + EMBARGO_MS <= start], valid


def write_jsonl(path, rows):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def build_dataset(cfg, flat, position, out_dir, *, per_class=400, seed=20261027, log=print):
    """``train.jsonl`` / ``valid.jsonl`` (mlx-lm, formato chat) y ``meta.json``. Sin posición: ``per_class`` miradas de cada
    etiqueta, cada una con su espejo (LARGO <-> CORTO); con posición: ``per_class`` de cada etiqueta (sin espejo: el espejo solo se
    pregunta sin posición). Las filas de validación son los últimos meses del período de entrenamiento."""
    flat_train, flat_valid = split_valid(flat, VALID_MONTHS)
    pos_train, pos_valid = split_valid(position, VALID_MONTHS)
    sets = {}
    for name, f, p in (("train", flat_train, pos_train), ("valid", flat_valid, pos_valid)):
        share = 1.0 if name == "train" else 0.2
        f = balance(f, "label", max(1, int(per_class * share)), seed)
        p = balance_position(p, max(1, int(per_class * share)), seed + 1)
        pairs = [(e, info_of(row, mirror)) for row in f for mirror in (False, True) for e in chat_examples(cfg, row, mirror)]
        pairs += [(e, info_of(row, False)) for row in p for e in chat_examples(cfg, row)]
        random.Random(seed + 2).shuffle(pairs)  # NOSONAR
        examples = [e for e, _ in pairs]
        sets[name] = (examples, f, p)
        write_jsonl(os.path.join(out_dir, name + ".jsonl"), examples)
        if name == "valid":                                  # what each validation example is worth, line by line (the net of following an answer)
            write_jsonl(os.path.join(out_dir, "valid-info.jsonl"), [i for _, i in pairs])
    meta = {"schema": DATASET_SCHEMA, "config_hash": qt.config_hash(cfg), "prompt_version": cfg["prompt"]["version"],
            "train": [TRAIN_FROM, TRAIN_TO], "valid_months": VALID_MONTHS, "per_class": per_class, "seed": seed,
            **{name: {"ejemplos": len(v[0]), "sin_posicion": dict(collections.Counter(r["label"] for r in v[1])),
                      "con_posicion": dict(collections.Counter(r["label"] for r in v[2]))} for name, v in sets.items()}}
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2, ensure_ascii=False)
    log("dataset: {}".format(json.dumps(meta, ensure_ascii=False)))
    return meta


# --------------------------------------------------------------------------- scoring an opinion


def _stats(values):
    n = len(values)
    if not n:
        return {"n": 0, "neto_bp": None, "ganadoras": None, "total_bp": 0.0}
    return {"n": n, "neto_bp": round(sum(values) / n, 2), "ganadoras": round(sum(1 for v in values if v > 0) / n, 3),
            "total_bp": round(sum(values), 1)}


def _row_side_bp(row, action):
    return row["largo_bp"] if action == "LARGO" else row["corto_bp"]


def _score_flat_rows(flat, opinion):
    entries, formula_entries = [], []
    by_month = collections.defaultdict(list)
    hits = 0
    for row in flat:
        said = opinion(row)
        hits += said == row["label"]
        if said in ("LARGO", "CORTO"):
            net = _row_side_bp(row, said)
            entries.append(net)
            by_month[row["month"]].append(net)
        if row["formula"] in ("LARGO", "CORTO"):
            formula_entries.append(_row_side_bp(row, row["formula"]))
    acc = round(hits / len(flat), 3) if flat else None
    return acc, entries, formula_entries, by_month


def _score_position_rows(position, opinion):
    trades = collections.defaultdict(list)
    for row in position:
        trades[row["trade"]].append(row)
    closes, formula_closes, hits, total = [], [], 0, 0
    for rows in trades.values():
        rows.sort(key=lambda r: r["t_ms"])
        formula_closes.append(rows[0]["final_bp"])
        first = next((r["net_now_bp"] for r in rows if opinion(r) == "CERRAR"), rows[0]["final_bp"])
        closes.append(first)
        for r in rows:
            hits += opinion(r) == r["label"]
            total += 1
    acc = round(hits / total, 3) if total else None
    return acc, closes, formula_closes


def score_opinions(flat, position, opinion):
    """Qué pasaría si se siguiera una opinión. ``opinion(row) -> acción`` (``LARGO``/``CORTO``/``ESPERAR`` sin posición,
    ``MANTENER``/``CERRAR`` con posición). Devuelve, para la opinión: el neto por ENTRADA sin posición (``entradas``), por mes, y el
    neto por operación de las fórmulas si se hubiera cerrado en la primera mirada donde la opinión dijo CERRAR (``cierres``),
    contra la fórmula sola (``formula_entradas``, ``formula_cierres``). Aciertos contra la etiqueta incluidos."""
    flat_acc, entries, formula_entries, by_month = _score_flat_rows(flat, opinion)
    pos_acc, closes, formula_closes = _score_position_rows(position, opinion)
    return {"acierto_sin_posicion": flat_acc,
            "acierto_con_posicion": pos_acc,
            "entradas": _stats(entries), "formula_entradas": _stats(formula_entries),
            "por_mes": {m: _stats(v) for m, v in sorted(by_month.items())},
            "cierres": _stats(closes), "formula_cierres": _stats(formula_closes)}


def baselines(flat, position, seed=1):
    """Las referencias que cualquier opinión tiene que superar: la fórmula, el oráculo (etiqueta), el azar y siempre-esperar."""
    rng = random.Random(seed)  # NOSONAR
    return {
        "formula": score_opinions(flat, position, lambda r: r["formula"]),
        "oraculo": score_opinions(flat, position, lambda r: r["label"]),
        "azar": score_opinions(flat, position, lambda r: rng.choice(FLAT_OPTIONS if r["kind"] == "flat" else POSITION_OPTIONS)),  # NOSONAR
        "esperar_siempre": score_opinions(flat, position, lambda r: "ESPERAR" if r["kind"] == "flat" else "MANTENER"),
    }


# --------------------------------------------------------------------------- live: label each saved look when its result is known


def _scores_by_time(db, product):
    """``{t_ms: puntaje}`` de las miradas guardadas del producto (el maestro de cada mirada, para saber cuándo se daba vuelta)."""
    out = {}
    for t_ms, text in db.execute("SELECT t_ms, formula_json FROM decisions WHERE product=? AND formula_json IS NOT NULL", (product,)):
        out[t_ms] = json.loads(text)["puntaje"]
    return out


def _resolve_position_look(trades, pos_json, net_now):
    trade = trades.get(json.loads(pos_json)["trade_no"]) if pos_json else None
    if trade is None or trade[5] != "closed" or trade[4] is None:
        return None
    return position_label(net_now, trade[4]), {"net_now_bp": net_now, "final_bp": trade[4]}


def _resolve_flat_look(cfg, t_ms, scores, closes, cost, weak):
    readings = {at: {"puntaje": score} for at, score in scores.items()}
    nets = {}
    for name, side in (("largo", 1), ("corto", -1)):
        out = ex._v8_exit(cfg, t_ms, side, readings, closes, cost, weak)
        if out is None:
            return None
        nets[name] = out["neto_bp"]
    return flat_label(nets["largo"], nets["corto"]), {"largo_bp": nets["largo"], "corto_bp": nets["corto"]}


def resolve_live(db, closes_of, cfg, now_ms):
    """Pone la etiqueta a las miradas guardadas cuyo resultado ya se conoce y no la tienen (tabla ``examples``)."""
    weak = corta.formulas(cfg)[0]["umbrales"]["flojo"]
    done = 0
    closes_all = {}
    for product in cfg["products"]:
        cost = float(round_trip_cost_bps(product))
        scores = _scores_by_time(db, product)
        trades = {r[0]: r for r in db.execute("SELECT trade_no, side, entry_ms, exit_ms, net_bp, status FROM trades WHERE product=?", (product,))}
        pending = db.execute(
            "SELECT d.bucket_ms, d.t_ms, d.kind, d.net_bp_now, d.position_json FROM decisions d LEFT JOIN examples e "
            "ON e.product=d.product AND e.bucket_ms=d.bucket_ms WHERE d.product=? AND e.bucket_ms IS NULL AND d.formula_json IS NOT NULL",
            (product,)).fetchall()
        for bucket, t_ms, kind, net_now, pos_json in pending:
            if kind == "position":
                resolved = _resolve_position_look(trades, pos_json, net_now)
            else:
                if closes_all.get(product) is None:
                    closes_all[product] = closes_of(product, min(r[1] for r in pending) - qt.BAR_MS, now_ms)
                resolved = _resolve_flat_look(cfg, t_ms, scores, closes_all[product], cost, weak)
            if resolved is None:
                continue
            label, detail = resolved
            with db:
                db.execute("INSERT OR REPLACE INTO examples VALUES(?,?,?,?,?,?,?)",
                           (product, bucket, t_ms, kind, label, json.dumps(detail), now_ms))
            done += 1
    return done


def export_live(db, cfg, out_path):
    """Los ejemplos ya etiquetados de la base en vivo, en el formato de chat del dataset (pregunta real, las dos órdenes)."""
    rows = []
    for product, state, kind, label in db.execute(
            "SELECT d.product, d.state_text, e.kind, e.label FROM examples e JOIN decisions d ON d.product=e.product AND d.bucket_ms=e.bucket_ms "
            "ORDER BY d.t_ms"):
        rows.append({"kind": kind, "product": product, "state_text": state, "label": label})
    examples = [e for row in rows for e in chat_examples(cfg, row)]
    write_jsonl(out_path, examples)
    return len(rows)


# --------------------------------------------------------------------------- the morning report


def _pb(x):
    return "n/d" if x is None else "{:+.1f} pb".format(x)


def _pct(x):
    return "n/d" if x is None else "{:.0f} %".format(100 * x)


def verdict(base, best, min_entries=30):
    """¿La opinión entrenada le gana a la fórmula sola (y al Qwen sin entrenar) en la práctica? ``base`` y ``best``: resultado de
    ``score_opinions`` (más ``espejo_da_vuelta`` y ``reparto``). Reglas fijas: más neto por entrada que la fórmula, al menos
    ``min_entries`` entradas, más neto que el Qwen sin entrenar, positiva en la mitad de los meses con entradas o más, y que no
    sea una costumbre (el espejo da vuelta en ≥ 90 % de las entradas, ninguna opción pasa del 70 % de las respuestas)."""
    entries, formula = best["entradas"], best["formula_entradas"]
    months = [m for m in best["por_mes"].values() if m["n"]]
    positive = sum(1 for m in months if m["neto_bp"] is not None and m["neto_bp"] > 0)
    reparto = best.get("reparto") or {}
    habit = bool(reparto) and max(reparto.values()) / max(1, sum(reparto.values())) > 0.7
    flips = best.get("espejo_da_vuelta")
    checks = {
        "mas neto que la fórmula sola": entries["neto_bp"] is not None and formula["neto_bp"] is not None and entries["neto_bp"] > formula["neto_bp"],
        "al menos {} entradas".format(min_entries): entries["n"] >= min_entries,
        "mas neto que Qwen sin entrenar": entries["neto_bp"] is not None and (base["entradas"]["neto_bp"] is None or entries["neto_bp"] > base["entradas"]["neto_bp"]),
        "positiva en la mitad de los meses o más": bool(months) and positive * 2 >= len(months),
        "no es una costumbre (espejo da vuelta ≥ 90 % y ninguna opción > 70 %)": flips is not None and flips >= 0.9 and not habit,
    }
    return checks, all(checks.values())


def report_md(base, best, history, meta=None):
    """El informe de la mañana (Markdown) con lo que dejó la noche: Qwen sin entrenar, el mejor checkpoint y la fórmula sola."""
    checks, passes = verdict(base, best)
    lines = ["# Qué dejó la noche: la opinión de Qwen contra la fórmula sola", "",
             "Práctica 2025-10-16 a 2026-04-18 (holdout intacto). El checkpoint se eligió con la validación del entrenamiento, no con la práctica.", "",
             "**Veredicto: {}**".format("PASA" if passes else "NO pasa"), ""]
    lines += ["- {} {}".format("✓" if ok else "✗", name) for name, ok in checks.items()]
    lines += ["", "## Entradas sin posición (neto tras costos por entrada)", "", "| | Entradas | Neto/op | Ganadoras | Acierto contra la etiqueta |", "|---|---|---|---|---|"]
    for name, r in ((FORMULA_SOLA, best), ("Qwen sin entrenar", base), ("Qwen entrenado (paso {})".format(best.get("paso", "?")), best)):
        e = r["formula_entradas"] if name == FORMULA_SOLA else r["entradas"]
        acc = "—" if name == FORMULA_SOLA else _pct(r["acierto_sin_posicion"])
        lines.append("| {} | {} | {} | {} | {} |".format(name, e["n"], _pb(e["neto_bp"]), _pct(e["ganadoras"]), acc))
    lines += ["", "## Cierres (operaciones de la fórmula, primer CERRAR de la opinión)", "", "| | Operaciones | Neto/op | Ganadoras |", "|---|---|---|---|"]
    for name, c in ((FORMULA_SOLA, best["formula_cierres"]), ("Qwen sin entrenar", base["cierres"]), ("Qwen entrenado", best["cierres"])):
        lines.append("| {} | {} | {} | {} |".format(name, c["n"], _pb(c["neto_bp"]), _pct(c["ganadoras"])))
    lines += ["", "## Por mes (neto por entrada del Qwen entrenado)", ""]
    lines += ["- {}: {} entradas, {}".format(m, v["n"], _pb(v["neto_bp"])) for m, v in best["por_mes"].items()] or ["- sin entradas"]
    lines += ["", "## Costumbre y espejo", "",
              "- Qwen sin entrenar: contesta {} ; espejo da vuelta {}".format(base.get("reparto"), _pct(base.get("espejo_da_vuelta"))),
              "- Qwen entrenado: contesta {} ; espejo da vuelta {}".format(best.get("reparto"), _pct(best.get("espejo_da_vuelta"))),
              "", "## Medición cada 500 pasos (validación del entrenamiento)", "", "| Paso | Acierto | Acierto balanceado | Costumbre (parte de la opción más repetida) |", "|---|---|---|---|"]
    for h in history:
        lines.append("| {} | {} | {} | {} |".format(h["paso"], _pct(h["acierto"]), _pct(h["acierto_balanceado"]), _pct(h["costumbre_parte"])))
    if meta:
        lines += ["", "Dataset: {}".format(json.dumps(meta, ensure_ascii=False))]
    lines += ["", "Muestras chicas: promesa, no prueba. Un PASA no cambia nada en vivo: el adaptador no se aplica solo."]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- CLI


def _parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=("dataset", "referencias", "resolver", "exportar", "informe"))
    p.add_argument("--config", default=None, help="config de Qwen en vivo (por defecto config/qwen-live.json)")
    p.add_argument("--cache-dir", default=qt.DEFAULT_CACHE)
    p.add_argument("--out", required=True, help="carpeta (dataset) o archivo (exportar) de salida")
    p.add_argument("--per-class", type=int, default=400)
    p.add_argument("--flat-rate", type=float, default=0.15)
    p.add_argument("--dir", default=None, help="carpeta de la noche (informe): base-practica.json, best-practica.json, historia.jsonl")
    p.add_argument("--db", default=None, help="base en vivo (resolver / exportar)")
    return p


def _history(args):
    return qt.History(args.cache_dir, qt.load_holdout_ms())


def _run_informe(args):
    def load(name):
        with open(os.path.join(args.dir, name), encoding="utf-8") as handle:
            return json.load(handle)

    with open(os.path.join(args.dir, "historia.jsonl"), encoding="utf-8") as handle:
        history = [json.loads(x) for x in handle if x.strip()]
    best = load("best-practica.json")
    best["paso"] = load("best.json")["paso"]
    text = report_md(load("base-practica.json"), best, history)
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(text)
    print(text)


def _run_dataset_or_refs(args, cfg):
    import gzip

    history = _history(args)
    spans = {"train": (TRAIN_FROM, TRAIN_TO), "practica": (PRACTICE_FROM, PRACTICE_TO)}
    got = {}
    for name, (a, b) in spans.items():
        flat, position = [], []
        for product in cfg["products"]:
            part = collect(history, cfg, product, qt.date_ms(a), qt.date_ms(b), flat_rate=args.flat_rate)
            flat += part["flat"]
            position += part["position"]
            print("{} {}: {} miradas sin posición, {} con posición".format(name, product, len(part["flat"]), len(part["position"])), flush=True)
        got[name] = (flat, position)
    if args.command == "dataset":
        os.makedirs(args.out, exist_ok=True)
        for name, (f, p) in got.items():
            with gzip.open(os.path.join(args.out, "filas-{}.jsonl.gz".format(name)), "wt", encoding="utf-8") as handle:
                for row in f + p:
                    handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        build_dataset(cfg, *got["train"], args.out, per_class=args.per_class)
        write_jsonl(os.path.join(args.out, "practica.jsonl"), got["practica"][0] + got["practica"][1])
    report = {name: baselines(*rows) for name, rows in got.items()}
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "referencias.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False)
    print(json.dumps(report, ensure_ascii=False, indent=1))


def main(argv=None):
    args = _parser().parse_args(argv)
    if args.command == "informe":
        _run_informe(args)
        return
    cfg = qt.load_config(args.config or qt.CONFIG_PATH_LIVE)
    if args.command in ("dataset", "referencias"):
        _run_dataset_or_refs(args, cfg)
    else:
        import sqlite3
        db = sqlite3.connect(args.db)
        if args.command == "exportar":
            print("{} ejemplos".format(export_live(db, cfg, args.out)))
        else:
            history = _history(args)
            print("{} etiquetados".format(resolve_live(
                db, lambda p, a, b: {int(x["bucket_start"]) + qt.BAR_MS: float(x["close"]) for x in history.bars(p, a, b)},
                cfg, int(time.time() * 1000))))


if __name__ == "__main__":
    main()
