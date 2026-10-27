"""Entrenar a Qwen con LoRA: el dataset (hilo «Entrenar a Qwen con LoRA»).

Qwen en vivo (config ``live``, ficha de 8 factores) contesta una línea ``F1:v … F8:v``. Aquí se arman ejemplos para un ajuste
fino LoRA del MISMO modelo (Qwen3-4B) con fotos del pasado: la misma pregunta y el mismo STATE que ve en vivo (``make_photos``
del examen, sin modelo), y como respuesta la línea que «debió» dar.

Dataset v3 (Fran, 27-oct: «quiero que Qwen aprenda cuándo entrar y cuándo salir, que busque superar las comisiones»): la
respuesta es el VEREDICTO DEL MAESTRO (``futures_qwen_maestro``, fórmula fija en ``config/qwen-lora-maestro.json`` sobre los
números direccionales de la ficha): +2 largo fuerte, +1 largo flojo, 0 nada, -1 corto flojo, -2 corto fuerte, en los renglones
que votan (F1 F2 F3 F4 F6 F7; F5 y F8 en 0). El espejo también se enseña: la ficha dada vuelta con el veredicto opuesto (exacto,
porque el maestro no tiene intercepto). Ya no hay etiqueta por plazo fijo, ni ±2 por tamaño del movimiento, ni pregunta de
entrada en el dataset (v2 tenía las tres y el adaptador aprendió una costumbre: la etiqueta era una moneda).

Períodos: se entrena con fotos ANTERIORES a la ventana práctica (``TRAIN_FROM`` a ``TRAIN_TO``, velas públicas de Kraken) y se
valida con el examen en la ventana práctica (2025-10-16 a 2026-04-18). El holdout no se lee nunca (``History`` lo rechaza).

La pregunta de la ENTRADA (``E:v``, cinco formas de entrar) sigue aquí para ``ops/qwen-lora/entry_eval.py`` (gramática
``ENTRY_GRAMMAR``), pero no entra en el dataset.

Salida (``dataset``): ``train.jsonl`` y ``valid.jsonl`` en el formato «chat» de mlx-lm (``{"messages": [system, user,
assistant]}``, dos ejemplos por foto: real y espejo) más ``meta.json`` (períodos, muestra, maestro, reparto de veredictos, hash
de la config). ``facts``: una línea JSON por foto con TODOS los números de la ficha (los hechos aplanados) y los movimientos,
para ajustar y medir el maestro (``futures_qwen_maestro fit|medir``). ``numbers``: solo los números de los renglones F1..F7.

Comandos: ``python -m balancita_engine.futures_qwen_lora dataset|facts|numbers``. Nada de esto toca Qwen en vivo ni descarga modelos.
"""

import argparse
import copy
import json
import os
import random
import re
import time

from . import futures_qwen_factors as fq
from . import futures_qwen_maestro as maestro
from . import futures_qwen_trader as qt
from . import futures_qwen_trader_exam as ex
from .futures_costs import fee_rate, side_impact_bps
from .futures_qwen_ficha import FACTORS, VOTING

