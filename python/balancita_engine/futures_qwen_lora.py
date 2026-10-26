"""Entrenar a Qwen con LoRA: el dataset (hilo «Entrenar a Qwen con LoRA»).

Qwen en vivo (config ``live``, ficha de 8 factores) contesta una línea ``F1:v … F8:v``. Aquí se arman ejemplos para un ajuste
fino LoRA del MISMO modelo (Qwen3-4B) con fotos del pasado: la misma pregunta y el mismo STATE que ve en vivo (``make_photos``
del examen, sin modelo), y como respuesta la línea que «debió» dar: los renglones que votan (F1 F2 F3 F4 F6 F7) llevan el signo
de lo que hizo el precio en las 4 h siguientes (+2 / -2 si el movimiento fue grande, +1 / -1 si fue chico; F5 y F8 en 0). El
espejo también se enseña: la ficha dada vuelta con la línea dada vuelta.

Períodos: se entrena con fotos ANTERIORES a la ventana práctica (``TRAIN_FROM`` a ``TRAIN_TO``, velas públicas de Kraken) y se
valida con el examen en la ventana práctica (2025-10-16 a 2026-04-18, config ``qwen-lora-exam.json``). El holdout no se lee
nunca (``History`` lo rechaza).

Segunda pregunta por foto, la ENTRADA (Fran, 26-oct: «hagamos las 3 igual»): con el lado ya decidido, ¿cómo entrar? Una línea
``E:v`` con cinco opciones: orden límite esperando un retroceso grande (E:-2: 30 pb, válida 2 h) o chico (E:-1: 10 pb, 1 h),
entrar ya a mercado (E:0), esperar la vela de 15 min y entrar solo si confirma (E:+1), o esperar 1 h (E:+2). La etiqueta es la
opción que dejó el mejor neto a las 4 h con las velas que siguieron (comisión maker 0,02 % para la orden límite, taker 0,05 % para
el resto, impacto del producto; una orden que no se llenó vale 0). El espejo lleva el lado opuesto y la misma opción. Esta pregunta
no existe en vivo ni en el examen: la contesta solo ``ops/qwen-lora/entry_eval.py`` (gramática ``ENTRY_GRAMMAR``).

Salida (``dataset``): ``train.jsonl`` y ``valid.jsonl`` en el formato «chat» de mlx-lm (``{"messages": [system, user,
assistant]}``, cuatro ejemplos por foto: dirección y entrada, real y espejo) más ``meta.json`` (períodos, muestra, umbral de
movimiento grande por producto, reparto de etiquetas, hash de la config).
``numbers``: una línea JSON por foto con los números de la ficha (F1..F7) y los movimientos, para estudios sin modelo.

Comandos: ``python -m balancita_engine.futures_qwen_lora dataset|numbers``. Nada de esto toca Qwen en vivo ni descarga modelos.
"""

import argparse
import copy
import json
import os
import random
import re
import time

from . import futures_qwen_factors as fq
from . import futures_qwen_trader as qt
from . import futures_qwen_trader_exam as ex
from .futures_costs import fee_rate, side_impact_bps
from .futures_qwen_ficha import FACTORS, VOTING

LABEL_HORIZON_MIN = 240                      # la etiqueta: el movimiento a 4 h (el plazo al que opera y cierra Qwen en vivo)
TRAIN_FROM, TRAIN_TO = "2022-04-01", "2025-10-01"   # fotos anteriores a la ventana práctica (2025-10-16)
VALID_MONTHS = 2                             # los últimos meses del período van a valid.jsonl (solo para mirar la pérdida)
DEFAULT_PER_PRODUCT = 2000                   # 4 ejemplos por foto (dirección y entrada, real y espejo): ~16.000 ejemplos
DEFAULT_PRODUCTS = ("PF_XBTUSD", "PF_ETHUSD")
DEFAULT_OUT = os.path.join(qt.DATA_DIR, "lora")
DATASET_SCHEMA = "balancita-qwen-lora-dataset.v2"