LABEL_HORIZON_MIN = 240                      # el plazo de la pregunta de ENTRADA (entry_eval.py); el dataset ya no lo usa
TRAIN_FROM, TRAIN_TO = "2022-04-01", "2025-10-01"   # fotos anteriores a la ventana práctica (2025-10-16)
VALID_MONTHS = 2                             # los últimos meses del período van a valid.jsonl (solo para mirar la pérdida)
DEFAULT_PER_PRODUCT = 2000                   # 2 ejemplos por foto (real y espejo): ~8.000 ejemplos
DEFAULT_PRODUCTS = ("PF_XBTUSD", "PF_ETHUSD")
DEFAULT_OUT = os.path.join(qt.DATA_DIR, "lora")
DATASET_SCHEMA = "balancita-qwen-lora-dataset.v3"

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
    """The exam's photos of ``[from_day, to_day)``: STATE, mirrored STATE, the numbers and facts of the sheet and the moves at
    the exam's horizons plus the teacher's. ``to_day`` bounds the candles read (it must not pass the holdout: ``History`` refuses)."""
    cfg2 = copy.deepcopy(cfg)
    cfg2["practice"] = dict(cfg["practice"], **{"from": from_day})
    horizons = set(cfg["exam"]["horizons_min"]) | {maestro.DEFAULT_HORIZON_MIN}   # the teacher's horizon too (12 h)
    cfg2["exam"] = dict(cfg["exam"], horizons_min=sorted(horizons))
    started = time.monotonic()
    photos = ex.make_photos(history, cfg2, product, qt.date_ms(to_day))
    log("fotos de {} de {} a {}: {} en {:.0f} s".format(product, from_day, to_day, len(photos), time.monotonic() - started))
    return photos


def line_of(values):
    return " ".join("{}:{}".format(f, "0" if v == 0 else "{:+d}".format(v)) for f, v in zip(FACTORS, values))


def example(cfg, state_text, values):
    """One mlx-lm «chat» example: the system text and the user prompt exactly as llama-server gets them in the exam / live
    (``futures_qwen_factors.build_prompt``), the answer line as the assistant turn (the chat template adds the empty
    ``<think>`` block, as llama-server does with ``enable_thinking`` off)."""
    question = fq.settings(cfg)["question"]
    return {"messages": [{"role": "system", "content": cfg["prompt"]["system"]},
                         {"role": "user", "content": fq.build_prompt(state_text, question)},
                         {"role": "assistant", "content": line_of(values)}]}


def examples_of(cfg, photo, teacher):
    """The two examples of one photo: the real sheet with the teacher's verdict and the mirrored sheet with the opposite one."""
    values = maestro.label_values(teacher, photo["hechos"])
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


def build_dataset(history, cfg, out_dir, *, teacher=None, products=DEFAULT_PRODUCTS, from_day=TRAIN_FROM, to_day=TRAIN_TO,
                  per_product=DEFAULT_PER_PRODUCT, valid_months=VALID_MONTHS, seed=20261026, log=print):
    """``train.jsonl``, ``valid.jsonl`` and ``meta.json`` in ``out_dir``, labelled by ``teacher`` (default: the one in the repo).
    Returns the meta."""
    teacher = teacher or maestro.load()
    rng_seed = "{}:{}:{}".format(seed, from_day, to_day)
    photos = []
    for product in products:
        photos += photos_between(history, cfg, product, from_day, to_day, log=log)
    if any("hechos" not in p for p in photos):
        raise qt.TraderError("las fotos no traen los hechos de la ficha: la config no tiene state_ficha")
    chosen = sample_photos(photos, per_product, rng_seed)
    train, valid = split_valid(chosen, valid_months)
    rows = {}
    for name, part in (("train", train), ("valid", valid)):
        rows[name] = [e for p in part for e in examples_of(cfg, p, teacher)]
        random.Random(rng_seed + name).shuffle(rows[name])     # mlx-lm reads the file in order: mixed products and months
        write_jsonl(os.path.join(out_dir, name + ".jsonl"), rows[name])
    meta = {"schema": DATASET_SCHEMA, "config_hash": qt.config_hash(cfg), "prompt_version": cfg["prompt"]["version"],
            "maestro": {"archivo": os.path.relpath(teacher["_path"], qt.ROOT) if teacher.get("_path") else None,
                        "hash": maestro.teacher_hash(teacher), "plazo_min": teacher["plazo_min"], "umbrales": teacher["umbrales"]},
            "from": from_day, "to": to_day, "products": list(products), "photos_available": len(photos), "photos_sampled": len(chosen),
            "per_product": per_product, "seed": seed, "valid_months": valid_months, "examples": {k: len(v) for k, v in rows.items()},
            "label_share": _label_share(teacher, chosen), "acierto_maestro": _teacher_hits(teacher, chosen),
            "note": "Cada foto da dos ejemplos: la ficha real con el veredicto del maestro (+2 largo fuerte, +1 flojo, 0 nada, -1, -2) "
                    "en F1 F2 F3 F4 F6 F7 y F5 F8 en 0, y el espejo con el veredicto opuesto. Sin plazo fijo, sin +-2 por tamano del "
                    "movimiento, sin pregunta de entrada."}
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=1, ensure_ascii=False)
    log("dataset: {} fotos de {} ({} ejemplos de entrenamiento, {} de validación) en {}".format(
        len(chosen), len(photos), len(rows["train"]), len(rows["valid"]), out_dir))
    return meta