# La entrada: valor de la línea E -> nombre; velas de 5 min que hacen falta después de la foto para etiquetarla.
ENTRY_OPTIONS = {-2: "limite_30pb_120min", -1: "limite_10pb_60min", 0: "mercado", 1: "confirma_15min", 2: "espera_60min"}
ENTRY_BARS = 24 + LABEL_HORIZON_MIN // 5     # la espera más larga (2 h) y las 4 h de la operación
ENTRY_QUESTION = (
    "El lado ya esta decidido: {side}. Elegi como entrar, mirando el STATE. Contesta una sola linea E:v con v entre -2 y +2. "
    "E:-2 = dejar una orden limite esperando un retroceso grande (30 pb a favor, valida 2 h; si el precio no llega, no se entra). "
    "E:-1 = orden limite esperando un retroceso chico (10 pb a favor, valida 1 h). "
    "E:0 = entrar ya a mercado. "
    "E:+1 = esperar la vela de 15 min y entrar a mercado solo si va a favor del lado. "
    "E:+2 = esperar 1 h y entrar a mercado. "
    "La orden limite paga comision 0,02 %; el resto 0,05 %. Elegi la opcion que deje el mejor resultado neto a las 4 h.")
ENTRY_GRAMMAR = 'root ::= "E:" v\nv ::= ("+" | "-") ("1" | "2") | "0"'
ENTRY_LINE = re.compile(r"^E:(0|[+-][12])$")


# --------------------------------------------------------------------------- photos and labels


def photos_between(history, cfg, product, from_day, to_day, log=print):
    """The exam's photos of ``[from_day, to_day)``: STATE, mirrored STATE, the numbers of the sheet and the moves. ``to_day``
    bounds the candles read (it must not pass the holdout: ``History`` refuses)."""
    cfg2 = copy.deepcopy(cfg)
    cfg2["practice"] = dict(cfg["practice"], **{"from": from_day})
    started = time.monotonic()
    photos = ex.make_photos(history, cfg2, product, qt.date_ms(to_day))
    log("fotos de {} de {} a {}: {} en {:.0f} s".format(product, from_day, to_day, len(photos), time.monotonic() - started))
    return photos


def label_values(move_bp, big_bp):
    """The 8 values Qwen should have written: the sign of the move on every voting line, 2 when the move is big."""
    if move_bp == 0:
        return [0] * len(FACTORS)
    value = (1 if move_bp > 0 else -1) * (2 if abs(move_bp) >= big_bp else 1)
    return [value if f in VOTING else 0 for f in FACTORS]


def line_of(values):
    return " ".join("{}:{}".format(f, "0" if v == 0 else "{:+d}".format(v)) for f, v in zip(FACTORS, values))