def _label_share(teacher, photos):
    """Share of every verdict among the sampled photos (the real sheets; the mirrors add the opposite ones)."""
    n = len(photos) or 1
    verdicts = [maestro.verdict(teacher, p["hechos"]) for p in photos]
    return {str(v): verdicts.count(v) / n for v in (-2, -1, 0, 1, 2)}


def _teacher_hits(teacher, photos):
    """Sign agreement of the non-zero verdicts with the moves the photos carry (the exam horizons), as information."""
    out = {}
    for horizon in sorted({h for p in photos for h in p["moves"]}, key=int):
        judged = [(maestro.verdict(teacher, p["hechos"]), p["moves"][horizon]) for p in photos if horizon in p["moves"]]
        judged = [(v, m) for v, m in judged if v != 0 and m != 0]
        out[horizon] = round(sum(1 for v, m in judged if (v > 0) == (m > 0)) / len(judged), 4) if judged else None
    return out


def facts_rows(photos):
    """One flat row per photo: product, time, every number of the sheet (``hechos``) and the moves (bp) at every horizon."""
    for p in photos:
        row = {"product": p["product"], "t_ms": p["t_ms"], "cost_bp": p["cost_bp"]}
        row.update(p.get("hechos") or {})
        row.update({"move_{}".format(h): v for h, v in p["moves"].items()})
        yield row


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
                       ("facts", "una línea JSON por foto con todos los números de la ficha y los movimientos (para el maestro)"),
                       ("numbers", "una línea JSON por foto con los números de los renglones F1..F7 y los movimientos (sin modelo)")):
        p = sub.add_parser(name, help=text)
        p.add_argument("--config", default=qt.CONFIG_PATH_LIVE, help="config del operador (default: la de Qwen en vivo)")
        p.add_argument("--cache-dir", default=qt.DEFAULT_CACHE, help="caché de velas (default %(default)s)")
        p.add_argument("--products", default=",".join(DEFAULT_PRODUCTS))
        p.add_argument("--from", dest="from_day", default=TRAIN_FROM)
        p.add_argument("--to", dest="to_day", default=TRAIN_TO, help="exclusivo; nunca pasa el holdout")
        p.add_argument("--offline", action="store_true", help="no descarga velas: usa solo la caché")
        if name == "dataset":
            p.add_argument("--out", default=DEFAULT_OUT)
            p.add_argument("--maestro", default=maestro.DEFAULT_PATH, help="el maestro que etiqueta (default %(default)s)")
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
        build_dataset(history, cfg, args.out, teacher=maestro.load(args.maestro), products=products, from_day=args.from_day,
                      to_day=args.to_day, per_product=args.per_product, valid_months=args.valid_months, seed=args.seed)
    else:
        photos = []
        for product in products:
            photos += photos_between(history, cfg, product, args.from_day, args.to_day)
        rows = facts_rows(photos) if args.command == "facts" else numbers_rows(photos)
        print("{} fotos escritas en {}".format(write_jsonl(args.out, rows), args.out))


if __name__ == "__main__":
    try:
        main()
    except qt.TraderError as error:
        print("error: {}".format(error))
        raise SystemExit(2)