def median(values):
    ordered = sorted(values)
    n = len(ordered)
    return ordered[n // 2] if n % 2 else (ordered[n // 2 - 1] + ordered[n // 2]) / 2.0


def big_threshold(photos):
    """The median |move| at the label horizon of these photos: a move at or above it is «big» (+2 / -2)."""
    return median([abs(p["moves"][str(LABEL_HORIZON_MIN)]) for p in photos]) if photos else 0.0


def example(cfg, state_text, values):
    """One mlx-lm «chat» example: the system text and the user prompt exactly as llama-server gets them in the exam / live
    (``futures_qwen_factors.build_prompt``), the answer line as the assistant turn (the chat template adds the empty
    ``<think>`` block, as llama-server does with ``enable_thinking`` off)."""
    question = fq.settings(cfg)["question"]
    return {"messages": [{"role": "system", "content": cfg["prompt"]["system"]},
                         {"role": "user", "content": fq.build_prompt(state_text, question)},
                         {"role": "assistant", "content": line_of(values)}]}


def examples_of(cfg, photo, big_bp):
    """The two examples of one photo: the real sheet with the real line and the mirrored sheet with the line turned over."""
    values = label_values(photo["moves"][str(LABEL_HORIZON_MIN)], big_bp)
    return [example(cfg, photo["state_text"], values), example(cfg, photo["mirror_text"], [-v for v in values])]


# --------------------------------------------------------------------------- the entry


def entry_nets(side, c0, nxt, product):
    """Net result (bp) of every entry option for ``side`` (+1 long, -1 short) decided at price ``c0``, given the bars that
    followed (``nxt``: at least ``ENTRY_BARS`` rows ``(high, low, close)``, the first one closing 5 min after the decision).
    Market entries pay taker fee and impact on both sides; the limit order pays maker fee on entry and fills at its own price
    when a later bar touches it (no impact); an order that never fills, or a confirmation that fails, is 0 (no trade). Every
    trade exits at market ``LABEL_HORIZON_MIN`` after its entry."""
    if len(nxt) < ENTRY_BARS:
        raise ValueError("entry_nets needs {} bars, got {}".format(ENTRY_BARS, len(nxt)))
    hold = LABEL_HORIZON_MIN // 5
    impact = float(side_impact_bps(product))
    taker_bp, maker_bp = float(fee_rate("taker")) * 1e4, float(fee_rate("maker")) * 1e4
    market_cost, limit_cost = 2 * taker_bp + 2 * impact, maker_bp + taker_bp + impact

    def at_market(k):                                     # enter at the close of bar ``k`` (-1: now, at c0)
        price = c0 if k < 0 else nxt[k][2]
        return side * (nxt[k + hold][2] / price - 1) * 1e4 - market_cost

    nets = {0: at_market(-1), 2: at_market(11)}
    nets[1] = at_market(2) if side * (nxt[2][2] - c0) > 0 else 0.0
    for value, depth_bp, bars in ((-1, 10, 12), (-2, 30, 24)):
        limit = c0 * (1 - side * depth_bp / 1e4)
        fill = next((k for k in range(bars) if (nxt[k][1] <= limit if side > 0 else nxt[k][0] >= limit)), None)
        nets[value] = 0.0 if fill is None else side * (nxt[fill + hold][2] / limit - 1) * 1e4 - limit_cost
    return nets


ENTRY_TIE_ORDER = (0, 1, 2, -1, -2)                # a tie goes to the simplest way in: market, confirmation, wait, then the limits


def entry_label(nets):
    """The option with the best net; a tie goes to the simplest option (``ENTRY_TIE_ORDER``)."""
    return max(nets, key=lambda v: (round(nets[v], 9), -ENTRY_TIE_ORDER.index(v)))


def entry_line(value):
    return "E:{}".format("0" if value == 0 else "{:+d}".format(value))


def parse_entry_line(text):
    match = ENTRY_LINE.match(text.strip())
    return None if match is None else int(match.group(1))


def entry_question(side):
    return ENTRY_QUESTION.format(side="LARGO" if side > 0 else "CORTO")


def entry_example(cfg, state_text, side, value):
    return {"messages": [{"role": "system", "content": cfg["prompt"]["system"]},
                         {"role": "user", "content": fq.build_prompt(state_text, entry_question(side))},
                         {"role": "assistant", "content": entry_line(value)}]}


def entry_examples_of(cfg, photo, value):
    """The real sheet with its side and the mirrored sheet with the opposite side: the best way in is the same."""
    side = 1 if photo["moves"][str(LABEL_HORIZON_MIN)] > 0 else -1
    return [entry_example(cfg, photo["state_text"], side, value), entry_example(cfg, photo["mirror_text"], -side, value)]


class Bars:
    """The candles of one product as ``(high, low, close)`` rows, addressed by the time a photo was taken."""

    def __init__(self, bars):
        self.rows = [(float(b["high"]), float(b["low"]), float(b["close"])) for b in bars]
        self.index = {int(b["bucket_start"]) + qt.BAR_MS: i for i, b in enumerate(bars)}

    def after(self, t_ms):
        """``(close at t_ms, the next ENTRY_BARS rows)`` or ``None`` when the candles do not reach that far."""
        i = self.index.get(t_ms)
        if i is None or i + 1 + ENTRY_BARS > len(self.rows):
            return None
        return self.rows[i][2], self.rows[i + 1:i + 1 + ENTRY_BARS]


def entry_labels(photos, bars_of):
    """``{(product, t_ms): value}`` for the photos whose price moved and whose candles reach 6 h ahead. ``bars_of(product)``
    gives the ``Bars`` of a product."""
    out, cache = {}, {}
    for photo in photos:
        move = photo["moves"][str(LABEL_HORIZON_MIN)]
        if move == 0:
            continue
        if photo["product"] not in cache:
            cache[photo["product"]] = bars_of(photo["product"])
        found = cache[photo["product"]].after(photo["t_ms"])
        if found is None:
            continue
        c0, nxt = found
        out[(photo["product"], photo["t_ms"])] = entry_label(entry_nets(1 if move > 0 else -1, c0, nxt, photo["product"]))
    return out


# --------------------------------------------------------------------------- sampling


def month_of(t_ms):
    return qt.stamp(t_ms)[:7]


def sample_photos(photos, per_product, seed):
    """Seeded sample of ``per_product`` photos per product, spread evenly over the months (the months with fewer photos give
    what they have and the rest is filled from the others, in a seeded order)."""
    out = []
    by_product = {}
    for photo in photos:
        by_product.setdefault(photo["product"], {}).setdefault(month_of(photo["t_ms"]), []).append(photo)
    for product in sorted(by_product):
        months = by_product[product]
        rng = random.Random("{}:{}".format(seed, product))
        pools = {m: rng.sample(items, len(items)) for m, items in sorted(months.items())}
        chosen, quota = [], max(1, per_product // len(pools))
        for m in sorted(pools):
            chosen += pools[m][:quota]
            del pools[m][:quota]
        rest = [p for m in sorted(pools) for p in pools[m]]
        rng.shuffle(rest)
        chosen += rest[:max(0, per_product - len(chosen))]
        out += sorted(chosen, key=lambda p: p["t_ms"])
    return out


def split_valid(photos, valid_months):
    """Train / valid by time: the photos of the last ``valid_months`` months of the period are the validation ones."""
    months = sorted({month_of(p["t_ms"]) for p in photos})
    valid = set(months[-valid_months:]) if valid_months > 0 else set()
    return [p for p in photos if month_of(p["t_ms"]) not in valid], [p for p in photos if month_of(p["t_ms"]) in valid]


# --------------------------------------------------------------------------- writing


def write_jsonl(path, rows):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    count = 0
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
    return count


def build_dataset(history, cfg, out_dir, *, products=DEFAULT_PRODUCTS, from_day=TRAIN_FROM, to_day=TRAIN_TO,
                  per_product=DEFAULT_PER_PRODUCT, valid_months=VALID_MONTHS, seed=20261026, log=print):
    """``train.jsonl``, ``valid.jsonl`` and ``meta.json`` in ``out_dir``. Returns the meta."""
    rng_seed = "{}:{}:{}".format(seed, from_day, to_day)
    photos = []
    for product in products:
        photos += photos_between(history, cfg, product, from_day, to_day, log=log)
    chosen = sample_photos(photos, per_product, rng_seed)
    big = {product: big_threshold([p for p in chosen if p["product"] == product]) for product in products}
    warm = qt.date_ms(from_day) - cfg["practice"]["warmup_days"] * qt.DAY_MS
    entries = entry_labels(chosen, lambda product: Bars(history.bars(product, warm, qt.date_ms(to_day))))
    train, valid = split_valid(chosen, valid_months)
    rows, counts = {}, {}
    for name, part in (("train", train), ("valid", valid)):
        rows[name] = [e for p in part for e in examples_of(cfg, p, big[p["product"]])]
        counts[name] = {"direccion": len(rows[name])}
        rows[name] += [e for p in part if (p["product"], p["t_ms"]) in entries
                       for e in entry_examples_of(cfg, p, entries[(p["product"], p["t_ms"])])]
        counts[name]["entrada"] = len(rows[name]) - counts[name]["direccion"]
        random.Random(rng_seed + name).shuffle(rows[name])     # mlx-lm reads the file in order: mixed products, months, questions
        write_jsonl(os.path.join(out_dir, name + ".jsonl"), rows[name])
    meta = {"schema": DATASET_SCHEMA, "config_hash": qt.config_hash(cfg), "prompt_version": cfg["prompt"]["version"],
            "label_horizon_min": LABEL_HORIZON_MIN, "from": from_day, "to": to_day, "products": list(products),
            "photos_available": len(photos), "photos_sampled": len(chosen), "per_product": per_product, "seed": seed,
            "valid_months": valid_months, "big_move_bp": big, "examples": {k: len(v) for k, v in rows.items()},
            "examples_by_question": counts, "label_share": _label_share(chosen),
            "entry_options": {str(k): v for k, v in sorted(ENTRY_OPTIONS.items())}, "entry_label_share": _entry_share(entries),
            "note": "Cada foto da cuatro ejemplos: direccion (ficha real y espejo; signo del movimiento a 4 h en F1 F2 F3 F4 F6 F7, "
                    "+-2 si |movimiento| >= big_move_bp del producto, +-1 si no; F5 y F8 en 0) y entrada (E:v, la opcion con mejor "
                    "neto a 4 h con las velas que siguieron; el espejo lleva el lado opuesto y la misma opcion)."}
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=1, ensure_ascii=False)
    log("dataset: {} fotos de {} ({} ejemplos de entrenamiento, {} de validación) en {}".format(
        len(chosen), len(photos), len(rows["train"]), len(rows["valid"]), out_dir))
    return meta


def _label_share(photos):
    moves = [p["moves"][str(LABEL_HORIZON_MIN)] for p in photos]
    n = len(moves) or 1
    return {"up": sum(1 for m in moves if m > 0) / n, "down": sum(1 for m in moves if m < 0) / n}


def _entry_share(entries):
    n = len(entries) or 1
    return {ENTRY_OPTIONS[v]: sum(1 for x in entries.values() if x == v) / n for v in sorted(ENTRY_OPTIONS)}


def numbers_rows(photos):
    """One flat row per photo: product, time, the numbers of the sheet and the moves (bp) at every horizon."""
    for p in photos:
        row = {"product": p["product"], "t_ms": p["t_ms"], "cost_bp": p["cost_bp"]}
        row.update({k: v for k, v in (p.get("ficha") or {}).items()})
        row.update({"move_{}".format(h): v for h, v in p["moves"].items()})
        yield row


# --------------------------------------------------------------------------- CLI


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name, text in (("dataset", "train.jsonl / valid.jsonl (formato chat de mlx-lm) con fotos del pasado"),
                       ("numbers", "una línea JSON por foto con los números de la ficha y los movimientos (sin modelo)")):
        p = sub.add_parser(name, help=text)
        p.add_argument("--config", default=qt.CONFIG_PATH_LIVE, help="config del operador (default: la de Qwen en vivo)")
        p.add_argument("--cache-dir", default=qt.DEFAULT_CACHE, help="caché de velas (default %(default)s)")
        p.add_argument("--products", default=",".join(DEFAULT_PRODUCTS))
        p.add_argument("--from", dest="from_day", default=TRAIN_FROM)
        p.add_argument("--to", dest="to_day", default=TRAIN_TO, help="exclusivo; nunca pasa el holdout")
        p.add_argument("--offline", action="store_true", help="no descarga velas: usa solo la caché")
        if name == "dataset":
            p.add_argument("--out", default=DEFAULT_OUT)
            p.add_argument("--per-product", type=int, default=DEFAULT_PER_PRODUCT)
            p.add_argument("--valid-months", type=int, default=VALID_MONTHS)
            p.add_argument("--seed", type=int, default=20261026)
        else:
            p.add_argument("--out", required=True, help="archivo .jsonl")
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    cfg = qt.load_config(args.config)
    from .futures_qwen_live import apply_overrides
    cfg = apply_overrides(cfg)
    holdout_ms = qt.load_holdout_ms()
    to_ms = qt.date_ms(args.to_day)
    if to_ms > holdout_ms:
        raise qt.TraderError("--to {} pasa el holdout ({}): no se leen esas velas".format(args.to_day, qt.stamp(holdout_ms)))
    products = [p.strip() for p in args.products.split(",") if p.strip()]
    history = qt.History(args.cache_dir, holdout_ms, offline=args.offline)
    if not history.offline:
        for product in dict.fromkeys(products + list(cfg.get("state_context") or ())):
            history.prefetch(product, qt.date_ms(args.from_day) - cfg["practice"]["warmup_days"] * qt.DAY_MS, to_ms)
    if args.command == "dataset":
        build_dataset(history, cfg, args.out, products=products, from_day=args.from_day, to_day=args.to_day,
                      per_product=args.per_product, valid_months=args.valid_months, seed=args.seed)
    else:
        photos = []
        for product in products:
            photos += photos_between(history, cfg, product, args.from_day, args.to_day)
        print("{} fotos escritas en {}".format(write_jsonl(args.out, numbers_rows(photos)), args.out))


if __name__ == "__main__":
    try:
        main()
    except qt.TraderError as error:
        print("error: {}".format(error))
        raise SystemExit(2)
